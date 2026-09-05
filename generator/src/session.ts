/**
 * Session identity -- the part that has to survive "Save As".
 *
 * Photoshop has a long-standing bug where saving a document under a new name
 * wipes its `generatorSettings`. 3.x stored the recording's identity there and
 * nowhere else, so a Save As silently orphaned the recording and started a new
 * folder mid-drawing.
 *
 * The fix is to stop treating the PSD as the only home for the identity. A
 * session id is written to three places with different failure modes:
 *
 *   1. the PSD's generatorSettings -- survives close/reopen, dies on Save As
 *   2. an in-memory documentId map  -- survives Save As, dies on PS restart
 *   3. the on-disk recovery index   -- survives PS restart, dies on doc rename
 *
 * Any one of them can re-identify the document, and whenever the PSD copy is
 * found missing it is written back immediately. That turns the manual patch in
 * 3.x into an automatic, permanent invariant.
 *
 * Constraint worth knowing: generator-core's setGeneratorSettings.jsx targets
 * the *active* document (`putEnumerated(classDocument, typeOrdinal, enumTarget)`)
 * while reads take an explicit document id. So a re-stamp can only be applied
 * to the document that is currently frontmost; for anything else we queue it
 * and retry when that document becomes active.
 */

import {
    Bounds,
    Config,
    SessionSummary
} from "../../shared/protocol";
import { assign, exists, mkdirp, randomHex, timeStampString } from "../../shared/compat";
import { sessionFolder } from "../../shared/paths";
import {
    SessionIndex,
    SessionManifest,
    createManifest,
    duplicateFrames,
    readManifest,
    writeManifest,
    scanFrames,
    summarizeSession,
    normalizePath
} from "./store";

/** How far back to look when guessing which session a reopened document is. */
export const CANVAS_MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface DocInfo {
    id: number;
    /** Raw `documentInfo.file`: a full path once saved, else "Untitled-1". */
    file: string;
    bounds: Bounds | null;
}

/** Everything this module needs from Photoshop, so it can be faked in tests. */
export interface PsGateway {
    getDocumentSettings(documentId: number): Promise<Record<string, unknown>>;
    /** Applies to the frontmost document only -- see the note at the top. */
    setActiveDocumentSettings(settings: Record<string, unknown>): Promise<void>;
    getActiveDocumentId(): number | null;
    /** False once Photoshop has closed the document. */
    isDocumentOpen(documentId: number): Promise<boolean>;
}

export interface ResolvedSession {
    sessionId: string;
    folder: string;
    manifest: SessionManifest;
    /** A brand new recording was started for this document. */
    isNew: boolean;
    /** The PSD's copy of the id was missing and has been written back. */
    restamped: boolean;
}

export interface ResolveOutcome {
    /** Null when nothing matched and creating a session was not permitted. */
    session: ResolvedSession | null;
    /**
     * Sessions this document might be a continuation of, best match first.
     * Offered to the user rather than adopted automatically: picking the wrong
     * one corrupts a recording, whereas a spurious new session costs a folder.
     */
    candidates: SessionSummary[];
}

export function documentDisplayName(file: string): string {
    if (!file) {
        return "Untitled";
    }
    const base = file.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || file;
    return base.replace(/\.[^.]+$/, "");
}

/** `documentInfo.file` is a real path only once the document has been saved. */
export function documentFilePath(file: string): string | null {
    if (!file || !/[\\/]/.test(file)) {
        return null;
    }
    return file;
}

/**
 * True when a document that was open as one file is now open as another, with
 * the first still sitting on disk -- which is what Save As leaves behind.
 *
 * Both have to be real paths: an untitled document being saved for the first
 * time leaves nothing to reopen, so there is nothing to fork. The old file
 * still existing is what separates Save As from the other ways a path can
 * change; "Save a Copy" never gets here at all, since it leaves the open
 * document's own path alone.
 */
export function isSaveAsRename(before: string, after: string): boolean {
    if (documentFilePath(before) === null || documentFilePath(after) === null) {
        return false;
    }
    if (normalizePath(before) === normalizePath(after)) {
        return false;
    }
    return exists(before);
}

