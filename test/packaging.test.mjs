/**
 * The pieces of the package that only agree by convention.
 *
 * Three panel manifests divide the Photoshop versions between them, the
 * installer draws the same lines in PowerShell, and each manifest names icon
 * files that have to exist at the size CEP expects. No code ties any of that
 * together, so this does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VARIANTS = ["classic", "legacy", "modern"];

function manifest(variant) {
    return fs.readFileSync(path.join(root, "cep/src/CSXS/manifest." + variant + ".xml"), "utf8");
}

/** Host range of a manifest, as [[fromMajor, fromMinor], [toMajor, toMinor]]. */
function hostRange(variant, host) {
    const match = manifest(variant).match(new RegExp('<Host Name="' + host + '" Version="\\[(\\d+)\\.(\\d+),(\\d+)\\.(\\d+)\\]"'));
    assert.ok(match, variant + " declares a " + host + " range");
    return [
        [Number(match[1]), Number(match[2])],
        [Number(match[3]), Number(match[4])]
    ];
}

function pngSize(file) {
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], file + " is a PNG");
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("every icon a manifest names exists, at 23 px and with a 46 px @2X companion", () => {
    for (const variant of VARIANTS) {
        const icons = [...manifest(variant).matchAll(/<Icon Type="(\w+)">\.\/(icons\/[\w-]+\.png)<\/Icon>/g)];
        assert.deepEqual(
            icons.map((m) => m[1]),
            ["Normal", "RollOver", "DarkNormal", "DarkRollOver"],
            variant + " names all four icon states"
        );
        for (const [, , relative] of icons) {
            const file = path.join(root, "cep/src", relative);
            assert.deepEqual(pngSize(file), [23, 23], relative);
            assert.deepEqual(pngSize(file.replace(/\.png$/, "@2X.png")), [46, 46], relative + " @2X");
        }
    }
});

test("the three manifests cover Photoshop 17.0 upwards between them, with no gap and no overlap", () => {
    const ranges = VARIANTS.map((variant) => ({ variant, range: hostRange(variant, "PHXS") })).sort(
        (a, b) => a.range[0][0] - b.range[0][0]
    );
    assert.deepEqual(ranges[0].range[0], [17, 0], "CC 2015.5 is the oldest host");
    assert.deepEqual(ranges[ranges.length - 1].range[1], [99, 9], "and the newest build is open-ended");
    for (let i = 1; i < ranges.length; i++) {
        const previous = ranges[i - 1];
        const next = ranges[i];
        assert.equal(previous.range[1][1], 9, previous.variant + " runs to the end of its last major");
        assert.deepEqual(next.range[0], [previous.range[1][0] + 1, 0], previous.variant + " hands over to " + next.variant);
    }
    for (const variant of VARIANTS) {
        assert.deepEqual(hostRange(variant, "PHSP"), hostRange(variant, "PHXS"), variant + ": PHSP mirrors PHXS");
    }
});

test("the installer draws the same lines between builds as the manifests do", () => {
    const script = fs.readFileSync(path.join(root, "scripts/photoshop.ps1"), "utf8");
    const variantLine = script.match(
        /\$variant = if \(\$version\.Major -le (\d+)\) \{ 'classic' \} elseif \(\$version\.Major -le (\d+)\) \{ 'legacy' \} else \{ 'modern' \}/
    );
    assert.ok(variantLine, "the variant line in photoshop.ps1 has the shape this test reads");
    assert.equal(Number(variantLine[1]), hostRange("classic", "PHXS")[1][0]);
    assert.equal(Number(variantLine[2]), hostRange("legacy", "PHXS")[1][0]);

    const supported = script.match(/Supported\s+=\s+\(\$version\.Major -ge (\d+)\)/);
    assert.ok(supported, "the Supported line in photoshop.ps1 has the shape this test reads");
    assert.equal(Number(supported[1]), hostRange("classic", "PHXS")[0][0]);
});
