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
import { describeNodeCompat, randomHex } from "../../shared/compat";
import {
    ConfigStore,
    SessionIndex,
    deleteSession,
    listSessions,
    writeManifest
} from "./store";
import {
    DocInfo,
    PsGateway,
    ResolvedSession,
    SessionResolver,
    canvasSize,
    isSaveAsRename
} from "./session";
import { Encoder, Pixmap } from "./encoder";
import { CaptureScheduler, SchedulerStats } from "./capture";
import { Bridge } from "./bridge";
import { CoreLogger, Logger } from "./logger";
import { computeOutputRect, computePadding, pixmapExceedsOutputRect } from "./framing";
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
 * How long a document-info request may go unanswered before it is given up on.
 *
 * Photoshop answers scripts only when it is free. Saving a 150 MB PSD to a
 * synced drive keeps it busy for tens of seconds, and on one occasion it then
 * went on not answering for 89 minutes -- from that save until the next one --
 * while still delivering imageChanged events. Events said the file had been
 * renamed and the canvas resized; the sync that would have acted on them was
 * waiting on a request Photoshop was sitting on, so nothing was recorded and
 * nothing was logged. A request that has gone longer than this is treated as
 * lost: it is reported, a fresh one is sent, and the old answer, should it
 * turn up, is discarded. A minute is comfortably past an honest big save.
 */
const SYNC_STALL_MS = 60000;

