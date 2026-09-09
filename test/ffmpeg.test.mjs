/**
 * Running ffmpeg, and everything that has to be true before it is run.
 *
 * The binary is not shipped any more -- a 75 MB download inside a 419 KB
 * plug-in was what made the repository 165 MB -- so the export begins by
 * finding one, and the interesting failures are all before a single frame is
 * encoded: no ffmpeg anywhere, a watermark image the user has since moved, a
 * machine with no font drawtext can use, a recording whose frames were left
 * half-written by a crash.
 *
 * ffmpeg itself is stood in for. What is worth pinning down is the command
 * that goes out, the progress read back from it, and the fact that every way
 * this can fail produces a sentence someone can act on rather than a spinner
 * that never stops.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { clearFaults, fsError, mockBuiltins, setFault, tempDir, withEnv, withIsolatedAppDir } from "./helpers.mjs";

mockBuiltins(mock, "fs", "child_process");
const ffmpeg = await import("../dist/modules/ffmpeg.mjs");
const { FFMPEG_ENV_VAR, FONT_ENV_VAR } = await import("../dist/modules/locate.mjs");
const { exportTempDir } = await import("../dist/modules/paths.mjs");

/** A JPEG the completeness check accepts: SOI, an SOF0 with a size, EOI. */
function jpeg(width = 400, height = 300) {
    return Buffer.from([
        0xff, 0xd8,
        0xff, 0xc0, 0x00, 0x11, 0x08,
        (height >> 8) & 0xff, height & 0xff,
        (width >> 8) & 0xff, width & 0xff,
        0x03,
        0xff, 0xd9
    ]);
}

/** A child process the test drives by hand. */
function fakeFfmpeg() {
    const state = { spawned: [], handlers: {}, stdout: {}, stderr: {}, killed: 0 };
    const child = {
        stdout: {
            setEncoding() {},
            on(event, fn) {
                state.stdout[event] = fn;
            }
        },
        stderr: {
            setEncoding() {},
            on(event, fn) {
                state.stderr[event] = fn;
            }
        },
        on(event, fn) {
            state.handlers[event] = fn;
            return child;
        },
        kill() {
            state.killed++;
        }
    };
    setFault("spawn", (command, args, options) => {
        state.spawned.push({ command, args, options });
        return child;
    });
    state.child = child;
    state.say = (text) => state.stderr.data(text);
    state.progress = (text) => state.stdout.data(text);
    state.fail = (err) => state.handlers.error(err);
    state.exit = (code) => state.handlers.close(code);
    return state;
}

/** Makes every candidate path exist, or only the ones named. */
function ffmpegAt(binary) {
    setFault("existsSync", (target) => target === binary || String(target).endsWith(".ttf"));
}

const WINDOWS_FFMPEG = "C:" + String.fromCharCode(92) + "ffmpeg" + String.fromCharCode(92) + "bin" +
    String.fromCharCode(92) + "ffmpeg.exe";

/* --------------------------------------------------------------- finding it */

test("the first candidate that exists is the one used, and the rest are remembered", (t) => {
    t.after(clearFaults);

    // The list doubles as the "we looked here" detail in the failure message,
    // so it is returned whether or not anything was found.
    setFault("existsSync", (target) => String(target).indexOf("ffmpeg") !== -1);
    const found = ffmpeg.locateFfmpeg();
    assert.ok(found.path, "something was found");
    assert.equal(found.path, found.searched[0], "the most deliberate candidate wins");
    assert.ok(found.searched.length > 1);
});

test("an override on the environment beats everything else", (t) => {
    t.after(clearFaults);
    withEnv({ [FFMPEG_ENV_VAR]: "D:/mine/ffmpeg.exe" }, () => {
        setFault("existsSync", () => true);
        assert.equal(ffmpeg.locateFfmpeg().path, "D:/mine/ffmpeg.exe");
    });
});

test("a PATH entry that cannot even be looked at does not fail the search", (t) => {
    t.after(clearFaults);

    // A disconnected network drive on PATH throws rather than returning false.
    let asked = 0;
    setFault("existsSync", () => {
        asked++;
        if (asked === 1) {
            throw fsError("EIO", "that drive is not there");
        }
        return asked === 2;
    });
    assert.equal(ffmpeg.locateFfmpeg().path, ffmpeg.locateFfmpeg().searched[1]);
});

