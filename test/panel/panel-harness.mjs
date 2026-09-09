/**
 * A panel with Photoshop, the generator and ffmpeg stood in for.
 *
 * App.tsx is the top of the panel and it reaches for four things that only
 * exist inside Photoshop: the bridge to the generator, CSInterface, ffmpeg,
 * and the clipboard helper. Each is a sibling module in dist/modules, so each
 * can be replaced wholesale -- which is what lets the panel be driven here as
 * a user would drive it, clicking real rendered buttons, without a Photoshop
 * anywhere.
 *
 * The stand-ins are behaviour tables rather than fixed fakes: a test sets
 * `panel.host.readHostTheme = ...` for the one call it is about and leaves the
 * rest alone.
 *
 *
 * Why these tests live in a directory of their own
 * ------------------------------------------------
 *
 * Because of what module mocking does to a coverage report. When a module is
 * replaced with `mock.module` and then imported, node records coverage for it
 * under the real file's path -- but the numbers are the stand-in's, which is
 * a handful of lines with nothing in them. That result does not add to the
 * one the module's own test file earned; it replaces it. So psHost.mjs, a
 * file covered to the last branch by psHost.test.mjs, reads as 27% the moment
 * a panel test stands it in.
 *
 * The fix is to keep the two apart: `coverage:core` measures everything
 * except the panel's own components over test/*.test.mjs, and
 * `coverage:panel` measures the panel components over these. Neither pass
 * measures a module the other one replaces, both are held to 100%, and
 * between them every module is measured exactly once.
 */

import { PROTOCOL_VERSION, DEFAULT_CONFIG } from "../../dist/modules/protocol.mjs";

/**
 * The modules replaced here are named rather than imported and re-exported.
 *
 * Importing one to copy its exports would load it as well as replace it, and
 * a module can only be measured where it is not a stand-in -- see above. A
 * name that goes missing from this list shows up as an import error rather
 * than as a silent gap.
 */
const PS_HOST_EXPORTS = [
    "readHostTheme",
    "hostUiLocale",
    "onThemeChanged",
    "makePanelPersistent",
    "evalScript",
    "writeFinalStill",
    "hasOpenDocument",
    "openDocumentInPhotoshop",
    "openDocumentForReview",
    "closeDocumentInPhotoshop",
    "switchToDocumentInPhotoshop",
    "chooseFolder",
    "chooseImageFile",
    "chooseSavePath",
    "openInExplorer",
    "openUrl"
];

const PANEL_BRIDGE = "../../dist/modules/panelBridge.mjs";
const PS_HOST = "../../dist/modules/psHost.mjs";
const FFMPEG = "../../dist/modules/ffmpeg.mjs";
const CLIPBOARD = "../../dist/modules/clipboard.mjs";
const COMPAT = "../../dist/modules/compat.mjs";

/** A state object shaped the way the generator sends one. */
export function panelState(overrides = {}) {
    return {
        protocolVersion: PROTOCOL_VERSION,
        generator: {
            pluginVersion: "4.10.0",
            protocolVersion: PROTOCOL_VERSION,
            pid: 1234,
            startedAt: 1700000000000,
            photoshopVersion: "27.2.0",
            node: "Node 22.18 (no fallbacks)"
        },
        config: { ...DEFAULT_CONFIG, language: "en", processImageFolderPath: "C:/frames" },
        document: {
            id: 1,
            name: "dragon",
            filePath: "C:/art/dragon.psd",
            bounds: { top: 0, left: 0, right: 800, bottom: 600 },
            sessionId: "s1",
            tooSmall: false
        },
        session: {
            sessionId: "s1",
            folder: "C:/frames/s1",
            frameCount: 12,
            timeSpentSec: 90,
            lastFrameAt: 1700000000000,
            createdAt: 1699999000000
        },
        health: {
            lastCaptureMs: 120,
            avgCaptureMs: 130,
            nextIntervalMs: 1500,
            capturing: false,
            droppedFrames: 0,
            consecutiveFailures: 0,
            encoder: "js",
            pausedReason: null
        },
        resumeCandidates: [],
        update: null,
        ...overrides
    };
}

