// Parlay rating. Scoring is pure (no I/O) so the math is unit-tested; ESPN fetches sit below it.
//
// Prop score (1–10)
//   Take the player's game log (regular season + postseason; preseason only if that is all there is).
//   Drop the game being bet, and drop games where the stat cell is blank (DNP) — never treat a blank as 0.
//   Combo stats (pra, pr, pa, ra, sb, rush_rec_yds, pass_rush_yds, td, points, hrr, …) are the sum of
//   their components from src/stats.ts. A missing component column means the leg cannot be scored.
//   Anytime TD / HR / goals (over 0.5) hit when the game total is ≥ 1. Every other leg hits when the
//   stat beats the line in the chosen direction (a push, stat === line, is not a hit).
//   Let n be the last 10 played games (or fewer, if that is the whole log) and h the hits among them.
//     base    = 10 * (h / n)                         // 8/10 starts at 8
//     cushion = seasonAvg − line   (over)
//             = line − seasonAvg   (under)           // positive = season average is on the bet's side
//     scale   = max(|line|, 1)
//     rel     = clamp(cushion / scale, −0.5, 0.5)    // ±50% of the line
//     adj     = rel * 3                              // at most ±1.5 points
//     score   = clamp(round(base + adj), 1, 10)
//   Season average uses every played game in that pool, not just the last 10.
//   L10 margin is the average of (stat − line) in the bet's direction over those last 10. It is shown,
//   not added a second time — the cushion above is what moves the score.
//
// Spread / total (1–10)
//   Compare the user's number to ESPN's current number. Positive edge = the user has the better number
//   (getting +4.5 when the market is +3.5, or laying −3 when the market is −6, or an over 46.5 when the
//   market total is 47.5).
//     edge  = userLine − marketLine                         (spread, same team)
//     edge  = marketTotal − userLine                        (over)
//     edge  = userLine − marketTotal                        (under)
//     score = clamp(round(5 + 2 * edge), 1, 10)             // half a point is one score point
//   No ESPN line → score 5, reason "no market line found". That 5 stays in the parlay score.
//
// Moneyline (1–10)
//   p = implied probability of the market's American odds for the picked side.
//     negative odds: |odds| / (|odds| + 100);  positive odds: 100 / (odds + 100)
//     score = clamp(round(10 * p), 1, 10)                   // 50% → 5, −175 ≈ 64% → 6
//   If the user also priced the leg, add 10 * (pMarket − pUser) before rounding, so a better price
//   (lower implied probability than the market) raises the score by about one point per 10 percentage
//   points. No market moneyline → 5, "no market line found".
//
// Parlay (1–10)
//   Each scored leg contributes p = score/10. The parlay is 10 × the product of those, rounded and
//   clamped to 1–10. One leg passes through unchanged. Extra legs pull the number down, and a low leg
//   dominates — a 1 and a 10 is a 1. Legs with no score (missing stat, empty log, unread line) are
//   left as "—" and left out of the product. The lowest scored leg(s) are flagged as weakest.
//
// Line movement (open vs close history) is out of scope. Only the current ESPN number is used.
import type { LegType } from './db.ts';
import { marketFromSummary, gameFromSummary, parseGameLog, type Espn, type LogGame, type MarketQuote } from './espn.ts';
import { STATS, sportOf } from './stats.ts';
import { completeText, type XaiOpts } from './slipvision.ts';

const FETCH_CONCURRENCY = 3;
const RATE_BUDGET_MS = 20_000;
const LEG_TIMEOUT_MS = 9_000;
const ANYTIME = new Set(['td', 'hr', 'goals']);

export interface RatableLeg {
  league: string;
  event_id: string | null;
  event_name: string | null;
  type: LegType;
  team: string | null;
  player: string | null;
  athlete_id: string | null;
  stat: string | null;
  side: 'over' | 'under' | null;
  line: number | null;
  odds: number | null;
  raw: string;
}

export interface LegRating { label: string; score: number | null; reason: string }
export interface ParlayRating { legs: LegRating[]; overall: number | null; weakest: string[]; summary: string | null }

