/**
 * Capturing a canvas too big to be returned at native size.
 *
 * A 7513x4617 document at the 1080 setting is asked for with maxDimension
 * 1837, so Photoshop hands back a downscaled pixmap. What it reports as that
 * pixmap's `bounds` decides how the frame is padded, and the two Photoshops
 * measured so far do not agree: the documented answer is document pixels, and
 * 2026 answers in the returned pixmap's own pixels instead. Read the second as
 * the first and the scale comes out 1, which pads every frame out to the full
 * 7513x4617 with the drawing stranded in the top-left corner -- permanently,
 * because the frames go straight into the exported video.
 *
 * Both conventions have to produce the same frame, so both are driven here.
 *
 * The fakes in the other suites all return the canvas at native size, which is
 * why nothing caught this: without a downscale the two conventions coincide.
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
/** computeMaxDimension(7513x4617, "1080"); the pixmap Photoshop then returns. */
const EXPECTED_MAX = 1837;
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
 * A Photoshop that honours `maxDimension` the way the real one does: the
 * canvas is fully painted, so the render is the whole document, scaled down
 * only far enough to fit under the cap.
 *
 * `boundsSpace` picks which convention it reports the pixmap's bounds in.
 */
function makeDownscalingPhotoshop(boundsSpace) {
    const listeners = new Map();
    const settings = new Map();
    const canvas = bounds(CANVAS_WIDTH, CANVAS_HEIGHT);
    const asked = [];

    const generator = {
        getDocumentInfo() {
            return Promise.resolve({ id: 1, file: "C:\\art\\L13.psd", bounds: canvas, resolution: 150 });
        },
        getDocumentPixmap(documentId, options) {
            const cap = options && options.maxDimension > 0 ? options.maxDimension : 10000;
            asked.push(cap);
            const longest = Math.max(CANVAS_WIDTH, CANVAS_HEIGHT);
            const scale = longest > cap ? cap / longest : 1;
            const width = Math.round(CANVAS_WIDTH * scale);
            const height = Math.round(CANVAS_HEIGHT * scale);
            const reported =
                boundsSpace === "pixmap" ? bounds(width, height) : bounds(CANVAS_WIDTH, CANVAS_HEIGHT);
            return Promise.resolve(makePixmap(width, height, reported));
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

async function startPlugin(boundsSpace) {
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
    const ps = makeDownscalingPhotoshop(boundsSpace);
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

for (const boundsSpace of ["document", "pixmap"]) {
    test("a downscaled capture is written at the requested size, not the canvas's" +
        " (bounds in " + boundsSpace + " space)", async (t) => {
        const h = await startPlugin(boundsSpace);
        t.after(() => h.cleanup());

        const frame = await recordOneFrame(h);

        assert.deepEqual(h.ps.asked, [EXPECTED_MAX], "the 1080 setting caps a 7513x4617 canvas at 1837");
        assert.deepEqual(
            jpegSize(frame),
            { width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT },
            "the frame is the downscaled canvas, not " + CANVAS_WIDTH + "x" + CANVAS_HEIGHT +
                " of mostly white"
        );
    });
}
