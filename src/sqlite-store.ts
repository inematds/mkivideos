// Store SQLite default — implementa QueueStore com better-sqlite3.
// Usado no modo standalone (rodar a fila sem bot) ou por hosts que não tenham
// um DB próprio. Hosts com SQLite próprio (ex.: openpcbot) podem implementar
// QueueStore sobre o banco deles em vez de usar este.

import Database from 'better-sqlite3';

import type { CourseStat, EnqueueInput, QueueStats, QueueStore, VideoJob } from './types.js';

/**
 * Condensa a mensagem de erro pra caber no banco SEM perder a causa.
 *
 * Erro de `execFile` chega como `"Command failed: <comando>\n<stderr>"` — e aqui o comando é o
 * prompt INTEIRO do agente (centenas de chars). O corte antigo (`slice(0, 500)`) guardava só o
 * eco do comando e descartava o stderr, que é a única parte que explica a falha: na prática
 * nenhum job era diagnosticável. Guardamos cabeça (o que rodou) + cauda (a causa).
 */
export function condenseError(error: string, max = 2000): string {
  const s = (error ?? '').trim();
  if (s.length <= max) return s;
  const head = 200;
  const marker = '\n…[trecho do meio cortado]…\n';
  return s.slice(0, head) + marker + s.slice(-(max - head - marker.length));
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS video_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    skill         TEXT NOT NULL,
    input         TEXT NOT NULL,
    opts          TEXT,
    status        TEXT NOT NULL DEFAULT 'queued',
    result_path   TEXT,
    error         TEXT,
    notify        TEXT NOT NULL DEFAULT 'sempre',
    send_video    INTEGER NOT NULL DEFAULT 0,
    chat_id       TEXT,
    course        TEXT,
    module        TEXT,
    render_target TEXT,
    kind          TEXT NOT NULL DEFAULT 'video',
    parent_id     INTEGER,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status, created_at, id);
`;

const now = (): number => Math.floor(Date.now() / 1000);

export class SqliteQueueStore implements QueueStore {
  private db: Database.Database;

  /** @param path caminho do arquivo .db, ou ':memory:' para in-memory. */
  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Adiciona colunas novas em bancos antigos (idempotente). */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(video_jobs)`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of [['course', 'TEXT'], ['module', 'TEXT'], ['render_target', 'TEXT'], ['kind', `TEXT NOT NULL DEFAULT 'video'`], ['parent_id', 'INTEGER']] as const) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE video_jobs ADD COLUMN ${name} ${type}`);
    }
  }

  /** Acesso ao Database cru (migrações/integração). */
  get raw(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  enqueue(job: EnqueueInput): number {
    const result = this.db.prepare(
      `INSERT INTO video_jobs (skill, input, opts, status, notify, send_video, chat_id, course, module, kind, parent_id, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(job.skill, job.input, job.opts, job.notify, job.sendVideo ? 1 : 0, job.chatId, job.course ?? null, job.module ?? null, job.kind ?? 'video', job.parentId ?? null, now());
    return Number(result.lastInsertRowid);
  }

  getNext(): VideoJob | null {
    return (this.db
      .prepare(`SELECT * FROM video_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`)
      .get() as VideoJob | undefined) ?? null;
  }

  getRunning(): VideoJob | null {
    return (this.db
      .prepare(`SELECT * FROM video_jobs WHERE status = 'running' ORDER BY started_at LIMIT 1`)
      .get() as VideoJob | undefined) ?? null;
  }

  runningCount(): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM video_jobs WHERE status = 'running'`).get() as { n: number }).n;
  }

  listRunning(): VideoJob[] {
    return this.db.prepare(`SELECT * FROM video_jobs WHERE status = 'running' ORDER BY started_at, id`).all() as VideoJob[];
  }

  markRunning(id: number): void {
    this.db.prepare(`UPDATE video_jobs SET status = 'running', started_at = ? WHERE id = ?`).run(now(), id);
  }

  setRenderTarget(id: number, target: string): void {
    this.db.prepare(`UPDATE video_jobs SET render_target = ? WHERE id = ?`).run(target, id);
  }

  markDone(id: number, resultPath: string): void {
    this.db.prepare(`UPDATE video_jobs SET status = 'done', result_path = ?, finished_at = ? WHERE id = ?`)
      .run(resultPath, now(), id);
  }

  markFailed(id: number, error: string): void {
    this.db.prepare(`UPDATE video_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
      .run(condenseError(error), now(), id);
  }

  cancel(id: number): boolean {
    const result = this.db.prepare(`UPDATE video_jobs SET status = 'canceled' WHERE id = ? AND status = 'queued'`).run(id);
    return result.changes > 0;
  }

  list(limit = 50): VideoJob[] {
    return this.db
      .prepare(`SELECT * FROM video_jobs ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as VideoJob[];
  }

  stats(): QueueStats {
    const byStatus: QueueStats['byStatus'] = { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 };
    for (const r of this.db.prepare(`SELECT status, count(*) AS n FROM video_jobs GROUP BY status`).all() as { status: VideoJob['status']; n: number }[]) {
      if (r.status in byStatus) byStatus[r.status] = r.n;
    }

    const courseMap = new Map<string, CourseStat>();
    for (const r of this.db.prepare(
      `SELECT course, status, count(*) AS n FROM video_jobs WHERE course IS NOT NULL AND course <> '' GROUP BY course, status`,
    ).all() as { course: string; status: VideoJob['status']; n: number }[]) {
      let c = courseMap.get(r.course);
      if (!c) { c = { course: r.course, total: 0, done: 0, failed: 0, running: 0, queued: 0, canceled: 0 }; courseMap.set(r.course, c); }
      c.total += r.n;
      c[r.status] += r.n;
    }
    const courses = [...courseMap.values()].sort((a, b) => a.course.localeCompare(b.course));

    const avgRow = this.db.prepare(
      `SELECT avg(finished_at - started_at) AS avg FROM video_jobs WHERE status = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
    ).get() as { avg: number | null };
    const avgRenderSeconds = avgRow.avg != null ? Math.round(avgRow.avg) : null;

    const dayAgo = now() - 86400;
    const doneDay = (this.db.prepare(
      `SELECT count(*) AS n FROM video_jobs WHERE status = 'done' AND finished_at >= ?`,
    ).get(dayAgo) as { n: number }).n;
    const throughputPerHour = doneDay > 0 ? Math.round((doneDay / 24) * 10) / 10 : null;

    const etaSeconds = avgRenderSeconds != null ? byStatus.queued * avgRenderSeconds : null;

    return { byStatus, courses, avgRenderSeconds, throughputPerHour, etaSeconds };
  }

  failStaleRunning(): number {
    const result = this.db.prepare(
      `UPDATE video_jobs SET status = 'failed', error = 'interrompido por reinício do serviço', finished_at = ? WHERE status = 'running'`,
    ).run(now());
    return result.changes;
  }
}
