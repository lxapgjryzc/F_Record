/**
 * Capture geometry.
 *
 * `computePadding` is what stops the recording from appearing to zoom: Photoshop
 * returns only the pixels that exist, so three strokes into a big canvas the
 * pixmap is tiny. Re-seating it inside the full canvas is what makes every
 * frame the same composition.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMaxDimension, computePadding, boundsEqual } from "../dist/test/framing.mjs";

const CANVAS = { top: 0, left: 0, right: 4000, bottom: 3000 };

test("downscales a large canvas towards the target pixel budget", () => {
    // 4000x3000 = 12M pixels; a 1080p 16:9 frame is ~2.07M.
    const dimension = computeMaxDimension(CANVAS, "1080");
    assert.ok(dimension < 4000, "large canvases are scaled down");
    assert.ok(dimension > 1000, "but not into uselessness");
});

test("never upscales a canvas that is already small", () => {
    const small = { top: 0, left: 0, right: 300, bottom: 200 };
    assert.equal(computeMaxDimension(small, "1440"), 300, "returns the canvas's own longest side");
});

test("a higher resolution setting asks Photoshop for more pixels", () => {
    const low = computeMaxDimension(CANVAS, "360");
    const high = computeMaxDimension(CANVAS, "1440");
    assert.ok(high > low);
});

test("square and panoramic canvases cost about the same to capture", () => {
    const square = computeMaxDimension({ top: 0, left: 0, right: 3000, bottom: 3000 }, "1080");
    const wide = computeMaxDimension({ top: 0, left: 0, right: 6000, bottom: 1500 }, "1080");
    const squarePixels = square * square;
    const widePixels = wide * (wide / 4);
    const ratio = squarePixels / widePixels;
    assert.ok(ratio > 0.5 && ratio < 2, "pixel budgets stay within 2x of each other");
});

test("degenerate bounds do not produce a zero or NaN dimension", () => {
    assert.equal(computeMaxDimension({ top: 0, left: 0, right: 0, bottom: 0 }, "1080"), 1);
    assert.ok(Number.isFinite(computeMaxDimension({ top: 5, left: 5, right: 5, bottom: 5 }, "1080")));
});

test("a pixmap covering the whole canvas needs no padding", () => {
    const padding = computePadding(CANVAS, CANVAS, 800, 600);
    assert.deepEqual(padding, { left: 0, top: 0, right: 0, bottom: 0 });
});

test("a small painted region is re-seated at the right offset and scale", () => {
    // Content occupies the middle 1000x750 of a 4000x3000 canvas, returned at
    // half scale (500x375 pixels).
    const painted = { top: 1000, left: 1000, right: 2000, bottom: 1750 };
    const padding = computePadding(CANVAS, painted, 500, 375);

    // scale = 500/1000 = 0.5
    assert.deepEqual(padding, { left: 500, top: 500, right: 1000, bottom: 625 });

    // The padded result is the whole canvas at the same 0.5 scale.
    assert.equal(500 + padding.left + padding.right, 2000);
    assert.equal(375 + padding.top + padding.bottom, 1500);
});

test("padding is never negative even if Photoshop hands back more than the canvas", () => {
    const overflowing = { top: -100, left: -100, right: 4200, bottom: 3200 };
    const padding = computePadding(CANVAS, overflowing, 4300, 3300);
    assert.ok(padding.left >= 0 && padding.top >= 0 && padding.right >= 0 && padding.bottom >= 0);
});

test("missing or empty pixmap bounds fall back to no padding rather than NaN", () => {
    assert.deepEqual(computePadding(CANVAS, null, 100, 100), { left: 0, top: 0, right: 0, bottom: 0 });
    assert.deepEqual(
        computePadding(CANVAS, { top: 5, left: 5, right: 5, bottom: 5 }, 100, 100),
        { left: 0, top: 0, right: 0, bottom: 0 }
    );
    assert.deepEqual(computePadding(CANVAS, CANVAS, 0, 0), { left: 0, top: 0, right: 0, bottom: 0 });
});

test("boundsEqual compares by value and handles nulls", () => {
    assert.equal(boundsEqual(CANVAS, { ...CANVAS }), true);
    assert.equal(boundsEqual(CANVAS, { ...CANVAS, right: 1 }), false);
    assert.equal(boundsEqual(null, null), true);
    assert.equal(boundsEqual(CANVAS, null), false);
});