export function canvasSize(bounds: Bounds | null): { width: number; height: number } {
    if (!bounds) {
        return { width: 0, height: 0 };
    }
    return {
        width: Math.max(0, Math.round(bounds.right - bounds.left)),
        height: Math.max(0, Math.round(bounds.bottom - bounds.top))
    };
}

export function newSessionId(): string {
    return timeStampString() + "-" + randomHex(4);
}

export class SessionResolver {
    /** documentId -> sessionId, valid only for the current Photoshop run. */
    private readonly docToSession: { [docId: number]: string } = {};
    /** Documents whose PSD copy still needs writing once they become active. */
    private readonly pendingStamps: { [docId: number]: string } = {};

    constructor(
        private readonly ps: PsGateway,
        private readonly index: SessionIndex,
        private readonly log: (level: "info" | "warn" | "error", message: string) => void
    ) {}

    /**
     * Reads the session id stored inside the PSD. Returns null both when the
     * document has never been recorded and when Photoshop wiped the settings --
     * the caller cannot tell those apart from this alone, which is exactly why
     * the other two lookups exist.
     */
    private async readStoredSessionId(documentId: number): Promise<string | null> {
        try {
            const settings = await this.ps.getDocumentSettings(documentId);
            const sessionId = settings && (settings as any).sessionId;
            return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
        } catch (e) {
            // extractDocumentSettings throws when generatorSettings is absent.
            return null;
        }
    }

    /**
     * Writes the session id back into the PSD. Only the frontmost document can
     * be written, so non-active documents are queued for `flushPendingStamps`.
     */
    private async stamp(documentId: number, sessionId: string): Promise<boolean> {
        if (this.ps.getActiveDocumentId() !== documentId) {
            this.pendingStamps[documentId] = sessionId;
            return false;
        }
        try {
            await this.ps.setActiveDocumentSettings({ sessionId: sessionId });
            delete this.pendingStamps[documentId];
            return true;
        } catch (e) {
            this.pendingStamps[documentId] = sessionId;
            this.log("warn", "Could not write session id into document " + documentId + ": " + errText(e));
            return false;
        }
    }

    /** Retries stamps that were deferred because their document was not active. */
    async flushPendingStamps(): Promise<void> {
        const active = this.ps.getActiveDocumentId();
        if (active === null) {
            return;
        }
        const sessionId = this.pendingStamps[active];
        if (!sessionId) {
            return;
        }
        await this.stamp(active, sessionId);
    }

    /**
     * Called after a save. If Photoshop cleared the settings we know about it
     * immediately rather than at the next capture, so no frames are ever
     * written to a fresh folder by mistake.
     */
    async repairAfterSave(documentId: number): Promise<boolean> {
        const known = this.docToSession[documentId];
        if (!known) {
            return false;
        }
        const stored = await this.readStoredSessionId(documentId);
        // The read can take a long time -- Photoshop answers scripts only once
        // a save is fully written -- and a Save As forks the document onto a
        // new session in the meantime. Writing `known` now would put the old
        // id back over the fork's, and every frame from then on would land in
        // the folder the file was saved away from. Whoever re-mapped the
        // document has stamped it already.
        if (this.docToSession[documentId] !== known) {
            return false;
        }
        if (stored === known) {
            return false;
        }
        this.log("info", "Document " + documentId + " lost its session id (Save As); restamping " + known);
        await this.stamp(documentId, known);
        return true;
    }

    forgetDocument(documentId: number): void {
        delete this.docToSession[documentId];
        delete this.pendingStamps[documentId];
    }

