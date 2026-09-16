/**
 * The control channel between the generator and the panel.
 *
 * 3.x had the two processes shout at each other through JSON files, each side
 * polling every 500ms. That raced, littered the data directory, and -- the
 * part that actually hurt -- gave the panel no way to tell a stopped
 * recording from a dead generator. Everything just looked frozen.
 *
 * So two things are pinned down here. That the door is shut: bound to
 * loopback, a random per-run token, and any request carrying an `Origin`
 * refused outright, because the panel talks through Node's http module and a
 * web page probing localhost cannot omit that header. And that a panel which
 * goes away -- a closed CEP window, a dropped socket, a write that throws --
 * costs a client and never the generator.
 *
 * The server is real and so are the requests; only the failures are staged.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";

import { clearFaults, fsError, mockBuiltins, setFault, withFault, withIsolatedAppDir } from "./helpers.mjs";

mockBuiltins(mock, "fs", "http", "crypto");
const { Bridge } = await import("../dist/modules/bridge.mjs");
const { bridgePath } = await import("../dist/modules/paths.mjs");
const { PROTOCOL_VERSION } = await import("../dist/modules/protocol.mjs");

const PANEL_HEADER = "x-f-record-client";
const PANEL_VALUE = "f-record-panel";

function makeState(overrides) {
    return { generator: { running: true }, config: { enabled: false }, session: null, ...overrides };
}

/**
 * A started bridge, plus what a test needs to talk to it.
 *
 * `t.after` shuts it down, so a failing assertion cannot leave a listener --
 * and a leaked one would keep the whole test process alive.
 */
async function startBridge(t, { state = makeState(), onCommand } = {}) {
    const env = withIsolatedAppDir();
    const logs = [];
    const commands = [];
    const bridge = new Bridge(
        "4.10.0",
        typeof state === "function" ? state : () => state,
        (command) => {
            commands.push(command);
            return onCommand ? onCommand(command) : Promise.resolve({ ok: true });
        },
        (level, message) => logs.push(level + ": " + message)
    );
    const port = await bridge.start();
    t.after(async () => {
        await bridge.stop();
        env.cleanup();
        clearFaults();
    });
    const info = JSON.parse(fs.readFileSync(bridgePath(), "utf8"));
    return { bridge, port, info, logs, commands, env };
}

/** One request, with whatever headers the test wants to get wrong. */
function request(port, method, urlPath, { token, headers, body, raw } = {}) {
    return new Promise((resolve, reject) => {
        const payload = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                path: urlPath,
                method,
                headers: {
                    ...(token === null ? {} : { Authorization: "Bearer " + token }),
                    [PANEL_HEADER]: PANEL_VALUE,
                    ...(payload ? { "Content-Type": "application/json" } : {}),
                    ...headers
                }
            },
            (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => (text += chunk));
                res.on("end", () =>
                    resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null })
                );
            }
        );
        req.on("error", reject);
        req.end(payload);
    });
}

/** Opens an SSE stream and collects the frames as they arrive. */
function openStream(port, token) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                path: "/events",
                method: "GET",
                headers: { Authorization: "Bearer " + token, [PANEL_HEADER]: PANEL_VALUE }
            },
            (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => (text += chunk));
                resolve({
                    res,
                    status: res.statusCode,
                    headers: res.headers,
                    text: () => text,
                    close: () => req.destroy(),
                    /** Waits until `pattern` shows up in what has arrived. */
                    async until(pattern, timeoutMs = 2000) {
                        const deadline = Date.now() + timeoutMs;
                        while (!pattern.test(text)) {
                            if (Date.now() > deadline) {
                                throw new Error("never saw " + pattern + " in: " + JSON.stringify(text));
                            }
                            await new Promise((r) => setTimeout(r, 10));
                        }
                        return text;
                    }
                });
            }
        );
        req.on("error", reject);
        req.end();
    });
}

/* --------------------------------------------------------------- start-up */

