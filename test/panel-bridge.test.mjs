/**
 * The panel's client for the generator's control channel.
 *
 * Both halves are real here: a generator Bridge on a real loopback port and
 * the panel's BridgeClient talking to it through Node's http, which is how it
 * talks inside CEP. That is worth the setup, because the thing being tested is
 * the seam between them -- the header the door checks for, the protocol
 * version handshake, the SSE framing.
 *
 * The other half is the status. 3.x could not tell "recording is off" from
 * "the generator died", so both looked like a panel that had stopped counting.
 * Every state here has a name, and getting from one to another -- a generator
 * that goes away mid-session, one that speaks a different protocol, one that
 * is not running yet -- is what the panel renders.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { clearFaults, fsError, mockBuiltins, setFault, withIsolatedAppDir } from "./helpers.mjs";

mockBuiltins(mock, "fs", "http");
const { BridgeClient } = await import("../dist/modules/panelBridge.mjs");
const { Bridge } = await import("../dist/modules/bridge.mjs");
const { bridgePath } = await import("../dist/modules/paths.mjs");
const { PROTOCOL_VERSION } = await import("../dist/modules/protocol.mjs");

function makeState() {
    return {
        protocolVersion: PROTOCOL_VERSION,
        generator: { pluginVersion: "4.10.0" },
        config: { enabled: false },
        document: null,
        session: null,
        health: { encoder: "js" },
        resumeCandidates: [],
        update: null
    };
}

/** A generator bridge and a panel client wired to it, both shut down after. */
async function connectedPair(t, { state = makeState(), onCommand } = {}) {
    const env = withIsolatedAppDir();
    const bridge = new Bridge(
        "4.10.0",
        typeof state === "function" ? state : () => state,
        (command) => (onCommand ? onCommand(command) : Promise.resolve({ ok: true, echoed: command.type })),
        () => {}
    );
    await bridge.start();

    const seen = { status: [], state: [], health: [], frame: [], log: [] };
    const client = new BridgeClient({
        onStatus: (status, detail) => seen.status.push([status, detail]),
        onState: (s) => seen.state.push(s),
        onHealth: (h) => seen.health.push(h),
        onFrame: (sessionId, frameCount, at) => seen.frame.push([sessionId, frameCount, at]),
        onLog: (level, message, at) => seen.log.push([level, message, at])
    });

    t.after(async () => {
        client.stop();
        await bridge.stop();
        env.cleanup();
        clearFaults();
    });
    return { bridge, client, seen, env };
}

async function until(predicate, what, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = predicate();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error("timed out waiting for " + what);
        }
        await new Promise((r) => setTimeout(r, 10));
    }
}

const statuses = (seen) => seen.status.map((entry) => entry[0]);

/* ----------------------------------------------------------- connecting */

test("the panel finds the generator, connects, and is handed the state at once", async (t) => {
    const h = await connectedPair(t);

    h.client.start();
    await until(() => h.seen.state.length > 0, "the first state");

    // The client starts out in "connecting", so only the change to
    // "connected" is announced -- a status is reported when it changes, not on
    // every attempt, or the panel would flicker on every retry.
    assert.deepEqual(statuses(h.seen), ["connected"]);
    assert.equal(h.seen.state[0].protocolVersion, PROTOCOL_VERSION);
});

test("with no generator running the panel says so, and keeps looking", async (t) => {
    const h = await connectedPair(t);
    fs.unlinkSync(bridgePath());

    h.client.start();
    await until(() => statuses(h.seen).indexOf("unavailable") !== -1, "the unavailable status");

    // Not an error state: Photoshop may simply not have loaded the generator
    // yet. The client keeps retrying, which is what makes the panel connect on
    // its own once it does.
    assert.deepEqual(h.seen.status[h.seen.status.length - 1], ["unavailable", null]);
});

