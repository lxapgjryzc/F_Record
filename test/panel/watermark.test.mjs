/**
 * The watermark controls, in both of the places they appear.
 *
 * Two things here are worth a test each. One is `scope`: the export dialog
 * offers what to stamp and the Settings tab offers that plus how it is laid
 * out, from the same component, so neither can drift from the other. The other
 * is the text box, which is the only field in the panel that keeps its own
 * copy of what is being typed -- because in Settings every keystroke makes a
 * round trip through the generator, and a reply that arrives late must not be
 * allowed to put older text back.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { h } from "preact";

import { choose, click, fire, installDom, query, queryAll, rerender, textOf, typeInto } from "./dom.mjs";
import { stubPanel } from "./panel-harness.mjs";

const dom = installDom();
const panel = stubPanel(mock);
const { WatermarkFields } = await import("../../dist/modules/watermark.mjs");
const { createTranslate } = await import("../../dist/modules/i18n.mjs");
const { DEFAULT_WATERMARK } = await import("../../dist/modules/protocol.mjs");

const t = createTranslate("en");

/**
 * Mounts the fields over a mark and plays the part of the parent that owns it.
 *
 * By default a patch is adopted and re-rendered, which is what both real
 * callers do. `deaf` holds the mark still instead, for the tests about a
 * config that comes back from elsewhere.
 */
function fields(overrides = {}, options = {}) {
    const patches = [];
    let mark = { ...DEFAULT_WATERMARK, ...overrides };
    const container = dom.document.createElement("div");
    dom.body.appendChild(container);
    const render = () => {
        rerender(
            container,
            h(WatermarkFields, {
                t,
                value: mark,
                scope: options.scope || "all",
                disabled: options.disabled,
                onChange: (patch) => {
                    patches.push(patch);
                    if (options.deaf !== true) {
                        mark = { ...mark, ...patch };
                        render();
                    }
                }
            })
        );
        dom.runEffects();
    };
    render();
    return {
        container,
        patches,
        at: () => mark,
        /** Hands down a whole new mark, as a config reload would. */
        handDown(next) {
            mark = { ...mark, ...next };
            render();
        }
    };
}

const selectFor = (container, key) => query(container, 'select[aria-label="' + t(key) + '"]');
const inputFor = (container, key) => query(container, 'input[aria-label="' + t(key) + '"]');
const textBox = (container) => inputFor(container, "watermark.text.label");
const optionsOf = (select) => queryAll(select, "option").map((option) => option.value);
const labelsOf = (container) => queryAll(container, "select").map((select) => select.getAttribute("aria-label"));

/* ------------------------------------------------------------------ scope */

test("switched off, there is nothing to lay out and nothing is offered", () => {
    const { container } = fields();
    assert.equal(selectFor(container, "watermark").value, "off");
    assert.deepEqual(labelsOf(container), [t("watermark")], "only the on/off choice");
    assert.equal(textBox(container), null);
});

test("the export dialog offers what to stamp, and the Settings tab also how", () => {
    const inDialog = fields({ kind: "text" }, { scope: "content" });
    assert.deepEqual(labelsOf(inDialog.container), [t("watermark")], "nothing about layout");
    assert.ok(textBox(inDialog.container), "but the text is still typed here");

    const inSettings = fields({ kind: "text" });
    assert.deepEqual(labelsOf(inSettings.container), [
        t("watermark"),
        t("watermark.style"),
        t("watermark.position"),
        t("watermark.size"),
        t("watermark.opacity")
    ]);
});

test("switching it on and off again is one choice, handed up as itself", () => {
    const { container, patches, at } = fields();
    choose(selectFor(container, "watermark"), "image");
    assert.equal(at().kind, "image");
    assert.ok(inputFor(container, "watermark.image.label"), "and the image row appears");

    choose(selectFor(container, "watermark"), "off");
    assert.deepEqual(patches, [{ kind: "image" }, { kind: "off" }]);
});

test("an embossed mark fills the frame, so there is no corner to pick", () => {
    const { container, at } = fields({ kind: "text", style: "corner" });
    assert.ok(selectFor(container, "watermark.position"), "a corner mark has one");

    choose(selectFor(container, "watermark.style"), "emboss");
    assert.equal(at().style, "emboss");
    assert.equal(selectFor(container, "watermark.position"), null);
});

test("the two styles offer the sizes that suit them", () => {
    // A corner badge is one mark and wants to be readable; an embossed one is
    // repeated across the frame and wants to be small. One list would be wrong
    // at both ends.
    const corner = fields({ kind: "text", style: "corner" });
    assert.deepEqual(optionsOf(selectFor(corner.container, "watermark.size")), ["4", "6", "8", "12", "20"]);

    const emboss = fields({ kind: "text", style: "emboss" });
    assert.deepEqual(optionsOf(selectFor(emboss.container, "watermark.size")), ["2", "3", "4", "6", "8"]);
});

test("a hand-edited config keeps its own value, in its place among the presets", () => {
    const { container } = fields({ kind: "text", sizePercent: 5, opacityPercent: 42 });
    assert.deepEqual(optionsOf(selectFor(container, "watermark.size")), ["4", "5", "6", "8", "12", "20"]);
    assert.equal(selectFor(container, "watermark.size").value, "5", "and it is the one selected");
    assert.deepEqual(optionsOf(selectFor(container, "watermark.opacity")), ["30", "42", "50", "70", "100"]);
});

test("sizes and opacities are handed up as numbers, not as the strings they were", () => {
    const { container, patches } = fields({ kind: "text" });
    choose(selectFor(container, "watermark.size"), "12");
    choose(selectFor(container, "watermark.opacity"), "50");
    choose(selectFor(container, "watermark.position"), "center");
    assert.deepEqual(patches, [{ sizePercent: 12 }, { opacityPercent: 50 }, { position: "center" }]);
});

