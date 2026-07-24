# mkivideos

**Serviço/biblioteca portável de fila de vídeos** — enfileira e processa a criação de vídeos
(skills `video-explicativo`, `videos-cursos-inema`, `video-demonstrativo`), com notificação,
**estatísticas** e painel. Dois modos:

1. **Serviço autônomo (recomendado)** — daemon systemd próprio (banco, worker, dashboard).
   Outros serviços (openpcbot, openclaw, hermes…) viram **clientes finos**: só **submetem** job
   e **consultam** a fila, via **CLI** (v1) ou **HTTP** (v2). Não carregam o motor. Ver [deploy/](deploy/README.md).
2. **Biblioteca embutida** — host-agnóstico (ports & adapters): roda dentro do processo do host
   implementando `QueueStore` + `QueueDeps`. (Modo legado; o openpcbot migrou pro modo 1.)

> Por que existe: render de vídeo (HyperFrames/FFmpeg + captura de frames no Chrome) satura CPU.
> A fila **serializa** o disparo (concorrência configurável, default 1) — você comanda, ela controla.
>
> **Worker background+poll (P7):** vídeo profundo de curso = pipeline de 1–2h. Uma sessão de agente
> não segura isso. Por job, o agente faz o **setup** e **dispara o render destacado** (emite `RENDER:`)
> e sai; o worker **vigia o arquivo** até ficar pronto. É o que faz curso profundo **terminar** de verdade.

> 📚 **Ecossistema:** a fila cobre 3 skills, mas o universo de criação de vídeo é grande —
> **skills** (explicativo, demo, cursos, plan-editor, mdd, pixflow, remotion, 3d-animation,
> videoprodutor…), **motores** (HyperFrames, Remotion, pixflow, FFmpeg), **geradores IA**
> (cloud: Seedance/Kling/Runway/Veo/Luma/Sora · local: **SkyReels V3**), **infra DGX**
> (**VideosDGX**) e **apoio** (TTS inemavox/Kokoro/ElevenLabs · imagem flux2-klein/NanoBanana).
> Catálogo completo em **[docs/ecossistema-video.md](docs/ecossistema-video.md)** — referência
> para qualquer hub/UI/fila unificada.

---

## Skill, agente ou worker?

**É um worker (serviço/daemon) — não é skill nem agente.** No sentido de IA, o mkivideos fica
*fora* da camada inteligente: é código determinístico (Node/TypeScript) rodando como daemon
systemd.

| Categoria | É? | Por quê |
|---|---|---|
| **Skill** | ❌ | Não é um pacote de instruções em `~/.claude/skills/`. Ele *nomeia* skills no prompt, mas não é uma. |
| **Agente** | ❌ | Não tem raciocínio, contexto nem LLM. "O host não tem janela de contexto, é só código." |
| **Worker / serviço** | ✅ | Daemon systemd (`mkivideos.service`): fila SQLite + loop de tick + spawn de processo. Puro código. |

Ele **invoca** agentes (cada job dispara um `claude -p`, uma sessão-agente isolada), que por
sua vez **executam** uma skill. A hierarquia:

```
mkivideos            ← WORKER (daemon, código, sem IA)
   └─ claude -p      ← AGENTE (sessão Claude isolada, com contexto próprio)
         └─ skill    ← SKILL (video-explicativo, reel-edita-inema…) que o agente executa
```

Ou seja: **um worker que despacha agentes, que por sua vez rodam skills.** É a camada de
infra/orquestração, não a de inteligência.

---

## O que ele faz (os 4 verbos)

