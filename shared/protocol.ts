/**
 * Wire protocol shared by the Generator plugin (server) and the CEP panel (client).
 *
 * Both sides are bundled separately, so this file must not import anything.
 */

export const PROTOCOL_VERSION = 4;
export const PLUGIN_NAME = "F_Record";

/* ------------------------------------------------------------------ config */

export type Resolution = "360" | "720" | "1080" | "1440" | "2160";
export type Language = "cn" | "en";
export type FrameFormat = "jpg";

export interface Config {
    /** Recording armed. Owned by the generator, mirrored into the panel. */
    enabled: boolean;
    /** Arm recording as soon as Photoshop launches, without opening the panel. */
    autoStart: boolean;
    /** Open a session for documents that have never been recorded before. */
    autoStartNewDocuments: boolean;
    processImageFolderPath: string;
    resolution: Resolution;
    /** JPEG quality, 1-100. */
    quality: number;
    /** Stop counting time after this many idle minutes. 0 disables the timeout. */
    idleTimeoutMinutes: number;
    /** Floor for the adaptive capture interval, in milliseconds. */
    minIntervalMs: number;
    /** Documents smaller than this (in pixels) never start a session. */
    minCanvasPixels: number;
    language: Language;
    format: FrameFormat;
}

export const DEFAULT_CONFIG: Omit<Config, "processImageFolderPath"> = {
    enabled: false,
    autoStart: false,
    autoStartNewDocuments: true,
    resolution: "1080",
    quality: 70,
    idleTimeoutMinutes: 1,
    minIntervalMs: 1500,
    minCanvasPixels: 256 * 256,
    language: "cn",
    format: "jpg"
};

/* ------------------------------------------------------------------- state */

export interface Bounds {
    top: number;
    left: number;
    bottom: number;
    right: number;
}

export interface GeneratorInfo {
    pluginVersion: string;
    protocolVersion: number;
    pid: number;
    startedAt: number;
    photoshopVersion: string | null;
    generatorCoreVersion: string | null;
}

export interface DocumentState {
    id: number;
    name: string;
    filePath: string | null;
    bounds: Bounds | null;
    sessionId: string | null;
    /** True when the document is too small to record (see minCanvasPixels). */
    tooSmall: boolean;
}

export interface SessionState {
    sessionId: string;
    folder: string;
    frameCount: number;
    timeSpentSec: number;
    lastFrameAt: number | null;
    createdAt: number;
}

export type EncoderKind = "native" | "js";

export interface HealthState {
    /** Duration of the most recent successful capture, in milliseconds. */
    lastCaptureMs: number | null;
    avgCaptureMs: number | null;
    /** Current adaptive throttle interval. */
    nextIntervalMs: number;
    capturing: boolean;
    droppedFrames: number;
    consecutiveFailures: number;
    encoder: EncoderKind;
    lastError: { message: string; at: number } | null;
    /** Set when recording auto-paused itself; surfaced verbatim in the panel. */
    pausedReason: string | null;
}

export interface State {
    protocolVersion: number;
    generator: GeneratorInfo;
    config: Config;
    document: DocumentState | null;
    session: SessionState | null;
    health: HealthState;
    /** Candidate sessions the current document might be a resumption of. */
    resumeCandidates: SessionSummary[];
}

export interface SessionSummary {
    sessionId: string;
    folder: string;
    docName: string;
    filePathHistory: string[];
    canvasBounds: Bounds | null;
    frameCount: number;
    timeSpentSec: number;
    createdAt: number;
    lastModifiedAt: number;
    format: FrameFormat;
    resolution: Resolution;
    /** Present when the folder could not be read; the session is still listed. */
    error?: string;
}

/* ---------------------------------------------------------------- commands */

export type Command =
    | { type: "ping" }
    | { type: "setConfig"; patch: Partial<Config> }
    | { type: "pause"; reason: string }
    | { type: "resume" }
    | { type: "listSessions" }
    | { type: "deleteSession"; sessionId: string }
    | { type: "adoptSession"; documentId: number; sessionId: string }
    | { type: "newSession"; documentId: number };

export interface CommandResult {
    ok: boolean;
    error?: string;
    sessions?: SessionSummary[];
    state?: State;
}

/* ------------------------------------------------------------------ events */

export type ServerEvent =
    | { type: "state"; state: State }
    | { type: "frame"; sessionId: string; frameCount: number; at: number }
    | { type: "health"; health: HealthState }
    | { type: "log"; level: "info" | "warn" | "error"; message: string; at: number };

/* ------------------------------------------------------------------ bridge */

export interface BridgeInfo {
    port: number;
    token: string;
    pid: number;
    protocolVersion: number;
    pluginVersion: string;
    startedAt: number;
}

/** Origin the panel sends and the generator checks. Panels run from file:// or app:// */
export const BRIDGE_ORIGIN_HEADER = "x-f-record-client";
export const BRIDGE_ORIGIN_VALUE = "f-record-panel";
