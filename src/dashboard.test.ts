import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { getVideoDashboardHtml, createDashboardServer } from './dashboard.js';
import { SqliteQueueStore } from './sqlite-store.js';

describe('getVideoDashboardHtml', () => {
  it('embeds the token and the polling endpoint', () => {
    const html = getVideoDashboardHtml('secret');
    expect(html).toContain('secret');
    expect(html).toContain('/api/video-jobs');
    expect(html).toContain('setInterval');
  });
  it('works with empty token (no auth)', () => {
    const html = getVideoDashboardHtml();
    expect(html).toContain('const TOKEN = ""');
  });
});

describe('createDashboardServer', () => {
  let store: SqliteQueueStore;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    store = new SqliteQueueStore(':memory:');
    server = createDashboardServer(store); // sem token
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('GET /api/video-jobs returns the jobs', async () => {
    store.enqueue({ skill: 'explicativo', input: 'Bayes', opts: null, notify: 'sempre', sendVideo: false, chatId: 'cli' });
    const res = await fetch(`${base}/api/video-jobs`);
    const body = await res.json() as { jobs: Array<{ input: string }> };
    expect(res.status).toBe(200);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].input).toBe('Bayes');
  });

  it('GET /videos serves the HTML page', async () => {
    const res = await fetch(`${base}/videos`);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Fila de Vídeos');
  });

  it('POST /api/video-jobs/:id/cancel cancels a queued job', async () => {
    const id = store.enqueue({ skill: 'explicativo', input: 'X', opts: null, notify: 'sempre', sendVideo: false, chatId: 'cli' });
    const res = await fetch(`${base}/api/video-jobs/${id}/cancel`, { method: 'POST' });
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(store.list()[0].status).toBe('canceled');
  });

  it('404 for unknown route', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('GET /api/stats returns aggregated stats + machine info', async () => {
    const a = store.enqueue({ skill: 'curso', input: '1', opts: null, notify: 'silencioso', sendVideo: false, chatId: null, course: 'skills-craft', module: '1.1' });
    store.enqueue({ skill: 'curso', input: '2', opts: null, notify: 'silencioso', sendVideo: false, chatId: null, course: 'skills-craft', module: '1.2' });
    store.markRunning(a); store.markDone(a, '/x.mp4');
    const res = await fetch(`${base}/api/stats`);
    const body = await res.json() as { stats: { byStatus: Record<string, number>; courses: Array<{ course: string; done: number; total: number }> }; machine: { cpus: number }; running: unknown[] };
    expect(res.status).toBe(200);
    expect(body.stats.byStatus.done).toBe(1);
    expect(body.stats.courses[0].course).toBe('skills-craft');
    expect(body.stats.courses[0].total).toBe(2);
    expect(body.machine.cpus).toBeGreaterThan(0);
  });
});

describe('createDashboardServer with token', () => {
  it('rejects requests without the token', async () => {
    const store = new SqliteQueueStore(':memory:');
    const server = createDashboardServer(store, { token: 'k' });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/api/video-jobs`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/api/video-jobs?token=k`)).status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
