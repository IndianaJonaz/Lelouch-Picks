// Edge Engine slip rating. Pure: no login, no browser, no Discord. The board arrives already parsed.
import type { ParsedLeg } from './parse.ts';
import { extractedLegLine } from './photoslips.ts';
import type { Extraction } from './slipvision.ts';
import { findStat } from './stats.ts';
import { fmtOdds, normName } from './util.ts';

const LEAGUE_OF: Record<string, string> = {
  nba: 'nba', wnba: 'wnba', nfl: 'nfl', nhl: 'nhl', mlb: 'mlb',
  cfb: 'ncaaf', ncaaf: 'ncaaf', cbb: 'ncaab', ncaab: 'ncaab',
};
const GRADE_RANK: Record<string, number> = { A: 3, B: 2, C: 1, D: 0 };

export interface EdgeProp {
  player: string;
  team: string;
  league: string;
  statLabel: string;
  stat: string | null;
  matchup: string;
  line: number;
  sim: number;
  diff: number | null;
  minutes: number | null;
  games: number | null;
  odds: number | null;
  /** Percent points, so 58.6 means +58.6%. */
  evPct: number | null;
  overPct: number;
  underPct: number;
  grade: string;
  featuredSide: 'over' | 'under' | null;
}

export interface RawEdgeCard {
  league?: string;
  player?: string;
  team?: string;
  market?: string;
  grade?: string;
  pill?: string;
  statsText?: string;
  sub?: string;
}

export interface EdgeQuery {
  raw: string;
  kind: 'prop' | 'other';
  player: string | null;
  names: string[];
  team: string | null;
  league: string | null;
  statText: string | null;
  side: 'over' | 'under' | null;
  line: number | null;
}

export interface EdgeLegRating {
  raw: string;
  status: 'same_line' | 'different_line' | 'miss' | 'ambiguous';
  text: string;
  edgePct: number | null;
  countsInParlay: boolean;
  grade: string | null;
  edgeLine: number | null;
  gap: number | null;
  cushion: number | null;
  player: string | null;
}

export interface EdgeSlipRating {
  legs: EdgeLegRating[];
  combinedPct: number | null;
  sameLine: number;
  matched: number;
  total: number;
  avgGrade: { letter: string; mean: number } | null;
  weakest: string | null;
  asOf: string | null;
  espn: { overall: number | null; weakest: string[] } | null;
}

export function edgeConfigured(c: { edgeEmail?: string; edgePassword?: string }): boolean {
  return !!(c.edgeEmail && c.edgePassword);
}

export function canonicalLeague(league: string | null | undefined): string | null {
  if (!league) return null;
  const k = league.toLowerCase().replace(/[^a-z]/g, '');
  return LEAGUE_OF[k] ?? null;
}

/** Map an Edge label ("Pts + Reb", "Rush + Rec Yards") onto our stat code. Null when we have no code. */
export function edgeStatCode(league: string | null, label: string): string | null {
  const folded = label.replace(/\byards\b/gi, 'yds').replace(/\bpoints\b/gi, 'pts');
  const tries = folded === label ? [label] : [label, folded];
  const leagues = canonicalLeague(league) ? [canonicalLeague(league)!] : ['nba', 'wnba', 'nfl', 'ncaaf', 'nhl', 'mlb', 'ncaab'];
  for (const l of leagues) {
    for (const t of tries) {
      const d = findStat(l, t);
      if (d) return d.key;
    }
  }
  return null;
}

/** True when two player names are the same after case, accents, periods and Jr/III are stripped. */
export function namesMatch(query: string, full: string): boolean {
  const q = normName(query);
  const f = normName(full);
  if (!q || !f) return false;
  if (q === f) return true;
  const qp = q.split(' ');
  const fp = f.split(' ');
  const last = fp[fp.length - 1] ?? '';
  if (qp.length === 1 && qp[0] === last && qp[0].length >= 3) return true;
  if (qp.length === 1 && fp[0] === qp[0] && qp[0].length >= 4) return true;
  if (qp.length === 2 && qp[0].length === 1 && fp[0]?.[0] === qp[0] && qp[1] === last) return true;
  return false;
}

