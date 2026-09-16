/**
 * What Chromium 41 is missing that the panel leans on.
 *
 * Photoshop CC 2015.5 and CC 2017 embed that Chromium (CEP 6.1/7), and the
 * panel is one bundle for every host, so the gaps are filled at start-up on
 * the panel's own window and the code above this never has to know. Both are
 * no-ops on any newer host.
 *
 * Kept to what is actually used: `Object.assign` (Chrome 45) for the state
 * updates in App.tsx, and `KeyboardEvent.key` (Chrome 51), without which Tab
 * would never show a focus ring and Escape would never close a dialog.
 */

import { assign } from "../../../shared/compat";

const KEY_NAMES: { [keyCode: number]: string } = {
    8: "Backspace",
    9: "Tab",
    13: "Enter",
    27: "Escape",
    32: " ",
    33: "PageUp",
    34: "PageDown",
    35: "End",
    36: "Home",
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    46: "Delete"
};

/** The `key` a modern browser would report for a keyCode, for the keys the panel listens for. */
export function keyNameFor(keyCode: number): string {
    return KEY_NAMES[keyCode] || "Unidentified";
}

export function installPolyfills(win: any): void {
    const O = win.Object;
    if (O && typeof O.assign !== "function") {
        O.assign = assign;
    }
    const KeyboardEvent = win.KeyboardEvent;
    if (KeyboardEvent && !("key" in KeyboardEvent.prototype)) {
        Object.defineProperty(KeyboardEvent.prototype, "key", {
            configurable: true,
            get: function (this: { keyCode: number }): string {
                return keyNameFor(this.keyCode);
            }
        });
    }
}
