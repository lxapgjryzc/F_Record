/**
 * CaptureScheduler -- the component that exists because 3.x could silently
 * stop recording and never say so.
 *
 * The regression these guard against: 3.x used a bare `isGettingImage` boolean
 * that was set before the capture and cleared after it, with a `catch { throw }`
 * in between. One throw from the JSON bookkeeping left the flag stuck at true
 * and killed recording for the rest of the Photoshop session, with the panel
 * still cheerfully showing the last frame count.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureScheduler } from "../dist/test/capture.mjs";
import { makeClock, flush, deferred } from "./helpers.mjs";

function makeScheduler(overrides = {}) {
    const clock = makeClock();
    const calls = [];
    let controller = null;

    const scheduler = new CaptureScheduler({
        minIntervalMs: 1000,
        timers: clock.timers,
        capture: () => {
            calls.push(clock.now());
            controller = deferred();
            return controller.promise;
        },
        ...overrides
    });

    return {
        scheduler,
        clock,
        calls,
        /** Settles the capture that is currently in flight. */
        finish: async (error) => {
            assert.ok(controller, "expected a capture to be in flight");
            const current = controller;
            controller = null;
            if (error) {
                current.reject(error);
            } else {
                current.resolve();
            }
            await flush();
        },
        inFlight: () => controller !== null
    };
}

test("does not capture until enabled", async () => {
    const h = makeScheduler();
    h.scheduler.notifyChange();
    await h.clock.advance(5000);
    assert.equal(h.calls.length, 0);
});

test("captures once per burst of changes, then once more for the trailing state", async () => {
    const h = makeScheduler();
    h.scheduler.setEnabled(true);

    // A stroke produces many imageChanged events in quick succession.
    for (let i = 0; i < 20; i++) {
        h.scheduler.notifyChange();
    }
    await h.clock.advance(0);
    assert.equal(h.calls.length, 1, "burst collapses into a single capture");

    // More changes arrive while that capture is still running.
    h.scheduler.notifyChange();
    h.scheduler.notifyChange();
    await h.finish();

    // They are coalesced into exactly one trailing capture, after the interval.
    await h.clock.advance(999);
    assert.equal(h.calls.length, 1, "still throttled");
    await h.clock.advance(1);
    assert.equal(h.calls.length, 2, "trailing capture runs once the interval elapses");
});

test("never starts a second capture while one is in flight", async () => {
    const h = makeScheduler();
    h.scheduler.setEnabled(true);
    h.scheduler.notifyChange();
    await h.clock.advance(0);
    assert.equal(h.calls.length, 1);

    // Changes keep arriving for a long time while the capture is still running.
    for (let i = 0; i < 5; i++) {
        h.scheduler.notifyChange();
        await h.clock.advance(2000);
    }
    assert.equal(h.calls.length, 1, "the in-flight capture is not doubled up");

    // That capture is now recorded as having taken 10s, so the next interval
    // is the 15s ceiling rather than the 1s floor.
    await h.finish();
    assert.equal(h.scheduler.getStats().nextIntervalMs, 15000);

    await h.clock.advance(14999);
    assert.equal(h.calls.length, 1, "still waiting out the backoff");
    await h.clock.advance(1);
    assert.equal(h.calls.length, 2);
});

test("backs off in proportion to how long capture takes", async () => {
    const h = makeScheduler();
    h.scheduler.setEnabled(true);
    h.scheduler.notifyChange();
    await h.clock.advance(0);

    // A heavy document: the capture takes two seconds.
    await h.clock.advance(2000);
    await h.finish();

    // Next interval is 3x the observed cost, so Photoshop gets breathing room.
    assert.equal(h.scheduler.getStats().nextIntervalMs, 6000);
    assert.equal(h.scheduler.getStats().lastCaptureMs, 2000);
});

