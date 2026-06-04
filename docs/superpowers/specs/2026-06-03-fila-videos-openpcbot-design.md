# Fila de Vídeos no openpcbot — Design v1

**Data:** 2026-06-03
**Autor:** Nei (+ Claude)
**Status:** aprovado para virar plano de implementação

## Objetivo

Processar a criação de vídeos das skills `video-explicativo`, `videos-cursos-inema`
e `video-demonstrativo` através de uma **fila controlada**, para não sobrecarregar
a máquina (DGX). O usuário comanda por **Telegram**, acompanha por um **painel**, e
recebe notificação (e opcionalmente o vídeo) ao terminar.

O agente Claude é o **orquestrador**: o usuário passa a informação, a fila controla
o resto, executa cada job de ponta a ponta sem babá, e notifica conforme padrões.

## Princípio central

Não construir serviço novo. **Estender o `openpcbot`** (em `~/projetos/openpcbot`),
que já provê toda a infraestrutura sempre-ligada no DGX:

| Peça necessária | Já existe no openpcbot |
|---|---|
| Corpo 24/7 | systemd user service |
| Entrada por Telegram | bot grammy |
| Painel / status | dashboard Hono na porta 3141 |
| Persistência | SQLite (WAL + FTS5) |
| Executor de skill | `runAgent()` (spawna sessão Claude Code com skills) |
| Padrão de "loop que dispara job" | `scheduler.ts` + tabela `scheduled_tasks` |

A fila de vídeo é um **primo do scheduler**, com uma diferença chave: **controle de
concorrência = 1** (o scheduler atual roda os jobs em sequência sem trava explícita).

## Escopo v1

- Concorrência: **1 job por vez**, ordem **FIFO**.
- Usuário único (Nei). Sem proteção contra chamada direta das skills (ver Backlog v2).
- Sem retry automático. Sem prioridade.

### Por que 1 por vez (gargalo é CPU, não GPU)

O render já foi otimizado pra usar a **GPU** (NVENC no encode + Chrome com `--browser-gpu`
na rasterização; TTS já era CUDA), com fallback automático pro CPU. Mas o gargalo real
continua sendo **CPU**: a captura de frames do Chrome orquestra vários workers em CPU, e
as sessões paralelas do usuário saturam os ~20 núcleos. Logo, **serializar os jobs (1 por
vez) ataca o gargalo de frente** — libera CPU. A GPU é o acelerador que faz cada job sair
mais rápido, não substitui a fila. Por isso concorrência = 1 mesmo com a GPU ociosa.

O worker deve instruir o agente a renderizar na GPU (`--gpu --browser-gpu`, com `timeout`
e fallback pro CPU se o arquivo sair vazio) — senão o render headless cairia em x264/CPU.
Referência da lógica já comprovada: `videos-explicativos/fep-videos/render-modulo.sh`.

## Arquitetura

### Componentes novos (dentro do openpcbot)

1. **Tabela `video_jobs`** (no SQLite existente, via `db.ts`).
2. **Worker `video-queue.ts`** — loop com trava de concorrência = 1.
3. **Comandos Telegram** — `/video`, `/fila` (registrados no `bot.ts` via grammy).
4. **Aba "Fila de Vídeos"** no dashboard (`dashboard.ts` / `dashboard-html.ts`).

### Modelo de dados — `video_jobs`

```sql
CREATE TABLE IF NOT EXISTS video_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  skill        TEXT NOT NULL,        -- 'explicativo' | 'curso' | 'demo'
  input        TEXT NOT NULL,        -- assunto (explicativo) ou link (curso/demo)
  opts         TEXT,                 -- JSON: { vertical?, voz?, ... } (default = padrão da skill)
  status       TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed|canceled
  result_path  TEXT,                 -- caminho absoluto do .mp4 gerado
  error        TEXT,                 -- mensagem de falha
  notify       TEXT NOT NULL DEFAULT 'sempre',  -- 'sempre' | 'silencioso'
  send_video   INTEGER NOT NULL DEFAULT 0,      -- 0/1 — anexar o mp4 no Telegram ao terminar
  chat_id      TEXT,                 -- de quem enfileirou (pra notificar)
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status, created_at);
```

Funções em `db.ts` (espelhando o estilo das de `scheduled_tasks`):
`enqueueVideoJob(...)`, `getNextQueuedJob()`, `getRunningJob()`, `markJobRunning(id)`,
`markJobDone(id, resultPath)`, `markJobFailed(id, error)`, `cancelJob(id)`, `listJobs()`.

### Worker — `video-queue.ts`

Inicializado uma vez no boot (junto do `initScheduler`), recebe o `sender` do Telegram.

Loop a cada ~15s (`setInterval`):

```
tick():
  se getRunningJob() existe → return            # trava de concorrência = 1
  job = getNextQueuedJob()                       # FIFO; null se fila vazia → return
  markJobRunning(job.id)
  notifica (se notify=='sempre'): "▶️ Iniciando vídeo #id (skill)"
  prompt = montaPrompt(job)                       # ver abaixo
  try:
    result = await runAgent(prompt, undefined, ()=>{})   # sessão Claude Code autônoma
    path = extraiResultPath(result.text)          # procura linha 'RESULT: <caminho>'
    se path válido → markJobDone(job.id, path); notificaFim(job, path)
    senão           → markJobFailed(job.id, 'sem RESULT no output'); notificaErro
  catch e:
    markJobFailed(job.id, e.message); notificaErro(job, e)
```

**Prompt autônomo** (`montaPrompt`), por skill — exemplo explicativo:

