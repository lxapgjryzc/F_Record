/**
 * The clean-up, and the two listing effects that keep it honest.
 *
 * The review walks the archive one recording at a time, opening each one's
 * document in Photoshop so the decision is made in front of the picture rather
 * than a name in a list. Nothing is deleted along the way: the decisions are
 * collected and applied together behind one confirmation, so stopping half-way
 * costs nothing and a slip can be discarded whole.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { byText, choose, click, query, queryAll, textOf } from "./dom.mjs";
import { panelState, sessionRow } from "./panel-harness.mjs";
import { bootPanel } from "./app-harness.mjs";

const { dom, panel, openPanel, t } = await bootPanel(mock);

const toasts = (container) => queryAll(container, ".toast").map((toast) => textOf(query(toast, ".toast-text")));
const dialog = (container) => query(container, ".dialog");
const status = (container) => textOf(query(container, ".dialog .hint"));
const choice = (container, key) => byText(query(container, ".review-choices"), t(key));
const filed = (overrides) => sessionRow({ archived: true, ...overrides });

/** Opens the archive and starts a review over it. */
async function review(sessions, options = {}) {
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
    click(byText(query(container, ".tabs"), t("tab.archive")));
    await dom.flush();
    if (options.tick) {
        for (const name of options.tick) {
            choose(query(container, 'input[aria-label="' + t("archive.select", name) + '"]'), true);
            await dom.flush();
        }
    }
    if (options.start !== false) {
        click(byText(query(container, ".toolbar"), t("archive.review")));
        await dom.flush();
    }
    return container;
}

/* ------------------------------------------------------- what it walks */

test("with nothing ticked the review walks the whole archive", async () => {
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    assert.equal(textOf(query(container, ".dialog-title")), t("review.title", 1, 2));
    assert.equal(textOf(query(container, ".review-name")), "dragon");
});

test("with rows ticked the review walks only those", async () => {
    const container = await review(
        [filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })],
        { tick: ["castle"] }
    );
    assert.equal(textOf(query(container, ".dialog-title")), t("review.title", 1, 1));
    assert.equal(textOf(query(container, ".review-name")), "castle");
});

test("the take in progress and anything in transit are left out of it", async () => {
    const container = await review(
        [
            filed({ sessionId: "s1" }),
            filed({ sessionId: "b", docName: "castle", moving: { done: 1, total: 2 } }),
            filed({ sessionId: "c", docName: "forest", packing: { done: 1, total: 2 } }),
            filed({ sessionId: "d", docName: "ocean" })
        ],
        { state: panelState() }
    );
    assert.equal(textOf(query(container, ".dialog-title")), t("review.title", 1, 1));
    assert.equal(textOf(query(container, ".review-name")), "ocean");
});

test("a review with nothing left to look at says so instead of opening empty", async () => {
    const container = await review([filed({ sessionId: "s1" })], { state: panelState() });
    assert.equal(dialog(container), null);
    assert.deepEqual(toasts(container), [t("archive.reviewEmpty")]);
});

/* ------------------------------------------------- opening each document */

test("each recording's document is opened, and the dialog says what happened", async () => {
    const opened = [];
    const container = await review([filed({ sessionId: "a" })], {
        host: {
            openDocumentForReview: (path) => {
                opened.push(path);
                return Promise.resolve("opened");
            }
        }
    });
    assert.deepEqual(opened, ["C:/art/dragon.psd"]);
    assert.equal(status(container), t("review.opened"));
});

test("a document that was already open stays open, and says so", async () => {
    const container = await review([filed({ sessionId: "a" })], {
        host: { openDocumentForReview: () => Promise.resolve("already") }
    });
    assert.equal(status(container), t("review.already"));
});

test("a recording that was never saved has nothing to open", async () => {
    const container = await review([filed({ sessionId: "a", filePathHistory: [] })]);
    assert.equal(status(container), t("review.unsaved"));
    assert.equal(choice(container, "review.deleteWithFile").disabled, true, "and no file to delete");
});

test("a file that has gone says where it last was", async () => {
    const container = await review([filed({ sessionId: "a", filePathHistory: ["C:/art/gone.psd"] })], {
        files: []
    });
    assert.equal(status(container), t("review.missing", "C:/art/gone.psd"));
    assert.equal(choice(container, "review.deleteWithFile").disabled, true);
});

