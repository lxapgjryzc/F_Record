/**
 * The panel's side of CEP: CSInterface, CSEvent and window.cep.
 *
 * None of it exists outside Photoshop, and all of it is reached through
 * globals -- which is exactly what makes it testable here: the test can be
 * CSInterface for the length of one assertion. What is worth pinning down is
 * the same thing everywhere in this file: a host that does not answer, or an
 * API an older CEP never had, must cost the feature and never the panel. A
 * throw out of any of these lands in a preact render.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { asPlatform, clearFaults, mockBuiltins, setFault } from "./helpers.mjs";

mockBuiltins(mock, "child_process");
const psHost = await import("../dist/modules/psHost.mjs");

/**
 * The CSInterface the module will use for the rest of this file.
 *
 * It is constructed once and cached inside the module, so the test changes
 * this object's behaviour rather than handing over a new one.
 */
const host = {
    environment: null,
    listeners: [],
    dispatched: [],
    scripts: [],
    reply: () => "",
    getHostEnvironment() {
        if (this.environment === null) {
            throw new Error("the host is not answering");
        }
        return this.environment;
    },
    addEventListener(type, handler) {
        if (this.listeners === null) {
            throw new Error("events are not available");
        }
        this.listeners.push({ type, handler });
    },
    dispatchEvent(event) {
        this.dispatched.push(event);
    },
    getApplicationID: () => "PHXS",
    getExtensionID: () => "com.F_know.F_Record.panel",
    evalScript(script, callback) {
        this.scripts.push(script);
        const answer = this.reply(script);
        if (answer instanceof Error) {
            throw answer;
        }
        callback(answer);
    }
};

globalThis.CSInterface = function () {
    return host;
};
globalThis.CSEvent = function () {
    return {};
};

function skin(red, green, blue) {
    return { appSkinInfo: { panelBackgroundColor: { color: { red, green, blue } } } };
}

/** Stands in for the `window.cep` CEP puts on the panel's global. */
function withCep(cep, body) {
    const saved = globalThis.window;
    globalThis.window = cep === null ? undefined : { cep };
    try {
        return body();
    } finally {
        if (saved === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = saved;
        }
    }
}

/* ------------------------------------------------------------------ theme */

test("the panel follows Photoshop's brightness, by luminance rather than by exact match", () => {
    // Photoshop ships four UI brightness levels and the exact values have
    // changed between releases; the two darker ones need the dark palette.
    host.environment = skin(50, 50, 50);
    assert.deepEqual(psHost.readHostTheme(), { dark: true, background: "rgb(50,50,50)" });

    host.environment = skin(240, 240, 240);
    assert.deepEqual(psHost.readHostTheme(), { dark: false, background: "rgb(240,240,240)" });

    // Green weighs most in the luminance formula, so a colour whose channels
    // average 77 is still a light theme.
    host.environment = skin(0, 230, 0);
    assert.equal(psHost.readHostTheme().dark, false);
    host.environment = skin(0, 200, 0);
    assert.equal(psHost.readHostTheme().dark, true, "and just under the line it is not");

    host.environment = skin(120.6, 120.4, 120.5);
    assert.equal(psHost.readHostTheme().background, "rgb(121,120,121)", "reported as whole channels");
});

test("a host that will not describe itself gets the dark palette", () => {
    // Dark is what Photoshop ships with, so it is the better guess -- and a
    // panel that throws here renders nothing at all.
    host.environment = null;
    assert.deepEqual(psHost.readHostTheme(), { dark: true, background: "rgb(50,50,50)" });
});

test("Photoshop's own UI language drives the auto setting, when it says", () => {
    host.environment = { appUILocale: "ja_JP" };
    assert.equal(psHost.hostUiLocale(), "ja_JP");

    host.environment = { appUILocale: "" };
    assert.equal(psHost.hostUiLocale(), null, "an empty string is not an answer");

    host.environment = { appUILocale: 7 };
    assert.equal(psHost.hostUiLocale(), null);

    host.environment = null;
    assert.equal(psHost.hostUiLocale(), null, "and a host that will not say is not an error");
});

