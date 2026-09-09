/**
 * Wire protocol shared by the Generator plugin (server) and the CEP panel (client).
 *
 * Both sides are bundled separately, so this file must not import anything.
 */

/**
 * Bumped for 12: `clipboardWatermark`. As with `exportDefaults` and `style`
 * inside the watermark before it, a new setting means a panel newer than its
 * generator, and the mismatch has to be visible rather than showing up as a
 * switch whose position is not respected.
 *
 * An older generator would in fact carry this field through untouched -- it
 * copies the stored config wholesale and only overwrites the keys it knows --
 * so the switch would stick. What it would not do is normalize it, and it is
 * the generator that owns the config file. Saying "these two halves are not
 * the same version" is cheaper than working out, for each new field, whether
 * the older half happens to be harmless.
 */
export const PROTOCOL_VERSION = 12;
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

/* --------------------------------------------------------------- watermark */

export type WatermarkKind = "off" | "text" | "image";
export type WatermarkPosition = "topLeft" | "topRight" | "bottomLeft" | "bottomRight" | "center";

/**
 * How the mark sits on the video.
 *
 * "corner" is one mark parked against an edge. "emboss" tiles it across the
 * whole frame as a relief -- the Photoshop trick of a neutral-grey layer that
 * carries nothing but highlight and shadow -- so it reads as pressed into the
 * paper rather than printed on top of it, and covers the picture rather than
 * a corner of it. `position` means nothing to "emboss".
 */
export type WatermarkStyle = "corner" | "emboss";

export const WATERMARK_KINDS: WatermarkKind[] = ["off", "text", "image"];
export const WATERMARK_STYLES: WatermarkStyle[] = ["corner", "emboss"];
export const WATERMARK_POSITIONS: WatermarkPosition[] = [
    "topLeft",
    "topRight",
    "bottomLeft",
    "bottomRight",
    "center"
];

/**
 * What to stamp on an exported video.
 *
 * Kept as one object rather than six loose config fields because the export
 * dialog hands the exporter a copy with `kind`, `text` or `imagePath` changed
 * for that one export, while the rest stays as configured.
 */
export interface WatermarkSettings {
    kind: WatermarkKind;
    /** Used when kind is "text". */
    text: string;
    /** Used when kind is "image". Any still ffmpeg can read; PNG keeps alpha. */
    imagePath: string;
    style: WatermarkStyle;
    /** Where a "corner" mark sits. Ignored by "emboss", which fills the frame. */
    position: WatermarkPosition;
    /** Height of one mark as a percentage of the video height. */
    sizePercent: number;
    opacityPercent: number;
}

export const WATERMARK_SIZE_MIN = 1;
export const WATERMARK_SIZE_MAX = 50;
export const WATERMARK_OPACITY_MIN = 5;
export const WATERMARK_OPACITY_MAX = 100;

/**
 * The floor the emboss style is clamped to at export time.
 *
 * Its tiling repeats the mark a fixed number of times, worked out from the
 * size alone, and that count is capped so a one-character signature cannot ask
 * for tens of thousands of copies. Below 2% the cap would bite before the
 * tiling reached the edge of the frame and leave a bare strip, so the size is
 * raised instead. See embossTiling in cep/src/node/export.ts.
 */
export const WATERMARK_EMBOSS_SIZE_MIN = 2;

export const DEFAULT_WATERMARK: WatermarkSettings = {
    kind: "off",
    text: "",
    imagePath: "",
    style: "corner",
    position: "bottomRight",
    sizePercent: 6,
    opacityPercent: 70
};

/**
 * Forces an arbitrary object into a usable WatermarkSettings.
 *
 * Lives here rather than in the generator because both ends need it: the
 * generator normalizes what it stores, and the panel normalizes the copy the
 * export dialog just edited before handing it to ffmpeg.
 *
 * Note what it deliberately does NOT do: turn a kind with nothing to draw yet
 * into "off". It used to, and that made the Settings tab impossible to use --
 * picking "Text" sent `{kind: "text", text: ""}` to the generator, which
 * normalized it straight back to "off", so the text box never appeared and
 * there was no way to type anything. Whether there is anything to draw is a
 * question for export time, and prepareWatermark answers it there.
 */
