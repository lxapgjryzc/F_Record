/**
 * The log the user can actually find.
 *
 * generator-core writes into Photoshop's own log directory, which almost
 * nobody discovers -- a large part of why "it just stopped recording" was so
 * hard to diagnose. Everything is mirrored into %APPDATA%/F_Record/logs so
 * scripts/doctor.ps1 can print it on request.
 *
 * The whole point is that this is the thing still working when nothing else
 * is, so every test here is really the same test: logging must not be what
 * breaks the plug-in. A full disk, a log directory that cannot be made, a
 * core logger that throws, a panel that has gone away mid-line -- none of
 * them may reach the caller, because the caller is the capture path.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { clearFaults, fsError, mockBuiltins, setFault, tempDir, withFault, withIsolatedAppDir } from "./helpers.mjs";

mockBuiltins(mock, "fs");
const { Logger } = await import("../dist/modules/logger.mjs");
const { generatorLogPath, logDir } = await import("../dist/modules/paths.mjs");

/** A core logger that records what it was told, or refuses to be told. */
function fakeCore(throwing = false) {
    const lines = [];
    const say = (level) => (message) => {
        if (throwing) {
            throw new Error("generator-core's logger is not available");
        }
        lines.push(level + ": " + message);
    };
    return { lines, info: say("info"), warn: say("warn"), error: say("error") };
}

function readLog() {
    return fs.readFileSync(generatorLogPath(), "utf8");
}

test("every level lands in the file, timestamped, and in the core logger too", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    const core = fakeCore();
    const log = new Logger(core);
    log.info("recording started");
    log.warn("capture was slow");
    log.error("capture failed");

    const lines = readLog().trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO\] recording started$/);
    assert.match(lines[1], /\[WARN\] capture was slow$/);
    assert.match(lines[2], /\[ERROR\] capture failed$/);

    // Photoshop's own log is where an Adobe engineer would look, so the lines
    // go to both places rather than being moved out of one into the other.
    assert.deepEqual(core.lines, [
        "info: recording started",
        "warn: capture was slow",
        "error: capture failed"
    ]);
});

test("the log directory is made on the way in", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    assert.equal(fs.existsSync(logDir()), false, "precondition: a fresh install");
    new Logger(null);
    assert.equal(fs.existsSync(logDir()), true);
});

test("a log directory that cannot be made is not a failed start-up", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    // This runs in the constructor, before the plug-in has done anything. A
    // read-only data directory has to cost the user their log, not their
    // recording.
    withFault("mkdirSync", fsError("EACCES", "the data directory is read-only"), () => {
        const log = new Logger(null);
        log.info("still going");
    });
});

test("a core logger that throws does not take the line with it", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    // generator-core's logger is optional and, on some hosts, hostile: it is
    // torn down before our plug-in is told to stop.
    const log = new Logger(fakeCore(true));
    log.info("shutting down");
    log.warn("shutting down");
    log.error("shutting down");

    assert.equal(readLog().trim().split("\n").length, 3, "our own file still has all three");
});

test("a plug-in with no core logger at all still logs", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    // init() is called with the logger argument omitted on older hosts.
    const log = new Logger(null);
    log.info("hello");
    assert.match(readLog(), /\[INFO\] hello/);
});

test("the panel sink sees the same lines, and can be taken away again", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    const seen = [];
    const log = new Logger(null);
    log.setSink((level, message) => seen.push(level + ": " + message));
    log.warn("something to show");

    // This is what puts a line in front of the artist without them opening a
    // file, which is the whole reason the panel has a log view.
    assert.deepEqual(seen, ["warn: something to show"]);

    log.setSink(null);
    log.warn("after the panel closed");
    assert.deepEqual(seen, ["warn: something to show"], "no sink, no delivery");
    assert.match(readLog(), /after the panel closed/, "and the file still has it");
});

test("a panel listener that throws is never allowed to break logging", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    const log = new Logger(null);
    log.setSink(() => {
        throw new Error("the panel went away between the check and the call");
    });
    log.error("this line still has to be written");

    assert.match(readLog(), /this line still has to be written/);
});

test("a disk that will not take the line is not the caller's problem", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    const core = fakeCore();
    const log = new Logger(core);

    // The caller is the capture path. A full disk must cost the log line and
    // nothing else -- including the copy that goes to Photoshop's own log.
    withFault("appendFileSync", fsError("ENOSPC", "the disk is full"), () => {
        log.error("the frame could not be written");
    });
    assert.deepEqual(core.lines, ["error: the frame could not be written"]);
});

/* ---------------------------------------------------------------- rotation */

test("a log under the limit is left where it is", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    const log = new Logger(null);
    log.info("first");
    withFault("statSync", () => ({ size: 1024 * 1024 - 1 }), () => log.info("second"));

    assert.match(readLog(), /first/);
    assert.match(readLog(), /second/);
    assert.equal(fs.existsSync(generatorLogPath() + ".1"), false);
});

test("a log at the limit is rolled over, keeping exactly one generation", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    const log = new Logger(null);
    log.info("the old log");

    // One megabyte, reported rather than written: the point is the rollover,
    // and a real one would mean writing a megabyte of text on every run.
    withFault("statSync", () => ({ size: 1024 * 1024 }), () => log.info("the new log"));

    assert.match(fs.readFileSync(generatorLogPath() + ".1", "utf8"), /the old log/);
    assert.match(readLog(), /the new log/);
    assert.doesNotMatch(readLog(), /the old log/, "the fresh file starts empty");

    // A second rollover replaces the previous generation rather than piling up
    // logs in a folder nobody empties.
    log.info("the newer log");
    withFault("statSync", () => ({ size: 1024 * 1024 }), () => log.info("the newest log"));
    assert.match(fs.readFileSync(generatorLogPath() + ".1", "utf8"), /the newer log/);
    assert.doesNotMatch(fs.readFileSync(generatorLogPath() + ".1", "utf8"), /the old log/);
});

test("a rollover that cannot happen still lets the line through", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    const log = new Logger(null);
    log.info("first");

    // Both halves refuse: the previous generation cannot be removed and the
    // current file cannot be renamed. Rotation is best effort; the log simply
    // grows past a megabyte, which beats losing the line that says why.
    setFault("statSync", () => ({ size: 1024 * 1024 }));
    setFault("unlinkSync", () => {
        throw fsError("EBUSY", "something has the old log open");
    });
    setFault("renameSync", () => {
        throw fsError("EBUSY", "something has the log open");
    });

    log.error("the line that says why");
    clearFaults();

    assert.match(readLog(), /the line that says why/);
});

test("no log file yet is not something to rotate", (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    // The very first line of a fresh install: statSync fails because there is
    // nothing there, which is a reason to write rather than to roll over.
    const log = new Logger(null);
    log.info("first line ever");
    assert.match(readLog(), /first line ever/);
    assert.equal(fs.existsSync(generatorLogPath() + ".1"), false);
});
