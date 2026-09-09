/**
 * The two shelves: the recordings still in play, and the archive.
 *
 * One component renders both, and `archived` is what tells them apart -- which
 * is deliberate, because they are the same list with different rules about
 * what may be done to a row. The rules are the interesting part: a folder that
 * has gone offers only the delete, a recording being moved offers nothing at
 * all until it lands, and the take in progress cannot be moved out from under
 * itself.
 *
 * The archive adds the bulk half -- tick rows, or let the staleness rule tick
 * them for you, and then act on all of them at once.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { h } from "preact";

import { byText, choose, click, installDom, mount, query, queryAll, textOf } from "./dom.mjs";
import { sessionRow, stubPanel } from "./panel-harness.mjs";

const dom = installDom();
const panel = stubPanel(mock);
const { Sessions, formatDate, pinCurrent } = await import("../dist/modules/sessionsView.mjs");
const { createTranslate, formatDuration } = await import("../dist/modules/i18n.mjs");

const t = createTranslate("en");

/** Mounts a shelf, recording every callback it makes. */
function shelf(props = {}) {
    const calls = [];
    const record = (name) => (...args) => calls.push({ name, args });
    const container = mount(
        dom,
        h(Sessions, {
            t,
            archived: false,
            sessions: [sessionRow()],
            currentSessionId: null,
            busy: false,
            stale: [],
            staleRule: "Older than 30 days",
            selected: {},
            onSelect: record("select"),
            onSelectMany: record("selectMany"),
            onRefresh: record("refresh"),
            onExport: record("export"),
            onDelete: record("delete"),
            onOpenDocument: record("openDocument"),
            onSwitchDocument: record("switchDocument"),
            onSetArchived: record("setArchived"),
            onMove: record("move"),
            onArchiveStale: record("archiveStale"),
            onOpenSelected: record("openSelected"),
            onPackSelected: record("packSelected"),
            onDeleteSelected: record("deleteSelected"),
            onReview: record("review"),
            ...props
        })
    );
    return { container, calls, only: (name) => calls.filter((call) => call.name === name) };
}

/** Every action on a row, by the name it is announced under. */
const actions = (container) =>
    queryAll(container, ".session-actions button").map((button) => button.getAttribute("aria-label"));
const actionFor = (container, label) => query(container, 'button[aria-label="' + label + '"]');
const toolbarButton = (container, text) => byText(query(container, ".toolbar"), text);

/* ------------------------------------------------------------- the listing */

test("before the listing arrives there is no empty shelf, only a wait", () => {
    // null is "not asked yet" and [] is "asked, and there are none"; showing
    // "no recordings" for the first would be a lie that corrects itself.
    const waiting = shelf({ sessions: null });
    assert.equal(textOf(query(waiting.container, ".empty")), t("status.connecting"));
    assert.equal(query(waiting.container, ".toolbar"), null, "and nothing to press meanwhile");

    const empty = shelf({ sessions: [] });
    assert.equal(textOf(query(empty.container, ".empty")), t("sessions.empty"));
    assert.ok(query(empty.container, ".toolbar"), "but the refresh is still there");
});

test("each shelf says its own kind of empty", () => {
    const archive = shelf({ archived: true, sessions: [] });
    assert.equal(textOf(query(archive.container, ".empty")), t("archive.empty"));
});

test("the take in progress goes first, whatever its timestamps say", () => {
    // A recording just started has no frames yet and a resumed one sits below
    // everything drawn on since, so sorting by last frame is not enough.
    const rows = [sessionRow({ sessionId: "a" }), sessionRow({ sessionId: "b" }), sessionRow({ sessionId: "c" })];
    assert.deepEqual(pinCurrent(rows, "c").map((row) => row.sessionId), ["c", "a", "b"]);
    assert.deepEqual(pinCurrent(rows, null), rows, "and with nothing recording, the order stands");

    const { container } = shelf({
        sessions: [sessionRow({ sessionId: "a", docName: "old" }), sessionRow({ sessionId: "b", docName: "now" })],
        currentSessionId: "b"
    });
    assert.deepEqual(
        queryAll(container, ".session-name").map(textOf),
        ["now", "old"]
    );
    assert.equal(textOf(query(container, ".badge")), t("sessions.current"));
});

test("a row says how much is in it, and when it was last touched", () => {
    const { container } = shelf({
        sessions: [sessionRow({ frameCount: 412, timeSpentSec: 3661, lastModifiedAt: 1700000000000 })]
    });
    assert.equal(
        textOf(query(container, ".session-meta")),
        t("sessions.frames", 412, formatDuration(3661, t)) + " · " + formatDate(1700000000000)
    );
});

