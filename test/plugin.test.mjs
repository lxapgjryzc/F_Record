/**
 * The plug-in's own edges.
 *
 * integration, resize, saveas-busy, new-document and downscale drive whole
 * recordings through a Photoshop that behaves. This file drives the same
 * plug-in through the states it is written to survive but nobody would arrange
 * on purpose: a Photoshop that will not say which version it is, a menu that
 * cannot be installed, a document that closes under a live session, a pixmap
 * with nothing in it, a disk that stops taking the manifest, and every command
 * the panel can send that the happy path never reaches.
 *
 * The rule the whole file is really about: none of it may stop the recording.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as nodeHttp from "node:http";
import * as path from "node:path";
import { Writable } from "node:stream";

import { clearFaults, fsError, mockBuiltins, setFault, tempDir, withIsolatedAppDir } from "./helpers.mjs";
import { makeJsxEngine } from "./photoshop.mjs";

mockBuiltins(mock, "fs", "http", "https");
const { init } = await import("../dist/modules/index.mjs");
const { ConfigStore } = await import("../dist/modules/store.mjs");

const BOUNDS = { top: 0, left: 0, right: 800, bottom: 600 };
const DOC_FILE = "C:" + String.fromCharCode(92) + "art" + String.fromCharCode(92) + "dragon.psd";

function pixmap(width, height) {
    const pixels = Buffer.alloc(Math.max(0, width * height * 4), 200);
    return {
        width,
        height,
        pixels,
        rowBytes: width * 4,
        channelCount: 4,
        bitsPerChannel: 8,
        bytesPerPixel: 4,
        bounds: { top: 0, left: 0, right: width, bottom: height }
    };
}

/**
 * A Photoshop that can be told to misbehave in one specific way.
 *
 * Everything is a hook so a test can name the one thing it is about, rather
 * than assembling a whole Photoshop each time.
 */
function makePhotoshop(options = {}) {
    const listeners = new Map();
    const settings = new Map();
    const calls = { documentInfo: [], pixmap: [], menu: [], toggles: [], saved: [] };
    let file = options.file === undefined ? DOC_FILE : options.file;
    let bounds = options.bounds === undefined ? BOUNDS : options.bounds;
    let id = 1;

    const writeSettings = makeJsxEngine({
        frontmost: () => 1,
        isOpen: () => true,
        write: (id, key, json) => settings.set(id, JSON.parse(json))
    });

    const generator = {
        getDocumentInfo(documentId, flags) {
            calls.documentInfo.push({ documentId, flags });
            if (options.documentInfo) {
                return options.documentInfo(documentId, flags);
            }
            return Promise.resolve({ id, file, bounds, resolution: 72 });
        },
        getDocumentPixmap(documentId, opts) {
            calls.pixmap.push({ documentId, options: opts });
            if (options.pixmap) {
                return options.pixmap(documentId, opts);
            }
            return Promise.resolve(pixmap(400, 300));
        },
        getDocumentSettingsForPlugin(documentId) {
            if (!settings.has(documentId)) {
                return Promise.reject(new Error("no generatorSettings"));
            }
            return Promise.resolve(settings.get(documentId));
        },
        evaluateJSXString(script) {
            if (options.evaluateJSXString) {
                return options.evaluateJSXString(script);
            }
            return Promise.resolve(writeSettings(script));
        },
        onPhotoshopEvent(event, listener) {
            if (!listeners.has(event)) {
                listeners.set(event, []);
            }
            listeners.get(event).push(listener);
        },
        addMenuItem(id, label, enabled, checked) {
            calls.menu.push({ id, label, enabled, checked });
            return options.addMenuItem ? options.addMenuItem() : Promise.resolve();
        },
        toggleMenu(id, enabled, checked, label) {
            calls.toggles.push({ id, enabled, checked, label });
            return options.toggleMenu ? options.toggleMenu() : Promise.resolve();
        }
    };
    if (options.version !== "absent") {
        generator.getPhotoshopVersion = () =>
            options.version instanceof Error ? Promise.reject(options.version) : Promise.resolve("27.2.0");
    }
    if (options.storedSessionId) {
        // A document that already carries a session id, the way one that has
        // been recorded before comes back from disk.
        settings.set(1, { sessionId: options.storedSessionId });
    }
    if (options.savePixmap) {
        generator.savePixmap = (pm, filePath, s) => {
            calls.saved.push({ filePath, settings: s });
            return options.savePixmap(pm, filePath, s);
        };
    }

    return {
        generator,
        calls,
        settings,
        emit(event, payload) {
            for (const listener of listeners.get(event) || []) {
                listener(payload);
            }
        },
        setFile(next) {
            file = next;
            settings.delete(1);
        },
        setBounds(next) {
            bounds = next;
        },
        setId(next) {
            id = next;
        }
    };
}

/**
 * A started plug-in, shut down again by the test runner.
 *
 * With `captureTimers` the recurring work is taken off the clock and handed to
 * the test instead: the plug-in's tick is one a second and its heartbeat every
 * fifth, so waiting for one in real time would put five seconds into the suite
 * for every test that needs it.
 */
async function startPlugin(t, options = {}) {
    const env = withIsolatedAppDir();
    if (options.config) {
        new ConfigStore().update(options.config);
    }
    if (options.before) {
        options.before(env);
    }
    const ps = makePhotoshop(options.photoshop);
    const logs = [];

    const realSetInterval = globalThis.setInterval;
    const intervals = [];
    if (options.captureTimers) {
        globalThis.setInterval = (fn, ms) => {
            intervals.push({ fn, ms });
            return { unref() {} };
        };
    }
    let handle;
    try {
        handle = init(ps.generator, options.pluginOptions || {}, {
            info: (m) => logs.push("info: " + m),
            warn: (m) => logs.push("warn: " + m),
            error: (m) => logs.push("error: " + m)
        });
        await handle.ready;
    } finally {
        globalThis.setInterval = realSetInterval;
    }

    t.after(async () => {
        await handle.stop();
        env.cleanup();
        clearFaults();
    });

    const h = {
        ps,
        handle,
        logs,
        env,
        appDir: path.join(env.dir, "F_Record"),
        /** Runs the plug-in's one-second tick once. */
        tick() {
            for (const timer of intervals) {
                if (timer.ms === 1000) {
                    timer.fn();
                }
            }
        },
        async sessionId() {
            return (await command(h, { type: "ping" })).state.session.sessionId;
        }
    };
    return h;
}

/** Sends a command straight to the plug-in, without going over HTTP. */
function command(h, cmd) {
    const info = JSON.parse(fs.readFileSync(path.join(h.appDir, "bridge.json"), "utf8"));
    return sendOverBridge(info, cmd);
}

function sendOverBridge(info, cmd) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(cmd);
        const req = nodeHttp.request(
            {
                host: "127.0.0.1",
                port: info.port,
                path: "/command",
                method: "POST",
                headers: {
                    Authorization: "Bearer " + info.token,
                    "x-f-record-client": "f-record-panel",
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload)
                }
            },
            (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (text += c));
                res.on("end", () => resolve(text ? JSON.parse(text) : null));
            }
        );
        req.on("error", reject);
        req.end(payload);
    });
}

async function settle(times = 12) {
    for (let i = 0; i < times; i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
}

/* ---------------------------------------------------------------- start-up */

test("a Photoshop that will not say which version it is is still recorded from", async (t) => {
    const h = await startPlugin(t, { photoshop: { version: new Error("no version available") } });

    // Cosmetic information; the panel shows a blank rather than the plug-in
    // refusing to start over it.
    const state = await command(h, { type: "ping" });
    assert.equal(state.ok, true);
    assert.equal(state.state.generator.photoshopVersion, null);
});

test("a Photoshop with no version API at all is still recorded from", async (t) => {
    const h = await startPlugin(t, { photoshop: { version: "absent" } });
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.generator.photoshopVersion, null);
});

