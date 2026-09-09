/**
 * Bulk deleting and packing.
 *
 * Deleting a recording with its document is the one action in the plug-in
 * that touches the artist's own files, so what it refuses matters as much
 * as what it does: a document another recording still belongs to stays, a
 * document the bin would not take keeps its recording, and the take in
 * progress is never in the batch. The bin itself is a stub here; the real
 * one is exercised by hand, since a test that fills the Recycle Bin on every
 * run is not a test anyone wants.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { deleteSessions, freeZipName, planPack, safeFileName } from "../dist/test/housekeeping.mjs";
import { listSessions, writePointer } from "../dist/test/store.mjs";
import { macTrashScript, windowsTrashScript } from "../dist/test/trash.mjs";
import { zipMethodFor } from "../dist/test/zip.mjs";
import { tempDir } from "./helpers.mjs";

function writeSession(root, sessionId, options = {}) {
    const folder = path.join(root, sessionId);
    fs.mkdirSync(folder, { recursive: true });
    const frames = options.frames === undefined ? 3 : options.frames;
    for (let i = 1; i <= frames; i++) {
        const name = String(i).padStart(6, "0") + "_" + (1700000000000 + i * 1000) + ".jpg";
        fs.writeFileSync(path.join(folder, name), "x");
    }
    fs.writeFileSync(
        path.join(folder, "session.json"),
        JSON.stringify({
            version: 4,
            sessionId,
            docName: options.docName || sessionId,
            filePathHistory: options.filePaths || [],
            canvasBounds: null,
            frameCount: frames,
            timeSpentSec: 10,
            createdAt: 1,
            lastModifiedAt: 2,
            format: "jpg",
            resolution: "1080",
            nextSeq: frames + 1
        })
    );
    return folder;
}

function setup() {
    const temp = tempDir();
    const root = path.join(temp.dir, "processImages");
    fs.mkdirSync(root, { recursive: true });
    const art = path.join(temp.dir, "art");
    fs.mkdirSync(art, { recursive: true });
    const psd = (name) => {
        const file = path.join(art, name);
        fs.writeFileSync(file, "psd " + name);
        return file;
    };
    return { temp, root, art, psd };
}

/** A bin that remembers what it was given and refuses what it is told to. */
function fakeTrash(refusing = []) {
    const calls = [];
    const trash = async (files) => {
        calls.push(files.slice());
        const failed = [];
        for (const file of files) {
            if (refusing.some((r) => file.endsWith(r))) {
                failed.push({ file, error: "in use" });
            } else {
                fs.unlinkSync(file);
            }
        }
        return { failed };
    };
    return { trash, calls };
}

const allow = () => null;

/* ---------------------------------------------------------------- delete */

test("deletes several recordings at once, with the document when asked", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    const a = s.psd("a.psd");
    const b = s.psd("b.psd");
    writeSession(s.root, "s-a", { docName: "a", filePaths: [a] });
    writeSession(s.root, "s-b", { docName: "b", filePaths: [b] });
    writeSession(s.root, "s-c", { docName: "c" });
    const bin = fakeTrash();

    const outcome = await deleteSessions(
        s.root,
        [
            { sessionId: "s-a", withDocument: true },
            { sessionId: "s-b", withDocument: false },
            { sessionId: "s-c", withDocument: true }
        ],
        listSessions(s.root),
        bin.trash,
        allow
    );

    assert.deepEqual(outcome.deleted, ["s-a", "s-b", "s-c"]);
    assert.deepEqual(outcome.warnings, []);
    assert.deepEqual(bin.calls, [[a]], "one call to the bin, only for the document that was asked for");
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), true, "b's document was not asked for");
    assert.deepEqual(listSessions(s.root), []);
});

