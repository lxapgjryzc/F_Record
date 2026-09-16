/**
 * The pixel budget behind a resolution.
 *
 * "1080p" names a number of pixels, not a height: about a 16:9 frame's worth,
 * so a canvas of any shape lands near the size the video comes out at. The
 * generator asks Photoshop for frames by this rule and the panel cuts the
 * clipboard copy down by it, and the point of it living in one place is that
 * the two agree to the pixel -- which is pinned here against the sizes
 * measured on Photoshop 2026 in framing.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { fitToResolution, longestSideFor } from "../dist/modules/fit.mjs";

test("a large canvas is brought down to about a 16:9 frame's worth of pixels", () => {
    // 4000x3000 is 12M pixels; a 1080p frame is 1920x1080, just over 2M.
    const fitted = fitToResolution(4000, 3000, "1080");
    assert.deepEqual(fitted, { width: 1663, height: 1247 }, "what Photoshop is asked for, measured");
    const budget = 1920 * 1080;
    assert.ok(Math.abs(fitted.width * fitted.height - budget) / budget < 0.01, "within a percent of the budget");
});

test("the canvas keeps its shape", () => {
    assert.deepEqual(fitToResolution(8000, 2000, "1080"), { width: 2880, height: 720 });
    assert.deepEqual(fitToResolution(1000, 4000, "720"), { width: 480, height: 1920 });
});

test("square and panoramic canvases get the same budget", () => {
    const square = fitToResolution(3000, 3000, "1080");
    const wide = fitToResolution(6000, 1500, "1080");
    const ratio = (square.width * square.height) / (wide.width * wide.height);
    assert.ok(ratio > 0.98 && ratio < 1.02);
});

test("a canvas already inside the budget keeps its own size", () => {
    assert.deepEqual(fitToResolution(300, 200, "1440"), { width: 300, height: 200 });
    assert.equal(longestSideFor(300, 200, "1440"), 300);
    // Exactly on the budget is inside it.
    assert.deepEqual(fitToResolution(1920, 1080, "1080"), { width: 1920, height: 1080 });
});

test("a higher resolution is more pixels, in order", () => {
    const sides = ["360", "720", "1080", "1440", "2160"].map((r) => longestSideFor(8000, 6000, r));
    for (let i = 1; i < sides.length; i++) {
        assert.ok(sides[i] > sides[i - 1], sides.join(" < "));
    }
});

test("a degenerate size fits to a pixel, never to nothing or NaN", () => {
    assert.equal(longestSideFor(0, 0, "1080"), 1);
    assert.equal(longestSideFor(5, 0, "1080"), 1, "no area");
    assert.equal(longestSideFor(-4, -3, "1080"), 1, "an area, but no side");
    assert.deepEqual(fitToResolution(0, 0, "1080"), { width: 1, height: 1 });
    assert.deepEqual(fitToResolution(5, 0, "1080"), { width: 1, height: 1 });
});