test("a menu that cannot be installed is a warning, not a failed load", async (t) => {
    const h = await startPlugin(t, {
        photoshop: { addMenuItem: () => Promise.reject(new Error("menus are not available")) }
    });

    assert.match(h.logs.join("\n"), /Could not install the Photoshop menu item: menus are not available/);
    const state = await command(h, { type: "ping" });
    assert.equal(state.ok, true, "and the plug-in is running");
});

test("auto-start arms recording without waiting for the panel", async (t) => {
    const h = await startPlugin(t, { config: { autoStart: true, enabled: false } });

    // The artist ticked "start recording as soon as Photoshop opens"; making
    // them open the panel first would defeat the point of it.
    assert.match(h.logs.join("\n"), /Auto-start is on/);
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.config.enabled, true);
});

test("a bridge that cannot be started costs the panel, not the recording", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    // A machine that forbids listening sockets. The generator keeps writing
    // frames; the panel simply reports that it cannot reach it.
    setFault("createServer", () => {
        const server = new nodeHttp.Server();
        server.listen = () => {
            process.nextTick(() => server.emit("error", fsError("EACCES", "listening is not permitted")));
            return server;
        };
        return server;
    });
    const ps = makePhotoshop();
    const logs = [];
    const handle = init(ps.generator, {}, { info: () => {}, warn: () => {}, error: (m) => logs.push(m) });
    await handle.ready;
    t.after(() => handle.stop());
    clearFaults();

    assert.match(logs.join("\n"), /Bridge failed to start, the panel will not connect: .*listening is not permitted/);
});

test("a start-up that fails outright is reported to Photoshop's own log", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    // generator-core calls init() synchronously while loading plug-ins and
    // treats a throw as "plugin failed to load", so everything real happens
    // asynchronously and every failure ends up here instead.
    setFault("writeFileSync", () => {
        throw fsError("EACCES", "the data directory is read-only");
    });
    const logs = [];
    const handle = init(makePhotoshop().generator, {}, {
        info: () => {},
        warn: () => {},
        error: (m) => logs.push(m)
    });
    await handle.ready;
    t.after(() => handle.stop());
    clearFaults();

    assert.match(logs.join("\n"), /F_Record failed to start: .*the data directory is read-only/);
});

/* ------------------------------------------------------------- the menu */

test("the Photoshop menu item toggles recording", async (t) => {
    const h = await startPlugin(t);
    assert.equal(h.ps.calls.menu.length, 1);
    const menuId = h.ps.calls.menu[0].id;

    h.ps.emit("generatorMenuChanged", { generatorMenuChanged: { name: menuId } });
    await settle();

    const state = await command(h, { type: "ping" });
    assert.equal(state.state.config.enabled, true, "the menu is a second switch for the same setting");

    // Someone else's menu item, and a malformed event: neither is ours.
    h.ps.emit("generatorMenuChanged", { generatorMenuChanged: { name: "com.other.plugin" } });
    h.ps.emit("generatorMenuChanged", {});
    h.ps.emit("generatorMenuChanged", null);
    await settle();
    assert.equal((await command(h, { type: "ping" })).state.config.enabled, true, "unchanged");
});

test("a menu toggle that fails is reported rather than lost", async (t) => {
    const h = await startPlugin(t, {
        photoshop: { toggleMenu: () => Promise.reject(new Error("the menu went away")) }
    });
    const menuId = h.ps.calls.menu[0].id;

    // refreshMenu failing is cosmetic and swallowed; what must not be lost is
    // the setting change itself.
    h.ps.emit("generatorMenuChanged", { generatorMenuChanged: { name: menuId } });
    await settle();
    assert.equal((await command(h, { type: "ping" })).state.config.enabled, true);
});

test("the menu label follows the panel's language", async (t) => {
    const h = await startPlugin(t, { config: { language: "en" } });
    assert.equal(h.ps.calls.menu[0].label, "F_Record: Record");

    const other = await startPlugin(t, { config: { language: "zh-CN" } });
    assert.notEqual(other.ps.calls.menu[0].label, "F_Record: Record");
});

/* --------------------------------------------------------------- events */

test("an imageChanged event with nothing in it is ignored", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();

    h.ps.emit("imageChanged", null);
    h.ps.emit("imageChanged", undefined);
    await settle();

    const state = await command(h, { type: "ping" });
    assert.equal(state.ok, true);
});

test("a document that closes takes its session with it", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    assert.ok((await command(h, { type: "ping" })).state.session, "precondition: recording something");

    // File > Close. Continuing to hold the session would leave the panel
    // showing a recording for a document that is not open.
    h.ps.emit("imageChanged", { id: 1, closed: true });
    await settle();

    const state = await command(h, { type: "ping" });
    assert.equal(state.state.session, null);
});

test("a document that closes without an id is not acted on", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();

    h.ps.emit("imageChanged", { closed: true });
    await settle();

    assert.ok((await command(h, { type: "ping" })).state.session, "the live session is untouched");
});

test("a throw inside the event handler is logged, not raised into Photoshop", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();

    // generator-core calls this listener directly; an exception out of it goes
    // nowhere useful and, on some hosts, takes the event subscription with it.
    h.ps.emit("imageChanged", {
        get id() {
            throw new Error("the event object is broken");
        }
    });
    await settle();

    assert.match(h.logs.join("\n"), /imageChanged handler failed: the event object is broken/);
});

test("being told the frontmost document is the one we already have is a no-op", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    const before = h.ps.calls.documentInfo.length;

    h.ps.emit("currentDocumentChanged", 1);
    h.ps.emit("currentDocumentChanged", { id: 1 });
    await settle(30);

    assert.equal(h.ps.calls.documentInfo.length, before, "no resync was scheduled");
});

test("a save whose repair fails is a warning and nothing more", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    t.after(clearFaults);

    // repairAfterSave stamps the session id back into the document. Photoshop
    // refusing the script is worth a line; the debounced resync will try again.
    setFault("writeFileSync", () => {
        throw fsError("EACCES", "the document could not be stamped");
    });
    h.ps.emit("save", {});
    await settle(30);
    clearFaults();

    const state = await command(h, { type: "ping" });
    assert.equal(state.ok, true);
});

/* --------------------------------------------------------------- capture */

test("Photoshop's own encoder is used when the host offers one", async (t) => {
    const written = [];
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: {
            savePixmap: (pm, filePath) => {
                written.push(filePath);
                fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
                return Promise.resolve();
            }
        }
    });
    await settle();

    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);

    // A native binary in its own process is much cheaper than encoding here,
    // so it is tried first wherever it still works.
    assert.ok(written.length > 0, "savePixmap was used");
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.health.encoder, "native");
});

test("a canvas with nothing on it is noted once and then left alone", async (t) => {
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: { pixmap: () => Promise.resolve({ width: 0, height: 0, pixels: Buffer.alloc(0) }) }
    });
    await settle();

    for (let i = 0; i < 3; i++) {
        h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
        await settle(30);
    }

    // Not an error -- an empty document is a normal thing to have open -- but
    // worth one line, so "never asked" can be told from "nothing came back".
    const noted = h.logs.filter((line) => line.indexOf("empty pixmap") !== -1);
    assert.equal(noted.length, 1, "once per session, not once per frame");
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.session.frameCount, 0);
});

