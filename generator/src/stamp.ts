/**
 * Writing a session id into a PSD, without it landing in the wrong one.
 *
 * Photoshop's Generator API is asymmetric. Reads name the document they want:
 *
 *     getGeneratorSettings.jsx   theRef.putIdentifier(classDocument, params.documentId)
 *
 * Writes cannot. Adobe's setGeneratorSettings.jsx targets
 * `putEnumerated(classDocument, typeOrdinal, enumTarget)` -- whichever document
 * is frontmost when Photoshop runs the script -- and that is not an oversight
 * we can route around. Probed against Photoshop 27.2 on 2026-09-09, every way
 * of naming the document in a `set` is refused:
 *
 *     property then putIdentifier(Dcmn, id)   "The command Set is not currently available"
 *     putIdentifier(Dcmn, id) then property   the same
 *     property then putIndex(Dcmn, 1)         the same
 *     setting the document object itself      the same
 *     enumTarget plus a documentID key        "succeeds" -- into the frontmost
 *                                             document, the key ignored
 *
 * That last one is the dangerous one, and it is the shape of the bug this
 * module exists to prevent: a write that reports success while going somewhere
 * else entirely.
 *
 * So the target cannot be named, and asking "is my document in front?" from
 * here and then writing is two facts about two different moments, separated by
 * an IPC round trip and by Photoshop's own event delivery lag. On 2026-09-09
 * that gap was four milliseconds wide: the id minted for a document created a
 * moment earlier landed in the PSD of the drawing the user had just switched
 * back to, and a 2460 frame recording was orphaned by the branch guard that
 * then, correctly, refused to let two documents record into one folder.
 *
 * What is left is to make Photoshop do the checking. The script below compares
 * `app.activeDocument.id` with the document it was sent for and writes only if
 * they match. Check and write are then one indivisible step inside Photoshop,
 * with no gap for a document switch to slip through, and the answer says which
 * happened. A write that did not happen is reported rather than assumed, and
 * the caller queues it and tries again; see SessionResolver.stamp, which also
 * reads the document back by id, because a write that says it succeeded has
 * only told us Photoshop ran the script.
 */

/** The slice of generator-core this module needs, so it can be faked. */
export interface JsxHost {
    evaluateJSXString(script: string, sharedEngineSafe?: boolean): unknown;
}

/**
 * Writes settings into a document's generatorSettings.
 *
 * Resolves true when Photoshop performed the write, false when it declined
 * because the document was not the one in front. An answer we cannot read
 * counts as true: the caller verifies by reading the document back, and that
 * is worth more than anything the write itself could claim.
 */
export type StampDocument = (
    documentId: number,
    settings: Record<string, unknown>
) => Promise<boolean>;

/**
 * Photoshop can only use letters, digits and underscores for object keys, so
 * generator-core escapes plugin ids before using one as a settings key. The
 * same escaping has to be used here or the settings would be written under a
 * key the reads never look at.
 */
export function escapePluginId(pluginId: string): string {
    return pluginId.replace(/[^a-zA-Z0-9]/g, function (char) {
        return "_" + char.charCodeAt(0) + "_";
    });
}

/** Photoshop declined: the document was not the one in front. */
export const NOT_FRONTMOST = "notFrontmost";

/**
 * The script Photoshop runs. Kept as source rather than assembled from pieces:
 * this is the one part of the plug-in that runs inside Photoshop, and being
 * able to read it next to Adobe's own setGeneratorSettings.jsx -- which it is
 * otherwise identical to -- is worth more than any abstraction over it.
 */
export const STAMP_JSX = [
    'var classProperty = charIDToTypeID("Prpr");',
    'var propNull = charIDToTypeID("null");',
    'var classNull = charIDToTypeID("null");',
    'var typeOrdinal = charIDToTypeID("Ordn");',
    'var enumTarget = charIDToTypeID("Trgt");',
    'var classDocument = charIDToTypeID("Dcmn");',
    'var propProperty = stringIDToTypeID("property");',
    'var actionSet = charIDToTypeID("setd");',
    'var keyTo = charIDToTypeID("T   ");',
    "",
    "function settingsDescriptor(settings) {",
    "    var desc = new ActionDescriptor();",
    "    for (var key in settings) {",
    "        if (settings.hasOwnProperty(key)) {",
    "            desc.putString(stringIDToTypeID(key), settings[key]);",
    "        }",
    "    }",
    "    return desc;",
    "}",
    "",
    "function writeSettings() {",
    "    var ref = new ActionReference();",
    '    ref.putProperty(classProperty, stringIDToTypeID("generatorSettings"));',
    "    ref.putEnumerated(classDocument, typeOrdinal, enumTarget);",
    "    var desc = new ActionDescriptor();",
    "    desc.putReference(propNull, ref);",
    "    desc.putObject(keyTo, classNull, settingsDescriptor(params.settings));",
    "    desc.putString(propProperty, params.key);",
    "    executeAction(actionSet, desc, DialogModes.NO);",
    "}",
    "",
    "function frontmostDocumentId() {",
    "    try {",
    "        return app.documents.length > 0 ? app.activeDocument.id : null;",
    "    } catch (e) {",
    "        return null;",
    "    }",
    "}",
    "",
    "// The check and the write, in one step Photoshop cannot be interrupted",
    "// between. Asking from outside and then writing is what put a session id",
    "// into the wrong document.",
    "var outcome;",
    "if (frontmostDocumentId() === params.documentId) {",
    "    writeSettings();",
    '    outcome = "written";',
    "} else {",
    '    outcome = "notFrontmost";',
    "}",
    "outcome;",
    ""
].join("\n");

/**
 * The `params` object the script reads, shaped as generator-core shapes it:
 * the settings are serialized because building the equivalent ActionDescriptor
 * by hand is harder, and wrapped as `{ json: ... }` because Photoshop needs an
 * object there. `documentId` is ours -- generator-core has no use for it,
 * because Adobe's script never checks.
 */
export function stampParams(
    documentId: number,
    pluginId: string,
    settings: Record<string, unknown>
): { documentId: number; key: string; settings: { json: string } } {
    return {
        documentId: documentId,
        key: escapePluginId(pluginId),
        settings: { json: JSON.stringify(settings) }
    };
}

/** The complete script, params prelude included, as generator-core sends it. */
export function stampScript(
    documentId: number,
    pluginId: string,
    settings: Record<string, unknown>
): string {
    return "var params = " + JSON.stringify(stampParams(documentId, pluginId, settings)) + ";\n" + STAMP_JSX;
}

export function createDocumentStamper(host: JsxHost, pluginId: string): StampDocument {
    return function stampDocument(documentId, settings) {
        if (!host || typeof host.evaluateJSXString !== "function") {
            return Promise.reject(
                new Error("this Photoshop's Generator does not expose evaluateJSXString")
            );
        }
        // Shared-engine safe, as generator-core runs its own settings scripts:
        // the write touches no script-engine state worth isolating, and the
        // isolated engine is slow enough to matter at this call rate.
        //
        // `new Promise` rather than `Promise.resolve`: a host that throws where
        // it should reject is a failed write like any other, and the caller's
        // retry handles it.
        return new Promise<unknown>((resolve) => {
            resolve(host.evaluateJSXString(stampScript(documentId, pluginId, settings), true));
        }).then(performed);
    };
}

function performed(answer: unknown): boolean {
    return typeof answer !== "string" || answer.replace(/^\s+|\s+$/g, "") !== NOT_FRONTMOST;
}