test("a document another recording still belongs to is kept, and said so", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    const shared = s.psd("shared.psd");
    // The same file recorded twice: once, then again after "start fresh".
    writeSession(s.root, "s-old", { docName: "shared", filePaths: [shared] });
    writeSession(s.root, "s-new", { docName: "shared (again)", filePaths: [shared] });
    const bin = fakeTrash();

    const one = await deleteSessions(
        s.root,
        [{ sessionId: "s-old", withDocument: true }],
        listSessions(s.root),
        bin.trash,
        allow
    );
    assert.deepEqual(one.deleted, ["s-old"], "the recording goes");
    assert.equal(fs.existsSync(shared), true, "the file stays");
    assert.deepEqual(bin.calls, [], "the bin was not even asked");
    assert.equal(one.warnings.length, 1);
    assert.match(one.warnings[0], /kept .*shared\.psd, which 'shared \(again\)' also belongs to/);

    // Both going together: nothing else claims the file, so it goes too.
    writeSession(s.root, "s-old", { docName: "shared", filePaths: [shared] });
    const both = await deleteSessions(
        s.root,
        [
            { sessionId: "s-old", withDocument: true },
            { sessionId: "s-new", withDocument: true }
        ],
        listSessions(s.root),
        bin.trash,
        allow
    );
    assert.deepEqual(both.deleted, ["s-old", "s-new"]);
    assert.deepEqual(both.warnings, []);
    assert.deepEqual(bin.calls, [[shared]], "asked once for the one file");
    assert.equal(fs.existsSync(shared), false);
});

test("a document the bin refuses keeps its recording; the rest of the batch goes", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    const stuck = s.psd("stuck.psd");
    const fine = s.psd("fine.psd");
    writeSession(s.root, "s-stuck", { docName: "stuck", filePaths: [stuck] });
    writeSession(s.root, "s-fine", { docName: "fine", filePaths: [fine] });
    const bin = fakeTrash(["stuck.psd"]);

    const outcome = await deleteSessions(
        s.root,
        [
            { sessionId: "s-stuck", withDocument: true },
            { sessionId: "s-fine", withDocument: true }
        ],
        listSessions(s.root),
        bin.trash,
        allow
    );
    assert.deepEqual(outcome.deleted, ["s-fine"]);
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0], /stuck: kept, .*stuck\.psd could not be sent to the Recycle Bin \(in use\)/);
    assert.ok(fs.existsSync(path.join(s.root, "s-stuck", "session.json")), "the recording is still there");
    assert.equal(fs.existsSync(fine), false);
});

test("a bin that fails outright keeps every recording it was to go with", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    const a = s.psd("a.psd");
    writeSession(s.root, "s-a", { docName: "a", filePaths: [a] });
    writeSession(s.root, "s-b", { docName: "b" });

    const outcome = await deleteSessions(
        s.root,
        [
            { sessionId: "s-a", withDocument: true },
            { sessionId: "s-b", withDocument: true }
        ],
        listSessions(s.root),
        async () => {
            throw new Error("powershell.exe not found");
        },
        allow
    );
    assert.deepEqual(outcome.deleted, ["s-b"], "b had no document to lose, so it went");
    assert.match(outcome.warnings[0], /a: kept, .*powershell\.exe not found/);
    assert.ok(fs.existsSync(a));
    assert.ok(fs.existsSync(path.join(s.root, "s-a")));
});

test("whatever the caller refuses is skipped by name, not silently", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    writeSession(s.root, "s-live", { docName: "live" });
    writeSession(s.root, "s-done", { docName: "done" });
    const bin = fakeTrash();

    const outcome = await deleteSessions(
        s.root,
        [
            { sessionId: "s-live", withDocument: false },
            { sessionId: "s-done", withDocument: false },
            { sessionId: "s-never", withDocument: true }
        ],
        listSessions(s.root),
        bin.trash,
        (id) => (id === "s-live" ? "in progress" : null)
    );
    assert.deepEqual(outcome.deleted, ["s-done"]);
    assert.deepEqual(outcome.warnings.slice(0, 1), ["live: in progress"]);
    assert.match(outcome.warnings[1], /s-never: .*not a F_Record session folder/, "one that never existed is refused by the store");
    assert.ok(fs.existsSync(path.join(s.root, "s-live")));
});

test("a recording whose pointer leads nowhere can be deleted in a batch too", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    writePointer(s.root, "s-gone", path.join(s.art, "nowhere_frames"));
    const outcome = await deleteSessions(
        s.root,
        [{ sessionId: "s-gone", withDocument: true }],
        listSessions(s.root),
        fakeTrash().trash,
        allow
    );
    assert.deepEqual(outcome.deleted, ["s-gone"]);
    assert.deepEqual(listSessions(s.root), []);
});

/* ------------------------------------------------------------------ pack */

