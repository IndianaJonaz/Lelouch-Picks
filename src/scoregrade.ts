// Grade a pending spread / total / moneyline from a final ESPN scoreboard game.
// A leg is graded only when exactly one final game matches. Anything else stays pending.
// Player props are not graded here — the box score (summary feed) is the only source for those.
import type { Leg } from './db.ts';
import type { Game } from './espn.ts';
import { gradeLeg, type LegGrade } from './grading.ts';

export type Match =
  | { ok: true; game: Game }
  | { ok: false; reason: 'none' | 'ambiguous' | 'not-final' };

const ABBR = /\b[A-Z]{2,4}\b/g;

function abbrs(text: string | null | undefined): string[] {
  return [...new Set((text ?? '').toUpperCase().match(ABBR) ?? [])];
}

function teamOn(g: Game, abbr: string): boolean {
  const a = abbr.toUpperCase();
  return g.home.abbr.toUpperCase() === a || g.away.abbr.toUpperCase() === a;
}

function final(g: Game): boolean {
  return g.state === 'post' && g.completed;
}

/** Both sides named on the leg must be the two teams in the game. A single team abbr is enough for spread/ml. */
function teamsMatch(leg: Pick<Leg, 'type' | 'team' | 'event_name' | 'raw'>, g: Game): boolean {
  const named = abbrs(`${leg.event_name ?? ''} ${leg.raw ?? ''}`);
  const sides = [g.home?.abbr, g.away?.abbr].map((a) => (a ?? '').toUpperCase()).filter(Boolean);
  if (named.length >= 2) {
    return named.every((a) => sides.includes(a)) && sides.every((a) => named.includes(a));
  }
  if (leg.type === 'total') return false; // a total with one team is not a confident game
  if (!leg.team) return false;
  return teamOn(g, leg.team);
}

function timeClose(leg: Pick<Leg, 'start_time'>, g: Game): boolean {
  if (!leg.start_time || !g.start) return true;
  const a = Date.parse(leg.start_time);
  const b = Date.parse(g.start);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) <= 36 * 3600_000;
}

export function matchLeg(leg: Pick<Leg, 'type' | 'event_id' | 'team' | 'event_name' | 'raw' | 'start_time' | 'league'>, games: Game[]): Match {
  if (leg.type === 'prop') return { ok: false, reason: 'none' };
  const pool = games.filter((g) => !leg.league || g.league === leg.league);
  if (leg.event_id) {
    const hits = pool.filter((g) => g.id === leg.event_id);
    if (hits.length !== 1) return { ok: false, reason: hits.length > 1 ? 'ambiguous' : 'none' };
    if (!final(hits[0])) return { ok: false, reason: 'not-final' };
    return { ok: true, game: hits[0] };
  }
  const candidates = pool.filter((g) => teamsMatch(leg, g) && timeClose(leg, g));
  const finals = candidates.filter(final);
  if (finals.length === 1) return { ok: true, game: finals[0] };
  if (finals.length > 1) return { ok: false, reason: 'ambiguous' };
  if (candidates.length === 1) return { ok: false, reason: 'not-final' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: false, reason: 'none' };
}

/** Grade from final scoreboard games. Pending in, pending out, unless the match is confident and final. */
export function applyScoreboardGrade(leg: Leg, games: Game[]): LegGrade {
  const keep: LegGrade = { status: leg.status, actual: leg.actual, detail: leg.detail };
  if (leg.status !== 'pending' || leg.type === 'prop') return keep;
  const m = matchLeg(leg, games);
  if (!m.ok) return keep;
  return gradeLeg(leg, m.game, null);
}