export function queryFromLeg(p: ParsedLeg, resolved?: { player?: string | null; team?: string | null; league?: string | null; stat?: string | null } | null): EdgeQuery {
  const hm = p.type === 'prop' ? p.subject.match(/^(.*?)\s*\(([^)]+)\)\s*$/) : null;
  const player = hm ? hm[1]!.trim() : p.type === 'prop' ? p.subject : null;
  const hint = hm ? hm[2]!.trim() : null;
  const names = [...new Set([player, resolved?.player].map((s) => (s ?? '').trim()).filter(Boolean))];
  return {
    raw: p.raw,
    kind: p.type === 'prop' ? 'prop' : 'other',
    player: player || null,
    names,
    team: hint || resolved?.team || null,
    league: p.league || resolved?.league || null,
    statText: p.statText || resolved?.stat || null,
    side: p.side,
    line: p.line,
  };
}

export function edgeLinesFromExtraction(x: Extraction): string[] {
  return x.legs.map((l) => extractedLegLine(x, l)).filter((s): s is string => !!s);
}

function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}
function fmtNum(n: number): string {
  const r = round1(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
function signedNum(n: number): string {
  const s = fmtNum(n);
  return n > 0 ? `+${s}` : s;
}
function fmtPct(n: number): string {
  return fmtNum(n);
}
function signedPct(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtNum(Math.abs(n))}%`;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&middot;/gi, '·')
    .replace(/&minus;/gi, '−')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, ' ');
}
function stripTags(s: string): string {
  return decodeHtml(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function numToken(s: string): number {
  return Number(s.replace(/−/g, '-').replace(/[^\d.+-]/g, ''));
}

export function parseStatsText(text: string): { line: number | null; sim: number | null; minutes: number | null; games: number | null; odds: number | null; evPct: number | null } {
  const t = text.replace(/\s+/g, ' ').trim();
  const grab = (re: RegExp) => { const m = t.match(re); return m ? numToken(m[1]!) : null; };
  const line = grab(/Line\s+([+\-−]?\d+(?:\.\d+)?)/i);
  const sim = grab(/Sim\s+([+\-−]?\d+(?:\.\d+)?)/i);
  const minM = t.match(/Min\s+([+\-−]?\d+(?:\.\d+)?)(?!\s*g)/i);
  const minutes = minM ? numToken(minM[1]!) : null;
  const gM = t.match(/(\d+)\s*games?\b/i) ?? t.match(/(\d+)\s*g\b/i);
  const games = gM ? Number(gM[1]) : null;
  const evM = t.match(/EV\s+([+\-−]?\d+(?:\.\d+)?)\s*%/i);
  const evPct = evM ? numToken(evM[1]!) : null;
  const withoutEv = t.replace(/EV\s+[+\-−]?\d+(?:\.\d+)?\s*%/i, ' ');
  const oddsM = withoutEv.match(/(?:^|\s)([+\-−]\d{3,4})(?!\d|\.)/);
  const odds = oddsM ? numToken(oddsM[1]!) : null;
  return { line, sim, minutes, games, odds, evPct };
}

function pctPair(sub: string, pill: string): { over: number | null; under: number | null; featured: 'over' | 'under' | null } {
  const overM = sub.match(/Over\s+([\d.]+)\s*%/i);
  const underM = sub.match(/Under\s+([\d.]+)\s*%/i);
  let over = overM ? Number(overM[1]) : null;
  let under = underM ? Number(underM[1]) : null;
  const featured: 'over' | 'under' | null = /under/i.test(pill) ? 'under' : /over/i.test(pill) ? 'over' : null;
  if (over == null && under != null) over = round1(100 - under);
  if (under == null && over != null) under = round1(100 - over);
  if (over == null && featured) {
    const m = pill.match(/([\d.]+)\s*%/);
    if (m) {
      const n = Number(m[1]);
      if (featured === 'over') { over = n; under = round1(100 - n); }
      else { under = n; over = round1(100 - n); }
    }
  }
  return { over, under, featured };
}

export function cardToProp(card: RawEdgeCard): EdgeProp | null {
  const player = (card.player ?? '').trim();
  const market = stripTags(card.market ?? '');
  const parts = market.split(/\s*[·|]\s*/);
  const statLabel = (parts[0] ?? '').trim();
  const matchup = (parts[1] ?? '').trim();
  const stats = parseStatsText(stripTags(card.statsText ?? ''));
  const pct = pctPair(stripTags(card.sub ?? ''), stripTags(card.pill ?? ''));
  if (!player || stats.line == null || stats.sim == null || pct.over == null || pct.under == null) return null;
  const league = canonicalLeague(card.league) ?? '';
  const gradeRaw = (card.grade ?? '').replace(/[^A-Za-z]/g, '').toUpperCase();
  const grade = /^[ABCD]/.test(gradeRaw) ? gradeRaw[0]! : (gradeRaw[0] ?? '');
  return {
    player, team: (card.team ?? '').trim(), league, statLabel,
    stat: statLabel ? edgeStatCode(league || null, statLabel) : null,
    matchup, line: stats.line, sim: stats.sim,
    diff: round1(stats.sim - stats.line),
    minutes: stats.minutes, games: stats.games, odds: stats.odds, evPct: stats.evPct,
    overPct: pct.over, underPct: pct.under, grade, featuredSide: pct.featured,
  };
}

/** Pull prop cards out of Edge's board HTML. A marketing "fixed snapshot" is not a live board. */
export function parseBoardHtml(html: string): EdgeProp[] {
  if (/fixed snapshot/i.test(html)) return [];
  const props: EdgeProp[] = [];
  const re = /<div class="brow"/g;
  const starts: number[] = [];
  for (let m = re.exec(html); m; m = re.exec(html)) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const at = starts[i]!;
    const chunk = html.slice(at, starts[i + 1] ?? Math.min(html.length, at + 4000));
    const before = html.slice(Math.max(0, at - 800), at);
    const league = before.match(/\bbp-(nba|wnba|nfl|nhl|mlb|cfb|cbb)\b/g)?.at(-1)?.replace('bp-', '') ?? '';
    const span = (cls: string) => chunk.match(new RegExp(`<span class="${cls}[^"]*">([\\s\\S]*?)</span>`, 'i'))?.[1] ?? '';
    const div = (cls: string) => chunk.match(new RegExp(`<div class="${cls}[^"]*">([\\s\\S]*?)</div>`, 'i'))?.[1] ?? '';
    const prop = cardToProp({
      league,
      player: stripTags(span('bn')),
      team: stripTags(span('bteam')),
      market: div('bmkt'),
      grade: stripTags(span('bgl')),
      pill: stripTags(span('bpill')),
      statsText: div('bstats'),
      sub: div('bsub'),
    });
    if (prop) props.push(prop);
  }
  return props;
}

