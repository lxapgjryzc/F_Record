/**
 * "There is a newer F_Record" -- checked here, shown by the panel.
 *
 * This lives in the generator rather than the panel because the generator owns
 * config and state; the panel is a thin client that renders what it is told.
 * Dismissing a version has to persist, and config is the generator's to write.
 *
 * Two things are deliberate:
 *
 *   - It is off unless the user turns it on. A plug-in for drawing has no
 *     business reaching the network on its own, so `checkForUpdates` defaults
 *     to false and nothing here runs until it is true.
 *   - Nothing is sent. It is an unauthenticated GET of the public releases
 *     endpoint; no identifier, no version, no telemetry rides along. GitHub
 *     sees an IP and a User-Agent, which is the floor for any HTTP request.
 *
 * A failed check is a non-event: it logs at info and is retried on the next
 * interval. Nothing here can throw into the capture path.
 */

import * as https from "https";
import { RELEASES_API, UpdateState } from "../../shared/protocol";

/** Roughly once a day; the panel is not a package manager. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Compares two dotted version strings.
 *
 * Returns > 0 when `a` is newer, < 0 when `b` is newer, 0 when equal. Missing
 * segments count as zero, so "4.1" and "4.1.0" compare equal. Anything
 * non-numeric in a segment sorts as 0, which makes a pre-release tag like
 * "4.1.0-rc1" compare equal to "4.1.0" rather than newer -- deliberate, since
 * offering someone a release candidate as an upgrade would be wrong.
 */
export function compareVersions(a: string, b: string): number {
    const left = versionParts(a);
    const right = versionParts(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++) {
        const x = i < left.length ? left[i] : 0;
        const y = i < right.length ? right[i] : 0;
        if (x !== y) {
            return x > y ? 1 : -1;
        }
    }
    return 0;
}

function versionParts(version: string): number[] {
    const cleaned = String(version || "").replace(/^[vV]/, "");
    const parts = cleaned.split(".");
    const out: number[] = [];
    for (let i = 0; i < parts.length; i++) {
        const n = parseInt(parts[i], 10);
        out.push(isFinite(n) && n >= 0 ? n : 0);
    }
    return out;
}

export interface ReleaseInfo {
    version: string;
    url: string;
    publishedAt: number | null;
}

/**
 * Pulls what we need out of a GitHub release payload.
 *
 * Drafts and pre-releases are ignored: `releases/latest` already excludes them,
 * but the check is cheap and this function is also fed by tests.
 */
export function parseLatestRelease(payload: unknown): ReleaseInfo | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }
    const release = payload as Record<string, unknown>;
    if (release.draft === true || release.prerelease === true) {
        return null;
    }
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const version = tag.replace(/^[vV]/, "");
    if (!version) {
        return null;
    }
    const url = typeof release.html_url === "string" ? release.html_url : "";
    let publishedAt: number | null = null;
    if (typeof release.published_at === "string") {
        const parsed = Date.parse(release.published_at);
        publishedAt = isFinite(parsed) ? parsed : null;
    }
    return { version: version, url: url, publishedAt: publishedAt };
}

/** Fetches the latest release. Rejects on any transport or parse problem. */
export function fetchLatestRelease(): Promise<ReleaseInfo> {
    return new Promise<ReleaseInfo>(function (resolve, reject) {
        let settled = false;
        const done = (err: Error | null, value?: ReleaseInfo): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (err) {
                reject(err);
            } else {
                resolve(value as ReleaseInfo);
            }
        };

        let request: any;
        try {
            request = https.get(
                RELEASES_API,
                {
                    headers: {
                        // GitHub rejects requests without one.
                        "User-Agent": "F_Record-plugin",
                        Accept: "application/vnd.github+json"
                    }
                },
                function (response: any) {
                    const status = response.statusCode || 0;
                    if (status !== 200) {
                        // Drain so the socket can be reused or closed cleanly.
                        response.resume();
                        done(new Error("GitHub replied " + status));
                        return;
                    }
                    let body = "";
                    response.setEncoding("utf8");
                    response.on("data", function (chunk: string) {
                        body += chunk;
                        // A latest-release payload is a few KB; anything much
                        // larger is not something we should be buffering.
                        if (body.length > 512 * 1024) {
                            response.destroy();
                            done(new Error("Response was unreasonably large"));
                        }
                    });
                    response.on("end", function () {
                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(body);
                        } catch (e) {
                            done(new Error("Could not parse the response"));
                            return;
                        }
                        const info = parseLatestRelease(parsed);
                        if (!info) {
                            done(new Error("No usable release in the response"));
                            return;
                        }
                        done(null, info);
                    });
                    response.on("error", function (e: Error) {
                        done(e);
                    });
                }
            );
        } catch (e) {
            done(e as Error);
            return;
        }

        request.on("error", function (e: Error) {
            done(e);
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, function () {
            request.destroy();
            done(new Error("Timed out contacting GitHub"));
        });
    });
}

