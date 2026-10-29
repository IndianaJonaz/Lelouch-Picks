// ESPN public JSON client: scoreboard, summary (box score), injuries, rosters.
// Every request goes through a small TTL cache with in-flight de-duplication,
// and every call records feed health so the dashboard can say exactly which feed is answering.

export const LEAGUES: Record<string, { path: string; label: string; sport: Sport; extra?: string; periods: number; periodMin: number }> = {
  nba: { path: 'basketball/nba', label: 'NBA', sport: 'basketball', periods: 4, periodMin: 12 },
  wnba: { path: 'basketball/wnba', label: 'WNBA', sport: 'basketball', periods: 4, periodMin: 10 },
  ncaab: { path: 'basketball/mens-college-basketball', label: 'NCAAB', sport: 'basketball', extra: 'groups=50&limit=400', periods: 2, periodMin: 20 },
  nfl: { path: 'football/nfl', label: 'NFL', sport: 'football', periods: 4, periodMin: 15 },
  ncaaf: { path: 'football/college-football', label: 'NCAAF', sport: 'football', extra: 'groups=80&limit=400', periods: 4, periodMin: 15 },
  nhl: { path: 'hockey/nhl', label: 'NHL', sport: 'hockey', periods: 3, periodMin: 20 },
  mlb: { path: 'baseball/mlb', label: 'MLB', sport: 'baseball', periods: 9, periodMin: 0 },
};
export type Sport = 'basketball' | 'football' | 'hockey' | 'baseball';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
/** Error text is shown on the dashboard; strip URLs so it can never reveal which event a hidden leg is on. */
export const scrub = (m: string) => m.replace(/https?:\/\/\S+/g, '<url>').replace(/event=\w+/g, 'event=…').slice(0, 200);

export interface TeamSide { id: string; abbr: string; name: string; short: string; location: string; score: number | null; logo: string | null; color: string | null; record: string | null; }
export interface Game {
  league: string;
  id: string;
  name: string;
  shortName: string;
  start: string;
  state: 'pre' | 'in' | 'post';
  completed: boolean;
  statusName: string;      // STATUS_FINAL, STATUS_IN_PROGRESS, STATUS_POSTPONED...
  detail: string;          // "Final", "Q3 4:12", "8:15 PM"
  period: number;
  clock: number;           // seconds left in period (sports with a clock)
  displayClock: string;
  home: TeamSide;
  away: TeamSide;
  odds: { details: string | null; overUnder: number | null; provider: string | null } | null;
  broadcast: string | null;
  fetchedAt: number;
}

export interface FeedHealth { feed: string; ok: boolean | null; lastOkAt: number | null; lastErrAt: number | null; lastError: string | null; latencyMs: number | null; calls: number; failures: number; }

type Fetcher = (url: string) => Promise<unknown>;

