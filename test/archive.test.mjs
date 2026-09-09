/**
 * Archiving a recording, and carrying its folder beside its document.
 *
 * Both exist for the same reason: an artist with a hundred recordings wants
 * the finished ones out of the way, ideally sitting next to the PSD they
 * belong to. The folder leaving the frames folder is the part that can go
 * wrong -- every lookup used to assume `<root>/<sessionId>` -- so this pins
 * down that a carried-off recording is still listed, still found when its
 * document is reopened, still deleted cleanly, and never silently lost.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
    SessionIndex,
    chooseDocumentSideFolder,
    copyFolderThenDelete,
    deleteSession,
    listSessions,
    locateSession,
    markArchived,
    moveFolder,
    readManifest,
    summarizeSession,
    writePointer
} from "../dist/test/store.mjs";
import { SessionResolver } from "../dist/test/session.mjs";
import { MOVED_POINTER_SUFFIX, documentSideFolder, sessionPointerPath } from "../dist/test/paths.mjs";
import { tempDir } from "./helpers.mjs";

const BOUNDS = { top: 0, left: 0, right: 2000, bottom: 1500 };

/** A recording as the generator would have left it on disk. */
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
            filePathHistory: options.filePath ? [options.filePath] : [],
            canvasBounds: BOUNDS,
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

function setupRoot() {
    const temp = tempDir();
    const root = path.join(temp.dir, "processImages");
    fs.mkdirSync(root, { recursive: true });
    const art = path.join(temp.dir, "art");
    fs.mkdirSync(art, { recursive: true });
    const psd = path.join(art, "dragon.psd");
    fs.writeFileSync(psd, "psd");
    return { temp, root, art, psd };
}

/* ----------------------------------------------------------------- archive */

test("archiving is a flag in the manifest, and the listing reports it", (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    const folder = writeSession(s.root, "a-1");

    assert.equal(summarizeSession(folder).archived, false, "old manifests without the flag are not archived");

    markArchived(folder, true);
    assert.equal(summarizeSession(folder).archived, true);
    assert.equal(listSessions(s.root)[0].archived, true);
    assert.equal(typeof readManifest(folder).archivedAt, "number", "when it happened is kept");

    markArchived(folder, false);
    const manifest = readManifest(folder);
    assert.equal("archived" in manifest, false, "cleared means absent, as on a manifest never archived");
    assert.equal(listSessions(s.root)[0].archived, false);
});

/* -------------------------------------------------------------------- move */

test("a folder carried beside its document is still listed, located and deleted", async (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    const home = writeSession(s.root, "m-1", { filePath: s.psd, docName: "dragon" });

    const to = chooseDocumentSideFolder(s.psd, "m-1");
    assert.equal(to, path.join(s.art, "dragon_frames"), "named after the file, not the session");
    assert.equal(to, documentSideFolder(s.psd));

    await moveFolder(home, to);
    writePointer(s.root, "m-1", to);

    assert.equal(fs.existsSync(home), false, "nothing left at home but the pointer");
    assert.ok(fs.existsSync(sessionPointerPath(s.root, "m-1")));
    assert.equal(locateSession(s.root, "m-1"), to, "found through the pointer");

    const listed = listSessions(s.root);
    assert.equal(listed.length, 1, "listed exactly once");
    assert.equal(listed[0].folder, to);
    assert.equal(listed[0].frameCount, 3, "with its frames");
    assert.equal(listed[0].besideDocument, true);

    deleteSession(s.root, "m-1");
    assert.equal(fs.existsSync(to), false, "the carried-off folder is what gets deleted");
    assert.equal(fs.existsSync(sessionPointerPath(s.root, "m-1")), false, "and the pointer with it");
    assert.deepEqual(listSessions(s.root), []);
});

test("sessions at home report that they are, and a pointer beside a home folder defers to home", async (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    const home = writeSession(s.root, "h-1");
    assert.equal(listSessions(s.root)[0].besideDocument, false);

    // A stale pointer left behind by, say, a move back that crashed between
    // the rename and the pointer's removal.
    writePointer(s.root, "h-1", path.join(s.art, "elsewhere"));
    assert.equal(locateSession(s.root, "h-1"), home);
    assert.equal(listSessions(s.root).length, 1, "not listed twice");
});