test("Photoshop refusing to open one says so twice: in the dialog and in a toast", async () => {
    const container = await review([filed({ sessionId: "a" })], {
        host: { openDocumentForReview: () => Promise.reject(new Error("Photoshop is not responding")) }
    });
    assert.equal(status(container), t("review.failed"));
    assert.deepEqual(toasts(container), ["Photoshop is not responding"]);
    assert.equal(choice(container, "review.deleteWithFile").disabled, true);
});

test("while Photoshop is opening one, nothing can be decided about it", async () => {
    let release = null;
    const container = await review([filed({ sessionId: "a" })], {
        host: {
            openDocumentForReview: () => new Promise((resolve) => {
                release = resolve;
            })
        }
    });
    assert.equal(status(container), t("review.opening"));
    for (const key of ["review.keep", "review.delete", "review.deleteWithFile"]) {
        assert.equal(choice(container, key).disabled, true, key);
    }
    assert.equal(byText(query(container, ".dialog-actions"), t("review.stop")).disabled, true);

    release("opened");
    await dom.flush();
    assert.equal(choice(container, "review.keep").disabled, false);
});

test("a recording the listing no longer has is still shown, by its id", async () => {
    const container = await review([filed({ sessionId: "a" })]);
    panel.bridge.pushState(panelState({ session: null }));
    await dom.flush();
    assert.equal(textOf(query(container, ".review-name")), "dragon", "the listing still has it");
});

/* ---------------------------------------------------------- deciding */

test("keeping one moves on to the next, and closes what was opened", async () => {
    const closed = [];
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })], {
        host: {
            closeDocumentInPhotoshop: (path, discard) => {
                closed.push({ path, discard });
                return Promise.resolve("ok");
            }
        }
    });
    click(choice(container, "review.keep"));
    await dom.flush();

    assert.deepEqual(closed, [{ path: "C:/art/dragon.psd", discard: false }]);
    assert.equal(textOf(query(container, ".review-name")), "castle");
    assert.equal(textOf(query(container, ".dialog-title")), t("review.title", 2, 2));
    assert.equal(query(container, ".dialog .hint + .hint"), null, "and nothing has been marked yet");
});

test("a running tally appears once something has been marked", async () => {
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    click(choice(container, "review.delete"));
    await dom.flush();
    assert.ok(textOf(dialog(container)).indexOf(t("review.soFar", 1, 0)) !== -1);
});

test("deleting with the file closes the document without saving", async () => {
    // The file is going to the bin; keeping the unsaved changes would mean
    // Photoshop writing back a file that is about to disappear.
    const closed = [];
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })], {
        host: {
            closeDocumentInPhotoshop: (path, discard) => {
                closed.push({ path, discard });
                return Promise.resolve("ok");
            }
        }
    });
    click(choice(container, "review.deleteWithFile"));
    await dom.flush();
    assert.deepEqual(closed, [{ path: "C:/art/dragon.psd", discard: true }]);
});

test("a document nothing opened is not closed on the way past", async () => {
    const container = await review(
        [filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })],
        { host: { openDocumentForReview: () => Promise.resolve("already") } }
    );
    click(choice(container, "review.keep"));
    await dom.flush();
    assert.equal(
        panel.host.calls.filter((each) => each.name === "closeDocumentInPhotoshop").length,
        0,
        "it was open before the review started, and stays open"
    );
});

test("a document Photoshop will not close does not stop the review", async () => {
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })], {
        host: { closeDocumentInPhotoshop: () => Promise.reject(new Error("It is busy")) }
    });
    click(choice(container, "review.keep"));
    await dom.flush();
    assert.equal(textOf(query(container, ".review-name")), "castle");
});

test("a recording that left the listing mid-review closes nothing and moves on", async () => {
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    panel.bridge.sessions = [filed({ sessionId: "b", docName: "castle" })];
    click(byText(query(container, ".tabs"), t("tab.archive")));
    await dom.flush();

    click(choice(container, "review.keep"));
    await dom.flush();
    assert.equal(textOf(query(container, ".review-name")), "castle");
});

test("changing your mind back to keep takes the mark off again", async () => {
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    click(choice(container, "review.delete"));
    await dom.flush();
    click(byText(query(container, ".dialog-actions"), t("review.stop")));
    await dom.flush();
    assert.ok(textOf(dialog(container)).indexOf(t("review.summary", 1, 0)) !== -1);

    // And the same walk again, keeping it this time.
    click(byText(query(container, ".dialog-actions"), t("review.discard")));
    await dom.flush();
    click(byText(query(container, ".toolbar"), t("archive.review")));
    await dom.flush();
    click(choice(container, "review.delete"));
    await dom.flush();
    click(choice(container, "review.keep"));
    await dom.flush();
    assert.ok(textOf(dialog(container)).indexOf(t("review.summary", 1, 0)) !== -1, "only the first one is marked");
});

