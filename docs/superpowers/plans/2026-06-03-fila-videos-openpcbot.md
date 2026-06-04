# Fila de Vídeos no openpcbot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma fila FIFO (1 job por vez) que processa as skills de vídeo (`video-explicativo`, `videos-cursos-inema`, `video-demonstrativo`), comandada por Telegram e visível num painel, estendendo o `openpcbot`.

**Architecture:** Tudo vive no repo `~/projetos/openpcbot`. Uma tabela `video_jobs` (SQLite existente) é a fila. Um worker (`video-queue.ts`) com trava de concorrência = 1 pega o próximo job e chama `runAgent()` (spawn de sessão Claude Code autônoma com as skills). Comandos `/video` e `/fila` (grammy) enfileiram/consultam; rotas Hono + página `/videos` no dashboard mostram o estado. O contrato `RESULT: <caminho>` na última linha do output do agente é como o worker captura o `.mp4` de forma determinística.

**Tech Stack:** Node 20 + TypeScript, better-sqlite3 (WAL), grammy (Telegram), Hono (dashboard), `@anthropic-ai/claude-agent-sdk` (`runAgent`), vitest.

> ⚠️ **Repo de implementação:** o código deste plano é escrito em `~/projetos/openpcbot`, NÃO em `mkivideos`. O `mkivideos` guarda só o spec/plano e o README de documentação. Antes de começar: `cd ~/projetos/openpcbot`.

**Spec de origem:** `docs/superpowers/specs/2026-06-03-fila-videos-openpcbot-design.md` (no repo mkivideos).

---

## File Structure

No `~/projetos/openpcbot`:

- **Modify** `src/db.ts` — tabela `video_jobs` no schema + interface `VideoJob` + funções de fila.
- **Create** `src/video-queue.ts` — funções puras (parser, prompt, extrator) + worker `initVideoQueue` / `processNextJob`.
- **Create** `src/video-queue.test.ts` — testes das funções puras e do `processNextJob` (com `runAgent` injetado).
- **Modify** `src/db.test.ts` — testes das funções de fila no banco em memória.
- **Modify** `src/bot.ts` — comandos `/video` e `/fila` + entradas em `setMyCommands`.
- **Create** `src/video-dashboard-html.ts` — HTML autocontido da página `/videos`.
- **Modify** `src/dashboard.ts` — rotas `GET /api/video-jobs`, `POST /api/video-jobs/:id/cancel`, `GET /videos`.
- **Modify** `src/index.ts` — chamar `initVideoQueue(...)` no boot.

No `~/projetos/mkivideos` (documentação, último task):

- **Modify** `README.md` — documentar o sistema. Commit + push para o GitHub.

---

## Task 1: Tabela `video_jobs` + funções de fila no db

**Files:**
- Modify: `src/db.ts` (schema em `createSchema`, ~linha 9; funções perto das de `scheduled_tasks`, ~linha 308-373)
- Test: `src/db.test.ts`

- [ ] **Step 1: Escrever os testes que falham**

Adicione no fim de `src/db.test.ts`, dentro do `describe('database', ...)`, antes do `});` final. Importe as novas funções no bloco de import do topo do arquivo (adicione os nomes à lista existente que importa de `./db.js`):