test("a pointer whose folder is gone is listed with an error, not dropped, and can be deleted", (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    const missing = path.join(s.art, "dragon_frames");
    writePointer(s.root, "gone-1", missing);

    const listed = listSessions(s.root);
    assert.equal(listed.length, 1, "the artist is told rather than left wondering");
    assert.equal(listed[0].sessionId, "gone-1");
    assert.equal(listed[0].frameCount, 0);
    assert.ok(listed[0].error.indexOf(missing) !== -1, "the error says where it was last seen");
    assert.equal(locateSession(s.root, "gone-1"), null);

    deleteSession(s.root, "gone-1");
    assert.equal(fs.existsSync(sessionPointerPath(s.root, "gone-1")), false);
    assert.deepEqual(listSessions(s.root), []);
});

test("a pointer at a folder holding some other recording is not believed, and never deleted through", (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    // Someone else's folder at the address a stale pointer names.
    const other = path.join(s.art, "dragon_frames");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(
        path.join(other, "session.json"),
        JSON.stringify({ version: 4, sessionId: "other-9", docName: "other", filePathHistory: [] })
    );
    writePointer(s.root, "mine-1", other);

    assert.equal(locateSession(s.root, "mine-1"), null, "a manifest with a different id is not ours");
    deleteSession(s.root, "mine-1");
    assert.ok(fs.existsSync(path.join(other, "session.json")), "the other recording is untouched");
    assert.equal(fs.existsSync(sessionPointerPath(s.root, "mine-1")), false, "only the pointer goes");
});

test("deleting something that is neither a folder nor a pointer is refused", (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    assert.throws(() => deleteSession(s.root, "never-was"), /not a F_Record session folder/);
});

test("chooseDocumentSideFolder steps aside from a folder that is not this recording", (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    const wanted = documentSideFolder(s.psd);

    fs.mkdirSync(wanted, { recursive: true });
    fs.writeFileSync(path.join(wanted, "notes.txt"), "the artist's own folder");
    assert.equal(chooseDocumentSideFolder(s.psd, "m-2"), wanted + "_2", "never overwrites what is there");

    fs.writeFileSync(path.join(wanted, "session.json"), JSON.stringify({ sessionId: "m-2" }));
    assert.equal(chooseDocumentSideFolder(s.psd, "m-2"), wanted, "unless it is this recording already");
});

test("the copy path carries every file, nested ones included, and leaves nothing behind", async (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    const from = writeSession(s.root, "c-1", { frames: 70 });
    fs.mkdirSync(path.join(from, "notes"));
    fs.writeFileSync(path.join(from, "notes", "palette.txt"), "colours");
    const to = path.join(s.art, "dragon_frames");

    const progress = [];
    await copyFolderThenDelete(from, to, (done, total) => progress.push([done, total]));

    assert.equal(fs.existsSync(from), false, "the source is gone once everything has arrived");
    assert.equal(fs.readdirSync(to).filter((f) => f.endsWith(".jpg")).length, 70);
    assert.equal(fs.readFileSync(path.join(to, "notes", "palette.txt"), "utf8"), "colours");
    assert.equal(fs.existsSync(to + ".moving"), false, "the staging folder is renamed away");
    assert.deepEqual(progress[progress.length - 1], [72, 72], "progress counts every file");
    assert.equal(listSessions(s.root).length, 0, "with no pointer written yet, the caller's job, it is not listed");
});

test("a copy that fails leaves the source untouched and no half-carried folder", async (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    const from = writeSession(s.root, "c-2", { frames: 5 });
    const to = path.join(s.art, "dragon_frames");
    // Something already at the destination makes the final rename fail.
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, "keep.txt"), "mine");

    await assert.rejects(copyFolderThenDelete(from, to));

    assert.equal(fs.readdirSync(from).filter((f) => f.endsWith(".jpg")).length, 5, "source intact");
    assert.equal(fs.existsSync(to + ".moving"), false, "staging cleaned up");
    assert.equal(fs.readFileSync(path.join(to, "keep.txt"), "utf8"), "mine", "destination untouched");
});

test("moveFolder refuses to land on something that already exists", async (t) => {
    const s = setupRoot();
    t.after(() => s.temp.cleanup());
    const from = writeSession(s.root, "c-3");
    const to = path.join(s.art, "dragon_frames");
    fs.mkdirSync(to, { recursive: true });
    await assert.rejects(moveFolder(from, to), /already exists/);
    assert.ok(fs.existsSync(from));
});

/* ---------------------------------------------------------------- resolver */

