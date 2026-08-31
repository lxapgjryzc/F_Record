/**
 * Localhost control channel between the Generator plugin and the CEP panel.
 *
 * 3.x had the two processes shout at each other through JSON files, each side
 * polling every 500ms. That raced (both sides wrote), littered the data
 * directory with atomic-write temp files the panel had to sweep up, and -- most
 * importantly -- gave the panel no way to tell a stopped recording from a dead
 * generator. Everything just looked frozen.
 *
 * Instead the generator serves a tiny HTTP endpoint on 127.0.0.1 and pushes
 * state over Server-Sent Events. The panel is a plain client: it renders what
 * it is told and sends commands. If the connection drops it says so.
 *
 * Security: the listener is bound to the loopback interface, every request must
 * carry a random per-run bearer token, and requests carrying an `Origin` header
 * are rejected outright. The panel talks to us through Node's http module (CEP
 * panels have Node enabled), never through the browser stack, so it never sends
 * an Origin -- which makes that check a clean way to shut out any web page
 * probing localhost.
 */

import * as http from "http";
import * as crypto from "crypto";
import {
    BridgeInfo,
    Command,
    CommandResult,
    PROTOCOL_VERSION,
    ServerEvent,
    State,
    BRIDGE_ORIGIN_HEADER,
    BRIDGE_ORIGIN_VALUE
} from "../../shared/protocol";
import { bridgePath } from "../../shared/paths";
import { writeJsonAtomic, mkdirp, randomHex, describeNodeCompat } from "../../shared/compat";
import * as path from "path";
import * as fs from "fs";

const SSE_HEARTBEAT_MS = 15000;
const MAX_BODY_BYTES = 256 * 1024;

export type StateProvider = () => State;
export type CommandHandler = (command: Command) => Promise<CommandResult>;

export class Bridge {
    private server: http.Server | null = null;
    private clients: http.ServerResponse[] = [];
    private heartbeat: any = null;
    private readonly token: string;
    private port = 0;

    constructor(
        private readonly pluginVersion: string,
        private readonly getState: StateProvider,
        private readonly handleCommand: CommandHandler,
        private readonly log: (level: "info" | "warn" | "error", message: string) => void
    ) {
        this.token = makeToken();
    }

