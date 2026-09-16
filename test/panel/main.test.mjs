/**
 * The eight lines that put the panel on screen.
 *
 * There is exactly one decision in them, and it is worth keeping: the panel
 * mounts into `#panel` and does nothing at all when that element is not there.
 * A `render` into null would throw, and in CEP a throw at the top of the entry
 * script leaves a blank white panel with nothing to say for itself.
 *
 * Importing the module is what runs it, so the two answers cannot both be had
 * in one file. This is the half where the element is there; main-empty covers
 * the other.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { installDom, query, textOf } from "./dom.mjs";
import { stubPanel } from "./panel-harness.mjs";

const dom = installDom();
const panel = stubPanel(mock);

const mountPoint = dom.document.createElement("div");
dom.document.register("panel", mountPoint);
dom.body.appendChild(mountPoint);

await import("../../dist/modules/main.mjs");

test("the panel is rendered into the element the HTML set aside for it", () => {
    assert.ok(query(mountPoint, ".app"), "and it is the whole panel, not a fragment");
    assert.ok(query(mountPoint, ".tabs"));
    assert.ok(textOf(mountPoint).length > 0);
});

test("and it is running: the bridge was opened", () => {
    assert.ok(panel.bridge.listeners, "with somewhere for the generator to talk to");
});
