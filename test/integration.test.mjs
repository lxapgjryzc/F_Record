/**
 * End-to-end test of the built Generator plug-in against a mock Photoshop.
 *
 * This loads `dist/generator/.../index.js` -- the exact bundle that ships --
 * and drives it through the same API generator-core uses: init(), then
 * Photoshop events. It covers the wiring the unit tests cannot: the HTTP
 * bridge, command handling, the capture path writing a real JPEG, and the
 * expensive-document guard actually being applied to getDocumentInfo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createRequire } from "node:module";

import { withIsolatedAppDir, tempDir, flush } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const BUNDLE = path.resolve("dist/generator/com.f_know.f_record.generator/index.js");
const BOUNDS = { top: 0, left: 0, right: 800, bottom: 600 };
const DEFAULT_DOC_FILE = "C:" + String.fromCharCode(92) + "art" + String.fromCharCode(92) + "test.psd";

/** A pixmap shaped exactly like generator-core's xpm.Pixmap: ARGB, 8-bit. */
function makePixmap(width, height, bounds) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = 255; // A
        pixels[i + 1] = 200; // R
        pixels[i + 2] = 100; // G
        pixels[i + 3] = 50; // B
    }
    return {
        width,
        height,
        pixels,
        rowBytes: width * 4,
        channelCount: 4,
        bitsPerChannel: 8,
        bytesPerPixel: 4,
        bounds: bounds || { top: 0, left: 0, right: width, bottom: height }
    };
}

function makeMockPhotoshop(initialFile) {
    const listeners = new Map();
    const settings = new Map();
    const calls = { documentInfo: [], pixmap: [] };
    let documentFile = initialFile || DEFAULT_DOC_FILE;

    const generator = {
        getDocumentInfo(documentId, flags) {
            calls.documentInfo.push({ documentId, flags });
            return Promise.resolve({
                id: 1,
                file: documentFile,
                bounds: BOUNDS,
                resolution: 72
            });
        },
        getDocumentPixmap(documentId, options) {
            calls.pixmap.push({ documentId, options });
            // Photoshop returns only the painted region; here half the canvas.
            return Promise.resolve(
                makePixmap(400, 300, { top: 0, left: 0, right: 400, bottom: 300 })
            );
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
        subscribed: () => Array.from(listeners.keys()),
        emit(event, payload) {
            for (const listener of listeners.get(event) || []) {
                listener(payload);
            }
        },
        saveAs(newPath) {
            // What Photoshop actually does: new path, settings gone.
            documentFile = newPath;
            settings.delete(1);
        }
    };
}

function request(bridge, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request(
            {
                host: "127.0.0.1",
                port: bridge.port,
                path: urlPath,
                method,
                headers: {
                    Authorization: "Bearer " + bridge.token,
                    "x-f-record-client": "f-record-panel",
                    ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
                }
            },
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

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error("timed out waiting for a condition");
        }
        await new Promise((r) => setTimeout(r, 25));
    }
}

async function startPlugin(initialFile) {
    const env = withIsolatedAppDir();
    // The bundle caches nothing across requires, but clear it anyway so each
    // test gets a fresh module instance.
    delete require.cache[BUNDLE];
    const plugin = require(BUNDLE);
    const ps = makeMockPhotoshop(initialFile);
    const handle = plugin.init(ps.generator, {}, null);
    await handle.ready;

    const bridgeFile = path.join(env.dir, "F_Record", "bridge.json");
    await waitFor(() => fs.existsSync(bridgeFile));
    const bridge = JSON.parse(fs.readFileSync(bridgeFile, "utf8"));

    return {
        ps,
        bridge,
        appDir: path.join(env.dir, "F_Record"),
        async cleanup() {
            await handle.stop();
            env.cleanup();
        }
    };
}

test("the plug-in starts, publishes a bridge, and serves its state", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    assert.ok(h.bridge.port > 0, "listening on a real port");
    assert.equal(typeof h.bridge.token, "string");
    assert.ok(h.bridge.token.length >= 32, "the token is not guessable");

    const state = await request(h.bridge, "GET", "/state");
    assert.equal(state.status, 200);
    assert.equal(state.body.generator.photoshopVersion, "27.2.0");
    assert.equal(state.body.config.enabled, false, "recording is off until asked for");
    assert.equal(state.body.session, null, "and no folder has been created");
});