test("a click while the next document is opening is not a decision", async () => {
    let release = null;
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })], {
        host: {
            openDocumentForReview: () =>
                release === null
                    ? Promise.resolve("opened")
                    : new Promise((resolve) => {
                          release = resolve;
                      })
        }
    });
    release = () => {};
    click(choice(container, "review.delete"));
    await dom.flush();
    assert.equal(choice(container, "review.keep").disabled, true, "still opening the next one");
});

/* --------------------------------------------------------- the summary */

test("the last recording ends the walk and offers what was decided", async () => {
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    click(choice(container, "review.delete"));
    await dom.flush();
    click(choice(container, "review.deleteWithFile"));
    await dom.flush();

    assert.equal(textOf(query(container, ".dialog-title")), t("review.summaryTitle"));
    assert.ok(textOf(dialog(container)).indexOf(t("review.summary", 2, 1)) !== -1);
});

test("stopping half-way is not a decision, and loses nothing", async () => {
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    click(choice(container, "review.delete"));
    await dom.flush();
    click(byText(query(container, ".dialog-actions"), t("review.stop")));
    await dom.flush();
    assert.equal(textOf(query(container, ".dialog-title")), t("review.summaryTitle"));
    assert.ok(textOf(dialog(container)).indexOf(t("review.summary", 1, 0)) !== -1);
});

test("stopping while a document is opening does nothing", async () => {
    let release = null;
    const container = await review([filed({ sessionId: "a" })], {
        host: {
            openDocumentForReview: () => new Promise((resolve) => {
                release = resolve;
            })
        }
    });
    // The Stop button is off while it waits, so the only way to ask is the
    // scrim -- and that has to be a no-op too.
    click(query(container, ".dialog-scrim"));
    await dom.flush();
    assert.equal(textOf(query(container, ".dialog-title")), t("review.title", 1, 1));
    release("opened");
    await dom.flush();
});

test("a review where nothing was marked offers only to be dismissed", async () => {
    const container = await review([filed({ sessionId: "a" })]);
    click(choice(container, "review.keep"));
    await dom.flush();
    assert.ok(textOf(dialog(container)).indexOf(t("review.summaryNone")) !== -1);
    assert.equal(byText(query(container, ".dialog-actions"), t("review.apply")), null);

    click(byText(query(container, ".dialog-actions"), t("common.dismiss")));
    await dom.flush();
    assert.equal(dialog(container), null);
    assert.equal(panel.bridge.sent("deleteSessions").length, 0);
});

test("discarding a review deletes nothing, however much was marked", async () => {
    const container = await review([filed({ sessionId: "a" })]);
    click(choice(container, "review.deleteWithFile"));
    await dom.flush();
    click(byText(query(container, ".dialog-actions"), t("review.discard")));
    await dom.flush();
    assert.equal(dialog(container), null);
    assert.equal(panel.bridge.sent("deleteSessions").length, 0);
});

test("applying deletes exactly what was marked, files and all", async () => {
    const container = await review(
        [
            filed({ sessionId: "a" }),
            filed({ sessionId: "b", docName: "castle" }),
            filed({ sessionId: "c", docName: "forest" })
        ]
    );
    click(choice(container, "review.deleteWithFile"));
    await dom.flush();
    click(choice(container, "review.keep"));
    await dom.flush();
    click(choice(container, "review.delete"));
    await dom.flush();

    panel.bridge.sessions = [filed({ sessionId: "b", docName: "castle" })];
    click(byText(query(container, ".dialog-actions"), t("review.apply")));
    await dom.flush();

    assert.deepEqual(panel.bridge.last("deleteSessions").items, [
        { sessionId: "a", withDocument: true },
        { sessionId: "c", withDocument: false }
    ]);
    assert.equal(dialog(container), null, "and the review is over");
    assert.ok(toasts(container).indexOf(t("archive.deleted", 2)) !== -1);
});

/* ------------------------------------------------- the listing's own news */

