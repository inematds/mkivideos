# mkivideos

Agente orquestrador para criação de vídeos em fila — integra as skills
`video-explicativo`, `videos-cursos-inema` e `video-demonstrativo` numa fila
controlada (1 por vez), comandada por Telegram e visível num painel.

## Como funciona

O processamento NÃO roda neste repo — roda no **openpcbot** (DGX, sempre ligado).
Este repo guarda o **design e o plano** do sistema:

- Spec: `docs/superpowers/specs/2026-06-03-fila-videos-openpcbot-design.md`
- Plano: `docs/superpowers/plans/2026-06-03-fila-videos-openpcbot.md`

### Arquitetura (v1)

1. **Telegram** → comando `/video explicativo <assunto>` (ou `curso`/`demo`).
   Slash command determinístico: só insere uma linha na tabela `video_jobs`.
2. **Fila** (`video_jobs`, SQLite do openpcbot) → FIFO, 1 job por vez.
3. **Worker** (`video-queue.ts`) → pega o próximo job e chama `runAgent()`,
   que spawna uma sessão Claude Code autônoma rodando a skill de ponta a ponta.
4. **Contrato** `RESULT: <caminho.mp4>` na última linha do agente → o worker
   captura o arquivo, marca `done` e notifica no Telegram (anexa o vídeo com `--enviar`).
5. **Painel** → `http://localhost:3141/videos?token=...` mostra a fila em tempo real.

### Comandos Telegram

| Comando | Ação |
|---|---|
| `/video explicativo <assunto>` | enfileira vídeo explicativo |
| `/video curso <link>` | enfileira vídeo de curso INEMA |
| `/video demo <link do app>` | enfileira vídeo demonstrativo |
| `/fila` | mostra a fila (running + queued) |
| `/fila cancelar <id>` | cancela um job ainda na fila |

Flags: `--vertical` (9:16), `--enviar` (anexa o .mp4), `--silencioso` (só no painel).

### Backlog v2

- Trava global de render (serializa até chamadas diretas das skills).
- Prioridade / job urgente; retry automático; concorrência configurável.