O mkivideos é **só um orquestrador de fila**. Ele **não gera vídeo, não renderiza e não
conhece skill nenhuma** além do nome que costura no prompt — zero IA no host ("o host não
tem janela de contexto, é só código: fila + tick"). Toda a inteligência mora nas skills
executadas por um `claude -p` isolado por job. A função do serviço se resume a 4 verbos:

### 1. Enfileirar
Registra o job na tabela `video_jobs` do SQLite (fonte da verdade). Grava tudo que define
**o quê** e **pra quem**: `kind` (explicativo/curso/demo/transcrever/dublar/reel/reelinematds),
`input` (assunto ou link), destino (`dest`/`--pasta`), `chat_id`, e as flags `notify` e
`send_video` (`--enviar`). O host só **submete** — determinístico, sem IA. Entra como `queued`.
Comandos: `mkivideos add …`, e o `mkivideos plan <url>` que quebra um curso em N jobs.

### 2. Escalonar
Um **tick a cada 15s** varre a fila e reivindica o próximo `queued`, respeitando a
**concorrência** (FIFO, default 1 — só pega um novo se nenhum estiver `running`). É o que
**serializa o disparo** e evita saturar a CPU com dois renders simultâneos. Cada job vira
um processo isolado; um não vaza no contexto do outro.

### 3. Disparar
Monta o **prompt** pelo *builder* correspondente ao `kind` (`buildVideoPrompt` /
`buildInemavoxPrompt` / `buildReelPrompt` / `buildReelInematdsPrompt`), embutindo no texto o
nome da skill-destino (ex.: `` Use a skill `video-explicativo`… ``). Spawna
`claude -p` (`runAgent`) — uma sessão Claude autônoma, de contexto próprio e descartável, que
roda a skill ponta-a-ponta. Como render de curso leva 1–2h e uma sessão não segura isso, o
agente faz o **setup**, **dispara o render em background destacado** (emite `RENDER:`) e sai;
o worker então **vigia o arquivo** (`waitForFile`) até o `.mp4` ficar pronto, o marcador
`.err` aparecer, ou estourar o timeout (2h).

### 4. Entregar / registrar
Ao ver o `RESULT:`/arquivo pronto, fecha o job por até 4 canais:
- **Banco** — `markDone(id, result_path)` (ou `markFailed(id, motivo)`). Canal canônico: quem
  enfileirou **puxa** o resultado por polling (`mkivideos get/status/stats`, dashboard `/videos`).
- **Mover** — se `--pasta`, `moveVideo` leva o artefato pra pasta/arquivo que o solicitante vigia.
- **Notificar** — se `notify=sempre` + `chat_id`, `sendMessage` avisa no Telegram (console no standalone).
- **Anexar** — se `--enviar` + `chat_id`, `sendDocument` manda o próprio `.mp4`/`.txt`/`.srt`.

> Em resumo: **fila persistente + agendador + spawn de agente + entrega do resultado.** Um
> "queue/cron manager" especializado em despachar jobs de vídeo para sessões Claude isoladas.

---

## Índice

- [Skill, agente ou worker?](#skill-agente-ou-worker)
- [O que ele faz (os 4 verbos)](#o-que-ele-faz-os-4-verbos)
- [Como funciona (visão geral)](#como-funciona-visão-geral)
- [Arquitetura: ports & adapters](#arquitetura-ports--adapters)
- [Instalação](#instalação)
- [Uso como biblioteca (dentro de um bot)](#uso-como-biblioteca-dentro-de-um-bot)
- [Uso standalone (sem bot)](#uso-standalone-sem-bot)
- [Dashboard portável](#dashboard-portável)
- [API](#api)
- [O contrato `RESULT:`](#o-contrato-result)
- [Comandos `/mkivideos` (no host Telegram)](#comandos-mkivideos-no-host-telegram)
- [Como outros serviços usam (integração)](#como-outros-serviços-usam-integração)
- [Render na GPU](#render-na-gpu)
- [Desenvolvimento](#desenvolvimento)
- [Status e backlog](#status-e-backlog)

---

## Como funciona (visão geral)

```
[Você no Telegram]  /mkivideos explicativo "Teorema de Bayes" --enviar
        │  (o host registra o comando — determinístico, sem IA)
        ▼
[ QueueStore ]  ← a fila persistente (tabela video_jobs)
        ▲
        │  tick a cada 15s (concorrência = 1)
[ processNextJob ]  ← o worker (deste pacote)
        │  monta o prompt e chama runAgent()
        ▼
[ runAgent ]  ← o host spawna uma sessão Claude Code AUTÔNOMA, isolada,
        │        com janela de contexto própria, que roda a skill ponta-a-ponta
        ▼
output do agente termina com:  RESULT: /caminho/do/video.mp4
        │  o worker captura o caminho (determinístico)
        ▼
markDone → notifica no Telegram → (--enviar) anexa o .mp4 → (--pasta) move pra lá
```

Pontos-chave:

- **Concorrência = 1, FIFO.** O worker só pega um job novo se nenhum estiver `running`.
- **Cada job roda isolado.** `runAgent` spawna um subprocesso Claude Code com **contexto
  próprio e descartável** — não polui nem acumula no contexto do bot. Um job não vaza no outro.
- **O host não tem "janela de contexto".** É só código (fila + tick). Quem gasta contexto
  é o subprocesso daquele job, que nasce e morre com ele.

---

## Arquitetura: ports & adapters

O **núcleo** (parse, prompt, worker) não sabe qual bot, banco ou transporte existe.
Ele fala com o mundo por **duas portas** que o host implementa:

| Porta | O que é | Quem implementa |
|---|---|---|
| **`QueueStore`** | persistência da fila (enqueue, getNext, getRunning, markDone…) | o host (sobre seu DB) — ou o `SqliteQueueStore` que vem aqui |
| **`QueueDeps`** | IO (runAgent, sendMessage, sendDocument, moveVideo) | o host (Telegram, Claude SDK, fs…) |

```
        ┌─────────────────── mkivideos (motor) ───────────────────┐
        │  parseVideoCommand · buildVideoPrompt · extractResultPath │
        │  formatQueueList · mkiHelpText · processNextJob · init…   │
        └───────────────┬───────────────────────┬─────────────────┘
                        │ usa                    │ usa
                 ┌──────▼──────┐          ┌───────▼────────┐
                 │ QueueStore  │          │   QueueDeps    │   ← portas (interfaces)
                 └──────┬──────┘          └───────┬────────┘
          implementado por                implementado por
        ┌───────────────▼──────┐      ┌───────────▼───────────────┐
        │ openpcbot: seu SQLite │      │ openpcbot: grammy + Claude │
        │  (ou SqliteQueueStore)│      │  SDK + fs                  │   ← adaptadores (host)
        └──────────────────────┘      └───────────────────────────┘
```

Trocar de host = reescrever só os **adaptadores**. O núcleo fica intacto.

---

## Instalação

```bash
# como dependência de um host — git tag pinada (recomendado: cópia real, versão travada)
#   package.json: "mkivideos": "git+ssh://git@github.com/inematds/mkivideos.git#v0.1.0"
npm install
# (dev local rápido, sem pinning: "mkivideos": "file:../mkivideos" — symlink pro folder)

# para hackear o próprio pacote
git clone git@github.com:inematds/mkivideos.git && cd mkivideos
npm install && npm run build && npm test
```

Requer Node 20+. O `SqliteQueueStore` usa `better-sqlite3` (binário nativo).

---

## Uso como biblioteca (dentro de um bot)

```ts
import { initVideoQueue, parseVideoCommand, formatQueueList, mkiHelpText } from 'mkivideos';
import { SqliteQueueStore } from 'mkivideos/sqlite-store'; // ou seu próprio QueueStore

const store = new SqliteQueueStore('/data/fila.db');

// 1) Quando chega um comando do usuário, enfileire:
const parsed = parseVideoCommand('explicativo Teorema de Bayes --enviar');
if (parsed.ok) {
  store.enqueue({
    skill: parsed.skill, input: parsed.input,
    opts: parsed.vertical || parsed.dest ? JSON.stringify({ vertical: parsed.vertical, dest: parsed.dest }) : null,
    notify: parsed.silent ? 'silencioso' : 'sempre',
    sendVideo: parsed.send, chatId: '12345',
  });
}

// 2) Suba o worker uma vez (tick de 15s, concorrência = 1):
store.failStaleRunning(); // limpa jobs órfãos de um restart
const stop = initVideoQueue(store, {
  runAgent:    (prompt) => spawnClaudeCode(prompt),          // seu spawn → { text }
  sendMessage: (chatId, text) => telegram.send(chatId, text),
  sendDocument:(chatId, path) => telegram.sendFile(chatId, path),
  moveVideo:   (src, dest) => moveFile(src, dest),           // → caminho final
});
// stop() para o tick (shutdown gracioso)
```

---

## Uso standalone (sem bot)

Desde a **v0.2.0** o pacote traz um **runner pronto** (`bin: mkivideos`): CLI pra enfileirar/
consultar + um daemon que processa a fila (1 por vez) com `runAgent` via `claude -p`,
notificação no console e dashboard opcional. Sem Telegram, sem escrever cola.

```bash
# enfileirar (--curso/--modulo agrupam nas estatísticas e no nome do arquivo P4)
mkivideos add explicativo "Teorema de Bayes" --enviar
mkivideos add curso https://meu-curso --curso skills-craft --modulo t1m1-o-que-e-uma-skill

# PLANNER (curso → fila): mapeia e enfileira 1 job de vídeo por peça — "manda a URL e esquece"
mkivideos plan https://meu-curso        # classifica + decompõe (landing/trilhas/módulos) em N jobs 'video'

# consultar
mkivideos fila
mkivideos stats              # status + por curso (X/Y) + ETA + throughput
mkivideos status <id>        # detalhe de um job
mkivideos get <id>           # só o caminho do .mp4 (vazio se não pronto)
mkivideos cancelar <id>

# rodar o daemon (worker background+poll + dashboard)
mkivideos run --port 3142 --token segredo --concurrency 1 --render-dir /caminho/absoluto/renders
#   → http://localhost:3142/videos?token=segredo  (fila + estatísticas + máquina)

# env: MKIVIDEOS_DB (banco) · MKIVIDEOS_CONCURRENCY · MKIVIDEOS_RENDER_DIR
MKIVIDEOS_DB=/data/fila.db MKIVIDEOS_CONCURRENCY=2 MKIVIDEOS_RENDER_DIR=/data/renders mkivideos run --port 3142
```

> Em produção use o **systemd user unit** em [`deploy/`](deploy/README.md) (`mkivideos.service`).

> ⚠️ **`--render-dir`/`MKIVIDEOS_RENDER_DIR` PRECISA ser caminho absoluto em produção.**
> O default (`'renders'`, relativo — `src/cli.ts`/`src/queue.ts`) funciona bem quando é o
> próprio worker que resolve o caminho (seu cwd é sempre a raiz do pacote), mas o
> `result_path` é gravado **como veio** no banco — se outro processo (ex.: o watcher de um
> bot integrador, que roda com outro cwd) tentar abrir esse caminho relativo, dá `ENOENT`
> mesmo com o arquivo existindo de verdade em disco. **Incidente real (2026-07-19,
> inematds/mkivideos + inematds/inemaccvbot)**: o worker foi reiniciado via `nohup node
> dist/cli.js run ...` direto (pra aplicar uma mudança de código), pulando os `Environment=`
> do unit systemd — inclusive `MKIVIDEOS_RENDER_DIR`. 5 jobs (#120–124) gravaram
> `result_path` relativo e falharam na cópia pro destino (`yt-pub-livesN`) feita pelo
> `inemaccvbot`, mesmo com os `.mp4` intactos em `renders/`. **Lição: nunca suba o worker
> com `nohup`/`node dist/cli.js` direto em produção — sempre `systemctl --user
> restart mkivideos.service` (ou o unit equivalente), mesmo só pra pegar um build novo.**

Pré-requisitos na máquina: `claude` CLI **logado**, as 3 skills de vídeo em `~/.claude/skills/`,
e a stack de render (HyperFrames/FFmpeg/Chrome/TTS/GPU). Sem bin (via lib), monte os deps
você mesmo — veja [Uso como biblioteca](#uso-como-biblioteca-dentro-de-um-bot).

---

## Dashboard portável

Desde a **v0.2.0** o painel é parte do pacote (`mkivideos/dashboard`) — qualquer host ganha:

```ts
import { createDashboardServer, getVideoDashboardHtml } from 'mkivideos/dashboard';

// (a) servidor standalone sem dependências (node:http):
createDashboardServer(store, { port: 3141, token: 'segredo' });
//   GET /videos · GET /api/video-jobs · POST /api/video-jobs/:id/cancel

// (b) ou pegue só o HTML e plugue na sua própria rota (Hono/Express/…):
app.get('/videos', (c) => c.html(getVideoDashboardHtml(MEU_TOKEN)));
```

Mostra os jobs (status colorido), atualiza a cada 5s, cancela os que estão na fila.
O `mkivideos run --port` já sobe esse painel.

---

## API

Exports principais (`import { … } from 'mkivideos'`):

| Símbolo | Tipo | O que faz |
|---|---|---|
| `parseVideoCommand(raw)` | `ParsedCommand` | texto do comando → `{skill,input,vertical,send,silent,dest}` ou `{ok:false,error}` |
| `buildVideoPrompt({skill,input,vertical}, outPath?)` | `string` | prompt autônomo. Sem `outPath`: síncrono (`RESULT:`). Com `outPath`: background+poll (`RENDER:`) |
| `extractResultPath(text)` | `string\|null` | captura o `.mp4` da última linha `RESULT:` (modo síncrono) |
| `extractRenderTarget(text)` | `string\|null` | captura o alvo da última linha `RENDER:` (modo background+poll) |
| `buildOutputName(job)` | `string` | nome de saída P4: `<curso>-<modulo>-<16\|9>.mp4` (usa course/module/opts) |
| `slugify(s)` | `string` | slug seguro pra nome de arquivo |
| `formatQueueList(jobs)` | `string` | render da fila ativa para `/mkivideos fila` |
| `mkiHelpText()` | `string` | texto de ajuda (HTML) |
| `processNextJob(store, deps, opts?)` | `Promise<void>` | processa **1** job (respeita `opts.concurrency`, `opts.background`) |
| `initVideoQueue(store, deps, opts?)` | `() => void` | liga o tick. `opts` = `intervalMs` (number, legado) ou `{concurrency, background, renderDir, pollTimeoutMs, intervalMs}` |

Tipos: `VideoJob` (+ `course`/`module`/`render_target`), `EnqueueInput`, `QueueStore` (+ `runningCount`/`listRunning`/`setRenderTarget`/`stats`), `QueueDeps` (+ `waitForFile?`), `QueueStats`, `WorkerOptions`, `ParsedCommand`.

Store default (`import { SqliteQueueStore } from 'mkivideos/sqlite-store'`): implementa
`QueueStore` com `better-sqlite3`. Construtor: `new SqliteQueueStore(path = ':memory:')`.

Dashboard (`import { … } from 'mkivideos/dashboard'`): `getVideoDashboardHtml(token?)` (a
página) e `createDashboardServer(store, {port?, token?})` (servidor HTTP sem deps).

Bin (`mkivideos`): runner standalone — `add` · `fila` · `cancelar <id>` · `run [--port] [--token]`.

### Flags de comando

| Flag | Efeito |
|---|---|
| `--vertical` | gera 9:16 (Shorts/Reels) em vez do padrão da skill |
| `--enviar` | anexa o `.mp4` ao terminar (`sendDocument`) |
| `--silencioso` | não notifica; job só visível no painel |
| `--pasta <caminho>` | move o `.mp4` final pra essa pasta (ou caminho `.mp4` completo) |

---

## O contrato `RESULT:`

É o que mantém o worker **desacoplado da skill**. O prompt autônomo termina pedindo:

- Sucesso → última linha **exatamente** `RESULT: <caminho absoluto do .mp4>`
- Falha → última linha `ERRO: <motivo>`

`extractResultPath` pega a **última** linha `RESULT:` (case-insensitive, só `\S+\.mp4`).
Sem `RESULT:`, o worker marca o job como `failed` com o motivo do `ERRO:` (ou genérico)
e **libera a fila** — um job que quebra nunca trava o próximo.

---

## Comandos `/mkivideos` (no host Telegram)

Comando único com subcomandos (use `/mkivideos help` para ver tudo):

| Comando | Ação |
|---|---|
| `/mkivideos explicativo <assunto>` | enfileira vídeo explicativo |
| `/mkivideos curso <link>` | enfileira vídeo de curso INEMA |
| `/mkivideos demo <link do app>` | enfileira vídeo demonstrativo |
| `/mkivideos fila` | mostra a fila (running + queued) |
| `/mkivideos fila cancelar <id>` | cancela um job ainda na fila |
| `/mkivideos help` | ajuda e parâmetros |

---

## Como outros serviços usam (integração)

mkivideos roda como **serviço autônomo** (`mkivideos run`, daemon systemd — ver [deploy/](deploy/README.md)).
Qualquer outro serviço fala com ele de três jeitos:

### (A) Cliente CLI — v1 (recomendado, mesma máquina)

O serviço cliente shella o binário `mkivideos` contra o **banco compartilhado** (`MKIVIDEOS_DB`).
É o padrão usado pelo openpcbot — um wrapper fino `mki.sh` (espelha o `vox.sh` do inemavox):

```bash
mki.sh add curso <link> --curso skills-craft --modulo t1m1-o-que-e-uma-skill   # submete
mki.sh fila            # lista running + queued
mki.sh stats           # status + por curso (X/Y) + ETA + throughput
mki.sh status <id>     # detalhe de um job
mki.sh get <id>        # caminho do .mp4 (vazio se não pronto)
mki.sh cancelar <id>
mki.sh ping            # daemon vivo?
```

`add`/consultas funcionam só com o binário + DB; quem **processa** é o daemon (`mkivideos run`).

### (B) Cliente HTTP — v2 (planejado, máquinas diferentes)

O daemon já expõe o dashboard + JSON read-only:
`GET /api/video-jobs`, `GET /api/stats`, `POST /api/video-jobs/:id/cancel` (na `--port`, com `?token=`).
**Falta** (v2) o `POST /jobs` de escrita pra submeter por HTTP sem CLI. Aí clientes em outra máquina
(ou sem shell) submetem por rede.

### (C) Biblioteca embutida — ports & adapters (modo legado)

Pra rodar o motor **dentro** do processo (sem daemon separado), implemente as duas portas e suba o tick:

1. **`QueueStore`** — sobre o DB do host (ou use `SqliteQueueStore`).
2. **`QueueDeps`** — `runAgent`, `sendMessage`, `sendDocument`, `moveVideo` (+ `waitForFile` p/ background+poll).
3. Registre o comando chamando `parseVideoCommand` + `store.enqueue`.
4. `initVideoQueue(store, deps, { concurrency, background: true })` no boot (e `store.failStaleRunning()` antes).

O núcleo não muda — você escreve só as **bordas**.

### Quem migrou: openpcbot (cliente fino)

O [openpcbot](https://github.com/inematds/openpcbot) **deixou de importar o motor** (modo C → modo A):
removeu `initVideoQueue`/`video-store.ts`/funções de fila e a dependência `mkivideos`. O comando
`/mkivideos` e o painel `/videos` agora **chamam o daemon** via `skills/mkivideos/mki.sh` (CLI) e
proxy HTTP (`/api/video-jobs` → `:3142`). O bot ficou mais leve — não segura render nem memória da fila.

---

## Render na GPU

`buildVideoPrompt` instrui o agente a renderizar na GPU com fallback pro CPU:

```bash
npx hyperframes render --quality high --gpu --browser-gpu   # timeout 900
# se o .mp4 sair vazio (GPU falhar):
npx hyperframes render --quality high                        # fallback CPU
```

A GPU absorve TTS/rasterização/encode (NVENC); a **captura de frames continua na CPU** —
por isso a fila (1 por vez) é o que de fato evita sobrecarga; a GPU só acelera cada job.
Lógica de referência: `videos-explicativos/fep-videos/render-modulo.sh`.

---

## Desenvolvimento

```bash
npm install        # instala deps (compila better-sqlite3)
npm run build      # tsc → dist/ (com .d.ts)
npm test           # vitest (núcleo + store)
npm run typecheck  # tsc --noEmit
```

Estrutura:

```
src/
  types.ts          # VideoJob, QueueStore, QueueDeps, ParsedCommand, EnqueueInput
  queue.ts          # parse/prompt/extract/format/help + processNextJob/initVideoQueue
  sqlite-store.ts   # SqliteQueueStore (store default, standalone)
  index.ts          # barrel de exports
  *.test.ts         # vitest
docs/superpowers/   # spec + planos de design
```

---

## Status e backlog

- ✅ **v1**: fila `/mkivideos` em produção no openpcbot (FIFO, 1 por vez, painel, `--pasta`,
  recuperação de job órfão no boot).
- ✅ **Fase 2** (v0.1.0): motor extraído para este pacote; openpcbot importa (git tag pinada).
- ✅ **v0.2.0**: **runner standalone** (bin `mkivideos`) + **dashboard portável** (`mkivideos/dashboard`).
- ✅ **v0.3.0 (serviço autônomo):**
  - **Worker background+poll (P7)** — agente dispara render destacado (`RENDER:`), worker vigia o arquivo (`waitForFile`).
  - **Concorrência configurável** (`MKIVIDEOS_CONCURRENCY` / `--concurrency`).
  - **Estatísticas** — `store.stats()`, dashboard com por-curso (X/Y), processando×espera, ETA, throughput, máquina; CLI `stats`/`status`/`get`.
  - **Metadados course/module** + naming P4 (`buildOutputName` → `<curso>-<modulo>-<16|9>.mp4`); `add --curso/--modulo`.
  - **systemd** `deploy/mkivideos.service`; **openpcbot virou cliente fino** (CLI, sem motor in-process).
- ✅ **v0.4.0 (planner / decomposição):** job `kind: 'plan'` — o agente classifica o input, escolhe a skill,
  mapeia a estrutura (curso → módulos) e **enfileira 1 job `video` por peça** (landing/trilhas/módulos),
  cada um linkado por `parent_id`. Resolve o curso autônomo sem cair no P7 (1 job = 1 etapa). CLI `mkivideos plan <url>`.
  *Worker e parsing testados; o comportamento do agente planner ao vivo (mapear + emitir `ENQUEUE:`) precisa de validação em produção.*
- ⏳ **Backlog**:
  - **Transporte HTTP v2** — `POST /jobs` de escrita (submeter por rede, máquinas diferentes).
  - Notificar o cliente no done (hoje o daemon notifica no console; falta callback/webhook pro Telegram do bot).
  - Trava global de render via lock; prioridade/retry; dropar a tabela `video_jobs` dormente do openpcbot.
  - **Destino do job first-class:** hoje já existe `--pasta <dir|.mp4>` (move o `.mp4` no fim). Falta: tornar o destino uma opção de submissão de primeira classe (escolher pasta/mover ao enviar o job), um **default por curso** (todos os vídeos do curso caem na mesma pasta) e expor isso no cliente (`mki.sh`)/painel.

Spec e planos detalhados em [`docs/superpowers/`](docs/superpowers/).
