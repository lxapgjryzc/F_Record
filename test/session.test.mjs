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

import {
    SessionResolver,
    canvasSize,
    documentDisplayName,
    isSaveAsRename
} from "../dist/modules/session.mjs";
import { SessionIndex } from "../dist/modules/store.mjs";
import { tempDir, withIsolatedAppDir } from "./helpers.mjs";
import { makePhotoshop } from "./photoshop.mjs";

const BOUNDS = { top: 0, left: 0, right: 2000, bottom: 1500 };
const SEP = String.fromCharCode(92);

function setup(runId = "run-1") {
    // The recovery index lives under %APPDATA%. Without a temporary one,
    // the suite reads and rewrites the real installation's.
    const app = withIsolatedAppDir();
    const folders = tempDir();
    const temp = { dir: folders.dir, cleanup: () => { folders.cleanup(); app.cleanup(); } };
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
    s.ps.carrySettings(1, 7);

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

// Photoshop will write generatorSettings only into the document in front --
// no reference form names another, verified against 27.2 -- so a repair
// noticed while the artist is looking elsewhere has to wait. What must never
// happen is the write going to the document that *is* in front instead,
// which is what orphaned a 2460 frame recording on 2026-09-09.
test("a repair for a document that is not frontmost waits rather than misfiring", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\art\f.psd", bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;

    // Save As, noticed while the artist is already looking at another document.
    s.ps.wipeSettings(1);
    s.ps.setActive(2);
    const deferred = await s.resolver.resolve(
        { id: 1, file: "C:\art\f2.psd", bounds: BOUNDS },
        s.config,
        true
    );

    assert.equal(deferred.session.sessionId, sessionId, "recording continues correctly");
    assert.equal(deferred.session.restamped, false, "the PSD could not be written yet");
    assert.equal(s.ps.peek(1), undefined);
    assert.equal(s.ps.peek(2), undefined, "and nothing went into the document in front");

    // It lands as soon as the document is back in front.
    s.ps.setActive(1);
    await s.resolver.flushPendingStamps();
    assert.equal(s.ps.peek(1).sessionId, sessionId, "repaired once its document is frontmost");
});

test("a queued stamp is said once, not once a second", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    await s.resolver.resolve({ id: 1, file: "C:\art\q.psd", bounds: BOUNDS }, s.config, true);
    s.ps.wipeSettings(1);
    s.ps.setActive(2);
    await s.resolver.resolve({ id: 1, file: "C:\art\q2.psd", bounds: BOUNDS }, s.config, true);

    for (let i = 0; i < 5; i++) {
        await s.resolver.flushPendingStamps();
    }
    const said = s.logs.filter((line) => /waits until its document is in front/.test(line));
    assert.equal(said.length, 1, "the log does not fill up with retries");
});

test("two documents waiting to be stamped take turns", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    // Both are recorded, both lose their id, and neither is in front.
    for (const id of [1, 2]) {
        s.ps.setActive(id);
        await s.resolver.resolve({ id, file: "C:\art\t" + id + ".psd", bounds: BOUNDS }, s.config, true);
        s.ps.wipeSettings(id);
    }
    s.ps.setActive(3);
    for (const id of [1, 2]) {
        await s.resolver.resolve({ id, file: "C:\art\t" + id + "b.psd", bounds: BOUNDS }, s.config, true);
    }
    assert.equal(s.ps.peek(1), undefined);
    assert.equal(s.ps.peek(2), undefined);

    // Document 2 comes to the front. Retrying from the same end of the queue
    // every time would spend every attempt on document 1 and never reach it.
    s.ps.setActive(2);
    await s.resolver.flushPendingStamps();
    await s.resolver.flushPendingStamps();
    assert.ok(s.ps.peek(2), "the document in front is reached");
});

test("a stamp Photoshop refused is retried until it takes", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\art\f3.psd", bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;

    // Photoshop busy with a dialog: the write is refused outright.
    s.ps.wipeSettings(1);
    s.ps.setWritesFail(true);
    const refused = await s.resolver.resolve(
        { id: 1, file: "C:\art\f4.psd", bounds: BOUNDS },
        s.config,
        true
    );
    assert.equal(refused.session.sessionId, sessionId, "the recording is unaffected");
    assert.equal(refused.session.restamped, false, "but nothing was written");
    assert.equal(s.ps.peek(1), undefined);

    s.ps.setWritesFail(false);
    await s.resolver.flushPendingStamps();
    assert.equal(s.ps.peek(1).sessionId, sessionId, "the queued write lands once Photoshop takes it");
});