export function normalizeWatermark(value: unknown): WatermarkSettings {
    const raw = (value || {}) as Partial<WatermarkSettings>;
    const out: WatermarkSettings = {
        kind: WATERMARK_KINDS.indexOf(raw.kind as WatermarkKind) === -1
            ? DEFAULT_WATERMARK.kind
            : (raw.kind as WatermarkKind),
        text: typeof raw.text === "string" ? raw.text : "",
        imagePath: typeof raw.imagePath === "string" ? raw.imagePath : "",
        style: WATERMARK_STYLES.indexOf(raw.style as WatermarkStyle) === -1
            ? DEFAULT_WATERMARK.style
            : (raw.style as WatermarkStyle),
        position: WATERMARK_POSITIONS.indexOf(raw.position as WatermarkPosition) === -1
            ? DEFAULT_WATERMARK.position
            : (raw.position as WatermarkPosition),
        sizePercent: clampPercent(
            raw.sizePercent,
            WATERMARK_SIZE_MIN,
            WATERMARK_SIZE_MAX,
            DEFAULT_WATERMARK.sizePercent
        ),
        opacityPercent: clampPercent(
            raw.opacityPercent,
            WATERMARK_OPACITY_MIN,
            WATERMARK_OPACITY_MAX,
            DEFAULT_WATERMARK.opacityPercent
        )
    };
    return out;
}

/** True when this watermark would actually put something on the video. */
export function watermarkDraws(mark: WatermarkSettings): boolean {
    if (mark.kind === "text") {
        return mark.text.length > 0;
    }
    if (mark.kind === "image") {
        return mark.imagePath.length > 0;
    }
    return false;
}

function clampPercent(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === "number" ? value : parseInt(String(value), 10);
    if (!isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
}

/* ----------------------------------------------------------- export dialog */

/**
 * What the export dialog was last confirmed with, so it opens where it was
 * left instead of back at "match the canvas, original length" every time.
 *
 * The watermark is deliberately not part of this. It already has a permanent
 * home of its own above, and the copy the dialog edits is a stated one-off;
 * remembering that copy would leave Settings showing one signature and the
 * dialog another, with no way to tell which one the next export would use.
 */
export interface ExportDefaults {
    /** 0 means "match the canvas". */
    aspectRatio: number;
    /** null keeps the recording's own length. */
    targetDurationSec: number | null;
}

export const DEFAULT_EXPORT_DEFAULTS: ExportDefaults = {
    aspectRatio: 0,
    targetDurationSec: null
};

/**
 * Forces an arbitrary object into usable ExportDefaults.
 *
 * Both ends need it for the same reasons the watermark does: the generator
 * normalizes what it stores, and the panel has to cope with a config written
 * by a version that had no export block at all.
 *
 * Anything it cannot make sense of becomes the neutral choice rather than an
 * error -- the worst case is a dialog that opens on its defaults, which is
 * where it always used to open.
 */
export function normalizeExportDefaults(value: unknown): ExportDefaults {
    const raw = (value || {}) as Partial<ExportDefaults>;
    const aspect = typeof raw.aspectRatio === "number"
        ? raw.aspectRatio
        : parseFloat(String(raw.aspectRatio));
    const seconds = typeof raw.targetDurationSec === "number"
        ? raw.targetDurationSec
        : parseInt(String(raw.targetDurationSec), 10);
    return {
        // Four decimals because that is how the dialog spells 16:9 (1.7778);
        // a stored value has to match one of its options exactly to be picked
        // up again.
        aspectRatio:
            isFinite(aspect) && aspect >= 0.1 && aspect <= 10
                ? Math.round(aspect * 10000) / 10000
                : DEFAULT_EXPORT_DEFAULTS.aspectRatio,
        targetDurationSec:
            isFinite(seconds) && seconds > 0
                ? Math.min(24 * 3600, Math.round(seconds))
                : DEFAULT_EXPORT_DEFAULTS.targetDurationSec
    };
}

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
    /**
     * What "Archive stale" on the Recordings tab sweeps up, and "Select
     * stale" on the Archive tab picks out: recordings with fewer frames than
     * this. 0 leaves the frame count out of it. See shared/stale.ts.
     */
    staleMaxFrames: number;
    /** ...and recordings created more than this many days ago. 0 leaves age out of it. */
    staleAfterDays: number;
    /** Stamped on exported videos. The export dialog can override it per export. */
    watermark: WatermarkSettings;
    /**
     * Whether "Copy canvas" stamps that mark on what it puts on the clipboard.
     *
     * A setting rather than a per-copy choice because the button's whole point
     * is that it is one click: an export is a deliberate act that already opens
     * a dialog to be asked in, while copying the canvas is something done
     * mid-drawing, and the answer is the same nearly every time. Off means the
     * copy is the picture as it stands.
     */
    clipboardWatermark: boolean;
    /** Where the export dialog opens: whatever it was last confirmed with. */
    exportDefaults: ExportDefaults;
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
    format: "jpg",
    staleMaxFrames: 20,
    staleAfterDays: 30,
    watermark: DEFAULT_WATERMARK,
    // On: someone who has set a watermark up wants it on what they hand out,
    // and the copy button exists to hand something out.
    clipboardWatermark: true,
    exportDefaults: DEFAULT_EXPORT_DEFAULTS
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
    /**
     * The Node the generator got from Photoshop, and which compat fallbacks are
     * live. Photoshop hands each host a different vintage -- 8.6 on 2020, 22 on
     * 2026 -- and that is the first thing worth knowing when export misbehaves
     * on a version nobody can reproduce on.
     */
    node: string;
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
    /** Finished and filed under the Archive tab; see setArchived. */
    archived: boolean;
    /**
     * True when the folder sits beside its document rather than under the
     * frames folder; see the moveSession command. Set on listings only.
     */
    besideDocument?: boolean;
    /** Present while the generator is carrying the folder somewhere else. */
    moving?: MoveProgress;
    /** Present while the generator is writing the recording into a zip; see packSessions. */
    packing?: MoveProgress;
    /** Present when the folder could not be read; the session is still listed. */
    error?: string;
}

