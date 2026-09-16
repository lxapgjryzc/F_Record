/**
 * On-disk layout, shared by both processes.
 *
 * Everything about a recording lives inside its own session folder, so the
 * folder is self-describing: move it, back it up, or copy it to another
 * machine and nothing is lost. The index below is a recovery cache, not the
 * source of truth.
 */

import * as path from "path";
import { getUserDataDir, pad } from "./compat";

export const APP_DIR_NAME = "F_Record";

export function appDir(): string {
    return path.join(getUserDataDir(), APP_DIR_NAME);
}

export function configPath(): string {
    return path.join(appDir(), "config.json");
}

/** Connection details the generator publishes for the panel to pick up. */
export function bridgePath(): string {
    return path.join(appDir(), "bridge.json");
}

/** Recovery index: lets a session be re-identified after Photoshop restarts. */
export function indexPath(): string {
    return path.join(appDir(), "index.json");
}

export function logDir(): string {
    return path.join(appDir(), "logs");
}

export function generatorLogPath(): string {
    return path.join(logDir(), "generator.log");
}

export function exportTempDir(): string {
    return path.join(appDir(), "exportTemp");
}

/**
 * Scratch space for "copy the canvas to the clipboard".
 *
 * Its own directory rather than a corner of exportTempDir, which a finished
 * export empties wholesale: the two would otherwise have to be careful about
 * each other for no gain.
 */
export function clipboardTempDir(): string {
    return path.join(appDir(), "clipboardTemp");
}

export function defaultProcessImageFolder(): string {
    return path.join(appDir(), "processImages");
}

export function sessionFolder(processImageFolderPath: string, sessionId: string): string {
    return path.join(processImageFolderPath, sessionId);
}

export const SESSION_MANIFEST_NAME = "session.json";

export function sessionManifestPath(folder: string): string {
    return path.join(folder, SESSION_MANIFEST_NAME);
}

/**
 * Left behind in the frames folder when a session's folder is carried off to
 * sit beside its document, so the frames folder on its own still accounts for
 * every recording: `<root>/<sessionId>.moved.json`, holding where it went.
 * The index caches the same thing, but the index is a cache; this is what a
 * fresh install on a copied drive can rebuild it from.
 */
export const MOVED_POINTER_SUFFIX = ".moved.json";

export function sessionPointerPath(processImageFolderPath: string, sessionId: string): string {
    return path.join(processImageFolderPath, sessionId + MOVED_POINTER_SUFFIX);
}

export interface MovedPointer {
    sessionId: string;
    folder: string;
}

/**
 * The folder a recording gets beside its document: `C:\art\dragon.psd` puts
 * its frames in `C:\art\dragon_frames`. Named after the file rather than the
 * session id so the two read as a pair in Explorer, which is the point of
 * carrying the folder there at all.
 */
export function documentSideFolder(filePath: string): string {
    const base = path.basename(filePath).replace(/\.[^.]+$/, "");
    return path.join(path.dirname(filePath), base + "_frames");
}

/* ------------------------------------------------------------------ frames */

/**
 * Frames are named `<seq6>_<epochMillis>.<ext>`.
 *
 * The sequence keeps lexical sort order correct and the timestamp records the
 * real drawing rhythm, which the exporter turns into per-frame durations. The
 * pair also means the directory listing *is* the frame count -- there is no
 * separate counter file that can drift out of sync with the files on disk,
 * which is how the previous layout lost frames after a Save As or a crash.
 */
/**
 * Six digits is the zero-padded minimum, not a maximum: a long-running
 * document eventually writes `1000000_...jpg`, and a strict `\d{6}` would make
 * every frame past that invisible to the scanner -- silently dropping them
 * from the frame count and the export. Ordering is by the parsed integer, so
 * the extra digit does not disturb the sort either.
 */
const FRAME_RE = /^(\d{6,})_(\d{10,16})\.(jpg|jpeg)$/i;

export function frameFileName(seq: number, timestampMs: number, ext = "jpg"): string {
    return pad(seq, 6) + "_" + Math.floor(timestampMs) + "." + ext;
}

export interface ParsedFrame {
    seq: number;
    timestampMs: number;
    fileName: string;
}

export function parseFrameFileName(fileName: string): ParsedFrame | null {
    const m = FRAME_RE.exec(fileName);
    if (!m) {
        return null;
    }
    return {
        seq: parseInt(m[1], 10),
        timestampMs: parseInt(m[2], 10),
        fileName: fileName
    };
}

/** Frames sorted by sequence, with unparseable entries dropped. */
export function parseFrameList(fileNames: string[]): ParsedFrame[] {
    const frames: ParsedFrame[] = [];
    for (let i = 0; i < fileNames.length; i++) {
        const parsed = parseFrameFileName(fileNames[i]);
        if (parsed) {
            frames.push(parsed);
        }
    }
    frames.sort(function (a, b) {
        return a.seq - b.seq || a.timestampMs - b.timestampMs;
    });
    return frames;
}

/**
 * Legacy (<= 3.x) frames were plain `000001.jpg` with the count kept in a
 * sibling JSON file. Recognise them so old recordings stay exportable.
 */
const LEGACY_FRAME_RE = /^(\d{6,})\.(jpg|jpeg)$/i;

export function parseLegacyFrameFileName(fileName: string): ParsedFrame | null {
    const m = LEGACY_FRAME_RE.exec(fileName);
    if (!m) {
        return null;
    }
    return { seq: parseInt(m[1], 10), timestampMs: 0, fileName: fileName };
}
