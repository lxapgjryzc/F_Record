/**
 * Draws the panel icon.
 *
 * The icon is a frame with a recording dot in it: a rounded square for the
 * canvas being recorded, a filled circle for "recording", the same red the
 * panel uses for its own record indicator. It is drawn here rather than kept
 * as an opaque asset so it can be regenerated at any size, in every variant
 * CEP asks for, from one description -- and so the repository carries no
 * binary nobody can reproduce.
 *
 * CEP wants four variants, chosen by the host's theme and hover state, each
 * at 23x23 with an @2X companion for high-DPI displays:
 *
 *   normal / rollover            light Photoshop themes  (dark glyph)
 *   dark-normal / dark-rollover  dark Photoshop themes   (light glyph)
 *
 * A 256 px rendering is written as well, for the README and the release page.
 *
 * Usage:
 *   node scripts/icon.mjs            writes cep/src/icons/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "cep/src/icons");

const RECORD_RED = [227, 72, 80];

/** Glyph colours per variant: the frame, and the dot. */
const VARIANTS = {
    "normal": { frame: [75, 75, 75], dot: RECORD_RED },
    "rollover": { frame: [30, 30, 30], dot: RECORD_RED },
    "dark-normal": { frame: [208, 208, 208], dot: RECORD_RED },
    "dark-rollover": { frame: [255, 255, 255], dot: RECORD_RED }
};

/* ------------------------------------------------------------ geometry */

/** Signed distance from (x, y) to a rounded rectangle centred on (cx, cy). */
function roundedRect(x, y, cx, cy, halfWidth, halfHeight, radius) {
    const dx = Math.abs(x - cx) - (halfWidth - radius);
    const dy = Math.abs(y - cy) - (halfHeight - radius);
    const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2);
    return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function circle(x, y, cx, cy, radius) {
    return Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - radius;
}

/**
 * The icon as a list of shapes, in paint order, each a function from a
 * point to "inside or not". Everything scales with `size`, so the 23 px
 * and 256 px renderings are the same drawing.
 */
function shapes(size, colours) {
    const centre = size / 2;
    const half = size * 0.40;
    const stroke = Math.max(1.5, size * 0.085);
    const corner = size * 0.16;
    const dotRadius = size * 0.17;
    return [
        {
            colour: colours.frame,
            inside: (x, y) => Math.abs(roundedRect(x, y, centre, centre, half, half, corner)) <= stroke / 2
        },
        {
            colour: colours.dot,
            inside: (x, y) => circle(x, y, centre, centre, dotRadius) <= 0
        }
    ];
}

/* ----------------------------------------------------------- rendering */

const SUBSAMPLES = 4;

/** Renders to straight (non-premultiplied) RGBA, supersampled for smooth edges. */
function render(size, colours) {
    const pixels = Buffer.alloc(size * size * 4);
    const layers = shapes(size, colours);
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let sy = 0; sy < SUBSAMPLES; sy++) {
                for (let sx = 0; sx < SUBSAMPLES; sx++) {
                    const x = px + (sx + 0.5) / SUBSAMPLES;
                    const y = py + (sy + 0.5) / SUBSAMPLES;
                    // Last layer that covers the sample wins: paint order.
                    let hit = null;
                    for (const layer of layers) {
                        if (layer.inside(x, y)) {
                            hit = layer.colour;
                        }
                    }
                    if (hit) {
                        r += hit[0];
                        g += hit[1];
                        b += hit[2];
                        a += 1;
                    }
                }
            }
            const at = (py * size + px) * 4;
            if (a > 0) {
                pixels[at] = Math.round(r / a);
                pixels[at + 1] = Math.round(g / a);
                pixels[at + 2] = Math.round(b / a);
                pixels[at + 3] = Math.round((a / (SUBSAMPLES * SUBSAMPLES)) * 255);
            }
        }
    }
    return pixels;
}

/* ----------------------------------------------------------------- png */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([length, typed, crc]);
}

/** An 8-bit RGBA PNG, one filter byte (none) per row. */
function encodePng(size, pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // colour type: RGBA
    header[10] = 0; // compression
    header[11] = 0; // filter
    header[12] = 0; // interlace

    const stride = size * 4;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (stride + 1)] = 0;
        pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0))
    ]);
}

/* ---------------------------------------------------------------- main */

function write(name, size, colours) {
    const target = path.join(outDir, name);
    fs.writeFileSync(target, encodePng(size, render(size, colours)));
    process.stdout.write("wrote " + path.relative(root, target) + " (" + size + "x" + size + ")\n");
}

fs.mkdirSync(outDir, { recursive: true });
for (const [variant, colours] of Object.entries(VARIANTS)) {
    write(variant + ".png", 23, colours);
    write(variant + "@2X.png", 46, colours);
}
write("icon-256.png", 256, VARIANTS["dark-normal"]);
