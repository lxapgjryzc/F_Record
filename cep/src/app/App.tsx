import { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
    CommandResult,
    Config,
    DEFAULT_EXPORT_DEFAULTS,
    DEFAULT_WATERMARK,
    DeleteItem,
    ISSUES_URL,
    SessionSummary,
    State
} from "../../../shared/protocol";
import { StaleCriteria, staleSessions } from "../../../shared/stale";
import { BridgeClient, ConnectionStatus } from "./bridge";
import { Translate, createTranslate } from "./i18n";
import { Banner, IssueButton, Toast, Toasts } from "./components/ui";
import { Dashboard, ExportJob } from "./components/Dashboard";
import { Sessions } from "./components/Sessions";
import { Settings } from "./components/Settings";
import { ExportChoice, ExportDialog } from "./components/ExportDialog";
import { PackDialog } from "./components/PackDialog";
import { ReviewDecision, ReviewDialog, ReviewState } from "./components/Review";
import { toFramePaths } from "../node/export";
import { runExport, runStillWatermark } from "../node/ffmpeg";
import { copyImageToClipboard } from "../node/clipboard";
import { clipboardTempDir, exportTempDir } from "../../../shared/paths";
import { mkdirp } from "../../../shared/compat";
import {
    chooseFolder,
    chooseSavePath,
    closeDocumentInPhotoshop,
    makePanelPersistent,
    hostUiLocale,
    onThemeChanged,
    openDocumentForReview,
    openDocumentInPhotoshop,
    openInExplorer,
    openUrl,
    readHostTheme,
    switchToDocumentInPhotoshop,
    writeFinalStill
} from "./psHost";

import * as fs from "fs";
import * as nodePath from "path";

type Tab = "dashboard" | "sessions" | "archive" | "settings";

interface PendingExport {
    session: SessionSummary;
    /** True when this is the recording attached to the open document. */
    isCurrent: boolean;
}

interface PendingPack {
    sessions: SessionSummary[];
    folder: string;
}

/** A batch of zips under way, so the panel can say when the last one lands. */
interface PackWatch {
    folder: string;
    count: number;
}

/** How many warning toasts a bulk action may raise before the rest are folded into one. */
const MAX_WARNING_TOASTS = 3;

