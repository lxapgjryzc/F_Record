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
import { DEFAULT_CONFIG } from "../dist/test/protocol.mjs";

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
