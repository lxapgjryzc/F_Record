/**
 * Builds every artifact the installer needs.
 *
 * Two CEP bundles come out of one source tree, differing only in compile
 * target:
 *
 *   legacy -> Photoshop 2020        (CEP 9,  Chromium 61, Node 8.6)
 *   modern -> Photoshop 2021..2026  (CEP 10/11/12, Chromium 74/88/99)
 *
 * The CSS is written to the Chromium 61 baseline in both cases, so the only
 * real difference is how far esbuild lowers the JavaScript. scripts/install.ps1
 * decides which one each Photoshop installation gets.
 *
 * Usage:
 *   node scripts/build.mjs            full build into dist/
 *   node scripts/build.mjs --tests    just the bundles the test suite imports
 *   node scripts/build.mjs --zip      full build plus a release archive
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const VERSION = pkg.version;

const CEP_FOLDER = "com.F_know.F_Record.cep";
const GENERATOR_FOLDER = "com.f_know.f_record.generator";

const args = process.argv.slice(2);
const testsOnly = args.includes("--tests");
const makeZip = args.includes("--zip");

/* ------------------------------------------------------------------ utils */

function rmrf(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

function mkdirp(target) {
    fs.mkdirSync(target, { recursive: true });
}

function copyFile(from, to) {
    mkdirp(path.dirname(to));
    fs.copyFileSync(from, to);
}

function log(message) {
    process.stdout.write(message + "\n");
}

function sizeOf(target) {
    try {
        return (fs.statSync(target).size / 1024).toFixed(0) + " KB";
    } catch {
        return "missing";
    }
}

/* ------------------------------------------------------------------ tests */

/**
 * The test suite runs on plain Node, which cannot import TypeScript with our
 * extensionless relative imports. Bundling each module under test to ESM keeps
 * the tests dependency-free and exercises the same code esbuild ships.
 */
const TEST_ENTRIES = {
    index: "generator/src/index.ts",
    bridge: "generator/src/bridge.ts",
    logger: "generator/src/logger.ts",
    capture: "generator/src/capture.ts",
    framing: "generator/src/framing.ts",
    session: "generator/src/session.ts",
    stamp: "generator/src/stamp.ts",
    store: "generator/src/store.ts",
    encoder: "generator/src/encoder.ts",
    compat: "shared/compat.ts",
    paths: "shared/paths.ts",
    protocol: "shared/protocol.ts",
    exportPlan: "cep/src/node/export.ts",
    clipboard: "cep/src/node/clipboard.ts",
    locate: "cep/src/node/locate.ts",
    ffmpeg: "cep/src/node/ffmpeg.ts",
    // The panel has a bridge of its own; the generator's is `bridge`.
    panelBridge: "cep/src/app/bridge.ts",
    i18n: "cep/src/app/i18n.ts",
    psHost: "cep/src/app/psHost.ts",
    locales: "cep/src/app/locales/index.ts",
    // The panel itself. One entry per component for the same reason as
    // everything else here: a number for App.tsx should be about App.tsx.
    main: "cep/src/app/main.tsx",
    app: "cep/src/app/App.tsx",
    ui: "cep/src/app/components/ui.tsx",
    dashboard: "cep/src/app/components/Dashboard.tsx",
    sessionsView: "cep/src/app/components/Sessions.tsx",
    settingsView: "cep/src/app/components/Settings.tsx",
    exportDialog: "cep/src/app/components/ExportDialog.tsx",
    packDialog: "cep/src/app/components/PackDialog.tsx",
    review: "cep/src/app/components/Review.tsx",
    watermark: "cep/src/app/components/Watermark.tsx",
    update: "generator/src/update.ts",
    stale: "shared/stale.ts",
    zip: "generator/src/zip.ts",
    trash: "generator/src/trash.ts",
    housekeeping: "generator/src/housekeeping.ts"
};

/**
 * Leaves imports between modules under test as imports.
 *
 * Bundling each entry with its dependencies inlined would put four other
 * modules inside session.mjs, and a coverage report over that file would be
 * measuring the wrong thing: it could never reach 100% without tests for
 * every line of everything session.ts happens to import, and a line it did
 * cover could belong to any of them. One output file per source file keeps
 * the numbers about the file they are named after. Anything that is not
 * itself an entry -- the ten locale dictionaries, say -- is still inlined.
 *
 * The same reasoning is why coverage is measured over dist/modules and not
 * over dist/generator/index.js: that bundle inlines every module below it, so
 * a number for it would be an average over files that are each already
 * measured here, and reaching 100% on it would mean driving every module's
 * error paths through a whole running plug-in. The shipped bundle is still
 * under test -- integration.test.mjs and its neighbours load that exact file
 * -- it is just not what the percentages are about.
 */
function siblingModules() {
    const bySource = new Map();
    for (const [name, entry] of Object.entries(TEST_ENTRIES)) {
        bySource.set(path.resolve(root, entry), "./" + name + ".mjs");
    }
    return {
        name: "sibling-modules",
        setup(build) {
            build.onResolve({ filter: /^./ }, (args) => {
                if (args.kind === "entry-point") {
                    return null;
                }
                const target = path.resolve(args.resolveDir, args.path);
                // `./locales` is a directory whose index.ts is an entry, so
                // the index forms are tried too -- without them that entry
                // would be inlined into whatever imported it and measured
                // twice, once as itself and once inside its importer.
                const forms = [
                    target,
                    target + ".ts",
                    target + ".tsx",
                    path.join(target, "index.ts"),
                    path.join(target, "index.tsx")
                ];
                for (const form of forms) {
                    const sibling = bySource.get(form);
                    if (sibling) {
                        return { path: sibling, external: true };
                    }
                }
                return null;
            });
        }
    };
}

/**
 * `dist/modules`, not `dist/test`: node --test treats everything under a
 * directory called `test` as a test file and leaves it out of the coverage
 * report, so the modules under test would silently measure nothing.
 */
async function buildTestBundles() {
    const out = path.join(dist, "modules");
    rmrf(out);
    mkdirp(out);

    const plugin = siblingModules();
    for (const [name, entry] of Object.entries(TEST_ENTRIES)) {
        await esbuild.build({
            entryPoints: [path.join(root, entry)],
            outfile: path.join(out, name + ".mjs"),
            bundle: true,
            platform: "node",
            format: "esm",
            target: "node18",
            // The panel is preact; the components under test compile the same
            // way here as they do in the shipped bundle.
            jsx: "automatic",
            jsxImportSource: "preact",
            // The same substitution the shipped bundle gets. Without it the
            // version would fall back to its dev default, and the test bundle
            // would be exercising a line the real one never runs.
            define: { __PLUGIN_VERSION__: JSON.stringify(VERSION) },
            // main.tsx pulls in the stylesheet, which the shipped bundle
            // turns into panel.css. There is nothing to measure in it and
            // nothing to render it here, so it is dropped.
            loader: { ".css": "empty" },
            // Dependencies stay imports as well, so a coverage report is
            // about our code and not about jpeg-js.
            packages: "external",
            plugins: [plugin],
            logLevel: "warning"
        });
    }
    log("built modules under test -> dist/modules");
}

/* ----------------------------------------------------------------- shared */

/**
 * Minified, but with names kept.
 *
 * `keepNames` costs a little size and buys back the thing this plugin actually
 * depends on when something goes wrong: readable function names in stack
 * traces. The whole design is "fail loudly" -- errors are surfaced in the panel
 * and tailed by doctor.ps1 -- and a mangled trace would gut that. Whitespace
 * and dead code are the parts worth dropping; identities are not.
 */
const MINIFY = {
    minify: true,
    keepNames: true,
    legalComments: "none"
};

/* -------------------------------------------------------------- generator */

/**
 * ES2015 output: the Generator process runs its own Node, and which one varies
 * a lot by host (Photoshop 2026 ships Node 22, older releases are far behind).
 * Compiling down and bundling every dependency means the plugin does not care.
 */
async function buildGenerator() {
    const out = path.join(dist, "generator", GENERATOR_FOLDER);
    rmrf(out);
    mkdirp(out);

    await esbuild.build({
        entryPoints: [path.join(root, "generator/src/index.ts")],
        outfile: path.join(out, "index.js"),
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "es2015",
        define: { __PLUGIN_VERSION__: JSON.stringify(VERSION) },
        ...MINIFY,
        logLevel: "warning"
    });

    fs.writeFileSync(
        path.join(out, "package.json"),
        JSON.stringify(
            {
                name: "f_record",
                version: VERSION,
                author: pkg.author,
                description: "F_Record capture engine for Photoshop's Generator",
                main: "index.js",
                // Photoshop 2020 shipped generator-core 3.x; 2026 ships 3.12.1.
                // Kept deliberately wide so a future 4.x host still loads us.
                "generator-core-version": ">=1.0.0 <6.0.0"
            },
            null,
            2
        ) + "\n"
    );

    log("built generator -> dist/generator (" + sizeOf(path.join(out, "index.js")) + ")");
}

/* -------------------------------------------------------------------- cep */

async function buildPanel(variant, target) {
    const out = path.join(dist, "cep-" + variant, CEP_FOLDER);
    rmrf(out);
    mkdirp(out);

    await esbuild.build({
        entryPoints: [path.join(root, "cep/src/app/main.tsx")],
        outfile: path.join(out, "panel.js"),
        bundle: true,
        // The panel runs in CEF but with Node enabled and `require` available
        // as a global, so Node's builtins must stay as runtime requires rather
        // than being bundled or shimmed.
        platform: "node",
        format: "iife",
        target: target,
        jsx: "automatic",
        jsxImportSource: "preact",
        define: { __PLUGIN_VERSION__: JSON.stringify(VERSION) },
        ...MINIFY,
        logLevel: "warning"
    });

    // esbuild names the extracted stylesheet after the JS outfile.
    const producedCss = path.join(out, "panel.css");
    if (!fs.existsSync(producedCss)) {
        throw new Error("expected panel.css to be emitted next to panel.js");
    }

    copyFile(path.join(root, "cep/src/index.html"), path.join(out, "index.html"));
    copyFile(path.join(root, "cep/src/host/init.jsx"), path.join(out, "host/init.jsx"));
    copyFile(path.join(root, "cep/src/js/CSInterface.js"), path.join(out, "js/CSInterface.js"));
    // The manifest carries the version twice and CEP compares it against what
    // is already installed, so a stale number there means an upgrade can be
    // silently ignored. package.json is the single source of truth; stamp it in
    // rather than trusting whoever last edited the XML to remember both places.
    const manifestSource = path.join(root, "cep/src/CSXS/manifest." + variant + ".xml");
    const manifest = fs
        .readFileSync(manifestSource, "utf8")
        .replace(/ExtensionBundleVersion="[^"]*"/, 'ExtensionBundleVersion="' + VERSION + '"')
        .replace(
            /(<Extension\s+Id="com\.F_know\.F_Record\.panel"\s+Version=")[^"]*(")/,
            "$1" + VERSION + "$2"
        );
    mkdirp(path.join(out, "CSXS"));
    fs.writeFileSync(path.join(out, "CSXS/manifest.xml"), manifest);

    log(
        "built cep-" + variant + " (" + target + ") -> dist/cep-" + variant +
        " (" + sizeOf(path.join(out, "panel.js")) + " js, " + sizeOf(producedCss) + " css)"
    );
}

/* ----------------------------------------------------------------- extras */

// photoshop.ps1 is dot-sourced by the other three, so leaving it out would
// break the installer in the release zip while working fine from the repo.
const SHIPPED_SCRIPTS = [
    "photoshop.ps1",
    "install.ps1",
    "install.cmd",
    "uninstall.ps1",
    "uninstall.cmd",
    "doctor.ps1"
];

function copyScripts() {
    const out = path.join(dist, "scripts");
    rmrf(out);
    mkdirp(out);
    for (const name of SHIPPED_SCRIPTS) {
        const from = path.join(root, "scripts", name);
        if (!fs.existsSync(from)) {
            throw new Error("scripts/" + name + " is missing; the release would be broken");
        }
        copyFile(from, path.join(out, name));
    }
    for (const name of ["README.md", "README_EN.md", "LICENSE"]) {
        const from = path.join(root, name);
        if (fs.existsSync(from)) {
            copyFile(from, path.join(dist, name));
        }
    }
    log("copied installer scripts and docs -> dist/");
}

function writeZip() {
    const releaseDir = path.join(root, "release");
    mkdirp(releaseDir);
    const archive = path.join(releaseDir, "F_Record-" + VERSION + ".zip");
    rmrf(archive);
    // Test bundles are a build artifact, not something users need.
    rmrf(path.join(dist, "modules"));
    // Compress-Archive ships with Windows PowerShell, so the release build has
    // no extra dependency.
    execFileSync(
        "powershell.exe",
        [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Compress-Archive -Path '" + dist + "\\*' -DestinationPath '" + archive + "' -Force"
        ],
        { stdio: "inherit" }
    );
    log("wrote " + archive + " (" + sizeOf(archive) + ")");
}

/* ------------------------------------------------------------------- main */

async function main() {
    if (testsOnly) {
        // The generator bundle too, not just dist/modules: integration.test.mjs
        // drives the exact file that ships, and building only the test bundles
        // left it asserting against whatever the last full build produced.
        await buildGenerator();
        await buildTestBundles();
        return;
    }

    rmrf(dist);
    await buildGenerator();
    await buildPanel("legacy", "chrome61");
    await buildPanel("modern", "chrome74");
    copyScripts();
    await buildTestBundles();

    if (makeZip) {
        writeZip();
    }
    log("\nbuild complete: dist/");
}

main().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
    process.exit(1);
});
