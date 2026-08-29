/**
 * Translations.
 *
 * A plain lookup table rather than i18next: the panel has ~70 strings and no
 * plural or interpolation rules worth a library, and dropping the dependency
 * keeps the bundle small enough to stay comfortable on Photoshop 2020's
 * Chromium 61 engine.
 */

import { Language } from "../../../shared/protocol";

type Dict = Record<string, string>;

const en: Dict = {
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
    "stat.encoder.native": "Photoshop encoder",
    "stat.encoder.js": "fallback encoder",

    "resume.title": "Continue an earlier recording?",
    "resume.body": "This canvas matches recordings you made before. Continue one, or start fresh.",
    "resume.continue": "Continue",
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

    "unit.minute": "min",
    "unit.second": "s",
    "unit.hour": "h",
    "unit.minuteShort": "m",
    "unit.secondShort": "s",
    "unit.ms": "ms",

    "common.details": "Details",
    "common.dismiss": "Dismiss",
    "common.cancel": "Cancel",
    "common.delete": "Delete",
    "common.never": "never"
};

const cn: Dict = {
    "tab.dashboard": "录制",
    "tab.sessions": "录像",
    "tab.settings": "设置",

    "status.connected": "已连接",
    "status.connecting": "连接中…",
    "status.unavailable": "生成器未运行",
    "status.unavailable.hint": "请勾选「编辑 ▸ 首选项 ▸ 增效工具 ▸ 启用生成器」，然后重启 Photoshop。",
    "status.mismatch": "版本不匹配",
    "status.mismatch.hint": "面板和生成器插件版本不一致，请重新安装两者。",

    "record.on": "录制中",
    "record.off": "未录制",
    "record.paused": "已暂停",
    "record.start": "开始录制",
    "record.stop": "停止录制",

    "doc.title": "文档",
    "doc.none": "没有打开的文档",
    "doc.tooSmall": "画布太小，不录制",
    "doc.noSession": "未在录制此文档",
    "doc.startForThis": "录制此文档",

    "stat.frames": "帧数",
    "stat.time": "用时",
    "stat.capture": "抓帧",
    "stat.interval": "每 {0}",
    "stat.encoder.native": "Photoshop 编码器",
    "stat.encoder.js": "备用编码器",

    "resume.title": "继续之前的录制？",
    "resume.body": "这个画布尺寸和你之前的录制相符。可以接着录，也可以新建一个。",
    "resume.continue": "继续",
    "resume.fresh": "新建",
    "resume.frames": "{0} 帧",

    "export.button": "导出",
    "export.title": "导出视频",
    "export.aspect": "宽高比",
    "export.aspect.canvas": "画布比例",
    "export.duration": "时长",
    "export.duration.original": "{0}（原始）",
    "export.timing": "节奏",
    "export.timing.fixed": "匀速",
    "export.timing.realtime": "真实节奏",
    "export.timing.hint": "匀速让每一帧时长相同；真实节奏按落笔的间隔来，停顿会被保留。",
    "export.confirm": "导出",
    "export.cancel": "取消",
    "export.preparing": "检查帧…",
    "export.encoding": "生成视频…",
    "export.finishing": "收尾…",
    "export.started": "开始导出",
    "export.done": "导出成功",
    "export.failed": "导出失败",
    "export.open": "打开",
    "export.noFrames": "这段录制还没有帧",

    "sessions.empty": "还没有录像",
    "sessions.frames": "{0} 帧 · {1}",
    "sessions.open": "打开文件夹",
    "sessions.export": "导出",
    "sessions.delete": "删除",
    "sessions.deleteConfirm": "删除这段录制和它的全部过程图？此操作不可撤销。",
    "sessions.current": "正在录制",
    "sessions.refresh": "刷新",

    "settings.folder": "过程图文件夹",
    "settings.folder.choose": "选择文件夹",
    "settings.folder.hint": "过程图存放位置。修改后已有的录像不会被移动。",
    "settings.resolution": "分辨率",
    "settings.quality": "质量",
    "settings.quality.low": "低",
    "settings.quality.medium": "中",
    "settings.quality.high": "高",
    "settings.interval": "抓帧间隔",
    "settings.interval.hint": "两帧之间的最短间隔。间隔越长，对 Photoshop 的负担越小。",
    "settings.idle": "离开时间",
    "settings.idle.hint": "超过这个时间没有落笔就停止计时。",
    "settings.idle.off": "不停",
    "settings.autoStart": "启动 Photoshop 时自动开始录制",
    "settings.autoStart.hint": "录制在后台进行，不需要打开这个面板。",
    "settings.autoNew": "自动录制新文档",
    "settings.autoNew.hint": "关闭后，每个文档都需要手动开始。",
    "settings.language": "语言",

    "unit.minute": "分钟",
    "unit.second": "秒",
    "unit.hour": "时",
    "unit.minuteShort": "分",
    "unit.secondShort": "秒",
    "unit.ms": "毫秒",

    "common.details": "详情",
    "common.dismiss": "关闭",
    "common.cancel": "取消",
    "common.delete": "删除",
    "common.never": "从不"
};

const dictionaries: Record<Language, Dict> = { en: en, cn: cn };

export type Translate = (key: string, ...args: Array<string | number>) => string;

export function createTranslate(language: Language): Translate {
    const primary = dictionaries[language] || cn;
    return function (key: string, ...args: Array<string | number>): string {
        let text = primary[key];
        if (text === undefined) {
            text = en[key];
        }
        if (text === undefined) {
            return key;
        }
        for (let i = 0; i < args.length; i++) {
            text = text.split("{" + i + "}").join(String(args[i]));
        }
        return text;
    };
}

/** `1h 04m` / `3m 20s` / `12s`, in the active language. */
export function formatDuration(totalSeconds: number, t: Translate): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) {
        return hours + t("unit.hour") + " " + pad2(minutes) + t("unit.minuteShort");
    }
    if (minutes > 0) {
        return minutes + t("unit.minuteShort") + " " + pad2(rest) + t("unit.secondShort");
    }
    return rest + t("unit.secondShort");
}

function pad2(value: number): string {
    return value < 10 ? "0" + value : String(value);
}

export function formatMillis(ms: number | null, t: Translate): string {
    if (ms === null) {
        return "—";
    }
    if (ms < 1000) {
        return Math.round(ms) + " " + t("unit.ms");
    }
    return (ms / 1000).toFixed(1) + " " + t("unit.secondShort");
}
