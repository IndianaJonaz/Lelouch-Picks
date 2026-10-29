// Pure grading + pace logic. No I/O here so it is easy to test.
import type { Leg, LegStatus, Slip, SlipStatus } from './db.ts';
import { elapsedFraction, type Game } from './espn.ts';
import { findInBox, sportOf, statValue, type Box } from './stats.ts';
import { americanToDecimal, round2 } from './util.ts';

export interface LegGrade { status: LegStatus; actual: number | null; detail: string | null }

const VOID_STATUSES = /POSTPONED|CANCELED|CANCELLED|FORFEIT/;

function sides(leg: Pick<Leg, 'team'>, g: Game) {
  const mine = leg.team && g.home.abbr === leg.team ? g.home : leg.team && g.away.abbr === leg.team ? g.away : null;
  const opp = mine ? (mine === g.home ? g.away : g.home) : null;
  return { mine, opp };
}

/** Grade one leg against the latest game state + box score. Never changes an already-settled leg. */
export function gradeLeg(leg: Leg, g: Game | null, box: Box | null): LegGrade {
  const keep: LegGrade = { status: leg.status, actual: leg.actual, detail: leg.detail };
  if (leg.status !== 'pending' || !g) return keep;
  if (VOID_STATUSES.test(g.statusName)) return { status: 'void', actual: null, detail: `Game ${g.detail || 'postponed/canceled'}` };
  if (g.state === 'pre') return keep;
  const final = g.state === 'post' && g.completed;

  if (leg.type === 'prop') {
    if (!box || leg.line == null || !leg.stat) return keep;
    const p = findInBox(box, leg.athlete_id, leg.player);
    if (!p) {
      if (!final) return { ...keep, actual: null };
      // Football box scores omit players with zero stats in a category, so "not listed" is ambiguous.
      if (sportOf(leg.league) === 'football') return { status: 'review', actual: null, detail: 'Not in final box score — needs a manual grade' };
      return { status: 'void', actual: null, detail: 'Did not play' };
    }
    if (p.dnp && final) return { status: 'void', actual: null, detail: 'Did not play' };
    const v = statValue(leg.league, leg.stat, p);
    if (v == null) return keep;
    if (leg.side === 'over') {
      if (v > leg.line) return { status: 'won', actual: v, detail: final ? null : 'Cashed early' };
      if (final) return { status: v === leg.line ? 'push' : 'lost', actual: v, detail: null };
    } else {
      if (v > leg.line) return { status: 'lost', actual: v, detail: final ? null : 'Busted early' };
      if (final) return { status: v === leg.line ? 'push' : 'won', actual: v, detail: null };
    }
    return { status: 'pending', actual: v, detail: null };
  }

  const hs = g.home.score ?? 0, as = g.away.score ?? 0;
  if (leg.type === 'total') {
    const total = hs + as;
    if (leg.line == null) return keep;
    if (!final) {
      if (leg.side === 'over' && total > leg.line) return { status: 'won', actual: total, detail: 'Cashed early' };
      if (leg.side === 'under' && total > leg.line) return { status: 'lost', actual: total, detail: 'Busted early' };
      return { status: 'pending', actual: total, detail: null };
    }
    if (total === leg.line) return { status: 'push', actual: total, detail: null };
    const over = total > leg.line;
    return { status: (leg.side === 'over') === over ? 'won' : 'lost', actual: total, detail: null };
  }

  const { mine, opp } = sides(leg, g);
  if (!mine || !opp) return { ...keep, detail: `Team ${leg.team} not found in game` };
  const ms = mine.score ?? 0, os = opp.score ?? 0;
  if (leg.type === 'spread') {
    const margin = ms + (leg.line ?? 0) - os;
    if (!final) return { status: 'pending', actual: margin, detail: null };
    return { status: margin > 0 ? 'won' : margin < 0 ? 'lost' : 'push', actual: margin, detail: null };
  }
  // moneyline
  const diff = ms - os;
  if (!final) return { status: 'pending', actual: diff, detail: null };
  return { status: diff > 0 ? 'won' : diff < 0 ? 'lost' : 'push', actual: diff, detail: null };
}

export interface Pace { current: number | null; target: number | null; frac: number | null; projected: number | null; pct: number | null; onPace: boolean | null; label: string }

