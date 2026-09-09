/**
 * The Settings tab, which owns nothing.
 *
 * Every control here hands a patch upwards and waits to be told the new config
 * -- there is no local copy to drift, and nothing is stored panel-side. What is
 * worth testing is the shape of what it offers: the presets, plus a
 * hand-edited config's own value in its place rather than snapped to the
 * nearest, and the rows that stop meaning anything being hidden rather than
 * greyed.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { h } from "preact";

import { byText, choose, click, installDom, mount, query, queryAll, textOf } from "./dom.mjs";
import { panelState, stubPanel } from "./panel-harness.mjs";

const dom = installDom();
const panel = stubPanel(mock);
const { Settings } = await import("../../dist/modules/settingsView.mjs");
const { createTranslate } = await import("../../dist/modules/i18n.mjs");
const { LANGUAGES } = await import("../../dist/modules/protocol.mjs");
const { LOCALE_NAMES } = await import("../../dist/modules/locales.mjs");
const { describeNodeCompat } = await import("../../dist/modules/compat.mjs");

const t = createTranslate("en");

/** Mounts the tab over a config and collects the patches it asks for. */
function settings(overrides = {}, props = {}) {
    const patches = [];
    const config = overrides === null ? null : { ...panelState().config, ...overrides };
    const container = mount(
        dom,
        h(Settings, {
            t,
            config,
            disabled: false,
            updateBusy: false,
            generatorNode: "Node 22.18 (no fallbacks)",
            onPatch: (patch) => patches.push(patch),
            onCheckUpdates: () => patches.push("check"),
            ...props
        })
    );
    return { container, patches };
}

const selectFor = (container, key) => query(container, 'select[aria-label="' + t(key) + '"]');
const optionsOf = (select) => queryAll(select, "option").map((option) => option.value);
const labelsOf = (select) => queryAll(select, "option").map(textOf);
/** The switch a label belongs to -- the label is a span inside the button. */
function switchFor(container, key) {
    let node = byText(container, t(key));
    while (node && node.localName !== "button") {
        node = node.parentNode;
    }
    return node;
}

/* --------------------------------------------------------------- the whole */

test("before a config arrives there is nothing to set, and it says so", () => {
    const { container } = settings(null);
    assert.equal(textOf(query(container, ".empty")), t("status.connecting"));
});

test("while the generator is busy, nothing on the tab can be moved", () => {
    const { container } = settings({ watermark: { kind: "text", text: "Anna" } }, { disabled: true });
    for (const control of queryAll(container, "select").concat(queryAll(container, "button"))) {
        assert.equal(control.disabled, true, control.getAttribute("aria-label") || textOf(control));
    }
});

/* -------------------------------------------------------------- the folder */

test("the frames folder is shown in full and only changed through the chooser", () => {
    const { container, patches } = settings({ processImageFolderPath: "C:/frames" });
    const field = query(container, 'input[aria-label="' + t("settings.folder") + '"]');
    assert.equal(field.value, "C:/frames");
    assert.equal(field.getAttribute("readOnly"), "true", "typing a path that does not exist helps nobody");
    assert.equal(field.getAttribute("title"), "C:/frames", "and the full path is there on hover");

    panel.host.chooseFolder = () => null;
    click(byText(container, t("settings.folder.choose")));
    assert.deepEqual(patches, [], "backing out of the chooser leaves it where it was");

    panel.host.chooseFolder = () => "D:/frames";
    click(byText(container, t("settings.folder.choose")));
    assert.deepEqual(patches, [{ processImageFolderPath: "D:/frames" }]);

    const call = panel.host.calls.filter((each) => each.name === "chooseFolder").pop();
    assert.deepEqual(call.args, [t("settings.folder.choose"), "C:/frames"], "and it starts where it is now");
});

/* ------------------------------------------------------------- the capture */

