// API payload builders. This is the ONLY place slip/leg data is shaped for the outside world,
// and hidden legs are stripped here — nothing downstream ever sees them.
import type { DatabaseSync } from 'node:sqlite';
import type { Leg, Slip } from './db.ts';
import { LEAGUES, type Espn, type FeedHealth, type Game } from './espn.ts';
import type { Engine } from './engine.ts';
import { paceFor, toWin } from './grading.ts';
import { statLabel } from './stats.ts';
import { isPublic } from './store.ts';
import { addDays, americanToDecimal, dayInTz, fmtOdds, normName, round2 } from './util.ts';

export interface Ctx { db: DatabaseSync; espn: Espn; engine: Engine; tz: string; leagues: string[]; demo: boolean; bot: () => { status: string; detail: string | null; tag: string | null } }

export function legText(l: Pick<Leg, 'type' | 'player' | 'team' | 'side' | 'line' | 'stat' | 'league' | 'event_name'>): string {
  const sideTxt = l.side === 'over' ? 'o' : 'u';
  switch (l.type) {
    case 'prop': if (l.line == null || !l.side) return `${l.player ?? '?'} ${statLabel(l.league, l.stat)}`.trim();
      return l.line === 0.5 && l.side === 'over' && ['td', 'goals', 'hr'].includes(l.stat ?? '') ? `${l.player} ${l.stat === 'td' ? 'anytime TD' : l.stat === 'hr' ? 'to homer' : 'to score'}` : `${l.player} ${sideTxt}${l.line} ${statLabel(l.league, l.stat)}`;
    case 'spread': return `${l.team} ${l.line === 0 ? 'PK' : (l.line! > 0 ? '+' : '') + l.line}`;
    case 'total': return `${l.event_name ?? ''} ${sideTxt}${l.line}`.trim();
    case 'ml': return `${l.team} ML`;
  }
}

const LEG_WORD: Record<string, string> = { pending: 'waiting', won: 'hit', lost: 'miss', push: 'push', void: 'void', review: 'check' };
export function headshot(l: Pick<Leg, 'league' | 'athlete_id'>): string | null {
  const sport = LEAGUES[l.league]?.sport;
  if (!l.athlete_id || !sport) return null;
  const path = l.league === 'nfl' ? 'nfl' : l.league === 'nhl' ? 'nhl' : l.league === 'mlb' ? 'mlb' : l.league === 'wnba' ? 'wnba' : l.league === 'nba' ? 'nba' : null;
  return path ? `https://a.espncdn.com/i/headshots/${path}/players/full/${l.athlete_id}.png` : null;
}
/** "Player over 20.5 Points" — the ticket row text. */
export function ticketLegText(l: Pick<Leg, 'type' | 'player' | 'team' | 'side' | 'line' | 'stat' | 'league' | 'event_name'>): string {
  if (l.type === 'prop' && l.player && l.side && l.line != null) return `${l.player} ${l.side} ${l.line} ${statLabel(l.league, l.stat)}`.trim();
  return legText(l);
}
/** Ticket summary. Status line, hit count and net all come from the same rows, so they can't contradict each other. */
export function ticket(slip: Slip, legs: Leg[]) {
  const hits = legs.filter((l) => l.status === 'won').length;
  const graded = legs.filter((l) => l.status !== 'pending').length;
  const settled = ['won', 'lost', 'push', 'void'].includes(slip.status);
  const pays = slip.status === 'won' && slip.profit != null ? round2(slip.stake + slip.profit)
    : slip.status === 'open' || slip.status === 'review' ? slip.payout ?? (slip.odds != null ? round2(slip.stake * americanToDecimal(slip.odds)) : null)
    : slip.status === 'lost' ? 0 : slip.stake;
  const statusLine = slip.status === 'open' ? 'OPEN' : slip.status === 'review' ? 'NEEDS REVIEW'
    : `SETTLED · ${slip.status === 'won' ? 'CASHED' : slip.status === 'lost' ? 'LOST' : slip.status === 'push' ? 'PUSH · STAKE BACK' : 'VOID · STAKE BACK'}`;
  const pt = (slip.play_type ?? '').toLowerCase();
  return {
    book: slip.book, playType: slip.play_type, playBadge: pt.includes('flex') ? 'FLEX' : pt.includes('power') ? 'POWER PLAY' : slip.play_type ? slip.play_type.toUpperCase() : null,
    sports: [...new Set(legs.map((l) => LEAGUES[l.league]?.label ?? l.league.toUpperCase()))],
    legCount: legs.length, hits, graded, risk: slip.stake, pays, net: settled ? slip.profit : null,
    statusLine, oddsAsLogged: slip.odds_text ?? (slip.odds != null ? fmtOdds(slip.odds) : null), isTest: !!slip.is_test,
  };
}