function teamHit(hint: string, prop: EdgeProp): boolean {
  const h = hint.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const t = prop.team.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!h) return false;
  if (t && (h === t || (h.length >= 2 && t.length >= 2 && (t.startsWith(h) || h.startsWith(t))))) return true;
  return prop.matchup.toUpperCase().split(/[^A-Z0-9]+/).includes(h);
}

function statMatch(q: EdgeQuery, p: EdgeProp): boolean {
  if (!q.statText) return false;
  const wanted = edgeStatCode(q.league || p.league || null, q.statText) ?? edgeStatCode(p.league || null, q.statText);
  const have = p.stat ?? (p.statLabel ? edgeStatCode(p.league || null, p.statLabel) : null);
  if (wanted && have) return wanted === have;
  const fold = (s: string) => normName(s).replace(/\byards\b/g, 'yds').replace(/\bpoints\b/g, 'pts');
  return !!p.statLabel && fold(q.statText) === fold(p.statLabel);
}

function espnSuffix(espn?: { score: number | null; reason: string; label?: string } | null): string {
  if (!espn) return '';
  if (espn.score == null) return ` · ESPN — ${espn.reason}`;
  return ` · ESPN ${espn.score}/10 — ${espn.reason}`;
}

function miss(q: EdgeQuery, note: string, espn?: { score: number | null; reason: string } | null): EdgeLegRating {
  return { raw: q.raw, status: 'miss', text: `${q.raw} — ${note}${espnSuffix(espn)}`, edgePct: null, countsInParlay: false, grade: null, edgeLine: null, gap: null, cushion: null, player: null };
}

