import { describe, it, expect, beforeEach } from 'vitest';

import { cmdAdd, cmdFila, cmdCancel, cmdRefazer, optVal, usage, makeDefaultDeps, waitForFile } from './cli-lib.js';
import { SqliteQueueStore } from './sqlite-store.js';

describe('cli-lib', () => {
  let store: SqliteQueueStore;
  beforeEach(() => { store = new SqliteQueueStore(':memory:'); });

  describe('cmdAdd', () => {
    it('enqueues and returns the id', () => {
      const msg = cmdAdd(store, 'explicativo Teorema de Bayes');
      expect(msg).toMatch(/enfileirado #1 \(explicativo\)/);
      expect(store.list()).toHaveLength(1);
      expect(store.getNext()?.input).toBe('Teorema de Bayes');
    });

    it('stores flags in opts and shows dest', () => {
      const msg = cmdAdd(store, 'explicativo X --vertical --pasta /out');
      expect(msg).toContain('→ /out');
      const opts = JSON.parse(store.getNext()!.opts!);
      expect(opts).toEqual({ vertical: true, dest: '/out' });
    });

    it('rejects an invalid skill', () => {
      expect(cmdAdd(store, 'foo bar')).toMatch(/^erro:/);
      expect(store.list()).toHaveLength(0);
    });

    it('enqueues transcrever/dublar', () => {
      expect(cmdAdd(store, 'transcrever https://x')).toMatch(/enfileirado #1 \(transcrever\)/);
      expect(cmdAdd(store, 'dublar https://y')).toMatch(/enfileirado #2 \(dublar\)/);
      expect(store.list()).toHaveLength(2);
    });

    it('enqueues reel com o caminho do avatar como input', () => {
      expect(cmdAdd(store, 'reel /home/nei/avatares/joao.mp4')).toMatch(/enfileirado #1 \(reel\)/);
      expect(store.getNext()?.input).toBe('/home/nei/avatares/joao.mp4');
    });
  });

  describe('cmdRefazer', () => {
    it('clona um job falho num novo job queued, preservando skill/input/opts', () => {
      cmdAdd(store, 'reel /p/avatar.mp4 --vertical --pasta /lives27');
      store.markRunning(1);
      store.markFailed(1, 'agente não disparou o render (sem RENDER:)');
      const msg = cmdRefazer(store, 1);
      expect(msg).toMatch(/enfileirado #2 \(reel\) — refez #1/);
      const novo = store.getNext()!;
      expect(novo.id).toBe(2);
      expect(novo.skill).toBe('reel');
      expect(novo.input).toBe('/p/avatar.mp4');
      expect(JSON.parse(novo.opts!)).toEqual({ vertical: true, dest: '/lives27' });
      expect(novo.status).toBe('queued');
    });

    it('não refaz um job que ainda está na fila ou rodando', () => {
      cmdAdd(store, 'explicativo X');
      expect(cmdRefazer(store, 1)).toMatch(/ainda queued/);
      store.markRunning(1);
      expect(cmdRefazer(store, 1)).toMatch(/ainda running/);
      expect(store.list()).toHaveLength(1);
    });

    it('avisa quando o id não existe', () => {
      expect(cmdRefazer(store, 99)).toBe('#99 não existe');
    });
  });

  describe('--pasta com destino .txt (moveVideo do makeDefaultDeps)', () => {
    it('trata caminho terminado em .txt como ARQUIVO, não diretório', async () => {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkivideos-test-'));
      const src = path.join(tmp, 'source.txt');
      fs.writeFileSync(src, 'ola');
      const destFile = path.join(tmp, 'sub', 'transcricao.txt');
      const deps = makeDefaultDeps();
      const finalPath = await deps.moveVideo(src, destFile);
      expect(finalPath).toBe(destFile);
      expect(fs.existsSync(destFile)).toBe(true);
    });
  });

  describe('cmdFila', () => {
    it('says empty when no active jobs', () => {
      expect(cmdFila(store)).toContain('vazia');
    });
    it('lists queued jobs', () => {
      cmdAdd(store, 'explicativo A');
      expect(cmdFila(store)).toContain('#1');
    });
  });

  describe('cmdCancel', () => {
    it('cancels a queued job', () => {
      cmdAdd(store, 'explicativo A');
      expect(cmdCancel(store, 1)).toContain('cancelado #1');
      expect(store.list()[0].status).toBe('canceled');
    });
    it('reports when it cannot cancel', () => {
      expect(cmdCancel(store, 999)).toMatch(/não cancelei/);
    });
    it('rejects a non-integer id', () => {
      expect(cmdCancel(store, NaN)).toMatch(/inválido/);
    });
  });

  describe('optVal', () => {
    it('reads --flag value', () => {
      expect(optVal(['run', '--port', '3141'], '--port')).toBe('3141');
      expect(optVal(['run'], '--port')).toBeUndefined();
    });
  });

  it('usage mentions the subcommands', () => {
    const u = usage();
    for (const s of ['add', 'fila', 'cancelar', 'run', 'MKIVIDEOS_DB']) expect(u).toContain(s);
  });

  describe('waitForFile', () => {
    let tmp: string;
    let target: string;

    beforeEach(async () => {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkivideos-waitforfile-'));
      target = path.join(tmp, 'out.mp4');
    });

    it('retorna sucesso quando o alvo aparece e estabiliza', async () => {
      const fs = await import('node:fs');
      const t0 = Date.now();
      setTimeout(() => fs.writeFileSync(target, 'conteudo'), 20);
      const res = await waitForFile(target, { timeoutMs: 5000, stableMs: 50, pollMs: 10 });
      expect(res).toEqual({ ok: true, failedMarker: false });
      expect(Date.now() - t0).toBeLessThan(5000);
    });

    it('retorna failedMarker RÁPIDO (não espera o timeout) quando aparece <alvo>.err', async () => {
      const fs = await import('node:fs');
      fs.writeFileSync(`${target}.log`, 'linha 1\nyt-dlp: falhou ao baixar\n');
      const t0 = Date.now();
      setTimeout(() => fs.writeFileSync(`${target}.err`, ''), 20);
      const res = await waitForFile(target, { timeoutMs: 5000, stableMs: 50, pollMs: 10 });
      const elapsed = Date.now() - t0;
      expect(res.ok).toBe(false);
      expect(res.failedMarker).toBe(true);
      expect(res.logExcerpt).toContain('yt-dlp: falhou ao baixar');
      expect(elapsed).toBeLessThan(1000); // bem antes do timeoutMs de 5000
    });

    it('honra o timeout quando nem alvo nem .err aparecem', async () => {
      const res = await waitForFile(target, { timeoutMs: 60, stableMs: 20, pollMs: 10 });
      expect(res).toEqual({ ok: false, failedMarker: false });
    });

    it('limpa um .err de uma tentativa anterior antes de começar a vigiar (não envenena o retry)', async () => {
      const fs = await import('node:fs');
      fs.writeFileSync(`${target}.err`, ''); // marcador de uma falha anterior pro mesmo alvo
      setTimeout(() => fs.writeFileSync(target, 'conteudo'), 20);
      const res = await waitForFile(target, { timeoutMs: 5000, stableMs: 50, pollMs: 10 });
      expect(res).toEqual({ ok: true, failedMarker: false });
    });
  });
});
