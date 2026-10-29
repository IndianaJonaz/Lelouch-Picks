// Match parsed legs to real ESPN games and athletes.
import { LEAGUES, type Espn, type Game } from './espn.ts';
import { ParseError, parseLeg, type ParsedLeg } from './parse.ts';
import { findStat, sportOf, sportsForStat } from './stats.ts';
import { addDays, dayInTz, normName } from './util.ts';
import type { Leg } from './db.ts';

export type ResolvedLeg = Omit<Leg, 'id' | 'slip_id' | 'idx' | 'status' | 'actual' | 'detail' | 'graded_at'>;

export interface ResolveOpts { tz: string; leagues: string[]; days?: string[]; allowStarted?: boolean; allowFinal?: boolean; now?: Date }

function teamMatches(text: string, g: Game): 'home' | 'away' | null {
  const n = normName(text);
  for (const k of ['home', 'away'] as const) {
    const t = g[k];
    const cands = [t.abbr, t.name, t.short, t.location, `${t.location} ${t.short}`].map((x) => normName(x || '')).filter(Boolean);
    if (cands.includes(n)) return k;
  }
  return null;
}

function nameScore(query: string, full: string): number {
  const q = normName(query), f = normName(full);
  if (!q || !f) return 0;
  if (q === f) return 3;
  const qp = q.split(' '), fp = f.split(' ');
  const last = fp[fp.length - 1];
  if (qp.length === 1 && (qp[0] === last || (fp.length > 2 && fp.slice(1).join('') === qp[0]))) return 2; // "Jokic"
  if (qp.length === 2 && qp[0].length === 1 && fp[0][0] === qp[0] && qp[1] === last) return 2; // "N Jokic"
  if (qp.length >= 2 && qp[qp.length - 1] === last && fp[0].startsWith(qp[0])) return 2; // nicknames prefix "Nik Jokic"
  if (qp.length === 1 && fp[0] === qp[0] && qp[0].length >= 4) return 1; // unique first name, e.g. "Giannis"
  return 0;
}

export class Resolver {
  private espn: Espn;
  constructor(espn: Espn) { this.espn = espn; }

  private async gamesFor(league: string, day: string): Promise<Game[]> {
    try { return (await this.espn.scoreboard(league, day)).games; } catch { return []; }
  }

  async resolve(text: string, o: ResolveOpts): Promise<ResolvedLeg> {
    const p = parseLeg(text);
    return this.resolveParsed(p, o);
  }

  async resolveParsed(p: ParsedLeg, o: ResolveOpts): Promise<ResolvedLeg> {
    const today = dayInTz(o.now ?? new Date(), o.tz);
    const days = o.days ?? Array.from({ length: 7 }, (_, i) => addDays(today, i));
    let leagues = p.league ? [p.league] : o.leagues.filter((l) => LEAGUES[l]);
    if (p.type === 'prop' && p.statText && !p.league) {
      const sports = sportsForStat(p.statText);
      if (!sports.length) throw new ParseError(`Unknown stat "${p.statText}" in "${p.raw}".`);
      leagues = leagues.filter((l) => sports.includes(sportOf(l)));
    }
    // "Name (TEAM)" hint
    let subject = p.subject;
    let hint: string | null = null;
    const hm = subject.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (hm) { subject = hm[1].trim(); hint = hm[2].trim(); }

    const usable = (g: Game) => o.allowFinal || g.state === 'pre' || (o.allowStarted !== false && g.state === 'in');

    for (const day of days) {
      for (const league of leagues) {
        const games = (await this.gamesFor(league, day)).filter(usable);
        if (!games.length) continue;
        if (p.type === 'prop') {
          const stat = findStat(league, p.statText ?? '');
          if (!stat) continue;
          const college = league === 'ncaaf' || league === 'ncaab';
          const pool = hint ? games.filter((g) => teamMatches(hint!, g)) : college ? [] : games;
          let best: { score: number; g: Game; side: 'home' | 'away'; id: string; name: string }[] = [];
          const pairs = pool.flatMap((g) => (['home', 'away'] as const).filter((k) => !hint || teamMatches(hint, g) === k).map((k) => ({ g, k })));
          const rosters = await Promise.all(pairs.map(({ g, k }) => this.espn.roster(league, g[k].id).catch(() => [] as { id: string; name: string }[])));
          pairs.forEach(({ g, k }, i) => {
            for (const a of rosters[i]) {
              const s = nameScore(subject, a.name);
              if (s) best.push({ score: s, g, side: k, id: a.id, name: a.name });
            }
          });
          if (!best.length) continue;
          const top = Math.max(...best.map((b) => b.score));
          best = best.filter((b) => b.score === top);
          if (best.length > 1 && new Set(best.map((b) => b.id)).size > 1) {
            throw new ParseError(`"${subject}" matches ${best.slice(0, 4).map((b) => `${b.name} (${b.g[b.side].abbr})`).join(', ')} — use the full name or add the team, e.g. "${best[0].name} (${best[0].g[best[0].side].abbr})".`);
          }
          const b = best[0];
          return {
            league, event_id: b.g.id, event_name: b.g.shortName, start_time: b.g.start, type: 'prop',
            team: b.g[b.side].abbr, player: b.name, athlete_id: b.id, stat: stat.key, side: p.side, line: p.line, odds: p.odds, raw: p.raw,
          };
        }
        for (const g of games) {
          const s1 = teamMatches(subject, g);
          if (p.type === 'total') {
            if (!s1 && !(p.subject2 && teamMatches(p.subject2, g))) continue;
            if (p.subject2 && s1 && !teamMatches(p.subject2, g)) continue;
            return { league, event_id: g.id, event_name: g.shortName, start_time: g.start, type: 'total', team: null, player: null, athlete_id: null, stat: null, side: p.side, line: p.line, odds: p.odds, raw: p.raw };
          }
          if (!s1) continue;
          return { league, event_id: g.id, event_name: g.shortName, start_time: g.start, type: p.type, team: g[s1].abbr, player: null, athlete_id: null, stat: null, side: null, line: p.type === 'spread' ? p.line : null, odds: p.odds, raw: p.raw };
        }
      }
    }
    const where = leagues.map((l) => LEAGUES[l].label).join('/');
    if (p.type === 'prop') throw new ParseError(`Couldn't find "${subject}" on a ${where} roster with a game in the next ${days.length} day(s).${leagues.some((l) => l.startsWith('ncaa')) ? ' College props need a team: "Name (TEAM) o…".' : ''}`);
    throw new ParseError(`No upcoming ${where} game found for "${subject}".`);
  }
}