/** Knobs generator-core can pass from a per-plugin config file; only tests set them. */
interface PluginOptions {
    syncStallMs?: number;
}

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
    /**
     * Bumped every time Photoshop reports new canvas bounds.
     *
     * A capture reads the bounds, then awaits a render that can take hundreds
     * of milliseconds. Image Size or Canvas Size landing inside that window
     * would leave the frame being padded against a canvas that no longer
     * exists. Comparing this counter across the await catches that regardless
     * of whether the debounced resync has caught up yet -- `docBounds` itself
     * is not a reliable witness, because it is updated 150ms later.
     */
    private boundsGeneration = 0;
    /**
     * The generation `docBounds` was actually fetched for.
     *
     * Behind `boundsGeneration` means Photoshop has told us the canvas changed
     * but the debounced resync has not read the new size yet -- so `docBounds`
     * is known-stale and nothing may be captured against it.
     */
    private syncedBoundsGeneration = 0;

    private current: ResolvedSession | null = null;
    private resumeCandidates: SessionSummary[] = [];
    private resolvedForDocId: number | null = null;
    private needsResolve = true;

    private lastFrameAt: number | null = null;
    private photoshopVersion: string | null = null;
    /**
     * Session the capture geometry has already been logged for.
     *
     * What Photoshop returns for a given pixmap request has not been the same
     * across versions, and it decides how every frame is seated. One line per
     * session makes it something the log can be read for instead of something
     * to be worked out backwards from a broken frame.
     */
    private loggedGeometryFor: string | null = null;
    /**
     * Session the "Photoshop ignored the requested rectangle" warning was
     * issued for. Once is enough: it is a property of the Photoshop build, so
     * it would otherwise repeat on every single frame.
     */
    private warnedOversizePixmapFor: string | null = null;

    private resyncTimer: any = null;
    private manifestTimer: any = null;
    private tickTimer: any = null;
    private tickCount = 0;

    /**
     * Serial of the document sync currently in flight, 0 when there is none.
     *
     * Only the sync holding this serial may apply what Photoshop answers.
     * A sync that has been superseded -- because Photoshop sat on its request
     * past `syncStallMs` and a fresh one was sent -- finds a different serial
     * here when its answer finally arrives, and drops it. That keeps exactly
     * one sync applying state at a time without the one in flight being able
     * to hold everything up indefinitely.
     */
    private syncInFlight = 0;
    private syncSerial = 0;
    private syncStartedAt = 0;
    /** True while the sync in flight is waiting on Photoshop, as opposed to forking or resolving. */
    private syncAwaitingInfo = false;
    private warnedStalledSync = false;
    /**
     * When the current run of unanswered requests began, 0 while Photoshop is
     * answering. Photoshop has been seen to stop answering scripts for 89
     * minutes at a stretch -- from one save of a 150 MB document to the next
     * -- while still delivering events. One warning when that starts and one
     * line when it ends is what the log needs; a line every 30 seconds in
     * between is not.
     */
    private stalledSince = 0;
    /**
     * A resync was asked for while one was already in flight.
     *
     * Photoshop answers document-info requests in order and only when it is
     * free, so a request sent just before a large Save As is answered once the
     * file is on disk -- tens of seconds later on a slow drive. Everything the
     * user does meanwhile (the Save As itself, a Canvas Size, the first strokes
     * on the renamed document) arrives as events during that wait. Each used
     * to ask for a resync that was thrown away because one was already
     * running, leaving `docBounds` and its generation behind the canvas: every
     * capture then refused the frame, silently, until the heartbeat happened
     * to come round. Remembering the request and running it as soon as the
     * one in flight returns is what makes the copy start recording at once.
     */
    private resyncRequested = false;
    private readonly syncStallMs: number;
    private stampFlushInFlight = false;
    /** Session an empty pixmap has already been noted for; once is enough. */
    private loggedEmptyPixmapFor: string | null = null;

    constructor(
        private readonly generator: GeneratorApi,
        coreLogger: CoreLogger | null,
        options: PluginOptions = {}
    ) {
        this.syncStallMs =
            typeof options.syncStallMs === "number" && options.syncStallMs > 0 ? options.syncStallMs : SYNC_STALL_MS;
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
            getActiveDocumentId: () => this.activeDocumentId,
            // Asked only when two documents claim one session, so the cost of
            // a document-info call there is irrelevant -- and the expensive
            // flags are off here as everywhere else.
            isDocumentOpen: (documentId: number) =>
                Promise.resolve(this.generator.getDocumentInfo(documentId, CHEAP_DOC_FLAGS)).then(
                    (info: any) => !!info && typeof info.id === "number",
                    () => false
                )
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
        // doctor.ps1 tails this log, so a 2020 user reporting a broken export
        // arrives with the answer already in front of them.
        this.log.info("Generator runtime: " + describeNodeCompat());

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

        // Events and the heartbeat come first, ahead of anything that waits on
        // Photoshop. The version query and the menu install are cosmetic, and
        // Photoshop can be slow to answer either; recording must not sit
        // behind them.
        this.subscribeToPhotoshop();

        const config = this.configStore.get();
        if (config.autoStart && !config.enabled) {
            this.log.info("Auto-start is on; arming recording without waiting for the panel");
            this.configStore.update({ enabled: true });
        }

        this.tickTimer = setInterval(() => this.tick(), TICK_MS);
        if (this.tickTimer.unref) {
            this.tickTimer.unref();
        }

        if (this.generator.getPhotoshopVersion) {
            try {
                this.photoshopVersion = String(await this.generator.getPhotoshopVersion());
            } catch (e) {
                this.photoshopVersion = null;
            }
        }
        await this.installMenu();

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
                this.boundsGeneration++;
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
        this.loggedGeometryFor = null;
        this.scheduler.discardPending();
        this.scheduler.setEnabled(false);
        this.broadcastState();
    }

    private async syncActiveDocument(): Promise<void> {
        if (this.syncInFlight !== 0) {
            const waited = Date.now() - this.syncStartedAt;
            if (waited < this.syncStallMs) {
                // Run again once the one in flight is done; see resyncRequested.
                this.resyncRequested = true;
                return;
            }
            if (!this.syncAwaitingInfo) {
                // Forking or resolving, which is our own work and must not be
                // run twice over. It is waiting on Photoshop too -- a stamp,
                // a settings read -- so say so once, where the panel shows
                // it, and queue behind it.
                if (!this.warnedStalledSync) {
                    this.warnedStalledSync = true;
                    this.log.error(
                        "A document sync has been waiting on Photoshop for " + Math.round(waited / 1000) +
                            "s; nothing is recorded until it finishes"
                    );
                }
                this.resyncRequested = true;
                return;
            }
            // Photoshop has sat on the request. Send a fresh one and let the
            // old answer, if it ever comes, fall on the floor: whatever it
            // would have said, the new answer says too, and more recently.
            if (this.stalledSince === 0) {
                this.stalledSince = this.syncStartedAt;
                // An error, not a warning: the panel only surfaces errors, and
                // "nothing is being recorded" is what the user has to know.
                this.log.error(
                    "Photoshop has not answered a document-info request for " + Math.round(waited / 1000) +
                        "s; asking again. Nothing is recorded until it answers"
                );
            }
        }

        for (;;) {
            this.resyncRequested = false;
            const serial = ++this.syncSerial;
            this.syncInFlight = serial;
            this.syncStartedAt = Date.now();
            this.warnedStalledSync = false;
            try {
                await this.syncActiveDocumentOnce(serial);
            } finally {
                if (this.syncInFlight === serial) {
                    this.syncInFlight = 0;
                    this.syncAwaitingInfo = false;
                }
            }
            // A newer sync has taken over, or nothing was asked for meanwhile.
            if (this.syncInFlight !== 0 || !this.resyncRequested) {
                return;
            }
        }
    }

    /** Closes a run of unanswered requests, if one was open. */
    private noteAnswered(): void {
        if (this.stalledSince === 0) {
            return;
        }
        this.log.info(
            "Photoshop is answering again after " + Math.round((Date.now() - this.stalledSince) / 1000) +
                "s; recording resumes"
        );
        this.stalledSince = 0;
        // Captures sent into the same silence timed out, and enough of those
        // pause recording. That pause was Photoshop's doing, so lift it here
        // rather than leave the panel asking for a resume click over a fault
        // that has already cleared. A pause the user or an export asked for
        // is left exactly where they put it.
        if (this.scheduler.isAutoPaused()) {
            this.log.info("Lifting the pause that the unanswered captures caused");
            this.scheduler.resume();
            this.broadcastState();
        }
    }

    /** One round trip to Photoshop and everything that follows from its answer. */
    private async syncActiveDocumentOnce(serial: number): Promise<void> {
        let info: any;
        // Read before the call, not after: anything Photoshop reports while
        // this is in flight is newer than what comes back, and marking it
        // as synced would hide a resize we have not actually seen yet.
        const generation = this.boundsGeneration;
        this.syncAwaitingInfo = true;
        try {
            info = await this.generator.getDocumentInfo(
                this.activeDocumentId === null ? undefined : this.activeDocumentId,
                CHEAP_DOC_FLAGS
            );
        } catch (e) {
            if (this.syncInFlight !== serial) {
                return;
            }
            this.syncAwaitingInfo = false;
            this.noteAnswered();
            // "No Open Document", or the document we were tracking is gone.
            if (this.activeDocumentId !== null || this.current !== null) {
                this.log.info("Photoshop has no document to record (" + errText(e) + "); detaching");
                this.clearActiveDocument();
            }
            return;
        }
        if (this.syncInFlight !== serial) {
            // Given up on while it waited; a newer sync owns the state now.
            return;
        }
        this.syncAwaitingInfo = false;
        this.noteAnswered();
        if (!info || typeof info.id !== "number") {
            this.log.warn("Photoshop answered a document-info request without a document id; detaching");
            this.clearActiveDocument();
            return;
        }

        const config = this.configStore.get();
        const wasDocumentId = this.activeDocumentId;
        const wasFile = this.docFile;
        if (info.id !== this.activeDocumentId) {
            this.activeDocumentId = info.id;
            this.needsResolve = true;
        }
        this.docBounds = info.bounds || null;
        this.syncedBoundsGeneration = generation;
        this.docFile = typeof info.file === "string" ? info.file : "";
        this.docPpi = typeof info.resolution === "number" ? info.resolution : undefined;

        const size = canvasSize(this.docBounds);
        this.docTooSmall = size.width * size.height < config.minCanvasPixels;

        // The same document arriving under a different name, with the old
        // file still on disk, is a Save As -- and a Save As means there are
        // now two artworks where there was one.
        const forked =
            info.id === wasDocumentId &&
            this.current !== null &&
            this.resolvedForDocId === info.id &&
            isSaveAsRename(wasFile, this.docFile)
                ? await this.forkForSaveAs(config)
                : false;

        if (!forked && (this.needsResolve || this.resolvedForDocId !== info.id || this.current === null)) {
            await this.resolveSession(config);
        }

        this.scheduler.setMinInterval(config.minIntervalMs);
        this.scheduler.setEnabled(config.enabled && this.current !== null && !this.docTooSmall);
        this.broadcastState();
    }

    /**
     * Hands the document a copy of its recording and leaves the original to
     * the file it was saved away from.
     *
     * Capture is stopped and `current` dropped for the duration, exactly as in
     * deleteCurrentSession: a frame landing while the folder is being
     * duplicated would end up in one branch and not the other, and which one
     * would depend on timing.
     *
     * A failure here leaves the document on the session it already had. Both
     * files then claim it, which the branch guard in the resolver catches the
     * next time the old one is opened -- a worse outcome than forking, but not
     * a broken one, and better than dropping the recording on the floor.
     */
    private async forkForSaveAs(config: Config): Promise<boolean> {
        const from = this.current;
        const documentId = this.activeDocumentId;
        if (!from || documentId === null) {
            return false;
        }

        this.flushManifest();
        this.current = null;
        this.scheduler.discardPending();
        await this.scheduler.whenIdle();

        const doc: DocInfo = { id: documentId, file: this.docFile, bounds: this.docBounds };
        try {
            this.current = await this.resolver.forkForSaveAs(doc, config, from);
        } catch (e) {
            this.current = from;
            this.needsResolve = true;
            this.log.error("Could not fork the recording after Save As: " + errText(e));
            return false;
        }
        this.resolvedForDocId = documentId;
        this.needsResolve = false;
        this.loggedGeometryFor = null;
        this.lastFrameAt = this.current.manifest.lastModifiedAt || null;
        this.resumeCandidates = [];
        return true;
    }

    private async resolveSession(config: Config): Promise<void> {
        if (this.activeDocumentId === null) {
            return;
        }
        // The resolver rebuilds the manifest from disk. Write the live one
        // first, or resolving straight back to the session already being
        // recorded -- a plain save does exactly that -- would hand back
        // counters up to two seconds stale, and the frame that landed in
        // between would lose its timestamp from lastModifiedAt.
        this.flushManifest();
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

        // Photoshop has reported a resize the debounced resync has not read
        // yet, so `bounds` describes a canvas that no longer exists. Capturing
        // now would pad the frame to the old size. Ask for the resync outright
        // rather than assume one is coming -- the one the resize scheduled may
        // have been folded into a sync that was already in flight -- and let
        // the change come round again; it is re-armed below.
        const generation = this.boundsGeneration;
        if (this.syncedBoundsGeneration !== generation) {
            this.scheduleResync();
            this.scheduler.notifyChange();
            return;
        }

        const outputRect = computeOutputRect(bounds, config.resolution);

        // One pixmap call, and all three settings matter. `inputRect` names the
        // canvas, `outputRect` names the size to render it at, and only with
        // both does `clipToDocumentBounds` actually clip. Sending
        // `maxDimension` instead -- what this did up to 4.2.1 -- gets back the
        // union of the layers at a scale Photoshop does not report, which is
        // how a whole session came out padded to 8000px of mostly white. See
        // `computeOutputRect` for the measurements.
        const pixmap: Pixmap & { bounds?: Bounds } = await this.generator.getDocumentPixmap(documentId, {
            inputRect: bounds,
            outputRect: outputRect,
            clipToDocumentBounds: true
        });

        if (!pixmap || !pixmap.pixels || pixmap.width <= 0 || pixmap.height <= 0) {
            // An empty canvas has nothing to record; not an error. Noted once
            // per session all the same, so a document that never yields
            // pixels can be told apart from one that is never asked.
            if (this.loggedEmptyPixmapFor !== session.sessionId) {
                this.loggedEmptyPixmapFor = session.sessionId;
                this.log.info("Photoshop returned an empty pixmap for " + session.sessionId + "; nothing to record yet");
            }
            return;
        }
        // Recording may have been switched off while Photoshop was rendering.
        if (!this.configStore.get().enabled || this.current !== session) {
            return;
        }
        // The canvas may also have been resized while it rendered. `bounds` is
        // then the canvas as it was, and padding computed from it would strand
        // the new image in the corner of a frame the old size -- a 400x300
        // drawing marooned in 1600x1200 of white. The pixmap alone cannot say
        // what the new canvas is, since it only covers the painted region, so
        // drop this frame and take another with bounds that agree. One frame
        // costs nothing; a visibly broken one is in the video forever.
        if (this.boundsGeneration !== generation) {
            this.log.info("Canvas was resized mid-capture; retaking the frame");
            this.scheduler.notifyChange();
            return;
        }

        if (this.loggedGeometryFor !== session.sessionId) {
            this.loggedGeometryFor = session.sessionId;
            this.log.info(
                "Capture geometry: canvas " + describeBounds(bounds) + ", asked for " +
                    describeBounds(outputRect) + ", got " + pixmap.width + "x" + pixmap.height +
                    " with bounds " + describeBounds(pixmap.bounds)
            );
        }

        if (
            this.warnedOversizePixmapFor !== session.sessionId &&
            pixmapExceedsOutputRect(outputRect, pixmap.width, pixmap.height)
        ) {
            this.warnedOversizePixmapFor = session.sessionId;
            this.log.warn(
                "Photoshop returned " + pixmap.width + "x" + pixmap.height + " for a requested " +
                    describeBounds(outputRect) + " -- larger than what was asked for, so this " +
                    "Photoshop is not honouring inputRect/outputRect. Frames are written " +
                    "unpadded rather than seated against a rectangle that does not describe them."
            );
        }

        const padding = computePadding(outputRect, pixmap.bounds, pixmap.width, pixmap.height);
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
            // document was not frontmost at the time. One at a time: a write
            // Photoshop is sitting on must not be joined by another every
            // second, to be executed as a batch when it finally wakes up.
            if (!this.stampFlushInFlight) {
                this.stampFlushInFlight = true;
                const done = () => {
                    this.stampFlushInFlight = false;
                };
                this.resolver.flushPendingStamps().then(done, done);
            }

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
                node: describeNodeCompat()
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

    /**
     * Throws away the recording attached to the open document and, when
     * recording is on, opens an empty one in its place. Nobody deletes the
     * take they are in the middle of except to start it over, so that is one
     * action here rather than a delete the user then has to recover from.
     *
     * The order is the whole of it. `current` is dropped first, which makes
     * every capture that starts afterwards a no-op, and then we wait out the
     * one that may already be rendering: both the encoder and writeManifest
     * create the directory they write into, so either landing after the delete
     * would leave a half session behind -- the orphaned folder the delete
     * existed to remove.
     */
    private async deleteCurrentSession(config: Config, sessionId: string): Promise<CommandResult> {
        this.current = null;
        this.lastFrameAt = null;
        this.loggedGeometryFor = null;
        this.resolvedForDocId = null;
        this.needsResolve = true;
        this.scheduler.discardPending();
        await this.scheduler.whenIdle();

        try {
            deleteSession(config.processImageFolderPath, sessionId);
        } catch (e) {
            // Gone already, or Windows is holding a handle on it. The session
            // is detached either way and the next resync will open a clean
            // one, so say what happened instead of reporting a delete that
            // did not happen.
            this.scheduler.setEnabled(false);
            this.scheduleResync();
            this.broadcastState();
            return { ok: false, error: errText(e) };
        }
        this.index.remove(sessionId);
        this.index.persist();
        this.log.info("Deleted session " + sessionId + " while it was being recorded");

        const documentId = this.activeDocumentId;
        if (documentId !== null) {
            // The document still points at the folder that just went, in the
            // PSD and in the resolver's map alike. Forget it and stamp the
            // replacement, rather than leaving a dangling id behind.
            this.resolver.forgetDocument(documentId);
            if (config.enabled && !this.docTooSmall) {
                const doc: DocInfo = { id: documentId, file: this.docFile, bounds: this.docBounds };
                this.current = await this.resolver.startFresh(doc, config);
                this.resolvedForDocId = documentId;
                this.needsResolve = false;
            }
        }

        this.scheduler.setEnabled(config.enabled && this.current !== null && !this.docTooSmall);
        if (this.current === null) {
            // Recording is off, so no folder was created to replace the one
            // deleted. Re-resolve promptly rather than at the next heartbeat,
            // so the panel stops showing a document with no recording sooner.
            this.scheduleResync();
        }
        this.broadcastState();
        return {
            ok: true,
            sessions: listSessions(config.processImageFolderPath),
            state: this.buildState()
        };
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
                    return this.deleteCurrentSession(config, command.sessionId);
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

function describeBounds(b: Bounds | null | undefined): string {
    if (!b) {
        return "none";
    }
    return b.left + "," + b.top + " " + (b.right - b.left) + "x" + (b.bottom - b.top);
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
    config: unknown,
    logger?: CoreLogger
): { ready: Promise<void>; stop: () => Promise<void> } | undefined {
    let plugin: FRecordPlugin;
    try {
        const options: PluginOptions = config && typeof config === "object" ? (config as PluginOptions) : {};
        plugin = new FRecordPlugin(generator, logger || null, options);
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