test("the adaptive interval is clamped to the configured floor and the ceiling", async () => {
    const h = makeScheduler({ captureTimeoutMs: 120000 });
    h.scheduler.setEnabled(true);

    // Instant capture: never faster than minIntervalMs.
    h.scheduler.notifyChange();
    await h.clock.advance(0);
    await h.finish();
    assert.equal(h.scheduler.getStats().nextIntervalMs, 1000);

    // Absurdly slow capture: 3x would be 60s, but the ceiling holds it at 15s
    // so a pathological document still gets recorded, just sparsely.
    h.scheduler.notifyChange();
    await h.clock.advance(1000);
    await h.clock.advance(20000);
    await h.finish();
    assert.equal(h.scheduler.getStats().nextIntervalMs, 15000);
});

test("a rejected capture is counted, backed off, and does not wedge the scheduler", async () => {
    const h = makeScheduler();
    h.scheduler.setEnabled(true);
    h.scheduler.notifyChange();
    await h.clock.advance(0);

    await h.finish(new Error("boom"));
    assert.equal(h.scheduler.getStats().consecutiveFailures, 1);
    assert.equal(h.scheduler.getStats().capturing, false, "the in-flight flag is cleared on failure");
    assert.equal(h.scheduler.getStats().droppedFrames, 1);

    // Crucially, recording continues.
    h.scheduler.notifyChange();
    await h.clock.advance(10000);
    assert.equal(h.calls.length, 2, "a failure does not stop future captures");
});

test("a capture that never settles is abandoned by the watchdog", async () => {
    const h = makeScheduler();
    h.scheduler.setEnabled(true);
    h.scheduler.notifyChange();
    await h.clock.advance(0);
    assert.equal(h.scheduler.getStats().capturing, true);

    // Photoshop stops responding: the promise simply never settles. This is
    // the exact shape of 3.x's permanent hang.
    await h.clock.advance(30000);

    assert.equal(h.scheduler.getStats().capturing, false, "watchdog clears the in-flight flag");
    assert.equal(h.scheduler.getStats().consecutiveFailures, 1);

    h.scheduler.notifyChange();
    await h.clock.advance(60000);
    assert.ok(h.calls.length >= 2, "recording recovers after a timeout");
});

test("auto-pauses loudly after repeated failures instead of failing quietly", async () => {
    const reasons = [];
    const h = makeScheduler({ onAutoPause: (reason) => reasons.push(reason) });
    h.scheduler.setEnabled(true);

    for (let i = 0; i < 5; i++) {
        h.scheduler.notifyChange();
        await h.clock.advance(20000);
        await h.finish(new Error("disk full"));
    }

    assert.equal(reasons.length, 1, "the user is told exactly once");
    assert.match(reasons[0], /5 consecutive capture failures/);
    assert.match(reasons[0], /disk full/, "the underlying cause is carried through");

    const stats = h.scheduler.getStats();
    assert.ok(stats.pausedReason, "the paused state carries a reason the panel can display");

    // Paused means paused: no further captures until explicitly resumed.
    const before = h.calls.length;
    h.scheduler.notifyChange();
    await h.clock.advance(60000);
    assert.equal(h.calls.length, before);

    h.scheduler.resume();
    assert.equal(h.scheduler.getStats().pausedReason, null);
    assert.equal(h.scheduler.getStats().consecutiveFailures, 0);
    await h.clock.advance(60000);
    assert.ok(h.calls.length > before, "resume actually resumes");
});

test("a pause it imposed itself is told apart from one that was asked for", async () => {
    const h = makeScheduler();
    h.scheduler.setEnabled(true);

    for (let i = 0; i < 5; i++) {
        h.scheduler.notifyChange();
        await h.clock.advance(20000);
        await h.finish(new Error("capture timed out"));
    }
    assert.equal(h.scheduler.isAutoPaused(), true, "five failures: the scheduler paused itself");

    // The plug-in may lift that once the cause has cleared. Doing so must not
    // touch a pause somebody asked for, which is why the two are distinct.
    h.scheduler.resume();
    assert.equal(h.scheduler.isAutoPaused(), false);
    assert.equal(h.scheduler.isPaused(), false);

    h.scheduler.pause("Exporting");
    assert.equal(h.scheduler.isPaused(), true);
    assert.equal(h.scheduler.isAutoPaused(), false, "an export's pause is not the scheduler's own");

    // Re-enabling starts clean, as before.
    h.scheduler.resume();
    for (let i = 0; i < 5; i++) {
        h.scheduler.notifyChange();
        await h.clock.advance(20000);
        await h.finish(new Error("capture timed out"));
    }
    assert.equal(h.scheduler.isAutoPaused(), true);
    h.scheduler.setEnabled(false);
    h.scheduler.setEnabled(true);
    assert.equal(h.scheduler.isAutoPaused(), false);
});

