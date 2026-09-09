/**
 * What the buttons on the first tab are wired to.
 *
 * The Dashboard itself decides what may be offered; this is the other half --
 * what each offer actually asks the generator for, and what the panel does
 * with a refusal. Every one of them is the same shape, which is the point:
 * one command, and a toast if it does not land.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { byText, click, fire, query, queryAll, textOf } from "./dom.mjs";
import { panelState, sessionRow } from "./panel-harness.mjs";
import { bootPanel } from "./app-harness.mjs";

const { dom, panel, openPanel, t } = await bootPanel(mock);

const toasts = (container) => queryAll(container, ".toast").map((toast) => textOf(query(toast, ".toast-text")));
const recordSwitch = (container) => query(container, '.record-head button[role="switch"]');
const refuse = (message) => {
    panel.bridge.reply = () => ({ ok: false, error: message });
};

/* --------------------------------------------------------------- recording */

test("the recording switch writes the config, and a refusal is said out loud", async () => {
    const container = await openPanel(panelState({ config: { ...panelState().config, enabled: false } }));
    click(recordSwitch(container));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("setConfig"), { type: "setConfig", patch: { enabled: true } });
    assert.deepEqual(toasts(container), []);

    refuse("config.json is read-only");
    click(recordSwitch(container));
    await dom.flush();
    assert.deepEqual(toasts(container), ["config.json is read-only"]);
});

test("resuming a paused recording asks for exactly that", async () => {
    const container = await openPanel(
        panelState({ config: { ...panelState().config, enabled: true }, health: { ...panelState().health, pausedReason: "Disk full" } })
    );
    click(query(container, ".banner.error button.primary"));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("resume"), { type: "resume" });

    refuse("The disk is still full");
    click(query(container, ".banner.error button.primary"));
    await dom.flush();
    assert.deepEqual(toasts(container), ["The disk is still full"]);
});

/* ---------------------------------------------------------------- resuming */

test("adopting a recording attaches it to the document in front", async () => {
    const container = await openPanel(
        panelState({ session: null, resumeCandidates: [sessionRow({ sessionId: "old", docName: "dragon" })] })
    );
    click(queryAll(query(container, ".banner-actions"), "button")[0]);
    await dom.flush();
    assert.deepEqual(panel.bridge.last("adoptSession"), {
        type: "adoptSession",
        documentId: 1,
        sessionId: "old"
    });

    refuse("That folder has gone");
    click(queryAll(query(container, ".banner-actions"), "button")[0]);
    await dom.flush();
    assert.deepEqual(toasts(container), ["That folder has gone"]);
});

test("starting fresh opens a new recording for the document in front", async () => {
    const container = await openPanel(panelState({ session: null }));
    click(byText(container, t("doc.startForThis")));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("newSession"), { type: "newSession", documentId: 1 });

    refuse("The frames folder is not writable");
    click(byText(container, t("doc.startForThis")));
    await dom.flush();
    assert.deepEqual(toasts(container), ["The frames folder is not writable"]);
});

test("with no document in front there is nothing to attach a recording to", async () => {
    // The resume offer is about recordings, not about what is open, so it is
    // on screen even with nothing open -- and then it has nowhere to go.
    const container = await openPanel(
        panelState({
            document: null,
            session: null,
            resumeCandidates: [sessionRow({ sessionId: "old" })]
        })
    );
    const offers = queryAll(query(container, ".banner-actions"), "button");
    click(offers[0]);
    await dom.flush();
    assert.equal(panel.bridge.sent("adoptSession").length, 0);

    click(offers[offers.length - 1]);
    await dom.flush();
    assert.equal(panel.bridge.sent("newSession").length, 0);
    assert.deepEqual(toasts(container), [], "and it says nothing, because nothing went wrong");
});

/* ------------------------------------------------------- exporting from here */

test("a recording whose document has been closed can still be exported", async () => {
    // The frames are on disk either way; what is missing is only the canvas
    // to take the aspect ratio from.
    const container = await openPanel(panelState({ document: null }), {
        folders: { "C:/frames/s1": ["000001_1700000000000.jpg"] },
        host: { chooseSavePath: () => "D:/out.mp4" }
    });
    click(queryAll(container, ".record-actions button")[1]);
    await dom.flush();
    assert.equal(query(container, ".dialog"), null, "there is no summary to export");
});

test("a recording with no frame yet is exported with no time on it", async () => {
    const container = await openPanel(
        panelState({ session: { ...panelState().session, lastFrameAt: 0 } }),
        {
            folders: { "C:/frames/s1": ["000001_1700000000000.jpg"] },
            host: { chooseSavePath: () => "D:/out.mp4" }
        }
    );
    click(queryAll(container, ".record-actions button")[1]);
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.equal(panel.media.exports.length, 1);
});

