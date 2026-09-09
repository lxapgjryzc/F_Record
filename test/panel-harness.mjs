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
 */

import * as realPsHost from "../dist/modules/psHost.mjs";
import * as realFfmpeg from "../dist/modules/ffmpeg.mjs";
import * as realClipboard from "../dist/modules/clipboard.mjs";
import { PROTOCOL_VERSION, DEFAULT_CONFIG } from "../dist/modules/protocol.mjs";

const PANEL_BRIDGE = "../dist/modules/panelBridge.mjs";
const PS_HOST = "../dist/modules/psHost.mjs";
const FFMPEG = "../dist/modules/ffmpeg.mjs";
const CLIPBOARD = "../dist/modules/clipboard.mjs";

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
    const bridge = {
        listeners: null,
        commands: [],
        started: 0,
        stopped: 0,
        /** What each command answers with; a function may throw to reject. */
        reply(command) {
            if (command.type === "listSessions") {
                return { ok: true, sessions: bridge.sessions };
            }
            return { ok: true, state: bridge.state };
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

    const host = {
        calls: [],
        readHostTheme: () => ({ dark: true, background: "rgb(50,50,50)" }),
        hostUiLocale: () => "en_US",
        onThemeChanged: () => {},
        makePanelPersistent: () => {},
        chooseFolder: () => null,
        chooseImageFile: () => null,
        chooseSavePath: () => null,
        openInExplorer: () => {},
        openUrl: () => {},
        writeFinalStill: () => Promise.resolve("ok"),
        hasOpenDocument: () => Promise.resolve(true),
        openDocumentInPhotoshop: () => Promise.resolve("ok"),
        openDocumentForReview: () => Promise.resolve("opened"),
        closeDocumentInPhotoshop: () => Promise.resolve("ok"),
        switchToDocumentInPhotoshop: () => Promise.resolve("ok")
    };

    const hostExports = {};
    for (const name of Object.keys(realPsHost)) {
        hostExports[name] =
            typeof host[name] === "function"
                ? (...args) => {
                      host.calls.push({ name, args });
                      return host[name](...args);
                  }
                : realPsHost[name];
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
        ...realFfmpeg,
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
        ...realClipboard,
        copyImageToClipboard(imagePath, tempDir) {
            media.clipboard.push({ imagePath, tempDir });
            return media.copyFails ? Promise.reject(media.copyFails) : Promise.resolve();
        }
    };

    mock.module(PANEL_BRIDGE, { namedExports: { BridgeClient: FakeBridgeClient } });
    mock.module(PS_HOST, { namedExports: hostExports });
    mock.module(FFMPEG, { namedExports: ffmpegExports });
    mock.module(CLIPBOARD, { namedExports: clipboardExports });

    return { bridge, host, media };
}
