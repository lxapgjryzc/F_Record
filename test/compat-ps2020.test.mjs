/**
 * The compatibility layer on the oldest Node it has to survive.
 *
 * Photoshop 2020's CEP panel runs Node 8.6, and 3.x's export threw outright
 * there because it called `fs.rmSync` unconditionally. Every fallback in
 * shared/compat.ts is chosen once, at import time, from
 * `process.versions.node` -- so the only way to run the Node 8 half of that
 * file is to be a process that claims to be Node 8 before the module is
 * imported. That is what this whole file is: the same module, in the host
 * that broke.
 *
 * It goes further than 8.6 and reports no version at all, which selects every
 * fallback at once including the pre-8.5 `fs.copyFile` one. Unknown has to
 * mean old: reading the version optimistically is exactly the mistake that
 * shipped in 3.x.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { fsError, mockBuiltins, pretendNodeVersion, tempDir, withFault } from "./helpers.mjs";

pretendNodeVersion(undefined);
mockBuiltins(mock, "fs");
const compat = await import("../dist/modules/compat.mjs");

test("a runtime that will not say which Node it is gets every fallback", () => {
    assert.deepEqual(
        {
            major: compat.nodeVersionInfo.major,
            minor: compat.nodeVersionInfo.minor,
            mkdir: compat.nodeVersionInfo.hasRecursiveMkdir,
            rm: compat.nodeVersionInfo.hasRm,
            rmdir: compat.nodeVersionInfo.hasRecursiveRmdir,
            copyFile: compat.nodeVersionInfo.hasCopyFile
        },
        { major: 0, minor: 0, mkdir: false, rm: false, rmdir: false, copyFile: false }
    );
    assert.equal(compat.describeNodeCompat(), "Node 0.0 (fallbacks: mkdir, rm, rmdir, copyFile)");
});

test("the hand-written mkdir builds the whole path and forgives an existing one", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const deep = path.join(temp.dir, "a", "b", "c");
    compat.mkdirp(deep);
    assert.equal(fs.statSync(deep).isDirectory(), true, "walked up and back down");

    compat.mkdirp(deep); // EEXIST is a success, not a failure
    assert.equal(fs.statSync(deep).isDirectory(), true);
});

test("the hand-written mkdir reports a directory it truly could not create", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    // The parent is a file, so there is nowhere to descend to. EEXIST is
    // forgiven; this is not EEXIST, and swallowing it would leave the caller
    // writing frames into a folder that is not there.
    const blocker = path.join(temp.dir, "blocker");
    fs.writeFileSync(blocker, "x");
    assert.throws(() => compat.mkdirp(path.join(blocker, "child")));
});

test("the hand-written mkdir stops climbing at the root", () => {
    // path.dirname of a root is the root, and the walk up has to notice that
    // or recurse until the stack goes. The root exists, so this is a no-op.
    compat.mkdirp(path.parse(process.cwd()).root);
});

test("the hand-written delete removes a whole recording, depth first", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const tree = path.join(temp.dir, "session");
    compat.mkdirp(path.join(tree, "nested"));
    fs.writeFileSync(path.join(tree, "000001_1700000001000.jpg"), "x");
    fs.writeFileSync(path.join(tree, "nested", "000002_1700000002000.jpg"), "y");

    compat.rmrf(tree);
    assert.equal(fs.existsSync(tree), false);
});

test("the hand-written delete handles a lone file and a path already gone", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const file = path.join(temp.dir, "session.json");
    fs.writeFileSync(file, "{}");
    compat.rmrf(file);
    assert.equal(fs.existsSync(file), false);

    compat.rmrf(file); // twice is not an error
    compat.rmrf(path.join(temp.dir, "never-existed"));
});

test("a Node too old even for fs.copyFile still duplicates frames", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const source = path.join(temp.dir, "000001_1700000001000.jpg");
    const bytes = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    fs.writeFileSync(source, bytes);

    compat.copyFile(source, path.join(temp.dir, "read-and-written.jpg"));
    assert.deepEqual(fs.readFileSync(path.join(temp.dir, "read-and-written.jpg")), bytes);

    // duplicateFile's fallback goes through the same door: linking onto a name
    // that is taken fails, and the copy that follows is the hand-written one.
    const taken = path.join(temp.dir, "taken.jpg");
    fs.writeFileSync(taken, "old");
    assert.equal(compat.duplicateFile(source, taken), "copy");
    assert.deepEqual(fs.readFileSync(taken), bytes);
});

/* --------------------------------------------- when the disk says no anyway */

test("a folder that cannot be listed is left alone rather than half-deleted", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const tree = path.join(temp.dir, "session");
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, "000001_1700000001000.jpg"), "x");

    withFault("readdirSync", fsError("EACCES", "the folder is not readable"), () => {
        compat.rmrf(tree);
    });
    assert.equal(fs.existsSync(path.join(tree, "000001_1700000001000.jpg")), true, "nothing went");
});

test("a frame that will not unlink does not turn the delete into a throw", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const file = path.join(temp.dir, "000001_1700000001000.jpg");
    fs.writeFileSync(file, "x");

    // One frame held open by Photoshop must not become a failed housekeeping
    // run; the caller finds out from what is left on disk, not from an
    // exception halfway through a batch.
    withFault("unlinkSync", fsError("EBUSY", "Photoshop still has the frame open"), () => {
        compat.rmrf(file);
    });
    assert.equal(fs.existsSync(file), true);
});

test("a folder that will not go after its contents did is not an error either", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const tree = path.join(temp.dir, "session");
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, "000001_1700000001000.jpg"), "x");

    withFault("rmdirSync", fsError("ENOTEMPTY", "raced with another delete"), () => {
        compat.rmrf(tree);
    });
    assert.equal(fs.existsSync(path.join(tree, "000001_1700000001000.jpg")), false, "contents still went");
    assert.equal(fs.existsSync(tree), true);
});
