import { JSX } from "preact";
import { SessionSummary, State } from "../../../../shared/protocol";
import { ConnectionStatus } from "../bridge";
import { Translate, formatDuration, formatMillis } from "../i18n";
import { Banner, ProgressBar, Row, Switch } from "./ui";
import { openInExplorer } from "../psHost";

export interface ExportJob {
    label: string;
    percent: number;
}

export interface DashboardProps {
    t: Translate;
    state: State | null;
    status: ConnectionStatus;
    statusDetail: string | null;
    exportJob: ExportJob | null;
    onToggleRecording: (next: boolean) => void;
    onResume: () => void;
    onAdopt: (sessionId: string) => void;
    onStartFresh: () => void;
    onExport: () => void;
}

export function Dashboard(props: DashboardProps): JSX.Element {
    const t = props.t;
    const state = props.state;

    if (props.status !== "connected" || !state) {
        return <ConnectionNotice t={t} status={props.status} detail={props.statusDetail} />;
    }

    const paused = state.health.pausedReason;
    const recording = state.config.enabled;
    const session = state.session;
    const document = state.document;
    const capturing = state.health.capturing;

    let dotClass = "dot";
    let stateLabel = t("record.off");
    if (recording && paused) {
        dotClass = "dot paused";
        stateLabel = t("record.paused");
    } else if (recording && session) {
        dotClass = capturing ? "dot live" : "dot ok";
        stateLabel = t("record.on");
    }

    return (
        <div>
            <div class="record-head">
                <span class="record-state">
                    <span class={dotClass} />
                    <span>{stateLabel}</span>
                </span>
                <Switch
                    checked={recording}
                    label={recording ? t("record.stop") : t("record.start")}
                    onChange={props.onToggleRecording}
                />
            </div>

            {paused ? (
                <Banner
                    tone="error"
                    title={t("record.paused")}
                    body={paused}
                    actions={
                        <button type="button" class="primary" onClick={props.onResume}>
                            {t("record.start")}
                        </button>
                    }
                />
            ) : null}

            {state.resumeCandidates.length > 0 ? (
                <ResumeOffer
                    t={t}
                    candidates={state.resumeCandidates}
                    onAdopt={props.onAdopt}
                    onStartFresh={props.onStartFresh}
                />
            ) : null}

            <div class="section">
                <Row label={t("doc.title")}>
                    {document ? document.name : <span class="muted">{t("doc.none")}</span>}
                </Row>
                {document && document.tooSmall ? <p class="hint">{t("doc.tooSmall")}</p> : null}

                {document && !session && !document.tooSmall && state.resumeCandidates.length === 0 ? (
                    <Banner
                        tone="info"
                        title={t("doc.noSession")}
                        actions={
                            <button type="button" class="primary" onClick={props.onStartFresh}>
                                {t("doc.startForThis")}
                            </button>
                        }
                    />
                ) : null}

                <Row label={t("stat.frames")}>{session ? session.frameCount : "—"}</Row>
                <Row label={t("stat.time")}>
                    {session ? formatDuration(session.timeSpentSec, t) : "—"}
                </Row>
                <Row label={t("stat.capture")}>
                    <span class="muted">
                        {formatMillis(state.health.lastCaptureMs, t)}
                        {" · "}
                        {t("stat.interval", (state.health.nextIntervalMs / 1000).toFixed(1) + t("unit.secondShort"))}
                    </span>
                </Row>
                {state.health.encoder === "js" ? (
                    <p class="hint">{t("stat.encoder.js")}</p>
                ) : null}
            </div>

            <div class="section">
                {props.exportJob ? (
                    <ProgressBar label={props.exportJob.label} percent={props.exportJob.percent} />
                ) : (
                    <div class="row">
                        {session && session.folder ? (
                            <button
                                type="button"
                                class="icon"
                                onClick={() => openInExplorer(session.folder)}
                            >
                                {t("sessions.open")}
                            </button>
                        ) : (
                            <span />
                        )}
                        <button
                            type="button"
                            class="primary"
                            disabled={!session || session.frameCount === 0}
                            onClick={props.onExport}
                        >
                            {t("export.button")}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function ResumeOffer(props: {
    t: Translate;
    candidates: SessionSummary[];
    onAdopt: (sessionId: string) => void;
    onStartFresh: () => void;
}): JSX.Element {
    const t = props.t;
    return (
        <Banner
            tone="info"
            title={t("resume.title")}
            body={t("resume.body")}
            actions={
                <div>
                    {props.candidates.slice(0, 3).map((candidate) => (
                        <button
                            key={candidate.sessionId}
                            type="button"
                            class="icon"
                            onClick={() => props.onAdopt(candidate.sessionId)}
                        >
                            {candidate.docName + " · " + t("resume.frames", candidate.frameCount)}
                        </button>
                    ))}
                    <button type="button" class="icon" onClick={props.onStartFresh}>
                        {t("resume.fresh")}
                    </button>
                </div>
            }
        />
    );
}

/**
 * The state 3.x could not express: a panel that is running while the thing
 * doing the recording is not. Saying so is the whole point.
 */
function ConnectionNotice(props: {
    t: Translate;
    status: ConnectionStatus;
    detail: string | null;
}): JSX.Element {
    const t = props.t;
    if (props.status === "connecting") {
        return (
            <div class="empty">
                <p>{t("status.connecting")}</p>
            </div>
        );
    }
    if (props.status === "mismatch") {
        return (
            <Banner
                tone="error"
                title={t("status.mismatch")}
                body={props.detail || t("status.mismatch.hint")}
            />
        );
    }
    return (
        <Banner
            tone="warn"
            title={t("status.unavailable")}
            body={
                <span>
                    {t("status.unavailable.hint")}
                    {props.detail ? <span class="muted">{" (" + props.detail + ")"}</span> : null}
                </span>
            }
        />
    );
}
