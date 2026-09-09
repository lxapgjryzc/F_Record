/**
 * Capture geometry.
 *
 * Photoshop is asked for the canvas rendered into an explicit rectangle, and
 * returns only the pixels that exist within it -- so three strokes into a big
 * canvas the pixmap is small, and `pixmap.bounds` says where in that rectangle
 * it belongs. Seating it there is what makes every frame the same composition
 * instead of an apparent zoom.
 *
 * The numbers below are measured, not invented: they come from a probe run
 * against Photoshop 2026 on the document that produced the 4.2.1 bug report.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    boundsWidth,
    boundsHeight,
    computeMaxDimension,
    computeOutputRect,
    computePadding,
    pixmapExceedsOutputRect
} from "../dist/test/framing.mjs";

const CANVAS = { top: 0, left: 0, right: 4000, bottom: 3000 };
const CANVAS_OUT = computeOutputRect(CANVAS, "1080");

/**
 * The canvas from the bug report: 8000x2000, with layers reaching 2246px above
 * and below it after Image Size and Canvas Size.
 */
const WIDE = { top: 0, left: 0, right: 8000, bottom: 2000 };
const WIDE_OUT = computeOutputRect(WIDE, "1080");

/* ------------------------------------------------------------ the cap */

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
    assert.ok(computeMaxDimension(CANVAS, "1440") > computeMaxDimension(CANVAS, "360"));
});

test("square and panoramic canvases cost about the same to capture", () => {
    const square = computeMaxDimension({ top: 0, left: 0, right: 3000, bottom: 3000 }, "1080");
    const wide = computeMaxDimension({ top: 0, left: 0, right: 6000, bottom: 1500 }, "1080");
    const ratio = (square * square) / (wide * (wide / 4));
    assert.ok(ratio > 0.5 && ratio < 2, "pixel budgets stay within 2x of each other");
});

test("degenerate bounds do not produce a zero or NaN dimension", () => {
    assert.equal(computeMaxDimension({ top: 0, left: 0, right: 0, bottom: 0 }, "1080"), 1);
    assert.ok(Number.isFinite(computeMaxDimension({ top: 5, left: 5, right: 5, bottom: 5 }, "1080")));
});

/* -------------------------------------------------- the requested rect */

test("the requested rectangle is the whole canvas at the capped scale", () => {
    // Measured: an 8000x2000 canvas at the 1080 setting is asked for as
    // 2880x720, and Photoshop returns exactly that.
    assert.deepEqual(WIDE_OUT, { top: 0, left: 0, right: 2880, bottom: 720 });
    assert.equal(boundsWidth(WIDE_OUT) / boundsHeight(WIDE_OUT), 4, "keeps the canvas's shape");
});

test("a canvas small enough to capture natively is asked for at native size", () => {
    const small = { top: 0, left: 0, right: 300, bottom: 200 };
    assert.deepEqual(computeOutputRect(small, "1440"), { top: 0, left: 0, right: 300, bottom: 200 });
});

test("the requested rectangle is anchored at the origin whatever the canvas is", () => {
    // Photoshop reports the returned pixels relative to this rectangle, so it
    // starting anywhere but 0,0 would put an offset into every frame.
    const offset = { top: 500, left: 800, right: 4800, bottom: 3500 };
    const rect = computeOutputRect(offset, "1080");
    assert.equal(rect.left, 0);
    assert.equal(rect.top, 0);
    assert.deepEqual(rect, computeOutputRect(CANVAS, "1080"), "same 4000x3000 shape, same request");
});

test("a degenerate canvas still yields a usable rectangle", () => {
    const rect = computeOutputRect({ top: 0, left: 0, right: 0, bottom: 0 }, "1080");
    assert.ok(boundsWidth(rect) > 0 && boundsHeight(rect) > 0);
});

/* --------------------------------------------------------- the seating */

test("a pixmap filling the requested rectangle needs no padding", () => {
    // Measured on the bug-report document: inputRect + outputRect + clip gives
    // back 2880x720 with bounds 0,0 -> 2880,720. The canvas, and nothing else.
    const padding = computePadding(WIDE_OUT, { top: 0, left: 0, right: 2880, bottom: 720 }, 2880, 720);
    assert.deepEqual(padding, { left: 0, top: 0, right: 0, bottom: 0 });
});