test("a bridge file that is not one is treated as no generator at all", async (t) => {
    const h = await connectedPair(t);

    // Half-written, or left behind by a much older release.
    for (const junk of ["{not json", JSON.stringify({ port: "80" }), JSON.stringify({ token: 1 }), "null"]) {
        fs.writeFileSync(bridgePath(), junk);
        const client = new BridgeClient({ onStatus: (s) => statusesSeen.push(s) });
        const statusesSeen = [];
        client.start();
        client.stop();
    }
    h.client.start();
    await until(() => statuses(h.seen).length > 0, "a status");
});

test("a generator built against another protocol is named, not silently ignored", async (t) => {
    const h = await connectedPair(t);
    const info = JSON.parse(fs.readFileSync(bridgePath(), "utf8"));
    fs.writeFileSync(bridgePath(), JSON.stringify({ ...info, protocolVersion: PROTOCOL_VERSION + 1 }));

    h.client.start();
    const entry = await until(
        () => h.seen.status.filter((s) => s[0] === "mismatch")[0],
        "the mismatch status"
    );

    // A half-upgraded install: the panel and the generator come from different
    // releases. Saying which is which is the difference between a fixable
    // report and "the panel does not work".
    assert.match(entry[1], new RegExp("Panel speaks protocol " + PROTOCOL_VERSION));
    assert.match(entry[1], new RegExp("generator speaks " + (PROTOCOL_VERSION + 1)));
});

test("a generator that refuses the connection is reported with its status code", async (t) => {
    const h = await connectedPair(t);
    const info = JSON.parse(fs.readFileSync(bridgePath(), "utf8"));
    fs.writeFileSync(bridgePath(), JSON.stringify({ ...info, token: "the wrong token entirely" }));

    h.client.start();
    const entry = await until(
        () => h.seen.status.filter((s) => s[0] === "unavailable" && s[1])[0],
        "the refusal"
    );
    assert.match(entry[1], /HTTP 403/);
});

/* -------------------------------------------------------------- streaming */

test("everything the generator broadcasts reaches the right listener", async (t) => {
    const h = await connectedPair(t);
    h.client.start();
    await until(() => h.seen.state.length > 0, "the first state");

    h.bridge.broadcast({ type: "health", health: { encoder: "native", droppedFrames: 2 } });
    h.bridge.broadcast({ type: "frame", sessionId: "s1", frameCount: 42, at: 1700000000000 });
    h.bridge.broadcast({ type: "log", level: "warn", message: "capture was slow", at: 1700000000001 });
    h.bridge.broadcast({ type: "state", state: makeState() });

    await until(() => h.seen.log.length > 0, "the log line");
    assert.deepEqual(h.seen.health[0], { encoder: "native", droppedFrames: 2 });
    assert.deepEqual(h.seen.frame[0], ["s1", 42, 1700000000000]);
    assert.deepEqual(h.seen.log[0], ["warn", "capture was slow", 1700000000001]);
    assert.equal(h.seen.state.length, 2, "the opening state and the broadcast one");
});

test("a panel that listens for nothing is still fed without complaint", async (t) => {
    const h = await connectedPair(t);
    // Every listener is optional; App.tsx wires the ones it renders.
    const quiet = new BridgeClient({});
    t.after(() => quiet.stop());
    quiet.start();

    await new Promise((r) => setTimeout(r, 150));
    h.bridge.broadcast({ type: "health", health: { encoder: "js" } });
    h.bridge.broadcast({ type: "frame", sessionId: "s1", frameCount: 1, at: 1 });
    h.bridge.broadcast({ type: "log", level: "info", message: "x", at: 1 });
    h.bridge.broadcast({ type: "state", state: makeState() });
    await new Promise((r) => setTimeout(r, 100));
});

