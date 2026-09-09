/**
 * Pure geometry for a capture: what rectangle to ask Photoshop for, and where
 * the pixels it returns sit inside that rectangle.
 *
 * Kept free of Photoshop calls so it can be unit tested; see test/framing.test.mjs.
 */

import { Bounds, Resolution } from "../../shared/protocol";
import { Padding, NO_PADDING } from "./encoder";

export function boundsWidth(bounds: Bounds): number {
    return Math.max(0, bounds.right - bounds.left);
}

export function boundsHeight(bounds: Bounds): number {
    return Math.max(0, bounds.bottom - bounds.top);
}

/**
 * The longest side we want a capture to have.
 *
 * The target is "about as many pixels as a 16:9 frame of the chosen height",
 * so a square canvas and a panoramic one cost roughly the same to capture and
 * both land near the export resolution. Never upscales: a small canvas is
 * captured at its native size.
 */
export function computeMaxDimension(bounds: Bounds, resolution: Resolution): number {
    const width = boundsWidth(bounds);
    const height = boundsHeight(bounds);
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
 * The rectangle Photoshop is asked to render the canvas into: the whole canvas
 * scaled down to `computeMaxDimension`, anchored at the origin.
 *
 * Asking with an explicit `outputRect` rather than `maxDimension` is what makes
 * the rest of this file simple, and it is not interchangeable with it --
 * measured on Photoshop 2026, against an 8000x2000 canvas whose layers reached
 * 2246px above and below it:
 *
 *   clipToDocumentBounds + maxDimension     2880x2247, bounds 0,0 -> 2880,2247
 *   inputRect/outputRect + maxDimension     2880x2247, bounds 0,0 -> 2880,2247
 *   outputRect without inputRect            8322x6492   (the request is ignored)
 *   inputRect + outputRect + clip           2880x720,  bounds 0,0 -> 2880,720
 *
 * Only the last is the canvas. `clipToDocumentBounds` does not clip anything
 * while `maxDimension` is in the request, and `outputRect` is ignored unless
 * `inputRect` comes with it -- so the frames came back holding the union of
 * the layers, at a scale that had to be guessed at from `pixmap.bounds`. That
 * guess is what wrote 169 frames of an 8000px-wide canvas with the drawing in
 * the left third and the rest white.
 *
 * With this rect the scale is one we chose rather than one we infer, and
 * Photoshop reports the returned pixels in that same space -- so seating them
 * is subtraction, with nothing left to get wrong.
 */
export function computeOutputRect(docBounds: Bounds, resolution: Resolution): Bounds {
    const width = boundsWidth(docBounds);
    const height = boundsHeight(docBounds);
    if (width <= 0 || height <= 0) {
        return { top: 0, left: 0, right: 1, bottom: 1 };
    }
    const maxDimension = computeMaxDimension(docBounds, resolution);
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    return {
        top: 0,
        left: 0,
        right: Math.max(1, Math.round(width * scale)),
        bottom: Math.max(1, Math.round(height * scale))
    };
}

/**
 * Padding that seats a returned pixmap inside the requested rectangle.
 *
 * Photoshop returns only the pixels that exist -- an artist three strokes into
 * a large canvas gets a small pixmap, and `pixmap.bounds` says where in
 * `outputRect` those pixels belong. Without this the recording would appear to
 * zoom as the painted area grew. Measured on Photoshop 2026, a 400x300 mark on
 * a 4000x3000 canvas asked for at 1663x1247 comes back as 167x126 with bounds
 * 83,62 -> 250,188: the mark's own place in the output rectangle.
 *
 * The result always fills `outputRect` exactly, because `pixmap.bounds` always
 * describes the returned pixels' own extent -- so the widths cancel.
 */
export function computePadding(
    outputRect: Bounds,
    pixmapBounds: Bounds | null | undefined,
    pixmapWidth: number,
    pixmapHeight: number
): Padding {
    if (!pixmapBounds || pixmapWidth <= 0 || pixmapHeight <= 0) {
        return NO_PADDING;
    }
    if (pixmapExceedsOutputRect(outputRect, pixmapWidth, pixmapHeight)) {
        return NO_PADDING;
    }
    return {
        left: nonNegative(Math.round(pixmapBounds.left - outputRect.left)),
        top: nonNegative(Math.round(pixmapBounds.top - outputRect.top)),
        right: nonNegative(Math.round(outputRect.right - pixmapBounds.right)),
        bottom: nonNegative(Math.round(outputRect.bottom - pixmapBounds.bottom))
    };
}

/**
 * True when Photoshop returned more pixels than the rectangle it was asked
 * for, which means it did not honour the request.
 *
 * Every Photoshop this has been measured on honours `inputRect` + `outputRect`
 * + `clipToDocumentBounds`, but only 2026 has been measured; the plug-in
 * supports 2020 and up. A version that quietly ignored the request would hand
 * back something at a scale of its own choosing, and seating that inside
 * `outputRect` would strand it in a corner -- which is exactly the failure
 * this whole file exists to have stopped happening.
 *
 * Padding is a nicety; it keeps the frame from appearing to zoom while the
 * painted area grows. A frame seated against a rectangle we can see does not
 * describe it is ruined, so the pixmap is written as it came instead.
 */
export function pixmapExceedsOutputRect(
    outputRect: Bounds,
    pixmapWidth: number,
    pixmapHeight: number
): boolean {
    const width = boundsWidth(outputRect);
    const height = boundsHeight(outputRect);
    if (width <= 0 || height <= 0) {
        return false;
    }
    return pixmapWidth > width + 1 || pixmapHeight > height + 1;
}

function nonNegative(value: number): number {
    return value > 0 ? value : 0;
}
