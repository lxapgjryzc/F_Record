/**
 * The file that actually ships.
 *
 * Everything else drives `dist/modules/*.mjs`, one output file per source
 * file, because that is what a coverage number can be about. What that
 * arrangement cannot see is the bundle itself: `dist/generator/.../index.js`
 * is built with different settings -- ES2015, CommonJS, minified with names
 * kept, every dependency inlined -- and is loaded by generator-core with
 * `require`, from a Node that varies wildly by Photoshop version.
 *
 * A mistake in the bundling is invisible to every other test here and total
 * for the user: Photoshop reports "plugin failed to load" and the panel never
 * finds a bridge. So the artifact is started once, for real, and asked to do
 * the one thing generator-core asks of it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

import { withIsolatedAppDir } from "./helpers.mjs";
import { makeJsxEngine } from "./photoshop.mjs";

const require = createRequire(import.meta.url);
const FOLDER = "com.f_know.f_record.generator";
const BUNDLE = path.resolve("dist/generator/" + FOLDER + "/index.js");

/** The smallest Photoshop the plug-in will talk to at all. */
function makeGenerator() {
    const handlers = new Map();
    const writeSettings = makeJsxEngine({
        frontmost: () => 1,
        isOpen: () => true,
        write: () => {}
    });
    return {
        on: (event, fn) => handlers.set(event, fn),
        removeListener: () => {},
        getPhotoshopExecutableLocation: () => Promise.resolve("C:/ps/Photoshop.exe"),
        getPhotoshopPath: () => Promise.resolve("C:/ps"),
        evaluateJSXString: (source) => Promise.resolve(writeSettings(source)),
        getDocumentInfo: () => Promise.resolve(null),
        getOpenDocumentIDs: () => Promise.resolve([]),
        getPixmap: () => Promise.reject(new Error("not needed")),
        getCustomOptions: () => Promise.resolve(null),
        setCustomOptions: () => Promise.resolve(),
        getPhotoshopVersion: () => Promise.resolve("27.2.0")
    };
}

test("the shipped bundle is loadable by the API generator-core uses", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    // A plain CommonJS require, which is how the host loads it. An ESM-only
    // artifact, or one whose syntax the target does not accept, dies here.
    const plugin = require(BUNDLE);
    assert.equal(typeof plugin.init, "function", "init is the entry point generator-core calls");

    const handle = plugin.init(makeGenerator(), {}, null);
    assert.ok(handle && handle.ready, "a throw here is 'plugin failed to load'");
    t.after(() => handle.stop());
    await handle.ready;

    // The bridge file is the panel's only way of finding the generator, so a
    // bundle that starts but never publishes one is just as broken.
    const bridgeFile = path.join(env.dir, "F_Record", "bridge.json");
    assert.equal(fs.existsSync(bridgeFile), true, "no bridge.json: the panel would never connect");
    const bridge = JSON.parse(fs.readFileSync(bridgeFile, "utf8"));
    assert.ok(bridge.port > 0);
    assert.ok(bridge.token.length >= 32);
});

test("the bundle ships with the manifest generator-core reads before loading it", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("dist/generator/" + FOLDER + "/package.json"), "utf8"));
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

    assert.equal(manifest.main, "index.js");
    assert.equal(manifest.version, pkg.version, "a stale version here is a silently ignored upgrade");
    // Photoshop 2020 shipped generator-core 3.x and 2026 ships 3.12.1; the
    // range is deliberately wide so a future 4.x host still loads us.
    assert.equal(manifest["generator-core-version"], ">=1.0.0 <6.0.0");
});

test("the bundle keeps its function names, which is what makes a stack trace useful", () => {
    // Minified but with keepNames: the whole design is "fail loudly", errors
    // are surfaced in the panel and tailed by doctor.ps1, and a mangled trace
    // would gut that.
    const source = fs.readFileSync(BUNDLE, "utf8");
    assert.ok(source.length > 0);
    for (const name of ["FRecordPlugin", "CaptureScheduler", "Encoder", "SessionIndex"]) {
        assert.ok(source.indexOf(name) !== -1, name + " survived minification");
    }
});
