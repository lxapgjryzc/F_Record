/**
 * Português do Brasil. O caminho de menu segue a interface brasileira do
 * Photoshop (Editar ▸ Preferências ▸ Plug-ins ▸ Ativar Gerador).
 */

export const dict: Record<string, string> = {
    "tab.dashboard": "Gravação",
    "tab.sessions": "Gravações",
    "tab.settings": "Configurações",

    "status.connected": "Conectado",
    "status.connecting": "Conectando…",
    "status.unavailable": "O Gerador não está em execução",
    "status.unavailable.hint":
        "Marque Editar ▸ Preferências ▸ Plug-ins ▸ Ativar Gerador e reinicie o Photoshop.",
    "status.mismatch": "Versões diferentes",
    "status.mismatch.hint":
        "O painel e o plug-in do Gerador estão em versões diferentes. Reinstale os dois.",

    "record.on": "Gravando",
    "record.off": "Não está gravando",
    "record.paused": "Pausado",
    "record.start": "Iniciar gravação",
    "record.stop": "Parar gravação",

    "doc.title": "Documento",
    "doc.none": "Nenhum documento aberto",
    "doc.tooSmall": "A tela é pequena demais para gravar",
    "doc.noSession": "Não está sendo gravado",
    "doc.startForThis": "Gravar este documento",

    "stat.frames": "Quadros",
    "stat.time": "Tempo gasto",
    "stat.capture": "Captura",
    "stat.interval": "a cada {0}",
    "stat.encoder.js": "codificador reserva",

    "resume.title": "Continuar uma gravação anterior?",
    "resume.body":
        "Esta tela corresponde a gravações que você fez antes. Continue uma delas ou comece do zero.",
    "resume.fresh": "Começar do zero",
    "resume.frames": "{0} quadros",

    "export.button": "Exportar",
    "export.title": "Exportar vídeo",
    "export.aspect": "Proporção",
    "export.aspect.canvas": "Igual à tela",
    "export.duration": "Duração",
    "export.duration.original": "{0} (original)",
    "export.timing": "Ritmo",
    "export.timing.fixed": "Uniforme",
    "export.timing.realtime": "Tempo real",
    "export.timing.hint":
        "Uniforme dá a mesma duração a cada quadro. Tempo real usa os intervalos entre as pinceladas, então as pausas aparecem.",
    "export.confirm": "Exportar",
    "export.cancel": "Cancelar",
    "export.preparing": "Verificando quadros…",
    "export.encoding": "Criando o vídeo…",
    "export.finishing": "Finalizando…",
    "export.started": "Exportação iniciada",
    "export.done": "Exportação concluída",
    "export.failed": "A exportação falhou",
    "export.open": "Abrir",
    "export.noFrames": "Esta gravação ainda não tem quadros",

    "sessions.empty": "Nenhuma gravação ainda",
    "sessions.frames": "{0} quadros · {1}",
    "sessions.open": "Abrir pasta",
    "sessions.export": "Exportar",
    "sessions.delete": "Excluir",
    "sessions.deleteConfirm":
        "Excluir esta gravação e todos os seus quadros? Não é possível desfazer.",
    "sessions.current": "gravando agora",
    "sessions.refresh": "Atualizar",

    "settings.folder": "Pasta dos quadros",
    "settings.folder.choose": "Escolher pasta",
    "settings.folder.hint":
        "Onde os quadros capturados ficam guardados. Alterar não move as gravações existentes.",
    "settings.resolution": "Resolução",
    "settings.quality": "Qualidade",
    "settings.quality.low": "Baixa",
    "settings.quality.medium": "Média",
    "settings.quality.high": "Alta",
    "settings.interval": "Intervalo de captura",
    "settings.interval.hint":
        "O menor intervalo entre dois quadros. Intervalos maiores pesam menos no Photoshop.",
    "settings.idle": "Tempo ocioso",
    "settings.idle.hint": "Parar de contar o tempo depois deste período sem desenhar.",
    "settings.idle.off": "Nunca",
    "settings.autoStart": "Começar a gravar ao abrir o Photoshop",
    "settings.autoStart.hint":
        "A gravação roda em segundo plano; este painel não precisa ficar aberto.",
    "settings.autoNew": "Gravar novos documentos automaticamente",
    "settings.autoNew.hint": "Quando desligado, cada documento precisa ser iniciado à mão.",
    "settings.language": "Idioma",
    "settings.language.auto": "Igual ao Photoshop",

    "update.setting": "Verificar atualizações",
    "update.setting.hint":
        "Pergunta ao GitHub cerca de uma vez por dia se existe uma versão mais nova. Desligado por padrão. Nada sobre você ou seu trabalho é enviado.",
    "update.checkNow": "Verificar agora",
    "update.checking": "Verificando…",
    "update.upToDate": "Você está na versão mais recente",
    "update.failed": "Não foi possível acessar o GitHub",
    "update.available": "F_Record {0} está disponível",
    "update.body": "Você está usando a versão {0}.",
    "update.view": "Ver a versão",

    "issue.report": "Relatar um problema",
    "issue.hint": "Abre no navegador a página de problemas do projeto no GitHub.",

    "unit.minute": "min",
    "unit.hour": "h",
    "unit.minuteShort": "m",
    "unit.secondShort": "s",
    "unit.ms": "ms",

    "common.dismiss": "Fechar",
};
