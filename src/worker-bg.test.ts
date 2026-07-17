import { describe, it, expect, beforeEach } from 'vitest';

import {
  buildVideoPrompt,
  buildInemavoxPrompt,
  extractRenderTarget,
  buildOutputName,
  slugify,
  processNextJob,
  buildPlannerPrompt,
  extractEnqueues,
} from './queue.js';
import { SqliteQueueStore } from './sqlite-store.js';
import type { QueueDeps } from './types.js';

describe('slugify / buildOutputName (P4)', () => {
  it('slugifica removendo acento, minúsculo, hífens', () => {
    expect(slugify('O que é uma Agent Skill!')).toBe('o-que-e-uma-agent-skill');
  });
  it('curso + módulo + formato 16:9 → <curso>-<modulo>-16.mp4', () => {
    expect(buildOutputName({ id: 1, course: 'skills-craft', module: 't1m1-o-que-e-uma-skill', opts: null }))
      .toBe('skills-craft-t1m1-o-que-e-uma-skill-16.mp4');
  });
  it('vertical → sufixo -9', () => {
    expect(buildOutputName({ id: 1, course: 'skills-craft', module: 't1m1', opts: JSON.stringify({ vertical: true }) }))
      .toBe('skills-craft-t1m1-9.mp4');
  });
  it('sem módulo → <curso>-<fmt>; sem curso → mkivideo-<id>-<fmt>', () => {
    expect(buildOutputName({ id: 5, course: 'skills-craft', module: null, opts: null })).toBe('skills-craft-16.mp4');
    expect(buildOutputName({ id: 7, course: null, module: null, opts: null })).toBe('mkivideo-7-16.mp4');
  });
});

describe('extractRenderTarget', () => {
  it('pega o alvo de uma linha RENDER:', () => {
    expect(extractRenderTarget('setup ok\nRENDER: /out/v.mp4')).toBe('/out/v.mp4');
  });
  it('pega o último RENDER se houver vários', () => {
    expect(extractRenderTarget('RENDER: /a.mp4\nRENDER: /b.mp4')).toBe('/b.mp4');
  });
  it('null quando ausente', () => {
    expect(extractRenderTarget('RESULT: /a.mp4')).toBeNull();
  });
});

describe('buildVideoPrompt (modo background+poll)', () => {
  it('com outPath: instrui render destacado, emite RENDER: e não espera', () => {
    const p = buildVideoPrompt({ skill: 'curso', input: 'http://x', vertical: false }, '/r/skills-craft-t1m1-16.mp4');
    expect(p).toContain('RENDER: /r/skills-craft-t1m1-16.mp4');
    expect(p).toContain('/r/skills-craft-t1m1-16.mp4');
    expect(p.toLowerCase()).toContain('background');
    expect(p).toContain('NÃO espere');
    expect(p).not.toContain('RESULT:');
  });

  it('com outPath: instrui a convenção `|| touch <alvo>.err` pro marcador de falha', () => {
    const p = buildVideoPrompt({ skill: 'curso', input: 'http://x', vertical: false }, '/r/v.mp4');
    expect(p).toContain('|| touch "/r/v.mp4.err"');
    expect(p).toContain('/r/v.mp4.log');
  });
});

describe('buildInemavoxPrompt (modo background+poll)', () => {
  it('com outPath: instrui a convenção `|| touch <alvo>.err` pro marcador de falha', () => {
    const p = buildInemavoxPrompt({ skill: 'transcrever', input: 'https://x' }, '/r/mkivideo-1-16.txt');
    expect(p).toContain('|| touch "/r/mkivideo-1-16.txt.err"');
    expect(p).toContain('/r/mkivideo-1-16.txt.log');
    expect(p).toContain('RENDER: /r/mkivideo-1-16.txt');
  });
});

