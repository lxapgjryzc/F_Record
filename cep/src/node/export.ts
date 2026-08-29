/**
 * Turning a folder of frames into an MP4.
 *
 * 3.x ran ffmpeg four times -- frames to a .ts, the final image to a .ts, a
 * faded copy to a third .ts, then a concat -- and before any of that it copied
 * every single frame into a temp folder, which doubled the disk I/O for long
 * recordings. It also drove ffmpeg through fluent-ffmpeg inside a worker it
 * launched with `spawn("node", ...)`, so export only worked on machines that
 * happened to have Node.js installed and on PATH.
 *
 * Here it is one ffmpeg invocation reading the frames where they already live,
 * via a concat list that carries a duration per frame. Carrying real durations
 * is also what makes "real time" playback possible, since the frame filenames
 * record when each one was captured.
 *
 * The builders below are pure so they can be tested without ffmpeg present;
 * see test/export.test.mjs.
 */

import { ParsedFrame, parseFrameList, parseLegacyFrameFileName } from "../../../shared/paths";

export const DEFAULT_FPS = 30;
export const INTRO_SECONDS = 1;
export const OUTRO_SECONDS = 2;
export const FADE_SECONDS = 1;

/** Longest a single frame may linger, so idle gaps do not stall playback. */
export const MAX_REALTIME_FRAME_SECONDS = 2;

export type TimingMode = "fixed" | "realtime";

export interface FrameRef {
    /** Absolute path to the frame on disk. */
    path: string;
    /** Capture time, from the frame's filename. 0 for legacy 3.x frames. */
    timestampMs: number;
}

export interface ConcatOptions {
    fps: number;
    timing: TimingMode;
    /** Multiplies every duration; 1 keeps the recording's own pace. */
    speed: number;
}

/**
 * Builds an ffconcat list.
 *
 * The concat demuxer applies a `duration` to the file that precedes it and
 * ignores the duration of the final entry, so the last frame is listed twice --
 * that is the documented way to make its duration stick.
 */
export function buildConcatList(frames: FrameRef[], options: ConcatOptions): string {
    if (frames.length === 0) {
        throw new Error("No frames to export");
    }
    const lines: string[] = ["ffconcat version 1.0"];
    const durations = frameDurations(frames, options);

    for (let i = 0; i < frames.length; i++) {
        lines.push("file " + quoteConcatPath(frames[i].path));
        lines.push("duration " + durations[i].toFixed(6));
    }
    // Repeat the last entry so its duration is honoured.
    lines.push("file " + quoteConcatPath(frames[frames.length - 1].path));
    return lines.join("\n") + "\n";
}

export function frameDurations(frames: FrameRef[], options: ConcatOptions): number[] {
    const base = 1 / Math.max(1, options.fps);
    const speed = options.speed > 0 ? options.speed : 1;
    const durations: number[] = [];

    const usable =
        options.timing === "realtime" &&
        frames.length > 1 &&
        frames[0].timestampMs > 0 &&
        frames[frames.length - 1].timestampMs > frames[0].timestampMs;

    for (let i = 0; i < frames.length; i++) {
        let seconds: number;
        if (usable && i < frames.length - 1) {
            const gap = (frames[i + 1].timestampMs - frames[i].timestampMs) / 1000;
            seconds = Math.min(MAX_REALTIME_FRAME_SECONDS, Math.max(base, gap));
        } else {
            seconds = base;
        }
        // Never go below one output frame, or ffmpeg drops the frame entirely.
        durations.push(Math.max(base, seconds * speed));
    }
    return durations;
}

export function totalSeconds(durations: number[]): number {
    let total = 0;
    for (let i = 0; i < durations.length; i++) {
        total += durations[i];
    }
    return total;
}

/**
 * Speed multiplier that lands the recording on `targetSeconds`, leaving room
 * for the intro and outro. Only ever speeds up: padding a recording out to be
 * longer than it was would just add duplicate frames.
 */
export function speedForTarget(
    naturalSeconds: number,
    targetSeconds: number | null,
    reservedSeconds: number
): number {
    if (targetSeconds === null || naturalSeconds <= 0) {
        return 1;
    }
    const available = targetSeconds - reservedSeconds;
    if (available <= 0) {
        return 0.001;
    }
    return Math.min(1, Math.max(0.001, Math.round((available / naturalSeconds) * 1000) / 1000));
}

/** ffmpeg's concat demuxer wants forward slashes and POSIX-style quoting. */
export function quoteConcatPath(filePath: string): string {
    return "'" + filePath.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'";
}

export interface FfmpegPlan {
    width: number;
    height: number;
    fps: number;
    concatListPath: string;
    finalImagePath: string | null;
    outputPath: string;
    /** Duration of the frame sequence after any speed change. */
    mainSeconds: number;
    crf: number;
    /** Letterbox colour; matches the white the frames are flattened onto. */
    padColor: string;
}

/**
 * A single ffmpeg command that normalises every frame to one size, optionally
 * bookends it with the finished artwork, and encodes to H.264.
 *
 * Normalising with scale+pad rather than assuming a fixed input size matters:
 * frames can legitimately differ in size within one recording if the canvas
 * was resized mid-session, and the concat demuxer would otherwise fail.
 */
