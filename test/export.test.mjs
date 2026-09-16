/**
 * Export planning: the concat list and the ffmpeg command.
 *
 * These are pure so the whole pipeline can be checked without ffmpeg on the
 * machine. The list format matters more than it looks: the concat demuxer
 * ignores the duration of the final entry, which is why the last frame is
 * listed twice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildConcatList,
    buildFfmpegArgs,
    buildStillArgs,
    expectedOutputSeconds,
    jpegSize,
    looksLikeCompleteJpeg,
    outputSize,
    buildEmbossTileStack,
    buildWatermarkFilter,
    embossMetrics,
    embossTiling,
    escapeFilterValue,
    quoteConcatPath,
    selectFrames,
    sequenceSeconds,
    speedForTarget,
    stillSize,
    tileWatermarkText,
    toFramePaths,
    DEFAULT_FPS,
    INTRO_SECONDS,
    OUTRO_SECONDS
} from "../dist/modules/exportPlan.mjs";

function frames(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push("C:\\frames\\" + String(i).padStart(6, "0") + ".jpg");
    }
    return out;
}

test("a frame sequence runs at one frame per output frame", () => {
    assert.equal(sequenceSeconds(900, 30), 30);
    assert.equal(sequenceSeconds(0, 30), 0);
    // A nonsense fps must not divide by zero.
    assert.ok(Number.isFinite(sequenceSeconds(10, 0)));
});

test("speeding a recording up actually shortens it", () => {
    // 900 frames = 30s at 30fps, asked to run at a tenth of that.
    const kept = selectFrames(frames(900), 0.1);
    assert.ok(
        Math.abs(sequenceSeconds(kept.length, 30) - 3) < 0.1,
        "a 30s recording at a tenth speed must come out near 3s"
    );
});

test("an awkward speed is not quantised to an integer stride", () => {
    // 0.45 is what a 60s recording asked to fit 30s (minus 3s of bookends)
    // works out at. Rounding the stride to 2 or 3 would land on 30s or 20s.
    const kept = selectFrames(frames(1800), 0.45);
    assert.ok(Math.abs(kept.length - 1800 * 0.45) <= 2);
});

test("speeding up keeps the first and last frames", () => {
    const all = frames(900);
    const kept = selectFrames(all, 0.017);
    assert.equal(kept[0], all[0]);
    assert.equal(kept[kept.length - 1], all[all.length - 1], "ends on the finished artwork");
    // No frame is ever listed twice, whatever the multiplier.
    assert.equal(new Set(kept).size, kept.length);
});

test("a speed of 1 or more leaves every frame in place", () => {
    assert.equal(selectFrames(frames(50), 1).length, 50);
    assert.equal(selectFrames(frames(50), 2).length, 50, "never pad with duplicates");
    assert.equal(selectFrames(frames(50), 0).length, 50, "nonsense speed changes nothing");
});

test("speedForTarget only ever speeds up", () => {
    // A 10s recording asked to fill 60s: stay at 1, do not pad with duplicates.
    assert.equal(speedForTarget(10, 60, 3), 1);
    // A 100s recording asked to fit 15s, minus 3s of bookends.
    assert.equal(speedForTarget(100, 15, 3), 0.12);
    // No target means no change.
    assert.equal(speedForTarget(100, null, 3), 1);
});

test("speedForTarget survives a target shorter than the bookends", () => {
    const speed = speedForTarget(100, 2, 3);
    assert.ok(speed > 0 && speed <= 1, "clamped rather than negative or zero");
});

test("the concat list repeats the final frame so its duration is honoured", () => {
    const list = buildConcatList(frames(3), 30);
    const lines = list.trim().split("\n");

    assert.equal(lines[0], "ffconcat version 1.0");
    const fileLines = lines.filter((line) => line.startsWith("file "));
    assert.equal(fileLines.length, 4, "3 frames plus the repeated last one");
    assert.equal(fileLines[2], fileLines[3]);

    const durationLines = lines.filter((line) => line.startsWith("duration "));
    assert.equal(durationLines.length, 3);
    for (const line of durationLines) {
        assert.ok(Math.abs(parseFloat(line.slice("duration ".length)) - 1 / 30) < 1e-6);
    }
});

test("concat paths are POSIX-quoted, and quotes inside a path are escaped", () => {
    assert.equal(quoteConcatPath("C:\\art\\a.jpg"), "'C:/art/a.jpg'");
    assert.equal(quoteConcatPath("C:\\it's\\a.jpg"), "'C:/it'\\''s/a.jpg'");
});

test("buildConcatList refuses an empty recording rather than emitting a broken list", () => {
    assert.throws(() => buildConcatList([], 30), /No frames/);
});

test("the ffmpeg command normalises frame size and encodes in one pass", () => {
    const args = buildFfmpegArgs({
        width: 1920,
        height: 1080,
        fps: 30,
        concatListPath: "C:\\temp\\frames.txt",
        finalImagePath: "C:\\temp\\final.jpg",
        outputPath: "C:\\out\\video.mp4",
        mainSeconds: 42,
        crf: 20,
        padColor: "white",
        workingFormat: "yuv420p",
        watermark: null
    });
    const joined = args.join(" ");

    assert.ok(joined.includes("-f concat -safe 0 -i C:\\temp\\frames.txt"));
    assert.ok(joined.includes("force_original_aspect_ratio=decrease"), "frames of differing sizes are letterboxed");
    assert.ok(joined.includes("pad=1920:1080"), "not stretched");
    assert.ok(joined.includes("concat=n=3:v=1:a=0"), "intro + body + outro");
    assert.ok(joined.includes("fade=t=in"), "the outro fades in");
    assert.ok(joined.includes("-progress pipe:1"), "machine-readable progress");
    assert.ok(joined.includes("-pix_fmt yuv420p"), "playable outside ffmpeg");
    assert.equal(args[args.length - 1], "C:\\out\\video.mp4");

    // One input per source and exactly one output: no intermediate .ts files.
    assert.equal(args.filter((a) => a === "-i").length, 2);
});

test("with no final still, the video is just the frames", () => {
    const args = buildFfmpegArgs({
        width: 1280,
        height: 720,
        fps: 30,
        concatListPath: "list.txt",
        finalImagePath: null,
        outputPath: "out.mp4",
        mainSeconds: 10,
        crf: 20,
        padColor: "white",
        workingFormat: "yuv420p",
        watermark: null
    });
    const joined = args.join(" ");
    assert.equal(args.filter((a) => a === "-i").length, 1);
    assert.ok(!joined.includes("concat=n=3"));
    assert.ok(joined.includes("[main]null[out]"));
});

test("output dimensions are always even, as H.264 with yuv420p requires", () => {
    for (const ratio of [16 / 9, 4 / 3, 1, 0.75, 9 / 16, 2.35]) {
        for (const resolution of [360, 720, 1080, 1440, 2160]) {
            const size = outputSize(ratio, resolution);
            assert.equal(size.width % 2, 0, `width ${size.width} for ratio ${ratio}`);
            assert.equal(size.height % 2, 0, `height ${size.height} for ratio ${ratio}`);
            assert.ok(size.width >= 2 && size.height >= 2);
        }
    }
});

test("a zero aspect ratio falls back to 16:9 instead of dividing by zero", () => {
    const size = outputSize(0, 1080);
    assert.ok(Number.isFinite(size.width) && Number.isFinite(size.height));
    assert.equal(size.width % 2, 0);
});

test("expected output length accounts for the bookends", () => {
    assert.equal(expectedOutputSeconds(10, false), 10);
    assert.equal(expectedOutputSeconds(10, true), 10 + INTRO_SECONDS + OUTRO_SECONDS);
});

test("truncated JPEGs are recognised so one bad frame cannot fail the export", () => {
    const good = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
    assert.equal(looksLikeCompleteJpeg(good), true);

    // Written but never finished: no end-of-image marker.
    assert.equal(looksLikeCompleteJpeg(Buffer.from([0xff, 0xd8, 0x11, 0x22])), false);
    // Not a JPEG at all.
    assert.equal(looksLikeCompleteJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
    assert.equal(looksLikeCompleteJpeg(Buffer.alloc(0)), false);
});

test("DEFAULT_FPS is a sane constant", () => {
    assert.ok(DEFAULT_FPS >= 24 && DEFAULT_FPS <= 60);
});

test("toFramePaths orders by sequence number, not filename", () => {
    // Past 999,999 the names gain a digit; sorted as strings "1000000" would
    // come before "999999" and the tail of a long recording would be scrambled.
    const join = (a, b) => a + "/" + b;
    const refs = toFramePaths(
        "frames",
        ["1000001_1700000003000.jpg", "999999_1700000001000.jpg", "1000000_1700000002000.jpg", "session.json"],
        join
    );
    assert.deepEqual(refs, [
        "frames/999999_1700000001000.jpg",
        "frames/1000000_1700000002000.jpg",
        "frames/1000001_1700000003000.jpg"
    ]);
});

test("toFramePaths falls back to 3.x names so old recordings stay exportable", () => {
    const join = (a, b) => a + "/" + b;
    const refs = toFramePaths("old", ["000002.jpg", "000010.jpg", "000001.jpg", "notes.txt"], join);
    assert.deepEqual(refs, ["old/000001.jpg", "old/000002.jpg", "old/000010.jpg"]);
});

test("toFramePaths prefers current naming and ignores strays", () => {
    const join = (a, b) => a + "/" + b;
    const refs = toFramePaths(
        "mixed",
        ["000001_1700000001000.jpg", "000002.jpg", "session.json", "000003_1700000003000.jpg.part"],
        join
    );
    assert.deepEqual(refs, ["mixed/000001_1700000001000.jpg"]);
});

/* ------------------------------------------------------------- watermark */