test("the bridge refuses requests without the token, and any request from a browser", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    const noToken = await new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port: h.bridge.port,
                path: "/state",
                headers: { "x-f-record-client": "f-record-panel" }
            },
            (res) => {
                res.resume();
                resolve(res.statusCode);
            }
        );
        req.on("error", reject);
        req.end();
    });
    assert.equal(noToken, 403);

    // A web page cannot suppress the Origin header, so its presence means the
    // caller is not our panel -- this is what keeps a random site from probing
    // localhost and driving the plug-in.
    const withOrigin = await new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port: h.bridge.port,
                path: "/state",
                headers: {
                    Authorization: "Bearer " + h.bridge.token,
                    "x-f-record-client": "f-record-panel",
                    Origin: "https://example.com"
                }
            },
            (res) => {
                res.resume();
                resolve(res.statusCode);
            }
        );
        req.on("error", reject);
        req.end();
    });
    assert.equal(withOrigin, 403);
});

test("document info is always requested with the expensive flags off", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    assert.ok(h.ps.calls.documentInfo.length > 0, "the document was inspected at least once");
    for (const call of h.ps.calls.documentInfo) {
        // This is the regression that made 3.x grind Photoshop to a halt: it
        // used the default flags, which walk every layer in ExtendScript, twice
        // a second, whether or not recording was even on.
        assert.equal(call.flags.layerInfo, false, "no per-layer walk");
        assert.equal(call.flags.compInfo, false);
        assert.equal(call.flags.getTextStyles, false);
        assert.equal(call.flags.getCompLayerSettings, false);
        assert.equal(call.flags.imageInfo, true, "but bounds and file path are still fetched");
    }
});

test("enabling recording and drawing writes a real, complete JPEG", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    const enabled = await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 200 }
    });
    assert.equal(enabled.body.ok, true);
    assert.ok(enabled.body.state.session, "a session folder is created once recording starts");

    const folder = enabled.body.state.session.folder;
    assert.ok(fs.existsSync(path.join(folder, "session.json")), "the manifest lives inside the folder");

    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });

    const frames = await waitFor(() => {
        const files = fs.readdirSync(folder).filter((f) => f.endsWith(".jpg"));
        return files.length > 0 ? files : null;
    });

    assert.equal(frames.length, 1);
    assert.match(frames[0], /^\d{6}_\d{13}\.jpg$/, "sequence plus capture timestamp");

    const bytes = fs.readFileSync(path.join(folder, frames[0]));
    assert.equal(bytes[0], 0xff, "a real JPEG, SOI marker");
    assert.equal(bytes[1], 0xd8);
    assert.equal(bytes[bytes.length - 2], 0xff, "and a complete one, EOI marker");
    assert.equal(bytes[bytes.length - 1], 0xd9);
    assert.ok(bytes.length > 1000, "not an empty image");
});

test("the pixmap is requested clipped to the canvas, and downscaled", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 200, resolution: "360" }
    });
    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await waitFor(() => (h.ps.calls.pixmap.length > 0 ? true : null));

    // Exactly one pixmap call per frame. 3.x made two (a boundsOnly probe and
    // the real one), each of which triggered its own layer walk inside
    // generator-core.
    assert.equal(h.ps.calls.pixmap.length, 1);

    const options = h.ps.calls.pixmap[0].options;
    // All three together, or Photoshop ignores the lot: measured on 2026,
    // `clipToDocumentBounds` does nothing while `maxDimension` is present, and
    // `outputRect` is ignored without `inputRect` beside it.
    assert.ok(options.inputRect, "the canvas is named explicitly");
    assert.ok(options.outputRect, "and the size to render it at");
    assert.equal(options.clipToDocumentBounds, true, "so Photoshop crops and we never need to");
    assert.equal(options.maxDimension, undefined, "maxDimension would switch the clipping back off");

    const longest = Math.max(
        options.outputRect.right - options.outputRect.left,
        options.outputRect.bottom - options.outputRect.top
    );
    assert.ok(longest > 0 && longest <= 800, "downscaled for 360p");
});

test("a burst of change events produces one capture, not one per event", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 5000 }
    });

    for (let i = 0; i < 40; i++) {
        h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    }
    await waitFor(() => (h.ps.calls.pixmap.length > 0 ? true : null));
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(h.ps.calls.pixmap.length, 1, "40 events, 1 capture");
});

test("changes to documents that are not frontmost are ignored", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 100 }
    });
    const before = h.ps.calls.pixmap.length;

    h.ps.emit("imageChanged", { id: 99, layers: [{ pixels: true }] });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(h.ps.calls.pixmap.length, before);
});

test("events with no pixel changes do not trigger a capture", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 100 }
    });
    const before = h.ps.calls.pixmap.length;

    // Selecting a layer, renaming it, toggling visibility: not a pixel change.
    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: false, name: "Layer 1" }] });
    h.ps.emit("imageChanged", { id: 1, selection: {} });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(h.ps.calls.pixmap.length, before);
});