test("a recording that was never written to has no date to show, and shows none", () => {
    const { container } = shelf({ sessions: [sessionRow({ lastModifiedAt: 0 })] });
    assert.equal(textOf(query(container, ".session-meta")), t("sessions.frames", 12, formatDuration(90, t)));
});

test("dates are written the same way whatever the locale, and padded", () => {
    // Sortable, unambiguous, and the same string in every language, because a
    // folder listing next to it is too.
    const early = new Date(2024, 0, 5, 9, 7).getTime();
    assert.equal(formatDate(early), "2024-01-05 09:07");
    const late = new Date(2024, 10, 25, 22, 45).getTime();
    assert.equal(formatDate(late), "2024-11-25 22:45");
});

/* --------------------------------------------------------------- the rows */

test("a row offers everything that can be done with a saved document", () => {
    const { container } = shelf({ sessions: [sessionRow({ filePathHistory: ["C:/art/piece.psd"] })] });
    assert.deepEqual(actions(container), [
        t("sessions.switch", "PSD"),
        t("sessions.openDocument", "PSD"),
        t("sessions.open"),
        t("sessions.export"),
        t("sessions.moveBeside", "piece.psd"),
        t("sessions.archive"),
        t("sessions.delete")
    ]);
});

test("the buttons carry the real extension, so they never lie about the file", () => {
    const tif = shelf({ sessions: [sessionRow({ filePathHistory: ["C:/art/piece.tif"] })] });
    assert.ok(actionFor(tif.container, t("sessions.openDocument", "TIF")));

    const bare = shelf({ sessions: [sessionRow({ filePathHistory: ["C:/art/piece"] })] });
    assert.ok(actionFor(bare.container, t("sessions.openDocument", "PSD")), "and guess PSD when there is none");
});

test("Save As is followed: the newest path is the one on offer", () => {
    const { container, only } = shelf({
        sessions: [sessionRow({ filePathHistory: ["C:/art/draft.psd", "C:/art/final.psd"] })]
    });
    assert.ok(actionFor(container, t("sessions.moveBeside", "final.psd")));
    assert.equal(
        actionFor(container, t("sessions.openDocument", "PSD")).getAttribute("title"),
        t("sessions.openDocument", "PSD") + "\nC:/art/final.psd"
    );

    click(actionFor(container, t("sessions.openDocument", "PSD")));
    assert.equal(only("openDocument")[0].args[0].sessionId, "s1");
});

test("a document that was never saved has nothing to open, and is not asked to", () => {
    const { container } = shelf({ sessions: [sessionRow({ filePathHistory: [] })] });
    assert.deepEqual(actions(container), [
        t("sessions.open"),
        t("sessions.export"),
        t("sessions.archive"),
        t("sessions.delete")
    ]);
});

test("a folder that has gone leaves only the one useful thing: letting it go", () => {
    const { container, only } = shelf({
        sessions: [sessionRow({ error: "The folder is no longer there", frameCount: 0 })]
    });
    assert.deepEqual(actions(container), [t("sessions.delete")]);
    assert.equal(textOf(query(container, ".hint")), "The folder is no longer there");

    click(actionFor(container, t("sessions.delete")));
    assert.equal(only("delete").length, 1);
});

test("a folder with trouble but frames still in it keeps its buttons", () => {
    const { container } = shelf({ sessions: [sessionRow({ error: "Two frames could not be read" })] });
    assert.ok(actionFor(container, t("sessions.export")), "the frames that are there can still go out");
});

test("a recording with no frames cannot be exported", () => {
    const empty = shelf({ sessions: [sessionRow({ frameCount: 0 })] });
    assert.equal(actionFor(empty.container, t("sessions.export")).disabled, true);

    const some = shelf({ sessions: [sessionRow({ frameCount: 12 })] });
    click(actionFor(some.container, t("sessions.export")));
    assert.equal(some.only("export")[0].args[0].sessionId, "s1");
});

test("a path that is nothing but separators still names the button something", () => {
    // Photoshop will not hand back a path like this, but a session.json that
    // was edited by hand can, and a button labelled with nothing at all would
    // be worse than one labelled oddly.
    const { container } = shelf({ sessions: [sessionRow({ filePathHistory: ["/"] })] });
    assert.ok(actionFor(container, t("sessions.moveBeside", "/")));
});

test("the folder opens without asking anyone, because nothing can go wrong", () => {
    const { container } = shelf({ sessions: [sessionRow({ folder: "C:/frames/s1" })] });
    click(actionFor(container, t("sessions.open")));
    assert.deepEqual(panel.host.calls.pop(), { name: "openInExplorer", args: ["C:/frames/s1"] });
});