export function App(): JSX.Element {
    const [state, setState] = useState<State | null>(null);
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [statusDetail, setStatusDetail] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>("dashboard");
    const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [pendingExport, setPendingExport] = useState<PendingExport | null>(null);
    const [exportJob, setExportJob] = useState<ExportJob | null>(null);
    /** True while the canvas is on its way to the clipboard. */
    const [copying, setCopying] = useState(false);
    const [updateBusy, setUpdateBusy] = useState(false);
    /** Archive rows that are ticked, by session id. */
    const [selected, setSelected] = useState<{ [sessionId: string]: boolean }>({});
    const [pendingPack, setPendingPack] = useState<PendingPack | null>(null);
    const [review, setReview] = useState<ReviewState | null>(null);

    const clientRef = useRef<BridgeClient | null>(null);
    const toastId = useRef(1);
    /** Where the last batch of zips went, offered again next time. */
    const packFolderRef = useRef<string | null>(null);
    const packWatchRef = useRef<PackWatch | null>(null);

    // Read once: Photoshop cannot change its UI language without restarting,
    // and re-reading it on every render would mean a host call per frame.
    const hostLocale = useRef<string | null>(null);
    if (hostLocale.current === null) {
        hostLocale.current = hostUiLocale() || "";
    }
    const language = state ? state.config.language : "auto";
    const t: Translate = createTranslate(language, hostLocale.current);

    const pushToast = useCallback(
        (tone: Toast["tone"], text: string, actionLabel?: string, onAction?: () => void) => {
            const id = toastId.current++;
            setToasts((current) => current.concat([{ id, tone, text, actionLabel, onAction }]));
            // Errors stay until dismissed; everything else clears itself.
            if (tone !== "negative") {
                setTimeout(() => {
                    setToasts((current) => current.filter((toast) => toast.id !== id));
                }, 6000);
            }
        },
        []
    );

    const dismissToast = useCallback((id: number) => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
    }, []);

    /* ------------------------------------------------------------ bridge */

    useEffect(() => {
        makePanelPersistent();

        const applyTheme = () => {
            const theme = readHostTheme();
            if (theme.dark) {
                document.documentElement.classList.remove("light");
            } else {
                document.documentElement.classList.add("light");
            }
        };
        applyTheme();
        onThemeChanged(applyTheme);

        // Focus rings only for keyboard users. Chromium 61 has no
        // :focus-visible, so the distinction is made here instead.
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Tab") {
                document.body.classList.add("kbd");
            }
        };
        const onMouseDown = () => document.body.classList.remove("kbd");
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("mousedown", onMouseDown);

        const client = new BridgeClient({
            onStatus: (next, detail) => {
                setStatus(next);
                setStatusDetail(detail);
                if (next !== "connected") {
                    setState(null);
                }
            },
            onState: (next) => setState(next),
            onHealth: (health) =>
                setState((current) => (current ? Object.assign({}, current, { health: health }) : current)),
            onFrame: (sessionId, frameCount) =>
                setState((current) => {
                    if (!current || !current.session || current.session.sessionId !== sessionId) {
                        return current;
                    }
                    return Object.assign({}, current, {
                        session: Object.assign({}, current.session, { frameCount: frameCount })
                    });
                }),
            onLog: (level, message) => {
                if (level === "error") {
                    pushToast("negative", message);
                }
            }
        });
        clientRef.current = client;
        client.start();

        return () => {
            client.stop();
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("mousedown", onMouseDown);
        };
    }, [pushToast]);

    const send = useCallback(
        async (command: Parameters<BridgeClient["send"]>[0]) => {
            const client = clientRef.current;
            if (!client) {
                throw new Error("Not connected");
            }
            const result = await client.send(command);
            if (!result.ok) {
                throw new Error(result.error || "Command failed");
            }
            return result;
        },
        []
    );

    const patchConfig = useCallback(
        (patch: Partial<Config>) => {
            send({ type: "setConfig", patch: patch }).catch((error: Error) => {
                pushToast("negative", error.message);
            });
        },
        [send, pushToast]
    );

    /**
     * Stores what the export dialog was just confirmed with, so it opens there
     * next time.
     *
     * Only when it actually changed: exporting a dozen recordings with the
     * same settings should not rewrite config.json a dozen times. The
     * watermark is not stored -- see ExportDefaults for why.
     */
    const rememberExportChoice = useCallback(
        (choice: ExportChoice) => {
            const stored = state ? state.config.exportDefaults : null;
            if (
                stored &&
                stored.aspectRatio === choice.aspectRatio &&
                stored.targetDurationSec === choice.targetDurationSec
            ) {
                return;
            }
            patchConfig({
                exportDefaults: {
                    aspectRatio: choice.aspectRatio,
                    targetDurationSec: choice.targetDurationSec
                }
            });
        },
        [state, patchConfig]
    );

    /**
     * The manual "check now" button.
     *
     * Says something either way: a check that silently does nothing when you
     * are already up to date reads as a broken button.
     */
    const checkForUpdates = useCallback(() => {
        setUpdateBusy(true);
        send({ type: "checkUpdate" })
            .then((result) => {
                const outcome = result.updateCheck ? result.updateCheck.outcome : "failed";
                if (outcome === "current") {
                    pushToast("positive", t("update.upToDate"));
                } else if (outcome === "failed") {
                    pushToast("negative", t("update.failed"));
                }
                // "newer" needs no toast: the banner appears on its own.
            })
            .catch((error: Error) => pushToast("negative", error.message))
            .then(() => setUpdateBusy(false));
    }, [send, pushToast, t]);

    const refreshSessions = useCallback(() => {
        send({ type: "listSessions" })
            .then((result) => setSessions(result.sessions || []))
            .catch((error: Error) => pushToast("negative", error.message));
    }, [send, pushToast]);

    useEffect(() => {
        if ((tab === "sessions" || tab === "archive") && status === "connected") {
            refreshSessions();
        }
    }, [tab, status, refreshSessions]);

    // A folder on the move, or a zip being written, reports progress only
    // through the listing, so keep asking while any row says it is busy.
    const anyInTransit = !!sessions && sessions.some((session) => !!session.moving || !!session.packing);
    useEffect(() => {
        if (!anyInTransit) {
            return;
        }
        const timer = setInterval(refreshSessions, 1000);
        return () => clearInterval(timer);
    }, [anyInTransit, refreshSessions]);

    // Say where a folder landed once it has. The generator logs the arrival,
    // but only its errors are surfaced here, and a move that took a minute
    // deserves more than a progress bar quietly vanishing.
    const movingRef = useRef<{ [sessionId: string]: string }>({});
    useEffect(() => {
        if (!sessions) {
            return;
        }
        const now: { [sessionId: string]: string } = {};
        for (let i = 0; i < sessions.length; i++) {
            const move = sessions[i].moving;
            if (move) {
                now[sessions[i].sessionId] = move.to;
            }
        }
        const before = movingRef.current;
        const ids = Object.keys(before);
        for (let i = 0; i < ids.length; i++) {
            if (now[ids[i]]) {
                continue;
            }
            const landed = sessions.filter((session) => session.sessionId === ids[i])[0];
            // Still at the old address means the move failed; the generator
            // has already said so through the log.
            if (landed && samePath(landed.folder, before[ids[i]])) {
                pushToast("positive", t("sessions.moved", landed.folder));
            }
        }
        movingRef.current = now;

        // The same for a batch of zips: one word when the last one is done.
        // A zip that failed has already been reported as an error.
        const watch = packWatchRef.current;
        if (watch && !sessions.some((session) => !!session.packing)) {
            packWatchRef.current = null;
            const folder = watch.folder;
            pushToast("positive", t("pack.done", watch.count, folder), t("export.open"), () =>
                openInExplorer(folder)
            );
        }
    }, [sessions]);

    // A tick outlives nothing: rows that leave the archive leave the selection.
    useEffect(() => {
        if (!sessions) {
            return;
        }
        setSelected((current) => {
            const next: { [sessionId: string]: boolean } = {};
            let changed = false;
            for (let i = 0; i < sessions.length; i++) {
                const id = sessions[i].sessionId;
                if (current[id] && sessions[i].archived) {
                    next[id] = true;
                }
            }
            const ids = Object.keys(current);
            for (let i = 0; i < ids.length; i++) {
                if (!next[ids[i]]) {
                    changed = true;
                }
            }
            return changed ? next : current;
        });
    }, [sessions]);

    /* ------------------------------------------------------------ export */

    const startExport = useCallback(
        async (target: PendingExport, choice: ExportChoice) => {
            const savePath = chooseSavePath(t("export.title"), target.session.docName + ".mp4");
            if (!savePath) {
                return;
            }

            const frames = readFrames(target.session.folder);
            if (frames.length === 0) {
                pushToast("negative", t("export.noFrames"));
                return;
            }

            setExportJob({ label: t("export.preparing"), percent: 0 });
            pushToast("info", t("export.started"));

            // Stop capturing while ffmpeg runs: the two would otherwise compete
            // for CPU, and the final-still export below briefly touches the
            // document, which would show up as a spurious frame.
            let paused = false;
            try {
                await send({ type: "pause", reason: "Exporting" });
                paused = true;
            } catch (e) {
                // Exporting an old recording with no generator running is fine.
            }

            let finalImagePath: string | null = null;
            if (target.isCurrent) {
                try {
                    mkdirp(exportTempDir());
                    const candidate = nodePath.join(exportTempDir(), "final.jpg");
                    if ((await writeFinalStill(candidate)) === "ok") {
                        finalImagePath = candidate;
                    }
                } catch (e) {
                    // Bookends are a flourish; a recording without them is fine.
                    finalImagePath = null;
                }
            }

            const aspect =
                choice.aspectRatio > 0
                    ? choice.aspectRatio
                    : aspectOfBounds(target.session);

            try {
                const handle = runExport(
                    {
                        frames: frames,
                        finalImagePath: finalImagePath,
                        outputPath: savePath,
                        aspectRatio: aspect,
                        resolution: parseInt(target.session.resolution, 10) || 1080,
                        targetDurationSec: choice.targetDurationSec,
                        watermark: choice.watermark
                    },
                    (progress) => {
                        const label =
                            progress.stage === "preparing"
                                ? t("export.preparing")
                                : progress.stage === "encoding"
                                    ? t("export.encoding")
                                    : t("export.finishing");
                        setExportJob({ label: label, percent: progress.percent });
                    }
                );
                await handle.promise;
                pushToast("positive", t("export.done"), t("export.open"), () => openInExplorer(savePath));
            } catch (error) {
                pushToast("negative", t("export.failed") + ": " + (error as Error).message);
            } finally {
                setExportJob(null);
                if (paused) {
                    send({ type: "resume" }).catch(() => {
                        /* the panel will reconnect and show the real state */
                    });
                }
            }
        },
        [send, pushToast, t]
    );

    /* --------------------------------------------------------- clipboard */

    /**
     * The canvas as it stands, watermarked, on the clipboard.
     *
     * The recording is not involved: this signs what is on screen right now,
     * so it works for a document with no session and before a single frame has
     * been captured. What it does share with export is the mark itself -- the
     * one stored in Settings, drawn by the same ffmpeg filters -- so what gets
     * pasted into a chat window matches what a viewer would see on the video.
     */
    const copyFrameToClipboard = useCallback(async () => {
        setCopying(true);

        // Same reason export pauses: writing the still touches the document,
        // and an unpaused generator would file that away as a real frame.
        let paused = false;
        try {
            await send({ type: "pause", reason: "Copying the canvas" });
            paused = true;
        } catch (e) {
            // No generator running is fine; there is then nothing to disturb.
        }

        const temp = clipboardTempDir();
        const source = nodePath.join(temp, "canvas.jpg");
        const marked = nodePath.join(temp, "canvas.png");
        try {
            mkdirp(temp);
            if ((await writeFinalStill(source)) !== "ok") {
                throw new Error(t("doc.none"));
            }
            await runStillWatermark({
                sourcePath: source,
                outputPath: marked,
                // Null is "copy it as it stands". `!== false` rather than a
                // plain read, so a config from a generator that predates the
                // setting still marks the copy, which is the default.
                watermark:
                    state && state.config.clipboardWatermark !== false
                        ? state.config.watermark
                        : null
            });
            await copyImageToClipboard(marked, temp);
            pushToast("positive", t("clipboard.done"));
        } catch (error) {
            pushToast("negative", t("clipboard.failed") + ": " + (error as Error).message);
        } finally {
            setCopying(false);
            // The clipboard holds a copy of the picture, not a claim on the
            // file, so nothing here is needed once the helper has returned.
            discard([source, marked]);
            if (paused) {
                send({ type: "resume" }).catch(() => {
                    /* the panel will reconnect and show the real state */
                });
            }
        }
    }, [send, pushToast, state, t]);

    const currentSessionSummary = useCallback((): SessionSummary | null => {
        if (!state || !state.session || !state.document) {
            return null;
        }
        return {
            sessionId: state.session.sessionId,
            folder: state.session.folder,
            docName: state.document.name,
            filePathHistory: [],
            canvasBounds: state.document.bounds,
            frameCount: state.session.frameCount,
            timeSpentSec: state.session.timeSpentSec,
            createdAt: state.session.createdAt,
            lastModifiedAt: state.session.lastFrameAt || 0,
            format: state.config.format,
            resolution: state.config.resolution,
            archived: false
        };
    }, [state]);

    /** The file to open for a recording, or null after saying why there is none. */
    const documentPathOf = (session: SessionSummary): string | null => {
        const history = session.filePathHistory;
        const target = latestExistingPath(history);
        if (!target) {
            pushToast("negative", t("sessions.documentMissing", history[history.length - 1]));
        }
        return target;
    };

    /* --------------------------------------------------------------- bulk */

    const currentSessionId = state && state.session ? state.session.sessionId : null;
    const archivedRows = sessions ? sessions.filter((session) => session.archived) : [];
    const activeRows = sessions ? sessions.filter((session) => !session.archived) : [];
    const criteria: StaleCriteria = {
        maxFrames: state ? state.config.staleMaxFrames : 0,
        afterDays: state ? state.config.staleAfterDays : 0
    };
    const staleRule = describeStaleRule(t, criteria);

    /** The ticked archive rows, in listing order. */
    const selectedRows = (): SessionSummary[] => archivedRows.filter((row) => !!selected[row.sessionId]);

    /** Bulk commands skip what they cannot do and say so; each line gets a toast, up to a point. */
    const reportWarnings = (result: CommandResult): number => {
        const warnings = result.warnings || [];
        for (let i = 0; i < warnings.length && i < MAX_WARNING_TOASTS; i++) {
            pushToast("negative", warnings[i]);
        }
        if (warnings.length > MAX_WARNING_TOASTS) {
            pushToast("negative", t("common.warningsMore", warnings.length - MAX_WARNING_TOASTS));
        }
        return warnings.length;
    };

    const archiveStale = () => {
        const ids = staleSessions(activeRows, criteria, Date.now(), currentSessionId).map((row) => row.sessionId);
        if (ids.length === 0 || !window.confirm(t("sessions.archiveStaleConfirm", ids.length))) {
            return;
        }
        send({ type: "setArchivedMany", sessionIds: ids, archived: true })
            .then((result) => {
                setSessions(result.sessions || []);
                const skipped = reportWarnings(result);
                pushToast("positive", t("sessions.archivedMany", ids.length - skipped));
            })
            .catch((e: Error) => pushToast("negative", e.message));
    };

    /** Opens every ticked recording's document in Photoshop, one after another. */
    const openSelected = async () => {
        const rows = selectedRows();
        let opened = 0;
        for (let i = 0; i < rows.length; i++) {
            const target = latestExistingPath(rows[i].filePathHistory);
            if (!target) {
                continue;
            }
            try {
                if ((await openDocumentInPhotoshop(target)) === "ok") {
                    opened++;
                }
            } catch (e) {
                pushToast("negative", (e as Error).message);
            }
        }
        if (opened === rows.length) {
            pushToast("positive", t("archive.openedAll", opened));
        } else {
            pushToast("info", t("archive.openedSome", opened, rows.length));
        }
    };

    /**
     * Deletes recordings, and their documents where asked. A document that
     * is open in Photoshop is closed first without saving, so Photoshop is
     * not left holding a file that no longer exists; the confirmation said
     * that would happen.
     */
    const runDelete = async (items: DeleteItem[]) => {
        const byId: { [sessionId: string]: SessionSummary } = {};
        for (let i = 0; i < archivedRows.length; i++) {
            byId[archivedRows[i].sessionId] = archivedRows[i];
        }
        for (let i = 0; i < items.length; i++) {
            const row = byId[items[i].sessionId];
            const target = items[i].withDocument && row ? latestExistingPath(row.filePathHistory) : null;
            if (target) {
                try {
                    await closeDocumentInPhotoshop(target, true);
                } catch (e) {
                    /* the generator will report the file if it cannot be binned */
                }
            }
        }
        try {
            const result = await send({ type: "deleteSessions", items: items });
            const remaining = result.sessions || [];
            setSessions(remaining);
            reportWarnings(result);
            let gone = 0;
            for (let i = 0; i < items.length; i++) {
                if (!remaining.some((row) => row.sessionId === items[i].sessionId)) {
                    gone++;
                }
            }
            pushToast("positive", t("archive.deleted", gone));
        } catch (e) {
            pushToast("negative", (e as Error).message);
        }
    };

    const deleteSelected = (withDocuments: boolean) => {
        const rows = selectedRows().filter((row) => row.sessionId !== currentSessionId);
        if (rows.length === 0) {
            return;
        }
        const question = withDocuments
            ? t("archive.deleteWithFilesConfirm", rows.length)
            : t("archive.deleteConfirm", rows.length);
        if (!window.confirm(question)) {
            return;
        }
        runDelete(rows.map((row) => ({ sessionId: row.sessionId, withDocument: withDocuments })));
    };

    const packSelected = () => {
        const rows = selectedRows().filter((row) => row.sessionId !== currentSessionId);
        if (rows.length === 0) {
            return;
        }
        const folder = chooseFolder(t("pack.chooseFolder"), packFolderRef.current || "");
        if (!folder) {
            return;
        }
        packFolderRef.current = folder;
        setPendingPack({ sessions: rows, folder: folder });
    };

    const startPack = async (target: PendingPack, deleteAfter: boolean) => {
        if (deleteAfter) {
            // The documents are going to the bin once zipped; Photoshop
            // should not be left with them open.
            for (let i = 0; i < target.sessions.length; i++) {
                const path = latestExistingPath(target.sessions[i].filePathHistory);
                if (path) {
                    try {
                        await closeDocumentInPhotoshop(path, true);
                    } catch (e) {
                        /* reported by the generator if the file then cannot go */
                    }
                }
            }
        }
        try {
            const result = await send({
                type: "packSessions",
                sessionIds: target.sessions.map((row) => row.sessionId),
                folder: target.folder,
                deleteAfter: deleteAfter
            });
            const listed = result.sessions || [];
            setSessions(listed);
            reportWarnings(result);
            const queued = listed.filter((row) => !!row.packing).length;
            if (queued > 0) {
                packWatchRef.current = { folder: target.folder, count: queued };
                pushToast("info", t("pack.started", queued));
            }
        } catch (e) {
            pushToast("negative", (e as Error).message);
        }
    };

    /* ------------------------------------------------------------- review */

    const reviewSession = (id: string): SessionSummary | null =>
        (sessions || []).filter((row) => row.sessionId === id)[0] || null;

    /** Opens the document of the recording at `index` and notes what happened. */
    const openForReview = (ids: string[], index: number) => {
        const session = reviewSession(ids[index]);
        const history = session ? session.filePathHistory : [];
        const target = latestExistingPath(history);
        if (!target) {
            setReview((current) =>
                current ? Object.assign({}, current, { opening: false, opened: history.length > 0 ? "missing" : "none" }) : current
            );
            return;
        }
        openDocumentForReview(target)
            .then((outcome) => {
                setReview((current) => (current ? Object.assign({}, current, { opening: false, opened: outcome }) : current));
            })
            .catch((e: Error) => {
                pushToast("negative", e.message);
                setReview((current) => (current ? Object.assign({}, current, { opening: false, opened: "error" }) : current));
            });
    };

    const startReview = () => {
        const ticked = selectedRows();
        const rows = (ticked.length > 0 ? ticked : archivedRows).filter(
            (row) => row.sessionId !== currentSessionId && !row.moving && !row.packing
        );
        if (rows.length === 0) {
            pushToast("info", t("archive.reviewEmpty"));
            return;
        }
        const ids = rows.map((row) => row.sessionId);
        setReview({ ids: ids, index: 0, opening: true, opened: null, decisions: {}, summary: false });
        openForReview(ids, 0);
    };

    /** Closes what the review opened for the recording in front, if it did. */
    const closeReviewed = async (current: ReviewState, discard: boolean) => {
        if (current.opened !== "opened") {
            return;
        }
        const session = reviewSession(current.ids[current.index]);
        const target = session ? latestExistingPath(session.filePathHistory) : null;
        if (target) {
            try {
                await closeDocumentInPhotoshop(target, discard);
            } catch (e) {
                /* the document stays open; nothing else depends on it */
            }
        }
    };

    const decideReview = async (decision: ReviewDecision | "keep") => {
        const current = review;
        if (!current || current.opening) {
            return;
        }
        const id = current.ids[current.index];
        const decisions = Object.assign({}, current.decisions);
        if (decision === "keep") {
            delete decisions[id];
        } else {
            decisions[id] = decision;
        }
        setReview(Object.assign({}, current, { opening: true }));
        await closeReviewed(current, decision === "deleteWithFile");
        const next = current.index + 1;
        if (next >= current.ids.length) {
            setReview(Object.assign({}, current, { decisions: decisions, opening: false, summary: true }));
            return;
        }
        setReview(Object.assign({}, current, { decisions: decisions, index: next, opening: true, opened: null }));
        openForReview(current.ids, next);
    };

    const stopReview = async () => {
        const current = review;
        if (!current || current.opening) {
            return;
        }
        setReview(Object.assign({}, current, { opening: true }));
        await closeReviewed(current, false);
        setReview(Object.assign({}, current, { opening: false, summary: true }));
    };

    const applyReview = () => {
        const current = review;
        setReview(null);
        if (!current) {
            return;
        }
        const ids = Object.keys(current.decisions);
        if (ids.length === 0) {
            return;
        }
        runDelete(
            ids.map((id) => ({ sessionId: id, withDocument: current.decisions[id] === "deleteWithFile" }))
        );
    };

    /* --------------------------------------------------------------- ui */

    const busy = exportJob !== null;

    return (
        <div class="app">
            <div class="tabs">
                <TabButton label={t("tab.dashboard")} active={tab === "dashboard"} onClick={() => setTab("dashboard")} />
                <TabButton label={t("tab.sessions")} active={tab === "sessions"} onClick={() => setTab("sessions")} />
                <TabButton label={t("tab.archive")} active={tab === "archive"} onClick={() => setTab("archive")} />
                <TabButton label={t("tab.settings")} active={tab === "settings"} onClick={() => setTab("settings")} />
            </div>

            <div class="body">
                {/*
                  * Above the tab content rather than inside one tab: an update
                  * is worth seeing wherever you are, but it is never urgent, so
                  * it is a dismissable strip and not a dialog.
                  */}
                {state && state.update && !state.update.dismissed ? (
                    <Banner
                        tone="info"
                        title={t("update.available", state.update.latestVersion)}
                        body={t("update.body", state.generator.pluginVersion)}
                        actions={
                            <>
                                <button
                                    type="button"
                                    class="link"
                                    onClick={() => openUrl(state.update!.url || ISSUES_URL)}
                                >
                                    {t("update.view")}
                                </button>
                                <button
                                    type="button"
                                    class="link"
                                    onClick={() => {
                                        const version = state.update!.latestVersion;
                                        send({ type: "dismissUpdate", version: version }).catch(
                                            (e: Error) => pushToast("negative", e.message)
                                        );
                                    }}
                                >
                                    {t("common.dismiss")}
                                </button>
                            </>
                        }
                    />
                ) : null}

                {tab === "dashboard" ? (
                    <Dashboard
                        t={t}
                        state={state}
                        status={status}
                        statusDetail={statusDetail}
                        exportJob={exportJob}
                        onToggleRecording={(next) => patchConfig({ enabled: next })}
                        onResume={() => {
                            send({ type: "resume" }).catch((e: Error) => pushToast("negative", e.message));
                        }}
                        onAdopt={(sessionId) => {
                            if (!state || !state.document) {
                                return;
                            }
                            send({
                                type: "adoptSession",
                                documentId: state.document.id,
                                sessionId: sessionId
                            }).catch((e: Error) => pushToast("negative", e.message));
                        }}
                        onStartFresh={() => {
                            if (!state || !state.document) {
                                return;
                            }
                            send({ type: "newSession", documentId: state.document.id }).catch((e: Error) =>
                                pushToast("negative", e.message)
                            );
                        }}
                        onExport={() => {
                            const summary = currentSessionSummary();
                            if (summary) {
                                setPendingExport({ session: summary, isCurrent: true });
                            }
                        }}
                        copying={copying}
                        onCopyFrame={() => {
                            copyFrameToClipboard().catch((e: Error) =>
                                pushToast("negative", e.message)
                            );
                        }}
                    />
                ) : null}

                {/*
                  * One list, two shelves: the archive is the same component
                  * over the rows flagged as finished, so a recording keeps
                  * every button it had when it is filed away.
                  */}
                {tab === "sessions" || tab === "archive" ? (
                    <Sessions
                        t={t}
                        archived={tab === "archive"}
                        sessions={sessions === null ? null : tab === "archive" ? archivedRows : activeRows}
                        currentSessionId={currentSessionId}
                        busy={busy}
                        stale={staleSessions(
                            tab === "archive" ? archivedRows : activeRows,
                            criteria,
                            Date.now(),
                            currentSessionId
                        )}
                        staleRule={staleRule}
                        selected={selected}
                        onSelect={(sessionId, on) =>
                            setSelected((current) => {
                                const next = Object.assign({}, current);
                                if (on) {
                                    next[sessionId] = true;
                                } else {
                                    delete next[sessionId];
                                }
                                return next;
                            })
                        }
                        onSelectMany={(sessionIds) => {
                            const next: { [sessionId: string]: boolean } = {};
                            for (let i = 0; i < sessionIds.length; i++) {
                                next[sessionIds[i]] = true;
                            }
                            setSelected(next);
                        }}
                        onRefresh={refreshSessions}
                        onOpenDocument={(session) => {
                            const target = documentPathOf(session);
                            if (!target) {
                                return;
                            }
                            openDocumentInPhotoshop(target)
                                .then((outcome) => {
                                    if (outcome === "missing") {
                                        pushToast("negative", t("sessions.documentMissing", target));
                                    }
                                })
                                .catch((e: Error) => pushToast("negative", e.message));
                        }}
                        onSwitchDocument={(session) => {
                            const target = documentPathOf(session);
                            if (!target) {
                                return;
                            }
                            switchToDocumentInPhotoshop(target)
                                .then((outcome) => {
                                    if (outcome === "missing") {
                                        pushToast("negative", t("sessions.documentMissing", target));
                                    } else if (outcome === "cancelled") {
                                        pushToast("info", t("sessions.switchCancelled"));
                                    }
                                })
                                .catch((e: Error) => pushToast("negative", e.message));
                        }}
                        onSetArchived={(session, archived) => {
                            send({ type: "setArchived", sessionId: session.sessionId, archived: archived })
                                .then((result) => setSessions(result.sessions || []))
                                .catch((e: Error) => pushToast("negative", e.message));
                        }}
                        onMove={(session, destination) => {
                            send({ type: "moveSession", sessionId: session.sessionId, destination: destination })
                                .then((result) => setSessions(result.sessions || []))
                                .catch((e: Error) => pushToast("negative", e.message));
                        }}
                        onExport={(session) =>
                            setPendingExport({
                                session: session,
                                isCurrent:
                                    !!state && !!state.session && state.session.sessionId === session.sessionId
                            })
                        }
                        onDelete={(session) => {
                            const isCurrent =
                                !!state && !!state.session && state.session.sessionId === session.sessionId;
                            const question = isCurrent
                                ? t("sessions.deleteRestartConfirm")
                                : t("sessions.deleteConfirm");
                            if (!window.confirm(question)) {
                                return;
                            }
                            send({ type: "deleteSession", sessionId: session.sessionId })
                                .then((result) => setSessions(result.sessions || []))
                                .catch((e: Error) => pushToast("negative", e.message));
                        }}
                        onArchiveStale={archiveStale}
                        onOpenSelected={() => {
                            openSelected().catch((e: Error) => pushToast("negative", e.message));
                        }}
                        onPackSelected={packSelected}
                        onDeleteSelected={deleteSelected}
                        onReview={startReview}
                    />
                ) : null}

                {tab === "settings" ? (
                    <Settings
                        t={t}
                        config={state ? state.config : null}
                        disabled={status !== "connected" || busy}
                        onPatch={patchConfig}
                        updateBusy={updateBusy}
                        onCheckUpdates={checkForUpdates}
                        generatorNode={state ? state.generator.node : null}
                    />
                ) : null}
            </div>

            <div class="footer">
                <span>
                    {status === "connected" ? t("status.connected") : t("status." + statusKey(status))}
                    {state ? " · v" + state.generator.pluginVersion : ""}
                </span>
                <IssueButton
                    label={t("issue.report")}
                    title={t("issue.hint")}
                    onClick={() => openUrl(ISSUES_URL)}
                />
            </div>

            {pendingExport ? (
                <ExportDialog
                    t={t}
                    frameCount={pendingExport.session.frameCount}
                    watermark={state ? state.config.watermark : DEFAULT_WATERMARK}
                    defaults={state ? state.config.exportDefaults : DEFAULT_EXPORT_DEFAULTS}
                    onCancel={() => setPendingExport(null)}
                    onConfirm={(choice) => {
                        const target = pendingExport;
                        setPendingExport(null);
                        rememberExportChoice(choice);
                        startExport(target, choice).catch((e: Error) =>
                            pushToast("negative", t("export.failed") + ": " + e.message)
                        );
                    }}
                />
            ) : null}

            {pendingPack ? (
                <PackDialog
                    t={t}
                    count={pendingPack.sessions.length}
                    folder={pendingPack.folder}
                    onCancel={() => setPendingPack(null)}
                    onConfirm={(deleteAfter) => {
                        const target = pendingPack;
                        setPendingPack(null);
                        startPack(target, deleteAfter).catch((e: Error) => pushToast("negative", e.message));
                    }}
                />
            ) : null}

            {review ? (
                <ReviewDialog
                    t={t}
                    review={review}
                    session={reviewSession(review.ids[review.index])}
                    lastKnownPath={(() => {
                        const session = reviewSession(review.ids[review.index]);
                        const history = session ? session.filePathHistory : [];
                        return history.length > 0 ? history[history.length - 1] : null;
                    })()}
                    onDecide={(decision) => {
                        decideReview(decision).catch((e: Error) => pushToast("negative", e.message));
                    }}
                    onStop={() => {
                        stopReview().catch((e: Error) => pushToast("negative", e.message));
                    }}
                    onApply={applyReview}
                    onDiscard={() => setReview(null)}
                />
            ) : null}

            <Toasts toasts={toasts} onDismiss={dismissToast} dismissLabel={t("toast.dismiss")} />
        </div>
    );
}

