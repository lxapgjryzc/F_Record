/**
 * Turning a recording into a video, and the canvas into something pasteable.
 *
 * These are the two places the panel does real work itself rather than asking
 * the generator to. They share a shape: pause the recording first (ffmpeg and
 * the capture loop would otherwise fight over the CPU, and writing the still
 * touches the document, which an unpaused generator would file away as a real
 * frame), do the work, then put everything back whatever happened.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { byText, choose, click, query, queryAll, textOf } from "./dom.mjs";
import { panelState, sessionRow } from "./panel-harness.mjs";
import { bootPanel } from "./app-harness.mjs";

const { dom, panel, disk, openPanel, t } = await bootPanel(mock);

const FRAMES = ["000001_1700000000000.jpg", "000002_1700000001000.jpg"];
const FOLDER = "C:/frames/s1";

const toasts = (container) => queryAll(container, ".toast").map((toast) => textOf(query(toast, ".toast-text")));
const actionRow = (container) => queryAll(container, ".record-actions button");
const exportButton = (container) => actionRow(container)[1];
const copyButton = (container) => actionRow(container)[0];
const selectFor = (container, key) => query(container, 'select[aria-label="' + t(key) + '"]');

/** Opens the panel with frames on disk and, by default, a place to save to. */
function withFrames(options = {}) {
    const savePath = options.savePath === undefined ? "D:/out.mp4" : options.savePath;
    return openPanel(options.state || panelState(), {
        folders: options.folders || { [FOLDER]: options.frames || FRAMES },
        host: { chooseSavePath: () => savePath, ...(options.host || {}) }
    });
}

/** Clicks Export, confirms the dialog, and lets the promises settle. */
async function runExport(container, pick) {
    click(exportButton(container));
    await dom.flush();
    if (pick) {
        pick(container);
    }
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    return panel.media.exports[panel.media.exports.length - 1] || null;
}

/* -------------------------------------------------------------- the dialog */

test("Export opens a dialog about the recording in front", async () => {
    const container = await withFrames();
    click(exportButton(container));
    await dom.flush();
    assert.ok(query(container, ".dialog"), "nothing has happened yet");
    assert.equal(panel.media.exports.length, 0);

    click(byText(container, t("export.cancel")));
    await dom.flush();
    assert.equal(query(container, ".dialog"), null, "and backing out leaves no trace");
});

test("what the dialog offers is what the last export was confirmed with", async () => {
    const container = await withFrames({
        state: panelState({
            config: {
                ...panelState().config,
                exportDefaults: { aspectRatio: 1.7778, targetDurationSec: 30 }
            },
            session: { ...panelState().session, frameCount: 30 * 600 }
        })
    });
    click(exportButton(container));
    await dom.flush();
    assert.equal(selectFor(container, "export.aspect").value, "1.7778");
    assert.equal(selectFor(container, "export.duration").value, "30");
});

test("a choice that changed is remembered; one that did not costs no write", async () => {
    const stored = { aspectRatio: 0, targetDurationSec: null };
    const container = await withFrames({
        state: panelState({ config: { ...panelState().config, exportDefaults: stored } })
    });

    (await runExport(container)).resolve();
    await dom.flush();
    assert.equal(panel.bridge.sent("setConfig").length, 0, "the same settings again rewrite nothing");

    await runExport(container, (root) => choose(selectFor(root, "export.aspect"), "0.5625"));
    assert.deepEqual(panel.bridge.last("setConfig").patch, {
        exportDefaults: { aspectRatio: 0.5625, targetDurationSec: null }
    });
});

test("with no config to compare against, the choice is stored either way", async () => {
    const container = await withFrames({ state: panelState({ config: { ...panelState().config, exportDefaults: null } }) });
    await runExport(container);
    assert.ok(panel.bridge.last("setConfig"));
});

/* ------------------------------------------------------------- the export */

test("a cancelled Save As stops there, without pausing anything", async () => {
    const container = await withFrames({ savePath: null });
    await runExport(container);
    assert.equal(panel.media.exports.length, 0);
    assert.equal(panel.bridge.sent("pause").length, 0, "the recording was never interrupted");
    assert.deepEqual(toasts(container), []);
});

test("the file is offered under the document's name, as an mp4", async () => {
    const container = await withFrames();
    await runExport(container);
    const call = panel.host.calls.filter((each) => each.name === "chooseSavePath").pop();
    assert.deepEqual(call.args, [t("export.title"), "dragon.mp4"]);
});