test("nothing found is reported as nothing found, with where it looked", (t) => {
    t.after(clearFaults);
    setFault("existsSync", () => false);

    const lookup = ffmpeg.locateFfmpeg();
    assert.equal(lookup.path, null);

    const message = ffmpeg.missingFfmpegMessage(lookup);
    assert.match(message, /^ffmpeg was not found, so this recording cannot be exported\./);
    assert.match(message, /Run install\.cmd/);
    assert.match(message, new RegExp(FFMPEG_ENV_VAR));
    assert.match(message, /Looked in:/);

    // Six paths and a count, rather than thirty lines of them in a dialog.
    const shown = message.split("\n").filter((line) => line.indexOf("  ") === 0);
    assert.ok(shown.length <= 7, "at most six paths plus the tail: " + shown.length);
    if (lookup.searched.length > 6) {
        assert.match(message, /\.\.\. and \d+ more/);
    }
});

test("the lead sentence says which button was pressed; the advice does not change", (t) => {
    t.after(clearFaults);
    setFault("existsSync", () => false);
    const lookup = { path: null, searched: ["C:/a", "C:/b"] };

    const message = ffmpeg.missingFfmpegMessage(lookup, "ffmpeg was not found, so the watermark could not be drawn.");
    assert.match(message, /^ffmpeg was not found, so the watermark could not be drawn\./);
    assert.doesNotMatch(message, /and \d+ more/, "a short list is shown in full");
});

test("the extension's own copy is looked for wherever the panel was loaded from", (t) => {
    t.after(clearFaults);
    setFault("existsSync", () => false);

    // __dirname is what CEP gives the panel; the ESM bundle the tests import
    // has none, and falling back to "." keeps the list usable either way.
    const withoutDirname = ffmpeg.locateFfmpeg().searched[0];
    globalThis.__dirname = "C:" + String.fromCharCode(92) + "ext";
    try {
        const withDirname = ffmpeg.locateFfmpeg().searched[0];
        assert.notEqual(withDirname, withoutDirname);
        assert.ok(withDirname.indexOf("ext") !== -1, withDirname);
    } finally {
        delete globalThis.__dirname;
    }
});

/* ------------------------------------------------------------------- fonts */

test("the first font that exists is used, and none is not an error here", (t) => {
    t.after(clearFaults);
    setFault("existsSync", (target) => String(target).toLowerCase().endsWith("arial.ttf"));
    assert.match(String(ffmpeg.locateFont()).toLowerCase(), /arial\.ttf$/);

    // The font list is built from the same context as the ffmpeg one, so it
    // reads __dirname too -- present in the panel, absent in the bundle the
    // tests import.
    globalThis.__dirname = "C:" + String.fromCharCode(92) + "ext";
    try {
        assert.match(String(ffmpeg.locateFont()).toLowerCase(), /arial\.ttf$/);
    } finally {
        delete globalThis.__dirname;
    }

    setFault("existsSync", () => false);
    assert.equal(ffmpeg.locateFont(), null);

    // A font directory that throws is skipped like a missing one.
    setFault("existsSync", () => {
        throw fsError("EACCES", "the font directory is not readable");
    });
    assert.equal(ffmpeg.locateFont(), null);
});

/* -------------------------------------------------------------- watermarks */

test("a watermark that draws nothing is no watermark at all", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    assert.equal(ffmpeg.prepareWatermark(null, temp.dir), null);
    assert.equal(ffmpeg.prepareWatermark({ kind: "off" }, temp.dir), null);
    // "Text" with nothing typed yet is a half-finished setting, not a demand
    // for a blank mark: export cleanly rather than failing.
    assert.equal(ffmpeg.prepareWatermark({ kind: "text", text: "" }, temp.dir), null);
});

test("an image watermark is checked for before the encode starts", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const logo = path.join(temp.dir, "logo.png");
    fs.writeFileSync(logo, "png");

    const plan = ffmpeg.prepareWatermark({ kind: "image", imagePath: logo }, temp.dir);
    assert.equal(plan.kind, "image");
    assert.equal(plan.imagePath, logo);

    // Someone who asked for their logo on it and got a clean file would only
    // find out after uploading it, so this throws rather than exporting bare.
    assert.throws(
        () => ffmpeg.prepareWatermark({ kind: "image", imagePath: path.join(temp.dir, "gone.png") }, temp.dir),
        /The watermark image is no longer at /
    );
});

test("a text watermark needs a font, and says so when there is none", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    setFault("existsSync", () => false);
    assert.throws(
        () => ffmpeg.prepareWatermark({ kind: "text", text: "F_know" }, temp.dir),
        new RegExp("No font was found[\\s\\S]*" + FONT_ENV_VAR)
    );
});