test("an export confirmed after the generator went away is still an export", async () => {
    const container = await openPanel(panelState(), {
        folders: { "C:/frames/s1": ["000001_1700000000000.jpg"] },
        host: { chooseSavePath: () => "D:/out.mp4" }
    });
    click(queryAll(container, ".record-actions button")[1]);
    await dom.flush();

    panel.bridge.setStatus("offline", null);
    await dom.flush();
    assert.ok(query(container, ".dialog"), "the dialog is still in front of you");

    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.equal(panel.media.exports.length, 1, "the frames are on disk regardless");
    assert.ok(panel.bridge.last("setConfig"), "and the choice is still worth remembering");
});

test("exporting a listed recording while the generator is away knows it is not the current one", async () => {
    const container = await openPanel(panelState({ session: null }), {
        sessions: [sessionRow({ sessionId: "a", folder: "C:/frames/a" })],
        folders: { "C:/frames/a": ["000001_1700000000000.jpg"] },
        host: { chooseSavePath: () => "D:/out.mp4" }
    });
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();

    panel.bridge.setStatus("offline", null);
    await dom.flush();
    click(query(container, 'button[aria-label="' + t("sessions.export") + '"]'));
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();

    assert.equal(panel.media.exports.pop().request.finalImagePath, null, "no open canvas to bookend it with");
});

/* ------------------------------------------------- what the generator sends back */

test("a command that answers without a listing leaves the listing empty, not broken", async () => {
    // Older generators answer some commands with nothing but `ok`.
    const container = await openPanel(panelState({ session: null }), {
        sessions: [sessionRow({ sessionId: "a" })]
    });
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    assert.equal(queryAll(container, ".session").length, 1);

    panel.bridge.reply = () => ({ ok: true });
    click(query(container, 'button[aria-label="' + t("sessions.archive") + '"]'));
    await dom.flush();
    assert.equal(queryAll(container, ".session").length, 0);

    panel.bridge.sessions = [sessionRow({ sessionId: "a" })];
    panel.bridge.replyPlainly();
    click(query(container, 'button[aria-label="' + t("sessions.refresh") + '"]'));
    await dom.flush();

    panel.bridge.reply = () => ({ ok: true });
    click(query(container, 'button[aria-label="' + t("sessions.moveBeside", "dragon.psd") + '"]'));
    await dom.flush();
    assert.equal(queryAll(container, ".session").length, 0);
});

test("a delete answered without a listing empties the shelf too", async () => {
    const container = await openPanel(panelState({ session: null }), {
        sessions: [sessionRow({ sessionId: "a" })]
    });
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    panel.bridge.reply = () => ({ ok: true });
    click(query(container, 'button[aria-label="' + t("sessions.delete") + '"]'));
    await dom.flush();
    assert.equal(queryAll(container, ".session").length, 0);
});

test("a listing that answers with nothing at all is an empty shelf", async () => {
    const container = await openPanel(panelState({ session: null }));
    panel.bridge.reply = () => ({ ok: true });
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    assert.equal(textOf(query(container, ".empty")), t("sessions.empty"));
});

test("a bulk archive answered without a listing is still counted", async () => {
    const old = Date.now() - 90 * 24 * 3600 * 1000;
    const container = await openPanel(
        panelState({
            session: null,
            config: { ...panelState().config, staleMaxFrames: 10, staleAfterDays: 30 }
        }),
        { sessions: [sessionRow({ sessionId: "a", createdAt: old })] }
    );
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    panel.bridge.reply = () => ({ ok: true });
    click(byText(query(container, ".toolbar"), t("sessions.archiveStale", 1)));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("sessions.archivedMany", 1)]);
});

test("a zip answered without a listing queues nothing, and says nothing", async () => {
    const container = await openPanel(panelState({ session: null }), {
        sessions: [sessionRow({ sessionId: "a", archived: true })],
        host: { chooseFolder: () => "D:/archive" }
    });
    click(byText(query(container, ".tabs"), t("tab.archive")));
    await dom.flush();
    click(query(container, "input.tick"));
    query(container, "input.tick").checked = true;
    const { fire } = await import("./dom.mjs");
    fire(query(container, "input.tick"), "change", {});
    await dom.flush();
    click(byText(query(container, ".toolbar.bulk"), t("archive.pack")));
    await dom.flush();
    panel.bridge.reply = () => ({ ok: true });
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.deepEqual(toasts(container), []);
});

/* ---------------------------------------------------------- odds and ends */

test("a Photoshop that will not say what language it is in is not a crash", async () => {
    const container = await openPanel(panelState(), { host: { hostUiLocale: () => null } });
    assert.ok(query(container, ".tabs"), "the panel comes up anyway");
});

