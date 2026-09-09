/**
 * Handing a picture to the system clipboard.
 *
 * There is no clipboard here to check the result in, so what is pinned down is
 * the command: the flags that make it work at all (-STA, without which .NET's
 * clipboard throws), and the fact that a path is always an argument rather
 * than something pasted into a script -- a folder name with a quote in it is
 * otherwise an injection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { WINDOWS_CLIPBOARD_SCRIPT, clipboardCommand } from "../dist/test/clipboard.mjs";

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
