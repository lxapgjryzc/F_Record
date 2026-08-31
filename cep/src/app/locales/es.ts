/**
 * Español. La ruta de menú sigue la interfaz española de Photoshop
 * (Edición ▸ Preferencias ▸ Plugins ▸ Activar Generator).
 */

export const dict: Record<string, string> = {
    "tab.dashboard": "Grabación",
    "tab.sessions": "Grabaciones",
    "tab.settings": "Ajustes",

    "status.connected": "Conectado",
    "status.connecting": "Conectando…",
    "status.unavailable": "Generator no está en marcha",
    "status.unavailable.hint":
        "Active Edición ▸ Preferencias ▸ Plugins ▸ Activar Generator y reinicie Photoshop.",
    "status.mismatch": "Versiones distintas",
    "status.mismatch.hint":
        "El panel y el plugin Generator tienen versiones diferentes. Vuelva a instalar ambos.",

    "record.on": "Grabando",
    "record.off": "Sin grabar",
    "record.paused": "En pausa",
    "record.start": "Iniciar grabación",
    "record.stop": "Detener grabación",

    "doc.title": "Documento",
    "doc.none": "No hay ningún documento abierto",
    "doc.tooSmall": "El lienzo es demasiado pequeño para grabarlo",
    "doc.noSession": "No se está grabando",
    "doc.startForThis": "Grabar este documento",

    "stat.frames": "Fotogramas",
    "stat.time": "Tiempo empleado",
    "stat.capture": "Captura",
    "stat.interval": "cada {0}",
    "stat.encoder.js": "codificador alternativo",

    "resume.title": "¿Continuar una grabación anterior?",
    "resume.body":
        "Este lienzo coincide con grabaciones que hizo antes. Continúe una o empiece de cero.",
    "resume.fresh": "Empezar de cero",
    "resume.frames": "{0} fotogramas",

    "export.button": "Exportar",
    "export.title": "Exportar vídeo",
    "export.aspect": "Proporción",
    "export.aspect.canvas": "Como el lienzo",
    "export.duration": "Duración",
    "export.duration.original": "{0} (original)",
    "export.timing": "Ritmo",
    "export.timing.fixed": "Uniforme",
    "export.timing.realtime": "Tiempo real",
    "export.timing.hint":
        "Uniforme da la misma duración a cada fotograma. Tiempo real usa los intervalos entre trazos, así que las pausas se ven.",
    "export.confirm": "Exportar",
    "export.cancel": "Cancelar",
    "export.preparing": "Comprobando fotogramas…",
    "export.encoding": "Creando el vídeo…",
    "export.finishing": "Finalizando…",
    "export.started": "Exportación iniciada",
    "export.done": "Exportación terminada",
    "export.failed": "La exportación ha fallado",
    "export.open": "Abrir",
    "export.noFrames": "Esta grabación todavía no tiene fotogramas",

    "sessions.empty": "Aún no hay grabaciones",
    "sessions.frames": "{0} fotogramas · {1}",
    "sessions.open": "Abrir carpeta",
    "sessions.export": "Exportar",
    "sessions.delete": "Eliminar",
    "sessions.deleteConfirm":
        "¿Eliminar esta grabación y todos sus fotogramas? Esta acción no se puede deshacer.",
    "sessions.current": "grabando ahora",
    "sessions.refresh": "Actualizar",

    "settings.folder": "Carpeta de fotogramas",
    "settings.folder.choose": "Elegir carpeta",
    "settings.folder.hint":
        "Dónde se guardan los fotogramas capturados. Cambiarla no mueve las grabaciones existentes.",
    "settings.resolution": "Resolución",
    "settings.quality": "Calidad",
    "settings.quality.low": "Baja",
    "settings.quality.medium": "Media",
    "settings.quality.high": "Alta",
    "settings.interval": "Intervalo de captura",
    "settings.interval.hint":
        "El intervalo mínimo entre dos fotogramas. Cuanto más largo, menos carga para Photoshop.",
    "settings.idle": "Tiempo de inactividad",
    "settings.idle.hint": "Dejar de contar el tiempo tras este rato sin dibujar.",
    "settings.idle.off": "Nunca",
    "settings.autoStart": "Empezar a grabar al abrir Photoshop",
    "settings.autoStart.hint":
        "La grabación se ejecuta en segundo plano; este panel no necesita estar abierto.",
    "settings.autoNew": "Grabar automáticamente los documentos nuevos",
    "settings.autoNew.hint": "Si está desactivado, cada documento debe iniciarse a mano.",
    "settings.language": "Idioma",
    "settings.language.auto": "Como Photoshop",
    "settings.runtime": "Entorno",
    "settings.runtime.hint": "La versión de Node que Photoshop entrega al plugin y qué alternativas de compatibilidad están activas. Conviene indicarla al informar de un problema.",

    "update.setting": "Buscar actualizaciones",
    "update.setting.hint":
        "Consulta a GitHub una vez al día aproximadamente si existe una versión más reciente. Desactivado por defecto. No se envía nada sobre usted ni sobre su trabajo.",
    "update.checkNow": "Buscar ahora",
    "update.checking": "Buscando…",
    "update.upToDate": "Tiene la última versión",
    "update.failed": "No se ha podido contactar con GitHub",
    "update.available": "F_Record {0} ya está disponible",
    "update.body": "Está usando la versión {0}.",
    "update.view": "Ver la versión",

    "issue.report": "Informar de un problema",
    "issue.hint": "Abre en el navegador el gestor de incidencias del proyecto en GitHub.",

    "unit.minute": "min",
    "unit.hour": "h",
    "unit.minuteShort": "m",
    "unit.secondShort": "s",
    "unit.ms": "ms",

    "common.dismiss": "Cerrar",
};
