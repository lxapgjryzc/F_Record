/**
 * How many pixels "1080p" is, when the picture is a canvas of any shape.
 *
 * A resolution here names a pixel budget rather than a height: about as many
 * pixels as a 16:9 frame of that height, so a square canvas and a panoramic
 * one cost about the same and both land near the size the video is exported
 * at. Never upscales -- a canvas already inside the budget keeps its own size.
 *
 * Two things are cut down by this one rule: the frames the generator asks
 * Photoshop for (generator/src/framing.ts) and the still the panel puts on
 * the clipboard (cep/src/node/export.ts). Keeping it here is what makes
 * "1080p" the same number of pixels in both places, so a copied canvas is
 * exactly the size of a recorded frame.
 */

import { Resolution } from "./protocol";

/**
 * The longest side a `width` x `height` picture should have to fit the
 * budget of `resolution`.
 *
 * Whole pixels, since Photoshop has to be asked for whole pixels; a
 * degenerate size comes back as 1 rather than 0 or NaN, so a request built
 * from it is still a rectangle.
 */
export function longestSideFor(width: number, height: number, resolution: Resolution): number {
    const area = width * height;
    const longest = Math.max(width, height);
    if (area <= 0 || longest <= 0) {
        return 1;
    }
    const target = parseInt(resolution, 10);
    const targetArea = (target * target * 16) / 9;
    const k = Math.min(Math.sqrt(targetArea / area), 1);
    return Math.max(1, Math.round(longest * k));
}

/**
 * The whole picture brought down to that longest side, keeping its shape.
 *
 * Both sides come from the one scale the rounded longest side implies, rather
 * than each straight from the budget, so what Photoshop returns for this
 * rectangle seats in it without an off-by-one -- see computePadding.
 */
export function fitToResolution(
    width: number,
    height: number,
    resolution: Resolution
): { width: number; height: number } {
    const longest = Math.max(width, height);
    const scale = Math.min(1, longestSideFor(width, height, resolution) / longest);
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
    };
}
