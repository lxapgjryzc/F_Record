/**
 * The panel's presentational primitives.
 *
 * Small pieces, but the ones every tab is built from, and several of them
 * carry a decision worth holding still. The icon buttons are pictures, so the
 * spoken name has to come from somewhere and it comes from `label` -- a
 * picture with no name is a guess, which is what replacing the old text
 * buttons risked. The dialog closes on the scrim but not on itself. And an
 * error toast never clears on its own, so it must always render something to
 * close it with.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { h } from "preact";

import { all, byText, choose, click, fire, installDom, mount, query, queryAll, textOf } from "./dom.mjs";

const dom = installDom();
const ui = await import("../../dist/modules/ui.mjs");

/* -------------------------------------------------------------- the icons */

test("the GitHub mark is inlined and follows the panel text colour", () => {
    // The panel is loaded from the filesystem; fetching a remote asset to draw
    // a button has no business in a CEP page. currentColor is what makes one
    // drawing work across all four Photoshop UI brightness levels.
    const svg = query(mount(dom, h(ui.GitHubIcon, {})), "svg");
    assert.equal(svg.getAttribute("fill"), "currentColor");
    assert.equal(svg.getAttribute("aria-hidden"), "true");
    assert.equal(svg.getAttribute("width"), "14", "a default size");
    assert.ok(query(svg, "path").getAttribute("d").length > 100, "a real path");

    assert.equal(query(mount(dom, h(ui.GitHubIcon, { size: 20 })), "svg").getAttribute("width"), "20");
});

test("every glyph name draws something, and none of them is spoken", () => {
    const names = [
        "film",
        "file",
        "folder",
        "trash",
        "enter",
        "archive",
        "unarchive",
        "paperclip",
        "refresh",
        "package"
    ];
    for (const name of names) {
        const svg = query(mount(dom, h(ui.Glyph, { name })), "svg");
        assert.equal(svg.getAttribute("stroke"), "currentColor", name);
        // Stroked rather than filled: a 16px line icon stays legible on every
        // brightness level.
        assert.equal(svg.getAttribute("fill"), "none", name);
        assert.equal(svg.getAttribute("aria-hidden"), "true", name + " is decorative");
        assert.ok(query(svg, "path").getAttribute("d").length > 10, name + " has a path");
    }

    assert.equal(query(mount(dom, h(ui.Glyph, { name: "film", size: 24 })), "svg").getAttribute("width"), "24");
});

test("an icon button says its name even though it only shows a picture", () => {
    const clicked = [];
    const button = query(
        mount(dom, h(ui.GlyphButton, { glyph: "trash", label: "Delete", onClick: () => clicked.push(1) })),
        "button"
    );

    assert.equal(button.getAttribute("aria-label"), "Delete");
    assert.equal(button.getAttribute("title"), "Delete", "and the tooltip says it too");
    assert.equal(button.getAttribute("aria-pressed"), null, "not a toggle");
    assert.ok(button.classList.contains("glyph-button"));

    click(button);
    assert.deepEqual(clicked, [1]);
});

test("an icon button can carry more in its tooltip, but never less", () => {
    // The open-document button appends the file's full path, as the text
    // version used to show.
    const button = query(
        mount(
            dom,
            h(ui.GlyphButton, {
                glyph: "file",
                label: "Open document",
                detail: "C:/art/dragon.psd",
                onClick: () => {}
            })
        ),
        "button"
    );
    assert.equal(button.getAttribute("title"), "Open document\nC:/art/dragon.psd");
    assert.equal(button.getAttribute("aria-label"), "Open document", "the spoken name stays short");
});

test("a toggle icon says whether it is on; a dangerous one says that too", () => {
    const off = query(
        mount(dom, h(ui.GlyphButton, { glyph: "paperclip", label: "Beside", active: false, onClick: () => {} })),
        "button"
    );
    assert.equal(off.getAttribute("aria-pressed"), "false");
    assert.ok(!off.classList.contains("active"));

    const on = query(
        mount(dom, h(ui.GlyphButton, { glyph: "paperclip", label: "Beside", active: true, onClick: () => {} })),
        "button"
    );
    assert.equal(on.getAttribute("aria-pressed"), "true");
    assert.ok(on.classList.contains("active"));

    const danger = query(
        mount(dom, h(ui.GlyphButton, { glyph: "trash", label: "Delete", danger: true, disabled: true, onClick: () => {} })),
        "button"
    );
    assert.ok(danger.classList.contains("danger"));
    assert.equal(danger.disabled, true);
});