function publicLeg(l: Leg, ctx: Ctx) {
  const snap = l.event_id ? ctx.engine.snaps.get(l.event_id) : undefined;
  const pace = snap ? paceFor(l, snap.game, snap.box) : null;
  return {
    id: l.id, league: l.league, leagueLabel: LEAGUES[l.league]?.label ?? l.league, type: l.type, text: legText(l), raw: l.raw,
    player: l.player, team: l.team, stat: l.stat, statLabel: statLabel(l.league, l.stat), side: l.side, line: l.line, odds: l.odds, oddsText: fmtOdds(l.odds),
    status: l.status, statusWord: LEG_WORD[l.status] ?? l.status, actual: l.actual, detail: l.detail, ticketText: ticketLegText(l), headshot: headshot(l),
    event: l.event_id ? { id: l.event_id, name: l.event_name, start: l.start_time, state: snap?.game.state ?? null, detail: snap?.game.detail ?? null } : null,
    pace,
  };
}

/**
 * Where a slip's screenshot lives on Discord, if it came from one. We never store the image — only this pointer.
 * Photo imports save channel_id + message_id; older rows may only have the message link in source_url.
 * /pick slips have a channel but no message id, so they return null.
 */
export function slipImageRef(slip: Pick<Slip, 'channel_id' | 'message_id' | 'source_url'>): { channelId: string; messageId: string } | null {
  if (slip.channel_id && slip.message_id) return { channelId: slip.channel_id, messageId: slip.message_id };
  const m = slip.source_url?.match(/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)\/?$/);
  return m ? { channelId: m[1], messageId: m[2] } : null;
}

// ---------- Open-slip filters (book / sport buckets) ----------
export type BookBucket = 'prizepicks' | 'kalshi' | 'other';
const norm = (v: string | null | undefined) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** Book tab for a slip: PrizePicks ("PrizePicks", "prize picks", "PP"), Kalshi, or Other (anything else, incl. unknown / /pick). */
export function bookBucket(book: string | null | undefined, legLeagues: (string | null | undefined)[] = []): BookBucket {
  const b = norm(book);
  if (b === 'prizepicks' || b === 'pp') return 'prizepicks';
  if (b === 'kalshi' || (!b && legLeagues.some((l) => norm(l) === 'kalshi'))) return 'kalshi';
  return 'other';
}
export const SPORT_TABS = ['nba', 'mlb', 'wnba', 'tennis', 'nfl', 'nbl'] as const;
const SPORT_ALIAS: Record<string, string> = { nbap: 'nba', nba1h: 'nba', nba1q: 'nba', mlbp: 'mlb', nflp: 'nfl', nfl1h: 'nfl', wnbap: 'wnba', atp: 'tennis', wta: 'tennis', ten: 'tennis', tennisp: 'tennis' };
/**
 * Sports on a slip, from each leg's league (ESPN key for resolved legs, or the screenshot's tag like "TENNIS"/"NBL").
 * Lowercase, de-duplicated; a multi-sport slip lists every sport. Unknown/blank leagues are skipped.
 */
