/**
 * The tab the panel opens on, which has one job: say what is happening.
 *
 * Almost everything here is a rule about what may be offered. A recording with
 * no frames cannot be exported; a document too small to record does not get a
 * "start" button; a paused recording says why rather than looking off. And
 * when the generator is not there at all the tab says so instead of showing an
 * empty dashboard -- the state 3.x could not express, and the reason this
 * component exists.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { h } from "preact";

import { byText, click, installDom, mount, query, queryAll, textOf } from "./dom.mjs";
import { panelState, sessionRow, stubPanel } from "./panel-harness.mjs";

const dom = installDom();
const panel = stubPanel(mock);
const { Dashboard } = await import("../../dist/modules/dashboard.mjs");
const { createTranslate, formatDuration, formatMillis } = await import("../../dist/modules/i18n.mjs");

const t = createTranslate("en");

/** Mounts the dashboard over a state, recording every callback it makes. */
function dashboard(overrides = {}, props = {}) {
    const calls = [];
    const record = (name) => (...args) => calls.push({ name, args });
    const state =
        overrides === null
            ? null
            : {
                  ...panelState(),
                  ...overrides,
                  config: { ...panelState().config, ...(overrides.config || {}) },
                  health: { ...panelState().health, ...(overrides.health || {}) }
              };
    const container = mount(
        dom,
        h(Dashboard, {
            t,
            state,
            status: "connected",
            statusDetail: null,
            exportJob: null,
            copying: false,
            onToggleRecording: record("toggle"),
            onResume: record("resume"),
            onAdopt: record("adopt"),
            onStartFresh: record("fresh"),
            onExport: record("export"),
            onCopyFrame: record("copy"),
            ...props
        })
    );
    return { container, calls, only: (name) => calls.filter((call) => call.name === name) };
}

const dot = (container) => query(container, "span.record-state span").className;
const toggle = (container) => query(container, 'button[role="switch"]');
const exportButton = (container) => queryAll(container, ".record-actions button")[1] || null;
const copyButton = (container) => queryAll(container, ".record-actions button")[0];

/* ------------------------------------------------------- is it recording? */

test("off, on, live and paused each look different at a glance", () => {
    const off = dashboard({ config: { enabled: false } });
    assert.equal(dot(off.container), "dot");
    assert.ok(textOf(off.container).indexOf(t("record.off")) !== -1);

    const idle = dashboard({ config: { enabled: true } });
    assert.equal(dot(idle.container), "dot ok", "recording, between captures");
    assert.ok(textOf(idle.container).indexOf(t("record.on")) !== -1);

    const live = dashboard({ config: { enabled: true }, health: { capturing: true } });
    assert.equal(dot(live.container), "dot live", "and mid-capture");

    const stopped = dashboard({ config: { enabled: true }, health: { pausedReason: "Disk full" } });
    assert.equal(dot(stopped.container), "dot paused");
    assert.ok(textOf(stopped.container).indexOf(t("record.paused")) !== -1);
});

test("a recording switched on with nothing to record does not claim to be on", () => {
    const { container } = dashboard({ config: { enabled: true }, session: null });
    assert.equal(dot(container), "dot", "the switch is on but no frames are going anywhere");
    assert.ok(textOf(container).indexOf(t("record.off")) !== -1);
});

test("the switch says what it will do, not what is happening", () => {
    const off = dashboard({ config: { enabled: false } });
    assert.equal(textOf(toggle(off.container)).trim(), t("record.start"));
    assert.equal(toggle(off.container).getAttribute("aria-checked"), "false");
    click(toggle(off.container));
    assert.deepEqual(off.only("toggle")[0].args, [true]);

    const on = dashboard({ config: { enabled: true } });
    assert.equal(textOf(toggle(on.container)).trim(), t("record.stop"));
    click(toggle(on.container));
    assert.deepEqual(on.only("toggle")[0].args, [false]);
});

test("a pause says why, and offers the one thing worth doing about it", () => {
    const { container, only } = dashboard({
        config: { enabled: true },
        health: { pausedReason: "Photoshop is busy" }
    });
    const banner = query(container, ".banner.error");
    assert.ok(textOf(banner).indexOf("Photoshop is busy") !== -1, "the reason, in the reason's own words");

    click(query(banner, "button.primary"));
    assert.equal(only("resume").length, 1);
});

