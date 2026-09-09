/**
 * The archive's bulk half, and the row-at-a-time actions in both listings.
 *
 * What these have in common is that they are the destructive end of the panel,
 * so the shape is always the same: work out what would actually happen, ask,
 * and only then do it. Nothing here deletes without a question, nothing acts
 * on the take in progress, and a bulk command that had to skip a row says
 * which -- up to a point, because thirty toasts is not a report.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { byText, choose, click, query, queryAll, textOf } from "./dom.mjs";
import { panelState, sessionRow } from "./panel-harness.mjs";
import { bootPanel } from "./app-harness.mjs";

const { dom, panel, disk, openPanel, t } = await bootPanel(mock);

const toasts = (container) => queryAll(container, ".toast").map((toast) => textOf(query(toast, ".toast-text")));
const rowNames = (container) => queryAll(container, ".session-name").map(textOf);
const toolbarButton = (container, text) => byText(query(container, ".toolbar"), text);
/** The nth button in the tools toolbar, for when its label carries a count. */
const toolAt = (container, index) => queryAll(query(container, ".toolbar"), "button")[index];
const bulkButton = (container, text) => byText(query(container, ".toolbar.bulk"), text);
const actionFor = (container, label) => query(container, 'button[aria-label="' + label + '"]');

const filed = (overrides) => sessionRow({ archived: true, ...overrides });

/** Opens the panel on one of the two listing tabs. */
async function listing(tab, sessions, options = {}) {
    const paths = [];
    for (const row of sessions) {
        for (const path of row.filePathHistory || []) {
            paths.push(path);
        }
    }
    const container = await openPanel(options.state || panelState({ session: null }), {
        sessions,
        files: options.files || paths,
        host: options.host || {}
    });
    click(byText(query(container, ".tabs"), t("tab." + tab)));
    await dom.flush();
    return container;
}

/** Ticks the named rows in the archive. */
async function tick(container, names) {
    for (const name of names) {
        choose(query(container, 'input[aria-label="' + t("archive.select", name) + '"]'), true);
        await dom.flush();
    }
}

/* --------------------------------------------------------------- one row */

test("archiving and unarchiving move a row between the shelves", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a", docName: "dragon" })]);
    panel.bridge.sessions = [sessionRow({ sessionId: "a", docName: "dragon", archived: true })];
    click(actionFor(container, t("sessions.archive")));
    await dom.flush();

    assert.deepEqual(panel.bridge.last("setArchived"), { type: "setArchived", sessionId: "a", archived: true });
    assert.deepEqual(rowNames(container), [], "and it is gone from this shelf at once");
});

test("a move is asked for and the new listing is what comes back", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a" })]);
    panel.bridge.sessions = [sessionRow({ sessionId: "a", besideDocument: true })];
    click(actionFor(container, t("sessions.moveBeside", "dragon.psd")));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("moveSession"), {
        type: "moveSession",
        sessionId: "a",
        destination: "document"
    });
    assert.ok(actionFor(container, t("sessions.moveHome")), "the listing says where it is now");
});

test("a row action the generator refuses is said out loud", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a" })]);
    panel.bridge.reply = () => ({ ok: false, error: "The folder is in use" });
    click(actionFor(container, t("sessions.archive")));
    await dom.flush();
    assert.deepEqual(toasts(container), ["The folder is in use"]);

    click(actionFor(container, t("sessions.moveBeside", "dragon.psd")));
    await dom.flush();
    assert.equal(toasts(container).length, 2);
});

test("deleting a recording is asked about first, and a no means no", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a" })]);
    dom.answerConfirm(false);
    click(actionFor(container, t("sessions.delete")));
    await dom.flush();
    assert.deepEqual(dom.asked, [t("sessions.deleteConfirm")]);
    assert.equal(panel.bridge.sent("deleteSession").length, 0);

    dom.answerConfirm(true);
    click(actionFor(container, t("sessions.delete")));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("deleteSession"), { type: "deleteSession", sessionId: "a" });
});

