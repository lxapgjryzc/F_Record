/**
 * The compatibility layer on the middle-aged host.
 *
 * Photoshop 2021's panel is Node 12.3 and 2022's is 12.13: old enough that
 * `fs.rmSync` (14.14) is missing, new enough that `fs.rmdirSync({recursive})`
 * (12.10) is there. That middle branch is its own path through rmrf, and
 * neither the modern host nor the Node 8 one goes anywhere near it.
 *
 * 12.10 is also the one version that makes the feature test compare minors at
 * all -- every other host settles it on the major alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { pretendNodeVersion, tempDir } from "./helpers.mjs";

pretendNodeVersion("12.10.0");
const compat = await import("../dist/modules/compat.mjs");

test("12.10 is read as having a recursive rmdir but no rm", () => {
    assert.deepEqual(
        {
            mkdir: compat.nodeVersionInfo.hasRecursiveMkdir,
            rm: compat.nodeVersionInfo.hasRm,
            rmdir: compat.nodeVersionInfo.hasRecursiveRmdir,
            copyFile: compat.nodeVersionInfo.hasCopyFile
        },
        { mkdir: true, rm: false, rmdir: true, copyFile: true },
        "the exact release rmdirSync({recursive}) arrived in"
    );
    assert.equal(compat.describeNodeCompat(), "Node 12.10 (fallbacks: rm)");
});

test("a recording goes in one recursive rmdir", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const tree = path.join(temp.dir, "session");
    fs.mkdirSync(path.join(tree, "nested"), { recursive: true });
    fs.writeFileSync(path.join(tree, "nested", "000001_1700000001000.jpg"), "x");

    compat.rmrf(tree);
    assert.equal(fs.existsSync(tree), false);
});

test("a file is not a directory, so the recursive rmdir is not its answer", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    // rmdirSync on a file fails; the check in front of it is what keeps a
    // stray session.json deletable on this host.
    const file = path.join(temp.dir, "session.json");
    fs.writeFileSync(file, "{}");
    compat.rmrf(file);
    assert.equal(fs.existsSync(file), false);
});
