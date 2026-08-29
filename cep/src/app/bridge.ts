/**
 * Panel-side client for the generator's control channel.
 *
 * CEP panels run with Node enabled, so this talks to the generator through
 * Node's `http` module rather than the browser stack. That buys three things:
 * no CORS dance, the auth token travels in a header instead of a URL, and
 * EventSource's inability to set headers stops being a problem.
 *
 * The status this exposes is as important as the data. 3.x could not tell
 * "recording is off" from "the generator died", so both looked like a panel
 * that had simply stopped counting. Here every state has a name and the UI
 * shows it.
 */

import {
    BridgeInfo,
    BRIDGE_ORIGIN_HEADER,
    BRIDGE_ORIGIN_VALUE,
    Command,
    CommandResult,
    HealthState,
    PROTOCOL_VERSION,
    ServerEvent,
    State
} from "../../../shared/protocol";
import { bridgePath } from "../../../shared/paths";

declare const require: (id: string) => any;

const http = require("http");
const fs = require("fs");

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;
const REQUEST_TIMEOUT_MS = 15000;

export type ConnectionStatus =
    /** Looking for bridge.json, or the socket is being opened. */
    | "connecting"
    /** Streaming state from the generator. */
    | "connected"
    /** No generator is running, or it is not reachable. */
    | "unavailable"
    /** Generator and panel were built against different protocol versions. */
    | "mismatch";

export interface BridgeListeners {
    onStatus?: (status: ConnectionStatus, detail: string | null) => void;
    onState?: (state: State) => void;
    onHealth?: (health: HealthState) => void;
    onFrame?: (sessionId: string, frameCount: number, at: number) => void;
    onLog?: (level: "info" | "warn" | "error", message: string, at: number) => void;
}

export class BridgeClient {
    private info: BridgeInfo | null = null;
    private stream: any = null;
    private retryTimer: any = null;
    private retryDelay = RETRY_MIN_MS;
    private stopped = false;
    private status: ConnectionStatus = "connecting";

    constructor(private readonly listeners: BridgeListeners) {}

    start(): void {
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        this.clearRetry();
        this.destroyStream();
    }

    getStatus(): ConnectionStatus {
        return this.status;
    }

    isConnected(): boolean {
        return this.status === "connected";
    }