    /**
     * Finds -- or, when allowed, creates -- the session for a document.
     *
     * `allowCreate` is false when the user has not opted into recording new
     * documents; the caller then gets `candidates` to offer in the panel
     * instead of silently starting a recording.
     */
    async resolve(doc: DocInfo, config: Config, allowCreate: boolean): Promise<ResolveOutcome> {
        const filePath = documentFilePath(doc.file);
        const docName = documentDisplayName(doc.file);
        const size = canvasSize(doc.bounds);

        let sessionId: string | null = null;
        let restamped = false;
        // Steps 1-4 only choose an id; the write into the PSD happens once,
        // after step 5 has had its say. A branched document must not be
        // stamped with the id it is about to be denied.
        let needsStamp = false;

        // 1. The PSD's own copy -- unless a stamp for this document is still
        //    queued. A pending stamp means we already know the right id and
        //    merely could not write it yet, so whatever sits in the PSD is
        //    stale; trusting it here would quietly revert the document to the
        //    session it was attached to before.
        const stored = await this.readStoredSessionId(doc.id);
        const pending = this.pendingStamps[doc.id];
        if (pending && pending !== stored && this.sessionExists(config, pending)) {
            sessionId = pending;
            needsStamp = true;
        } else if (stored && this.sessionExists(config, stored)) {
            sessionId = stored;
        }

        // 2/3. In-memory map, then the persisted index by document id. Both mean
        //      the PSD copy was wiped (almost always by a Save As), so repair it.
        if (!sessionId) {
            const remembered = this.docToSession[doc.id] || null;
            const indexed = remembered ? null : this.index.findByDocumentId(doc.id);
            const candidate = remembered || (indexed ? indexed.sessionId : null);
            if (candidate && this.sessionExists(config, candidate)) {
                sessionId = candidate;
                needsStamp = true;
            }
        }

        // 4. Same file on disk as a session we already know about.
        if (!sessionId && filePath) {
            const byPath = this.index.findByFilePath(filePath);
            if (byPath && this.sessionExists(config, byPath.sessionId)) {
                sessionId = byPath.sessionId;
                needsStamp = true;
            }
        }

        // 5. One session, one document. Two documents claiming the same id
        //    means the drawing was branched in two -- see the note on
        //    heldByAnotherOpenDocument -- and the newcomer gets its own
        //    recording rather than interleaving frames into someone else's.
        if (sessionId && (await this.heldByAnotherOpenDocument(sessionId, doc.id))) {
            this.log(
                "info",
                "Document " + doc.id + " ('" + docName + "') carries session " + sessionId +
                    ", which another open document is already recording; branching it into its own recording"
            );
            sessionId = null;
            needsStamp = false;
        }

        if (sessionId && needsStamp) {
            this.docToSession[doc.id] = sessionId;
            restamped = await this.stamp(doc.id, sessionId);
        }

        // 6. Nothing matched. Collect same-canvas sessions for the panel to
        //    offer, rather than adopting one behind the user's back.
        const candidates = sessionId ? [] : this.canvasCandidates(config, size, doc.id);

        if (!sessionId) {
            if (!allowCreate) {
                return { session: null, candidates: candidates };
            }
            sessionId = newSessionId();
            const folder = sessionFolder(config.processImageFolderPath, sessionId);
            mkdirp(folder);
            writeManifest(folder, createManifest(sessionId, docName, filePath, doc.bounds, config));
            this.docToSession[doc.id] = sessionId;
            await this.stamp(doc.id, sessionId);
            this.log("info", "Started session " + sessionId + " for '" + docName + "'");
            return {
                // isNew, but not "restamped": this is the first stamp, not a repair.
                session: this.finish(doc, config, sessionId, docName, filePath, size, true, false),
                candidates: []
            };
        }

        return {
            session: this.finish(doc, config, sessionId, docName, filePath, size, false, restamped),
            candidates: []
        };
    }

    /** Attaches an existing session to a document, on the user's instruction. */
    async adopt(doc: DocInfo, config: Config, sessionId: string): Promise<ResolvedSession> {
        if (!this.sessionExists(config, sessionId)) {
            throw new Error("Session '" + sessionId + "' no longer exists");
        }
        if (await this.heldByAnotherOpenDocument(sessionId, doc.id)) {
            throw new Error("Session '" + sessionId + "' is being recorded by another open document");
        }
        const filePath = documentFilePath(doc.file);
        const docName = documentDisplayName(doc.file);
        this.docToSession[doc.id] = sessionId;
        const restamped = await this.stamp(doc.id, sessionId);
        this.log("info", "Adopted session " + sessionId + " for document " + doc.id);
        return this.finish(doc, config, sessionId, docName, filePath, canvasSize(doc.bounds), false, restamped);
    }

