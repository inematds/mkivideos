// Lógica testável do CLI standalone (sem efeitos colaterais no import).
// O executável (cli.ts) só liga argv → estas funções + IO.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import { parseVideoCommand, formatQueueStatus } from './queue.js';
import type { QueueDeps, QueueStore } from './types.js';

const run = promisify(execFile);

/** `mkivideos add <skill> <input...> [--flags]` → enfileira. Retorna a mensagem. */
export function cmdAdd(store: QueueStore, raw: string): string {
  const parsed = parseVideoCommand(raw);
  if (!parsed.ok) return `erro: ${parsed.error}`;
  const o: { vertical?: boolean; dest?: string } = {};
  if (parsed.vertical) o.vertical = true;
  if (parsed.dest) o.dest = parsed.dest;
  const opts = Object.keys(o).length ? JSON.stringify(o) : null;
  const id = store.enqueue({
    skill: parsed.skill, input: parsed.input, opts,
    notify: parsed.silent ? 'silencioso' : 'sempre',
    sendVideo: parsed.send, chatId: 'cli',
    course: parsed.course ?? null, module: parsed.module ?? null,
  });
  return `enfileirado #${id} (${parsed.skill})${parsed.course ? ` [${parsed.course}${parsed.module ? '/' + parsed.module : ''}]` : ''}${parsed.dest ? ` → ${parsed.dest}` : ''}`;
}

/** `mkivideos plan <url|assunto>` → enfileira um job PLANNER (decompõe em 1 job por vídeo). */
export function cmdPlan(store: QueueStore, raw: string): string {
  const input = raw.trim();
  if (!input) return 'erro: uso: mkivideos plan <url-do-curso ou assunto>';
  const id = store.enqueue({
    skill: 'curso', input, opts: null, notify: 'sempre', sendVideo: false, chatId: 'cli', kind: 'plan',
  });
  return `planner enfileirado #${id} — vai classificar, mapear e enfileirar 1 job de vídeo por peça`;
}

/** `mkivideos fila` → status rico: resumo + por curso (X/Y) + processando × espera. */
export function cmdFila(store: QueueStore): string {
  return formatQueueStatus(store.list(100000));
}

/** `mkivideos cancelar <id>` → cancela um job que ainda espera. */
export function cmdCancel(store: QueueStore, id: number): string {
  if (!Number.isInteger(id)) return 'erro: id inválido';
  return store.cancel(id) ? `cancelado #${id}` : `não cancelei #${id} (já rodando ou não existe)`;
}

const fmtDur = (s: number | null): string => {
  if (s == null) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${m}m` : (m ? `${m}m` : `${Math.round(s)}s`);
};

/** `mkivideos stats` → resumo da fila (status, por curso X/Y, throughput, ETA). */
export function cmdStats(store: QueueStore): string {
  const s = store.stats();
  const b = s.byStatus;
  const lines = [
    `📊 mkivideos — fila`,
    `  rodando ${b.running} · na fila ${b.queued} · prontos ${b.done} · falhas ${b.failed} · cancelados ${b.canceled}`,
    `  médio/vídeo ${fmtDur(s.avgRenderSeconds)} · throughput ${s.throughputPerHour ?? '—'}/h · ETA fila (1/vez) ${fmtDur(s.etaSeconds)}`,
  ];
  if (s.courses.length) {
    lines.push('  por curso:');
    for (const c of s.courses) {
      lines.push(`    ${c.course}: ${c.done}/${c.total} feito` +
        (c.running ? ` · ${c.running} rodando` : '') + (c.queued ? ` · ${c.queued} na fila` : '') + (c.failed ? ` · ${c.failed} falha` : ''));
    }
  }
  return lines.join('\n');
}

/** `mkivideos status <id>` → detalhe de um job. */
export function cmdStatus(store: QueueStore, id: number): string {
  if (!Number.isInteger(id)) return 'erro: id inválido';
  const j = store.list(10000).find((x) => x.id === id);
  if (!j) return `#${id} não existe`;
  const parts = [`#${j.id} [${j.status}] ${j.skill}`];
  if (j.course) parts.push(`curso=${j.course}`);
  if (j.module) parts.push(`módulo=${j.module}`);
  parts.push(`entrada=${j.input}`);
  if (j.render_target) parts.push(`alvo=${j.render_target}`);
  if (j.result_path) parts.push(`resultado=${j.result_path}`);
  if (j.error) parts.push(`erro=${j.error}`);
  return parts.join(' · ');
}

