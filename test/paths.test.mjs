/**
 * The on-disk layout.
 *
 * Every path the plug-in touches is derived here rather than assembled at the
 * call site, so this is the one place that decides what a recording folder is
 * called and where the data directory lives. The tests are about the shape of
 * those names -- a session folder that is self-describing, a frame name that
 * carries its own ordering and timing -- because that shape is what lets a
 * folder be moved to another machine and still make sense.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";

import {
    APP_DIR_NAME,
    MOVED_POINTER_SUFFIX,
    SESSION_MANIFEST_NAME,
    appDir,
    bridgePath,
    clipboardTempDir,
    configPath,
    defaultProcessImageFolder,
    documentSideFolder,
    exportTempDir,
    frameFileName,
    generatorLogPath,
    indexPath,
    logDir,
    parseFrameFileName,
    parseFrameList,
    parseLegacyFrameFileName,
    sessionFolder,
    sessionManifestPath,
    sessionPointerPath
} from "../dist/modules/paths.mjs";
import { withIsolatedAppDir } from "./helpers.mjs";

/* ------------------------------------------------------------ data directory */

test("everything the plug-in owns lives under one named folder in the user's data directory", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());

    const root = appDir();
    assert.equal(path.basename(root), APP_DIR_NAME);

    // One folder to back up, one folder to delete: every derived path has to
    // stay inside it, or "uninstall" and "where did my recordings go" both
    // become questions with more than one answer.
    const derived = {
        config: configPath(),
        bridge: bridgePath(),
        index: indexPath(),
        logs: logDir(),
        log: generatorLogPath(),
        exportTemp: exportTempDir(),
        clipboardTemp: clipboardTempDir(),
        frames: defaultProcessImageFolder()
    };
    for (const [name, target] of Object.entries(derived)) {
        assert.equal(
            target.slice(0, root.length + 1),
            root + path.sep,
            name + " escaped the data directory: " + target
        );
    }

    assert.equal(path.basename(derived.config), "config.json");
    assert.equal(path.basename(derived.bridge), "bridge.json");
    assert.equal(path.basename(derived.index), "index.json");
    assert.equal(path.basename(derived.log), "generator.log");
    assert.equal(path.dirname(derived.log), derived.logs, "the log sits in the log directory");
});

test("the scratch directories are siblings, not one inside the other", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());

    // A finished export empties exportTemp wholesale. If the clipboard's
    // scratch file lived in a corner of it, the two would have to be careful
    // about each other for no gain.
    assert.notEqual(exportTempDir(), clipboardTempDir());
    assert.equal(
        clipboardTempDir().indexOf(exportTempDir() + path.sep),
        -1,
        "the clipboard scratch is not inside the export scratch"
    );
});

test("the data directory follows APPDATA, which is what keeps tests off the real recordings", (t) => {
    const isolated = withIsolatedAppDir();
    t.after(() => isolated.cleanup());

    // withIsolatedAppDir works by pointing APPDATA/HOME at a temp folder; if
    // appDir stopped reading them, every test that writes frames would start
    // writing them into the user's own F_Record folder instead.
    const home = process.platform === "win32" ? process.env.APPDATA : os.homedir();
    assert.equal(appDir().indexOf(home), 0, "rooted at " + home + ", got " + appDir());
});

/* --------------------------------------------------------------- sessions */

test("a session folder is the session id under the frames root", () => {
    const folder = sessionFolder("C:\\frames", "20260101-abc123");
    assert.equal(folder, path.join("C:\\frames", "20260101-abc123"));
    assert.equal(sessionManifestPath(folder), path.join(folder, SESSION_MANIFEST_NAME));
    assert.equal(SESSION_MANIFEST_NAME, "session.json");
});

test("a moved recording leaves a pointer named after the session it left", () => {
    const pointer = sessionPointerPath("C:\\frames", "20260101-abc123");
    assert.equal(pointer, path.join("C:\\frames", "20260101-abc123" + MOVED_POINTER_SUFFIX));

    // The pointer is the fallback the index is only a cache of: it has to be
    // findable by scanning the frames root, so the session id must be the
    // whole of the name in front of the suffix.
    assert.equal(path.basename(pointer).slice(0, -MOVED_POINTER_SUFFIX.length), "20260101-abc123");
});

