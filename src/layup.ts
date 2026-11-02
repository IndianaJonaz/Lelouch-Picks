// Where graded slips are announced, and the record that stops a restart from posting twice.
import type { DatabaseSync } from 'node:sqlite';
import { kvGet, kvSet } from './db.ts';

const CURSOR = 'layup_feed_since';

/** First boot of this feature. Slips settled before this instant are not back-filled into the channel. */
export function ensureFeedCursor(db: DatabaseSync, now = new Date()): string {
  const existing = kvGet(db, CURSOR);
  if (existing) return existing;
  const v = now.toISOString();
  kvSet(db, CURSOR, v);
  return v;
}

export function claimGradePost(db: DatabaseSync, slipId: string, status: string): boolean {
  const r = db.prepare(
    `INSERT INTO grade_posts (slip_id, status, posted_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(slip_id) DO NOTHING`,
  ).run(slipId, status);
  return r.changes === 1;
}

export function releaseGradePost(db: DatabaseSync, slipId: string) {
  db.prepare('DELETE FROM grade_posts WHERE slip_id = ?').run(slipId);
}

/** Won / lost / push slips settled after the cursor that have not been posted. */
export function listUnposted(db: DatabaseSync, since: string): string[] {
  const rows = db.prepare(
    `SELECT id FROM slips WHERE status IN ('won','lost','push') AND profit IS NOT NULL AND is_demo = 0 AND is_test = 0
     AND settled_at >= ? AND id NOT IN (SELECT slip_id FROM grade_posts) ORDER BY settled_at, id`,
  ).all(since) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * LAYUP_FEED_CHANNEL_ID when it is a Discord snowflake.
 * Otherwise the channel whose name contains "layup-feed" (the 🏀︱layup-feed channel).
 */
export function layupChannelId(channels: { id: string; name: string }[], envId?: string | null): string | null {
  const env = (envId ?? '').trim();
  if (/^\d{5,25}$/.test(env)) return env;
  const matches = channels.filter((c) => c.name.toLowerCase().includes('layup-feed'));
  if (!matches.length) return null;
  return matches[0].id;
}