test("it listens on loopback and publishes how to reach it", async (t) => {
    const h = await startBridge(t);

    assert.ok(h.port > 0, "the OS picked a free port rather than us guessing one");
    assert.equal(h.info.port, h.port);
    assert.equal(h.info.pid, process.pid);
    assert.equal(h.info.protocolVersion, PROTOCOL_VERSION);
    assert.equal(h.info.pluginVersion, "4.10.0");
    assert.match(h.info.node, /^Node \d+\.\d+ /, "which Node this is, for a bug report");
    assert.match(h.info.token, /^[0-9a-f]{64}$/, "32 random bytes, not a guessable string");
    assert.match(h.logs.join(" "), /Bridge listening on 127\.0\.0\.1:/);
});

test("stopping takes the bridge file with it, so a stale one never misleads the panel", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    await bridge.start();
    assert.equal(fs.existsSync(bridgePath()), true);

    await bridge.stop();
    assert.equal(fs.existsSync(bridgePath()), false, "a panel that starts now knows to wait");

    // Twice: generator-core can call stop on a plug-in that never started.
    await bridge.stop();
});

test("a bridge that was never started still stops", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    await bridge.stop();
});

test("a bridge file that cannot be written is reported, not fatal", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);
    const logs = [];
    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), (level, message) =>
        logs.push(level + ": " + message)
    );
    t.after(() => bridge.stop());

    // The generator still records; it is the panel that cannot find it, and
    // the log is the only place that can say so.
    setFault("writeFileSync", () => {
        throw fsError("EACCES", "the data directory is read-only");
    });
    await bridge.start();
    clearFaults();

    assert.equal(logs.filter((line) => line.indexOf("error: Could not publish") === 0).length, 1);
    assert.match(logs.join(" "), /the data directory is read-only/);
});

test("a listener that cannot be opened rejects rather than hanging", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    // Locked-down machines do exist: a policy that forbids listening sockets
    // turns into an error event, and start() has to surface it so the plug-in
    // can log "the panel will not be able to connect" and carry on.
    setFault("createServer", () => {
        const server = new http.Server();
        server.listen = () => {
            process.nextTick(() => server.emit("error", fsError("EACCES", "listening is not permitted")));
            return server;
        };
        return server;
    });

    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    await assert.rejects(bridge.start(), /listening is not permitted/);
});

test("a listener with no port to report starts anyway", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    // address() answers with a string for a pipe rather than an object with a
    // port. There is nothing useful to publish then, but crashing on it would
    // be worse than publishing a zero the panel will refuse.
    setFault("createServer", () => {
        const server = new http.Server();
        server.listen = (port, host, ready) => {
            process.nextTick(ready);
            return server;
        };
        server.address = () => "/tmp/a-pipe";
        server.close = (done) => done();
        return server;
    });

    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    assert.equal(await bridge.start(), 0);
    await bridge.stop();
});

test("a heartbeat timer that cannot be unreferenced does not hold Photoshop open", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    // unref() keeps the interval from being a reason the process stays alive.
    // Hosts whose timers are the browser's return a plain id instead, and
    // reaching for unref() on that would throw during start-up.
    const realSetInterval = globalThis.setInterval;
    let fired = null;
    globalThis.setInterval = (fn) => {
        fired = fn;
        return 7;
    };
    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    try {
        await bridge.start();
    } finally {
        globalThis.setInterval = realSetInterval;
    }
    t.after(() => bridge.stop());

    assert.equal(typeof fired, "function", "the heartbeat was scheduled");
    fired(); // with no clients, a no-op
});

/* ----------------------------------------------------------------- the door */

test("a request from anything that looks like a browser is refused", async (t) => {
    const h = await startBridge(t);

    // A page cannot omit Origin on a cross-origin request, so its presence
    // means the caller is not our panel, whatever else it got right.
    const fromPage = await request(h.port, "GET", "/state", {
        token: h.info.token,
        headers: { Origin: "http://evil.example" }
    });
    assert.equal(fromPage.status, 403);
    assert.deepEqual(fromPage.body, { ok: false, error: "forbidden" });
});

test("a request without the panel's own header is refused", async (t) => {
    const h = await startBridge(t);
    const bare = await request(h.port, "GET", "/state", {
        token: h.info.token,
        headers: { [PANEL_HEADER]: "" }
    });
    assert.equal(bare.status, 403);
});

