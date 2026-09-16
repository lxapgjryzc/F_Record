/**
 * Writing a session id without it landing in the wrong document.
 *
 * The script in stamp.ts is the only part of this plug-in that runs inside
 * Photoshop, and it is the part four earlier fixes in this area were built
 * around rather than on. So it is executed here for real -- against the
 * miniature ActionDescriptor world in photoshop.mjs -- and the case that
 * matters is driven directly: Photoshop is looking at another document when it
 * gets round to the write.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    NOT_FRONTMOST,
    STAMP_JSX,
    createDocumentStamper,
    escapePluginId,
    stampParams,
    stampScript
} from "../dist/modules/stamp.mjs";
import { makeJsxEngine, makePhotoshop } from "./photoshop.mjs";

const PLUGIN = "F_Record";

/* ------------------------------------------------------------- the params */

test("the plugin id is escaped the way generator-core escapes it", () => {
    // Photoshop keys may hold only letters, digits and underscores, and
    // generator-core replaces everything else with _<charCode>_. Reads go
    // through generator-core, so a different escaping here would write the
    // settings under a key nothing ever looks at.
    assert.equal(escapePluginId("F_Record"), "F_95_Record");
    assert.equal(escapePluginId("abc123"), "abc123");
    assert.equal(escapePluginId("a.b-c"), "a_46_b_45_c");
});

test("the settings travel as JSON, wrapped as Photoshop needs them", () => {
    const params = stampParams(7, PLUGIN, { sessionId: "s-1" });
    assert.deepEqual(params, {
        documentId: 7,
        key: "F_95_Record",
        settings: { json: '{"sessionId":"s-1"}' }
    });
});