test("a manifest that cannot be written is a warning, and the frames keep coming", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    t.after(clearFaults);

    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);
    const sessionId = await h.sessionId();
    assert.ok((await command(h, { type: "ping" })).state.session.frameCount > 0, "precondition: recording");

    // session.json is a cache of what the folder already says; losing a write
    // of it costs accuracy in the panel, not the recording.
    setFault("writeFileSync", () => {
        throw fsError("ENOSPC", "the disk is full");
    });
    const flagged = await command(h, { type: "setArchived", sessionId, archived: true });
    clearFaults();

    assert.equal(flagged.ok, true, "the command still succeeded");
    assert.match(h.logs.join("\n"), /Could not update .*session\.json: .*the disk is full/);
});

/* ------------------------------------------------------------------ tick */

test("the heartbeat re-syncs the document and offers the panel a fresh state", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true }, captureTimers: true });
    await settle();
    const before = h.ps.calls.documentInfo.length;

    // Every fifth tick. It is what recovers from a Photoshop that stopped
    // answering, so it must happen whether or not anything else does.
    for (let i = 0; i < 5; i++) {
        h.tick();
    }
    await settle(20);

    assert.ok(h.ps.calls.documentInfo.length > before, "the document was asked about again");
});

test("a tick that throws is logged rather than killing the heartbeat", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true }, captureTimers: true });
    await settle();

    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);
    // Wait out the manifest flush the frame armed, so the next tick is the one
    // that has to arm a new timer -- which is where the failure lands.
    await new Promise((r) => setTimeout(r, 2200));

    // The tick is the plug-in's only recurring work: it counts drawing time,
    // retries session ids Photoshop would not take, and re-syncs the document.
    // An exception out of it that stopped the interval would freeze all three
    // for the rest of the Photoshop session.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => {
        throw new Error("no timers left");
    };
    try {
        h.tick();
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }

    assert.match(h.logs.join("\n"), /Tick failed: no timers left/);
    h.tick(); // and it still runs afterwards
});

/* ---------------------------------------------------------------- config */

test("pointing the frames folder somewhere else starts clean rather than splitting a recording", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    const first = (await command(h, { type: "ping" })).state.session.sessionId;

    const elsewhere = path.join(temp.dir, "other-frames");
    await command(h, { type: "setConfig", patch: { processImageFolderPath: elsewhere } });
    await settle(40);

    // Half a recording in each location would be worse than a new one.
    const state = await command(h, { type: "ping" });
    assert.ok(state.state.session, "a session under the new folder");
    assert.notEqual(state.state.session.sessionId, first);
    assert.ok(state.state.session.folder.indexOf(elsewhere) === 0, state.state.session.folder);
});

test("turning update checks on checks once, and turning them off clears the banner", async (t) => {
    const h = await startPlugin(t);

    // No network is reached: the checker's own fetch fails and that is a
    // non-event. What matters is that the switch is acted on immediately
    // rather than a day later.
    const on = await command(h, { type: "setConfig", patch: { checkForUpdates: true } });
    assert.equal(on.state.config.checkForUpdates, true);
    await settle(20);

    const off = await command(h, { type: "setConfig", patch: { checkForUpdates: false } });
    assert.equal(off.state.config.checkForUpdates, false);
    assert.equal(off.state.update, null, "the banner goes with the setting");
});

/* -------------------------------------------------------------- commands */

test("pause and resume are reflected in the state the panel reads back", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();

    const paused = await command(h, { type: "pause", reason: "Exporting" });
    assert.equal(paused.state.health.pausedReason, "Exporting");

    const resumed = await command(h, { type: "resume" });
    assert.equal(resumed.state.health.pausedReason, null);

    // A pause with nothing to say still says something, since the panel shows
    // this string next to a stopped recording.
    const bare = await command(h, { type: "pause" });
    assert.equal(bare.state.health.pausedReason, "Paused");
    await command(h, { type: "resume" });
});

test("a command the panel should never send is refused rather than ignored", async (t) => {
    const h = await startPlugin(t);
    const result = await command(h, { type: "somethingElse" });
    assert.deepEqual(result, { ok: false, error: "Unknown command" });
});

test("adopting a session attaches the open document to a recording it already had", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    const first = (await command(h, { type: "ping" })).state.session.sessionId;

    // Start a second recording for the same document, then go back to the
    // first -- which is what the panel's "resume this one" button does.
    const fresh = await command(h, { type: "newSession", documentId: 1 });
    assert.equal(fresh.ok, true);
    const second = fresh.state.session.sessionId;
    assert.notEqual(second, first);

    const adopted = await command(h, { type: "adoptSession", documentId: 1, sessionId: first });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.state.session.sessionId, first);
});

test("adopting or starting a session with no document open is refused", async (t) => {
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: { documentInfo: () => Promise.reject(new Error("no document")) }
    });
    await settle(30);

    assert.deepEqual(await command(h, { type: "adoptSession", documentId: 1, sessionId: "s" }), {
        ok: false,
        error: "No open document"
    });
    assert.deepEqual(await command(h, { type: "newSession", documentId: 1 }), {
        ok: false,
        error: "No open document"
    });
});

test("dismissing an update remembers the version rather than the click", async (t) => {
    const h = await startPlugin(t);
    const result = await command(h, { type: "dismissUpdate", version: "9.9.9" });

    // Remembering "dismissed" alone would silence the next release too.
    assert.equal(result.ok, true);
    assert.equal(result.state.config.dismissedUpdateVersion, "9.9.9");
});

test("checking for updates is refused while the user has opted out", async (t) => {
    const h = await startPlugin(t, { config: { checkForUpdates: false } });

    // A plug-in for drawing has no business reaching the network on its own,
    // and the button must not be a way round the setting.
    assert.deepEqual(await command(h, { type: "checkUpdate" }), {
        ok: false,
        error: "Update checks are switched off"
    });
});

test("checking for updates with the setting on reports what happened", async (t) => {
    const h = await startPlugin(t, { config: { checkForUpdates: true } });

    // There is no network here, so the check fails -- which is itself a
    // non-event the panel is told about rather than an error it must handle.
    const result = await command(h, { type: "checkUpdate" });
    assert.equal(result.ok, true);
    assert.ok(result.updateCheck);
    assert.ok(["newer", "current", "failed"].indexOf(result.updateCheck.outcome) !== -1);
});

/* ------------------------------------------------- a Photoshop that answers oddly */

test("an answer with no document id in it is not something to record against", async (t) => {
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: { documentInfo: () => Promise.resolve({ file: DOC_FILE, bounds: BOUNDS }) }
    });
    await settle(30);

    // Without an id there is nothing to ask for a pixmap of, and nothing to
    // key the session by. Detaching says so; carrying on would record the
    // previous document's canvas under this one's name.
    assert.match(h.logs.join("\n"), /answered a document-info request without a document id/);
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.document, null);
});

test("a document with no file yet is shown by the name Photoshop gives it", async (t) => {
    const h = await startPlugin(t, { photoshop: { file: "" } });
    await settle(30);

    // File > New, never saved. The panel needs something to put on the row.
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.document.name, "Untitled");
    assert.equal(state.state.document.filePath, null);
});