function rateOne(q: EdgeQuery, board: EdgeProp[], espn?: { score: number | null; reason: string; label?: string } | null): EdgeLegRating {
  if (q.kind !== 'prop' || !q.side || q.line == null || !q.names.length) {
    const why = q.kind !== 'prop' ? "Not on Edge's board (player props only)" : "Not on Edge's board";
    return miss(q, why, espn);
  }
  const named = board.filter((p) => q.names.some((n) => namesMatch(n, p.player)));
  if (!named.length) return miss(q, "Not on Edge's board", espn);
  const id = (p: EdgeProp) => `${normName(p.player)}|${p.team.toUpperCase()}`;
  let pool = named;
  const identities = [...new Set(pool.map(id))];
  if (identities.length > 1) {
    if (q.team) pool = pool.filter((p) => teamHit(q.team!, p));
    const left = [...new Set(pool.map(id))];
    if (left.length !== 1) {
      const who = [...new Map(named.map((p) => [id(p), `${p.player} (${p.team || '?'})`])).values()];
      return {
        raw: q.raw, status: 'ambiguous', edgePct: null, countsInParlay: false, grade: null, edgeLine: null, gap: null, cushion: null, player: null,
        text: `${q.raw} — matches ${who.join(' and ')}; add the team.`,
      };
    }
  }
  const stated = pool.filter((p) => statMatch(q, p));
  if (!stated.length) return miss(q, "Not on Edge's board", espn);
  const line = q.line;
  const exact = stated.filter((p) => Math.abs(p.line - line) < 0.051);
  const chosen = exact[0] ?? stated.slice().sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line) || stated.indexOf(a) - stated.indexOf(b))[0]!;
  const same = exact.length > 0;
  const gap = round1(line - chosen.line);
  const cushion = round1(q.side === 'over' ? chosen.sim - line : line - chosen.sim);
  const sidePct = q.side === 'over' ? chosen.overPct : chosen.underPct;
  const sideWord = q.side === 'over' ? 'OVER' : 'UNDER';
  if (same) {
    const evOk = chosen.featuredSide == null || chosen.featuredSide === q.side;
    const bits = [`${q.raw} — ${chosen.player} Edge ${sideWord} ${fmtPct(sidePct)}% · sim ${fmtNum(chosen.sim)} · grade ${chosen.grade || '—'}`];
    if (evOk && chosen.evPct != null) bits.push(`EV ${signedPct(chosen.evPct)}`);
    else if (!evOk && chosen.featuredSide) bits.push(`card EV is for ${chosen.featuredSide.toUpperCase()}, not your side`);
    if (chosen.odds != null) bits.push(`odds ${fmtOdds(chosen.odds)}`);
    if (chosen.minutes != null) bits.push(`min ${fmtNum(chosen.minutes)}`);
    if (chosen.games != null) bits.push(`${chosen.games}g`);
    return {
      raw: q.raw, status: 'same_line', text: bits.join(' · '), edgePct: sidePct, countsInParlay: true,
      grade: chosen.grade || null, edgeLine: chosen.line, gap: 0, cushion, player: chosen.player,
    };
  }
  const featuredPct = chosen.featuredSide === 'under' ? chosen.underPct : chosen.overPct;
  const featuredWord = chosen.featuredSide === 'under' ? 'UNDER' : 'OVER';
  const way = gap > 0 ? `${fmtNum(gap)} higher` : `${fmtNum(Math.abs(gap))} lower`;
  const text = `${q.raw} — different line. ${chosen.player}: Edge's line is ${fmtNum(chosen.line)} (yours is ${way}). Sim ${fmtNum(chosen.sim)} · cushion ${signedNum(cushion)} vs your line · grade ${chosen.grade || '—'}. Edge's ${fmtPct(featuredPct)}% ${featuredWord} is for ${fmtNum(chosen.line)}, not your line.`;
  return {
    raw: q.raw, status: 'different_line', text, edgePct: null, countsInParlay: false,
    grade: chosen.grade || null, edgeLine: chosen.line, gap, cushion, player: chosen.player,
  };
}