test("the script carries its params in the prelude, as generator-core does", () => {
    const script = stampScript(7, PLUGIN, { sessionId: "s-1" });
    assert.match(script, /^var params = \{/);
    assert.ok(script.endsWith(STAMP_JSX), "the prelude is followed by the script itself");
    assert.ok(script.includes('"documentId":7'));
});

test("the script never names the document in the reference", () => {
    // Photoshop 27.2 refuses every form of that, and the one form it does not
    // refuse ignores the document and writes to the front anyway. Pinned here
    // because it reads like an obvious improvement to anyone who has not tried
    // it against the real thing.
    assert.ok(!STAMP_JSX.includes("putIdentifier"), "no identifier reference");
    assert.ok(!STAMP_JSX.includes("documentID"), "no documentID key either");
    assert.ok(STAMP_JSX.includes("frontmostDocumentId() === params.documentId"));
});

/* -------------------------------------------------------- the script runs */

function world(frontmost, open = [1, 2]) {
    const written = [];
    const engine = makeJsxEngine({
        frontmost: () => frontmost,
        isOpen: (id) => open.includes(id),
        write: (id, key, json) => written.push({ id, key, settings: JSON.parse(json) })
    });
    return { engine, written };
}

test("the write happens when Photoshop is looking at the right document", async () => {
    const w = world(1);
    const stamp = createDocumentStamper({ evaluateJSXString: w.engine }, PLUGIN);

    assert.equal(await stamp(1, { sessionId: "s-1" }), true);
    assert.deepEqual(w.written, [{ id: 1, key: "F_95_Record", settings: { sessionId: "s-1" } }]);
});

// The whole bug, in one test. The old code asked "is my document in front?" on
// this side of the wire and then sent a write that Photoshop aimed at whatever
// was in front when it ran. Here the question is asked inside the script, so
// there is no gap: a document that is not in front is not written to, and
// nothing else is written to in its place.
test("nothing is written when Photoshop is looking at another document", async () => {
    const w = world(2);
    const stamp = createDocumentStamper({ evaluateJSXString: w.engine }, PLUGIN);

    assert.equal(await stamp(1, { sessionId: "s-1" }), false, "reported, not assumed");
    assert.deepEqual(w.written, [], "document 2 keeps its own id");
});

test("nothing is written when no document is open at all", async () => {
    const w = world(null, []);
    const stamp = createDocumentStamper({ evaluateJSXString: w.engine }, PLUGIN);

    assert.equal(await stamp(1, { sessionId: "s-1" }), false);
    assert.deepEqual(w.written, []);
});

test("writing our key leaves another plug-in's settings alone", async () => {
    const ps = makePhotoshop();
    ps.setActive(1);
    await ps.gateway.setDocumentSettings(1, { sessionId: "ours" });

    // Some other Generator plug-in's entry, sitting in the same document.
    const other = createDocumentStamper(ps.generator, "Other_Plugin");
    await other(1, { theirs: true });

    assert.deepEqual(ps.peek(1), { sessionId: "ours" }, "ours is still there and unchanged");
    assert.deepEqual(
        await ps.generator.getDocumentSettingsForPlugin(1, "Other_Plugin"),
        { theirs: true }
    );
});

test("a document Photoshop has closed is reported as not written", async () => {
    const ps = makePhotoshop();
    ps.setActive(1);
    ps.close(1);
    const stamp = createDocumentStamper(ps.generator, PLUGIN);

    assert.equal(await stamp(1, { sessionId: "s-1" }), false);
    assert.equal(ps.peek(1), undefined);
});

/* --------------------------------------------------------- what came back */

test("only a plain refusal counts as a refusal", async () => {
    // Anything else is treated as "it may have been written", because the
    // caller reads the document back and that answer is worth more.
    assert.equal(NOT_FRONTMOST, "notFrontmost");

    const refused = createDocumentStamper({ evaluateJSXString: () => "  notFrontmost\n" }, PLUGIN);
    assert.equal(await refused(1, {}), false, "whitespace does not hide it");

    for (const answer of [undefined, 42, "written", "something else"]) {
        const stamp = createDocumentStamper({ evaluateJSXString: () => answer }, PLUGIN);
        assert.equal(await stamp(1, {}), true, "answer " + String(answer) + " is not a refusal");
    }
});

test("a Generator without evaluateJSXString is reported rather than ignored", async () => {
    await assert.rejects(
        () => createDocumentStamper({}, PLUGIN)(1, {}),
        /does not expose evaluateJSXString/
    );
    await assert.rejects(
        () => createDocumentStamper(null, PLUGIN)(1, {}),
        /does not expose evaluateJSXString/
    );
});

test("a script Photoshop throws on rejects rather than reporting success", async () => {
    const stamp = createDocumentStamper(
        {
            evaluateJSXString() {
                throw new Error("Photoshop is busy");
            }
        },
        PLUGIN
    );
    await assert.rejects(() => stamp(1, {}), /Photoshop is busy/);
});

test("naming the document in the reference is refused, as Photoshop refuses it", async () => {
    // Guards the fake itself: if it ever started honouring an identifier, the
    // tests above would go on passing while the real thing failed.
    const ps = makePhotoshop();
    ps.setActive(1);
    assert.throws(
        () =>
            ps.generator.evaluateJSXString(
                'var params = { key: "F_95_Record", settings: { json: "{}" }, documentId: 1 };\n' +
                    "var ref = new ActionReference();\n" +
                    'ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("generatorSettings"));\n' +
                    'ref.putIdentifier(charIDToTypeID("Dcmn"), params.documentId);\n' +
                    "var desc = new ActionDescriptor();\n" +
                    'desc.putReference(charIDToTypeID("null"), ref);\n' +
                    "var payload = new ActionDescriptor();\n" +
                    'payload.putString(stringIDToTypeID("json"), params.settings.json);\n' +
                    'desc.putObject(charIDToTypeID("T   "), charIDToTypeID("null"), payload);\n' +
                    'desc.putString(stringIDToTypeID("property"), params.key);\n' +
                    'executeAction(charIDToTypeID("setd"), desc, DialogModes.NO);\n'
            ),
        /Set is not currently available/
    );
});