> Use a skill `video-explicativo` para criar um vídeo sobre: "<input>".
> Formato/voz: <padrão da skill, salvo override em opts>.
> Rode o fluxo COMPLETO de ponta a ponta de forma autônoma, **sem pedir
> confirmação de frames nem qualquer interação** — assuma os defaults do
> usuário (PT-BR, dark premium âmbar, CTA INEMA.CLUB).
> Ao terminar, sua ÚLTIMA linha deve ser exatamente:
> `RESULT: <caminho absoluto do arquivo .mp4 final>`
> Se falhar, sua última linha deve ser: `ERRO: <motivo curto>`.

O contrato `RESULT:` / `ERRO:` na última linha é como o worker captura o resultado
de forma determinística (sem precisar interpretar a conversa toda).

### Como o openpcbot "passa pro agente" (a dúvida-chave)

Dois caminhos **separados e determinísticos** — nenhum depende de classificação por IA:

```
[Você no Telegram]
      │  "/video explicativo Teorema de Bayes --enviar"
      ▼
[bot.ts: bot.command('video')]   ← slash command, roteamento fixo, SEM IA
      │  insere linha em video_jobs (status=queued), responde "📥 enfileirado #12"
      ▼
[ tabela video_jobs ]  ←─── fonte da verdade / fila persistente
      ▲
      │  (loop independente, a cada 15s)
[video-queue.ts worker]
      │  pega #12, status→running, monta prompt
      ▼
[runAgent(prompt)]  ← SPAWNA uma sessão Claude Code real, headless, com as skills
      │              (mesmo motor do chat, mas autônoma e dedicada a esse job)
      │  roda video-explicativo de ponta a ponta → gera .mp4
      ▼
[worker lê 'RESULT: /.../video.mp4'] → status→done → notifica/anexa no Telegram
```

Pontos importantes da resposta à dúvida:

- Texto comum (sem `/`) **continua indo pro orquestrador atual** do openpcbot. A fila
  só intercepta os slash commands `/video` e `/fila`. Nada do comportamento existente muda.
- "Passar pro agente" **não** é repassar pra esta conversa de chat. É o worker chamando
  `runAgent`, que **abre uma instância nova e autônoma** do Claude Code (com as skills
  carregadas) só pra produzir aquele vídeo. É isso que serializa e roda sem babá.

### Comandos Telegram

| Comando | Ação |
|---|---|
| `/video explicativo <assunto>` | enfileira job explicativo |
| `/video curso <link>` | enfileira job de curso INEMA |
| `/video demo <link do app>` | enfileira job demonstrativo |
| `/fila` | lista a fila: o que roda agora + queued na ordem |
| `/fila cancelar <id>` | cancela um job ainda `queued` (status→canceled) |

Flags opcionais no fim do comando:

| Flag | Efeito |
|---|---|
| `--vertical` | gera 9:16 em vez do default da skill |
| `--enviar` | anexa o .mp4 no Telegram ao terminar (`send_video=1`) |
| `--silencioso` | não notifica; só aparece no painel (`notify='silencioso'`) |

Parser simples: primeiro token após `/video` = skill; resto até a primeira `--` = input;
flags `--x` viram `opts`/`notify`/`send_video`.

### Painel — aba "Fila de Vídeos" (dashboard :3141)

- Nova rota Hono (ex: `/api/video-jobs` → `listJobs()`), e um card na página do dashboard.
- Mostra: id, skill, input (truncado), status (badge colorido), tempo decorrido
  (running) ou tempo total (done), link pro `.mp4` quando `done`.
- Botão **Cancelar** em jobs `queued` (chama `cancelJob`).
- Sem auth nova — herda o que o dashboard já usa.

### Notificação e entrega (defaults aprovados)

- **Ao terminar:** Telegram "✅ Vídeo #id pronto — <skill>" + caminho do arquivo.
  Anexa o `.mp4` **só se** `--enviar` foi passado (vídeo é pesado; evita encher o chat).
- **Ao falhar:** avisa na hora com o motivo (`ERRO: ...`).
- **Sob demanda:** `/fila` a qualquer momento.
- `--silencioso` suprime as notificações (job só visível no painel).

## Fora de escopo (Backlog v2)

- **Wrapper de render compartilhado (`render-gpu.sh`):** generalizar a lógica
  GPU-first/CPU-fallback do `render-modulo.sh` num único script que as 3 skills chamam.
  Esse wrapper é o lugar natural pra hospedar **também** a trava global abaixo — as duas
  coisas vivem no mesmo chokepoint (o passo de render), então consolida o v2 num ponto só.
- **Trava global de render (lock de 1 vaga):** serializar o passo de render mesmo em
  chamadas diretas das skills / outras pessoas / outras máquinas. Implementação: o
  `render-gpu.sh` acima pega um semáforo (lockfile ou mini-endpoint no openpcbot) antes de
  renderizar. Garante o limite físico independente da fila.
- **Prioridade / job urgente** que fura a fila.
- **Retry automático** em falha.
- Concorrência configurável (> 1).

## Critérios de sucesso (v1)

1. `/video explicativo <assunto>` no Telegram cria um job `queued` e responde com o id.
2. Com a fila vazia, o worker pega o job, roda a skill de ponta a ponta sozinho e gera o `.mp4`.
3. Com 2+ jobs enfileirados, **nunca** roda mais de 1 ao mesmo tempo (FIFO respeitado).
4. Ao terminar, chega a notificação no Telegram; com `--enviar`, o `.mp4` é anexado.
5. `/fila` e o painel refletem o estado real (queued/running/done/failed) a qualquer momento.
6. Falha de um job marca `failed` + motivo e **não trava** a fila (próximo job segue).
