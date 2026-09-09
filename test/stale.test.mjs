/**
 * The stale rule behind "Archive stale" and "Select stale".
 *
 * The panel counts these before the click and shows the number on the
 * button, so the rule is pinned down here: either threshold alone is
 * enough, 0 switches a threshold off, and what a bulk action could not act
 * on anyway is left out.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DAY_MS, isStale, staleSessions } from "../dist/test/stale.mjs";

const NOW = 1_700_000_000_000;

function session(overrides) {
    return {
        sessionId: "s",
        folder: "C:\\frames\\s",
        docName: "piece",
        filePathHistory: [],
        canvasBounds: null,
        frameCount: 500,
        timeSpentSec: 100,
        createdAt: NOW - DAY_MS,
        lastModifiedAt: NOW,
        format: "jpg",
        resolution: "1080",
        archived: false,
        ...overrides
    };
}

test("too few frames is stale, on its own", () => {
    const criteria = { maxFrames: 20, afterDays: 0 };
    assert.equal(isStale(session({ frameCount: 19 }), criteria, NOW), true);
    assert.equal(isStale(session({ frameCount: 20 }), criteria, NOW), false, "the threshold itself is enough");
    assert.equal(isStale(session({ frameCount: 0 }), criteria, NOW), true);
});

test("created long enough ago is stale, on its own, whatever the frame count", () => {
    const criteria = { maxFrames: 0, afterDays: 30 };
    assert.equal(isStale(session({ createdAt: NOW - 31 * DAY_MS }), criteria, NOW), true);
    assert.equal(isStale(session({ createdAt: NOW - 29 * DAY_MS }), criteria, NOW), false);
    assert.equal(
        isStale(session({ createdAt: NOW - 31 * DAY_MS, lastModifiedAt: NOW }), criteria, NOW),
        true,
        "age is measured from when the recording began, not the last frame"
    );
});

test("a threshold of 0 is off, and both off means nothing is stale", () => {
    assert.equal(isStale(session({ frameCount: 0, createdAt: 1 }), { maxFrames: 0, afterDays: 0 }, NOW), false);
});

test("a recording without a manifest has no age, so only the frame rule can catch it", () => {
    assert.equal(isStale(session({ createdAt: 0, frameCount: 500 }), { maxFrames: 20, afterDays: 30 }, NOW), false);
    assert.equal(isStale(session({ createdAt: 0, frameCount: 3 }), { maxFrames: 20, afterDays: 30 }, NOW), true);
});

test("staleSessions leaves out the take in progress and rows that are only an error", () => {
    const criteria = { maxFrames: 20, afterDays: 30 };
    const rows = [
        session({ sessionId: "current", frameCount: 2 }),
        session({ sessionId: "gone", frameCount: 0, error: "Folder not found: X" }),
        session({ sessionId: "short", frameCount: 5 }),
        session({ sessionId: "old", createdAt: NOW - 90 * DAY_MS }),
        session({ sessionId: "fine" })
    ];
    assert.deepEqual(
        staleSessions(rows, criteria, NOW, "current").map((s) => s.sessionId),
        ["short", "old"]
    );
    assert.deepEqual(
        staleSessions(rows, criteria, NOW, null).map((s) => s.sessionId),
        ["current", "short", "old"],
        "with nothing recording, the first row is just another short one"
    );
});
