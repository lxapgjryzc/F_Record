/**
 * Pixmap decoding.
 *
 * The channel layouts come from generator-core's lib/xpm.js and are easy to get
 * subtly wrong -- 4-channel pixmaps are ARGB but 3-channel ones are BGR, and
 * 16-bit documents are big-endian. A mistake here shows up as recordings with
 * swapped red and blue, which is exactly the kind of thing worth pinning down.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pixmapToRgba, hasPadding, NO_PADDING } from "../dist/test/encoder.mjs";

const WHITE = [255, 255, 255];

/** Reads pixel (x, y) out of a tightly packed RGBA buffer. */
function pixelAt(raster, x, y) {
    const offset = (y * raster.width + x) * 4;
    return [raster.data[offset], raster.data[offset + 1], raster.data[offset + 2], raster.data[offset + 3]];
}

test("4-channel pixmaps are read as ARGB", () => {
    // One opaque pixel: alpha 255, red 10, green 20, blue 30.
    const pixmap = {
        width: 1,
        height: 1,
        channelCount: 4,
        bitsPerChannel: 8,
        bytesPerPixel: 4,
        rowBytes: 4,
        pixels: Buffer.from([255, 10, 20, 30])
    };
    const raster = pixmapToRgba(pixmap, WHITE, NO_PADDING);
    assert.deepEqual(pixelAt(raster, 0, 0), [10, 20, 30, 255]);
});

test("3-channel pixmaps are read as BGR", () => {
    // xpm.js getPixel3 reads b at offset 0 and r at offset 2.
    const pixmap = {
        width: 1,
        height: 1,
        channelCount: 3,
        bitsPerChannel: 8,
        bytesPerPixel: 3,
        rowBytes: 3,
        pixels: Buffer.from([30, 20, 10]) // b, g, r
    };
    const raster = pixmapToRgba(pixmap, WHITE, NO_PADDING);
    assert.deepEqual(pixelAt(raster, 0, 0), [10, 20, 30, 255]);
});

test("single-channel pixmaps become grey", () => {
    const pixmap = {
        width: 1,
        height: 1,
        channelCount: 1,
        bitsPerChannel: 8,
        bytesPerPixel: 1,
        rowBytes: 1,
        pixels: Buffer.from([128])
    };
    const raster = pixmapToRgba(pixmap, WHITE, NO_PADDING);
    assert.deepEqual(pixelAt(raster, 0, 0), [128, 128, 128, 255]);
});

test("16-bit channels are downsampled by taking the big-endian high byte", () => {
    // ARGB, two bytes per channel, big-endian: alpha 0xFFFF, r 0x0A00, etc.
    const pixmap = {
        width: 1,
        height: 1,
        channelCount: 4,
        bitsPerChannel: 16,
        bytesPerPixel: 8,
        rowBytes: 8,
        pixels: Buffer.from([0xff, 0xff, 0x0a, 0x00, 0x14, 0x00, 0x1e, 0x00])
    };
    const raster = pixmapToRgba(pixmap, WHITE, NO_PADDING);
    assert.deepEqual(pixelAt(raster, 0, 0), [0x0a, 0x14, 0x1e, 255]);
});

test("fully transparent pixels take the background, since JPEG has no alpha", () => {
    const pixmap = {
        width: 1,
        height: 1,
        channelCount: 4,
        bitsPerChannel: 8,
        bytesPerPixel: 4,
        rowBytes: 4,
        pixels: Buffer.from([0, 10, 20, 30])
    };
    const raster = pixmapToRgba(pixmap, WHITE, NO_PADDING);
    assert.deepEqual(pixelAt(raster, 0, 0), [255, 255, 255, 255]);
});

test("semi-transparent pixels are composited onto the background", () => {
    // 50% black over white should land near mid grey.
    const pixmap = {
        width: 1,
        height: 1,
        channelCount: 4,
        bitsPerChannel: 8,
        bytesPerPixel: 4,
        rowBytes: 4,
        pixels: Buffer.from([128, 0, 0, 0])
    };
    const raster = pixmapToRgba(pixmap, WHITE, NO_PADDING);
    const [r, g, b, a] = pixelAt(raster, 0, 0);
    assert.ok(r > 120 && r < 135, "got " + r);
    assert.equal(r, g);
    assert.equal(g, b);
    assert.equal(a, 255);
});

test("rowBytes padding between scanlines is respected", () => {
    // 2x2 image whose rows are padded to 12 bytes instead of 8.
    const rowBytes = 12;
    const pixels = Buffer.alloc(rowBytes * 2, 0);
    // Row 0: two red pixels.
    pixels.set([255, 255, 0, 0], 0);
    pixels.set([255, 255, 0, 0], 4);
    // Row 1 begins at rowBytes, not at 8: two blue pixels.
    pixels.set([255, 0, 0, 255], rowBytes);
    pixels.set([255, 0, 0, 255], rowBytes + 4);

    const raster = pixmapToRgba(
        { width: 2, height: 2, channelCount: 4, bitsPerChannel: 8, bytesPerPixel: 4, rowBytes, pixels },
        WHITE,
        NO_PADDING
    );
    assert.deepEqual(pixelAt(raster, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(raster, 1, 1), [0, 0, 255, 255]);
});

test("padding re-seats the pixels inside a larger canvas filled with white", () => {
    const pixmap = {
        width: 1,
        height: 1,
        channelCount: 4,
        bitsPerChannel: 8,
        bytesPerPixel: 4,
        rowBytes: 4,
        pixels: Buffer.from([255, 10, 20, 30])
    };
    const raster = pixmapToRgba(pixmap, WHITE, { left: 2, top: 1, right: 3, bottom: 4 });

    assert.equal(raster.width, 6);
    assert.equal(raster.height, 6);
    assert.deepEqual(pixelAt(raster, 2, 1), [10, 20, 30, 255], "content lands at the padded offset");
    assert.deepEqual(pixelAt(raster, 0, 0), [255, 255, 255, 255], "surrounding area is background");
    assert.deepEqual(pixelAt(raster, 5, 5), [255, 255, 255, 255]);
});

test("a truncated pixel buffer degrades to background instead of throwing", () => {
    // Photoshop or a crash can leave us short; better a partial frame than none.
    const pixmap = {
        width: 4,
        height: 4,
        channelCount: 4,
        bitsPerChannel: 8,
        bytesPerPixel: 4,
        rowBytes: 16,
        pixels: Buffer.from([255, 10, 20, 30]) // only one pixel's worth
    };
    const raster = pixmapToRgba(pixmap, WHITE, NO_PADDING);
    assert.equal(raster.width, 4);
    assert.deepEqual(pixelAt(raster, 0, 0), [10, 20, 30, 255]);
    assert.deepEqual(pixelAt(raster, 3, 3), [255, 255, 255, 255]);
});

test("hasPadding distinguishes a real inset from none", () => {
    assert.equal(hasPadding(NO_PADDING), false);
    assert.equal(hasPadding({ left: 0, top: 0, right: 1, bottom: 0 }), true);
});