test("a folder with no frames in it is said out loud rather than encoded", async () => {
    const container = await withFrames({ frames: ["notes.txt"] });
    await runExport(container);
    assert.deepEqual(toasts(container), [t("export.noFrames")]);
    assert.equal(panel.media.exports.length, 0);
});

test("a folder that cannot be read is no frames, not a crash", async () => {
    const container = await withFrames({ folders: {} });
    await runExport(container);
    assert.deepEqual(toasts(container), [t("export.noFrames")]);
});

test("the frames come from the folder listing, not from a counter", async () => {
    // Deliberately: a stale count in session.json must never make the export
    // skip a frame or demand one that is not there.
    const container = await withFrames({
        frames: ["000002_1700000001000.jpg", "000001_1700000000000.jpg", "session.json"]
    });
    const job = await runExport(container);
    assert.deepEqual(job.request.frames, [
        "C:\\frames\\s1\\000001_1700000000000.jpg",
        "C:\\frames\\s1\\000002_1700000001000.jpg"
    ]);
});

test("capturing stops while ffmpeg runs, and starts again afterwards", async () => {
    const container = await withFrames();
    const job = await runExport(container);
    assert.deepEqual(panel.bridge.last("pause"), { type: "pause", reason: "Exporting" });
    assert.equal(panel.bridge.sent("resume").length, 0, "not until it is done");

    job.resolve();
    await dom.flush();
    assert.equal(panel.bridge.sent("resume").length, 1);
});

test("exporting an old recording with no generator running is fine", async () => {
    const container = await withFrames();
    panel.bridge.reply = () => {
        throw new Error("Not connected");
    };
    const job = await runExport(container);
    assert.ok(job, "there was nothing to pause, and the export went ahead");

    job.resolve();
    await dom.flush();
    assert.equal(panel.bridge.sent("resume").length, 0, "and nothing to put back");
});

test("a resume the generator refuses is not worth a word to the artist", async () => {
    // The panel reconnects and shows the real state; a toast about it would
    // be noise on top of an export that worked.
    const container = await withFrames();
    const job = await runExport(container);
    panel.bridge.reply = (command) => {
        if (command.type === "resume") {
            throw new Error("Gone");
        }
        return { ok: true };
    };
    job.resolve();
    await dom.flush();
    assert.deepEqual(toasts(container), [t("export.started"), t("export.done")]);
});

test("the recording in front gets a closing frame of the canvas as it stands", async () => {
    const container = await withFrames();
    const job = await runExport(container);
    assert.ok(job.request.finalImagePath, "the bookend");
    assert.ok(panel.made.length > 0, "and a folder to put it in");
});

test("a bookend that cannot be written is a flourish missed, not an export lost", async () => {
    const container = await withFrames({ host: { writeFinalStill: () => Promise.resolve("noDocument") } });
    const job = await runExport(container);
    assert.equal(job.request.finalImagePath, null);

    const thrown = await withFrames({
        host: { writeFinalStill: () => Promise.reject(new Error("Photoshop is busy")) }
    });
    const second = await runExport(thrown);
    assert.equal(second.request.finalImagePath, null);
    assert.ok(second, "and the export still ran");
});

test("an old recording from the listing gets no bookend, because it is not open", async () => {
    const container = await openPanel(panelState({ session: null }), {
        folders: { "C:/frames/old": FRAMES },
        sessions: [sessionRow({ sessionId: "old", folder: "C:/frames/old" })],
        host: { chooseSavePath: () => "D:/out.mp4" }
    });
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    click(query(container, 'button[aria-label="' + t("sessions.export") + '"]'));
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();

    const job = panel.media.exports.pop();
    assert.equal(job.request.finalImagePath, null);
    assert.equal(panel.host.calls.filter((each) => each.name === "writeFinalStill").length, 0);
});

test("with no aspect chosen, the canvas decides -- and a broken canvas decides nothing", async () => {
    const square = await withFrames();
    const job = await runExport(square);
    assert.equal(job.request.aspectRatio, 800 / 600);

    const chosen = await withFrames();
    const picked = await runExport(chosen, (root) => choose(selectFor(root, "export.aspect"), "0.5625"));
    assert.equal(picked.request.aspectRatio, 0.5625);

    const flat = await withFrames({
        state: panelState({
            document: { ...panelState().document, bounds: { top: 0, left: 0, right: 0, bottom: 600 } }
        })
    });
    assert.equal((await runExport(flat)).request.aspectRatio, 0);
});