export function rateEdgeLegs(legs: EdgeQuery[], board: EdgeProp[], opts?: {
  espnLegs?: ({ score: number | null; reason: string; label?: string } | null)[];
  espn?: { overall: number | null; weakest: string[] } | null;
  asOf?: string | null;
}): EdgeSlipRating {
  const rated = legs.map((q, i) => rateOne(q, board, opts?.espnLegs?.[i] ?? null));
  const same = rated.filter((l) => l.status === 'same_line' && l.edgePct != null);
  const matched = rated.filter((l) => l.status === 'same_line' || l.status === 'different_line').length;
  const product = same.reduce((a, l) => a * ((l.edgePct ?? 0) / 100), 1);
  const combinedPct = same.length ? Math.round(product * 1000) / 10 : null;
  const grades = rated.map((l) => (l.grade ? GRADE_RANK[l.grade] : undefined)).filter((n): n is number => n != null);
  const mean = grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : null;
  const letter = mean == null ? null : mean >= 2.5 ? 'A' : mean >= 1.5 ? 'B' : mean >= 0.5 ? 'C' : 'D';
  const weakestLeg = same.slice().sort((a, b) => (a.edgePct ?? 100) - (b.edgePct ?? 100))[0];
  return {
    legs: rated,
    combinedPct,
    sameLine: same.length,
    matched,
    total: rated.length,
    avgGrade: mean == null || letter == null ? null : { letter, mean },
    weakest: weakestLeg?.raw ?? null,
    asOf: opts?.asOf ?? null,
    espn: opts?.espn ?? null,
  };
}

export function formatEdgeAsOf(ms: number, tz = 'America/Chicago'): string {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms)).replace(/\u202f/g, ' ');
  const zone = tz === 'America/Chicago' ? 'CT' : tz;
  return `Edge data as of ${when} ${zone}`;
}

export function formatEdgeReport(r: EdgeSlipRating): string {
  const lines = r.legs.map((l) => l.text);
  const chance = r.combinedPct == null ? '— (no leg is on Edge\'s line)' : `${fmtPct(r.combinedPct)}% (assuming independence)`;
  const grade = r.avgGrade ? ` · avg grade ${r.avgGrade.letter} (${fmtNum(r.avgGrade.mean)})` : '';
  const weak = r.weakest ? ` · weakest: ${r.weakest}` : '';
  lines.push('', `Combined hit chance ${chance} · ${r.sameLine}/${r.total} legs on Edge's line${grade}${weak}`);
  if (r.espn) {
    const w = r.espn.weakest.length ? ` · weakest: ${r.espn.weakest.join(', ')}` : '';
    lines.push(`ESPN second opinion: ${r.espn.overall == null ? '—' : `${r.espn.overall}/10`}${w}`);
  }
  if (r.asOf) lines.push(r.asOf);
  return lines.join('\n').slice(0, 4000);
}
