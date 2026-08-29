/**
 * F_Record Generator plugin -- the half that runs inside Photoshop's Generator
 * process and does the actual capturing.
 *
 * Two things dominate the design, both of them reactions to how 3.x failed:
 *
 * 1. Do as little to Photoshop as possible. 3.x polled `getDocumentInfo()`
 *    twice a second with the default flags -- which walks every layer, in
 *    ExtendScript, on Photoshop's main thread -- and did it whether or not
 *    recording was even switched on. Then every captured frame cost another
 *    four document-info passes and two pixmap renders. Here, state is driven by
 *    events, document info is fetched with layer/comp/text info switched off,
 *    and a frame costs exactly one pixmap call.
 *
 * 2. Fail loudly. Nothing in the capture path can leave recording wedged with
 *    the panel showing a stale frame count: see CaptureScheduler.
 */

import * as path from "path";
import {
    Command,
    CommandResult,
    Config,
    DocumentState,
    HealthState,
    PLUGIN_NAME,
    PROTOCOL_VERSION,
    SessionState,
    SessionSummary,
    State,
    Bounds
} from "../../shared/protocol";
import { frameFileName } from "../../shared/paths";
import { randomHex } from "../../shared/compat";
import {
    ConfigStore,
    SessionIndex,
    deleteSession,
    listSessions,
    writeManifest
} from "./store";
import { DocInfo, PsGateway, ResolvedSession, SessionResolver, canvasSize } from "./session";
import { Encoder, Pixmap } from "./encoder";
import { CaptureScheduler, SchedulerStats } from "./capture";
import { Bridge } from "./bridge";
import { CoreLogger, Logger } from "./logger";
import { computeMaxDimension, computePadding } from "./framing";
import { UpdateChecker } from "./update";

declare const __PLUGIN_VERSION__: string;
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== "undefined" ? __PLUGIN_VERSION__ : "0.0.0-dev";

const MENU_ID = "f-record-toggle";
const RESYNC_DEBOUNCE_MS = 150;
const MANIFEST_FLUSH_MS = 2000;
const TICK_MS = 1000;
/** Heartbeat resync, purely as a safety net if an event is ever missed. */
const HEARTBEAT_TICKS = 5;

/**
 * Everything below is switched off. `imageInfo` alone gives us bounds, file
 * path and resolution -- the only things we need -- and skips the per-layer
 * ExtendScript walk that made 3.x's polling so expensive.
 */
const CHEAP_DOC_FLAGS = {
    compInfo: false,
    imageInfo: true,
    layerInfo: false,
    expandSmartObjects: false,
    getTextStyles: false,
    getFullTextStyles: false,
    selectedLayers: false,
    getCompLayerSettings: false,
    getDefaultLayerFX: false,
    getPathData: false
};

interface GeneratorApi {
    getDocumentInfo(documentId?: number, flags?: object): Promise<any>;
    getDocumentPixmap(documentId: number, settings: object): Promise<any>;
    getDocumentSettingsForPlugin(documentId: number, pluginId: string): Promise<any>;
    setDocumentSettingsForPlugin(settings: object, pluginId: string): Promise<any>;
    savePixmap?(pixmap: any, filePath: string, settings: object): Promise<any>;
    onPhotoshopEvent(event: string, listener: (payload: any) => void): unknown;
    addMenuItem(name: string, displayName: string, enabled: boolean, checked: boolean): Promise<any>;
    toggleMenu(name: string, enabled: boolean, checked: boolean, displayName?: string): Promise<any>;
    getPhotoshopVersion?(): Promise<string>;
}

class FRecordPlugin {
    private readonly log: Logger;
    private readonly configStore: ConfigStore;
    private readonly index: SessionIndex;
    private readonly resolver: SessionResolver;
    private readonly encoder: Encoder;
    private readonly scheduler: CaptureScheduler;
    private readonly bridge: Bridge;
    private readonly updates: UpdateChecker;
    private readonly startedAt = Date.now();