export class Espn {
  private cache = new Map<string, { at: number; ttl: number; data: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();
  readonly health = new Map<string, FeedHealth>();
  private fetcher: Fetcher;

  constructor(fetcher?: Fetcher) {
    this.fetcher = fetcher ?? (async (url: string) => {
      const res = await fetch(url, { headers: { 'user-agent': 'picks-hq/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  }

  private mark(feed: string, ok: boolean, latency: number, err?: string) {
    const h = this.health.get(feed) ?? { feed, ok: null, lastOkAt: null, lastErrAt: null, lastError: null, latencyMs: null, calls: 0, failures: 0 };
    h.calls++;
    h.latencyMs = latency;
    h.ok = ok;
    if (ok) h.lastOkAt = Date.now();
    else { h.failures++; h.lastErrAt = Date.now(); h.lastError = err ?? 'error'; }
    this.health.set(feed, h);
  }

  /** Cached GET. ttlFn decides TTL from the payload (live games refresh faster). On failure, serves stale data if any (marked by `stale`). */
  async get<T>(feed: string, url: string, ttlFn: (d: T) => number): Promise<{ data: T; at: number; stale: boolean }> {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < hit.ttl) return { data: hit.data as T, at: hit.at, stale: false };
    let p = this.inflight.get(url);
    if (!p) {
      const t0 = Date.now();
      p = this.fetcher(url).then(
        (data) => { this.mark(feed, true, Date.now() - t0); this.cache.set(url, { at: Date.now(), ttl: ttlFn(data as T), data }); return data; },
        (e: Error) => { const msg = scrub(e.message || String(e)); this.mark(feed, false, Date.now() - t0, msg); throw new Error(msg); },
      ).finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    try {
      await p;
      const c = this.cache.get(url)!;
      return { data: c.data as T, at: c.at, stale: false };
    } catch (e) {
      if (hit) return { data: hit.data as T, at: hit.at, stale: true };
      throw e;
    }
  }

  async scoreboard(league: string, ymd?: string): Promise<{ games: Game[]; at: number; stale: boolean }> {
    const L = LEAGUES[league];
    if (!L) throw new Error(`unknown league ${league}`);
    const q = [ymd ? `dates=${ymd.replace(/-/g, '')}` : '', L.extra ?? ''].filter(Boolean).join('&');
    const url = `${BASE}/${L.path}/scoreboard${q ? '?' + q : ''}`;
    const r = await this.get<any>(`scoreboard:${league}`, url, (d) => ((d?.events ?? []).some((e: any) => e?.status?.type?.state === 'in') ? 15_000 : 60_000));
    const games = (r.data?.events ?? []).map((e: any) => parseEvent(league, e, r.at));
    return { games, at: r.at, stale: r.stale };
  }

  async summary(league: string, eventId: string): Promise<{ data: any; at: number; stale: boolean }> {
    const L = LEAGUES[league];
    const url = `${BASE}/${L.path}/summary?event=${encodeURIComponent(eventId)}`;
    return this.get<any>(`summary:${league}`, url, (d) => {
      const st = d?.header?.competitions?.[0]?.status?.type;
      return st?.state === 'in' ? 12_000 : st?.completed ? 30 * 60_000 : 60_000;
    });
  }

  async injuries(league: string): Promise<{ data: any; at: number; stale: boolean }> {
    const L = LEAGUES[league];
    return this.get<any>(`injuries:${league}`, `${BASE}/${L.path}/injuries`, () => 10 * 60_000);
  }

  async roster(league: string, teamId: string): Promise<{ id: string; name: string }[]> {
    const L = LEAGUES[league];
    const r = await this.get<any>(`roster:${league}`, `${BASE}/${L.path}/teams/${teamId}/roster`, () => 12 * 3600_000);
    const out: { id: string; name: string }[] = [];
    for (const a of r.data?.athletes ?? []) {
      if (Array.isArray(a?.items)) for (const i of a.items) out.push({ id: String(i.id), name: i.displayName ?? i.fullName });
      else if (a?.id) out.push({ id: String(a.id), name: a.displayName ?? a.fullName });
    }
    return out;
  }

  healthList(): FeedHealth[] { return [...this.health.values()].sort((a, b) => a.feed.localeCompare(b.feed)); }
}

function side(c: any): TeamSide {
  const t = c?.team ?? {};
  const s = c?.score;
  return {
    id: String(t.id ?? ''),
    abbr: t.abbreviation ?? '',
    name: t.displayName ?? t.name ?? '',
    short: t.shortDisplayName ?? t.name ?? '',
    location: t.location ?? '',
    score: s === undefined || s === null || s === '' ? null : Number(typeof s === 'object' ? s.value ?? s.displayValue : s),
    logo: t.logo ?? t.logos?.[0]?.href ?? null,
    color: t.color ?? null,
    record: c?.records?.[0]?.summary ?? c?.record?.[0]?.summary ?? c?.record?.[0]?.displayValue ?? null,
  };
}

export function parseEvent(league: string, e: any, at = Date.now()): Game {
  const comp = e?.competitions?.[0] ?? {};
  const status = comp.status ?? e.status ?? {};
  const st = status.type ?? {};
  const cs = comp.competitors ?? [];
  const home = side(cs.find((c: any) => c.homeAway === 'home') ?? cs[0]);
  const away = side(cs.find((c: any) => c.homeAway === 'away') ?? cs[1]);
  const o = comp.odds?.[0];
  const state = (st.state === 'in' || st.state === 'post' ? st.state : 'pre') as Game['state'];
  return {
    league,
    id: String(e.id),
    name: e.name ?? `${away.name} at ${home.name}`,
    shortName: e.shortName ?? `${away.abbr} @ ${home.abbr}`,
    start: e.date ?? comp.date,
    state,
    completed: !!st.completed,
    statusName: st.name ?? '',
    detail: st.shortDetail ?? st.detail ?? '',
    period: Number(status.period ?? 0),
    clock: Number(status.clock ?? 0),
    displayClock: status.displayClock ?? '',
    home, away,
    odds: o ? { details: o.details ?? null, overUnder: o.overUnder ?? null, provider: o.provider?.name ?? null } : null,
    broadcast: comp.broadcasts?.[0]?.names?.[0] ?? comp.geoBroadcasts?.[0]?.media?.shortName ?? null,
    fetchedAt: at,
  };
}

/** Game from a summary payload's header (used when grading). */
export function gameFromSummary(league: string, s: any, at = Date.now()): Game | null {
  const comp = s?.header?.competitions?.[0];
  if (!comp) return null;
  return parseEvent(league, { id: s.header.id, date: comp.date, name: undefined, shortName: undefined, competitions: [comp] }, at);
}

/** Fraction of regulation elapsed, 0..1 (null before start). */
export function elapsedFraction(g: Pick<Game, 'league' | 'state' | 'period' | 'clock' | 'detail' | 'completed'>): number | null {
  if (g.state === 'pre') return null;
  if (g.state === 'post') return 1;
  const L = LEAGUES[g.league];
  if (!L) return null;
  if (L.sport === 'baseball') {
    const inning = Math.max(1, g.period);
    const d = g.detail.toLowerCase();
    const half = d.startsWith('bot') || d.startsWith('mid') ? 0.5 : d.startsWith('end') ? 1 : 0;
    return Math.min(1, (inning - 1 + half) / 9);
  }
  if (g.period > L.periods) return 1;
  const len = L.periodMin * 60;
  const elapsed = (g.period - 1) * len + Math.max(0, len - g.clock);
  return Math.min(1, Math.max(0, elapsed / (L.periods * len)));
}
