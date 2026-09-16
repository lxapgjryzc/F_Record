/**
 * Pixmap decoding.
 *
 * The channel layouts come from generator-core's lib/xpm.js and are easy to get
 * subtly wrong -- 4-channel pixmaps are ARGB but 3-channel ones are BGR, and
 * 16-bit documents are big-endian. A mistake here shows up as recordings with
 * swapped red and blue, which is exactly the kind of thing worth pinning down.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { fsError, mockBuiltins, tempDir, withFaultAsync } from "./helpers.mjs";

// A swappable `fs`, so the half-written-frame guard can be reached: it only
// runs when the rename that publishes a frame fails.
mockBuiltins(mock, "fs");
const { Encoder, pixmapToRgba, hasPadding, NO_PADDING } = await import("../dist/modules/encoder.mjs");

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

test("a pixmap that describes none of its layout is assumed to be 8-bit ARGB", () => {
    // generator-core fills these in, but the shapes it hands over have varied
    // between hosts; the defaults are what keep an unannotated pixmap readable
    // rather than turning it into noise.
    const raster = pixmapToRgba(
        { width: 1, height: 1, pixels: Buffer.from([255, 10, 20, 30]) },
        WHITE,
        NO_PADDING
    );
    assert.deepEqual(pixelAt(raster, 0, 0), [10, 20, 30, 255]);
});

test("hasPadding notices an inset on any single side", () => {
    assert.equal(hasPadding(NO_PADDING), false);
    assert.equal(hasPadding({ left: 1, top: 0, right: 0, bottom: 0 }), true);
    assert.equal(hasPadding({ left: 0, top: 1, right: 0, bottom: 0 }), true);
    assert.equal(hasPadding({ left: 0, top: 0, right: 1, bottom: 0 }), true);
    assert.equal(hasPadding({ left: 0, top: 0, right: 0, bottom: 1 }), true);
});

/* ------------------------------------------------------- choosing an encoder */

/** A savePixmap that records what it was asked for. */
function nativeSaver(behaviour) {
    const calls = [];
    return {
        calls,
        savePixmap(pixmap, filePath, settings) {
            calls.push({ pixmap, filePath, settings });
            if (behaviour) {
                return behaviour(calls.length);
            }
            fs.writeFileSync(filePath, "native jpeg");
            return Promise.resolve();
        }
    };
}

function recordingLog() {
    const lines = [];
    return { lines, log: (level, message) => lines.push(level + ": " + message) };
}

const ONE_PIXEL = {
    width: 1,
    height: 1,
    channelCount: 4,
    bitsPerChannel: 8,
    bytesPerPixel: 4,
    rowBytes: 4,
    pixels: Buffer.from([255, 10, 20, 30])
};

test("with no native saver the built-in encoder is used from the start", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const sink = recordingLog();
    const encoder = new Encoder(null, sink.log);

    assert.equal(encoder.getKind(), "js");

    const target = path.join(temp.dir, "frames", "000001_1700000001000.jpg");
    await encoder.encode(ONE_PIXEL, target, { quality: 80, padding: NO_PADDING });

    // The frame folder is created on the way, and the result is a real JPEG.
    assert.deepEqual(fs.readFileSync(target).subarray(0, 2), Buffer.from([0xff, 0xd8]));
    assert.deepEqual(sink.lines, [], "nothing to report: this was the plan all along");
});

test("the native encoder is preferred, and told what to encode", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const native = nativeSaver();
    const encoder = new Encoder(native, recordingLog().log);

    const target = path.join(temp.dir, "000001_1700000001000.jpg");
    await encoder.encode(ONE_PIXEL, target, { quality: 82, padding: NO_PADDING, ppi: 72 });

    assert.equal(encoder.getKind(), "native");
    assert.equal(native.calls.length, 1);
    assert.deepEqual(native.calls[0].settings, {
        format: "jpg",
        quality: 82,
        // White and fully opaque, matching how the JS path flattens alpha --
        // otherwise the two encoders would disagree about transparent pixels.
        background: [255, 255, 255, 1],
        ppi: 72
    });
});

test("padding is passed to the native encoder only when there is some", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const native = nativeSaver();
    const encoder = new Encoder(native, recordingLog().log);
    const target = path.join(temp.dir, "000001_1700000001000.jpg");

    await encoder.encode(ONE_PIXEL, target, { quality: 80, padding: NO_PADDING });
    assert.equal("padding" in native.calls[0].settings, false);

    const inset = { left: 1, top: 2, right: 3, bottom: 4 };
    await encoder.encode(ONE_PIXEL, target, { quality: 80, padding: inset });
    assert.deepEqual(native.calls[1].settings.padding, inset);
});

test("quality is clamped to what a JPEG encoder will accept", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const native = nativeSaver();
    const encoder = new Encoder(native, recordingLog().log);
    const target = path.join(temp.dir, "000001_1700000001000.jpg");

    await encoder.encode(ONE_PIXEL, target, { quality: 0, padding: NO_PADDING });
    await encoder.encode(ONE_PIXEL, target, { quality: 900, padding: NO_PADDING });
    await encoder.encode(ONE_PIXEL, target, { quality: 82.6, padding: NO_PADDING });

    assert.deepEqual(native.calls.map((c) => c.settings.quality), [1, 100, 83]);
});

