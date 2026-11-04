// "All sports betting predictions" consensus for one prop leg, from free public market data.
// Pure parsing/scoring sits at the top (unit-tested); the HTTP feed sits at the bottom.
//
// Sources (all plain HTTPS JSON, no browser, no login):
//   1. DraftKings player props as republished by ESPN's public core API (no key):
//        sports.core.api.espn.com/v2/sports/{sport}/leagues/{league}/events/{id}/competitions/{id}/odds/100/propBets
//      • Two-way "Total X" market at exactly your line → no-vig probability for your side:
//          p_side = imp(side) / (imp(over) + imp(under))
//        ESPN does not label the two rows. The over is the row whose price is closer to the "N+" milestone at
//        floor(line)+1 when one exists; otherwise the first row (ESPN lists over first; 45/45 pairs checked 2026-11-04).
//      • Otherwise a one-sided "X Milestones" N+ price where N = floor(line)+1 (x.5 lines only):
//          over  p = imp(N+)          under p = 1 − imp(N+)
//        Milestones include the book's margin, so these lean slightly toward the over. Shown as "alt".
//      • Anytime TD / goal (over 0.5) uses the "Anytime … Scorer" price, also margin-inclusive.
//   2. Kalshi player-prop markets (public market-data API, no key; NBA points/reb/ast/3PM/stl/blk/PRA):
//        p = mid of best YES bid and ask on the "N+" market whose floor_strike equals your x.5 line,
//        only when both sides are quoted and the spread is ≤ 15¢ (thin books are skipped). Under = 1 − p.
//   3. The Odds API (optional, only when ODDS_API_KEY is set — the free tier is 500 credits/month):
//        every US book with both sides at exactly your line → no-vig p per book, then the mean.
//
// Consensus probability = mean of the sources that priced the leg (each source counts once).
// Consensus score (1–10) = clamp(round(10 × p), 1, 10): 50% → 5, 62% → 6, 38% → 4.
// A leg no source prices is "n/a" — never a guessed number.
import { LEAGUES } from './espn.ts';
import { sportOf } from './stats.ts';
import { normName } from './util.ts';


export interface MarketSource { name: string; p: number; detail: string }
export interface ConsensusLeg { score: number | null; p: number | null; sources: MarketSource[]; note: string }

export interface ConsensusInput {
  league: string;
  eventId: string | null;
  eventName: string | null;
  athleteId: string | null;
  player: string | null;
  team: string | null;
  stat: string | null;
  side: 'over' | 'under' | null;
  line: number | null;
}

export function implied(american: number): number | null {
  if (!Number.isFinite(american) || Math.abs(american) < 100) return null;
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}

export function probToScore(p: number | null): number | null {
  if (p == null || !Number.isFinite(p)) return null;
  return Math.min(10, Math.max(1, Math.round(10 * p)));
}

const isHalf = (n: number) => Math.abs(n - Math.floor(n) - 0.5) < 1e-9;
const pct = (p: number) => `${Math.round(p * 100)}%`;

// ---------- ESPN / DraftKings prop bets ----------

interface PropMap { pair: string[]; mile: string[]; anytime?: string[] }
const P = (pair: string[], mile: string[], anytime?: string[]): PropMap => ({ pair, mile, anytime });

