/**
 * Filesystem helpers that behave identically from Node 6 up to Node 22.
 *
 * Photoshop hands us wildly different Node runtimes depending on the host:
 * the CEP panel gets Node 8.6 (PS 2020) through 17.7 (PS 2024+), and the
 * Generator process gets its own, separately-versioned Node. Anything newer
 * than Node 8 has to be feature-detected rather than assumed -- the previous
 * release called fs.rmSync (Node 14.14+) unconditionally, which made export
 * throw outright on PS 2020 and PS 2021.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const NODE_VERSION = (function (): [number, number] {
    const raw = (typeof process !== "undefined" && process.versions && process.versions.node) || "0.0.0";
    const parts = raw.split(".");
    return [parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0];
})();

function nodeAtLeast(major: number, minor: number): boolean {
    if (NODE_VERSION[0] !== major) {
        return NODE_VERSION[0] > major;
    }
    return NODE_VERSION[1] >= minor;
}

const HAS_RECURSIVE_MKDIR = nodeAtLeast(10, 12);
const HAS_RM = nodeAtLeast(14, 14);
const HAS_RECURSIVE_RMDIR = nodeAtLeast(12, 10);
const HAS_COPY_FILE = nodeAtLeast(8, 5);

export function exists(target: string): boolean {
    try {
        fs.statSync(target);
        return true;
    } catch (e) {
        return false;
    }
}

export function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch (e) {
        return false;
    }
}

/** Recursive mkdir that is a no-op when the directory already exists. */
export function mkdirp(target: string): void {
    if (HAS_RECURSIVE_MKDIR) {
        fs.mkdirSync(target, { recursive: true } as any);
        return;
    }
    // Node < 10.12: walk up until we find an existing ancestor, then descend.
    const parent = path.dirname(target);
    if (parent !== target && !exists(parent)) {
        mkdirp(parent);
    }
    try {
        fs.mkdirSync(target);
    } catch (e) {
        // EEXIST is fine; anything else is a real failure.
        if (!exists(target)) {
            throw e;
        }
    }
}

/** Recursive delete. Never throws when the target is already gone. */
export function rmrf(target: string): void {
    if (!exists(target)) {
        return;
    }
    if (HAS_RM) {
        fs.rmSync(target, { recursive: true, force: true } as any);
        return;
    }
    if (HAS_RECURSIVE_RMDIR && isDirectory(target)) {
        fs.rmdirSync(target, { recursive: true } as any);
        return;
    }
    if (!isDirectory(target)) {
        try {
            fs.unlinkSync(target);
        } catch (e) {
            /* already gone */
        }
        return;
    }
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(target);
    } catch (e) {
        return;
    }
    for (let i = 0; i < entries.length; i++) {
        rmrf(path.join(target, entries[i]));
    }
    try {
        fs.rmdirSync(target);
    } catch (e) {
        /* raced with another delete */
    }
}

/** How duplicateFile got the bytes to the other path. */
export type DuplicateMode = "link" | "copy";

/**
 * Puts the contents of `source` at `dest` as cheaply as the filesystem allows.
 *
 * A hard link is tried first. A frame is written once and never touched again,
 * so two directory entries pointing at one set of bytes behave exactly like two
 * copies -- either folder can be deleted, renamed or exported from without the
 * other noticing -- while costing no disk space and no time. That matters
 * because the same recording gets duplicated again on every Save As, and a
 * habit of saving each milestone under a new name would otherwise multiply a
 * few gigabytes of frames by the number of milestones.
 *
 * Links are refused by exFAT and by network shares, and never work across
 * volumes. Those fall back to a real byte copy, which is correct but slow;
 * callers report which one happened so the log says where the time went.
 */
export function duplicateFile(source: string, dest: string): DuplicateMode {
    try {
        fs.linkSync(source, dest);
        return "link";
    } catch (e) {
        copyFileContents(source, dest);
        return "copy";
    }
}

function copyFileContents(source: string, dest: string): void {
    if (HAS_COPY_FILE) {
        fs.copyFileSync(source, dest);
        return;
    }
    fs.writeFileSync(dest, fs.readFileSync(source));
}

let atomicCounter = 0;

/**
 * Write-then-rename so a reader never observes a half-written file.
 *
 * Replaces the write-file-atomic dependency, which littered the data directory
 * with `<name>.<pid><random>` temp files that the panel then had to sweep up.
 * Temp files here live in the same directory (rename must not cross devices)
 * but use a fixed, recognisable suffix and are removed on every failure path.
 */
