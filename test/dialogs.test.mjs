/**
 * The three dialogs that stand between a click and something irreversible.
 *
 * Each one is the last word before frames or documents go: the export
 * settings, the zip-and-delete confirmation, and the clean-up review. What
 * they have in common is that the safe half is the default -- packing does not
 * delete unless asked, the review deletes nothing until the very end -- and
 * that they never offer a choice the recording in front cannot actually
 * honour.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { h } from "preact";

import { byText, choose, click, installDom, mount, query, queryAll, textOf } from "./dom.mjs";
import { sessionRow } from "./panel-harness.mjs";

const dom = installDom();
const { PackDialog } = await import("../dist/modules/packDialog.mjs");
const { ExportDialog } = await import("../dist/modules/exportDialog.mjs");
const { ReviewDialog } = await import("../dist/modules/review.mjs");
const { createTranslate } = await import("../dist/modules/i18n.mjs");
const { DEFAULT_EXPORT_DEFAULTS, DEFAULT_WATERMARK, watermarkDraws } = await import("../dist/modules/protocol.mjs");

const t = createTranslate("en");

/* ---------------------------------------------------------------- packing */

test("packing does not delete unless it is asked to", () => {
    const confirmed = [];
    const container = mount(
        dom,
        h(PackDialog, {
            t,
            count: 3,
            folder: "D:/archive",
            onConfirm: (deleteAfter) => confirmed.push(deleteAfter),
            onCancel: () => {}
        })
    );

    // Packing is the safe half; the delete has to be asked for.
    const toggle = query(container, "button[role=\"switch\"]");
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.ok(textOf(container).indexOf("D:/archive") !== -1, "and it says where they are going");

    click(query(container, "button.primary"));
    assert.deepEqual(confirmed, [false]);
});

test("packing deletes when the switch is on, and the switch is what decides", () => {
    const confirmed = [];
    const container = mount(
        dom,
        h(PackDialog, {
            t,
            count: 1,
            folder: "D:/archive",
            onConfirm: (deleteAfter) => confirmed.push(deleteAfter),
            onCancel: () => {}
        })
    );

    click(query(container, "button[role=\"switch\"]"));
    assert.equal(query(container, "button[role=\"switch\"]").getAttribute("aria-checked"), "true");

    click(query(container, "button.primary"));
    assert.deepEqual(confirmed, [true]);
});

test("packing can be backed out of, by the button or by the scrim", () => {
    const cancelled = [];
    const container = mount(
        dom,
        h(PackDialog, { t, count: 1, folder: "D:/a", onConfirm: () => {}, onCancel: () => cancelled.push(1) })
    );

    click(byText(container, t("export.cancel")));
    click(query(container, ".dialog-scrim"));
    assert.deepEqual(cancelled, [1, 1]);
});

/* --------------------------------------------------------------- exporting */

function exportDialog(props) {
    const confirmed = [];
    const cancelled = [];
    const container = mount(
        dom,
        h(ExportDialog, {
            t,
            frameCount: 1800,
            watermark: DEFAULT_WATERMARK,
            defaults: DEFAULT_EXPORT_DEFAULTS,
            onConfirm: (choice) => confirmed.push(choice),
            onCancel: () => cancelled.push(1),
            ...props
        })
    );
    return { container, confirmed, cancelled };
}

const selectFor = (container, label) => query(container, 'select[aria-label="' + t(label) + '"]');

test("only the lengths shorter than the recording are offered", () => {
    // 1200 frames at 30fps is forty seconds, plus three seconds of bookends.
    // A one-minute preset would make the video longer, not shorter.
    const short = exportDialog({ frameCount: 1200 });
    const lengths = queryAll(selectFor(short.container, "export.duration"), "option").map((o) => o.value);
    assert.deepEqual(lengths, ["15", "30", "0"], "15s and 30s, then the original");

    const long = exportDialog({ frameCount: 30 * 600 });
    assert.deepEqual(
        queryAll(selectFor(long.container, "export.duration"), "option").map((o) => o.value),
        ["15", "30", "60", "180", "0"]
    );

    const tiny = exportDialog({ frameCount: 10 });
    assert.deepEqual(
        queryAll(selectFor(tiny.container, "export.duration"), "option").map((o) => o.value),
        ["0"],
        "a recording shorter than every preset offers only its own length"
    );
});