test("deleting the take you are in the middle of says that is what it is", async () => {
    // The generator empties the folder and opens a fresh recording for the
    // same document, which is a different promise from "this will be gone".
    const container = await listing("sessions", [sessionRow({ sessionId: "s1" })], {
        state: panelState()
    });
    click(actionFor(container, t("sessions.delete")));
    await dom.flush();
    assert.deepEqual(dom.asked, [t("sessions.deleteRestartConfirm")]);
});

test("a delete the generator refuses is said out loud", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a" })]);
    panel.bridge.reply = () => ({ ok: false, error: "Two frames are locked" });
    click(actionFor(container, t("sessions.delete")));
    await dom.flush();
    assert.deepEqual(toasts(container), ["Two frames are locked"]);
});

/* ---------------------------------------------------- opening a document */

test("opening a recording's document opens the newest file that still exists", async () => {
    // Save As appends, so the last entry is where the artist is working now --
    // but a file moved back to an earlier address is the case a plain "last
    // entry" would miss.
    const opened = [];
    const container = await listing(
        "sessions",
        [sessionRow({ sessionId: "a", filePathHistory: ["C:/art/draft.psd", "C:/art/final.psd"] })],
        { files: ["C:/art/draft.psd"], host: { openDocumentInPhotoshop: (path) => {
            opened.push(path);
            return Promise.resolve("ok");
        } } }
    );
    click(actionFor(container, t("sessions.openDocument", "PSD")));
    await dom.flush();
    assert.deepEqual(opened, ["C:/art/draft.psd"]);
});

test("a document that is nowhere any more says so, by the name it last had", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a", filePathHistory: ["C:/art/gone.psd"] })], {
        files: []
    });
    click(actionFor(container, t("sessions.openDocument", "PSD")));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("sessions.documentMissing", "C:/art/gone.psd")]);
});

test("a file that vanished between the listing and the click is reported too", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a" })], {
        host: { openDocumentInPhotoshop: () => Promise.resolve("missing") }
    });
    click(actionFor(container, t("sessions.openDocument", "PSD")));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("sessions.documentMissing", "C:/art/dragon.psd")]);
});

test("Photoshop refusing to open a document is reported in its own words", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a" })], {
        host: { openDocumentInPhotoshop: () => Promise.reject(new Error("Photoshop is not responding")) }
    });
    click(actionFor(container, t("sessions.openDocument", "PSD")));
    await dom.flush();
    assert.deepEqual(toasts(container), ["Photoshop is not responding"]);
});

test("switching says nothing when it works, and says why when it does not", async () => {
    const quiet = await listing("sessions", [sessionRow({ sessionId: "a" })]);
    click(actionFor(quiet, t("sessions.switch", "PSD")));
    await dom.flush();
    assert.deepEqual(toasts(quiet), []);

    const cancelled = await listing("sessions", [sessionRow({ sessionId: "a" })], {
        host: { switchToDocumentInPhotoshop: () => Promise.resolve("cancelled") }
    });
    click(actionFor(cancelled, t("sessions.switch", "PSD")));
    await dom.flush();
    assert.deepEqual(toasts(cancelled), [t("sessions.switchCancelled")], "nothing was switched, and nothing was lost");

    const missing = await listing("sessions", [sessionRow({ sessionId: "a" })], {
        host: { switchToDocumentInPhotoshop: () => Promise.resolve("missing") }
    });
    click(actionFor(missing, t("sessions.switch", "PSD")));
    await dom.flush();
    assert.deepEqual(toasts(missing), [t("sessions.documentMissing", "C:/art/dragon.psd")]);

    const broken = await listing("sessions", [sessionRow({ sessionId: "a" })], {
        host: { switchToDocumentInPhotoshop: () => Promise.reject(new Error("Save was refused")) }
    });
    click(actionFor(broken, t("sessions.switch", "PSD")));
    await dom.flush();
    assert.deepEqual(toasts(broken), ["Save was refused"]);
});