    private activeDocumentId: number | null = null;
    private docBounds: Bounds | null = null;
    private docFile = "";
    private docPpi: number | undefined;
    private docTooSmall = false;

    private current: ResolvedSession | null = null;
    private resumeCandidates: SessionSummary[] = [];
    private resolvedForDocId: number | null = null;
    private needsResolve = true;

    private lastFrameAt: number | null = null;
    private photoshopVersion: string | null = null;

    private resyncTimer: any = null;
    private manifestTimer: any = null;
    private tickTimer: any = null;
    private tickCount = 0;
    private resyncInFlight = false;

    constructor(private readonly generator: GeneratorApi, coreLogger: CoreLogger | null) {
        this.log = new Logger(coreLogger);
        this.configStore = new ConfigStore();
        this.index = new SessionIndex(randomHex(8));

        const gateway: PsGateway = {
            getDocumentSettings: (documentId: number) =>
                Promise.resolve(this.generator.getDocumentSettingsForPlugin(documentId, PLUGIN_NAME)),
            setActiveDocumentSettings: (settings: Record<string, unknown>) =>
                Promise.resolve(this.generator.setDocumentSettingsForPlugin(settings, PLUGIN_NAME)).then(
                    () => undefined
                ),
            getActiveDocumentId: () => this.activeDocumentId
        };
        this.resolver = new SessionResolver(gateway, this.index, (level, message) =>
            this.log.log(level, message)
        );

        this.encoder = new Encoder(
            typeof this.generator.savePixmap === "function"
                ? {
                      savePixmap: (pixmap, filePath, settings) =>
                          Promise.resolve(this.generator.savePixmap!(pixmap, filePath, settings))
                  }
                : null,
            (level, message) => this.log.log(level, message)
        );

        this.scheduler = new CaptureScheduler({
            minIntervalMs: this.configStore.get().minIntervalMs,
            capture: () => this.performCapture(),
            onStats: () => this.broadcastHealth(),
            onAutoPause: (reason) => {
                this.log.error(reason);
                this.broadcastState();
            },
            log: (level, message) => this.log.log(level, message)
        });

        this.bridge = new Bridge(
            PLUGIN_VERSION,
            () => this.buildState(),
            (command) => this.handleCommand(command),
            (level, message) => this.log.log(level, message)
        );

        // Reads the live config on every call rather than capturing it, so
        // switching the setting off takes effect without a restart.
        this.updates = new UpdateChecker({
            currentVersion: PLUGIN_VERSION,
            isEnabled: () => this.configStore.get().checkForUpdates,
            dismissedVersion: () => this.configStore.get().dismissedUpdateVersion,
            onChange: () => this.broadcastState(),
            log: (level, message) => this.log.log(level, message)
        });
    }

    async start(): Promise<void> {
        this.log.info("F_Record " + PLUGIN_VERSION + " starting (protocol " + PROTOCOL_VERSION + ")");

        this.index.prune();
        this.index.persist();

        try {
            await this.bridge.start();
        } catch (e) {
            // Losing the panel channel must not stop recording; the panel will
            // simply report that the generator is unreachable.
            this.log.error("Bridge failed to start, the panel will not connect: " + errText(e));
        }

        // Only mirror warnings and errors to the panel; info would be noise.
        this.log.setSink((level, message) => {
            if (level === "info") {
                return;
            }
            this.bridge.broadcast({ type: "log", level: level, message: message, at: Date.now() });
        });

        if (this.generator.getPhotoshopVersion) {
            try {
                this.photoshopVersion = String(await this.generator.getPhotoshopVersion());
            } catch (e) {
                this.photoshopVersion = null;
            }
        }

        this.subscribeToPhotoshop();
        await this.installMenu();

        const config = this.configStore.get();
        if (config.autoStart && !config.enabled) {
            this.log.info("Auto-start is on; arming recording without waiting for the panel");
            this.configStore.update({ enabled: true });
        }

        this.tickTimer = setInterval(() => this.tick(), TICK_MS);
        if (this.tickTimer.unref) {
            this.tickTimer.unref();
        }

        await this.syncActiveDocument();
        this.log.info("F_Record ready");
    }

