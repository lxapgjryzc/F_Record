/**
 * Sends files to the Recycle Bin (the Trash, on macOS) instead of unlinking.
 *
 * These are the artist's documents. Every other delete in this plug-in is of
 * frames the plug-in wrote itself, and those go for good once confirmed; a
 * PSD is somebody's work, and a wrong tick in a bulk action should be
 * something the bin can give back. Node has no API for the bin, so the
 * shell's is borrowed: SHFileOperation through PowerShell on Windows, the
 * Finder through osascript on macOS. Anywhere else there is no bin to speak
 * of and the file is unlinked, so the tests run on Linux too.
 *
 * Nothing here shows a window. SHFileOperation is called with the flags that
 * suppress confirmation, progress and error UI, so a file that cannot be
 * binned comes back as a code rather than a dialog the generator would sit
 * behind for ever. Each file is reported on its own: one that is in use does
 * not stop the rest, and the caller keeps the recording of any that stayed.
 */

import * as fs from "fs";
import { execFile } from "child_process";

export interface TrashFailure {
    file: string;
    error: string;
}

export interface TrashResult {
    failed: TrashFailure[];
}

export type Trash = (files: string[]) => Promise<TrashResult>;

const FAIL_PREFIX = "F_RECORD_FAIL\t";

/**
 * FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI. ALLOWUNDO
 * is what makes it a move to the bin rather than a delete.
 */
const SH_FLAGS = "0x0004 | 0x0010 | 0x0040 | 0x0400";

/**
 * The PowerShell that does the work on Windows. SHFILEOPSTRUCT is declared
 * with natural packing, which is right for the 64-bit PowerShell every
 * supported Photoshop runs beside; the 32-bit layout is packed to 1 and
 * would need Pack = 1. Failures are printed one per line and the script
 * exits 0, so a file in use is a line in stdout and not a lost batch.
 */
export function windowsTrashScript(files: string[]): string {
    const quoted = files.map(function (file) {
        return "'" + file.replace(/'/g, "''") + "'";
    });
    return [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -TypeDefinition @'",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public static class FRecordBin {",
        "    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
        "    private struct SHFILEOPSTRUCT {",
        "        public IntPtr hwnd;",
        "        public uint wFunc;",
        "        public string pFrom;",
        "        public string pTo;",
        "        public ushort fFlags;",
        "        public int fAnyOperationsAborted;",
        "        public IntPtr hNameMappings;",
        "        public string lpszProgressTitle;",
        "    }",
        "    [DllImport(\"shell32.dll\", CharSet = CharSet.Unicode)]",
        "    private static extern int SHFileOperation(ref SHFILEOPSTRUCT op);",
        "    public static int Delete(string path) {",
        "        SHFILEOPSTRUCT op = new SHFILEOPSTRUCT();",
        "        op.wFunc = 3;",
        "        op.pFrom = path + \"\\0\\0\";",
        "        op.fFlags = (ushort)(" + SH_FLAGS + ");",
        "        int code = SHFileOperation(ref op);",
        "        if (code == 0 && op.fAnyOperationsAborted != 0) { return -1; }",
        "        return code;",
        "    }",
        "}",
        "'@",
        "foreach ($p in @(" + quoted.join(", ") + ")) {",
        "    if (-not (Test-Path -LiteralPath $p)) { continue }",
        "    $code = [FRecordBin]::Delete($p)",
        "    if ($code -ne 0) { Write-Output ('" + FAIL_PREFIX + "' + $code + \"`t\" + $p) }",
        "    elseif (Test-Path -LiteralPath $p) { Write-Output ('" + FAIL_PREFIX + "still there\t' + $p) }",
        "}"
    ].join("\n");
}

/** The AppleScript asking the Finder to do the same. */
export function macTrashScript(files: string[]): string {
    const items = files.map(function (file) {
        return 'POSIX file "' + file.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '" as alias';
    });
    return 'tell application "Finder" to delete {' + items.join(", ") + "}";
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise(function (resolve, reject) {
        execFile(
            command,
            args,
            { windowsHide: true, maxBuffer: 4 * 1024 * 1024 } as any,
            function (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) {
                if (error) {
                    reject(new Error(String(stderr || error.message || error).trim() || "shell failed"));
                    return;
                }
                resolve({ stdout: String(stdout), stderr: String(stderr) });
            }
        );
    });
}

/** Sends every file to the bin; a file that cannot go is reported, not thrown. */
export async function trashFiles(files: string[]): Promise<TrashResult> {
    if (files.length === 0) {
        return { failed: [] };
    }
    if (process.platform === "win32") {
        const encoded = Buffer.from(windowsTrashScript(files), "utf16le").toString("base64");
        const result = await run("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded
        ]);
        const failed: TrashFailure[] = [];
        const lines = result.stdout.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf(FAIL_PREFIX) !== 0) {
                continue;
            }
            const rest = lines[i].slice(FAIL_PREFIX.length);
            const tab = rest.indexOf("\t");
            const code = tab === -1 ? "?" : rest.slice(0, tab);
            failed.push({
                file: tab === -1 ? rest : rest.slice(tab + 1),
                error: /^-?\d+$/.test(code) ? "SHFileOperation returned " + code : code
            });
        }
        return { failed: failed };
    }
    if (process.platform === "darwin") {
        // The Finder takes the batch as one; if it refuses, nothing moved.
        try {
            await run("osascript", ["-e", macTrashScript(files)]);
        } catch (e) {
            return {
                failed: files.map(function (file) {
                    return { file: file, error: (e as Error).message };
                })
            };
        }
        return { failed: [] };
    }
    const failed: TrashFailure[] = [];
    for (let i = 0; i < files.length; i++) {
        try {
            fs.unlinkSync(files[i]);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                failed.push({ file: files[i], error: (e as Error).message });
            }
        }
    }
    return { failed: failed };
}