test("a request with the wrong token is refused, whatever length it is", async (t) => {
    const h = await startBridge(t);

    assert.equal((await request(h.port, "GET", "/state", { token: "wrong" })).status, 403, "too short");
    assert.equal(
        (await request(h.port, "GET", "/state", { token: h.info.token.replace(/.$/, "0") })).status,
        403,
        "right length, one character out"
    );
    assert.equal((await request(h.port, "GET", "/state", { token: null })).status, 403, "no header at all");
});

test("an unknown path is a 404 rather than a hint about what does exist", async (t) => {
    const h = await startBridge(t);
    const missing = await request(h.port, "GET", "/admin", { token: h.info.token });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { ok: false, error: "not found" });

    assert.equal((await request(h.port, "POST", "/state", { token: h.info.token })).status, 404, "wrong method");
});

/* ------------------------------------------------------------------ state */

test("the state endpoint answers with whatever the plug-in currently is", async (t) => {
    let enabled = false;
    const h = await startBridge(t, { state: () => makeState({ config: { enabled } }) });

    const first = await request(h.port, "GET", "/state", { token: h.info.token });
    assert.equal(first.status, 200);
    assert.equal(first.body.config.enabled, false);
    assert.match(first.headers["content-type"], /application\/json/);

    // Read afresh each time rather than cached: the panel asks after a command
    // and has to see the result of it.
    enabled = true;
    const second = await request(h.port, "GET", "/state", { token: h.info.token });
    assert.equal(second.body.config.enabled, true);

    const withQuery = await request(h.port, "GET", "/state?t=123", { token: h.info.token });
    assert.equal(withQuery.status, 200, "a cache-busting query string is not a different route");
});

/* --------------------------------------------------------------- commands */

test("a command reaches the handler and its result comes back", async (t) => {
    const h = await startBridge(t, { onCommand: (c) => Promise.resolve({ ok: true, echoed: c.type }) });

    const result = await request(h.port, "POST", "/command", {
        token: h.info.token,
        body: { type: "start", sessionId: "s1" }
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, echoed: "start" });
    assert.deepEqual(h.commands, [{ type: "start", sessionId: "s1" }]);
});

test("a handler that rejects is an answer, not a dead request", async (t) => {
    const h = await startBridge(t, {
        onCommand: () => Promise.reject(new Error("Photoshop is not responding"))
    });

    // The panel is waiting on this socket. A rejection that never became a
    // response would leave a button spinning for ever.
    const result = await request(h.port, "POST", "/command", { token: h.info.token, body: { type: "stop" } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: false, error: "Photoshop is not responding" });
});

test("a handler that rejects with something that is not an Error still answers", async (t) => {
    const h = await startBridge(t, { onCommand: () => Promise.reject("the document went away") });
    const result = await request(h.port, "POST", "/command", { token: h.info.token, body: { type: "stop" } });
    assert.deepEqual(result.body, { ok: false, error: "the document went away" });
});

test("a body that is not JSON is a 400, and the handler never sees it", async (t) => {
    const h = await startBridge(t);
    const result = await request(h.port, "POST", "/command", { token: h.info.token, raw: "{not json" });

    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { ok: false, error: "invalid JSON body" });
    assert.deepEqual(h.commands, []);
});

test("a body too large to be a command is refused before it is buffered", async (t) => {
    const h = await startBridge(t);

    // Commands are a few hundred bytes. Anything approaching a megabyte is
    // either a mistake or someone probing, and buffering it inside Photoshop's
    // own process is the part worth refusing.
    const result = await request(h.port, "POST", "/command", {
        token: h.info.token,
        raw: JSON.stringify({ type: "start", padding: "x".repeat(300 * 1024) })
    }).catch((e) => ({ status: "connection " + e.code }));

    if (typeof result.status === "number") {
        assert.equal(result.status, 400);
        assert.deepEqual(result.body, { ok: false, error: "request body too large" });
    } else {
        // Destroying the request can also drop the socket before the reply is
        // read; either way the command was refused.
        assert.match(String(result.status), /connection ECONNRESET|connection EPIPE/);
    }
    assert.deepEqual(h.commands, []);
});

