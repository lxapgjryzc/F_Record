/**
 * Trims the white margin off frames written by a version with the padding bug.
 *
 * 4.0 through 4.2.1 padded every frame out to the full canvas using a scale
 * read off `pixmap.bounds`. When Photoshop sent a pixmap larger than the
 * canvas -- which it does for a document whose layers reach past the canvas,
 * the state Image Size and Canvas Size leave behind -- that scale read as 1
 * and the padding came out enormous: an 8000x2000 canvas produced 8000x2094
 * frames holding a 2880x2094 drawing and 5120 columns of white.
 *
 * Nothing is lost in those frames, only surrounded, so they can be repaired.
 * The margin the encoder wrote is flat 255,255,255 white, which a JPEG of an
 * actual drawing never is over a large area, so it can be measured off the
 * pixels and cut away.
 *
 * Usage:
 *   node scripts/repair-frames.mjs <sessionFolder> [--out <folder>] [--quality 90]
 *
 * The source folder is never modified: the repaired session is written beside
 * it as "<folder>-repaired" unless --out says otherwise. Drop the result into
 * the processImages folder and it appears in the panel like any other
 * recording.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jpeg = require("jpeg-js");

/** Below this the margin is more likely a pale drawing than encoder padding. */
const MIN_MARGIN_PX = 16;
const MIN_MARGIN_FRACTION = 0.01;

function fail(message) {
    process.stderr.write(message + "\n");
    process.exit(1);
}

function parseArgs(argv) {
    const options = { folder: null, out: null, quality: 90 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--out") {
            options.out = argv[++i];
        } else if (arg === "--quality") {
            options.quality = parseInt(argv[++i], 10);
        } else if (arg.startsWith("-")) {
            fail("Unknown option " + arg);
        } else if (options.folder === null) {
            options.folder = arg;
        } else {
            fail("Unexpected argument " + arg);
        }
    }
    if (!options.folder) {
        fail("Usage: node scripts/repair-frames.mjs <sessionFolder> [--out <folder>] [--quality 90]");
    }
    if (!(options.quality >= 1 && options.quality <= 100)) {
        fail("--quality must be between 1 and 100");
    }
    return options;
}

function frameFiles(folder) {
    return fs
        .readdirSync(folder)
        .filter((name) => /\.jpe?g$/i.test(name))
        .sort();
}

/**
 * The frame with its flat white right and bottom margins removed.
 *
 * The last column and the last row holding a pixel that is not pure white.
 * Padding written by the encoder is uniform 255, and a JPEG of an actual
 * drawing is not, so everything past those two lines is padding.
 *
 * Both edges are measured over the whole frame rather than by stopping at the
 * first hit: a row whose only marks sit to the left of the current right edge
 * still counts towards the bottom edge.
 */
function contentBox(raster) {
    const { data, width, height } = raster;
    let right = 0;
    let bottom = 0;
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        let inked = false;
        for (let x = width - 1; x >= 0; x--) {
            const i = row + x * 4;
            if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) {
                if (x + 1 > right) {
                    right = x + 1;
                }
                inked = true;
                break;
            }
        }
        if (inked) {
            bottom = y + 1;
        }
    }
    return { width: right, height: bottom };
}

/** A margin worth cutting: large enough that no drawing produced it. */
function worthTrimming(full, content) {
    const margin = full - content;
    return content > 0 && margin >= MIN_MARGIN_PX && margin >= full * MIN_MARGIN_FRACTION;
}

function cropRaster(raster, width, height) {
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        raster.data.copy(out, y * width * 4, y * raster.width * 4, y * raster.width * 4 + width * 4);
    }
    return { data: out, width: width, height: height };
}

function decode(file) {
    return jpeg.decode(fs.readFileSync(file), { useTArray: false });
}

const options = parseArgs(process.argv.slice(2));
const source = path.resolve(options.folder);
if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    fail(source + " is not a folder");
}
const target = path.resolve(options.out || source + "-repaired");
if (path.resolve(target) === source) {
    fail("--out must differ from the source folder");
}

const files = frameFiles(source);
if (files.length === 0) {
    fail("No frames found in " + source);
}

/*
 * Pass one: measure every frame, then decide one crop per frame size.
 *
 * Per-frame crops would breathe: a frame whose drawing stops short of the
 * pixmap edge would be cut tighter than its neighbours, and the recording
 * would jitter. The widest content of each size is the pixmap Photoshop sent,
 * so every frame of that size is cut to it.
 */
process.stdout.write("Measuring " + files.length + " frames...\n");
const groups = new Map();
const sizeOf = new Map();
for (let i = 0; i < files.length; i++) {
    const raster = decode(path.join(source, files[i]));
    const key = raster.width + "x" + raster.height;
    const box = contentBox(raster);
    const group = groups.get(key) || { width: raster.width, height: raster.height, content: { width: 0, height: 0 }, count: 0 };
    group.content.width = Math.max(group.content.width, box.width);
    group.content.height = Math.max(group.content.height, box.height);
    group.count++;
    groups.set(key, group);
    sizeOf.set(files[i], key);
    if ((i + 1) % 25 === 0 || i + 1 === files.length) {
        process.stdout.write("  " + (i + 1) + "/" + files.length + "\n");
    }
}

const crops = new Map();
let anyTrim = false;
for (const [key, group] of groups) {
    const width = worthTrimming(group.width, group.content.width) ? group.content.width : group.width;
    const height = worthTrimming(group.height, group.content.height) ? group.content.height : group.height;
    crops.set(key, { width: width, height: height });
    const trimmed = width !== group.width || height !== group.height;
    anyTrim = anyTrim || trimmed;
    process.stdout.write(
        "  " + group.count + " frames at " + key + " -> " + width + "x" + height +
            (trimmed ? "" : "  (nothing to trim)") + "\n"
    );
}

if (!anyTrim) {
    process.stdout.write("No padded frames found; nothing to repair.\n");
    process.exit(0);
}

fs.mkdirSync(target, { recursive: true });
process.stdout.write("Writing to " + target + "\n");

let widest = 0;
let tallest = 0;
for (let i = 0; i < files.length; i++) {
    const crop = crops.get(sizeOf.get(files[i]));
    const raster = decode(path.join(source, files[i]));
    const cropped =
        crop.width === raster.width && crop.height === raster.height
            ? raster
            : cropRaster(raster, crop.width, crop.height);
    widest = Math.max(widest, cropped.width);
    tallest = Math.max(tallest, cropped.height);
    const encoded = jpeg.encode({ data: cropped.data, width: cropped.width, height: cropped.height }, options.quality);
    fs.writeFileSync(path.join(target, files[i]), encoded.data);
    if ((i + 1) % 25 === 0 || i + 1 === files.length) {
        process.stdout.write("  " + (i + 1) + "/" + files.length + "\n");
    }
}

/*
 * The manifest comes along so the repaired folder is a session in its own
 * right. Its id is the folder name -- the panel keys on the id, and two
 * folders claiming one id would fight over which is the recording.
 */
const manifestPath = path.join(source, "session.json");
if (fs.existsSync(manifestPath)) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
        manifest = null;
    }
    if (manifest) {
        manifest.sessionId = path.basename(target);
        // The old bounds describe the canvas the frames were wrongly padded
        // to; "match the canvas" on export has to mean the frames instead.
        manifest.canvasBounds = { top: 0, left: 0, right: widest, bottom: tallest };
        fs.writeFileSync(path.join(target, "session.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
}

process.stdout.write("Repaired " + files.length + " frames into " + target + "\n");
