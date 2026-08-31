/**
 * Русский. Путь в меню соответствует русской версии Photoshop
 * (Редактирование ▸ Установки ▸ Внешние модули ▸ Включить Generator).
 */

export const dict: Record<string, string> = {
    "tab.dashboard": "Запись",
    "tab.sessions": "Записи",
    "tab.settings": "Настройки",

    "status.connected": "Подключено",
    "status.connecting": "Подключение…",
    "status.unavailable": "Generator не запущен",
    "status.unavailable.hint":
        "Включите «Редактирование ▸ Установки ▸ Внешние модули ▸ Включить Generator» и перезапустите Photoshop.",
    "status.mismatch": "Версии не совпадают",
    "status.mismatch.hint":
        "У панели и модуля Generator разные версии. Переустановите оба.",

    "record.on": "Идёт запись",
    "record.off": "Запись не ведётся",
    "record.paused": "Приостановлено",
    "record.start": "Начать запись",
    "record.stop": "Остановить запись",

    "doc.title": "Документ",
    "doc.none": "Нет открытых документов",
    "doc.tooSmall": "Холст слишком мал для записи",
    "doc.noSession": "Не записывается",
    "doc.startForThis": "Записывать этот документ",

    "stat.frames": "Кадры",
    "stat.time": "Затрачено времени",
    "stat.capture": "Съёмка",
    "stat.interval": "каждые {0}",
    "stat.encoder.js": "запасной кодировщик",

    "resume.title": "Продолжить предыдущую запись?",
    "resume.body":
        "Размер холста совпадает с вашими прежними записями. Можно продолжить одну из них или начать заново.",
    "resume.fresh": "Начать заново",
    "resume.frames": "кадров: {0}",

    "export.button": "Экспорт",
    "export.title": "Экспорт видео",
    "export.aspect": "Соотношение сторон",
    "export.aspect.canvas": "Как у холста",
    "export.duration": "Длительность",
    "export.duration.original": "{0} (исходная)",
    "export.timing": "Темп",
    "export.timing.fixed": "Равномерный",
    "export.timing.realtime": "Реальное время",
    "export.timing.hint":
        "Равномерный даёт каждому кадру одинаковую длительность. Реальное время использует промежутки между мазками, поэтому паузы остаются заметны.",
    "export.confirm": "Экспорт",
    "export.cancel": "Отмена",
    "export.preparing": "Проверка кадров…",
    "export.encoding": "Создание видео…",
    "export.finishing": "Завершение…",
    "export.started": "Экспорт начат",
    "export.done": "Экспорт завершён",
    "export.failed": "Не удалось выполнить экспорт",
    "export.open": "Открыть",
    "export.noFrames": "В этой записи пока нет кадров",

    "sessions.empty": "Записей пока нет",
    "sessions.frames": "кадров: {0} · {1}",
    "sessions.open": "Открыть папку",
    "sessions.export": "Экспорт",
    "sessions.delete": "Удалить",
    "sessions.deleteConfirm":
        "Удалить эту запись и все её кадры? Это действие нельзя отменить.",
    "sessions.deleteRestartConfirm":
        "Эта запись сейчас идёт. Удалить её вместе со всеми кадрами и начать новую? Это действие нельзя отменить.",
    "sessions.current": "записывается сейчас",
    "sessions.refresh": "Обновить",

    "settings.folder": "Папка кадров",
    "settings.folder.choose": "Выбрать папку",
    "settings.folder.hint":
        "Где хранятся снятые кадры. Изменение не переносит уже сделанные записи.",
    "settings.resolution": "Разрешение",
    "settings.quality": "Качество",
    "settings.quality.low": "Низкое",
    "settings.quality.medium": "Среднее",
    "settings.quality.high": "Высокое",
    "settings.interval": "Интервал съёмки",
    "settings.interval.hint":
        "Наименьший промежуток между двумя кадрами. Чем он больше, тем меньше нагрузка на Photoshop.",
    "settings.idle": "Время простоя",
    "settings.idle.hint": "Прекращать отсчёт времени после такого перерыва в рисовании.",
    "settings.idle.off": "Никогда",
    "settings.autoStart": "Начинать запись при запуске Photoshop",
    "settings.autoStart.hint":
        "Запись идёт в фоне; держать эту панель открытой не нужно.",
    "settings.autoNew": "Автоматически записывать новые документы",
    "settings.autoNew.hint": "Если выключено, каждый документ нужно запускать вручную.",
    "settings.language": "Язык",
    "settings.language.auto": "Как в Photoshop",
    "settings.runtime": "Среда выполнения",
    "settings.runtime.hint": "Версия Node, которую Photoshop даёт модулю, и какие резервные пути совместимости включены. Стоит указать при сообщении о проблеме.",

    "update.setting": "Проверять обновления",
    "update.setting.hint":
        "Примерно раз в сутки спрашивает у GitHub, вышла ли более новая версия. По умолчанию выключено. Никакие сведения о вас или вашей работе не отправляются.",
    "update.checkNow": "Проверить сейчас",
    "update.checking": "Проверка…",
    "update.upToDate": "У вас последняя версия",
    "update.failed": "Не удалось связаться с GitHub",
    "update.available": "Доступна версия F_Record {0}",
    "update.body": "Сейчас установлена версия {0}.",
    "update.view": "Открыть страницу выпуска",

    "issue.report": "Сообщить о проблеме",
    "issue.hint": "Открывает трекер проблем проекта на GitHub в браузере.",

    "unit.minute": "мин",
    "unit.hour": "ч",
    "unit.minuteShort": "м",
    "unit.secondShort": "с",
    "unit.ms": "мс",

    "common.dismiss": "Закрыть",
};
