import { JSX } from "preact";
import { MoveDestination, SessionSummary } from "../../../../shared/protocol";
import { Translate, formatDuration } from "../i18n";
import { openInExplorer } from "../psHost";
import { Checkbox, GlyphButton, ProgressBar } from "./ui";

export interface SessionsProps {
    t: Translate;
    /** Which shelf this is: the recordings still in play, or the archive. */
    archived: boolean;
    sessions: SessionSummary[] | null;
    currentSessionId: string | null;
    busy: boolean;
    /** The rows the thresholds in Settings call stale; see shared/stale.ts. */
    stale: SessionSummary[];
    /** The thresholds in words, for the tooltip on the stale buttons. */
    staleRule: string;
    /** Archive tab only: the rows that are ticked, by session id. */
    selected: { [sessionId: string]: boolean };
    onSelect: (sessionId: string, selected: boolean) => void;
    /** Replaces the selection wholesale. */
    onSelectMany: (sessionIds: string[]) => void;
    onRefresh: () => void;
    onExport: (session: SessionSummary) => void;
    onDelete: (session: SessionSummary) => void;
    onOpenDocument: (session: SessionSummary) => void;
    onSwitchDocument: (session: SessionSummary) => void;
    onSetArchived: (session: SessionSummary, archived: boolean) => void;
    onMove: (session: SessionSummary, destination: MoveDestination) => void;
    /** Recordings tab: files every stale row under the archive. */
    onArchiveStale: () => void;
    /** Archive tab, on the ticked rows. */
    onOpenSelected: () => void;
    onPackSelected: () => void;
    onDeleteSelected: (withDocuments: boolean) => void;
    /** Archive tab: the one-at-a-time clean-up, over the ticked rows or all of them. */
    onReview: () => void;
}

/**
 * Every recording ever made, not just the open document's -- split across
 * two tabs by the `archived` flag, so the pieces still being drawn are not
 * buried under the ones that are done.
 *
 * This is possible because each session folder carries its own session.json,
 * so the list is built by reading the folders themselves rather than trusting
 * a central index that a crash or a manual file move could invalidate.
 *
 * The archive is also where recordings are dealt with in bulk: rows can be
 * ticked, the stale ones with one click, and the ticked rows opened, zipped
 * or deleted together. The Recordings tab has one bulk action of its own,
 * sweeping the stale rows into the archive.
 */
export function Sessions(props: SessionsProps): JSX.Element {
    const t = props.t;

    if (props.sessions === null) {
        return <div class="empty">{t("status.connecting")}</div>;
    }

    const rows = pinCurrent(props.sessions, props.currentSessionId);
    const header = props.archived ? (
        <ArchiveTools {...props} rows={rows} />
    ) : (
        <div class="row">
            <div class="toolbar">
                <button
                    type="button"
                    class="icon"
                    title={props.staleRule}
                    disabled={props.busy || props.stale.length === 0}
                    onClick={props.onArchiveStale}
                >
                    {t("sessions.archiveStale", props.stale.length)}
                </button>
            </div>
            <GlyphButton glyph="refresh" label={t("sessions.refresh")} disabled={props.busy} onClick={props.onRefresh} />
        </div>
    );

    if (rows.length === 0) {
        return (
            <div>
                {header}
                <div class="empty">{t(props.archived ? "archive.empty" : "sessions.empty")}</div>
            </div>
        );
    }

    return (
        <div>
            {header}
            {rows.map((session) => (
                <SessionRow
                    key={session.sessionId}
                    {...props}
                    session={session}
                    isCurrent={session.sessionId === props.currentSessionId}
                />
            ))}
        </div>
    );
}

/**
 * The take in progress goes first whatever its timestamps say. The listing
 * is sorted by last frame, which usually puts it there anyway, but a
 * recording just started has no frames yet, and one resumed after a break
 * sits below everything drawn on since.
 */
export function pinCurrent(sessions: SessionSummary[], currentSessionId: string | null): SessionSummary[] {
    if (!currentSessionId) {
        return sessions;
    }
    const current: SessionSummary[] = [];
    const rest: SessionSummary[] = [];
    for (let i = 0; i < sessions.length; i++) {
        (sessions[i].sessionId === currentSessionId ? current : rest).push(sessions[i]);
    }
    return current.concat(rest);
}

