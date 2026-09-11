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
    WatermarkPlan,
    buildConcatList,
    buildFfmpegArgs,
    buildStillArgs,
    embossTiling,
    expectedOutputSeconds,
    jpegSize,
    looksLikeCompleteJpeg,
    outputSize,
    selectFrames,
    sequenceSeconds,
    speedForTarget,
    stillSize,
    tileWatermarkText,
    DEFAULT_FPS,
    INTRO_SECONDS,
    OUTRO_SECONDS
} from "./export";
import { FFMPEG_ENV_VAR, FONT_ENV_VAR, ffmpegCandidates, fontCandidates } from "./locate";
import {
    ClipboardResolution,
    WatermarkSettings,
    normalizeWatermark,
    watermarkDraws
} from "../../../shared/protocol";
import { clipboardTempDir, exportTempDir } from "../../../shared/paths";
import { assign, mkdirp, rmrf, writeFileAtomic } from "../../../shared/compat";

import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface ExportProgress {
    stage: "preparing" | "encoding" | "finishing";
    percent: number;
}

export interface ExportRequest {
    /** Absolute paths to the frames, in order. */
    frames: string[];
    /** Full-quality still of the finished artwork, used as intro and outro. */
    finalImagePath: string | null;
    outputPath: string;
    aspectRatio: number;
    resolution: number;
    /** Target length in seconds, or null to keep the recording's own pace. */
    targetDurationSec: number | null;
    /** Stamped over the finished video. Null, or kind "off", means none. */
    watermark: WatermarkSettings | null;
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

/**
 * The message shown when something cannot run because there is no ffmpeg.
 *
 * `lead` says what was being attempted; everything after it is the same advice
 * either way, since the fix does not depend on which button was pressed.
 */
export function missingFfmpegMessage(lookup: FfmpegLookup, lead?: string): string {
    const shown = lookup.searched.slice(0, 6);
    const lines = [
        lead || "ffmpeg was not found, so this recording cannot be exported.",
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

/** The first font on this machine that drawtext can use, or null. */
export function locateFont(): string | null {
    const candidates = fontCandidates({
        platform: process.platform,
        extensionDir: typeof __dirname === "string" ? __dirname : ".",
        env: process.env
    });
    for (let i = 0; i < candidates.length; i++) {
        try {
            if (fs.existsSync(candidates[i])) {
                return candidates[i];
            }
        } catch (e) {
            /* an unreadable font directory is not worth failing the export */
        }
    }
    return null;
}

/**
 * Turns the configured watermark into something ffmpeg can draw, or null.
 *
 * Throws rather than quietly exporting an unmarked video: someone who asked
 * for their name on it and got a clean file would only find out after
 * uploading it. The messages name the thing that is missing, since both
 * failures -- a moved logo, a machine with no usable font -- are fixable.
 */
export function prepareWatermark(
    settings: WatermarkSettings | null,
    tempDir: string
): WatermarkPlan | null {
    const mark = normalizeWatermark(settings);
    // "Text" with nothing typed yet is a half-finished setting, not a demand
    // for a blank mark: export cleanly rather than failing or drawing nothing
    // at some cost. Settings can hold that state -- see normalizeWatermark.
    if (mark.kind === "off" || !watermarkDraws(mark)) {
        return null;
    }

    const base: WatermarkPlan = {
        kind: mark.kind,
        textFilePath: "",
        fontFile: "",
        imagePath: "",
        style: mark.style,
        position: mark.position,
        opacity: mark.opacityPercent / 100,
        size: mark.sizePercent / 100
    };

    if (mark.kind === "image") {
        if (!fs.existsSync(mark.imagePath)) {
            throw new Error("The watermark image is no longer at " + mark.imagePath);
        }
        return assign(base, { imagePath: mark.imagePath });
    }

    const font = locateFont();
    if (font === null) {
        throw new Error(
            "No font was found to draw the text watermark with. Set " +
                FONT_ENV_VAR +
                " to a .ttf or .ttc file to choose one."
        );
    }
    // No trailing newline: drawtext would render it as a second, empty line and
    // push the text up off the margin.
    //
    // The embossed style covers the frame, and drawtext draws one block of
    // text wherever you put it, so the repetition has to be in the string it
    // is handed. It happens here rather than in the filter builder because
    // this is where the file gets written; embossTiling owns the arithmetic.
    let text = mark.text;
    if (mark.style === "emboss") {
        const tiling = embossTiling(base.size, mark.text.length);
        text = tileWatermarkText(mark.text, tiling.columns, tiling.rows);
    }
    const textFilePath = path.join(tempDir, "watermark.txt");
    writeFileAtomic(textFilePath, Buffer.from(text, "utf8"));
    return assign(base, { textFilePath: textFilePath, fontFile: font });
}

/**
 * Drops frames that are missing or structurally incomplete.
 *
 * A frame can be truncated if Photoshop or the machine went down mid-write.
 * 3.x checked for this too but used the result to decide whether to copy the
 * file; here the bad frame is simply left out of the concat list, so one
 * damaged file costs a single frame instead of the whole export.
 */
export function filterUsableFrames(frames: string[]): { usable: string[]; skipped: number } {
    const usable: string[] = [];
    let skipped = 0;
    for (let i = 0; i < frames.length; i++) {
        let ok = false;
        try {
            ok = looksLikeCompleteJpeg(fs.readFileSync(frames[i]));
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

export interface StillRequest {
    /** The JPEG Photoshop just wrote of the open document. */
    sourcePath: string;
    /** Where the marked PNG goes. */
    outputPath: string;
    /** How big it comes out; see stillSize. */
    resolution: ClipboardResolution;
    /** Stamped on the still. Null, or kind "off", leaves it unmarked. */
    watermark: WatermarkSettings | null;
}

/**
 * Stamps the watermark on one still.
 *
 * The panel's "copy the canvas" button, which wants a picture rather than a
 * video but wants the same mark on it. No progress reporting: this is one
 * frame, and it is over before a bar could say anything useful.
 */
export function runStillWatermark(request: StillRequest): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const lookup = locateFfmpeg();
        if (lookup.path === null) {
            reject(
                new Error(
                    missingFfmpegMessage(
                        lookup,
                        "ffmpeg was not found, so the watermark could not be drawn."
                    )
                )
            );
            return;
        }

        // The copy is cut down from the picture and the mark is sized against
        // the copy, so the picture has to be measured first -- and if
        // Photoshop's still is unreadable, saying so here beats letting ffmpeg
        // fail on it further down.
        let size: { width: number; height: number } | null = null;
        try {
            size = jpegSize(fs.readFileSync(request.sourcePath));
        } catch (e) {
            size = null;
        }
        if (size === null) {
            reject(new Error("Photoshop's copy of the canvas could not be read"));
            return;
        }

        const temp = clipboardTempDir();
        mkdirp(temp);

        let watermark: WatermarkPlan | null;
        try {
            watermark = prepareWatermark(request.watermark, temp);
        } catch (error) {
            reject(error as Error);
            return;
        }

        const target = stillSize(size, request.resolution);
        const args = buildStillArgs({
            width: target.width,
            height: target.height,
            sourceWidth: size.width,
            sourceHeight: size.height,
            // Nothing here is timed; the emboss style builds its relief on a
            // synthetic source that needs a rate all the same.
            fps: 1,
            workingFormat: "yuv444p",
            watermark: watermark,
            sourcePath: request.sourcePath,
            outputPath: request.outputPath
        });

        const child = childProcess.spawn(lookup.path, args, { windowsHide: true });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", function (chunk: string) {
            stderr = (stderr + chunk).slice(-4000);
        });
        child.on("error", function (err: Error) {
            reject(new Error("Could not run ffmpeg: " + err.message));
        });
        child.on("close", function (code: number) {
            if (code !== 0) {
                reject(new Error(failureMessage(code, stderr)));
                return;
            }
            resolve();
        });
    });
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
        const naturalSeconds = sequenceSeconds(checked.usable.length, fps);
        const hasBookends = request.finalImagePath !== null && fs.existsSync(request.finalImagePath);
        const reserved = hasBookends ? INTRO_SECONDS + OUTRO_SECONDS : 0;
        const speed = speedForTarget(naturalSeconds, request.targetDurationSec, reserved);

        const kept = selectFrames(checked.usable, speed);
        const listText = buildConcatList(kept, fps);
        const mainSeconds = sequenceSeconds(kept.length, fps);

        const temp = exportTempDir();
        // Make sure the scratch dir exists, but do NOT wipe it: the caller
        // stages the bookend still (finalImagePath) inside this same directory
        // before calling us. Wiping it here -- as an earlier version did --
        // deleted that file *after* hasBookends had already been latched true
        // above, so ffmpeg was handed a path to a final.jpg that no longer
        // existed and died with "No such file or directory". frames.txt is
        // rewritten in full every run, and a successful encode clears the whole
        // directory below, so there is nothing to gain from a pre-wipe here.
        mkdirp(temp);
        const listPath = path.join(temp, "frames.txt");
        writeFileAtomic(listPath, listText);

        let watermark: WatermarkPlan | null;
        try {
            watermark = prepareWatermark(request.watermark, temp);
        } catch (error) {
            reject(error as Error);
            return;
        }

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
            padColor: "white",
            // What H.264 encodes anyway, so nothing is gained by carrying the
            // frames at a higher chroma resolution than the file will keep.
            workingFormat: "yuv420p",
            watermark: watermark
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
                reject(new Error(failureMessage(code, stderr)));
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

/**
 * What to say when ffmpeg gives up.
 *
 * The one failure worth translating out of ffmpeg-speak is a build without
 * libfreetype: "No such filter: 'drawtext'" tells the user nothing about the
 * watermark they just switched on, and the fix -- a different ffmpeg -- is not
 * one they would guess.
 */
export function failureMessage(code: number, stderr: string): string {
    const tail = (stderr || "").trim();
    if (/drawtext/i.test(tail) && /no such filter|unknown filter|not found/i.test(tail)) {
        return (
            "This ffmpeg cannot draw text, so the text watermark could not be added. " +
            "Install a build with freetype (the one scripts/install.ps1 downloads has it), " +
            "or use an image watermark instead.\n\n" +
            tail
        );
    }
    return "ffmpeg exited with code " + code + (tail ? ": " + tail : "");
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
