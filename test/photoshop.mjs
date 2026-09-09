/**
 * A Photoshop that lies the way the real one does.
 *
 * The fakes this replaces all stored a written setting straight onto the
 * document the caller named, which is the one thing Photoshop does not do:
 * `setGeneratorSettings.jsx` writes to whatever document is frontmost when
 * Photoshop runs the script, and the caller only finds out afterwards, if it
 * looks. A test suite built on that assumption cannot express the bug that
 * orphaned a 2460 frame recording on 2026-09-09, which is why four rounds of
 * fixes in this area all passed their tests and shipped anyway.
 *
 * So this models the parts that actually bite:
 *
 *   - the write is a script; Photoshop runs it when it gets round to it, and
 *     everything the user did in the meantime has already happened
 *   - a reference that names the document is refused, as Photoshop refuses it
 *   - reads are by document id and are always accurate
 *   - settings live per document and are wiped by Save As
 *
 * The script is really executed -- `makeJsxEngine` evaluates it against a
 * miniature ActionDescriptor world -- so the JSX in stamp.ts is under test
 * here too, rather than being a string nobody runs outside Photoshop.
 */

import { createDocumentStamper, escapePluginId } from "../dist/modules/stamp.mjs";

const PLUGIN_ID = "F_Record";

/* --------------------------------------------------- the ExtendScript world */

class FakeActionReference {
    constructor() {
        this.property = null;
        this.target = null;
    }
    putProperty(_class, key) {
        this.property = key;
    }
    putIdentifier(_class, id) {
        this.target = { form: "identifier", id };
    }
    putEnumerated(_class, _form, _value) {
        this.target = { form: "enumerated" };
    }
}

class FakeActionDescriptor {
    constructor() {
        this.entries = new Map();
    }
    putString(key, value) {
        this.entries.set(key, value);
    }
    putReference(key, value) {
        this.entries.set(key, value);
    }
    putObject(key, _class, value) {
        this.entries.set(key, value);
    }
}

/**
 * Evaluates a script the way Photoshop does: the value of its last expression
 * comes back. `eval` is what gives us that completion value -- a Function body
 * would return undefined -- and the globals arrive as parameters, so the
 * script sees exactly the names ExtendScript provides and nothing else.
 */
function runJsx(source, globals) {
    const names = Object.keys(globals);
    const runner = new Function(...names, "__source", "return eval(__source);");
    return runner(...names.map((name) => globals[name]), source);
}

/**
 * An `evaluateJSXString` for a fake Photoshop.
 *
 * `world` supplies what Photoshop knows at the moment the script runs, which
 * is the whole point: `frontmost()` is read *during* execution, not when the
 * script was sent.
 *
 *   frontmost()          the document in front right now, or null
 *   isOpen(id)           whether Photoshop still has that document
 *   write(id, key, json) stores one entry of a document's generatorSettings
 *   writesFail()         true while Photoshop is refusing to store settings
 */
export function makeJsxEngine(world) {
    const writesFail = world.writesFail || (() => false);

    function executeSet(descriptor) {
        const reference = descriptor.entries.get("c:null");
        if (!reference || reference.property !== "s:generatorSettings") {
            throw new Error("unsupported reference");
        }

        if (reference.target.form === "identifier") {
            // Verified against Photoshop 27.2 on 2026-09-09: naming the
            // document in a generatorSettings `set` is refused, in every
            // form. See the header of stamp.ts.
            throw new Error("General Photoshop error occurred. - The command Set is not currently available.");
        }
        // The frontmost document *now*, not the one the caller had in mind
        // when it sent the script.
        const documentId = world.frontmost();

        if (documentId === null || !world.isOpen(documentId)) {
            throw new Error("no such document");
        }
        if (writesFail()) {
            throw new Error("Photoshop rejected the write");
        }

        world.write(
            documentId,
            descriptor.entries.get("s:property"),
            descriptor.entries.get("c:T   ").entries.get("s:json")
        );
        return documentId;
    }

    const app = {
        get documents() {
            return { length: world.frontmost() === null ? 0 : 1 };
        },
        get activeDocument() {
            const id = world.frontmost();
            if (id === null) {
                throw new Error("No such element");
            }
            return { id };
        }
    };

    const globals = {
        charIDToTypeID: (id) => "c:" + id,
        stringIDToTypeID: (id) => "s:" + id,
        ActionReference: FakeActionReference,
        ActionDescriptor: FakeActionDescriptor,
        DialogModes: { NO: "no" },
        app,
        executeAction: (action, descriptor) => {
            if (action !== "c:setd") {
                throw new Error("unsupported action " + action);
            }
            return executeSet(descriptor);
        }
    };

    return (script) => runJsx(script, globals);
}