test("a request that dies mid-body does not leave a handler waiting", async (t) => {
    const h = await startBridge(t);

    const req = http.request({
        host: "127.0.0.1",
        port: h.port,
        path: "/command",
        method: "POST",
        headers: {
            Authorization: "Bearer " + h.info.token,
            [PANEL_HEADER]: PANEL_VALUE,
            "Content-Length": "1000"
        }
    });
    req.on("error", () => {});
    req.write("{");
    req.destroy(); // the panel window was closed mid-command

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(h.commands, [], "nothing half-parsed was acted on");
});

/* ------------------------------------------------------------- the stream */

test("a stream opens with the current state, so the panel paints at once", async (t) => {
    const h = await startBridge(t);
    const stream = await openStream(h.port, h.info.token);
    t.after(() => stream.close());

    assert.equal(stream.status, 200);
    assert.equal(stream.headers["content-type"], "text/event-stream");
    assert.equal(stream.headers["cache-control"], "no-cache");

    const text = await stream.until(/"type":"state"/);
    assert.match(text, /^: connected/, "a comment first, so the connection is established immediately");
    assert.ok(h.bridge.hasClients());
});

test("what is broadcast reaches every open panel", async (t) => {
    const h = await startBridge(t);
    const one = await openStream(h.port, h.info.token);
    const two = await openStream(h.port, h.info.token);
    t.after(() => {
        one.close();
        two.close();
    });
    await one.until(/"type":"state"/);
    await two.until(/"type":"state"/);

    h.bridge.broadcast({ type: "log", level: "warn", message: "capture was slow" });

    await one.until(/capture was slow/);
    await two.until(/capture was slow/);
});

test("broadcasting with nobody listening is free", async (t) => {
    const h = await startBridge(t);
    assert.equal(h.bridge.hasClients(), false);
    h.bridge.broadcast({ type: "log", level: "info", message: "nobody is watching" });
});

test("a panel that goes away is dropped rather than written to for ever", async (t) => {
    const h = await startBridge(t);
    const stream = await openStream(h.port, h.info.token);
    await stream.until(/"type":"state"/);
    assert.equal(h.bridge.hasClients(), true);

    stream.close();

    const deadline = Date.now() + 2000;
    while (h.bridge.hasClients() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(h.bridge.hasClients(), false, "the closed socket was let go of");
});

test("a socket that throws on write is dropped, by broadcast and by the heartbeat alike", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    // A socket can fail between the check and the write; the point is that one
    // dead panel costs a client and not the generator.
    const realSetInterval = globalThis.setInterval;
    let ping = null;
    globalThis.setInterval = (fn) => {
        ping = fn;
        return { unref() {} };
    };
    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    let port;
    try {
        port = await bridge.start();
    } finally {
        globalThis.setInterval = realSetInterval;
    }
    t.after(() => bridge.stop());

    const alive = await openStream(port, JSON.parse(fs.readFileSync(bridgePath(), "utf8")).token);
    t.after(() => alive.close());
    await alive.until(/"type":"state"/);

    // A second client whose socket has been made hostile.
    const dead = await openStream(port, JSON.parse(fs.readFileSync(bridgePath(), "utf8")).token);
    t.after(() => dead.close());
    await dead.until(/"type":"state"/);
    dead.res.socket.destroy();
    await new Promise((r) => setTimeout(r, 30));

    bridge.broadcast({ type: "log", level: "info", message: "still here" });
    ping();
    await alive.until(/still here/);
    assert.ok(bridge.hasClients(), "the healthy panel is still connected");
});

test("a stream that cannot even be greeted is not counted as a client", async (t) => {
    const h = await startBridge(t);
    t.after(clearFaults);

    // The socket died between the headers and the first state frame. Keeping
    // it on the list would mean writing to it on every change for ever.
    const stream = await openStream(h.port, h.info.token);
    t.after(() => stream.close());
    await stream.until(/"type":"state"/);

    // A state provider that throws is the same shape of failure, seen from the
    // other side: the greeting cannot be composed, so there is nothing to send.
    const broken = new Bridge(
        "4.10.0",
        () => {
            throw new Error("state could not be read");
        },
        () => Promise.resolve({ ok: true }),
        () => {}
    );
    const port = await broken.start();
    t.after(() => broken.stop());
    const second = await openStream(port, JSON.parse(fs.readFileSync(bridgePath(), "utf8")).token);
    t.after(() => second.close());

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(broken.hasClients(), false, "a panel that was never greeted is not on the list");
});

