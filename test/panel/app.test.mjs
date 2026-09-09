/**
 * The panel as a whole: what it does on the way up, and the frame around the
 * tabs.
 *
 * App.tsx owns every piece of state the panel has, so most of what is worth
 * saying about it is about wiring -- a health tick that must not clear the
 * document, a frame count that must land on the right recording, a language
 * that follows the config without a reload. The tabs themselves are tested
 * where they live.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { byText, click, query, queryAll, textOf } from "./dom.mjs";
import { panelState, sessionRow } from "./panel-harness.mjs";
import { bootPanel } from "./app-harness.mjs";

const { dom, panel, openPanel, t } = await bootPanel(mock);

const tabButton = (container, key) => byText(query(container, ".tabs"), t(key));
const footer = (container) => textOf(query(container, ".footer span"));
const toasts = (container) => queryAll(container, ".toast").map((toast) => textOf(query(toast, ".toast-text")));

/* ------------------------------------------------------------- standing up */

test("the panel makes itself persistent, dresses for the host, and connects", async () => {
    // Persistent because a CEP panel is otherwise torn down when it is hidden,
    // which would drop the bridge and lose the recording state every time
    // someone switched to another panel.
    const container = await openPanel();
    const names = panel.host.calls.map((call) => call.name);
    assert.ok(names.indexOf("makePanelPersistent") !== -1);
    assert.equal(panel.bridge.started, 1);
    assert.ok(query(container, ".app"), "and the panel is on screen");
});

test("the panel follows the host's theme, then and later", async () => {
    let announce = null;
    await openPanel(panelState(), {
        host: {
            readHostTheme: () => ({ dark: true, background: "rgb(50,50,50)" }),
            onThemeChanged: (callback) => {
                announce = callback;
            }
        }
    });
    assert.equal(dom.document.documentElement.classList.contains("light"), false);

    panel.host.readHostTheme = () => ({ dark: false, background: "rgb(240,240,240)" });
    announce();
    assert.equal(dom.document.documentElement.classList.contains("light"), true, "Photoshop went light");

    panel.host.readHostTheme = () => ({ dark: true, background: "rgb(50,50,50)" });
    announce();
    assert.equal(dom.document.documentElement.classList.contains("light"), false);
});

test("focus rings appear for the keyboard and go for the mouse", async () => {
    // Chromium 61 has no :focus-visible, so the distinction is made here.
    await openPanel();
    assert.equal(dom.body.classList.contains("kbd"), false);

    dom.fireWindow("keydown", { key: "a" });
    assert.equal(dom.body.classList.contains("kbd"), false, "typing is not navigating");

    dom.fireWindow("keydown", { key: "Tab" });
    assert.equal(dom.body.classList.contains("kbd"), true);

    dom.fireWindow("mousedown", {});
    assert.equal(dom.body.classList.contains("kbd"), false);
});

test("a panel taken down lets go of everything it was holding", async () => {
    await openPanel();
    const before = panel.bridge.stopped;
    assert.equal(dom.windowListenerCount("keydown"), 1);

    await openPanel();
    assert.equal(panel.bridge.stopped, before + 1, "the bridge is closed");
    assert.equal(dom.windowListenerCount("keydown"), 1, "and no listener is left behind");
});

test("Photoshop's UI language is read once, not on every render", async () => {
    await openPanel();
    const reads = panel.host.calls.filter((call) => call.name === "hostUiLocale").length;
    assert.equal(reads, 1);

    panel.bridge.pushState(panelState({ config: { ...panelState().config, language: "auto" } }));
    await dom.flush();
    assert.equal(panel.host.calls.filter((call) => call.name === "hostUiLocale").length, 1);
});

test("the panel speaks whatever the config says, and changes when it changes", async () => {
    const container = await openPanel(panelState({ config: { ...panelState().config, language: "en" } }));
    assert.ok(tabButton(container, "tab.dashboard"), "English while the config says English");

    panel.bridge.pushState(panelState({ config: { ...panelState().config, language: "ja" } }));
    await dom.flush();
    assert.equal(tabButton(container, "tab.dashboard"), null);
    assert.ok(query(container, ".tabs"), "but the tabs are still there, in Japanese");
});

/* ------------------------------------------------------------ what arrives */