/* ----------------------------------------------------------- the fake host */

export function makePhotoshop() {
    /** id -> { open, settings }, where settings is Photoshop's generatorSettings. */
    const documents = new Map();
    let frontmost = null;
    let writesFail = false;
    let beforeExecute = null;
    const scripts = [];

    function document(id) {
        let doc = documents.get(id);
        if (!doc) {
            doc = { open: false, settings: {} };
            documents.set(id, doc);
        }
        return doc;
    }

    const engine = makeJsxEngine({
        frontmost: () => frontmost,
        isOpen: (id) => documents.has(id) && documents.get(id).open,
        write: (id, key, json) => {
            document(id).settings[key] = json;
        },
        writesFail: () => writesFail
    });

    const generator = {
        async getDocumentSettingsForPlugin(documentId, pluginId) {
            const doc = documents.get(documentId);
            const raw = doc && doc.settings[escapePluginId(pluginId)];
            if (raw === undefined) {
                // generator-core throws rather than returning {} when a
                // document has no generatorSettings at all.
                throw new Error("no generatorSettings");
            }
            return JSON.parse(raw);
        },
        evaluateJSXString(script) {
            scripts.push(script);
            // Photoshop runs the script when it gets round to it. Everything
            // the user did in the meantime has already happened by the time
            // the reference inside is resolved.
            if (beforeExecute) {
                beforeExecute();
            }
            return engine(script);
        }
    };

    const stampDocument = createDocumentStamper(generator, PLUGIN_ID);

    return {
        /** Photoshop bringing a document to the front, opening it if new. */
        setActive(id) {
            document(id).open = true;
            frontmost = id;
        },
        /** A document that is open but not in front. */
        open(id) {
            document(id).open = true;
        },
        /** Photoshop closing a document, with or without telling us. */
        close(id) {
            document(id).open = false;
            if (frontmost === id) {
                frontmost = null;
            }
        },
        frontmost() {
            return frontmost;
        },
        /** What Photoshop does to a document's settings on Save As. */
        wipeSettings(id) {
            document(id).settings = {};
        },
        /** What a file on disk carries, dropped into a document as it opens. */
        setSettings(id, settings) {
            document(id).settings = { [escapePluginId(PLUGIN_ID)]: JSON.stringify(settings) };
        },
        /** The same file opened again under a new document id, settings and all. */
        carrySettings(fromId, toId) {
            document(toId).settings = { ...document(fromId).settings };
        },
        /** Photoshop refusing to store settings, e.g. while a dialog is up. */
        setWritesFail(value) {
            writesFail = value;
        },
        /**
         * Runs just before Photoshop executes a write script -- the gap the old
         * code could not see into. A test switches documents in here.
         */
        onBeforeExecute(fn) {
            beforeExecute = fn;
        },
        /** This plug-in's settings as they really sit in the document. */
        peek(id) {
            const doc = documents.get(id);
            const raw = doc && doc.settings[escapePluginId(PLUGIN_ID)];
            return raw === undefined ? undefined : JSON.parse(raw);
        },
        scripts,
        generator,
        gateway: {
            getDocumentSettings: (documentId) =>
                generator.getDocumentSettingsForPlugin(documentId, PLUGIN_ID),
            setDocumentSettings: (documentId, settings) => stampDocument(documentId, settings),
            async isDocumentOpen(documentId) {
                const doc = documents.get(documentId);
                return !!doc && doc.open;
            }
        }
    };
}
