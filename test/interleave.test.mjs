/**
 * The invariants, checked against every interleaving we can think of.
 *
 * Four rounds of fixes in this area each closed the one interleaving that had
 * been observed, and each shipped a test that pinned exactly that sequence.
 * The fifth arrived on 2026-09-09 anyway. The difference here is that the
 * scenarios are not fixed sequences: the moment Photoshop switches documents
 * relative to a write is a parameter, and every value of it is run.
 *
 * The invariants are the promise the plug-in makes to the artist:
 *
 *   1. one session, one open document -- two drawings never interleave their
 *      frames into a single folder
 *   2. a recording with frames in it is never orphaned: while its document is
 *      open, that document still resolves to it
 *   3. a document records into a folder that belongs to its own file
 *   4. frames already on disk are never lost
 *
 * A harness that cannot fail is worth nothing, so the last test drives the
 * same scenario through a write shaped like the old one and shows it landing
 * in the wrong PSD.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { SessionResolver } from "../dist/modules/session.mjs";
import { SessionIndex } from "../dist/modules/store.mjs";
import { tempDir, withIsolatedAppDir } from "./helpers.mjs";
import { makePhotoshop } from "./photoshop.mjs";

const BOUNDS = { top: 0, left: 0, right: 6250, bottom: 4167 };
const SEP = String.fromCharCode(92);
const DESKTOP = "C:" + SEP + "Users" + SEP + "Admin" + SEP + "Desktop" + SEP;

/* --------------------------------------------------------------- the world */

function makeWorld() {
    // See the note in session.test.mjs: the recovery index is read from
    // %APPDATA%, so each world needs one of its own.
    const app = withIsolatedAppDir();
    const folders = tempDir();
    const temp = { dir: folders.dir, cleanup: () => { folders.cleanup(); app.cleanup(); } };
    const processImageFolderPath = path.join(temp.dir, "processImages");
    fs.mkdirSync(processImageFolderPath, { recursive: true });

    const config = {
        enabled: true,
        autoStart: false,
        autoStartNewDocuments: true,
        processImageFolderPath,
        resolution: "1080",
        quality: 70,
        idleTimeoutMinutes: 1,
        minIntervalMs: 1500,
        minCanvasPixels: 0,
        language: "zh-CN",
        format: "jpg"
    };

    const ps = makePhotoshop();
    const index = new SessionIndex("run-1");
    const logs = [];
    const resolver = new SessionResolver(ps.gateway, index, (level, message) =>
        logs.push(level + ": " + message)
    );

    /** documentId -> the file Photoshop reports for it. */
    const files = new Map();
    /** documentId -> the session the plug-in last resolved for it. */
    const sessionOf = new Map();
    const open = new Set();
    let highWater = 0;

    function folderOf(sessionId) {
        return path.join(processImageFolderPath, sessionId);
    }

    function allSessions() {
        return fs
            .readdirSync(processImageFolderPath)
            .filter((name) => fs.existsSync(path.join(processImageFolderPath, name, "session.json")))
            .map((name) => ({
                sessionId: name,
                manifest: JSON.parse(
                    fs.readFileSync(path.join(processImageFolderPath, name, "session.json"), "utf8")
                ),
                frames: fs.readdirSync(path.join(processImageFolderPath, name)).filter((f) => f.endsWith(".jpg"))
            }));
    }

    const world = {
        temp,
        config,
        ps,
        logs,
        sessionOf,
        allSessions,

        /** Photoshop opening a document and bringing it to the front. */
        newDocument(id, file) {
            files.set(id, file);
            open.add(id);
            ps.setActive(id);
        },
        switchTo(id) {
            ps.setActive(id);
        },
        close(id) {
            open.delete(id);
            ps.close(id);
        },
        /** The first save of an untitled document: it gains a path, keeps its id. */
        save(id, file) {
            files.set(id, file);
            fs.writeFileSync(path.join(temp.dir, path.basename(file)), "psd");
        },

        /** The plug-in resolving whichever document Photoshop says is in front. */
        async sync(id) {
            const outcome = await resolver.resolve(
                { id, file: files.get(id), bounds: BOUNDS },
                config,
                true
            );
            if (outcome.session) {
                sessionOf.set(id, outcome.session.sessionId);
            }
            world.check();
            return outcome;
        },

        /** Frames landing in whatever folder the document is attached to. */
        draw(id, count) {
            const sessionId = sessionOf.get(id);
            assert.ok(sessionId, "document " + id + " has nowhere to record");
            const folder = folderOf(sessionId);
            const existing = fs.readdirSync(folder).filter((f) => f.endsWith(".jpg")).length;
            for (let i = 1; i <= count; i++) {
                const seq = String(existing + i).padStart(6, "0");
                fs.writeFileSync(path.join(folder, seq + "_" + (1700000000000 + i * 1000) + ".jpg"), "x");
            }
            world.check();
        },

        async flushStamps() {
            await resolver.flushPendingStamps();
            world.check();
        },

        /** Every invariant, after every step. */
        check() {
            const sessions = allSessions();

            // 1. One session, one open document.
            const claimedBy = new Map();
            for (const [documentId, sessionId] of sessionOf) {
                if (!open.has(documentId)) {
                    continue;
                }
                assert.equal(
                    claimedBy.has(sessionId),
                    false,
                    "session " + sessionId + " is claimed by documents " +
                        claimedBy.get(sessionId) + " and " + documentId
                );
                claimedBy.set(sessionId, documentId);
            }

            // 2 and 3. A recording with frames belongs to a file; while that
            //          file is open, its document must still resolve to it.
            for (const session of sessions) {
                if (session.frames.length === 0) {
                    continue;
                }
                const history = session.manifest.filePathHistory || [];
                for (const [documentId, file] of files) {
                    if (!open.has(documentId) || !history.includes(file)) {
                        continue;
                    }
                    assert.equal(
                        sessionOf.get(documentId),
                        session.sessionId,
                        "document " + documentId + " ('" + file + "') has lost recording " +
                            session.sessionId + ", which holds " + session.frames.length + " frames"
                    );
                }
            }

            // 4. Frames already written are never lost.
            const total = sessions.reduce((sum, session) => sum + session.frames.length, 0);
            assert.ok(total >= highWater, "frames went missing: " + total + " < " + highWater);
            highWater = total;
        }
    };

    return world;
}