    /**
     * Splits a recording in two, because Save As splits the artwork in two.
     *
     * Save As is not only how a file gets renamed; it is how an artist keeps
     * a milestone and carries on, or forks one drawing into two endings. The
     * file left behind on disk is a complete work in its own right and it
     * already holds this session's id, stamped there before the split -- so
     * the frames drawn up to this moment belong to both sides.
     *
     * Which side keeps the folder is not a free choice. Photoshop only lets
     * generatorSettings be written to the document that is open, so the copy
     * has to go to the document in front: it can be stamped immediately, while
     * the file on disk keeps the id it already carries and, with it, the
     * original folder. That the folders end up named after their files is a
     * happy side effect.
     *
     * The frames are hard-linked where the filesystem allows, so forking a
     * 10,000 frame recording costs neither the disk space nor the wait a real
     * copy would -- see duplicateFile. Both folders are still independent:
     * either can be deleted or exported without the other noticing.
     */
    async forkForSaveAs(doc: DocInfo, config: Config, from: ResolvedSession): Promise<ResolvedSession> {
        const filePath = documentFilePath(doc.file);
        const docName = documentDisplayName(doc.file);
        const sessionId = newSessionId();
        const folder = sessionFolder(config.processImageFolderPath, sessionId);

        const duplicated = await duplicateFrames(from.folder, folder, this.log);

        // The copy inherits what the drawing has accumulated -- when it began,
        // how long it has taken -- but none of the paths. Those belong to the
        // file that kept the original folder; sharing them would make reopening
        // that file ambiguous between the two recordings.
        const manifest = assign({} as SessionManifest, from.manifest);
        manifest.sessionId = sessionId;
        manifest.docName = docName;
        manifest.filePathHistory = [];
        manifest.lastModifiedAt = Date.now();
        writeManifest(folder, manifest);

        // The document has moved to the copy. The session it came from keeps
        // its own file paths, so reopening the file left behind still finds it.
        this.index.detachDocument(from.sessionId, doc.id);
        // Claimed before the stamp is awaited, so a repair that was already
        // reading the PSD when the fork began sees the new owner and stands
        // down instead of writing the old id back on top; see repairAfterSave.
        this.docToSession[doc.id] = sessionId;
        await this.stamp(doc.id, sessionId);

        this.log(
            "info",
            "Save As forked session " + from.sessionId + " into " + sessionId + " for '" + docName +
                "' (" + duplicated.frameCount + " frames by " + duplicated.mode + ")"
        );
        return this.finish(doc, config, sessionId, docName, filePath, canvasSize(doc.bounds), false, false);
    }

    /** Forces a brand new session, abandoning whatever the document pointed at. */
    async startFresh(doc: DocInfo, config: Config): Promise<ResolvedSession> {
        const filePath = documentFilePath(doc.file);
        const docName = documentDisplayName(doc.file);
        const sessionId = newSessionId();
        const folder = sessionFolder(config.processImageFolderPath, sessionId);
        mkdirp(folder);
        writeManifest(folder, createManifest(sessionId, docName, filePath, doc.bounds, config));
        this.docToSession[doc.id] = sessionId;
        await this.stamp(doc.id, sessionId);
        this.log("info", "Started fresh session " + sessionId + " for document " + doc.id);
        return this.finish(doc, config, sessionId, docName, filePath, canvasSize(doc.bounds), true, false);
    }

