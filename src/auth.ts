import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { kvGet, kvSet } from './db.ts';
import { readViewerToken, signViewerToken, type Viewer, type ViewerToken } from './tiers.ts';
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

  createSession(persistent: boolean, ua: string, viewer?: ViewerToken | null): { token: string; maxAge: number | null } {
    const token = randomBytes(32).toString('base64url');
    const ttl = persistent ? 30 * 86400_000 : 12 * 3600_000;
    this.db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at, persistent, user_agent, viewer_user_id, viewer_name, viewer_tier, viewer_staff) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(sha(token), new Date().toISOString(), new Date(Date.now() + ttl).toISOString(), persistent ? 1 : 0, ua.slice(0, 200),
        viewer?.userId ?? null, viewer?.name ?? null, viewer?.tier ?? null, viewer ? (viewer.staff ? 1 : 0) : null);
    return { token, maxAge: persistent ? ttl / 1000 : null };
  }

  signViewer(v: Omit<ViewerToken, 'exp'>) { return signViewerToken(this.secret, v); }
  readViewer(token: string) { return readViewerToken(this.secret, token); }

  /** Discord member bound to this session, or null when they signed in with the key alone (treated as Free). */
  sessionViewer(token: string | undefined): Viewer | null {
    if (!token) return null;
    const r = this.db.prepare('SELECT viewer_user_id, viewer_tier, viewer_staff, expires_at FROM sessions WHERE token_hash = ?').get(sha(token)) as
      { viewer_user_id: string | null; viewer_tier: string | null; viewer_staff: number | null; expires_at: string } | undefined;
    if (!r || Date.parse(r.expires_at) <= Date.now() || !r.viewer_user_id) return null;
    return { userId: r.viewer_user_id, tier: r.viewer_tier || 'free', staff: !!r.viewer_staff };
  }

  attachViewer(token: string | undefined, v: ViewerToken) {
    if (!token) return;
    this.db.prepare('UPDATE sessions SET viewer_user_id = ?, viewer_name = ?, viewer_tier = ?, viewer_staff = ? WHERE token_hash = ?')
      .run(v.userId, v.name, v.tier, v.staff ? 1 : 0, sha(token));
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