    /**
     * Releases every timer and the bridge socket.
     *
     * generator-core has no unload hook, so nothing calls this in production --
     * the process simply exits with Photoshop. It exists so tests can drive a
     * real plugin instance and then let the test runner exit.
     */
    async stop(): Promise<void> {
        for (const timer of [this.tickTimer, this.resyncTimer, this.manifestTimer]) {
            if (timer !== null) {
                clearTimeout(timer);
                clearInterval(timer);
            }
        }
        this.tickTimer = null;
        this.resyncTimer = null;
        this.manifestTimer = null;
        this.scheduler.dispose();
        this.log.setSink(null);
        this.flushManifest();
        await this.bridge.stop();
    }

    /* ------------------------------------------------------------ events */

    private subscribeToPhotoshop(): void {
        // imageChanged is the expensive one generator-core warns about, so it
        // is the only high-frequency subscription and everything it triggers is
        // rate limited by CaptureScheduler.
        this.generator.onPhotoshopEvent("imageChanged", (event) => this.onImageChanged(event));
        this.generator.onPhotoshopEvent("currentDocumentChanged", (event) =>
            this.onCurrentDocumentChanged(event)
        );
        this.generator.onPhotoshopEvent("save", () => this.onSave());
        this.generator.onPhotoshopEvent("generatorMenuChanged", (event) => this.onMenuChanged(event));
    }

    private onImageChanged(event: any): void {
        try {
            if (!event) {
                return;
            }
            const documentId = typeof event.id === "number" ? event.id : null;

            if (event.closed) {
                if (documentId !== null) {
                    this.resolver.forgetDocument(documentId);
                    if (documentId === this.activeDocumentId) {
                        this.clearActiveDocument();
                    }
                }
                return;
            }

            // A changed file path means Save As or a rename, which is exactly
            // when Photoshop wipes generatorSettings. Re-resolve so the session
            // is repaired before the next frame is written.
            if (typeof event.file === "string" || event.generatorSettings !== undefined) {
                this.needsResolve = true;
                this.scheduleResync();
            }
            if (event.bounds) {
                this.needsResolve = true;
                this.scheduleResync();
            }

            if (documentId === null || documentId !== this.activeDocumentId) {
                return;
            }
            if (!event.layers || !someLayerHasPixels(event.layers)) {
                return;
            }
            this.scheduler.notifyChange();
        } catch (e) {
            this.log.error("imageChanged handler failed: " + errText(e));
        }
    }

    private onCurrentDocumentChanged(event: any): void {
        const id = typeof event === "number" ? event : event && typeof event.id === "number" ? event.id : null;
        if (id === this.activeDocumentId) {
            return;
        }
        this.activeDocumentId = id;
        this.needsResolve = true;
        // Anything queued belonged to the document we just left.
        this.scheduler.discardPending();
        this.scheduler.setEnabled(false);
        this.scheduleResync();
    }

    private onSave(): void {
        // Photoshop clears generatorSettings on Save As. Put the id back now
        // rather than leaving it to the debounced resync below, so a capture
        // racing in between still resolves to the right session.
        if (this.activeDocumentId !== null) {
            this.resolver.repairAfterSave(this.activeDocumentId).catch((e) => {
                this.log.warn("Could not repair the session id after save: " + errText(e));
            });
        }
        this.needsResolve = true;
        this.scheduleResync();
    }

    private onMenuChanged(event: any): void {
        const menu = event && event.generatorMenuChanged;
        if (!menu || menu.name !== MENU_ID) {
            return;
        }
        const config = this.configStore.get();
        this.applyConfigPatch({ enabled: !config.enabled }).catch((e) => {
            this.log.error("Menu toggle failed: " + errText(e));
        });
    }

