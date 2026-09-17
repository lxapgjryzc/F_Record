import { JSX } from "preact";
import {
    SessionSummary,
    State,
    normalizeWatermark,
    watermarkDraws
} from "../../../../shared/protocol";
import { ConnectionStatus } from "../bridge";
import { Translate, formatDuration, formatMillis } from "../i18n";
import { Banner, ProgressBar, RecordDot, Row, Switch, recordingIndicator } from "./ui";
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
    /** True while the canvas is being copied to the clipboard. */
    copying: boolean;
    onToggleRecording: (next: boolean) => void;
    onResume: () => void;
    onAdopt: (sessionId: string) => void;
    onStartFresh: () => void;
    onExport: () => void;
    onCopyFrame: () => void;
}

export function Dashboard(props: DashboardProps): JSX.Element {
    const t = props.t;
    const state = props.state;

    if (props.status !== "connected" || !state) {
        return <ConnectionNotice t={t} status={props.status} detail={props.statusDetail} />;
    }

    const paused = state.health.pausedReason;
    const session = state.session;
    const document = state.document;
    // The switch belongs to the document in front: on when its recording is.
    const recording = !!session && session.recording;
    const indicator = recordingIndicator(state);

    // What the copy button will actually do, worked out the same way the
    // exporter works it out -- a "text" mark with nothing typed yet draws
    // nothing -- so the tooltip cannot promise a signature that is not coming.
    const marksClipboard =
        state.config.clipboardWatermark !== false &&
        watermarkDraws(normalizeWatermark(state.config.watermark));

    return (
        <div>
            <div class="record-head">
                <span class="record-state">
                    <RecordDot indicator={indicator} />
                    <span>{t(indicator.labelKey)}</span>
                </span>
                {/*
                  * Nothing open means nothing to switch, and a canvas too
                  * small to record cannot be switched on -- though one that
                  * shrank while recording can still be switched off.
                  */}
                <Switch
                    checked={recording}
                    disabled={!document || (!recording && document.tooSmall)}
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
                        {/*
                          * Copying the canvas sits next to Export because it
                          * is the same act at a smaller scale -- the picture,
                          * signed, ready to hand to someone. It asks the
                          * document rather than the recording, so it is on
                          * offer with no session and no frames yet; what it
                          * needs is something open to copy.
                          */}
                        <div class="record-actions">
                            <button
                                type="button"
                                class="icon"
                                disabled={!document || props.copying}
                                title={marksClipboard ? t("clipboard.hint") : t("clipboard.hint.plain")}
                                onClick={props.onCopyFrame}
                            >
                                {props.copying ? t("clipboard.working") : t("clipboard.button")}
                            </button>
                            <button
                                type="button"
                                class="primary"
                                disabled={!session || session.frameCount === 0 || props.copying}
                                onClick={props.onExport}
                            >
                                {t("export.button")}
                            </button>
                        </div>
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