test("the capture settings offer their presets and hand back numbers", () => {
    const { container, patches } = settings({});
    assert.deepEqual(optionsOf(selectFor(container, "settings.resolution")), [
        "360",
        "720",
        "1080",
        "1440",
        "2160"
    ]);

    choose(selectFor(container, "settings.resolution"), "720");
    choose(selectFor(container, "settings.interval"), "3000");
    choose(selectFor(container, "settings.idle"), "10");
    choose(selectFor(container, "settings.quality"), "90");
    assert.deepEqual(patches, [
        { resolution: "720" },
        { minIntervalMs: 3000 },
        { idleTimeoutMinutes: 10 },
        { quality: 90 }
    ]);
});

test("quality is three words, and any stored number lands on the nearest", () => {
    // The config holds a JPEG quality; the tab offers low, medium and high.
    // A number from somewhere else has to show as one of them or the box
    // renders empty.
    assert.deepEqual(labelsOf(selectFor(settings({}).container, "settings.quality")), [
        t("settings.quality.low"),
        t("settings.quality.medium"),
        t("settings.quality.high")
    ]);
    for (const [stored, shown] of [[1, "40"], [40, "40"], [55, "40"], [56, "70"], [80, "70"], [81, "90"], [100, "90"]]) {
        assert.equal(selectFor(settings({ quality: stored }).container, "settings.quality").value, shown, stored);
    }
});

test("switching the idle timeout off is one of the choices, not a missing one", () => {
    const { container } = settings({ idleTimeoutMinutes: 0 });
    assert.equal(selectFor(container, "settings.idle").value, "0");
    assert.equal(labelsOf(selectFor(container, "settings.idle")).pop(), t("settings.idle.off"));
});

/* ---------------------------------------------------------------- the mark */

test("what the watermark rows change is the stored mark, patched not replaced", () => {
    const { container, patches } = settings({
        watermark: { kind: "text", text: "Anna", sizePercent: 8, opacityPercent: 70 }
    });
    choose(selectFor(container, "watermark.opacity"), "30");
    assert.equal(patches[0].watermark.text, "Anna", "the rest of the mark comes along");
    assert.equal(patches[0].watermark.opacityPercent, 30);
});

test("a generator too old to know about watermarks still gets the rows drawn", () => {
    // It sends a config with no watermark at all; normalising rather than
    // trusting is what keeps the panel's own settings on screen.
    const { container } = settings({ watermark: undefined });
    assert.equal(selectFor(container, "watermark").value, "off");
});

test("the clipboard choice appears only once there is a mark to add", () => {
    const off = settings({ watermark: { kind: "off" } });
    assert.equal(switchFor(off.container, "settings.clipboardWatermark"), null);
    assert.equal(textOf(off.container).indexOf(t("settings.clipboardWatermark.hint")), -1);

    const on = settings({ watermark: { kind: "text", text: "Anna" } });
    assert.ok(switchFor(on.container, "settings.clipboardWatermark"), "hidden rather than greyed");
});

test("the copy button is signed unless someone says otherwise", () => {
    // It is one click with nothing to ask in, so the choice is made here once.
    const on = settings({ watermark: { kind: "text", text: "Anna" } });
    const toggle = switchFor(on.container, "settings.clipboardWatermark");
    assert.equal(toggle.getAttribute("aria-checked"), "true", "on by default");
    click(toggle);
    assert.deepEqual(on.patches, [{ clipboardWatermark: false }]);

    const declined = settings({
        watermark: { kind: "text", text: "Anna" },
        clipboardWatermark: false
    });
    const back = switchFor(declined.container, "settings.clipboardWatermark");
    assert.equal(back.getAttribute("aria-checked"), "false");
    click(back);
    assert.deepEqual(declined.patches, [{ clipboardWatermark: true }]);
});

/* ------------------------------------------------------------- starting up */

test("both automatic starts are switches, and each says what it does", () => {
    const { container, patches } = settings({ autoStart: false, autoStartNewDocuments: true });
    click(switchFor(container, "settings.autoStart"));
    click(switchFor(container, "settings.autoNew"));
    assert.deepEqual(patches, [{ autoStart: true }, { autoStartNewDocuments: false }]);
    assert.ok(textOf(container).indexOf(t("settings.autoStart.hint")) !== -1);
    assert.ok(textOf(container).indexOf(t("settings.autoNew.hint")) !== -1);
});

