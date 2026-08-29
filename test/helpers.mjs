import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
