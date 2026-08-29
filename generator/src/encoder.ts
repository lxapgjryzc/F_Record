/**
 * Pixmap -> JPEG on disk.
 *
 * Two encoders, chosen at runtime:
 *
 *   native  generator-core's savePixmap, which pipes the raw pixmap through the
 *           `convert.exe` bundled inside Photoshop.
 *   js      jpeg-js, in this process.
 *
 * Native is tried first because a native binary in its own process is much
 * cheaper. On Photoshop 2026 it does not work: convert.exe can no longer be
 * launched standalone (it exits immediately with STATUS_DLL_NOT_FOUND, so
 * savePixmap fails as soon as its stdin is written). Measured here, that is
 * exactly the "PS API compatibility" problem 3.x worked around by hand-rolling
 * an encoder. Older Photoshop releases may still have a working convert.exe,
 * which is why this is probed rather than assumed.
 *
 * The first native failure switches to js permanently *and falls through to it
 * within the same call*, so the frame that triggered the switch is still
 * written. Measured cost of the js path: ~120ms for a 1080p frame, ~520ms for
 * a 4000x3000 canvas at 1440p -- all of it in the Generator process, never on
 * Photoshop's UI thread, and CaptureScheduler widens its interval to match.
 *
 * Pixmap layout, per generator-core's lib/xpm.js:
 *   channelCount 4 -> A R G B   (getPixel4 reads a=0, r=1, g=2, b=3)
 *   channelCount 3 -> B G R     (getPixel3 reads b=0, g=1, r=2)
 *   channelCount 1 -> greyscale
 * Channels are big-endian, so for 16-bit documents the high byte comes first
 * and reading byte 0 of each channel is a free 16->8 bit downsample.
 */

import * as fs from "fs";
import { encode as encodeJpeg } from "jpeg-js";
import { mkdirp } from "../../shared/compat";
import { EncoderKind } from "../../shared/protocol";

export interface Pixmap {
    width: number;
    height: number;
    pixels: Buffer;
    bitsPerChannel?: number;
    channelCount?: number;
    bytesPerPixel?: number;
    rowBytes?: number;
}

export interface Padding {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export const NO_PADDING: Padding = { left: 0, top: 0, right: 0, bottom: 0 };

export interface NativeSaver {
    savePixmap(pixmap: Pixmap, filePath: string, settings: Record<string, unknown>): Promise<unknown>;
}

export function hasPadding(padding: Padding): boolean {
    return padding.left > 0 || padding.top > 0 || padding.right > 0 || padding.bottom > 0;
}

/**
 * Flattens a pixmap to tightly packed RGB(A), compositing onto `background`
 * because JPEG has no alpha, and surrounding it with `padding` so every frame
 * of a recording covers the full canvas even when only part of it is painted.
 */
export function pixmapToRgba(
    pixmap: Pixmap,
    background: [number, number, number],
    padding: Padding
): { data: Buffer; width: number; height: number } {
    const pw = pixmap.width;
    const ph = pixmap.height;
    const channels = pixmap.channelCount || 4;
    const bitsPerChannel = pixmap.bitsPerChannel || 8;
    const bytesPerChannel = Math.max(1, Math.floor(bitsPerChannel / 8));
    const bytesPerPixel = pixmap.bytesPerPixel || channels * bytesPerChannel;
    const rowBytes = pixmap.rowBytes || pw * bytesPerPixel;
    const src = pixmap.pixels;

    const width = pw + padding.left + padding.right;
    const height = ph + padding.top + padding.bottom;
    const out = Buffer.alloc(width * height * 4);

    // Background first, so padded regions and fully transparent pixels agree.
    for (let i = 0; i < out.length; i += 4) {
        out[i] = background[0];
        out[i + 1] = background[1];
        out[i + 2] = background[2];
        out[i + 3] = 255;
    }

    for (let y = 0; y < ph; y++) {
        const srcRow = y * rowBytes;
        const dstRow = ((y + padding.top) * width + padding.left) * 4;
        for (let x = 0; x < pw; x++) {
            const s = srcRow + x * bytesPerPixel;
            const d = dstRow + x * 4;
            if (s + bytesPerPixel > src.length) {
                continue; // truncated buffer: leave the background showing
            }

            let r: number;
            let g: number;
            let b: number;
            let alpha = 255;

            if (channels >= 4) {
                alpha = src[s];
                r = src[s + bytesPerChannel];
                g = src[s + bytesPerChannel * 2];
                b = src[s + bytesPerChannel * 3];
            } else if (channels === 3) {
                b = src[s];
                g = src[s + bytesPerChannel];
                r = src[s + bytesPerChannel * 2];
            } else {
                r = g = b = src[s];
            }

            if (alpha === 255) {
                out[d] = r;
                out[d + 1] = g;
                out[d + 2] = b;
            } else if (alpha !== 0) {
                const a = alpha / 255;
                out[d] = Math.round(r * a + background[0] * (1 - a));
                out[d + 1] = Math.round(g * a + background[1] * (1 - a));
                out[d + 2] = Math.round(b * a + background[2] * (1 - a));
            }
            // alpha === 0 keeps the background already written above.
        }
    }

    return { data: out, width: width, height: height };
}

export interface EncodeOptions {
    quality: number;
    padding: Padding;
    /** Document resolution in PPI; passed through so convert.exe stops warning. */
    ppi?: number;
}

export class Encoder {
    private kind: EncoderKind = "native";
    private nativeFailure: string | null = null;

