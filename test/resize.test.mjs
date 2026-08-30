/**
 * Resizing the canvas in the middle of a recording.
 *
 * Image Size and Canvas Size are ordinary things to reach for halfway through a
 * drawing, and both change `documentInfo.bounds` under a live session. What has
 * to hold: the session must not be orphaned into a new folder, frames written
 * afterwards must match the new canvas, and a resize landing while a capture is
 * already in flight must not produce a frame padded out to the size the canvas
 * used to be -- which it did, until the bounds-generation guard in
 * performCapture. The last test pins down the one thing that is deliberately
 * *not* captured: a resize on its own, with no stroke after it.
 *
 * Drives the real built generator bundle, like integration.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

import { withIsolatedAppDir } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const BUNDLE = path.resolve("dist/generator/com.f_know.f_record.generator/index.js");

function bounds(width, height) {
    return { top: 0, left: 0, right: width, bottom: height };
}

function makePixmap(width, height) {
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
        bounds: bounds(width, height)
    };
}

/**
 * A Photoshop whose canvas can be resized, and whose pixmap call can be held
 * open so a resize can be made to land while a capture is mid-flight.
 */
function makeResizablePhotoshop() {
    const listeners = new Map();
    const settings = new Map();
    let canvas = bounds(1600, 1200);
    let gate = null;

    const generator = {
        getDocumentInfo() {
            return Promise.resolve({ id: 1, file: "C:\\art\\test.psd", bounds: canvas, resolution: 72 });
        },
        getDocumentPixmap() {
            // Photoshop clips to the canvas, so the pixmap always matches
            // whatever the canvas is at the moment it renders.
            const produce = () => makePixmap(canvas.right, canvas.bottom);
            if (gate) {
                return gate.promise.then(produce);
            }
            return Promise.resolve(produce());
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
        emit(event, payload) {
            for (const listener of listeners.get(event) || []) {
                listener(payload);
            }
        },
        /** What Image Size / Canvas Size does: new bounds, plus an event. */
        resize(width, height) {
            canvas = bounds(width, height);
            this.emit("imageChanged", { id: 1, bounds: canvas });
        },
        canvas: () => canvas,
        /** Holds the next pixmap render open until release() is called. */
        hold() {
            let release;
            const promise = new Promise((resolve) => (release = resolve));
            gate = { promise, release };
            return () => {
                gate = null;
                release();
            };
        },
        paint() {
            this.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
        }
    };
}

async function startPlugin() {
    const env = withIsolatedAppDir();
    const appDir = path.join(env.dir, "F_Record");

    // Arm recording before the plug-in loads: ConfigStore reads config.json in
    // its constructor, so this is the same state as a user who left the switch
    // on. A short interval keeps the test quick.
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
        path.join(appDir, "config.json"),
        JSON.stringify({
            enabled: true,
            autoStartNewDocuments: true,
            minIntervalMs: 200,
            minCanvasPixels: 0,
            processImageFolderPath: path.join(appDir, "processImages")
        })
    );

    delete require.cache[BUNDLE];
    const plugin = require(BUNDLE);
    const ps = makeResizablePhotoshop();
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
    const before = (() => {
        const folders = sessionFolders(h.appDir);
        return folders.length ? framesIn(path.join(h.appDir, "processImages", folders[0])).length : 0;
    })();
    h.ps.paint();
    await waitFor(() => {
        const folders = sessionFolders(h.appDir);
        if (!folders.length) return false;
        return framesIn(path.join(h.appDir, "processImages", folders[0])).length > before;
    });
    const folder = path.join(h.appDir, "processImages", sessionFolders(h.appDir)[0]);
    const frames = framesIn(folder);
    return path.join(folder, frames[frames.length - 1]);
}

test("a resize does not orphan the session into a second folder", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    // Arm recording the way the menu item does.
    await recordOneFrame(h);

    const folderCount = sessionFolders(h.appDir).length;
    assert.equal(folderCount, 1, "one session to begin with");

    h.ps.resize(800, 600);
    await recordOneFrame(h);

    assert.equal(
        sessionFolders(h.appDir).length,
        1,
        "the resize kept recording into the same folder"
    );
});

test("frames written after a resize match the new canvas", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    const first = await recordOneFrame(h);
    const firstSize = jpegSize(first);
    assert.equal(firstSize.width / firstSize.height > 1, true, "1600x1200 is landscape");

    h.ps.resize(600, 1200);
    // Give the debounced resync time to pick the new bounds up.
    await new Promise((r) => setTimeout(r, 400));
    const second = await recordOneFrame(h);
    const secondSize = jpegSize(second);

    assert.ok(
        secondSize.height > secondSize.width,
        "after resizing to 600x1200 the frame is portrait, got " +
            secondSize.width + "x" + secondSize.height
    );
});

test("a resize landing mid-capture does not pad the frame out to the old canvas", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    await recordOneFrame(h);
    const folder = path.join(h.appDir, "processImages", sessionFolders(h.appDir)[0]);
    const before = framesIn(folder).length;

    // Hold the render open, start a capture, shrink the canvas while that
    // capture is still in flight, then let the render complete. The pixmap that
    // comes back describes the NEW canvas; the capture began under the old one.
    const release = h.ps.hold();
    h.ps.paint();
    await new Promise((r) => setTimeout(r, 60));
    h.ps.resize(400, 300);
    await new Promise((r) => setTimeout(r, 60));
    release();

    // Wait for a frame written after the resize. The mid-flight one is dropped,
    // so this is the retake, and it must describe the canvas as it now is.
    await waitFor(() => framesIn(folder).length > before, 8000);

    const frames = framesIn(folder);
    const last = jpegSize(path.join(folder, frames[frames.length - 1]));

    // The canvas is 400x300. A frame appreciably larger than that means the old
    // 1600x1200 bounds were used to pad it, leaving the image in one corner of
    // a mostly blank frame.
    assert.ok(
        last.width <= 420 && last.height <= 320,
        "frame should match the 400x300 canvas, got " + last.width + "x" + last.height
    );
});

test("a resize on its own does not add a frame; the next stroke does", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    await recordOneFrame(h);
    const folder = path.join(h.appDir, "processImages", sessionFolders(h.appDir)[0]);
    const before = framesIn(folder).length;

    // Canvas Size / Image Size report new bounds but no pixel change, and the
    // capture trigger is pixel changes. So resizing alone is not recorded --
    // the new canvas first appears in the frame after the next stroke.
    h.ps.resize(900, 900);
    await new Promise((r) => setTimeout(r, 900));

    assert.equal(framesIn(folder).length, before, "the resize itself is not a frame");

    const next = await recordOneFrame(h);
    const size = jpegSize(next);
    assert.ok(
        Math.abs(size.width - size.height) <= 2,
        "the next stroke records the new square canvas, got " + size.width + "x" + size.height
    );
});