/* ------------------------------------------------------------- the numbers */

test("with no session the counters show a dash rather than a zero", () => {
    // A zero would say "recorded nothing"; a dash says "nothing to say yet".
    const { container } = dashboard({ session: null });
    const rows = queryAll(container, ".section .row-value").map(textOf);
    assert.ok(rows.indexOf("—") !== -1);
    assert.equal(rows.filter((value) => value === "—").length, 2, "frames and time both");
});

test("frames, time and capture cost are all shown in words the locale chose", () => {
    const { container } = dashboard({
        session: { ...panelState().session, frameCount: 412, timeSpentSec: 3661 },
        health: { lastCaptureMs: 240, nextIntervalMs: 2500 }
    });
    const text = textOf(container);
    assert.ok(text.indexOf("412") !== -1);
    assert.ok(text.indexOf(formatDuration(3661, t)) !== -1);
    assert.ok(text.indexOf(formatMillis(240, t)) !== -1);
    assert.ok(text.indexOf(t("stat.interval", "2.5" + t("unit.secondShort"))) !== -1);
});

test("the slow encoder says so; the fast one says nothing", () => {
    const slow = dashboard({ health: { encoder: "js" } });
    assert.ok(textOf(slow.container).indexOf(t("stat.encoder.js")) !== -1);

    const fast = dashboard({ health: { encoder: "sharp" } });
    assert.equal(textOf(fast.container).indexOf(t("stat.encoder.js")), -1);
});

/* ------------------------------------------------------------ the document */

test("with nothing open the document row says so, quietly", () => {
    const { container } = dashboard({ document: null });
    assert.equal(textOf(query(container, ".section span.muted")), t("doc.none"));
});

test("a canvas too small to record is told so, and not offered a recording", () => {
    const { container } = dashboard({
        document: { ...panelState().document, tooSmall: true },
        session: null
    });
    assert.ok(textOf(container).indexOf(t("doc.tooSmall")) !== -1);
    assert.equal(byText(container, t("doc.startForThis")), null, "starting one would fail");
});

test("a document with no recording yet is offered one", () => {
    const { container, only } = dashboard({ document: panelState().document, session: null });
    click(byText(container, t("doc.startForThis")));
    assert.equal(only("fresh").length, 1);
});

test("nothing is offered twice: the resume banner takes the offer with it", () => {
    const { container } = dashboard({
        session: null,
        resumeCandidates: [sessionRow({ sessionId: "old" })]
    });
    assert.equal(byText(container, t("doc.startForThis")), null);
    assert.ok(textOf(container).indexOf(t("resume.title")) !== -1, "the resume offer says it instead");
});

/* -------------------------------------------------------------- resuming */

test("the recordings worth resuming are named, and at most three are", () => {
    const { container, only } = dashboard({
        resumeCandidates: [
            sessionRow({ sessionId: "a", docName: "dragon", frameCount: 40 }),
            sessionRow({ sessionId: "b", docName: "castle" }),
            sessionRow({ sessionId: "c", docName: "forest" }),
            sessionRow({ sessionId: "d", docName: "ocean" })
        ]
    });
    const offers = queryAll(query(container, ".banner-actions"), "button");
    assert.equal(offers.length, 4, "three recordings and a way out");
    assert.equal(textOf(offers[0]), "dragon · " + t("resume.frames", 40));
    assert.equal(textOf(offers[3]), t("resume.fresh"));

    click(offers[0]);
    assert.deepEqual(only("adopt")[0].args, ["a"]);
    click(offers[3]);
    assert.equal(only("fresh").length, 1);
});

/* -------------------------------------------------------------- exporting */

test("a recording with no frames cannot be exported", () => {
    const empty = dashboard({ session: { ...panelState().session, frameCount: 0 } });
    assert.equal(exportButton(empty.container).disabled, true);

    const none = dashboard({ session: null });
    assert.equal(exportButton(none.container).disabled, true);

    const some = dashboard({});
    assert.equal(exportButton(some.container).disabled, false);
    click(exportButton(some.container));
    assert.equal(some.only("export").length, 1);
});