/** A listing row shaped the way listSessions returns one. */
export function sessionRow(overrides = {}) {
    return {
        sessionId: "s1",
        folder: "C:/frames/s1",
        docName: "dragon",
        filePathHistory: ["C:/art/dragon.psd"],
        canvasBounds: { top: 0, left: 0, right: 800, bottom: 600 },
        frameCount: 12,
        timeSpentSec: 90,
        createdAt: 1699999000000,
        lastModifiedAt: 1700000000000,
        format: "jpg",
        resolution: "1080",
        archived: false,
        besideDocument: false,
        ...overrides
    };
}

/**
 * Replaces the four modules App.tsx cannot have here.
 *
 * Call once per test file, before importing app.mjs.
 */
export function stubPanel(mock) {
    /**
     * The answer a command gets when a test has not said otherwise.
     *
     * The listing comes back with everything, as the real protocol does for
     * every command that can change it -- so a test says what the shelf looks
     * like afterwards by setting `bridge.sessions` before the click.
     */
    const plainReply = () => ({ ok: true, state: bridge.state, sessions: bridge.sessions });

    const bridge = {
        listeners: null,
        commands: [],
        started: 0,
        stopped: 0,
        /** What each command answers with; a function may throw to reject. */
        reply: plainReply,
        /** Puts that back, so one test's stubbed answer is not the next one's. */
        replyPlainly() {
            bridge.reply = plainReply;
        },
        sessions: [],
        state: null
    };

    class FakeBridgeClient {
        constructor(listeners) {
            bridge.listeners = listeners;
        }
        start() {
            bridge.started++;
        }
        stop() {
            bridge.stopped++;
        }
        send(command) {
            bridge.commands.push(command);
            try {
                return Promise.resolve(bridge.reply(command));
            } catch (error) {
                return Promise.reject(error);
            }
        }
    }

    /** Pushes a whole state, as a connected generator does. */
    bridge.connect = (state) => {
        bridge.state = state;
        bridge.listeners.onStatus("connected", null);
        bridge.listeners.onState(state);
    };
    bridge.setStatus = (status, detail) => bridge.listeners.onStatus(status, detail || null);
    bridge.pushState = (state) => {
        bridge.state = state;
        bridge.listeners.onState(state);
    };
    bridge.pushHealth = (health) => bridge.listeners.onHealth(health);
    bridge.pushFrame = (sessionId, frameCount, at) => bridge.listeners.onFrame(sessionId, frameCount, at);
    bridge.pushLog = (level, message, at) => bridge.listeners.onLog(level, message, at);
    bridge.sent = (type) => bridge.commands.filter((command) => command.type === type);
    bridge.last = (type) => bridge.sent(type).pop() || null;

    /**
     * What Photoshop does when a test has not said otherwise: everything
     * works, and every chooser is cancelled -- a test that means to pick a
     * file says which.
     */
    const hostDefaults = {
        readHostTheme: () => ({ dark: true, background: "rgb(50,50,50)" }),
        hostUiLocale: () => "en_US",
        onThemeChanged: () => {},
        makePanelPersistent: () => {},
        chooseFolder: () => null,
        chooseImageFile: () => null,
        chooseSavePath: () => null,
        openInExplorer: () => {},
        openUrl: () => {},
        evalScript: () => Promise.resolve(""),
        writeFinalStill: () => Promise.resolve("ok"),
        hasOpenDocument: () => Promise.resolve(true),
        openDocumentInPhotoshop: () => Promise.resolve("ok"),
        openDocumentForReview: () => Promise.resolve("opened"),
        closeDocumentInPhotoshop: () => Promise.resolve("ok"),
        switchToDocumentInPhotoshop: () => Promise.resolve("ok")
    };

    const host = { calls: [], ...hostDefaults };

    const hostExports = {};
    for (const name of PS_HOST_EXPORTS) {
        hostExports[name] = (...args) => {
            host.calls.push({ name, args });
            return host[name](...args);
        };
    }

    const media = {
        /** Handed back by runExport; the test drives it. */
        exports: [],
        stills: [],
        clipboard: [],
        /** Set to reject the next still or copy. */
        stillFails: null,
        copyFails: null
    };

    const ffmpegExports = {
        runExport(request, onProgress) {
            let settle;
            const promise = new Promise((resolve, reject) => {
                settle = { resolve, reject };
            });
            const job = { request, onProgress, cancelled: 0, ...settle };
            job.cancel = () => {
                job.cancelled++;
            };
            media.exports.push(job);
            return { promise, cancel: job.cancel };
        },
        runStillWatermark(request) {
            media.stills.push(request);
            return media.stillFails ? Promise.reject(media.stillFails) : Promise.resolve();
        }
    };

    const clipboardExports = {
        copyImageToClipboard(imagePath, tempDir) {
            media.clipboard.push({ imagePath, tempDir });
            return media.copyFails ? Promise.reject(media.copyFails) : Promise.resolve();
        }
    };

    // What the panel reaches for out of shared/compat, directly and through
    // shared/paths. The description is a fixed string rather than this
    // machine's, so a test can assert the words that reach the screen, and the
    // data directory is a fixed one so no test writes anywhere real.
    const made = [];
    const compatExports = {
        mkdirp: (target) => {
            made.push(target);
        },
        describeNodeCompat: () => "Node 8.6 (mkdir, rm, rmdir)",
        getUserDataDir: () => "C:\\Users\\test\\AppData\\Roaming",
        pad: (num, size) => {
            let out = String(Math.floor(Math.abs(num)));
            while (out.length < size) {
                out = "0" + out;
            }
            return out;
        }
    };

    mock.module(COMPAT, { namedExports: compatExports });
    mock.module(PANEL_BRIDGE, { namedExports: { BridgeClient: FakeBridgeClient } });
    mock.module(PS_HOST, { namedExports: hostExports });
    mock.module(FFMPEG, { namedExports: ffmpegExports });
    mock.module(CLIPBOARD, { namedExports: clipboardExports });

    /** Back to "everything works", so one test's stand-in is not the next's. */
    function reset() {
        bridge.replyPlainly();
        bridge.commands.length = 0;
        bridge.sessions = [];
        Object.assign(host, hostDefaults);
        host.calls.length = 0;
        media.exports.length = 0;
        media.stills.length = 0;
        media.clipboard.length = 0;
        media.stillFails = null;
        media.copyFails = null;
        made.length = 0;
    }

    return { bridge, host, media, made, reset };
}