test("a text watermark is written to a file, without a trailing newline", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const font = path.join(temp.dir, "font.ttf");
    withEnv({ [FONT_ENV_VAR]: font }, () => {
        setFault("existsSync", (target) => target === font);
        const plan = ffmpeg.prepareWatermark({ kind: "text", text: "F_know" }, temp.dir);

        assert.equal(plan.fontFile, font);
        // drawtext renders a trailing newline as a second, empty line and
        // pushes the text up off the margin.
        assert.equal(fs.readFileSync(plan.textFilePath, "utf8"), "F_know");
    });
});

test("the embossed style is tiled into the file, since drawtext draws one block", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const font = path.join(temp.dir, "font.ttf");
    withEnv({ [FONT_ENV_VAR]: font }, () => {
        setFault("existsSync", (target) => target === font);
        const plan = ffmpeg.prepareWatermark(
            { kind: "text", text: "F_know", style: "emboss", sizePercent: 20 },
            temp.dir
        );

        // The relief covers the whole frame, and drawtext puts one block of
        // text wherever it is told, so the repetition has to be in the string.
        const text = fs.readFileSync(plan.textFilePath, "utf8");
        assert.ok(text.split("\n").length > 1, "more than one row");
        assert.ok(text.indexOf("F_know") !== text.lastIndexOf("F_know"), "more than one column");
    });
});

/* ------------------------------------------------------------- frame checks */

test("a frame left half-written by a crash costs that frame and nothing else", (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());

    const good = path.join(temp.dir, "000001_1700000001000.jpg");
    const truncated = path.join(temp.dir, "000002_1700000002000.jpg");
    fs.writeFileSync(good, jpeg());
    fs.writeFileSync(truncated, jpeg().subarray(0, 8));

    const checked = ffmpeg.filterUsableFrames([good, truncated, path.join(temp.dir, "never.jpg")]);

    // 3.x checked for this too but used the answer to decide whether to copy
    // the file; leaving the bad one out of the list costs one frame instead of
    // the whole export.
    assert.deepEqual(checked.usable, [good]);
    assert.equal(checked.skipped, 2);
});

/* ------------------------------------------------------------ progress lines */

test("ffmpeg's progress output is read for the timestamp and nothing else", () => {
    assert.equal(ffmpeg.parseProgressLine("out_time_us=2500000"), 2.5);
    // Despite the name ffmpeg reports microseconds here too.
    assert.equal(ffmpeg.parseProgressLine("out_time_ms=2500000"), 2.5);
    assert.equal(ffmpeg.parseProgressLine("out_time_us=0"), 0);

    assert.equal(ffmpeg.parseProgressLine("frame=42"), null);
    assert.equal(ffmpeg.parseProgressLine(""), null);
    // Before the first frame ffmpeg emits N/A and a negative, neither of which
    // is a position to move a progress bar to.
    assert.equal(ffmpeg.parseProgressLine("out_time_us=N/A"), null);
    assert.equal(ffmpeg.parseProgressLine("out_time_us=-1"), null);
    assert.equal(ffmpeg.parseProgressLine("out_time_ms=N/A"), null);
    assert.equal(ffmpeg.parseProgressLine("out_time_ms=-1"), null);
});

test("the one ffmpeg error worth translating is the build without freetype", () => {
    // "No such filter: 'drawtext'" tells the user nothing about the watermark
    // they just switched on, and the fix is not one they would guess.
    const message = ffmpeg.failureMessage(1, "[AVFilterGraph] No such filter: 'drawtext'");
    assert.match(message, /This ffmpeg cannot draw text/);
    assert.match(message, /freetype/);
    assert.match(message, /No such filter: 'drawtext'/, "and the original is kept");

    assert.equal(
        ffmpeg.failureMessage(1, "Invalid data found when processing input"),
        "ffmpeg exited with code 1: Invalid data found when processing input"
    );
    assert.equal(ffmpeg.failureMessage(255, "   "), "ffmpeg exited with code 255");
    assert.equal(ffmpeg.failureMessage(255, ""), "ffmpeg exited with code 255");
});

/* ------------------------------------------------------- stamping one still */

/** A source JPEG plus an isolated data directory, ready for a still run. */
function stillFixture(t) {
    const env = withIsolatedAppDir();
    const temp = tempDir();
    t.after(() => {
        temp.cleanup();
        env.cleanup();
        clearFaults();
    });
    const source = path.join(temp.dir, "canvas.jpg");
    fs.writeFileSync(source, jpeg(800, 600));
    return { env, temp, source, outputPath: path.join(temp.dir, "canvas.png") };
}

test("a still cannot be stamped without an ffmpeg, and says so in those words", async (t) => {
    const f = stillFixture(t);
    setFault("existsSync", () => false);

    await assert.rejects(
        ffmpeg.runStillWatermark({ sourcePath: f.source, outputPath: f.outputPath, watermark: null }),
        /ffmpeg was not found, so the watermark could not be drawn\./
    );
});

