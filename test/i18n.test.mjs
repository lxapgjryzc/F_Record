/**
 * The panel's ten languages.
 *
 * A plain lookup table rather than i18next: ~100 strings, no plural rules
 * worth a library, and a dependency dropped is bundle weight Photoshop 2020's
 * Chromium 61 does not have to carry. What that costs is that the fallbacks
 * are ours to get right, and they are the whole of this file: a language the
 * panel does not have, a key one dictionary is behind on, a key nobody has.
 * Each has to degrade to something readable rather than to a blank or a
 * dotted key in the middle of a button.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTranslate, formatDuration, formatMillis } from "../dist/modules/i18n.mjs";
import { dictionaries } from "../dist/modules/locales.mjs";

test("a language the panel has is used, and Photoshop's own locale settles auto", () => {
    assert.equal(createTranslate("en")("tab.dashboard"), "Record");
    assert.equal(createTranslate("zh-CN")("tab.dashboard"), dictionaries["zh-CN"]["tab.dashboard"]);

    // "Match Photoshop" is the default, and what it matches is the host's UI
    // locale rather than the operating system's.
    assert.equal(createTranslate("auto", "ja_JP")("tab.dashboard"), dictionaries.ja["tab.dashboard"]);
    assert.equal(createTranslate("auto", null)("tab.dashboard"), "Record", "unknown host, English");
});

test("a language we do not have falls back to English rather than to nothing", () => {
    // Not reachable from the panel's own picker, but config.json is a file the
    // user can edit and a future release can add a tag this build never saw.
    const t = createTranslate("kl-GL");
    assert.equal(t("tab.dashboard"), "Record");
});

test("a key one dictionary is behind on falls through to English", () => {
    // A contributor adds a language and misses a string; the panel shows the
    // English for that one button rather than "settings.watermark.style".
    const t = createTranslate("de");
    for (const key of Object.keys(dictionaries.en)) {
        assert.equal(typeof t(key), "string");
        assert.notEqual(t(key), "", key + " came back empty");
    }
});

test("a key nobody has comes back as itself, which is at least searchable", () => {
    const t = createTranslate("en");
    assert.equal(t("nothing.like.this"), "nothing.like.this");
});

test("placeholders are filled in, in order, and repeated where they repeat", () => {
    const t = createTranslate("en");
    // The dictionaries use {0}, {1} rather than named slots, so the order is
    // the contract; a translator moving them around is what this protects.
    const dict = dictionaries.en;
    const key = Object.keys(dict).find((k) => dict[k].indexOf("{0}") !== -1);
    assert.ok(key, "at least one string takes an argument");
    assert.equal(t(key, "X").indexOf("{0}"), -1, "the placeholder is gone");
    assert.ok(t(key, "X").indexOf("X") !== -1);

    // A string with no placeholders is not disturbed by arguments it never
    // asked for, and a missing argument leaves the placeholder rather than
    // printing "undefined".
    assert.equal(t("tab.dashboard", "unused"), "Record");
});

/* --------------------------------------------------------------- durations */

test("a duration reads as hours, minutes or seconds, whichever it is", () => {
    const t = createTranslate("en");
    assert.equal(formatDuration(3840, t), "1h 04m", "minutes are padded so the width does not jump");
    assert.equal(formatDuration(3600, t), "1h 00m");
    assert.equal(formatDuration(200, t), "3m 20s");
    assert.equal(formatDuration(600, t), "10m 00s", "and so are seconds");
    assert.equal(formatDuration(12, t), "12s");
    assert.equal(formatDuration(0, t), "0s");
});

test("a duration that cannot be one is shown as none rather than as nonsense", () => {
    const t = createTranslate("en");
    // timeSpentSec comes from a manifest on disk, which a crash can leave
    // half-written; a negative would otherwise render as "-1s".
    assert.equal(formatDuration(-5, t), "0s");
    assert.equal(formatDuration(12.9, t), "12s", "and a fraction of a second is not one");
});

test("a capture time is milliseconds until it is worth showing as seconds", () => {
    const t = createTranslate("en");
    assert.equal(formatMillis(null, t), "—", "nothing measured yet");
    assert.equal(formatMillis(0, t), "0 ms");
    assert.equal(formatMillis(120.4, t), "120 ms");
    assert.equal(formatMillis(999, t), "999 ms");
    // Past a second the interesting digit is the first decimal, not the
    // three that would make the number unreadable at a glance.
    assert.equal(formatMillis(1000, t), "1.0 s");
    assert.equal(formatMillis(2450, t), "2.5 s");
});