test("a synchronous throw from capture is handled like a rejection", async () => {
    const clock = makeClock();
    let calls = 0;
    const scheduler = new CaptureScheduler({
        minIntervalMs: 1000,
        timers: clock.timers,
        capture: () => {
            calls++;
            throw new Error("sync failure");
        }
    });
    scheduler.setEnabled(true);
    scheduler.notifyChange();
    await clock.advance(0);

    assert.equal(calls, 1);
    assert.equal(scheduler.getStats().capturing, false, "flag cleared even on a synchronous throw");
    assert.equal(scheduler.getStats().consecutiveFailures, 1);
});

test("disabling clears queued work and re-enabling starts clean", async () => {
    const h = makeScheduler();
    h.scheduler.setEnabled(true);
    h.scheduler.notifyChange();
    await h.clock.advance(0);
    await h.finish(new Error("nope"));
    assert.equal(h.scheduler.getStats().consecutiveFailures, 1);

    h.scheduler.setEnabled(false);
    h.scheduler.notifyChange();
    await h.clock.advance(60000);
    assert.equal(h.calls.length, 1, "no captures while disabled");

    h.scheduler.setEnabled(true);
    assert.equal(h.scheduler.getStats().consecutiveFailures, 0, "failure history is reset");
    assert.equal(h.scheduler.getStats().nextIntervalMs, 1000, "backoff is reset");
});

test("a change reported while disabled is captured as soon as it is enabled", async () => {
    // Switching documents disables the scheduler until the new document is
    // synced. A stroke landing in that window is the new document's first,
    // and it must not have to wait for a second stroke to be recorded.
    const h = makeScheduler();
    h.scheduler.setEnabled(true);
    h.scheduler.setEnabled(false);
    h.scheduler.notifyChange();
    await h.clock.advance(60000);
    assert.equal(h.calls.length, 0, "nothing is captured while disabled");

    h.scheduler.setEnabled(true);
    await h.clock.advance(0);
    assert.equal(h.calls.length, 1, "the stroke that landed meanwhile is captured on enabling");
});

test("discardPending drops work belonging to a document we just left", async () => {
    const h = makeScheduler();
    h.scheduler.setEnabled(true);
    h.scheduler.notifyChange();
    h.scheduler.discardPending();
    await h.clock.advance(60000);
    assert.equal(h.calls.length, 0);
});

test("whenIdle resolves only once the capture in flight has settled", async () => {
    const h = makeScheduler();

    let idleWithNothingRunning = false;
    h.scheduler.whenIdle().then(() => (idleWithNothingRunning = true));
    await flush();
    assert.equal(idleWithNothingRunning, true, "nothing in flight, nothing to wait for");

    h.scheduler.setEnabled(true);
    h.scheduler.notifyChange();
    await h.clock.advance(0);
    assert.ok(h.inFlight(), "precondition: a capture is running");

    // What this is for: deleting a session folder has to outlast the frame
    // being written into it, or the encoder recreates the folder behind the
    // delete and leaves half a recording on disk.
    let waited = false;
    h.scheduler.whenIdle().then(() => (waited = true));
    await flush();
    assert.equal(waited, false, "still writing");

    await h.finish();
    assert.equal(waited, true, "released as soon as the capture settles");
});

test("whenIdle is released by dispose, so a caller is never stranded", async () => {
    const h = makeScheduler();
    h.scheduler.setEnabled(true);
    h.scheduler.notifyChange();
    await h.clock.advance(0);

    let released = false;
    h.scheduler.whenIdle().then(() => (released = true));
    h.scheduler.dispose();
    await flush();

    assert.equal(released, true);
});