/** Live pace for a leg. For props: current stat vs line, projected linearly by game time. */
export function paceFor(leg: Leg, g: Game | null, box: Box | null): Pace {
  const none: Pace = { current: null, target: leg.line, frac: null, projected: null, pct: null, onPace: null, label: '' };
  if (!g) return none;
  const frac = elapsedFraction(g);
  if (frac == null) return { ...none, label: 'Not started' };
  const proj = (v: number) => (frac >= 0.08 ? round2(v / frac) : null);
  if (leg.type === 'prop') {
    const p = box ? findInBox(box, leg.athlete_id, leg.player) : null;
    const cur = p && leg.stat ? statValue(leg.league, leg.stat, p) : leg.actual;
    if (cur == null || leg.line == null) return { ...none, frac, label: 'Waiting for box score' };
    const projected = g.state === 'post' ? cur : proj(cur);
    const pct = Math.min(1, leg.line > 0 ? cur / Math.ceil(leg.line) : 1);
    let onPace: boolean | null = projected == null ? null : leg.side === 'over' ? projected > leg.line : projected < leg.line;
    if (leg.side === 'over' && cur > leg.line) onPace = true;
    if (leg.side === 'under' && cur > leg.line) onPace = false;
    return { current: cur, target: leg.line, frac, projected, pct, onPace, label: `${cur} / ${leg.line}` };
  }
  const hs = g.home.score ?? 0, as = g.away.score ?? 0;
  if (leg.type === 'total' && leg.line != null) {
    const total = hs + as;
    const projected = g.state === 'post' ? total : proj(total);
    const onPace = projected == null ? null : leg.side === 'over' ? projected > leg.line : projected < leg.line;
    return { current: total, target: leg.line, frac, projected, pct: Math.min(1, total / leg.line), onPace, label: `${total} pts · line ${leg.line}` };
  }
  const { mine, opp } = sides(leg, g);
  if (!mine || !opp) return none;
  const diff = (mine.score ?? 0) - (opp.score ?? 0);
  if (leg.type === 'spread') {
    const margin = diff + (leg.line ?? 0);
    return { current: margin, target: 0, frac, projected: null, pct: null, onPace: margin > 0 ? true : margin < 0 ? false : null, label: margin > 0 ? `Covering by ${margin}` : margin < 0 ? `Behind the number by ${-margin}` : 'On the number' };
  }
  return { current: diff, target: 0, frac, projected: null, pct: null, onPace: diff > 0 ? true : diff < 0 ? false : null, label: diff > 0 ? `Leading by ${diff}` : diff < 0 ? `Trailing by ${-diff}` : 'Tied' };
}

export interface Settlement { status: SlipStatus; profit: number | null; detail: string | null }

/** Settle a slip from its legs. Profit is in units (stake × (decimal − 1)). */
export function settleSlip(slip: Pick<Slip, 'stake' | 'odds'>, legs: Pick<Leg, 'status' | 'odds'>[]): Settlement {
  if (!legs.length) return { status: 'open', profit: null, detail: null };
  if (legs.some((l) => l.status === 'lost')) return { status: 'lost', profit: round2(-slip.stake), detail: null };
  if (legs.some((l) => l.status === 'pending')) return { status: 'open', profit: null, detail: null };
  if (legs.some((l) => l.status === 'review')) return { status: 'review', profit: null, detail: 'A leg needs a manual grade' };
  const won = legs.filter((l) => l.status === 'won');
  const dropped = legs.filter((l) => l.status === 'push' || l.status === 'void');
  if (!won.length) return { status: legs.every((l) => l.status === 'void') ? 'void' : 'push', profit: 0, detail: 'Stake returned' };
  let dec: number | null = null;
  // The slip's own price wins when every leg stood (books price SGPs/boosts differently from the product of legs).
  if (slip.odds != null && !dropped.length) dec = americanToDecimal(slip.odds);
  else if (won.every((l) => l.odds != null)) dec = won.reduce((d, l) => d * americanToDecimal(l.odds!), 1);
  else if (slip.odds != null && dropped.every((l) => l.odds != null)) dec = americanToDecimal(slip.odds) / dropped.reduce((d, l) => d * americanToDecimal(l.odds!), 1);
  if (dec == null || dec <= 1) return { status: 'review', profit: null, detail: 'A leg pushed/voided and per-leg odds are missing — re-price with /settle' };
  return { status: 'won', profit: round2(slip.stake * (dec - 1)), detail: dropped.length ? `Re-priced without ${dropped.length} push/void leg(s)` : null };
}

/** Potential payout (to-win) for an open slip, if odds are known. */
export function toWin(slip: Pick<Slip, 'stake' | 'odds'>, legs: Pick<Leg, 'odds'>[]): number | null {
  if (slip.odds != null) return round2(slip.stake * (americanToDecimal(slip.odds) - 1));
  if (legs.length && legs.every((l) => l.odds != null)) return round2(slip.stake * (legs.reduce((d, l) => d * americanToDecimal(l.odds!), 1) - 1));
  return null;
}
