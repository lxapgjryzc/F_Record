/**
 * The parts of the store the other suites do not reach.
 *
 * archive, session and interleave drive the store through whole recordings,
 * which is the right way to test the happy paths. What is left over is the
 * awkward middle: config that has to survive being read back, 3.x folders,
 * a listing that must never throw whatever it meets, a fork that loses one
 * frame out of a thousand, and a move across two volumes. Those are the
 * states a bug report arrives in, and most of them need the filesystem to
 * misbehave on cue.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { clearFaults, fsError, mockBuiltins, setFault, tempDir, withIsolatedAppDir } from "./helpers.mjs";

mockBuiltins(mock, "fs");
const {
    ConfigStore,
    SessionIndex,
    chooseDocumentSideFolder,
    deleteSession,
    duplicateFrames,
    listSessions,
    markArchived,
    moveFolder,
    normalizeConfig,
    normalizePath,
    scanFrames,
    summarizeSession,
    writeManifest,
    writePointer
} = await import("../dist/modules/store.mjs");
const { DEFAULT_CONFIG } = await import("../dist/modules/protocol.mjs");

/** A session folder with `frames` frames and, unless told otherwise, a manifest. */
function writeSession(root, sessionId, { frames = 3, manifest = true, docName = sessionId } = {}) {
    const folder = path.join(root, sessionId);
    fs.mkdirSync(folder, { recursive: true });
    for (let i = 1; i <= frames; i++) {
        fs.writeFileSync(
            path.join(folder, String(i).padStart(6, "0") + "_" + (1700000000000 + i * 1000) + ".jpg"),
            "frame " + i
        );
    }
    if (manifest) {
        writeManifest(folder, {
            version: 4,
            sessionId,
            docName,
            filePathHistory: [],
            canvasBounds: null,
            frameCount: frames,
            timeSpentSec: 10,
            createdAt: 1700000000000,
            lastModifiedAt: 1700000005000,
            format: "jpg",
            resolution: "1080",
            nextSeq: frames + 1
        });
    }
    return folder;
}

const quiet = () => {};

/** Windows paths, written with forward slashes so the source stays readable. */
const winPath = (s) => s.split("/").join(String.fromCharCode(92));

/** The shape upsert() wants, for a document that has never been saved. */
function indexed(sessionId, folder, extra = {}) {
    return {
        sessionId,
        folder,
        documentId: null,
        filePath: null,
        canvasWidth: 0,
        canvasHeight: 0,
        ...extra
    };
}

/* ------------------------------------------------------------------ config */

test("the config on disk is the one that comes back, normalised", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());
    t.after(clearFaults);

    const store = new ConfigStore();
    assert.equal(store.get().quality, DEFAULT_CONFIG.quality);
    assert.ok(store.get().processImageFolderPath.length > 0, "a default frames folder is filled in");

    // update() is what every panel setting goes through, and it has to both
    // normalise and persist -- a value that survives only until the next
    // restart is the shape of "my settings keep resetting".
    const updated = store.update({ quality: 999, language: "cn" });
    assert.equal(updated.quality, 100, "clamped");
    assert.equal(updated.language, "zh-CN", "the 4.0 language tag is migrated");

    const reread = new ConfigStore();
    assert.equal(reread.get().quality, 100);
    assert.equal(reread.get().language, "zh-CN");
});

test("a config file full of nonsense is repaired rather than refused", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());

    fs.mkdirSync(path.join(isolated.dir, "F_Record"), { recursive: true });
    fs.writeFileSync(path.join(isolated.dir, "F_Record", "config.json"), "{ not json at all");

    // The panel has to come up. A config it cannot read is a config it
    // replaces, not a reason to leave the user without a plug-in.
    const store = new ConfigStore();
    assert.equal(store.get().quality, DEFAULT_CONFIG.quality);

    store.persist();
    assert.deepEqual(new ConfigStore().get(), store.get());
});

/* ------------------------------------------------------------- 3.x folders */