    private async installMenu(): Promise<void> {
        try {
            const config = this.configStore.get();
            await this.generator.addMenuItem(MENU_ID, this.menuLabel(config), true, config.enabled);
        } catch (e) {
            // A missing menu is cosmetic; never let it stop the plugin loading.
            this.log.warn("Could not install the Photoshop menu item: " + errText(e));
        }
    }

    private menuLabel(config: Config): string {
        return config.language === "en" ? "F_Record: Record" : "F_Record: 录制";
    }

    private async refreshMenu(): Promise<void> {
        try {
            const config = this.configStore.get();
            await this.generator.toggleMenu(MENU_ID, true, config.enabled, this.menuLabel(config));
        } catch (e) {
            /* cosmetic */
        }
    }

    /* --------------------------------------------------------- document */

    private scheduleResync(): void {
        if (this.resyncTimer !== null) {
            return;
        }
        this.resyncTimer = setTimeout(() => {
            this.resyncTimer = null;
            this.syncActiveDocument().catch((e) => {
                this.log.error("Document sync failed: " + errText(e));
            });
        }, RESYNC_DEBOUNCE_MS);
    }

    private clearActiveDocument(): void {
        this.activeDocumentId = null;
        this.docBounds = null;
        this.docFile = "";
        this.docPpi = undefined;
        this.docTooSmall = false;
        this.current = null;
        this.resumeCandidates = [];
        this.resolvedForDocId = null;
        this.needsResolve = true;
        this.lastFrameAt = null;
        this.scheduler.discardPending();
        this.scheduler.setEnabled(false);
        this.broadcastState();
    }

    private async syncActiveDocument(): Promise<void> {
        if (this.resyncInFlight) {
            return;
        }
        this.resyncInFlight = true;
        try {
            let info: any;
            try {
                info = await this.generator.getDocumentInfo(
                    this.activeDocumentId === null ? undefined : this.activeDocumentId,
                    CHEAP_DOC_FLAGS
                );
            } catch (e) {
                // "No Open Document", or the document we were tracking is gone.
                if (this.activeDocumentId !== null || this.current !== null) {
                    this.clearActiveDocument();
                }
                return;
            }
            if (!info || typeof info.id !== "number") {
                this.clearActiveDocument();
                return;
            }

            const config = this.configStore.get();
            if (info.id !== this.activeDocumentId) {
                this.activeDocumentId = info.id;
                this.needsResolve = true;
            }
            this.docBounds = info.bounds || null;
            this.docFile = typeof info.file === "string" ? info.file : "";
            this.docPpi = typeof info.resolution === "number" ? info.resolution : undefined;

            const size = canvasSize(this.docBounds);
            this.docTooSmall = size.width * size.height < config.minCanvasPixels;

            if (this.needsResolve || this.resolvedForDocId !== info.id || this.current === null) {
                await this.resolveSession(config);
            }

            this.scheduler.setMinInterval(config.minIntervalMs);
            this.scheduler.setEnabled(config.enabled && this.current !== null && !this.docTooSmall);
            this.broadcastState();
        } finally {
            this.resyncInFlight = false;
        }
    }

    private async resolveSession(config: Config): Promise<void> {
        if (this.activeDocumentId === null) {
            return;
        }
        const doc: DocInfo = {
            id: this.activeDocumentId,
            file: this.docFile,
            bounds: this.docBounds
        };
        // Only create a folder when recording is actually on -- browsing a
        // document with the switch off should leave nothing behind.
        const allowCreate = config.enabled && config.autoStartNewDocuments && !this.docTooSmall;
        const outcome = await this.resolver.resolve(doc, config, allowCreate);

        this.current = outcome.session;
        this.resumeCandidates = outcome.candidates;
        this.resolvedForDocId = this.activeDocumentId;
        this.needsResolve = false;

        if (outcome.session) {
            this.lastFrameAt = outcome.session.manifest.lastModifiedAt || null;
            if (outcome.session.restamped) {
                this.log.info(
                    "Repaired the session id inside '" + outcome.session.manifest.docName +
                        "' after Photoshop cleared it; continuing session " + outcome.session.sessionId
                );
            }
        } else {
            this.lastFrameAt = null;
        }
    }

