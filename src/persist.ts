// Optional durable persistence: SQLite stays the working DB; the whole file is snapshotted into
// Postgres (DATABASE_URL, e.g. Neon) so Render's ephemeral disk can be wiped without losing slips.
// Unset DATABASE_URL => none of this runs and behaviour is exactly as before.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface SnapshotStore {
  load(): Promise<Buffer | null>;
  save(data: Buffer): Promise<void>;
  close(): Promise<void>;
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
export const isSqlite = (b: Buffer) => b.length >= 512 && b.subarray(0, 16).equals(SQLITE_MAGIC);

/** Postgres-backed store. `pg` is imported lazily so it's only loaded when DATABASE_URL is set. */
export async function pgSnapshotStore(url: string): Promise<SnapshotStore> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
  pool.on('error', (e) => console.error('[persist] postgres pool error:', e.message)); // never log the URL
  await pool.query('CREATE TABLE IF NOT EXISTS app_snapshot (id int PRIMARY KEY, data bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), bytes int NOT NULL)');
  return {
    async load() {
      const r = await pool.query<{ data: Buffer }>('SELECT data FROM app_snapshot WHERE id = 1');
      return r.rows[0]?.data ?? null;
    },
    async save(data) {
      await pool.query('INSERT INTO app_snapshot (id, data, updated_at, bytes) VALUES (1, $1, now(), $2) ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, bytes = excluded.bytes', [data, data.length]);
    },
    async close() { await pool.end(); },
  };
}

/** A consistent copy of the live DB (VACUUM INTO a temp file; node:sqlite is synchronous so no writer interleaves). */
export function snapshotBytes(db: DatabaseSync): Buffer {
  const tmp = path.join(os.tmpdir(), `phq-snap-${process.pid}-${randomBytes(6).toString('hex')}.db`);
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    return readFileSync(tmp);
  } finally { rmSync(tmp, { force: true }); }
}

/** Write snapshot bytes to `dbPath` atomically (and drop any stale WAL/SHM) before openDb runs. */
export function writeDbFile(dbPath: string, data: Buffer) {
  if (!isSqlite(data)) throw new Error('snapshot is not a SQLite database');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.restore-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  for (const ext of ['-wal', '-shm', '-journal']) rmSync(dbPath + ext, { force: true });
  renameSync(tmp, dbPath);
}

/** Boot step: restore the latest snapshot into dbPath if one exists. Returns the byte count restored, or 0. */
export async function restoreSnapshot(store: SnapshotStore, dbPath: string): Promise<number> {
  const data = await store.load();
  if (!data || !data.length) return 0;
  writeDbFile(dbPath, data);
  return data.length;
}

const totalChanges = (db: DatabaseSync) => Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);

/**
 * Saves a snapshot after writes settle: checks every `pollMs`; once the DB has changed and been quiet
 * for `quietMs` (or `maxWaitMs` passed since the first unsaved change) it uploads. Identical bytes are skipped.
 */
export class Snapshotter {
  private db: DatabaseSync; private store: SnapshotStore;
  private quietMs: number; private maxWaitMs: number; private pollMs: number; private now: () => number;
  private savedChanges = -1; private seenChanges = -1; private lastChangeAt = 0; private dirtySince = 0;
  private lastHash = ''; private saving: Promise<boolean> | null = null; private timer: NodeJS.Timeout | null = null;
  lastSavedAt: number | null = null; lastError: string | null = null; saves = 0;
  constructor(db: DatabaseSync, store: SnapshotStore, o: { quietMs?: number; maxWaitMs?: number; pollMs?: number; now?: () => number } = {}) {
    this.db = db; this.store = store;
    this.quietMs = o.quietMs ?? 5000; this.maxWaitMs = o.maxWaitMs ?? 60_000; this.pollMs = o.pollMs ?? 1000; this.now = o.now ?? Date.now;
  }