test("a 3.x recording is still readable, in the right order", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    // 3.x wrote `000001.jpg` and kept the count in a sibling file. The names
    // carry no timestamp, so the sequence is all there is to sort by.
    const folder = path.join(temp.dir, "old");
    fs.mkdirSync(folder);
    for (const n of ["000010", "000002", "000001"]) {
        fs.writeFileSync(path.join(folder, n + ".jpg"), "x");
    }
    fs.writeFileSync(path.join(folder, "count.json"), "{}");

    assert.deepEqual(scanFrames(folder).map((f) => f.seq), [1, 2, 10]);
});

test("a folder with 4.x frames does not fall back to the 3.x naming", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const folder = writeSession(temp.dir, "modern", { frames: 2 });
    fs.writeFileSync(path.join(folder, "000009.jpg"), "a stray 3.x frame");

    assert.deepEqual(scanFrames(folder).map((f) => f.seq), [1, 2], "the newer naming wins outright");
});

test("a folder that cannot be listed reads as empty rather than throwing", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    assert.deepEqual(scanFrames(path.join(temp.dir, "never-existed")), []);
});

/* ------------------------------------------------------------- summarising */

test("a folder that is neither a recording nor has frames is not one", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    // The frames root is a folder in the user's data directory, and people put
    // things in folders. A stray directory must not appear in the panel as a
    // recording with nothing in it.
    const stray = path.join(temp.dir, "screenshots");
    fs.mkdirSync(stray);
    fs.writeFileSync(path.join(stray, "notes.txt"), "hello");

    assert.equal(summarizeSession(stray), null);
});

test("a folder that will not be read at all is reported as a row with an error", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);
    const folder = writeSession(temp.dir, "20260101-abc123");

    // Synthetic: a listing that comes back as something other than a list. The
    // point is the contract rather than the cause -- whatever the filesystem
    // does, one bad folder becomes a row the panel can show and explain, and
    // never an exception that costs the user the rest of the listing.
    setFault("readdirSync", () => null);

    const summary = summarizeSession(folder);
    assert.equal(summary.sessionId, "20260101-abc123");
    assert.equal(summary.frameCount, 0);
    assert.ok(summary.error.length > 0, "says something went wrong");
});

/* ---------------------------------------------------------------- listing */

test("a frames folder that is not there yet lists nothing", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    assert.deepEqual(listSessions(path.join(temp.dir, "processImages")), []);
});

test("a folder being carried somewhere else is not listed while it is half-copied", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const root = path.join(temp.dir, "processImages");
    fs.mkdirSync(root);
    writeSession(root, "20260101-here");

    // copyFolderThenDelete assembles under a `.moving` name. Showing that in
    // the panel would offer the artist a recording that is half a recording,
    // with a delete button next to it.
    writeSession(root, "20260101-there.moving");

    assert.deepEqual(listSessions(root).map((s) => s.sessionId), ["20260101-here"]);
});

/* ------------------------------------------------------------------ forks */

test("a fork reports a real byte copy when the filesystem refused to link", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const from = writeSession(temp.dir, "source", { frames: 2, manifest: false });
    const to = path.join(temp.dir, "fork");

    // exFAT and network shares refuse hard links. The caller logs which one
    // happened, because the byte copy is where a slow Save As goes.
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, "000001_1700000001000.jpg"), "already here");

    const result = await duplicateFrames(from, to, quiet);
    assert.equal(result.mode, "copy");
    assert.equal(result.frameCount, 2);
    assert.equal(fs.readFileSync(path.join(to, "000001_1700000001000.jpg"), "utf8"), "frame 1");
});

test("a frame that cannot be duplicated costs that frame and nothing else", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);
    const from = writeSession(temp.dir, "source", { frames: 3, manifest: false });
    const to = path.join(temp.dir, "fork");

    // Losing one frame out of a thousand is a blemish; failing the fork would
    // leave two documents recording into the same folder.
    const doomed = "000002_1700000002000.jpg";
    const refuse = (source) => {
        if (path.basename(source) === doomed) {
            throw fsError("EIO", "that frame will not read");
        }
        throw fsError("EPERM", "links are not supported here");
    };
    setFault("linkSync", refuse);
    setFault("copyFileSync", (source, dest) => {
        if (path.basename(source) === doomed) {
            throw fsError("EIO", "that frame will not read");
        }
        return fs.copyFileSync(source, dest);
    });

    const warnings = [];
    const result = await duplicateFrames(from, to, (level, message) => warnings.push(level + ": " + message));

    assert.equal(result.frameCount, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^warn: Could not duplicate frame 000002_1700000002000\.jpg: /);
    assert.match(warnings[0], /that frame will not read/);
    assert.equal(fs.existsSync(path.join(to, doomed)), false);
});

