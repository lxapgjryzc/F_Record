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

import { SessionResolver, isSaveAsRename } from "../dist/test/session.mjs";
import { SessionIndex } from "../dist/test/store.mjs";
import { tempDir } from "./helpers.mjs";

const BOUNDS = { top: 0, left: 0, right: 2000, bottom: 1500 };
const SEP = String.fromCharCode(92);

/** Stand-in for Photoshop's generatorSettings storage. */
function makePhotoshop() {
    const stored = new Map();
    const open = new Set();
    let active = null;
    let writesFail = false;
    return {
        setActive(id) {
            active = id;
            open.add(id);
        },
        /** Photoshop closing a document, with or without telling us. */
        close(id) {
            open.delete(id);
            if (active === id) {
                active = null;
            }
        },
        /** Photoshop refusing to store settings, e.g. while a dialog is up. */
        setWritesFail(value) {
            writesFail = value;
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
                if (writesFail) {
                    throw new Error("Photoshop rejected the write");
                }
                stored.set(active, settings);
            },
            getActiveDocumentId() {
                return active;
            },
            async isDocumentOpen(documentId) {
                return open.has(documentId);
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

// The forking above is driven by the plug-in, which notices the document's
// path change. The resolver's own job is narrower and still worth pinning: a
// document whose stamp has been wiped must find its way back to its session
// rather than starting a fresh one. That is the safety net for every Save As
// that does not qualify as a fork -- the file moved rather than copied, say.
test("a document whose stamp Photoshop wiped is recovered and re-stamped", async (t) => {
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

test("a stamp wiped twice over is recovered both times", async (t) => {
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

    // The panel only offers a session no open document is using, which is
    // what closing document 1 makes true here.
    s.ps.close(1);
    s.resolver.forgetDocument(1);
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

test("a stamp Photoshop refused is not undone by the stale id left in the PSD", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\art\h.psd", bounds: BOUNDS }, s.config, true);
    const oldId = first.session.sessionId;
    writeFrames(s.config, oldId, 4);

    // The user asks for a fresh recording, but Photoshop refuses the write, so
    // the new id can only be queued.
    s.ps.setWritesFail(true);
    const fresh = await s.resolver.startFresh({ id: 1, file: "C:\art\h.psd", bounds: BOUNDS }, s.config);
    assert.notEqual(fresh.sessionId, oldId, "a new session really was started");
    assert.equal(s.ps.peek(1).sessionId, oldId, "precondition: the PSD still holds the old id");

    // The next resync must not hand the document back to the old session just
    // because that is what the PSD still says.
    const again = await s.resolver.resolve({ id: 1, file: "C:\art\h.psd", bounds: BOUNDS }, s.config, true);
    assert.equal(again.session.sessionId, fresh.sessionId, "the queued id wins over the stale PSD copy");

    // Once Photoshop accepts writes again the document catches up.
    s.ps.setWritesFail(false);
    await s.resolver.flushPendingStamps();
    assert.equal(s.ps.peek(1).sessionId, fresh.sessionId);
});

test("reopening the file a Save As branched from keeps the two drawings apart", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    // Save As is also how an artist forks a drawing: work up to a point in
    // a.psd, save it as b.psd, and carry on down one path.
    s.ps.setActive(1);
    const original = await s.resolver.resolve(
        { id: 1, file: "C:\art\a.psd", bounds: BOUNDS },
        s.config,
        true
    );
    const sessionId = original.session.sessionId;
    writeFrames(s.config, sessionId, 20);
    // What a.psd carries on disk: the id it was stamped with before the fork.
    const stampedIntoTheFile = s.ps.peek(1);

    s.ps.wipeSettings(1);
    const branchB = await s.resolver.resolve(
        { id: 1, file: "C:\art\b.psd", bounds: BOUNDS },
        s.config,
        true
    );
    assert.equal(branchB.session.sessionId, sessionId, "the open document keeps the recording");

    // Now the artist reopens a.psd to try the other path. It arrives holding
    // the same session id as the document already recording into it.
    s.ps.setActive(2);
    await s.ps.gateway.setActiveDocumentSettings(stampedIntoTheFile);
    const branchA = await s.resolver.resolve(
        { id: 2, file: "C:\art\a.psd", bounds: BOUNDS },
        s.config,
        true
    );

    assert.notEqual(branchA.session.sessionId, sessionId, "the fork records on its own");
    assert.equal(branchA.session.isNew, true);
    assert.equal(branchA.session.manifest.frameCount, 0);
    assert.equal(s.ps.peek(2).sessionId, branchA.session.sessionId, "and the reopened file is restamped");

    // Without this, both documents write frames into one folder and the export
    // interleaves two different drawings into a single video.
    assert.equal(
        fs.readdirSync(original.session.folder).filter((f) => f.endsWith(".jpg")).length,
        20,
        "the first branch keeps its frames, and gains none from the second"
    );
});

test("a document Photoshop closed without telling us does not cost the recording", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve(
        { id: 1, file: "C:\art\i.psd", bounds: BOUNDS },
        s.config,
        true
    );
    writeFrames(s.config, first.session.sessionId, 6);

    // The document is gone but no close event reached us, so the map still
    // says document 1 owns the session. Splitting the recording on the
    // strength of that alone would be the very bug this module exists to stop.
    s.ps.close(1);
    s.ps.setActive(2);
    await s.ps.gateway.setActiveDocumentSettings(s.ps.peek(1));

    const again = await s.resolver.resolve(
        { id: 2, file: "C:\art\i.psd", bounds: BOUNDS },
        s.config,
        true
    );
    assert.equal(again.session.sessionId, first.session.sessionId, "the reopened file carries on");
    assert.equal(again.session.manifest.frameCount, 6);
});

test("a session another open document is recording cannot be adopted", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve(
        { id: 1, file: "C:\art\j.psd", bounds: BOUNDS },
        s.config,
        true
    );

    s.ps.setActive(2);
    await assert.rejects(
        () => s.resolver.adopt({ id: 2, file: "Untitled-8", bounds: BOUNDS }, s.config, first.session.sessionId),
        /another open document/
    );
});

/**
 * Save As forks the artwork, so it forks the recording.
 *
 * The file left on disk is a finished work in its own right and already holds
 * this session's id; the frames drawn up to that moment belong to both sides.
 * The document in front gets the copy -- it is the only one Photoshop will let
 * us stamp -- and the file left behind keeps the original folder.
 */
test("Save As gives the renamed document its own copy of the frames so far", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const original = await s.resolver.resolve(
        { id: 1, file: "C:" + SEP + "art" + SEP + "a.psd", bounds: BOUNDS },
        s.config,
        true
    );
    writeFrames(s.config, original.session.sessionId, 20);
    original.session.manifest.timeSpentSec = 480;

    const forked = await s.resolver.forkForSaveAs(
        { id: 1, file: "C:" + SEP + "art" + SEP + "b.psd", bounds: BOUNDS },
        s.config,
        original.session
    );

    assert.notEqual(forked.sessionId, original.session.sessionId, "a second folder, not a rename");
    assert.equal(forked.manifest.frameCount, 20, "with every frame drawn so far");
    assert.equal(forked.manifest.timeSpentSec, 480, "and the time already spent");
    assert.equal(forked.manifest.docName, "b");
    assert.equal(forked.manifest.nextSeq, 21, "numbering carries on rather than restarting");

    // Filenames must survive verbatim: they carry the sequence and the capture
    // time, which are what order the export and pace real-time playback.
    const before = fs.readdirSync(original.session.folder).filter((f) => f.endsWith(".jpg")).sort();
    const after = fs.readdirSync(forked.folder).filter((f) => f.endsWith(".jpg")).sort();
    assert.deepEqual(after, before);

    // The file left on disk keeps its recording, and the document in front is
    // stamped with the copy.
    assert.equal(s.ps.peek(1).sessionId, forked.sessionId);
    assert.deepEqual(forked.manifest.filePathHistory, ["C:" + SEP + "art" + SEP + "b.psd"]);
    assert.equal(
        fs.existsSync(path.join(original.session.folder, "session.json")),
        true,
        "the original folder is left intact"
    );
});

test("the two halves are independent: a frame added to one does not reach the other", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const original = await s.resolver.resolve(
        { id: 1, file: "C:" + SEP + "art" + SEP + "a.psd", bounds: BOUNDS },
        s.config,
        true
    );
    writeFrames(s.config, original.session.sessionId, 5);
    const forked = await s.resolver.forkForSaveAs(
        { id: 1, file: "C:" + SEP + "art" + SEP + "b.psd", bounds: BOUNDS },
        s.config,
        original.session
    );

    // Hard links share bytes, never directory entries -- adding to or deleting
    // from one folder must be invisible to the other.
    fs.writeFileSync(path.join(forked.folder, "000006_1700000006000.jpg"), "x");
    assert.equal(fs.readdirSync(original.session.folder).filter((f) => f.endsWith(".jpg")).length, 5);
    assert.equal(fs.readdirSync(forked.folder).filter((f) => f.endsWith(".jpg")).length, 6);

    fs.rmSync(original.session.folder, { recursive: true, force: true });
    assert.equal(
        fs.readdirSync(forked.folder).filter((f) => f.endsWith(".jpg")).length,
        6,
        "deleting the original leaves the copy whole"
    );
    assert.equal(fs.readFileSync(path.join(forked.folder, "000001_1700000001000.jpg"), "utf8"), "x");
});

test("saving one file under a new name several times leaves each name its own recording", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    let current = (await s.resolver.resolve(
        { id: 1, file: "C:" + SEP + "art" + SEP + "v1.psd", bounds: BOUNDS },
        s.config,
        true
    )).session;
    const folders = [current.folder];

    // v1 -> v2 -> v3 -> v4, each with more drawing in between, which is how
    // people actually use Save As.
    let drawn = 0;
    for (const name of ["v2", "v3", "v4"]) {
        drawn += 10;
        writeFrames(s.config, current.sessionId, drawn);
        current = await s.resolver.forkForSaveAs(
            { id: 1, file: "C:" + SEP + "art" + SEP + name + ".psd", bounds: BOUNDS },
            s.config,
            current
        );
        assert.equal(current.manifest.frameCount, drawn, name + " starts from everything drawn so far");
        folders.push(current.folder);
    }

    assert.equal(new Set(folders).size, 4, "four names, four recordings");
    // v1 was left behind at 10 frames; v2 inherited those and grew to 20
    // before being left behind in turn; v3 to 30. v4 is where the drawing is
    // now, so it holds everything and nothing has been drawn since.
    assert.deepEqual(
        folders.map((f) => fs.readdirSync(f).filter((x) => x.endsWith(".jpg")).length),
        [10, 20, 30, 30],
        "each name keeps the drawing exactly as it stood when it was left behind"
    );

    // Only the newest is attached to the document; the rest are findable by
    // the file each was left to.
    assert.equal(s.ps.peek(1).sessionId, current.sessionId);
    for (const name of ["v1", "v2", "v3"]) {
        const found = s.index.findByFilePath("C:" + SEP + "art" + SEP + name + ".psd");
        assert.ok(found, name + ".psd has a recording of its own");
        assert.notEqual(found.sessionId, current.sessionId);
    }
});

