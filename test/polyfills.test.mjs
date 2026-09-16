/**
 * The two things Chromium 41 (Photoshop CC 2015.5 / CC 2017) lacks that the
 * panel leans on. Everything is installed on a window handed in, never on
 * this process's own globals, so the real Object is never touched here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { installPolyfills, keyNameFor } = await import("../dist/modules/polyfills.mjs");

test("a window without Object.assign gets one that merges left to right and skips a null source", () => {
    const win = { Object: {} };
    installPolyfills(win);
    assert.equal(typeof win.Object.assign, "function");
    assert.deepEqual(win.Object.assign({ a: 1 }, { b: 2 }, null, { a: 3 }), { a: 3, b: 2 });
});

test("a window that has Object.assign keeps its own", () => {
    const own = () => "mine";
    const win = { Object: { assign: own } };
    installPolyfills(win);
    assert.equal(win.Object.assign, own);
});

test("a window with no Object at all -- the test DOM -- is left alone", () => {
    installPolyfills({});
});

test("KeyboardEvent.key is derived from keyCode where the host never set it", () => {
    function KeyboardEvent(keyCode) {
        this.keyCode = keyCode;
    }
    installPolyfills({ KeyboardEvent });

    assert.equal(new KeyboardEvent(27).key, "Escape");
    assert.equal(new KeyboardEvent(9).key, "Tab");
    assert.equal(new KeyboardEvent(13).key, "Enter");
    assert.equal(new KeyboardEvent(32).key, " ");
    // F1: not something the panel listens for, and not something worth
    // guessing at either.
    assert.equal(new KeyboardEvent(112).key, "Unidentified");
});

test("a KeyboardEvent that already reports key is not overridden", () => {
    function KeyboardEvent() {}
    Object.defineProperty(KeyboardEvent.prototype, "key", { get: () => "native" });
    installPolyfills({ KeyboardEvent });
    assert.equal(new KeyboardEvent().key, "native");
});

test("the arrows and the editing keys are named the way a modern browser names them", () => {
    assert.deepEqual([37, 38, 39, 40].map(keyNameFor), ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]);
    assert.deepEqual([8, 46, 33, 34, 35, 36].map(keyNameFor), ["Backspace", "Delete", "PageUp", "PageDown", "End", "Home"]);
});
