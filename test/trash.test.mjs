/**
 * Sending the artist's documents to the Recycle Bin.
 *
 * These are the only files the plug-in deletes that it did not write itself. A
 * frame it made can go for good; a PSD is somebody's work, and a wrong tick in
 * a bulk action has to be something the bin can give back. Node has no API for
 * the bin, so the shell's is borrowed -- which means what is worth pinning
 * down here is the command that goes out and what is made of what comes back.
 * The bin itself is the user's, and no test gets to put things in it.
 *
 * The other half is that a batch is not all-or-nothing. One file Photoshop
 * still has open must not cost the caller the other nine, and the recording of
 * anything that stayed has to survive.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { asPlatform, clearFaults, mockBuiltins, setFault, tempDir } from "./helpers.mjs";

mockBuiltins(mock, "child_process");
const { macTrashScript, trashFiles, windowsTrashScript } = await import("../dist/modules/trash.mjs");

/**
 * Stands in for the shell.
 *
 * `reply` decides what the run looked like: a string is stdout from a
 * successful run, an object is `{ error, stderr }` from a failed one.
 */
function shell(reply) {
    const runs = [];
    setFault("execFile", (command, args, options, callback) => {
        runs.push({ command, args, options });
        const answer = typeof reply === "function" ? reply(runs.length) : reply;
        const settle = () => {
            if (answer && typeof answer === "object") {
                callback(answer.error || null, answer.stdout || "", answer.stderr || "");
            } else {
                callback(null, answer || "", "");
            }
        };
        setImmediate(settle);
        return { pid: 1 };
    });
    return runs;
}

const FAIL = "F_RECORD_FAIL\t";

/* ------------------------------------------------------------ the scripts */

test("the Windows script asks for a move to the bin, not a delete", () => {
    const script = windowsTrashScript(["C:\\art\\dragon.psd"]);

    // FOF_ALLOWUNDO (0x0040) is the flag that makes this the bin rather than
    // an unlink; without it the file is simply gone.
    assert.ok(script.includes("0x0040"), "FOF_ALLOWUNDO");
    // And these are what keep a dialog from appearing behind Photoshop, where
    // the generator would sit waiting for a click nobody can see.
    assert.ok(script.includes("0x0004"), "FOF_SILENT");
    assert.ok(script.includes("0x0010"), "FOF_NOCONFIRMATION");
    assert.ok(script.includes("0x0400"), "FOF_NOERRORUI");
    assert.ok(script.includes("op.wFunc = 3"), "FO_DELETE");
    assert.ok(script.includes('op.pFrom = path + "\\0\\0"'), "pFrom is a double-null-terminated list");
});

test("a quote in a document's name cannot turn into PowerShell", () => {
    const script = windowsTrashScript(["C:\\art\\it's mine.psd", "C:\\art\\b.psd"]);
    // Doubled, which is how a single-quoted PowerShell string escapes one.
    assert.ok(script.includes("'C:\\art\\it''s mine.psd'"));
    assert.ok(script.includes("@('C:\\art\\it''s mine.psd', 'C:\\art\\b.psd')"), "both files, one run");
});

test("the Windows script reports each file rather than failing the batch", () => {
    const script = windowsTrashScript(["C:\\art\\a.psd"]);
    assert.ok(script.includes("if (-not (Test-Path -LiteralPath $p)) { continue }"), "already gone is fine");
    assert.ok(script.includes("Write-Output ('" + FAIL), "a refusal is a line, not an exit code");
    // A code of 0 that left the file behind is still a failure; SHFileOperation
    // is documented to lie about this in some shell configurations.
    assert.ok(script.includes("still there"));
});

test(
    "the generated PowerShell parses",
    { skip: process.platform !== "win32" && "PowerShell is only on Windows" },
    () => {
        // Compiled, not run: nothing is deleted, but a typo in the C# or in the
        // quoting would be caught here rather than the first time a user ticks
        // a box.
        const script = windowsTrashScript(["C:\\art\\it's mine.psd"]);
        const check =
            "$errors = $null; " +
            "[System.Management.Automation.Language.Parser]::ParseInput(" +
            "[Console]::In.ReadToEnd(), [ref]$null, [ref]$errors) | Out-Null; " +
            "if ($errors.Count) { $errors[0].Message; exit 1 }";
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], {
            input: script,
            stdio: ["pipe", "pipe", "pipe"]
        });
    }
);

test("the AppleScript escapes what would otherwise end the string", () => {
    const script = macTrashScript(['/Users/a/say "hi".psd', "/Users/a/back\\slash.psd"]);
    assert.ok(script.includes('POSIX file "/Users/a/say \\"hi\\".psd" as alias'));
    assert.ok(script.includes('POSIX file "/Users/a/back\\\\slash.psd" as alias'));
    assert.ok(script.startsWith('tell application "Finder" to delete {'), "one batch, one Finder call");
});

/* ------------------------------------------------------------- the batches */

test("an empty batch never reaches the shell", async (t) => {
    t.after(clearFaults);
    const runs = shell("");
    assert.deepEqual(await trashFiles([]), { failed: [] });
    assert.deepEqual(runs, [], "nothing was run");
});

test("Windows hands the script over encoded, with no window and no profile", async (t) => {
    t.after(clearFaults);
    const runs = shell("");

    const result = await asPlatform("win32", () => trashFiles(["C:\\art\\dragon.psd"]));

    assert.deepEqual(result, { failed: [] });
    assert.equal(runs[0].command, "powershell.exe");
    assert.equal(runs[0].options.windowsHide, true, "no console flash behind Photoshop");
    assert.ok(runs[0].args.includes("-NoProfile"));
    assert.ok(runs[0].args.includes("-NonInteractive"));

    // -EncodedCommand takes UTF-16LE base64, which is what keeps a path full of
    // quotes, spaces and non-ASCII intact across the argv boundary.
    const encoded = runs[0].args[runs[0].args.indexOf("-EncodedCommand") + 1];
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    assert.equal(decoded, windowsTrashScript(["C:\\art\\dragon.psd"]));
});