test("switching a recording whose file has gone never gets as far as Photoshop", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a" })], { files: [] });
    click(actionFor(container, t("sessions.switch", "PSD")));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("sessions.documentMissing", "C:/art/dragon.psd")]);
    assert.equal(panel.host.calls.filter((each) => each.name === "switchToDocumentInPhotoshop").length, 0);
});

test("a path the filesystem will not answer for is as good as a missing one", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a" })]);
    disk.broken = new Error("EPERM: the drive is not readable");
    click(actionFor(container, t("sessions.openDocument", "PSD")));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("sessions.documentMissing", "C:/art/dragon.psd")]);
});

/* ------------------------------------------------------- sweeping up stale */

test("archiving the stale rows asks, counts, and reports what it could not do", async () => {
    const old = Date.now() - 90 * 24 * 3600 * 1000;
    const rows = [
        sessionRow({ sessionId: "a", docName: "one", lastModifiedAt: old, frameCount: 2 }),
        sessionRow({ sessionId: "b", docName: "two", lastModifiedAt: old, frameCount: 2 })
    ];
    const container = await listing("sessions", rows, {
        state: panelState({
            session: null,
            config: { ...panelState().config, staleMaxFrames: 10, staleAfterDays: 30 }
        })
    });

    dom.answerConfirm(false);
    click(toolbarButton(container, t("sessions.archiveStale", 2)));
    await dom.flush();
    assert.deepEqual(dom.asked, [t("sessions.archiveStaleConfirm", 2)]);
    assert.equal(panel.bridge.sent("setArchivedMany").length, 0);

    dom.answerConfirm(true);
    panel.bridge.reply = () => ({ ok: true, sessions: [], warnings: ["two is in use"] });
    click(toolbarButton(container, t("sessions.archiveStale", 2)));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("setArchivedMany"), {
        type: "setArchivedMany",
        sessionIds: ["a", "b"],
        archived: true
    });
    assert.deepEqual(toasts(container), ["two is in use", t("sessions.archivedMany", 1)]);
});

test("with nothing stale there is nothing to ask about", async () => {
    const container = await listing("sessions", [sessionRow({ sessionId: "a" })], {
        state: panelState({ session: null, config: { ...panelState().config, staleMaxFrames: 0, staleAfterDays: 0 } })
    });
    assert.equal(toolbarButton(container, t("sessions.archiveStale", 0)).disabled, true);
});

test("a bulk archive the generator refuses is said out loud", async () => {
    const old = Date.now() - 90 * 24 * 3600 * 1000;
    const container = await listing("sessions", [sessionRow({ sessionId: "a", lastModifiedAt: old, frameCount: 2 })], {
        state: panelState({ session: null, config: { ...panelState().config, staleMaxFrames: 10, staleAfterDays: 30 } })
    });
    panel.bridge.reply = () => ({ ok: false, error: "The archive folder is read-only" });
    click(toolbarButton(container, t("sessions.archiveStale", 1)));
    await dom.flush();
    assert.deepEqual(toasts(container), ["The archive folder is read-only"]);
});

test("the staleness rule is quoted on the button, in whichever form it takes", async () => {
    const both = await listing("sessions", [sessionRow()], {
        state: panelState({ session: null, config: { ...panelState().config, staleMaxFrames: 10, staleAfterDays: 30 } })
    });
    assert.equal(toolAt(both, 0).getAttribute("title"), t("stale.rule.both", 10, 30));

    const frames = await listing("sessions", [sessionRow()], {
        state: panelState({ session: null, config: { ...panelState().config, staleMaxFrames: 10, staleAfterDays: 0 } })
    });
    assert.equal(toolAt(frames, 0).getAttribute("title"), t("stale.rule.frames", 10));

    const days = await listing("sessions", [sessionRow()], {
        state: panelState({ session: null, config: { ...panelState().config, staleMaxFrames: 0, staleAfterDays: 30 } })
    });
    assert.equal(toolAt(days, 0).getAttribute("title"), t("stale.rule.days", 30));

    const off = await listing("sessions", [sessionRow()], {
        state: panelState({ session: null, config: { ...panelState().config, staleMaxFrames: 0, staleAfterDays: 0 } })
    });
    assert.equal(toolAt(off, 0).getAttribute("title"), t("stale.rule.off"));
});