```ts
// adicionar à lista de imports de './db.js' no topo:
//   enqueueVideoJob, getNextQueuedJob, getRunningJob,
//   markJobRunning, markJobDone, markJobFailed, cancelJob, listJobs,

describe('video_jobs queue', () => {
  it('enqueue creates a queued job and returns its id', () => {
    const id = enqueueVideoJob({
      skill: 'explicativo', input: 'Teorema de Bayes',
      opts: null, notify: 'sempre', sendVideo: false, chatId: '123',
    });
    expect(id).toBeGreaterThan(0);
    const job = getNextQueuedJob();
    expect(job?.id).toBe(id);
    expect(job?.status).toBe('queued');
    expect(job?.skill).toBe('explicativo');
  });

  it('getNextQueuedJob is FIFO by created_at then id', () => {
    const a = enqueueVideoJob({ skill: 'explicativo', input: 'A', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    const b = enqueueVideoJob({ skill: 'explicativo', input: 'B', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    expect(getNextQueuedJob()?.id).toBe(a);
    markJobRunning(a);
    markJobDone(a, '/tmp/a.mp4');
    expect(getNextQueuedJob()?.id).toBe(b);
  });

  it('getRunningJob returns the running job or null', () => {
    expect(getRunningJob()).toBeNull();
    const id = enqueueVideoJob({ skill: 'demo', input: 'http://x', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    markJobRunning(id);
    expect(getRunningJob()?.id).toBe(id);
  });

  it('markJobDone sets status, result_path and finished_at', () => {
    const id = enqueueVideoJob({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    markJobRunning(id);
    markJobDone(id, '/out/x.mp4');
    const done = listJobs().find((j) => j.id === id)!;
    expect(done.status).toBe('done');
    expect(done.result_path).toBe('/out/x.mp4');
    expect(done.finished_at).toBeGreaterThan(0);
  });

  it('markJobFailed records the error and frees the queue', () => {
    const id = enqueueVideoJob({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    markJobRunning(id);
    markJobFailed(id, 'render quebrou');
    const failed = listJobs().find((j) => j.id === id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('render quebrou');
    expect(getRunningJob()).toBeNull();
  });

  it('cancelJob only cancels queued jobs', () => {
    const id = enqueueVideoJob({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    expect(cancelJob(id)).toBe(true);
    expect(listJobs().find((j) => j.id === id)!.status).toBe('canceled');
    const running = enqueueVideoJob({ skill: 'explicativo', input: 'Y', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    markJobRunning(running);
    expect(cancelJob(running)).toBe(false); // não cancela job em execução
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd ~/projetos/openpcbot && npx vitest run src/db.test.ts`
Expected: FAIL — `enqueueVideoJob is not exported` (ou similar).

- [ ] **Step 3: Adicionar a tabela ao schema**

Em `src/db.ts`, dentro de `createSchema`, logo após o bloco `CREATE TABLE ... scheduled_tasks` / seu índice (~linha 22), adicione:

```sql
    CREATE TABLE IF NOT EXISTS video_jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      skill        TEXT NOT NULL,
      input        TEXT NOT NULL,
      opts         TEXT,
      status       TEXT NOT NULL DEFAULT 'queued',
      result_path  TEXT,
      error        TEXT,
      notify       TEXT NOT NULL DEFAULT 'sempre',
      send_video   INTEGER NOT NULL DEFAULT 0,
      chat_id      TEXT,
      created_at   INTEGER NOT NULL,
      started_at   INTEGER,
      finished_at  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status, created_at, id);
```

- [ ] **Step 4: Adicionar interface + funções**

Em `src/db.ts`, após `resumeScheduledTask` (~linha 373), adicione:

```ts
// ── Video jobs queue ──────────────────────────────────────────────

export interface VideoJob {
  id: number;
  skill: 'explicativo' | 'curso' | 'demo';
  input: string;
  opts: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  result_path: string | null;
  error: string | null;
  notify: 'sempre' | 'silencioso';
  send_video: number; // 0 | 1
  chat_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export function enqueueVideoJob(job: {
  skill: VideoJob['skill'];
  input: string;
  opts: string | null;
  notify: VideoJob['notify'];
  sendVideo: boolean;
  chatId: string | null;
}): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO video_jobs (skill, input, opts, status, notify, send_video, chat_id, created_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(job.skill, job.input, job.opts, job.notify, job.sendVideo ? 1 : 0, job.chatId, now);
  return Number(result.lastInsertRowid);
}

export function getNextQueuedJob(): VideoJob | null {
  return (db
    .prepare(`SELECT * FROM video_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`)
    .get() as VideoJob | undefined) ?? null;
}

export function getRunningJob(): VideoJob | null {
  return (db
    .prepare(`SELECT * FROM video_jobs WHERE status = 'running' ORDER BY started_at LIMIT 1`)
    .get() as VideoJob | undefined) ?? null;
}

export function markJobRunning(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE video_jobs SET status = 'running', started_at = ? WHERE id = ?`).run(now, id);
}

