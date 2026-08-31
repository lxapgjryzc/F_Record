import { JSX } from "preact";
import { SessionSummary } from "../../../../shared/protocol";
import { Translate, formatDuration } from "../i18n";
import { openInExplorer } from "../psHost";

export interface SessionsProps {
    t: Translate;
    sessions: SessionSummary[] | null;
    currentSessionId: string | null;
    busy: boolean;
    onRefresh: () => void;
    onExport: (session: SessionSummary) => void;
    onDelete: (session: SessionSummary) => void;
}

/**
 * Every recording ever made, not just the open document's.
 *
 * This is possible because each session folder carries its own session.json,
 * so the list is built by reading the folders themselves rather than trusting
 * a central index that a crash or a manual file move could invalidate.
 */
export function Sessions(props: SessionsProps): JSX.Element {
    const t = props.t;

    if (props.sessions === null) {
        return <div class="empty">{t("status.connecting")}</div>;
    }
    if (props.sessions.length === 0) {
        return (
            <div>
                <div class="row">
                    <span />
                    <button type="button" class="icon" onClick={props.onRefresh}>
                        {t("sessions.refresh")}
                    </button>
                </div>
                <div class="empty">{t("sessions.empty")}</div>
            </div>
        );
    }

    return (
        <div>
            <div class="row">
                <span />
                <button type="button" class="icon" disabled={props.busy} onClick={props.onRefresh}>
                    {t("sessions.refresh")}
                </button>
            </div>
            {props.sessions.map((session) => {
                const isCurrent = session.sessionId === props.currentSessionId;
                return (
                    <div class="session" key={session.sessionId}>
                        <div class="session-title">
                            <span class="session-name" title={session.folder}>
                                {session.docName}
                            </span>
                            {isCurrent ? <span class="badge">{t("sessions.current")}</span> : null}
                        </div>
                        <div class="session-meta">
                            {t(
                                "sessions.frames",
                                session.frameCount,
                                formatDuration(session.timeSpentSec, t)
                            )}
                            {session.lastModifiedAt > 0
                                ? " · " + formatDate(session.lastModifiedAt)
                                : ""}
                        </div>
                        {session.error ? <div class="hint">{session.error}</div> : null}
                        <div class="session-actions">
                            <button
                                type="button"
                                class="icon"
                                disabled={props.busy || session.frameCount === 0}
                                onClick={() => props.onExport(session)}
                            >
                                {t("sessions.export")}
                            </button>
                            <button
                                type="button"
                                class="icon"
                                onClick={() => openInExplorer(session.folder)}
                            >
                                {t("sessions.open")}
                            </button>
                            {/*
                              * Deleting the take you are in the middle of is
                              * the whole reason to delete one mid-session:
                              * it went wrong and you want to start over. The
                              * generator empties the folder and opens a fresh
                              * recording for the same document.
                              */}
                            <button
                                type="button"
                                class="danger-text"
                                disabled={props.busy}
                                onClick={() => props.onDelete(session)}
                            >
                                {t("sessions.delete")}
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function formatDate(epochMs: number): string {
    const d = new Date(epochMs);
    return (
        d.getFullYear() +
        "-" + two(d.getMonth() + 1) +
        "-" + two(d.getDate()) +
        " " + two(d.getHours()) +
        ":" + two(d.getMinutes())
    );
}

function two(value: number): string {
    return value < 10 ? "0" + value : String(value);
}