/* ------------------------------------------------------- the 2026-09-09 run */

/**
 * What actually happened, as the log recorded it.
 *
 * Photoshop had just restarted with L15big1.psd open and recording. The artist
 * pressed File > New; Photoshop reported the new document as frontmost, and
 * 0.7 seconds later reported the old one as frontmost again. The plug-in's
 * write for the new document was in flight across that switch.
 *
 * `frontmostDuringWrite` is the whole point: it is the document Photoshop
 * really has in front when it gets round to running the write script, which
 * on the day was not the one the write was meant for.
 */
async function replayNewDocumentDuringWrite(world, frontmostDuringWrite) {
    // L15big1.psd, open and part-drawn.
    world.newDocument(59, DESKTOP + "L15big1.psd");
    await world.sync(59);
    world.draw(59, 2460);
    const original = world.sessionOf.get(59);

    // File > New. Photoshop says the new document is in front.
    world.newDocument(68, "Untitled-1");

    // ... and switches back while the plug-in is writing the new id.
    world.ps.onBeforeExecute(() => {
        if (frontmostDuringWrite !== null) {
            world.ps.setActive(frontmostDuringWrite);
        }
    });
    await world.sync(68);
    world.ps.onBeforeExecute(null);

    // The artist carries on drawing on the old document.
    world.switchTo(59);
    await world.sync(59);

    return original;
}

test("File > New cannot take the recording away from the document behind it", async (t) => {
    // Every document Photoshop could really have had in front when it ran
    // the write, including the one that caused the incident.
    for (const frontmostDuringWrite of [null, 59, 68]) {
        const world = makeWorld();
        try {
            const original = await replayNewDocumentDuringWrite(world, frontmostDuringWrite);

            assert.equal(
                world.sessionOf.get(59),
                original,
                "L15big1 keeps its recording (frontmost during the write=" +
                    frontmostDuringWrite + ")"
            );
            const kept = world.allSessions().find((s) => s.sessionId === original);
            assert.equal(kept.frames.length, 2460, "and every frame of it");
            assert.notEqual(world.sessionOf.get(68), original, "the new document gets its own");
        } finally {
            world.temp.cleanup();
        }
    }
});

test("an id another open document is recording is not believed, however it got into the PSD", async (t) => {
    const world = makeWorld();
    t.after(() => world.temp.cleanup());

    world.newDocument(59, DESKTOP + "L15big1.psd");
    await world.sync(59);
    world.draw(59, 2460);
    const original = world.sessionOf.get(59);

    world.newDocument(68, "Untitled-1");
    await world.sync(68);
    const theirs = world.sessionOf.get(68);

    // However it got there -- a stray write, a plug-in of our own from
    // another machine -- document 59 now carries document 68's id, and
    // document 68 is open and recording into it.
    world.ps.setSettings(59, { sessionId: theirs });
    world.switchTo(59);
    const after = await world.sync(59);

    assert.equal(after.session.sessionId, original, "the document's own recording wins");
    assert.equal(after.session.manifest.frameCount, 2460);
    assert.equal(world.ps.peek(59).sessionId, original, "and the PSD is repaired");
    assert.ok(
        world.logs.some((line) => /another open document is already recording it; looking further/.test(line)),
        "and it says why the id in the PSD was passed over"
    );
});

