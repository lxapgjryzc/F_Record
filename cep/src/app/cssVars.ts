/**
 * CSS custom properties on a Chromium that has none.
 *
 * The stylesheet carries the theme as custom properties on :root, with
 * :root.light overriding them. Chromium 49 was the first to understand var(),
 * and Photoshop CC 2015.5 / CC 2017 embed Chromium 41: there, every
 * declaration that uses var() is thrown away at parse time and the panel
 * comes up unstyled. So on that host the stylesheet's own text is read, the
 * values are substituted in, and the result is installed as an inline
 * stylesheet -- again each time the theme flips, since the flip is a class
 * on :root that the substitution has to see.
 *
 * Nothing here runs on a host that understands var() itself.
 */

const ROOT_BLOCK = /:root\s*\{([^}]*)\}/;
const LIGHT_BLOCK = /:root\.light\s*\{([^}]*)\}/;
const DECLARATION = /(--[\w-]+)\s*:\s*([^;]+);/g;
const REFERENCE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g;

/** Values may point at other values; this many passes settles any sane sheet. */
const MAX_PASSES = 8;

interface Values {
    [name: string]: string;
}

export function supportsCssVariables(win: any): boolean {
    try {
        return !!(win.CSS && typeof win.CSS.supports === "function" && win.CSS.supports("--probe", "0"));
    } catch (e) {
        return false;
    }
}

function declarations(css: string, block: RegExp, into: Values): void {
    const match = block.exec(css);
    if (!match) {
        return;
    }
    let declaration: RegExpExecArray | null;
    DECLARATION.lastIndex = 0;
    while ((declaration = DECLARATION.exec(match[1])) !== null) {
        into[declaration[1]] = declaration[2].trim();
    }
}

function substitute(text: string, values: Values): string {
    return text.replace(REFERENCE, (reference: string, name: string, fallback: string | undefined) => {
        if (Object.prototype.hasOwnProperty.call(values, name)) {
            return values[name];
        }
        // A reference to nothing stays as it was: the host drops the
        // declaration, exactly as it would have without this module.
        return fallback === undefined ? reference : fallback.trim();
    });
}

/** The stylesheet with every var() replaced by the value :root (and, when `light`, :root.light) declares. */
export function inlineCssVariables(css: string, light: boolean): string {
    const values: Values = {};
    declarations(css, ROOT_BLOCK, values);
    if (light) {
        declarations(css, LIGHT_BLOCK, values);
    }

    let pass = 0;
    let changed = true;
    while (changed && pass < MAX_PASSES) {
        changed = false;
        pass++;
        for (const name in values) {
            const resolved = substitute(values[name], values);
            if (resolved !== values[name]) {
                values[name] = resolved;
                changed = true;
            }
        }
    }

    return substitute(css, values);
}

export interface CssVariableFallback {
    /** Re-substitutes for the theme class :root carries now. */
    refresh(): void;
}

let active: CssVariableFallback | null = null;

/**
 * Installs the substituted stylesheet on a host without var(), and returns
 * a handle to refresh it. Null where the host needs no help, or where the
 * stylesheet could not be read -- in which case the panel is left to the
 * host, which is no worse than before.
 */
export function installCssVariableFallback(win: any, readStylesheet: () => string | null): CssVariableFallback | null {
    if (supportsCssVariables(win)) {
        return null;
    }
    const css = readStylesheet();
    if (!css) {
        return null;
    }
    const doc = win.document;
    const style = doc.createElement("style");
    (doc.head || doc.body).appendChild(style);
    const fallback: CssVariableFallback = {
        refresh() {
            style.textContent = inlineCssVariables(css, doc.documentElement.classList.contains("light"));
        }
    };
    fallback.refresh();
    active = fallback;
    return fallback;
}

/** After the theme class changed. Nothing to do on a host with native var(). */
export function refreshCssVariables(): void {
    if (active) {
        active.refresh();
    }
}
