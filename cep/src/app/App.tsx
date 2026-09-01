import { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Config, ISSUES_URL, SessionSummary, State } from "../../../shared/protocol";
import { BridgeClient, ConnectionStatus } from "./bridge";
import { Translate, createTranslate } from "./i18n";
import { Banner, IssueButton, Toast, Toasts } from "./components/ui";
import { Dashboard, ExportJob } from "./components/Dashboard";
import { Sessions } from "./components/Sessions";
import { Settings } from "./components/Settings";
import { ExportChoice, ExportDialog } from "./components/ExportDialog";
import { FrameRef, toFrameRefs } from "../node/export";
import { runExport } from "../node/ffmpeg";
import { exportTempDir } from "../../../shared/paths";
import { mkdirp } from "../../../shared/compat";
import {
    chooseSavePath,
    makePanelPersistent,
    hostUiLocale,
    onThemeChanged,
    openInExplorer,
    openUrl,
    readHostTheme,
    writeFinalStill
} from "./psHost";

declare const require: (id: string) => any;
const fs = require("fs");
const nodePath = require("path");

type Tab = "dashboard" | "sessions" | "settings";

interface PendingExport {
    session: SessionSummary;
    /** True when this is the recording attached to the open document. */
    isCurrent: boolean;
}

export function App(): JSX.Element {
    const [state, setState] = useState<State | null>(null);
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [statusDetail, setStatusDetail] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>("dashboard");
    const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [pendingExport, setPendingExport] = useState<PendingExport | null>(null);
    const [exportJob, setExportJob] = useState<ExportJob | null>(null);
    const [updateBusy, setUpdateBusy] = useState(false);

    const clientRef = useRef<BridgeClient | null>(null);
    const toastId = useRef(1);

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
        if (tab === "sessions" && status === "connected") {
            refreshSessions();
        }
    }, [tab, status, refreshSessions]);

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
                        timing: choice.timing,
                        targetDurationSec: choice.targetDurationSec
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
            resolution: state.config.resolution
        };
    }, [state]);

    /* --------------------------------------------------------------- ui */

    const busy = exportJob !== null;

    return (
        <div class="app">
            <div class="tabs">
                <TabButton label={t("tab.dashboard")} active={tab === "dashboard"} onClick={() => setTab("dashboard")} />
                <TabButton label={t("tab.sessions")} active={tab === "sessions"} onClick={() => setTab("sessions")} />
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
                    />
                ) : null}

                {tab === "sessions" ? (
                    <Sessions
                        t={t}
                        sessions={sessions}
                        currentSessionId={state && state.session ? state.session.sessionId : null}
                        busy={busy}
                        onRefresh={refreshSessions}
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
                    onCancel={() => setPendingExport(null)}
                    onConfirm={(choice) => {
                        const target = pendingExport;
                        setPendingExport(null);
                        startExport(target, choice).catch((e: Error) =>
                            pushToast("negative", t("export.failed") + ": " + e.message)
                        );
                    }}
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


/**
 * Lists a session's frames straight from disk.
 *
 * The directory listing is the authority for what exists -- deliberately, so a
 * stale counter in session.json can never cause a frame to be skipped or a
 * missing one to be demanded. Ordering and legacy-name handling live in
 * toFrameRefs, so the panel and the exporter cannot disagree about them.
 */
function readFrames(folder: string): FrameRef[] {
    try {
        return toFrameRefs(folder, fs.readdirSync(folder), nodePath.join);
    } catch (e) {
        return [];
    }
}
