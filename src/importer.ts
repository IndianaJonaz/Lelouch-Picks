// Import a slip that may already be settled (admin API, Discord screenshots).
// Legs are matched to ESPN games, graded from box scores right away, and only then is a
// known slip result applied — so legs show real outcomes, not "Manually settled".
import { createHash } from 'node:crypto';
import type { Leg, LegStatus, Slip, SlipStatus } from './db.ts';
import { getLegs, getSlip } from './db.ts';
import { LEAGUES } from './espn.ts';
import { ParseError, parseLeg, type ParsedLeg } from './parse.ts';
import type { Resolver, ResolvedLeg } from './resolve.ts';
import { findInBox, findStat, parseBox, statValue } from './stats.ts';
import { createSlip, manualSettle, SlipError } from './store.ts';
import { consistencyProblems } from './grading.ts';
import { addDays, dayInTz } from './util.ts';
import type { Ctx } from './views.ts';

export type FinalStatus = Exclude<SlipStatus, 'open' | 'review'>;
export interface LegHint {
  actual?: number | null;
  result?: LegStatus | null;          // what the screenshot says (used only for legs ESPN can't grade)
  scores?: { team: string; score: number }[] | null; // e.g. BKN 128 / MIA 144 printed on the slip
  leagueLabel?: string | null;        // e.g. "LoL", shown for legs we can't match
  statLabel?: string | null;          // stat as printed, shown for legs we can't match
}
export interface ImportLeg { text?: string; parsed?: ParsedLeg; hint?: LegHint }
export interface ImportOpts {
  userId: string; userName: string; title?: string | null; stake: number; odds?: number | null; hidden?: boolean; note?: string | null;
  source: string; guildId?: string | null; channelId?: string | null; messageId?: string | null;
  /** YYYY-MM-DD of the games. Finished games on that day are allowed. */
  date?: string | null;
  /** Settled slip: search finished games back from this day when no date is known. */
  searchBackFrom?: string | null;
  searchBackDays?: number;
  result?: { status: FinalStatus; profit: number } | null;
  /** Keep legs we can't match to ESPN (esports, unsupported stats) as manual legs instead of failing. */
  allowUnresolved?: boolean;
  dedupeKeys?: string[];
  book?: string | null; playType?: string | null; oddsText?: string | null; payout?: number | null; isTest?: boolean; sourceUrl?: string | null;
}
export interface ImportResult { slip: Slip; legs: Leg[]; unresolved: number; problems: string[] }

export class DuplicateSlipError extends SlipError {
  slipId: string;
  constructor(slipId: string) { super(`Already on the board as \`${slipId}\`.`); this.slipId = slipId; }
}

const RESULTS = new Set<FinalStatus>(['won', 'lost', 'push', 'void']);
export const isFinalStatus = (s: unknown): s is FinalStatus => RESULTS.has(s as FinalStatus);

export function sha256(x: string | Uint8Array) { return createHash('sha256').update(x).digest('hex'); }

export function findDuplicate(ctx: Ctx, userId: string, keys: string[]): string | null {
  for (const k of keys) {
    const r = ctx.db.prepare('SELECT slip_id FROM slip_imports WHERE user_id = ? AND k = ?').get(userId, k) as { slip_id: string } | undefined;
    if (r) return r.slip_id;
  }
  return null;
}

async function verify(ctx: Ctx, rl: ResolvedLeg, day: string, hint: LegHint | undefined, needFinal: boolean): Promise<boolean> {
  const sb = await ctx.espn.scoreboard(rl.league, day).catch(() => null);
  const g = sb?.games.find((x) => x.id === rl.event_id);
  if (!g) return false;
  if (needFinal && g.state !== 'post') return false;
  const sc = hint?.scores?.filter((s) => Number.isFinite(s.score)) ?? [];
  if (sc.length === 2) {
    const want = sc.map((s) => s.score).sort((a, b) => a - b).join('-');
    const have = [g.home.score ?? -1, g.away.score ?? -1].sort((a, b) => a - b).join('-');
    return want === have;
  }
  if (hint?.actual != null && rl.type === 'prop' && rl.stat) {
    const s = await ctx.espn.summary(rl.league, rl.event_id!).catch(() => null);
    if (!s) return true;
    const p = findInBox(parseBox(rl.league, s.data), rl.athlete_id, rl.player);
    if (!p) return true; // can't check; accept
    return statValue(rl.league, rl.stat, p) === hint.actual;
  }
  return true;
}

async function resolveOne(ctx: Ctx, resolver: Resolver, p: ParsedLeg, o: ImportOpts, hint?: LegHint): Promise<ResolvedLeg> {
  if (p.type === 'prop' && p.league && p.statText && !findStat(p.league, p.statText)) throw new ParseError(`Unknown ${p.league.toUpperCase()} stat "${p.statText}".`);
  const base = { tz: ctx.tz, leagues: ctx.leagues };
  const settled = !!o.result;
  let days: string[] | null = null;
  if (o.date) days = settled ? [o.date, addDays(o.date, -1), addDays(o.date, 1)] : [o.date];
  else if (settled) {
    const from = o.searchBackFrom ?? dayInTz(new Date(), ctx.tz);
    days = Array.from({ length: (o.searchBackDays ?? 21) + 1 }, (_, i) => addDays(from, -i));
  }
  if (!days) return resolver.resolveParsed(p, base); // open slip: upcoming / live games
  // Admin import with an explicit date and no screenshot hints: keep the simple one-day behaviour.
  if (o.date && !hint) return resolver.resolveParsed(p, { ...base, days: [o.date], allowFinal: true });
  let lastErr: Error | null = null;
  for (const day of days) {
    try {
      const rl = await resolver.resolveParsed(p, { ...base, days: [day], allowFinal: true });
      if (await verify(ctx, rl, day, hint, settled)) return rl;
    } catch (e) { if (!(e instanceof ParseError)) throw e; lastErr = e; }
  }
  throw lastErr ?? new ParseError(`Couldn't match "${p.raw}" to a finished game.`);
}