test("switching away from the piece you are recording is not offered", () => {
    const { container, only } = shelf({ sessions: [sessionRow()], currentSessionId: "s1" });
    assert.equal(actionFor(container, t("sessions.switch", "PSD")).disabled, true);
    assert.equal(actionFor(container, t("sessions.openDocument", "PSD")).disabled, false, "but reopening is fine");

    click(actionFor(container, t("sessions.openDocument", "PSD")));
    assert.equal(only("openDocument").length, 1);
});

test("switching says what it will do first, so a save is never a surprise", () => {
    const { container, only } = shelf({ sessions: [sessionRow({ filePathHistory: ["C:/art/piece.psd"] })] });
    const button = actionFor(container, t("sessions.switch", "PSD"));
    assert.equal(
        button.getAttribute("title"),
        t("sessions.switch", "PSD") + "\n" + t("sessions.switch.hint") + "\nC:/art/piece.psd"
    );
    click(button);
    assert.equal(only("switchDocument")[0].args[0].sessionId, "s1");
});

test("the paperclip is a toggle, and says which way it will go", () => {
    const home = shelf({ sessions: [sessionRow({ filePathHistory: ["C:/art/piece.psd"] })] });
    const out = actionFor(home.container, t("sessions.moveBeside", "piece.psd"));
    assert.equal(out.getAttribute("aria-pressed"), "false");
    click(out);
    assert.deepEqual(home.only("move")[0].args[1], "document");

    const beside = shelf({ sessions: [sessionRow({ besideDocument: true })] });
    const back = actionFor(beside.container, t("sessions.moveHome"));
    assert.equal(back.getAttribute("aria-pressed"), "true");
    click(back);
    assert.deepEqual(beside.only("move")[0].args[1], "root");
});

test("the frames under the take in progress stay put, and the button says why", () => {
    const { container } = shelf({ sessions: [sessionRow()], currentSessionId: "s1" });
    const clip = actionFor(container, t("sessions.moveBeside", "dragon.psd"));
    assert.equal(clip.disabled, true);
    assert.ok(clip.getAttribute("title").indexOf(t("sessions.moveLocked")) !== -1);
});

test("a recording in transit shows how far along it is, and offers nothing", () => {
    const moving = shelf({ sessions: [sessionRow({ moving: { done: 3, total: 12 } })] });
    assert.equal(textOf(query(moving.container, ".progress-label")), t("sessions.moving") + "25%");
    assert.equal(query(moving.container, ".session-actions"), null);

    const packing = shelf({ sessions: [sessionRow({ packing: { done: 1, total: 4 } })] });
    assert.equal(textOf(query(packing.container, ".progress-label")), t("sessions.packing") + "25%");

    const starting = shelf({ sessions: [sessionRow({ packing: { done: 0, total: 0 } })] });
    assert.equal(textOf(query(starting.container, ".progress-label")), t("sessions.packing") + "0%");
});

test("while the panel is busy, no row will start anything else", () => {
    const { container } = shelf({ sessions: [sessionRow()], busy: true });
    for (const button of queryAll(container, ".session-actions button")) {
        const label = button.getAttribute("aria-label");
        assert.equal(button.disabled, label !== t("sessions.open"), label);
    }
});

test("each shelf offers the move to the other one", () => {
    const open = shelf({ sessions: [sessionRow()] });
    click(actionFor(open.container, t("sessions.archive")));
    assert.deepEqual(open.only("setArchived")[0].args[1], true);

    const archived = shelf({ archived: true, sessions: [sessionRow({ archived: true })] });
    click(actionFor(archived.container, t("sessions.unarchive")));
    assert.deepEqual(archived.only("setArchived")[0].args[1], false);
});

/* ------------------------------------------------- sweeping up, one click */

test("the Recordings tab sweeps its stale rows into the archive, and says how many", () => {
    const none = shelf({ stale: [] });
    assert.equal(toolbarButton(none.container, t("sessions.archiveStale", 0)).disabled, true);

    const some = shelf({ stale: [sessionRow(), sessionRow({ sessionId: "s2" })] });
    const button = toolbarButton(some.container, t("sessions.archiveStale", 2));
    assert.equal(button.getAttribute("title"), "Older than 30 days", "and the rule it is going by");
    click(button);
    assert.equal(some.only("archiveStale").length, 1);
});

test("refreshing is on both shelves, and off while something is happening", () => {
    const idle = shelf({});
    click(actionFor(idle.container, t("sessions.refresh")));
    assert.equal(idle.only("refresh").length, 1);

    const busy = shelf({ busy: true });
    assert.equal(actionFor(busy.container, t("sessions.refresh")).disabled, true);
});

/* ------------------------------------------------------- the archive tools */