test("a pixmap that does not say what it covers is still recorded, and said so", async (t) => {
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: {
            pixmap: () => {
                const pm = pixmap(400, 300);
                delete pm.bounds;
                return Promise.resolve(pm);
            }
        }
    });
    await settle();

    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);

    // The geometry line is what a broken frame is diagnosed from, so it has to
    // read sensibly even when Photoshop volunteers nothing.
    assert.match(h.logs.join("\n"), /Capture geometry: .* with bounds none/);
    assert.ok((await command(h, { type: "ping" })).state.session.frameCount > 0);
});

/* ------------------------------------------------- captures that come too late */

test("recording switched off while Photoshop was rendering costs that frame", async (t) => {
    let release = null;
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: {
            pixmap: () => new Promise((resolve) => (release = () => resolve(pixmap(400, 300))))
        }
    });
    await settle();

    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(20);
    assert.ok(release, "precondition: a capture is waiting on Photoshop");

    // The artist hit the switch while the render was in flight. Writing the
    // frame now would put one more in a recording they have just stopped.
    await command(h, { type: "setConfig", patch: { enabled: false } });
    release();
    await settle(30);

    const folder = fs.readdirSync(path.join(h.appDir, "processImages"));
    const frames = folder.length
        ? fs.readdirSync(path.join(h.appDir, "processImages", folder[0])).filter((n) => n.endsWith(".jpg"))
        : [];
    assert.deepEqual(frames, [], "nothing was written after the switch");
});

test("a canvas resized while Photoshop was rendering makes the frame be retaken", async (t) => {
    let release = null;
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: {
            pixmap: () => new Promise((resolve) => (release = () => resolve(pixmap(400, 300))))
        }
    });
    await settle();

    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(20);
    assert.ok(release, "precondition: a capture is waiting on Photoshop");

    // Image Size landing mid-render. The pixmap covers only the painted area,
    // so it cannot say what the new canvas is; padding it against the old one
    // would strand the drawing in a corner of a frame that is in the video for
    // ever. One frame costs nothing.
    h.ps.setBounds({ top: 0, left: 0, right: 1600, bottom: 1200 });
    h.ps.emit("imageChanged", { id: 1, bounds: { top: 0, left: 0, right: 1600, bottom: 1200 } });
    release();
    await settle(40);

    assert.match(h.logs.join("\n"), /Canvas was resized mid-capture; retaking the frame/);
});

/* --------------------------------------------------------------- packing */

test("packing with nowhere to write the zips is refused", async (t) => {
    const h = await startPlugin(t);

    assert.deepEqual(await command(h, { type: "packSessions", sessionIds: [], folder: "", deleteAfter: false }), {
        ok: false,
        error: "No folder to write the zips into"
    });
});

test("packing into something that is not a folder is refused", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const h = await startPlugin(t);

    const file = path.join(temp.dir, "notes.txt");
    fs.writeFileSync(file, "not a folder");

    const result = await command(h, {
        type: "packSessions",
        sessionIds: [],
        folder: file,
        deleteAfter: false
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /is not a folder|Cannot write to/);
});

test("packing a recording that is no longer there is a warning, not a failure", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const h = await startPlugin(t);

    const result = await command(h, {
        type: "packSessions",
        sessionIds: ["20260101-gone"],
        folder: temp.dir,
        deleteAfter: false
    });
    assert.equal(result.ok, true, "the rest of a batch is not lost to one missing row");
    assert.deepEqual(result.warnings, ["20260101-gone: no longer exists"]);
});

test("a zip that cannot be written names the recording it belonged to", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);
    const sessionId = await h.sessionId();

    // Close the document so the recording is no longer in progress.
    h.ps.emit("imageChanged", { id: 1, closed: true });
    await settle(20);
    t.after(clearFaults);

    // The drive fills up part-way through. Packing returns before the zip is
    // written, so the only place this can be reported is the log -- which the
    // panel shows.
    setFault("createWriteStream", () => {
        throw fsError("ENOSPC", "the disk is full");
    });
    const result = await command(h, {
        type: "packSessions",
        sessionIds: [sessionId],
        folder: temp.dir,
        deleteAfter: false
    });
    assert.equal(result.ok, true, "queued; the failure arrives in the log");
    await settle(60);
    clearFaults();

    assert.match(h.logs.join("\n"), /Could not pack recording dragon: .*the disk is full/);
});

test("deleting nothing at all is not an error", async (t) => {
    const h = await startPlugin(t);
    const result = await command(h, { type: "deleteSessions", items: [] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
});

/* ----------------------------------------------------------------- moving */

test("a recording with no document on disk cannot be moved next to one", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true }, photoshop: { file: "" } });
    await settle(30);
    const sessionId = await h.sessionId();
    h.ps.emit("imageChanged", { id: 1, closed: true });
    await settle(20);

    assert.deepEqual(await command(h, { type: "moveSession", sessionId, destination: "document" }), {
        ok: false,
        error: "The document this recording belongs to is not on disk"
    });
});

test("moving a recording to where it already is changes nothing", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle(30);
    const sessionId = await h.sessionId();
    h.ps.emit("imageChanged", { id: 1, closed: true });
    await settle(20);

    // The panel's switch is a toggle, and a double click on it should not
    // start a move of a folder onto itself.
    const result = await command(h, { type: "moveSession", sessionId, destination: "root" });
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.sessions));
});

test("moving a recording that is no longer there says so", async (t) => {
    const h = await startPlugin(t);
    assert.deepEqual(await command(h, { type: "moveSession", sessionId: "20260101-gone", destination: "root" }), {
        ok: false,
        error: "Session '20260101-gone' no longer exists"
    });
});

test("archiving a recording that is no longer there says so", async (t) => {
    const h = await startPlugin(t);
    assert.deepEqual(await command(h, { type: "setArchived", sessionId: "20260101-gone", archived: true }), {
        ok: false,
        error: "Session '20260101-gone' no longer exists"
    });
});

/* ------------------------------------------------------------- start-up again */

test("a plug-in that cannot even read its config tells Photoshop it failed to load", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    // generator-core calls init() while loading plug-ins and treats a throw as
    // "plugin failed to load" with no further explanation, so the failure is
    // caught here and written where somebody can read it.
    setFault("mkdirSync", () => {
        throw fsError("EACCES", "the data directory cannot be created");
    });
    const logs = [];
    const handle = init(makePhotoshop().generator, {}, {
        info: () => {},
        warn: () => {},
        error: (m) => logs.push(m)
    });
    clearFaults();

    assert.equal(handle, undefined, "nothing to await and nothing to stop");
    assert.match(logs.join("\n"), /F_Record failed to initialise: .*the data directory cannot be created/);
});

test("options that are not options are ignored rather than trusted", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    // generator-core passes whatever is in the host's plug-in config; a
    // string, or nothing at all, must not stop the plug-in loading.
    const handle = init(makePhotoshop().generator, "not an object", null);
    assert.ok(handle);
    await handle.ready;
    t.after(() => handle.stop());
});

/* ------------------------------------------------ recordings that are busy */

/**
 * Makes the next zip take long enough to be caught in the act.
 *
 * `packing` is a state the panel polls and every other action refuses, and it
 * lasts exactly as long as writing a zip -- which for a two-frame recording is
 * no time at all unless the disk is made slow on purpose.
 */
function slowZip() {
    setFault("createWriteStream", () => {
        const sink = new Writable({
            write(chunk, encoding, callback) {
                setTimeout(callback, 40);
            }
        });
        return sink;
    });
}

/** A finished recording with a real document beside it, ready to be acted on. */
async function recordedAndClosed(t, h) {
    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);
    const sessionId = await h.sessionId();
    h.ps.emit("imageChanged", { id: 1, closed: true });
    await settle(20);
    return sessionId;
}

