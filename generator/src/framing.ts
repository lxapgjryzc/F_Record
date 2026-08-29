/**
 * Pure geometry for a capture: how far to downscale, and where the pixels
 * Photoshop returned sit inside the canvas.
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
 * The longest side we ask Photoshop for.
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
 * Padding that re-seats a returned pixmap inside the full canvas.
 *
 * Photoshop returns only the pixels that exist -- an artist three strokes into
 * a large canvas gets a small pixmap. Without this the recording would appear
 * to zoom as the painted area grew. `clipToDocumentBounds` guarantees the
 * pixmap never extends past the canvas, so padding alone is enough and no
 * cropping is needed.
 */
export function computePadding(
    docBounds: Bounds,
    pixmapBounds: Bounds | null | undefined,
    pixmapWidth: number,
    pixmapHeight: number
): Padding {
    if (!pixmapBounds) {
        return NO_PADDING;
    }
    const sourceWidth = boundsWidth(pixmapBounds);
    const sourceHeight = boundsHeight(pixmapBounds);
    if (sourceWidth <= 0 || sourceHeight <= 0 || pixmapWidth <= 0 || pixmapHeight <= 0) {
        return NO_PADDING;
    }
    const scaleX = pixmapWidth / sourceWidth;
    const scaleY = pixmapHeight / sourceHeight;

    return {
        left: nonNegative(Math.round((pixmapBounds.left - docBounds.left) * scaleX)),
        top: nonNegative(Math.round((pixmapBounds.top - docBounds.top) * scaleY)),
        right: nonNegative(Math.round((docBounds.right - pixmapBounds.right) * scaleX)),
        bottom: nonNegative(Math.round((docBounds.bottom - pixmapBounds.bottom) * scaleY))
    };
}

function nonNegative(value: number): number {
    return value > 0 ? value : 0;
}

export function boundsEqual(a: Bounds | null, b: Bounds | null): boolean {
    if (!a || !b) {
        return a === b;
    }
    return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}
