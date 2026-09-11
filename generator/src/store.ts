/**
 * Persistence for config, session manifests, and the recovery index.
 *
 * The generator process is the single writer for all of these. The panel reads
 * state over the bridge and mutates it by sending commands, which removes the
 * two-writer race the 3.x file-polling design had.
 */

import * as fs from "fs";
import * as path from "path";
import {
    Config,
    DEFAULT_CONFIG,
    Bounds,
    FrameFormat,
    LANGUAGES,
    RESOLUTIONS,
    Resolution,
    SessionSummary,
    normalizeClipboardResolution,
    normalizeWatermark,
    normalizeExportDefaults
} from "../../shared/protocol";
import {
    assign,
    DuplicateMode,
    copyFile,
    duplicateFile,
    exists,
    mkdirp,
    readJson,
    writeJsonAtomic,
    rmrf,
    isDirectory
} from "../../shared/compat";
import {
    appDir,
    configPath,
    indexPath,
    defaultProcessImageFolder,
    sessionFolder,
    sessionManifestPath,
    sessionPointerPath,
    documentSideFolder,
    MOVED_POINTER_SUFFIX,
    MovedPointer,
    parseFrameList,
    parseLegacyFrameFileName,
    ParsedFrame
} from "../../shared/paths";

export const MANIFEST_VERSION = 4;

export interface SessionManifest {
    version: number;
    sessionId: string;
    docName: string;
    /** Every path this document has been saved to, oldest first. */
    filePathHistory: string[];
    canvasBounds: Bounds | null;
    /** Cached; the directory listing is the source of truth. */
    frameCount: number;
    timeSpentSec: number;
    createdAt: number;
    lastModifiedAt: number;
    format: FrameFormat;
    resolution: Resolution;
    /** Cached next sequence number; recomputed from disk when reopening. */
    nextSeq: number;
    /**
     * Finished, and filed under the panel's Archive tab. Absent rather than
     * false on every manifest written before the flag existed. Cleared again
     * by the next frame recorded into the folder: drawing on a piece is the
     * one sure sign it was not finished after all.
     */
    archived?: boolean;
    archivedAt?: number;
}

export interface IndexEntry {
    sessionId: string;
    folder: string;
    /** Photoshop document ids, only trustworthy within the run that wrote them. */
    docIds: number[];
    psRunId: string;
    filePaths: string[];
    canvasWidth: number;
    canvasHeight: number;
    firstSeen: number;
    lastSeen: number;
}

interface IndexFile {
    version: number;
    entries: IndexEntry[];
}

/* ------------------------------------------------------------------ config */

export class ConfigStore {
    private config: Config;

    constructor() {
        this.config = this.load();
    }

    private load(): Config {
        mkdirp(appDir());
        const base = assign({} as Config, DEFAULT_CONFIG as Partial<Config>, {
            processImageFolderPath: defaultProcessImageFolder()
        } as Partial<Config>);
        const stored = readJson<Partial<Config>>(configPath(), {});
        return normalizeConfig(assign({} as Config, base, stored));
    }

    get(): Config {
        return this.config;
    }

    /** Applies a patch, normalizes it, persists it, and returns the result. */
    update(patch: Partial<Config>): Config {
        this.config = normalizeConfig(assign({} as Config, this.config, patch));
        this.persist();
        return this.config;
    }

    persist(): void {
        writeJsonAtomic(configPath(), this.config);
    }
}

