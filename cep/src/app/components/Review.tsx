import { JSX } from "preact";
import { SessionSummary } from "../../../../shared/protocol";
import { Translate, formatDuration } from "../i18n";
import { Dialog, Hint } from "./ui";
import { formatDate } from "./Sessions";

/** What the review did about the document of the recording in front. */
export type ReviewOpened =
    /** Opened it in Photoshop; the review closes it again when moving on. */
    | "opened"
    /** It was open already, and stays open. */
    | "already"
    /** The file is no longer where the recording last saw it. */
    | "missing"
    /** Never saved: nothing to open. */
    | "none"
    /** Photoshop refused; the error went to a toast. */
    | "error";

export type ReviewDecision = "delete" | "deleteWithFile";

export interface ReviewState {
    /** The recordings under review, in order. */
    ids: string[];
    index: number;
    /** Waiting on Photoshop to open the document in front. */
    opening: boolean;
    opened: ReviewOpened | null;
    decisions: { [sessionId: string]: ReviewDecision };
    /** Every recording has been looked at, or the review was stopped: time to apply. */
    summary: boolean;
}

export interface ReviewDialogProps {
    t: Translate;
    review: ReviewState;
    /** The recording in front, or null when the listing no longer has it. */
    session: SessionSummary | null;
    /** Where its document is, for the "no longer at" message. */
    lastKnownPath: string | null;
    onDecide: (decision: ReviewDecision | "keep") => void;
    onStop: () => void;
    onApply: () => void;
    onDiscard: () => void;
}

/**
 * The clean-up: each archived recording's document is opened in Photoshop
 * in turn, and the artist says keep, delete the recording, or delete both,
 * with the picture in front of them rather than a name in a list. Nothing
 * is deleted along the way; the decisions are applied together at the end,
 * behind one confirmation, so stopping half-way loses nothing and a slip
 * can be discarded.
 */
export function ReviewDialog(props: ReviewDialogProps): JSX.Element {
    const t = props.t;
    const review = props.review;
    const decided = Object.keys(review.decisions);
    const withFile = decided.filter((id) => review.decisions[id] === "deleteWithFile").length;

    if (review.summary) {
        return (
            <Dialog
                title={t("review.summaryTitle")}
                onDismiss={props.onDiscard}
                actions={
                    <>
                        <button type="button" onClick={props.onDiscard}>
                            {decided.length > 0 ? t("review.discard") : t("common.dismiss")}
                        </button>
                        {decided.length > 0 ? (
                            <button type="button" class="primary" onClick={props.onApply}>
                                {t("review.apply")}
                            </button>
                        ) : null}
                    </>
                }
            >
                <p class="dialog-text">
                    {decided.length > 0 ? t("review.summary", decided.length, withFile) : t("review.summaryNone")}
                </p>
            </Dialog>
        );
    }

    const session = props.session;
    const canDeleteFile = review.opened === "opened" || review.opened === "already";
    const waiting = review.opening;

    let status: string;
    switch (review.opened) {
        case "opened":
            status = t("review.opened");
            break;
        case "already":
            status = t("review.already");
            break;
        case "missing":
            status = t("review.missing", props.lastKnownPath || "");
            break;
        case "none":
            status = t("review.unsaved");
            break;
        case "error":
            status = t("review.failed");
            break;
        default:
            status = t("review.opening");
    }

    return (
        <Dialog
            title={t("review.title", review.index + 1, review.ids.length)}
            onDismiss={props.onStop}
            actions={
                <button type="button" disabled={waiting} onClick={props.onStop}>
                    {t("review.stop")}
                </button>
            }
        >
            <div class="review-name">{session ? session.docName : review.ids[review.index]}</div>
            {session ? (
                <div class="session-meta">
                    {t("sessions.frames", session.frameCount, formatDuration(session.timeSpentSec, t))}
                    {session.lastModifiedAt > 0 ? " · " + formatDate(session.lastModifiedAt) : ""}
                </div>
            ) : null}
            <Hint>{status}</Hint>
            <div class="review-choices">
                <button type="button" disabled={waiting} onClick={() => props.onDecide("keep")}>
                    {t("review.keep")}
                </button>
                <button type="button" class="danger-text" disabled={waiting} onClick={() => props.onDecide("delete")}>
                    {t("review.delete")}
                </button>
                <button
                    type="button"
                    class="danger-text"
                    disabled={waiting || !canDeleteFile}
                    onClick={() => props.onDecide("deleteWithFile")}
                >
                    {t("review.deleteWithFile")}
                </button>
            </div>
            {decided.length > 0 ? <Hint>{t("review.soFar", decided.length, withFile)}</Hint> : null}
        </Dialog>
    );
}
