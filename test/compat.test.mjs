/**
 * The Node compatibility layer.
 *
 * The regression this exists for: 3.x called `fs.rmSync` (Node 14.14+) from the
 * CEP panel, whose Node is 8.6 on Photoshop 2020 and 12.3 on 2021. Export threw
 * outright on both. Everything here is either feature-detected or written
 * against Node 6-era APIs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
    exists,
    isDirectory,
    mkdirp,
    rmrf,
    writeFileAtomic,
    readJson,
    writeJsonAtomic,
    assign,
    pad,
    timeStampString,
    randomHex,
    nodeVersionInfo
} from "../dist/test/compat.mjs";
import { frameFileName, parseFrameFileName, parseFrameList, parseLegacyFrameFileName } from "../dist/test/paths.mjs";
import { tempDir } from "./helpers.mjs";

test("mkdirp creates nested directories and is idempotent", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const deep = path.join(temp.dir, "a", "b", "c");
    mkdirp(deep);
    assert.equal(isDirectory(deep), true);
    mkdirp(deep); // must not throw on an existing path
    assert.equal(isDirectory(deep), true);
});

test("rmrf removes a populated tree and tolerates a missing one", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const tree = path.join(temp.dir, "session");
    mkdirp(path.join(tree, "nested"));
    fs.writeFileSync(path.join(tree, "a.jpg"), "x");
    fs.writeFileSync(path.join(tree, "nested", "b.jpg"), "y");

    rmrf(tree);
    assert.equal(exists(tree), false);

    rmrf(tree); // already gone: still must not throw
    rmrf(path.join(temp.dir, "never-existed"));
});

test("rmrf deletes a plain file too", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const file = path.join(temp.dir, "one.txt");
    fs.writeFileSync(file, "x");
    rmrf(file);
    assert.equal(exists(file), false);
});

test("the compat layer reports which modern APIs it found", () => {
    // On this Node everything is available; the point is that the flags exist
    // and are booleans, so the fallbacks are selected by detection rather than
    // by hoping.
    assert.equal(typeof nodeVersionInfo.hasRm, "boolean");
    assert.equal(typeof nodeVersionInfo.hasRecursiveMkdir, "boolean");
    assert.equal(typeof nodeVersionInfo.hasRecursiveRmdir, "boolean");
    assert.ok(nodeVersionInfo.major > 0);
});

test("writeFileAtomic replaces the file and leaves no temp files behind", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const target = path.join(temp.dir, "config.json");
    writeFileAtomic(target, "first");
    assert.equal(fs.readFileSync(target, "utf8"), "first");

    writeFileAtomic(target, "second");
    assert.equal(fs.readFileSync(target, "utf8"), "second");

    // 3.x used write-file-atomic, which littered the data directory with
    // `config.json.<pid><random>` files that the panel then had to sweep up.
    assert.deepEqual(fs.readdirSync(temp.dir), ["config.json"]);
});

test("writeFileAtomic creates missing parent directories", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const target = path.join(temp.dir, "x", "y", "z.json");
    writeFileAtomic(target, "{}");
    assert.equal(fs.readFileSync(target, "utf8"), "{}");
});

test("readJson returns the fallback for missing, malformed, and non-object files", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const fallback = { ok: true };
    assert.deepEqual(readJson(path.join(temp.dir, "nope.json"), fallback), fallback);

    const broken = path.join(temp.dir, "broken.json");
    fs.writeFileSync(broken, "{not json");
    assert.deepEqual(readJson(broken, fallback), fallback);

    const scalar = path.join(temp.dir, "scalar.json");
    fs.writeFileSync(scalar, "42");
    assert.deepEqual(readJson(scalar, fallback), fallback);

    const good = path.join(temp.dir, "good.json");
    writeJsonAtomic(good, { a: 1 });
    assert.deepEqual(readJson(good, fallback), { a: 1 });
});

test("assign copies own keys and skips null sources", () => {
    assert.deepEqual(assign({ a: 1 }, { b: 2 }, null, undefined, { a: 3 }), { a: 3, b: 2 });
});

test("pad and timeStampString produce sortable, filesystem-safe strings", () => {
    assert.equal(pad(7, 3), "007");
    assert.equal(pad(1234, 2), "1234");
    const stamp = timeStampString(new Date(2026, 0, 2, 3, 4, 5, 6));
    assert.equal(stamp, "2026-01-02-03-04-05-006");
    assert.equal(/[\\/:*?"<>|]/.test(stamp), false, "safe as a folder name");
});

test("randomHex returns the requested number of bytes", () => {
    assert.equal(randomHex(4).length, 8);
    assert.match(randomHex(8), /^[0-9a-f]{16}$/);
});

/* ------------------------------------------------------------ frame names */

test("frame names round-trip and sort by sequence", () => {
    const name = frameFileName(42, 1700000000123);
    assert.equal(name, "000042_1700000000123.jpg");

    const parsed = parseFrameFileName(name);
    assert.deepEqual(parsed, { seq: 42, timestampMs: 1700000000123, fileName: name });
});

test("frame parsing rejects anything that is not one of ours", () => {
    assert.equal(parseFrameFileName("session.json"), null);
    assert.equal(parseFrameFileName("000042.jpg"), null, "3.x naming is handled separately");
    assert.equal(parseFrameFileName("000042_123.jpg"), null, "too short to be an epoch timestamp");
    assert.equal(parseFrameFileName("000042_1700000000123.jpg.part"), null, "half-written frame");
    assert.equal(parseFrameFileName("notes.txt"), null);
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
    assert.equal(parseLegacyFrameFileName("000123_1700000000000.jpg"), null);
});