test("a health tick moves the numbers and leaves everything else alone", async () => {
    const container = await openPanel();
    panel.bridge.pushHealth({ ...panelState().health, lastCaptureMs: 999, encoder: "sharp" });
    await dom.flush();

    assert.ok(textOf(container).indexOf("dragon") !== -1, "the document is still there");
    assert.equal(textOf(container).indexOf(t("stat.encoder.js")), -1, "and the new encoder is");
});

test("a health tick before there is any state is not a state", async () => {
    const container = await openPanel(null);
    panel.bridge.pushHealth({ ...panelState().health });
    await dom.flush();
    assert.ok(query(container, ".empty") || query(container, ".banner"), "still nothing to show");
});

test("a frame lands on the recording it belongs to, and nowhere else", async () => {
    const container = await openPanel();
    panel.bridge.pushFrame("s1", 77, Date.now());
    await dom.flush();
    assert.ok(textOf(container).indexOf("77") !== -1);

    panel.bridge.pushFrame("somebody-else", 500, Date.now());
    await dom.flush();
    assert.equal(textOf(container).indexOf("500"), -1, "a stray frame is not this recording's");

    panel.bridge.pushState(panelState({ session: null }));
    await dom.flush();
    panel.bridge.pushFrame("s1", 900, Date.now());
    await dom.flush();
    assert.equal(textOf(container).indexOf("900"), -1, "and with no recording there is nowhere to put it");
});

test("losing the generator clears the state rather than showing a stale one", async () => {
    const container = await openPanel();
    assert.ok(textOf(container).indexOf("dragon") !== -1);

    panel.bridge.setStatus("offline", "ECONNREFUSED");
    await dom.flush();
    assert.equal(textOf(container).indexOf("dragon"), -1);
    assert.ok(textOf(container).indexOf(t("status.unavailable")) !== -1);
});

/* ---------------------------------------------------------------- toasts */

test("an error from the generator is a toast that stays until it is dismissed", async () => {
    const container = await openPanel();
    panel.bridge.pushLog("error", "Could not write frame 12", Date.now());
    await dom.flush();
    assert.deepEqual(toasts(container), ["Could not write frame 12"]);

    click(query(container, ".toast button"));
    await dom.flush();
    assert.deepEqual(toasts(container), []);
});

test("the log is not a feed: only errors are worth interrupting for", async () => {
    const container = await openPanel();
    panel.bridge.pushLog("info", "Captured a frame", Date.now());
    panel.bridge.pushLog("warn", "That took a while", Date.now());
    await dom.flush();
    assert.deepEqual(toasts(container), []);
});

test("a toast that is not an error clears itself", async (context) => {
    const container = await openPanel(
        panelState({ config: { ...panelState().config, checkForUpdates: true } })
    );
    click(tabButton(container, "tab.settings"));
    await dom.flush();

    // Only now, because flushing effects waits on a real timer.
    mock.timers.enable({ apis: ["setTimeout"] });
    context.after(() => mock.timers.reset());

    panel.bridge.reply = () => ({ ok: true, updateCheck: { outcome: "current" } });
    click(byText(container, t("update.checkNow")));
    for (let settle = 0; settle < 4; settle++) {
        await Promise.resolve();
    }
    dom.runEffects();
    assert.deepEqual(toasts(container), [t("update.upToDate")]);

    mock.timers.tick(6000);
    dom.runEffects();
    assert.deepEqual(toasts(container), [], "and takes only itself with it");
});

/* ------------------------------------------------------------------ tabs */

test("all four tabs are there and each one shows its own thing", async () => {
    const container = await openPanel();
    assert.deepEqual(
        queryAll(container, ".tabs button").map(textOf),
        [t("tab.dashboard"), t("tab.sessions"), t("tab.archive"), t("tab.settings")]
    );
    assert.equal(query(container, ".tab.active"), tabButton(container, t("tab.dashboard")));

    click(tabButton(container, "tab.settings"));
    await dom.flush();
    assert.ok(query(container, 'select[aria-label="' + t("settings.resolution") + '"]'));
    assert.equal(textOf(query(container, ".tab.active")), t("tab.settings"));

    click(tabButton(container, "tab.dashboard"));
    await dom.flush();
    assert.ok(query(container, 'button[role="switch"]'), "and back to the recording switch");
});