test("Report an Issue is a button, because a CEP panel cannot navigate", () => {
    // An <a href> would either do nothing or replace the panel with the page;
    // the click has to go out through openURLInDefaultBrowser instead.
    const clicked = [];
    const container = mount(
        dom,
        h(ui.IssueButton, { label: "Report an Issue", title: "on GitHub", onClick: () => clicked.push(1) })
    );
    const button = query(container, "button");
    assert.equal(button.localName, "button");
    assert.equal(button.getAttribute("title"), "on GitHub");
    assert.ok(query(container, "svg"), "with the mark beside it");
    assert.equal(textOf(button).trim(), "Report an Issue");

    click(button);
    assert.deepEqual(clicked, [1]);
});

/* ------------------------------------------------------------- the layout */

test("a row puts its label and its value in their own slots", () => {
    const container = mount(dom, h(ui.Row, { label: "Frames", children: "12" }));
    assert.equal(textOf(query(container, ".row-label")), "Frames");
    assert.equal(textOf(query(container, ".row-value")), "12");
});

test("a hint is a paragraph, so it wraps rather than stretching a row", () => {
    const container = mount(dom, h(ui.Hint, { children: "Nothing has been drawn yet" }));
    assert.equal(query(container, "p.hint") !== null, true);
    assert.equal(textOf(container), "Nothing has been drawn yet");
});

/* -------------------------------------------------------------- the inputs */

test("a checkbox is labelled for a screen reader by the row it sits on", () => {
    const seen = [];
    const input = query(
        mount(dom, h(ui.Checkbox, { checked: true, ariaLabel: "Select dragon", onChange: (v) => seen.push(v) })),
        "input"
    );
    assert.equal(input.checked, true);
    assert.equal(input.getAttribute("aria-label"), "Select dragon");

    choose(input, false);
    assert.deepEqual(seen, [false]);

    const off = query(
        mount(dom, h(ui.Checkbox, { checked: false, ariaLabel: "x", disabled: true, onChange: () => {} })),
        "input"
    );
    assert.equal(off.disabled, true);
});

test("a switch reports its state to a screen reader and flips on click", () => {
    const seen = [];
    const on = query(
        mount(dom, h(ui.Switch, { checked: true, label: "Recording", onChange: (v) => seen.push(v) })),
        "button"
    );
    assert.equal(on.getAttribute("role"), "switch");
    assert.equal(on.getAttribute("aria-checked"), "true");
    assert.ok(on.classList.contains("on"));
    click(on);
    assert.deepEqual(seen, [false], "a switch that is on turns off");

    const off = query(
        mount(dom, h(ui.Switch, { checked: false, label: "Recording", disabled: true, onChange: (v) => seen.push(v) })),
        "button"
    );
    assert.equal(off.getAttribute("aria-checked"), "false");
    assert.ok(!off.classList.contains("on"));
    assert.equal(off.disabled, true);
});

test("a select renders its options and hands back the value, not the label", () => {
    const seen = [];
    const container = mount(
        dom,
        h(ui.Select, {
            value: "1080",
            ariaLabel: "Resolution",
            options: [
                { value: "720", label: "720p" },
                { value: "1080", label: "1080p" }
            ],
            onChange: (v) => seen.push(v)
        })
    );
    const select = query(container, "select");
    assert.equal(select.value, "1080");
    assert.equal(select.getAttribute("aria-label"), "Resolution");
    assert.ok(select.classList.contains("control-narrow"), "narrow by default");
    assert.deepEqual(queryAll(container, "option").map((o) => textOf(o)), ["720p", "1080p"]);

    choose(select, "720");
    assert.deepEqual(seen, ["720"]);

    const wide = query(
        mount(dom, h(ui.Select, { value: "a", options: [], ariaLabel: "x", narrow: false, onChange: () => {} })),
        "select"
    );
    assert.ok(!wide.classList.contains("control-narrow"));
    assert.equal(
        query(mount(dom, h(ui.Select, { value: "a", options: [], ariaLabel: "x", disabled: true, onChange: () => {} })), "select").disabled,
        true
    );
});

/* -------------------------------------------------------- banners and bars */