export function normalizeConfig(config: Config): Config {
    const out = assign({} as Config, config);

    out.enabled = !!out.enabled;
    out.autoStart = !!out.autoStart;
    out.autoStartNewDocuments = !!out.autoStartNewDocuments;

    if (RESOLUTIONS.indexOf(out.resolution) === -1) {
        out.resolution = DEFAULT_CONFIG.resolution;
    }
    out.quality = clampInt(out.quality, 1, 100, DEFAULT_CONFIG.quality);
    out.idleTimeoutMinutes = clampInt(out.idleTimeoutMinutes, 0, 24 * 60, DEFAULT_CONFIG.idleTimeoutMinutes);
    out.minIntervalMs = clampInt(out.minIntervalMs, 200, 60000, DEFAULT_CONFIG.minIntervalMs);
    out.minCanvasPixels = clampInt(out.minCanvasPixels, 0, 1e9, DEFAULT_CONFIG.minCanvasPixels);

    // 4.0 stored "cn"/"en"; 4.1 uses BCP 47 tags so they can be matched against
    // Photoshop's own appUILocale. Migrate rather than resetting, or every
    // existing Chinese user would silently be moved to auto-detect.
    const legacy = out.language as unknown as string;
    if (legacy === "cn") {
        out.language = "zh-CN";
    }
    if (LANGUAGES.indexOf(out.language) === -1) {
        out.language = DEFAULT_CONFIG.language;
    }

    out.checkForUpdates = !!out.checkForUpdates;
    if (typeof out.dismissedUpdateVersion !== "string" || out.dismissedUpdateVersion.length === 0) {
        out.dismissedUpdateVersion = null;
    }

    out.format = "jpg";

    out.staleMaxFrames = clampInt(out.staleMaxFrames, 0, 1e6, DEFAULT_CONFIG.staleMaxFrames);
    out.staleAfterDays = clampInt(out.staleAfterDays, 0, 36500, DEFAULT_CONFIG.staleAfterDays);

    // Always a fresh object: DEFAULT_CONFIG carries the default watermark by
    // reference, and a stored config that shared it could edit the default.
    out.watermark = normalizeWatermark(out.watermark);
    // Absent means a config written before this setting existed, and the
    // default is on -- so only an explicit `false` turns it off.
    out.clipboardWatermark = out.clipboardWatermark !== false;
    out.clipboardResolution = normalizeClipboardResolution(out.clipboardResolution);
    // Same reasoning: a fresh object every time, so nothing stored can end up
    // sharing DEFAULT_CONFIG's copy and editing the default through it.
    out.exportDefaults = normalizeExportDefaults(out.exportDefaults);

    if (typeof out.processImageFolderPath !== "string" || out.processImageFolderPath.length === 0) {
        out.processImageFolderPath = defaultProcessImageFolder();
    }
    return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === "number" ? value : parseInt(String(value), 10);
    if (!isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
}

/* ----------------------------------------------------------------- session */

export function readManifest(folder: string): SessionManifest | null {
    const manifest = readJson<SessionManifest | null>(sessionManifestPath(folder), null as any);
    if (!manifest || typeof manifest.sessionId !== "string") {
        return null;
    }
    return manifest;
}

export function writeManifest(folder: string, manifest: SessionManifest): void {
    mkdirp(folder);
    writeJsonAtomic(sessionManifestPath(folder), manifest);
}

export function createManifest(
    sessionId: string,
    docName: string,
    filePath: string | null,
    bounds: Bounds | null,
    config: Config
): SessionManifest {
    const now = Date.now();
    return {
        version: MANIFEST_VERSION,
        sessionId: sessionId,
        docName: docName,
        filePathHistory: filePath ? [filePath] : [],
        canvasBounds: bounds,
        frameCount: 0,
        timeSpentSec: 0,
        createdAt: now,
        lastModifiedAt: now,
        format: config.format,
        resolution: config.resolution,
        nextSeq: 1
    };
}

/**
 * Reads the frames actually on disk. This is the authority for frame count and
 * the next sequence number -- the manifest only caches them so the panel does
 * not have to stat a 10,000-file directory on every update.
 */
export function scanFrames(folder: string): ParsedFrame[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(folder);
    } catch (e) {
        return [];
    }
    const frames = parseFrameList(entries);
    if (frames.length > 0) {
        return frames;
    }
    // Fall back to the 3.x `000001.jpg` naming so old recordings still export.
    const legacy: ParsedFrame[] = [];
    for (let i = 0; i < entries.length; i++) {
        const parsed = parseLegacyFrameFileName(entries[i]);
        if (parsed) {
            legacy.push(parsed);
        }
    }
    legacy.sort(function (a, b) {
        return a.seq - b.seq;
    });
    return legacy;
}