    /** Sends a command. Rejects when the generator is unreachable. */
    send(command: Command): Promise<CommandResult> {
        const info = this.info;
        if (!info) {
            return Promise.reject(new Error("Generator is not running"));
        }
        return new Promise<CommandResult>((resolve, reject) => {
            const body = JSON.stringify(command);
            const request = http.request(
                {
                    host: "127.0.0.1",
                    port: info.port,
                    path: "/command",
                    method: "POST",
                    headers: this.headers({
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body)
                    })
                },
                (response: any) => {
                    let text = "";
                    response.setEncoding("utf8");
                    response.on("data", function (chunk: string) {
                        text += chunk;
                    });
                    response.on("end", function () {
                        try {
                            resolve(JSON.parse(text));
                        } catch (e) {
                            reject(new Error("Malformed response from the generator: " + text.slice(0, 200)));
                        }
                    });
                }
            );
            request.setTimeout(REQUEST_TIMEOUT_MS, function () {
                request.destroy(new Error("Command timed out"));
            });
            request.on("error", (err: Error) => {
                // The generator went away between reading bridge.json and now.
                this.handleDisconnect(err.message);
                reject(err);
            });
            request.end(body);
        });
    }

    private headers(extra?: Record<string, string | number>): Record<string, string | number> {
        const base: Record<string, string | number> = {
            Authorization: "Bearer " + (this.info ? this.info.token : ""),
            // The generator rejects anything carrying an Origin header, so a
            // web page cannot reach it even if it guesses the port; this header
            // is how our Node client identifies itself instead.
            [BRIDGE_ORIGIN_HEADER]: BRIDGE_ORIGIN_VALUE
        };
        if (extra) {
            const keys = Object.keys(extra);
            for (let i = 0; i < keys.length; i++) {
                base[keys[i]] = extra[keys[i]];
            }
        }
        return base;
    }

    private readBridgeInfo(): BridgeInfo | null {
        try {
            const raw = fs.readFileSync(bridgePath(), "utf8");
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.port !== "number" || typeof parsed.token !== "string") {
                return null;
            }
            return parsed as BridgeInfo;
        } catch (e) {
            return null;
        }
    }

    private setStatus(status: ConnectionStatus, detail: string | null): void {
        if (this.status === status) {
            return;
        }
        this.status = status;
        if (this.listeners.onStatus) {
            this.listeners.onStatus(status, detail);
        }
    }

    private connect(): void {
        if (this.stopped) {
            return;
        }
        this.destroyStream();

        const info = this.readBridgeInfo();
        if (!info) {
            this.info = null;
            this.setStatus("unavailable", null);
            this.scheduleRetry();
            return;
        }
        if (info.protocolVersion !== PROTOCOL_VERSION) {
            this.info = null;
            this.setStatus(
                "mismatch",
                "Panel speaks protocol " + PROTOCOL_VERSION + ", generator speaks " + info.protocolVersion
            );
            this.scheduleRetry();
            return;
        }
        this.info = info;
        this.setStatus("connecting", null);

        const request = http.request(
            {
                host: "127.0.0.1",
                port: info.port,
                path: "/events",
                method: "GET",
                headers: this.headers({ Accept: "text/event-stream" })
            },
            (response: any) => {
                if (response.statusCode !== 200) {
                    this.handleDisconnect("Generator refused the connection (HTTP " + response.statusCode + ")");
                    response.resume();
                    return;
                }
                this.retryDelay = RETRY_MIN_MS;
                this.setStatus("connected", null);
                response.setEncoding("utf8");

                let buffer = "";
                response.on("data", (chunk: string) => {
                    buffer += chunk;
                    // SSE frames are separated by a blank line.
                    let split = buffer.indexOf("\n\n");
                    while (split !== -1) {
                        const frame = buffer.slice(0, split);
                        buffer = buffer.slice(split + 2);
                        this.dispatchFrame(frame);
                        split = buffer.indexOf("\n\n");
                    }
                });
                response.on("end", () => {
                    this.handleDisconnect("Generator closed the connection");
                });
                response.on("error", (err: Error) => {
                    this.handleDisconnect(err.message);
                });
            }
        );

        request.on("error", (err: Error) => {
            this.handleDisconnect(err.message);
        });
        // No response timeout: this connection is meant to stay open. The
        // generator's SSE heartbeat is what proves it is still alive.
        request.end();
        this.stream = request;
    }

    private dispatchFrame(frame: string): void {
        const lines = frame.split("\n");
        let data = "";
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.length === 0 || line.charAt(0) === ":") {
                continue; // heartbeat comment
            }
            if (line.indexOf("data:") === 0) {
                data += line.slice(5).replace(/^ /, "");
            }
        }
        if (!data) {
            return;
        }
        let event: ServerEvent;
        try {
            event = JSON.parse(data);
        } catch (e) {
            return;
        }
        switch (event.type) {
            case "state":
                if (this.listeners.onState) {
                    this.listeners.onState(event.state);
                }
                break;
            case "health":
                if (this.listeners.onHealth) {
                    this.listeners.onHealth(event.health);
                }
                break;
            case "frame":
                if (this.listeners.onFrame) {
                    this.listeners.onFrame(event.sessionId, event.frameCount, event.at);
                }
                break;
            case "log":
                if (this.listeners.onLog) {
                    this.listeners.onLog(event.level, event.message, event.at);
                }
                break;
        }
    }

    private handleDisconnect(detail: string): void {
        this.destroyStream();
        this.info = null;
        this.setStatus("unavailable", detail);
        this.scheduleRetry();
    }

    private destroyStream(): void {
        if (!this.stream) {
            return;
        }
        try {
            this.stream.destroy();
        } catch (e) {
            /* already torn down */
        }
        this.stream = null;
    }

    private clearRetry(): void {
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private scheduleRetry(): void {
        if (this.stopped || this.retryTimer !== null) {
            return;
        }
        const delay = this.retryDelay;
        this.retryDelay = Math.min(RETRY_MAX_MS, Math.round(this.retryDelay * 1.6));
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, delay);
    }
}
