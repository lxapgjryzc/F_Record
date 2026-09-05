/**
 * Save As on a document Photoshop is slow to answer for.
 *
 * Writing a large PSD blocks Photoshop's script engine, so a document-info
 * request sent just before or during the save is answered only once the file
 * is on disk -- tens of seconds later on a network drive. Everything the user
 * does meanwhile (the Save As itself, a Canvas Size, the first strokes on the
 * renamed document) arrives as events while that one request is in flight.
 * Recording must pick up on the copy as soon as Photoshop answers, without
 * waiting for anything else.
 *
 * Drives the real built generator bundle, like integration.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createRequire } from "node:module";

import { withIsolatedAppDir, tempDir } from "./helpers.mjs";

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

/** A Photoshop whose document-info answers can be held back. */
function makeBusyPhotoshop(initialFile) {
    const listeners = new Map();
    const settings = new Map();
    const calls = { documentInfo: 0, pixmap: 0 };
    let file = initialFile;
    let canvas = bounds(1600, 1200);
    let infoGate = null;
    let swallowNextInfo = false;

    const generator = {
        getDocumentInfo() {
            calls.documentInfo++;
            const answer = () => ({ id: 1, file: file, bounds: canvas, resolution: 72 });
            if (swallowNextInfo) {
                swallowNextInfo = false;
                return new Promise(() => {});
            }
            if (infoGate) {
                return infoGate.promise.then(answer);
            }
            return Promise.resolve(answer());
        },
        getDocumentPixmap() {
            calls.pixmap++;
            return Promise.resolve(makePixmap(canvas.right, canvas.bottom));
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
        calls,
        settings,
        emit(event, payload) {
            for (const listener of listeners.get(event) || []) {
                listener(payload);
            }
        },
        /** Every document-info request from now on waits until release() is called. */
        holdDocumentInfo() {
            let release;
            const promise = new Promise((resolve) => (release = resolve));
            infoGate = { promise, release };
            return () => {
                infoGate = null;
                release();
            };
        },
        /** The next document-info request is never answered at all. */
        loseNextDocumentInfo() {
            swallowNextInfo = true;
        },
        saveAs(newPath) {
            file = newPath;
            this.emit("save", {});
            this.emit("imageChanged", { id: 1, file: newPath });
        },
        resize(width, height) {
            canvas = bounds(width, height);
            this.emit("imageChanged", { id: 1, bounds: canvas });
        },
        paint() {
            this.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
        }
    };
}

function request(bridge, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {
            Authorization: "Bearer " + bridge.token,
            "x-f-record-client": "f-record-panel"
        };
        if (payload) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(payload);
        }
        const req = http.request(
            { host: "127.0.0.1", port: bridge.port, path: urlPath, method, headers },
            (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (text += c));
                res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
            }
        );
        req.on("error", reject);
        req.end(payload);
    });
}

async function waitFor(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error("timed out waiting for " + what);
        }
        await new Promise((r) => setTimeout(r, 25));
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function framesIn(folder) {
    return fs.readdirSync(folder).filter((f) => f.endsWith(".jpg")).sort();
}

async function startPlugin(initialFile, pluginOptions = {}) {
    const env = withIsolatedAppDir();
    const appDir = path.join(env.dir, "F_Record");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
        path.join(appDir, "config.json"),
        JSON.stringify({ enabled: true, minIntervalMs: 100, autoStartNewDocuments: true })
    );

    delete require.cache[BUNDLE];
    const plugin = require(BUNDLE);
    const ps = makeBusyPhotoshop(initialFile);
    const handle = plugin.init(ps.generator, pluginOptions, null);
    await handle.ready;

    const bridgeFile = path.join(appDir, "bridge.json");
    await waitFor(() => fs.existsSync(bridgeFile), 5000, "the bridge");
    const bridge = JSON.parse(fs.readFileSync(bridgeFile, "utf8"));

    return {
        ps,
        bridge,
        appDir,
        log: () => fs.readFileSync(path.join(appDir, "logs", "generator.log"), "utf8"),
        async cleanup() {
            await handle.stop();
            env.cleanup();
        }
    };
}