test("a folder on the move is chased until it lands, then said out loud", async (context) => {
    // The generator reports progress only through the listing, so the panel
    // keeps asking while any row says it is busy.
    const container = await review([filed({ sessionId: "a" })], { start: false });

    // Only setInterval, so flushing effects can still wait on a real timer.
    mock.timers.enable({ apis: ["setInterval"] });
    context.after(() => mock.timers.reset());

    panel.bridge.sessions = [filed({ sessionId: "a", moving: { done: 1, total: 4, to: "C:/art/dragon frames" } })];
    click(query(container, 'button[aria-label="' + t("sessions.refresh") + '"]'));
    await dom.flush();
    assert.ok(query(container, ".progress"), "a bar while it moves");

    const before = panel.bridge.sent("listSessions").length;
    mock.timers.tick(1000);
    assert.equal(panel.bridge.sent("listSessions").length, before + 1, "and it keeps asking");

    panel.bridge.sessions = [filed({ sessionId: "a", folder: "C:/art/dragon frames" })];
    mock.timers.tick(1000);
    for (let round = 0; round < 8; round++) {
        await Promise.resolve();
        dom.runEffects();
    }
    assert.ok(toasts(container).indexOf(t("sessions.moved", "C:/art/dragon frames")) !== -1);
    assert.equal(query(container, ".progress"), null, "and the bar has gone with it");
});

test("a move that ended up back where it started failed, and says nothing", async () => {
    // The generator has already reported the failure through the log; a
    // cheerful "moved" on top of it would be a lie.
    const container = await review([filed({ sessionId: "a", folder: "C:/frames/s1" })], { start: false });
    panel.bridge.sessions = [filed({ sessionId: "a", moving: { done: 1, total: 4, to: "C:/art/dragon frames" } })];
    click(query(container, 'button[aria-label="' + t("sessions.refresh") + '"]'));
    await dom.flush();

    panel.bridge.sessions = [filed({ sessionId: "a", folder: "C:/frames/s1" })];
    click(query(container, 'button[aria-label="' + t("sessions.refresh") + '"]'));
    await dom.flush();
    assert.deepEqual(toasts(container), []);
});

test("a batch of zips gets one word when the last one lands, and a way to see them", async () => {
    const container = await review([filed({ sessionId: "a" })], {
        start: false,
        host: { chooseFolder: () => "D:/archive" }
    });
    choose(query(container, 'input[aria-label="' + t("archive.select", "dragon") + '"]'), true);
    await dom.flush();
    click(byText(query(container, ".toolbar.bulk"), t("archive.pack")));
    await dom.flush();

    panel.bridge.sessions = [filed({ sessionId: "a", packing: { done: 0, total: 3 } })];
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.ok(toasts(container).indexOf(t("pack.started", 1)) !== -1);

    panel.bridge.sessions = [filed({ sessionId: "a" })];
    click(query(container, 'button[aria-label="' + t("sessions.refresh") + '"]'));
    await dom.flush();
    assert.ok(toasts(container).indexOf(t("pack.done", 1, "D:/archive")) !== -1);

    const opened = [];
    panel.host.openInExplorer = (folder) => opened.push(folder);
    click(byText(queryAll(container, ".toast").pop(), t("export.open")));
    assert.deepEqual(opened, ["D:/archive"]);
});

test("the recording being made can be reviewed once it is filed, and closes normally", async () => {
    // Its row is only left out of a review while it is the take in progress;
    // once the generator has moved on it is an archive row like any other.
    const closed = [];
    const container = await review([filed({ sessionId: "s1" }), filed({ sessionId: "b", docName: "castle" })], {
        host: {
            closeDocumentInPhotoshop: (path, discard) => {
                closed.push({ path, discard });
                return Promise.resolve("ok");
            }
        }
    });
    assert.equal(textOf(query(container, ".dialog-title")), t("review.title", 1, 2));

    click(choice(container, "review.keep"));
    await dom.flush();
    assert.deepEqual(closed, [{ path: "C:/art/dragon.psd", discard: false }]);
});

test("a recording that leaves the listing while it is in front closes nothing", async () => {
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })]);
    panel.bridge.sessions = [];
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    click(byText(query(container, ".tabs"), t("tab.archive")));
    await dom.flush();

    click(choice(container, "review.keep"));
    await dom.flush();
    assert.equal(
        panel.host.calls.filter((each) => each.name === "closeDocumentInPhotoshop").length,
        0,
        "there is no longer a recording to say which file that was"
    );
});

test("a host that throws while opening the next document is reported, not swallowed", async () => {
    let first = true;
    const container = await review([filed({ sessionId: "a" }), filed({ sessionId: "b", docName: "castle" })], {
        host: {
            openDocumentForReview: () => {
                if (first) {
                    first = false;
                    return Promise.resolve("opened");
                }
                throw new Error("The CEP bridge is gone");
            }
        }
    });
    click(choice(container, "review.keep"));
    await dom.flush();
    assert.deepEqual(toasts(container), ["The CEP bridge is gone"]);
});