/** ESPN propBets type names per canonical stat key. Matched after stripping " (incl. overtime)". */
export const ESPN_PROP_TYPES: Record<string, Record<string, PropMap>> = {
  basketball: {
    pts: P(['Total Points'], ['Points Milestones']),
    reb: P(['Total Rebounds'], ['Rebounds Milestones']),
    ast: P(['Total Assists'], ['Assists Milestones']),
    '3pm': P(['Total 3-Point Field Goals'], ['3-Point Field Goals Milestones']),
    stl: P(['Total Steals'], ['Steals Milestones']),
    blk: P(['Total Blocks'], ['Blocks Milestones']),
    pra: P(['Total Points, Rebounds, and Assists'], ['Points + Assists + Rebounds Milestones']),
    pr: P(['Total Points and Rebounds'], ['Points + Rebounds Milestones']),
    pa: P(['Total Points and Assists'], ['Points + Assists Milestones']),
    ra: P(['Total Assists and Rebounds'], ['Rebounds + Assists Milestones']),
  },
  football: {
    pass_yds: P(['Total Passing Yards'], ['Passing Yards Milestones']),
    rush_yds: P(['Total Rushing Yards'], ['Rushing Yards Milestones']),
    rec_yds: P(['Total Receiving Yards'], ['Receiving Yards Milestones']),
    rec: P(['Total Receptions'], ['Receptions Milestones']),
    pass_comp: P(['Total Pass Completions'], ['Passing Completions Milestones']),
    pass_att: P(['Total Passing Attempts'], ['Passing Attempts Milestones']),
    pass_td: P(['Total Passing Touchdowns'], ['Passing Touchdown Milestones']),
    pass_int: P(['Total Passing Interceptions'], ['Interceptions Thrown Milestones']),
    rush_att: P(['Total Carries'], ['Rushing Attempts Milestones']),
    rush_rec_yds: P(['Total Rushing Plus Receiving Yards'], ['Rushing + Receiving Yards Milestones']),
    pass_rush_yds: P([], ['Passing + Rushing Yards Milestones']),
    kick_pts: P(['Total Kicking Points'], ['Kicking Points Milestones']),
    fg_made: P([], ['Field Goals Made Milestones']),
    td: P([], [], ['Anytime Touchdown Scorer']),
  },
  hockey: {
    points: P(['Total Points'], ['Points Milestones']),
    assists: P(['Total Assists'], ['Assists Milestones']),
    sog: P(['Total Shots on Goal'], ['Shots on Goal Milestones']),
    blocks: P(['Total Blocked Shots'], ['Blocked Shots Milestones']),
    saves: P(['Total Saves'], ['Goalkeeper Saves Milestones']),
    goals: P([], ['Goals Milestones'], ['Anytime Goalscorer']),
  },
  baseball: {},
};

/** One compact row per prop price. Raw ESPN payloads are not kept. */
export interface PropRow { athleteId: string; type: string; target: number | null; american: number }

export function propRowsFromEspn(payload: any): PropRow[] {
  const out: PropRow[] = [];
  for (const i of payload?.items ?? []) {
    const ref: string = i?.athlete?.$ref ?? '';
    const m = ref.match(/\/athletes\/(\d+)/);
    if (!m) continue;
    const american = Number(String(i?.odds?.american?.value ?? '').replace(/[^\d+-]/g, ''));
    if (!Number.isFinite(american) || Math.abs(american) < 100) continue;
    const t = i?.current?.target?.value;
    const type = String(i?.type?.name ?? '').replace(/\s*\(incl\. overtime\)\s*$/i, '').trim();
    out.push({ athleteId: m[1]!, type, target: typeof t === 'number' && Number.isFinite(t) ? t : null, american });
  }
  return out;
}

/** DraftKings (via ESPN) probability for one side. Null when DK has no usable price at this line. */
export function espnPropProbability(rows: PropRow[], q: { league: string; athleteId: string; stat: string; side: 'over' | 'under'; line: number }): MarketSource | null {
  const map = ESPN_PROP_TYPES[sportOf(q.league)]?.[q.stat];
  if (!map) return null;
  const mine = rows.filter((r) => r.athleteId === q.athleteId);
  const N = Math.floor(q.line) + 1;
  const mileRows = isHalf(q.line) ? mine.filter((r) => map.mile.includes(r.type) && r.target === N) : [];
  const mileVals = [...new Set(mileRows.map((r) => r.american))];
  const mileP = mileVals.length === 1 ? implied(mileVals[0]!) : null; // duplicates that disagree are ignored

  const pair = mine.filter((r) => map.pair.includes(r.type) && r.target != null && Math.abs(r.target - q.line) < 1e-9);
  if (pair.length === 2) {
    const a = implied(pair[0]!.american), b = implied(pair[1]!.american);
    if (a != null && b != null) {
      let overFirst = true;
      if (mileP != null) overFirst = Math.abs(a - mileP) <= Math.abs(b - mileP);
      const [po, pu] = overFirst ? [a, b] : [b, a];
      const [ao, au] = overFirst ? [pair[0]!.american, pair[1]!.american] : [pair[1]!.american, pair[0]!.american];
      const pOver = po / (po + pu);
      const p = q.side === 'over' ? pOver : 1 - pOver;
      const price = q.side === 'over' ? ao : au;
      return { name: 'DK', p, detail: `DK ${q.side === 'over' ? 'o' : 'u'}${q.line} ${fmtAm(price)} → ${pct(p)} no-vig` };
    }
  }
  if (map.anytime && q.side === 'over' && q.line === 0.5) {
    const any = [...new Set(mine.filter((r) => map.anytime!.includes(r.type)).map((r) => r.american))];
    if (any.length === 1) {
      const p = implied(any[0]!)!;
      return { name: 'DK', p, detail: `DK anytime ${fmtAm(any[0]!)} → ${pct(p)} (incl. vig)` };
    }
  }
  if (mileP != null) {
    const p = q.side === 'over' ? mileP : 1 - mileP;
    return { name: 'DK', p, detail: `DK alt ${N}+ ${fmtAm(mileVals[0]!)} → ${pct(p)}${q.side === 'under' ? ' under' : ''} (incl. vig)` };
  }
  return null;
}