export interface PropMath {
  score: number | null;
  reason: string;
  hits: number | null;
  n: number | null;
  seasonAvg: number | null;
  /** Average of (stat − line) in the bet's direction over the last-10 sample. */
  margin: number | null;
  /** Season-average cushion vs the line, in the bet's direction. This is what adjusts the score. */
  cushion: number | null;
}

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, Math.round(n)));
}

export function impliedProbability(american: number): number | null {
  if (!Number.isFinite(american) || Math.abs(american) < 100) return null;
  return american < 0 ? (-american) / (-american + 100) : 100 / (american + 100);
}

function n1(n: number): string {
  const r = Math.round(n * 10) / 10;
  const z = Object.is(r, -0) ? 0 : r;
  return z.toFixed(1);
}
function signed(n: number): string {
  const s = n1(n);
  return n > 0 ? `+${s}` : s;
}
function num(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}
export function spreadText(n: number): string {
  if (n === 0) return 'PK';
  return (n > 0 ? '+' : '') + num(n);
}
function shortStat(league: string, key: string): string {
  return STATS[sportOf(league)].find((d) => d.key === key)?.aliases[0] ?? key;
}
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function opponentFromEvent(eventName: string | null | undefined, team: string | null | undefined): string | null {
  if (!eventName || !team) return null;
  const m = eventName.toUpperCase().match(/\b([A-Z]{2,5})\s*@\s*([A-Z]{2,5})\b/);
  if (!m) return null;
  const t = team.toUpperCase();
  if (t === m[1]) return m[2];
  if (t === m[2]) return m[1];
  return null;
}

function columnProblem(league: string, stat: string, columns: Set<string>): string | null {
  const def = STATS[sportOf(league)].find((d) => d.key === stat);
  if (!def) return `unknown stat ${stat}`;
  if (def.combo) {
    const miss = def.combo.filter((k) => !columns.has(k));
    if (miss.length) return `game log has no ${miss.map((k) => shortStat(league, k)).join(' + ')}`;
    return null;
  }
  if (!columns.has(stat)) return `game log has no ${shortStat(league, stat)}`;
  return null;
}

function valueOf(league: string, stat: string, stats: Record<string, number | null>): number | null {
  const def = STATS[sportOf(league)].find((d) => d.key === stat);
  if (!def) return null;
  const keys = def.combo ?? [stat];
  if (keys.some((k) => stats[k] == null)) return null;
  return keys.reduce((s, k) => s + (stats[k] as number), 0);
}

const emptyProp = (reason: string): PropMath => ({ score: null, reason, hits: null, n: null, seasonAvg: null, margin: null, cushion: null });

/** Score one prop from an already-parsed game log. `columns` is the set of canonical keys the log actually has. */
export function scoreProp(input: {
  league: string; stat: string; side: 'over' | 'under'; line: number;
  games: LogGame[]; columns: readonly string[];
  excludeEventId?: string | null; opponent?: string | null;
}): PropMath {
  const columns = new Set(input.columns);
  const problem = columnProblem(input.league, input.stat, columns);
  if (problem) return emptyProp(problem);
  const rows: { date: string; eventId: string; preseason: boolean; value: number }[] = [];
  for (const g of input.games) {
    if (input.excludeEventId && g.eventId === input.excludeEventId) continue;
    const v = valueOf(input.league, input.stat, g.stats);
    if (v == null) continue;
    rows.push({ date: g.date, eventId: g.eventId, preseason: g.preseason, value: v });
  }
  const reg = rows.filter((r) => !r.preseason);
  const pool = (reg.length ? reg : rows).slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.eventId < b.eventId ? 1 : -1));
  if (!pool.length) return emptyProp('no played games in the log');
  const preseason = !reg.length;
  const l10 = pool.slice(0, 10);
  const anytime = input.side === 'over' && input.line <= 0.5 && ANYTIME.has(input.stat);
  const isHit = (v: number) => anytime ? v >= 1 : input.side === 'over' ? v > input.line : v < input.line;
  const hits = l10.filter((r) => isHit(r.value)).length;
  const n = l10.length;
  const seasonAvg = mean(pool.map((r) => r.value));
  const margin = mean(l10.map((r) => input.side === 'under' ? input.line - r.value : r.value - input.line));
  const cushion = input.side === 'under' ? input.line - seasonAvg : seasonAvg - input.line;
  const scale = Math.max(Math.abs(input.line), 1);
  const rel = Math.max(-0.5, Math.min(0.5, cushion / scale));
  const score = clampScore(Math.round(10 * (hits / n) + rel * 3));
  const vs = input.opponent ? ` vs ${input.opponent}` : '';
  const pre = preseason ? ' (preseason)' : '';
  const reason = `hit ${hits}/${n}, avg ${n1(seasonAvg)}, margin ${signed(margin)}${vs}${pre}`;
  return { score, reason, hits, n, seasonAvg, margin, cushion };
}

