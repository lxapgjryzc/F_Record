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
 * via a concat list.
 *
 * Playback is even: every frame gets exactly one output frame's worth of time.
 * 4.5.0 also offered "real time" pacing, which stretched each frame to the gap
 * between captures; it has since been dropped, along with the per-frame
 * durations it needed, so a concat entry is now always 1/fps.
 *
 * The builders below are pure so they can be tested without ffmpeg present;
 * see test/export.test.mjs.
 */

import { fitToResolution } from "../../../shared/fit";
import { ParsedFrame, parseFrameList, parseLegacyFrameFileName } from "../../../shared/paths";
import {
    ClipboardResolution,
    WatermarkPosition,
    WatermarkStyle,
    WATERMARK_EMBOSS_SIZE_MIN,
    WATERMARK_SIZE_MAX
} from "../../../shared/protocol";

export const DEFAULT_FPS = 30;
export const INTRO_SECONDS = 1;
export const OUTRO_SECONDS = 2;
export const FADE_SECONDS = 1;

/**
 * How far the tiled mark is turned, in degrees, by the emboss style.
 *
 * Off the horizontal on purpose: a mark that runs parallel to the drawing's
 * own edges reads as part of the picture, and a diagonal one is also much
 * harder to paint out of a screenshot.
 */
export const EMBOSS_ANGLE_DEGREES = -30;

/** What separates one copy of the text from the next along a row. */
export const EMBOSS_TILE_GAP = "   ";

/**
 * Ceiling on the tiling, so a one-character signature at a tiny size cannot
 * ask drawtext for a hundred thousand glyphs. WATERMARK_EMBOSS_SIZE_MIN is
 * chosen so the cap never bites before the frame is covered.
 */
export const EMBOSS_MAX_TILES = 80;

/**
 * What the emboss style does at 100% opacity.
 *
 * The relief is blended in additively, so the blend's opacity is directly how
 * far it pushes a pixel: at 1.0 the bevel off a white-on-black mask moves
 * brightness by up to ±128 levels, half the range. That is a black-and-white
 * stamp printed over the drawing, not something pressed into the paper -- and
 * the drawing is what the video is of. A relief reads as a relief somewhere
 * around ±30 levels and stops being a relief well before ±90.
 *
 * So the whole percentage is mapped onto the range this style can actually
 * use, rather than leaving three quarters of the setting as gradations of
 * "too much". 100% is the anti-theft end -- plainly there, still a relief;
 * 30% is a whisper. The corner style is unaffected: there the number is the
 * alpha of one badge in one corner, and 100% of that is a reasonable thing to
 * ask for.
 */
export const EMBOSS_MAX_STRENGTH = 0.3;

/**
 * Builds an ffconcat list, one output frame per entry.
 *
 * The concat demuxer applies a `duration` to the file that precedes it and
 * ignores the duration of the final entry, so the last frame is listed twice --
 * that is the documented way to make its duration stick.
 */
export function buildConcatList(framePaths: string[], fps: number): string {
    if (framePaths.length === 0) {
        throw new Error("No frames to export");
    }
    const seconds = 1 / Math.max(1, fps);
    const lines: string[] = ["ffconcat version 1.0"];

    for (let i = 0; i < framePaths.length; i++) {
        lines.push("file " + quoteConcatPath(framePaths[i]));
        lines.push("duration " + seconds.toFixed(6));
    }
    // Repeat the last entry so its duration is honoured.
    lines.push("file " + quoteConcatPath(framePaths[framePaths.length - 1]));
    return lines.join("\n") + "\n";
}

/** How long a frame sequence runs, at one frame per output frame. */
export function sequenceSeconds(frameCount: number, fps: number): number {
    return frameCount / Math.max(1, fps);
}

