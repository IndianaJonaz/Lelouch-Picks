// Turn what people type ("Jokic o10.5 reb", "GB -3.5", "CAR/GB u47.5", "Tatum 30+ pts (+150)")
// into a structured leg. Resolution against real games happens in resolve.ts.
import { LEAGUES } from './espn.ts';
import { sportsForStat } from './stats.ts';
import type { LegType } from './db.ts';

export interface ParsedLeg {
  raw: string;
  league: string | null;      // explicit league prefix, if any
  type: LegType;
  subject: string;            // player name (prop) or team text
  subject2: string | null;    // second team (game totals written "A/B o47.5")
  side: 'over' | 'under' | null;
  line: number | null;
  statText: string | null;
  odds: number | null;
}

export class ParseError extends Error {}

const OU = '(o|u|over|under)';
const NUM = '(\\d+(?:\\.\\d+)?)';

export function splitLegs(text: string): string[] {
  return text.split(/\r?\n|;|\s\|\s|\|/).map((s) => s.trim().replace(/^[-•*\d.)\s]+(?=[A-Za-z])/, '').trim()).filter(Boolean);
}

export function parseLeg(input: string): ParsedLeg {
  const raw = input.trim().replace(/\s+/g, ' ');
  let s = raw;
  let league: string | null = null;
  const lm = s.match(/^\[?(nba|wnba|nfl|nhl|mlb|ncaaf|cfb|ncaab|cbb)\]?[:\s]+/i);
  if (lm) {
    const k = lm[1].toLowerCase();
    league = k === 'cfb' ? 'ncaaf' : k === 'cbb' ? 'ncaab' : k;
    s = s.slice(lm[0].length);
  }
  // odds at the end: "(-115)", "@ +120", " -110" (only 3-4 digit integers count as odds)
  let odds: number | null = null;
  const om = s.match(/\s*(?:@\s*|\(\s*)?([+-]\d{3,4})\s*\)?\s*$/);
  if (om && !/\.\d$/.test(om[1])) {
    const v = Number(om[1]);
    if (Math.abs(v) >= 100) { odds = v; s = s.slice(0, om.index).trim(); }
  }
  const side = (t: string) => (t.toLowerCase().startsWith('o') ? 'over' : 'under') as 'over' | 'under';
  const base = { raw, league, odds, subject2: null as string | null };
  let m: RegExpMatchArray | null;

  // Moneyline
  if ((m = s.match(/^(.+?)\s+(ml|moneyline|money line|to win|win|outright)$/i))) {
    return { ...base, type: 'ml', subject: m[1].trim(), side: null, line: null, statText: null };
  }
  // Game total: "CAR/GB o47.5", "CAR @ GB under 47.5", "CAR vs GB o 47.5"
  if ((m = s.match(new RegExp(`^(.+?)\\s*(?:/|@|\\bvs\\.?|\\bv\\.?|\\bat\\b)\\s*(.+?)\\s+${OU}\\s*${NUM}$`, 'i')))) {
    return { ...base, type: 'total', subject: m[1].trim(), subject2: m[2].trim(), side: side(m[3]), line: Number(m[4]), statText: null };
  }
  // Anytime TD / to score / to hit a HR
  if ((m = s.match(/^(.+?)\s+(anytime td|anytime touchdown|atd|to score(?: a td| a goal)?|anytime goal|to hit a hr|to hit a home run|hr)$/i))) {
    const t = m[2].toLowerCase();
    const statText = t.includes('hr') || t.includes('home run') ? 'hr' : t.includes('goal') ? 'goals' : t === 'to score' ? 'to score' : 'anytime td';
    return { ...base, type: 'prop', subject: m[1].trim(), side: 'over', line: 0.5, statText };
  }
  // "GB -150" with no line besides odds -> moneyline
  if (odds !== null && !/\d/.test(s) && !/\b(over|under)\b/i.test(s)) {
    if (s.split(' ').length <= 3) return { ...base, type: 'ml', subject: s, side: null, line: null, statText: null };
  }
  // "Tatum 30+ pts"  => over 29.5
  if ((m = s.match(/^(.+?)\s+(\d+)\+\s*(.+)$/))) {
    return { ...base, type: 'prop', subject: m[1].trim(), side: 'over', line: Number(m[2]) - 0.5, statText: m[3].trim() };
  }
  // "Jokic o10.5 reb", "Josh Allen over 245.5 pass yds"
  if ((m = s.match(new RegExp(`^(.+?)\\s+${OU}\\s*${NUM}\\s+(.+)$`, 'i')))) {
    return { ...base, type: 'prop', subject: m[1].trim(), side: side(m[2]), line: Number(m[3]), statText: m[4].trim() };
  }
  // "Jokic reb o10.5" / "Jokic rebounds over 10.5"
  if ((m = s.match(new RegExp(`^(.+?)\\s+${OU}\\s*${NUM}$`, 'i')))) {
    const before = m[1].trim();
    const words = before.split(' ');
    for (let n = Math.min(4, words.length - 1); n >= 1; n--) {
      const stat = words.slice(-n).join(' ');
      if (sportsForStat(stat).length) {
        return { ...base, type: 'prop', subject: words.slice(0, -n).join(' '), side: side(m[2]), line: Number(m[3]), statText: stat };
      }
    }
    // Otherwise "GB o47.5": game total by one team
    return { ...base, type: 'total', subject: before, side: side(m[2]), line: Number(m[3]), statText: null };
  }
  // Spread: "GB -3.5", "Packers +7", "GB pk"
  if ((m = s.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?|pk|pick|pick'?em|even)$/i))) {
    const l = /^[+-]/.test(m[2]) ? Number(m[2]) : 0;
    return { ...base, type: 'spread', subject: m[1].trim(), side: null, line: l, statText: null };
  }
  throw new ParseError(`Couldn't read "${raw}". Try: "Jokic o10.5 reb", "GB -3.5", "CAR/GB u47.5", "GB ML", "Tatum 30+ pts (+150)".`);
}

export function isLeague(s: string): boolean { return s in LEAGUES; }