/**
 * A disk with only the folders and files a test says are there.
 *
 * App.tsx asks the filesystem three questions -- does this document still
 * exist, what frames are in this folder, and please forget this scratch file
 * -- and every one of them decides something visible. `mkdirp` is replaced
 * alongside them so no test writes a folder onto the real machine.
 */
export function stubFs(mock) {
    const disk = {
        /** Absolute paths that exist. */
        files: new Set(),
        /** Folder path to the names in it. */
        folders: new Map(),
        /** Paths that were asked to be deleted. */
        unlinked: [],
        /** Set to make every call throw, as an unreadable drive would. */
        broken: null
    };

    const check = () => {
        if (disk.broken) {
            throw disk.broken;
        }
    };

    mock.module("fs", {
        namedExports: {
            existsSync(target) {
                check();
                return disk.files.has(target) || disk.folders.has(target);
            },
            readdirSync(folder) {
                check();
                if (!disk.folders.has(folder)) {
                    const error = new Error("ENOENT: no such directory, scandir '" + folder + "'");
                    error.code = "ENOENT";
                    throw error;
                }
                return disk.folders.get(folder).slice();
            },
            unlinkSync(target) {
                disk.unlinked.push(target);
                check();
                if (!disk.files.has(target)) {
                    const error = new Error("ENOENT: no such file, unlink '" + target + "'");
                    error.code = "ENOENT";
                    throw error;
                }
                disk.files.delete(target);
            }
        }
    });

    return disk;
}
