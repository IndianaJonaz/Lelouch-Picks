// League injury report from ESPN's public injuries JSON.
// Each player is shown as Active or Out. The source's own designation stays attached
// so a game-time decision is still visible. A player with no name is omitted.
import { LEAGUES } from './espn.ts';

export type InjuryBadge = 'Active' | 'Out';

export interface InjuryPlayer {
  league: string;
  leagueLabel: string;
  team: string;
  teamName: string;
  player: string;
  /** Official designation, unchanged. Null when the feed listed the player with none. */
  designation: string | null;
  note: string | null;
  badge: InjuryBadge;
  date: string | null;
}

export interface InjuryLeagueStatus {
  league: string;
  label: string;
  ok: boolean;
  at: number | null;
  error: string | null;
  count: number;
}

export interface InjuryReportPayload {
  asOf: number;
  cachedUntil: number;
  source: 'ESPN public injuries';
  unavailable: boolean;
  error: string | null;
  leagues: InjuryLeagueStatus[];
  players: InjuryPlayer[];
}

/** Out, IR, Suspended, and the other season-ending designations. Everything else is Active. */
const OUT_RULES: RegExp[] = [
  /^out\b/i,
  /\binjured reserve\b/i,
  /\bir\b/i,
  /\bsuspended\b/i,
  /\bsuspension\b/i,
  /\bseason[-\s]?ending\b/i,
  /\binjured list\b/i,
  /\bpup\b/i,
  /physically unable/i,
  /\bnfi\b/i,
  /non-football injury/i,
  /\bil\b/i,
];

export function injuryBadge(designation: string | null | undefined): InjuryBadge {
  const s = (designation ?? '').trim();
  if (!s) return 'Active';
  return OUT_RULES.some((r) => r.test(s)) ? 'Out' : 'Active';
}

export function parseInjuryFeed(league: string, data: unknown): InjuryPlayer[] {
  const teams = (data as { injuries?: unknown[] } | null)?.injuries;
  if (!Array.isArray(teams)) return [];
  const label = LEAGUES[league]?.label ?? league.toUpperCase();
  const out: InjuryPlayer[] = [];
  for (const team of teams) {
    const t = team as { displayName?: string; abbreviation?: string; injuries?: unknown[] };
    for (const raw of t.injuries ?? []) {
      const i = raw as {
        status?: string | null; date?: string | null; shortComment?: string | null; longComment?: string | null;
        athlete?: { displayName?: string; fullName?: string; team?: { abbreviation?: string; displayName?: string } };
      };
      const player = (i.athlete?.displayName ?? i.athlete?.fullName ?? '').trim();
      if (!player) continue;
      const designation = i.status == null || String(i.status).trim() === '' ? null : String(i.status).trim();
      const note = (i.shortComment ?? i.longComment ?? '').trim() || null;
      out.push({
        league,
        leagueLabel: label,
        team: i.athlete?.team?.abbreviation ?? t.abbreviation ?? '',
        teamName: t.displayName ?? i.athlete?.team?.displayName ?? '',
        player,
        designation,
        note,
        badge: injuryBadge(designation),
        date: i.date ?? null,
      });
    }
  }
  return out;
}

export interface InjuryReportOpts {
  leagues: string[];
  fetchLeague: (league: string) => Promise<unknown>;
  ttlMs?: number;
  now?: () => number;
}

export class InjuryReport {
  private leagues: string[];
  private fetchLeague: (league: string) => Promise<unknown>;
  private ttl: number;
  private now: () => number;
  private cache: InjuryReportPayload | null = null;
  private inflight: Promise<InjuryReportPayload> | null = null;

  constructor(o: InjuryReportOpts) {
    this.leagues = o.leagues;
    this.fetchLeague = o.fetchLeague;
    this.ttl = o.ttlMs ?? 10 * 60_000;
    this.now = o.now ?? Date.now;
  }

  get(): Promise<InjuryReportPayload> {
    if (this.cache && this.now() < this.cache.cachedUntil) return Promise.resolve(this.cache);
    this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async refresh(): Promise<InjuryReportPayload> {
    const now = this.now();
    if (!this.leagues.length) {
      this.cache = { asOf: now, cachedUntil: now + Math.min(this.ttl, 60_000), source: 'ESPN public injuries', unavailable: true, error: 'No leagues configured', leagues: [], players: [] };
      return this.cache;
    }
    const settled = await Promise.all(this.leagues.map(async (league) => {
      try {
        const data = await this.fetchLeague(league);
        const players = parseInjuryFeed(league, data);
        const row: InjuryLeagueStatus = { league, label: LEAGUES[league]?.label ?? league.toUpperCase(), ok: true, at: now, error: null, count: players.length };
        return { row, players };
      } catch (e) {
        const row: InjuryLeagueStatus = { league, label: LEAGUES[league]?.label ?? league.toUpperCase(), ok: false, at: null, error: String((e as Error)?.message ?? e).slice(0, 160), count: 0 };
        return { row, players: [] as InjuryPlayer[] };
      }
    }));
    const leagues = settled.map((s) => s.row);
    const anyOk = leagues.some((l) => l.ok);
    const players = settled.flatMap((s) => s.players);
    const error = anyOk ? null : (leagues.map((l) => l.error).find(Boolean) ?? 'unavailable');
    this.cache = {
      asOf: now,
      cachedUntil: now + (anyOk ? this.ttl : Math.min(this.ttl, 60_000)),
      source: 'ESPN public injuries',
      unavailable: !anyOk,
      error: anyOk ? null : error,
      leagues,
      players,
    };
    return this.cache;
  }
}

export const INJURY_LEAGUES = ['nba', 'nfl', 'mlb', 'nhl', 'ncaaf', 'ncaab', 'wnba'];