test("with no generator to ask, nothing is stale and nothing is offered", async () => {
    const container = await openPanel(null);
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    assert.equal(query(container, ".empty") !== null, true, "there is no listing to have a rule about");
});

/* --------------------------------------------------------- ticking rows */

test("a tick outlives nothing: a row that leaves the archive leaves the selection", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    await tick(container, ["dragon", "castle"]);
    assert.ok(bulkButton(container, t("archive.selected", 2)) || query(container, ".toolbar-count"));

    panel.bridge.sessions = [filed({ sessionId: "a" })];
    click(actionFor(container, t("sessions.refresh")));
    await dom.flush();
    assert.equal(textOf(query(container, ".toolbar-count")), t("archive.selected", 1));

    panel.bridge.sessions = [sessionRow({ sessionId: "a", archived: false })];
    click(actionFor(container, t("sessions.refresh")));
    await dom.flush();
    assert.equal(query(container, ".toolbar.bulk"), null, "unarchived is out of the archive, and out of the tally");
});

test("unticking a row puts it back, and the tally follows", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    await tick(container, ["dragon", "castle"]);
    choose(query(container, 'input[aria-label="' + t("archive.select", "castle") + '"]'), false);
    await dom.flush();
    assert.equal(textOf(query(container, ".toolbar-count")), t("archive.selected", 1));
});

test("select-all takes the shelf, and select-stale takes the rule's word for it", async () => {
    const old = Date.now() - 90 * 24 * 3600 * 1000;
    const container = await listing(
        "archive",
        [
            filed({ sessionId: "a", createdAt: Date.now(), frameCount: 400 }),
            filed({ sessionId: "b", docName: "castle", createdAt: old, frameCount: 2 })
        ],
        {
            state: panelState({
                session: null,
                config: { ...panelState().config, staleMaxFrames: 10, staleAfterDays: 30 }
            })
        }
    );
    click(toolAt(container, 0));
    await dom.flush();
    assert.equal(textOf(query(container, ".toolbar-count")), t("archive.selected", 1));

    click(toolAt(container, 1));
    await dom.flush();
    assert.equal(textOf(query(container, ".toolbar-count")), t("archive.selected", 2));

    click(toolAt(container, 1));
    await dom.flush();
    assert.equal(query(container, ".toolbar.bulk"), null);
});

/* ------------------------------------------------------ deleting in bulk */

test("deleting the ticked rows asks how many, and a no leaves them alone", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    await tick(container, ["dragon", "castle"]);

    dom.answerConfirm(false);
    click(bulkButton(container, t("archive.deleteSelected")));
    await dom.flush();
    assert.deepEqual(dom.asked, [t("archive.deleteConfirm", 2)]);
    assert.equal(panel.bridge.sent("deleteSessions").length, 0);

    dom.answerConfirm(true);
    panel.bridge.sessions = [];
    click(bulkButton(container, t("archive.deleteSelected")));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("deleteSessions").items, [
        { sessionId: "a", withDocument: false },
        { sessionId: "b", withDocument: false }
    ]);
    assert.ok(toasts(container).indexOf(t("archive.deleted", 2)) !== -1);
});

test("deleting the files too says so, and closes them in Photoshop first", async () => {
    // Otherwise Photoshop is left holding a file that no longer exists -- and
    // the question said that would happen.
    const closed = [];
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: {
            closeDocumentInPhotoshop: (path, discard) => {
                closed.push({ path, discard });
                return Promise.resolve("ok");
            }
        }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.deleteWithFiles")));
    await dom.flush();

    assert.deepEqual(dom.asked, [t("archive.deleteWithFilesConfirm", 1)]);
    assert.deepEqual(closed, [{ path: "C:/art/dragon.psd", discard: true }]);
    assert.deepEqual(panel.bridge.last("deleteSessions").items, [{ sessionId: "a", withDocument: true }]);
});

