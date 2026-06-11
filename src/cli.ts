#!/usr/bin/env node
// Executável do runner standalone. Liga argv → cli-lib + IO.
// Build → dist/cli.js (bin "mkivideos"). Uso: `mkivideos <add|fila|cancelar|run>`.

import path from 'node:path';

import { initVideoQueue } from './queue.js';
import { SqliteQueueStore } from './sqlite-store.js';
import { createDashboardServer } from './dashboard.js';
import { cmdAdd, cmdPlan, cmdFila, cmdCancel, cmdStats, cmdStatus, cmdGet, optVal, makeDefaultDeps, usage } from './cli-lib.js';

const DB = process.env.MKIVIDEOS_DB || path.resolve('mkivideos.db');

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  const store = new SqliteQueueStore(DB);

  switch (cmd) {
    case 'add':
      console.log(cmdAdd(store, rest.join(' ')));
      break;

    case 'plan':
      console.log(cmdPlan(store, rest.join(' ')));
      break;

    case 'fila':
      console.log(cmdFila(store));
      break;

    case 'cancelar':
    case 'cancel':
      console.log(cmdCancel(store, Number(rest[0])));
      break;

    case 'stats':
      console.log(cmdStats(store));
      break;

    case 'status':
      console.log(cmdStatus(store, Number(rest[0])));
      break;

    case 'get':
      console.log(cmdGet(store, Number(rest[0])));
      break;

    case 'run': {
      const swept = store.failStaleRunning();
      if (swept > 0) console.log(`(limpei ${swept} job(s) órfão(s) de um restart)`);

      const concurrency = Number(optVal(rest, '--concurrency') ?? process.env.MKIVIDEOS_CONCURRENCY ?? 1) || 1;
      const renderDir = optVal(rest, '--render-dir') ?? process.env.MKIVIDEOS_RENDER_DIR ?? 'renders';
      // daemon usa o modo background+poll (P7): agente dispara o render destacado, worker vigia o arquivo.
      initVideoQueue(store, makeDefaultDeps(), { background: true, concurrency, renderDir });
      console.log(`worker: background+poll · concorrência ${concurrency} · renders em "${renderDir}"`);

      const port = optVal(rest, '--port');
      const token = optVal(rest, '--token');
      if (port) {
        createDashboardServer(store, { port: Number(port), token });
        console.log(`dashboard: http://localhost:${port}/videos${token ? `?token=${token}` : ''}`);
      }
      console.log(`mkivideos rodando (DB: ${DB}) — Ctrl+C pra sair`);
      // setInterval (worker) + server seguram o processo vivo.
      return;
    }

    default:
      console.log(usage());
  }

  // Comandos one-shot fecham o banco e saem.
  store.close();
}

main();
