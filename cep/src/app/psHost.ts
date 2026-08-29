/**
 * Thin wrappers around CEP's host bridges: CSInterface (ExtendScript, theme,
 * events) and window.cep.fs (native file dialogs).
 *
 * These APIs are identical from CEP 9 through CEP 12, so one implementation
 * serves Photoshop 2020 through 2026.
 */

declare const require: (id: string) => any;
declare const CSInterface: any;
declare const CSEvent: any;

const childProcess = require("child_process");

let cs: any = null;

function csi(): any {
    if (!cs) {
        cs = new CSInterface();
    }
    return cs;
}

/* ------------------------------------------------------------------- theme */

export interface HostTheme {
    dark: boolean;
    /** Panel background, as reported by Photoshop. */
    background: string;
}

export function readHostTheme(): HostTheme {
    try {
        const skin = csi().getHostEnvironment().appSkinInfo;
        const color = skin.panelBackgroundColor.color;
        const rgb = [Math.round(color.red), Math.round(color.green), Math.round(color.blue)];
        // Photoshop ships four UI brightness levels; the two darker ones need
        // the dark palette. Luminance is a more robust test than an exact match.
        const luminance = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
        return {
            dark: luminance < 128,
            background: "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")"
        };
    } catch (e) {
        return { dark: true, background: "rgb(50,50,50)" };
    }
}

/**
 * Photoshop's own UI language, e.g. "en_US", "zh_CN", "ja_JP".
 *
 * Drives the "Match Photoshop" language setting. Returns null when the host
 * does not say, which resolveLocale treats as English.
 */
export function hostUiLocale(): string | null {
    try {
        const locale = csi().getHostEnvironment().appUILocale;
        return typeof locale === "string" && locale.length > 0 ? locale : null;
    } catch (e) {
        return null;
    }
}

export function onThemeChanged(handler: () => void): void {
    try {
        csi().addEventListener("com.adobe.csxs.events.ThemeColorChanged", handler);
    } catch (e) {
        /* theme sync is cosmetic */
    }
}

/* -------------------------------------------------------------- lifecycle */

/**
 * Asks Photoshop to keep this panel loaded after the user closes it.
 *
 * Recording itself does not depend on this -- the Generator plugin runs
 * independently -- but it keeps the panel's connection alive so reopening is
 * instant.
 */
export function makePanelPersistent(): void {
    try {
        const event = new CSEvent();
        event.type = "com.adobe.PhotoshopPersistent";
        event.appId = csi().getApplicationID();
        event.extensionId = csi().getExtensionID();
        event.scope = "APPLICATION";
        event.data = {};
        csi().dispatchEvent(event);
    } catch (e) {
        /* older hosts may not support it; harmless */
    }
}

/* ----------------------------------------------------------- extendscript */

export function evalScript(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
        try {
            csi().evalScript(script, function (result: string) {
                if (result === "EvalScript_ErrMessage") {
                    reject(new Error("Photoshop could not run the script"));
                    return;
                }
                resolve(result);
            });
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
        }
    });
}

function encodeArg(value: string): string {
    // encodeURIComponent leaves !'()* alone, and ExtendScript string literals
    // are delimited with single quotes, so finish the job here.
    return encodeURIComponent(value).replace(/[!'()*]/g, function (c) {
        return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

/** Writes a full-quality still of the current artwork. */
export async function writeFinalStill(targetPath: string): Promise<"ok" | "no-document"> {
    const result = await evalScript("$.f_record.generateFinalJPG('" + encodeArg(targetPath) + "')");
    if (result === "ok" || result === "no-document") {
        return result;
    }
    throw new Error(result.replace(/^error:/, "") || "Could not export the final image");
}

export async function hasOpenDocument(): Promise<boolean> {
    try {
        return (await evalScript("$.f_record.hasDocument()")) === "yes";
    } catch (e) {
        return false;
    }
}

/* ---------------------------------------------------------------- dialogs */

declare const window: any;

export function chooseFolder(title: string, initial: string): string | null {
    try {
        const result = window.cep.fs.showOpenDialog(false, true, title, initial);
        if (result.err === 0 && result.data && result.data.length > 0) {
            return result.data[0];
        }
    } catch (e) {
        /* dialog unavailable */
    }
    return null;
}

export function chooseSavePath(title: string, suggestedName: string): string | null {
    try {
        const result = window.cep.fs.showSaveDialogEx(title, "", ["mp4"], suggestedName, "MP4 (*.mp4)");
        if (result.err === 0 && result.data) {
            return result.data;
        }
    } catch (e) {
        /* dialog unavailable */
    }
    return null;
}

/** Reveals a file or folder in Explorer. */
export function openInExplorer(target: string): void {
    try {
        if (process.platform === "win32") {
            // `start` needs an empty title argument first, or a quoted path is
            // taken as the window title.
            childProcess.exec('start "" "' + target + '"');
        } else {
            childProcess.exec('open "' + target + '"');
        }
    } catch (e) {
        /* best effort */
    }
}

export function openUrl(url: string): void {
    try {
        window.cep.util.openURLInDefaultBrowser(url);
    } catch (e) {
        /* best effort */
    }
}
