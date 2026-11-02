// When an open slip should be done grading, and which open legs have already hit.
// Game legs: latest scheduled start + 12h. Kalshi: the market close/expiry when the
// leg text or start time carries one. Nothing is invented when no time is known.
import type { DatabaseSync } from 'node:sqlite';
import { getLegs } from './db.ts';
import { gradeSource } from './books.ts';

export const GAME_GRACE_MS = 12 * 3600_000;

const ISO = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/;

export interface SettleLeg {
  start_time?: string | null;
  league?: string | null;
  raw?: string | null;
  event_name?: string | null;
}

function kalshiClose(leg: SettleLeg): number | null {
  const text = `${leg.raw ?? ''} ${leg.event_name ?? ''}`;
  const m = text.match(ISO);
  if (m) {
    const raw = m[0].replace(' ', 'T');
    const t = Date.parse(raw.includes('T') ? raw : `${raw}T23:59:59Z`);
    if (Number.isFinite(t)) return t;
  }
  if (leg.start_time) {
    const t = Date.parse(leg.start_time);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function legDeadline(leg: SettleLeg, book?: string | null): number | null {
  const kalshi = gradeSource(book) === 'kalshi' || (leg.league ?? '').toLowerCase() === 'kalshi';
  if (kalshi) return kalshiClose(leg);
  if (!leg.start_time) return null;
  const t = Date.parse(leg.start_time);
  return Number.isFinite(t) ? t + GAME_GRACE_MS : null;
}

/** Latest leg deadline, or null when no leg has a usable time. */
export function computeSettleBy(legs: SettleLeg[], book?: string | null): string | null {
  let max = -Infinity;
  for (const leg of legs) {
    const t = legDeadline(leg, book);
    if (t != null && t > max) max = t;
  }
  return Number.isFinite(max) && max > -Infinity ? new Date(max).toISOString() : null;
}

/** Fill settle_by on rows that don't have one yet. Never overwrites a stored value. */
export function backfillSettleBy(db: DatabaseSync): number {
  const rows = db.prepare(`SELECT id, book FROM slips WHERE settle_by IS NULL`).all() as { id: string; book: string | null }[];
  const upd = db.prepare(`UPDATE slips SET settle_by = ? WHERE id = ? AND settle_by IS NULL`);
  let n = 0;
  for (const s of rows) {
    const at = computeSettleBy(getLegs(db, s.id), s.book);
    if (!at) continue;
    n += upd.run(at, s.id).changes;
  }
  return n;
}

export function isOverdue(
  slip: { status: string; settle_by?: string | null },
  legs: { status: string }[],
  now = Date.now(),
): boolean {
  if (slip.status !== 'open' || !slip.settle_by) return false;
  const t = Date.parse(slip.settle_by);
  if (!Number.isFinite(t) || now <= t) return false;
  return legs.some((l) => l.status === 'pending' || l.status === 'review');
}

/** Open-slip mark. A check only after the grader has the leg won. Pending shows nothing. */
export function openLegMark(status: string): 'hit' | 'miss' | null {
  if (status === 'won') return 'hit';
  if (status === 'lost') return 'miss';
  return null;
}