    /* ---------------------------------------------------------- capture */

    private async performCapture(): Promise<void> {
        const config = this.configStore.get();
        const session = this.current;
        const documentId = this.activeDocumentId;
        const bounds = this.docBounds;

        if (!config.enabled || !session || documentId === null || !bounds) {
            return;
        }

        const maxDimension = computeMaxDimension(bounds, config.resolution);

        // One pixmap call. `clipToDocumentBounds` keeps Photoshop from sending
        // pixels that lie outside the canvas, which means the frame only ever
        // needs padding to reach full canvas size and never cropping.
        const pixmap: Pixmap & { bounds?: Bounds } = await this.generator.getDocumentPixmap(documentId, {
            clipToDocumentBounds: true,
            maxDimension: maxDimension
        });

        if (!pixmap || !pixmap.pixels || pixmap.width <= 0 || pixmap.height <= 0) {
            // An empty canvas has nothing to record; not an error.
            return;
        }
        // Recording may have been switched off while Photoshop was rendering.
        if (!this.configStore.get().enabled || this.current !== session) {
            return;
        }

        const padding = computePadding(bounds, pixmap.bounds, pixmap.width, pixmap.height);
        const at = Date.now();
        const seq = session.manifest.nextSeq;
        const target = path.join(session.folder, frameFileName(seq, at, config.format));

        await this.encoder.encode(pixmap, target, {
            quality: config.quality,
            padding: padding,
            ppi: this.docPpi
        });

        session.manifest.nextSeq = seq + 1;
        session.manifest.frameCount = session.manifest.frameCount + 1;
        session.manifest.lastModifiedAt = at;
        this.lastFrameAt = at;
        this.markManifestDirty();

        this.bridge.broadcast({
            type: "frame",
            sessionId: session.sessionId,
            frameCount: session.manifest.frameCount,
            at: at
        });
    }

    private markManifestDirty(): void {
        if (this.manifestTimer !== null) {
            return;
        }
        this.manifestTimer = setTimeout(() => {
            this.manifestTimer = null;
            this.flushManifest();
        }, MANIFEST_FLUSH_MS);
    }

    private flushManifest(): void {
        const session = this.current;
        if (!session) {
            return;
        }
        try {
            writeManifest(session.folder, session.manifest);
        } catch (e) {
            this.log.warn("Could not update " + session.sessionId + "/session.json: " + errText(e));
        }
    }

    /* ------------------------------------------------------------- tick */

    private tick(): void {
        try {
            this.tickCount++;
            const config = this.configStore.get();
            const session = this.current;

            if (config.enabled && session && this.lastFrameAt !== null && !this.scheduler.isPaused()) {
                const idleMs = config.idleTimeoutMinutes * 60 * 1000;
                const withinIdleWindow = config.idleTimeoutMinutes === 0 || Date.now() - this.lastFrameAt <= idleMs;
                if (withinIdleWindow) {
                    session.manifest.timeSpentSec++;
                    this.markManifestDirty();
                }
            }

            // Retries any session id that could not be written because its
            // document was not frontmost at the time.
            this.resolver.flushPendingStamps().catch(() => {
                /* logged inside the resolver */
            });

            if (this.tickCount % HEARTBEAT_TICKS === 0) {
                if (this.bridge.hasClients()) {
                    this.broadcastState();
                }
                this.syncActiveDocument().catch(() => {
                    /* logged inside */
                });
                // Piggybacks on the heartbeat rather than owning a timer. Returns
                // immediately unless the user opted in and a day has passed.
                this.updates.maybeCheck();
            }
        } catch (e) {
            this.log.error("Tick failed: " + errText(e));
        }
    }

