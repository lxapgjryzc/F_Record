/**
 * Finding ffmpeg.
 *
 * Earlier builds bundled ffmpeg.exe inside the extension, so there was nothing
 * to find. It is now installed separately -- either it was already on the
 * machine, or scripts/install.ps1 fetched it -- which makes "where do we look,
 * and in what order" real logic worth pinning down.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ffmpegCandidates, pathDirectories, ffmpegExeName, FFMPEG_ENV_VAR } from "../dist/test/locate.mjs";

/** Windows paths, written with forward slashes so the source stays readable. */
const w = (s) => s.split("/").join(String.fromCharCode(92));

const EXT_DIR = w("C:/Program Files/Adobe/Adobe Photoshop 2026/CEP/extensions/com.F_know.F_Record.cep");

const WIN = {
    platform: "win32",
    extensionDir: EXT_DIR,
    env: {
        ProgramData: w("C:/ProgramData"),
        LOCALAPPDATA: w("C:/Users/a/AppData/Local"),
        ProgramFiles: w("C:/Program Files"),
        PATH: w("C:/Windows/system32") + ";" + w("C:/tools/ffmpeg/bin")
    }
};

function ctx(overrides) {
    return { ...WIN, ...overrides, env: { ...WIN.env, ...(overrides && overrides.env) } };
}

test("the executable name follows the platform", () => {
    assert.equal(ffmpegExeName("win32"), "ffmpeg.exe");
    assert.equal(ffmpegExeName("darwin"), "ffmpeg");
});

test("an explicit override is tried before anything else", () => {
    const list = ffmpegCandidates(ctx({ env: { [FFMPEG_ENV_VAR]: w("D:/my/ffmpeg.exe") } }));
    assert.equal(list[0], w("D:/my/ffmpeg.exe"), "the override wins outright");
});

test("a copy inside the extension is still honoured, so an existing bundled copy keeps working", () => {
    const list = ffmpegCandidates(ctx());
    assert.equal(list[0], EXT_DIR + w("/ffmpeg/ffmpeg.exe"), "bundled location first when no override");
});

test("the shared install location is searched", () => {
    const list = ffmpegCandidates(ctx());
    assert.ok(
        list.includes(w("C:/ProgramData/F_Record/ffmpeg/ffmpeg.exe")),
        "where install.ps1 puts a downloaded ffmpeg"
    );
});

test("the shared location is preferred over PATH", () => {
    const list = ffmpegCandidates(ctx());
    const shared = list.indexOf(w("C:/ProgramData/F_Record/ffmpeg/ffmpeg.exe"));
    const onPath = list.indexOf(w("C:/tools/ffmpeg/bin/ffmpeg.exe"));
    assert.ok(shared !== -1 && onPath !== -1, "both are candidates");
    assert.ok(shared < onPath, "the copy we installed is the one we trust first");
});

test("every PATH directory becomes a candidate", () => {
    const list = ffmpegCandidates(ctx());
    assert.ok(list.includes(w("C:/Windows/system32/ffmpeg.exe")));
    assert.ok(list.includes(w("C:/tools/ffmpeg/bin/ffmpeg.exe")));
});

test("winget and chocolatey shims are covered, since neither is always on PATH", () => {
    const list = ffmpegCandidates(ctx());
    assert.ok(list.includes(w("C:/Users/a/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe")));
    assert.ok(list.includes(w("C:/ProgramData/chocolatey/bin/ffmpeg.exe")));
});

test("candidates are deduplicated, case-insensitively", () => {
    const list = ffmpegCandidates(
        ctx({
            env: {
                PATH: [w("C:/tools/ffmpeg/bin"), w("c:/TOOLS/FFMPEG/BIN"), w("C:/tools/ffmpeg/bin")].join(";")
            }
        })
    );
    const target = w("c:/tools/ffmpeg/bin/ffmpeg.exe");
    const hits = list.filter((p) => p.toLowerCase() === target);
    assert.equal(hits.length, 1, "the same directory is not probed three times");
});

test("PATH parsing survives the junk Windows leaves in it", () => {
    const raw = [w("C:/a"), "", "  " + w("C:/b") + "  ", '"' + w("C:/c") + '"', ""].join(";");
    assert.deepEqual(
        pathDirectories(raw, "win32"),
        [w("C:/a"), w("C:/b"), w("C:/c")],
        "empty entries, padding and quotes are all dropped"
    );
    assert.deepEqual(pathDirectories(undefined, "win32"), [], "an unset PATH is not an error");
});

test("a missing ProgramData does not break the list", () => {
    const list = ffmpegCandidates({
        platform: "win32",
        extensionDir: w("C:/ext"),
        env: { PATH: w("C:/Windows") }
    });
    assert.ok(list.length > 0);
    assert.ok(list.every((p) => typeof p === "string" && p.length > 0));
});

test("posix hosts get posix paths", () => {
    const list = ffmpegCandidates({
        platform: "darwin",
        extensionDir: "/Library/Adobe/CEP/extensions/f_record",
        env: { HOME: "/Users/a", PATH: "/usr/local/bin:/usr/bin" }
    });
    assert.equal(list[0], "/Library/Adobe/CEP/extensions/f_record/ffmpeg/ffmpeg");
    assert.ok(list.includes("/Users/a/.local/share/F_Record/ffmpeg/ffmpeg"));
    assert.ok(list.includes("/usr/local/bin/ffmpeg"));
    assert.ok(list.every((p) => p.indexOf(String.fromCharCode(92)) === -1), "no Windows separators leak in");
});