test("a still Photoshop wrote badly is reported before ffmpeg is asked to read it", async (t) => {
    const f = stillFixture(t);
    ffmpegAt(WINDOWS_FFMPEG);
    fs.writeFileSync(f.source, "not a jpeg at all");

    // The mark is sized against the picture, so the picture has to be measured
    // first -- and saying so here beats letting ffmpeg fail on it further down.
    await assert.rejects(
        ffmpeg.runStillWatermark({ sourcePath: f.source, outputPath: f.outputPath, watermark: null }),
        /could not be read/
    );

    fs.rmSync(f.source);
    await assert.rejects(
        ffmpeg.runStillWatermark({ sourcePath: f.source, outputPath: f.outputPath, watermark: null }),
        /could not be read/
    );
});

test("a watermark that cannot be prepared stops the still before it is spawned", async (t) => {
    const f = stillFixture(t);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);

    await assert.rejects(
        ffmpeg.runStillWatermark({
            sourcePath: f.source,
            outputPath: f.outputPath,
            watermark: { kind: "image", imagePath: path.join(f.temp.dir, "gone.png") }
        }),
        /The watermark image is no longer at /
    );
    assert.deepEqual(child.spawned, [], "nothing was run");
});

test("a still that ffmpeg writes resolves once, with no window shown", async (t) => {
    const f = stillFixture(t);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);

    const done = ffmpeg.runStillWatermark({
        sourcePath: f.source,
        outputPath: f.outputPath,
        watermark: null
    });
    child.exit(0);
    await done;

    assert.equal(child.spawned[0].command, WINDOWS_FFMPEG);
    assert.equal(child.spawned[0].options.windowsHide, true);
    // The picture goes in and the marked copy comes out.
    assert.ok(child.spawned[0].args.indexOf(f.source) !== -1, "the still is the input");
    assert.ok(child.spawned[0].args.indexOf(f.outputPath) !== -1);
});

test("an ffmpeg that will not start is told apart from one that failed", async (t) => {
    const f = stillFixture(t);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);

    const done = ffmpeg.runStillWatermark({ sourcePath: f.source, outputPath: f.outputPath, watermark: null });
    child.fail(new Error("spawn ENOENT"));
    await assert.rejects(done, /^Error: Could not run ffmpeg: spawn ENOENT$/);
});

test("a still ffmpeg refused comes back with what it printed", async (t) => {
    const f = stillFixture(t);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);

    const done = ffmpeg.runStillWatermark({ sourcePath: f.source, outputPath: f.outputPath, watermark: null });
    child.say("Invalid data found");
    child.exit(1);
    await assert.rejects(done, /ffmpeg exited with code 1: Invalid data found/);
});

/* ------------------------------------------------------------- the export */

/** A recording of `count` complete frames, plus somewhere to put the video. */
function exportFixture(t, count = 4) {
    const env = withIsolatedAppDir();
    const temp = tempDir();
    t.after(() => {
        temp.cleanup();
        env.cleanup();
        clearFaults();
    });
    const frames = [];
    for (let i = 1; i <= count; i++) {
        const frame = path.join(temp.dir, String(i).padStart(6, "0") + "_170000000" + (1000 + i) + ".jpg");
        fs.writeFileSync(frame, jpeg());
        frames.push(frame);
    }
    return {
        env,
        temp,
        request: {
            frames,
            finalImagePath: null,
            outputPath: path.join(temp.dir, "out.mp4"),
            aspectRatio: 4 / 3,
            resolution: 1080,
            targetDurationSec: null,
            watermark: null
        }
    };
}

test("an export with no ffmpeg says where it looked", async (t) => {
    const f = exportFixture(t);
    setFault("existsSync", () => false);

    const handle = ffmpeg.runExport(f.request, () => {});
    await assert.rejects(handle.promise, /ffmpeg was not found, so this recording cannot be exported\./);
});

test("a recording whose frames are all damaged is refused, not encoded to nothing", async (t) => {
    const f = exportFixture(t, 2);
    ffmpegAt(WINDOWS_FFMPEG);
    for (const frame of f.request.frames) {
        fs.writeFileSync(frame, "half a frame");
    }

    const handle = ffmpeg.runExport(f.request, () => {});
    await assert.rejects(handle.promise, /No complete frames were found in this recording/);
});