test("the archive says what it is for, and the Recordings tab does not", () => {
    assert.ok(textOf(shelf({ archived: true }).container).indexOf(t("archive.hint")) !== -1);
    assert.equal(textOf(shelf({}).container).indexOf(t("archive.hint")), -1);
});

test("rows are ticked one at a time, or all at once, or by the staleness rule", () => {
    const rows = [sessionRow({ sessionId: "a" }), sessionRow({ sessionId: "b" })];
    const { container, only } = shelf({ archived: true, sessions: rows, stale: [rows[1]] });

    choose(query(container, 'input[aria-label="' + t("archive.select", "dragon") + '"]'), true);
    assert.deepEqual(only("select")[0].args, ["a", true]);

    click(toolbarButton(container, t("archive.selectStale", 1)));
    assert.deepEqual(only("selectMany")[0].args, [["b"]]);

    click(toolbarButton(container, t("archive.selectAll")));
    assert.deepEqual(only("selectMany")[1].args, [["a", "b"]]);
});

test("once everything is ticked the same button clears it", () => {
    const rows = [sessionRow({ sessionId: "a" })];
    const { container, only } = shelf({ archived: true, sessions: rows, selected: { a: true } });
    click(toolbarButton(container, t("archive.selectNone")));
    assert.deepEqual(only("selectMany")[0].args, [[]]);
});

test("a row that is being moved cannot be ticked, or counted as ticked", () => {
    const rows = [sessionRow({ sessionId: "a", moving: { done: 1, total: 2 } })];
    const { container } = shelf({ archived: true, sessions: rows });
    assert.equal(query(container, "input.tick").disabled, true);
    assert.equal(toolbarButton(container, t("archive.selectAll")).disabled, true, "there is nothing tickable");
});

test("nothing ticked means no bulk toolbar at all", () => {
    const { container } = shelf({ archived: true, sessions: [sessionRow()] });
    assert.equal(query(container, ".toolbar.bulk"), null);
});

test("the ticked rows can be opened, zipped, or deleted with or without their files", () => {
    const rows = [sessionRow({ sessionId: "a" }), sessionRow({ sessionId: "b" })];
    const { container, only } = shelf({
        archived: true,
        sessions: rows,
        selected: { a: true, b: true }
    });
    const bulk = query(container, ".toolbar.bulk");
    assert.equal(textOf(query(bulk, ".toolbar-count")), t("archive.selected", 2));
    assert.ok(query(container, ".session.selected"), "and the rows themselves show it");

    click(byText(bulk, t("archive.openSelected", 2)));
    assert.equal(only("openSelected").length, 1);
    click(byText(bulk, t("archive.pack")));
    assert.equal(only("packSelected").length, 1);
    click(byText(bulk, t("archive.deleteSelected")));
    assert.deepEqual(only("deleteSelected")[0].args, [false]);
    click(byText(bulk, t("archive.deleteWithFiles")));
    assert.deepEqual(only("deleteSelected")[1].args, [true]);
});

test("only the ticked rows that have a file to open are counted as openable", () => {
    const rows = [
        sessionRow({ sessionId: "a" }),
        sessionRow({ sessionId: "b", filePathHistory: [] }),
        sessionRow({ sessionId: "c", error: "gone" })
    ];
    const { container } = shelf({
        archived: true,
        sessions: rows,
        selected: { a: true, b: true, c: true }
    });
    assert.ok(byText(query(container, ".toolbar.bulk"), t("archive.openSelected", 1)));
});

test("with nothing openable ticked, the open button is off rather than misleading", () => {
    const { container } = shelf({
        archived: true,
        sessions: [sessionRow({ sessionId: "a", filePathHistory: [] })],
        selected: { a: true }
    });
    assert.equal(byText(query(container, ".toolbar.bulk"), t("archive.openSelected", 0)).disabled, true);
});

test("the one-at-a-time clean-up needs something to look through", () => {
    const empty = shelf({ archived: true, sessions: [] });
    assert.equal(toolbarButton(empty.container, t("archive.review")).disabled, true);

    const some = shelf({ archived: true, sessions: [sessionRow()] });
    const button = toolbarButton(some.container, t("archive.review"));
    assert.equal(button.getAttribute("title"), t("review.hint"));
    click(button);
    assert.equal(some.only("review").length, 1);
});

test("while the panel is busy, none of the bulk tools will start anything", () => {
    const { container } = shelf({
        archived: true,
        sessions: [sessionRow({ sessionId: "a" })],
        selected: { a: true },
        stale: [sessionRow({ sessionId: "a" })],
        busy: true
    });
    for (const button of queryAll(container, ".toolbar button")) {
        assert.equal(button.disabled, true, textOf(button) || button.getAttribute("aria-label"));
    }
});