test("a recording being packed is off limits to everything else meanwhile", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    const sessionId = await recordedAndClosed(t, h);

    slowZip();
    const queued = await command(h, {
        type: "packSessions",
        sessionIds: [sessionId],
        folder: temp.dir,
        deleteAfter: false
    });
    assert.equal(queued.ok, true);

    // Everything that would touch the folder has to wait for the zip: reading
    // it while it is being read is fine, but deleting or moving it out from
    // under the writer is not.
    const busy = "This recording is being packed; try again once its zip is written";
    assert.deepEqual(await command(h, { type: "setArchived", sessionId, archived: true }), { ok: false, error: busy });
    assert.deepEqual(await command(h, { type: "moveSession", sessionId, destination: "document" }), {
        ok: false,
        error: busy
    });
    assert.deepEqual(await command(h, { type: "deleteSession", sessionId }), { ok: false, error: busy });

    const again = await command(h, {
        type: "packSessions",
        sessionIds: [sessionId],
        folder: temp.dir,
        deleteAfter: false
    });
    assert.deepEqual(again.warnings, ["dragon: " + busy]);

    const bulk = await command(h, { type: "setArchivedMany", sessionIds: [sessionId], archived: true });
    assert.deepEqual(bulk.warnings, ["dragon: " + busy]);

    await settle(80);
    clearFaults();
});

/**
 * Makes the next move take long enough to be caught in the act.
 *
 * The frames folder defaults to C: and artwork tends to live anywhere else, so
 * a move across volumes is the common case -- and it is the slow one, copying
 * a file at a time and handing the event loop back as it goes. Reported here
 * rather than actually performed: a real one big enough to be slow would mean
 * writing a few thousand files per test.
 */
function slowMove(from) {
    const names = [];
    for (let i = 1; i <= 6000; i++) {
        names.push(String(i).padStart(6, "0") + "_170000000" + (1000 + i) + ".jpg");
    }
    setFault("renameSync", (source, dest) => {
        if (source === from) {
            throw fsError("EXDEV", "cross-device link not permitted");
        }
        return fs.renameSync(source, dest);
    });
    setFault("readdirSync", (target, ...rest) => (target === from ? names : fs.readdirSync(target, ...rest)));
    setFault("copyFileSync", () => {});
}

test("a recording already on the move is not moved twice", async (t) => {
    const art = tempDir();
    t.after(() => art.cleanup());
    t.after(clearFaults);
    const document = path.join(art.dir, "dragon.psd");
    fs.writeFileSync(document, "psd");

    const h = await startPlugin(t, { config: { enabled: true }, photoshop: { file: document } });
    await settle();
    const sessionId = await recordedAndClosed(t, h);
    const from = path.join(h.appDir, "processImages", sessionId);

    slowMove(from);
    const started = await command(h, { type: "moveSession", sessionId, destination: "document" });
    assert.equal(started.ok, true);

    // Two clicks on the switch button, or the panel polling and re-sending.
    assert.deepEqual(await command(h, { type: "moveSession", sessionId, destination: "document" }), {
        ok: false,
        error: "This recording is already being moved"
    });

    const busy = "This recording is being moved; try again once it has arrived";
    assert.deepEqual(await command(h, { type: "setArchived", sessionId, archived: true }), { ok: false, error: busy });

    await settle(200);
    clearFaults();
});

test("a move that fails names the recording and where it was going", async (t) => {
    const art = tempDir();
    t.after(() => art.cleanup());
    t.after(clearFaults);
    const document = path.join(art.dir, "dragon.psd");
    fs.writeFileSync(document, "psd");

    const h = await startPlugin(t, { config: { enabled: true }, photoshop: { file: document } });
    await settle();
    const sessionId = await recordedAndClosed(t, h);

    // The folder beside the document cannot be created.
    setFault("renameSync", () => {
        throw fsError("EPERM", "the destination is not writable");
    });
    const started = await command(h, { type: "moveSession", sessionId, destination: "document" });
    clearFaults();
    assert.equal(started.ok, true, "returned before the move was done, as it always does");

    await settle(60);
    assert.match(h.logs.join("\n"), /Could not move recording .*: .*the destination is not writable/);
});

/* ------------------------------------------- deleting the take in progress */

test("deleting the recording in progress replaces it with a fresh one", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);
    const sessionId = await h.sessionId();

    // Nobody deletes the take they are in the middle of except to start it
    // over, so that is one action rather than a delete to recover from.
    const result = await command(h, { type: "deleteSession", sessionId });
    assert.equal(result.ok, true);
    assert.ok(result.state.session, "a new session is open");
    assert.notEqual(result.state.session.sessionId, sessionId);
    assert.equal(fs.existsSync(path.join(h.appDir, "processImages", sessionId)), false);
});

test("deleting the take in progress with recording off leaves nothing behind", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);
    const sessionId = await h.sessionId();

    await command(h, { type: "setConfig", patch: { enabled: false } });
    const result = await command(h, { type: "deleteSession", sessionId });

    // With the switch off there is no folder to open in its place, so the
    // panel has to stop showing a recording for this document.
    assert.equal(result.ok, true);
    assert.equal(result.state.session, null);
});

test("a delete that the filesystem refuses is reported rather than claimed", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);
    const sessionId = await h.sessionId();
    t.after(clearFaults);

    // Windows holding a handle on the folder. The session is detached either
    // way, so the panel must be told what really happened rather than shown a
    // delete that did not take.
    setFault("rmSync", () => {
        throw "the folder is in use";
    });
    const result = await command(h, { type: "deleteSession", sessionId });
    clearFaults();

    assert.equal(result.ok, false);
    assert.equal(result.error, "the folder is in use", "even a failure that is not an Error");
});

/* ------------------------------------------------------- Save As, forked */

test("a fork that fails leaves the document on the recording it already had", async (t) => {
    const art = tempDir();
    t.after(() => art.cleanup());
    t.after(clearFaults);
    const document = path.join(art.dir, "dragon.psd");
    fs.writeFileSync(document, "psd");

    const h = await startPlugin(t, { config: { enabled: true }, photoshop: { file: document } });
    await settle();
    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);
    const before = await h.sessionId();

    // Save As, with the duplicate refused by the disk. Both files then claim
    // the one recording, which the resolver catches later -- a worse outcome
    // than forking, but not a broken one, and better than losing the take.
    const copy = path.join(art.dir, "dragon-copy.psd");
    fs.writeFileSync(copy, "psd");
    setFault("writeFileSync", () => {
        throw fsError("ENOSPC", "the disk is full");
    });
    h.ps.setFile(copy);
    h.ps.emit("imageChanged", { id: 1, file: copy });
    await settle(80);
    clearFaults();

    assert.match(h.logs.join("\n"), /Could not fork the recording after Save As: /);
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.session.sessionId, before, "still the recording it had");
});

/* -------------------------------------------------- Photoshop stops answering */

test("a session id Photoshop would not take is repaired when it answers again", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    const sessionId = await h.sessionId();

    // Photoshop clears generatorSettings on Save As and will not always take
    // the stamp back straight away. Losing it would orphan the folder; the
    // recording continues and the id goes back in when it can.
    h.ps.settings.delete(1);
    h.ps.emit("imageChanged", { id: 1, generatorSettings: null });
    await settle(60);

    const state = await command(h, { type: "ping" });
    assert.equal(state.state.session.sessionId, sessionId, "the same take, still going");
});

/* ------------------------------------- when Photoshop stops answering at all */