test("theme changes are subscribed to where the host allows it", () => {
    host.listeners = [];
    psHost.onThemeChanged(() => {});
    assert.equal(host.listeners.length, 1);
    assert.equal(host.listeners[0].type, "com.adobe.csxs.events.ThemeColorChanged");

    // Cosmetic: a CEP that refuses the subscription must not stop the panel.
    host.listeners = null;
    psHost.onThemeChanged(() => {});
    host.listeners = [];
});

/* -------------------------------------------------------------- lifecycle */

test("the panel asks to stay loaded, and a host that will not is not a failure", () => {
    host.dispatched = [];
    psHost.makePanelPersistent();

    assert.equal(host.dispatched.length, 1);
    assert.equal(host.dispatched[0].type, "com.adobe.PhotoshopPersistent");
    assert.equal(host.dispatched[0].scope, "APPLICATION");
    assert.equal(host.dispatched[0].appId, "PHXS");

    const saved = globalThis.CSEvent;
    globalThis.CSEvent = function () {
        throw new Error("older hosts have no CSEvent");
    };
    try {
        psHost.makePanelPersistent();
    } finally {
        globalThis.CSEvent = saved;
    }
});

/* ----------------------------------------------------------- extendscript */

test("a script that runs gives its answer back", async () => {
    host.reply = () => "yes";
    assert.equal(await psHost.evalScript("$.f_record.hasDocument()"), "yes");
});

test("ExtendScript's own failure marker becomes an error with words in it", async () => {
    // "EvalScript_ErrMessage" is what CEP returns for a script that threw, and
    // it is the whole of what it returns -- there is no detail to pass on.
    host.reply = () => "EvalScript_ErrMessage";
    await assert.rejects(psHost.evalScript("$.f_record.hasDocument()"), /Photoshop could not run the script/);
});

test("a host that throws on the way in is reported, whatever it threw", async () => {
    host.reply = () => new Error("the script engine is busy");
    await assert.rejects(psHost.evalScript("x"), /the script engine is busy/);

    host.reply = () => {
        // eslint-disable-next-line no-throw-literal
        throw "not an Error at all";
    };
    await assert.rejects(psHost.evalScript("x"), /not an Error at all/);
    host.reply = () => "";
});