test("a document Photoshop will not close is not a reason to stop deleting", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: { closeDocumentInPhotoshop: () => Promise.reject(new Error("It has unsaved changes")) }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.deleteWithFiles")));
    await dom.flush();
    assert.ok(panel.bridge.last("deleteSessions"), "the generator will report the file if it cannot bin it");
});

test("deleting without the files does not go near Photoshop", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })]);
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.deleteSelected")));
    await dom.flush();
    assert.equal(panel.host.calls.filter((each) => each.name === "closeDocumentInPhotoshop").length, 0);
});

test("the take in progress is never in a bulk delete", async () => {
    const container = await listing("archive", [filed({ sessionId: "s1" })], { state: panelState() });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.deleteSelected")));
    await dom.flush();
    assert.deepEqual(dom.asked, [], "there was nothing it was allowed to delete");
    assert.equal(panel.bridge.sent("deleteSessions").length, 0);
});

test("what is reported deleted is what actually went", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    await tick(container, ["dragon", "castle"]);
    panel.bridge.reply = () => ({ ok: true, sessions: [filed({ sessionId: "b", docName: "castle" })], warnings: ["castle is locked"] });
    click(bulkButton(container, t("archive.deleteSelected")));
    await dom.flush();
    assert.deepEqual(toasts(container), ["castle is locked", t("archive.deleted", 1)]);
});

test("a bulk delete the generator refuses is said out loud", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })]);
    await tick(container, ["dragon"]);
    panel.bridge.reply = () => ({ ok: false, error: "The frames folder is read-only" });
    click(bulkButton(container, t("archive.deleteSelected")));
    await dom.flush();
    assert.deepEqual(toasts(container), ["The frames folder is read-only"]);
});

test("a bulk command that skipped a great many rows folds the rest into one line", async () => {
    // Thirty toasts is not a report.
    const container = await listing("archive", [filed({ sessionId: "a" })]);
    await tick(container, ["dragon"]);
    panel.bridge.reply = () => ({
        ok: true,
        sessions: [],
        warnings: ["one", "two", "three", "four", "five"]
    });
    click(bulkButton(container, t("archive.deleteSelected")));
    await dom.flush();
    assert.deepEqual(toasts(container), [
        "one",
        "two",
        "three",
        t("common.warningsMore", 2),
        t("archive.deleted", 1)
    ]);
});

/* ------------------------------------------------------- opening in bulk */

test("opening the ticked rows opens every one that has a file", async () => {
    const opened = [];
    const container = await listing(
        "archive",
        [
            filed({ sessionId: "a", filePathHistory: ["C:/art/dragon.psd"] }),
            filed({ sessionId: "b", docName: "castle", filePathHistory: [] })
        ],
        {
            files: ["C:/art/dragon.psd"],
            host: {
                openDocumentInPhotoshop: (path) => {
                    opened.push(path);
                    return Promise.resolve("ok");
                }
            }
        }
    );
    await tick(container, ["dragon", "castle"]);
    click(bulkButton(container, t("archive.openSelected", 1)));
    await dom.flush();
    assert.deepEqual(opened, ["C:/art/dragon.psd"]);
    assert.deepEqual(toasts(container), [t("archive.openedSome", 1, 2)]);
});

test("opening the ticked rows when every one works says so plainly", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })]);
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.openSelected", 1)));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("archive.openedAll", 1)]);
});

test("a document Photoshop refuses mid-batch does not stop the batch", async () => {
    const container = await listing(
        "archive",
        [filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle", filePathHistory: ["C:/art/castle.psd"] })],
        {
            files: ["C:/art/dragon.psd", "C:/art/castle.psd"],
            host: {
                openDocumentInPhotoshop: (path) =>
                    path.indexOf("dragon") !== -1
                        ? Promise.reject(new Error("dragon.psd is corrupt"))
                        : Promise.resolve("ok")
            }
        }
    );
    await tick(container, ["dragon", "castle"]);
    click(bulkButton(container, t("archive.openSelected", 2)));
    await dom.flush();
    assert.deepEqual(toasts(container), ["dragon.psd is corrupt", t("archive.openedSome", 1, 2)]);
});

test("a document that opened as something other than ok is not counted as opened", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: { openDocumentInPhotoshop: () => Promise.resolve("missing") }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.openSelected", 1)));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("archive.openedSome", 0, 1)]);
});