function TabButton(props: { label: string; active: boolean; onClick: () => void }): JSX.Element {
    return (
        <button type="button" class={"tab" + (props.active ? " active" : "")} onClick={props.onClick}>
            {props.label}
        </button>
    );
}

function statusKey(status: ConnectionStatus): string {
    return status === "mismatch" ? "mismatch" : status === "connecting" ? "connecting" : "unavailable";
}

function aspectOfBounds(session: SessionSummary): number {
    const bounds = session.canvasBounds;
    if (!bounds) {
        return 0;
    }
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (width <= 0 || height <= 0) {
        return 0;
    }
    return width / height;
}

/** The thresholds in words, for the tooltip on the stale buttons. */
function describeStaleRule(t: Translate, criteria: StaleCriteria): string {
    if (criteria.maxFrames > 0 && criteria.afterDays > 0) {
        return t("stale.rule.both", criteria.maxFrames, criteria.afterDays);
    }
    if (criteria.maxFrames > 0) {
        return t("stale.rule.frames", criteria.maxFrames);
    }
    if (criteria.afterDays > 0) {
        return t("stale.rule.days", criteria.afterDays);
    }
    return t("stale.rule.off");
}

/** Deletes scratch files, and does not care whether they were there. */
function discard(paths: string[]): void {
    for (let i = 0; i < paths.length; i++) {
        try {
            fs.unlinkSync(paths[i]);
        } catch (e) {
            /* a leftover in the temp folder is harmless */
        }
    }
}

function samePath(a: string, b: string): boolean {
    const key = (p: string) => p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
    return key(a) === key(b);
}

/**
 * The newest path in a document's save history that still has a file at it.
 *
 * Newest first because Save As appends: the last entry is where the artist is
 * working now. Walking back covers the file having been moved back to where an
 * earlier save put it, which is the one case a plain "last entry" would miss.
 */
function latestExistingPath(history: string[]): string | null {
    for (let i = history.length - 1; i >= 0; i--) {
        try {
            if (fs.existsSync(history[i])) {
                return history[i];
            }
        } catch (e) {
            /* an unreadable path is as good as a missing one */
        }
    }
    return null;
}

/**
 * Lists a session's frames straight from disk.
 *
 * The directory listing is the authority for what exists -- deliberately, so a
 * stale counter in session.json can never cause a frame to be skipped or a
 * missing one to be demanded. Ordering and legacy-name handling live in
 * toFramePaths, so the panel and the exporter cannot disagree about them.
 */
function readFrames(folder: string): string[] {
    try {
        return toFramePaths(folder, fs.readdirSync(folder), nodePath.join);
    } catch (e) {
        return [];
    }
}