test("a menu toggle that cannot be applied is reported", async (t) => {
    const h = await startPlugin(t);
    const menuId = h.ps.calls.menu[0].id;
    t.after(clearFaults);

    // The menu item is a second switch for the same setting, and it goes
    // through the same code the panel does. A failure there has nowhere else
    // to be reported: there is no dialog to put it in.
    setFault("writeFileSync", () => {
        throw fsError("EACCES", "config.json is read-only");
    });
    h.ps.emit("generatorMenuChanged", { generatorMenuChanged: { name: menuId } });
    await settle(40);
    clearFaults();

    assert.match(h.logs.join("\n"), /Menu toggle failed: .*config\.json is read-only/);
});

/* ------------------------------------------------ a canvas with no size at all */

test("a document Photoshop reports no canvas for is not captured against", async (t) => {
    const h = await startPlugin(t, {
        config: { enabled: true, minCanvasPixels: 0 },
        photoshop: { documentInfo: () => Promise.resolve({ id: 1 }) }
    });
    await settle(30);

    // No bounds, no file, no resolution. There is nothing to ask for a pixmap
    // of, and padding a frame against a canvas we cannot describe would be
    // guesswork; the stroke is simply not recorded.
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.document.bounds, null);
    assert.equal(state.state.document.filePath, null);

    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);
    assert.equal((await command(h, { type: "ping" })).state.session.frameCount, 0);
});

/* ------------------------------------------- a folder that moves under a capture */

test("a recording whose folder is in transit is not written into, and is repointed after", async (t) => {
    const art = tempDir();
    t.after(() => art.cleanup());
    t.after(clearFaults);
    const document = path.join(art.dir, "dragon.psd");
    fs.writeFileSync(document, "psd");

    const h = await startPlugin(t, { config: { enabled: true }, photoshop: { file: document } });
    await settle();
    const sessionId = await recordedAndClosed(t, h);
    const from = path.join(h.appDir, "processImages", sessionId);
    const framesBefore = fs.readdirSync(from).filter((n) => n.endsWith(".jpg")).length;

    slowMove(from);
    assert.equal((await command(h, { type: "moveSession", sessionId, destination: "document" })).ok, true);

    // The artist opens the document again while its folder is half-copied. A
    // frame written now would land in whichever of the two locations the
    // timing chose.
    h.ps.emit("currentDocumentChanged", { id: 1 });
    await settle(30);
    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(30);
    assert.equal(
        fs.readdirSync(from).filter((n) => n.endsWith(".jpg")).length,
        framesBefore,
        "nothing was written into a folder that is on its way somewhere else"
    );

    // And once it has arrived, the live session follows it rather than staying
    // pointed at an address that no longer holds anything -- a capture into the
    // old address would write into a folder nothing lists any more.
    const deadline = Date.now() + 20000;
    let arrived = null;
    while (Date.now() < deadline) {
        const state = await command(h, { type: "ping" });
        if (state.state.session && state.state.session.folder !== from) {
            arrived = state.state.session.folder;
            break;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    clearFaults();

    assert.ok(arrived, "the move finished and the session followed it");
    assert.match(arrived, /dragon_frames/);
    assert.match(h.logs.join("\n"), /Moved session .* to '.*dragon_frames'/);
});

/* ------------------------------------------------------- packing, once more */

test("packing into a path that is not a folder is refused after the attempt to make one", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);
    const h = await startPlugin(t);

    const file = path.join(temp.dir, "notes.txt");
    fs.writeFileSync(file, "not a folder");

    // mkdirp is happy -- some filesystems say yes to creating what is already
    // there -- and the check after it is what catches a file in the way.
    setFault("mkdirSync", () => undefined);
    const result = await command(h, {
        type: "packSessions",
        sessionIds: [],
        folder: file,
        deleteAfter: false
    });
    clearFaults();

    assert.deepEqual(result, { ok: false, error: "'" + file + "' is not a folder" });
});

test("a document the bin will not take keeps its recording, and says so after packing", async (t) => {
    const art = tempDir();
    t.after(() => art.cleanup());
    const zips = tempDir();
    t.after(() => zips.cleanup());
    const document = path.join(art.dir, "dragon.psd");
    fs.writeFileSync(document, "psd");

    // A bin that refuses everything: what Windows does when the document is
    // open in another application.
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: { file: document },
        pluginOptions: {
            trash: (files) => Promise.resolve({ failed: files.map((file) => ({ file, error: "in use" })) })
        }
    });
    await settle();
    const sessionId = await recordedAndClosed(t, h);

    const result = await command(h, {
        type: "packSessions",
        sessionIds: [sessionId],
        folder: zips.dir,
        deleteAfter: true
    });
    assert.equal(result.ok, true);
    await settle(80);

    // The zip is written and the recording stays, because the document it
    // belongs to could not go with it.
    assert.ok(fs.readdirSync(zips.dir).some((name) => name.endsWith(".zip")));
    assert.match(h.logs.join("\n"), /After packing: .*could not be sent to the Recycle Bin \(in use\)/);
    assert.equal(fs.existsSync(document), true);
});

/* -------------------------------------------- commands with nothing much in them */

test("commands with fields the panel left out are treated as empty, not as errors", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true } });
    await settle();
    const sessionId = await h.sessionId();

    // A panel one version behind, or a hand-made request. None of these may
    // throw out of the bridge, which would leave the request unanswered.
    assert.equal((await command(h, { type: "setConfig" })).ok, true);
    assert.equal((await command(h, { type: "setArchivedMany", archived: true })).ok, true);
    assert.equal((await command(h, { type: "deleteSessions" })).ok, true);
    assert.equal((await command(h, { type: "packSessions", folder: h.appDir, deleteAfter: false })).ok, true);

    // And unarchiving, which is the other half of the archive flag.
    h.ps.emit("imageChanged", { id: 1, closed: true });
    await settle(20);
    assert.equal((await command(h, { type: "setArchived", sessionId, archived: true })).ok, true);
    assert.equal((await command(h, { type: "setArchived", sessionId, archived: false })).ok, true);
    assert.match(h.logs.join("\n"), /Unarchived session /);
});

test("a document whose path is nothing but a separator still has a name", async (t) => {
    const h = await startPlugin(t, { photoshop: { file: "/" } });
    await settle(30);

    // Nothing sensible to shorten it to, so the whole of it is the name --
    // which beats an empty row in the panel.
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.document.name, "/");
});
test("a session prepared for a document the artist has left is not installed onto the new one", async (t) => {
    let slowStamp = false;
    let deaf = false;
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: {
            // Photoshop stops answering the moment the command goes out, so
            // nothing puts the old document back while the test is watching.
            documentInfo: () =>
                deaf
                    ? new Promise(() => {})
                    : Promise.resolve({ id: 1, file: DOC_FILE, bounds: BOUNDS, resolution: 72 }),
            evaluateJSXString: () =>
                slowStamp
                    ? new Promise((resolve) => setTimeout(() => resolve(undefined), 300))
                    : Promise.resolve(undefined)
        }
    });
    await settle(30);
    const before = await h.sessionId();

    // Every way of producing a session awaits Photoshop -- a settings read, a
    // stamp -- and the artist can move to another document in the meantime.
    // The session then belongs to the document they left; installing it here
    // would record whatever is in front now into that document's folder.
    slowStamp = true;
    deaf = true;
    const started = command(h, { type: "newSession", documentId: 1 });
    await new Promise((r) => setTimeout(r, 60));
    h.ps.emit("currentDocumentChanged", { id: 7 });
    const result = await started;

    assert.equal(result.ok, true);
    assert.match(h.logs.join("\n"), /was being prepared for it; syncing the new one/);
    assert.equal(result.state.session.sessionId, before, "the take in progress was left alone");
});