test("a resolution is only forwarded when it is a real number", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const native = nativeSaver();
    const encoder = new Encoder(native, recordingLog().log);
    const target = path.join(temp.dir, "000001_1700000001000.jpg");

    await encoder.encode(ONE_PIXEL, target, { quality: 80, padding: NO_PADDING });
    await encoder.encode(ONE_PIXEL, target, { quality: 80, padding: NO_PADDING, ppi: Infinity });
    await encoder.encode(ONE_PIXEL, target, { quality: 80, padding: NO_PADDING, ppi: 300 });

    // convert.exe warns about a missing resolution but refuses an impossible
    // one, so a document that reports nonsense must not take the frame with it.
    assert.deepEqual(native.calls.map((c) => "ppi" in c.settings), [false, false, true]);
});

/**
 * The switch this module exists for.
 *
 * On Photoshop 2026 the bundled convert.exe can no longer be launched on its
 * own, so savePixmap fails as soon as its stdin is written. The frame that
 * discovers this must still be written -- a recording that loses its first
 * frame on every new Photoshop is the bug, not the slower encoder.
 */
test("the first native failure falls through to the built-in encoder in the same call", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const native = nativeSaver(() => Promise.reject(new Error("STATUS_DLL_NOT_FOUND")));
    const sink = recordingLog();
    const encoder = new Encoder(native, sink.log);

    const target = path.join(temp.dir, "000001_1700000001000.jpg");
    await encoder.encode(ONE_PIXEL, target, { quality: 80, padding: NO_PADDING });

    assert.deepEqual(fs.readFileSync(target).subarray(0, 2), Buffer.from([0xff, 0xd8]), "the frame survived");
    assert.equal(encoder.getKind(), "js");
    assert.equal(sink.lines.length, 1);
    assert.match(sink.lines[0], /^info: /, "not an error: nothing was lost");
    assert.match(sink.lines[0], /STATUS_DLL_NOT_FOUND/, "says why, for the log a user sends in");
});

test("the switch is permanent, so a broken host is not probed once per frame", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const native = nativeSaver(() => Promise.reject(new Error("no")));
    const encoder = new Encoder(native, recordingLog().log);

    for (let i = 1; i <= 3; i++) {
        await encoder.encode(ONE_PIXEL, path.join(temp.dir, "00000" + i + "_1700000001000.jpg"), {
            quality: 80,
            padding: NO_PADDING
        });
    }
    assert.equal(native.calls.length, 1, "asked once, then never again");
    assert.equal(fs.readdirSync(temp.dir).length, 3, "every frame still written");
});

test("a native failure with nothing to say is still reported", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    // savePixmap rejecting with a bare string is not hypothetical: the failure
    // comes back through generator-core's IPC and arrives as whatever it was
    // serialised as.
    const native = nativeSaver(() => Promise.reject("convert.exe went away"));
    const sink = recordingLog();
    const encoder = new Encoder(native, sink.log);

    await encoder.encode(ONE_PIXEL, path.join(temp.dir, "000001_1700000001000.jpg"), {
        quality: 80,
        padding: NO_PADDING
    });
    assert.match(sink.lines[0], /convert\.exe went away/);
});

/* ------------------------------------------------------ writing the frame */

test("a frame appears whole or not at all", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const encoder = new Encoder(null, recordingLog().log);
    const target = path.join(temp.dir, "000001_1700000001000.jpg");

    // The exporter scans the folder while the recording runs, so a reader must
    // never meet a half-written frame under a name it will try to decode.
    await withFaultAsync("renameSync", fsError("EPERM", "the rename lost a race"), async () => {
        await assert.rejects(
            encoder.encode(ONE_PIXEL, target, { quality: 80, padding: NO_PADDING }),
            /the rename lost a race/
        );
    });

    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(target + ".part"), false, "and the scratch file went with it");
});

test("a scratch file that cannot be removed does not replace the real error", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const encoder = new Encoder(null, recordingLog().log);
    const target = path.join(temp.dir, "000001_1700000001000.jpg");

    await withFaultAsync("renameSync", fsError("EPERM", "the rename lost a race"), async () => {
        await withFaultAsync("unlinkSync", fsError("EBUSY", "and the scratch file is held"), async () => {
            await assert.rejects(
                encoder.encode(ONE_PIXEL, target, { quality: 80, padding: NO_PADDING }),
                /the rename lost a race/
            );
        });
    });
});

test("a frame path with no folder in it is written where the process stands", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const encoder = new Encoder(null, recordingLog().log);

    // dirNameOf has to answer something for a bare name; "." is the only
    // sensible one, and mkdirp of "." must not be an error.
    const cwd = process.cwd();
    process.chdir(temp.dir);
    try {
        await encoder.encode(ONE_PIXEL, "000001_1700000001000.jpg", { quality: 80, padding: NO_PADDING });
    } finally {
        process.chdir(cwd);
    }
    assert.deepEqual(fs.readdirSync(temp.dir), ["000001_1700000001000.jpg"]);
});