export function summarizeSession(folder: string): SessionSummary | null {
    const manifest = readManifest(folder);
    const sessionId = manifest ? manifest.sessionId : path.basename(folder);
    let frames: ParsedFrame[] = [];
    let error: string | undefined;
    try {
        frames = scanFrames(folder);
    } catch (e) {
        error = e && (e as Error).message ? (e as Error).message : String(e);
    }
    if (!manifest && frames.length === 0) {
        return null;
    }
    const last = frames.length > 0 ? frames[frames.length - 1] : null;
    const summary: SessionSummary = {
        sessionId: sessionId,
        folder: folder,
        docName: manifest ? manifest.docName : sessionId,
        filePathHistory: manifest ? manifest.filePathHistory || [] : [],
        canvasBounds: manifest ? manifest.canvasBounds : null,
        frameCount: frames.length,
        timeSpentSec: manifest ? manifest.timeSpentSec : 0,
        createdAt: manifest ? manifest.createdAt : 0,
        lastModifiedAt: manifest
            ? Math.max(manifest.lastModifiedAt, last ? last.timestampMs : 0)
            : last ? last.timestampMs : 0,
        format: manifest ? manifest.format : "jpg",
        resolution: manifest ? manifest.resolution : "1080",
        archived: manifest ? !!manifest.archived : false
    };
    if (error) {
        summary.error = error;
    }
    return summary;
}

/**
 * What the listing shows for a recording whose pointer leads nowhere: the
 * folder was carried off beside its document and has since been moved or
 * deleted by hand. Listed rather than dropped, so the artist learns where it
 * was last seen and can delete the entry, instead of a recording vanishing
 * from the panel without a word.
 */
function summarizeDangling(sessionId: string, pointer: MovedPointer): SessionSummary {
    return {
        sessionId: sessionId,
        folder: pointer.folder,
        docName: sessionId,
        filePathHistory: [],
        canvasBounds: null,
        frameCount: 0,
        timeSpentSec: 0,
        createdAt: 0,
        lastModifiedAt: 0,
        format: "jpg",
        resolution: "1080",
        archived: false,
        error: "Folder not found: " + pointer.folder
    };
}

/**
 * Every recording the frames folder knows of: the folders in it, plus the
 * ones a pointer file says were carried off beside their documents. A folder
 * still being carried (see moveFolder) is skipped until it has arrived.
 */
export function listSessions(processImageFolderPath: string): SessionSummary[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(processImageFolderPath);
    } catch (e) {
        return [];
    }
    const out: SessionSummary[] = [];
    const seen: { [sessionId: string]: boolean } = {};
    const push = function (summary: SessionSummary | null): void {
        if (summary && !seen[summary.sessionId]) {
            seen[summary.sessionId] = true;
            summary.besideDocument = isBesideDocument(processImageFolderPath, summary.folder);
            out.push(summary);
        }
    };
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const target = path.join(processImageFolderPath, entry);
        if (isDirectory(target)) {
            if (endsWith(entry, MOVING_SUFFIX)) {
                continue;
            }
            push(summarizeSession(target));
            continue;
        }
        if (endsWith(entry, MOVED_POINTER_SUFFIX)) {
            const sessionId = entry.slice(0, entry.length - MOVED_POINTER_SUFFIX.length);
            const folder = locateSession(processImageFolderPath, sessionId);
            if (folder) {
                push(summarizeSession(folder));
            } else {
                const pointer = readPointer(processImageFolderPath, sessionId);
                if (pointer) {
                    push(summarizeDangling(sessionId, pointer));
                }
            }
        }
    }
    out.sort(function (a, b) {
        return b.lastModifiedAt - a.lastModifiedAt;
    });
    return out;
}

function endsWith(text: string, suffix: string): boolean {
    return text.length > suffix.length && text.slice(text.length - suffix.length) === suffix;
}

export interface DuplicateResult {
    frameCount: number;
    /** "copy" means the filesystem refused hard links and real bytes moved. */
    mode: DuplicateMode;
}

/**
 * Puts every frame of one session into another folder.
 *
 * The filenames are kept exactly -- they carry the sequence number and the
 * capture time, which are what order the export and date the recording, so
 * renaming them would quietly change how the copy plays back.
 *
 * A frame that cannot be duplicated is skipped rather than aborting the whole
 * fork: losing one frame out of a thousand is a blemish, while failing the
 * fork outright would leave both documents recording into one folder.
 */
export async function duplicateFrames(
    fromFolder: string,
    toFolder: string,
    log: (level: "info" | "warn" | "error", message: string) => void
): Promise<DuplicateResult> {
    mkdirp(toFolder);
    const frames = scanFrames(fromFolder);
    let mode: DuplicateMode = "link";
    let copied = 0;
    for (let i = 0; i < frames.length; i++) {
        try {
            const used = duplicateFile(
                path.join(fromFolder, frames[i].fileName),
                path.join(toFolder, frames[i].fileName)
            );
            if (used === "copy") {
                mode = "copy";
            }
            copied++;
        } catch (e) {
            log("warn", "Could not duplicate frame " + frames[i].fileName + ": " + errorText(e));
        }
        // Hard links make this loop nearly free, but the byte-copy fallback on
        // a network drive does not: hand the event loop back often enough that
        // the generator keeps answering Photoshop while it runs.
        if ((i & 63) === 63) {
            await nextTick();
        }
    }
    return { frameCount: copied, mode: mode };
}