/** `mkivideos get <id>` → só o caminho do .mp4 (vazio se não pronto). */
export function cmdGet(store: QueueStore, id: number): string {
  const j = store.list(10000).find((x) => x.id === id);
  return j?.result_path ?? '';
}

/** Pega o valor de uma flag `--nome valor` num array de tokens. */
export function optVal(tokens: string[], name: string): string | undefined {
  const i = tokens.indexOf(name);
  return i >= 0 ? tokens[i + 1] : undefined;
}

/** Espera um arquivo existir e estabilizar (tamanho parado), com timeout. Pro modo background+poll. */
export async function waitForFile(
  p: string,
  opts: { timeoutMs?: number; stableMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 2 * 60 * 60 * 1000; // 2h
  const stableMs = opts.stableMs ?? 12_000;
  const pollMs = opts.pollMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    let size = -1;
    try { size = fs.statSync(p).size; } catch { size = -1; }
    if (size > 0) {
      if (size === lastSize) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return true;
      } else {
        lastSize = size; stableSince = 0;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/** Deps default pro modo standalone: runAgent via `claude -p`, notifica no console, move via fs. */
export function makeDefaultDeps(): QueueDeps {
  return {
    runAgent: async (prompt) => {
      const { stdout } = await run('claude', ['-p', prompt], { maxBuffer: 100 * 1024 * 1024 });
      return { text: stdout };
    },
    sendMessage: async (_chatId, text) => { console.log(text); },
    sendDocument: async (_chatId, p) => { console.log('📎', p); },
    moveVideo: async (src, dest) => {
      const isFile = dest.toLowerCase().endsWith('.mp4');
      const targetDir = isFile ? path.dirname(dest) : dest;
      fs.mkdirSync(targetDir, { recursive: true });
      const target = isFile ? dest : path.join(dest, path.basename(src));
      try { fs.renameSync(src, target); }
      catch { fs.copyFileSync(src, target); fs.unlinkSync(src); }
      return target;
    },
    waitForFile,
  };
}

export function usage(): string {
  return [
    'mkivideos — fila de vídeos (standalone)',
    '',
    'Uso:',
    '  mkivideos add <explicativo|curso|demo> <assunto/link> [--vertical] [--enviar] [--silencioso] [--pasta <caminho>] [--curso <nome>] [--modulo <label>]',
    '  mkivideos plan <url-do-curso | assunto>     # PLANNER: mapeia e enfileira 1 job de vídeo por peça (curso → módulos)',
    '  mkivideos fila',
    '  mkivideos stats                            # status + por curso (X/Y) + ETA',
    '  mkivideos status <id>                      # detalhe de um job',
    '  mkivideos get <id>                         # só o caminho do .mp4 (vazio se não pronto)',
    '  mkivideos cancelar <id>',
    '  mkivideos run [--port <n>] [--token <t>] [--concurrency <n>] [--render-dir <dir>]   # daemon (background+poll) + dashboard',
    '',
    'Env:',
    '  MKIVIDEOS_DB           caminho do banco SQLite (default: ./mkivideos.db)',
    '  MKIVIDEOS_CONCURRENCY  jobs em paralelo no daemon (default: 1)',
    '  MKIVIDEOS_RENDER_DIR   pasta-base dos renders (default: renders)',
    '',
    'Requer: `claude` CLI logado + as skills de vídeo + stack de render (HyperFrames/FFmpeg/Chrome/TTS).',
  ].join('\n');
}