test("a queued stamp for a document Photoshop has closed is dropped", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    await s.resolver.resolve({ id: 1, file: "C:\art\f5.psd", bounds: BOUNDS }, s.config, true);
    s.ps.wipeSettings(1);
    s.ps.setWritesFail(true);
    await s.resolver.resolve({ id: 1, file: "C:\art\f6.psd", bounds: BOUNDS }, s.config, true);

    // The artist closes the document rather than answering the dialog.
    s.ps.close(1);
    s.ps.setWritesFail(false);
    await s.resolver.flushPendingStamps();
    assert.equal(s.ps.peek(1), undefined, "nothing is written into a document that has gone");

    // And the queue is empty rather than retrying it forever.
    s.ps.open(1);
    await s.resolver.flushPendingStamps();
    assert.equal(s.ps.peek(1), undefined);
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
    s.ps.setSettings(2, stampedIntoTheFile);
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
    s.ps.carrySettings(1, 2);

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
    // time, which are what order the export and date the recording.
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

test("a repair still reading the PSD when the fork happens does not put the old id back", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const original = await s.resolver.resolve(
        { id: 1, file: "C:" + SEP + "art" + SEP + "a.psd", bounds: BOUNDS },
        s.config,
        true
    );
    writeFrames(s.config, original.session.sessionId, 3);

    // Save As: the settings go, and the save event starts a repair. Its read
    // of the PSD is answered only after the save is fully written, which for
    // a large file on a slow drive is long after the fork has run.
    s.ps.wipeSettings(1);
    let answerRead;
    const readAnswered = new Promise((resolve) => (answerRead = resolve));
    const gateway = s.ps.gateway;
    const read = gateway.getDocumentSettings.bind(gateway);
    // Only the repair's own read is the slow one; the reads that verify a
    // write are answered as normal, or the fork below could never finish.
    let slow = true;
    gateway.getDocumentSettings = async (id) => {
        if (slow) {
            slow = false;
            await readAnswered;
        }
        return read(id);
    };
    const repair = s.resolver.repairAfterSave(1);

    const forked = await s.resolver.forkForSaveAs(
        { id: 1, file: "C:" + SEP + "art" + SEP + "b.psd", bounds: BOUNDS },
        s.config,
        original.session
    );
    assert.equal(s.ps.peek(1).sessionId, forked.sessionId, "precondition: the fork stamped the document");

    // Photoshop finally answers the read: nothing there. The repair's remedy
    // for that would be to write back the id it knew before the fork -- the
    // original's -- which would send every frame from here on into the
    // folder the file was saved away from.
    answerRead();
    assert.equal(await repair, false, "the repair stands down");
    assert.equal(s.ps.peek(1).sessionId, forked.sessionId, "the document keeps the copy's id");
    assert.ok(!s.logs.some((l) => /restamping/.test(l)), "and nothing claims to have repaired it");
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
    s.ps.setSettings(2, stampedIntoTheFile);
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

/* ------------------------------------------------- the repair after a save */

// onSave calls this before the debounced resync gets there, so a capture
// racing in between still resolves to the right session.

test("a save that did not clear the id repairs nothing", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\r1.psd", bounds: BOUNDS }, s.config, true);

    assert.equal(await s.resolver.repairAfterSave(1), false, "the PSD still holds it");
    assert.equal(s.ps.peek(1).sessionId, first.session.sessionId);
});

test("a save that cleared the id puts it back at once", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\r2.psd", bounds: BOUNDS }, s.config, true);
    s.ps.wipeSettings(1);

    assert.equal(await s.resolver.repairAfterSave(1), true);
    assert.equal(s.ps.peek(1).sessionId, first.session.sessionId, "back in the document");
    assert.ok(s.logs.some((line) => /lost its session id \(Save As\); restamping/.test(line)));
});

test("a save on a document we have never recorded repairs nothing", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(9);
    assert.equal(await s.resolver.repairAfterSave(9), false);
});

/* ------------------------------------------------------------- odd shapes */

test("a document with no bounds has no size and is offered no candidates", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    assert.deepEqual(canvasSize(null), { width: 0, height: 0 });

    // Photoshop occasionally answers without bounds; a session still starts,
    // and nothing can be matched to it by canvas size.
    s.ps.setActive(1);
    const outcome = await s.resolver.resolve({ id: 1, file: "Untitled-1", bounds: null }, s.config, true);
    assert.ok(outcome.session);
    assert.equal(outcome.session.manifest.canvasBounds, null);

    s.ps.setActive(2);
    const other = await s.resolver.resolve({ id: 2, file: "Untitled-2", bounds: null }, s.config, false);
    assert.equal(other.session, null);
    assert.deepEqual(other.candidates, [], "a canvas of no size matches nothing");
});

test("a folder whose manifest has gone is described again from what is on disk", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\m.psd", bounds: BOUNDS }, s.config, true);
    writeFrames(s.config, first.session.sessionId, 4);
    fs.rmSync(path.join(first.session.folder, "session.json"));

    const again = await s.resolver.resolve({ id: 1, file: "C:\\art\\m.psd", bounds: BOUNDS }, s.config, true);
    assert.equal(again.session.sessionId, first.session.sessionId, "the folder is still the recording");
    assert.equal(again.session.manifest.frameCount, 4, "counted from the frames themselves");
    assert.deepEqual(again.session.manifest.filePathHistory, ["C:\\art\\m.psd"]);
});