export function scoreSpread(userLine: number, marketLine: number | null): { score: number; reason: string } {
  if (marketLine == null || !Number.isFinite(marketLine)) return { score: 5, reason: 'no market line found' };
  const edge = userLine - marketLine;
  if (edge === 0) return { score: 5, reason: `market ${spreadText(marketLine)}, same number` };
  return { score: clampScore(Math.round(5 + 2 * edge)), reason: `market ${spreadText(marketLine)}, you ${spreadText(userLine)} (${signed(edge)} pts)` };
}

export function scoreTotal(side: 'over' | 'under', userLine: number, marketTotal: number | null): { score: number; reason: string } {
  if (marketTotal == null || !Number.isFinite(marketTotal)) return { score: 5, reason: 'no market line found' };
  const edge = side === 'over' ? marketTotal - userLine : userLine - marketTotal;
  const you = `${side === 'over' ? 'o' : 'u'}${num(userLine)}`;
  if (edge === 0) return { score: 5, reason: `market ${num(marketTotal)}, same number` };
  return { score: clampScore(Math.round(5 + 2 * edge)), reason: `market ${num(marketTotal)}, you ${you} (${signed(edge)} pts)` };
}

export function scoreMoneyline(marketOdds: number | null, userOdds: number | null): { score: number; reason: string } {
  const p = marketOdds == null ? null : impliedProbability(marketOdds);
  if (p == null || marketOdds == null) return { score: 5, reason: 'no market line found' };
  const up = userOdds == null ? null : impliedProbability(userOdds);
  const adj = up == null ? 0 : 10 * (p - up);
  const you = up == null || userOdds == null ? '' : `, you ${userOdds > 0 ? '+' : ''}${userOdds} (${Math.round(up * 100)}%)`;
  const score = clampScore(Math.round(10 * p + adj));
  return { score, reason: `market ${marketOdds > 0 ? '+' : ''}${marketOdds} (${Math.round(p * 100)}% implied)${you}` };
}

export function scoreParlay(legs: { label: string; score: number | null }[]): { overall: number | null; weakest: string[] } {
  const scored = legs.filter((l): l is { label: string; score: number } => l.score != null);
  if (!scored.length) return { overall: null, weakest: [] };
  const product = scored.reduce((p, l) => p * (l.score / 10), 1);
  const overall = clampScore(Math.round(10 * product));
  const min = Math.min(...scored.map((l) => l.score));
  return { overall, weakest: scored.filter((l) => l.score === min).map((l) => l.label) };
}

export function legLabel(l: Pick<RatableLeg, 'type' | 'player' | 'team' | 'side' | 'line' | 'stat' | 'league' | 'event_name' | 'raw'>): string {
  if (l.type === 'prop') {
    const who = l.player || l.raw || '?';
    if (l.line === 0.5 && l.side === 'over' && (l.stat === 'td' || l.stat === 'hr' || l.stat === 'goals')) {
      return `${who} ${l.stat === 'td' ? 'anytime TD' : l.stat === 'hr' ? 'to homer' : 'to score'}`;
    }
    const side = l.side === 'over' ? 'o' : l.side === 'under' ? 'u' : '';
    const stat = l.stat ? shortStat(l.league, l.stat) : '';
    return `${who} ${side}${l.line ?? '?'}${stat ? ' ' + stat : ''}`.replace(/\s+/g, ' ').trim();
  }
  if (l.type === 'spread') return `${l.team ?? '?'} ${l.line == null ? '?' : spreadText(l.line)}`;
  if (l.type === 'total') {
    const side = l.side === 'over' ? 'o' : 'u';
    return `${l.event_name ?? l.raw} ${side}${l.line ?? '?'}`.trim();
  }
  return `${l.team ?? l.raw} ML`;
}