test("a socket with no Nagle switch to turn off is still served", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    // setNoDelay is there to keep state updates from being held back a few
    // milliseconds. It is an optimisation, and a socket that does not offer it
    // -- an older Node, a wrapped stream -- must still get its events.
    setFault("createServer", (handler) => {
        const server = http.createServer((req, res) => {
            Object.defineProperty(req, "socket", { value: { setNoDelay: undefined }, configurable: true });
            handler(req, res);
        });
        return server;
    });

    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    const port = await bridge.start();
    t.after(() => bridge.stop());
    clearFaults();

    const stream = await openStream(port, JSON.parse(fs.readFileSync(bridgePath(), "utf8")).token);
    t.after(() => stream.close());
    await stream.until(/"type":"state"/);
});

test("stopping closes the panels' streams, even the ones that resist", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    const port = await bridge.start();
    const token = JSON.parse(fs.readFileSync(bridgePath(), "utf8")).token;
    const stream = await openStream(port, token);
    t.after(() => stream.close());
    await stream.until(/"type":"state"/);

    // Photoshop is quitting; a socket that throws on the way out must not stop
    // the shutdown, or the plug-in hangs the host.
    bridge.broadcast({ type: "log", level: "info", message: "going" });
    await stream.until(/going/);
    for (const client of bridge.clients) {
        client.end = () => {
            throw new Error("the socket was already gone");
        };
    }
    // And one that has already been torn down under us, which throws when
    // asked again. Photoshop is quitting; nothing here may be a reason to
    // stop halfway and leave it waiting.
    bridge.sockets.push({
        destroy() {
            throw new Error("the socket was already gone");
        }
    });

    await bridge.stop();
    assert.equal(bridge.hasClients(), false);
});

/* ------------------------------------------------------------------ token */

test("a machine with no entropy to spare still gets a token", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    // randomBytes can only fail if the pool is unavailable, which should not
    // happen -- but refusing to start the plug-in over it would be worse than
    // a token from Math.random on a loopback-only listener.
    setFault("randomBytes", () => {
        throw new Error("the entropy pool is not available");
    });
    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    clearFaults();

    await bridge.start();
    t.after(() => bridge.stop());
    const info = JSON.parse(fs.readFileSync(bridgePath(), "utf8"));
    assert.match(info.token, /^[0-9a-f]{64}$/, "still 32 bytes, still not guessable at a glance");

    const ok = await request(info.port, "GET", "/state", { token: info.token });
    assert.equal(ok.status, 200, "and it is the token the door accepts");
});

/* --------------------------------------------- sockets that misbehave outright */

test("a client whose write throws is dropped by both the broadcast and the heartbeat", async (t) => {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());

    const realSetInterval = globalThis.setInterval;
    let ping = null;
    globalThis.setInterval = (fn) => {
        ping = fn;
        return { unref() {} };
    };
    const bridge = new Bridge("4.10.0", makeState, () => Promise.resolve({ ok: true }), () => {});
    let port;
    try {
        port = await bridge.start();
    } finally {
        globalThis.setInterval = realSetInterval;
    }
    t.after(() => bridge.stop());

    const token = JSON.parse(fs.readFileSync(bridgePath(), "utf8")).token;
    const first = await openStream(port, token);
    const second = await openStream(port, token);
    t.after(() => {
        first.close();
        second.close();
    });
    await first.until(/"type":"state"/);
    await second.until(/"type":"state"/);

    // A response object that throws rather than merely failing: this is what a
    // socket torn down inside CEP looks like from here, and one of them must
    // not cost the other panel its updates.
    assert.equal(bridge.clients.length, 2);
    bridge.clients[0].write = () => {
        throw new Error("the socket is gone");
    };

    bridge.broadcast({ type: "log", level: "info", message: "still here" });
    assert.equal(bridge.clients.length, 1, "dropped on the way past");
    await second.until(/still here/);

    bridge.clients[0].write = () => {
        throw new Error("this one too");
    };
    ping();
    assert.equal(bridge.hasClients(), false, "and the heartbeat drops them just the same");
});