test("the dialog reopens where the last export was confirmed", () => {
    const { container } = exportDialog({ defaults: { aspectRatio: 1.7778, targetDurationSec: 30 } });
    assert.equal(selectFor(container, "export.aspect").value, "1.7778");
    assert.equal(selectFor(container, "export.duration").value, "30");
});

test("a remembered choice this recording cannot offer falls back to the neutral one", () => {
    // "30s" remembered from an hour-long session is not on the menu for a
    // twenty-second one, and a Select pointed at a value it has no option for
    // renders as an empty box.
    const { container } = exportDialog({
        frameCount: 300,
        defaults: { aspectRatio: 99, targetDurationSec: 180 }
    });
    assert.equal(selectFor(container, "export.duration").value, "0", "the original length");
    assert.equal(selectFor(container, "export.aspect").value, "0", "match the canvas");
});

test("what is confirmed is what was chosen, as numbers rather than strings", () => {
    const { container, confirmed } = exportDialog({ frameCount: 30 * 600 });

    choose(selectFor(container, "export.aspect"), "0.5625");
    choose(selectFor(container, "export.duration"), "60");
    click(query(container, "button.primary"));

    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].aspectRatio, 0.5625);
    assert.equal(confirmed[0].targetDurationSec, 60);
    assert.equal(confirmed[0].watermark.kind, "off");
});

test("the original length is confirmed as null, not as zero seconds", () => {
    const { container, confirmed } = exportDialog({});
    choose(selectFor(container, "export.duration"), "0");
    click(query(container, "button.primary"));
    assert.equal(confirmed[0].targetDurationSec, null);
});

test("a watermark switched on for one export is offered, with a hint about scope", () => {
    const { container, confirmed } = exportDialog({});
    assert.equal(textOf(container).indexOf(t("watermark.dialog.hint")), -1, "no hint while it is off");

    choose(query(container, 'select[aria-label="' + t("watermark") + '"]'), "text");
    assert.ok(textOf(container).indexOf(t("watermark.dialog.hint")) !== -1, "now it says this is one-off");

    click(query(container, "button.primary"));

    // The dialog hands on what was chosen rather than second-guessing it; a
    // mark with nothing in it is one that draws nothing, and that is decided
    // downstream so half-typed text does not keep switching the mark off.
    assert.equal(confirmed[0].watermark.kind, "text");
    assert.equal(watermarkDraws(confirmed[0].watermark), false, "still draws nothing");
});

test("exporting can be backed out of", () => {
    const { container, cancelled, confirmed } = exportDialog({});
    click(byText(container, t("export.cancel")));
    assert.deepEqual(cancelled, [1]);
    assert.deepEqual(confirmed, []);
});

/* ---------------------------------------------------------------- review */

function reviewState(overrides = {}) {
    return { ids: ["s1", "s2"], index: 0, opening: false, opened: "opened", decisions: {}, summary: false, ...overrides };
}

function reviewDialog(props) {
    const decided = [];
    const events = { stop: 0, apply: 0, discard: 0 };
    const container = mount(
        dom,
        h(ReviewDialog, {
            t,
            review: reviewState(),
            session: sessionRow(),
            lastKnownPath: "C:/art/dragon.psd",
            onDecide: (d) => decided.push(d),
            onStop: () => events.stop++,
            onApply: () => events.apply++,
            onDiscard: () => events.discard++,
            ...props
        })
    );
    return { container, decided, events };
}

test("the review shows which recording is in front and how far along it is", () => {
    const { container } = reviewDialog({ review: reviewState({ index: 1 }) });
    assert.equal(textOf(query(container, ".dialog-title")), t("review.title", 2, 2));
    assert.equal(textOf(query(container, ".review-name")), "dragon");
    assert.ok(textOf(query(container, ".session-meta")).length > 0, "with its frame count and date");
});

test("a recording the listing no longer has is named by its id", () => {
    const { container } = reviewDialog({ session: null });
    assert.equal(textOf(query(container, ".review-name")), "s1");
    assert.equal(query(container, ".session-meta"), null);
});

