import * as childProcess from "node:child_process";
import * as cryptoModule from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

/* --------------------------------------------------------- fault injection */

/**
 * An `fs` that behaves exactly like the real one until a test says otherwise.
 *
 * Most of this plug-in's error handling is about a disk that says no: a frame
 * folder the user deleted mid-recording, a log that cannot be rotated, a
 * rename that loses a race with Photoshop's own save. Those are the paths bug
 * reports arrive about, and none of them can be reached by arranging real
 * files -- the whole point of `catch (e)` there is that the filesystem
 * misbehaved. So the test gets to be the filesystem for one call.
 *
 * Two rules make this work with coverage. `mockFs()` must run before the
 * module under test is imported, which means importing it with a top-level
 * `await import(...)` rather than a static import. And the fault has to be
 * settable *after* that import rather than baked into it, because Node's
 * coverage reports one result per file: a second, cache-busted instance of
 * the same module does not add to the first one's coverage, it replaces it.
 * Hence one mutable table consulted per call, rather than one module instance
 * per scenario.
 */
const faults = new Map();

/** One namespace's functions, each looking the fault table up before it acts. */
function passThrough(real) {
    const fake = Object.create(null);
    for (const key of Object.keys(real)) {
        const value = real[key];
        // Only the plain functions are wrapped. The PascalCase exports are
        // constructors (Stats, Dirent, ChildProcess) and a wrapper around one
        // would break `new`.
        if (typeof value === "function" && /^[a-z]/.test(key)) {
            fake[key] = function (...args) {
                const fault = faults.get(key);
                return fault ? fault.apply(this, args) : value.apply(real, args);
            };
        } else {
            fake[key] = value;
        }
    }
    fake.default = fake;
    return fake;
}

/**
 * The builtins worth standing in for, and why each one is here.
 *
 *   fs             a disk that says no -- the shape of most of the error
 *                  handling in this plug-in, and unreachable with real files
 *   child_process  the Recycle Bin, the clipboard and ffmpeg; driving the real
 *                  ones would make the assertion about the user's machine
 *   https          the update check, the one thing that leaves the machine
 *   http           the bridge, where a socket has to misbehave on cue
 *   crypto         the token, whose only failure is an entropy pool that is
 *                  not there
 *   zlib           the deflater, to hold open the window between a read ending
 *                  and the compressed bytes finishing
 */
const BUILTINS = {
    child_process: childProcess,
    crypto: cryptoModule,
    fs,
    http,
    https,
    zlib
};

/**
 * Stands in for one or more Node builtins, for the rest of this test file.
 *
 * With no fault set each is the real thing, so a module imported through this
 * behaves exactly as it would in Photoshop. Two rules make it work with
 * coverage. It must run before the module under test is imported, which means
 * importing that module with a top-level `await import(...)` rather than a
 * static import. And a fault has to be settable *after* that import rather
 * than baked into it, because Node's coverage reports one result per file: a
 * second, cache-busted instance of the same module does not add to the first
 * one's coverage, it replaces it. Hence one mutable table consulted per call,
 * rather than one module instance per scenario.
 */
export function mockBuiltins(mock, ...names) {
    for (let i = 0; i < names.length; i++) {
        const real = BUILTINS[names[i]];
        if (!real) {
            throw new Error("no stand-in for '" + names[i] + "'");
        }
        const fake = passThrough(real);
        mock.module(names[i], { namedExports: fake, defaultExport: fake });
    }
}

/** Makes the named function throw (or do) whatever `impl` says. */
export function setFault(name, impl) {
    faults.set(
        name,
        typeof impl === "function"
            ? impl
            : () => {
                  throw impl;
              }
    );
}

export function clearFaults() {
    faults.clear();
}

/** Runs `body` with a fault in place, clearing it afterwards either way. */
export function withFault(name, impl, body) {
    setFault(name, impl);
    try {
        return body();
    } finally {
        faults.delete(name);
    }
}

/** The same, awaiting `body` before the fault is taken away again. */
export async function withFaultAsync(name, impl, body) {
    setFault(name, impl);
    try {
        return await body();
    } finally {
        faults.delete(name);
    }
}