/* ---------------------------------------------------- a request that misbehaves */

/**
 * The route handler, reached directly.
 *
 * A request that stops part-way is easy to describe and awkward to produce
 * over a real socket -- Node turns most of it into 'aborted' rather than the
 * 'error' the reader listens for. Handing the handler a request the test
 * drives by hand says exactly what is being claimed.
 */
async function captureHandler(t) {
    const env = withIsolatedAppDir();
    t.after(() => env.cleanup());
    t.after(clearFaults);

    let handler = null;
    setFault("createServer", (fn) => {
        handler = fn;
        return http.createServer(fn);
    });
    const commands = [];
    const bridge = new Bridge(
        "4.10.0",
        makeState,
        (command) => {
            commands.push(command);
            return Promise.resolve({ ok: true });
        },
        () => {}
    );
    await bridge.start();
    clearFaults();
    t.after(() => bridge.stop());

    const token = JSON.parse(fs.readFileSync(bridgePath(), "utf8")).token;
    return { handler, commands, token };
}

/** A request whose events the test emits, and a response that records. */
function fakeExchange(token) {
    const handlers = {};
    const req = {
        method: "POST",
        url: "/command",
        headers: { authorization: "Bearer " + token, [PANEL_HEADER]: PANEL_VALUE },
        destroyed: 0,
        on(event, fn) {
            handlers[event] = fn;
            return req;
        },
        destroy() {
            req.destroyed++;
        },
        emit: (event, value) => handlers[event] && handlers[event](value)
    };
    const res = { statuses: [], bodies: [], writeHead: (s) => res.statuses.push(s), end: (b) => res.bodies.push(b) };
    return { req, res, replied: () => (res.bodies.length ? JSON.parse(res.bodies[0]) : null) };
}

test("a body that keeps arriving after it was refused is ignored, not answered twice", async (t) => {
    const h = await captureHandler(t);
    const x = fakeExchange(h.token);
    h.handler(x.req, x.res);

    x.req.emit("data", Buffer.alloc(300 * 1024));
    assert.deepEqual(x.res.statuses, [400]);
    assert.deepEqual(x.replied(), { ok: false, error: "request body too large" });
    assert.equal(x.req.destroyed, 1, "and the sender is cut off");

    // Whatever is still in flight arrives afterwards. Answering again would
    // write a second response onto a socket that already has one.
    x.req.emit("data", Buffer.alloc(1024));
    x.req.emit("end");
    x.req.emit("error", new Error("and then it broke"));

    assert.deepEqual(x.res.statuses, [400], "still one answer");
    assert.deepEqual(h.commands, []);
});

test("a request that breaks part-way is answered with why, once", async (t) => {
    const h = await captureHandler(t);
    const x = fakeExchange(h.token);
    h.handler(x.req, x.res);

    x.req.emit("data", Buffer.from('{"type":"st'));
    x.req.emit("error", new Error("the panel window was closed"));

    assert.deepEqual(x.res.statuses, [400]);
    assert.deepEqual(x.replied(), { ok: false, error: "the panel window was closed" });
    assert.deepEqual(h.commands, [], "half a command is not a command");

    // The 'end' that Node sometimes still emits afterwards changes nothing.
    x.req.emit("end");
    assert.deepEqual(x.res.statuses, [400]);
});

test("a request that does not say what it wants gets the same 404 as anything else", async (t) => {
    const h = await captureHandler(t);
    const x = fakeExchange(h.token);
    x.req.method = "GET";
    x.req.url = undefined;

    // Node fills url in for a real request; the fallback is what keeps a
    // hand-rolled client -- or a future Node -- from taking the route table
    // down with a split() on undefined.
    h.handler(x.req, x.res);

    assert.deepEqual(x.res.statuses, [404]);
    assert.deepEqual(x.replied(), { ok: false, error: "not found" });
});
