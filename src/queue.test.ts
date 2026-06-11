import { describe, it, expect, beforeEach } from 'vitest';

import {
  parseVideoCommand,
  buildVideoPrompt,
  extractResultPath,
  formatQueueList,
  formatQueueStatus,
  mkiHelpText,
  processNextJob,
} from './queue.js';
import { SqliteQueueStore } from './sqlite-store.js';
import type { QueueDeps, VideoJob } from './types.js';

describe('parseVideoCommand', () => {
  it('parses skill + input', () => {
    expect(parseVideoCommand('explicativo Teorema de Bayes')).toEqual({
      ok: true, skill: 'explicativo', input: 'Teorema de Bayes', vertical: false, send: false, silent: false, dest: undefined,
    });
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

  it('parses --pasta <caminho> and strips it from input', () => {
    const r = parseVideoCommand('explicativo Bayes --pasta /home/nei/videos --vertical') as any;
    expect(r.input).toBe('Bayes');
    expect(r.dest).toBe('/home/nei/videos');
    expect(r.vertical).toBe(true);
  });

  it('dest is undefined when --pasta absent', () => {
    expect((parseVideoCommand('explicativo Bayes') as any).dest).toBeUndefined();
  });

  it('parses --curso e --modulo e tira do input', () => {
    const r = parseVideoCommand('curso http://x --curso skills-craft --modulo t1m1-o-que-e --silencioso') as any;
    expect(r.input).toBe('http://x');
    expect(r.course).toBe('skills-craft');
    expect(r.module).toBe('t1m1-o-que-e');
    expect(r.silent).toBe(true);
  });

  it('--pasta no fim sem valor não quebra', () => {
    expect((parseVideoCommand('explicativo Bayes --pasta') as any).dest).toBeUndefined();
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

const j = (over: Partial<VideoJob>): VideoJob => ({
  id: 1, skill: 'explicativo', input: 'X', kind: 'video', parent_id: null, opts: null, status: 'queued',
  result_path: null, error: null, notify: 'sempre', send_video: 0,
  chat_id: '1', course: null, module: null, render_target: null,
  created_at: 0, started_at: null, finished_at: null, ...over,
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

describe('formatQueueStatus (rico)', () => {
  it('agrupa por curso com X/Y e separa processando × espera', () => {
    const out = formatQueueStatus([
      j({ id: 1, status: 'done', course: 'make', module: 't1m1' }),
      j({ id: 2, status: 'running', course: 'make', module: 't1m2' }),
      j({ id: 3, status: 'queued', course: 'make', module: 't1m3' }),
      j({ id: 4, status: 'done', course: 'n8n', module: 'landing' }),
    ]);
    expect(out).toContain('Por curso');
    expect(out).toContain('make: 1/3 feito');
    expect(out).toContain('n8n: 1/1 feito');
    expect(out).toContain('▶️ Processando agora');
    expect(out).toContain('#2');           // running
    expect(out).toContain('Na espera (1)');
    expect(out).toContain('#3');           // queued
    expect(out.indexOf('#2')).toBeLessThan(out.indexOf('Na espera')); // running antes da espera
  });
  it('fila vazia', () => {
    expect(formatQueueStatus([])).toContain('vazia');
  });
});

describe('mkiHelpText', () => {
  it('documents the 3 skills, the flags and the fila subcommand', () => {
    const h = mkiHelpText();
    for (const s of ['explicativo', 'curso', 'demo', '--vertical', '--enviar', '--silencioso', '--pasta', 'fila']) {
      expect(h).toContain(s);
    }
  });
});

describe('processNextJob', () => {
  let store: SqliteQueueStore;
  const sent: string[] = [];
  const docs: Array<{ chatId: string; path: string }> = [];
  const moved: Array<{ src: string; dest: string }> = [];
  const deps = (agentText: string | null): QueueDeps => ({
    runAgent: async () => ({ text: agentText }),
    sendMessage: async (_chatId, text) => { sent.push(text); },
    sendDocument: async (chatId, path) => { docs.push({ chatId, path }); },
    moveVideo: async (src, dest) => { moved.push({ src, dest }); return dest + '/moved.mp4'; },
  });

  beforeEach(() => {
    store = new SqliteQueueStore(':memory:');
    sent.length = 0; docs.length = 0; moved.length = 0;
  });

  it('does nothing when a job is already running', async () => {
    const id = store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    store.markRunning(id);
    const id2 = store.enqueue({ skill: 'explicativo', input: 'Y', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('RESULT: /a.mp4'));
    expect(store.list().find((x) => x.id === id2)!.status).toBe('queued');
  });

  it('runs the next job and marks it done on RESULT', async () => {
    const id = store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '99' });
    await processNextJob(store, deps('trabalho...\nRESULT: /out/x.mp4'));
    const job = store.list().find((x) => x.id === id)!;
    expect(job.status).toBe('done');
    expect(job.result_path).toBe('/out/x.mp4');
    expect(sent.some((m) => m.includes('pronto'))).toBe(true);
    expect(docs.length).toBe(0);
  });

  it('attaches the file when send_video is set', async () => {
    store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: true, chatId: '99' });
    await processNextJob(store, deps('RESULT: /out/x.mp4'));
    expect(docs).toEqual([{ chatId: '99', path: '/out/x.mp4' }]);
  });

  it('sends the file even when notify is silencioso (send_video set)', async () => {
    store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'silencioso', sendVideo: true, chatId: '7' });
    await processNextJob(store, deps('RESULT: /out/x.mp4'));
    expect(sent.length).toBe(0);
    expect(docs).toEqual([{ chatId: '7', path: '/out/x.mp4' }]);
  });

  it('moves the video to opts.dest and reports/sends the new path', async () => {
    store.enqueue({ skill: 'explicativo', input: 'X', opts: JSON.stringify({ dest: '/dst' }), notify: 'sempre', sendVideo: true, chatId: '5' });
    await processNextJob(store, deps('RESULT: /out/x.mp4'));
    expect(moved).toEqual([{ src: '/out/x.mp4', dest: '/dst' }]);
    const job = store.list()[0];
    expect(job.result_path).toBe('/dst/moved.mp4');
    expect(docs).toEqual([{ chatId: '5', path: '/dst/moved.mp4' }]);
    expect(sent.some((m) => m.includes('/dst/moved.mp4'))).toBe(true);
  });

  it('marks failed when no RESULT and keeps queue free', async () => {
    const id = store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('ERRO: render quebrou'));
    expect(store.list().find((x) => x.id === id)!.status).toBe('failed');
    expect(store.getRunning()).toBeNull();
  });

  it('ignores malformed opts and still completes', async () => {
    const id = store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    // injeta opts corrompido direto no banco
    store.raw.prepare(`UPDATE video_jobs SET opts = '{' WHERE id = ?`).run(id);
    await processNextJob(store, deps('RESULT: /out/ok.mp4'));
    expect(store.list().find((x) => x.id === id)!.status).toBe('done');
  });

  it('does not notify when notify is silencioso', async () => {
    store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'silencioso', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('RESULT: /out/x.mp4'));
    expect(sent.length).toBe(0);
  });
});