test("a recording with no canvas remembered exports at whatever ffmpeg makes of it", async () => {
    const container = await openPanel(panelState({ session: null }), {
        folders: { "C:/frames/old": FRAMES },
        sessions: [sessionRow({ sessionId: "old", folder: "C:/frames/old", canvasBounds: null })],
        host: { chooseSavePath: () => "D:/out.mp4" }
    });
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    click(query(container, 'button[aria-label="' + t("sessions.export") + '"]'));
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.equal(panel.media.exports.pop().request.aspectRatio, 0);
});

test("the resolution is the one the recording was made at, and 1080 when it is nonsense", async () => {
    const container = await withFrames({
        state: panelState({ config: { ...panelState().config, resolution: "720" } })
    });
    assert.equal((await runExport(container)).request.resolution, 720);

    const odd = await openPanel(panelState({ session: null }), {
        folders: { "C:/frames/old": FRAMES },
        sessions: [sessionRow({ sessionId: "old", folder: "C:/frames/old", resolution: "auto" })],
        host: { chooseSavePath: () => "D:/out.mp4" }
    });
    click(byText(query(odd, ".tabs"), t("tab.sessions")));
    await dom.flush();
    click(query(odd, 'button[aria-label="' + t("sessions.export") + '"]'));
    await dom.flush();
    click(query(odd, ".dialog button.primary"));
    await dom.flush();
    assert.equal(panel.media.exports.pop().request.resolution, 1080);
});

test("every stage of the encode has words, and a bar that moves", async () => {
    const container = await withFrames();
    const job = await runExport(container);
    assert.equal(textOf(query(container, ".progress-label")), t("export.preparing") + "0%");

    for (const [stage, label] of [
        ["preparing", t("export.preparing")],
        ["encoding", t("export.encoding")],
        ["finishing", t("export.finishing")]
    ]) {
        job.onProgress({ stage, percent: 50 });
        await dom.flush();
        assert.equal(textOf(query(container, ".progress-label")), label + "50%");
    }
});

test("a finished export offers to show you the file", async () => {
    const container = await withFrames();
    const job = await runExport(container);
    job.resolve();
    await dom.flush();

    assert.deepEqual(toasts(container), [t("export.started"), t("export.done")]);
    const opened = [];
    panel.host.openInExplorer = (path) => opened.push(path);
    click(byText(queryAll(container, ".toast").pop(), t("export.open")));
    assert.deepEqual(opened, ["D:/out.mp4"]);
    assert.equal(query(container, ".progress"), null, "and the bar is gone");
});

test("an export that failed says why, and puts the panel back", async () => {
    const container = await withFrames();
    const job = await runExport(container);
    job.reject(new Error("ffmpeg exited with 1"));
    await dom.flush();

    assert.ok(toasts(container).indexOf(t("export.failed") + ": ffmpeg exited with 1") !== -1);
    assert.equal(query(container, ".progress"), null);
    assert.equal(panel.bridge.sent("resume").length, 1, "capturing starts again either way");
});

test("while an export runs, nothing else on the dashboard can be started", async () => {
    const container = await withFrames();
    const job = await runExport(container);
    assert.equal(query(container, ".record-actions"), null, "the buttons are the progress bar now");

    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    assert.equal(query(container, 'button[aria-label="' + t("sessions.refresh") + '"]').disabled, true);
    job.resolve();
    await dom.flush();
});

/* ----------------------------------------------------------- the clipboard */

test("copying signs the canvas with the mark from Settings and hands it over", async () => {
    const container = await openPanel(
        panelState({ config: { ...panelState().config, watermark: { kind: "text", text: "Anna" } } })
    );
    click(copyButton(container));
    await dom.flush();

    assert.equal(panel.media.stills.length, 1);
    assert.deepEqual(panel.media.stills[0].watermark, { kind: "text", text: "Anna" });
    assert.equal(panel.media.clipboard[0].imagePath, panel.media.stills[0].outputPath);
    assert.deepEqual(toasts(container), [t("clipboard.done")]);
});

test("someone who does not want the copy signed gets it unsigned", async () => {
    const container = await openPanel(
        panelState({
            config: {
                ...panelState().config,
                watermark: { kind: "text", text: "Anna" },
                clipboardWatermark: false
            }
        })
    );
    click(copyButton(container));
    await dom.flush();
    assert.equal(panel.media.stills[0].watermark, null, "copy it as it stands");
});