test("Save As, Canvas Size and the first strokes all landing while Photoshop is busy still record the copy", async (t) => {
    const art = tempDir("f_record-art-");
    t.after(() => art.cleanup());
    const first = path.join(art.dir, "a.psd");
    const second = path.join(art.dir, "b.psd");
    fs.writeFileSync(first, "psd");

    const h = await startPlugin(first);
    t.after(() => h.cleanup());

    const state = await request(h.bridge, "GET", "/state");
    const original = state.body.session;
    assert.ok(original, "recording is on");

    h.ps.paint();
    await waitFor(() => framesIn(original.folder).length >= 1, 5000, "the first frame");
    const drawnSoFar = framesIn(original.folder);

    // Photoshop starts writing the file and stops answering scripts. A plain
    // save is what triggers the document sync that will now sit in flight.
    const release = h.ps.holdDocumentInfo();
    h.ps.emit("save", {});
    await sleep(250);

    // Meanwhile: the Save As completes, the user widens the canvas and draws.
    fs.writeFileSync(second, "psd");
    h.ps.saveAs(second);
    h.ps.resize(2000, 1200);
    await sleep(50);
    h.ps.paint();
    await sleep(200);
    h.ps.paint();
    await sleep(200);

    // Photoshop answers at last, with the new name and the new canvas.
    release();

    const forked = await waitFor(
        async () => {
            const s = await request(h.bridge, "GET", "/state");
            return s.body.session && s.body.session.sessionId !== original.sessionId ? s.body.session : null;
        },
        5000,
        "the fork"
    );
    assert.deepEqual(framesIn(forked.folder), drawnSoFar, "the copy starts with everything drawn so far");

    // Drawing carries on. The copy must gain a frame promptly -- this is the
    // whole point of forking -- and the original must not. Three seconds is
    // well inside the five-second heartbeat, so this passes only if the sync
    // the resize asked for during the wait is actually run, not merely
    // rescued by the next heartbeat.
    const pixmapsBefore = h.ps.calls.pixmap;
    h.ps.paint();
    await waitFor(() => framesIn(forked.folder).length > drawnSoFar.length, 3000, "a frame on the copy");
    assert.ok(h.ps.calls.pixmap > pixmapsBefore, "a render was actually asked for");
    assert.deepEqual(framesIn(original.folder), drawnSoFar, "the original is left alone");
    assert.deepEqual(h.ps.settings.get(1), { sessionId: forked.sessionId }, "the document carries the copy's id");
    assert.ok(!/has not answered/.test(h.log()), "a slow answer is not a lost one");
});

test("a document-info request Photoshop never answers is given up on, loudly, and recording carries on", async (t) => {
    const art = tempDir("f_record-art-");
    t.after(() => art.cleanup());
    const file = path.join(art.dir, "a.psd");
    fs.writeFileSync(file, "psd");

    // A stall limit short enough to test; production waits 30 seconds.
    const h = await startPlugin(file, { syncStallMs: 400 });
    t.after(() => h.cleanup());

    const state = await request(h.bridge, "GET", "/state");
    const folder = state.body.session.folder;
    h.ps.paint();
    await waitFor(() => framesIn(folder).length >= 1, 5000, "the first frame");
    const before = framesIn(folder).length;

    // The request a plain save sends out vanishes into Photoshop. The resize
    // that follows leaves the canvas ahead of what has been synced, so every
    // capture from here on is waiting on a sync that will never complete.
    h.ps.loseNextDocumentInfo();
    h.ps.emit("save", {});
    await sleep(100);
    h.ps.resize(2000, 1200);
    h.ps.paint();

    // Nothing can be recorded until the lost request is written off. Once it
    // is, the frame that was waiting must be taken against the new canvas.
    await waitFor(() => framesIn(folder).length > before, 3000, "a frame after the lost request");
    assert.match(h.log(), /has not answered a document-info request for \d+s; asking again/);
    assert.equal(
        (h.log().match(/has not answered/g) || []).length,
        1,
        "the stall is reported once, not on every retry"
    );
    assert.match(h.log(), /answering again after \d+s; recording resumes/, "and its end is reported too");
    const s = await request(h.bridge, "GET", "/state");
    assert.deepEqual(s.body.document.bounds, bounds(2000, 1200), "and the canvas has caught up");
});