function fmtAm(n: number): string { return n > 0 ? `+${n}` : `−${Math.abs(n)}`; }

// ---------- Kalshi ----------

export const KALSHI_SERIES: Record<string, Record<string, string>> = {
  nba: { pts: 'KXNBAPTS', reb: 'KXNBAREB', ast: 'KXNBAAST', '3pm': 'KXNBA3PT', stl: 'KXNBASTL', blk: 'KXNBABLK', pra: 'KXNBAPRA' },
};
/** ESPN abbreviations that Kalshi spells differently. */
const KALSHI_TEAM: Record<string, string> = { WSH: 'WAS', NY: 'NYK', UTAH: 'UTA', NO: 'NOP', SA: 'SAS', GS: 'GSW' };
export const kalshiTeam = (abbr: string) => KALSHI_TEAM[abbr.toUpperCase()] ?? abbr.toUpperCase();

export interface KalshiRow { player: string; strike: number; bid: number | null; ask: number | null }

export function kalshiRows(payload: any): KalshiRow[] {
  const out: KalshiRow[] = [];
  for (const m of payload?.markets ?? []) {
    if (m?.strike_type !== 'greater' || typeof m?.floor_strike !== 'number') continue;
    const title = String(m?.title ?? '');
    const player = title.split(':')[0]?.trim();
    if (!player) continue;
    const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 1 ? n : null; };
    out.push({ player, strike: m.floor_strike, bid: num(m.yes_bid_dollars), ask: num(m.yes_ask_dollars) });
  }
  return out;
}

/** Pick the Kalshi event for this game from the open events list. Both teams must appear in the ticker suffix. */
export function kalshiEventFor(events: { event_ticker: string }[], teams: string[]): string | null {
  const codes = teams.map(kalshiTeam);
  const hit = events.filter((e) => {
    const tail = e.event_ticker.split('-')[1] ?? '';
    const pair = tail.replace(/^\d{2}[A-Z]{3}\d{2}/, '');
    return codes.length >= 2 ? codes.every((c) => pair.includes(c)) && pair.length === codes.join('').length : codes.some((c) => pair.includes(c));
  });
  hit.sort((a, b) => a.event_ticker.localeCompare(b.event_ticker));
  return hit[0]?.event_ticker ?? null;
}

export const KALSHI_MAX_SPREAD = 0.15;

export function kalshiProbability(rows: KalshiRow[], q: { player: string; side: 'over' | 'under'; line: number }): MarketSource | null {
  if (!isHalf(q.line)) return null;
  const want = normName(q.player);
  const m = rows.find((r) => normName(r.player) === want && Math.abs(r.strike - q.line) < 1e-9);
  if (!m || m.bid == null || m.ask == null || m.ask < m.bid || m.ask - m.bid > KALSHI_MAX_SPREAD) return null;
  const mid = (m.bid + m.ask) / 2;
  const p = q.side === 'over' ? mid : 1 - mid;
  const N = Math.floor(q.line) + 1;
  return { name: 'Kalshi', p, detail: `Kalshi ${N}+ ${Math.round(m.bid * 100)}/${Math.round(m.ask * 100)}¢ → ${pct(p)}${q.side === 'under' ? ' under' : ''}` };
}

// ---------- The Odds API (optional key) ----------