function nextTick(): Promise<void> {
    return new Promise<void>(function (resolve) {
        setTimeout(resolve, 0);
    });
}

function errorText(e: unknown): string {
    return e && (e as Error).message ? (e as Error).message : String(e);
}

export function deleteSession(processImageFolderPath: string, sessionId: string): void {
    const folder = locateSession(processImageFolderPath, sessionId);
    const pointer = readPointer(processImageFolderPath, sessionId);
    if (!folder && !pointer) {
        throw new Error(
            "Refusing to delete '" + sessionFolder(processImageFolderPath, sessionId) +
                "': not a F_Record session folder"
        );
    }
    if (folder) {
        // Refuse to delete anything that is not recognisably one of our folders.
        if (!exists(sessionManifestPath(folder)) && scanFrames(folder).length === 0) {
            throw new Error("Refusing to delete '" + folder + "': not a F_Record session folder");
        }
        rmrf(folder);
    }
    // A pointer whose folder is already gone is the whole of what is left of
    // the recording; deleting the entry is how the listing lets go of it.
    removePointer(processImageFolderPath, sessionId);
}

/* --------------------------------------------------------------- archive */

/** Sets or clears the finished flag on a manifest already in memory. */
export function applyArchived(manifest: SessionManifest, archived: boolean): void {
    if (archived) {
        manifest.archived = true;
        manifest.archivedAt = Date.now();
    } else {
        delete manifest.archived;
        delete manifest.archivedAt;
    }
}

/** The same, for a recording nobody has open: read, flag, write back. */
export function markArchived(folder: string, archived: boolean): SessionManifest {
    const manifest = readManifest(folder);
    if (!manifest) {
        throw new Error("No session.json in '" + folder + "'");
    }
    applyArchived(manifest, archived);
    writeManifest(folder, manifest);
    return manifest;
}

/* -------------------------------------------------------------- location */

/**
 * A session folder is normally `<root>/<sessionId>`. One that has been
 * carried off to sit beside its document leaves a pointer file behind in the
 * frames folder saying where it went, so the frames folder on its own still
 * accounts for every recording -- see sessionPointerPath.
 */
export function readPointer(processImageFolderPath: string, sessionId: string): MovedPointer | null {
    const pointer = readJson<MovedPointer | null>(
        sessionPointerPath(processImageFolderPath, sessionId),
        null as any
    );
    if (!pointer || typeof pointer.folder !== "string" || pointer.folder.length === 0) {
        return null;
    }
    return pointer;
}

export function writePointer(processImageFolderPath: string, sessionId: string, folder: string): void {
    writeJsonAtomic(sessionPointerPath(processImageFolderPath, sessionId), {
        sessionId: sessionId,
        folder: folder
    });
}

export function removePointer(processImageFolderPath: string, sessionId: string): void {
    rmrf(sessionPointerPath(processImageFolderPath, sessionId));
}

/**
 * Where a session's folder is now: at home under the frames folder, or
 * wherever the pointer there says it was carried to. Null when neither holds
 * it. Home wins when both exist, since that is where new frames would go.
 *
 * The pointer's target has to carry this session's own manifest before it is
 * believed. A folder the artist has since reused for something else must
 * not be recorded into, and certainly not deleted, on the strength of a
 * stale pointer.
 */
export function locateSession(processImageFolderPath: string, sessionId: string): string | null {
    const home = sessionFolder(processImageFolderPath, sessionId);
    if (isDirectory(home)) {
        return home;
    }
    const pointer = readPointer(processImageFolderPath, sessionId);
    if (pointer && isDirectory(pointer.folder)) {
        const manifest = readManifest(pointer.folder);
        if (manifest && manifest.sessionId === sessionId) {
            return pointer.folder;
        }
    }
    return null;
}

/** True when the folder sits beside a document rather than under the frames folder. */
export function isBesideDocument(processImageFolderPath: string, folder: string): boolean {
    return normalizePath(path.dirname(folder)) !== normalizePath(processImageFolderPath);
}

