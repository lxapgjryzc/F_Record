/**
 * Capture scheduling: throttle, coalesce, back off, and never die quietly.
 *
 * 3.x reacted to every single `imageChanged` event with an immediate capture,
 * guarded only by a boolean. generator-core itself warns that this event is
 * expensive ("WARNING the imageChanged event is expensive, please consider NOT
 * listening to it"), and the guard leaked: one throw on the wrong line left it
 * stuck at `true` and recording stopped for the rest of the Photoshop session
 * with nothing shown to the user.
 *
 * This scheduler fixes both halves:
 *
 *   - Captures are rate-limited by an interval that adapts to how long the last
 *     capture actually took, so a heavy document slows down instead of
 *     saturating Photoshop. Changes arriving mid-capture are coalesced into one
 *     trailing capture, so the final state of a burst is never lost.
 *   - Every capture is raced against a timeout and the in-flight flag is
 *     cleared in a `finally`, so no failure mode can wedge it. Repeated
 *     failures auto-pause recording *with a reason string* that the panel
 *     displays -- the failure is loud, not silent.
 *
 * The class contains no Photoshop calls so it can be driven by fake timers in
 * tests; see test/capture.test.mjs.
 */

export const MAX_INTERVAL_MS = 15000;
export const CAPTURE_TIMEOUT_MS = 30000;
export const FAILURE_THRESHOLD = 5;
/** Keep Photoshop busy with us at most ~1/3 of the time. */
export const BACKOFF_MULTIPLIER = 3;

export interface Timers {
    now(): number;
    setTimeout(fn: () => void, ms: number): any;
    clearTimeout(handle: any): void;
}

export const realTimers: Timers = {
    now: function () {
        return Date.now();
    },
    setTimeout: function (fn, ms) {
        return setTimeout(fn, ms);
    },
    clearTimeout: function (handle) {
        clearTimeout(handle);
    }
};

export interface SchedulerStats {
    lastCaptureMs: number | null;
    avgCaptureMs: number | null;
    nextIntervalMs: number;
    capturing: boolean;
    droppedFrames: number;
    consecutiveFailures: number;
    pausedReason: string | null;
}

export interface SchedulerOptions {
    minIntervalMs: number;
    maxIntervalMs?: number;
    captureTimeoutMs?: number;
    failureThreshold?: number;
    timers?: Timers;
    /** Performs one capture. Rejecting counts as a failure. */
    capture: () => Promise<void>;
    onStats?: (stats: SchedulerStats) => void;
    onAutoPause?: (reason: string) => void;
    log?: (level: "info" | "warn" | "error", message: string) => void;
}

export class CaptureScheduler {
    private readonly timers: Timers;
    private readonly capture: () => Promise<void>;
    private readonly onStats: (stats: SchedulerStats) => void;
    private readonly onAutoPause: (reason: string) => void;
    private readonly log: (level: "info" | "warn" | "error", message: string) => void;
    private readonly maxIntervalMs: number;
    private readonly captureTimeoutMs: number;
    private readonly failureThreshold: number;

    private minIntervalMs: number;
    private nextIntervalMs: number;

    private enabled = false;
    private pausedReason: string | null = null;
    /**
     * True when the pause was this scheduler's own doing, after repeated
     * failures, rather than asked for by the user or by an export. The
     * distinction is what lets the plug-in lift a pause once the failures'
     * cause -- Photoshop not answering -- has visibly cleared, while leaving
     * a pause somebody asked for exactly where they put it.
     */
    private autoPaused = false;
    private inFlight = false;
    private pendingChange = false;
    private timer: any = null;
    /**
     * Negative infinity rather than 0, so the very first capture after
     * enabling runs immediately instead of waiting out an interval. With a
     * wall clock the difference never shows, but relying on the epoch being a
     * large number is not something to leave implicit.
     */
    private lastCaptureEndAt = Number.NEGATIVE_INFINITY;

    private lastCaptureMs: number | null = null;
    private avgCaptureMs: number | null = null;
    private droppedFrames = 0;
    private consecutiveFailures = 0;
    /** Resolvers handed out by whenIdle, released when a capture settles. */
    private idleWaiters: Array<() => void> = [];

    constructor(options: SchedulerOptions) {
        this.timers = options.timers || realTimers;
        this.capture = options.capture;
        this.onStats = options.onStats || function () {};
        this.onAutoPause = options.onAutoPause || function () {};
        this.log = options.log || function () {};
        this.minIntervalMs = options.minIntervalMs;
        this.nextIntervalMs = options.minIntervalMs;
        this.maxIntervalMs = options.maxIntervalMs || MAX_INTERVAL_MS;
        this.captureTimeoutMs = options.captureTimeoutMs || CAPTURE_TIMEOUT_MS;
        this.failureThreshold = options.failureThreshold || FAILURE_THRESHOLD;
    }