function plan(watermark, over) {
    return Object.assign(
        {
            width: 1920,
            height: 1080,
            fps: 30,
            concatListPath: "C:\\temp\\frames.txt",
            finalImagePath: "C:\\temp\\final.jpg",
            outputPath: "C:\\out\\video.mp4",
            mainSeconds: 42,
            crf: 20,
            padColor: "white",
            workingFormat: "yuv420p",
            watermark: watermark
        },
        over || {}
    );
}

/** A still plan that, unless told otherwise, comes out at the picture's own size. */
function still(watermark, over) {
    return Object.assign(
        {
            width: 2000,
            height: 1500,
            sourceWidth: 2000,
            sourceHeight: 1500,
            fps: 1,
            workingFormat: "yuv444p",
            sourcePath: "C:\\temp\\canvas.jpg",
            outputPath: "C:\\temp\\canvas.png",
            watermark: watermark
        },
        over || {}
    );
}

function textMark(over) {
    return Object.assign(
        {
            kind: "text",
            textFilePath: "C:\\temp\\watermark.txt",
            fontFile: "C:\\Windows\\Fonts\\msyh.ttc",
            imagePath: "",
            style: "corner",
            position: "bottomRight",
            opacity: 0.7,
            size: 0.06
        },
        over || {}
    );
}

