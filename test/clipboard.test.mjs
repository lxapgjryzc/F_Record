/**
 * Handing a picture to the system clipboard.
 *
 * There is no clipboard here to check the result in, so what is pinned down is
 * the command: the flags that make it work at all (-STA, without which .NET's
 * clipboard throws), and the fact that a path is always an argument rather
 * than something pasted into a script -- a folder name with a quote in it is
 * otherwise an injection.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { asPlatform, clearFaults, mockBuiltins, setFault, tempDir } from "./helpers.mjs";

// The spawn is stood in for: the assertion is about the command that goes out,
// and the alternative would be a test that writes to the user's clipboard.
mockBuiltins(mock, "child_process");
const { WINDOWS_CLIPBOARD_SCRIPT, clipboardCommand, copyImageToClipboard } = await import(
    "../dist/modules/clipboard.mjs"
);

test("Windows goes through PowerShell, in a single-threaded apartment", () => {
    const plan = clipboardCommand("win32", "C:\\temp\\canvas.png", "C:\\temp\\clipboard.ps1");
    assert.equal(plan.command, "powershell.exe");
    // The OLE clipboard is STA-only and powershell.exe starts multi-threaded,
    // so without this SetImage throws instead of copying.
    assert.ok(plan.args.includes("-STA"));
    assert.ok(plan.args.includes("-NoProfile"), "a user's profile has no business here");
    assert.ok(plan.args.includes("-NonInteractive"));
    assert.deepEqual(plan.args.slice(-4), [
        "-File",
        "C:\\temp\\clipboard.ps1",
        "-Path",
        "C:\\temp\\canvas.png"
    ]);
});

test("the picture's path is an argument, never part of the script", () => {
    const nasty = "C:\\temp\\it's $(bad) \"art\".png";
    const plan = clipboardCommand("win32", nasty, "C:\\temp\\clipboard.ps1");
    // Passed as its own argv entry, so PowerShell never parses it as code.
    assert.equal(plan.args[plan.args.length - 1], nasty);
    assert.ok(!WINDOWS_CLIPBOARD_SCRIPT.includes(nasty));
    assert.ok(
        WINDOWS_CLIPBOARD_SCRIPT.includes("param([Parameter(Mandatory = $true)][string]$Path)"),
        "the script takes the path rather than containing it"
    );
});

test("the Windows script copies the bytes and holds no handle on the file", () => {
    // Image.FromFile would keep the scratch file open, and the caller deletes
    // it the moment the helper returns.
    assert.ok(!WINDOWS_CLIPBOARD_SCRIPT.includes("FromFile"));
    assert.ok(WINDOWS_CLIPBOARD_SCRIPT.includes("MemoryStream"));
    assert.ok(WINDOWS_CLIPBOARD_SCRIPT.includes("Clipboard]::SetImage"));
});

test("macOS reads the file as PNG data, not as a file reference", () => {
    const plan = clipboardCommand("darwin", "/Users/a/canvas.png", "/tmp/clipboard.ps1");
    assert.equal(plan.command, "osascript");
    assert.equal(plan.args[0], "-e");
    // Without the four-char code the clipboard would hold the file itself,
    // which pastes as an attachment rather than as the picture.
    assert.ok(plan.args[1].includes("«class PNGf»"));
    assert.ok(plan.args[1].includes('POSIX file "/Users/a/canvas.png"'));
});

test("a quote in a macOS path is escaped rather than closing the AppleScript string", () => {
    const plan = clipboardCommand("darwin", '/Users/a/say "hi".png', "/tmp/x.ps1");
    assert.ok(plan.args[1].includes('say \\"hi\\".png'));
});

test("a platform we have no way to reach is admitted, not attempted", () => {
    assert.equal(clipboardCommand("linux", "/tmp/canvas.png", "/tmp/x.ps1"), null);
});

/* ------------------------------------------------------- running the helper */

/** A child process the test drives by hand. */
function fakeChild() {
    const handlers = { child: {}, stderr: {} };
    const child = {
        stderr: {
            setEncoding() {},
            on(event, fn) {
                handlers.stderr[event] = fn;
            }
        },
        on(event, fn) {
            handlers.child[event] = fn;
            return child;
        }
    };
    return {
        child,
        say: (text) => handlers.stderr.data(text),
        fail: (err) => handlers.child.error(err),
        exit: (code) => handlers.child.close(code)
    };
}

