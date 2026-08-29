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
    Resolution,
    SessionSummary
} from "../../shared/protocol";
import {
    assign,
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

const RESOLUTIONS: Resolution[] = ["360", "720", "1080", "1440", "2160"];

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

    if (out.language !== "cn" && out.language !== "en") {
        out.language = DEFAULT_CONFIG.language;
    }
    out.format = "jpg";

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
        resolution: manifest ? manifest.resolution : "1080"
    };
    if (error) {
        summary.error = error;
    }
    return summary;
}

export function listSessions(processImageFolderPath: string): SessionSummary[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(processImageFolderPath);
    } catch (e) {
        return [];
    }
    const out: SessionSummary[] = [];
    for (let i = 0; i < entries.length; i++) {
        const folder = path.join(processImageFolderPath, entries[i]);
        if (!isDirectory(folder)) {
            continue;
        }
        const summary = summarizeSession(folder);
        if (summary) {
            out.push(summary);
        }
    }
    out.sort(function (a, b) {
        return b.lastModifiedAt - a.lastModifiedAt;
    });
    return out;
}

export function deleteSession(processImageFolderPath: string, sessionId: string): void {
    const folder = sessionFolder(processImageFolderPath, sessionId);
    // Refuse to delete anything that is not recognisably one of our folders.
    if (!exists(sessionManifestPath(folder)) && scanFrames(folder).length === 0) {
        throw new Error("Refusing to delete '" + folder + "': not a F_Record session folder");
    }
    rmrf(folder);
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

    all(): IndexEntry[] {
        return this.entries;
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