    /* ------------------------------------------------------------ state */

    private buildHealth(): HealthState {
        const stats: SchedulerStats = this.scheduler.getStats();
        return {
            lastCaptureMs: stats.lastCaptureMs,
            avgCaptureMs: stats.avgCaptureMs,
            nextIntervalMs: stats.nextIntervalMs,
            capturing: stats.capturing,
            droppedFrames: stats.droppedFrames,
            consecutiveFailures: stats.consecutiveFailures,
            encoder: this.encoder.getKind(),
            lastError: null,
            pausedReason: stats.pausedReason
        };
    }

    private buildState(): State {
        const config = this.configStore.get();
        const session = this.current;

        let document: DocumentState | null = null;
        if (this.activeDocumentId !== null) {
            document = {
                id: this.activeDocumentId,
                name: session ? session.manifest.docName : displayNameOf(this.docFile),
                filePath: /[\\/]/.test(this.docFile) ? this.docFile : null,
                bounds: this.docBounds,
                sessionId: session ? session.sessionId : null,
                tooSmall: this.docTooSmall
            };
        }

        let sessionState: SessionState | null = null;
        if (session) {
            sessionState = {
                sessionId: session.sessionId,
                folder: session.folder,
                frameCount: session.manifest.frameCount,
                timeSpentSec: session.manifest.timeSpentSec,
                lastFrameAt: this.lastFrameAt,
                createdAt: session.manifest.createdAt
            };
        }

        // Falling back to the built-in encoder is a supported configuration,
        // not a fault, so it is reported through `health.encoder` alone and
        // never as an error the panel would surface as a problem.
        const health = this.buildHealth();

        return {
            protocolVersion: PROTOCOL_VERSION,
            generator: {
                pluginVersion: PLUGIN_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                pid: process.pid,
                startedAt: this.startedAt,
                photoshopVersion: this.photoshopVersion,
                generatorCoreVersion: null
            },
            config: config,
            document: document,
            session: sessionState,
            health: health,
            resumeCandidates: session ? [] : this.resumeCandidates,
            update: this.updates.getState()
        };
    }

    private broadcastState(): void {
        this.bridge.broadcast({ type: "state", state: this.buildState() });
    }

    private broadcastHealth(): void {
        this.bridge.broadcast({ type: "health", health: this.buildHealth() });
    }

    /* --------------------------------------------------------- commands */

    private async applyConfigPatch(patch: Partial<Config>): Promise<Config> {
        const before = this.configStore.get();
        const after = this.configStore.update(patch);

        if (after.minIntervalMs !== before.minIntervalMs) {
            this.scheduler.setMinInterval(after.minIntervalMs);
        }
        if (after.processImageFolderPath !== before.processImageFolderPath) {
            // Sessions live under the old folder; start clean rather than
            // writing half a recording into each location.
            this.current = null;
            this.needsResolve = true;
        }
        if (after.enabled !== before.enabled || after.language !== before.language) {
            await this.refreshMenu();
        }
        if (after.enabled && !before.enabled) {
            this.scheduler.resume();
            this.needsResolve = true;
        }
        if (after.checkForUpdates !== before.checkForUpdates) {
            // Switching it off must clear the banner, not just stop refreshing
            // it. Switching it on checks once now rather than waiting a day.
            this.updates.forget();
            if (after.checkForUpdates) {
                this.updates.check().catch(() => {
                    /* check() never rejects */
                });
            }
        }

        await this.syncActiveDocument();
        return after;
    }