test("heartbeats, split frames and junk in the stream are all handled", async (t) => {
    const h = await connectedPair(t);
    h.client.start();
    await until(() => h.seen.state.length > 0, "the first state");

    const client = h.bridge.clients[0];
    // A comment is the SSE heartbeat, and it must not be read as an event.
    client.write(": ping\n\n");
    // An event whose data is not JSON: a truncated write, or a future field
    // this build cannot parse. Dropping the frame beats taking the panel down.
    client.write("data: {not json\n\n");
    // An event of a type this panel does not know, which is what a newer
    // generator talking to an older panel looks like.
    client.write('data: {"type":"somethingNew"}\n\n');
    // A frame with no data lines at all.
    client.write("\n\n");
    // Split across two `data:` lines, the way SSE allows.
    client.write('data: {"type":"log","level":"info",\ndata:"message":"in two halves","at":1}\n\n');

    await until(() => h.seen.log.length > 0, "the split log line");
    assert.deepEqual(h.seen.log[0], ["info", "in two halves", 1]);
    assert.equal(h.seen.state.length, 1, "nothing else was mistaken for an event");
});

test("a generator that goes away puts the panel back into unavailable", async (t) => {
    const h = await connectedPair(t);
    h.client.start();
    await until(() => h.seen.state.length > 0, "the first state");

    await h.bridge.stop();
    const entry = await until(
        () => h.seen.status.filter((s) => s[0] === "unavailable")[0],
        "the disconnect"
    );

    // The detail says what happened, which is what the panel shows under
    // "generator unreachable" rather than leaving a stale frame count.
    assert.ok(entry[1], "a reason came with it");
});

/* --------------------------------------------------------------- commands */

test("a command goes out with the token and the panel's own header", async (t) => {
    const commands = [];
    const h = await connectedPair(t, {
        onCommand: (command) => {
            commands.push(command);
            return Promise.resolve({ ok: true, echoed: command.type });
        }
    });
    h.client.start();
    await until(() => h.seen.state.length > 0, "the first state");

    const result = await h.client.send({ type: "setConfig", patch: { enabled: true } });

    assert.deepEqual(result, { ok: true, echoed: "setConfig" });
    assert.deepEqual(commands, [{ type: "setConfig", patch: { enabled: true } }]);
});

test("a command sent before the generator is found is refused, not queued", async (t) => {
    const h = await connectedPair(t);

    // The panel's buttons are live before the first connection completes; the
    // rejection is what turns them into a visible error rather than a click
    // that does nothing.
    await assert.rejects(h.client.send({ type: "ping" }), /Generator is not running/);
});

test("a reply that is not JSON is reported with what came back", async (t) => {
    const h = await connectedPair(t);
    h.client.start();
    await until(() => h.seen.state.length > 0, "the first state");

    // The generator answers commands with JSON; anything else means something
    // else is on that port, and quoting it is what makes that diagnosable.
    const client = h.bridge.clients[0];
    assert.ok(client, "precondition: the stream is open");
    h.bridge.handleCommandForTest = null;

    await assert.rejects(
        (async () => {
            setFault("request", (options, onResponse) => {
                const response = {
                    setEncoding() {},
                    on(event, fn) {
                        if (event === "data") {
                            setImmediate(() => fn("<html>not the generator</html>"));
                        } else if (event === "end") {
                            setImmediate(() => setImmediate(fn));
                        }
                        return response;
                    }
                };
                setImmediate(() => onResponse(response));
                return { setTimeout() {}, on() {}, end() {}, destroy() {} };
            });
            return h.client.send({ type: "ping" });
        })(),
        /Malformed response from the generator: <html>not the generator<\/html>/
    );
    clearFaults();
});

test("a command that cannot be sent takes the connection down with it", async (t) => {
    const h = await connectedPair(t);
    h.client.start();
    await until(() => h.seen.state.length > 0, "the first state");
    t.after(clearFaults);

    // The generator went away between reading bridge.json and now. The command
    // rejects and the panel is told the connection is gone, rather than being
    // left showing a live view of a process that has exited.
    setFault("request", () => {
        const request = {
            setTimeout() {},
            on(event, fn) {
                if (event === "error") {
                    setImmediate(() => fn(new Error("socket hang up")));
                }
                return request;
            },
            end() {},
            destroy() {}
        };
        return request;
    });

    await assert.rejects(h.client.send({ type: "ping" }), /socket hang up/);
    clearFaults();
    assert.equal(statuses(h.seen)[statuses(h.seen).length - 1], "unavailable");
});