function manualLeg(p: ParsedLeg, hint?: LegHint): ResolvedLeg {
  const league = (p.league ?? hint?.leagueLabel ?? 'other').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'other';
  const m = p.subject.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return { league, event_id: null, event_name: null, start_time: null, type: 'prop', team: m ? m[2].trim() : null, player: m ? m[1].trim() : p.subject,
    athlete_id: null, stat: hint?.statLabel ?? p.statText, side: p.side, line: p.line, odds: null, raw: p.raw };
}

export async function importSlip(ctx: Ctx, resolver: Resolver, input: ImportLeg[], o: ImportOpts): Promise<ImportResult> {
  if (o.result && !isFinalStatus(o.result.status)) throw new SlipError('result needs status won|lost|push|void.');
  if (o.result && !Number.isFinite(o.result.profit)) throw new SlipError('result needs a numeric profit.');
  if (o.date && !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new SlipError('date must be YYYY-MM-DD.');
  const keys = o.dedupeKeys ?? [];
  const dup = findDuplicate(ctx, o.userId, keys);
  if (dup) throw new DuplicateSlipError(dup);

  const resolved: ResolvedLeg[] = [];
  const manual: { idx: number; hint?: LegHint }[] = [];
  for (const [i, l] of input.entries()) {
    const p = l.parsed ?? parseLeg(String(l.text ?? ''));
    const knownLeague = !p.league || LEAGUES[p.league];
    try {
      if (!knownLeague) throw new ParseError(`${p.league} isn't on ESPN`);
      resolved.push(await resolveOne(ctx, resolver, p, o, l.hint));
    } catch (e) {
      if (!(e instanceof ParseError) || !o.allowUnresolved) throw e;
      resolved.push(manualLeg(p, l.hint));
      manual.push({ idx: i, hint: l.hint });
    }
  }
  if (manual.length === resolved.length && !o.result) throw new SlipError('None of these legs match a game I can track — post it with /pick instead.');

  const slip = createSlip(ctx.db, {
    user_id: o.userId, user_name: o.userName, title: o.title ?? null, stake: o.stake, odds: o.odds ?? null, hidden: !!o.hidden, note: o.note ?? null,
    source: o.source, guild_id: o.guildId ?? null, channel_id: o.channelId ?? null, message_id: o.messageId ?? null, oddsOptional: !!o.result,
    book: o.book ?? null, play_type: o.playType ?? null, odds_text: o.oddsText ?? null, payout: o.payout ?? null, is_test: !!o.isTest, source_url: o.sourceUrl ?? null,
  }, resolved);
  for (const k of keys) ctx.db.prepare('INSERT OR IGNORE INTO slip_imports (user_id, k, slip_id) VALUES (?, ?, ?)').run(o.userId, k, slip.id);

  // Legs ESPN can't grade: take the screenshot's result for settled slips, otherwise flag for review.
  const legs = getLegs(ctx.db, slip.id);
  for (const m of manual) {
    const leg = legs[m.idx];
    const r = m.hint?.result;
    const status: LegStatus = o.result && r && ['won', 'lost', 'push', 'void'].includes(r) ? r : 'review';
    ctx.db.prepare(`UPDATE legs SET status = ?, actual = ?, detail = ?, graded_at = CASE WHEN ? != 'review' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id = ?`)
      .run(status, m.hint?.actual ?? null, status === 'review' ? 'Not on ESPN — needs a manual grade' : 'From the slip screenshot', status, leg.id);
  }

  await ctx.engine.gradeSlipLegs(slip.id);
  let problems: string[] = [];
  if (o.result) {
    // Never store a result that contradicts the graded legs (e.g. WIN with 0 hits): park it for an admin instead.
    const graded = getLegs(ctx.db, slip.id).map((l) => ({ status: l.status === 'pending' || l.status === 'review' ? 'void' as const : l.status }));
    problems = consistencyProblems({ status: o.result.status, profit: o.result.profit, play_type: o.playType ?? null }, graded);
    if (problems.length) {
      ctx.db.prepare("UPDATE slips SET status = 'review', profit = NULL, note = trim(coalesce(note,'') || ' [needs review: ' || ? || ']') WHERE id = ?").run(`slip says ${o.result.status} ${o.result.profit}; ${problems.join('; ')}`, slip.id);
    } else manualSettle(ctx.db, slip.id, o.result.status, o.result.profit);
  } else ctx.engine.settle(slip.id);
  ctx.engine.poke();
  const out = getLegs(ctx.db, slip.id);
  return { slip: getSlip(ctx.db, slip.id)!, legs: out, unresolved: manual.length, problems };
}
