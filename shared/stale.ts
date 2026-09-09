/**
 * Which recordings count as stale.
 *
 * "Archive stale" on the Recordings tab sweeps these off into the archive,
 * and "Select stale" on the Archive tab picks them out for deleting or
 * packing. Both use one rule, kept here so the panel can say how many a click
 * will touch before it is clicked: a recording with fewer frames than the
 * threshold (a test canvas, a doodle abandoned after two strokes), or one
 * created longer ago than the other threshold. Either alone is enough.
 *
 * Age is measured from when the recording began rather than the last frame,
 * as the thresholds in Settings say. A piece still being drawn that trips the
 * age rule is archived and comes straight back with the next frame, which is
 * how archiving already behaves; and a recording without a manifest has no
 * creation time, so age never applies to it.
 */

import { SessionSummary } from "./protocol";

export interface StaleCriteria {
    /** Fewer frames than this is stale; 0 ignores frame count. */
    maxFrames: number;
    /** Created more than this many days ago is stale; 0 ignores age. */
    afterDays: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function isStale(session: SessionSummary, criteria: StaleCriteria, now: number): boolean {
    if (criteria.maxFrames > 0 && session.frameCount < criteria.maxFrames) {
        return true;
    }
    if (
        criteria.afterDays > 0 &&
        session.createdAt > 0 &&
        now - session.createdAt > criteria.afterDays * DAY_MS
    ) {
        return true;
    }
    return false;
}

/**
 * The stale ones among `sessions`, leaving out what a bulk action could not
 * act on anyway: the take in progress, whose archive flag the next frame
 * would clear, and rows that are only an error -- a pointer to a folder that
 * has gone, with no manifest to flag.
 */
export function staleSessions(
    sessions: SessionSummary[],
    criteria: StaleCriteria,
    now: number,
    currentSessionId: string | null
): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        if (session.sessionId === currentSessionId || session.error) {
            continue;
        }
        if (isStale(session, criteria, now)) {
            out.push(session);
        }
    }
    return out;
}