export function slipSports(legLeagues: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const l of legLeagues) { const k = norm(l); if (k && k !== 'other' && k !== 'kalshi') out.add(SPORT_ALIAS[k] ?? k); }
  return [...out];
}

export function slipView(slip: Slip, legs: Leg[], ctx: Ctx) {
  const pub = isPublic(slip);
  const base = {
    id: slip.id, user: slip.user_name, userId: slip.user_id, title: slip.title, stake: slip.stake, status: slip.status, profit: slip.profit,
    createdAt: slip.created_at, settledAt: slip.settled_at, demo: !!slip.is_demo, test: !!slip.is_test, hidden: !pub, wasHidden: !!slip.hidden, book: slip.book,
    legCount: legs.length,
    /** Screenshot slip whose image can be fetched from Discord on demand (never for hidden slips or /pick entries). */
    hasImage: pub && !!slipImageRef(slip),
    bookKey: bookBucket(slip.book, pub ? legs.map((l) => l.league) : []),
    /** Hidden slips expose no sport (it would hint at the legs); they only show under "All". */
    sports: pub ? slipSports(legs.map((l) => l.league)) : [] as string[],
    progress: { won: legs.filter((l) => l.status === 'won').length, lost: legs.filter((l) => l.status === 'lost').length, pending: legs.filter((l) => l.status === 'pending').length },
  };
  if (!pub) return { ...base, progress: { won: 0, lost: 0, pending: legs.length }, odds: null, oddsText: '', toWin: null, note: null, legs: [] as ReturnType<typeof publicLeg>[], ticket: null as ReturnType<typeof ticket> | null, firstStart: null };
  return {
    ...base, odds: slip.odds, oddsText: fmtOdds(slip.odds), toWin: toWin(slip, legs), note: slip.note,
    legs: legs.map((l) => publicLeg(l, ctx)), ticket: ticket(slip, legs),
    firstStart: legs.map((l) => l.start_time).filter(Boolean).sort()[0] ?? null,
  };
}

function loadSlips(ctx: Ctx, where: string, args: (string | number)[] = []): { slip: Slip; legs: Leg[] }[] {
  const slips = ctx.db.prepare(`SELECT * FROM slips WHERE ${where}`).all(...args) as unknown as Slip[];
  if (!slips.length) return [];
  const legs = ctx.db.prepare(`SELECT * FROM legs WHERE slip_id IN (${slips.map(() => '?').join(',')}) ORDER BY idx`).all(...slips.map((s) => s.id)) as unknown as Leg[];
  const by = new Map<string, Leg[]>();
  for (const l of legs) (by.get(l.slip_id) ?? by.set(l.slip_id, []).get(l.slip_id)!).push(l);
  return slips.map((slip) => ({ slip, legs: by.get(slip.id) ?? [] }));
}

const gameView = (g: Game) => ({
  id: g.id, league: g.league, leagueLabel: LEAGUES[g.league]?.label ?? g.league, name: g.name, shortName: g.shortName, start: g.start, state: g.state, completed: g.completed,
  detail: g.detail, period: g.period, clock: g.displayClock, broadcast: g.broadcast, odds: g.odds,
  home: g.home, away: g.away, fetchedAt: g.fetchedAt,
});