export function buildFfmpegArgs(plan: FfmpegPlan): string[] {
    const fit =
        "scale=" + plan.width + ":" + plan.height + ":force_original_aspect_ratio=decrease," +
        "pad=" + plan.width + ":" + plan.height + ":(ow-iw)/2:(oh-ih)/2:color=" + plan.padColor +
        ",setsar=1";

    const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];

    args.push("-f", "concat", "-safe", "0", "-i", plan.concatListPath);

    const hasBookends = plan.finalImagePath !== null;
    if (hasBookends) {
        const still = INTRO_SECONDS + OUTRO_SECONDS;
        args.push("-loop", "1", "-framerate", String(plan.fps), "-t", String(still), "-i", plan.finalImagePath!);
    }

    let filter =
        "[0:v]" + fit + ",fps=" + plan.fps + ",format=yuv420p[main]";

    if (hasBookends) {
        filter +=
            ";[1:v]" + fit + ",fps=" + plan.fps + ",format=yuv420p,split=2[s0][s1]" +
            ";[s0]trim=duration=" + INTRO_SECONDS + ",setpts=PTS-STARTPTS[intro]" +
            ";[s1]trim=duration=" + OUTRO_SECONDS +
            ",fade=t=in:st=0:d=" + FADE_SECONDS + ":color=" + plan.padColor +
            ",setpts=PTS-STARTPTS[outro]" +
            ";[intro][main][outro]concat=n=3:v=1:a=0[out]";
    } else {
        filter += ";[main]null[out]";
    }

    args.push("-filter_complex", filter, "-map", "[out]");
    // The filter graph already produces exactly width x height in yuv420p, so
    // no -s / -vf is needed here; adding one would re-scale needlessly.
    args.push(
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", String(plan.crf),
        "-pix_fmt", "yuv420p",
        "-r", String(plan.fps),
        "-movflags", "+faststart"
    );
    // Machine-readable progress on stdout; ffmpeg's human output is silenced
    // by -loglevel error above, so stderr carries only real failures.
    args.push("-progress", "pipe:1", "-nostats");
    args.push(plan.outputPath);
    return args;
}

/** Total output length, used to turn ffmpeg's progress into a percentage. */
export function expectedOutputSeconds(mainSeconds: number, hasBookends: boolean): number {
    return mainSeconds + (hasBookends ? INTRO_SECONDS + OUTRO_SECONDS : 0);
}

/**
 * Output dimensions for an aspect ratio and a target resolution.
 *
 * H.264 with yuv420p requires even dimensions, hence the rounding to multiples
 * of two.
 */
export function outputSize(aspectRatio: number, resolution: number): { width: number; height: number } {
    const ratio = aspectRatio > 0 ? aspectRatio : 16 / 9;
    let height = resolution * Math.sqrt(16 / 9 / ratio);
    let width = height * ratio;
    height = Math.max(2, Math.round(height / 2) * 2);
    width = Math.max(2, Math.round(width / 2) * 2);
    return { width: width, height: height };
}

/**
 * Cheap structural check for a JPEG: SOI at the start, EOI at the end.
 *
 * Worth keeping from 3.x. A frame can be truncated if Photoshop or the machine
 * went down mid-write, and one bad file would otherwise fail the whole export.
 * Frames that fail are dropped from the concat list rather than aborting.
 */
export function looksLikeCompleteJpeg(buffer: Buffer): boolean {
    if (!buffer || buffer.length < 4) {
        return false;
    }
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        return false;
    }
    return buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

/**
 * Turns a directory listing into ordered frame references.
 *
 * Ordering comes from `parseFrameList`, which sorts on the parsed sequence
 * number rather than the filename. That matters once a recording passes 999,999
 * frames and the names grow a seventh digit: sorted as strings, "1000000" would
 * come before "999999" and the export would be scrambled at the very end.
 *
 * 3.x recordings, named plain `000001.jpg` with no capture time, are read as a
 * fallback so they stay exportable -- they simply have no real-time pacing.
 *
 * `joinPath` is injected so this module stays free of Node imports and can be
 * unit tested directly.
 */
export function toFrameRefs(
    folder: string,
    fileNames: string[],
    joinPath: (a: string, b: string) => string
): FrameRef[] {
    const modern = parseFrameList(fileNames);
    if (modern.length > 0) {
        return modern.map(function (frame) {
            return { path: joinPath(folder, frame.fileName), timestampMs: frame.timestampMs };
        });
    }

    const legacy: ParsedFrame[] = [];
    for (let i = 0; i < fileNames.length; i++) {
        const parsed = parseLegacyFrameFileName(fileNames[i]);
        if (parsed) {
            legacy.push(parsed);
        }
    }
    legacy.sort(function (a, b) {
        return a.seq - b.seq;
    });
    return legacy.map(function (frame) {
        return { path: joinPath(folder, frame.fileName), timestampMs: 0 };
    });
}