test("a folder still on the move at the next listing is not reported as landed", async () => {
    const container = await openPanel(panelState({ session: null }), {
        sessions: [sessionRow({ sessionId: "a", moving: { done: 1, total: 9, to: "C:/art/dragon frames" } })]
    });
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();

    panel.bridge.sessions = [sessionRow({ sessionId: "a", moving: { done: 4, total: 9, to: "C:/art/dragon frames" } })];
    click(query(container, 'button[aria-label="' + t("sessions.refresh") + '"]'));
    await dom.flush();
    assert.deepEqual(toasts(container), [], "it is still going");
});

test("a review of a recording the listing has since lost still has words for it", async () => {
    const container = await openPanel(panelState({ session: null }), {
        sessions: [
            sessionRow({ sessionId: "a", archived: true }),
            sessionRow({ sessionId: "b", docName: "castle", archived: true })
        ]
    });
    click(byText(query(container, ".tabs"), t("tab.archive")));
    await dom.flush();
    click(byText(query(container, ".toolbar"), t("archive.review")));
    await dom.flush();

    // Both rows go while the first is still in front of us.
    panel.bridge.sessions = [];
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    click(byText(query(container, ".tabs"), t("tab.archive")));
    await dom.flush();

    click(byText(query(container, ".review-choices"), t("review.keep")));
    await dom.flush();
    assert.equal(textOf(query(container, ".review-name")), "b", "named by its id, which is all that is left");
    assert.equal(textOf(query(container, ".dialog .hint")), t("review.unsaved"));
});

/* ------------------------------------------------------- checking for updates */

test("a manual check says something either way, because a silent button reads as broken", async () => {
    const container = await openPanel(
        panelState({ config: { ...panelState().config, checkForUpdates: true } })
    );
    click(byText(query(container, ".tabs"), t("tab.settings")));
    await dom.flush();

    panel.bridge.reply = () => ({ ok: true, updateCheck: { outcome: "current" } });
    click(byText(container, t("update.checkNow")));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("update.upToDate")]);

    panel.bridge.reply = () => ({ ok: true, updateCheck: { outcome: "failed" } });
    click(byText(container, t("update.checkNow")));
    await dom.flush();
    assert.ok(toasts(container).indexOf(t("update.failed")) !== -1);
});

test("a check that found something says nothing: the strip says it instead", async () => {
    const container = await openPanel(
        panelState({ config: { ...panelState().config, checkForUpdates: true } })
    );
    click(byText(query(container, ".tabs"), t("tab.settings")));
    await dom.flush();
    panel.bridge.reply = () => ({ ok: true, updateCheck: { outcome: "newer" } });
    click(byText(container, t("update.checkNow")));
    await dom.flush();
    assert.deepEqual(toasts(container), []);
});

test("a generator too old to answer a check at all counts as a failed check", async () => {
    const container = await openPanel(
        panelState({ config: { ...panelState().config, checkForUpdates: true } })
    );
    click(byText(query(container, ".tabs"), t("tab.settings")));
    await dom.flush();
    panel.bridge.reply = () => ({ ok: true });
    click(byText(container, t("update.checkNow")));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("update.failed")]);
});

test("a check that could not be sent leaves the button usable again", async () => {
    const container = await openPanel(
        panelState({ config: { ...panelState().config, checkForUpdates: true } })
    );
    click(byText(query(container, ".tabs"), t("tab.settings")));
    await dom.flush();
    refuse("The generator is not listening");
    click(byText(container, t("update.checkNow")));
    await dom.flush();
    assert.deepEqual(toasts(container), ["The generator is not listening"]);
    assert.equal(byText(container, t("update.checkNow")).disabled, false);
});

/* ----------------------------------------------------------- odd answers */

test("a bulk delete answered without a listing counts everything as gone", async () => {
    const container = await openPanel(panelState({ session: null }), {
        sessions: [sessionRow({ sessionId: "a", archived: true })]
    });
    click(byText(query(container, ".tabs"), t("tab.archive")));
    await dom.flush();
    const tick = query(container, "input.tick");
    tick.checked = true;
    fire(tick, "change", {});
    await dom.flush();

    panel.bridge.reply = () => ({ ok: true });
    click(byText(query(container, ".toolbar.bulk"), t("archive.deleteSelected")));
    await dom.flush();
    assert.ok(toasts(container).indexOf(t("archive.deleted", 1)) !== -1);
});

test("exporting a listed recording that is not being recorded gets no bookend", async () => {
    const container = await openPanel(panelState({ session: null }), {
        sessions: [sessionRow({ sessionId: "a", folder: "C:/frames/a" })],
        folders: { "C:/frames/a": ["000001_1700000000000.jpg"] },
        host: { chooseSavePath: () => "D:/out.mp4" }
    });
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    click(query(container, 'button[aria-label="' + t("sessions.export") + '"]'));
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.equal(panel.media.exports.pop().request.finalImagePath, null);
});