export interface MoveProgress {
    /** Files carried so far, out of `total`. */
    done: number;
    total: number;
    /** Where the folder is going, or the zip being written. */
    to: string;
}

/** One recording in a deleteSessions command. */
export interface DeleteItem {
    sessionId: string;
    /** Send the document the recording belongs to to the Recycle Bin as well. */
    withDocument: boolean;
}

/** Where a recording's folder may be carried to; see the moveSession command. */
export type MoveDestination = "document" | "root";

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
    /** Files a finished recording under the Archive tab, or brings it back. */
    | { type: "setArchived"; sessionId: string; archived: boolean }
    /**
     * The same for several at once. A recording that cannot be flagged --
     * on the move, or without a session.json -- is skipped and named in
     * `warnings` rather than failing the rest.
     */
    | { type: "setArchivedMany"; sessionIds: string[]; archived: boolean }
    /**
     * Deletes several recordings at once, each optionally with the document
     * it belongs to. Documents go to the Recycle Bin (the Trash on macOS);
     * frames folders are removed outright, as deleteSession does. The
     * recording in progress is skipped and named in `warnings`, as is a
     * document that another recording still belongs to.
     */
    | { type: "deleteSessions"; items: DeleteItem[] }
    /**
     * Writes each recording, with its document when there is one, into a
     * zip of its own under `folder`. Returns at once; the listing reports
     * progress through `packing`. With `deleteAfter`, a recording whose zip
     * was written in full is then deleted as deleteSessions would, document
     * included.
     */
    | { type: "packSessions"; sessionIds: string[]; folder: string; deleteAfter: boolean }
    /**
     * Carries a recording's folder next to the document it belongs to, or
     * back under the frames folder. Returns at once; the listing reports
     * progress through `moving` until the folder has arrived.
     */
    | { type: "moveSession"; sessionId: string; destination: MoveDestination }
    /** Silence the banner for one specific version. */
    | { type: "dismissUpdate"; version: string }
    /** Check now, regardless of the schedule. Still refuses when opted out. */
    | { type: "checkUpdate" };

export interface CommandResult {
    ok: boolean;
    error?: string;
    /**
     * What a command that otherwise succeeded could not do, one line each:
     * a bulk command skips what it cannot act on rather than failing whole.
     */
    warnings?: string[];
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
    /** Mirrored here so doctor.ps1 can report it without talking to the bridge. */
    node: string;
}

/** Origin the panel sends and the generator checks. Panels run from file:// or app:// */
export const BRIDGE_ORIGIN_HEADER = "x-f-record-client";
export const BRIDGE_ORIGIN_VALUE = "f-record-panel";
