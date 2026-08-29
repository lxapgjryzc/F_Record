/**
 * Where to look for ffmpeg.
 *
 * 4.0.0 shipped a 75 MB ffmpeg.exe inside the extension. That made the release
 * download 99% third-party binary for a plugin whose own code is 419 KB, and
 * it is why the repository is 165 MB. It is no longer shipped: scripts/install.ps1
 * either finds an ffmpeg already on the machine or downloads one from
 * BtbN/FFmpeg-Builds, so this module's job is to find it wherever it landed.
 *
 * The order below is "most deliberate first": an explicit override beats a
 * copy inside the extension, which beats the shared install, which beats
 * whatever happens to be on PATH.
 *
 * Kept free of `require` and of every filesystem call so it can be unit tested
 * on plain Node; ffmpeg.ts does the existence checks against this list.
 */

export interface LocateContext {
    platform: string;
    /** The extension's own directory -- installs from 4.0.0 still have a copy. */
    extensionDir: string;
    env: { [key: string]: string | undefined };
}

/** Point this at an ffmpeg binary to override every other location. */
export const FFMPEG_ENV_VAR = "F_RECORD_FFMPEG";

/**
 * Installed once per machine rather than once per Photoshop: a user with 2020,
 * 2024 and 2026 side by side would otherwise get three copies of the same
 * ~90 MB binary. install.ps1 writes here and doctor.ps1 reports on it.
 */
export const SHARED_DIR_NAME = "F_Record";

export function ffmpegExeName(platform: string): string {
    return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function sep(platform: string): string {
    return platform === "win32" ? "\\" : "/";
}

function join(platform: string, ...parts: string[]): string {
    const s = sep(platform);
    const cleaned: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        let part = parts[i];
        if (!part) {
            continue;
        }
        if (i > 0) {
            part = part.replace(/^[\/]+/, "");
        }
        cleaned.push(part.replace(/[\/]+$/, ""));
    }
    return cleaned.join(s);
}

/** Splits %PATH% into directories, tolerating the trailing empty entries Windows leaves. */
export function pathDirectories(rawPath: string | undefined, platform: string): string[] {
    if (!rawPath) {
        return [];
    }
    const parts = rawPath.split(platform === "win32" ? ";" : ":");
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        const trimmed = parts[i].trim().replace(/^"(.*)"$/, "$1");
        if (trimmed.length > 0) {
            out.push(trimmed);
        }
    }
    return out;
}

/**
 * Every path worth trying, in priority order and without duplicates.
 *
 * The list doubles as the "we looked here" detail in the export error message,
 * so it stays readable rather than exhaustive.
 */
export function ffmpegCandidates(ctx: LocateContext): string[] {
    const platform = ctx.platform;
    const exe = ffmpegExeName(platform);
    const env = ctx.env || {};
    const out: string[] = [];

    const add = (candidate: string): void => {
        if (!candidate) {
            return;
        }
        for (let i = 0; i < out.length; i++) {
            if (out[i].toLowerCase() === candidate.toLowerCase()) {
                return;
            }
        }
        out.push(candidate);
    };

    // 1. An explicit override always wins.
    const override = env[FFMPEG_ENV_VAR];
    if (override) {
        add(override);
    }

    // 2. A copy inside the extension: how 4.0.0 shipped, still honoured so an
    //    upgrade over an existing install keeps working without a download.
    add(join(platform, ctx.extensionDir, "ffmpeg", exe));

    // 3. Where install.ps1 puts the shared copy.
    if (platform === "win32") {
        const programData = env.ProgramData || env.ALLUSERSPROFILE;
        if (programData) {
            add(join(platform, programData, SHARED_DIR_NAME, "ffmpeg", exe));
        }
    } else {
        const home = env.HOME;
        if (home) {
            add(join(platform, home, ".local", "share", SHARED_DIR_NAME, "ffmpeg", exe));
        }
    }

    // 4. Anything already on PATH -- the case where the user manages ffmpeg
    //    themselves and the installer never had to download anything.
    const pathDirs = pathDirectories(env.PATH || env.Path, platform);
    for (let i = 0; i < pathDirs.length; i++) {
        add(join(platform, pathDirs[i], exe));
    }

    // 5. Common installs that are not always on PATH.
    if (platform === "win32") {
        const roots: string[] = [];
        if (env.LOCALAPPDATA) {
            roots.push(join(platform, env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
        }
        if (env.ProgramData) {
            roots.push(join(platform, env.ProgramData, "chocolatey", "bin"));
        }
        if (env.ProgramFiles) {
            roots.push(join(platform, env.ProgramFiles, "ffmpeg", "bin"));
        }
        roots.push("C:\ffmpeg\bin");
        for (let i = 0; i < roots.length; i++) {
            add(join(platform, roots[i], exe));
        }
    } else {
        add("/usr/local/bin/" + exe);
        add("/usr/bin/" + exe);
        add("/opt/homebrew/bin/" + exe);
    }

    return out;
}