// ---------- Live ----------
export async function liveView(ctx: Ctx, includeAll: boolean) {
  const since = new Date(Date.now() - 18 * 3600_000).toISOString();
  const rows = loadSlips(ctx, `status = 'open' OR settled_at >= ? OR id IN (SELECT slip_id FROM legs WHERE start_time >= ?)`, [since, since]);
  const byEvent = new Map<string, { leg: ReturnType<typeof publicLeg>; slipId: string; user: string; demo: boolean }[]>();
  let hiddenLegs = 0;
  for (const { slip, legs } of rows) {
    if (!isPublic(slip)) { hiddenLegs += legs.filter((l) => l.status === 'pending').length; continue; }
    for (const l of legs) {
      if (!l.event_id) continue;
      const arr = byEvent.get(l.event_id) ?? [];
      arr.push({ leg: publicLeg(l, ctx), slipId: slip.id, user: slip.user_name, demo: !!slip.is_demo });
      byEvent.set(l.event_id, arr);
    }
  }
  const games = [] as any[];
  for (const [eventId, legs] of byEvent) {
    const snap = ctx.engine.snaps.get(eventId);
    if (!snap) { games.push({ id: eventId, pending: true, name: legs[0].leg.event?.name, start: legs[0].leg.event?.start, league: legs[0].leg.league, legs }); continue; }
    games.push({ ...gameView(snap.game), stale: snap.stale, error: snap.error, legs });
  }
  const order = { in: 0, pre: 1, post: 2 } as Record<string, number>;
  games.sort((a, b) => (order[a.state ?? 'pre'] - order[b.state ?? 'pre']) || String(a.start).localeCompare(String(b.start)));
  let slate: any[] = [];
  const slateErrors: { league: string; error: string }[] = [];
  if (includeAll) {
    const day = dayInTz(new Date(), ctx.tz);
    const res = await Promise.all(ctx.leagues.map(async (lg) => {
      try { const r = await ctx.espn.scoreboard(lg, day); return r.games.map((g) => ({ ...gameView(g), stale: r.stale })); }
      catch (e) { slateErrors.push({ league: lg, error: (e as Error).message }); return []; }
    }));
    slate = res.flat().filter((g) => !byEvent.has(g.id)).sort((a, b) => (order[a.state] - order[b.state]) || a.start.localeCompare(b.start));
  }
  return { asOf: Date.now(), source: 'ESPN public scoreboard & box score JSON', games, slate, slateErrors, hiddenLegs, engine: ctx.engine.lastTick };
}

// ---------- Board ----------
export function leaderboard(ctx: Ctx, period: string) {
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === 'today' ? 1 : null;
  const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : '0';
  const rows = ctx.db.prepare(`SELECT user_id, user_name, status, stake, profit, is_demo FROM slips WHERE status IN ('won','lost','push','void') AND profit IS NOT NULL AND is_test = 0 AND settled_at >= ? ORDER BY settled_at`).all(since) as any[];
  const m = new Map<string, any>();
  for (const r of rows) {
    const u = m.get(r.user_id) ?? { userId: r.user_id, user: r.user_name, profit: 0, staked: 0, w: 0, l: 0, p: 0, slips: 0, streak: '', demo: !!r.is_demo, last: [] as string[] };
    u.user = r.user_name; u.profit += r.profit; u.slips++;
    if (r.status === 'won') u.w++; else if (r.status === 'lost') u.l++; else u.p++;
    if (r.status === 'won' || r.status === 'lost') { u.staked += r.stake; u.last.push(r.status === 'won' ? 'W' : 'L'); }
    m.set(r.user_id, u);
  }
  const list = [...m.values()].map((u) => {
    const last = u.last as string[];
    let n = 0; const t = last[last.length - 1];
    for (let i = last.length - 1; i >= 0 && last[i] === t; i--) n++;
    return { ...u, profit: round2(u.profit), staked: round2(u.staked), roi: u.staked ? round2((u.profit / u.staked) * 100) : 0, streak: t ? `${t}${n}` : '', last: last.slice(-10) };
  });
  list.sort((a, b) => b.profit - a.profit || b.roi - a.roi || a.user.localeCompare(b.user));
  return list.map((u, i) => ({ rank: i + 1, ...u }));
}

// ---------- Profit over time ----------
export interface ProfitPoint { t: string; slipId: string; status: string; delta: number; cum: number; approxTime: boolean }
/**
 * Cumulative profit per member from settled, non-test slips, ordered by settle time (created time when a row has no
 * settled_at — flagged approxTime). Pushes/voids add a 0-change point. Grouped by Discord user id, latest display name.
 */