test("a recording with no date to show does not show an empty separator", () => {
    const { container } = reviewDialog({ session: sessionRow({ lastModifiedAt: 0 }) });
    assert.equal(textOf(query(container, ".session-meta")), t("sessions.frames", 12, "1m 30s"));
});

test("every way the document could have been opened has words for it", () => {
    const cases = {
        opened: t("review.opened"),
        already: t("review.already"),
        missing: t("review.missing", "C:/art/dragon.psd"),
        none: t("review.unsaved"),
        error: t("review.failed"),
        null: t("review.opening")
    };
    for (const [opened, expected] of Object.entries(cases)) {
        const { container } = reviewDialog({ review: reviewState({ opened: opened === "null" ? null : opened }) });
        assert.equal(textOf(query(container, "p.hint")), expected, opened);
    }
});

test("deleting the document is only offered when the document is in front", () => {
    // The whole point of the review is deciding with the picture in front of
    // you; offering to bin a file nobody is looking at is how a slip happens.
    const deletable = (opened) => {
        const { container } = reviewDialog({ review: reviewState({ opened }) });
        return byText(container, t("review.deleteWithFile")).disabled;
    };
    assert.equal(deletable("opened"), false);
    assert.equal(deletable("already"), false);
    assert.equal(deletable("missing"), true);
    assert.equal(deletable("none"), true);
    assert.equal(deletable("error"), true);
});

test("nothing can be decided while Photoshop is still opening the document", () => {
    const { container, decided } = reviewDialog({ review: reviewState({ opening: true }) });
    for (const label of ["review.keep", "review.delete", "review.deleteWithFile", "review.stop"]) {
        assert.equal(byText(container, t(label)).disabled, true, label);
    }
    assert.deepEqual(decided, []);
});

test("each of the three answers is passed on as itself", () => {
    for (const [label, decision] of [
        ["review.keep", "keep"],
        ["review.delete", "delete"],
        ["review.deleteWithFile", "deleteWithFile"]
    ]) {
        const { container, decided } = reviewDialog({});
        click(byText(container, t(label)));
        assert.deepEqual(decided, [decision]);
    }
});

test("the running tally appears only once something has been decided", () => {
    const none = reviewDialog({});
    assert.equal(queryAll(none.container, "p.hint").length, 1, "just the status line");

    const some = reviewDialog({
        review: reviewState({ decisions: { s1: "delete", s2: "deleteWithFile" } })
    });
    const hints = queryAll(some.container, "p.hint").map((p) => textOf(p));
    assert.equal(hints.length, 2);
    assert.equal(hints[1], t("review.soFar", 2, 1), "two decided, one of them with its file");
});

test("stopping the review is always available, and is not a decision", () => {
    const { container, events, decided } = reviewDialog({});
    click(byText(container, t("review.stop")));
    assert.equal(events.stop, 1);
    assert.deepEqual(decided, []);

    // The scrim does the same, rather than leaving the review half-open.
    click(query(container, ".dialog-scrim"));
    assert.equal(events.stop, 2);
});

/* ------------------------------------------------------- the review summary */

test("the summary offers to apply only when there is something to apply", () => {
    const empty = reviewDialog({ review: reviewState({ summary: true }) });
    assert.equal(textOf(query(empty.container, "p.dialog-text")), t("review.summaryNone"));
    assert.equal(query(empty.container, "button.primary"), null, "nothing to apply");
    assert.equal(textOf(query(empty.container, ".dialog-actions button")), t("common.dismiss"));

    const some = reviewDialog({
        review: reviewState({ summary: true, decisions: { s1: "delete", s2: "deleteWithFile" } })
    });
    assert.equal(textOf(query(some.container, "p.dialog-text")), t("review.summary", 2, 1));
    click(query(some.container, "button.primary"));
    assert.equal(some.events.apply, 1);
});

test("a review can be discarded whole, so a slip costs nothing", () => {
    // Nothing has been deleted along the way; the decisions are applied
    // together at the end, behind this one confirmation.
    const { container, events } = reviewDialog({
        review: reviewState({ summary: true, decisions: { s1: "delete" } })
    });
    click(byText(container, t("review.discard")));
    assert.equal(events.discard, 1);

    click(query(container, ".dialog-scrim"));
    assert.equal(events.discard, 2, "and the scrim discards rather than applying");
});
