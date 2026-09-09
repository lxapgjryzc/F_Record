/**
 * The Node compatibility layer.
 *
 * The regression this exists for: 3.x called `fs.rmSync` (Node 14.14+) from the
 * CEP panel, whose Node is 8.6 on Photoshop 2020 and 12.3 on 2021. Export threw
 * outright on both. Everything here is either feature-detected or written
 * against Node 6-era APIs.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { asPlatform, fsError, mockBuiltins, tempDir, withEnv, withFault } from "./helpers.mjs";

// Imported through a swappable `fs` so the "the disk refused" paths below can
// be reached at all; with no fault set it is the real filesystem.
mockBuiltins(mock, "fs");
const {
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
    nodeVersionInfo,
    describeNodeCompat,
    duplicateFile,
    copyFile,
    getUserDataDir
} = await import("../dist/modules/compat.mjs");

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

test("exists and isDirectory answer for a path that is not there", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const missing = path.join(temp.dir, "gone");

    // Both are used as guards all over the plug-in, on paths the user may have
    // deleted from under it. Neither may throw; "no" is the answer.
    assert.equal(exists(missing), false);
    assert.equal(isDirectory(missing), false);

    const file = path.join(temp.dir, "session.json");
    fs.writeFileSync(file, "{}");
    assert.equal(exists(file), true);
    assert.equal(isDirectory(file), false, "a file is not a folder");
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

test("describeNodeCompat names the Node and the fallbacks it forces", () => {
    const text = describeNodeCompat();

    // This is the line a user pastes into an issue, so it has to be readable
    // and it has to say something either way.
    assert.match(text, /^Node \d+\.\d+ /, "starts with the version: " + text);
    assert.ok(
        / \(no fallbacks\)$/.test(text) || / \(fallbacks: [a-z, ]+\)$/.test(text),
        "ends with a fallback verdict: " + text
    );

    // And it has to agree with the flags it is describing.
    const claimsNone = text.indexOf("no fallbacks") !== -1;
    const allModern =
        nodeVersionInfo.hasRm && nodeVersionInfo.hasRecursiveMkdir && nodeVersionInfo.hasRecursiveRmdir;
    assert.equal(claimsNone, allModern, "the summary matches the detected flags");

    assert.equal(text.indexOf(String(nodeVersionInfo.major)), 5, "reports the real major version");
});

/**
 * duplicateFile is what makes forking a recording on Save As affordable.
 *
 * A hard link is not a shortcut with caveats here: a frame is written once and
 * never touched again, so two names for one set of bytes behave exactly like
 * two copies. The properties that have to hold are that the bytes match and
 * that the folders are independent -- deleting one must not disturb the other.
 */
test("duplicateFile puts identical bytes at the other path", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const source = path.join(temp.dir, "000001_1700000001000.jpg");
    const dest = path.join(temp.dir, "copy.jpg");
    const bytes = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    fs.writeFileSync(source, bytes);

    const mode = duplicateFile(source, dest);

    assert.ok(mode === "link" || mode === "copy", "reports how it got there: " + mode);
    assert.deepEqual(fs.readFileSync(dest), bytes);
});

test("deleting one of the two names leaves the other readable", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const source = path.join(temp.dir, "frame.jpg");
    const dest = path.join(temp.dir, "forked.jpg");
    fs.writeFileSync(source, "frame");

    duplicateFile(source, dest);
    fs.rmSync(source);

    assert.equal(fs.readFileSync(dest, "utf8"), "frame", "the fork survives its origin");
    assert.equal(fs.existsSync(source), false);
});

test("duplicateFile reports a real copy when it cannot link", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const source = path.join(temp.dir, "frame.jpg");
    fs.writeFileSync(source, "frame");

    // Linking onto an existing name fails, which is the same door the exFAT
    // and network-share cases come through: it must fall back, not throw.
    const dest = path.join(temp.dir, "taken.jpg");
    fs.writeFileSync(dest, "old");

    assert.equal(duplicateFile(source, dest), "copy");
    assert.equal(fs.readFileSync(dest, "utf8"), "frame");
});