test("captures Photoshop never answers pause recording, and answering again lifts the pause", async (t) => {
    let hang = false;
    const pending = [];
    const h = await startPlugin(t, {
        config: { enabled: true, minIntervalMs: 200 },
        pluginOptions: { syncStallMs: 10 },
        photoshop: {
            pixmap: () => Promise.reject(new Error("Photoshop is not responding")),
            documentInfo: () =>
                hang
                    ? new Promise((resolve) => pending.push(resolve))
                    : Promise.resolve({ id: 1, file: DOC_FILE, bounds: BOUNDS, resolution: 72 })
        }
    });
    await settle(30);

    // Photoshop has been seen to stop answering for 89 minutes at a stretch
    // while still delivering events. Five capture failures in a row stop the
    // scheduler rather than letting it spin, and say so where the panel can
    // show it -- freezing silently is the 3.x behaviour this replaced.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
        await new Promise((r) => setTimeout(r, 100));
        if ((await command(h, { type: "ping" })).state.health.pausedReason) {
            break;
        }
    }
    const paused = await command(h, { type: "ping" });
    assert.match(paused.state.health.pausedReason || "", /consecutive capture failures/);
    assert.match(h.logs.join("\n"), /error: Recording paused after \d+ consecutive capture failures/);

    // Now the same silence swallows a document-info request, and a second one
    // is sent past it. When Photoshop comes back, the pause it caused goes
    // with it: leaving the artist a resume button to press over a fault that
    // has already cleared would be its own bug.
    hang = true;
    h.ps.emit("currentDocumentChanged", { id: 2 });
    await settle(20);
    h.ps.emit("currentDocumentChanged", { id: 1 });
    await settle(20);
    assert.match(h.logs.join("\n"), /has not answered a document-info request for \d+s; asking again/);

    hang = false;
    pending.forEach((resolve) => resolve({ id: 1, file: DOC_FILE, bounds: BOUNDS, resolution: 72 }));
    await settle(60);

    assert.match(h.logs.join("\n"), /Photoshop is answering again after \d+s; recording resumes/);
    assert.match(h.logs.join("\n"), /Lifting the pause that the unanswered captures caused/);
    assert.equal((await command(h, { type: "ping" })).state.health.pausedReason, null);
});

test("an answer Photoshop finally gives to a request we gave up on is dropped", async (t) => {
    let hang = false;
    const pending = [];
    let answerWith = { id: 1, file: DOC_FILE, bounds: BOUNDS, resolution: 72 };
    const h = await startPlugin(t, {
        pluginOptions: { syncStallMs: 10 },
        photoshop: {
            documentInfo: () =>
                hang ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(answerWith)
        }
    });
    await settle(30);

    // A request sent just before a large Save As is answered only once the
    // file is on disk, tens of seconds later. Waiting for it would mean
    // recording nothing meanwhile, so a fresh one is sent past it and the old
    // answer is left to fall on the floor.
    hang = true;
    h.ps.emit("currentDocumentChanged", { id: 2 });
    await new Promise((r) => setTimeout(r, 300));
    h.ps.emit("currentDocumentChanged", { id: 3 });
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(pending.length >= 2, "two requests are outstanding, got " + pending.length);
    assert.match(h.logs.join("\n"), /has not answered a document-info request for \d+s; asking again/);

    // Both answer at once, the abandoned one first. Whatever it would have
    // said, the newer one says too and more recently, so only the newest may
    // apply anything -- applying the older one is what used to point recording
    // back at a document the artist had already left.
    hang = false;
    pending[0]({ id: 42, file: DOC_FILE, bounds: BOUNDS, resolution: 72 });
    pending.slice(1).forEach((resolve) => resolve({ id: 7, file: DOC_FILE, bounds: BOUNDS, resolution: 72 }));
    answerWith = { id: 7, file: DOC_FILE, bounds: BOUNDS, resolution: 72 };
    await settle(60);

    assert.equal((await command(h, { type: "ping" })).state.document.id, 7, "not the answer we gave up on");
});

/* ------------------------------------------- a recording from before all this */

/** Writes a session folder by hand, as one left by an earlier run looks. */
function seedSession(env, sessionId, manifest) {
    const folder = path.join(env.dir, "F_Record", "processImages", sessionId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
        path.join(folder, "session.json"),
        JSON.stringify({
            version: 4,
            sessionId,
            docName: "dragon",
            canvasBounds: null,
            frameCount: 0,
            timeSpentSec: 0,
            createdAt: 0,
            lastModifiedAt: 0,
            format: "jpg",
            resolution: "1080",
            nextSeq: 1,
            ...manifest
        })
    );
    return folder;
}

test("a recording that has never had a frame in it is resumed with no last frame", async (t) => {
    const OLD = "2026-01-01-00-00-00-000-abcdef01";
    const h = await startPlugin(t, {
        config: { enabled: true },
        before: (env) => seedSession(env, OLD),
        photoshop: { storedSessionId: OLD }
    });
    await settle(40);

    // The folder was made and then nothing was drawn -- the switch was off, or
    // Photoshop was closed straight after. "Last frame: never" is the honest
    // answer; a zero rendered as a date would read as 1970.
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.session.sessionId, OLD, "picked up where it left off");
    assert.equal(state.state.session.lastFrameAt, null);
});

test("a recording that never knew its document cannot be moved next to one", async (t) => {
    const OLD = "2026-01-01-00-00-00-000-abcdef02";
    const h = await startPlugin(t, {
        before: (env) => seedSession(env, OLD),
        photoshop: { storedSessionId: OLD }
    });
    await settle(40);
    h.ps.emit("imageChanged", { id: 1, closed: true });
    await settle(20);

    // 4.0 wrote no filePathHistory at all. Reading one has to give an empty
    // list rather than undefined, which the search for the newest existing
    // path would iterate straight off the end of.
    assert.deepEqual(await command(h, { type: "moveSession", sessionId: OLD, destination: "document" }), {
        ok: false,
        error: "The document this recording belongs to is not on disk"
    });
});

test("a Save As out of a recording with no frames yet forks it just the same", async (t) => {
    const art = tempDir();
    t.after(() => art.cleanup());
    const document = path.join(art.dir, "dragon.psd");
    const copy = path.join(art.dir, "dragon-copy.psd");
    fs.writeFileSync(document, "psd");
    fs.writeFileSync(copy, "psd");

    const OLD = "2026-01-01-00-00-00-000-abcdef03";
    const h = await startPlugin(t, {
        config: { enabled: true },
        before: (env) => seedSession(env, OLD, { filePathHistory: [document] }),
        photoshop: { file: document, storedSessionId: OLD }
    });
    await settle(40);
    assert.equal((await command(h, { type: "ping" })).state.session.sessionId, OLD);

    // The file left behind is a complete work in its own right even with an
    // empty recording attached, so the copy still gets its own folder.
    h.ps.setFile(copy);
    h.ps.emit("imageChanged", { id: 1, file: copy });
    await settle(80);

    const state = await command(h, { type: "ping" });
    assert.notEqual(state.state.session.sessionId, OLD, "the copy records into its own folder");
    assert.equal(state.state.session.frameCount, 0, "and inherits a recording with nothing in it");
});

