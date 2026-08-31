/**
 * Wire protocol shared by the Generator plugin (server) and the CEP panel (client).
 *
 * Both sides are bundled separately, so this file must not import anything.
 */

/** Bumped for 6: three write-only fields removed from the state payload. */
export const PROTOCOL_VERSION = 6;
export const PLUGIN_NAME = "F_Record";

/** Where users are asked to file bugs, and where update checks look. */
export const REPO_OWNER = "lxapgjryzc";
export const REPO_NAME = "F_Record";
export const REPO_URL = "https://github.com/" + REPO_OWNER + "/" + REPO_NAME;
export const ISSUES_URL = REPO_URL + "/issues";
export const RELEASES_API =
    "https://api.github.com/repos/" + REPO_OWNER + "/" + REPO_NAME + "/releases/latest";

/* ------------------------------------------------------------------ config */

export type Resolution = "360" | "720" | "1080" | "1440" | "2160";

/**
 * The ten locales Photoshop ships in that cover essentially all of its users.
 * "auto" follows Photoshop's own UI language and falls back to English.
 *
 * These are BCP 47 tags rather than the old "cn"/"en" pair, so they can be
 * matched against `appUILocale` (which reports e.g. "zh_CN", "pt_BR") without
 * a translation table. normalizeConfig migrates the old values.
 */
export type Language =
    | "auto"
    | "en"
    | "zh-CN"
    | "zh-TW"
    | "ja"
    | "ko"
    | "de"
    | "fr"
    | "es"
    | "pt-BR"
    | "ru";

export const LANGUAGES: Language[] = [
    "auto",
    "en",
    "zh-CN",
    "zh-TW",
    "ja",
    "ko",
    "de",
    "fr",
    "es",
    "pt-BR",
    "ru"
];

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
    /**
     * Ask GitHub whether a newer release exists. Off unless the user opts in:
     * a drawing plug-in has no business reaching the network on its own, and
     * the check is only useful while the panel is actually open.
     */
    checkForUpdates: boolean;
    /**
     * Release tag the user dismissed. Stored rather than a plain boolean so a
     * dismissal silences that one version, not every future one.
     */
    dismissedUpdateVersion: string | null;
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
    language: "auto",
    checkForUpdates: false,
    dismissedUpdateVersion: null,
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
    /** Set when recording auto-paused itself; surfaced verbatim in the panel. */
    pausedReason: string | null;
}

export interface UpdateState {
    /** Release tag with any leading "v" stripped, e.g. "4.1.0". */
    latestVersion: string;
    /** Release page to open; never a direct download. */
    url: string;
    publishedAt: number | null;
    /** True once the user dismissed this exact version. */
    dismissed: boolean;
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
    /** Null until a check has actually found a newer release. */
    update: UpdateState | null;
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
    | { type: "newSession"; documentId: number }
    /** Silence the banner for one specific version. */
    | { type: "dismissUpdate"; version: string }
    /** Check now, regardless of the schedule. Still refuses when opted out. */
    | { type: "checkUpdate" };

export interface CommandResult {
    ok: boolean;
    error?: string;
    sessions?: SessionSummary[];
    state?: State;
    /** Set by checkUpdate: "newer" found, already "current", or the check failed. */
    updateCheck?: { outcome: "newer" | "current" | "failed"; message?: string };
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