export function markJobDone(id: number, resultPath: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE video_jobs SET status = 'done', result_path = ?, finished_at = ? WHERE id = ?`)
    .run(resultPath, now, id);
}

export function markJobFailed(id: number, error: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE video_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
    .run(error.slice(0, 500), now, id);
}

/** Cancels a job only if it is still queued. Returns true if a row changed. */
export function cancelJob(id: number): boolean {
  const result = db.prepare(`UPDATE video_jobs SET status = 'canceled' WHERE id = ? AND status = 'queued'`).run(id);
  return result.changes > 0;
}

export function listJobs(limit = 50): VideoJob[] {
  return db
    .prepare(`SELECT * FROM video_jobs ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(limit) as VideoJob[];
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run src/db.test.ts`
Expected: PASS (todos os testes, incluindo `video_jobs queue`).

- [ ] **Step 6: Commit**

```bash
cd ~/projetos/openpcbot
git add src/db.ts src/db.test.ts
git commit -m "feat(video-queue): add video_jobs table and queue db functions"
```

---

## Task 2: Parser de comando, builder de prompt e extrator de resultado (funções puras)

**Files:**
- Create: `src/video-queue.ts`
- Test: `src/video-queue.test.ts`

- [ ] **Step 1: Escrever os testes que falham**

Crie `src/video-queue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseVideoCommand, buildVideoPrompt, extractResultPath } from './video-queue.js';

