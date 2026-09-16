/**
 * Bulk housekeeping: deleting recordings together with their documents, and
 * packing them into zips.
 *
 * Everything here takes what it needs by argument -- the listing, the
 * function that sends a file to the bin, the reason a recording is off
 * limits -- so it runs in a test without a Photoshop or a Recycle Bin. The
 * plug-in in index.ts supplies the real ones.
 */

import * as path from "path";
import { DeleteItem, SessionSummary } from "../../shared/protocol";
import { exists } from "../../shared/compat";
import {
    deleteSession,
    listFilesRecursively,
    locateSession,
    newestExistingPath,
    normalizePath,
    readManifest
} from "./store";
import { Trash } from "./trash";
import { ZipEntry } from "./zip";

/** Why a recording cannot be acted on right now, or null when it can. */
export type Refusal = (sessionId: string) => string | null;

/** The file a recording belongs to, or null when none of its paths is on disk. */
export function documentOf(session: SessionSummary): string | null {
    return newestExistingPath(session.filePathHistory || []);
}

/* ---------------------------------------------------------------- delete */

export interface DeleteOutcome {
    /** Recordings that are gone, for the index to forget. */
    deleted: string[];
    /** Recordings and documents that stayed, and why, one line each. */
    warnings: string[];
}

/**
 * Deletes several recordings, each optionally with its document.
 *
 * The documents go to the bin first, all in one call, and only a recording
 * whose document went is deleted afterwards: the artist asked for both, and
 * a recording gone while its file stayed is the state they would not have
 * chosen. A document that another recording still belongs to -- the same
 * file recorded twice, or the original side of a Save As whose copy has
 * since been deleted -- is kept and said so, since deleting it would take
 * that other recording's file out from under it.
 */
export async function deleteSessions(
    root: string,
    items: DeleteItem[],
    sessions: SessionSummary[],
    trash: Trash,
    refuse: Refusal
): Promise<DeleteOutcome> {
    const warnings: string[] = [];
    const deleted: string[] = [];
    const byId: { [sessionId: string]: SessionSummary } = {};
    for (let i = 0; i < sessions.length; i++) {
        byId[sessions[i].sessionId] = sessions[i];
    }

    interface Planned {
        sessionId: string;
        name: string;
        document: string | null;
    }
    const plan: Planned[] = [];
    const going: { [sessionId: string]: boolean } = {};
    for (let i = 0; i < items.length; i++) {
        const session = byId[items[i].sessionId];
        const name = session ? session.docName : items[i].sessionId;
        const reason = refuse(items[i].sessionId);
        if (reason) {
            warnings.push(name + ": " + reason);
            continue;
        }
        going[items[i].sessionId] = true;
        plan.push({
            sessionId: items[i].sessionId,
            name: name,
            document: items[i].withDocument && session ? documentOf(session) : null
        });
    }

    // A file two recordings belong to is kept unless both are going.
    for (let i = 0; i < plan.length; i++) {
        const file = plan[i].document;
        if (!file) {
            continue;
        }
        const owner = otherOwner(file, plan[i].sessionId, sessions, going);
        if (owner) {
            warnings.push(plan[i].name + ": kept " + file + ", which '" + owner.docName + "' also belongs to");
            plan[i].document = null;
        }
    }

    const files: string[] = [];
    for (let i = 0; i < plan.length; i++) {
        if (plan[i].document && files.indexOf(plan[i].document as string) === -1) {
            files.push(plan[i].document as string);
        }
    }
    const failed: { [normalized: string]: string } = {};
    if (files.length > 0) {
        try {
            const result = await trash(files);
            for (let i = 0; i < result.failed.length; i++) {
                failed[normalizePath(result.failed[i].file)] = result.failed[i].error;
            }
        } catch (e) {
            for (let i = 0; i < files.length; i++) {
                failed[normalizePath(files[i])] = errorText(e);
            }
        }
    }

    for (let i = 0; i < plan.length; i++) {
        const file = plan[i].document;
        if (file && failed[normalizePath(file)]) {
            warnings.push(
                plan[i].name + ": kept, " + file + " could not be sent to the Recycle Bin (" +
                    failed[normalizePath(file)] + ")"
            );
            continue;
        }
        try {
            deleteSession(root, plan[i].sessionId);
            deleted.push(plan[i].sessionId);
        } catch (e) {
            warnings.push(plan[i].name + ": " + errorText(e));
        }
    }
    return { deleted: deleted, warnings: warnings };
}

/** A recording, not among those going, whose document is this file. */
function otherOwner(
    file: string,
    sessionId: string,
    sessions: SessionSummary[],
    going: { [sessionId: string]: boolean }
): SessionSummary | null {
    const wanted = normalizePath(file);
    for (let i = 0; i < sessions.length; i++) {
        const other = sessions[i];
        if (other.sessionId === sessionId || going[other.sessionId]) {
            continue;
        }
        const theirs = documentOf(other);
        if (theirs && normalizePath(theirs) === wanted) {
            return other;
        }
    }
    return null;
}

/* ------------------------------------------------------------------ pack */

export interface PackPlan {
    sessionId: string;
    /** The zip to write; does not exist yet. */
    zip: string;
    entries: ZipEntry[];
    /** The document going in beside the frames, if it is on disk. */
    document: string | null;
}

/**
 * What goes into a recording's zip, and where: `dragon.psd` at the top and
 * the frames under `dragon_frames/`, mirroring what the paperclip lays out
 * beside the document on disk, with session.json among the frames so the
 * folder can be dropped straight back into the frames folder and listed.
 * The zip is named after the document, or after the recording's title when
 * the document was never saved, and steps aside from a zip already there.
 */
export function planPack(root: string, sessionId: string, folder: string): PackPlan {
    const source = locateSession(root, sessionId);
    if (!source) {
        throw new Error("Session '" + sessionId + "' no longer exists");
    }
    const manifest = readManifest(source);
    const document = newestExistingPath(manifest ? manifest.filePathHistory || [] : []);
    const base =
        (document
            ? path.basename(document).replace(/\.[^.]+$/, "")
            : safeFileName(manifest ? manifest.docName : "")) || sessionId;

    const entries: ZipEntry[] = [];
    if (document) {
        entries.push({ name: path.basename(document), source: document });
    }
    const files = listFilesRecursively(source);
    for (let i = 0; i < files.length; i++) {
        entries.push({
            name: base + "_frames/" + files[i].replace(/\\/g, "/"),
            source: path.join(source, files[i])
        });
    }
    return { sessionId: sessionId, zip: freeZipName(folder, base), entries: entries, document: document };
}

/** A document title made safe as a file name; empty when nothing survives. */
export function safeFileName(title: string): string {
    return String(title || "")
        .replace(/\.[^.]+$/, "")
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
        .replace(/^[\s.]+|[\s.]+$/g, "");
}

/** `base.zip`, or `base_2.zip` and so on when that name is taken. */
export function freeZipName(folder: string, base: string): string {
    const wanted = path.join(folder, base + ".zip");
    if (!exists(wanted) && !exists(wanted + ".part")) {
        return wanted;
    }
    for (let n = 2; n < 10000; n++) {
        const candidate = path.join(folder, base + "_" + n + ".zip");
        if (!exists(candidate) && !exists(candidate + ".part")) {
            return candidate;
        }
    }
    throw new Error("No free name for '" + wanted + "'");
}

function errorText(e: unknown): string {
    return e && (e as Error).message ? (e as Error).message : String(e);
}