/** An Error carrying the `code` Node would have put on it. */
export function fsError(code, message) {
    const error = new Error(code + ": " + (message || "injected by the test suite"));
    error.code = code;
    return error;
}

/** Fails the first call with `code`, then hands over to `real`. */
export function failOnce(code, real) {
    let fired = false;
    return function (...args) {
        if (!fired) {
            fired = true;
            throw fsError(code);
        }
        return real.apply(fs, args);
    };
}

/**
 * Pretends the runtime is a different, older Node.
 *
 * Every fallback in shared/compat.ts is decided once, at import time, from
 * `process.versions.node`. Call this at the top of a test file, before the
 * module under test is imported, and that whole file runs as if it were
 * inside the Node that ships with an older Photoshop.
 */
export function pretendNodeVersion(version) {
    Object.defineProperty(process, "versions", {
        value: Object.assign({}, process.versions, { node: version }),
        configurable: true,
        writable: true
    });
}

/* ------------------------------------------------------- ambient overrides */

/**
 * Runs `body` with `process.platform` reporting something else.
 *
 * Half of this codebase branches on the platform -- the Recycle Bin, the
 * clipboard, the rename dance Windows needs and POSIX does not -- and only one
 * of those branches is the machine the tests run on.
 */
export function asPlatform(platform, body) {
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
        return body();
    } finally {
        Object.defineProperty(process, "platform", { value: real, configurable: true });
    }
}

/** The same, for `process.env` keys, restoring absent ones to absent. */
export function withEnv(values, body) {
    const saved = {};
    for (const key of Object.keys(values)) {
        saved[key] = process.env[key];
        if (values[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = values[key];
        }
    }
    try {
        return body();
    } finally {
        for (const key of Object.keys(saved)) {
            if (saved[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = saved[key];
            }
        }
    }
}

/**
 * A controllable clock for CaptureScheduler.
 *
 * The scheduler takes its timers by injection precisely so its behaviour under
 * load -- throttling, coalescing, timing out -- can be tested in milliseconds
 * instead of in real time.
 */
export function makeClock() {
    let now = 0;
    let seq = 0;
    const pending = new Map();

    const timers = {
        now: () => now,
        setTimeout: (fn, ms) => {
            const id = ++seq;
            pending.set(id, { at: now + Math.max(0, ms), fn });
            return id;
        },
        clearTimeout: (id) => {
            pending.delete(id);
        }
    };

    /** Runs every timer due within `ms`, flushing microtasks between each. */
    async function advance(ms) {
        const target = now + ms;
        for (;;) {
            let nextId = null;
            let nextAt = Infinity;
            for (const [id, timer] of pending) {
                if (timer.at <= target && timer.at < nextAt) {
                    nextAt = timer.at;
                    nextId = id;
                }
            }
            if (nextId === null) {
                break;
            }
            const timer = pending.get(nextId);
            pending.delete(nextId);
            now = timer.at;
            timer.fn();
            await flush();
        }
        now = target;
        await flush();
    }

    return { timers, advance, pendingCount: () => pending.size, now: () => now };
}

/** Lets queued promise callbacks run. */
export async function flush(times = 6) {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
    }
}

/** A promise whose settlement the test controls. */
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Creates an isolated temp directory and returns it plus a cleanup function. */
export function tempDir(prefix = "f_record-test-") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return {
        dir,
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}

/**
 * Points the shared paths module at a temp directory.
 *
 * paths.appDir() derives from APPDATA / HOME, so overriding those keeps tests
 * away from the user's real recordings.
 */
export function withIsolatedAppDir() {
    const temp = tempDir();
    const saved = {
        APPDATA: process.env.APPDATA,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE
    };
    process.env.APPDATA = temp.dir;
    process.env.HOME = temp.dir;
    process.env.USERPROFILE = temp.dir;
    return {
        dir: temp.dir,
        cleanup() {
            for (const key of Object.keys(saved)) {
                if (saved[key] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = saved[key];
                }
            }
            temp.cleanup();
        }
    };
}