test("Save As hands the renamed document a copy and leaves the original whole", async (t) => {
    // Real files, because whether this counts as a Save As turns on a.psd
    // still being on disk once the document has become b.psd.
    const art = tempDir("f_record-art-");
    t.after(() => art.cleanup());
    const first = path.join(art.dir, "a.psd");
    const second = path.join(art.dir, "b.psd");
    fs.writeFileSync(first, "psd");

    const h = await startPlugin(first);
    t.after(() => h.cleanup());

    const started = await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 100 }
    });
    const original = started.body.state.session;

    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await waitFor(() =>
        fs.readdirSync(original.folder).filter((f) => f.endsWith(".jpg")).length >= 1 ? true : null
    );
    const drawnSoFar = fs.readdirSync(original.folder).filter((f) => f.endsWith(".jpg")).sort();

    // File > Save As. Photoshop writes b.psd, clears generatorSettings, and
    // leaves a.psd on disk exactly as it was.
    fs.writeFileSync(second, "psd");
    h.ps.saveAs(second);
    h.ps.emit("save", {});

    const forked = await waitFor(async () => {
        const state = await request(h.bridge, "GET", "/state");
        const session = state.body.session;
        return session && session.sessionId !== original.sessionId ? session : null;
    });

    // The drawing carries on where it was, in a folder of its own.
    assert.equal(forked.frameCount, drawnSoFar.length, "nothing is lost in the handover");
    assert.deepEqual(
        fs.readdirSync(forked.folder).filter((f) => f.endsWith(".jpg")).sort(),
        drawnSoFar,
        "the same frames, under the same names"
    );
    assert.equal(h.ps.settings.get(1).sessionId, forked.sessionId, "and the document is stamped with it");

    // a.psd keeps its own recording, frozen where it was saved away from.
    assert.deepEqual(
        fs.readdirSync(original.folder).filter((f) => f.endsWith(".jpg")).sort(),
        drawnSoFar
    );

    // Everything drawn from here belongs to b.psd alone. This is the 3.x
    // regression in its new form: a second folder is fine, a second folder
    // that starts empty and loses the first half of the drawing is not.
    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await waitFor(() =>
        fs.readdirSync(forked.folder).filter((f) => f.endsWith(".jpg")).length > drawnSoFar.length
            ? true
            : null
    );
    assert.equal(
        fs.readdirSync(original.folder).filter((f) => f.endsWith(".jpg")).length,
        drawnSoFar.length,
        "a.psd gains nothing from what is drawn in b.psd"
    );

    const config = JSON.parse(fs.readFileSync(path.join(h.appDir, "config.json"), "utf8"));
    assert.equal(fs.readdirSync(config.processImageFolderPath).length, 2, "two files, two recordings");
});

test("a plain save keeps writing into the same session folder", async (t) => {
    const art = tempDir("f_record-art-");
    t.after(() => art.cleanup());
    const file = path.join(art.dir, "a.psd");
    fs.writeFileSync(file, "psd");

    const h = await startPlugin(file);
    t.after(() => h.cleanup());

    const started = await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 100 }
    });
    const sessionId = started.body.state.session.sessionId;
    const folder = started.body.state.session.folder;

    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await waitFor(() => (fs.readdirSync(folder).filter((f) => f.endsWith(".jpg")).length >= 1 ? true : null));

    // Ctrl+S: same path, so there is nothing to fork.
    h.ps.emit("save", {});
    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await waitFor(() => (fs.readdirSync(folder).filter((f) => f.endsWith(".jpg")).length >= 2 ? true : null));

    const state = await request(h.bridge, "GET", "/state");
    assert.equal(state.body.session.sessionId, sessionId);

    const config = JSON.parse(fs.readFileSync(path.join(h.appDir, "config.json"), "utf8"));
    assert.deepEqual(fs.readdirSync(config.processImageFolderPath), [sessionId], "no second folder");
});

test("pause and resume are honoured, so export can stop competing with capture", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 100 }
    });
    await request(h.bridge, "POST", "/command", { type: "pause", reason: "Exporting" });

    const before = h.ps.calls.pixmap.length;
    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.ps.calls.pixmap.length, before, "paused means paused");

    const paused = await request(h.bridge, "GET", "/state");
    assert.equal(paused.body.health.pausedReason, "Exporting", "and the panel is told why");

    await request(h.bridge, "POST", "/command", { type: "resume" });
    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await waitFor(() => (h.ps.calls.pixmap.length > before ? true : null));
});