test("a path is escaped before it goes into an ExtendScript string literal", async () => {
    host.scripts = [];
    host.reply = () => "ok";
    await psHost.writeFinalStill("C:" + String.fromCharCode(92) + "art\\it's (a) final!.jpg");

    // Single quotes delimit the literal, and encodeURIComponent leaves !'()*
    // alone -- so a document called "it's (a) final!" would otherwise close the
    // string and run whatever followed.
    const script = host.scripts[0];
    assert.equal((script.match(/'/g) || []).length, 2, "exactly the two delimiters");
    assert.ok(script.indexOf("%27") !== -1, "the apostrophe was encoded");
    assert.ok(script.indexOf("%28") !== -1 && script.indexOf("%29") !== -1, "and the brackets");
    assert.ok(script.indexOf("%21") !== -1, "and the bang");
});

test("the still writer passes on what Photoshop said, and refuses what it did not", async () => {
    host.reply = () => "ok";
    assert.equal(await psHost.writeFinalStill("C:/a.jpg"), "ok");

    host.reply = () => "no-document";
    assert.equal(await psHost.writeFinalStill("C:/a.jpg"), "no-document");

    host.reply = () => "error:the disk is full";
    await assert.rejects(psHost.writeFinalStill("C:/a.jpg"), /^Error: the disk is full$/);

    host.reply = () => "";
    await assert.rejects(psHost.writeFinalStill("C:/a.jpg"), /Could not export the final image/);
});

test("asking whether a document is open is never a reason to throw", async () => {
    host.reply = () => "yes";
    assert.equal(await psHost.hasOpenDocument(), true);

    host.reply = () => "no";
    assert.equal(await psHost.hasOpenDocument(), false);

    // The panel asks this to decide whether to enable a button; a Photoshop
    // that is mid-dialog and will not answer means "no", not a broken panel.
    host.reply = () => "EvalScript_ErrMessage";
    assert.equal(await psHost.hasOpenDocument(), false);
});

test("opening a document reports what happened, and anything else is an error", async () => {
    host.reply = () => "ok";
    assert.equal(await psHost.openDocumentInPhotoshop("C:/a.psd"), "ok");
    host.reply = () => "missing";
    assert.equal(await psHost.openDocumentInPhotoshop("C:/a.psd"), "missing");
    host.reply = () => "error:it is locked";
    await assert.rejects(psHost.openDocumentInPhotoshop("C:/a.psd"), /it is locked/);
    host.reply = () => "";
    await assert.rejects(psHost.openDocumentInPhotoshop("C:/a.psd"), /Could not open the document/);
});

test("the review opener says whether it opened the document or found it open", async () => {
    // The clean-up review closes behind itself only what it opened, so this
    // distinction is the whole reason it exists as its own call.
    for (const outcome of ["opened", "already", "missing"]) {
        host.reply = () => outcome;
        assert.equal(await psHost.openDocumentForReview("C:/a.psd"), outcome);
    }
    host.reply = () => "error:no";
    await assert.rejects(psHost.openDocumentForReview("C:/a.psd"), /^Error: no$/);
    host.reply = () => "";
    await assert.rejects(psHost.openDocumentForReview("C:/a.psd"), /Could not open the document/);
});

test("closing says whether the user backed out of the save prompt", async () => {
    host.scripts = [];
    for (const outcome of ["ok", "not-open", "cancelled"]) {
        host.reply = () => outcome;
        assert.equal(await psHost.closeDocumentInPhotoshop("C:/a.psd", false), outcome);
    }
    assert.ok(host.scripts[0].endsWith(", false)"), "the discard flag goes over as a boolean literal");

    host.reply = () => "ok";
    await psHost.closeDocumentInPhotoshop("C:/a.psd", true);
    assert.ok(host.scripts[host.scripts.length - 1].endsWith(", true)"));

    host.reply = () => "error:it would not close";
    await assert.rejects(psHost.closeDocumentInPhotoshop("C:/a.psd", true), /it would not close/);
    host.reply = () => "";
    await assert.rejects(psHost.closeDocumentInPhotoshop("C:/a.psd", true), /Could not close the document/);
});

test("switching documents reports a cancelled dialog rather than claiming success", async () => {
    for (const outcome of ["ok", "missing", "cancelled"]) {
        host.reply = () => outcome;
        assert.equal(await psHost.switchToDocumentInPhotoshop("C:/a.psd"), outcome);
    }
    host.reply = () => "error:no";
    await assert.rejects(psHost.switchToDocumentInPhotoshop("C:/a.psd"), /^Error: no$/);
    host.reply = () => "";
    await assert.rejects(psHost.switchToDocumentInPhotoshop("C:/a.psd"), /Could not switch documents/);
});

/* ---------------------------------------------------------------- dialogs */

test("the folder picker returns what the user chose, and nothing when they did not", () => {
    const calls = [];
    const dialog = (result) => ({
        fs: {
            showOpenDialog(...args) {
                calls.push(args);
                if (result instanceof Error) {
                    throw result;
                }
                return result;
            }
        }
    });

    withCep(dialog({ err: 0, data: ["C:/frames"] }), () => {
        assert.equal(psHost.chooseFolder("Pick a folder", "C:/"), "C:/frames");
    });
    assert.deepEqual(calls[0].slice(0, 2), [false, true], "folders, not files");

    // Cancelled, refused, and a CEP too old to have the dialog at all.
    withCep(dialog({ err: 0, data: [] }), () => assert.equal(psHost.chooseFolder("t", "C:/"), null));
    withCep(dialog({ err: 2, data: ["C:/x"] }), () => assert.equal(psHost.chooseFolder("t", "C:/"), null));
    withCep(dialog({ err: 0 }), () => assert.equal(psHost.chooseFolder("t", "C:/"), null));
    withCep(dialog(new Error("no dialogs here")), () => assert.equal(psHost.chooseFolder("t", "C:/"), null));
    withCep(null, () => assert.equal(psHost.chooseFolder("t", "C:/"), null));
});

test("the watermark picker offers the formats that keep their transparency first", () => {
    const calls = [];
    const cep = {
        fs: {
            showOpenDialog(...args) {
                calls.push(args);
                return { err: 0, data: ["C:/logo.png"] };
            }
        }
    };
    withCep(cep, () => {
        assert.equal(psHost.chooseImageFile("Pick a logo", "C:/"), "C:/logo.png");
    });
    assert.deepEqual(calls[0].slice(0, 2), [false, false], "a file, not a folder");
    assert.equal(calls[0][4][0], "png", "PNG first: it is the one that keeps alpha");

    withCep({ fs: { showOpenDialog: () => ({ err: 0, data: [] }) } }, () =>
        assert.equal(psHost.chooseImageFile("t", "C:/"), null)
    );
    withCep(null, () => assert.equal(psHost.chooseImageFile("t", "C:/"), null));
});

test("the save picker suggests a name and asks only for mp4", () => {
    const calls = [];
    withCep(
        {
            fs: {
                showSaveDialogEx(...args) {
                    calls.push(args);
                    return { err: 0, data: "C:/out/dragon.mp4" };
                }
            }
        },
        () => assert.equal(psHost.chooseSavePath("Save video", "dragon.mp4"), "C:/out/dragon.mp4")
    );
    assert.deepEqual(calls[0][2], ["mp4"]);
    assert.equal(calls[0][3], "dragon.mp4");

    withCep({ fs: { showSaveDialogEx: () => ({ err: 0, data: "" }) } }, () =>
        assert.equal(psHost.chooseSavePath("t", "a.mp4"), null)
    );
    withCep({ fs: { showSaveDialogEx: () => ({ err: 2, data: "C:/x" }) } }, () =>
        assert.equal(psHost.chooseSavePath("t", "a.mp4"), null)
    );
    withCep(null, () => assert.equal(psHost.chooseSavePath("t", "a.mp4"), null));
});

/* ------------------------------------------------------------ the shell */

test("revealing a file uses the shell each platform actually has", (t) => {
    t.after(clearFaults);
    const commands = [];
    setFault("exec", (command) => {
        commands.push(command);
    });

    // `start` takes an empty title argument first, or a quoted path is read as
    // the window title and nothing opens.
    asPlatform("win32", () => psHost.openInExplorer("C:\\art\\dragon_frames"));
    assert.equal(commands[0], 'start "" "C:\\art\\dragon_frames"');

    asPlatform("darwin", () => psHost.openInExplorer("/Users/a/frames"));
    assert.equal(commands[1], 'open "/Users/a/frames"');
});

test("a shell that will not start is not a reason for the panel to fall over", (t) => {
    t.after(clearFaults);
    setFault("exec", () => {
        throw new Error("no shell available");
    });
    asPlatform("win32", () => psHost.openInExplorer("C:\\art"));
});

test("a link opens in the browser, and a host without that API is not a crash", () => {
    const opened = [];
    withCep({ util: { openURLInDefaultBrowser: (url) => opened.push(url) } }, () =>
        psHost.openUrl("https://github.com/lxapgjryzc/F_Record")
    );
    assert.deepEqual(opened, ["https://github.com/lxapgjryzc/F_Record"]);

    withCep(null, () => psHost.openUrl("https://example.com"));
});
