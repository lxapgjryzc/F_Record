/**
 * Session identity: the "Save As" fix.
 *
 * Photoshop clears a document's generatorSettings when it is saved under a new
 * name. 3.x kept the recording's identity only there, so a Save As mid-drawing
 * orphaned the recording and silently started a second folder. The scenarios
 * below are the ones that actually happen to people:
 *
 *   - Save As while recording          (PSD copy wiped, run still alive)
 *   - close and reopen the document    (PSD copy intact)
 *   - restart Photoshop, then reopen   (only the on-disk index survives)
 *   - a brand new document of the same size as an old recording
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { SessionResolver } from "../dist/test/session.mjs";
import { SessionIndex } from "../dist/test/store.mjs";
import { tempDir } from "./helpers.mjs";

const BOUNDS = { top: 0, left: 0, right: 2000, bottom: 1500 };

/** Stand-in for Photoshop's generatorSettings storage. */
function makePhotoshop() {
    const stored = new Map();
    let active = null;
    return {
        setActive(id) {
            active = id;
        },
        /** What Photoshop does to a document on Save As. */
        wipeSettings(id) {
            stored.delete(id);
        },
        peek(id) {
            return stored.get(id);
        },
        gateway: {
            async getDocumentSettings(documentId) {
                const value = stored.get(documentId);
                if (value === undefined) {
                    // generator-core throws rather than returning {} when a
                    // document has no generatorSettings at all.
                    throw new Error("no generatorSettings");
                }
                return value;
            },
            async setActiveDocumentSettings(settings) {
                if (active === null) {
                    throw new Error("no active document");
                }
                stored.set(active, settings);
            },
            getActiveDocumentId() {
                return active;
            }
        }
    };
}

function setup(runId = "run-1") {
    const temp = tempDir();
    const processImageFolderPath = path.join(temp.dir, "processImages");
    fs.mkdirSync(processImageFolderPath, { recursive: true });
    const config = {
        enabled: true,
        autoStart: false,
        autoStartNewDocuments: true,
        processImageFolderPath,
        resolution: "1080",
        quality: 70,
        idleTimeoutMinutes: 1,
        minIntervalMs: 1500,
        minCanvasPixels: 0,
        language: "cn",
        format: "jpg"
    };
    const ps = makePhotoshop();
    const index = new SessionIndex(runId);
    const logs = [];
    const resolver = new SessionResolver(ps.gateway, index, (level, message) =>
        logs.push(level + ": " + message)
    );
    return { temp, config, ps, index, resolver, logs };
}

/** Simulates frames landing on disk, so a session looks genuinely used. */
function writeFrames(config, sessionId, count) {
    const folder = path.join(config.processImageFolderPath, sessionId);
    fs.mkdirSync(folder, { recursive: true });
    for (let i = 1; i <= count; i++) {
        const name = String(i).padStart(6, "0") + "_" + (1700000000000 + i * 1000) + ".jpg";
        fs.writeFileSync(path.join(folder, name), "x");
    }
}

test("a new document starts a session and stamps it into the PSD", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const outcome = await s.resolver.resolve({ id: 1, file: "Untitled-1", bounds: BOUNDS }, s.config, true);

    assert.ok(outcome.session, "a session is created");
    assert.equal(outcome.session.isNew, true);
    assert.equal(s.ps.peek(1).sessionId, outcome.session.sessionId, "written into the document");
    assert.ok(fs.existsSync(path.join(outcome.session.folder, "session.json")), "manifest sits inside the folder");
});

test("Save As wipes the PSD copy; the session is recovered and re-stamped", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "Untitled-1", bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;
    writeFrames(s.config, sessionId, 12);

    // The artist hits File > Save As halfway through. Photoshop drops the
    // settings and the document acquires a real path.
    s.ps.wipeSettings(1);
    assert.equal(s.ps.peek(1), undefined, "precondition: Photoshop really cleared it");

    const after = await s.resolver.resolve(
        { id: 1, file: "C:\\art\\dragon.psd", bounds: BOUNDS },
        s.config,
        true
    );

    assert.equal(after.session.sessionId, sessionId, "recording continues in the same session");
    assert.equal(after.session.isNew, false, "no second folder is started");
    assert.equal(after.session.restamped, true, "the PSD copy is written back");
    assert.equal(s.ps.peek(1).sessionId, sessionId, "and it really is back in the document");
    assert.deepEqual(
        after.session.manifest.filePathHistory,
        ["C:\\art\\dragon.psd"],
        "the new path is recorded"
    );
    assert.equal(after.session.manifest.frameCount, 12, "frame count comes from the files on disk");
});

test("a second Save As under yet another name still continues the same session", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "Untitled-1", bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;

    s.ps.wipeSettings(1);
    await s.resolver.resolve({ id: 1, file: "C:\\art\\v1.psd", bounds: BOUNDS }, s.config, true);
    s.ps.wipeSettings(1);
    const third = await s.resolver.resolve({ id: 1, file: "C:\\art\\v2.psd", bounds: BOUNDS }, s.config, true);

    assert.equal(third.session.sessionId, sessionId);
    assert.deepEqual(third.session.manifest.filePathHistory, ["C:\\art\\v1.psd", "C:\\art\\v2.psd"]);
});