export const ODDS_API_SPORT: Record<string, string> = { nba: 'basketball_nba', wnba: 'basketball_wnba', nfl: 'americanfootball_nfl', nhl: 'icehockey_nhl', ncaab: 'basketball_ncaab', ncaaf: 'americanfootball_ncaaf' };
export const ODDS_API_MARKET: Record<string, Record<string, string>> = {
  basketball: { pts: 'player_points', reb: 'player_rebounds', ast: 'player_assists', '3pm': 'player_threes', stl: 'player_steals', blk: 'player_blocks', pra: 'player_points_rebounds_assists', pr: 'player_points_rebounds', pa: 'player_points_assists', ra: 'player_rebounds_assists' },
  football: { pass_yds: 'player_pass_yds', rush_yds: 'player_rush_yds', rec_yds: 'player_reception_yds', rec: 'player_receptions', pass_td: 'player_pass_tds', pass_comp: 'player_pass_completions', pass_att: 'player_pass_attempts', pass_int: 'player_pass_interceptions', rush_att: 'player_rush_attempts', rush_rec_yds: 'player_rush_reception_yds' },
  hockey: { points: 'player_points', assists: 'player_assists', sog: 'player_shots_on_goal', blocks: 'player_blocked_shots' },
  baseball: {},
};

/** Mean no-vig probability across books that list both sides at exactly this line. */
export function oddsApiProbability(payload: any, q: { player: string; side: 'over' | 'under'; line: number; market: string }): MarketSource | null {
  const want = normName(q.player);
  const ps: number[] = [];
  for (const b of payload?.bookmakers ?? []) {
    const mk = (b?.markets ?? []).find((m: any) => m?.key === q.market);
    if (!mk) continue;
    const mine = (mk.outcomes ?? []).filter((o: any) => normName(String(o?.description ?? '')) === want && Math.abs(Number(o?.point) - q.line) < 1e-9);
    const o = mine.find((x: any) => /^over$/i.test(x?.name)), u = mine.find((x: any) => /^under$/i.test(x?.name));
    const po = o ? implied(Number(o.price)) : null, pu = u ? implied(Number(u.price)) : null;
    if (po == null || pu == null) continue;
    const pOver = po / (po + pu);
    ps.push(q.side === 'over' ? pOver : 1 - pOver);
  }
  if (!ps.length) return null;
  const p = ps.reduce((a, b) => a + b, 0) / ps.length;
  return { name: 'OddsAPI', p, detail: `${ps.length} book${ps.length === 1 ? '' : 's'} (Odds API) → ${pct(p)} no-vig` };
}

// ---------- Combine ----------

export function combineSources(sources: MarketSource[], whyNone = 'no market prices this leg'): ConsensusLeg {
  if (!sources.length) return { score: null, p: null, sources, note: whyNone };
  const p = sources.reduce((a, s) => a + s.p, 0) / sources.length;
  return { score: probToScore(p), p, sources, note: sources.map((s) => s.detail).join(' · ') };
}

// ---------- Feed (HTTP, cached, time-boxed) ----------

