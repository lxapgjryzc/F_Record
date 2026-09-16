/**
 * The var() fallback for Chromium 41 (Photoshop CC 2015.5 / CC 2017).
 *
 * The substitution is pure text and is tested as such; the installation is
 * tested against the smallest document that has the three things it touches:
 * somewhere to append a style, a class list on :root to read the theme from,
 * and createElement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { inlineCssVariables, supportsCssVariables, installCssVariableFallback, refreshCssVariables } = await import(
    "../dist/modules/cssVars.mjs"
);

const SHEET = [
    ":root {",
    "    --bg: #323232;",
    "    --text: #e8e8e8;",
    "    --accent: #2680eb;",
    "    --accent-hover: var(--accent);",
    "}",
    ":root.light {",
    "    --bg: #f0f0f0;",
    "    --text: #202020;",
    "}",
    "body { background: var(--bg); color: var(--text); }",
    ".button:hover { color: var( --accent-hover ); }",
    ".hint { padding: var(--gap, 4px); margin: var(--nothing); }"
].join("\n");

/* ------------------------------------------------------------ substitution */

test("every var() is replaced by the value :root declares", () => {
    const out = inlineCssVariables(SHEET, false);
    assert.match(out, /body \{ background: #323232; color: #e8e8e8; \}/);
});

test("the light block wins when the light class is on", () => {
    const out = inlineCssVariables(SHEET, true);
    assert.match(out, /body \{ background: #f0f0f0; color: #202020; \}/);
    // ...and only for what it redefines.
    assert.match(out, /\.button:hover \{ color: #2680eb; \}/);
});

test("a value that refers to another value is followed", () => {
    assert.match(inlineCssVariables(SHEET, false), /\.button:hover \{ color: #2680eb; \}/);
});

test("a fallback fills in for a name nobody declared, and no fallback leaves the reference as it was", () => {
    const out = inlineCssVariables(SHEET, false);
    assert.match(out, /padding: 4px;/);
    // The host drops that declaration, exactly as it would have anyway.
    assert.match(out, /margin: var\(--nothing\);/);
});

test("two values that point at each other do not loop forever", () => {
    const circular = ":root { --a: var(--b); --b: var(--a); }\np { color: var(--a); }";
    const out = inlineCssVariables(circular, false);
    assert.match(out, /p \{ color: var\(--[ab]\); \}/);
});

test("a sheet with no :root block at all is returned with its references untouched", () => {
    assert.equal(inlineCssVariables("p { color: var(--x); }", true), "p { color: var(--x); }");
});

/* --------------------------------------------------------------- detection */

test("native var() is detected through CSS.supports, and anything less is taken as no", () => {
    assert.equal(supportsCssVariables({ CSS: { supports: () => true } }), true);
    // Chromium 41 has CSS.supports but says no to a custom property.
    assert.equal(supportsCssVariables({ CSS: { supports: () => false } }), false);
    assert.equal(supportsCssVariables({ CSS: {} }), false);
    assert.equal(supportsCssVariables({}), false);
    assert.equal(
        supportsCssVariables({
            CSS: {
                supports() {
                    throw new Error("not here");
                }
            }
        }),
        false
    );
});

/* ------------------------------------------------------------ installation */

/** A document with exactly what the fallback touches. */
function fakeDocument({ head = true } = {}) {
    const appended = [];
    const holder = { appendChild: (node) => appended.push(node) };
    const classes = new Set();
    return {
        appended,
        classes,
        doc: {
            head: head ? holder : null,
            body: holder,
            documentElement: { classList: { contains: (name) => classes.has(name) } },
            createElement: (tag) => ({ tag, textContent: "" })
        }
    };
}

test("refreshing with nothing installed is nothing", () => {
    refreshCssVariables();
});

test("on a host with native var() nothing is installed", () => {
    const { doc, appended } = fakeDocument();
    assert.equal(installCssVariableFallback({ CSS: { supports: () => true }, document: doc }, () => SHEET), null);
    assert.equal(appended.length, 0);
});

test("a stylesheet that cannot be read installs nothing either", () => {
    const { doc, appended } = fakeDocument();
    assert.equal(installCssVariableFallback({ document: doc }, () => null), null);
    assert.equal(appended.length, 0);
});

test("without native var() the substituted sheet is installed and follows the theme class", () => {
    const { doc, appended, classes } = fakeDocument();
    const fallback = installCssVariableFallback({ document: doc }, () => SHEET);

    assert.ok(fallback);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].tag, "style");
    assert.match(appended[0].textContent, /background: #323232;/);

    // The theme flipped to light: App.tsx toggles the class and asks for a refresh.
    classes.add("light");
    refreshCssVariables();
    assert.match(appended[0].textContent, /background: #f0f0f0;/);
});

test("a document without a head takes the style in its body", () => {
    const { doc, appended } = fakeDocument({ head: false });
    assert.ok(installCssVariableFallback({ document: doc }, () => SHEET));
    assert.equal(appended.length, 1);
});
