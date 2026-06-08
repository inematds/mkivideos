# mkivideos

**Motor portável de fila de vídeos** — enfileira e processa a criação de vídeos
(skills `video-explicativo`, `videos-cursos-inema`, `video-demonstrativo`) **um por
vez**, com notificação e painel. É **host-agnóstico** (ports & adapters): roda dentro
de qualquer assistente "jarvis" sempre-ligado (openpcbot, openclaw, hermes, claudebot…)
ou **standalone**, sem bot nenhum.

> Por que existe: render de vídeo (HyperFrames/FFmpeg + captura de frames no Chrome)
> satura CPU. Rodar vários ao mesmo tempo trava a máquina. Esta fila **serializa**
> (concorrência = 1) e organiza o disparo — você comanda, ela controla o resto.

> 📚 **Ecossistema:** a fila cobre 3 skills, mas há ~12 projetos/skills que criam vídeo
> (demonstrativo, plan-editor, mdd, pixflow, remotion, videoprodutor, promptfilmes, times
> de marketing…). Mapa completo em **[docs/ecossistema-video.md](docs/ecossistema-video.md)** —
> referência para qualquer hub/UI/fila unificada.

---

## Índice

- [Como funciona (visão geral)](#como-funciona-visão-geral)
- [Arquitetura: ports & adapters](#arquitetura-ports--adapters)
- [Instalação](#instalação)
- [Uso como biblioteca (dentro de um bot)](#uso-como-biblioteca-dentro-de-um-bot)
- [Uso standalone (sem bot)](#uso-standalone-sem-bot)
- [Dashboard portável](#dashboard-portável)
- [API](#api)
- [O contrato `RESULT:`](#o-contrato-result)
- [Comandos `/mkivideos` (no host Telegram)](#comandos-mkivideos-no-host-telegram)
- [Integração de referência: openpcbot](#integração-de-referência-openpcbot)
- [Portar para outro host](#portar-para-outro-host)
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
# enfileirar
mkivideos add explicativo "Teorema de Bayes" --enviar
mkivideos add curso https://meu-curso --vertical --pasta /home/nei/videos

# consultar / cancelar
mkivideos fila
mkivideos cancelar 3

# rodar o worker (daemon) — opcionalmente com dashboard web
mkivideos run --port 3141 --token segredo
#   → processa a fila e serve http://localhost:3141/videos?token=segredo

# banco: ./mkivideos.db por padrão, ou defina MKIVIDEOS_DB
MKIVIDEOS_DB=/data/fila.db mkivideos run
```

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
| `buildVideoPrompt({skill,input,vertical})` | `string` | prompt autônomo (roda a skill, render GPU+fallback, emite `RESULT:`) |
| `extractResultPath(text)` | `string\|null` | captura o `.mp4` da última linha `RESULT:` |
| `formatQueueList(jobs)` | `string` | render da fila ativa para `/mkivideos fila` |
| `mkiHelpText()` | `string` | texto de ajuda (HTML) |
| `processNextJob(store, deps)` | `Promise<void>` | processa **1** job (no-op se já houver `running`) |
| `initVideoQueue(store, deps, intervalMs?)` | `() => void` | liga o tick; retorna `stop()` |

Tipos: `VideoJob`, `EnqueueInput`, `QueueStore`, `QueueDeps`, `ParsedCommand`.

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

## Integração de referência: openpcbot

O [openpcbot](https://github.com/inematds/openpcbot) é o host de produção (DGX, sempre
ligado). Ele **importa este pacote** e fornece os adaptadores:

- **`QueueStore`** sobre o SQLite próprio dele (a tabela `video_jobs` no mesmo banco das
  outras features) — em vez do `SqliteQueueStore`.
- **`QueueDeps.runAgent`** via Claude Agent SDK (`runAgent(prompt, undefined, …)` → spawna
  a sessão Claude Code autônoma).
- **`sendMessage`/`sendDocument`** via grammy (Telegram); **`moveVideo`** via `fs`.
- Comando `/mkivideos` (grammy) + painel `/videos` (Hono na :3141).

### Acoplamento: ligado no fonte, independente no runtime

- O openpcbot **importa** o motor por **git tag pinada** (`git+ssh://…/mkivideos.git#v0.1.0`).
  O npm instala uma **cópia real** dessa tag em `node_modules` (não symlink) e roda o `prepare` (build).
- **Versão fixada (pinned):** o openpcbot fica preso à `v0.1.0`. Melhoria aqui só entra quando se
  publica uma **nova tag** e ele roda `npm update mkivideos` + rebuild — sob comando.
- **Runtime independente:** o openpcbot **não depende do folder local** `mkivideos`; usa a cópia
  instalada da tag. Mover/apagar este repo não derruba o bot.

> Trade-off honesto: com `file:../mkivideos` (symlink) NÃO há pinning nem independência — o host lê o
> `dist/` vivo do folder. Por isso a integração de produção usa a **git tag**.

---

## Portar para outro host

Para rodar em openclaw / hermes / claudebot / etc., implemente as duas portas:

1. **`QueueStore`** — sobre o DB do host (ou use `SqliteQueueStore`).
2. **`QueueDeps`** — `runAgent` (como o host spawna o Claude Code), `sendMessage`,
   `sendDocument`, `moveVideo`.
3. Registre o comando `/mkivideos` chamando `parseVideoCommand` + `store.enqueue`.
4. Suba `initVideoQueue(store, deps)` no boot (e `store.failStaleRunning()` antes).

O núcleo não muda. Você escreve só as **bordas** — tipicamente algumas dezenas de linhas.

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
- ✅ **v0.2.0**: **runner standalone** (bin `mkivideos` add/fila/cancelar/run) + **dashboard
  portável** (`mkivideos/dashboard`).
- ⏳ **Backlog**:
  - Notifier webhook no runner (hoje notifica no console); flags do daemon (intervalo configurável).
  - Trava global de render (serializa até chamadas diretas das skills) via `render-gpu.sh` com lock.
  - Prioridade / job urgente; retry automático; concorrência configurável.
  - openpcbot adotar o dashboard portável (`mkivideos/dashboard`) ao subir pra v0.2.0.

Spec e planos detalhados em [`docs/superpowers/`](docs/superpowers/).