test("adopting a recording that has been deleted says so", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    await assert.rejects(
        () => s.resolver.adopt({ id: 1, file: "C:\\art\\gone.psd", bounds: BOUNDS }, s.config, "no-such-session"),
        /no longer exists/
    );
});

test("a refusal that is not an Error is still reported", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    // Photoshop's own layers throw strings often enough to matter, and a log
    // line reading "[object Object]" is how a diagnosis gets lost.
    s.ps.gateway.setDocumentSettings = () => Promise.reject("Photoshop said no");

    const outcome = await s.resolver.resolve({ id: 1, file: "C:\\art\\s.psd", bounds: BOUNDS }, s.config, true);
    assert.ok(outcome.session, "the recording starts anyway");
    assert.ok(
        s.logs.some((line) => /Session id for document 1 could not be written: Photoshop said no/.test(line))
    );
});

/* --------------------------------------------- what the evidence can look like */

test("a path that is nothing but separators still names something", () => {
    assert.equal(documentDisplayName(SEP + SEP), SEP + SEP);
    assert.equal(documentDisplayName(""), "Untitled");
    assert.equal(documentDisplayName("C:" + SEP + "art" + SEP + "dragon.psd"), "dragon");
});

test("a document whose settings come back empty is treated as unrecorded", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    // generator-core answers with null rather than throwing on some versions.
    s.ps.gateway.getDocumentSettings = async () => null;

    s.ps.setActive(1);
    const outcome = await s.resolver.resolve({ id: 1, file: "Untitled-1", bounds: BOUNDS }, s.config, true);
    assert.equal(outcome.session.isNew, true);
});

test("an id pointing at a folder that has gone loses to the file's own recording", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\d1.psd", bounds: BOUNDS }, s.config, true);
    writeFrames(s.config, first.session.sessionId, 7);

    // The PSD names a recording nobody has: deleted, or from another machine.
    s.ps.setSettings(1, { sessionId: "2026-01-01-00-00-00-000-deadbeef" });

    const again = await s.resolver.resolve({ id: 1, file: "C:\\art\\d1.psd", bounds: BOUNDS }, s.config, true);
    assert.equal(again.session.sessionId, first.session.sessionId);
    assert.equal(again.session.manifest.frameCount, 7);
});

test("an id pointing at a folder with no manifest loses to the file's own recording", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const mine = await s.resolver.resolve({ id: 1, file: "C:\\art\\d2.psd", bounds: BOUNDS }, s.config, true);
    writeFrames(s.config, mine.session.sessionId, 3);

    s.ps.setActive(2);
    const other = await s.resolver.resolve({ id: 2, file: "Untitled-9", bounds: BOUNDS }, s.config, true);
    fs.rmSync(path.join(other.session.folder, "session.json"));
    s.ps.close(2);

    // Document 1 now carries an id whose folder is there but says nothing.
    s.ps.setSettings(1, { sessionId: other.session.sessionId });
    s.ps.setActive(1);

    const again = await s.resolver.resolve({ id: 1, file: "C:\\art\\d2.psd", bounds: BOUNDS }, s.config, true);
    assert.equal(again.session.sessionId, mine.session.sessionId, "the one that claims the file wins");
    assert.equal(s.ps.peek(1).sessionId, mine.session.sessionId, "and the document is repaired");
});

test("a manifest written before file paths were recorded gains one", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\d3.psd", bounds: BOUNDS }, s.config, true);

    // A 3.x-era manifest: no filePathHistory at all.
    const manifestPath = path.join(first.session.folder, "session.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.filePathHistory;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const again = await s.resolver.resolve({ id: 1, file: "C:\\art\\d3.psd", bounds: BOUNDS }, s.config, true);
    assert.deepEqual(again.session.manifest.filePathHistory, ["C:\\art\\d3.psd"]);
});

test("a recording deleted while its id was being written does not take the resolve down", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: "C:\\art\\d4.psd", bounds: BOUNDS }, s.config, true);
    s.ps.wipeSettings(1);

    // The artist deletes the take from the panel while the repair is in flight.
    const write = s.ps.gateway.setDocumentSettings.bind(s.ps.gateway);
    s.ps.gateway.setDocumentSettings = async (id, settings) => {
        fs.rmSync(first.session.folder, { recursive: true, force: true });
        return write(id, settings);
    };

    const again = await s.resolver.resolve({ id: 1, file: "C:\\art\\d4.psd", bounds: BOUNDS }, s.config, true);
    assert.equal(again.session.sessionId, first.session.sessionId);
    assert.equal(again.session.manifest.frameCount, 0, "an empty folder, not someone else's frames");
});
