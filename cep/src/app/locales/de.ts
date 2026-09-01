/**
 * Deutsch. Der Menüpfad folgt der deutschen Photoshop-Oberfläche
 * (Bearbeiten ▸ Voreinstellungen ▸ Zusatzmodule ▸ Generator aktivieren).
 */

export const dict: Record<string, string> = {
    "tab.dashboard": "Aufnahme",
    "tab.sessions": "Aufnahmen",
    "tab.settings": "Einstellungen",

    "status.connected": "Verbunden",
    "status.connecting": "Verbindung wird hergestellt…",
    "status.unavailable": "Generator läuft nicht",
    "status.unavailable.hint":
        "Aktivieren Sie Bearbeiten ▸ Voreinstellungen ▸ Zusatzmodule ▸ Generator aktivieren und starten Sie Photoshop neu.",
    "status.mismatch": "Versionen stimmen nicht überein",
    "status.mismatch.hint":
        "Bedienfeld und Generator-Zusatzmodul haben unterschiedliche Versionen. Installieren Sie beide neu.",

    "record.on": "Nimmt auf",
    "record.off": "Nimmt nicht auf",
    "record.paused": "Angehalten",
    "record.start": "Aufnahme starten",
    "record.stop": "Aufnahme beenden",

    "doc.title": "Dokument",
    "doc.none": "Kein Dokument geöffnet",
    "doc.tooSmall": "Arbeitsfläche ist zu klein für eine Aufnahme",
    "doc.noSession": "Wird nicht aufgenommen",
    "doc.startForThis": "Dieses Dokument aufnehmen",

    "stat.frames": "Bilder",
    "stat.time": "Arbeitszeit",
    "stat.capture": "Aufnahme",
    "stat.interval": "alle {0}",
    "stat.encoder.js": "Ersatz-Encoder",

    "resume.title": "Frühere Aufnahme fortsetzen?",
    "resume.body":
        "Diese Arbeitsfläche passt zu Aufnahmen von früher. Setzen Sie eine davon fort oder beginnen Sie neu.",
    "resume.fresh": "Neu beginnen",
    "resume.frames": "{0} Bilder",

    "export.button": "Exportieren",
    "export.title": "Video exportieren",
    "export.aspect": "Seitenverhältnis",
    "export.aspect.canvas": "Wie Arbeitsfläche",
    "export.duration": "Länge",
    "export.duration.original": "{0} (Original)",
    "export.timing": "Tempo",
    "export.timing.fixed": "Gleichmäßig",
    "export.timing.realtime": "Echtzeit",
    "export.timing.hint":
        "Gleichmäßig gibt jedem Bild dieselbe Länge. Echtzeit verwendet die Abstände zwischen den Strichen, Pausen bleiben also sichtbar.",
    "export.confirm": "Exportieren",
    "export.cancel": "Abbrechen",
    "export.preparing": "Bilder werden geprüft…",
    "export.encoding": "Video wird erstellt…",
    "export.finishing": "Wird abgeschlossen…",
    "export.started": "Export gestartet",
    "export.done": "Export abgeschlossen",
    "export.failed": "Export fehlgeschlagen",
    "export.open": "Öffnen",
    "export.noFrames": "Diese Aufnahme enthält noch keine Bilder",

    "toast.dismiss": "Schließen",

    "sessions.empty": "Noch keine Aufnahmen",
    "sessions.frames": "{0} Bilder · {1}",
    "sessions.open": "Ordner öffnen",
    "sessions.export": "Exportieren",
    "sessions.delete": "Löschen",
    "sessions.deleteConfirm":
        "Diese Aufnahme und alle ihre Bilder löschen? Das lässt sich nicht rückgängig machen.",
    "sessions.deleteRestartConfirm":
        "Diese Aufnahme läuft gerade. Sie mit allen ihren Bildern löschen und eine neue starten? Das lässt sich nicht rückgängig machen.",
    "sessions.current": "wird gerade aufgenommen",
    "sessions.refresh": "Aktualisieren",

    "settings.folder": "Bilderordner",
    "settings.folder.choose": "Ordner wählen",
    "settings.folder.hint":
        "Wo aufgenommene Bilder gespeichert werden. Eine Änderung verschiebt vorhandene Aufnahmen nicht.",
    "settings.resolution": "Auflösung",
    "settings.quality": "Qualität",
    "settings.quality.low": "Niedrig",
    "settings.quality.medium": "Mittel",
    "settings.quality.high": "Hoch",
    "settings.interval": "Aufnahmeabstand",
    "settings.interval.hint":
        "Der kürzeste Abstand zwischen zwei Bildern. Größere Abstände schonen Photoshop.",
    "settings.idle": "Leerlaufzeit",
    "settings.idle.hint": "Die Zeitzählung nach so langer Zeit ohne Zeichnen anhalten.",
    "settings.idle.off": "Nie",
    "settings.autoStart": "Aufnahme beim Start von Photoshop beginnen",
    "settings.autoStart.hint":
        "Die Aufnahme läuft im Hintergrund; dieses Bedienfeld muss nicht geöffnet bleiben.",
    "settings.autoNew": "Neue Dokumente automatisch aufnehmen",
    "settings.autoNew.hint": "Wenn aus, muss jedes Dokument von Hand gestartet werden.",
    "settings.language": "Sprache",
    "settings.language.auto": "Wie Photoshop",
    "settings.runtime": "Laufzeitumgebung",
    "settings.runtime.hint": "Die Node-Version, die Photoshop dem Zusatzmodul gibt, und welche Kompatibilitäts-Fallbacks aktiv sind. Beim Melden eines Problems hilfreich.",

    "update.setting": "Nach Updates suchen",
    "update.setting.hint":
        "Fragt etwa einmal täglich bei GitHub nach, ob eine neuere Version vorliegt. Standardmäßig aus. Es werden keine Daten über Sie oder Ihre Arbeit gesendet.",
    "update.checkNow": "Jetzt suchen",
    "update.checking": "Wird gesucht…",
    "update.upToDate": "Sie haben die neueste Version",
    "update.failed": "GitHub war nicht erreichbar",
    "update.available": "F_Record {0} ist verfügbar",
    "update.body": "Sie verwenden {0}.",
    "update.view": "Version ansehen",

    "issue.report": "Problem melden",
    "issue.hint": "Öffnet den Issue-Tracker des Projekts auf GitHub im Browser.",

    "unit.minute": "Min.",
    "unit.hour": "Std.",
    "unit.minuteShort": "m",
    "unit.secondShort": "s",
    "unit.ms": "ms",

    "common.dismiss": "Schließen",
};