  start() { this.timer ??= setInterval(() => { void this.tick(); }, this.pollMs); this.timer.unref(); return this; }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Called on each poll; exposed for tests. */
  async tick(): Promise<boolean> {
    const n = totalChanges(this.db), t = this.now();
    if (n === this.savedChanges) return false;
    if (n !== this.seenChanges) { this.seenChanges = n; this.lastChangeAt = t; if (!this.dirtySince) this.dirtySince = t; }
    if (t - this.lastChangeAt < this.quietMs && t - this.dirtySince < this.maxWaitMs) return false;
    return this.saveNow();
  }

  /** Snapshot + upload now (serialized; concurrent callers share the in-flight save). */
  saveNow(): Promise<boolean> {
    if (this.saving) return this.saving.then(() => this.saveNow());
    this.saving = (async () => {
      const n = totalChanges(this.db);
      const data = snapshotBytes(this.db);
      const hash = createHash('sha256').update(data).digest('hex');
      try {
        if (hash !== this.lastHash) { await this.store.save(data); this.lastHash = hash; this.saves++; }
        this.savedChanges = n; this.dirtySince = 0; this.lastSavedAt = this.now(); this.lastError = null;
        return true;
      } catch (e) {
        this.lastError = (e as Error).message;
        console.error('[persist] snapshot save failed:', this.lastError);
        return false;
      }
    })().finally(() => { this.saving = null; });
    return this.saving;
  }

  /** Shutdown: final save, bounded by a timeout so SIGTERM never hangs. */
  async flush(timeoutMs = 8000): Promise<boolean> {
    this.stop();
    let t: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((r) => { t = setTimeout(() => r(false), timeoutMs); });
    try { return await Promise.race([this.saveNow(), timeout]); } finally { clearTimeout(t); }
  }
}

/**
 * Replace the live DB's contents with an uploaded SQLite file, in place (the open connection is shared
 * across the app, so we copy rows instead of swapping files). Validates first; all-or-nothing transaction.
 */
export function importInto(db: DatabaseSync, data: Buffer, openDb: (file: string) => DatabaseSync): { tables: Record<string, number> } {
  if (!isSqlite(data)) throw new Error('upload is not a SQLite database');
  const tmp = path.join(os.tmpdir(), `phq-import-${process.pid}-${randomBytes(6).toString('hex')}.db`);
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    // Open with the app's own openDb: proves it's readable and migrates it to the current schema.
    const chk = openDb(tmp);
    try {
      const ok = (chk.prepare('PRAGMA integrity_check').get() as Record<string, string>);
      if (Object.values(ok)[0] !== 'ok') throw new Error('upload failed integrity_check');
      chk.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { chk.close(); }
    for (const ext of ['-wal', '-shm']) rmSync(tmp + ext, { force: true });

    const tables = (db.prepare(`SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((r) => r.name);
    const q = (s: string) => '"' + s.replace(/"/g, '""') + '"';
    const counts: Record<string, number> = {};
    db.prepare('ATTACH DATABASE ? AS imp').run(tmp);
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      const impTables = new Set((db.prepare(`SELECT name FROM imp.sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name));
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const t of tables) {
          db.exec(`DELETE FROM main.${q(t)}`);
          if (!impTables.has(t)) { counts[t] = 0; continue; }
          const mainCols = new Set((db.prepare(`PRAGMA main.table_info(${q(t)})`).all() as { name: string }[]).map((c) => c.name));
          const cols = (db.prepare(`PRAGMA imp.table_info(${q(t)})`).all() as { name: string }[]).map((c) => c.name).filter((c) => mainCols.has(c)).map(q).join(', ');
          db.exec(`INSERT INTO main.${q(t)} (${cols}) SELECT ${cols} FROM imp.${q(t)}`);
          counts[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM main.${q(t)}`).get() as { n: number }).n);
        }
        if (impTables.has('sqlite_sequence')) { db.exec('DELETE FROM main.sqlite_sequence'); db.exec('INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM imp.sqlite_sequence'); }
        const bad = db.prepare('PRAGMA main.foreign_key_check').all();
        if (bad.length) throw new Error(`upload has ${bad.length} broken foreign key reference(s)`);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('DETACH DATABASE imp');
    }
    return { tables: counts };
  } finally { for (const ext of ['', '-wal', '-shm']) rmSync(tmp + ext, { force: true }); }
}
