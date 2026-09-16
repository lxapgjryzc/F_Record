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
 * Both halves of that are addressed by document id -- including the write,
 * which Adobe's own setGeneratorSettings.jsx is not; see stamp.ts for why the
 * plug-in sends its own script instead. A stamp therefore lands in the
 * document it names, whatever is frontmost, and every write is read back by id
 * to prove it. Queued stamps exist only for writes Photoshop refused outright.
 *
 * The index is the odd one out. The other two name a document; it names a
 * file, and finds whatever sits at that path now -- which, once a file has
 * been overwritten under the same name, is a different piece of work. So it
 * is believed only for a document that was opened from the file, on a canvas
 * the size the recording was last seen at, and never over an id the document
 * carries itself; see recordingOfFile.
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
    locateSession,
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
    /**
     * Writes settings into this document, or reports that Photoshop declined
     * because it is not the document in front. Photoshop cannot be made to
     * write anywhere else, so `false` here is a normal answer and not a
     * failure; see stamp.ts.
     */
    setDocumentSettings(documentId: number, settings: Record<string, unknown>): Promise<boolean>;
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

/** One source of a document's identity, and what taking it would cost. */
interface Candidate {
    sessionId: string;
    /** Named in the log when a candidate is rejected or repaired. */
    source: string;
    /** The PSD's copy disagrees with this and has to be written back. */
    needsStamp: boolean;
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
    /**
     * documentId -> the normalized path the document had when this run first
     * saw it, "" for one that was untitled. Kept for the whole run, even past
     * forgetDocument: a document id is never reused within a run, and being
     * forgotten does not change where a document came from.
     */
    private readonly docOrigins: { [docId: number]: string } = {};
    /** Where the last retry left off, so no queued document starves. */
    private stampCursor = 0;

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
     * Writes the session id back into the PSD and proves it landed.
     *
     * The read is by document id and so cannot be aimed at the wrong document;
     * it is the only witness worth having, because a write that reports
     * success has only told us Photoshop ran the script, not what it ran it
     * against. Anything short of the id coming back out of *this* document is
     * a failure and is queued for `flushPendingStamps`.
     */
    private async stamp(documentId: number, sessionId: string): Promise<boolean> {
        try {
            if (await this.ps.setDocumentSettings(documentId, { sessionId: sessionId })) {
                const readBack = await this.readStoredSessionId(documentId);
                if (readBack !== sessionId) {
                    throw new Error(
                        "it still reads " + (readBack === null ? "nothing" : "'" + readBack + "'")
                    );
                }
                delete this.pendingStamps[documentId];
                return true;
            }
        } catch (e) {
            this.queueStamp(documentId, sessionId, "warn", "could not be written: " + errText(e));
            return false;
        }
        // Nothing went wrong: Photoshop simply will not write into a document
        // that is not in front, and this one is not. It waits its turn.
        this.queueStamp(documentId, sessionId, "info", "waits until its document is in front again");
        return false;
    }

    /**
     * Remembers a stamp for `flushPendingStamps`, saying so once.
     *
     * Once, because the retry runs on the heartbeat: a document the artist has
     * left for the afternoon would otherwise write a line a second.
     */
    private queueStamp(
        documentId: number,
        sessionId: string,
        level: "info" | "warn",
        what: string
    ): void {
        const alreadyQueued = this.pendingStamps[documentId] === sessionId;
        this.pendingStamps[documentId] = sessionId;
        if (!alreadyQueued) {
            this.log(level, "Session id for document " + documentId + " " + what);
        }
    }