test("a resize Photoshop has reported but we have not read yet stops the frame", async (t) => {
    let bounds = BOUNDS;
    let slowInfo = false;
    const h = await startPlugin(t, {
        config: { enabled: true, minIntervalMs: 200 },
        photoshop: {
            documentInfo: () => {
                const answer = { id: 1, file: DOC_FILE, bounds, resolution: 72 };
                return slowInfo
                    ? new Promise((resolve) => setTimeout(() => resolve(answer), 400))
                    : Promise.resolve(answer);
            }
        }
    });
    await settle(30);

    // Photoshop says the canvas changed, and reading the new size takes a
    // while. Until it is in, `docBounds` describes a canvas that no longer
    // exists and a frame padded against it would strand the drawing in the
    // corner of a picture the old size -- which is in the video for ever.
    slowInfo = true;
    bounds = { top: 0, left: 0, right: 1600, bottom: 1200 };
    h.ps.emit("imageChanged", { id: 1, bounds });
    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(h.ps.calls.pixmap, [], "nothing was asked for against the canvas as it was");

    // The change is re-armed rather than dropped, so the frame is taken once
    // the new size is known.
    const deadline = Date.now() + 8000;
    while (h.ps.calls.pixmap.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(h.ps.calls.pixmap.length > 0, "the stroke was not lost");
    assert.deepEqual(h.ps.calls.pixmap[0].options.inputRect, bounds, "and against the canvas as it now is");
});

test("a document that has been deleted since it was recorded cannot be moved beside", async (t) => {
    const GONE = "2026-01-01-00-00-00-000-abcdef05";
    const h = await startPlugin(t, {
        before: (env) =>
            seedSession(env, GONE, { filePathHistory: [path.join(env.dir, "never", "there.psd")] })
    });
    await settle(30);

    // The recording remembers where its document was; the artist has since
    // deleted or moved it. There is nowhere to carry the folder to, and
    // creating a folder beside a file that is not there would be worse.
    assert.deepEqual(await command(h, { type: "moveSession", sessionId: GONE, destination: "document" }), {
        ok: false,
        error: "The document this recording belongs to is not on disk"
    });
});

test("a folder with no session.json left cannot be moved next to a document", async (t) => {
    const ORPHAN = "2026-01-01-00-00-00-000-abcdef04";
    const h = await startPlugin(t, {
        before: (env) => {
            const folder = path.join(env.dir, "F_Record", "processImages", ORPHAN);
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(path.join(folder, "000001_1700000001000.jpg"), "frame");
        }
    });
    await settle(30);

    // session.json can be lost to a crash mid-write while the frames survive.
    // There is then nothing that says which document it belonged to, so there
    // is nowhere to carry it to -- but it is still a recording, and saying so
    // beats a stack trace.
    assert.deepEqual(await command(h, { type: "moveSession", sessionId: ORPHAN, destination: "document" }), {
        ok: false,
        error: "The document this recording belongs to is not on disk"
    });
    assert.deepEqual(
        (await command(h, { type: "moveSession", sessionId: ORPHAN, destination: "root" })).ok,
        true,
        "and it is already at home, so moving it there is a no-op"
    );
});

/* -------------------------------------------------------------- updates */

test("an update that is found reaches the panel, and dismissing it is remembered", async (t) => {
    const h = await startPlugin(t, { config: { checkForUpdates: true } });
    t.after(clearFaults);

    // GitHub, answered without a packet leaving the machine.
    const release = JSON.stringify({
        tag_name: "v99.0.0",
        html_url: "https://github.com/lxapgjryzc/F_Record/releases/tag/v99.0.0",
        published_at: "2026-03-01T10:00:00Z"
    });
    setFault("get", (url, options, onResponse) => {
        const response = {
            statusCode: 200,
            resume() {},
            setEncoding() {},
            on(event, fn) {
                if (event === "data") {
                    setImmediate(() => fn(release));
                } else if (event === "end") {
                    setImmediate(() => setImmediate(fn));
                }
                return response;
            },
            destroy() {}
        };
        setImmediate(() => onResponse(response));
        return { on: () => {}, setTimeout: () => {}, destroy: () => {} };
    });

    const found = await command(h, { type: "checkUpdate" });
    clearFaults();

    assert.deepEqual(found.updateCheck, { outcome: "newer" });
    assert.equal(found.state.update.latestVersion, "99.0.0");
    assert.equal(found.state.update.dismissed, false);

    // Dismissing is by version, so the next release still gets a banner.
    const dismissed = await command(h, { type: "dismissUpdate", version: "99.0.0" });
    assert.equal(dismissed.state.update.dismissed, true);

    const other = await command(h, { type: "dismissUpdate", version: "98.0.0" });
    assert.equal(other.state.update.dismissed, false, "a different version is not silenced");
});

/* ------------------------------------------------------------- encoders */

test("a host whose own encoder is broken says so once and keeps recording", async (t) => {
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: {
            // Photoshop 2026's bundled convert.exe cannot be launched on its
            // own any more, so savePixmap fails the moment its stdin is
            // written. Every frame from then on goes through the built-in
            // encoder instead -- slower, but nothing is lost.
            savePixmap: () => Promise.reject(new Error("STATUS_DLL_NOT_FOUND"))
        }
    });
    await settle();

    h.ps.emit("imageChanged", { id: 1, layers: [{ id: 2, pixels: true }] });
    await settle(40);

    assert.match(h.logs.join("\n"), /info: Photoshop's own image encoder is unavailable/);
    assert.match(h.logs.join("\n"), /STATUS_DLL_NOT_FOUND/);
    const state = await command(h, { type: "ping" });
    assert.equal(state.state.health.encoder, "js");
    assert.ok(state.state.session.frameCount > 0, "the frame that discovered it was still written");
});

/* ------------------------------------------------------- the heartbeat again */

test("a heartbeat whose sync fails does not become an unhandled rejection", async (t) => {
    const h = await startPlugin(t, { config: { enabled: true }, captureTimers: true });
    await settle(30);
    t.after(clearFaults);

    // The tick has nowhere to put a rejected promise; one escaping it takes
    // the whole generator down on some of the Node versions Photoshop ships.
    const unhandled = [];
    const watch = (e) => unhandled.push(e);
    process.on("unhandledRejection", watch);
    try {
        setFault("writeFileSync", () => {
            throw fsError("ENOSPC", "the disk is full");
        });
        h.ps.emit("currentDocumentChanged", { id: 5 });
        for (let i = 0; i < 5; i++) {
            h.tick();
        }
        await new Promise((r) => setTimeout(r, 300));
        clearFaults();
    } finally {
        process.off("unhandledRejection", watch);
    }

    assert.deepEqual(unhandled, []);
});

/* ------------------------------------------------------------- adopting */

test("a recording claimed by a document that is no longer open can be adopted", async (t) => {
    let openDocuments = true;
    const h = await startPlugin(t, {
        config: { enabled: true },
        photoshop: {
            documentInfo: (documentId) =>
                openDocuments || documentId === undefined || documentId === 2
                    ? Promise.resolve({ id: documentId === undefined ? 1 : documentId, file: DOC_FILE, bounds: BOUNDS, resolution: 72 })
                    : Promise.reject(new Error("no such document"))
        }
    });
    await settle(30);
    const first = await h.sessionId();

    // The artist moves to a second document, then asks it to take over the
    // first one's recording. Two documents may not record into one folder, so
    // the resolver asks whether the first is still open -- and Photoshop
    // refusing to describe it is the answer "no".
    h.ps.emit("currentDocumentChanged", { id: 2 });
    await settle(40);
    openDocuments = false;

    const adopted = await command(h, { type: "adoptSession", documentId: 2, sessionId: first });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.state.session.sessionId, first);
});