test("an untitled document carrying a recording's id continues it", async (t) => {
    const world = makeWorld();
    t.after(() => world.temp.cleanup());

    // Nothing but the id: no file, no map entry, no index entry. It is the
    // document's own word and it is honoured.
    world.newDocument(4, "Untitled-1");
    const first = await world.sync(4);
    world.draw(4, 10);
    world.close(4);

    world.newDocument(5, "Untitled-2");
    world.ps.setSettings(5, { sessionId: first.session.sessionId });
    const second = await world.sync(5);
    assert.equal(second.session.sessionId, first.session.sessionId, "nothing contradicts it");
});

/* ------------------------------------------------ every interleaving there is */

/**
 * The same handful of moves, in every order Photoshop could deliver them and
 * with the write landing at every moment it could land.
 */
test("the invariants survive every ordering of new, switch, save and draw", async (t) => {
    const moves = [
        (w) => w.newDocument(2, "Untitled-2"),
        (w) => w.switchTo(1),
        (w) => w.switchTo(2),
        (w) => w.save(1, DESKTOP + "one.psd")
    ];

    let runs = 0;
    for (const order of permutations([0, 1, 2, 3])) {
        for (const frontmostDuringWrite of [null, 1, 2]) {
            const world = makeWorld();
            try {
                world.newDocument(1, "Untitled-1");
                await world.sync(1);
                world.draw(1, 5);

                world.ps.onBeforeExecute(() => {
                    if (frontmostDuringWrite !== null) {
                        world.ps.setActive(frontmostDuringWrite);
                    }
                });

                for (const move of order) {
                    moves[move](world);
                    // Whichever document Photoshop says is in front is the one
                    // the plug-in syncs, exactly as the real event loop does.
                    const front = world.ps.frontmost();
                    if (front !== null) {
                        await world.sync(front);
                    }
                }
                await world.flushStamps();
                runs++;
            } finally {
                world.temp.cleanup();
            }
        }
    }
    assert.equal(runs, 72, "every ordering was actually run");
});

function* permutations(items) {
    if (items.length <= 1) {
        yield items;
        return;
    }
    for (let i = 0; i < items.length; i++) {
        const rest = items.slice(0, i).concat(items.slice(i + 1));
        for (const tail of permutations(rest)) {
            yield [items[i], ...tail];
        }
    }
}

/* ------------------------------------------------------------ the witness */

// Without this the suite above proves nothing: a harness that cannot catch the
// bug it was built for is just a slower way of passing. This drives the same
// moment through a write shaped like the one the plug-in used to send -- no
// document in the request, so Photoshop aims it at whatever is in front -- and
// shows it landing in the PSD of the document the artist had switched back to.
test("the harness catches the write the old code sent", async (t) => {
    const world = makeWorld();
    t.after(() => world.temp.cleanup());

    world.newDocument(59, DESKTOP + "L15big1.psd");
    world.newDocument(68, "Untitled-1");

    // Photoshop switches back to 59 as the script for 68 runs.
    world.ps.onBeforeExecute(() => world.ps.setActive(59));

    // The old write: "set generatorSettings on the target document", with the
    // target left to Photoshop.
    await world.ps.generator.evaluateJSXString(
        'var params = { key: "F_95_Record", settings: { json: "{\\"sessionId\\":\\"for-68\\"}" } };\n' +
            'var ref = new ActionReference();\n' +
            'ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("generatorSettings"));\n' +
            'ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));\n' +
            'var desc = new ActionDescriptor();\n' +
            'desc.putReference(charIDToTypeID("null"), ref);\n' +
            'var payload = new ActionDescriptor();\n' +
            'payload.putString(stringIDToTypeID("json"), params.settings.json);\n' +
            'desc.putObject(charIDToTypeID("T   "), charIDToTypeID("null"), payload);\n' +
            'desc.putString(stringIDToTypeID("property"), params.key);\n' +
            'executeAction(charIDToTypeID("setd"), desc, DialogModes.NO);\n'
    );

    assert.deepEqual(
        world.ps.peek(59),
        { sessionId: "for-68" },
        "document 68's id went into document 59's PSD -- the 2026-09-09 bug"
    );
    assert.equal(world.ps.peek(68), undefined, "and never reached the document it was for");

    // The same write through stamp.ts, under the same interleaving. Photoshop
    // cannot be made to write into a document that is not in front -- no
    // reference form names one -- so the fix is not that it lands somewhere
    // better. It is that it does not land anywhere at all, and says so.
    const performed = await world.ps.gateway.setDocumentSettings(68, { sessionId: "mine" });
    assert.equal(performed, false, "declined, and reported as declined");
    assert.equal(world.ps.peek(68), undefined, "still nothing in the document it was for");
    assert.deepEqual(
        world.ps.peek(59),
        { sessionId: "for-68" },
        "and, unlike the old write, it did not touch the document in front"
    );
});