test("a fork of a long recording hands the event loop back as it goes", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const from = writeSession(temp.dir, "source", { frames: 130, manifest: false });
    const to = path.join(temp.dir, "fork");

    // The generator answers Photoshop on this same loop. A fork that ran to
    // completion without yielding would make Photoshop stop responding for as
    // long as it took -- which on a network drive is not a moment.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
        const result = await duplicateFrames(from, to, quiet);
        assert.equal(result.frameCount, 130);
    } finally {
        clearInterval(timer);
    }
    assert.ok(ticks > 0, "the loop ran while the fork was in progress");
});

/* --------------------------------------------------------------- deleting */

test("a folder that is not recognisably ours is refused, by name", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const root = path.join(temp.dir, "processImages");

    // The frames folder is a path the user can point anywhere, including at
    // their own documents. Nothing here deletes a folder it cannot recognise.
    const stray = path.join(root, "holiday-photos");
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, "beach.png"), "not ours");

    assert.throws(
        () => deleteSession(root, "holiday-photos"),
        /Refusing to delete .*holiday-photos.*not a F_Record session folder/
    );
    assert.equal(fs.existsSync(path.join(stray, "beach.png")), true);

    assert.throws(() => deleteSession(root, "never-existed"), /Refusing to delete/);
});

test("a recording that is only a pointer is let go of by deleting the pointer", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const root = path.join(temp.dir, "processImages");
    fs.mkdirSync(root, { recursive: true });

    // The folder was carried off beside a document and the artist then deleted
    // it themselves. All that is left of the recording is the pointer, and
    // removing that is how the listing stops offering it.
    writePointer(root, "20260101-gone", path.join(temp.dir, "art", "dragon_frames"));
    assert.equal(listSessions(root).length, 1);

    deleteSession(root, "20260101-gone");
    assert.deepEqual(listSessions(root), []);
});

test("archiving a folder with no manifest says which folder", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const folder = writeSession(temp.dir, "frames-only", { manifest: false });
    assert.throws(() => markArchived(folder, true), /No session\.json in /);
});

/* ------------------------------------------------- naming a folder beside a document */

test("a thousand taken names beside one document is an error, not an endless search", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // Every candidate exists and none of them is this session's, so there is
    // nowhere to put the folder. Saying so beats looping.
    setFault("statSync", () => ({ isDirectory: () => true }));

    assert.throws(
        () => chooseDocumentSideFolder(path.join(temp.dir, "dragon.psd"), "20260101-abc123"),
        /No free folder name beside .*dragon\.psd/
    );
});

/* ----------------------------------------------------------------- moving */

test("a move within one volume is a rename, and reports itself done in one step", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const from = writeSession(temp.dir, "20260101-abc123");
    const to = path.join(temp.dir, "art", "dragon_frames");

    const steps = [];
    await moveFolder(from, to, (done, total) => steps.push([done, total]));

    assert.deepEqual(steps, [[1, 1]], "instant, however many frames there are");
    assert.equal(fs.existsSync(from), false);
    assert.equal(fs.existsSync(path.join(to, "session.json")), true);
});

test("a move across volumes falls back to copying, and the source only goes at the end", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);
    const from = writeSession(temp.dir, "20260101-abc123", { frames: 2 });
    const to = path.join(temp.dir, "art", "dragon_frames");

    // The frames folder defaults to C: and artwork tends to live anywhere
    // else, so this is the common case rather than the exotic one.
    setFault("renameSync", (source, dest) => {
        if (source === from) {
            throw fsError("EXDEV", "cross-device link not permitted");
        }
        return fs.renameSync(source, dest);
    });

    const steps = [];
    await moveFolder(from, to, (done, total) => steps.push([done, total]));

    assert.deepEqual(steps, [[1, 3], [2, 3], [3, 3]], "one step per file, not one for the folder");
    assert.equal(fs.existsSync(from), false);
    assert.equal(fs.readFileSync(path.join(to, "000001_1700000001000.jpg"), "utf8"), "frame 1");
    assert.equal(fs.existsSync(to + ".moving"), false, "the staging name is gone");
});

