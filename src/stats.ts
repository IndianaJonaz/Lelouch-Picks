import { LEAGUES, type Sport } from './espn.ts';
import { normName } from './util.ts';

export interface PlayerLine { id: string; name: string; team: string; dnp: boolean; stats: Record<string, number>; }
export type Box = Map<string, PlayerLine>;

// ---- Stat catalogue: canonical key -> label + aliases, per sport ----
interface StatDef { key: string; label: string; aliases: string[]; combo?: string[] }
const S = (key: string, label: string, aliases: string[], combo?: string[]): StatDef => ({ key, label, aliases, combo });

export const STATS: Record<Sport, StatDef[]> = {
  basketball: [
    S('pts', 'Points', ['pts', 'points', 'point', 'p']),
    S('reb', 'Rebounds', ['reb', 'rebs', 'rebounds', 'rebound', 'r', 'boards']),
    S('ast', 'Assists', ['ast', 'asts', 'assists', 'assist', 'a', 'dimes']),
    S('3pm', 'Threes made', ['3pm', '3pt', '3pts', 'threes', '3s', '3 pointers', 'three pointers', '3ptm', 'treys']),
    S('stl', 'Steals', ['stl', 'steals', 'steal']),
    S('blk', 'Blocks', ['blk', 'blocks', 'block']),
    S('to', 'Turnovers', ['to', 'tov', 'turnovers']),
    S('pra', 'Pts+Reb+Ast', ['pra', 'p+r+a', 'pts+reb+ast', 'pts reb ast', 'points rebounds assists'], ['pts', 'reb', 'ast']),
    S('pr', 'Pts+Reb', ['pr', 'p+r', 'pts+reb', 'points rebounds'], ['pts', 'reb']),
    S('pa', 'Pts+Ast', ['pa', 'p+a', 'pts+ast', 'points assists'], ['pts', 'ast']),
    S('ra', 'Reb+Ast', ['ra', 'r+a', 'reb+ast', 'rebounds assists'], ['reb', 'ast']),
    S('sb', 'Stl+Blk', ['sb', 's+b', 'stl+blk', 'stocks'], ['stl', 'blk']),
  ],
  football: [
    S('pass_yds', 'Passing yards', ['pass yds', 'passing yds', 'passing yards', 'pass yards', 'py']),
    S('pass_td', 'Passing TDs', ['pass td', 'pass tds', 'passing td', 'passing tds', 'passing touchdowns']),
    S('pass_comp', 'Completions', ['completions', 'comp', 'cmp', 'pass completions']),
    S('pass_att', 'Pass attempts', ['pass att', 'pass attempts', 'attempts']),
    S('pass_int', 'Interceptions thrown', ['int', 'ints', 'interceptions', 'interceptions thrown']),
    S('rush_yds', 'Rushing yards', ['rush yds', 'rushing yds', 'rushing yards', 'rush yards', 'ry']),
    S('rush_att', 'Rush attempts', ['rush att', 'rush attempts', 'carries']),
    S('rec', 'Receptions', ['rec', 'recs', 'receptions', 'catches']),
    S('rec_yds', 'Receiving yards', ['rec yds', 'receiving yds', 'receiving yards', 'rec yards', 'recy']),
    S('rush_rec_yds', 'Rush+Rec yards', ['rush+rec yds', 'rush rec yds', 'rushing+receiving yards', 'scrimmage yds', 'scrimmage yards'], ['rush_yds', 'rec_yds']),
    S('pass_rush_yds', 'Pass+Rush yards', ['pass+rush yds', 'pass rush yds', 'passing+rushing yards'], ['pass_yds', 'rush_yds']),
    S('td', 'Touchdowns (rush+rec)', ['td', 'tds', 'touchdowns', 'anytime td', 'atd', 'anytime touchdown', 'to score'], ['rush_td', 'rec_td']),
    S('rush_td', 'Rushing TDs', ['rush td', 'rush tds', 'rushing td', 'rushing tds']),
    S('rec_td', 'Receiving TDs', ['rec td', 'rec tds', 'receiving td', 'receiving tds']),
    S('tackles', 'Tackles', ['tackles', 'tkl', 'total tackles']),
    S('sacks', 'Sacks', ['sacks', 'sack']),
    S('kick_pts', 'Kicking points', ['kicking points', 'kick pts']),
    S('fg_made', 'Field goals made', ['fg', 'fgs', 'field goals', 'fg made']),
  ],
  hockey: [
    S('goals', 'Goals', ['goals', 'goal', 'g', 'to score', 'anytime goal']),
    S('assists', 'Assists', ['assists', 'assist', 'a', 'ast']),
    S('points', 'Points', ['points', 'pts', 'point', 'p'], ['goals', 'assists']),
    S('sog', 'Shots on goal', ['sog', 'shots', 'shots on goal', 's']),
    S('hits', 'Hits', ['hits', 'hit']),
    S('blocks', 'Blocked shots', ['blocks', 'blocked shots', 'blk', 'bs']),
    S('saves', 'Saves', ['saves', 'sv']),
    S('ga', 'Goals against', ['goals against', 'ga']),
  ],
  baseball: [
    S('hits', 'Hits', ['hits', 'hit', 'h']),
    S('runs', 'Runs', ['runs', 'run', 'r']),
    S('rbi', 'RBIs', ['rbi', 'rbis']),
    S('hr', 'Home runs', ['hr', 'hrs', 'home runs', 'home run', 'homer', 'homers']),
    S('bb', 'Walks', ['bb', 'walks', 'walk']),
    S('hrr', 'Hits+Runs+RBIs', ['hrr', 'h+r+rbi', 'hits+runs+rbis', 'hits runs rbis'], ['hits', 'runs', 'rbi']),
    S('pk', 'Pitcher strikeouts', ['k', 'ks', 'strikeouts', 'so', 'pitcher strikeouts', 'pitching strikeouts']),
    S('outs', 'Outs recorded', ['outs', 'outs recorded', 'pitching outs']),
    S('er', 'Earned runs allowed', ['er', 'earned runs']),
    S('h_allowed', 'Hits allowed', ['hits allowed']),
  ],
};