/** Stand-in for Photoshop's generatorSettings storage, as in session.test.mjs. */
function makePhotoshop() {
    const stored = new Map();
    const open = new Set();
    let active = null;
    return {
        setActive(id) {
            active = id;
            open.add(id);
        },
        wipeSettings(id) {
            stored.delete(id);
        },
        gateway: {
            async getDocumentSettings(documentId) {
                const value = stored.get(documentId);
                if (value === undefined) {
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
            },
            async isDocumentOpen(documentId) {
                return open.has(documentId);
            }
        }
    };
}

function setupResolver() {
    const s = setupRoot();
    const config = {
        enabled: true,
        autoStart: false,
        autoStartNewDocuments: true,
        processImageFolderPath: s.root,
        resolution: "1080",
        quality: 70,
        idleTimeoutMinutes: 1,
        minIntervalMs: 1500,
        minCanvasPixels: 0,
        language: "en",
        format: "jpg"
    };
    const ps = makePhotoshop();
    const index = new SessionIndex("run-1");
    const resolver = new SessionResolver(ps.gateway, index, () => {});
    return { ...s, config, ps, index, resolver };
}

/** What the generator does once a move has landed. */
function recordMove(s, sessionId, to) {
    writePointer(s.root, sessionId, to);
    const entry = s.index.find(sessionId);
    entry.folder = to;
    s.index.persist();
}

test("reopening a document whose recording was carried beside it continues in the carried folder", async (t) => {
    const s = setupResolver();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: s.psd, bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;
    const home = first.session.folder;
    for (let i = 1; i <= 4; i++) {
        fs.writeFileSync(path.join(home, String(i).padStart(6, "0") + "_" + (1700000000000 + i) + ".jpg"), "x");
    }

    const to = chooseDocumentSideFolder(s.psd, sessionId);
    await moveFolder(home, to);
    recordMove(s, sessionId, to);

    // Closed and reopened later, with the PSD's own copy of the id wiped so
    // the file path is what has to find it.
    s.resolver.forgetDocument(1);
    s.ps.wipeSettings(1);
    s.ps.setActive(2);
    const again = await s.resolver.resolve({ id: 2, file: s.psd, bounds: BOUNDS }, s.config, true);

    assert.equal(again.session.sessionId, sessionId, "the same recording, not a fresh folder");
    assert.equal(again.session.folder, to, "and it is recorded into where it is now");
    assert.equal(again.session.manifest.frameCount, 4, "with its frames found there");
    assert.equal(fs.existsSync(home), false, "nothing was recreated at the old address");
    assert.ok(fs.existsSync(path.join(to, "session.json")));
});

test("a carried-off recording is still offered to a new canvas of the same size", async (t) => {
    const s = setupResolver();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: s.psd, bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;
    fs.writeFileSync(path.join(first.session.folder, "000001_1700000000001.jpg"), "x");

    const to = chooseDocumentSideFolder(s.psd, sessionId);
    await moveFolder(first.session.folder, to);
    recordMove(s, sessionId, to);
    s.resolver.forgetDocument(1);

    s.ps.setActive(2);
    const outcome = await s.resolver.resolve({ id: 2, file: "Untitled-3", bounds: BOUNDS }, s.config, false);
    assert.equal(outcome.session, null);
    assert.equal(outcome.candidates.length, 1, "offered despite living beside its document");
    assert.equal(outcome.candidates[0].sessionId, sessionId);
    assert.equal(outcome.candidates[0].folder, to);
});

test("a recording whose pointer leads nowhere counts as gone, so the document gets a fresh one", async (t) => {
    const s = setupResolver();
    t.after(() => s.temp.cleanup());

    s.ps.setActive(1);
    const first = await s.resolver.resolve({ id: 1, file: s.psd, bounds: BOUNDS }, s.config, true);
    const sessionId = first.session.sessionId;
    fs.rmSync(first.session.folder, { recursive: true, force: true });
    writePointer(s.root, sessionId, path.join(s.art, "deleted_by_hand" + MOVED_POINTER_SUFFIX));

    s.resolver.forgetDocument(1);
    s.ps.wipeSettings(1);
    s.ps.setActive(2);
    const again = await s.resolver.resolve({ id: 2, file: s.psd, bounds: BOUNDS }, s.config, true);
    assert.notEqual(again.session.sessionId, sessionId);
    assert.equal(again.session.isNew, true);
});