test("reopening the file a Save As left behind continues its own recording", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const original = await s.resolver.resolve(
        { id: 1, file: "C:" + SEP + "art" + SEP + "a.psd", bounds: BOUNDS },
        s.config,
        true
    );
    writeFrames(s.config, original.session.sessionId, 12);
    // a.psd on disk holds the id it was stamped with before the fork.
    const stampedIntoTheFile = s.ps.peek(1);

    const forked = await s.resolver.forkForSaveAs(
        { id: 1, file: "C:" + SEP + "art" + SEP + "b.psd", bounds: BOUNDS },
        s.config,
        original.session
    );
    writeFrames(s.config, forked.sessionId, 30);

    // The artist reopens a.psd to take the drawing somewhere else.
    s.ps.setActive(2);
    await s.ps.gateway.setActiveDocumentSettings(stampedIntoTheFile);
    const reopened = await s.resolver.resolve(
        { id: 2, file: "C:" + SEP + "art" + SEP + "a.psd", bounds: BOUNDS },
        s.config,
        true
    );

    // No branch guard needed any more: the two files hold two different ids,
    // so a.psd simply picks its own recording back up where it left off.
    assert.equal(reopened.session.sessionId, original.session.sessionId);
    assert.equal(reopened.session.isNew, false);
    assert.equal(reopened.session.manifest.frameCount, 12, "the 30 frames drawn in b.psd are not its own");
});

/**
 * What counts as a Save As.
 *
 * This one predicate decides whether a recording gets forked, so every way a
 * document's path can change is worth pinning down. Getting it wrong in either
 * direction is bad: a missed fork puts two artworks in one folder, a spurious
 * one splits a recording that should have stayed whole.
 */
test("a Save As is a new name for a document whose old file is still there", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const before = path.join(temp.dir, "a.psd");
    const after = path.join(temp.dir, "b.psd");
    fs.writeFileSync(before, "psd");

    assert.equal(isSaveAsRename(before, after), true);

    // Saving an untitled document for the first time leaves nothing behind.
    assert.equal(isSaveAsRename("Untitled-1", after), false);
    assert.equal(isSaveAsRename(before, "Untitled-1"), false);

    // A plain Ctrl+S does not change the path.
    assert.equal(isSaveAsRename(before, before), false);
    if (process.platform === "win32") {
        // Windows paths are case-insensitive, so a different casing of the same
        // file is the same file, not a Save As.
        assert.equal(isSaveAsRename(before, before.toUpperCase()), false);
    }

    // The old file being gone means it was moved, not copied -- there is no
    // second artwork to record separately.
    fs.rmSync(before);
    assert.equal(isSaveAsRename(before, after), false);
});