function imageMark(over) {
    return Object.assign(textMark(), { kind: "image", imagePath: "C:\\art\\logo.png" }, over || {});
}

function embossMark(over) {
    return Object.assign(textMark(), { style: "emboss", size: 0.04 }, over || {});
}

test("no watermark leaves the filter graph exactly as it was", () => {
    const args = buildFfmpegArgs(plan(null));
    const joined = args.join(" ");
    assert.ok(joined.includes("concat=n=3:v=1:a=0[out]"), "the bookended video is the output itself");
    assert.ok(!joined.includes("drawtext"));
    assert.ok(!joined.includes("overlay"));
    assert.equal(args.filter((a) => a === "-i").length, 2, "no extra input");
});

test("a text watermark is drawn from a file, so no signature can break the filter graph", () => {
    const args = buildFfmpegArgs(plan(textMark()));
    const joined = args.join(" ");
    assert.ok(joined.includes("concat=n=3:v=1:a=0[body]"), "the mark goes on after the bookends");
    assert.ok(joined.includes("[body]drawtext="));
    assert.ok(joined.includes("textfile=C\\\\:/temp/watermark.txt"), "the text is never inlined");
    assert.ok(joined.includes("fontfile=C\\\\:/Windows/Fonts/msyh.ttc"));
    assert.ok(joined.includes("fontsize=65"), "6% of 1080");
    assert.ok(joined.includes("fontcolor=white@0.700"));
    assert.ok(joined.includes("bordercolor=black@0.700"), "outlined, or it vanishes on a white canvas");
    assert.ok(joined.endsWith("C:\\out\\video.mp4"));
    assert.equal(args.filter((a) => a === "-i").length, 2, "text needs no extra input");
});