    private async handleCommand(command: Command): Promise<CommandResult> {
        const config = this.configStore.get();

        switch (command.type) {
            case "ping":
                return { ok: true, state: this.buildState() };

            case "setConfig":
                await this.applyConfigPatch(command.patch || {});
                return { ok: true, state: this.buildState() };

            case "pause":
                this.scheduler.pause(command.reason || "Paused");
                this.broadcastState();
                return { ok: true, state: this.buildState() };

            case "resume":
                this.scheduler.resume();
                this.broadcastState();
                return { ok: true, state: this.buildState() };

            case "listSessions":
                return { ok: true, sessions: listSessions(config.processImageFolderPath) };

            case "deleteSession": {
                if (this.current && this.current.sessionId === command.sessionId) {
                    return { ok: false, error: "That session is currently being recorded" };
                }
                deleteSession(config.processImageFolderPath, command.sessionId);
                this.index.remove(command.sessionId);
                this.index.persist();
                return { ok: true, sessions: listSessions(config.processImageFolderPath) };
            }

            case "adoptSession": {
                if (this.activeDocumentId === null) {
                    return { ok: false, error: "No open document" };
                }
                this.flushManifest();
                const doc: DocInfo = { id: this.activeDocumentId, file: this.docFile, bounds: this.docBounds };
                this.current = await this.resolver.adopt(doc, config, command.sessionId);
                this.resumeCandidates = [];
                this.resolvedForDocId = this.activeDocumentId;
                this.needsResolve = false;
                this.lastFrameAt = this.current.manifest.lastModifiedAt || null;
                this.scheduler.setEnabled(config.enabled && !this.docTooSmall);
                this.broadcastState();
                return { ok: true, state: this.buildState() };
            }

            case "newSession": {
                if (this.activeDocumentId === null) {
                    return { ok: false, error: "No open document" };
                }
                this.flushManifest();
                const doc: DocInfo = { id: this.activeDocumentId, file: this.docFile, bounds: this.docBounds };
                this.current = await this.resolver.startFresh(doc, config);
                this.resumeCandidates = [];
                this.resolvedForDocId = this.activeDocumentId;
                this.needsResolve = false;
                this.lastFrameAt = null;
                this.scheduler.setEnabled(config.enabled && !this.docTooSmall);
                this.broadcastState();
                return { ok: true, state: this.buildState() };
            }

            case "dismissUpdate": {
                // Recorded against the version, so a later release still shows.
                this.configStore.update({ dismissedUpdateVersion: command.version });
                this.broadcastState();
                return { ok: true, state: this.buildState() };
            }

            case "checkUpdate": {
                if (!config.checkForUpdates) {
                    return { ok: false, error: "Update checks are switched off" };
                }
                const result = await this.updates.check();
                this.broadcastState();
                return { ok: true, state: this.buildState(), updateCheck: result };
            }

            default:
                return { ok: false, error: "Unknown command" };
        }
    }
}

function someLayerHasPixels(layers: any[]): boolean {
    for (let i = 0; i < layers.length; i++) {
        if (layers[i] && layers[i].pixels === true) {
            return true;
        }
    }
    return false;
}

function displayNameOf(file: string): string {
    if (!file) {
        return "Untitled";
    }
    const base = file.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || file;
    return base.replace(/\.[^.]+$/, "");
}

function errText(e: unknown): string {
    if (e && (e as Error).message) {
        return (e as Error).message;
    }
    return String(e);
}

/**
 * generator-core entry point. It calls this synchronously while loading
 * plugins and treats a throw as "plugin failed to load", so all real work
 * happens asynchronously and every failure is logged rather than raised.
 */
export function init(
    generator: GeneratorApi,
    _config: unknown,
    logger?: CoreLogger
): { ready: Promise<void>; stop: () => Promise<void> } | undefined {
    let plugin: FRecordPlugin;
    try {
        plugin = new FRecordPlugin(generator, logger || null);
    } catch (e) {
        if (logger && logger.error) {
            logger.error("F_Record failed to initialise: " + errText(e));
        }
        return undefined;
    }
    const ready = plugin.start().catch(function (e) {
        if (logger && logger.error) {
            logger.error("F_Record failed to start: " + errText(e));
        }
    });
    // generator-core ignores the return value; the handle is here so tests can
    // await startup and shut a real instance down again.
    return { ready: ready as Promise<void>, stop: () => plugin.stop() };
}
