import { describe, it, expect, beforeEach } from 'vitest';

import { cmdAdd, cmdFila, cmdCancel, optVal, usage, makeDefaultDeps } from './cli-lib.js';
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
});