/**
 * The newest path in a save history that still has a file at it. Newest first
 * because Save As appends: the last entry is where the artist is working now.
 */
export function newestExistingPath(history: string[]): string | null {
    for (let i = history.length - 1; i >= 0; i--) {
        if (exists(history[i])) {
            return history[i];
        }
    }
    return null;
}

/**
 * Where a session's folder goes beside its document: `dragon_frames` next
 * to `dragon.psd`, or `dragon_frames_2` when that name is already taken by
 * something that is not this recording.
 */
export function chooseDocumentSideFolder(filePath: string, sessionId: string): string {
    const wanted = documentSideFolder(filePath);
    if (!exists(wanted) || isSessionFolder(wanted, sessionId)) {
        return wanted;
    }
    for (let n = 2; n < 1000; n++) {
        const candidate = wanted + "_" + n;
        if (!exists(candidate) || isSessionFolder(candidate, sessionId)) {
            return candidate;
        }
    }
    throw new Error("No free folder name beside '" + filePath + "'");
}

function isSessionFolder(folder: string, sessionId: string): boolean {
    const manifest = readManifest(folder);
    return !!manifest && manifest.sessionId === sessionId;
}

/* ------------------------------------------------------------------ move */

/** Suffix on the folder a copy is assembled in, until it is complete. */
export const MOVING_SUFFIX = ".moving";

export type MoveProgressListener = (done: number, total: number) => void;

/**
 * Carries a session folder to `to`, whole.
 *
 * A rename is tried first: on the same volume it is instant however many
 * frames there are. Across volumes the filesystem refuses (EXDEV) -- and the
 * frames folder defaults to C: while artwork tends to live anywhere else --
 * so the files are copied one by one and the source removed afterwards. The
 * copy yields to the event loop as it goes, as duplicateFrames does, so the
 * generator keeps answering Photoshop while a few gigabytes cross drives.
 *
 * The copy is assembled under a `.moving` name and renamed into place only
 * once complete, so nothing ever sees a half-carried folder at the
 * destination. Failure part-way removes that half and leaves the source
 * exactly as it was: nothing is lost, and the pointer saying where the
 * folder lives is written by the caller only after this has returned.
 */
export async function moveFolder(from: string, to: string, onProgress?: MoveProgressListener): Promise<void> {
    if (exists(to)) {
        throw new Error("'" + to + "' already exists");
    }
    mkdirp(path.dirname(to));
    try {
        fs.renameSync(from, to);
        if (onProgress) {
            onProgress(1, 1);
        }
        return;
    } catch (e) {
        if (!e || (e as NodeJS.ErrnoException).code !== "EXDEV") {
            throw e;
        }
    }
    await copyFolderThenDelete(from, to, onProgress);
}

/** The slow path of moveFolder, on its own so it can be exercised without two volumes. */
export async function copyFolderThenDelete(
    from: string,
    to: string,
    onProgress?: MoveProgressListener
): Promise<void> {
    const staging = to + MOVING_SUFFIX;
    rmrf(staging);
    const files = listFilesRecursively(from);
    let done = 0;
    try {
        mkdirp(staging);
        for (let i = 0; i < files.length; i++) {
            const dest = path.join(staging, files[i]);
            mkdirp(path.dirname(dest));
            copyFile(path.join(from, files[i]), dest);
            done++;
            if (onProgress) {
                onProgress(done, files.length);
            }
            if ((i & 31) === 31) {
                await nextTick();
            }
        }
        fs.renameSync(staging, to);
    } catch (e) {
        rmrf(staging);
        throw e;
    }
    rmrf(from);
}

/** Relative paths of every file under `root`, however deep. */
export function listFilesRecursively(root: string, prefix?: string): string[] {
    const out: string[] = [];
    const entries = fs.readdirSync(path.join(root, prefix || ""));
    for (let i = 0; i < entries.length; i++) {
        const relative = prefix ? path.join(prefix, entries[i]) : entries[i];
        if (isDirectory(path.join(root, relative))) {
            const nested = listFilesRecursively(root, relative);
            for (let n = 0; n < nested.length; n++) {
                out.push(nested[n]);
            }
        } else {
            out.push(relative);
        }
    }
    return out;
}

/* ------------------------------------------------------------------- index */

export class SessionIndex {
    private entries: IndexEntry[];
    private readonly runId: string;

