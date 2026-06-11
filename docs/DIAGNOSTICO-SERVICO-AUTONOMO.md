# Diagnóstico — mkivideos como serviço autônomo

**Data:** 2026-06-08
**Decisão do dono:** desacoplar do openpcbot. mkivideos vira **serviço autônomo** (fila + worker + banco próprios). O openpcbot deixa de rodar o motor in-process e passa a ser **cliente fino**: só **envia** job e **consulta** status. Objetivo: mais leve, mais independente, sem segurar memória no bot.

---

## 1. Estado atual (medido)

### O que está rodando hoje
- O openpcbot **importa o motor** (`initVideoQueue(videoStore, deps)`) e roda o worker **dentro do processo do bot** (`src/index.ts:115`). Concorrência = 1, tick a cada 15s.
- A fila persiste na **mesma tabela `video_jobs` do banco do bot** (`store/openpcbot.db`), via adaptador `src/video-store.ts` + funções escritas à mão em `src/db.ts`.
- O `runAgent` do worker é o **SDK do Claude Agent** do bot (sessão headless).

### Sintoma reportado
"A fila não avança." Na verdade **não está travada** — está **vazia**. Worker vivo (serviço up há 4 dias, tick OK, último job `#97` ficou pronto às 17:27 de hoje). O que existe é **histórico de falha/cancelamento em massa**.

### Números reais (`video_jobs`, 97 jobs no total)
- **90 cancelados**, **4 failed**, **3 done**. Ou seja: ~93% dos jobs nunca viraram vídeo entregue.
- Os 4 `failed` (skill `curso`): erro **`sem RESULT no output do agente`**, cada um ~13 min antes de falhar. Um morreu com `code 143` (SIGTERM no meio).
- O cancelamento em massa (jobs 87–96, às 05:27) foi manual — bate com a mensagem das 02:11 ("eu nao queria os videos").
- Custo colateral: o processo do bot estava com **pico de 16,7 GB de RAM / 6d17h de CPU** — render pesado dentro do bot infla o processo que também atende Telegram.

---

## 2. Causa-raiz (já levantada em PENDENCIAS.md P7)

**O job de curso profundo é grande demais pra uma sessão de agente.**

Vídeo profundo por módulo = pipeline de ~1,5–2h (puxar conteúdo → spec+SVG → narração → **render 14–90 min**). A sessão autônoma (`runAgent` via SDK no bot, ou `claude -p` no standalone) **encerra os turnos em ~13 min**, no meio do setup, **antes do render**. Sem render, nunca sai a linha `RESULT: <caminho>.mp4` que o worker espera → marca `failed`.

A **fila gerencia o fluxo bem**. O problema é o **tamanho do trabalho por job** + o **modelo de execução** (uma sessão síncrona esperando 1–2h). Mover isso pra um serviço autônomo **não resolve sozinho** — o redesenho do worker (item 4) é o que resolve.

---

## 3. Arquitetura alvo

```
┌─────────────┐   add job (HTTP/CLI)    ┌──────────────────────────┐
│  openpcbot  │ ──────────────────────▶ │   mkivideos (daemon)     │
│ (Telegram)  │                          │  - worker (1/vez)        │
│ CLIENTE FINO│ ◀────────────────────── │  - fila SQLite própria   │
└─────────────┘   status/fila (HTTP/CLI) │  - dashboard /videos     │
                                          │  - render em background  │
                                          └──────────────────────────┘
```

- **mkivideos = dono da fila.** Banco próprio (`MKIVIDEOS_DB`, ex.: `~/projetos/mkivideos/mkivideos.db`), worker próprio, roda como **serviço systemd** independente do bot.
- **openpcbot = cliente fino.** Não importa mais `mkivideos` como lib, não roda `initVideoQueue`. Só fala com o daemon (submeter + consultar). Padrão **idêntico ao inemavox** (`skills/inemavox/vox.sh ping|submit|status|get`).

### O que JÁ existe (não precisa construir)
- `mkivideos run [--port N] [--token T]` → daemon: worker (`initVideoQueue`) + dashboard HTTP (`createDashboardServer`). — `src/cli.ts:32`
- `mkivideos add | fila | cancelar` → CLI one-shot no mesmo banco. — `src/cli-lib.ts`
- Store SQLite próprio (`SqliteQueueStore`, `src/sqlite-store.ts`) com `failStaleRunning()` no boot.
- Core puro e testado: `parseVideoCommand`, `buildVideoPrompt`, `extractResultPath`, `formatQueueList` (`src/queue.ts`, com `queue.test.ts`).