test("closing and reopening a document resumes via the PSD copy", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\a.psd", bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;
    writeFrames(s.config, sessionId, 5);

    // Reopening gives the document a new id, but its settings travelled with
    // the file.
    s.resolver.forgetDocument(1);
    s.ps.setActive(7);
    const settings = s.ps.peek(1);
    s.ps.gateway.setActiveDocumentSettings(settings);

    const again = await s.resolver.resolve({ id: 7, file: "C:\\art\\a.psd", bounds: BOUNDS }, s.config, true);
    assert.equal(again.session.sessionId, sessionId);
    assert.equal(again.session.isNew, false);
    assert.equal(again.session.manifest.frameCount, 5);
});

test("after a Photoshop restart, the file path in the on-disk index recovers the session", async (t) => {
    const s = setup("run-1");
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\b.psd", bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;
    writeFrames(s.config, sessionId, 9);

    // New Photoshop run: new document ids, empty in-memory map, and the PSD's
    // own copy is gone too (say it was flattened and re-saved elsewhere).
    const nextRun = {
        ...s,
        index: new SessionIndex("run-2")
    };
    const ps2 = makePhotoshop();
    ps2.setActive(42);
    const resolver2 = new SessionResolver(ps2.gateway, nextRun.index, () => {});

    const recovered = await resolver2.resolve(
        { id: 42, file: "C:\\art\\b.psd", bounds: BOUNDS },
        s.config,
        true
    );

    assert.equal(recovered.session.sessionId, sessionId, "matched on the file path");
    assert.equal(recovered.session.restamped, true);
    assert.equal(recovered.session.manifest.frameCount, 9);
});

test("an unrelated document of the same size is offered as a choice, never adopted silently", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\c.psd", bounds: BOUNDS }, s.config, true);
    writeFrames(s.config, first.session.sessionId, 30);

    // The earlier document is closed, freeing its session.
    s.resolver.forgetDocument(1);

    // A different, never-before-seen document that happens to match the canvas.
    s.ps.setActive(2);
    const outcome = await s.resolver.resolve(
        { id: 2, file: "Untitled-9", bounds: BOUNDS },
        s.config,
        false
    );

    assert.equal(outcome.session, null, "nothing is adopted behind the user's back");
    assert.equal(outcome.candidates.length, 1, "but the match is offered");
    assert.equal(outcome.candidates[0].sessionId, first.session.sessionId);
    assert.equal(outcome.candidates[0].frameCount, 30);
});

test("adopting a candidate attaches it and stamps the document", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\d.psd", bounds: BOUNDS }, s.config, true);
    writeFrames(s.config, first.session.sessionId, 4);

    s.ps.setActive(2);
    const adopted = await s.resolver.adopt(
        { id: 2, file: "Untitled-3", bounds: BOUNDS },
        s.config,
        first.session.sessionId
    );

    assert.equal(adopted.sessionId, first.session.sessionId);
    assert.equal(s.ps.peek(2).sessionId, first.session.sessionId);
    assert.equal(adopted.manifest.frameCount, 4);
});

test("a session already attached to another open document is not offered", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\e.psd", bounds: BOUNDS }, s.config, true);
    writeFrames(s.config, first.session.sessionId, 10);

    s.ps.setActive(2);
    const outcome = await s.resolver.resolve({ id: 2, file: "Untitled-4", bounds: BOUNDS }, s.config, false);

    assert.equal(outcome.candidates.length, 0, "document 1 is still using it");
});

test("a stamp deferred because the document was not frontmost is retried later", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\f.psd", bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;

    // Photoshop can only write generatorSettings to the frontmost document, so
    // a Save As noticed while another document is in front cannot be repaired
    // immediately.
    s.ps.wipeSettings(1);
    s.ps.setActive(2);
    const deferredStamp = await s.resolver.resolve(
        { id: 1, file: "C:\\art\\f2.psd", bounds: BOUNDS },
        s.config,
        true
    );
    assert.equal(deferredStamp.session.sessionId, sessionId, "recording still continues correctly");
    assert.equal(deferredStamp.session.restamped, false, "but the PSD could not be written yet");
    assert.equal(s.ps.peek(1), undefined);

    // When it comes back to the front, the stamp lands.
    s.ps.setActive(1);
    await s.resolver.flushPendingStamps();
    assert.equal(s.ps.peek(1).sessionId, sessionId, "repaired once the document is frontmost again");
});

test("a session whose folder was deleted is not resurrected", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\g.psd", bounds: BOUNDS }, s.config, true);
    fs.rmSync(first.session.folder, { recursive: true, force: true });

    const outcome = await s.resolver.resolve({ id: 1, file: "C:\\art\\g.psd", bounds: BOUNDS }, s.config, true);
    assert.notEqual(outcome.session.sessionId, first.session.sessionId, "a fresh session is started");
    assert.equal(outcome.session.isNew, true);
});

test("with creation disallowed and nothing matching, no folder is created", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const outcome = await s.resolver.resolve({ id: 1, file: "Untitled-1", bounds: BOUNDS }, s.config, false);

    assert.equal(outcome.session, null);
    assert.deepEqual(fs.readdirSync(s.config.processImageFolderPath), [], "nothing is written to disk");
});