    /**
     * Retries one queued stamp.
     *
     * One per call, on the heartbeat: a write Photoshop is sitting on must not
     * be joined by another every second, to be executed as a batch when it
     * finally wakes up. In rotation, because Photoshop takes a write only for
     * the document in front -- always starting at the same end of the queue
     * would spend every attempt on a document the artist has left and never
     * reach the one they are looking at. Documents Photoshop has since closed
     * are dropped rather than retried forever.
     */
    async flushPendingStamps(): Promise<void> {
        const keys = Object.keys(this.pendingStamps);
        if (keys.length === 0) {
            return;
        }
        const start = this.stampCursor % keys.length;
        for (let n = 0; n < keys.length; n++) {
            const documentId = parseInt(keys[(start + n) % keys.length], 10);
            const sessionId = this.pendingStamps[documentId];
            if (!(await this.ps.isDocumentOpen(documentId))) {
                this.forgetDocument(documentId);
                continue;
            }
            this.stampCursor = start + n + 1;
            await this.stamp(documentId, sessionId);
            return;
        }
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
     * Every id that could be this document's, best first, with the ones whose
     * folder has gone dropped and duplicates collapsed onto their best source.
     */
    private async candidateSessions(
        doc: DocInfo,
        config: Config,
        filePath: string | null
    ): Promise<Candidate[]> {
        const out: Candidate[] = [];
        const add = (sessionId: string | null, source: string, needsStamp: boolean): void => {
            if (!sessionId || !this.sessionExists(config, sessionId)) {
                return;
            }
            for (let i = 0; i < out.length; i++) {
                if (out[i].sessionId === sessionId) {
                    return;
                }
            }
            out.push({ sessionId: sessionId, source: source, needsStamp: needsStamp });
        };

        // A queued stamp means we already know the right id and merely could
        // not write it yet, so whatever sits in the PSD is stale; trusting
        // that would quietly revert the document to the session it was
        // attached to before.
        add(this.pendingStamps[doc.id] || null, "a queued write", true);

        // The id in the PSD is the document's own word and the best evidence
        // there is. It is written only into the document it names (see
        // stamp.ts), and it travels with the pixels: a file copied or renamed
        // over another still holds the id of the drawing it contains.
        add(await this.readStoredSessionId(doc.id), "the document itself", false);

        // Both of these mean the PSD's copy was wiped -- almost always by a
        // Save As -- so it has to be written back.
        add(this.docToSession[doc.id] || null, "this run's document map", true);
        const indexed = this.index.findByDocumentId(doc.id);
        add(indexed ? indexed.sessionId : null, "the recovery index", true);

        add(this.recordingOfFile(doc, filePath), "the file it was opened from", true);

        return out;
    }

    /**
     * The recording the index says this file belongs to, when that can be
     * this document's.
     *
     * The index remembers which file each recording was of, and after a
     * Photoshop restart it is all that is left once a Save As has wiped the
     * PSD's copy. It is also the only source that names a file rather than a
     * document, so it is the only one that can be led astray: it finds
     * whatever sits at the path now, and a name is easily reused.
     *
     * So the document must have been opened from the file. One saved to the
     * path just now is a new piece of work replacing whatever the old
     * recording was of; if it has a recording of its own, the sources above
     * already carry it. And the canvas must be the size the index last saw
     * the recording's document at: the same file cannot change size without
     * being resolved again, so a different size is a different file under
     * the same name.
     */
    private recordingOfFile(doc: DocInfo, filePath: string | null): string | null {
        if (!filePath || this.docOrigins[doc.id] !== normalizePath(filePath)) {
            return null;
        }
        const entry = this.index.findByFilePath(filePath);
        if (!entry) {
            return null;
        }
        const size = canvasSize(doc.bounds);
        if (entry.canvasWidth !== size.width || entry.canvasHeight !== size.height) {
            return null;
        }
        return entry.sessionId;
    }

    /**
     * Remembers where a document was when this run first met it. Set once:
     * every path after that is one the document was saved to, not opened
     * from, which is the distinction recordingOfFile turns on.
     */
    private noteOrigin(documentId: number, filePath: string | null): void {
        if (!(documentId in this.docOrigins)) {
            this.docOrigins[documentId] = filePath === null ? "" : normalizePath(filePath);
        }
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

        // Everything that could name this document's recording, best first.
        // Any one of them can be the only survivor of a Save As, a crash or a
        // Photoshop restart, which is why there are five.
        this.noteOrigin(doc.id, filePath);
        const sources = await this.candidateSessions(doc, config, filePath);

        let chosen: Candidate | null = null;
        for (let i = 0; i < sources.length; i++) {
            // One session, one document. Two documents claiming the same id
            // means the drawing was branched in two -- see the note on
            // heldByAnotherOpenDocument -- and the newcomer must not
            // interleave its frames into someone else's recording. The next
            // candidate is tried rather than giving up on the spot: the id in
            // a PSD can be wrong, and the file's own recording is usually
            // sitting right behind it.
            if (await this.heldByAnotherOpenDocument(sources[i].sessionId, doc.id)) {
                this.log(
                    "info",
                    "Document " + doc.id + " ('" + docName + "') gets session " + sources[i].sessionId +
                        " from " + sources[i].source + ", but another open document is already " +
                        "recording it; looking further"
                );
                continue;
            }
            chosen = sources[i];
            break;
        }

        if (!chosen) {
            // Nothing matched. Collect same-canvas sessions for the panel to
            // offer, rather than adopting one behind the user's back.
            const candidates = this.canvasCandidates(config, size, doc.id);
            if (!allowCreate) {
                return { session: null, candidates: candidates };
            }
            const fresh = newSessionId();
            const folder = sessionFolder(config.processImageFolderPath, fresh);
            mkdirp(folder);
            writeManifest(folder, createManifest(fresh, docName, filePath, doc.bounds, config));
            this.docToSession[doc.id] = fresh;
            await this.stamp(doc.id, fresh);
            this.log("info", "Started session " + fresh + " for '" + docName + "'");
            return {
                // isNew, but not "restamped": this is the first stamp, not a repair.
                session: this.finish(doc, config, fresh, docName, filePath, size, true, false),
                candidates: []
            };
        }

        // Claimed before the stamp is awaited, for the reason forkForSaveAs
        // gives: a repair that was already reading the PSD must see the new
        // owner and stand down rather than writing the old id back on top.
        this.docToSession[doc.id] = chosen.sessionId;
        const restamped = chosen.needsStamp ? await this.stamp(doc.id, chosen.sessionId) : false;

        return {
            session: this.finish(doc, config, chosen.sessionId, docName, filePath, size, false, restamped),
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
        // Wherever the folder is now: at home, or beside the document if it
        // has been carried there. A session that exists is always locatable;
        // the fallback only names where a brand new one would go.
        const folder =
            locateSession(config.processImageFolderPath, sessionId) ||
            sessionFolder(config.processImageFolderPath, sessionId);
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
        return locateSession(config.processImageFolderPath, sessionId) !== null;
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
            // A folder carried off beside its document still counts: the
            // frames folder keeps a pointer to it, which is what locates it.
            const located = locateSession(config.processImageFolderPath, entry.sessionId);
            if (!located || normalizePath(entry.folder) !== normalizePath(located)) {
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