/* ------------------------------------------------------------ the stale rule */

test("the staleness thresholds offer presets, and either can be switched off", () => {
    const { container, patches } = settings({ staleMaxFrames: 20, staleAfterDays: 30 });
    assert.deepEqual(optionsOf(selectFor(container, "settings.staleFrames")), ["0", "10", "20", "50", "100", "300"]);
    assert.deepEqual(optionsOf(selectFor(container, "settings.staleDays")), [
        "0",
        "7",
        "14",
        "30",
        "60",
        "90",
        "180",
        "365"
    ]);
    assert.equal(labelsOf(selectFor(container, "settings.staleFrames"))[0], t("settings.stale.off"));
    assert.equal(labelsOf(selectFor(container, "settings.staleDays"))[0], t("settings.stale.off"));
    assert.equal(labelsOf(selectFor(container, "settings.staleFrames"))[1], "10 " + t("unit.frames"));
    assert.equal(labelsOf(selectFor(container, "settings.staleDays"))[1], "7 " + t("unit.days"));

    choose(selectFor(container, "settings.staleFrames"), "50");
    choose(selectFor(container, "settings.staleDays"), "0");
    assert.deepEqual(patches, [{ staleMaxFrames: 50 }, { staleAfterDays: 0 }]);
});

test("a hand-edited threshold is offered as it is, in its place among the presets", () => {
    // Snapping it to the nearest would quietly change a rule someone meant.
    const { container } = settings({ staleMaxFrames: 25, staleAfterDays: 45 });
    assert.deepEqual(optionsOf(selectFor(container, "settings.staleFrames")), [
        "0",
        "10",
        "20",
        "25",
        "50",
        "100",
        "300"
    ]);
    assert.equal(selectFor(container, "settings.staleFrames").value, "25");
    assert.equal(optionsOf(selectFor(container, "settings.staleDays")).indexOf("45"), 4);
});

/* -------------------------------------------------------------- the language */

test("every language is listed in itself, so a wrong turn can be undone", () => {
    const { container, patches } = settings({ language: "en" });
    const select = selectFor(container, "settings.language");
    assert.deepEqual(optionsOf(select), LANGUAGES);
    assert.deepEqual(labelsOf(select), [t("settings.language.auto")].concat(
        LANGUAGES.slice(1).map((code) => LOCALE_NAMES[code])
    ));

    choose(select, "ja");
    assert.deepEqual(patches, [{ language: "ja" }]);
});

/* --------------------------------------------------------------- the update */

test("checking for updates is only offered to someone who wants updates", () => {
    const off = settings({ checkForUpdates: false });
    assert.equal(byText(off.container, t("update.checkNow")), null);
    click(switchFor(off.container, "update.setting"));
    assert.deepEqual(off.patches, [{ checkForUpdates: true }]);

    const on = settings({ checkForUpdates: true });
    click(byText(on.container, t("update.checkNow")));
    assert.deepEqual(on.patches, ["check"]);
});

test("a check in flight says so instead of inviting a second one", () => {
    const { container } = settings({ checkForUpdates: true }, { updateBusy: true });
    const button = query(container, "button.secondary");
    assert.equal(textOf(button), t("update.checking"));
    assert.equal(button.disabled, true);
});

/* -------------------------------------------------------------- the runtimes */

test("both Nodes are named, because they are different builds", () => {
    // An export bug that only happens on old Photoshop is almost always one of
    // these fallbacks, and this is the line to quote.
    const { container } = settings({}, { generatorNode: "Node 18.16 (mkdir)" });
    const hints = queryAll(container, ".hint").map(textOf);
    assert.ok(hints.indexOf("Panel · " + describeNodeCompat()) !== -1);
    assert.ok(hints.indexOf("Generator · Node 18.16 (mkdir)") !== -1);
});

test("with no generator to ask, its line is a dash rather than a guess", () => {
    const { container } = settings({}, { generatorNode: null });
    assert.ok(queryAll(container, ".hint").map(textOf).indexOf("Generator · —") !== -1);
});