test("a rename that fails for any other reason is not quietly turned into a copy", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);
    const from = writeSession(temp.dir, "20260101-abc123");
    const to = path.join(temp.dir, "art", "dragon_frames");

    // EXDEV is the one that means "try the slow way". Anything else -- a
    // permission problem, a folder in use -- has to surface, or the copy would
    // fail again a moment later with a stranger message.
    setFault("renameSync", () => {
        throw fsError("EACCES", "the destination is not writable");
    });

    await assert.rejects(moveFolder(from, to), /the destination is not writable/);
    assert.equal(fs.existsSync(path.join(from, "session.json")), true, "the source is untouched");
});

/* ------------------------------------------------------------------ index */

test("an index lookup with nothing to look for finds nothing", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());

    // A document that has never been saved has no path, and asking the index
    // about "" would otherwise match every entry whose path normalises away.
    const index = new SessionIndex("run-1");
    index.upsert({
        sessionId: "s1",
        folder: winPath("C:/frames/s1"),
        documentId: null,
        filePath: "",
        canvasWidth: 0,
        canvasHeight: 0
    });
    assert.equal(index.findByFilePath(""), null);
    assert.equal(index.findByFilePath(null), null);
});

test("canvas matches come back newest first", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());

    // This is how an unsaved document is re-attached to its recording after a
    // Photoshop restart, and the artist means the one they were just drawing.
    const index = new SessionIndex("run-1");
    const unsaved = { documentId: null, filePath: null };
    index.upsert({ sessionId: "older", folder: winPath("C:/a"), canvasWidth: 1920, canvasHeight: 1080, ...unsaved });
    index.upsert({ sessionId: "newer", folder: winPath("C:/b"), canvasWidth: 1920, canvasHeight: 1080, ...unsaved });
    index.upsert({ sessionId: "different", folder: winPath("C:/c"), canvasWidth: 800, canvasHeight: 600, ...unsaved });

    const found = index.findByCanvas(1920, 1080, 60 * 60 * 1000);
    assert.deepEqual(found.map((e) => e.sessionId).sort(), ["newer", "older"]);
    assert.ok(found[0].lastSeen >= found[1].lastSeen, "most recently touched first");
});

test("entries can be forgotten one at a time or by their folder going away", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const kept = path.join(temp.dir, "kept");
    fs.mkdirSync(kept);
    const index = new SessionIndex("run-1");
    index.upsert(indexed("kept", kept));
    index.upsert(indexed("deleted-by-hand", path.join(temp.dir, "gone")));
    index.upsert(indexed("unwanted", kept));

    index.remove("unwanted");
    assert.equal(index.find("unwanted"), null);

    // The index is a cache; the folders on disk are the truth. An entry whose
    // folder the artist deleted in Explorer has to be dropped, not resurrected.
    index.prune();
    assert.equal(index.find("deleted-by-hand"), null);
    assert.ok(index.find("kept"), "the one still on disk stays");
});

test("detaching a document from a session that is not there is not an error", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());

    // Save As detaches the old session as it forks. If the fork already
    // removed it -- two saves in quick succession -- there is nothing to do.
    const index = new SessionIndex("run-1");
    index.detachDocument("never-existed", 7);
});

test("normalising a path that is not there gives nothing to compare", () => {
    assert.equal(normalizePath(""), "");
    assert.equal(normalizePath(null), "");
    assert.equal(normalizePath(undefined), "");
});

/* --------------------------------------------------- config, out of range */

test("a resolution and a frames folder that make no sense are replaced", () => {
    // config.json is a plain file in the user's data directory; people edit it,
    // and a sync client can hand back a half-merged one. Anything the panel
    // could not have produced is replaced rather than acted on.
    const repaired = normalizeConfig({ ...DEFAULT_CONFIG, resolution: "4320", processImageFolderPath: "" });
    assert.equal(repaired.resolution, DEFAULT_CONFIG.resolution);
    assert.ok(repaired.processImageFolderPath.length > 0);

    const noFolder = normalizeConfig({ ...DEFAULT_CONFIG, processImageFolderPath: 42 });
    assert.equal(typeof noFolder.processImageFolderPath, "string");
    assert.ok(noFolder.processImageFolderPath.length > 0);
});