test("a file the shell refused comes back named, with its code", async (t) => {
    t.after(clearFaults);
    // 0x7C / 124 is DE_INVALIDFILES; the number is what a bug report needs.
    shell([FAIL + "124\tC:\\art\\locked.psd", "", FAIL + "still there\tC:\\art\\stubborn.psd", ""].join("\r\n"));

    const result = await asPlatform("win32", () =>
        trashFiles(["C:\\art\\locked.psd", "C:\\art\\stubborn.psd", "C:\\art\\fine.psd"])
    );

    assert.deepEqual(result.failed, [
        { file: "C:\\art\\locked.psd", error: "SHFileOperation returned 124" },
        { file: "C:\\art\\stubborn.psd", error: "still there" }
    ]);
});

test("a negative code and a line without its tab are still reported", async (t) => {
    t.after(clearFaults);
    // -1 is the script's own "the user aborted it"; a line with no tab should
    // not silently drop the file it names.
    shell([FAIL + "-1\tC:\\art\\aborted.psd", FAIL + "mangled", "unrelated output"].join("\n"));

    const result = await asPlatform("win32", () => trashFiles(["C:\\art\\aborted.psd"]));

    assert.deepEqual(result.failed, [
        { file: "C:\\art\\aborted.psd", error: "SHFileOperation returned -1" },
        { file: "mangled", error: "?" }
    ]);
});

test("a shell that will not start at all is an error, not a silent success", async (t) => {
    t.after(clearFaults);
    shell({ error: new Error("spawn ENOENT"), stderr: "" });

    await assert.rejects(asPlatform("win32", () => trashFiles(["C:\\art\\a.psd"])), /spawn ENOENT/);
});

test("what the shell printed to stderr is preferred to Node's summary of it", async (t) => {
    t.after(clearFaults);
    // execFile's own message is "Command failed: ..."; the line PowerShell
    // wrote is the one that says what actually went wrong.
    shell({ error: new Error("Command failed"), stderr: "  Add-Type : cannot compile\n" });

    await assert.rejects(asPlatform("win32", () => trashFiles(["C:\\art\\a.psd"])), /Add-Type : cannot compile/);
});

test("a failure that says nothing at all still says something", async (t) => {
    t.after(clearFaults);
    const nameless = new Error("");
    shell({ error: nameless, stderr: "   " });

    // Every path out of here has to produce a sentence for the panel; an empty
    // string in the error banner is indistinguishable from a hang.
    await assert.rejects(asPlatform("win32", () => trashFiles(["C:\\art\\a.psd"])), (e) => {
        assert.equal(e.message, "shell failed");
        return true;
    });
});

test("an error with no message at all is described by what it is", async (t) => {
    t.after(clearFaults);
    shell({ error: new Error(""), stderr: "" });

    // Nothing to quote from either side, so the error's own rendering has to
    // do. "Error" is not much, but it is a sentence and it is not empty.
    await assert.rejects(asPlatform("win32", () => trashFiles(["C:\\art\\a.psd"])), (e) => {
        assert.equal(e.message, "Error");
        return true;
    });
});

test("macOS asks the Finder once, and a refusal is charged to every file", async (t) => {
    t.after(clearFaults);
    const runs = shell("");

    assert.deepEqual(await asPlatform("darwin", () => trashFiles(["/Users/a/one.psd"])), { failed: [] });
    assert.equal(runs[0].command, "osascript");
    assert.equal(runs[0].args[0], "-e");
    assert.equal(runs[0].args[1], macTrashScript(["/Users/a/one.psd"]));

    shell({ error: new Error("Finder got an error: -1728") });
    const refused = await asPlatform("darwin", () => trashFiles(["/Users/a/one.psd", "/Users/a/two.psd"]));

    // The Finder takes the batch as one, so if it refuses, nothing moved --
    // reporting only the first file would leave the other looking binned.
    assert.deepEqual(refused.failed, [
        { file: "/Users/a/one.psd", error: "Finder got an error: -1728" },
        { file: "/Users/a/two.psd", error: "Finder got an error: -1728" }
    ]);
});

test("where there is no bin the file is unlinked, and a missing one is not a failure", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const present = path.join(temp.dir, "one.psd");
    fs.writeFileSync(present, "psd");
    const absent = path.join(temp.dir, "never.psd");

    const result = await asPlatform("linux", () => trashFiles([present, absent]));

    assert.deepEqual(result, { failed: [] }, "already gone is the outcome the caller wanted");
    assert.equal(fs.existsSync(present), false);
});

test("an unlink that fails for a real reason is reported and the batch goes on", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // A directory where a document was expected: EPERM or EISDIR depending on
    // the platform, but never ENOENT, so it has to be reported.
    const notAFile = path.join(temp.dir, "folder.psd");
    fs.mkdirSync(notAFile);
    const alsoThere = path.join(temp.dir, "two.psd");
    fs.writeFileSync(alsoThere, "psd");

    const result = await asPlatform("linux", () => trashFiles([notAFile, alsoThere]));

    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].file, notAFile);
    assert.ok(result.failed[0].error.length > 0, "says why");
    assert.equal(fs.existsSync(alsoThere), false, "the rest of the batch still went");
});
