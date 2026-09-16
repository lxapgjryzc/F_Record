/**
 * A small rolling log the user can actually find.
 *
 * generator-core's own logger writes into Photoshop's log directory, whose
 * location most people never discover -- which is a large part of why "it just
 * stopped recording" was so hard to diagnose. We mirror everything into
 * %APPDATA%/F_Record/logs so scripts/doctor.ps1 can print it on request.
 */

import * as fs from "fs";
import { logDir, generatorLogPath } from "../../shared/paths";
import { mkdirp } from "../../shared/compat";

export type LogLevel = "info" | "warn" | "error";

const MAX_BYTES = 1024 * 1024;

export interface CoreLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export class Logger {
    private sink: ((level: LogLevel, message: string) => void) | null = null;

    constructor(private readonly core: CoreLogger | null) {
        try {
            mkdirp(logDir());
        } catch (e) {
            /* logging must never be the thing that breaks the plugin */
        }
    }

    /** Additional destination, used to mirror log lines to the panel. */
    setSink(sink: ((level: LogLevel, message: string) => void) | null): void {
        this.sink = sink;
    }

    log(level: LogLevel, message: string): void {
        const line = new Date().toISOString() + " [" + level.toUpperCase() + "] " + message;

        try {
            this.rotateIfNeeded();
            fs.appendFileSync(generatorLogPath(), line + "\n");
        } catch (e) {
            /* disk full / permissions -- keep going */
        }

        if (this.core) {
            try {
                if (level === "error") {
                    this.core.error(message);
                } else if (level === "warn") {
                    this.core.warn(message);
                } else {
                    this.core.info(message);
                }
            } catch (e) {
                /* core logger is optional */
            }
        }

        if (this.sink) {
            try {
                this.sink(level, message);
            } catch (e) {
                /* never let a panel listener break logging */
            }
        }
    }

    info(message: string): void {
        this.log("info", message);
    }

    warn(message: string): void {
        this.log("warn", message);
    }

    error(message: string): void {
        this.log("error", message);
    }

    private rotateIfNeeded(): void {
        let size = 0;
        try {
            size = fs.statSync(generatorLogPath()).size;
        } catch (e) {
            return;
        }
        if (size < MAX_BYTES) {
            return;
        }
        const previous = generatorLogPath() + ".1";
        try {
            fs.unlinkSync(previous);
        } catch (e) {
            /* no previous rotation */
        }
        try {
            fs.renameSync(generatorLogPath(), previous);
        } catch (e) {
            /* rotation is best effort */
        }
    }
}
