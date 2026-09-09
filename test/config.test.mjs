/**
 * Config normalisation, and the 4.0 -> 4.1 language migration.
 *
 * 4.0 stored the language as "cn" or "en". 4.1 uses BCP 47 tags so the value
 * can be matched against Photoshop's own appUILocale. If the migration were
 * skipped, every existing Chinese user would silently be moved to auto-detect
 * on upgrade -- which happens to look identical until Photoshop is running in
 * English, at which point their panel changes language on its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "../dist/test/store.mjs";
import {
    DEFAULT_CONFIG,
    DEFAULT_EXPORT_DEFAULTS,
    DEFAULT_WATERMARK,
    normalizeExportDefaults,
    normalizeWatermark,
    watermarkDraws
} from "../dist/test/protocol.mjs";

/** A stored 4.0 config, before any of the 4.1 fields existed. */
function legacyConfig(overrides) {
    return Object.assign(
        {
            enabled: true,
            autoStart: false,
            autoStartNewDocuments: true,
            processImageFolderPath: "C:\\frames",
            resolution: "1080",
            quality: 70,
            idleTimeoutMinutes: 1,
            minIntervalMs: 1500,
            minCanvasPixels: 65536,
            language: "cn",
            format: "jpg"
        },
        overrides
    );
}

test("a 4.0 config saying cn keeps Chinese rather than resetting", () => {
    const out = normalizeConfig(legacyConfig({ language: "cn" }));
    assert.equal(out.language, "zh-CN");
});

test("a 4.0 config saying en still means English", () => {
    const out = normalizeConfig(legacyConfig({ language: "en" }));
    assert.equal(out.language, "en");
});

test("the new tags pass through untouched", () => {
    for (const tag of ["auto", "zh-TW", "ja", "ko", "de", "fr", "es", "pt-BR", "ru"]) {
        assert.equal(normalizeConfig(legacyConfig({ language: tag })).language, tag);
    }
});

test("an unrecognised language falls back to the default", () => {
    const out = normalizeConfig(legacyConfig({ language: "elvish" }));
    assert.equal(out.language, "auto");
});

test("update checking defaults to off for a config that predates it", () => {
    const out = normalizeConfig(legacyConfig());
    assert.equal(out.checkForUpdates, false, "never opt someone in on upgrade");
    assert.equal(out.dismissedUpdateVersion, null);
});

test("a non-boolean checkForUpdates is coerced rather than trusted", () => {
    assert.equal(normalizeConfig(legacyConfig({ checkForUpdates: "yes" })).checkForUpdates, true);
    assert.equal(normalizeConfig(legacyConfig({ checkForUpdates: 0 })).checkForUpdates, false);
});

test("a blank dismissed version is stored as null, not an empty string", () => {
    assert.equal(normalizeConfig(legacyConfig({ dismissedUpdateVersion: "" })).dismissedUpdateVersion, null);
    assert.equal(normalizeConfig(legacyConfig({ dismissedUpdateVersion: 42 })).dismissedUpdateVersion, null);
    assert.equal(
        normalizeConfig(legacyConfig({ dismissedUpdateVersion: "4.1.0" })).dismissedUpdateVersion,
        "4.1.0"
    );
});

test("the shipped default really is opted out", () => {
    assert.equal(DEFAULT_CONFIG.checkForUpdates, false);
    assert.equal(DEFAULT_CONFIG.language, "auto");
});


/* ------------------------------------------------------------- watermark */

test("a config that predates watermarks gets the default, off", () => {
    const out = normalizeConfig(legacyConfig());
    assert.equal(out.watermark.kind, "off");
    assert.equal(out.watermark.position, DEFAULT_WATERMARK.position);
});

test("the default watermark object is never handed out to be edited in place", () => {
    const first = normalizeConfig(legacyConfig()).watermark;
    first.text = "scribbled on";
    assert.equal(DEFAULT_WATERMARK.text, "", "the shared default must not be writable through a config");
    assert.equal(normalizeConfig(legacyConfig()).watermark.text, "");
});

test("a kind with nothing to draw yet is kept, so Settings can be filled in", () => {
    // Downgrading these to "off" made the Settings tab unusable: picking Text
    // sent {kind: "text", text: ""} to the generator, which handed back "off",
    // so the text box never appeared and nothing could ever be typed.
    assert.equal(normalizeWatermark({ kind: "text", text: "" }).kind, "text");
    assert.equal(normalizeWatermark({ kind: "image", imagePath: "" }).kind, "image");
    assert.equal(normalizeWatermark({ kind: "text", text: "F_know" }).kind, "text");
    assert.equal(normalizeWatermark({ kind: "image", imagePath: "C:/logo.png" }).kind, "image");
});