### O que FALTA construir
1. **Worker resiliente a render longo (P7 — bloqueante).** Hoje o worker espera UMA sessão fazer tudo. Trocar pelo modelo **dispara render em background + poll**:
   - o agente faz o setup (conteúdo → spec → narração) e **dispara o render destacado** (nohup/PID), emitindo o caminho-alvo do `.mp4` e saindo;
   - o worker passa a **vigiar o arquivo** até existir/estabilizar (ou checar o PID), então marca `done`. Libera a sessão.
   - Opcional mais robusto: **1 job = 1 etapa** (setup / narração / render) em vez de 1 job = tudo. Cada etapa cabe numa sessão.
2. **Superfície de submissão/consulta pro cliente.** Decidir entre:
   - **(A) CLI via SSH/local** — openpcbot shella `mkivideos add ...` / `mkivideos fila` (mais simples, igual padrão atual do bot). Bom se bot e daemon estão na mesma máquina.
   - **(B) HTTP JSON** — daemon expõe `POST /jobs`, `GET /jobs`, `GET /jobs/:id` (além do dashboard HTML que já existe). Mais limpo e desacoplado; permite máquinas diferentes. Hoje o dashboard só serve HTML read-only — falta o JSON de escrita/leitura.
3. **Serviço systemd** (`mkivideos.service`, user unit) com `MKIVIDEOS_DB`, `--port`, `--token`, restart on-failure. Análogo ao `inemavox-api`.
4. **Skill/cliente no openpcbot** (`skills/mkivideos/mki.sh`): `ping | add | fila | status | get`, espelhando o `vox.sh`. Auto-trigger no CLAUDE.md do bot.

### O que REMOVER do openpcbot (na migração)
- `src/index.ts:112–131` (bloco `initVideoQueue` + worker in-process) e o `failStaleRunningJobs()` do boot.
- `src/video-store.ts` (adaptador) e as funções de fila em `src/db.ts` (`enqueueVideoJob`, `getNextQueuedJob`, `markJob*`, `failStaleRunningJobs`, `listJobs`, `cancelJob`) — elimina a **duplicação de schema** `video_jobs` (tabela hand-written no bot ≠ schema do `SqliteQueueStore`).
- Dependência `"mkivideos"` no `package.json` do bot (não importa mais como lib).
- O handler `/mkivideos` no `bot.ts` passa a chamar o cliente (item 4), não o motor local.

---

## 4. Decisões em aberto (precisam do dono)

1. **Render longo (P7):** confirmar o caminho **(c) background + poll** (recomendado) vs **1 job = 1 etapa**. Sem isso, curso profundo continua falhando mesmo autônomo.
2. **Transporte cliente↔daemon:** **CLI (A)** ou **HTTP JSON (B)**? Mesma máquina hoje → CLI é o caminho rápido; HTTP deixa pronto pra separar máquinas depois.
3. **Concorrência (P1):** manter `1` ou expor configurável (host tem 20 núcleos, ~14 ociosos com 1/vez → até ~3× throughput). Decisão de produção em volume.
4. **Migração do histórico:** começar o banco do daemon limpo, ou migrar os `video_jobs` atuais do `store/openpcbot.db`? (Recomendo limpo — o histórico é 93% cancelado/failed.)

---

## 5. Próximos passos sugeridos (ordem)

1. Decidir itens 1 e 2 acima (desbloqueiam tudo).
2. Implementar o **worker background+poll** (P7) — é o que de fato faz o curso profundo terminar.
3. Expor a superfície de cliente (CLI ou HTTP) + `mkivideos.service` systemd.
4. Criar `skills/mkivideos/mki.sh` no openpcbot e migrar o handler `/mkivideos`.
5. Remover o motor in-process do bot (item "REMOVER" acima) e rebuildar o bot.
6. Smoke test: 1 job leve (landing/overview) ponta a ponta via cliente → daemon → entrega no Telegram.

> Ver também `PENDENCIAS.md` (P1 concorrência, P5/P6 dashboard por curso + ETA, P7 worker autônomo) — este diagnóstico assume essas pendências e foca no **desacoplamento + autonomia**.