test("every choice offered is one the protocol knows, and each of them has words", () => {
    const { container } = fields({ kind: "text" });
    assert.deepEqual(optionsOf(selectFor(container, "watermark.style")), ["corner", "emboss"]);
    assert.deepEqual(optionsOf(selectFor(container, "watermark.position")), [
        "topLeft",
        "topRight",
        "bottomLeft",
        "bottomRight",
        "center"
    ]);
    assert.equal(
        textOf(selectFor(container, "watermark.position")),
        ["topLeft", "topRight", "bottomLeft", "bottomRight", "center"]
            .map((where) => t("watermark.position." + where))
            .join("")
    );
});

test("while it is disabled, nothing on it can be reached", () => {
    const { container } = fields({ kind: "image" }, { disabled: true });
    for (const select of queryAll(container, "select")) {
        assert.equal(select.disabled, true, select.getAttribute("aria-label"));
    }
    assert.equal(query(container, "button.icon").disabled, true);
});

/* ------------------------------------------------------------------ image */

test("choosing an image is offered by name, and backing out changes nothing", () => {
    const { container, patches } = fields({ kind: "image" });
    assert.equal(inputFor(container, "watermark.image.label").value, "");
    assert.equal(
        inputFor(container, "watermark.image.label").getAttribute("placeholder"),
        t("watermark.image.none"),
        "an empty box says so rather than sitting there blank"
    );

    panel.host.chooseImageFile = () => null;
    click(query(container, "button.icon"));
    assert.deepEqual(patches, [], "a cancelled chooser leaves the old image alone");

    panel.host.chooseImageFile = () => "C:/art/sign.png";
    click(query(container, "button.icon"));
    assert.deepEqual(patches, [{ imagePath: "C:/art/sign.png" }]);
    assert.equal(inputFor(container, "watermark.image.label").value, "C:/art/sign.png");
});

test("the chooser starts where the current image is", () => {
    const { container } = fields({ kind: "image", imagePath: "C:/art/sign.png" });
    panel.host.chooseImageFile = () => null;
    click(query(container, "button.icon"));
    const call = panel.host.calls.filter((each) => each.name === "chooseImageFile").pop();
    assert.deepEqual(call.args, [t("watermark.image.choose"), "C:/art/sign.png"]);
});

/* ------------------------------------------------------------------- text */

test("typing is passed on a letter at a time, and never re-sent unchanged", () => {
    const { container, patches } = fields({ kind: "text" });
    const box = textBox(container);
    fire(box, "focus", {});
    typeInto(box, "Ann");
    typeInto(box, "Anna");
    typeInto(box, "Anna");
    assert.deepEqual(patches, [{ text: "Ann" }, { text: "Anna" }]);
});

test("a reply that arrives late cannot put older text back while it is being typed", () => {
    // This is the 4.7.0 bug. Settings sends every keystroke to the generator
    // and is handed a whole config back; if two are in flight the older reply
    // can land last, and adopting it would lose letters and throw the caret to
    // the end. So while the field has the caret, what it shows is what was
    // typed.
    const { container, handDown } = fields({ kind: "text" }, { deaf: true });
    fire(textBox(container), "focus", {});
    typeInto(textBox(container), "Anna");

    handDown({ text: "Ann" }); // the stale reply, landing after "Anna" was typed
    assert.equal(textBox(container).value, "Anna", "what was typed stays");

    fire(textBox(container), "blur", {});
    handDown({ text: "Annabel" }); // and now something genuinely from elsewhere
    assert.equal(textBox(container).value, "Annabel", "outside changes land once the field is left");
});

test("leaving the field sends what is in it, even mid-composition", () => {
    const { container, patches } = fields({ kind: "text" }, { deaf: true });
    const box = textBox(container);
    fire(box, "focus", {});
    fire(box, "compositionstart", {});
    typeInto(box, "zhong");
    assert.deepEqual(patches, [], "a half-typed candidate is nobody else's business");

    fire(box, "blur", {});
    assert.deepEqual(patches, [{ text: "zhong" }], "clicking away commits what is actually there");
});

test("an IME candidate is not sent until it is committed", () => {
    const { container, patches } = fields({ kind: "text" });
    const box = textBox(container);
    fire(box, "focus", {});
    fire(box, "compositionstart", {});
    for (const stage of ["z", "zh", "zho", "zhong"]) {
        typeInto(box, stage);
    }
    assert.deepEqual(patches, [], "storing half a syllable would shut the candidate window");

    box.value = "中";
    fire(box, "compositionend", {});
    assert.deepEqual(patches, [{ text: "中" }]);
});

test("a composition committed after the size changed patches on top of it", () => {
    // The listeners are attached once but reach the current render's callback,
    // so a commit that lands after another field moved does not undo it.
    const { container, patches, at } = fields({ kind: "text" });
    fire(textBox(container), "focus", {});
    fire(textBox(container), "compositionstart", {});

    choose(selectFor(container, "watermark.size"), "20");
    assert.equal(at().sizePercent, 20);

    textBox(container).value = "中";
    fire(textBox(container), "compositionend", {});
    assert.deepEqual(patches, [{ sizePercent: 20 }, { text: "中" }]);
    assert.equal(at().sizePercent, 20, "and the size is still where it was put");
});

test("the listeners go when the field does", () => {
    const { container, handDown } = fields({ kind: "text" });
    const box = textBox(container);
    assert.equal(box.eventListeners.compositionend.length, 1);

    handDown({ kind: "off" });
    assert.equal(box.eventListeners.compositionend.length, 0, "and are not left on a detached input");
});
