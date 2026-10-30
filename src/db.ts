import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type LegType = 'prop' | 'spread' | 'total' | 'ml';
export type LegStatus = 'pending' | 'won' | 'lost' | 'push' | 'void' | 'review';
export type SlipStatus = 'open' | 'won' | 'lost' | 'push' | 'void' | 'review';

export interface Leg {
  id: number;
  slip_id: string;
  idx: number;
  league: string;
  event_id: string | null;
  event_name: string | null;
  start_time: string | null;
  type: LegType;
  team: string | null;        // team abbreviation (spread/ml) or player's team (prop)
  player: string | null;
  athlete_id: string | null;
  stat: string | null;        // canonical stat key, e.g. pts, pra, rec_yds
  side: 'over' | 'under' | null;
  line: number | null;
  odds: number | null;        // American
  status: LegStatus;
  actual: number | null;
  detail: string | null;      // human note from grader
  raw: string;                // what the user typed
  graded_at: string | null;
}
export interface Slip {
  id: string;
  user_id: string;
  user_name: string;
  title: string | null;
  stake: number;              // units
  odds: number | null;        // American, whole slip
  hidden: number;
  revealed_at: string | null;
  status: SlipStatus;
  profit: number | null;      // units, null while open / review
  note: string | null;
  source: string;             // discord | api | demo
  is_demo: number;
  guild_id: string | null;
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
  settled_at: string | null;
  poster_day: string | null;  // YYYY-MM-DD if pinned as that day's poster
  book: string | null;        // PrizePicks, FanDuel, Kalshi… (screenshot imports)
  play_type: string | null;   // "6-Pick Power Play", "Flex Play"…
  odds_text: string | null;   // odds exactly as logged ("+500", "6x", "YES 40¢ × 25")
  payout: number | null;      // total payout as logged (won) or potential
  is_test: number;            // staff-channel test slip: kept off standings
  source_url: string | null;  // link to the original Discord message (no copy of the image is stored)
}

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS slips (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      title TEXT,
      stake REAL NOT NULL DEFAULT 1,
      odds INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0,
      revealed_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      profit REAL,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'discord',
      is_demo INTEGER NOT NULL DEFAULT 0,
      guild_id TEXT, channel_id TEXT, message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      settled_at TEXT,
      poster_day TEXT
    );
    CREATE INDEX IF NOT EXISTS slips_status ON slips(status);
    CREATE TABLE IF NOT EXISTS legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slip_id TEXT NOT NULL REFERENCES slips(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      league TEXT NOT NULL,
      event_id TEXT, event_name TEXT, start_time TEXT,
      type TEXT NOT NULL,
      team TEXT, player TEXT, athlete_id TEXT, stat TEXT,
      side TEXT, line REAL, odds INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      actual REAL, detail TEXT,
      raw TEXT NOT NULL,
      graded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS legs_slip ON legs(slip_id);
    CREATE INDEX IF NOT EXISTS legs_event ON legs(event_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      persistent INTEGER NOT NULL,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS photo_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, user_name TEXT NOT NULL,
      guild_id TEXT, channel_id TEXT, message_id TEXT, source_url TEXT,
      image_key TEXT NOT NULL,
      is_test INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      read_error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS slip_imports (
      user_id TEXT NOT NULL,
      k TEXT NOT NULL,
      slip_id TEXT NOT NULL REFERENCES slips(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, k)
    );
  `);
  // Additive migrations for databases created before these columns existed.
  const have = new Set((db.prepare('PRAGMA table_info(slips)').all() as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [['book', 'TEXT'], ['play_type', 'TEXT'], ['odds_text', 'TEXT'], ['payout', 'REAL'], ['is_test', 'INTEGER NOT NULL DEFAULT 0'], ['source_url', 'TEXT']]) {
    if (!have.has(col)) db.exec(`ALTER TABLE slips ADD COLUMN ${col} ${type}`);
  }
  return db;
}

export function kvGet(db: DatabaseSync, k: string): string | null {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return r ? r.v : null;
}
export function kvSet(db: DatabaseSync, k: string, v: string) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

export function getSlip(db: DatabaseSync, id: string): Slip | undefined {
  return db.prepare('SELECT * FROM slips WHERE id = ?').get(id) as unknown as Slip | undefined;
}
export function getLegs(db: DatabaseSync, slipId: string): Leg[] {
  return db.prepare('SELECT * FROM legs WHERE slip_id = ? ORDER BY idx').all(slipId) as unknown as Leg[];
}