describe('processNextJob — background+poll', () => {
  let store: SqliteQueueStore;
  const sent: string[] = [];
  const moved: Array<{ src: string; dest: string }> = [];
  const waited: Array<{ path: string }> = [];

  const deps = (agentText: string | null, fileReady: boolean): QueueDeps => ({
    runAgent: async () => ({ text: agentText }),
    sendMessage: async (_c, t) => { sent.push(t); },
    sendDocument: async () => { /* noop */ },
    moveVideo: async (src, dest) => { moved.push({ src, dest }); return dest + '/moved.mp4'; },
    waitForFile: async (p) => { waited.push({ path: p }); return { ok: fileReady, failedMarker: false }; },
  });

  const opts = { background: true, renderDir: 'renders' };

  beforeEach(() => { store = new SqliteQueueStore(':memory:'); sent.length = 0; moved.length = 0; waited.length = 0; });

  it('dispara, vigia o arquivo e marca done quando pronto', async () => {
    const id = store.enqueue({ skill: 'curso', input: 'http://x', opts: null, notify: 'sempre', sendVideo: false, chatId: '1', course: 'skills-craft', module: 't1m1' });
    await processNextJob(store, deps('setup...\nRENDER: /renders/skills-craft-t1m1-16.mp4', true), opts);
    const job = store.list().find((x) => x.id === id)!;
    expect(job.status).toBe('done');
    expect(job.result_path).toBe('/renders/skills-craft-t1m1-16.mp4');
    expect(job.render_target).toBe('/renders/skills-craft-t1m1-16.mp4');
    expect(waited).toEqual([{ path: '/renders/skills-craft-t1m1-16.mp4' }]);
  });

  it('marca failed se o arquivo não fica pronto (timeout)', async () => {
    const id = store.enqueue({ skill: 'curso', input: 'http://x', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('RENDER: /renders/x.mp4', false), opts);
    expect(store.list().find((x) => x.id === id)!.status).toBe('failed');
  });

  it('marca failed RÁPIDO (sem esperar timeout) quando aparece o marcador <alvo>.err', async () => {
    const id = store.enqueue({ skill: 'curso', input: 'http://x', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    const markerDeps: QueueDeps = {
      runAgent: async () => ({ text: 'setup...\nRENDER: /renders/x.mp4' }),
      sendMessage: async (_c, t) => { sent.push(t); },
      sendDocument: async () => { /* noop */ },
      moveVideo: async (src, dest) => { moved.push({ src, dest }); return dest + '/moved.mp4'; },
      waitForFile: async (p) => {
        waited.push({ path: p });
        return { ok: false, failedMarker: true, logExcerpt: 'yt-dlp: erro ao baixar' };
      },
    };
    await processNextJob(store, markerDeps, opts);
    const job = store.list().find((x) => x.id === id)!;
    expect(job.status).toBe('failed');
    expect(job.error).toContain('/renders/x.mp4.log');
    expect(job.error).toContain('yt-dlp: erro ao baixar');
    expect(sent.some((t) => t.includes('/renders/x.mp4.log'))).toBe(true);
  });

  it('marca failed se o agente não dispara o render (sem RENDER:)', async () => {
    const id = store.enqueue({ skill: 'curso', input: 'http://x', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('ERRO: nao consegui', true), opts);
    expect(store.list().find((x) => x.id === id)!.status).toBe('failed');
  });

  it('move pro dest (pasta) depois que o render fica pronto', async () => {
    store.enqueue({ skill: 'curso', input: 'http://x', opts: JSON.stringify({ dest: '/final' }), notify: 'silencioso', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('RENDER: /renders/x.mp4', true), opts);
    expect(moved).toEqual([{ src: '/renders/x.mp4', dest: '/final' }]);
    expect(store.list()[0].result_path).toBe('/final/moved.mp4');
  });

  it('transcrever: aceita artefato .txt (não .mp4) no RENDER: e marca done', async () => {
    const id = store.enqueue({ skill: 'transcrever', input: 'https://x', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('setup...\nRENDER: /renders/mkivideo-1-16.txt', true), opts);
    const job = store.list().find((x) => x.id === id)!;
    expect(job.status).toBe('done');
    expect(job.result_path).toBe('/renders/mkivideo-1-16.txt');
  });

  it('transcrever: --pasta apontando pra um .txt é tratado como arquivo (não pasta)', async () => {
    store.enqueue({ skill: 'transcrever', input: 'https://x', opts: JSON.stringify({ dest: '/final/transcricao.txt' }), notify: 'silencioso', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('RENDER: /final/transcricao.txt', true), opts);
    expect(moved).toEqual([]); // não passou por moveVideo — já era o destino final
    expect(store.list()[0].result_path).toBe('/final/transcricao.txt');
  });

  it('dublar: usa .mp4 igual aos skills de vídeo (RENDER: com .mp4)', async () => {
    const id = store.enqueue({ skill: 'dublar', input: 'https://x', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('RENDER: /renders/mkivideo-1-16.mp4', true), opts);
    expect(store.list().find((x) => x.id === id)!.status).toBe('done');
  });

  it('transcrever: RENDER: com .mp4 é rejeitado (extensão errada pra essa skill)', async () => {
    const id = store.enqueue({ skill: 'transcrever', input: 'https://x', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    await processNextJob(store, deps('RENDER: /renders/x.mp4', true), opts);
    expect(store.list().find((x) => x.id === id)!.status).toBe('failed');
  });
});

describe('concorrência', () => {
  let store: SqliteQueueStore;
  const deps: QueueDeps = {
    runAgent: async () => ({ text: 'RESULT: /a.mp4' }),
    sendMessage: async () => { /* noop */ },
    sendDocument: async () => { /* noop */ },
    moveVideo: async (_s, d) => d,
  };
  beforeEach(() => { store = new SqliteQueueStore(':memory:'); });

  it('não passa do limite de concorrência', async () => {
    store.enqueue({ skill: 'explicativo', input: 'A', opts: null, notify: 'silencioso', sendVideo: false, chatId: null });
    const b = store.enqueue({ skill: 'explicativo', input: 'B', opts: null, notify: 'silencioso', sendVideo: false, chatId: null });
    const c = store.enqueue({ skill: 'explicativo', input: 'C', opts: null, notify: 'silencioso', sendVideo: false, chatId: null });
    store.markRunning(b); store.markRunning(c);  // 2 já rodando
    await processNextJob(store, deps, { concurrency: 2 });   // cheio → no-op
    expect(store.runningCount()).toBe(2);
    await processNextJob(store, deps, { concurrency: 3 });   // abre 1 vaga → pega o A
    expect(store.list().filter((x) => x.status !== 'queued').length).toBe(3);
  });
});

describe('planner (kind=plan)', () => {
  it('buildPlannerPrompt instrui classificar + emitir ENQUEUE', () => {
    const p = buildPlannerPrompt('https://curso/x');
    expect(p).toContain('ENQUEUE:');
    expect(p).toContain('PLAN_DONE');
    expect(p.toLowerCase()).toContain('classifi');
  });

  it('extractEnqueues parseia as linhas ENQUEUE e ignora o resto', () => {
    const out = extractEnqueues([
      'blah blah',
      'ENQUEUE: skill=curso | input=https://c/m1 | course=c | module=t1m1 | vertical=0',
      'ENQUEUE: skill=explicativo | input=Teorema de Bayes',
      'ENQUEUE: skill=invalida | input=x',   // skill inválida → ignora
      'ENQUEUE: skill=curso | course=semInput', // sem input → ignora
      'PLAN_DONE: 2',
    ].join('\n'));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ skill: 'curso', input: 'https://c/m1', course: 'c', module: 't1m1', vertical: false });
    expect(out[1]).toMatchObject({ skill: 'explicativo', input: 'Teorema de Bayes' });
  });

  it('processNextJob roda o plano e enfileira 1 job de vídeo por linha', async () => {
    const store = new SqliteQueueStore(':memory:');
    const planId = store.enqueue({ skill: 'curso', input: 'https://curso/x', opts: null, notify: 'silencioso', sendVideo: false, chatId: null, kind: 'plan' });
    const deps: QueueDeps = {
      runAgent: async () => ({ text: 'mapeei\nENQUEUE: skill=curso | input=https://c/m1 | course=c | module=t1m1\nENQUEUE: skill=curso | input=https://c/m2 | course=c | module=t1m2\nPLAN_DONE: 2' }),
      sendMessage: async () => {}, sendDocument: async () => {}, moveVideo: async (_s, d) => d,
    };
    await processNextJob(store, deps, {});
    const all = store.list();
    const plan = all.find((x) => x.id === planId)!;
    expect(plan.status).toBe('done');
    expect(plan.result_path).toBe('planned:2');
    const children = all.filter((x) => x.parent_id === planId);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.kind === 'video' && c.status === 'queued' && c.course === 'c')).toBe(true);
  });

  it('plano sem ENQUEUE marca failed', async () => {
    const store = new SqliteQueueStore(':memory:');
    const id = store.enqueue({ skill: 'curso', input: 'x', opts: null, notify: 'silencioso', sendVideo: false, chatId: null, kind: 'plan' });
    const deps: QueueDeps = {
      runAgent: async () => ({ text: 'ERRO: nao consegui mapear' }),
      sendMessage: async () => {}, sendDocument: async () => {}, moveVideo: async (_s, d) => d,
    };
    await processNextJob(store, deps, {});
    expect(store.list().find((x) => x.id === id)!.status).toBe('failed');
  });
});

describe('stats', () => {
  let store: SqliteQueueStore;
  beforeEach(() => { store = new SqliteQueueStore(':memory:'); });

  it('agrega por status e por curso (X/Y)', () => {
    const a = store.enqueue({ skill: 'curso', input: '1', opts: null, notify: 'silencioso', sendVideo: false, chatId: null, course: 'skills-craft', module: '1.1' });
    store.enqueue({ skill: 'curso', input: '2', opts: null, notify: 'silencioso', sendVideo: false, chatId: null, course: 'skills-craft', module: '1.2' });
    store.enqueue({ skill: 'curso', input: '3', opts: null, notify: 'silencioso', sendVideo: false, chatId: null, course: 'skill-design', module: '1.1' });
    store.markRunning(a); store.markDone(a, '/x.mp4');
    const s = store.stats();
    expect(s.byStatus.done).toBe(1);
    expect(s.byStatus.queued).toBe(2);
    const sc = s.courses.find((c) => c.course === 'skills-craft')!;
    expect(sc.total).toBe(2);
    expect(sc.done).toBe(1);
    expect(s.courses.find((c) => c.course === 'skill-design')!.queued).toBe(1);
  });
});
