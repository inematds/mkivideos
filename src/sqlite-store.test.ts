import { describe, it, expect, beforeEach } from 'vitest';

import { SqliteQueueStore, condenseError } from './sqlite-store.js';

describe('condenseError', () => {
  // O erro real do execFile: "Command failed: <comando>\n<stderr>". O comando é o prompt
  // inteiro do agente, então cortar o começo descartava justamente o stderr (a causa).
  const promptEcho = 'Command failed: claude -p Use a skill `video-explicativo` ' + 'blá '.repeat(700);
  const stderr = 'Error: usage limit reached, retry after 3600s';

  it('preserva o stderr (a causa) quando a mensagem estoura o limite', () => {
    const out = condenseError(`${promptEcho}\n${stderr}`);
    expect(out).toContain(stderr);
  });

  it('preserva também a cabeça, pra saber o que rodou', () => {
    const out = condenseError(`${promptEcho}\n${stderr}`);
    expect(out).toContain('Command failed: claude -p');
    expect(out).toContain('cortado');
  });

  it('respeita o limite', () => {
    expect(condenseError(`${promptEcho}\n${stderr}`).length).toBeLessThanOrEqual(2000);
  });

  it('deixa mensagem curta intacta', () => {
    expect(condenseError('ERRO: disco cheio')).toBe('ERRO: disco cheio');
  });

  it('aguenta vazio/undefined sem quebrar', () => {
    expect(condenseError('')).toBe('');
    expect(condenseError(undefined as unknown as string)).toBe('');
  });
});

describe('SqliteQueueStore', () => {
  let store: SqliteQueueStore;
  beforeEach(() => { store = new SqliteQueueStore(':memory:'); });

  it('enqueue creates a queued job and returns its id', () => {
    const id = store.enqueue({ skill: 'explicativo', input: 'Bayes', opts: null, notify: 'sempre', sendVideo: false, chatId: '123' });
    expect(id).toBeGreaterThan(0);
    const job = store.getNext();
    expect(job?.id).toBe(id);
    expect(job?.status).toBe('queued');
    expect(job?.skill).toBe('explicativo');
  });

  it('send_video round-trips as 1', () => {
    store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: true, chatId: '1' });
    expect(store.getNext()?.send_video).toBe(1);
  });

  it('getNext is FIFO by created_at then id', () => {
    const a = store.enqueue({ skill: 'explicativo', input: 'A', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    const b = store.enqueue({ skill: 'explicativo', input: 'B', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    expect(store.getNext()?.id).toBe(a);
    store.markRunning(a);
    store.markDone(a, '/tmp/a.mp4');
    expect(store.getNext()?.id).toBe(b);
  });

  it('getRunning returns the running job or null', () => {
    expect(store.getRunning()).toBeNull();
    const id = store.enqueue({ skill: 'demo', input: 'http://x', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    store.markRunning(id);
    expect(store.getRunning()?.id).toBe(id);
  });

  it('markDone sets status, result_path and finished_at', () => {
    const id = store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    store.markRunning(id);
    store.markDone(id, '/out/x.mp4');
    const done = store.list().find((x) => x.id === id)!;
    expect(done.status).toBe('done');
    expect(done.result_path).toBe('/out/x.mp4');
    expect(done.finished_at).toBeGreaterThan(0);
  });

  it('markFailed records the error (truncated) and frees the queue', () => {
    const id = store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    store.markRunning(id);
    store.markFailed(id, 'render quebrou');
    const failed = store.list().find((x) => x.id === id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('render quebrou');
    expect(store.getRunning()).toBeNull();
  });

  it('cancel only cancels queued jobs', () => {
    const id = store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    expect(store.cancel(id)).toBe(true);
    expect(store.list().find((x) => x.id === id)!.status).toBe('canceled');
    const running = store.enqueue({ skill: 'explicativo', input: 'Y', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    store.markRunning(running);
    expect(store.cancel(running)).toBe(false);
  });

  it('markFailed guarda a CAUSA de um erro gigante do execFile (regressão: job 48)', () => {
    // Reproduz o formato real que quebrou o diagnóstico: o prompt do agente ocupava
    // sozinho os 500 chars do corte antigo, e o stderr era descartado.
    const id = store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    const causa = 'Error: process exited with code 1 — motivo de verdade aqui';
    store.markFailed(id, `Command failed: claude -p ${'prompt gigante '.repeat(60)}\n${causa}`);
    const err = store.list().find((x) => x.id === id)!.error!;
    expect(err).toContain(causa);
    expect(err).toContain('Command failed: claude -p');
  });

  it('failStaleRunning marks orphaned running jobs as failed', () => {
    const a = store.enqueue({ skill: 'explicativo', input: 'A', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    const b = store.enqueue({ skill: 'explicativo', input: 'B', opts: null, notify: 'sempre', sendVideo: false, chatId: '1' });
    store.markRunning(a);
    expect(store.failStaleRunning()).toBe(1);
    expect(store.list().find((x) => x.id === a)!.status).toBe('failed');
    expect(store.list().find((x) => x.id === a)!.error).toContain('reinício');
    expect(store.list().find((x) => x.id === b)!.status).toBe('queued');
  });
});
