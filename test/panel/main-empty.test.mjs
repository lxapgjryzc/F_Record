/**
 * The other half of main.tsx: a page with no `#panel` in it.
 *
 * That should never happen -- index.html has one -- but rendering into null
 * throws, and a throw at the top of the entry script is a blank white CEP
 * panel with no way to say what went wrong. Doing nothing is quieter and
 * leaves the HTML visible.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { installDom, textOf } from "./dom.mjs";
import { stubPanel } from "./panel-harness.mjs";

const dom = installDom();
const panel = stubPanel(mock);

await import("../../dist/modules/main.mjs");

test("with nowhere to mount, nothing is mounted and nothing is thrown", () => {
    assert.equal(textOf(dom.body), "");
    assert.equal(panel.bridge.listeners, null, "and the bridge was never opened");
});