test("the folder beside a document is named after the document, not the session", () => {
    // `C:\art\dragon.psd` -> `C:\art\dragon_frames`, so the two read as a pair
    // in Explorer. That pairing is the whole point of carrying the folder
    // over, so the session id must not appear in the name.
    assert.equal(documentSideFolder(path.join("C:\\art", "dragon.psd")), path.join("C:\\art", "dragon_frames"));
    assert.equal(documentSideFolder(path.join("/home/a", "dragon.psb")), path.join("/home/a", "dragon_frames"));
});

test("only the last extension is dropped, and a document without one still works", () => {
    assert.equal(
        documentSideFolder(path.join("C:\\art", "dragon.v2.psd")),
        path.join("C:\\art", "dragon.v2_frames"),
        "a version number in the name is part of the name"
    );
    assert.equal(
        documentSideFolder(path.join("C:\\art", "untitled")),
        path.join("C:\\art", "untitled_frames")
    );
});

/* ----------------------------------------------------------- frame naming */

test("frame names round-trip and sort by sequence", () => {
    const name = frameFileName(42, 1700000000123);
    assert.equal(name, "000042_1700000000123.jpg");

    const parsed = parseFrameFileName(name);
    assert.deepEqual(parsed, { seq: 42, timestampMs: 1700000000123, fileName: name });
});

test("a fractional timestamp is floored, and the extension can be overridden", () => {
    // The name is the only record of when the frame was taken, and the
    // exporter parses it back with parseInt; a decimal point in the middle of
    // the name would make the frame unreadable rather than merely imprecise.
    assert.equal(frameFileName(1, 1700000000123.75), "000001_1700000000123.jpg");
    assert.equal(frameFileName(1, 1700000000123, "jpeg"), "000001_1700000000123.jpeg");
});

test("frame parsing rejects anything that is not one of ours", () => {
    assert.equal(parseFrameFileName("session.json"), null);
    assert.equal(parseFrameFileName("000042.jpg"), null, "3.x naming is handled separately");
    assert.equal(parseFrameFileName("000042_123.jpg"), null, "too short to be an epoch timestamp");
    assert.equal(parseFrameFileName("000042_1700000000123.jpg.part"), null, "half-written frame");
    assert.equal(parseFrameFileName("notes.txt"), null);
    assert.equal(parseFrameFileName("00042_1700000000123.jpg"), null, "five digits is not our padding");
});

test("parseFrameList orders by sequence, not by string, and drops strangers", () => {
    const frames = parseFrameList([
        "000010_1700000010000.jpg",
        "session.json",
        "000002_1700000002000.jpg",
        "000001_1700000001000.jpg",
        "random.png"
    ]);
    assert.deepEqual(frames.map((f) => f.seq), [1, 2, 10]);
});

test("two frames that share a sequence fall back to the timestamp", () => {
    // A duplicated sequence should not happen, but a folder that was merged by
    // hand can hold one; leaving the order down to Array.sort's stability
    // would put the later frame first half the time.
    const frames = parseFrameList(["000007_1700000009000.jpg", "000007_1700000002000.jpg"]);
    assert.deepEqual(frames.map((f) => f.timestampMs), [1700000002000, 1700000009000]);
});

test("sequence numbers past 999999 still sort correctly by number", () => {
    // Lexical order would put 1000000 before 999999; parseFrameList sorts on
    // the parsed integer, so a very long recording stays in order.
    const frames = parseFrameList(["1000000_1700000002000.jpg", "999999_1700000001000.jpg"]);
    assert.deepEqual(frames.map((f) => f.seq), [999999, 1000000]);
});

test("legacy 3.x frame names are still recognised so old recordings export", () => {
    assert.deepEqual(parseLegacyFrameFileName("000123.jpg"), {
        seq: 123,
        timestampMs: 0,
        fileName: "000123.jpg"
    });
    assert.deepEqual(parseLegacyFrameFileName("000123.JPEG"), {
        seq: 123,
        timestampMs: 0,
        fileName: "000123.JPEG"
    });
    assert.equal(parseLegacyFrameFileName("000123_1700000000000.jpg"), null);
    assert.equal(parseLegacyFrameFileName("thumbnail.png"), null);
});