export function sportOf(league: string): Sport { return LEAGUES[league]?.sport ?? 'basketball'; }

export function findStat(league: string, text: string): StatDef | null {
  const t = text.toLowerCase().replace(/\s*\+\s*/g, '+').replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
  for (const d of STATS[sportOf(league)]) if (d.key === t || d.aliases.includes(t)) return d;
  return null;
}
/** Which sports recognise this stat text (used when league is not specified). */
export function sportsForStat(text: string): Sport[] {
  return (Object.keys(STATS) as Sport[]).filter((s) => {
    const t = text.toLowerCase().replace(/\s*\+\s*/g, '+').replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
    return STATS[s].some((d) => d.key === t || d.aliases.includes(t));
  });
}
export function statLabel(league: string, key: string | null): string {
  if (!key) return '';
  return STATS[sportOf(league)].find((d) => d.key === key)?.label ?? key;
}

export function statValue(league: string, key: string, line: PlayerLine): number | null {
  const def = STATS[sportOf(league)].find((d) => d.key === key);
  if (!def) return null;
  if (def.combo) {
    let sum = 0;
    for (const k of def.combo) sum += line.stats[k] ?? 0;
    return sum;
  }
  return line.stats[key] ?? 0;
}

// ---- Box score normalisation from ESPN summary.boxscore.players ----
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const first = (v: unknown) => num(String(v ?? '').split(/[-/]/)[0]);
const ipToOuts = (v: unknown) => { const [w, p] = String(v ?? '0').split('.'); return num(w) * 3 + num(p || 0); };

export function parseBox(league: string, summary: any): Box {
  const sport = sportOf(league);
  const box: Box = new Map();
  for (const team of summary?.boxscore?.players ?? []) {
    const abbr = team?.team?.abbreviation ?? '';
    for (const grp of team?.statistics ?? []) {
      const keys: string[] = grp.keys ?? [];
      const gname: string = (grp.name ?? '').toLowerCase();
      const pitching = keys.includes('fullInnings.partInnings');
      for (const a of grp.athletes ?? []) {
        const id = String(a?.athlete?.id ?? '');
        if (!id) continue;
        const pl: PlayerLine = box.get(id) ?? { id, name: a.athlete.displayName ?? '', team: abbr, dnp: false, stats: {} };
        const raw: Record<string, string> = {};
        keys.forEach((k, i) => (raw[k] = a.stats?.[i]));
        const s = pl.stats;
        const hasStats = (a.stats ?? []).length > 0;
        if (sport === 'basketball') {
          pl.dnp = !!a.didNotPlay || !hasStats;
          if (hasStats) {
            s.pts = num(raw.points); s.reb = num(raw.rebounds); s.ast = num(raw.assists);
            s.stl = num(raw.steals); s.blk = num(raw.blocks); s.to = num(raw.turnovers);
            s['3pm'] = first(raw['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);
            s.min = num(raw.minutes);
          }
        } else if (sport === 'football') {
          if (gname === 'passing') {
            const [c, att] = String(raw['completions/passingAttempts'] ?? '0/0').split('/');
            s.pass_comp = num(c); s.pass_att = num(att); s.pass_yds = num(raw.passingYards); s.pass_td = num(raw.passingTouchdowns); s.pass_int = num(raw.interceptions);
          } else if (gname === 'rushing') {
            s.rush_att = num(raw.rushingAttempts); s.rush_yds = num(raw.rushingYards); s.rush_td = num(raw.rushingTouchdowns);
          } else if (gname === 'receiving') {
            s.rec = num(raw.receptions); s.rec_yds = num(raw.receivingYards); s.rec_td = num(raw.receivingTouchdowns);
          } else if (gname === 'defensive') {
            s.tackles = num(raw.totalTackles); s.sacks = num(raw.sacks);
          } else if (gname === 'kicking') {
            s.fg_made = first(raw['fieldGoalsMade/fieldGoalAttempts']); s.kick_pts = num(raw.totalKickingPoints);
          }
        } else if (sport === 'hockey') {
          if (gname === 'goalies') { s.saves = num(raw.saves); s.ga = num(raw.goalsAgainst); }
          else { s.goals = num(raw.goals); s.assists = num(raw.assists); s.sog = num(raw.shotsTotal); s.hits = num(raw.hits); s.blocks = num(raw.blockedShots); }
          if (!hasStats) pl.dnp = true;
        } else if (sport === 'baseball') {
          if (pitching) { s.pk = num(raw.strikeouts); s.outs = ipToOuts(raw['fullInnings.partInnings']); s.er = num(raw.earnedRuns); s.h_allowed = num(raw.hits); }
          else { s.hits = num(raw.hits); s.runs = num(raw.runs); s.rbi = num(raw.RBIs); s.hr = num(raw.homeRuns); s.bb = num(raw.walks); }
        }
        box.set(id, pl);
      }
    }
  }
  return box;
}

/** Find a player in a box score by athlete id, else by normalised name. */
export function findInBox(box: Box, athleteId: string | null, name: string | null): PlayerLine | null {
  if (athleteId && box.has(athleteId)) return box.get(athleteId)!;
  if (!name) return null;
  const n = normName(name);
  for (const p of box.values()) if (normName(p.name) === n) return p;
  return null;
}