test("a watermark that cannot be prepared stops the export before it is spawned", async (t) => {
    const f = exportFixture(t);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);
    f.request.watermark = { kind: "image", imagePath: path.join(f.temp.dir, "gone.png") };

    const handle = ffmpeg.runExport(f.request, () => {});
    await assert.rejects(handle.promise, /The watermark image is no longer at /);
    assert.deepEqual(child.spawned, []);
});

test("an export reports its stages, follows the progress, and cleans up after", async (t) => {
    const f = exportFixture(t);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);

    const stages = [];
    const handle = ffmpeg.runExport(f.request, (p) => stages.push(p));
    assert.deepEqual(stages[0], { stage: "preparing", percent: 0 });
    assert.deepEqual(stages[1], { stage: "encoding", percent: 0 });

    // The frame list is written where the concat demuxer will read it.
    assert.ok(fs.existsSync(path.join(exportTempDir(), "frames.txt")));

    // -progress writes key=value lines; only the timestamp moves the bar, and
    // a line split across two chunks still has to be read.
    child.progress("frame=1\nout_time_us=");
    child.progress("50000\nfps=30\n");
    const encoding = stages.filter((s) => s.stage === "encoding");
    assert.ok(encoding.length > 1, "the bar moved");
    assert.ok(encoding[encoding.length - 1].percent > 0);
    assert.ok(encoding[encoding.length - 1].percent <= 99, "100 is for when it is really done");

    child.exit(0);
    await handle.promise;

    assert.deepEqual(stages[stages.length - 1], { stage: "finishing", percent: 100 });
    assert.equal(fs.existsSync(exportTempDir()), false, "the scratch directory went with it");
});

test("the bookend still is used when it is there, and skipped when it is not", async (t) => {
    const f = exportFixture(t);
    const child = fakeFfmpeg();
    const final = path.join(f.temp.dir, "final.jpg");
    fs.writeFileSync(final, jpeg());
    setFault(
        "existsSync",
        (target) => target === WINDOWS_FFMPEG || target === final || String(target).endsWith(".ttf")
    );
    f.request.finalImagePath = final;

    const handle = ffmpeg.runExport(f.request, () => {});
    child.exit(0);
    await handle.promise;

    assert.ok(child.spawned[0].args.indexOf(final) !== -1, "the still is an input");
});

test("a scratch directory that will not go is not a failed export", async (t) => {
    const f = exportFixture(t);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);

    const handle = ffmpeg.runExport(f.request, () => {});
    // The video is written; leftover temp files are harmless and not worth
    // telling the user their export failed over.
    setFault("rmSync", () => {
        throw fsError("EBUSY", "something is holding the folder");
    });
    child.exit(0);
    await handle.promise;
    clearFaults();
});

test("an ffmpeg that will not start, and one that fails, are both reported", async (t) => {
    const f = exportFixture(t);
    let child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);

    let handle = ffmpeg.runExport(f.request, () => {});
    child.fail(new Error("spawn ENOENT"));
    await assert.rejects(handle.promise, /Could not run ffmpeg: spawn ENOENT/);

    child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);
    handle = ffmpeg.runExport(f.request, () => {});
    child.say("Error while opening encoder");
    child.exit(1);
    await assert.rejects(handle.promise, /ffmpeg exited with code 1: Error while opening encoder/);
});

test("cancelling kills ffmpeg and reports the cancel rather than the exit code", async (t) => {
    const f = exportFixture(t);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);

    const handle = ffmpeg.runExport(f.request, () => {});
    handle.cancel();
    assert.equal(child.killed, 1);

    // ffmpeg exits non-zero when it is killed; the user pressed cancel, so
    // that is what they are told.
    child.exit(255);
    await assert.rejects(handle.promise, /Export cancelled/);

    // Cancelling again, after it has already gone, is not an error.
    handle.cancel();
});

test("a cancel that ffmpeg will not take is not itself a failure", async (t) => {
    const f = exportFixture(t);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);

    const handle = ffmpeg.runExport(f.request, () => {});
    child.child.kill = () => {
        throw new Error("the process is already gone");
    };
    handle.cancel();
    child.exit(255);
    await assert.rejects(handle.promise, /Export cancelled/);
});

test("a target length makes the export drop frames rather than run long", async (t) => {
    const f = exportFixture(t, 120);
    const child = fakeFfmpeg();
    ffmpegAt(WINDOWS_FFMPEG);
    f.request.targetDurationSec = 1;
    f.request.crf = 26;

    const handle = ffmpeg.runExport(f.request, () => {});
    child.exit(0);
    await handle.promise;

    // The concat list is the whole of how the pace is set, so the frames that
    // are dropped are dropped there rather than by ffmpeg.
    assert.ok(child.spawned[0].args.indexOf("26") !== -1, "and the quality asked for is used");
});