type Fetcher = (url: string) => Promise<unknown>;
const ESPN_CORE = 'https://sports.core.api.espn.com/v2/sports';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const ODDS_API = 'https://api.the-odds-api.com/v4';
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 64;
const REQ_TIMEOUT_MS = 6_000;
const LEG_BUDGET_MS = 9_000;
/** Kalshi's public API rate-limits bursts (HTTP 429). Requests go one at a time, spaced, with one retry. */
const KALSHI_GAP_MS = 250;
const KALSHI_RETRY_MS = 1_200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ESPN prop pages are ~0.75 MB of JSON each. At most two are parsed at once to keep the 512 MB box's peak low. */
const ESPN_PROP_CONCURRENCY = 2;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class ConsensusFeed {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private fetcher: Fetcher;
  private kalshiQueue: Promise<unknown> = Promise.resolve();
  private espnActive = 0;
  private espnWaiters: (() => void)[] = [];
  readonly oddsApiKey: string;

  constructor(opts: { fetcher?: Fetcher; oddsApiKey?: string } = {}) {
    this.oddsApiKey = opts.oddsApiKey ?? '';
    this.fetcher = opts.fetcher ?? (async (url: string) => {
      const res = await fetch(url, { headers: { 'user-agent': 'picks-hq/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  }

  /** Cache only the compact parsed value. Failures are not cached. Oldest entry is evicted past MAX_ENTRIES. */
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  /** Serialised Kalshi GET with spacing and a single retry after a 429. */
  private kalshiGet(url: string): Promise<unknown> {
    const run = async () => {
      try { return await this.fetcher(url); }
      catch (e) {
        if (!/HTTP 429/.test((e as Error).message)) throw e;
        await sleep(KALSHI_RETRY_MS);
        return await this.fetcher(url);
      } finally { await sleep(KALSHI_GAP_MS); }
    };
    const p = this.kalshiQueue.then(run, run);
    this.kalshiQueue = p.catch(() => {});
    return p;
  }

  private async espnSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.espnActive >= ESPN_PROP_CONCURRENCY) await new Promise<void>((r) => this.espnWaiters.push(r));
    this.espnActive++;
    try { return await fn(); }
    finally { this.espnActive--; this.espnWaiters.shift()?.(); }
  }

  espnPropRows(league: string, eventId: string): Promise<PropRow[]> {
    const L = LEAGUES[league];
    if (!L) return Promise.resolve([]);
    const [sport, lg] = L.path.split('/');
    return this.cached(`espn:${league}:${eventId}`, async () => {
      const rows: PropRow[] = [];
      for (let page = 1; page <= 3; page++) {
        const url = `${ESPN_CORE}/${sport}/leagues/${lg}/events/${eventId}/competitions/${eventId}/odds/100/propBets?lang=en&region=us&limit=1000&page=${page}`;
        const d: any = await this.espnSlot(() => this.fetcher(url));
        rows.push(...propRowsFromEspn(d));
        if (!d?.pageCount || page >= d.pageCount) break;
      }
      return rows;
    });
  }

  kalshiRowsFor(league: string, stat: string, teams: string[]): Promise<KalshiRow[]> {
    const series = KALSHI_SERIES[league]?.[stat];
    if (!series || !teams.length) return Promise.resolve([]);
    return this.cached(`kalshi:${series}:${teams.join('-')}`, async () => {
      const ev: any = await this.cached(`kalshi-events:${series}`, () => this.kalshiGet(`${KALSHI}/events?series_ticker=${series}&status=open&limit=200`).then((d: any) => ({ events: (d?.events ?? []).map((e: any) => ({ event_ticker: String(e?.event_ticker ?? '') })) })));
      const ticker = kalshiEventFor(ev.events, teams);
      if (!ticker) return [];
      const d = await this.kalshiGet(`${KALSHI}/markets?event_ticker=${encodeURIComponent(ticker)}&limit=1000`);
      return kalshiRows(d);
    });
  }

  private async oddsApi(league: string, stat: string, teamNames: { home: string; away: string } | null, q: { player: string; side: 'over' | 'under'; line: number }): Promise<MarketSource | null> {
    const sportKey = ODDS_API_SPORT[league];
    const market = ODDS_API_MARKET[sportOf(league)]?.[stat];
    if (!this.oddsApiKey || !sportKey || !market || !teamNames) return null;
    const key = encodeURIComponent(this.oddsApiKey);
    const events: any = await this.cached(`odds-events:${sportKey}`, () => this.fetcher(`${ODDS_API}/sports/${sportKey}/events?apiKey=${key}`));
    const ev = (events ?? []).find((e: any) => normName(e?.home_team ?? '') === normName(teamNames.home) && normName(e?.away_team ?? '') === normName(teamNames.away));
    if (!ev?.id) return null;
    const odds = await this.cached(`odds:${ev.id}:${market}`, () => this.fetcher(`${ODDS_API}/sports/${sportKey}/events/${ev.id}/odds?apiKey=${key}&regions=us&markets=${market}&oddsFormat=american`));
    return oddsApiProbability(odds, { ...q, market });
  }

  /** Rate one leg. Never throws; a source that fails or times out is simply absent. */
  async rate(q: ConsensusInput, teamNames?: { home: string; away: string } | null): Promise<ConsensusLeg> {
    if (!q.stat || !q.side || q.line == null || !q.player) return combineSources([], 'player props only');
    const teams = (q.eventName?.toUpperCase().match(/\b([A-Z]{2,5})\s*@\s*([A-Z]{2,5})\b/)?.slice(1) ?? []) as string[];
    const leg = { side: q.side, line: q.line };
    const tasks: Promise<MarketSource | null>[] = [
      q.eventId && q.athleteId
        ? this.espnPropRows(q.league, q.eventId).then((rows) => espnPropProbability(rows, { league: q.league, athleteId: q.athleteId!, stat: q.stat!, ...leg }))
        : Promise.resolve(null),
      this.kalshiRowsFor(q.league, q.stat, teams).then((rows) => kalshiProbability(rows, { player: q.player!, ...leg })),
      this.oddsApi(q.league, q.stat, teamNames ?? null, { player: q.player, ...leg }),
    ];
    const settled = await Promise.all(tasks.map((t) => withTimeout(t, LEG_BUDGET_MS).catch(() => null)));
    return combineSources(settled.filter((s): s is MarketSource => !!s));
  }
}
