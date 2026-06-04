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

1. **Telegram** → comando `/mkivideos explicativo <assunto>` (ou `curso`/`demo`).
   Slash command determinístico: só insere uma linha na tabela `video_jobs`.
2. **Fila** (`video_jobs`, SQLite do openpcbot) → FIFO, 1 job por vez.
3. **Worker** (`video-queue.ts`) → pega o próximo job e chama `runAgent()`,
   que spawna uma sessão Claude Code autônoma rodando a skill de ponta a ponta.
4. **Contrato** `RESULT: <caminho.mp4>` na última linha do agente → o worker
   captura o arquivo, marca `done` e notifica no Telegram (anexa o vídeo com `--enviar`).
5. **Painel** → `http://localhost:3141/videos?token=...` mostra a fila em tempo real.

### Comandos Telegram

Comando único `/mkivideos` (use `/mkivideos help` para parâmetros):

| Comando | Ação |
|---|---|
| `/mkivideos explicativo <assunto>` | enfileira vídeo explicativo |
| `/mkivideos curso <link>` | enfileira vídeo de curso INEMA |
| `/mkivideos demo <link do app>` | enfileira vídeo demonstrativo |
| `/mkivideos fila` | mostra a fila (running + queued) |
| `/mkivideos fila cancelar <id>` | cancela um job ainda na fila |
| `/mkivideos help` | ajuda e parâmetros |

Flags: `--vertical` (9:16), `--enviar` (anexa o .mp4), `--silencioso` (só no painel),
`--pasta <caminho>` (move o .mp4 final pra essa pasta — ou caminho `.mp4` completo).

## Integração com o bot host (jarvis-agnóstica)

A fila não é casada com o **openpcbot** — ele é só o *host* que a gente usou.
O mesmo sistema roda em **qualquer assistente "jarvis" sempre-ligado** (openclaw,
hermes, claudebot, etc.) desde que o host ofereça quatro capacidades. A integração
é um **contrato pequeno**, não um acoplamento:

| O que a fila precisa do host | Como o openpcbot atende | Equivalente num outro jarvis |
|---|---|---|
| **Processo sempre-ligado** (escuta comandos, roda o tick da fila) | systemd user service | qualquer daemon/serviço do bot |
| **Entrada de comando determinística** (`/mkivideos …` → enfileira) | slash command do grammy | handler de comando do bot |
| **Store persistente da fila** | tabela `video_jobs` no SQLite | qualquer DB/arquivo (SQLite, Postgres, JSON) |
| **Spawn de sessão Claude Code autônoma** (o "worker") | `runAgent()` (Claude Agent SDK) | `claude -p`, Agent SDK, ou API equivalente |
| *(opcional)* enviar arquivo / painel | `sendDocument` + dashboard Hono `/videos` | qualquer envio de arquivo / web UI |

### O núcleo portável

Independente do host, a lógica de fila vive em peças puras e testáveis:

- **`video_jobs`** — a fila (id, skill, input, opts, status, result_path, …).
- **`parseVideoCommand`** — texto do comando → job estruturado.
- **`buildVideoPrompt`** — job → prompt autônomo (roda a skill ponta-a-ponta,
  render na GPU com fallback CPU, e termina com `RESULT: <caminho.mp4>`).
- **`processNextJob`** — worker com **concorrência = 1**: pega 1 job, chama o
  `runAgent` do host, lê o `RESULT:`, move pra `--pasta` se houver, notifica.
- **`extractResultPath`** — captura o `.mp4` do output de forma determinística.

Trocar de jarvis = reimplementar só as **bordas** (intake de comando, store,
spawn, envio). O contrato `RESULT: <caminho.mp4>` na última linha do agente é o
que mantém o worker desacoplado de *qual* skill ou *qual* bot está rodando.

## Status

- ✅ **v1 implementado e mergeado no openpcbot** (branch `feat/fila-videos` → `main`,
  149 testes). Roda em produção no DGX após `npm run build` + restart do serviço.
- ⏳ **Fase 2 (pendência): extrair o motor pra este repo.** Hoje o código vive dentro
  do openpcbot. A Fase 2 move o núcleo portável (lógica pura + contratos `QueueDeps`/
  `QueueStore` + schema `video_jobs`) pra cá como pacote, e o openpcbot passa a
  **importar** em vez de manter cópia inline.

### Decisão de acoplamento (Fase 2)

O openpcbot fica **ligado** ao mkivideos (importa o motor), mas com independência onde
importa:

- **Runtime independente:** `npm run build` embute o motor no `dist/` do openpcbot — o
  bot no ar não precisa do mkivideos presente/funcionando; não cai se o mkivideos mudar.
- **Versão fixada (pinned):** o openpcbot trava uma versão (git tag / `npm version`);
  melhorias no mkivideos só entram quando ele roda `npm update` + rebuild. Update sob comando.
- **Fonte única:** melhora-se o motor uma vez aqui → todos os hosts (openpcbot, openclaw,
  hermes…) ganham ao adotar a nova versão. Sem cópia que diverge.

### Backlog v2

- Trava global de render (serializa até chamadas diretas das skills) — ponto único
  compartilhável entre hosts via um `render-gpu.sh` com lock.
- Prioridade / job urgente; retry automático; concorrência configurável.
- Override de pasta por host (`VIDEO_OUTPUT_DIR`) além do `--pasta` por comando.
- Runner standalone (rodar a fila sem bot: store SQLite default + `claude -p` + notifier).