/* ----------------------------------------- a recording with no manifest left */

test("frames without a manifest are still a recording, named after their folder", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    // session.json can be lost to a crash mid-write, and 3.x never wrote one.
    // Everything the panel shows then has to come from the frames themselves.
    const folder = writeSession(temp.dir, "20260101-abc123", { frames: 2, manifest: false });

    const summary = summarizeSession(folder);
    assert.equal(summary.sessionId, "20260101-abc123", "the folder name is the id");
    assert.equal(summary.docName, "20260101-abc123");
    assert.equal(summary.frameCount, 2);
    assert.deepEqual(summary.filePathHistory, [], "no document is known");
    assert.equal(summary.canvasBounds, null);
    assert.equal(summary.timeSpentSec, 0);
    assert.equal(summary.createdAt, 0, "unknown, rather than guessed at");
    assert.equal(summary.lastModifiedAt, 1700000002000, "the last frame is the last we know of");
    assert.equal(summary.format, "jpg");
    assert.equal(summary.resolution, "1080");
    assert.equal(summary.archived, false);
});

test("a manifest written before there was a save history still summarises", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    // A 4.0 session.json has no filePathHistory. Reading one has to give the
    // panel an empty list, not undefined -- everything downstream, from the
    // delete guard to the stale rule, iterates it.
    const folder = writeSession(temp.dir, "20260101-abc123", { frames: 1 });
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, "session.json"), "utf8"));
    delete manifest.filePathHistory;
    fs.writeFileSync(path.join(folder, "session.json"), JSON.stringify(manifest));

    assert.deepEqual(summarizeSession(folder).filePathHistory, []);
});

test("a frame that fails with something that is not an Error is still named in the log", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);
    const from = writeSession(temp.dir, "source", { frames: 1, manifest: false });

    setFault("linkSync", () => {
        throw "the share went away";
    });
    setFault("copyFileSync", () => {
        throw "the share went away";
    });

    const warnings = [];
    const result = await duplicateFrames(from, path.join(temp.dir, "fork"), (level, message) =>
        warnings.push(message)
    );

    assert.equal(result.frameCount, 0);
    assert.match(warnings[0], /Could not duplicate frame .*: the share went away$/);
});

/* ------------------------------------------------------------- index files */

test("an index file that is not a list of entries starts empty", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());

    // The index is a recovery cache, so a damaged one is rebuilt by scanning
    // rather than being a reason the plug-in will not start.
    fs.mkdirSync(path.join(isolated.dir, "F_Record"), { recursive: true });
    fs.writeFileSync(
        path.join(isolated.dir, "F_Record", "index.json"),
        JSON.stringify({ version: 4, entries: "not a list" })
    );

    const index = new SessionIndex("run-1");
    assert.equal(index.find("anything"), null);
    index.upsert({
        sessionId: "s1",
        folder: winPath("C:/frames/s1"),
        documentId: null,
        filePath: null,
        canvasWidth: 0,
        canvasHeight: 0
    });
    assert.ok(index.find("s1"));
});

test("a document recorded twice re-attaches to the more recent take", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());

    // "Start fresh" on a file that already has a recording leaves two entries
    // pointing at the same path. Reopening it has to find the one the artist
    // was last drawing into, not whichever comes first in the file.
    const index = new SessionIndex("run-1");
    const file = winPath("C:/art/dragon.psd");
    const common = { filePath: file };
    index.upsert(indexed("first", winPath("C:/a"), common));

    // Both takes are stamped with Date.now(), and two upserts in one
    // millisecond would leave the answer down to array order.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
        index.upsert(indexed("second", winPath("C:/b"), common));
    } finally {
        Date.now = realNow;
    }

    const found = index.findByFilePath(file);
    assert.ok(found, "one of them matched");
    assert.equal(found.sessionId, "second");
});