test("the text is drawn literally, so a signature ending in % does not fail the export", () => {
    // drawtext expands %{...} and strftime by default: "F_know 100%" died with
    // "Stray %" in a real export, and "%{pts}" would have silently become a
    // timestamp on someone's video.
    const args = buildFfmpegArgs(plan(textMark()));
    assert.ok(args.join(" ").includes(":expansion=none"));
});

test("an image watermark is a third input, scaled and faded by the plan", () => {
    const args = buildFfmpegArgs(plan(imageMark()));
    const joined = args.join(" ");
    assert.equal(args.filter((a) => a === "-i").length, 3);
    assert.equal(args[args.indexOf("-i", args.indexOf("-i", args.indexOf("-i") + 1) + 1) + 1], "C:\\art\\logo.png");
    assert.ok(joined.includes("[2:v]format=rgba,scale=-1:65"), "input 2, behind the concat list and the still");
    assert.ok(joined.includes("colorchannelmixer=aa=0.700"), "a PNG cut-out stays a cut-out");
    assert.ok(joined.includes("[body][wm]overlay="));
});

test("with no bookend still the image watermark moves to input 1", () => {
    const args = buildFfmpegArgs(plan(imageMark(), { finalImagePath: null }));
    const joined = args.join(" ");
    assert.equal(args.filter((a) => a === "-i").length, 2);
    assert.ok(joined.includes("[1:v]format=rgba"));
    assert.ok(joined.includes("[main]null[body]"));
});

test("each corner is placed with the right filter's own variable names", () => {
    const corners = {
        topLeft: { text: "x=32:y=32", image: "overlay=32:32" },
        topRight: { text: "x=w-text_w-32:y=32", image: "overlay=W-w-32:32" },
        bottomLeft: { text: "x=32:y=h-text_h-32", image: "overlay=32:H-h-32" },
        bottomRight: { text: "x=w-text_w-32:y=h-text_h-32", image: "overlay=W-w-32:H-h-32" },
        center: { text: "x=(w-text_w)/2:y=(h-text_h)/2", image: "overlay=(W-w)/2:(H-h)/2" }
    };
    for (const position of Object.keys(corners)) {
        const text = buildWatermarkFilter(plan(textMark({ position })), "body", "out", 2);
        assert.ok(text.includes(corners[position].text), position + " as text");
        const image = buildWatermarkFilter(plan(imageMark({ position })), "body", "out", 2);
        assert.ok(image.includes(corners[position].image), position + " as an image");
    }
});

test("the mark scales with the video rather than sitting at a fixed pixel size", () => {
    const small = buildWatermarkFilter(plan(textMark(), { width: 640, height: 360 }), "body", "out", 2);
    const large = buildWatermarkFilter(plan(textMark(), { width: 3840, height: 2160 }), "body", "out", 2);
    assert.ok(small.includes("fontsize=22"), "6% of 360");
    assert.ok(large.includes("fontsize=130"), "6% of 2160");
    assert.ok(small.includes("x=w-text_w-11"), "and so does the margin");
    assert.ok(large.includes("x=w-text_w-65"));
});

test("a nonsense size or opacity is clamped instead of producing a broken filter", () => {
    const huge = buildWatermarkFilter(plan(textMark({ size: 40, opacity: 12 })), "body", "out", 2);
    assert.ok(huge.includes("fontsize=540"), "half the height, no more");
    assert.ok(huge.includes("white@1.000"));
    const tiny = buildWatermarkFilter(plan(textMark({ size: 0, opacity: 0 })), "body", "out", 2);
    assert.ok(/fontsize=[1-9]/.test(tiny), "never a zero-height mark");
    assert.ok(tiny.includes("white@0.050"), "never fully invisible either");
});