test("sessions can be listed and deleted over the bridge", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 100 }
    });
    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await waitFor(async () => {
        const listed = await request(h.bridge, "POST", "/command", { type: "listSessions" });
        return listed.body.sessions.length > 0 && listed.body.sessions[0].frameCount > 0 ? listed : null;
    });

    const listed = await request(h.bridge, "POST", "/command", { type: "listSessions" });
    assert.equal(listed.body.sessions.length, 1);
    assert.equal(listed.body.sessions[0].docName, "test");

    const stale = await request(h.bridge, "POST", "/command", {
        type: "deleteSession",
        sessionId: "no-such-session"
    });
    assert.equal(stale.body.ok, false, "and a folder we did not write is never touched");
});

test("deleting the take in progress wipes it and starts a fresh one", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    const started = await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 100 }
    });
    const folder = started.body.state.session.folder;
    const sessionId = started.body.state.session.sessionId;

    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await waitFor(() =>
        fs.readdirSync(folder).filter((f) => f.endsWith(".jpg")).length >= 1 ? true : null
    );

    // The artist decides the take is a write-off and starts over.
    const deleted = await request(h.bridge, "POST", "/command", {
        type: "deleteSession",
        sessionId
    });
    assert.equal(deleted.body.ok, true);
    assert.equal(fs.existsSync(folder), false, "the folder and every frame in it are gone");

    const fresh = deleted.body.state.session;
    assert.ok(fresh, "recording carries straight on");
    assert.notEqual(fresh.sessionId, sessionId, "in a new session");
    assert.equal(fresh.frameCount, 0, "starting from nothing");
    assert.equal(h.ps.settings.get(1).sessionId, fresh.sessionId, "and the PSD points at the new one");

    // Exactly one folder: the deleted one must not come back when the pending
    // manifest flush or a capture already in flight lands.
    const config = JSON.parse(fs.readFileSync(path.join(h.appDir, "config.json"), "utf8"));
    assert.deepEqual(fs.readdirSync(config.processImageFolderPath), [fresh.sessionId]);

    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });
    await waitFor(() =>
        fs.readdirSync(fresh.folder).filter((f) => f.endsWith(".jpg")).length >= 1 ? true : null
    );
    await new Promise((r) => setTimeout(r, 2500)); // outlast MANIFEST_FLUSH_MS
    assert.deepEqual(
        fs.readdirSync(config.processImageFolderPath),
        [fresh.sessionId],
        "and nothing resurrects the deleted folder afterwards"
    );
});

test("state and frame updates are pushed over SSE rather than polled for", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    const events = [];
    const stream = await new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port: h.bridge.port,
                path: "/events",
                headers: {
                    Authorization: "Bearer " + h.bridge.token,
                    "x-f-record-client": "f-record-panel",
                    Accept: "text/event-stream"
                }
            },
            (res) => {
                assert.equal(res.statusCode, 200);
                assert.match(res.headers["content-type"], /text\/event-stream/);
                res.setEncoding("utf8");
                let buffer = "";
                res.on("data", (chunk) => {
                    buffer += chunk;
                    let split = buffer.indexOf("\n\n");
                    while (split !== -1) {
                        const frame = buffer.slice(0, split);
                        buffer = buffer.slice(split + 2);
                        for (const line of frame.split("\n")) {
                            if (line.startsWith("data:")) {
                                events.push(JSON.parse(line.slice(5).trim()));
                            }
                        }
                        split = buffer.indexOf("\n\n");
                    }
                });
                resolve(req);
            }
        );
        req.on("error", reject);
        req.end();
    });
    t.after(() => stream.destroy());

    // A full state snapshot arrives immediately, so the panel paints at once.
    await waitFor(() => (events.some((e) => e.type === "state") ? true : null));

    await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minIntervalMs: 100 }
    });
    h.ps.emit("imageChanged", { id: 1, layers: [{ pixels: true }] });

    const frameEvent = await waitFor(() => events.find((e) => e.type === "frame") || null);
    assert.equal(frameEvent.frameCount, 1);
    assert.ok(frameEvent.at > 0);
});

test("a document below the minimum canvas size is not recorded", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    // 800x600 = 480,000 px; require more than that.
    const result = await request(h.bridge, "POST", "/command", {
        type: "setConfig",
        patch: { enabled: true, minCanvasPixels: 1000000 }
    });

    assert.equal(result.body.state.document.tooSmall, true);
    assert.equal(result.body.state.session, null, "no folder is created for a scratch document");
});

test("it subscribes only to the events it needs", async (t) => {
    const h = await startPlugin();
    t.after(() => h.cleanup());

    const subscribed = h.ps.subscribed().sort();
    assert.deepEqual(subscribed, ["currentDocumentChanged", "generatorMenuChanged", "imageChanged", "save"]);
});