test("opening a listing tab asks for the listing, and the archive gets its own half", async () => {
    const container = await openPanel(panelState(), {
        sessions: [sessionRow({ sessionId: "a", docName: "open" }), sessionRow({ sessionId: "b", docName: "filed", archived: true })]
    });
    assert.equal(panel.bridge.sent("listSessions").length, 0, "not until a tab asks");

    click(tabButton(container, "tab.sessions"));
    await dom.flush();
    assert.equal(panel.bridge.sent("listSessions").length, 1);
    assert.deepEqual(queryAll(container, ".session-name").map(textOf), ["open"]);

    click(tabButton(container, "tab.archive"));
    await dom.flush();
    assert.deepEqual(queryAll(container, ".session-name").map(textOf), ["filed"]);
});

test("a listing that cannot be fetched says so instead of showing nothing", async () => {
    const container = await openPanel();
    panel.bridge.reply = () => ({ ok: false, error: "The frames folder is not readable" });
    click(tabButton(container, "tab.sessions"));
    await dom.flush();
    assert.deepEqual(toasts(container), ["The frames folder is not readable"]);
});

/* ---------------------------------------------------------------- footer */

test("the footer says where the panel stands and which plugin it is talking to", async () => {
    const container = await openPanel();
    assert.equal(footer(container), t("status.connected") + " · v4.10.0");

    panel.bridge.setStatus("connecting", null);
    await dom.flush();
    assert.equal(footer(container), t("status.connecting"));

    panel.bridge.setStatus("offline", null);
    await dom.flush();
    assert.equal(footer(container), t("status.unavailable"));

    panel.bridge.setStatus("mismatch", null);
    await dom.flush();
    assert.equal(footer(container), t("status.mismatch"));
});

test("reporting a problem opens the issue tracker", async () => {
    const container = await openPanel();
    const opened = [];
    panel.host.openUrl = (url) => opened.push(url);
    click(query(container, ".footer button"));
    assert.equal(opened.length, 1);
    assert.ok(opened[0].indexOf("http") === 0, "and it is a real address");
});

/* --------------------------------------------------------- the update strip */

test("an update is a strip above whatever tab you are on, never a dialog", async () => {
    // Worth seeing wherever you are, but never urgent enough to interrupt.
    const container = await openPanel(
        panelState({ update: { latestVersion: "4.11.0", url: "https://example.invalid/4.11.0", dismissed: false } })
    );
    const banner = query(container, ".body .banner.info");
    assert.ok(textOf(banner).indexOf(t("update.available", "4.11.0")) !== -1);
    assert.ok(textOf(banner).indexOf(t("update.body", "4.10.0")) !== -1);

    click(tabButton(container, "tab.settings"));
    await dom.flush();
    assert.ok(query(container, ".body .banner.info"), "and it follows you across the tabs");
});

test("the update strip can be read or put away, and stays away", async () => {
    const container = await openPanel(
        panelState({ update: { latestVersion: "4.11.0", url: "https://example.invalid/4.11.0", dismissed: false } })
    );
    const opened = [];
    panel.host.openUrl = (url) => opened.push(url);
    click(byText(container, t("update.view")));
    assert.deepEqual(opened, ["https://example.invalid/4.11.0"]);

    click(byText(container, t("common.dismiss")));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("dismissUpdate"), { type: "dismissUpdate", version: "4.11.0" });
});

test("an update with nowhere to point sends you to the issue tracker", async () => {
    const container = await openPanel(
        panelState({ update: { latestVersion: "4.11.0", url: null, dismissed: false } })
    );
    const opened = [];
    panel.host.openUrl = (url) => opened.push(url);
    click(byText(container, t("update.view")));
    assert.equal(opened.length, 1);
    assert.ok(opened[0].indexOf("http") === 0);
});

test("an update already dismissed is not raised again", async () => {
    const container = await openPanel(
        panelState({ update: { latestVersion: "4.11.0", url: null, dismissed: true } })
    );
    assert.equal(query(container, ".body .banner.info"), null);
});

test("a dismissal the generator refuses is said out loud, not swallowed", async () => {
    const container = await openPanel(
        panelState({ update: { latestVersion: "4.11.0", url: null, dismissed: false } })
    );
    panel.bridge.reply = () => ({ ok: false, error: "config.json is read-only" });
    click(byText(container, t("common.dismiss")));
    await dom.flush();
    assert.deepEqual(toasts(container), ["config.json is read-only"]);
});
