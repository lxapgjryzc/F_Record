/**
 * Picking a language.
 *
 * The panel ships ten locales but Photoshop reports far more than ten values,
 * in a format of its own ("zh_CN", not "zh-CN"). The fallback chain is where
 * that gets reconciled, and getting it wrong means someone lands in a language
 * they cannot read with no obvious way out -- so it is pinned down here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    LOCALE_NAMES,
    dictionaries,
    matchHostLocale,
    resolveLocale
} from "../dist/test/locales.mjs";

/** English is the source of truth every other locale is checked against. */
const en = dictionaries.en;

test("an explicit choice is honoured regardless of the host", () => {
    assert.equal(resolveLocale("ja", "de_DE"), "ja");
    assert.equal(resolveLocale("pt-BR", null), "pt-BR");
});

test("auto follows Photoshop, underscores and all", () => {
    assert.equal(resolveLocale("auto", "ja_JP"), "ja");
    assert.equal(resolveLocale("auto", "zh_CN"), "zh-CN");
    assert.equal(resolveLocale("auto", "zh_TW"), "zh-TW");
    assert.equal(resolveLocale("auto", "pt_BR"), "pt-BR");
});

test("case does not matter, since hosts are inconsistent about it", () => {
    assert.equal(matchHostLocale("ZH-cn"), "zh-CN");
    assert.equal(matchHostLocale("pt-br"), "pt-BR");
});

test("a region we do not ship falls back to the same language", () => {
    assert.equal(matchHostLocale("de_AT"), "de", "Austrian German gets German");
    assert.equal(matchHostLocale("fr_CA"), "fr", "Canadian French gets French");
    assert.equal(matchHostLocale("es_MX"), "es");
    assert.equal(matchHostLocale("en_GB"), "en");
});

test("Chinese is routed by script, not by region", () => {
    assert.equal(matchHostLocale("zh_HK"), "zh-TW", "Hong Kong uses traditional characters");
    assert.equal(matchHostLocale("zh_MO"), "zh-TW");
    assert.equal(matchHostLocale("zh_Hant"), "zh-TW");
    assert.equal(matchHostLocale("zh_SG"), "zh-CN", "Singapore uses simplified");
    assert.equal(matchHostLocale("zh_Hans"), "zh-CN");
    assert.equal(matchHostLocale("zh"), "zh-CN", "bare zh defaults to simplified");
});

test("European Portuguese gets Brazilian rather than English", () => {
    assert.equal(matchHostLocale("pt_PT"), "pt-BR");
});

test("an unknown or empty locale falls back to English", () => {
    assert.equal(matchHostLocale("th_TH"), "en");
    assert.equal(matchHostLocale(""), "en");
    assert.equal(matchHostLocale(null), "en");
    assert.equal(matchHostLocale(undefined), "en");
});

test("a hand-edited config with a bogus language does not blank the panel", () => {
    assert.equal(resolveLocale("klingon", "en_US"), "en");
});

test("every shipped locale covers every English key", () => {
    const expected = Object.keys(en).sort();
    const codes = Object.keys(dictionaries);
    assert.equal(codes.length, 10, "ten locales are shipped");

    for (const code of codes) {
        const actual = Object.keys(dictionaries[code]).sort();
        const missing = expected.filter((key) => actual.indexOf(key) === -1);
        const extra = actual.filter((key) => expected.indexOf(key) === -1);
        assert.deepEqual(missing, [], code + " is missing keys");
        assert.deepEqual(extra, [], code + " has keys English does not");
    }
});

test("no locale left a value empty or accidentally untranslated as a key", () => {
    for (const code of Object.keys(dictionaries)) {
        for (const key of Object.keys(dictionaries[code])) {
            const value = dictionaries[code][key];
            assert.equal(typeof value, "string", code + "/" + key + " is not a string");
            assert.ok(value.length > 0, code + "/" + key + " is empty");
            assert.notEqual(value, key, code + "/" + key + " was left as the key");
        }
    }
});

test("placeholders survive translation", () => {
    // A dropped {0} means a number silently vanishes from the UI.
    const withPlaceholders = Object.keys(en).filter((key) => en[key].indexOf("{0}") !== -1);
    assert.ok(withPlaceholders.length > 0, "the English source really does use placeholders");

    for (const code of Object.keys(dictionaries)) {
        for (const key of withPlaceholders) {
            assert.ok(
                dictionaries[code][key].indexOf("{0}") !== -1,
                code + "/" + key + " lost its {0} placeholder"
            );
        }
        for (const key of Object.keys(en)) {
            if (en[key].indexOf("{1}") !== -1) {
                assert.ok(
                    dictionaries[code][key].indexOf("{1}") !== -1,
                    code + "/" + key + " lost its {1} placeholder"
                );
            }
        }
    }
});

test("every locale has a name written in its own language", () => {
    for (const code of Object.keys(dictionaries)) {
        assert.equal(typeof LOCALE_NAMES[code], "string");
        assert.ok(LOCALE_NAMES[code].length > 0, code + " has no display name");
    }
});