test("while an export runs, the buttons are replaced by how far along it is", () => {
    const { container } = dashboard({}, { exportJob: { label: "Encoding", percent: 42 } });
    assert.equal(textOf(query(container, ".progress-label")), "Encoding42%");
    assert.equal(query(container, ".progress-fill").style.width, "42%");
    assert.equal(exportButton(container), null, "there is nothing else to do meanwhile");
});

test("the frames folder can be opened, when there is one", () => {
    const { container } = dashboard({});
    click(byText(container, t("sessions.open")));
    assert.deepEqual(panel.host.calls.pop(), { name: "openInExplorer", args: ["C:/frames/s1"] });

    const none = dashboard({ session: null });
    assert.equal(byText(none.container, t("sessions.open")), null);
});

/* -------------------------------------------------------------- the copy */

test("copying asks the document, so it is offered before there is a recording", () => {
    const { container, only } = dashboard({ session: null });
    assert.equal(copyButton(container).disabled, false, "there is something on screen to copy");
    click(copyButton(container));
    assert.equal(only("copy").length, 1);

    const closed = dashboard({ document: null });
    assert.equal(copyButton(closed.container).disabled, true);
});

test("the tooltip promises a signature only when one is actually coming", () => {
    const off = dashboard({});
    assert.equal(copyButton(off.container).getAttribute("title"), t("clipboard.hint.plain"));

    const half = dashboard({ config: { watermark: { kind: "text", text: "" } } });
    assert.equal(
        copyButton(half.container).getAttribute("title"),
        t("clipboard.hint.plain"),
        "a mark with nothing typed in it draws nothing"
    );

    const on = dashboard({ config: { watermark: { kind: "text", text: "Anna" } } });
    assert.equal(copyButton(on.container).getAttribute("title"), t("clipboard.hint"));

    const declined = dashboard({
        config: { watermark: { kind: "text", text: "Anna" }, clipboardWatermark: false }
    });
    assert.equal(copyButton(declined.container).getAttribute("title"), t("clipboard.hint.plain"));
});

test("while a copy is being made, nothing else may be started", () => {
    const { container } = dashboard({}, { copying: true });
    assert.equal(textOf(copyButton(container)), t("clipboard.working"));
    assert.equal(copyButton(container).disabled, true);
    assert.equal(exportButton(container).disabled, true, "both hands are full");
});

/* ------------------------------------------------------- no generator yet */

test("while it is still looking, it says so rather than showing an empty panel", () => {
    const { container } = dashboard(null, { status: "connecting" });
    assert.equal(textOf(query(container, ".empty")), t("status.connecting"));
});

test("a generator that is not there is a warning, with whatever is known about why", () => {
    const bare = dashboard(null, { status: "offline" });
    assert.equal(textOf(query(bare.container, ".banner-title")), t("status.unavailable"));
    assert.equal(textOf(query(bare.container, ".banner-body")), t("status.unavailable.hint"));

    const detailed = dashboard(null, { status: "offline", statusDetail: "ECONNREFUSED" });
    assert.equal(
        textOf(query(detailed.container, ".banner-body")),
        t("status.unavailable.hint") + " (ECONNREFUSED)"
    );
});

test("a generator of the wrong vintage says that, and not that it is missing", () => {
    // These are different problems with different answers -- one is "start
    // Photoshop", the other is "update the plugin" -- so they cannot share a
    // message.
    const bare = dashboard(null, { status: "mismatch" });
    assert.equal(textOf(query(bare.container, ".banner-title")), t("status.mismatch"));
    assert.equal(textOf(query(bare.container, ".banner-body")), t("status.mismatch.hint"));

    const detailed = dashboard(null, { status: "mismatch", statusDetail: "panel 5, generator 4" });
    assert.equal(textOf(query(detailed.container, ".banner-body")), "panel 5, generator 4");
});

test("connected but with nothing said yet is still not a dashboard", () => {
    const { container } = dashboard(null, { status: "connected" });
    assert.ok(query(container, ".banner.warn"), "no state means nothing to show");
});
