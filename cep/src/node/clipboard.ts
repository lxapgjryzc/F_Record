/**
 * Putting a picture on the system clipboard.
 *
 * CEP has no clipboard API for images -- `document.execCommand("copy")` moves
 * text and nothing else -- so this goes out to the platform. On Windows that
 * is PowerShell driving the .NET clipboard; on macOS it is AppleScript. Both
 * are already on the machine, so nothing new has to be installed for the
 * button to work.
 *
 * The command builders are pure so they can be tested without a clipboard to
 * write to; see test/clipboard.test.mjs.
 */

import { writeFileAtomic } from "../../../shared/compat";

declare const require: (id: string) => any;

/**
 * The Windows half, as a script rather than a `-Command` string.
 *
 * A path is handed to it as a parameter and never pasted into the source, so a
 * folder with a quote or a `$` in its name cannot turn into PowerShell.
 *
 * The bitmap is loaded from a MemoryStream instead of from the file: Image
 * .FromFile keeps the file open for the lifetime of the object, and the caller
 * wants to delete its scratch file straight afterwards. SetImage copies the
 * data into the clipboard rather than leaving a promise to serve it later, so
 * it survives this process exiting a moment later.
 */
export const WINDOWS_CLIPBOARD_SCRIPT = [
    "param([Parameter(Mandatory = $true)][string]$Path)",
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$bytes = [System.IO.File]::ReadAllBytes($Path)",
    "$stream = New-Object System.IO.MemoryStream(,$bytes)",
    "try {",
    "    $image = [System.Drawing.Image]::FromStream($stream)",
    "    try {",
    "        [System.Windows.Forms.Clipboard]::SetImage($image)",
    "    } finally {",
    "        $image.Dispose()",
    "    }",
    "} finally {",
    "    $stream.Dispose()",
    "}",
    ""
].join("\r\n");

export interface ClipboardCommand {
    command: string;
    args: string[];
}

/**
 * How to ask this platform to hold `imagePath`, or null if we do not know.
 *
 * `scriptPath` is where the Windows script above has been written; it is
 * passed in rather than decided here so this stays free of side effects.
 *
 * -STA is not optional: the OLE clipboard is single-threaded-apartment only,
 * and powershell.exe starts multi-threaded, where SetImage throws. -NoProfile
 * keeps a user's profile script out of it, both for speed and because a
 * profile that writes to the host would be picked up as an error.
 */
export function clipboardCommand(
    platform: string,
    imagePath: string,
    scriptPath: string
): ClipboardCommand | null {
    if (platform === "win32") {
        return {
            command: "powershell.exe",
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                scriptPath,
                "-Path",
                imagePath
            ]
        };
    }
    if (platform === "darwin") {
        // «class PNGf» is the four-char code for PNG data; `set the clipboard
        // to` with a plain file reference would put the file on the clipboard
        // rather than the picture in it.
        return {
            command: "osascript",
            args: [
                "-e",
                'set the clipboard to (read (POSIX file "' +
                    imagePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
                    '") as «class PNGf»)'
            ]
        };
    }
    return null;
}

/**
 * Puts the PNG at `imagePath` on the clipboard.
 *
 * Node is reached for here rather than at the top of the file so that the
 * builders above can be imported by the test suite, which runs outside CEP and
 * has no `require` global to give this module.
 */
export function copyImageToClipboard(imagePath: string, tempDir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const path = require("path");
        const childProcess = require("child_process");
        const scriptPath = path.join(tempDir, "clipboard.ps1");
        if (process.platform === "win32") {
            try {
                writeFileAtomic(scriptPath, Buffer.from(WINDOWS_CLIPBOARD_SCRIPT, "utf8"));
            } catch (error) {
                reject(error as Error);
                return;
            }
        }

        const plan = clipboardCommand(process.platform, imagePath, scriptPath);
        if (plan === null) {
            reject(new Error("Copying a picture to the clipboard is not supported on " + process.platform));
            return;
        }

        const child = childProcess.spawn(plan.command, plan.args, { windowsHide: true });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", function (chunk: string) {
            stderr = (stderr + chunk).slice(-2000);
        });
        child.on("error", function (err: Error) {
            reject(new Error("Could not run " + plan.command + ": " + err.message));
        });
        child.on("close", function (code: number) {
            if (code !== 0) {
                reject(new Error(stderr.trim() || "The clipboard helper exited with code " + code));
                return;
            }
            resolve();
        });
    });
}
