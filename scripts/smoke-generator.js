/*
 * Runs the built capture plug-in on whatever Node this is started with, the
 * way generator-core would: loads it, starts it against a stand-in Photoshop,
 * lets it record one frame, and stops. Exit code 0 means a frame was written
 * and nothing was logged as a warning or error.
 *
 * It exists for the hosts the test suite cannot be: Photoshop CC 2015.5 to
 * 2021 run Generator on Node 4.3.1 / 4.8.4 / 8.11.1, and the only way to know
 * the ES5 bundle really loads there is to run it on that Node. Fetch the
 * binary from nodejs.org/dist and point it here:
 *
 *   node-4.8.4.exe scripts/smoke-generator.js dist/generator/com.f_know.f_record.generator/index.js
 *
 * Written in ES5 with the pre-4.5 Buffer API, since that is where it runs.
 */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");

var bundle = path.resolve(process.argv[2] || "dist/generator/com.f_know.f_record.generator/index.js");

// An application data folder of its own, so nothing lands in the real one.
var appData = path.join(os.tmpdir(), "f_record-smoke-" + process.version + "-" + Date.now());
fs.mkdirSync(appData);
fs.mkdirSync(path.join(appData, "F_Record"));
process.env.APPDATA = appData;
fs.writeFileSync(
    path.join(appData, "F_Record", "config.json"),
    JSON.stringify({
        autoStart: true,
        minIntervalMs: 100,
        minCanvasPixels: 0,
        processImageFolderPath: path.join(appData, "frames")
    })
);

function pixmap(width, height) {
    var pixels = new Buffer(width * height * 4);
    pixels.fill(200);
    return {
        width: width,
        height: height,
        pixels: pixels,
        rowBytes: width * 4,
        channelCount: 4,
        bitsPerChannel: 8,
        bytesPerPixel: 4,
        bounds: { top: 0, left: 0, right: width, bottom: height }
    };
}

var listeners = {};
var photoshop = {
    onPhotoshopEvent: function (name, listener) {
        listeners[name] = listener;
    },
    getDocumentInfo: function () {
        return Promise.resolve({
            id: 1,
            file: "C:\\art\\dragon.psd",
            bounds: { top: 0, left: 0, right: 800, bottom: 600 },
            resolution: 72
        });
    },
    getDocumentPixmap: function () {
        return Promise.resolve(pixmap(400, 300));
    },
    getPhotoshopVersion: function () {
        return Promise.resolve("18.0.0");
    },
    addMenuItem: function () {
        return Promise.resolve();
    },
    toggleMenu: function () {
        return Promise.resolve();
    },
    // No generatorSettings on this document: the plug-in warns once that the
    // session id could not be stamped, which is expected and filtered below.
    evaluateJSXString: function () {
        return Promise.resolve("null");
    }
};

var logs = [];
var logger = {
    info: function (message) {
        logs.push("info: " + message);
    },
    warn: function (message) {
        logs.push("warn: " + message);
    },
    error: function (message) {
        logs.push("error: " + message);
    }
};

function wait(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

function countFrames() {
    var root = path.join(appData, "frames");
    if (!fs.existsSync(root)) {
        return 0;
    }
    return fs.readdirSync(root).reduce(function (total, session) {
        return (
            total +
            fs.readdirSync(path.join(root, session)).filter(function (name) {
                return /\.jpg$/.test(name);
            }).length
        );
    }, 0);
}

var plugin = require(bundle);
var handle = plugin.init(photoshop, {}, logger);

handle.ready
    .then(function () {
        listeners.imageChanged({ id: 1, layers: [{ id: 2, pixels: true }] });
        return wait(800);
    })
    .then(function () {
        return handle.stop();
    })
    .then(function () {
        var frames = countFrames();
        var problems = logs.filter(function (line) {
            return /^(warn|error)/.test(line) && !/Session id for document/.test(line);
        });
        console.log(process.version + ": " + frames + " frame(s) written, " + problems.length + " problem(s)");
        console.log(logs.join("\n"));
        process.exit(frames > 0 && problems.length === 0 ? 0 : 1);
    })
    .catch(function (error) {
        console.log(process.version + ": FAILED " + ((error && error.stack) || error));
        console.log(logs.join("\n"));
        process.exit(1);
    });