describe('parseVideoCommand', () => {
  it('parses skill + input', () => {
    const r = parseVideoCommand('explicativo Teorema de Bayes');
    expect(r).toEqual({ ok: true, skill: 'explicativo', input: 'Teorema de Bayes', vertical: false, send: false, silent: false });
  });

  it('maps aliases curso/demo', () => {
    expect((parseVideoCommand('curso https://x') as any).skill).toBe('curso');
    expect((parseVideoCommand('demo http://localhost:3000') as any).skill).toBe('demo');
  });

  it('extracts flags and strips them from input', () => {
    const r = parseVideoCommand('explicativo Bayes --vertical --enviar --silencioso') as any;
    expect(r.input).toBe('Bayes');
    expect(r.vertical).toBe(true);
    expect(r.send).toBe(true);
    expect(r.silent).toBe(true);
  });

  it('rejects unknown skill', () => {
    expect(parseVideoCommand('foo bar')).toEqual({ ok: false, error: expect.stringContaining('explicativo') });
  });

  it('rejects empty input', () => {
    expect(parseVideoCommand('explicativo   ')).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('buildVideoPrompt', () => {
  it('includes the skill name, input and the RESULT contract', () => {
    const p = buildVideoPrompt({ skill: 'explicativo', input: 'Bayes', vertical: false });
    expect(p).toContain('video-explicativo');
    expect(p).toContain('Bayes');
    expect(p).toContain('RESULT:');
    expect(p).toContain('sem pedir confirmação');
  });

  it('instructs GPU render with CPU fallback', () => {
    const p = buildVideoPrompt({ skill: 'explicativo', input: 'X', vertical: false });
    expect(p).toContain('--browser-gpu');
    expect(p).toContain('fallback');
  });

  it('asks for 9:16 when vertical', () => {
    expect(buildVideoPrompt({ skill: 'explicativo', input: 'X', vertical: true })).toContain('9:16');
  });

  it('uses the right skill slug for curso and demo', () => {
    expect(buildVideoPrompt({ skill: 'curso', input: 'http://x', vertical: false })).toContain('videos-cursos-inema');
    expect(buildVideoPrompt({ skill: 'demo', input: 'http://x', vertical: false })).toContain('video-demonstrativo');
  });
});

describe('extractResultPath', () => {
  it('returns the path from a RESULT line', () => {
    expect(extractResultPath('blah\nRESULT: /out/video.mp4\n')).toBe('/out/video.mp4');
  });
  it('returns the last RESULT line if several', () => {
    expect(extractResultPath('RESULT: /a.mp4\nRESULT: /b.mp4')).toBe('/b.mp4');
  });
  it('returns null when ERRO is present', () => {
    expect(extractResultPath('ERRO: render falhou')).toBeNull();
  });
  it('returns null when no RESULT line', () => {
    expect(extractResultPath('done, no marker')).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/video-queue.test.ts`
Expected: FAIL — `Cannot find module './video-queue.js'`.

- [ ] **Step 3: Implementar as funções puras**

Crie `src/video-queue.ts` com (worker vem no Task 3 — por ora só as puras):

```ts
import type { VideoJob } from './db.js';

const SKILL_SLUGS: Record<VideoJob['skill'], string> = {
  explicativo: 'video-explicativo',
  curso: 'videos-cursos-inema',
  demo: 'video-demonstrativo',
};

export type ParsedCommand =
  | { ok: true; skill: VideoJob['skill']; input: string; vertical: boolean; send: boolean; silent: boolean }
  | { ok: false; error: string };

/** Parse the text after "/video" (ctx.match). */
export function parseVideoCommand(raw: string): ParsedCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: false, error: 'Uso: /video <explicativo|curso|demo> <assunto/link> [--vertical] [--enviar] [--silencioso]' };

  const skillToken = tokens[0].toLowerCase();
  if (skillToken !== 'explicativo' && skillToken !== 'curso' && skillToken !== 'demo') {
    return { ok: false, error: `Skill inválida "${skillToken}". Use: explicativo, curso ou demo.` };
  }
  const skill = skillToken as VideoJob['skill'];

  const rest = tokens.slice(1);
  const vertical = rest.includes('--vertical');
  const send = rest.includes('--enviar');
  const silent = rest.includes('--silencioso');
  const input = rest.filter((t) => !t.startsWith('--')).join(' ').trim();

  if (!input) return { ok: false, error: 'Faltou o assunto/link depois da skill.' };
  return { ok: true, skill, input, vertical, send, silent };
}

/** Autonomous prompt for runAgent — runs the skill end-to-end and emits RESULT:. */
export function buildVideoPrompt(job: { skill: VideoJob['skill']; input: string; vertical: boolean }): string {
  const slug = SKILL_SLUGS[job.skill];
  const formato = job.vertical ? 'Formato 9:16 (vertical, Shorts/Reels).' : 'Use o formato padrão da skill.';
  return [
    `Use a skill \`${slug}\` para criar um vídeo a partir de: "${job.input}".`,
    formato,
    'Rode o fluxo COMPLETO de ponta a ponta de forma AUTÔNOMA, sem pedir confirmação de frames nem qualquer interação — assuma os defaults do usuário (PT-BR, dark premium âmbar, CTA INEMA.CLUB).',
    // Empurra encode+rasterização pra GPU (NVENC + Chrome GPU) — a CPU está saturada pelas sessões paralelas; a captura de frames já consome CPU suficiente.
    'No RENDER FINAL use a GPU: `npx hyperframes render --quality high --gpu --browser-gpu` com `timeout 900`. Se o .mp4 sair vazio (GPU falhar), faça FALLBACK pro CPU: `npx hyperframes render --quality high` (sem flags de GPU).',
    'Ao terminar com sucesso, sua ÚLTIMA linha deve ser exatamente: `RESULT: <caminho absoluto do .mp4 final>`.',
    'Se falhar, sua ÚLTIMA linha deve ser: `ERRO: <motivo curto>`.',
  ].join('\n');
}

/** Extracts the .mp4 path from the agent output (last `RESULT:` line). Null if absent/ERRO. */
export function extractResultPath(text: string | null): string | null {
  if (!text) return null;
  let found: string | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*RESULT:\s*(.+\.mp4)\s*$/i);
    if (m) found = m[1].trim();
  }
  return found;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/video-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video-queue.ts src/video-queue.test.ts
git commit -m "feat(video-queue): add command parser, prompt builder, result extractor"
```

---

## Task 3: Worker `processNextJob` + `initVideoQueue` (concorrência = 1)

**Files:**
- Modify: `src/video-queue.ts`
- Test: `src/video-queue.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Adicione a `src/video-queue.test.ts` (e ao import do topo: `processNextJob`). Importe também os helpers do db de teste:

```ts
import { _initTestDatabase, enqueueVideoJob, listJobs, markJobRunning, getRunningJob } from './db.js';

describe('processNextJob', () => {
  beforeEach(() => _initTestDatabase());

  const sent: string[] = [];
  const docs: Array<{ chatId: string; path: string }> = [];
  const deps = (agentText: string | null) => ({
    runAgent: async () => ({ text: agentText }),
    sendMessage: async (chatId: string, text: string) => { sent.push(text); },
    sendDocument: async (chatId: string, path: string) => { docs.push({ chatId, path }); },
  });

  beforeEach(() => { sent.length = 0; docs.length = 0; });

  it('does nothing when a job is already running', async () => {
    const id = enqueueVideoJob({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    markJobRunning(id); // ocupa a vaga
    const id2 = enqueueVideoJob({ skill: 'explicativo', input: 'Y', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    await processNextJob(deps('RESULT: /a.mp4'));
    expect(listJobs().find((j) => j.id === id2)!.status).toBe('queued'); // não começou
  });

  it('runs the next job and marks it done on RESULT', async () => {
    const id = enqueueVideoJob({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '99' });
    await processNextJob(deps('trabalho...\nRESULT: /out/x.mp4'));
    const job = listJobs().find((j) => j.id === id)!;
    expect(job.status).toBe('done');
    expect(job.result_path).toBe('/out/x.mp4');
    expect(sent.some((m) => m.includes('pronto'))).toBe(true);
    expect(docs.length).toBe(0); // sendVideo=false → não anexa
  });

  it('attaches the file when send_video is set', async () => {
    enqueueVideoJob({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: true, chatId: '99' });
    await processNextJob(deps('RESULT: /out/x.mp4'));
    expect(docs).toEqual([{ chatId: '99', path: '/out/x.mp4' }]);
  });

  it('marks failed when no RESULT and keeps queue free', async () => {
    const id = enqueueVideoJob({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    await processNextJob(deps('ERRO: render quebrou'));
    expect(listJobs().find((j) => j.id === id)!.status).toBe('failed');
    expect(getRunningJob()).toBeNull();
  });

  it('does not notify when notify is silencioso', async () => {
    enqueueVideoJob({ skill: 'explicativo', input: 'X', opts: null, notify: 'silencioso', sendVideo: false, chatId: '1' });
    await processNextJob(deps('RESULT: /out/x.mp4'));
    expect(sent.length).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/video-queue.test.ts`
Expected: FAIL — `processNextJob is not exported`.

- [ ] **Step 3: Implementar o worker**

Adicione ao fim de `src/video-queue.ts`:

```ts
import {
  getNextQueuedJob, getRunningJob, markJobRunning, markJobDone, markJobFailed, type VideoJob,
} from './db.js';

export interface QueueDeps {
  runAgent: (prompt: string) => Promise<{ text: string | null }>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  sendDocument: (chatId: string, path: string) => Promise<void>;
}

const SKILL_LABEL: Record<VideoJob['skill'], string> = {
  explicativo: 'explicativo', curso: 'curso INEMA', demo: 'demonstrativo',
};

/** Processes at most one job. No-op if a job is already running (concorrência = 1). */
export async function processNextJob(deps: QueueDeps): Promise<void> {
  if (getRunningJob()) return;
  const job = getNextQueuedJob();
  if (!job) return;

  markJobRunning(job.id);
  const notify = job.notify === 'sempre' && job.chat_id;
  if (notify) await deps.sendMessage(job.chat_id!, `▶️ Iniciando vídeo #${job.id} (${SKILL_LABEL[job.skill]})`);

  try {
    const opts = job.opts ? JSON.parse(job.opts) as { vertical?: boolean } : {};
    const prompt = buildVideoPrompt({ skill: job.skill, input: job.input, vertical: !!opts.vertical });
    const result = await deps.runAgent(prompt);
    const path = extractResultPath(result.text);

    if (!path) {
      const reason = result.text?.split('\n').reverse().find((l) => /ERRO:/i.test(l))?.trim() || 'sem RESULT no output do agente';
      markJobFailed(job.id, reason);
      if (notify) await deps.sendMessage(job.chat_id!, `❌ Vídeo #${job.id} falhou: ${reason}`);
      return;
    }

    markJobDone(job.id, path);
    if (notify) {
      await deps.sendMessage(job.chat_id!, `✅ Vídeo #${job.id} pronto — ${SKILL_LABEL[job.skill]}\n${path}`);
      if (job.send_video) {
        try { await deps.sendDocument(job.chat_id!, path); }
        catch (e) { await deps.sendMessage(job.chat_id!, `(não consegui anexar o arquivo: ${(e as Error).message})`); }
      }
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    markJobFailed(job.id, msg);
    if (notify) await deps.sendMessage(job.chat_id!, `❌ Vídeo #${job.id} falhou: ${msg}`);
  }
}

let queueTimer: NodeJS.Timeout | undefined;

/** Wires the worker to a 15s tick. Call once at boot. */
export function initVideoQueue(deps: QueueDeps): void {
  if (queueTimer) clearInterval(queueTimer);
  queueTimer = setInterval(() => { void processNextJob(deps); }, 15_000);
}
```

> Nota: o `import` de `buildVideoPrompt`/`extractResultPath` é local ao módulo (mesmo arquivo), então não precisa importá-los — só os símbolos do `./db.js`. Mantenha o import de `./db.js` único no topo (mescle com o `import type { VideoJob }` já existente do Task 2, virando um import normal).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/video-queue.test.ts`
Expected: PASS (puras + `processNextJob`).

- [ ] **Step 5: Commit**

```bash
git add src/video-queue.ts src/video-queue.test.ts
git commit -m "feat(video-queue): add processNextJob worker with concurrency=1 and initVideoQueue tick"
```

---

## Task 4: Comandos Telegram `/video` e `/fila`

**Files:**
- Modify: `src/video-queue.ts` (helper puro `formatQueueList`)
- Modify: `src/video-queue.test.ts`
- Modify: `src/bot.ts` (handlers + `setMyCommands`)

- [ ] **Step 1: Teste que falha para `formatQueueList`**

Adicione a `src/video-queue.test.ts` (import: `formatQueueList`):

```ts
import type { VideoJob } from './db.js';
const j = (over: Partial<VideoJob>): VideoJob => ({
  id: 1, skill: 'explicativo', input: 'X', opts: null, status: 'queued',
  result_path: null, error: null, notify: 'sempre', send_video: 0,
  chat_id: '1', created_at: 0, started_at: null, finished_at: null, ...over,
});

describe('formatQueueList', () => {
  it('says empty when no active jobs', () => {
    expect(formatQueueList([])).toContain('vazia');
  });
  it('lists running first then queued', () => {
    const out = formatQueueList([
      j({ id: 2, status: 'queued', input: 'B' }),
      j({ id: 1, status: 'running', input: 'A' }),
    ]);
    expect(out.indexOf('#1')).toBeLessThan(out.indexOf('#2'));
    expect(out).toContain('▶️');
  });
  it('ignores done/failed/canceled', () => {
    expect(formatQueueList([j({ id: 9, status: 'done' })])).toContain('vazia');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/video-queue.test.ts`
Expected: FAIL — `formatQueueList is not exported`.

- [ ] **Step 3: Implementar `formatQueueList`**

Adicione a `src/video-queue.ts`:

```ts
/** Renders the active queue (running + queued) for the /fila command. */
export function formatQueueList(jobs: VideoJob[]): string {
  const running = jobs.filter((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  const active = [...running, ...queued];
  if (active.length === 0) return '📭 Fila vazia.';
  const line = (jb: VideoJob) => {
    const icon = jb.status === 'running' ? '▶️' : '⏳';
    const inp = jb.input.length > 40 ? jb.input.slice(0, 40) + '…' : jb.input;
    return `${icon} #${jb.id} ${jb.skill} — ${inp}`;
  };
  return ['📋 Fila de vídeos:', ...active.map(line)].join('\n');
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/video-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Registrar os comandos no bot**

Em `src/bot.ts`:

(a) No topo, adicione aos imports de `./db.js` (ou ao bloco de import existente): `enqueueVideoJob, listJobs, cancelJob`. E importe do worker:

```ts
import { parseVideoCommand, formatQueueList } from './video-queue.js';
```

(b) Em `setMyCommands([...])` (~linha 792), adicione duas entradas antes do `]`:

```ts
    { command: 'video', description: 'Enfileira um vídeo (explicativo|curso|demo)' },
    { command: 'fila', description: 'Mostra a fila de vídeos' },
```

(c) Junto aos outros `bot.command(...)` (ex: após o handler `/handoff`, ~linha 1404), adicione:

```ts
  bot.command('video', (ctx) => {
    if (!isAuthorised(ctx.chat!.id)) return;
    const parsed = parseVideoCommand(ctx.match ?? '');
    if (!parsed.ok) return ctx.reply(parsed.error);
    const opts = parsed.vertical ? JSON.stringify({ vertical: true }) : null;
    const id = enqueueVideoJob({
      skill: parsed.skill, input: parsed.input, opts,
      notify: parsed.silent ? 'silencioso' : 'sempre',
      sendVideo: parsed.send, chatId: ctx.chat!.id.toString(),
    });
    return ctx.reply(`📥 Vídeo enfileirado #${id} (${parsed.skill})${parsed.send ? ' — vou te enviar o arquivo ao terminar' : ''}.`);
  });

  bot.command('fila', (ctx) => {
    if (!isAuthorised(ctx.chat!.id)) return;
    const arg = (ctx.match ?? '').trim();
    const cancelMatch = arg.match(/^cancelar\s+(\d+)$/i);
    if (cancelMatch) {
      const ok = cancelJob(Number(cancelMatch[1]));
      return ctx.reply(ok ? `🗑️ Job #${cancelMatch[1]} cancelado.` : `Não consegui cancelar #${cancelMatch[1]} (já rodando ou não existe).`);
    }
    return ctx.reply(formatQueueList(listJobs()));
  });
```

- [ ] **Step 6: Verificar build + testes**

Run: `npx tsc --noEmit && npx vitest run src/video-queue.test.ts`
Expected: sem erros de tipo; testes PASS.

- [ ] **Step 7: Commit**

```bash
git add src/bot.ts src/video-queue.ts src/video-queue.test.ts
git commit -m "feat(video-queue): add /video and /fila Telegram commands"
```

---

## Task 5: Painel — rotas + página `/videos`

**Files:**
- Create: `src/video-dashboard-html.ts`
- Modify: `src/dashboard.ts`

- [ ] **Step 1: Criar a página HTML autocontida**

Crie `src/video-dashboard-html.ts`:

```ts
/** Self-contained queue panel. Polls /api/video-jobs and renders a table. */
export function getVideoDashboardHtml(token: string): string {
  return `<!DOCTYPE html>
<html lang="pt-br"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fila de Vídeos — OpenPCBot</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0D1321; color:#F0EBD8; margin:0; padding:24px; }
  h1 { color:#FFC300; font-size:20px; }
  table { width:100%; border-collapse:collapse; margin-top:16px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid #3E5C76; font-size:14px; }
  th { color:#748CAB; font-weight:600; }
  .badge { padding:2px 8px; border-radius:10px; font-size:12px; }
  .queued{background:#3E5C76}.running{background:#FFC300;color:#0D1321}.done{background:#2EC4B6;color:#0D1321}
  .failed{background:#b00020}.canceled{background:#555}
  button { background:#1D2D44; color:#F0EBD8; border:1px solid #3E5C76; border-radius:6px; padding:4px 10px; cursor:pointer; }
  a { color:#FFC300; }
</style></head><body>
<h1>📋 Fila de Vídeos</h1>
<table><thead><tr><th>#</th><th>Skill</th><th>Entrada</th><th>Status</th><th>Resultado</th><th></th></tr></thead>
<tbody id="rows"><tr><td colspan="6">carregando…</td></tr></tbody></table>
<script>
const TOKEN = ${JSON.stringify(token)};
async function load() {
  const r = await fetch('/api/video-jobs?token=' + encodeURIComponent(TOKEN));
  const { jobs } = await r.json();
  document.getElementById('rows').innerHTML = jobs.map(function(j){
    var inp = (j.input||'').length > 50 ? j.input.slice(0,50)+'…' : (j.input||'');
    var res = j.result_path ? '<a href="#">'+j.result_path+'</a>' : (j.error ? ('⚠ '+j.error) : '—');
    var btn = j.status === 'queued' ? '<button onclick="cancelJob('+j.id+')">cancelar</button>' : '';
    return '<tr><td>#'+j.id+'</td><td>'+j.skill+'</td><td>'+inp+'</td>'
      + '<td><span class="badge '+j.status+'">'+j.status+'</span></td><td>'+res+'</td><td>'+btn+'</td></tr>';
  }).join('') || '<tr><td colspan="6">Sem jobs ainda.</td></tr>';
}
async function cancelJob(id){
  await fetch('/api/video-jobs/'+id+'/cancel?token='+encodeURIComponent(TOKEN), {method:'POST'});
  load();
}
load(); setInterval(load, 5000);
</script></body></html>`;
}
```

- [ ] **Step 2: Adicionar as rotas no dashboard**

Em `src/dashboard.ts`:

(a) Imports: adicione a `./db.js`: `listJobs, cancelJob`. E:

```ts
import { getVideoDashboardHtml } from './video-dashboard-html.js';
```

(b) Junto às outras rotas (após o bloco de `/api/tasks`, ~linha 98), adicione:

```ts
  // Video queue
  app.get('/videos', (c) => c.html(getVideoDashboardHtml(DASHBOARD_TOKEN!)));

  app.get('/api/video-jobs', (c) => c.json({ jobs: listJobs() }));

  app.post('/api/video-jobs/:id/cancel', (c) => {
    const ok = cancelJob(Number(c.req.param('id')));
    return c.json({ ok });
  });
```

- [ ] **Step 3: Verificar build**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 4: Smoke test manual da rota**

Run (com o bot rodando e `DASHBOARD_TOKEN` setado):
```bash
curl -s "http://localhost:3141/api/video-jobs?token=$DASHBOARD_TOKEN" | head
```
Expected: JSON `{"jobs":[...]}` (lista, possivelmente vazia). A página fica em `http://localhost:3141/videos?token=...`.

- [ ] **Step 5: Commit**

```bash
git add src/video-dashboard-html.ts src/dashboard.ts
git commit -m "feat(video-queue): add /videos dashboard page and queue API routes"
```

---

## Task 6: Wiring no boot (`index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Importar e inicializar o worker**

Em `src/index.ts`:

(a) Adicione o import:

```ts
import { initVideoQueue } from './video-queue.js';
import { InputFile } from 'grammy';
```

(b) Logo após o bloco `if (ALLOWED_CHAT_ID) { initScheduler(...) }` (~linha 104), adicione:

```ts
  // Video queue worker — concorrência = 1, dispara runAgent por job
  initVideoQueue({
    runAgent: (prompt) => runAgent(prompt, undefined, () => {}).then((r) => ({ text: r.text })),
    sendMessage: (chatId, text) =>
      bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }).then(() => {}).catch((err) => logger.error({ err }, 'Video queue failed to send message')),
    sendDocument: (chatId, filePath) =>
      bot.api.sendDocument(chatId, new InputFile(filePath)).then(() => {}).catch((err) => logger.error({ err }, 'Video queue failed to send document')),
  });
  logger.info('Video queue worker started (concorrência = 1)');
```

(c) Adicione `runAgent` ao import de `./agent.js` (crie a linha se não existir):

```ts
import { runAgent } from './agent.js';
```

- [ ] **Step 2: Verificar build**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 3: Rodar a suíte completa**

Run: `npx vitest run`
Expected: PASS (db + video-queue + suíte existente).

- [ ] **Step 4: Smoke test end-to-end (manual)**

1. Reinicie o bot: `cd ~/projetos/openpcbot && ./stop.sh && ./start.sh` (ou `systemctl --user restart` conforme o serviço).
2. No Telegram: `/video explicativo Teste de fila --silencioso` → deve responder `📥 Vídeo enfileirado #N`.
3. `/fila` → deve listar `▶️`/`⏳ #N`.
4. Abra `http://localhost:3141/videos?token=$DASHBOARD_TOKEN` → job aparece, status muda para `running` em até 15s.
5. Aguarde concluir → status `done` + `result_path` preenchido (sem `--silencioso`, chega a notificação no Telegram).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(video-queue): start the video queue worker at boot"
```

---

## Task 7: Documentar no README do mkivideos + atualizar GitHub

**Files:**
- Modify: `~/projetos/mkivideos/README.md`

- [ ] **Step 1: Reescrever o README**

Substitua `~/projetos/mkivideos/README.md` por:

```markdown
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
```

- [ ] **Step 2: Commit + push**

```bash
cd ~/projetos/mkivideos
git add README.md docs/
git commit -m "docs: documentar fila de vídeos (spec, plano e README)"
git push origin main
```

Expected: push aceito em `git@github.com:inematds/mkivideos.git`.

---

## Self-Review (preenchido pelo autor do plano)

- **Cobertura do spec:** tabela `video_jobs` (T1) ✓ · worker 1-por-vez/FIFO (T3) ✓ · prompt autônomo + `RESULT:` (T2/T3) ✓ · comandos `/video` e `/fila` + flags (T4) ✓ · painel (T5) ✓ · notificação/entrega defaults (T3) ✓ · roteamento determinístico explicado no README (T7) ✓ · backlog v2 registrado (README) ✓.
- **Placeholders:** nenhum — todo passo tem código/comando real.
- **Consistência de tipos:** `VideoJob`, `enqueueVideoJob({...sendVideo})`, `processNextJob(QueueDeps)`, `parseVideoCommand`, `buildVideoPrompt`, `extractResultPath`, `formatQueueList` usados com as mesmas assinaturas em todas as tasks. `send_video` é `number` (0/1) no banco; a flag de entrada é `sendVideo: boolean`.