export function formatLegLine(l: LegRating): string {
  return `${l.score == null ? '—' : `${l.score}/10`} · ${l.label} — ${l.reason}`;
}

export function formatParlayLine(r: Pick<ParlayRating, 'overall' | 'weakest' | 'legs'>): string {
  const unscored = r.legs.filter((l) => l.score == null).length;
  if (r.overall == null) return 'Parlay: — · no scored legs';
  const w = r.weakest.length ? ` · weakest: ${r.weakest.join(', ')}` : '';
  const u = unscored ? ` · ${unscored} unscored` : '';
  return `Parlay: ${r.overall}/10${w}${u}`;
}

export function ratingDescription(r: ParlayRating): string {
  const lines = [...r.legs.map(formatLegLine), '', formatParlayLine(r)];
  if (r.summary) lines.push('', `> ${r.summary}`);
  return lines.join('\n').slice(0, 4096);
}

function quoteFor(team: string | null, q: MarketQuote | null, kind: 'spread' | 'total' | 'ml'): number | null {
  if (!q) return null;
  if (kind === 'total') return q.total;
  if (!team) return null;
  const map = kind === 'spread' ? q.spreadByAbbr : q.mlByAbbr;
  if (team in map) return map[team];
  const t = team.toUpperCase();
  for (const [k, v] of Object.entries(map)) if (k.toUpperCase() === t) return v;
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let done = false;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
    );
  });
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (!items.length) return out;
  let cursor = 0;
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

function miss(leg: RatableLeg, reason: string): LegRating {
  return { label: legLabel(leg), score: null, reason };
}
function neutral(leg: RatableLeg): LegRating {
  return { label: legLabel(leg), score: 5, reason: 'no market line found' };
}