export interface UpdateCheckerOptions {
    currentVersion: string;
    /** Reads the live config each time, so toggling it takes effect at once. */
    isEnabled: () => boolean;
    dismissedVersion: () => string | null;
    onChange: () => void;
    log: (level: "info" | "warn" | "error", message: string) => void;
    /** Injected by tests; defaults to the real HTTPS call. */
    fetch?: () => Promise<ReleaseInfo>;
    now?: () => number;
}

/**
 * Owns the "is there a newer version" answer.
 *
 * Holds no timer of its own: `maybeCheck()` is driven by the plugin's existing
 * one-second tick, so this adds no scheduling of its own to the capture engine.
 */
export class UpdateChecker {
    private latest: ReleaseInfo | null = null;
    private lastCheckedAt = 0;
    private inFlight = false;

    constructor(private readonly options: UpdateCheckerOptions) {}

    private now(): number {
        return this.options.now ? this.options.now() : Date.now();
    }

    private fetch(): Promise<ReleaseInfo> {
        return this.options.fetch ? this.options.fetch() : fetchLatestRelease();
    }

    /** Called from the tick. Cheap and silent unless a check is actually due. */
    maybeCheck(): void {
        if (!this.options.isEnabled() || this.inFlight) {
            return;
        }
        if (this.lastCheckedAt !== 0 && this.now() - this.lastCheckedAt < CHECK_INTERVAL_MS) {
            return;
        }
        this.check().catch(function () {
            /* check() never rejects; this is belt and braces */
        });
    }

    /**
     * Runs a check now. Resolves with what happened rather than throwing, so
     * the caller can report it to the panel without a try/catch.
     */
    async check(): Promise<{ outcome: "newer" | "current" | "failed"; message?: string }> {
        if (this.inFlight) {
            return { outcome: "failed", message: "A check is already running" };
        }
        this.inFlight = true;
        try {
            const info = await this.fetch();
            this.lastCheckedAt = this.now();
            const newer = compareVersions(info.version, this.options.currentVersion) > 0;
            this.latest = newer ? info : null;
            this.options.onChange();
            if (newer) {
                this.options.log("info", "F_Record " + info.version + " is available");
                return { outcome: "newer" };
            }
            return { outcome: "current" };
        } catch (e) {
            // Not being able to reach GitHub is not a fault worth shouting
            // about; it is retried on the next interval.
            this.lastCheckedAt = this.now();
            const message = e && (e as Error).message ? (e as Error).message : String(e);
            this.options.log("info", "Update check did not complete: " + message);
            return { outcome: "failed", message: message };
        } finally {
            this.inFlight = false;
        }
    }

    /** Null unless a check found something strictly newer than what is running. */
    getState(): UpdateState | null {
        if (!this.latest) {
            return null;
        }
        return {
            latestVersion: this.latest.version,
            url: this.latest.url,
            publishedAt: this.latest.publishedAt,
            checkedAt: this.lastCheckedAt,
            dismissed: this.options.dismissedVersion() === this.latest.version
        };
    }

    /** Drops what we know, so turning the setting off clears the banner. */
    forget(): void {
        this.latest = null;
        this.lastCheckedAt = 0;
    }
}