/* --------------------------------------------------------- emboss style */

test("the embossed style blends a relief in rather than drawing on top", () => {
    const filter = buildWatermarkFilter(plan(embossMark()), "body", "out", 2);
    assert.ok(filter.includes("blend=all_mode=grainextract"), "two offset copies make the bevel");
    // 70% of the range this style can use, not 70% of everything: the blend is
    // additive, so an unscaled 0.7 would move brightness by ±90 levels, which
    // is a stamp printed over the drawing rather than a mark pressed into it.
    assert.ok(filter.includes("[body][wm]blend=all_mode=grainmerge:all_opacity=0.210"));
    // Not overlay: it returns pure white and pure black unchanged, and these
    // frames are white paper with near-black lines on them.
    assert.ok(!filter.includes("all_mode=overlay"));
    assert.ok(filter.includes("loop=loop=-1:size=1:start=0"), "the relief is rendered once");
    assert.ok(filter.includes("shortest=1"), "and the looped relief never ends by itself");
});

test("an embossed mark is turned and cropped from a canvas big enough to cover the corners", () => {
    const filter = buildWatermarkFilter(plan(embossMark()), "body", "out", 2);
    // 1920x1080 has a diagonal of 2203, and the canvas has to reach the frame's
    // corners after the rotation, so it is that plus slack, rounded up to even.
    assert.ok(filter.includes("color=c=black:s=2220x2220:r=30"));
    assert.ok(filter.includes("rotate=-30*PI/180:fillcolor=black,crop=1920:1080"));
    assert.ok(filter.includes("fontsize=43"), "4% of 1080");
    assert.ok(!filter.includes("borderw="), "a relief has no outline to draw");
});

test("an embossed image is tiled by doubling, so a big grid costs few filters", () => {
    const filter = buildWatermarkFilter(plan(embossMark({ kind: "image" })), "body", "out", 2);
    assert.ok(filter.includes("[2:v]format=rgba,scale=43:43:force_original_aspect_ratio=decrease"));
    assert.ok(filter.includes("pad=43:43:(ow-iw)/2:(oh-ih)/2:color=black@0[etile]"), "a square cell");
    // 43px doubled six times is 2752, the first size past the 2220 canvas.
    assert.ok(filter.includes("hstack=inputs=2[eh6]"));
    assert.ok(filter.includes("vstack=inputs=2[ev6]"));
    assert.ok(!filter.includes("[eh7]"), "and it stops as soon as it is covered");
    assert.ok(filter.includes("[ebg][ev6]overlay="), "flattened onto black so alpha becomes shape");
});

test("the tile stack stops as soon as the cell covers the canvas", () => {
    const none = buildEmbossTileStack(600, 400, "etile");
    assert.deepEqual(none.chains, [], "a cell already bigger than the canvas needs no stacking");
    assert.equal(none.label, "etile");
    const one = buildEmbossTileStack(300, 400, "etile");
    assert.equal(one.label, "ev1");
    assert.equal(one.chains.length, 4, "one doubling across and one down");
});

test("the emboss bevel stays well inside one stroke of the mark", () => {
    const small = embossMetrics(1920, 1080, 0.04);
    const huge = embossMetrics(1920, 1080, 0.5);
    // 43px of type, so the two copies travel 2px apart: any further and they
    // stop overlapping inside a stroke, and the mark is drawn twice -- once
    // white, once black -- instead of being pressed in once.
    assert.equal(small.depth, 2);
    assert.equal(huge.depth, 10, "capped, or the letters become two smeared ghosts");
    assert.equal(small.square, huge.square, "the canvas depends on the frame, not the mark");
});

test("the emboss stays a relief even at full opacity", () => {
    const full = buildWatermarkFilter(plan(embossMark({ opacity: 1 })), "body", "out", 2);
    assert.ok(full.includes("all_opacity=0.300"), "the anti-theft end, not a stamp");
    const faint = buildWatermarkFilter(plan(embossMark({ opacity: 0 })), "body", "out", 2);
    assert.ok(faint.includes("all_opacity=0.015"), "and never nothing at all");
    // The corner style is untouched: there the number is one badge's alpha.
    const corner = buildWatermarkFilter(plan(textMark({ opacity: 1 })), "body", "out", 2);
    assert.ok(corner.includes("white@1.000"));
});

