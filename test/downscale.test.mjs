/**
 * Capturing a canvas too big to be returned at native size.
 *
 * A 7513x4617 document at the 1080 setting is asked for as a 1837x1129
 * rectangle, and Photoshop renders the canvas into it. What matters is that
 * the frame on disk is that rectangle -- not the canvas's own 7513x4617 with
 * the drawing stranded in a corner, which is what 4.0-4.2.1 wrote whenever
 * Photoshop returned something other than the canvas.
 *
 * Three Photoshops are driven here: one that honours the request (every
 * version measured so far), and two that do not, standing in for a version
 * this has never run on. A frame is allowed to come out unpadded; it is not
 * allowed to come out padded against a rectangle that does not describe it.
 *
 * Drives the real built generator bundle, like resize.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

import { withIsolatedAppDir } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const BUNDLE = path.resolve("dist/generator/com.f_know.f_record.generator/index.js");

const CANVAS_WIDTH = 7513;
const CANVAS_HEIGHT = 4617;
/** computeOutputRect(7513x4617, "1080"): the rectangle Photoshop is asked for. */
const EXPECTED_WIDTH = 1837;
const EXPECTED_HEIGHT = 1129;

function bounds(width, height) {
    return { top: 0, left: 0, right: width, bottom: height };
}

function makePixmap(width, height, pixmapBounds) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = 255;
        pixels[i + 1] = 200;
        pixels[i + 2] = 100;
        pixels[i + 3] = 50;
    }
    return {
        width,
        height,
        pixels,
        rowBytes: width * 4,
        channelCount: 4,
        bitsPerChannel: 8,
        bytesPerPixel: 4,
        bounds: pixmapBounds
    };
}

/**
 * The canvas is fully painted, so the render is the whole document.
 *
 * `behaviour` picks how the fake Photoshop answers:
 *
 *   honours   renders the canvas into `outputRect`, reporting the pixels in
 *             that same space -- Photoshop 2026, measured.
 *   ignores   ignores `outputRect` and answers the way `maxDimension` does:
 *             the layers, scaled to their own longest side, with the bounds
 *             normalised to the origin. This is the shape that wrote 169
 *             ruined frames.
 *   native    ignores the request altogether and returns the canvas at 1:1.
 */
function makeDownscalingPhotoshop(behaviour) {
    const listeners = new Map();
    const settings = new Map();
    const canvas = bounds(CANVAS_WIDTH, CANVAS_HEIGHT);
    const asked = [];

    const generator = {
        getDocumentInfo() {
            return Promise.resolve({ id: 1, file: "C:\\art\\L13.psd", bounds: canvas, resolution: 150 });
        },
        getDocumentPixmap(documentId, options) {
            const rect = options && options.outputRect;
            asked.push(rect ? bounds(rect.right - rect.left, rect.bottom - rect.top) : null);

            if (behaviour === "native") {
                return Promise.resolve(
                    makePixmap(CANVAS_WIDTH, CANVAS_HEIGHT, bounds(CANVAS_WIDTH, CANVAS_HEIGHT))
                );
            }
            if (behaviour === "ignores") {
                // Layers reaching past the canvas, scaled to the cap: taller
                // than anything that was asked for.
                const width = EXPECTED_WIDTH;
                const height = Math.round(EXPECTED_WIDTH * 1.2);
                return Promise.resolve(makePixmap(width, height, bounds(width, height)));
            }
            const width = rect.right - rect.left;
            const height = rect.bottom - rect.top;
            return Promise.resolve(makePixmap(width, height, bounds(width, height)));
        },
        getDocumentSettingsForPlugin(documentId) {
            if (!settings.has(documentId)) {
                return Promise.reject(new Error("no generatorSettings"));
            }
            return Promise.resolve(settings.get(documentId));
        },
        setDocumentSettingsForPlugin(value) {
            settings.set(1, value);
            return Promise.resolve();
        },
        onPhotoshopEvent(event, listener) {
            if (!listeners.has(event)) {
                listeners.set(event, []);
            }
            listeners.get(event).push(listener);
        },
        addMenuItem: () => Promise.resolve(),
        toggleMenu: () => Promise.resolve(),
        getPhotoshopVersion: () => Promise.resolve("27.2.0")
    };

    return {
        generator,
        asked,
        emit(event, payload) {
            for (const listener of listeners.get(event) || []) {
                listener(payload);
            }
        },
        paint() {
            this.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
        }
    };
}

