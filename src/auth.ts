import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { kvGet, kvSet } from './db.ts';
import { dayInTz } from './util.ts';

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class Auth {
  private db: DatabaseSync; private secret: string; private tz: string;
  constructor(db: DatabaseSync, secret: string, tz: string) { this.db = db; this.secret = secret; this.tz = tz; }

  today(now = new Date()) { return dayInTz(now, this.tz); }
  rotation(day = this.today()) { return Number(kvGet(this.db, `key_rotation:${day}`) ?? 0); }

  /** Today's access key. Deterministic per (secret, day, rotation) so every process agrees without storing it. */
  keyFor(day = this.today(), rotation = this.rotation(day)): string {
    const mac = createHmac('sha256', this.secret).update(`access:${day}:${rotation}`).digest();
    let s = '';
    for (let i = 0; i < 8; i++) s += ABC[mac[i] % ABC.length];
    return `PHQ-${s.slice(0, 4)}-${s.slice(4)}`;
  }

  rotate(): string {
    const day = this.today();
    kvSet(this.db, `key_rotation:${day}`, String(this.rotation(day) + 1));
    return this.keyFor(day);
  }

  checkKey(input: string): boolean {
    const norm = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const a = Buffer.from(norm(input)), b = Buffer.from(norm(this.keyFor()));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Sliding-window limiter on FAILED attempts: 10 per 10 minutes per IP. */
  allowAttempt(ip: string): boolean {
    this.db.prepare('DELETE FROM login_attempts WHERE at < ?').run(Date.now() - 10 * 60_000);
    return (this.db.prepare('SELECT count(*) AS n FROM login_attempts WHERE ip = ?').get(ip) as { n: number }).n < 10;
  }
  recordFailure(ip: string) { this.db.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)').run(ip, Date.now()); }

  createSession(persistent: boolean, ua: string): { token: string; maxAge: number | null } {
    const token = randomBytes(32).toString('base64url');
    const ttl = persistent ? 30 * 86400_000 : 12 * 3600_000;
    this.db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at, persistent, user_agent) VALUES (?,?,?,?,?)')
      .run(sha(token), new Date().toISOString(), new Date(Date.now() + ttl).toISOString(), persistent ? 1 : 0, ua.slice(0, 200));
    return { token, maxAge: persistent ? ttl / 1000 : null };
  }

  validSession(token: string | undefined): boolean {
    if (!token) return false;
    const r = this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha(token)) as { expires_at: string } | undefined;
    return !!r && Date.parse(r.expires_at) > Date.now();
  }

  destroySession(token: string | undefined) { if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); }
  revokeAll() { this.db.prepare('DELETE FROM sessions').run(); }
  purge() { this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()); }
}
