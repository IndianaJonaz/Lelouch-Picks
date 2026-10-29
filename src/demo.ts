// Demo mode: seeds clearly-labelled DEMO slips on REAL ESPN games (yesterday's finals + today's/tomorrow's slate),
// so every page can be previewed without Discord. Lines are made-up demo picks; all scores/stats/grades are real.
import type { DatabaseSync } from 'node:sqlite';
import type { Espn, Game } from './espn.ts';
import type { Resolver, ResolvedLeg } from './resolve.ts';
import { createSlip } from './store.ts';
import { parseBox } from './stats.ts';
import { addDays, dayInTz } from './util.ts';

const USERS = [
  { id: 'demo:ace', name: 'Ace' }, { id: 'demo:marlo', name: 'Marlo' }, { id: 'demo:kesh', name: 'Kesh' },
  { id: 'demo:vee', name: 'Vee' }, { id: 'demo:dutch', name: 'Dutch' },
];
const half = (n: number) => Math.floor(n) + 0.5;

export function clearDemo(db: DatabaseSync) { db.prepare('DELETE FROM slips WHERE is_demo = 1').run(); }
export function hasDemo(db: DatabaseSync) { return !!db.prepare('SELECT 1 FROM slips WHERE is_demo = 1 LIMIT 1').get(); }