test("a banner carries its tone, and shows only the parts it was given", () => {
    const plain = mount(dom, h(ui.Banner, { tone: "warn", title: "Not connected" }));
    assert.ok(query(plain, ".banner").classList.contains("warn"));
    assert.equal(textOf(query(plain, ".banner-title")), "Not connected");
    assert.equal(query(plain, ".banner-body"), null);
    assert.equal(query(plain, ".banner-actions"), null);

    const full = mount(
        dom,
        h(ui.Banner, {
            tone: "error",
            title: "Export failed",
            body: "ffmpeg exited with code 1",
            actions: h("button", { type: "button" }, "Retry")
        })
    );
    assert.equal(textOf(query(full, ".banner-body")), "ffmpeg exited with code 1");
    assert.equal(textOf(query(full, ".banner-actions")), "Retry");
});

test("a progress bar clamps whatever it is given to something drawable", () => {
    // The percentage comes from ffmpeg's own timestamps divided by a length we
    // predicted; both can be a little out, and a bar 140% wide would spill.
    const at = (percent) => {
        const container = mount(dom, h(ui.ProgressBar, { label: "Encoding", percent }));
        return {
            text: textOf(container),
            width: query(container, ".progress-fill").style.width
        };
    };

    assert.equal(at(42).text, "Encoding42%");
    assert.equal(at(42).width, "42%");
    assert.equal(at(-5).width, "0%");
    assert.equal(at(140).width, "100%");
});

/* -------------------------------------------------------------- the dialog */

test("a dialog closes on the scrim but not on itself", () => {
    const dismissed = [];
    const container = mount(
        dom,
        h(ui.Dialog, {
            title: "Export",
            children: h("p", {}, "How long?"),
            actions: h("button", { type: "button" }, "Go"),
            onDismiss: () => dismissed.push(1)
        })
    );

    const dialog = query(container, ".dialog");
    assert.equal(dialog.getAttribute("role"), "dialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.equal(textOf(query(container, ".dialog-title")), "Export");

    // Clicking inside must not close it -- the click bubbles to the scrim, so
    // the check is on which element the event started at.
    click(query(container, ".dialog-title"));
    assert.deepEqual(dismissed, [], "a click inside is not a dismissal");

    click(query(container, ".dialog-scrim"));
    assert.deepEqual(dismissed, [1]);
});

/* -------------------------------------------------------------- the toasts */

test("no toasts is no element at all, rather than an empty strip", () => {
    const container = mount(dom, h(ui.Toasts, { toasts: [], onDismiss: () => {}, dismissLabel: "Dismiss" }));
    assert.equal(query(container, ".toasts"), null);
});

test("a toast with an action runs it and then clears itself", () => {
    const acted = [];
    const dismissed = [];
    const container = mount(
        dom,
        h(ui.Toasts, {
            toasts: [{ id: 7, tone: "positive", text: "Exported", actionLabel: "Show", onAction: () => acted.push(1) }],
            onDismiss: (id) => dismissed.push(id),
            dismissLabel: "Dismiss"
        })
    );

    assert.ok(query(container, ".toast").classList.contains("positive"));
    assert.equal(textOf(query(container, ".toast-text")), "Exported");

    click(byText(container, "Show"));
    assert.deepEqual(acted, [1]);
    assert.deepEqual(dismissed, [7], "and it goes once its action has run");
});

test("a toast with an action but nothing to do still clears itself", () => {
    const dismissed = [];
    const container = mount(
        dom,
        h(ui.Toasts, {
            toasts: [{ id: 8, tone: "info", text: "Packed", actionLabel: "Show" }],
            onDismiss: (id) => dismissed.push(id),
            dismissLabel: "Dismiss"
        })
    );
    click(byText(container, "Show"));
    assert.deepEqual(dismissed, [8]);
});

test("a toast with no action gets a close button, since errors never fade", () => {
    // pushToast leaves errors on screen indefinitely, so without this there
    // would be no way to get rid of one.
    const dismissed = [];
    const container = mount(
        dom,
        h(ui.Toasts, {
            toasts: [
                { id: 1, tone: "negative", text: "Export failed" },
                { id: 2, tone: "info", text: "Moved" }
            ],
            onDismiss: (id) => dismissed.push(id),
            dismissLabel: "Dismiss"
        })
    );

    const closers = queryAll(container, "button.toast-close");
    assert.equal(closers.length, 2);
    assert.equal(closers[0].getAttribute("aria-label"), "Dismiss");
    click(closers[0]);
    assert.deepEqual(dismissed, [1]);
});