/**
 * Starts a copy on `platform` and hands back the promise plus the child.
 *
 * The platform is forced rather than taken from the machine so that the
 * Windows path -- the one with a script to write and an -STA host to start --
 * is exercised wherever the suite runs.
 */
function startCopy(imageDir, { platform = "win32", scratch = imageDir } = {}) {
    const fake = fakeChild();
    const spawned = [];
    setFault("spawn", (command, args, options) => {
        spawned.push({ command, args, options });
        return fake.child;
    });
    const promise = asPlatform(platform, () =>
        copyImageToClipboard(path.join(imageDir, "canvas.png"), scratch)
    );
    // Nothing is awaited yet: the executor has already run, so the handlers
    // are registered and `fake` can be driven straight away.
    return { promise, spawned, ...fake };
}

test("a successful helper resolves once, after the script has been written", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const copy = startCopy(temp.dir);
    copy.exit(0);
    await copy.promise;

    assert.equal(copy.spawned[0].command, "powershell.exe");
    assert.equal(copy.spawned[0].options.windowsHide, true, "no console flash over Photoshop");
    // The script is written beside the picture rather than shipped, so the
    // panel has nothing extra to install and the path stays a parameter.
    assert.equal(fs.readFileSync(path.join(temp.dir, "clipboard.ps1"), "utf8"), WINDOWS_CLIPBOARD_SCRIPT);
    assert.equal(copy.spawned[0].args[copy.spawned[0].args.indexOf("-File") + 1], path.join(temp.dir, "clipboard.ps1"));
});

test("a helper that exits non-zero reports what it printed", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const copy = startCopy(temp.dir);
    copy.say('Exception calling "SetImage"');
    copy.say(": the clipboard is in use\n");
    copy.exit(1);

    // Both chunks, in order: stderr arrives in pieces and a message cut in
    // half is worse than no message.
    await assert.rejects(copy.promise, /Exception calling "SetImage": the clipboard is in use/);
});

test("only the tail of a runaway helper is kept", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const copy = startCopy(temp.dir);
    // A profile script or a broken assembly can print without stopping; the
    // panel shows this text, and the end of it is the part that says why.
    copy.say("x".repeat(5000));
    copy.say("\nthe real reason");
    copy.exit(1);

    await assert.rejects(copy.promise, (e) => {
        assert.ok(e.message.length <= 2000, "kept " + e.message.length + " characters");
        assert.ok(e.message.endsWith("the real reason"));
        return true;
    });
});

test("a helper that exits non-zero in silence still says something", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const copy = startCopy(temp.dir);
    copy.exit(3);

    await assert.rejects(copy.promise, /The clipboard helper exited with code 3/);
});

test("a helper that will not start names the program that is missing", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const copy = startCopy(temp.dir);
    copy.fail(new Error("spawn ENOENT"));

    // "Could not run powershell.exe" is a different problem from "the
    // clipboard refused", and the panel's message has to tell them apart.
    await assert.rejects(copy.promise, /^Error: Could not run powershell\.exe: spawn ENOENT$/);
});

test("macOS goes straight to osascript, with no script to write first", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const copy = startCopy(temp.dir, { platform: "darwin" });
    copy.exit(0);
    await copy.promise;

    assert.equal(copy.spawned[0].command, "osascript");
    assert.equal(fs.existsSync(path.join(temp.dir, "clipboard.ps1")), false, "nothing to write on a Mac");
});

test("a platform with no clipboard we can reach is refused before anything is spawned", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const copy = startCopy(temp.dir, { platform: "linux" });

    await assert.rejects(copy.promise, /not supported on linux/);
    assert.deepEqual(copy.spawned, []);
});

test("a scratch directory that cannot be written is reported, not spawned around", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // A file where the scratch folder should be: the script cannot be written,
    // and running the helper without it would only produce a stranger error.
    const blocked = path.join(temp.dir, "not-a-folder");
    fs.writeFileSync(blocked, "x");

    const copy = startCopy(temp.dir, { scratch: blocked });

    await assert.rejects(copy.promise);
    assert.deepEqual(copy.spawned, [], "nothing was run");
});