test("a small painted region is seated where Photoshop says it belongs", () => {
    // Measured: a 400x300 mark at 200,150 on a 4000x3000 canvas, asked for at
    // 1663x1247, comes back as 167x126 with bounds 83,62 -> 250,188.
    assert.deepEqual(CANVAS_OUT, { top: 0, left: 0, right: 1663, bottom: 1247 });

    const padding = computePadding(CANVAS_OUT, { top: 62, left: 83, right: 250, bottom: 188 }, 167, 126);
    assert.deepEqual(padding, { left: 83, top: 62, right: 1413, bottom: 1059 });

    // The seated frame is exactly the rectangle that was asked for.
    assert.equal(167 + padding.left + padding.right, 1663);
    assert.equal(126 + padding.top + padding.bottom, 1247);
});

test("the frame always comes out the size that was requested", () => {
    // The widths cancel: pixmap.bounds always describes the returned pixels'
    // own extent, so wherever the region sits the padding makes up the rest.
    for (const region of [
        { top: 0, left: 0, right: 40, bottom: 30 },
        { top: 600, left: 900, right: 1000, bottom: 700 },
        { top: 1147, left: 1563, right: 1663, bottom: 1247 }
    ]) {
        const w = boundsWidth(region);
        const h = boundsHeight(region);
        const padding = computePadding(CANVAS_OUT, region, w, h);
        assert.equal(w + padding.left + padding.right, 1663, "width for " + JSON.stringify(region));
        assert.equal(h + padding.top + padding.bottom, 1247, "height for " + JSON.stringify(region));
    }
});

test("padding is never negative even if Photoshop overshoots the rectangle", () => {
    const overflowing = { top: -100, left: -100, right: 1763, bottom: 1347 };
    const padding = computePadding(CANVAS_OUT, overflowing, 1863, 1447);
    assert.ok(padding.left >= 0 && padding.top >= 0 && padding.right >= 0 && padding.bottom >= 0);
});

test("missing or empty pixmap bounds fall back to no padding rather than NaN", () => {
    assert.deepEqual(computePadding(CANVAS_OUT, null, 100, 100), { left: 0, top: 0, right: 0, bottom: 0 });
    assert.deepEqual(computePadding(CANVAS_OUT, CANVAS_OUT, 0, 0), { left: 0, top: 0, right: 0, bottom: 0 });
});

/* ------------------------------------------ a Photoshop that ignores us */

test("a pixmap larger than the requested rectangle is written unpadded", () => {
    // What 4.2.1 produced: the layer union, 2880x2247, against a canvas that
    // only ever wanted 2880x720. Seating that would strand the drawing in a
    // corner, so the guard writes it as it came instead.
    assert.equal(pixmapExceedsOutputRect(WIDE_OUT, 2880, 2247), true);
    const padding = computePadding(WIDE_OUT, { top: 0, left: 0, right: 2880, bottom: 2247 }, 2880, 2247);
    assert.deepEqual(padding, { left: 0, top: 0, right: 0, bottom: 0 });
    assert.equal(2247 + padding.top + padding.bottom, 2247, "the frame stays what Photoshop sent");
});

test("a Photoshop ignoring the request entirely is caught too", () => {
    // No scaling applied at all: the full canvas at native size.
    assert.equal(pixmapExceedsOutputRect(CANVAS_OUT, 4000, 3000), true);
    assert.deepEqual(computePadding(CANVAS_OUT, CANVAS, 4000, 3000), {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0
    });
});

test("the guard does not fire on anything that actually fits", () => {
    assert.equal(pixmapExceedsOutputRect(CANVAS_OUT, 1663, 1247), false, "exactly the rectangle");
    assert.equal(pixmapExceedsOutputRect(CANVAS_OUT, 167, 126), false, "a small region");
    assert.equal(pixmapExceedsOutputRect(CANVAS_OUT, 1664, 1248), false, "one pixel of rounding slack");
    assert.equal(pixmapExceedsOutputRect(WIDE_OUT, 2880, 720), false, "the bug-report canvas, fixed");
});

test("degenerate input never reports an oversized pixmap", () => {
    assert.equal(pixmapExceedsOutputRect({ top: 0, left: 0, right: 0, bottom: 0 }, 800, 600), false);
    assert.equal(pixmapExceedsOutputRect(CANVAS_OUT, 0, 0), false);
});