export function profitSeries(ctx: Ctx, userId?: string | null) {
  const rows = ctx.db.prepare(`SELECT id, user_id, user_name, status, profit, is_demo, settled_at, created_at, coalesce(settled_at, created_at) AS t FROM slips
    WHERE status IN ('won','lost','push','void') AND profit IS NOT NULL AND is_test = 0 ${userId ? 'AND user_id = ?' : ''} ORDER BY t, id`).all(...(userId ? [userId] : [])) as any[];
  const m = new Map<string, { userId: string; user: string; demo: boolean; profit: number; points: ProfitPoint[] }>();
  for (const r of rows) {
    const u = m.get(r.user_id) ?? { userId: r.user_id, user: r.user_name, demo: !!r.is_demo, profit: 0, points: [] as ProfitPoint[] };
    const delta = r.status === 'won' || r.status === 'lost' ? round2(r.profit) : 0;
    u.user = r.user_name; u.profit = round2(u.profit + delta);
    u.points.push({ t: r.t, slipId: r.id, status: r.status, delta, cum: u.profit, approxTime: !r.settled_at });
    m.set(r.user_id, u);
  }
  return { asOf: Date.now(), users: [...m.values()].sort((a, b) => b.profit - a.profit || a.user.localeCompare(b.user)) };
}

export function boardView(ctx: Ctx, period: string) {
  const today = dayInTz(new Date(), ctx.tz);
  const open = loadSlips(ctx, `status IN ('open','review') ORDER BY created_at DESC LIMIT 200`).map(({ slip, legs }) => slipView(slip, legs, ctx));
  const recent = loadSlips(ctx, `status NOT IN ('open','review') AND settled_at >= ? ORDER BY settled_at DESC LIMIT 40`, [new Date(Date.now() - 7 * 86400_000).toISOString()]).map(({ slip, legs }) => slipView(slip, legs, ctx));
  // Tonight's poster: pinned by an admin for today, else the public open slip with the biggest to-win that starts today.
  let poster: any = null;
  const pinned = loadSlips(ctx, `poster_day = ?`, [today])[0];
  if (pinned && isPublic(pinned.slip)) poster = { ...slipView(pinned.slip, pinned.legs, ctx), pinned: true };
  else {
    const cands = open.filter((s) => !s.hidden && s.status === 'open' && s.firstStart && dayInTz(new Date(s.firstStart), ctx.tz) === today);
    cands.sort((a, b) => (b.toWin ?? 0) - (a.toWin ?? 0));
    if (cands[0]) poster = { ...cands[0], pinned: false };
  }
  const totals = ctx.db.prepare(`SELECT count(*) AS n, sum(CASE WHEN status='won' THEN 1 ELSE 0 END) AS w, sum(CASE WHEN status='lost' THEN 1 ELSE 0 END) AS l, round(coalesce(sum(profit),0),2) AS profit FROM slips WHERE status IN ('won','lost','push','void') AND is_test = 0`).get() as any;
  return { asOf: Date.now(), today, open, recent, poster, leaderboard: leaderboard(ctx, period), period, totals };
}

