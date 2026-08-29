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
    expectedOutputSeconds,
    frameDurations,
    looksLikeCompleteJpeg,
    outputSize,
    quoteConcatPath,
    speedForTarget,
    toFrameRefs,
    totalSeconds,
    DEFAULT_FPS,
    INTRO_SECONDS,
    OUTRO_SECONDS
} from "../dist/test/exportPlan.mjs";

function frames(count, stepMs = 1000, startMs = 1700000000000) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push({ path: "C:\\frames\\" + String(i).padStart(6, "0") + ".jpg", timestampMs: startMs + i * stepMs });
    }
    return out;
}

test("fixed pacing gives every frame one output frame's worth of time", () => {
    const durations = frameDurations(frames(10), { fps: 30, timing: "fixed", speed: 1 });
    assert.equal(durations.length, 10);
    for (const d of durations) {
        assert.ok(Math.abs(d - 1 / 30) < 1e-9);
    }
});

test("real-time pacing uses the gaps between captures", () => {
    // Frames two seconds apart in wall time.
    const durations = frameDurations(frames(4, 2000), { fps: 30, timing: "realtime", speed: 1 });
    // Capped at MAX_REALTIME_FRAME_SECONDS (2s), so each gap lands exactly on 2.
    assert.equal(durations[0], 2);
    assert.equal(durations[1], 2);
    assert.equal(durations[2], 2);
    // The final frame has no successor, so it gets the base duration.
    assert.ok(Math.abs(durations[3] - 1 / 30) < 1e-9);
});

test("real-time pacing clamps long idle gaps instead of stalling the video", () => {
    // Timestamps are real epoch milliseconds: a zero first timestamp is the
    // sentinel for legacy 3.x frames that carry no timing at all.
    const base = 1700000000000;
    const sparse = [
        { path: "a.jpg", timestampMs: base },
        { path: "b.jpg", timestampMs: base + 10 * 60 * 1000 }, // a ten-minute coffee break
        { path: "c.jpg", timestampMs: base + 10 * 60 * 1000 + 500 }
    ];
    const durations = frameDurations(sparse, { fps: 30, timing: "realtime", speed: 1 });
    assert.equal(durations[0], 2, "ten minutes becomes two seconds, not ten minutes");
});

test("real-time pacing falls back to fixed for legacy frames with no timestamps", () => {
    const legacy = [
        { path: "a.jpg", timestampMs: 0 },
        { path: "b.jpg", timestampMs: 0 },
        { path: "c.jpg", timestampMs: 0 }
    ];
    const durations = frameDurations(legacy, { fps: 30, timing: "realtime", speed: 1 });
    for (const d of durations) {
        assert.ok(Math.abs(d - 1 / 30) < 1e-9);
    }
});

test("no frame is ever shorter than one output frame, however hard we speed up", () => {
    const durations = frameDurations(frames(100), { fps: 30, timing: "fixed", speed: 0.001 });
    for (const d of durations) {
        assert.ok(d >= 1 / 30 - 1e-9, "a sub-frame duration would make ffmpeg drop the frame");
    }
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
    const list = buildConcatList(frames(3), { fps: 30, timing: "fixed", speed: 1 });
    const lines = list.trim().split("\n");

    assert.equal(lines[0], "ffconcat version 1.0");
    const fileLines = lines.filter((line) => line.startsWith("file "));
    assert.equal(fileLines.length, 4, "3 frames plus the repeated last one");
    assert.equal(fileLines[2], fileLines[3]);

    const durationLines = lines.filter((line) => line.startsWith("duration "));
    assert.equal(durationLines.length, 3);
});

test("concat paths are POSIX-quoted, and quotes inside a path are escaped", () => {
    assert.equal(quoteConcatPath("C:\\art\\a.jpg"), "'C:/art/a.jpg'");
    assert.equal(quoteConcatPath("C:\\it's\\a.jpg"), "'C:/it'\\''s/a.jpg'");
});

test("buildConcatList refuses an empty recording rather than emitting a broken list", () => {
    assert.throws(() => buildConcatList([], { fps: 30, timing: "fixed", speed: 1 }), /No frames/);
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
        padColor: "white"
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
        padColor: "white"
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

test("total duration adds up and DEFAULT_FPS is a sane constant", () => {
    assert.equal(totalSeconds([1, 2, 3.5]), 6.5);
    assert.ok(DEFAULT_FPS >= 24 && DEFAULT_FPS <= 60);
});

test("toFrameRefs orders by sequence number, not filename", () => {
    // Past 999,999 the names gain a digit; sorted as strings "1000000" would
    // come before "999999" and the tail of a long recording would be scrambled.
    const join = (a, b) => a + "/" + b;
    const refs = toFrameRefs(
        "frames",
        ["1000001_1700000003000.jpg", "999999_1700000001000.jpg", "1000000_1700000002000.jpg", "session.json"],
        join
    );
    assert.deepEqual(refs.map((r) => r.path), [
        "frames/999999_1700000001000.jpg",
        "frames/1000000_1700000002000.jpg",
        "frames/1000001_1700000003000.jpg"
    ]);
    assert.equal(refs[0].timestampMs, 1700000001000);
});

test("toFrameRefs falls back to 3.x names so old recordings stay exportable", () => {
    const join = (a, b) => a + "/" + b;
    const refs = toFrameRefs("old", ["000002.jpg", "000010.jpg", "000001.jpg", "notes.txt"], join);
    assert.deepEqual(refs.map((r) => r.path), ["old/000001.jpg", "old/000002.jpg", "old/000010.jpg"]);
    assert.equal(refs[0].timestampMs, 0, "no capture times, so pacing falls back to fixed");
});

test("toFrameRefs prefers current naming and ignores strays", () => {
    const join = (a, b) => a + "/" + b;
    const refs = toFrameRefs(
        "mixed",
        ["000001_1700000001000.jpg", "000002.jpg", "session.json", "000003_1700000003000.jpg.part"],
        join
    );
    assert.deepEqual(refs.map((r) => r.path), ["mixed/000001_1700000001000.jpg"]);
});
