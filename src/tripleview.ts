// /edge report: three separate 1–10 ratings per leg — Edge Engine, ESPN, and a market Consensus.
// Pure formatting; the numbers arrive already computed.
//
//   Edge (1–10)      = round(Edge's simulated hit % for YOUR side ÷ 10), only when Edge has your exact line.
//                      Not on Edge's board, a different line, or an ambiguous name → "n/a" (no number is made up).
//   ESPN (1–10)      = last-10 game-log hit rate × 10, ±1.5 for the season-average cushion (src/rate.ts).
//   Consensus (1–10) = round(10 × mean market probability) across DraftKings (via ESPN), Kalshi and,
//                      when ODDS_API_KEY is set, The Odds API books (src/consensus.ts).
//
//   Weak rating  : any single rating ≤ WEAK_MAX (4/10) gets ⚠️ right after it.
//   Strong rating: any single rating ≥ STRONG_MIN (7/10) gets ✅ right after it.
//   Weak leg     : the leg's average of its available ratings rounds to ≤ WEAK_MAX → the leg line starts with ⚠️.
//   Strong leg   : average of available ratings ≥ STRONG_MIN and no available rating ≤ WEAK_MAX → starts with ✅.
//   In between (or nothing rated): no leading emoji.
//   Slip summary : per source, the average of the legs it rated (⚠️ when ≤ WEAK_MAX), plus combined hit chance
//                  (product of probabilities, assuming independent legs) for Edge and Consensus.
import type { EdgeLegRating, EdgeSlipRating } from './edgerate.ts';
import type { ConsensusLeg } from './consensus.ts';
import type { LegRating } from './rate.ts';

export const WEAK_MAX = 4;
export const STRONG_MIN = 7;
export const CAUTION = '⚠️';
export const STRONG = '✅';

export interface TripleLeg {
  label: string;
  edge: { score: number | null; note: string };
  espn: { score: number | null; note: string };
  consensus: { score: number | null; p: number | null; note: string };
}

export function edgeScore(l: EdgeLegRating): { score: number | null; note: string } {
  if (l.status === 'same_line' && l.edgePct != null) {
    const s = Math.min(10, Math.max(1, Math.round(l.edgePct / 10)));
    return { score: s, note: `${Math.round(l.edgePct * 10) / 10}% sim${l.grade ? ` · grade ${l.grade}` : ''}` };
  }
  if (l.status === 'different_line') return { score: null, note: `Edge line is ${l.edgeLine}, not yours` };
  if (l.status === 'ambiguous') return { score: null, note: 'name matches 2 players — add the team' };
  return { score: null, note: "not on Edge's board" };
}

const mark = (s: number) => s <= WEAK_MAX ? ` ${CAUTION}` : s >= STRONG_MIN ? ` ${STRONG}` : '';
const rating = (name: string, s: number | null) => s == null ? `${name} n/a` : `${name} ${s}/10${mark(s)}`;

export function legAverage(l: TripleLeg): number | null {
  const xs = [l.edge.score, l.espn.score, l.consensus.score].filter((n): n is number => n != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
export function isWeakLeg(l: TripleLeg): boolean {
  const a = legAverage(l);
  return a != null && Math.round(a) <= WEAK_MAX;
}
export function isStrongLeg(l: TripleLeg): boolean {
  const a = legAverage(l);
  return a != null && a >= STRONG_MIN && !hasWeakRating(l);
}
export function legEmoji(l: TripleLeg): string {
  return isWeakLeg(l) ? CAUTION : isStrongLeg(l) ? STRONG : '';
}
export function hasWeakRating(l: TripleLeg): boolean {
  return [l.edge.score, l.espn.score, l.consensus.score].some((s) => s != null && s <= WEAK_MAX);
}

export function buildTriple(labels: string[], edge: EdgeLegRating[], espn: (LegRating | null)[], consensus: (ConsensusLeg | null)[]): TripleLeg[] {
  return labels.map((label, i) => ({
    label,
    edge: edge[i] ? edgeScore(edge[i]!) : { score: null, note: 'Edge off' },
    espn: espn[i] ? { score: espn[i]!.score, note: espn[i]!.reason } : { score: null, note: 'not rated' },
    consensus: consensus[i] ? { score: consensus[i]!.score, p: consensus[i]!.p, note: consensus[i]!.note } : { score: null, p: null, note: 'not rated' },
  }));
}

function avg(xs: (number | null)[]): number | null {
  const v = xs.filter((n): n is number => n != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function avgText(name: string, xs: (number | null)[]): string {
  const a = avg(xs);
  if (a == null) return `${name} n/a`;
  const r = Math.round(a * 10) / 10;
  return `${name} ${r}/10${Math.round(a) <= WEAK_MAX ? ` ${CAUTION}` : a >= STRONG_MIN ? ` ${STRONG}` : ''}`;
}

export function formatTripleReport(legs: TripleLeg[], opts: { edge?: EdgeSlipRating | null; edgeOff?: string | null; asOf?: string | null } = {}): string {
  const out: string[] = [];
  legs.forEach((l, i) => {
    const e = legEmoji(l);
    const head = `${e ? `${e} ` : ''}**${l.label}** — ${rating('Edge', l.edge.score)} · ${rating('ESPN', l.espn.score)} · ${rating('Consensus', l.consensus.score)}`;
    out.push(`${i + 1}. ${head}`);
    out.push(`   ↳ Edge: ${l.edge.note} · ESPN: ${l.espn.note} · Mkts: ${l.consensus.note}`);
  });
  out.push('');
  out.push(`**Slip** (avg of rated legs): ${avgText('Edge', legs.map((l) => l.edge.score))} · ${avgText('ESPN', legs.map((l) => l.espn.score))} · ${avgText('Consensus', legs.map((l) => l.consensus.score))}`);
  const priced = legs.filter((l) => l.consensus.p != null);
  const mkt = priced.length ? `${Math.round(priced.reduce((a, l) => a * l.consensus.p!, 1) * 1000) / 10}% (${priced.length}/${legs.length} legs priced)` : '—';
  const edgeC = opts.edge?.combinedPct != null ? `${opts.edge.combinedPct}% (${opts.edge.sameLine}/${opts.edge.total} on Edge's line)` : `— (${opts.edge?.sameLine ?? 0}/${legs.length} on Edge's line)`;
  out.push(`Combined hit chance, independent legs: Consensus ${mkt} · Edge ${edgeC}`);
  const weak = legs.filter(hasWeakRating).map((l) => l.label);
  const strong = legs.filter(isStrongLeg).map((l) => l.label);
  out.push(strong.length ? `${STRONG} Strong legs (avg ≥${STRONG_MIN}, none ≤${WEAK_MAX}): ${strong.join(', ')}` : 'Strong legs: none');
  out.push(weak.length ? `${CAUTION} Caution (a rating ≤${WEAK_MAX}/10): ${weak.join(', ')}` : `No rating ≤${WEAK_MAX}/10.`);
  if (opts.edgeOff) out.push(opts.edgeOff);
  if (opts.asOf) out.push(opts.asOf);
  out.push(`-# Edge = sim % ÷10 · ESPN = last-10 hit rate · Consensus = avg market % ×10 (DK via ESPN, Kalshi). ${STRONG} = strong (rating ≥${STRONG_MIN}; leg avg ≥${STRONG_MIN}, none ≤${WEAK_MAX}) · ${CAUTION} = weak (rating ≤${WEAK_MAX}; leg avg ≤${WEAK_MAX}).`);
  return out.join('\n').slice(0, 4000);
}