/**
 * Speeds a recording up by DROPPING frames, not by shortening them.
 *
 * 4.5.0 applied the speed multiplier to each frame's duration and then clamped
 * it back up to one output frame, because a shorter entry would be dropped by
 * ffmpeg. Every frame already lasts exactly one output frame, so the clamp undid
 * the multiplier completely and "export as 30s" handed back a video of the
 * original length.
 *
 * Dropping is what a speed-up actually is. Frame `i` belongs at output position
 * `i * speed`, so a frame is kept whenever that position has moved past the
 * frames already emitted -- which keeps the count at `speed` times the original
 * without quantising to an integer stride, so an odd multiplier like 0.45 still
 * lands on the requested length. The final frame is always kept, so the
 * recording ends on the finished artwork.
 */
export function selectFrames(framePaths: string[], speed: number): string[] {
    if (!(speed > 0) || speed >= 1 || framePaths.length < 2) {
        return framePaths.slice();
    }
    const kept: string[] = [];
    for (let i = 0; i < framePaths.length; i++) {
        if (Math.floor(i * speed) >= kept.length) {
            kept.push(framePaths[i]);
        }
    }
    const last = framePaths[framePaths.length - 1];
    if (kept[kept.length - 1] !== last) {
        kept.push(last);
    }
    return kept;
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

/**
 * A watermark resolved down to what ffmpeg needs: files that exist, and sizes
 * in pixels rather than percentages.
 *
 * The text is passed as a *file* rather than inline. drawtext's own escaping
 * has to survive two rounds of parsing (filtergraph, then filter options), and
 * a signature with a colon, a backslash or an apostrophe in it would otherwise
 * either break the graph or silently render as something else. `textfile=`
 * sidesteps all of it: only the path needs escaping, and we choose the path.
 */
export interface WatermarkPlan {
    kind: "text" | "image";
    /** kind "text": a UTF-8 file holding exactly the words to draw. */
    textFilePath: string;
    /** kind "text": absolute path to a .ttf/.ttc. */
    fontFile: string;
    /** kind "image": the still to overlay. */
    imagePath: string;
    style: WatermarkStyle;
    /** Ignored when style is "emboss". */
    position: WatermarkPosition;
    /** 0-1. */
    opacity: number;
    /** Height of one mark as a fraction of the output height, 0-1. */
    size: number;
}

/**
 * What the mark is being drawn onto: the size of the picture, and the pixel
 * format the two halves of an embossed mark have to agree on.
 *
 * Split out of FfmpegPlan because the same mark goes onto two very different
 * things -- a video, and the single still the panel copies to the clipboard --
 * and the filter builders below need only this much of either.
 */
export interface WatermarkCanvas {
    width: number;
    height: number;
    fps: number;
    /**
     * The format the picture is carrying when the mark is blended into it.
     *
     * The embossed style blends a relief with the picture, and `blend` wants
     * both sides in the same format, so this is what the relief is converted
     * to as well. Video uses yuv420p, which is what H.264 encodes anyway; a
     * still is copied out as RGB and would only lose colour detail by passing
     * through 4:2:0, so it asks for yuv444p instead. Either way the relief has
     * flat 128 chroma, where grainmerge leaves the picture's own colour alone.
     */
    workingFormat: string;
    watermark: WatermarkPlan | null;
}

export interface FfmpegPlan extends WatermarkCanvas {
    concatListPath: string;
    finalImagePath: string | null;
    outputPath: string;
    /** Duration of the frame sequence after any speed change. */
    mainSeconds: number;
    crf: number;
    /** Letterbox colour; matches the white the frames are flattened onto. */
    padColor: string;
}

/** One picture, marked and written out again: the clipboard copy. */
export interface StillPlan extends WatermarkCanvas {
    sourcePath: string;
    outputPath: string;
    /**
     * The size of the picture at `sourcePath`. `width` x `height` is the size
     * it comes out at; when the two differ it is scaled down on the way in,
     * before the mark goes on. See stillSize.
     */
    sourceWidth: number;
    sourceHeight: number;
}

/**
 * How big the clipboard copy comes out.
 *
 * The button exists to hand someone a look at the work in progress, not to
 * move the artwork, and a 6000-pixel canvas on the clipboard is a hundred-odd
 * megabytes of bitmap that every chat window then has to swallow. So it is
 * cut down to a resolution -- the recording's own words and the recording's
 * own rule, so "1080p" here is exactly the size of a recorded frame -- unless
 * the original is asked for. Never upscaled either way.
 */
export function stillSize(
    source: { width: number; height: number },
    resolution: ClipboardResolution
): { width: number; height: number } {
    if (resolution === "original") {
        return { width: source.width, height: source.height };
    }
    return fitToResolution(source.width, source.height, resolution);
}

/** Mark height and margin in pixels, for a given output height. */
export function watermarkMetrics(height: number, size: number): { size: number; margin: number } {
    const marked = Math.max(8, Math.round(height * Math.min(0.5, Math.max(0.01, size))));
    // A margin that scales with the video: a fixed 24px would crowd the corner
    // at 360p and look lost at 2160p.
    return { size: marked, margin: Math.max(4, Math.round(height * 0.03)) };
}

/**
 * Escapes a value for use inside a filtergraph option.
 *
 * ffmpeg unescapes a filtergraph twice: once when splitting the description
 * into filters, and again when splitting a filter into `option=value` pairs.
 * A character that is special to the inner parser therefore needs its escape
 * to survive the outer one, which means escaping the escape:
 *
 *   :  ->  \\:      the colon after a drive letter (a plain \: is eaten by the
 *                   outer pass, and the inner pass then reads a separator --
 *                   "No option name near '/Windows/Fonts/msyh.ttc'")
 *   '  ->  \\\'     special to both passes
 *   [ ] , ;  ->  \[ etc, special only to the outer pass
 *
 * Backslashes become forward slashes first: a Windows path is full of them,
 * ffmpeg accepts either, and this way there is one fewer thing to count.
 */
export function escapeFilterValue(value: string): string {
    const forwardSlashed = value.replace(/\\/g, "/");
    let out = "";
    for (let i = 0; i < forwardSlashed.length; i++) {
        const c = forwardSlashed.charAt(i);
        if (c === ":") {
            out += "\\\\:";
        } else if (c === "'") {
            out += "\\\\\\'";
        } else if (c === "[" || c === "]" || c === "," || c === ";") {
            out += "\\" + c;
        } else {
            out += c;
        }
    }
    return out;
}

/**
 * Where the mark sits, as ffmpeg expressions.
 *
 * `mainWidth`/`mainHeight` and `markWidth`/`markHeight` are the variable names
 * of the filter being fed: overlay calls them W/H and w/h, drawtext calls the
 * video w/h and the text text_w/text_h. Naming them here keeps one copy of the
 * corner arithmetic rather than two that can drift apart.
 */
export function watermarkPlacement(
    position: WatermarkPosition,
    margin: number,
    names: { mainWidth: string; mainHeight: string; markWidth: string; markHeight: string }
): { x: string; y: string } {
    const left = String(margin);
    const top = String(margin);
    const right = names.mainWidth + "-" + names.markWidth + "-" + margin;
    const bottom = names.mainHeight + "-" + names.markHeight + "-" + margin;
    const middleX = "(" + names.mainWidth + "-" + names.markWidth + ")/2";
    const middleY = "(" + names.mainHeight + "-" + names.markHeight + ")/2";

    switch (position) {
        case "topLeft":
            return { x: left, y: top };
        case "topRight":
            return { x: right, y: top };
        case "bottomLeft":
            return { x: left, y: bottom };
        case "center":
            return { x: middleX, y: middleY };
        default:
            return { x: right, y: bottom };
    }
}

/** The filter chain that stamps the mark, from `inLabel` to `outLabel`. */
export function buildWatermarkFilter(
    plan: WatermarkCanvas,
    inLabel: string,
    outLabel: string,
    imageInputIndex: number
): string {
    if (plan.watermark!.style === "emboss") {
        return buildEmbossFilter(plan, inLabel, outLabel, imageInputIndex);
    }
    return buildCornerFilter(plan, inLabel, outLabel, imageInputIndex);
}

/**
 * One mark parked against an edge.
 *
 * White with a dark outline rather than plain white: frames are flattened onto
 * white, so unoutlined white text would be invisible on exactly the drawings
 * this plug-in exists for.
 */
function buildCornerFilter(
    plan: WatermarkCanvas,
    inLabel: string,
    outLabel: string,
    imageInputIndex: number
): string {
    const mark = plan.watermark!;
    const metrics = watermarkMetrics(plan.height, mark.size);
    const opacity = Math.min(1, Math.max(0.05, mark.opacity)).toFixed(3);

    if (mark.kind === "text") {
        const place = watermarkPlacement(mark.position, metrics.margin, {
            mainWidth: "w",
            mainHeight: "h",
            markWidth: "text_w",
            markHeight: "text_h"
        });
        return (
            "[" + inLabel + "]drawtext=" +
            "fontfile=" + escapeFilterValue(mark.fontFile) +
            ":textfile=" + escapeFilterValue(mark.textFilePath) +
            // Draw the words as typed. drawtext otherwise expands %{...} and
            // strftime sequences, so a signature ending in "100%" fails the
            // whole export with "Stray %", and one containing %{pts} would
            // quietly become a timestamp.
            ":expansion=none" +
            ":fontsize=" + metrics.size +
            ":fontcolor=white@" + opacity +
            ":borderw=" + Math.max(1, Math.round(metrics.size / 12)) +
            ":bordercolor=black@" + opacity +
            ":x=" + place.x +
            ":y=" + place.y +
            "[" + outLabel + "]"
        );
    }

    const place = watermarkPlacement(mark.position, metrics.margin, {
        mainWidth: "W",
        mainHeight: "H",
        markWidth: "w",
        markHeight: "h"
    });
    // scale=-1 keeps the logo's own aspect ratio; colorchannelmixer multiplies
    // the alpha it already has rather than replacing it, so a PNG cut-out stays
    // a cut-out instead of becoming a translucent rectangle.
    return (
        "[" + imageInputIndex + ":v]format=rgba,scale=-1:" + metrics.size +
        ",colorchannelmixer=aa=" + opacity + "[wm]" +
        ";[" + inLabel + "][wm]overlay=" + place.x + ":" + place.y + ":format=auto[" + outLabel + "]"
    );
}

/** The pixel sizes the embossed style is laid out with. */
export function embossMetrics(
    width: number,
    height: number,
    size: number
): { mark: number; square: number; depth: number; blur: string; lineSpacing: number } {
    const fraction = Math.min(
        WATERMARK_SIZE_MAX / 100,
        Math.max(WATERMARK_EMBOSS_SIZE_MIN / 100, size)
    );
    const mark = Math.max(8, Math.round(height * fraction));
    // The tiling is laid out flat and then turned inside a canvas that does not
    // grow, so the frame's corners are covered only if the canvas's inscribed
    // circle reaches them -- which makes the side of the square the frame's
    // diagonal. The slack absorbs the rounding: a corner landing exactly on the
    // circle would be a coin toss between covered and not.
    const square = Math.ceil((Math.sqrt(width * width + height * height) + 16) / 2) * 2;
    // How far apart the bevel's two offset copies sit.
    //
    // This has to stay well inside one stroke of the glyph, because the two
    // copies cancelling wherever they agree *is* the effect: that is what
    // leaves the inside of a letter neutral and lights only its rims. Push
    // them further apart than a stroke is wide and nothing overlaps any more --
    // each copy lands on bare background, so every letter comes out twice, once
    // solid white and once solid black. That is a watermark printed on the
    // picture, which is the opposite of what this style is for -- and it is
    // exactly what 4.7.0 shipped, at a twelfth of the type size.
    //
    // A stroke runs around a tenth of the type size and rather less for CJK,
    // which is mostly what this gets asked to draw; a logo's can be thinner
    // still, and there is no way to measure it from here. A twenty-eighth
    // leaves room under all of them.
    const depth = Math.min(10, Math.max(1, Math.round(mark / 28)));
    return {
        mark: mark,
        square: square,
        depth: depth,
        // How much the mask is softened BEFORE the two copies are subtracted.
        //
        // Blurring first is what makes this a bevel rather than an outline: it
        // turns each stroke into a slope, and the subtraction of two slopes is
        // a shoulder -- bright where the surface tilts towards the light, dark
        // where it tilts away, flat in between. It also rescues strokes thinner
        // than the offset, which come out as a single soft ridge instead of a
        // pair of ghosts -- hence half again the offset, so the two slopes
        // always overlap. Blurring the relief afterwards instead, which is what
        // 4.7.0 did, only feathers the edge of something already wrong.
        blur: (depth * 1.5).toFixed(2),
        lineSpacing: Math.max(1, Math.round(mark * 0.6))
    };
}

/**
 * How many copies of the text it takes to cover the rotated canvas.
 *
 * drawtext draws one block, so the tiling has to be in the string handed to
 * it: these are the counts prepareWatermark repeats the signature by.
 *
 * How wide a glyph comes out is not knowable from here -- it depends on the
 * font, and on whether the signature is Latin or CJK -- so this assumes the
 * narrowest glyphs a font is likely to have (0.35em) and the widest frame (a
 * diagonal of 2.2x the height). Both guesses err the same way, towards too
 * many copies, and the overspill is cropped; too few would leave a bare strip
 * down the edge of the video.
 */
export function embossTiling(size: number, textLength: number): { columns: number; rows: number } {
    const fraction = Math.min(
        WATERMARK_SIZE_MAX / 100,
        Math.max(WATERMARK_EMBOSS_SIZE_MIN / 100, size)
    );
    const chars = Math.max(1, textLength) + EMBOSS_TILE_GAP.length;
    return {
        columns: clampTiles(2.2 / (0.35 * fraction * chars)),
        rows: clampTiles(2.2 / (1.6 * fraction))
    };
}

function clampTiles(value: number): number {
    return Math.max(1, Math.min(EMBOSS_MAX_TILES, Math.ceil(value)));
}

/**
 * The signature repeated into a block big enough to cover the frame.
 *
 * Every other row starts half a cell in, so the copies do not line up into
 * columns -- which is the difference between a watermark and wallpaper.
 */
export function tileWatermarkText(text: string, columns: number, rows: number): string {
    const cells: string[] = [];
    for (let i = 0; i < columns; i++) {
        cells.push(text);
    }
    const line = cells.join(EMBOSS_TILE_GAP);
    const indent = new Array(Math.ceil((text.length + EMBOSS_TILE_GAP.length) / 2) + 1).join(" ");
    const lines: string[] = [];
    for (let r = 0; r < rows; r++) {
        lines.push(r % 2 === 1 ? indent + line : line);
    }
    return lines.join("\n");
}

/**
 * Tiles a still by doubling it: split it in two, stack the halves side by
 * side, repeat until it outgrows the canvas, then do the same downwards.
 *
 * A logo has no line breaks to tile it with the way text does. Laying out N
 * columns directly would need an N-way split feeding an N-input hstack;
 * doubling needs log2(N) of each, and the file is decoded once either way.
 */
export function buildEmbossTileStack(
    cell: number,
    square: number,
    inLabel: string
): { chains: string[]; label: string } {
    const chains: string[] = [];
    let label = inLabel;

    let width = Math.max(1, cell);
    let step = 0;
    while (width < square) {
        step++;
        chains.push("[" + label + "]split=2[eh" + step + "a][eh" + step + "b]");
        chains.push("[eh" + step + "a][eh" + step + "b]hstack=inputs=2[eh" + step + "]");
        label = "eh" + step;
        width *= 2;
    }

    let height = Math.max(1, cell);
    step = 0;
    while (height < square) {
        step++;
        chains.push("[" + label + "]split=2[ev" + step + "a][ev" + step + "b]");
        chains.push("[ev" + step + "a][ev" + step + "b]vstack=inputs=2[ev" + step + "]");
        label = "ev" + step;
        height *= 2;
    }

    return { chains: chains, label: label };
}

/**
 * The mark tiled across the whole frame as a relief.
 *
 * Three pieces: a mask of the tiled mark, white on black; the relief built
 * from that mask; and the blend that presses the relief into the video.
 *
 * The relief is the Photoshop move done in arithmetic. The mask is blurred, so
 * every stroke becomes a slope rather than a cliff, and two copies of it -- one
 * nudged up-left, one down-right -- go into `grainextract`, which is
 * A - B + 128. Wherever the two agree -- inside a letter, and in the empty
 * space around it -- the result is a flat, neutral 128; only the slopes
 * survive, light where the surface tilts towards the light and dark where it
 * tilts away. That is a bevel.
 *
 * Both halves of that matter. Without the blur the difference is an outline,
 * and once the offset outgrows a stroke the two copies stop overlapping
 * altogether and the mark is drawn twice, in white and in black, instead of
 * being pressed in once -- which is why `depth` is a twentieth of the type
 * size and not a twelfth. See embossMetrics.
 *
 * What puts it on the picture is `grainmerge` (A + B - 128) and NOT `overlay`,
 * which is the blend Photoshop's own emboss reaches for. Overlay is pinned at
 * its endpoints: given a pixel that is already pure white or pure black it
 * returns that pixel unchanged, whatever the layer above says. Frames here are
 * flattened onto white and the drawing on them is near-black, so an overlaid
 * emboss would be invisible over almost the whole frame and show up only in
 * the midtones. grainmerge is a plain addition, so it reads everywhere.
 *
 * The relief is the same in every frame, so it is rendered once and held with
 * `loop`; without that, each frame of the export would redo the tiling, the
 * rotation and the blur.
 */
function buildEmbossFilter(
    plan: WatermarkCanvas,
    inLabel: string,
    outLabel: string,
    imageInputIndex: number
): string {
    const mark = plan.watermark!;
    const metrics = embossMetrics(plan.width, plan.height, mark.size);
    // Scaled, not used as-is: see EMBOSS_MAX_STRENGTH.
    const opacity = (
        Math.min(1, Math.max(0.05, mark.opacity)) * EMBOSS_MAX_STRENGTH
    ).toFixed(3);
    const depth = metrics.depth;
    const canvas = "color=c=black:s=" + metrics.square + "x" + metrics.square + ":r=" + plan.fps;
    const turn =
        "rotate=" + EMBOSS_ANGLE_DEGREES + "*PI/180:fillcolor=black" +
        ",crop=" + plan.width + ":" + plan.height;

    const chains: string[] = [];
    let mask: string;

    if (mark.kind === "text") {
        mask =
            canvas +
            ",drawtext=fontfile=" + escapeFilterValue(mark.fontFile) +
            ":textfile=" + escapeFilterValue(mark.textFilePath) +
            // See buildCornerFilter: without this a signature ending in "%"
            // fails the export and "%{pts}" becomes a timestamp.
            ":expansion=none" +
            ":fontsize=" + metrics.mark +
            ":fontcolor=white" +
            ":line_spacing=" + metrics.lineSpacing +
            ":x=(w-text_w)/2:y=(h-text_h)/2," +
            turn;
    } else {
        chains.push(
            "[" + imageInputIndex + ":v]format=rgba" +
                ",scale=" + metrics.mark + ":" + metrics.mark +
                ":force_original_aspect_ratio=decrease" +
                // A square cell whatever shape the logo is, so the copies line
                // up when they are stacked.
                ",pad=" + metrics.mark + ":" + metrics.mark +
                ":(ow-iw)/2:(oh-ih)/2:color=black@0[etile]"
        );
        const stack = buildEmbossTileStack(metrics.mark, metrics.square, "etile");
        for (let i = 0; i < stack.chains.length; i++) {
            chains.push(stack.chains[i]);
        }
        chains.push(canvas + "[ebg]");
        // Onto black rather than straight to grey: that is what turns a PNG's
        // alpha into brightness, so a cut-out logo embosses its shape and not
        // the rectangle it was saved in.
        mask =
            "[ebg][" + stack.label + "]overlay=(W-w)/2:(H-h)/2:format=auto:shortest=1," + turn;
    }

    chains.push(mask + ",format=gray,gblur=sigma=" + metrics.blur + ",split=2[eup][edn]");
    chains.push(
        "[eup]pad=iw+" + depth + ":ih+" + depth + ":0:0:black" +
            ",crop=iw-" + depth + ":ih-" + depth + ":" + depth + ":" + depth + "[elit]"
    );
    chains.push(
        "[edn]pad=iw+" + depth + ":ih+" + depth + ":" + depth + ":" + depth + ":black" +
            ",crop=iw-" + depth + ":ih-" + depth + ":0:0[edim]"
    );
    // A yuv format, not grey: the relief then has flat 128 in both chroma
    // planes, where grainmerge leaves them exactly as they were, so the emboss
    // moves brightness only and cannot tint the drawing. Which one comes from
    // the canvas -- blend needs both sides to match, and a still is carried at
    // full chroma resolution rather than the video's 4:2:0.
    chains.push(
        "[elit][edim]blend=all_mode=grainextract" +
            ",format=" + plan.workingFormat + ",loop=loop=-1:size=1:start=0,setsar=1[wm]"
    );
    // shortest=1 because the relief, held by loop, never ends on its own.
    chains.push(
        "[" + inLabel + "][wm]blend=all_mode=grainmerge:all_opacity=" + opacity +
            ":shortest=1[" + outLabel + "]"
    );

    return chains.join(";");
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

    // An image watermark is another input, and its index depends on whether the
    // bookend still took input 1.
    const watermark = plan.watermark;
    if (watermark && watermark.kind === "image") {
        args.push("-i", watermark.imagePath);
    }
    const watermarkInput = hasBookends ? 2 : 1;

    // Without a mark the bookended video is already the output, so it is
    // labelled [out] directly rather than passed through a null filter.
    const body = watermark ? "body" : "out";

    let filter =
        "[0:v]" + fit + ",fps=" + plan.fps + ",format=" + plan.workingFormat + "[main]";

    if (hasBookends) {
        filter +=
            ";[1:v]" + fit + ",fps=" + plan.fps + ",format=" + plan.workingFormat + ",split=2[s0][s1]" +
            ";[s0]trim=duration=" + INTRO_SECONDS + ",setpts=PTS-STARTPTS[intro]" +
            ";[s1]trim=duration=" + OUTRO_SECONDS +
            ",fade=t=in:st=0:d=" + FADE_SECONDS + ":color=" + plan.padColor +
            ",setpts=PTS-STARTPTS[outro]" +
            ";[intro][main][outro]concat=n=3:v=1:a=0[" + body + "]";
    } else {
        filter += ";[main]null[" + body + "]";
    }

    // The mark goes on last, over the intro and outro as well: it is the video
    // that is being signed, not the frame sequence inside it.
    if (watermark) {
        filter += ";" + buildWatermarkFilter(plan, body, "out", watermarkInput);
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

/**
 * The same mark, on one picture instead of a video.
 *
 * This is what the clipboard button runs. It goes through ffmpeg rather than
 * through Photoshop so that what lands on the clipboard is drawn by exactly
 * the code that draws the mark on an export -- same style, same tiling, same
 * relief -- rather than by a second implementation that would drift.
 *
 * Nothing is padded: there is no fixed frame to fit here, and the still keeps
 * the canvas's shape. It is scaled down when the plan is smaller than the
 * source -- see stillSize -- and the mark goes on afterwards, so it is sized
 * against what lands on the clipboard, in the proportion it has on the video.
 * `-update 1` is what lets a single .png be an output file rather than the
 * first entry of an image sequence.
 */
export function buildStillArgs(plan: StillPlan): string[] {
    const args: string[] = ["-hide_banner", "-loglevel", "error", "-y", "-i", plan.sourcePath];

    const watermark = plan.watermark;
    if (watermark && watermark.kind === "image") {
        args.push("-i", watermark.imagePath);
    }

    const body = watermark ? "body" : "out";
    // Full chroma before the scale: a JPEG can carry its colour at half
    // resolution, and scaling the picture once it is all at one resolution is
    // what keeps a drawing's edges clean rather than fringed. Lanczos because
    // this is line art being made smaller, and bilinear would soften it.
    let filter = "[0:v]format=" + plan.workingFormat;
    if (plan.width !== plan.sourceWidth || plan.height !== plan.sourceHeight) {
        filter += ",scale=" + plan.width + ":" + plan.height + ":flags=lanczos";
    }
    filter += ",setsar=1[" + body + "]";
    if (watermark) {
        filter += ";" + buildWatermarkFilter(plan, body, "out", 1);
    }

    args.push("-filter_complex", filter, "-map", "[out]");
    args.push("-frames:v", "1", "-update", "1", plan.outputPath);
    return args;
}

/**
 * Width and height from a JPEG's frame header, or null if it has none.
 *
 * The mark is sized as a fraction of the picture's height, so the still has to
 * be measured before it can be marked. Reading the header here rather than
 * asking ffprobe keeps export.ts free of another binary -- ffprobe is not one
 * of the things install.ps1 puts on disk -- and the file in question is one
 * Photoshop wrote a moment ago, so only the ordinary structure has to be
 * handled.
 */
export function jpegSize(buffer: Buffer): { width: number; height: number } | null {
    if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        return null;
    }
    let offset = 2;
    while (offset + 3 < buffer.length) {
        // Segments may be preceded by any number of 0xff fill bytes.
        if (buffer[offset] !== 0xff) {
            offset++;
            continue;
        }
        const marker = buffer[offset + 1];
        if (marker === 0xff) {
            offset++;
            continue;
        }
        // Markers that stand alone, with no length word after them.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
            offset += 2;
            continue;
        }
        // Entropy-coded data starts here and the frame header is behind us; if
        // we have not found it by now the file is not one we can measure.
        if (marker === 0xda || marker === 0xd9) {
            return null;
        }
        const length = (buffer[offset + 2] << 8) | buffer[offset + 3];
        if (length < 2) {
            return null;
        }
        // SOF0..SOF15 carry the dimensions; the three markers interleaved with
        // them in that range (DHT, JPG, DAC) do not.
        if (
            marker >= 0xc0 && marker <= 0xcf &&
            marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        ) {
            if (offset + 9 > buffer.length) {
                return null;
            }
            const height = (buffer[offset + 5] << 8) | buffer[offset + 6];
            const width = (buffer[offset + 7] << 8) | buffer[offset + 8];
            return width > 0 && height > 0 ? { width: width, height: height } : null;
        }
        offset += 2 + length;
    }
    return null;
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
 * Turns a directory listing into an ordered list of frame paths.
 *
 * Ordering comes from `parseFrameList`, which sorts on the parsed sequence
 * number rather than the filename. That matters once a recording passes 999,999
 * frames and the names grow a seventh digit: sorted as strings, "1000000" would
 * come before "999999" and the export would be scrambled at the very end.
 *
 * 3.x recordings, named plain `000001.jpg` with no capture time, are read as a
 * fallback so they stay exportable.
 *
 * `joinPath` is injected so this module stays free of Node imports and can be
 * unit tested directly.
 */
export function toFramePaths(
    folder: string,
    fileNames: string[],
    joinPath: (a: string, b: string) => string
): string[] {
    const modern = parseFrameList(fileNames);
    if (modern.length > 0) {
        return modern.map(function (frame) {
            return joinPath(folder, frame.fileName);
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
        return joinPath(folder, frame.fileName);
    });
}