    /**
     * Records the association everywhere, refreshes the manifest from what is
     * actually on disk, and appends any newly-seen file path.
     */
    private finish(
        doc: DocInfo,
        config: Config,
        sessionId: string,
        docName: string,
        filePath: string | null,
        size: { width: number; height: number },
        isNew: boolean,
        restamped: boolean
    ): ResolvedSession {
        const folder = sessionFolder(config.processImageFolderPath, sessionId);
        this.docToSession[doc.id] = sessionId;

        let manifest = readManifest(folder);
        if (!manifest) {
            manifest = createManifest(sessionId, docName, filePath, doc.bounds, config);
        }

        // The directory is authoritative; the manifest's counters are a cache
        // that a crash or a manual edit may have left behind.
        const frames = scanFrames(folder);
        manifest.frameCount = frames.length;
        manifest.nextSeq = frames.length > 0 ? frames[frames.length - 1].seq + 1 : 1;
        manifest.docName = docName;
        if (doc.bounds) {
            manifest.canvasBounds = doc.bounds;
        }
        if (filePath) {
            manifest.filePathHistory = manifest.filePathHistory || [];
            const normalized = normalizePath(filePath);
            let known = false;
            for (let i = 0; i < manifest.filePathHistory.length; i++) {
                if (normalizePath(manifest.filePathHistory[i]) === normalized) {
                    known = true;
                    break;
                }
            }
            if (!known) {
                manifest.filePathHistory.push(filePath);
            }
        }
        writeManifest(folder, manifest);

        this.index.upsert({
            sessionId: sessionId,
            folder: folder,
            documentId: doc.id,
            filePath: filePath,
            canvasWidth: size.width,
            canvasHeight: size.height
        });
        this.index.persist();

        return {
            sessionId: sessionId,
            folder: folder,
            manifest: manifest,
            isNew: isNew,
            restamped: restamped
        };
    }

    private sessionExists(config: Config, sessionId: string): boolean {
        return exists(sessionFolder(config.processImageFolderPath, sessionId));
    }

    private canvasCandidates(
        config: Config,
        size: { width: number; height: number },
        documentId: number
    ): SessionSummary[] {
        if (size.width === 0 || size.height === 0) {
            return [];
        }
        const matches = this.index.findByCanvas(size.width, size.height, CANVAS_MATCH_WINDOW_MS);
        const out: SessionSummary[] = [];
        for (let i = 0; i < matches.length && out.length < 5; i++) {
            const entry = matches[i];
            // The index outlives changes to the process-image folder, so drop
            // entries that live somewhere the user is no longer recording to.
            if (normalizePath(entry.folder) !== normalizePath(sessionFolder(config.processImageFolderPath, entry.sessionId))) {
                continue;
            }
            // Skip sessions already attached to another open document.
            if (
                entry.docIds.indexOf(documentId) === -1 &&
                this.otherDocumentsHolding(entry.sessionId, documentId).length > 0
            ) {
                continue;
            }
            const summary = summarizeSession(entry.folder);
            if (summary && summary.frameCount > 0) {
                out.push(summary);
            }
        }
        return out;
    }

    /**
     * True when another document Photoshop still has open is recording into
     * this session.
     *
     * Save As is also how an artist branches a drawing in two. The open
     * document keeps the recording -- that is the entire point of the repair
     * above -- while the file left behind on disk still carries the same
     * session id, stamped into it before the split. Reopen that file to try a
     * different direction and two documents now claim one folder: both write
     * frames into it and the export interleaves two different drawings into
     * one video. So the second document is branched off instead.
     *
     * The map alone is not proof of a conflict. A document closed without us
     * seeing the event leaves a stale entry behind, and treating that as a
     * conflict would split a recording merely because a file was reopened --
     * the exact failure this whole module exists to prevent. Photoshop is
     * asked whether the other document really is still open, and entries it
     * no longer recognises are dropped.
     */
    private async heldByAnotherOpenDocument(sessionId: string, documentId: number): Promise<boolean> {
        const holders = this.otherDocumentsHolding(sessionId, documentId);
        for (let i = 0; i < holders.length; i++) {
            if (await this.ps.isDocumentOpen(holders[i])) {
                return true;
            }
            this.forgetDocument(holders[i]);
        }
        return false;
    }

    /** Documents other than this one that the map has attached to the session. */
    private otherDocumentsHolding(sessionId: string, documentId: number): number[] {
        const out: number[] = [];
        const keys = Object.keys(this.docToSession);
        for (let i = 0; i < keys.length; i++) {
            const id = parseInt(keys[i], 10);
            if (id !== documentId && this.docToSession[id] === sessionId) {
                out.push(id);
            }
        }
        return out;
    }
}

function errText(e: unknown): string {
    if (e && (e as Error).message) {
        return (e as Error).message;
    }
    return String(e);
}
