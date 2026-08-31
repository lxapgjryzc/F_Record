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
import { computeMaxDimension, computePadding, isScaledWholeDocument } from "../dist/test/framing.mjs";

const CANVAS = { top: 0, left: 0, right: 4000, bottom: 3000 };
/** What performCapture would have asked Photoshop for, for this canvas. */
const CANVAS_MAX = computeMaxDimension(CANVAS, "1080");

/**
 * The canvas from the bug report, and the numbers Photoshop 2026 answered with.
 * 7513x4617 capped at 1837 comes back as a 1837x1129 pixmap whose bounds are
 * the document rectangle *already scaled* rather than in document pixels.
 */
const BIG = { top: 0, left: 0, right: 7513, bottom: 4617 };
const BIG_MAX = computeMaxDimension(BIG, "1080");

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
    const padding = computePadding(CANVAS, CANVAS, 800, 600, CANVAS_MAX);
    assert.deepEqual(padding, { left: 0, top: 0, right: 0, bottom: 0 });
});

test("a small painted region is re-seated at the right offset and scale", () => {
    // Content occupies the middle 1000x750 of a 4000x3000 canvas, returned at
    // half scale (500x375 pixels).
    const painted = { top: 1000, left: 1000, right: 2000, bottom: 1750 };
    const padding = computePadding(CANVAS, painted, 500, 375, CANVAS_MAX);

    // scale = 500/1000 = 0.5
    assert.deepEqual(padding, { left: 500, top: 500, right: 1000, bottom: 625 });

    // The padded result is the whole canvas at the same 0.5 scale.
    assert.equal(500 + padding.left + padding.right, 2000);
    assert.equal(375 + padding.top + padding.bottom, 1500);
});

test("padding is never negative even if Photoshop hands back more than the canvas", () => {
    const overflowing = { top: -100, left: -100, right: 4200, bottom: 3200 };
    const padding = computePadding(CANVAS, overflowing, 4300, 3300, CANVAS_MAX);
    assert.ok(padding.left >= 0 && padding.top >= 0 && padding.right >= 0 && padding.bottom >= 0);
});

test("missing or empty pixmap bounds fall back to no padding rather than NaN", () => {
    assert.deepEqual(computePadding(CANVAS, null, 100, 100, CANVAS_MAX), { left: 0, top: 0, right: 0, bottom: 0 });
    assert.deepEqual(
        computePadding(CANVAS, { top: 5, left: 5, right: 5, bottom: 5 }, 100, 100, CANVAS_MAX),
        { left: 0, top: 0, right: 0, bottom: 0 }
    );
    assert.deepEqual(computePadding(CANVAS, CANVAS, 0, 0, CANVAS_MAX), { left: 0, top: 0, right: 0, bottom: 0 });
});

/* ------------------------------------------- pixmap bounds and their scale */

test("a downscaled whole canvas is not padded out to full document size", () => {
    // The bug: Photoshop capped 7513x4617 at 1837 and reported the bounds in
    // the pixmap's own pixels, so the scale read as 1 and the frame came out
    // 7513x4617 with the drawing marooned in the top-left corner.
    assert.equal(BIG_MAX, 1837);
    const pixmapWidth = 1837;
    const pixmapHeight = 1129;
    const scaledBounds = { top: 0, left: 0, right: pixmapWidth, bottom: pixmapHeight };

    const padding = computePadding(BIG, scaledBounds, pixmapWidth, pixmapHeight, BIG_MAX);

    assert.deepEqual(padding, { left: 0, top: 0, right: 0, bottom: 0 });
    assert.equal(pixmapWidth + padding.left + padding.right, 1837, "frame stays at the requested size");
    assert.equal(pixmapHeight + padding.top + padding.bottom, 1129);
});

test("the same capture with document-space bounds also needs no padding", () => {
    // Photoshop's documented contract. Both readings have to reach the same
    // answer, or the frame size would flip about between versions.
    const padding = computePadding(BIG, BIG, 1837, 1129, BIG_MAX);
    assert.deepEqual(padding, { left: 0, top: 0, right: 0, bottom: 0 });
});

test("a partly painted canvas is still re-seated when the capture was downscaled", () => {
    // Document-space bounds, unambiguous because they are wider than the pixmap
    // Photoshop returned: the guard must keep its hands off these. A 4000x2500
    // painted region capped at 1837 comes back at 1837x1148.
    const painted = { top: 1000, left: 2000, right: 6000, bottom: 3500 };
    const scale = 1837 / 4000;
    const padding = computePadding(BIG, painted, 1837, 1148, BIG_MAX);

    assert.deepEqual(padding, {
        left: Math.round(2000 * scale),
        top: Math.round(1000 * (1148 / 2500)),
        right: Math.round((7513 - 6000) * scale),
        bottom: Math.round((4617 - 3500) * (1148 / 2500))
    });
    assert.ok(padding.left > 0 && padding.right > 0, "the region is seated inside the canvas");

    // The padded frame is the whole canvas at the pixmap's own scale, give or
    // take the rounding of four independent edges.
    const frameWidth = 1837 + padding.left + padding.right;
    assert.ok(Math.abs(frameWidth - 7513 * scale) <= 2, "frame " + frameWidth);
});

test("a small painted region on a big canvas is re-seated, not mistaken for the canvas", () => {
    // Nothing was downscaled here -- the region is well under the cap -- so the
    // documented reading applies and the region must be padded into place.
    const region = { top: 50, left: 100, right: 600, bottom: 450 };
    const padding = computePadding(CANVAS, region, 500, 400, CANVAS_MAX);
    assert.deepEqual(padding, { left: 100, top: 50, right: 3400, bottom: 2550 });
});

test("scaled-bounds detection needs a cap, a capped pixmap, and the whole canvas", () => {
    const scaled = { top: 0, left: 0, right: 1837, bottom: 1129 };
    assert.equal(isScaledWholeDocument(BIG, scaled, 1837, 1129, BIG_MAX), true);

    // No cap in play: the canvas already fits, so nothing was scaled.
    assert.equal(isScaledWholeDocument(BIG, scaled, 1837, 1129, 8000), false);
    // A pixmap that never reached the cap was never capped.
    assert.equal(isScaledWholeDocument(BIG, { top: 0, left: 0, right: 500, bottom: 300 }, 500, 300, BIG_MAX), false);
    // Right size, wrong place: not the canvas.
    assert.equal(
        isScaledWholeDocument(BIG, { top: 200, left: 200, right: 2037, bottom: 1329 }, 1837, 1129, BIG_MAX),
        false
    );
    // Right place, wrong shape: not the canvas either.
    assert.equal(
        isScaledWholeDocument(BIG, { top: 0, left: 0, right: 1837, bottom: 900 }, 1837, 900, BIG_MAX),
        false
    );
});