test("copyFile always moves bytes, even where a link would have worked", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const source = path.join(temp.dir, "frame.jpg");
    const dest = path.join(temp.dir, "moved.jpg");
    fs.writeFileSync(source, "frame");

    copyFile(source, dest);

    assert.equal(fs.readFileSync(dest, "utf8"), "frame");
    // A move across drives has to be a real copy: the destination must not
    // share an inode with a source that is about to be deleted.
    fs.rmSync(source);
    assert.equal(fs.readFileSync(dest, "utf8"), "frame");
});

test("timeStampString with no argument stamps now", () => {
    const before = Date.now();
    const stamp = timeStampString();
    assert.match(stamp, /^\d{4}(-\d{2}){5}-\d{3}$/);
    assert.equal(new Date(before).getFullYear(), Number(stamp.slice(0, 4)));
});

test("randomHex pads a byte below 16 rather than emitting a single digit", () => {
    // Two hex digits per byte is what makes the length predictable; a byte of
    // 0 emitting "0" would quietly shorten every id it appears in.
    const real = Math.random;
    const queue = [0, 0.999, 0.05, 0.5];
    Math.random = () => queue.shift();
    try {
        assert.equal(randomHex(4), "00ff0c80");
    } finally {
        Math.random = real;
    }
});

/* ------------------------------------------------------- the data directory */

test("getUserDataDir follows APPDATA on Windows and falls back to the profile", () => {
    asPlatform("win32", () => {
        withEnv({ APPDATA: "D:\\roaming" }, () => {
            assert.equal(getUserDataDir(), "D:\\roaming");
        });
        withEnv({ APPDATA: undefined }, () => {
            // A Photoshop launched by a service or a scheduled task can come
            // up without APPDATA; guessing beats throwing at import time.
            assert.equal(getUserDataDir(), path.join(os.homedir(), "AppData", "Roaming"));
        });
    });
});

test("getUserDataDir uses Application Support off Windows", () => {
    asPlatform("darwin", () => {
        assert.equal(getUserDataDir(), path.join(os.homedir(), "Library", "Application Support"));
    });
});

/* ------------------------------------------------ writeFileAtomic's failures */

test("writeFileAtomic skips the Windows unlink dance elsewhere", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const target = path.join(temp.dir, "config.json");

    fs.writeFileSync(target, "old");
    // renameSync overwrites in place on POSIX, so removing the destination
    // first would only widen the window where the file is missing entirely.
    asPlatform("linux", () => writeFileAtomic(target, "new"));
    assert.equal(fs.readFileSync(target, "utf8"), "new");
    assert.deepEqual(fs.readdirSync(temp.dir), ["config.json"]);
});

test("a failed write takes its temp file with it and reports the real error", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    // A directory in the way is the shape of the real failure: Photoshop's own
    // save has taken the name, or a sync client has put a folder there.
    const target = path.join(temp.dir, "config.json");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "x");

    assert.throws(() => writeFileAtomic(target, "new"));
    assert.deepEqual(
        fs.readdirSync(temp.dir),
        ["config.json"],
        "no .tmp- file survives the failure"
    );
});

test("the temp file being unremovable does not hide why the write failed", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const target = path.join(temp.dir, "config.json");

    // Two failures in a row: the one worth reporting is the rename, not the
    // best-effort cleanup that could not tidy up after it.
    withFault("renameSync", fsError("EPERM", "rename refused"), () => {
        withFault("unlinkSync", fsError("EBUSY", "and the temp file is held open too"), () => {
            assert.throws(() => writeFileAtomic(target, "new"), /rename refused/);
        });
    });
});

test("a Windows unlink that fails still lets the rename try", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const target = path.join(temp.dir, "config.json");
    fs.writeFileSync(target, "old");

    // Removing the old file first is a workaround for renameSync throwing on
    // Windows, not a precondition; when it cannot be done the rename is still
    // the thing that decides, and it may well succeed.
    withFault("unlinkSync", fsError("EBUSY", "another process has it open"), () => {
        asPlatform("win32", () => writeFileAtomic(target, "new"));
    });
    assert.equal(fs.readFileSync(target, "utf8"), "new");
});