test("a generator too old to know about the setting still signs the copy", async () => {
    const config = { ...panelState().config, watermark: { kind: "text", text: "Anna" } };
    delete config.clipboardWatermark;
    const container = await openPanel(panelState({ config }));
    click(copyButton(container));
    await dom.flush();
    assert.ok(panel.media.stills[0].watermark, "which is the default");
});

test("the copy is cut down to the size chosen in Settings", async () => {
    const container = await openPanel(
        panelState({ config: { ...panelState().config, clipboardResolution: "720" } })
    );
    click(copyButton(container));
    await dom.flush();
    assert.equal(panel.media.stills[0].resolution, "720");
});

test("a generator too old to know about the size gets the 1080p copy the button is for", async () => {
    const config = { ...panelState().config };
    delete config.clipboardResolution;
    const container = await openPanel(panelState({ config }));
    click(copyButton(container));
    await dom.flush();
    assert.equal(panel.media.stills[0].resolution, "1080", "the default, not a full-size copy by accident");
});

test("copying pauses the recording too, and puts it back", async () => {
    const container = await openPanel();
    click(copyButton(container));
    await dom.flush();
    assert.deepEqual(panel.bridge.last("pause"), { type: "pause", reason: "Copying the canvas" });
    assert.equal(panel.bridge.sent("resume").length, 1);
});

test("copying with no generator running is fine; there is nothing to disturb", async () => {
    const container = await openPanel();
    panel.bridge.reply = () => {
        throw new Error("Not connected");
    };
    click(copyButton(container));
    await dom.flush();
    assert.equal(panel.media.clipboard.length, 1);
    assert.equal(panel.bridge.sent("resume").length, 0);
});

test("a resume refused after a copy is not worth a word either", async () => {
    const container = await openPanel();
    panel.bridge.reply = (command) => {
        if (command.type === "resume") {
            throw new Error("Gone");
        }
        return { ok: true };
    };
    click(copyButton(container));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("clipboard.done")]);
});

test("with nothing open there is nothing to copy, and it says which", async () => {
    const container = await openPanel(panelState(), {
        host: { writeFinalStill: () => Promise.resolve("noDocument") }
    });
    click(copyButton(container));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("clipboard.failed") + ": " + t("doc.none")]);
});

test("a copy that fails anywhere along the way says so and lets go", async () => {
    const container = await openPanel();
    panel.media.copyFails = new Error("The clipboard helper is missing");
    click(copyButton(container));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("clipboard.failed") + ": The clipboard helper is missing"]);
    assert.equal(copyButton(container).disabled, false, "and the button comes back");
});

test("the scratch files go afterwards, whether or not they were ever there", async () => {
    const container = await openPanel();
    click(copyButton(container));
    await dom.flush();
    assert.equal(disk.unlinked.length, 2, "the still and the marked copy");

    panel.media.stillFails = new Error("ffmpeg is not on the path");
    disk.unlinked.length = 0;
    click(copyButton(container));
    await dom.flush();
    assert.equal(disk.unlinked.length, 2, "and a failed copy tidies up too");
});

test("exporting the take in progress from the listing bookends it like the dashboard does", async () => {
    // The same recording reached a different way is still the same recording.
    const container = await openPanel(panelState(), {
        sessions: [sessionRow({ sessionId: "s1", folder: FOLDER })],
        folders: { [FOLDER]: FRAMES },
        host: { chooseSavePath: () => "D:/out.mp4" }
    });
    click(byText(query(container, ".tabs"), t("tab.sessions")));
    await dom.flush();
    click(query(container, 'button[aria-label="' + t("sessions.export") + '"]'));
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.ok(panel.media.exports.pop().request.finalImagePath, "the canvas as it stands, on the end");
});

test("a Save As dialog that cannot even be opened is reported like any other failure", async () => {
    // The CEP bridge into Photoshop can be gone rather than merely unhelpful,
    // and then the host call throws where every other one returns.
    const container = await withFrames({
        host: {
            chooseSavePath: () => {
                throw new Error("The CEP bridge is gone");
            }
        }
    });
    click(exportButton(container));
    await dom.flush();
    click(query(container, ".dialog button.primary"));
    await dom.flush();
    assert.deepEqual(toasts(container), [t("export.failed") + ": The CEP bridge is gone"]);
});