test("the emboss mask is softened before the two copies are subtracted", () => {
    const filter = buildWatermarkFilter(plan(embossMark()), "body", "out", 2);
    const mask = filter.indexOf("gblur=sigma=3.00,split=2[eup][edn]");
    assert.ok(mask !== -1, "half again the offset, so thin strokes ridge instead of ghosting");
    assert.ok(mask < filter.indexOf("grainextract"), "and before the subtraction, not after");
    assert.ok(
        !/grainextract,gblur/.test(filter),
        "blurring the relief afterwards only feathers a bevel that already went wrong"
    );
});

test("a size below the emboss floor is raised, since the tiling would not reach the edge", () => {
    assert.equal(embossMetrics(1920, 1080, 0.005).mark, embossMetrics(1920, 1080, 0.02).mark);
    const tiling = embossTiling(0.005, 1);
    assert.ok(tiling.columns <= 80 && tiling.rows <= 80, "and the repeat count stays bounded");
});

test("the text is repeated enough to cover the frame, with rows offset", () => {
    const tiling = embossTiling(0.04, "F_know".length);
    assert.ok(tiling.columns >= 8, "9 chars at 4% of the height, across a 2.2x diagonal");
    assert.ok(tiling.rows >= 30);
    const block = tileWatermarkText("ab", 3, 4).split("\n");
    assert.equal(block.length, 4);
    assert.equal(block[0], "ab   ab   ab");
    assert.equal(block[1], "   ab   ab   ab", "every other row starts half a cell in");
    assert.equal(block[2], block[0]);
});

/* ----------------------------------------------------------------- still */

test("a still planned at its own size is not resized, and comes out as one frame", () => {
    const args = buildStillArgs(still(null));
    const joined = args.join(" ");
    assert.equal(args.filter((a) => a === "-i").length, 1);
    assert.ok(!joined.includes("scale="), "the original was asked for, or the canvas fits the budget");
    assert.ok(!joined.includes("pad="), "and nothing is letterboxed either");
    assert.ok(joined.includes("-frames:v 1 -update 1"), "one picture, not an image sequence");
    assert.equal(args[args.length - 1], "C:\\temp\\canvas.png");
});

test("a still bigger than its plan is scaled down on the way in", () => {
    const args = buildStillArgs(still(null, { sourceWidth: 4000, sourceHeight: 3000 })).join(" ");
    assert.ok(args.includes("scale=2000:1500:flags=lanczos"), "to the plan's size, with a filter fit for line art");
    assert.ok(args.includes("format=yuv444p,scale="), "at full chroma, so colour and line are scaled at one resolution");
    assert.ok(!args.includes("pad="), "the shape is the canvas's own");
    // Either side differing is enough; a plan is never the source's width at
    // another height, but the check is on both.
    assert.ok(buildStillArgs(still(null, { sourceHeight: 3000 })).join(" ").includes("scale="));
});

test("the mark goes on after the scale, so it is sized against what is copied", () => {
    const args = buildStillArgs(still(textMark(), { sourceWidth: 4000, sourceHeight: 3000 })).join(" ");
    assert.ok(args.indexOf("scale=") < args.indexOf("drawtext"));
});

test("how big the copy comes out is the recording's own rule, unless the original is asked for", () => {
    assert.deepEqual(
        stillSize({ width: 4000, height: 3000 }, "1080"),
        { width: 1663, height: 1247 },
        "exactly the size a 1080p frame of this canvas records at"
    );
    assert.deepEqual(stillSize({ width: 4000, height: 3000 }, "original"), { width: 4000, height: 3000 });
    assert.deepEqual(stillSize({ width: 800, height: 600 }, "1080"), { width: 800, height: 600 }, "never upscaled");
});

test("the still is marked by the very filters an export uses", () => {
    const corner = buildStillArgs(still(textMark())).join(" ");
    assert.ok(corner.includes("drawtext"));
    assert.ok(corner.includes("[body]drawtext"), "the mark goes on the picture, not beside it");
    assert.ok(corner.includes("[out]"));

    const emboss = buildStillArgs(still(embossMark())).join(" ");
    assert.ok(emboss.includes("blend=all_mode=grainmerge"), "the relief is pressed in");
});