    constructor(runId: string) {
        this.runId = runId;
        const file = readJson<IndexFile>(indexPath(), { version: MANIFEST_VERSION, entries: [] });
        this.entries = Array.isArray(file.entries) ? file.entries : [];
    }

    find(sessionId: string): IndexEntry | null {
        for (let i = 0; i < this.entries.length; i++) {
            if (this.entries[i].sessionId === sessionId) {
                return this.entries[i];
            }
        }
        return null;
    }

    /** Only meaningful for entries written by the current generator run. */
    findByDocumentId(documentId: number): IndexEntry | null {
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            if (entry.psRunId === this.runId && entry.docIds.indexOf(documentId) !== -1) {
                return entry;
            }
        }
        return null;
    }

    findByFilePath(filePath: string): IndexEntry | null {
        const needle = normalizePath(filePath);
        if (!needle) {
            return null;
        }
        let best: IndexEntry | null = null;
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            for (let p = 0; p < entry.filePaths.length; p++) {
                if (normalizePath(entry.filePaths[p]) === needle) {
                    if (!best || entry.lastSeen > best.lastSeen) {
                        best = entry;
                    }
                }
            }
        }
        return best;
    }

    /** Sessions with the same canvas size, most recently touched first. */
    findByCanvas(width: number, height: number, maxAgeMs: number): IndexEntry[] {
        const cutoff = Date.now() - maxAgeMs;
        const matches: IndexEntry[] = [];
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            if (entry.canvasWidth === width && entry.canvasHeight === height && entry.lastSeen >= cutoff) {
                matches.push(entry);
            }
        }
        matches.sort(function (a, b) {
            return b.lastSeen - a.lastSeen;
        });
        return matches;
    }

    upsert(partial: {
        sessionId: string;
        folder: string;
        documentId: number | null;
        filePath: string | null;
        canvasWidth: number;
        canvasHeight: number;
    }): IndexEntry {
        let entry = this.find(partial.sessionId);
        const now = Date.now();
        if (!entry) {
            entry = {
                sessionId: partial.sessionId,
                folder: partial.folder,
                docIds: [],
                psRunId: this.runId,
                filePaths: [],
                canvasWidth: partial.canvasWidth,
                canvasHeight: partial.canvasHeight,
                firstSeen: now,
                lastSeen: now
            };
            this.entries.push(entry);
        }
        entry.folder = partial.folder;
        entry.canvasWidth = partial.canvasWidth;
        entry.canvasHeight = partial.canvasHeight;
        entry.lastSeen = now;

        if (entry.psRunId !== this.runId) {
            // Document ids from a previous Photoshop run are meaningless now.
            entry.psRunId = this.runId;
            entry.docIds = [];
        }
        if (partial.documentId !== null && entry.docIds.indexOf(partial.documentId) === -1) {
            entry.docIds.push(partial.documentId);
        }
        if (partial.filePath) {
            const normalized = normalizePath(partial.filePath);
            let known = false;
            for (let i = 0; i < entry.filePaths.length; i++) {
                if (normalizePath(entry.filePaths[i]) === normalized) {
                    known = true;
                    break;
                }
            }
            if (!known) {
                entry.filePaths.push(partial.filePath);
            }
        }
        return entry;
    }

    /**
     * Drops one document from a session's entry, leaving the rest intact.
     *
     * Used when a Save As forks a recording: the document has moved on to the
     * copy, but the session it came from keeps its file paths so reopening the
     * original file still finds it.
     */
    detachDocument(sessionId: string, documentId: number): void {
        const entry = this.find(sessionId);
        if (!entry) {
            return;
        }
        entry.docIds = entry.docIds.filter(function (id) {
            return id !== documentId;
        });
    }

    remove(sessionId: string): void {
        this.entries = this.entries.filter(function (entry) {
            return entry.sessionId !== sessionId;
        });
    }

    /** Drops entries whose session folder no longer exists. */
    prune(): void {
        this.entries = this.entries.filter(function (entry) {
            return exists(entry.folder);
        });
    }

    persist(): void {
        writeJsonAtomic(indexPath(), { version: MANIFEST_VERSION, entries: this.entries });
    }
}

export function normalizePath(p: string): string {
    if (!p) {
        return "";
    }
    let out = path.normalize(p).replace(/[\\/]+$/, "");
    if (process.platform === "win32") {
        out = out.toLowerCase();
    }
    return out;
}