async function rateOne(espn: Espn, leg: RatableLeg, marketFor: (league: string, eventId: string) => Promise<MarketQuote | null>, deadline: number): Promise<LegRating> {
  if (Date.now() > deadline) {
    return leg.type === 'prop' ? miss(leg, 'timed out before this leg was rated') : neutral(leg);
  }
  if (leg.type === 'prop') {
    if (!leg.athlete_id) return miss(leg, 'no ESPN athlete id');
    if (!leg.stat) return miss(leg, 'no stat on this leg');
    if (!leg.side || leg.line == null) return miss(leg, 'no line on this leg');
    try {
      const gl = await withTimeout(espn.gamelog(leg.league, leg.athlete_id), Math.min(LEG_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
      const parsed = parseGameLog(leg.league, gl.data);
      const scored = scoreProp({
        league: leg.league, stat: leg.stat, side: leg.side, line: leg.line,
        games: parsed.games, columns: parsed.columns, excludeEventId: leg.event_id,
        opponent: opponentFromEvent(leg.event_name, leg.team),
      });
      return { label: legLabel(leg), score: scored.score, reason: scored.reason };
    } catch (e) {
      const timed = e instanceof Error && e.message === 'timeout';
      return miss(leg, timed ? 'game log timed out' : 'game log unavailable');
    }
  }
  if (leg.type === 'spread' && leg.line == null) return miss(leg, 'no line on this leg');
  if (leg.type === 'total' && (leg.line == null || !leg.side)) return miss(leg, 'no line on this leg');
  if (leg.type === 'ml' && !leg.team) return miss(leg, 'no team on this leg');
  let quote: MarketQuote | null = null;
  if (leg.event_id) {
    try { quote = await withTimeout(marketFor(leg.league, leg.event_id), Math.min(LEG_TIMEOUT_MS, Math.max(1, deadline - Date.now()))); }
    catch { quote = null; }
  }
  if (leg.type === 'spread') {
    const s = scoreSpread(leg.line!, quoteFor(leg.team, quote, 'spread'));
    return { label: legLabel(leg), ...s };
  }
  if (leg.type === 'total') {
    const s = scoreTotal(leg.side!, leg.line!, quoteFor(null, quote, 'total'));
    return { label: legLabel(leg), ...s };
  }
  const s = scoreMoneyline(quoteFor(leg.team, quote, 'ml'), leg.odds);
  return { label: legLabel(leg), ...s };
}

/** Score already-resolved legs. Does not call the model and does not save anything. */
export async function rateResolvedLegs(espn: Espn, legs: RatableLeg[]): Promise<LegRating[]> {
  const deadline = Date.now() + RATE_BUDGET_MS;
  const markets = new Map<string, Promise<MarketQuote | null>>();
  const marketFor = (league: string, eventId: string) => {
    const k = `${league}:${eventId}`;
    let p = markets.get(k);
    if (!p) {
      p = (async () => {
        const s = await espn.summary(league, eventId);
        const g = gameFromSummary(league, s.data);
        if (!g) return null;
        return marketFromSummary(s.data, g.home.abbr, g.away.abbr);
      })().catch(() => null);
      markets.set(k, p);
    }
    return p;
  };
  return pool(legs, FETCH_CONCURRENCY, (leg) => rateOne(espn, leg, marketFor, deadline));
}

const SUMMARY_SYSTEM = `You write a 2-3 sentence note about a parlay rating.
Use ONLY the numbers, labels and reasons in the user JSON. Do not add injuries, news, weather, rest, matchup history, or any fact that is not in the JSON.
Do not change the scores. If a leg has a null score, say it was not scored. No preamble and no betting advice.`;

/** Optional 2–3 sentence note. Missing key or any failure returns null and is not logged. */
export async function ratingSummary(r: ParlayRating, xai: XaiOpts | null | undefined): Promise<string | null> {
  if (!xai?.apiKey) return null;
  if (r.legs.every((l) => l.score == null) && r.overall == null) return null;
  const payload = {
    overall: r.overall,
    weakest: r.weakest,
    legs: r.legs.map((l) => ({ label: l.label, score: l.score, reason: l.reason })),
  };
  try {
    const text = await completeText(SUMMARY_SYSTEM, JSON.stringify(payload), { ...xai, timeoutMs: xai.timeoutMs ?? 12_000 });
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, 600) : null;
  } catch {
    return null;
  }
}

export async function rateSlip(espn: Espn, legs: RatableLeg[], xai?: XaiOpts | null): Promise<ParlayRating> {
  const rated = await rateResolvedLegs(espn, legs);
  const { overall, weakest } = scoreParlay(rated);
  const rating: ParlayRating = { legs: rated, overall, weakest, summary: null };
  rating.summary = await ratingSummary(rating, xai);
  return rating;
}

/** Parse/resolve is injected so this stays free of the Resolver. Blank lines and resolve errors become unscored legs. Nothing is saved. */
export async function ratePasted(
  espn: Espn,
  resolve: (text: string) => Promise<RatableLeg>,
  lines: string[],
  xai?: XaiOpts | null,
): Promise<ParlayRating> {
  const slots: ({ leg: RatableLeg } | { fail: LegRating })[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) { slots.push({ fail: { label: '(blank leg)', score: null, reason: 'could not read this leg' } }); continue; }
    try { slots.push({ leg: await resolve(text) }); }
    catch (e) {
      const reason = (e instanceof Error ? e.message : 'could not match this leg').replace(/\s+/g, ' ').slice(0, 200);
      slots.push({ fail: { label: text.slice(0, 80), score: null, reason } });
    }
  }
  const ok = slots.flatMap((s) => ('leg' in s ? [s.leg] : []));
  const rated = await rateResolvedLegs(espn, ok);
  let i = 0;
  const legs = slots.map((s) => ('fail' in s ? s.fail : rated[i++]!));
  const { overall, weakest } = scoreParlay(legs);
  const rating: ParlayRating = { legs, overall, weakest, summary: null };
  rating.summary = await ratingSummary(rating, xai);
  return rating;
}