// ---------- News & health ----------
export async function newsView(ctx: Ctx) {
  const rows = loadSlips(ctx, `status = 'open'`).filter((r) => isPublic(r.slip));
  const players = new Map<string, { league: string; name: string; athleteId: string | null; team: string | null; slips: string[] }>();
  const teams = new Map<string, { league: string; team: string; slips: string[] }>();
  for (const { slip, legs } of rows) for (const l of legs) {
    if (l.status !== 'pending') continue;
    if (l.type === 'prop' && l.player) {
      const k = `${l.league}:${l.athlete_id ?? normName(l.player)}`;
      const p = players.get(k) ?? { league: l.league, name: l.player, athleteId: l.athlete_id, team: l.team, slips: [] };
      p.slips.push(slip.id); players.set(k, p);
    } else if (l.team) {
      const k = `${l.league}:${l.team}`;
      const t = teams.get(k) ?? { league: l.league, team: l.team, slips: [] };
      t.slips.push(slip.id); teams.set(k, t);
    }
  }
  const leagues = [...new Set([...players.values(), ...teams.values()].map((x) => x.league))];
  const feeds: Record<string, { ok: boolean; at: number | null; stale: boolean; error: string | null }> = {};
  const injuries: any[] = [];
  await Promise.all(leagues.map(async (lg) => {
    try {
      const r = await ctx.espn.injuries(lg);
      feeds[lg] = { ok: true, at: r.at, stale: r.stale, error: null };
      for (const t of r.data?.injuries ?? []) for (const i of t.injuries ?? []) {
        const href: string = i.athlete?.links?.[0]?.href ?? '';
        const aid = href.match(/\/id\/(\d+)/)?.[1] ?? null;
        const name: string = i.athlete?.displayName ?? '';
        const teamAbbr: string = i.athlete?.team?.abbreviation ?? '';
        const p = [...players.values()].find((p) => p.league === lg && ((p.athleteId && p.athleteId === aid) || normName(p.name) === normName(name)));
        const tm = teams.get(`${lg}:${teamAbbr}`);
        const severe = /out|doubtful|questionable|day-to-day|injured reserve/i.test(i.status ?? '');
        if (!p && !(tm && severe)) continue;
        injuries.push({
          league: lg, leagueLabel: LEAGUES[lg].label, player: name, team: teamAbbr || t.displayName, status: i.status, date: i.date,
          short: i.shortComment ?? null, long: i.longComment ?? null, type: i.details?.type ?? null, returnDate: i.details?.returnDate ?? null,
          onSlip: !!p, slips: p ? p.slips : tm!.slips, via: p ? 'player on slip' : `team on slip (${teamAbbr})`, source: 'ESPN injuries',
        });
      }
    } catch (e) { feeds[lg] = { ok: false, at: null, stale: false, error: (e as Error).message }; }
  }));
  injuries.sort((a, b) => Number(b.onSlip) - Number(a.onSlip) || String(b.date).localeCompare(String(a.date)));
  const tracked = [...players.values()].map((p) => ({ ...p, hasNote: injuries.some((i) => i.onSlip && normName(i.player) === normName(p.name)) }));
  return { asOf: Date.now(), injuries, tracked, feeds };
}

export function healthView(ctx: Ctx) {
  const now = Date.now();
  const status = (h: FeedHealth) => h.ok === null ? 'idle' : !h.ok ? 'down' : h.lastOkAt && now - h.lastOkAt > 30 * 60_000 ? 'idle' : 'ok';
  const feeds = ctx.espn.healthList().map((h) => ({ ...h, status: status(h), ageMs: h.lastOkAt ? now - h.lastOkAt : null }));
  let dbOk = true;
  try { ctx.db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  const tick = ctx.engine.lastTick;
  const bot = ctx.bot();
  const overall = !dbOk || feeds.some((f) => f.status === 'down') ? 'degraded' : 'ok';
  return {
    asOf: now, overall, demo: ctx.demo,
    components: [
      { name: 'Database (SQLite)', status: dbOk ? 'ok' : 'down', detail: dbOk ? 'reads OK' : 'query failed' },
      { name: 'Grading engine', status: tick ? (tick.error ? 'degraded' : 'ok') : 'idle', detail: tick ? `last run ${Math.round((now - tick.at) / 1000)}s ago · ${tick.events} event(s) · ${tick.ms}ms${tick.error ? ' · ' + tick.error : ''}` : 'not run yet' },
      { name: 'Discord bot', status: bot.status, detail: bot.detail },
    ],
    feeds,
  };
}

export function upcomingDays(tz: string, n: number) { const t = dayInTz(new Date(), tz); return Array.from({ length: n }, (_, i) => addDays(t, i)); }