export async function seedDemo(db: DatabaseSync, espn: Espn, resolver: Resolver, tz: string, log = console.log): Promise<number> {
  const today = dayInTz(new Date(), tz);
  const yday = addDays(today, -1);
  const tasks: { user: number; title: string; legs: { text: string; day: string; final?: boolean }[]; stake: number; odds?: number; hidden?: boolean; note?: string }[] = [];
  const sb = async (lg: string, d: string): Promise<Game[]> => { try { return (await espn.scoreboard(lg, d)).games; } catch { return []; } };

  // --- Yesterday's finals: props on real box scores ---
  const finals = [...(await sb('nba', yday)), ...(await sb('nhl', yday))].filter((g) => g.completed);
  let k = 0;
  for (const g of finals.slice(0, 8)) {
    try {
      const s = await espn.summary(g.league, g.id);
      const box = [...parseBox(g.league, s.data).values()].filter((p) => !p.dnp);
      if (g.league === 'nba') {
        const top = box.sort((a, b) => (b.stats.pts ?? 0) - (a.stats.pts ?? 0)).slice(0, 2);
        const [a, b] = top;
        if (!a || !b) continue;
        const offA = k % 3 === 2 ? 1.5 : -2.5; // mostly hits, some misses
        const offB = k % 2 ? 2.5 : -1.5;
        tasks.push({ user: k % USERS.length, title: `${g.shortName} scorers`, stake: 1 + (k % 3) * 0.5, odds: 264,
          legs: [{ text: `NBA ${a.name} (${a.team}) o${half(a.stats.pts + offA)} pts`, day: yday, final: true }, { text: `NBA ${b.name} (${b.team}) o${half(b.stats.pts + offB)} pts`, day: yday, final: true }] });
        const reb = box.sort((x, y) => (y.stats.reb ?? 0) - (x.stats.reb ?? 0))[0];
        if (reb) tasks.push({ user: (k + 2) % USERS.length, title: null as any, stake: 1, legs: [{ text: `NBA ${reb.name} (${reb.team}) ${k % 2 ? 'u' : 'o'}${half(reb.stats.reb - 1)} reb (-115)`, day: yday, final: true }] });
        // Real closing line from ESPN pickcenter (DraftKings) — the leg is a demo pick, the line and result are real.
        const pc = s.data?.pickcenter?.[0];
        const pm = String(pc?.details ?? '').match(/^([A-Z]+)\s+(-?\d+(?:\.\d+)?)$/);
        if (pm) {
          const favSide = g.home.abbr === pm[1] ? g.home : g.away;
          const dog = favSide === g.home ? g.away : g.home;
          const line = Number(pm[2]);
          tasks.push({ user: (k + 1) % USERS.length, title: null as any, stake: 2, legs: [{ text: k % 2 ? `NBA ${favSide.abbr} ${line} (-110)` : `NBA ${dog.abbr} +${-line} (-110)`, day: yday, final: true }] });
        }
        if (pc?.overUnder) tasks.push({ user: (k + 3) % USERS.length, title: null as any, stake: 1, legs: [{ text: `NBA ${g.away.abbr}/${g.home.abbr} ${k % 2 ? 'u' : 'o'}${pc.overUnder} (-110)`, day: yday, final: true }] });
      } else {
        const shooter = box.sort((a, b) => (b.stats.sog ?? 0) - (a.stats.sog ?? 0))[0];
        if (shooter) tasks.push({ user: (k + 3) % USERS.length, title: null as any, stake: 1, legs: [{ text: `NHL ${shooter.name} (${shooter.team}) o${half((shooter.stats.sog ?? 2) - 2)} sog (-125)`, day: yday, final: true }] });
        const ou = s.data?.pickcenter?.[0]?.overUnder;
        if (ou) tasks.push({ user: (k + 4) % USERS.length, title: null as any, stake: 1, legs: [{ text: `NHL ${g.away.abbr}/${g.home.abbr} ${k % 2 ? 'u' : 'o'}${ou} (-110)`, day: yday, final: true }] });
      }
      k++;
    } catch (e) { log('[demo] skip final', g.shortName, (e as Error).message); }
  }

  // --- Today's & tomorrow's slate: game lines from ESPN odds, props from season leaders ---
  const upcoming: Game[] = [];
  for (const d of [today, addDays(today, 1)]) for (const lg of ['nfl', 'nba', 'nhl']) upcoming.push(...(await sb(lg, d)).filter((g) => !g.completed).map((g) => Object.assign(g, { _day: d })));
  let j = 0;
  for (const g of upcoming.slice(0, 9) as (Game & { _day: string })[]) {
    const L = g.league.toUpperCase();
    const legs: { text: string; day: string }[] = [];
    const det = g.odds?.details ?? '';
    const m = det.match(/^([A-Z]+)\s+(-?\d+(?:\.\d+)?)$/);
    if (m && g.league !== 'nhl') legs.push({ text: `${L} ${m[1] === 'UTAH' ? 'UTA' : m[1]} ${m[2]} (-110)`, day: g._day });
    if (g.odds?.overUnder) legs.push({ text: `${L} ${g.away.abbr}/${g.home.abbr} ${j % 2 ? 'u' : 'o'}${g.odds.overUnder} (-110)`, day: g._day });
    try {
      const s = await espn.summary(g.league, g.id);
      for (const t of (s.data?.leaders ?? []).slice(0, 2)) {
        const abbr = t.team?.abbreviation;
        const c = t.leaders?.find((x: any) => ['pointsPerGame', 'passingYards', 'rushingYards', 'receivingYards'].includes(x.name));
        const ld = c?.leaders?.[0];
        if (!ld) continue;
        if (c.name === 'pointsPerGame') legs.push({ text: `${L} ${ld.athlete.displayName} (${abbr}) o${half(ld.value - 1)} pts (-115)`, day: g._day });
        else if (g.league === 'nfl') {
          const comp = g.home.abbr === abbr ? g.home : g.away;
          const gp = (comp.record ?? '').split('-').reduce((n, x) => n + Number(x || 0), 0) || 1;
          const stat = c.name === 'passingYards' ? 'pass yds' : c.name === 'rushingYards' ? 'rush yds' : 'rec yds';
          legs.push({ text: `NFL ${ld.athlete.displayName} (${abbr}) o${half(ld.value / gp - 5)} ${stat} (-115)`, day: g._day });
        }
      }
    } catch { /* leaders optional */ }
    if (!legs.length) continue;
    const pick = legs.slice(0, j % 3 === 0 ? 3 : 2);
    tasks.push({ user: j % USERS.length, title: j === 0 ? `${g.shortName} build` : null as any, stake: j === 0 ? 2 : 1, odds: pick.length === 3 ? 596 : pick.length === 2 ? 264 : undefined, hidden: j === 2, legs: pick,
      note: j === 0 ? 'Demo slip — real game, real lines from ESPN odds, graded live.' : undefined });
    if (g.league !== 'nhl' && j % 2 === 0) tasks.push({ user: (j + 2) % USERS.length, title: null as any, stake: 1, legs: [{ text: `${L} ${g.home.abbr} ML (${g.league === 'nfl' ? '-180' : '-140'})`, day: g._day }] });
    j++;
  }

  let n = 0;
  for (const t of tasks) {
    try {
      const legs: ResolvedLeg[] = [];
      for (const l of t.legs) legs.push(await resolver.resolve(l.text, { tz, leagues: ['nba', 'nfl', 'nhl'], days: [l.day], allowFinal: !!l.final }));
      const u = USERS[t.user];
      createSlip(db, { user_id: u.id, user_name: u.name, title: t.title, stake: t.stake, odds: t.odds ?? null, hidden: t.hidden, note: t.note ?? null, source: 'demo', is_demo: true }, legs);
      n++;
    } catch (e) { log('[demo] skipped slip:', (e as Error).message); }
  }
  log(`[demo] seeded ${n} demo slips on real ESPN games (${finals.length} finals yesterday, ${upcoming.length} upcoming)`);
  return n;
}
