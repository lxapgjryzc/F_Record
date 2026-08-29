/**
 * Runs ffmpeg and turns its `-progress` stream into percentages.
 *
 * The binary is no longer shipped inside the extension -- locate.ts says where
 * it is looked for, scripts/install.ps1 is what puts it there.
 *
 * Deliberately no fluent-ffmpeg and no ffprobe: we know the output duration
 * before we start (we built the frame list), so probing is unnecessary, and
 * talking to ffmpeg directly removes the dependency chain that made 3.x's
 * export depend on a Node.js install the user probably did not have.
 */

import {
    FrameRef,
    TimingMode,
    buildConcatList,
    buildFfmpegArgs,
    expectedOutputSeconds,
    frameDurations,
    looksLikeCompleteJpeg,
    outputSize,
    speedForTarget,
    totalSeconds,
    DEFAULT_FPS,
    INTRO_SECONDS,
    OUTRO_SECONDS
} from "./export";
import { FFMPEG_ENV_VAR, ffmpegCandidates } from "./locate";
import { exportTempDir } from "../../../shared/paths";
import { mkdirp, rmrf, writeFileAtomic } from "../../../shared/compat";

declare const require: (id: string) => any;

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

export interface ExportProgress {
    stage: "preparing" | "encoding" | "finishing";
    percent: number;
}

export interface ExportRequest {
    frames: FrameRef[];
    /** Full-quality still of the finished artwork, used as intro and outro. */
    finalImagePath: string | null;
    outputPath: string;
    aspectRatio: number;
    resolution: number;
    timing: TimingMode;
    /** Target length in seconds, or null to keep the recording's own pace. */
    targetDurationSec: number | null;
    crf?: number;
}

export interface ExportHandle {
    promise: Promise<void>;
    cancel(): void;
}

export interface FfmpegLookup {
    /** The binary that was found, or null when none of the candidates exist. */
    path: string | null;
    /** Everything that was tried, so a failure can say where it looked. */
    searched: string[];
}

/**
 * Finds ffmpeg on this machine.
 *
 * Returns the list it tried as well as the hit, because "ffmpeg is missing" is
 * only actionable if the user can see which places were ruled out.
 */
export function locateFfmpeg(): FfmpegLookup {
    const searched = ffmpegCandidates({
        platform: process.platform,
        extensionDir: typeof __dirname === "string" ? __dirname : ".",
        env: process.env
    });
    for (let i = 0; i < searched.length; i++) {
        try {
            if (fs.existsSync(searched[i])) {
                return { path: searched[i], searched: searched };
            }
        } catch (e) {
            /* an unreadable PATH entry is not worth failing the whole export */
        }
    }
    return { path: null, searched: searched };
}

/** The message shown when export cannot run because there is no ffmpeg. */
export function missingFfmpegMessage(lookup: FfmpegLookup): string {
    const shown = lookup.searched.slice(0, 6);
    const lines = [
        "ffmpeg was not found, so this recording cannot be exported.",
        "",
        "Run install.cmd from the scripts folder again to install it, or",
        "install ffmpeg yourself and make sure it is on PATH. To point",
        "F_Record at one specific binary, set " + FFMPEG_ENV_VAR + ".",
        "",
        "Looked in:"
    ];
    for (let i = 0; i < shown.length; i++) {
        lines.push("  " + shown[i]);
    }
    if (lookup.searched.length > shown.length) {
        lines.push("  ... and " + (lookup.searched.length - shown.length) + " more");
    }
    return lines.join("\n");
}

/**
 * Drops frames that are missing or structurally incomplete.
 *
 * A frame can be truncated if Photoshop or the machine went down mid-write.
 * 3.x checked for this too but used the result to decide whether to copy the
 * file; here the bad frame is simply left out of the concat list, so one
 * damaged file costs a single frame instead of the whole export.
 */
export function filterUsableFrames(frames: FrameRef[]): { usable: FrameRef[]; skipped: number } {
    const usable: FrameRef[] = [];
    let skipped = 0;
    for (let i = 0; i < frames.length; i++) {
        let ok = false;
        try {
            ok = looksLikeCompleteJpeg(fs.readFileSync(frames[i].path));
        } catch (e) {
            ok = false;
        }
        if (ok) {
            usable.push(frames[i]);
        } else {
            skipped++;
        }
    }
    return { usable: usable, skipped: skipped };
}

