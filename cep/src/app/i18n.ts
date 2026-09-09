/**
 * Translation machinery.
 *
 * A plain lookup table rather than i18next: the panel has ~100 strings and no
 * plural or interpolation rules worth a library, and dropping the dependency
 * keeps the bundle small enough to stay comfortable on Photoshop 2020's
 * Chromium 61 engine.
 *
 * The dictionaries themselves live in ./locales, one file per language, so a
 * contributor can add one without touching anything here.
 */

import { Language } from "../../../shared/protocol";
import { dictionaries, resolveLocale } from "./locales";
import { dict as en } from "./locales/en";

export type Translate = (key: string, ...args: Array<string | number>) => string;

/**
 * Builds the lookup for a language.
 *
 * `hostLocale` is Photoshop's own UI locale, used only when the setting is
 * "auto". Every miss falls through to English rather than showing the raw key,
 * so a locale that is behind on a few strings degrades gracefully.
 */
export function createTranslate(language: Language, hostLocale?: string | null): Translate {
    const primary = dictionaries[resolveLocale(language, hostLocale)] || en;
    return function (key: string, ...args: Array<string | number>): string {
        let text = primary[key];
        if (text === undefined) {
            text = en[key];
        }
        if (text === undefined) {
            return key;
        }
        for (let i = 0; i < args.length; i++) {
            text = text.split("{" + i + "}").join(String(args[i]));
        }
        return text;
    };
}

/** `1h 04m` / `3m 20s` / `12s`, in the active language. */
export function formatDuration(totalSeconds: number, t: Translate): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) {
        return hours + t("unit.hour") + " " + pad2(minutes) + t("unit.minuteShort");
    }
    if (minutes > 0) {
        return minutes + t("unit.minuteShort") + " " + pad2(rest) + t("unit.secondShort");
    }
    return rest + t("unit.secondShort");
}

function pad2(value: number): string {
    return value < 10 ? "0" + value : String(value);
}

export function formatMillis(ms: number | null, t: Translate): string {
    if (ms === null) {
        return "—";
    }
    if (ms < 1000) {
        return Math.round(ms) + " " + t("unit.ms");
    }
    return (ms / 1000).toFixed(1) + " " + t("unit.secondShort");
}
