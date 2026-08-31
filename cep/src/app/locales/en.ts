/**
 * English -- the source of truth.
 *
 * Every other locale is keyed against this file. A key missing anywhere else
 * falls back to the string here rather than showing the raw key, so a partial
 * translation degrades to English instead of to gibberish.
 */

export const dict: Record<string, string> = {
    "tab.dashboard": "Record",
    "tab.sessions": "Recordings",
    "tab.settings": "Settings",

    "status.connected": "Connected",
    "status.connecting": "Connecting…",
    "status.unavailable": "Generator not running",
    "status.unavailable.hint":
        "Enable Edit ▸ Preferences ▸ Plug-ins ▸ Enable Generator, then restart Photoshop.",
    "status.mismatch": "Version mismatch",
    "status.mismatch.hint": "The panel and the generator plug-in are different versions. Reinstall both.",

    "record.on": "Recording",
    "record.off": "Not recording",
    "record.paused": "Paused",
    "record.start": "Start recording",
    "record.stop": "Stop recording",

    "doc.title": "Document",
    "doc.none": "No document open",
    "doc.tooSmall": "Canvas is too small to record",
    "doc.noSession": "Not being recorded",
    "doc.startForThis": "Record this document",

    "stat.frames": "Frames",
    "stat.time": "Time spent",
    "stat.capture": "Capture",
    "stat.interval": "every {0}",
    "stat.encoder.js": "fallback encoder",

    "resume.title": "Continue an earlier recording?",
    "resume.body": "This canvas matches recordings you made before. Continue one, or start fresh.",
    "resume.fresh": "Start fresh",
    "resume.frames": "{0} frames",

    "export.button": "Export",
    "export.title": "Export video",
    "export.aspect": "Aspect ratio",
    "export.aspect.canvas": "Match canvas",
    "export.duration": "Length",
    "export.duration.original": "{0} (original)",
    "export.timing": "Pacing",
    "export.timing.fixed": "Even",
    "export.timing.realtime": "Real time",
    "export.timing.hint":
        "Even gives every frame the same length. Real time uses the gaps between strokes, so pauses show.",
    "export.confirm": "Export",
    "export.cancel": "Cancel",
    "export.preparing": "Checking frames…",
    "export.encoding": "Encoding video…",
    "export.finishing": "Finishing…",
    "export.started": "Export started",
    "export.done": "Export finished",
    "export.failed": "Export failed",
    "export.open": "Open",
    "export.noFrames": "This recording has no frames yet",

    "sessions.empty": "No recordings yet",
    "sessions.frames": "{0} frames · {1}",
    "sessions.open": "Open folder",
    "sessions.export": "Export",
    "sessions.delete": "Delete",
    "sessions.deleteConfirm": "Delete this recording and all its frames? This cannot be undone.",
    "sessions.current": "recording now",
    "sessions.refresh": "Refresh",

    "settings.folder": "Frames folder",
    "settings.folder.choose": "Choose folder",
    "settings.folder.hint":
        "Where captured frames are stored. Changing it does not move existing recordings.",
    "settings.resolution": "Resolution",
    "settings.quality": "Quality",
    "settings.quality.low": "Low",
    "settings.quality.medium": "Medium",
    "settings.quality.high": "High",
    "settings.interval": "Capture interval",
    "settings.interval.hint":
        "The shortest gap between two frames. Longer intervals are gentler on Photoshop.",
    "settings.idle": "Idle timeout",
    "settings.idle.hint": "Stop counting time after this long without drawing.",
    "settings.idle.off": "Never",
    "settings.autoStart": "Start recording when Photoshop opens",
    "settings.autoStart.hint": "Recording runs in the background; this panel does not need to be open.",
    "settings.autoNew": "Record new documents automatically",
    "settings.autoNew.hint": "When off, each document has to be started by hand.",
    "settings.language": "Language",
    "settings.language.auto": "Match Photoshop",
    "settings.runtime": "Runtime",
    "settings.runtime.hint": "The Node build Photoshop hands the plug-in, and which compatibility fallbacks are active. Worth quoting when reporting a problem.",

    "update.setting": "Check for updates",
    "update.setting.hint":
        "Asks GitHub about once a day whether a newer version exists. Off by default. Nothing about you or your work is sent.",
    "update.checkNow": "Check now",
    "update.checking": "Checking…",
    "update.upToDate": "You have the latest version",
    "update.failed": "Could not reach GitHub",
    "update.available": "F_Record {0} is available",
    "update.body": "You are running {0}.",
    "update.view": "View release",

    "issue.report": "Report an Issue",
    "issue.hint": "Opens the project issue tracker on GitHub in your browser.",

    "unit.minute": "min",
    "unit.hour": "h",
    "unit.minuteShort": "m",
    "unit.secondShort": "s",
    "unit.ms": "ms",

    "common.dismiss": "Dismiss",
};