test("a command that never comes back is given up on", async (t) => {
    const h = await connectedPair(t);
    h.client.start();
    await until(() => h.seen.state.length > 0, "the first state");
    t.after(clearFaults);

    // Fifteen seconds in production; the panel must not spin for ever on a
    // generator that accepted the request and then stopped answering.
    let timeoutMs = 0;
    setFault("request", () => {
        const request = {
            setTimeout(ms, fn) {
                timeoutMs = ms;
                setImmediate(fn);
            },
            on(event, fn) {
                if (event === "error") {
                    request.fail = fn;
                }
                return request;
            },
            end() {},
            destroy(err) {
                if (request.fail) {
                    request.fail(err);
                }
            }
        };
        return request;
    });

    await assert.rejects(h.client.send({ type: "ping" }), /Command timed out/);
    assert.equal(timeoutMs, 15000);
    clearFaults();
});

/* ------------------------------------------------------------- retrying */

test("stopping the client stops it looking, and starting again picks up", async (t) => {
    const h = await connectedPair(t);
    const info = fs.readFileSync(bridgePath(), "utf8");
    fs.unlinkSync(bridgePath());

    h.client.start();
    await until(() => statuses(h.seen).indexOf("unavailable") !== -1, "the first miss");
    h.client.stop();

    const before = h.seen.status.length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(h.seen.status.length, before, "a stopped client does not keep retrying");

    // And it can be started again -- which is what happens when the panel is
    // closed and reopened without Photoshop restarting.
    fs.writeFileSync(bridgePath(), info);
    h.client.start();
    await until(() => statuses(h.seen).indexOf("connected") !== -1, "the connection after starting again");
});

test("a retry that fires as the panel closes does not reconnect behind it", async (t) => {
    const h = await connectedPair(t);
    fs.unlinkSync(bridgePath());

    // clearTimeout cannot recall a callback the event loop has already picked
    // up, so the retry has to check for itself whether it is still wanted.
    const realSetTimeout = globalThis.setTimeout;
    let retry = null;
    globalThis.setTimeout = (fn, ms) => {
        retry = fn;
        return realSetTimeout(() => {}, ms);
    };
    try {
        h.client.start();
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(typeof retry, "function", "a retry was scheduled");

    h.client.stop();
    const before = h.seen.status.length;
    retry();

    await new Promise((r) => realSetTimeout(r, 100));
    assert.equal(h.seen.status.length, before, "nothing was attempted after the panel closed");
});

test("a generator whose port is dead is reported rather than waited on", async (t) => {
    const h = await connectedPair(t);
    const info = JSON.parse(fs.readFileSync(bridgePath(), "utf8"));
    // A bridge.json left behind by a generator that has since exited: the file
    // is well formed and the port answers nothing.
    fs.writeFileSync(bridgePath(), JSON.stringify({ ...info, port: 1 }));

    h.client.start();
    const entry = await until(
        () => h.seen.status.filter((s) => s[0] === "unavailable" && s[1])[0],
        "the failed connection"
    );
    assert.ok(entry[1].length > 0, "with the socket's own reason: " + entry[1]);
});

test("a stream that throws on the way out does not stop the panel reconnecting", async (t) => {
    const h = await connectedPair(t);
    t.after(clearFaults);

    // A socket torn down under us: destroying it again throws, and that must
    // not be the thing that stops the client from opening the next one.
    setFault("request", () => {
        const request = {
            setTimeout() {},
            on() {
                return request;
            },
            end() {},
            destroy() {
                throw new Error("the socket was already gone");
            }
        };
        return request;
    });
    h.client.start();
    await new Promise((r) => setTimeout(r, 50));

    h.client.stop();
    clearFaults();
});
