/**
 * 日本語。メニュー階層は日本語版 Photoshop の実際の表記に合わせています
 *（編集 ▸ 環境設定 ▸ プラグイン ▸ ジェネレーターを使用）。
 */

export const dict: Record<string, string> = {
    "tab.dashboard": "記録",
    "tab.sessions": "記録一覧",
    "tab.settings": "設定",

    "status.connected": "接続済み",
    "status.connecting": "接続中…",
    "status.unavailable": "ジェネレーターが動作していません",
    "status.unavailable.hint":
        "「編集 ▸ 環境設定 ▸ プラグイン ▸ ジェネレーターを使用」にチェックを入れ、Photoshop を再起動してください。",
    "status.mismatch": "バージョンの不一致",
    "status.mismatch.hint": "パネルとジェネレータープラグインのバージョンが異なります。両方を再インストールしてください。",

    "record.on": "記録中",
    "record.off": "停止中",
    "record.paused": "一時停止中",
    "record.start": "記録を開始",
    "record.stop": "記録を停止",

    "doc.title": "ドキュメント",
    "doc.none": "開いているドキュメントがありません",
    "doc.tooSmall": "カンバスが小さすぎるため記録しません",
    "doc.noSession": "このドキュメントは記録されていません",
    "doc.startForThis": "このドキュメントを記録",

    "stat.frames": "フレーム数",
    "stat.time": "作業時間",
    "stat.capture": "キャプチャ",
    "stat.interval": "{0} ごと",
    "stat.encoder.js": "代替エンコーダー",

    "resume.title": "前回の記録を続けますか？",
    "resume.body": "このカンバスサイズは以前の記録と一致します。続きから記録するか、新しく始めることができます。",
    "resume.fresh": "新規に開始",
    "resume.frames": "{0} フレーム",

    "export.button": "書き出し",
    "export.title": "動画を書き出し",
    "export.aspect": "縦横比",
    "export.aspect.canvas": "カンバスに合わせる",
    "export.duration": "長さ",
    "export.duration.original": "{0}（元の長さ）",
    "export.timing": "テンポ",
    "export.timing.fixed": "等間隔",
    "export.timing.realtime": "実時間",
    "export.timing.hint":
        "等間隔はすべてのフレームを同じ長さにします。実時間は筆の間隔をそのまま使うため、止まっていた時間も残ります。",
    "export.confirm": "書き出し",
    "export.cancel": "キャンセル",
    "export.preparing": "フレームを確認中…",
    "export.encoding": "動画を作成中…",
    "export.finishing": "仕上げ中…",
    "export.started": "書き出しを開始しました",
    "export.done": "書き出しが完了しました",
    "export.failed": "書き出しに失敗しました",
    "export.open": "開く",
    "export.noFrames": "この記録にはまだフレームがありません",

    "sessions.empty": "記録はまだありません",
    "sessions.frames": "{0} フレーム · {1}",
    "sessions.open": "フォルダーを開く",
    "sessions.export": "書き出し",
    "sessions.delete": "削除",
    "sessions.deleteConfirm": "この記録とすべてのフレームを削除しますか？この操作は取り消せません。",
    "sessions.current": "記録中",
    "sessions.refresh": "再読み込み",

    "settings.folder": "フレームの保存先",
    "settings.folder.choose": "フォルダーを選択",
    "settings.folder.hint": "キャプチャしたフレームの保存場所です。変更しても既存の記録は移動しません。",
    "settings.resolution": "解像度",
    "settings.quality": "画質",
    "settings.quality.low": "低",
    "settings.quality.medium": "中",
    "settings.quality.high": "高",
    "settings.interval": "キャプチャ間隔",
    "settings.interval.hint": "フレーム間の最短の間隔です。長くするほど Photoshop への負担が軽くなります。",
    "settings.idle": "放置時間",
    "settings.idle.hint": "この時間だけ描画がないと、作業時間の計測を止めます。",
    "settings.idle.off": "しない",
    "settings.autoStart": "Photoshop の起動時に記録を開始",
    "settings.autoStart.hint": "記録はバックグラウンドで動くため、このパネルを開いておく必要はありません。",
    "settings.autoNew": "新規ドキュメントを自動的に記録",
    "settings.autoNew.hint": "オフにすると、ドキュメントごとに手動で開始する必要があります。",
    "settings.language": "言語",
    "settings.language.auto": "Photoshop に合わせる",

    "update.setting": "アップデートを確認",
    "update.setting.hint":
        "新しいバージョンがあるか、1 日に 1 回ほど GitHub に問い合わせます。初期状態ではオフです。あなたや作品に関する情報は一切送信しません。",
    "update.checkNow": "今すぐ確認",
    "update.checking": "確認中…",
    "update.upToDate": "最新バージョンです",
    "update.failed": "GitHub に接続できませんでした",
    "update.available": "F_Record {0} が公開されています",
    "update.body": "現在のバージョンは {0} です。",
    "update.view": "リリースを見る",

    "issue.report": "問題を報告",
    "issue.hint": "GitHub の問題報告ページをブラウザーで開きます。",

    "unit.minute": "分",
    "unit.hour": "時間",
    "unit.minuteShort": "分",
    "unit.secondShort": "秒",
    "unit.ms": "ミリ秒",

    "common.dismiss": "閉じる",
};