test("whether a watermark draws anything is a separate question", () => {
    const mark = (over) => normalizeWatermark(Object.assign({ kind: "text", text: "F_know" }, over));
    assert.equal(watermarkDraws(mark()), true);
    assert.equal(watermarkDraws(mark({ text: "" })), false, "chosen but not filled in");
    assert.equal(watermarkDraws(mark({ kind: "image", imagePath: "C:/logo.png" })), true);
    assert.equal(watermarkDraws(mark({ kind: "image", imagePath: "" })), false);
    assert.equal(watermarkDraws(mark({ kind: "off" })), false);
});

test("nonsense in a hand-edited watermark is clamped, not trusted", () => {
    const out = normalizeWatermark({
        kind: "banner",
        text: 42,
        style: "raised",
        position: "middleish",
        sizePercent: 900,
        opacityPercent: -3
    });
    assert.equal(out.kind, "off", "an unknown kind falls back to the default");
    assert.equal(out.text, "");
    assert.equal(out.style, DEFAULT_WATERMARK.style, "and so does an unknown style");
    assert.equal(out.position, DEFAULT_WATERMARK.position);
    assert.equal(out.sizePercent, 50, "half the video height is the ceiling");
    assert.equal(out.opacityPercent, 5, "and never fully transparent");
});

test("a watermark survives a round trip through the config unchanged", () => {
    const mark = {
        kind: "text",
        text: "F_know · 2026",
        imagePath: "",
        style: "emboss",
        position: "topLeft",
        sizePercent: 8,
        opacityPercent: 50
    };
    assert.deepEqual(normalizeConfig(legacyConfig({ watermark: mark })).watermark, mark);
});

/* -------------------------------------------------------- export defaults */

test("a config that predates the export block opens the dialog on its defaults", () => {
    const out = normalizeConfig(legacyConfig());
    assert.deepEqual(out.exportDefaults, DEFAULT_EXPORT_DEFAULTS);
});

test("the default export block is never handed out to be edited in place", () => {
    const first = normalizeConfig(legacyConfig()).exportDefaults;
    first.aspectRatio = 1.7778;
    assert.equal(DEFAULT_EXPORT_DEFAULTS.aspectRatio, 0);
    assert.equal(normalizeConfig(legacyConfig()).exportDefaults.aspectRatio, 0);
});

test("a remembered export choice survives a round trip through the config", () => {
    const remembered = { aspectRatio: 1.7778, targetDurationSec: 30 };
    assert.deepEqual(
        normalizeConfig(legacyConfig({ exportDefaults: remembered })).exportDefaults,
        remembered,
        "16:9 has to come back spelled exactly as the dialog spells it, or its option will not match"
    );
});

test("nonsense in a hand-edited export block falls back to the neutral choice", () => {
    const out = normalizeExportDefaults({ aspectRatio: "widescreen", targetDurationSec: -5 });
    assert.equal(out.aspectRatio, 0, "match the canvas");
    assert.equal(out.targetDurationSec, null, "keep the original length");
    assert.equal(normalizeExportDefaults(null).aspectRatio, 0);
    assert.equal(normalizeExportDefaults({ aspectRatio: 400 }).aspectRatio, 0, "and so does an absurd one");
    assert.equal(
        normalizeExportDefaults({ targetDurationSec: 1e9 }).targetDurationSec,
        24 * 3600,
        "a day is as long as an export gets asked for"
    );
});

/* ------------------------------------------------------ clipboard marking */

test("a config that predates the clipboard switch marks the copy", () => {
    // Someone who set a watermark up before this switch existed had every
    // reason to expect it on anything they hand out, so absent means on.
    assert.equal(normalizeConfig(legacyConfig()).clipboardWatermark, true);
    assert.equal(DEFAULT_CONFIG.clipboardWatermark, true);
});

test("only an explicit false turns the clipboard mark off", () => {
    assert.equal(normalizeConfig(legacyConfig({ clipboardWatermark: false })).clipboardWatermark, false);
    assert.equal(normalizeConfig(legacyConfig({ clipboardWatermark: true })).clipboardWatermark, true);
    // A hand-edited config with a string in it should not read as "off"
    // because it is not the boolean false.
    assert.equal(normalizeConfig(legacyConfig({ clipboardWatermark: "no" })).clipboardWatermark, true);
    assert.equal(normalizeConfig(legacyConfig({ clipboardWatermark: null })).clipboardWatermark, true);
});
