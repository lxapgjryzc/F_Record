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
 *
 * The scale Photoshop applied is recovered from the pixmap: `pixmapWidth`
 * counts output pixels while `pixmapBounds` is documented to count *document*
 * pixels, so their ratio is the scale. `maxDimension` is the cap that was
 * asked for, and it is what tells apart the one case where that documented
 * contract does not hold -- see `isScaledWholeDocument`.
 */
export function computePadding(
    docBounds: Bounds,
    pixmapBounds: Bounds | null | undefined,
    pixmapWidth: number,
    pixmapHeight: number,
    maxDimension: number
): Padding {
    if (!pixmapBounds) {
        return NO_PADDING;
    }
    const sourceWidth = boundsWidth(pixmapBounds);
    const sourceHeight = boundsHeight(pixmapBounds);
    if (sourceWidth <= 0 || sourceHeight <= 0 || pixmapWidth <= 0 || pixmapHeight <= 0) {
        return NO_PADDING;
    }
    if (isScaledWholeDocument(docBounds, pixmapBounds, pixmapWidth, pixmapHeight, maxDimension)) {
        // The pixmap already *is* the whole canvas, so there is nothing to
        // re-seat. Falling through would read a scale of 1 off bounds that are
        // not at scale 1 and pad the frame out to full document size.
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

/**
 * True when `pixmapBounds` is the whole canvas measured in the *returned
 * pixmap's* pixels rather than the document's.
 *
 * Photoshop is documented to report `pixmap.bounds` in document coordinates
 * (generator-core: "essentially document.layers[i].bounds"), and everything
 * above depends on that. Measured on Photoshop 2026, a `maxDimension` request
 * that forces a downscale breaks it: a 7513x4617 canvas capped at 1837 comes
 * back as a 1837x1129 pixmap whose bounds are 0,0,1837,1129 as well -- the
 * document rectangle, already scaled.
 *
 * `pixmapWidth / sourceWidth` is then 1 instead of 0.2445, so the frame gets
 * padded out to the full 7513x4617 with the drawing stranded in the top-left
 * corner and everything else white. Frames like that are permanent: they go
 * straight into the exported video.
 *
 * The two readings cannot be told apart from the bounds alone, so this checks
 * the only thing that separates them -- whether Photoshop had any reason to
 * downscale, and whether what came back is that exact downscale of the whole
 * canvas:
 *
 *   - a cap below the canvas's longest side, or Photoshop had nothing to do;
 *   - a pixmap that reaches the cap, which only a downscale produces;
 *   - bounds that match the canvas at that scale, origin included.
 *
 * Anything else keeps the documented reading. A pixmap covering part of the
 * canvas at scale 1 is not a case this has to decide: with nothing scaled the
 * two spaces agree, and the arithmetic above is right either way.
 */
export function isScaledWholeDocument(
    docBounds: Bounds,
    pixmapBounds: Bounds,
    pixmapWidth: number,
    pixmapHeight: number,
    maxDimension: number
): boolean {
    if (!(maxDimension > 0)) {
        return false;
    }
    const docW = boundsWidth(docBounds);
    const docH = boundsHeight(docBounds);
    if (docW <= 0 || docH <= 0) {
        return false;
    }
    const longestDoc = Math.max(docW, docH);
    if (longestDoc <= maxDimension) {
        return false; // nothing to downscale, so both readings share a scale
    }
    if (Math.max(pixmapWidth, pixmapHeight) < maxDimension) {
        return false; // never reached the cap, so it was not capped
    }
    const scale = maxDimension / longestDoc;
    return (
        within1(pixmapBounds.left, docBounds.left * scale) &&
        within1(pixmapBounds.top, docBounds.top * scale) &&
        within1(boundsWidth(pixmapBounds), docW * scale) &&
        within1(boundsHeight(pixmapBounds), docH * scale)
    );
}

/** Photoshop rounds to whole pixels; one pixel of slack absorbs that. */
function within1(a: number, b: number): boolean {
    return Math.abs(a - b) <= 1;
}

function nonNegative(value: number): number {
    return value > 0 ? value : 0;
}