    setMinInterval(ms: number): void {
        this.minIntervalMs = ms;
        if (this.nextIntervalMs < ms) {
            this.nextIntervalMs = ms;
        }
    }

    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) {
            return;
        }
        this.enabled = enabled;
        if (!enabled) {
            this.cancelTimer();
            this.pendingChange = false;
        } else {
            // A fresh start clears a previous auto-pause and its failure count.
            this.pausedReason = null;
            this.autoPaused = false;
            this.consecutiveFailures = 0;
            this.nextIntervalMs = this.minIntervalMs;
        }
        this.emitStats();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    pause(reason: string): void {
        this.pausedReason = reason;
        this.autoPaused = false;
        this.cancelTimer();
        this.emitStats();
    }

    resume(): void {
        if (this.pausedReason === null) {
            return;
        }
        this.pausedReason = null;
        this.autoPaused = false;
        this.consecutiveFailures = 0;
        this.nextIntervalMs = this.minIntervalMs;
        this.emitStats();
        if (this.pendingChange) {
            this.schedule();
        }
    }

    isPaused(): boolean {
        return this.pausedReason !== null;
    }

    /** Paused by the failure threshold, not by anyone's request. */
    isAutoPaused(): boolean {
        return this.pausedReason !== null && this.autoPaused;
    }

    /**
     * Resolves once no capture is in flight.
     *
     * Deleting a session folder has to wait for this. A capture is a chain of
     * awaits -- render, then encode -- and one that is already past its "is
     * this still the current session" check will finish writing its frame
     * regardless, recreating the folder that was just removed. Callers drop
     * the session first, so no new capture writes anything, then wait here for
     * whichever one was already running.
     */
    whenIdle(): Promise<void> {
        if (!this.inFlight) {
            return Promise.resolve();
        }
        const self = this;
        return new Promise<void>(function (resolve) {
            self.idleWaiters.push(resolve);
        });
    }

    /** Call when Photoshop reports pixels changed. Cheap and safe to spam. */
    notifyChange(): void {
        this.pendingChange = true;
        this.schedule();
    }

    /** Drops any queued work, e.g. when switching documents. */
    discardPending(): void {
        this.pendingChange = false;
        this.cancelTimer();
    }

    getStats(): SchedulerStats {
        return {
            lastCaptureMs: this.lastCaptureMs,
            avgCaptureMs: this.avgCaptureMs,
            nextIntervalMs: this.nextIntervalMs,
            capturing: this.inFlight,
            droppedFrames: this.droppedFrames,
            consecutiveFailures: this.consecutiveFailures,
            pausedReason: this.pausedReason
        };
    }

    dispose(): void {
        this.cancelTimer();
        this.enabled = false;
        // Never leave a whenIdle() caller waiting on a scheduler that is gone.
        this.releaseIdleWaiters();
    }

    private releaseIdleWaiters(): void {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (let i = 0; i < waiters.length; i++) {
            waiters[i]();
        }
    }

    private cancelTimer(): void {
        if (this.timer !== null) {
            this.timers.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private schedule(): void {
        if (!this.enabled || this.pausedReason !== null || this.inFlight || this.timer !== null) {
            return;
        }
        if (!this.pendingChange) {
            return;
        }
        const elapsed = this.timers.now() - this.lastCaptureEndAt;
        const delay = Math.max(0, this.nextIntervalMs - elapsed);
        this.timer = this.timers.setTimeout(() => {
            this.timer = null;
            this.run();
        }, delay);
    }

    private run(): void {
        if (!this.enabled || this.pausedReason !== null || this.inFlight || !this.pendingChange) {
            return;
        }
        // Consume the request now: anything that arrives while we are capturing
        // sets the flag again and produces exactly one trailing capture.
        this.pendingChange = false;
        this.inFlight = true;
        const startedAt = this.timers.now();
        this.emitStats();

        let settled = false;
        const finish = (error: Error | null) => {
            if (settled) {
                return;
            }
            settled = true;
            this.inFlight = false;
            this.lastCaptureEndAt = this.timers.now();
            const elapsed = this.lastCaptureEndAt - startedAt;

            if (error) {
                this.consecutiveFailures++;
                this.droppedFrames++;
                this.log("warn", "Capture failed (" + this.consecutiveFailures + " in a row): " + error.message);
                // Back off hard on failure so a persistently broken document
                // cannot spin.
                this.nextIntervalMs = Math.min(
                    this.maxIntervalMs,
                    Math.max(this.minIntervalMs, this.nextIntervalMs * 2)
                );
                if (this.consecutiveFailures >= this.failureThreshold) {
                    const reason =
                        "Recording paused after " + this.consecutiveFailures +
                        " consecutive capture failures. Last error: " + error.message;
                    this.pausedReason = reason;
                    this.autoPaused = true;
                    this.log("error", reason);
                    this.onAutoPause(reason);
                }
            } else {
                this.consecutiveFailures = 0;
                this.lastCaptureMs = elapsed;
                this.avgCaptureMs =
                    this.avgCaptureMs === null ? elapsed : Math.round(this.avgCaptureMs * 0.7 + elapsed * 0.3);
                this.nextIntervalMs = clamp(
                    Math.max(this.minIntervalMs, Math.round(elapsed * BACKOFF_MULTIPLIER)),
                    this.minIntervalMs,
                    this.maxIntervalMs
                );
            }

            this.emitStats();
            this.releaseIdleWaiters();
            this.schedule();
        };

        const watchdog = this.timers.setTimeout(() => {
            finish(new Error("capture timed out after " + this.captureTimeoutMs + "ms"));
        }, this.captureTimeoutMs);

        const clearWatchdog = () => {
            this.timers.clearTimeout(watchdog);
        };

        let promise: Promise<void>;
        try {
            promise = this.capture();
        } catch (e) {
            // A synchronous throw must not bypass the reset below.
            clearWatchdog();
            finish(toError(e));
            return;
        }

        Promise.resolve(promise).then(
            () => {
                clearWatchdog();
                finish(null);
            },
            (e: unknown) => {
                clearWatchdog();
                finish(toError(e));
            }
        );
    }

    private emitStats(): void {
        this.onStats(this.getStats());
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function toError(e: unknown): Error {
    if (e instanceof Error) {
        return e;
    }
    return new Error(e && (e as any).message ? (e as any).message : String(e));
}
