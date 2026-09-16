/**
 * The locale table, and the rule for picking one.
 *
 * All ten dictionaries are bundled rather than loaded on demand: the panel runs
 * from the local filesystem inside CEP, where a dynamic import would mean an
 * extra file read per language and would not work at all on Photoshop 2020's
 * Chromium 61. Together they add roughly 25 KB before minification, which is
 * cheaper than the machinery to avoid them.
 *
 * `resolveLocale` is pure so the fallback chain can be tested without a host;
 * see test/locales.test.mjs.
 */

import { Language } from "../../../../shared/protocol";
import { dict as en } from "./en";
import { dict as zhCN } from "./zh-CN";
import { dict as zhTW } from "./zh-TW";
import { dict as ja } from "./ja";
import { dict as ko } from "./ko";
import { dict as de } from "./de";
import { dict as fr } from "./fr";
import { dict as es } from "./es";
import { dict as ptBR } from "./pt-BR";
import { dict as ru } from "./ru";

export type Dict = Record<string, string>;

/** Every language except "auto", which is a rule rather than a dictionary. */
export type Locale = Exclude<Language, "auto">;

export const dictionaries: Record<Locale, Dict> = {
    en: en,
    "zh-CN": zhCN,
    "zh-TW": zhTW,
    ja: ja,
    ko: ko,
    de: de,
    fr: fr,
    es: es,
    "pt-BR": ptBR,
    ru: ru
};

export const FALLBACK_LOCALE: Locale = "en";

/**
 * Regional variants we do not ship, pointed at the closest thing we do.
 *
 * Traditional-script Chinese regions get zh-TW and simplified ones zh-CN,
 * because script matters far more than region here. European Portuguese gets
 * pt-BR: not ideal, but far closer for a Portuguese speaker than English.
 */
const REGION_ALIASES: Record<string, Locale> = {
    "zh-hk": "zh-TW",
    "zh-mo": "zh-TW",
    "zh-hant": "zh-TW",
    "zh-sg": "zh-CN",
    "zh-hans": "zh-CN",
    "pt-pt": "pt-BR"
};

/** Primary subtag -> locale, for hosts reporting e.g. "de_AT" or plain "fr". */
const PRIMARY: Record<string, Locale> = {
    en: "en",
    zh: "zh-CN",
    ja: "ja",
    ko: "ko",
    de: "de",
    fr: "fr",
    es: "es",
    pt: "pt-BR",
    ru: "ru"
};

/**
 * Turns Photoshop's `appUILocale` into one of our locales.
 *
 * The host reports things like "en_US", "zh_CN", "pt_BR", sometimes just "de".
 * Underscores and case are normalised first, then the full tag is tried, then
 * the alias table, then the primary subtag, and finally English.
 */
export function matchHostLocale(hostLocale: string | null | undefined): Locale {
    const raw = String(hostLocale || "").trim().replace(/_/g, "-");
    if (!raw) {
        return FALLBACK_LOCALE;
    }
    const lower = raw.toLowerCase();

    // Exact match against a shipped locale, ignoring case ("zh-cn" -> "zh-CN").
    const localeKeys = Object.keys(dictionaries) as Locale[];
    for (let i = 0; i < localeKeys.length; i++) {
        if (localeKeys[i].toLowerCase() === lower) {
            return localeKeys[i];
        }
    }

    if (REGION_ALIASES[lower]) {
        return REGION_ALIASES[lower];
    }

    const primary = lower.split("-")[0];
    if (PRIMARY[primary]) {
        return PRIMARY[primary];
    }
    return FALLBACK_LOCALE;
}

/**
 * The locale actually used: the explicit choice, or the host's when set to
 * "auto". An unknown stored value falls back to English rather than throwing,
 * so a hand-edited config cannot leave the panel blank.
 */
export function resolveLocale(language: Language, hostLocale: string | null | undefined): Locale {
    if (language === "auto") {
        return matchHostLocale(hostLocale);
    }
    if (Object.prototype.hasOwnProperty.call(dictionaries, language)) {
        return language as Locale;
    }
    return FALLBACK_LOCALE;
}

/** What each option is called in its own language, for the settings menu. */
export const LOCALE_NAMES: Record<Locale, string> = {
    en: "English",
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    ja: "日本語",
    ko: "한국어",
    de: "Deutsch",
    fr: "Français",
    es: "Español",
    "pt-BR": "Português (Brasil)",
    ru: "Русский"
};