test("a pack plan puts the document at the top and the frames in a folder named after it", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    const dragon = s.psd("dragon.psd");
    const folder = writeSession(s.root, "s-d", { docName: "dragon", filePaths: [dragon], frames: 2 });
    fs.mkdirSync(path.join(folder, "notes"));
    fs.writeFileSync(path.join(folder, "notes", "palette.txt"), "colours");
    const out = path.join(s.temp.dir, "zips");

    const plan = planPack(s.root, "s-d", out);
    assert.equal(plan.zip, path.join(out, "dragon.zip"));
    assert.equal(plan.document, dragon);
    assert.deepEqual(
        plan.entries.map((e) => e.name).sort(),
        [
            "dragon.psd",
            "dragon_frames/000001_1700000001000.jpg",
            "dragon_frames/000002_1700000002000.jpg",
            "dragon_frames/notes/palette.txt",
            "dragon_frames/session.json"
        ].sort()
    );
    assert.equal(plan.entries[0].source, dragon);
    assert.equal(zipMethodFor(plan.entries[0].name), "deflate");
});

test("a recording that was never saved is packed under its title, made safe", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    writeSession(s.root, "s-u", { docName: "Untitled-1", frames: 1 });
    const plan = planPack(s.root, "s-u", s.art);
    assert.equal(plan.document, null);
    assert.equal(plan.zip, path.join(s.art, "Untitled-1.zip"));
    assert.deepEqual(
        plan.entries.map((e) => e.name).sort(),
        ["Untitled-1_frames/000001_1700000001000.jpg", "Untitled-1_frames/session.json"]
    );
});

test("a document whose path has moved on since is still found through its history", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    const first = s.psd("first.psd");
    writeSession(s.root, "s-h", { docName: "second", filePaths: [first, path.join(s.art, "second.psd")] });
    const plan = planPack(s.root, "s-h", s.art);
    assert.equal(plan.document, first, "the newest path that is still on disk");
    assert.equal(plan.zip, path.join(s.art, "first.zip"), "and the zip is named after that file");
});

test("a carried-off recording is packed from where it lives", async (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    const beside = path.join(s.art, "piece_frames");
    fs.mkdirSync(beside);
    fs.writeFileSync(path.join(beside, "session.json"), JSON.stringify({ sessionId: "s-m", docName: "piece", filePathHistory: [] }));
    fs.writeFileSync(path.join(beside, "000001_1700000001000.jpg"), "x");
    writePointer(s.root, "s-m", beside);
    const plan = planPack(s.root, "s-m", s.temp.dir);
    assert.equal(plan.entries[0].source, path.join(beside, "000001_1700000001000.jpg"));
});

test("zip names step aside from what is already there, part files included", (t) => {
    const s = setup();
    t.after(() => s.temp.cleanup());
    assert.equal(freeZipName(s.art, "piece"), path.join(s.art, "piece.zip"));
    fs.writeFileSync(path.join(s.art, "piece.zip"), "");
    assert.equal(freeZipName(s.art, "piece"), path.join(s.art, "piece_2.zip"));
    fs.writeFileSync(path.join(s.art, "piece_2.zip.part"), "");
    assert.equal(freeZipName(s.art, "piece"), path.join(s.art, "piece_3.zip"));
});

test("titles become file names without the characters Windows refuses", () => {
    assert.equal(safeFileName("Untitled-1"), "Untitled-1");
    assert.equal(safeFileName("dragon.psd"), "dragon", "an extension is dropped");
    assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
    assert.equal(safeFileName(" .hidden. "), "hidden");
    assert.equal(safeFileName(""), "");
});

/* ----------------------------------------------------------------- trash */

test("the Windows script quotes paths for PowerShell and never confirms or shows an error box", () => {
    const script = windowsTrashScript(["C:\\art\\it's.psd", "D:\\b.psd"]);
    assert.ok(script.indexOf("'C:\\art\\it''s.psd', 'D:\\b.psd'") !== -1, "single quotes are doubled");
    assert.ok(script.indexOf("0x0004 | 0x0010 | 0x0040 | 0x0400") !== -1, "silent, no confirmation, undo, no error UI");
    assert.ok(script.indexOf("-NonInteractive") === -1, "the flags are the caller's; the script only prints");
    assert.ok(script.indexOf("F_RECORD_FAIL") !== -1, "failures are reported per file");
});

test("the macOS script escapes quotes and asks the Finder, which is what puts things in the Trash", () => {
    const script = macTrashScript(['/Users/a/say "hi".psd', "/Users/a/b.psd"]);
    assert.equal(
        script,
        'tell application "Finder" to delete {POSIX file "/Users/a/say \\"hi\\".psd" as alias, POSIX file "/Users/a/b.psd" as alias}'
    );
});
