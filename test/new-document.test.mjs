/**
 * A second document opened while the first is still being synced.
 *
 * Every other test drives one document, so nothing here had ever seen the
 * frontmost document change while a document-info request for the previous
 * one was in flight. That is what "save, then File > New" does: the save
 * sends out a sync, Photoshop answers it only once the file is on disk, and
 * the new document arrives in between. The answer describes the document
 * the user just left; applied as if it were current, it pointed recording
 * back at the old document, and every stroke on the new one was ignored --
 * indefinitely, because the heartbeat asks for the document it believes is
 * frontmost, and that belief is exactly what had been overwritten.
 *
 * Drives the real built generator bundle, like saveas-busy.test.mjs.
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

/**
 * A Photoshop with several documents, one of them frontmost.
 *
 * Document-info requests name a document, or ask for the frontmost one; the
 * settings write goes to whichever document is frontmost when Photoshop gets
 * round to it, as it does in the real thing. Both kinds of request can be
 * held back to stand in for a Photoshop that is busy saving.
 */
function makeMultiDocumentPhotoshop() {
    const listeners = new Map();
    const settings = new Map();
    const docs = new Map();
    const calls = { documentInfo: [], pixmap: [] };
    let active = null;
    let infoGate = null;
    let settingsGate = null;

    const gated = (gate, produce) => {
        if (gate) {
            return gate.promise.then(produce);
        }
        return Promise.resolve().then(produce);
    };
    const holder = (set) => {
        let release;
        const promise = new Promise((resolve) => (release = resolve));
        set({ promise, release });
        return () => {
            set(null);
            release();
        };
    };

    const generator = {
        getDocumentInfo(documentId) {
            calls.documentInfo.push(documentId);
            return gated(infoGate, () => {
                const id = documentId === undefined ? active : documentId;
                const doc = docs.get(id);
                if (!doc) {
                    throw new Error("No such document");
                }
                return { id: id, file: doc.file, bounds: doc.bounds, resolution: 72 };
            });
        },
        getDocumentPixmap(documentId) {
            calls.pixmap.push(documentId);
            const doc = docs.get(documentId);
            return Promise.resolve(makePixmap(doc.bounds.right, doc.bounds.bottom));
        },
        getDocumentSettingsForPlugin(documentId) {
            return gated(settingsGate, () => {
                if (!settings.has(documentId)) {
                    throw new Error("no generatorSettings");
                }
                return settings.get(documentId);
            });
        },
        setDocumentSettingsForPlugin(value) {
            return gated(settingsGate, () => {
                settings.set(active, value);
            });
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
        /** Every document-info request from now on waits until the returned function is called. */
        holdDocumentInfo() {
            return holder((gate) => (infoGate = gate));
        },
        /** Every generatorSettings read and write waits until the returned function is called. */
        holdSettings() {
            return holder((gate) => (settingsGate = gate));
        },
        /** File > New: the document exists and is frontmost before any event says so. */
        newDocument(id, name, size) {
            docs.set(id, { file: name, bounds: size });
            active = id;
            this.emit("currentDocumentChanged", id);
            this.emit("imageChanged", { id: id, file: name, bounds: size, active: true });
        },
        /** Clicking another document's tab. */
        switchTo(id) {
            active = id;
            this.emit("currentDocumentChanged", id);
        },
        /** A first save of an untitled document: it gains a path and loses its settings. */
        save(id, filePath) {
            docs.get(id).file = filePath;
            settings.delete(id);
            this.emit("save", {});
            this.emit("imageChanged", { id: id, file: filePath });
        },
        paint(id) {
            this.emit("imageChanged", { id: id, layers: [{ pixels: true }] });
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

async function startPlugin() {
    const env = withIsolatedAppDir();
    const appDir = path.join(env.dir, "F_Record");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
        path.join(appDir, "config.json"),
        JSON.stringify({ enabled: true, minIntervalMs: 100, autoStartNewDocuments: true })
    );

    delete require.cache[BUNDLE];
    const plugin = require(BUNDLE);
    const ps = makeMultiDocumentPhotoshop();
    ps.newDocument(1, "Untitled-1", bounds(1600, 1200));
    const handle = plugin.init(ps.generator, {}, null);
    await handle.ready;

    const bridgeFile = path.join(appDir, "bridge.json");
    await waitFor(() => fs.existsSync(bridgeFile), 5000, "the bridge");
    const bridge = JSON.parse(fs.readFileSync(bridgeFile, "utf8"));

    return {
        ps,
        bridge,
        appDir,
        state: async () => (await request(bridge, "GET", "/state")).body,
        log: () => fs.readFileSync(path.join(appDir, "logs", "generator.log"), "utf8"),
        async cleanup() {
            await handle.stop();
            env.cleanup();
        }
    };
}

/** Draws on the first document, saves it, and hands back its session. */
async function drawAndSaveFirst(h, art) {
    const first = (await h.state()).session;
    assert.ok(first, "recording is on");
    h.ps.paint(1);
    await waitFor(() => framesIn(first.folder).length >= 1, 5000, "the first frame");
    const saved = path.join(art.dir, "one.psd");
    fs.writeFileSync(saved, "psd");
    return { session: first, file: saved };
}

/**
 * Drawing on the new document must land in a recording of its own, and must
 * do so well inside the five-second heartbeat: this is the event path being
 * tested, not a rescue.
 */
async function expectSecondDocumentRecorded(h, first) {
    const drawnOnFirst = framesIn(first.folder);
    h.ps.paint(2);
    await sleep(150);
    h.ps.paint(2);

    const second = await waitFor(
        async () => {
            const s = await h.state();
            return s.session && s.session.sessionId !== first.sessionId && s.document && s.document.id === 2
                ? s.session
                : null;
        },
        3000,
        "a recording for the second document"
    );
    await waitFor(() => framesIn(second.folder).length >= 1, 3000, "a frame on the second document");
    assert.deepEqual(framesIn(first.folder), drawnOnFirst, "the first document's recording is left alone");
    assert.ok(
        h.ps.calls.pixmap.indexOf(2) !== -1 && h.ps.calls.pixmap.indexOf(1, h.ps.calls.pixmap.indexOf(2)) === -1,
        "every render after the switch is of the second document"
    );
    assert.deepEqual(h.ps.settings.get(2), { sessionId: second.sessionId }, "the new document carries its own id");
    // The first document's own id may still be waiting to be written back --
    // Photoshop only lets the frontmost document be stamped -- but the new
    // document's id must not have landed in it.
    assert.notDeepEqual(h.ps.settings.get(1), { sessionId: second.sessionId }, "and the first does not carry it");

    // Going back to the first document carries on its recording, in its own
    // folder, and the id that could not be written while it was behind is
    // written now.
    h.ps.switchTo(1);
    await waitFor(
        async () => {
            const s = await h.state();
            return s.session && s.session.sessionId === first.sessionId && s.document && s.document.id === 1;
        },
        3000,
        "the first document's recording to be picked up again"
    );
    const drawnOnSecond = framesIn(second.folder);
    h.ps.paint(1);
    await waitFor(() => framesIn(first.folder).length > drawnOnFirst.length, 3000, "a frame on the first document again");
    assert.deepEqual(framesIn(second.folder), drawnOnSecond, "the second document's recording is left alone");
    assert.deepEqual(h.ps.settings.get(1), { sessionId: first.sessionId }, "the first document carries its own id");
    return second;
}

test("File > New while Photoshop is still answering for the saved document records the new one", async (t) => {
    const art = tempDir("f_record-art-");
    t.after(() => art.cleanup());
    const h = await startPlugin();
    t.after(() => h.cleanup());
    const first = await drawAndSaveFirst(h, art);

    // Photoshop starts writing the file and stops answering scripts. The save
    // sends out a document sync that now sits in flight, asking about the
    // document being saved.
    const release = h.ps.holdDocumentInfo();
    h.ps.save(1, first.file);
    await sleep(250);

    // Meanwhile the user starts a new drawing.
    h.ps.newDocument(2, "Untitled-2", bounds(1000, 800));
    await sleep(50);

    // Photoshop answers at last -- about the document that is no longer in front.
    release();

    await expectSecondDocumentRecorded(h, first.session);
});

test("File > New while the saved document's session is being repaired records the new one", async (t) => {
    const art = tempDir("f_record-art-");
    t.after(() => art.cleanup());
    const h = await startPlugin();
    t.after(() => h.cleanup());
    const first = await drawAndSaveFirst(h, art);

    // This time Photoshop answers the document-info request promptly but
    // sits on the generatorSettings read and write that follow it: the sync
    // is past the answer and into resolving the session when the new
    // document arrives.
    const release = h.ps.holdSettings();
    h.ps.save(1, first.file);
    await sleep(250);
    h.ps.newDocument(2, "Untitled-2", bounds(1000, 800));
    await sleep(50);
    release();

    await expectSecondDocumentRecorded(h, first.session);
});

test("the first stroke on the new document, landing before its sync is done, is recorded", async (t) => {
    const art = tempDir("f_record-art-");
    t.after(() => art.cleanup());
    const h = await startPlugin();
    t.after(() => h.cleanup());
    const first = await drawAndSaveFirst(h, art);
    h.ps.save(1, first.file);
    await sleep(400);

    // Photoshop answers document-info promptly this time; what takes long is
    // setting up the new document's recording, which reads and writes its
    // settings. The user does not wait for that: the first stroke lands
    // while it is still under way.
    const release = h.ps.holdSettings();
    h.ps.newDocument(2, "Untitled-2", bounds(1000, 800));
    await sleep(250);
    h.ps.paint(2);
    await sleep(50);
    release();

    // No further stroke. The one that landed has to be enough.
    const second = await waitFor(
        async () => {
            const s = await h.state();
            return s.session && s.session.sessionId !== first.session.sessionId && s.document && s.document.id === 2
                ? s.session
                : null;
        },
        3000,
        "a recording for the second document"
    );
    await waitFor(() => framesIn(second.folder).length >= 1, 3000, "the first stroke on the second document");
});

test("File > New with Photoshop answering promptly records the new document", async (t) => {
    const art = tempDir("f_record-art-");
    t.after(() => art.cleanup());
    const h = await startPlugin();
    t.after(() => h.cleanup());
    const first = await drawAndSaveFirst(h, art);

    h.ps.save(1, first.file);
    await sleep(400);
    h.ps.newDocument(2, "Untitled-2", bounds(1000, 800));

    await expectSecondDocumentRecorded(h, first.session);
});