    constructor(
        private readonly native: NativeSaver | null,
        private readonly log: (level: "info" | "warn" | "error", message: string) => void
    ) {
        if (!native) {
            this.kind = "js";
        }
    }

    getKind(): EncoderKind {
        return this.kind;
    }

    async encode(pixmap: Pixmap, filePath: string, options: EncodeOptions): Promise<void> {
        mkdirp(dirNameOf(filePath));

        if (this.kind === "native" && this.native) {
            try {
                const settings: Record<string, unknown> = {
                    format: "jpg",
                    quality: Math.min(100, Math.max(1, Math.round(options.quality))),
                    // White, fully opaque: matches how the JS path flattens alpha.
                    background: [255, 255, 255, 1]
                };
                if (hasPadding(options.padding)) {
                    settings.padding = options.padding;
                }
                if (typeof options.ppi === "number" && isFinite(options.ppi)) {
                    settings.ppi = options.ppi;
                }
                await this.native.savePixmap(pixmap, filePath, settings);
                return;
            } catch (e) {
                this.nativeFailure = errText(e);
                this.kind = "js";
                // Expected on current Photoshop: the bundled convert.exe cannot
                // be launched as a standalone process any more (it exits with
                // STATUS_DLL_NOT_FOUND), so savePixmap fails the moment its
                // stdin is written. Logged at info because the frame is still
                // encoded below -- nothing is lost, it is just slower.
                this.log(
                    "info",
                    "Photoshop's own image encoder is unavailable, using the built-in encoder " +
                        "for the rest of this session (frames are unaffected). Reason: " + this.nativeFailure
                );
            }
        }

        this.encodeWithJs(pixmap, filePath, options);
    }

    private encodeWithJs(pixmap: Pixmap, filePath: string, options: EncodeOptions): void {
        const raster = pixmapToRgba(pixmap, [255, 255, 255], options.padding);
        const encoded = encodeJpeg(
            { data: raster.data, width: raster.width, height: raster.height },
            Math.min(100, Math.max(1, Math.round(options.quality)))
        );

        // Write under a temp name and rename, so a reader never sees a
        // half-written frame. The exporter's integrity check covers the rest.
        const tmp = filePath + ".part";
        fs.writeFileSync(tmp, encoded.data);
        try {
            fs.renameSync(tmp, filePath);
        } catch (e) {
            try {
                fs.unlinkSync(tmp);
            } catch (e2) {
                /* best effort */
            }
            throw e;
        }
    }
}

function dirNameOf(filePath: string): string {
    const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    return idx > 0 ? filePath.substring(0, idx) : ".";
}

function errText(e: unknown): string {
    if (e && (e as Error).message) {
        return (e as Error).message;
    }
    return String(e);
}