test("a still carries full chroma, so copying a drawing does not soften its colour", () => {
    const args = buildStillArgs(still(embossMark())).join(" ");
    assert.ok(args.includes("[0:v]format=yuv444p"), "the picture itself");
    // blend refuses two different formats, so the relief has to follow suit.
    assert.ok(args.includes(",format=yuv444p,loop="), "and the relief it is blended with");
    assert.ok(!args.includes("yuv420p"), "nothing is subsampled on the way to the clipboard");
});

test("an image watermark on a still is input 1, since there is no bookend to take it", () => {
    const args = buildStillArgs(still(imageMark()));
    assert.equal(args.filter((a) => a === "-i").length, 2);
    assert.ok(args.join(" ").includes("[1:v]format=rgba"));
});

test("a JPEG's frame header gives up its size, whatever precedes it", () => {
    // SOI, an APP0 that has to be stepped over, then SOF0: 8-bit, 1500x2000.
    const jpeg = Buffer.from([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0xdc, 0x07, 0xd0, 0x03
    ]);
    assert.deepEqual(jpegSize(jpeg), { width: 2000, height: 1500 });

    // Progressive JPEGs use SOF2 and are just as measurable.
    const progressive = Buffer.from(jpeg);
    progressive[9] = 0xc2;
    assert.deepEqual(jpegSize(progressive), { width: 2000, height: 1500 });
});

test("anything that is not a measurable JPEG says so rather than guessing", () => {
    assert.equal(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null, "a PNG");
    assert.equal(jpegSize(Buffer.from([])), null);
    assert.equal(jpegSize(null), null, "nothing read at all");
    // Truncated mid-header: SOI, then a frame marker whose payload never arrives.
    assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08])), null);
    // A DHT is in the SOF range but carries no dimensions; it must be skipped,
    // not read as a frame header.
    const dhtOnly = Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda]);
    assert.equal(jpegSize(dhtOnly), null);
});

test("the scan steps over padding, fill bytes and standalone markers", () => {
    // Everything before the frame header that a real encoder is allowed to
    // emit: a stray byte, 0xff used as fill, a restart marker and a bare 0x01.
    // Each has its own way of not being a segment, and reading any of them as
    // one would walk the offset into the middle of the entropy-coded data.
    const jpeg = Buffer.from([
        0xff, 0xd8,
        0x00, // not a marker at all
        0xff, 0xff, // fill before the next marker
        0xff, 0xd0, // RST0: stands alone
        0xff, 0x01, // TEM: stands alone
        0xff, 0xc1, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03
    ]);
    assert.deepEqual(jpegSize(jpeg), { width: 200, height: 100 });
});

test("entropy-coded data means the header is behind us and was not found", () => {
    // SOS with no frame header before it: the rest of the file is compressed
    // scan data, so there is nothing left to measure and guessing would be
    // worse than admitting it.
    const sos = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02]);
    assert.equal(jpegSize(sos), null);

    const eoi = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(jpegSize(eoi), null);
});

test("a segment that claims an impossible length is not walked off the end of", () => {
    // The length word counts itself, so anything under 2 is corrupt. Trusting
    // it would move the offset backwards and spin.
    const corrupt = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(jpegSize(corrupt), null);
});

test("a frame header with no picture in it is not a size", () => {
    // 0x0000 in either field: a file that says it is zero pixels wide cannot
    // be scaled, and returning {width: 0} would divide by it downstream.
    const zeroWide = Buffer.from([
        0xff, 0xd8,
        0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0x00, 0x03
    ]);
    assert.equal(jpegSize(zeroWide), null);
});

test("filter values are escaped, so a path with a drive letter or a quote survives", () => {
    assert.equal(escapeFilterValue("C:\\Users\\a\\font.ttf"), "C\\\\:/Users/a/font.ttf");
    assert.equal(
        escapeFilterValue("D:/it's [odd], really;"),
        "D\\\\:/it\\\\\\'s \\[odd\\]\\, really\\;"
    );
});