export function runExport(
    request: ExportRequest,
    onProgress: (progress: ExportProgress) => void
): ExportHandle {
    let child: any = null;
    let cancelled = false;

    const promise = new Promise<void>((resolve, reject) => {
        const lookup = locateFfmpeg();
        if (lookup.path === null) {
            reject(new Error(missingFfmpegMessage(lookup)));
            return;
        }
        const binary = lookup.path;

        onProgress({ stage: "preparing", percent: 0 });

        const checked = filterUsableFrames(request.frames);
        if (checked.usable.length === 0) {
            reject(new Error("No complete frames were found in this recording"));
            return;
        }

        const fps = DEFAULT_FPS;
        const naturalDurations = frameDurations(checked.usable, {
            fps: fps,
            timing: request.timing,
            speed: 1
        });
        const naturalSeconds = totalSeconds(naturalDurations);
        const hasBookends = request.finalImagePath !== null && fs.existsSync(request.finalImagePath);
        const reserved = hasBookends ? INTRO_SECONDS + OUTRO_SECONDS : 0;
        const speed = speedForTarget(naturalSeconds, request.targetDurationSec, reserved);

        const listText = buildConcatList(checked.usable, {
            fps: fps,
            timing: request.timing,
            speed: speed
        });
        const mainSeconds = totalSeconds(
            frameDurations(checked.usable, { fps: fps, timing: request.timing, speed: speed })
        );

        const temp = exportTempDir();
        // Start from a clean temp directory; a previous run may have died.
        rmrf(temp);
        mkdirp(temp);
        const listPath = path.join(temp, "frames.txt");
        writeFileAtomic(listPath, listText);

        const size = outputSize(request.aspectRatio, request.resolution);
        const args = buildFfmpegArgs({
            width: size.width,
            height: size.height,
            fps: fps,
            concatListPath: listPath,
            finalImagePath: hasBookends ? request.finalImagePath : null,
            outputPath: request.outputPath,
            mainSeconds: mainSeconds,
            crf: typeof request.crf === "number" ? request.crf : 20,
            padColor: "white"
        });

        const totalOut = expectedOutputSeconds(mainSeconds, hasBookends);
        onProgress({ stage: "encoding", percent: 0 });

        child = childProcess.spawn(binary, args, { windowsHide: true });

        let stderr = "";
        let stdoutBuffer = "";

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", function (chunk: string) {
            stdoutBuffer += chunk;
            let newline = stdoutBuffer.indexOf("\n");
            while (newline !== -1) {
                const line = stdoutBuffer.slice(0, newline).trim();
                stdoutBuffer = stdoutBuffer.slice(newline + 1);
                const seconds = parseProgressLine(line);
                if (seconds !== null && totalOut > 0) {
                    onProgress({
                        stage: "encoding",
                        percent: Math.max(0, Math.min(99, Math.round((seconds / totalOut) * 100)))
                    });
                }
                newline = stdoutBuffer.indexOf("\n");
            }
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", function (chunk: string) {
            // Keep only the tail; a failing filter graph can be very chatty.
            stderr = (stderr + chunk).slice(-4000);
        });

        child.on("error", function (err: Error) {
            reject(new Error("Could not run ffmpeg: " + err.message));
        });

        child.on("close", function (code: number) {
            child = null;
            if (cancelled) {
                reject(new Error("Export cancelled"));
                return;
            }
            if (code !== 0) {
                reject(new Error("ffmpeg exited with code " + code + (stderr ? ": " + stderr.trim() : "")));
                return;
            }
            onProgress({ stage: "finishing", percent: 100 });
            try {
                rmrf(temp);
            } catch (e) {
                /* leftover temp files are harmless */
            }
            resolve();
        });
    });

    return {
        promise: promise,
        cancel: function () {
            cancelled = true;
            if (child) {
                try {
                    child.kill();
                } catch (e) {
                    /* already gone */
                }
            }
        }
    };
}

/** ffmpeg's -progress output is `key=value` lines; we only need the timestamp. */
export function parseProgressLine(line: string): number | null {
    if (line.indexOf("out_time_us=") === 0) {
        const micros = parseInt(line.slice("out_time_us=".length), 10);
        return isFinite(micros) && micros >= 0 ? micros / 1000000 : null;
    }
    if (line.indexOf("out_time_ms=") === 0) {
        // Despite the name ffmpeg reports microseconds here too, but treat it
        // as a fallback only -- out_time_us above is the reliable one.
        const value = parseInt(line.slice("out_time_ms=".length), 10);
        return isFinite(value) && value >= 0 ? value / 1000000 : null;
    }
    return null;
}