export function writeFileAtomic(target: string, data: string | Buffer): void {
    mkdirp(path.dirname(target));
    atomicCounter = (atomicCounter + 1) % 0xffff;
    const tmp = target + ".tmp-" + process.pid.toString(36) + "-" + atomicCounter.toString(36);
    try {
        fs.writeFileSync(tmp, data);
        // renameSync overwrites an existing destination on POSIX, but on Windows
        // it throws EPERM/EEXIST, so drop the old file first.
        if (process.platform === "win32" && exists(target)) {
            try {
                fs.unlinkSync(target);
            } catch (e) {
                /* fall through to rename, which will report the real problem */
            }
        }
        fs.renameSync(tmp, target);
    } catch (e) {
        try {
            fs.unlinkSync(tmp);
        } catch (e2) {
            /* best effort */
        }
        throw e;
    }
}

export function readJson<T>(target: string, fallback: T): T {
    try {
        const raw = fs.readFileSync(target, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") {
            return fallback;
        }
        return parsed as T;
    } catch (e) {
        return fallback;
    }
}

export function writeJsonAtomic(target: string, value: unknown): void {
    writeFileAtomic(target, JSON.stringify(value, null, 2));
}

/** Base directory for per-user application data. */
export function getUserDataDir(): string {
    if (process.platform === "win32") {
        return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    }
    return path.join(os.homedir(), "Library", "Application Support");
}

/** `Object.assign` without relying on it existing (Node 6 has it; be explicit anyway). */
export function assign<T>(target: T, ...sources: Array<Partial<T> | null | undefined>): T {
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (!source) {
            continue;
        }
        const keys = Object.keys(source);
        for (let k = 0; k < keys.length; k++) {
            (target as any)[keys[k]] = (source as any)[keys[k]];
        }
    }
    return target;
}

export function pad(num: number, size: number): string {
    let s = String(Math.floor(Math.abs(num)));
    while (s.length < size) {
        s = "0" + s;
    }
    return s;
}

/** Filesystem-safe `YYYY-MM-DD-HH-mm-ss-SSS`. */
export function timeStampString(date?: Date): string {
    const d = date || new Date();
    return (
        d.getFullYear() +
        "-" + pad(d.getMonth() + 1, 2) +
        "-" + pad(d.getDate(), 2) +
        "-" + pad(d.getHours(), 2) +
        "-" + pad(d.getMinutes(), 2) +
        "-" + pad(d.getSeconds(), 2) +
        "-" + pad(d.getMilliseconds(), 3)
    );
}

export function randomHex(bytes: number): string {
    let out = "";
    for (let i = 0; i < bytes; i++) {
        out += pad2Hex(Math.floor(Math.random() * 256));
    }
    return out;
}

function pad2Hex(n: number): string {
    const s = n.toString(16);
    return s.length === 1 ? "0" + s : s;
}

export const nodeVersionInfo = {
    major: NODE_VERSION[0],
    minor: NODE_VERSION[1],
    hasRecursiveMkdir: HAS_RECURSIVE_MKDIR,
    hasRm: HAS_RM,
    hasRecursiveRmdir: HAS_RECURSIVE_RMDIR,
    hasCopyFile: HAS_COPY_FILE
};

/**
 * One line saying which Node this is and which fallbacks are live.
 *
 * This module exists because Photoshop hands each half of the plug-in a
 * different, sometimes very old Node -- 8.6 in the 2020 panel, 22 in the 2026
 * generator -- and 3.x's export was broken on the old ones precisely because it
 * called fs.rmSync unconditionally. Those are also the hosts hardest to get
 * hold of for testing, so when someone reports "export does nothing on 2020"
 * the first useful question is which of these detections fired. Printing it
 * beats asking them to guess.
 *
 * Example: `Node 8.6 (fallbacks: mkdir, rm, rmdir)` / `Node 22.18 (no fallbacks)`
 */
export function describeNodeCompat(): string {
    const fallbacks: string[] = [];
    if (!HAS_RECURSIVE_MKDIR) {
        fallbacks.push("mkdir");
    }
    if (!HAS_RM) {
        fallbacks.push("rm");
    }
    if (!HAS_RECURSIVE_RMDIR) {
        fallbacks.push("rmdir");
    }
    if (!HAS_COPY_FILE) {
        fallbacks.push("copyFile");
    }
    const version = "Node " + NODE_VERSION[0] + "." + NODE_VERSION[1];
    return version + (fallbacks.length ? " (fallbacks: " + fallbacks.join(", ") + ")" : " (no fallbacks)");
}
