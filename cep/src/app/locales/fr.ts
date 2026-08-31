/**
 * Français. Le chemin de menu suit l'interface française de Photoshop
 * (Édition ▸ Préférences ▸ Modules externes ▸ Activer Generator).
 */

export const dict: Record<string, string> = {
    "tab.dashboard": "Enregistrement",
    "tab.sessions": "Enregistrements",
    "tab.settings": "Paramètres",

    "status.connected": "Connecté",
    "status.connecting": "Connexion…",
    "status.unavailable": "Generator ne fonctionne pas",
    "status.unavailable.hint":
        "Cochez Édition ▸ Préférences ▸ Modules externes ▸ Activer Generator, puis redémarrez Photoshop.",
    "status.mismatch": "Versions différentes",
    "status.mismatch.hint":
        "Le panneau et le module Generator n'ont pas la même version. Réinstallez les deux.",

    "record.on": "Enregistrement en cours",
    "record.off": "Pas d'enregistrement",
    "record.paused": "En pause",
    "record.start": "Démarrer l'enregistrement",
    "record.stop": "Arrêter l'enregistrement",

    "doc.title": "Document",
    "doc.none": "Aucun document ouvert",
    "doc.tooSmall": "Le plan de travail est trop petit pour être enregistré",
    "doc.noSession": "Non enregistré",
    "doc.startForThis": "Enregistrer ce document",

    "stat.frames": "Images",
    "stat.time": "Temps passé",
    "stat.capture": "Capture",
    "stat.interval": "toutes les {0}",
    "stat.encoder.js": "encodeur de secours",

    "resume.title": "Reprendre un enregistrement précédent ?",
    "resume.body":
        "Ce format correspond à des enregistrements déjà réalisés. Reprenez-en un ou repartez de zéro.",
    "resume.fresh": "Repartir de zéro",
    "resume.frames": "{0} images",

    "export.button": "Exporter",
    "export.title": "Exporter la vidéo",
    "export.aspect": "Format",
    "export.aspect.canvas": "Comme le document",
    "export.duration": "Durée",
    "export.duration.original": "{0} (d'origine)",
    "export.timing": "Rythme",
    "export.timing.fixed": "Régulier",
    "export.timing.realtime": "Temps réel",
    "export.timing.hint":
        "Régulier donne la même durée à chaque image. Temps réel reprend les intervalles entre les traits, les pauses restent donc visibles.",
    "export.confirm": "Exporter",
    "export.cancel": "Annuler",
    "export.preparing": "Vérification des images…",
    "export.encoding": "Création de la vidéo…",
    "export.finishing": "Finalisation…",
    "export.started": "Export démarré",
    "export.done": "Export terminé",
    "export.failed": "Échec de l'export",
    "export.open": "Ouvrir",
    "export.noFrames": "Cet enregistrement ne contient encore aucune image",

    "sessions.empty": "Aucun enregistrement pour l'instant",
    "sessions.frames": "{0} images · {1}",
    "sessions.open": "Ouvrir le dossier",
    "sessions.export": "Exporter",
    "sessions.delete": "Supprimer",
    "sessions.deleteConfirm":
        "Supprimer cet enregistrement et toutes ses images ? Cette action est irréversible.",
    "sessions.deleteRestartConfirm":
        "Cet enregistrement est en cours. Le supprimer avec toutes ses images et en commencer un nouveau ? Cette action est irréversible.",
    "sessions.current": "en cours d'enregistrement",
    "sessions.refresh": "Actualiser",

    "settings.folder": "Dossier des images",
    "settings.folder.choose": "Choisir un dossier",
    "settings.folder.hint":
        "Emplacement des images capturées. Le modifier ne déplace pas les enregistrements existants.",
    "settings.resolution": "Résolution",
    "settings.quality": "Qualité",
    "settings.quality.low": "Basse",
    "settings.quality.medium": "Moyenne",
    "settings.quality.high": "Haute",
    "settings.interval": "Intervalle de capture",
    "settings.interval.hint":
        "Intervalle minimal entre deux images. Plus il est long, plus Photoshop est ménagé.",
    "settings.idle": "Délai d'inactivité",
    "settings.idle.hint": "Arrêter le décompte du temps après cette durée sans dessiner.",
    "settings.idle.off": "Jamais",
    "settings.autoStart": "Démarrer l'enregistrement à l'ouverture de Photoshop",
    "settings.autoStart.hint":
        "L'enregistrement tourne en arrière-plan ; ce panneau n'a pas besoin de rester ouvert.",
    "settings.autoNew": "Enregistrer automatiquement les nouveaux documents",
    "settings.autoNew.hint": "Si désactivé, chaque document doit être démarré à la main.",
    "settings.language": "Langue",
    "settings.language.auto": "Comme Photoshop",
    "settings.runtime": "Environnement",
    "settings.runtime.hint": "La version de Node que Photoshop fournit au module, et les solutions de repli de compatibilité actives. Utile à indiquer en cas de problème.",

    "update.setting": "Rechercher les mises à jour",
    "update.setting.hint":
        "Interroge GitHub environ une fois par jour pour savoir si une version plus récente existe. Désactivé par défaut. Aucune information vous concernant ou concernant votre travail n'est envoyée.",
    "update.checkNow": "Rechercher maintenant",
    "update.checking": "Recherche…",
    "update.upToDate": "Vous avez la dernière version",
    "update.failed": "GitHub est injoignable",
    "update.available": "F_Record {0} est disponible",
    "update.body": "Vous utilisez la version {0}.",
    "update.view": "Voir la version",

    "issue.report": "Signaler un problème",
    "issue.hint": "Ouvre le suivi des problèmes du projet sur GitHub dans votre navigateur.",

    "unit.minute": "min",
    "unit.hour": "h",
    "unit.minuteShort": "m",
    "unit.secondShort": "s",
    "unit.ms": "ms",

    "common.dismiss": "Fermer",
};