async function startPlugin(behaviour) {
    const env = withIsolatedAppDir();
    const appDir = path.join(env.dir, "F_Record");

    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
        path.join(appDir, "config.json"),
        JSON.stringify({
            enabled: true,
            autoStartNewDocuments: true,
            resolution: "1080",
            minIntervalMs: 200,
            minCanvasPixels: 0,
            processImageFolderPath: path.join(appDir, "processImages")
        })
    );

    delete require.cache[BUNDLE];
    const plugin = require(BUNDLE);
    const ps = makeDownscalingPhotoshop(behaviour);
    const handle = plugin.init(ps.generator, {}, null);
    await handle.ready;

    return {
        ps,
        appDir,
        async cleanup() {
            await handle.stop();
            env.cleanup();
        }
    };
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error("timed out");
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}

function sessionFolders(appDir) {
    const root = path.join(appDir, "processImages");
    try {
        return fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory());
    } catch (e) {
        return [];
    }
}

function framesIn(folder) {
    try {
        return fs.readdirSync(folder).filter((n) => n.endsWith(".jpg")).sort();
    } catch (e) {
        return [];
    }
}

/** JPEG SOF0/SOF2 carries the real pixel dimensions; read them back off disk. */
function jpegSize(file) {
    const buf = fs.readFileSync(file);
    let i = 2;
    while (i < buf.length - 9) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
    }
    throw new Error("no SOF marker in " + file);
}

async function recordOneFrame(h) {
    h.ps.paint();
    await waitFor(() => {
        const folders = sessionFolders(h.appDir);
        if (!folders.length) {
            return false;
        }
        return framesIn(path.join(h.appDir, "processImages", folders[0])).length > 0;
    });
    const folder = path.join(h.appDir, "processImages", sessionFolders(h.appDir)[0]);
    return path.join(folder, framesIn(folder)[0]);
}

test("a downscaled capture is written at the size that was asked for", async (t) => {
    const h = await startPlugin("honours");
    t.after(() => h.cleanup());

    const frame = await recordOneFrame(h);

    assert.deepEqual(
        h.ps.asked,
        [bounds(EXPECTED_WIDTH, EXPECTED_HEIGHT)],
        "the 1080 setting asks for a 7513x4617 canvas as " + EXPECTED_WIDTH + "x" + EXPECTED_HEIGHT
    );
    assert.deepEqual(
        jpegSize(frame),
        { width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT },
        "the frame is the downscaled canvas, not " + CANVAS_WIDTH + "x" + CANVAS_HEIGHT +
            " of mostly white"
    );
});

/*
 * The two ways a Photoshop that does not honour the request can answer. Both
 * must leave the pixels alone rather than seat them inside a rectangle that
 * demonstrably does not describe them -- an unpadded frame is a frame; a
 * frame with the drawing stranded in a corner of a white field is not.
 */
for (const [label, expected, behaviour] of [
    ["ignores the requested rectangle", { width: EXPECTED_WIDTH, height: Math.round(EXPECTED_WIDTH * 1.2) }, "ignores"],
    ["does not scale at all", { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, "native"]
]) {
    test("a Photoshop that " + label + " still writes a usable frame", async (t) => {
        const h = await startPlugin(behaviour);
        t.after(() => h.cleanup());

        const frame = await recordOneFrame(h);
        const size = jpegSize(frame);

        assert.deepEqual(size, expected, "written exactly as Photoshop sent it, unpadded");
        assert.ok(
            size.width <= CANVAS_WIDTH && size.height <= CANVAS_HEIGHT,
            "and never padded out past the canvas itself"
        );
    });
}