    start(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                this.route(req, res);
            });
            server.on("error", (err) => {
                reject(err);
            });
            // Port 0 lets the OS pick a free port; the panel discovers it via
            // bridge.json rather than us guessing a fixed one.
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                this.port = address && typeof address === "object" ? address.port : 0;
                this.server = server;
                this.publish();
                this.heartbeat = setInterval(() => {
                    this.pingClients();
                }, SSE_HEARTBEAT_MS);
                if (this.heartbeat.unref) {
                    this.heartbeat.unref();
                }
                this.log("info", "Bridge listening on 127.0.0.1:" + this.port);
                resolve(this.port);
            });
        });
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.heartbeat) {
                clearInterval(this.heartbeat);
                this.heartbeat = null;
            }
            for (let i = 0; i < this.clients.length; i++) {
                try {
                    this.clients[i].end();
                } catch (e) {
                    /* client already gone */
                }
            }
            this.clients = [];
            this.unpublish();
            if (!this.server) {
                resolve();
                return;
            }
            this.server.close(() => {
                resolve();
            });
            this.server = null;
        });
    }

    /** Publishes connection details for the panel to discover. */
    private publish(): void {
        const info: BridgeInfo = {
            port: this.port,
            token: this.token,
            pid: process.pid,
            protocolVersion: PROTOCOL_VERSION,
            pluginVersion: this.pluginVersion,
            startedAt: Date.now(),
            node: describeNodeCompat()
        };
        try {
            mkdirp(path.dirname(bridgePath()));
            writeJsonAtomic(bridgePath(), info);
        } catch (e) {
            this.log("error", "Could not publish bridge info: " + errText(e));
        }
    }

    private unpublish(): void {
        try {
            fs.unlinkSync(bridgePath());
        } catch (e) {
            /* already gone */
        }
    }

    broadcast(event: ServerEvent): void {
        if (this.clients.length === 0) {
            return;
        }
        const payload = "data: " + JSON.stringify(event) + "\n\n";
        const alive: http.ServerResponse[] = [];
        for (let i = 0; i < this.clients.length; i++) {
            const client = this.clients[i];
            try {
                client.write(payload);
                alive.push(client);
            } catch (e) {
                /* drop this client */
            }
        }
        this.clients = alive;
    }

    hasClients(): boolean {
        return this.clients.length > 0;
    }

    private pingClients(): void {
        const alive: http.ServerResponse[] = [];
        for (let i = 0; i < this.clients.length; i++) {
            try {
                // An SSE comment: keeps the socket warm and lets the panel
                // notice a dead generator instead of showing stale numbers.
                this.clients[i].write(": ping\n\n");
                alive.push(this.clients[i]);
            } catch (e) {
                /* drop */
            }
        }
        this.clients = alive;
    }

    private authorized(req: http.IncomingMessage): boolean {
        // A browser page cannot omit Origin on a cross-origin request, so its
        // presence means the caller is not our panel.
        if (req.headers.origin) {
            return false;
        }
        if (req.headers[BRIDGE_ORIGIN_HEADER] !== BRIDGE_ORIGIN_VALUE) {
            return false;
        }
        const auth = req.headers.authorization || "";
        const expected = "Bearer " + this.token;
        return safeEqual(String(auth), expected);
    }

    private route(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (!this.authorized(req)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "forbidden" }));
            return;
        }

        const url = (req.url || "/").split("?")[0];

        if (req.method === "GET" && url === "/state") {
            this.sendJson(res, 200, this.getState());
            return;
        }
        if (req.method === "GET" && url === "/events") {
            this.openStream(req, res);
            return;
        }
        if (req.method === "POST" && url === "/command") {
            this.readBody(req, (err, body) => {
                if (err) {
                    this.sendJson(res, 400, { ok: false, error: err.message });
                    return;
                }
                let command: Command;
                try {
                    command = JSON.parse(body);
                } catch (e) {
                    this.sendJson(res, 400, { ok: false, error: "invalid JSON body" });
                    return;
                }
                this.handleCommand(command).then(
                    (result: CommandResult) => {
                        this.sendJson(res, 200, result);
                    },
                    (e: unknown) => {
                        this.sendJson(res, 200, { ok: false, error: errText(e) });
                    }
                );
            });
            return;
        }

        this.sendJson(res, 404, { ok: false, error: "not found" });
    }

    private openStream(req: http.IncomingMessage, res: http.ServerResponse): void {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
        });
        // Disable Nagle so state updates are not held back a few milliseconds.
        if (req.socket && (req.socket as any).setNoDelay) {
            (req.socket as any).setNoDelay(true);
        }
        res.write(": connected\n\n");
        this.clients.push(res);

        const drop = () => {
            this.clients = this.clients.filter(function (client) {
                return client !== res;
            });
        };
        req.on("close", drop);
        req.on("error", drop);
        res.on("error", drop);

        // Send the full state immediately so the panel paints without waiting
        // for the next change.
        try {
            res.write("data: " + JSON.stringify({ type: "state", state: this.getState() }) + "\n\n");
        } catch (e) {
            drop();
        }
    }

    private readBody(req: http.IncomingMessage, callback: (err: Error | null, body: string) => void): void {
        let body = "";
        let size = 0;
        let done = false;
        req.on("data", function (chunk) {
            if (done) {
                return;
            }
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                done = true;
                callback(new Error("request body too large"), "");
                req.destroy();
                return;
            }
            body += chunk.toString("utf8");
        });
        req.on("end", function () {
            if (done) {
                return;
            }
            done = true;
            callback(null, body);
        });
        req.on("error", function (err) {
            if (done) {
                return;
            }
            done = true;
            callback(err, "");
        });
    }

    private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body)
        });
        res.end(body);
    }
}

function makeToken(): string {
    try {
        return crypto.randomBytes(32).toString("hex");
    } catch (e) {
        // randomBytes can only fail if the entropy pool is unavailable, which
        // should not happen; fall back rather than refusing to start.
        return randomHex(32);
    }
}

/** Length-independent comparison, to avoid leaking the token by timing. */
function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function errText(e: unknown): string {
    if (e && (e as Error).message) {
        return (e as Error).message;
    }
    return String(e);
}
