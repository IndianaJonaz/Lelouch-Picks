// Book-specific settlement. Kalshi and every other book use settleSlip unchanged.
// PrizePicks and DraftKings have no public slip API — legs are already graded from ESPN
// box scores / final scores. This only decides what the slip did.
import type { Leg, Slip } from './db.ts';
import { settleSlip, type Settlement } from './grading.ts';
import { round2 } from './util.ts';

export type GradeSource = 'kalshi' | 'prizepicks' | 'draftkings';

/** "PricePicks" is the owner's spelling of PrizePicks. */
export function gradeSource(book: string | null | undefined): GradeSource | null {
  const b = String(book ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (b === 'kalshi') return 'kalshi';
  if (b === 'prizepicks' || b === 'pricepicks' || b === 'pp') return 'prizepicks';
  if (b === 'draftkings' || b === 'dk') return 'draftkings';
  return null;
}

/**
 * PrizePicks Flex Play payout multiple of stake (total return, not profit).
 * 3-pick 3/2, 4-pick 6/1.5, 5-pick 10/2/0.4, 6-pick 25/2/0.4.
 * A multiple of 1 returns stake (push). Below 1 is a loss. Counts missing from the chart
 * are not partial wins — a miss loses the slip. Standard entries only; demon/goblin
 * prices are used only when the slip itself stored a payout.
 */
export const FLEX_PAYOUT: Record<number, Record<number, number>> = {
  3: { 3: 3, 2: 1 },
  4: { 4: 6, 3: 1.5 },
  5: { 5: 10, 4: 2, 3: 0.4 },
  6: { 6: 25, 5: 2, 4: 0.4 },
};

export function flexMultiple(legs: number, hits: number): number | null {
  const row = FLEX_PAYOUT[legs];
  if (!row || row[hits] == null) return null;
  return row[hits];
}

type PricedSlip = Pick<Slip, 'stake' | 'odds'> & { book?: string | null; play_type?: string | null; payout?: number | null };
type PricedLeg = Pick<Leg, 'status' | 'odds'>;

const open: Settlement = { status: 'open', profit: null, detail: null };

function fromMultiple(stake: number, mult: number, detail: string | null): Settlement {
  if (mult === 1) return { status: 'push', profit: 0, detail };
  if (mult > 1) return { status: 'won', profit: round2(stake * (mult - 1)), detail };
  return { status: 'lost', profit: round2(stake * (mult - 1)), detail };
}

/** Price a full hit. Logged payout/odds win when the leg set did not change; otherwise reprice from leg odds. */
function priceFullHit(slip: PricedSlip, legs: PricedLeg[], useSlipPrice: boolean): Settlement {
  if (useSlipPrice && slip.payout != null && slip.payout > slip.stake) {
    return { status: 'won', profit: round2(slip.payout - slip.stake), detail: null };
  }
  return settleSlip({ stake: slip.stake, odds: useSlipPrice ? slip.odds : null }, legs);
}

function settleDraftKings(slip: PricedSlip, legs: PricedLeg[]): Settlement {
  if (!legs.length) return open;
  if (legs.some((l) => l.status === 'pending' || l.status === 'review')) return open;
  // A one-leg bet is graded exactly as that leg.
  if (legs.length === 1) {
    const l = legs[0];
    if (l.status === 'won') return { ...priceFullHit(slip, legs, true), detail: null };
    if (l.status === 'lost') return { status: 'lost', profit: round2(-slip.stake), detail: null };
    if (l.status === 'push') return { status: 'push', profit: 0, detail: null };
    return { status: 'void', profit: 0, detail: null };
  }
  const active = legs.filter((l) => l.status !== 'push' && l.status !== 'void');
  const dropped = legs.length - active.length;
  if (!active.length) {
    const allVoid = legs.every((l) => l.status === 'void');
    return { status: allVoid ? 'void' : 'push', profit: 0, detail: 'Push/void leg(s) dropped' };
  }
  if (active.some((l) => l.status === 'lost')) return { status: 'lost', profit: round2(-slip.stake), detail: null };
  const priced = priceFullHit(slip, active, dropped === 0);
  return { ...priced, detail: dropped ? `Graded without ${dropped} push/void leg(s)` : priced.detail };
}

function settlePrizePicks(slip: PricedSlip, legs: PricedLeg[]): Settlement {
  if (!legs.length) return open;
  if (legs.some((l) => l.status === 'pending' || l.status === 'review')) return open;
  // DNP / void is removed. The slip is graded on whoever actually played.
  const active = legs.filter((l) => l.status !== 'void');
  const removed = legs.length - active.length;
  if (!active.length) return { status: 'void', profit: 0, detail: 'DNP — stake returned' };
  const hits = active.filter((l) => l.status === 'won').length;
  const flex = /flex/i.test(slip.play_type ?? '');
  const hitNote = `${hits}/${active.length} hits`;
  if (flex) {
    if (active.some((l) => l.status === 'push')) {
      return { status: 'push', profit: 0, detail: `${hitNote} · push` };
    }
    const loggedFull = removed === 0 && hits === active.length && (slip.odds != null || (slip.payout != null && slip.payout > slip.stake));
    if (loggedFull) return { ...priceFullHit(slip, active, true), detail: hitNote };
    const mult = flexMultiple(active.length, hits);
    if (mult == null) {
      if (hits === active.length) return { ...priceFullHit(slip, active, removed === 0), detail: hitNote };
      return { status: 'lost', profit: round2(-slip.stake), detail: hitNote };
    }
    return fromMultiple(slip.stake, mult, hitNote);
  }
  if (active.some((l) => l.status === 'lost')) {
    return { status: 'lost', profit: round2(-slip.stake), detail: removed ? `DNP removed · ${hitNote}` : null };
  }
  if (active.some((l) => l.status === 'push')) return { status: 'push', profit: 0, detail: 'Push' };
  const priced = priceFullHit(slip, active, removed === 0);
  return { ...priced, detail: removed ? `DNP removed · graded on ${active.length}` : priced.detail };
}

/** Kalshi and any other book: the original settlement, untouched. */
export function settleForBook(slip: PricedSlip, legs: PricedLeg[]): Settlement {
  const src = gradeSource(slip.book);
  if (src === 'prizepicks') return settlePrizePicks(slip, legs);
  if (src === 'draftkings') return settleDraftKings(slip, legs);
  return settleSlip(slip, legs);
}