/** The hint, the selection tools, and -- once anything is ticked -- what can be done with it. */
function ArchiveTools(props: SessionsProps & { rows: SessionSummary[] }): JSX.Element {
    const t = props.t;
    const selectable = props.rows.filter((row) => !row.moving && !row.packing);
    const ticked = props.rows.filter((row) => !!props.selected[row.sessionId]);
    const allTicked = selectable.length > 0 && ticked.length >= selectable.length;
    const openable = ticked.filter((row) => row.filePathHistory.length > 0 && !row.error).length;

    return (
        <div>
            <p class="hint">{t("archive.hint")}</p>
            <div class="row">
                <div class="toolbar">
                    <button
                        type="button"
                        class="icon"
                        title={props.staleRule}
                        disabled={props.busy || props.stale.length === 0}
                        onClick={() => props.onSelectMany(props.stale.map((row) => row.sessionId))}
                    >
                        {t("archive.selectStale", props.stale.length)}
                    </button>
                    <button
                        type="button"
                        class="icon"
                        disabled={props.busy || selectable.length === 0}
                        onClick={() =>
                            props.onSelectMany(allTicked ? [] : selectable.map((row) => row.sessionId))
                        }
                    >
                        {allTicked ? t("archive.selectNone") : t("archive.selectAll")}
                    </button>
                    <button
                        type="button"
                        class="icon"
                        title={t("review.hint")}
                        disabled={props.busy || props.rows.length === 0}
                        onClick={props.onReview}
                    >
                        {t("archive.review")}
                    </button>
                </div>
                <GlyphButton glyph="refresh" label={t("sessions.refresh")} disabled={props.busy} onClick={props.onRefresh} />
            </div>
            {ticked.length > 0 ? (
                <div class="toolbar bulk">
                    <span class="muted toolbar-count">{t("archive.selected", ticked.length)}</span>
                    <button
                        type="button"
                        class="icon"
                        disabled={props.busy || openable === 0}
                        onClick={props.onOpenSelected}
                    >
                        {t("archive.openSelected", openable)}
                    </button>
                    <button type="button" class="icon" disabled={props.busy} onClick={props.onPackSelected}>
                        {t("archive.pack")}
                    </button>
                    <button
                        type="button"
                        class="icon danger-text"
                        disabled={props.busy}
                        onClick={() => props.onDeleteSelected(false)}
                    >
                        {t("archive.deleteSelected")}
                    </button>
                    <button
                        type="button"
                        class="icon danger-text"
                        disabled={props.busy}
                        onClick={() => props.onDeleteSelected(true)}
                    >
                        {t("archive.deleteWithFiles")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function SessionRow(props: SessionsProps & { session: SessionSummary; isCurrent: boolean }): JSX.Element {
    const t = props.t;
    const session = props.session;
    const isCurrent = props.isCurrent;
    const latestPath = newestPath(session);
    const inTransit = session.moving || session.packing || null;
    // A pointer whose folder has gone: nothing to open, export or move, and
    // the one useful thing left is to let the entry go.
    const gone = !!session.error && session.frameCount === 0;
    const beside = !!session.besideDocument;
    const locked = props.busy || inTransit !== null;

    return (
        <div class={"session" + (props.selected[session.sessionId] ? " selected" : "")}>
            <div class="session-title">
                {props.archived ? (
                    <Checkbox
                        checked={!!props.selected[session.sessionId]}
                        ariaLabel={t("archive.select", session.docName)}
                        disabled={locked}
                        onChange={(next) => props.onSelect(session.sessionId, next)}
                    />
                ) : null}
                <span class="session-name" title={session.folder}>
                    {session.docName}
                </span>
                {isCurrent ? <span class="badge">{t("sessions.current")}</span> : null}
            </div>
            <div class="session-meta">
                {t("sessions.frames", session.frameCount, formatDuration(session.timeSpentSec, t))}
                {session.lastModifiedAt > 0 ? " · " + formatDate(session.lastModifiedAt) : ""}
            </div>
            {session.error ? <div class="hint">{session.error}</div> : null}
            {inTransit ? (
                <ProgressBar
                    label={session.moving ? t("sessions.moving") : t("sessions.packing")}
                    percent={inTransit.total > 0 ? Math.round((inTransit.done / inTransit.total) * 100) : 0}
                />
            ) : (
                <div class="session-actions">
                    {/*
                      * The recording remembers every path its document was
                      * saved to, so the file can be reopened from here without
                      * hunting for it. A document that was never saved has
                      * nothing to open and gets neither button. The names
                      * carry the real extension -- "Open PSD" for most people,
                      * "Open TIF" when that is what they work in -- so they
                      * never lie.
                      *
                      * Switch is Open with the current document saved and
                      * closed first: one click from one piece to the next for
                      * whoever keeps a single canvas open. Pointless for the
                      * piece already being recorded, so it is off there.
                      */}
                    {latestPath && !gone ? (
                        <GlyphButton
                            glyph="enter"
                            label={t("sessions.switch", fileExtension(latestPath))}
                            detail={t("sessions.switch.hint") + "\n" + latestPath}
                            disabled={locked || isCurrent}
                            onClick={() => props.onSwitchDocument(session)}
                        />
                    ) : null}
                    {latestPath && !gone ? (
                        <GlyphButton
                            glyph="file"
                            label={t("sessions.openDocument", fileExtension(latestPath))}
                            detail={latestPath}
                            disabled={locked}
                            onClick={() => props.onOpenDocument(session)}
                        />
                    ) : null}
                    {!gone ? (
                        <GlyphButton
                            glyph="folder"
                            label={t("sessions.open")}
                            detail={session.folder}
                            onClick={() => openInExplorer(session.folder)}
                        />
                    ) : null}
                    {!gone ? (
                        <GlyphButton
                            glyph="film"
                            label={t("sessions.export")}
                            disabled={locked || session.frameCount === 0}
                            onClick={() => props.onExport(session)}
                        />
                    ) : null}
                    <span class="session-actions-gap" />
                    {/*
                      * The paperclip is a toggle: off, the frames live under
                      * the frames folder; on, they sit beside the document in
                      * a folder named after it. The generator refuses to move
                      * the take in progress, so the button says why it is off.
                      */}
                    {latestPath && !gone ? (
                        <GlyphButton
                            glyph="paperclip"
                            active={beside}
                            label={beside ? t("sessions.moveHome") : t("sessions.moveBeside", fileName(latestPath))}
                            detail={isCurrent ? t("sessions.moveLocked") : session.folder}
                            disabled={locked || isCurrent}
                            onClick={() => props.onMove(session, beside ? "root" : "document")}
                        />
                    ) : null}
                    {!gone ? (
                        <GlyphButton
                            glyph={props.archived ? "unarchive" : "archive"}
                            label={props.archived ? t("sessions.unarchive") : t("sessions.archive")}
                            disabled={locked}
                            onClick={() => props.onSetArchived(session, !props.archived)}
                        />
                    ) : null}
                    {/*
                      * Deleting the take you are in the middle of is the whole
                      * reason to delete one mid-session: it went wrong and you
                      * want to start over. The generator empties the folder
                      * and opens a fresh recording for the same document.
                      */}
                    <GlyphButton
                        glyph="trash"
                        danger
                        label={t("sessions.delete")}
                        disabled={locked}
                        onClick={() => props.onDelete(session)}
                    />
                </div>
            )}
        </div>
    );
}

/**
 * Where the document most recently lived. Save As appends to the history, so
 * the last entry is the file the artist is actually working in now.
 */
function newestPath(session: SessionSummary): string | null {
    const history = session.filePathHistory;
    return history.length > 0 ? history[history.length - 1] : null;
}

/** "PSD" for "C:\\art\\piece.psd"; "PSD" too when there is no extension to show. */
function fileExtension(filePath: string): string {
    const match = /\.([^.\\/]+)$/.exec(filePath);
    return match ? match[1].toUpperCase() : "PSD";
}

/** "piece.psd" for "C:\\art\\piece.psd". */
function fileName(filePath: string): string {
    const parts = filePath.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
}

export function formatDate(epochMs: number): string {
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