/* ------------------------------------------------------------- zipping */

test("zipping asks where to put them, and remembers the answer", async () => {
    let asked = 0;
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: {
            chooseFolder: (title, start) => {
                asked++;
                return asked === 1 ? "D:/archive" : start;
            }
        }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    assert.ok(textOf(query(container, ".dialog")).indexOf("D:/archive") !== -1);

    click(byText(query(container, ".dialog"), t("export.cancel")));
    await dom.flush();
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    assert.ok(textOf(query(container, ".dialog")).indexOf("D:/archive") !== -1, "offered again next time");
});

test("a cancelled folder chooser is the end of it", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })]);
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    assert.equal(query(container, ".dialog"), null);
});

test("the take in progress is never zipped either", async () => {
    const container = await listing("archive", [filed({ sessionId: "s1" })], { state: panelState() });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    assert.equal(panel.host.calls.filter((each) => each.name === "chooseFolder").length, 0);
});

test("packing does not delete unless the dialog was asked to", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: { chooseFolder: () => "D:/archive" }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();

    panel.bridge.sessions = [filed({ sessionId: "a", packing: { done: 0, total: 3 } })];
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("packSessions"), {
        type: "packSessions",
        sessionIds: ["a"],
        folder: "D:/archive",
        deleteAfter: false
    });
    assert.equal(panel.host.calls.filter((each) => each.name === "closeDocumentInPhotoshop").length, 0);
    assert.ok(toasts(container).indexOf(t("pack.started", 1)) !== -1);
});

test("packing that will delete closes the documents first", async () => {
    const closed = [];
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: {
            chooseFolder: () => "D:/archive",
            closeDocumentInPhotoshop: (path, discard) => {
                closed.push({ path, discard });
                return Promise.resolve("ok");
            }
        }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    click(query(container, '.dialog button[role="switch"]'));
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();

    assert.deepEqual(closed, [{ path: "C:/art/dragon.psd", discard: true }]);
    assert.equal(panel.bridge.last("packSessions").deleteAfter, true);
});

test("a document that will not close does not stop the zip", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: {
            chooseFolder: () => "D:/archive",
            closeDocumentInPhotoshop: () => Promise.reject(new Error("It has unsaved changes"))
        }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    click(query(container, '.dialog button[role="switch"]'));
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.ok(panel.bridge.last("packSessions"));
});

test("a recording with no file to close is simply zipped", async () => {
    const container = await listing("archive", [filed({ sessionId: "a", filePathHistory: [] })], {
        host: { chooseFolder: () => "D:/archive" }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    click(query(container, '.dialog button[role="switch"]'));
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.equal(panel.host.calls.filter((each) => each.name === "closeDocumentInPhotoshop").length, 0);
    assert.ok(panel.bridge.last("packSessions"));
});

test("packing the dialog cancels changes nothing", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: { chooseFolder: () => "D:/archive" }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    click(byText(query(container, ".dialog"), t("export.cancel")));
    await dom.flush();
    assert.equal(query(container, ".dialog"), null);
    assert.equal(panel.bridge.sent("packSessions").length, 0);
});

test("a zip the generator refuses is said out loud", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: { chooseFolder: () => "D:/archive" }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    panel.bridge.reply = () => ({ ok: false, error: "D:/archive is full" });
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.deepEqual(toasts(container), ["D:/archive is full"]);
});

test("a zip that queued nothing says nothing about starting", async () => {
    const container = await listing("archive", [filed({ sessionId: "a" })], {
        host: { chooseFolder: () => "D:/archive" }
    });
    await tick(container, ["dragon"]);
    click(bulkButton(container, t("archive.pack")));
    await dom.flush();
    panel.bridge.reply = () => ({ ok: true, sessions: [], warnings: ["a is already zipped"] });
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.deepEqual(toasts(container), ["a is already zipped"]);
});
