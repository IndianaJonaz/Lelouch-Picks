// Read a sportsbook / DFS slip screenshot with xAI's vision model (OpenAI-compatible chat completions)
// and turn it into an import request. Values the model can't read stay null; nothing is guessed.
import type { LegStatus } from './db.ts';
import type { FinalStatus, ImportLeg } from './importer.ts';
import { sha256 } from './importer.ts';
import type { ParsedLeg } from './parse.ts';
import { decimalToAmerican, round2 } from './util.ts';

export const XAI_URL = 'https://api.x.ai/v1/chat/completions';
export const DEFAULT_XAI_MODEL = 'grok-4.3';

export type Conf = 'high' | 'medium' | 'low';
export type LegResult = 'won' | 'lost' | 'push' | 'void' | 'pending';
/** One leg as read. Anything not clearly printed is null — a blank to fill on the confirm card, never a guess. */
export interface ExtractedLeg {
  player: string | null; team: string | null; league: string | null; matchup: string | null;
  line: number | null; direction: 'over' | 'under' | null; stat: string | null; actual: number | null; leg_result: LegResult | null;
  confidence: Conf;
}
export interface Kalshi { side: 'yes' | 'no' | null; price_cents: number | null; contracts: number | null }
export interface Extraction {
  is_slip: boolean; confidence: Conf; platform: string | null; play_type: string | null; pick_count: number | null;
  stake: number | null; payout: number | null; odds_text: string | null; kalshi: Kalshi | null;
  status: 'won' | 'lost' | 'push' | 'void' | 'open' | 'unknown';
  games_date: string | null; screenshot_date: string | null; legs: ExtractedLeg[]; notes: string | null;
}
export interface PhotoRead { is_slip_image: boolean; slips: Extraction[] }

export const KNOWN_PLATFORMS = ['PrizePicks', 'Underdog', 'FanDuel', 'DraftKings', 'Sleeper', 'Kalshi'];
export const isKalshi = (x: Pick<Extraction, 'platform'>) => (x.platform ?? '').trim().toLowerCase() === 'kalshi';

const nullable = (t: string) => ({ type: [t, 'null'] });
const CONF = { type: 'string', enum: ['high', 'medium', 'low'] };
const SLIP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_slip', 'confidence', 'platform', 'play_type', 'pick_count', 'stake', 'payout', 'odds_text', 'kalshi', 'status', 'games_date', 'screenshot_date', 'legs', 'notes'],
  properties: {
    is_slip: { type: 'boolean' }, confidence: CONF,
    platform: nullable('string'), play_type: nullable('string'), pick_count: nullable('integer'),
    stake: nullable('number'), payout: nullable('number'), odds_text: nullable('string'),
    kalshi: {
      type: ['object', 'null'], additionalProperties: false, required: ['side', 'price_cents', 'contracts'],
      properties: { side: { type: ['string', 'null'], enum: ['yes', 'no', null] }, price_cents: nullable('number'), contracts: nullable('number') },
    },
    status: { type: 'string', enum: ['won', 'lost', 'push', 'void', 'open', 'unknown'] },
    games_date: nullable('string'), screenshot_date: nullable('string'),
    legs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['player', 'team', 'league', 'matchup', 'line', 'direction', 'stat', 'actual', 'leg_result', 'confidence'],
        properties: {
          player: nullable('string'), team: nullable('string'), league: nullable('string'), matchup: nullable('string'),
          line: nullable('number'), direction: { type: ['string', 'null'], enum: ['over', 'under', null] }, stat: nullable('string'),
          actual: nullable('number'), leg_result: { type: ['string', 'null'], enum: ['won', 'lost', 'push', 'void', 'pending', null] },
          confidence: CONF,
        },
      },
    },
    notes: nullable('string'),
  },
};
export const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['is_slip_image', 'slips'],
  properties: { is_slip_image: { type: 'boolean' }, slips: { type: 'array', items: SLIP_SCHEMA } },
} as const;

export const PROMPT = `You read photos and screenshots of sports betting / DFS pick slips and prediction-market tickets.
Platforms, in order of likelihood: PrizePicks (most common), Underdog, FanDuel, DraftKings, Sleeper, Kalshi. Any other or unfamiliar layout: still extract what is clearly printed but set that slip's confidence to "low" and platform to null unless the name is printed.
Images may be dark mode or light mode, tightly cropped, photographed at an angle, or contain SEVERAL slips (side by side, stacked, a grid). Return one entry in "slips" per distinct slip, top-to-bottom then left-to-right. is_slip_image=false (and slips=[]) only if there is no slip at all.
Return ONLY JSON matching the schema. NEVER invent or estimate a value: anything not clearly printed is null (a blank the user will fill in). If a leg is partly cut off, still return it with the readable fields and nulls for the rest. Keep legs in the exact printed order.
Per slip:
- stake: dollars paid/risked. payout: dollars paid out (won) or the potential total payout ("to pay"/"to win" incl. stake) if printed; else null.
- odds_text: the odds/multiplier exactly as printed ("+500", "-110", "6x", "37.5x"), else null.
- kalshi: for Kalshi tickets only: side yes/no, price_cents (price per contract in cents, e.g. 40 for 40¢), contracts (count). Else null.
- status: printed overall result (Win/Won/Cashed -> won, Loss/Lost -> lost, Refund/Push/Tie -> push, Void/Canceled/Refunded -> void, live/pending/in progress -> open). Unclear -> "unknown".
- pick_count: number of picks the header says ("6-Pick Power Play" -> 6, "3 leg parlay" -> 3), else null. Count the header, not your legs.
- games_date: YYYY-MM-DD only if a game date is printed next to the games. screenshot_date: YYYY-MM-DD of a timestamp printed on the slip.
- legs: player as printed (combos "A + B" as printed; for Kalshi/market tickets put the market title here). team: abbreviation as printed. league: tag as printed (NBA, NBAP, WNBA, NFL, NHL, MLB, CFB, CBB, LoL, CS2...). matchup: game line exactly as printed incl. scores ("BKN 128 vs MIA 144").
  line: number as printed. direction: down arrow / "Less" / "Under" = under; up arrow / "More" / "Over" = over. stat: as printed ("Points", "3-PT Made"; for spreads/moneylines the pick text like "Chiefs -3.5"; for Kalshi "Yes"/"No").
  actual: final stat shown, else null. leg_result: won (hit / green check), lost (miss / red X), push (tie icon), void (DNP / removed), pending (not final), null if not shown.
  confidence per leg: high only if every value was clearly legible; medium if one value was a little hard to read; low if anything was cut off or blurry.
- confidence per slip: high only if stake, payout/status and every leg were legible; low for cropped/blurry/unknown layouts.
- notes: anything odd (cropped, reduced payout, DNP, flex play) in a few words, else null.`;

export const REREAD_PROMPT = (first: unknown, problems: string[]) => `A first read of this image produced the JSON below, but it looks incomplete:
${problems.map((p) => '- ' + p).join('\n')}
Look again carefully, focusing on those parts (cut-off edges, faint or dark-mode text, every slip in the image). Return the COMPLETE corrected JSON for the whole image in the same schema, legs in printed order. Still never invent: unreadable values stay null with confidence "low".
First read:
${JSON.stringify(first)}`;

export class VisionError extends Error {}

export interface XaiOpts { apiKey: string; model?: string; fetch?: typeof fetch; timeoutMs?: number }

async function callXai(image: Uint8Array, mime: string, userText: string, o: XaiOpts): Promise<{ data: unknown; usage: any; model: string }> {
  const model = o.model || DEFAULT_XAI_MODEL;
  const body = {
    model, temperature: 0,
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mime === 'image/jpg' ? 'image/jpeg' : mime};base64,${Buffer.from(image).toString('base64')}`, detail: 'high' } },
        { type: 'text', text: userText },
      ] },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'slips', strict: true, schema: SCHEMA } },
  };
  const f = o.fetch ?? fetch;
  const call = (b: unknown) => f(XAI_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
    body: JSON.stringify(b), signal: AbortSignal.timeout(o.timeoutMs ?? 90_000),
  });
  let r = await call(body);
  let text = await r.text();
  // If the model/endpoint rejects the strict schema, fall back to plain JSON mode (the checks below still apply).
  if (r.status === 400 && /response_format|schema/i.test(text)) {
    r = await call({ ...body, response_format: { type: 'json_object' } });
    text = await r.text();
  }
  if (!r.ok) throw new VisionError(`xAI HTTP ${r.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  let j: any;
  try { j = JSON.parse(text); } catch { throw new VisionError('xAI returned non-JSON'); }
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new VisionError('xAI response had no content');
  try { return { data: JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')), usage: j.usage ?? null, model: j.model ?? model }; }
  catch { throw new VisionError('model output was not JSON'); }
}

/** Why a read looks incomplete (drives the single focused re-read). */
export function readProblems(read: any): string[] {
  const out: string[] = [];
  for (const [i, s] of (Array.isArray(read?.slips) ? read.slips : []).entries()) {
    const n = Array.isArray(s?.legs) ? s.legs.length : 0;
    const tag = `slip ${i + 1}`;
    if (s?.pick_count != null && n < s.pick_count) out.push(`${tag}: header says ${s.pick_count} picks but only ${n} legs were read`);
    if (s?.stake == null) out.push(`${tag}: stake missing`);
    if (s?.status === 'won' && s?.payout == null) out.push(`${tag}: marked won but payout missing`);
    for (const [j, l] of (s?.legs ?? []).entries()) {
      if (l?.confidence === 'low' || l?.line == null || l?.player == null) out.push(`${tag} leg ${j + 1} (${l?.player ?? '?'}): incomplete or low confidence`);
    }
  }
  return out;
}

const readScore = (read: any) => (Array.isArray(read?.slips) ? read.slips : []).reduce((n: number, s: any) =>
  n + (s?.legs ?? []).reduce((m: number, l: any) => m + 2 - (l?.confidence === 'low' ? 1 : 0) - (l?.line == null ? 1 : 0), 0) - (s?.stake == null ? 3 : 0), 0);

/** Read an image; if the first pass looks incomplete, do exactly one focused re-read and keep the better one. */
export async function extractSlips(image: Uint8Array, mime: string, o: XaiOpts): Promise<{ read: unknown; usage: any[]; model: string; reread: boolean }> {
  if (!o.apiKey) throw new VisionError('XAI_API_KEY not set');
  if (!/^image\/(png|jpe?g)$/.test(mime)) throw new VisionError(`unsupported image type ${mime}`);
  const first = await callXai(image, mime, 'Extract every slip in this image.', o);
  const problems = (first.data as any)?.is_slip_image === false ? [] : readProblems(first.data);
  if (!problems.length) return { read: first.data, usage: [first.usage], model: first.model, reread: false };
  const second = await callXai(image, mime, REREAD_PROMPT(first.data, problems), o).catch(() => null);
  if (!second) return { read: first.data, usage: [first.usage], model: first.model, reread: true };
  const better = readScore(second.data) >= readScore(first.data) ? second.data : first.data;
  return { read: better, usage: [first.usage, second.usage], model: second.model, reread: true };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => (isNum(v) ? v : null);
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): T | null => (xs.includes(v as T) ? (v as T) : null);
const CONFS = ['high', 'medium', 'low'] as const;

export function blankLeg(): ExtractedLeg {
  return { player: null, team: null, league: null, matchup: null, line: null, direction: null, stat: null, actual: null, leg_result: null, confidence: 'low' };
}
export function blankSlip(): Extraction {
  return { is_slip: true, confidence: 'low', platform: null, play_type: null, pick_count: null, stake: null, payout: null, odds_text: null, kalshi: null,
    status: 'unknown', games_date: null, screenshot_date: null, legs: [], notes: null };
}

/** Coerce whatever the model returned into a well-typed (possibly partial) slip. Bad values become blanks, never guesses. */
export function normalizeSlip(raw: any): Extraction {
  const x = blankSlip();
  if (!raw || typeof raw !== 'object') return x;
  x.is_slip = raw.is_slip !== false;
  x.confidence = oneOf(raw.confidence, CONFS) ?? 'low';
  x.platform = str(raw.platform); x.play_type = str(raw.play_type);
  x.pick_count = Number.isInteger(raw.pick_count) && raw.pick_count > 0 && raw.pick_count <= 25 ? raw.pick_count : null;
  x.stake = num(raw.stake) != null && raw.stake > 0 ? raw.stake : null;
  x.payout = num(raw.payout) != null && raw.payout >= 0 ? raw.payout : null;
  x.odds_text = str(raw.odds_text);
  x.kalshi = raw.kalshi && typeof raw.kalshi === 'object'
    ? { side: oneOf(raw.kalshi.side, ['yes', 'no'] as const), price_cents: num(raw.kalshi.price_cents), contracts: num(raw.kalshi.contracts) } : null;
  x.status = oneOf(raw.status, ['won', 'lost', 'push', 'void', 'open', 'unknown'] as const) ?? 'unknown';
  x.games_date = typeof raw.games_date === 'string' && DATE.test(raw.games_date) ? raw.games_date : null;
  x.screenshot_date = typeof raw.screenshot_date === 'string' && DATE.test(raw.screenshot_date) ? raw.screenshot_date : null;
  x.notes = str(raw.notes);
  x.legs = (Array.isArray(raw.legs) ? raw.legs : []).slice(0, 25).map((l: any): ExtractedLeg => ({
    player: str(l?.player), team: str(l?.team), league: str(l?.league), matchup: str(l?.matchup),
    line: num(l?.line) != null && l.line >= 0 ? l.line : null, direction: oneOf(l?.direction, ['over', 'under'] as const), stat: str(l?.stat),
    actual: num(l?.actual), leg_result: oneOf(l?.leg_result, ['won', 'lost', 'push', 'void', 'pending'] as const), confidence: oneOf(l?.confidence, CONFS) ?? 'low',
  }));
  // Partial read: the header says more picks than we saw -> add blank legs to fill in (never invented).
  while (x.pick_count != null && x.legs.length < x.pick_count) x.legs.push(blankLeg());
  // Kalshi: stake = contracts x price when not printed.
  if (isKalshi(x) && x.stake == null && x.kalshi?.contracts && x.kalshi.price_cents) x.stake = Math.round(x.kalshi.contracts * x.kalshi.price_cents) / 100;
  // Kalshi: each winning contract pays $1.
  if (isKalshi(x) && x.payout == null && x.kalshi?.contracts) x.payout = x.kalshi.contracts;
  // A slip where nothing won can't be a win (all push/void legs = stake back).
  if (x.status === 'won' && x.legs.length && x.legs.every((l) => l.leg_result === 'push' || l.leg_result === 'void')) {
    x.status = x.legs.every((l) => l.leg_result === 'void') ? 'void' : 'push';
    x.notes = [x.notes, 'all legs push/void — not a win'].filter(Boolean).join(' · ');
  }
  return x;
}

export function legMissing(x: Pick<Extraction, 'platform'>, l: ExtractedLeg): string[] {
  const miss: string[] = [];
  if (!l.player) miss.push(isKalshi(x) ? 'market' : 'player');
  if (isKalshi(x)) { if (!l.stat) miss.push('yes/no'); return miss; }
  if (l.line == null) miss.push('line');
  if (!l.direction) miss.push('over/under');
  if (!l.stat) miss.push('stat');
  return miss;
}

/** What blocks confirming (must be filled via Edit) and what to double-check (flags on the card). */
export function checkSlip(x: Extraction): { blocking: string[]; flags: string[] } {
  const blocking: string[] = [];
  const flags: string[] = [];
  if (x.stake == null) blocking.push('stake');
  else if (x.stake > 1000) blocking.push('stake over 1000');
  if (x.status === 'unknown') blocking.push('result (won/lost/push/void/open)');
  if (x.status === 'won' && (x.payout == null || x.payout <= (x.stake ?? 0))) blocking.push('payout (needed for a win)');
  if (!x.legs.length) blocking.push('legs');
  x.legs.forEach((l, i) => { const m = legMissing(x, l); if (m.length) blocking.push(`leg ${i + 1}: ${m.join(', ')}`); });
  const known = !!x.platform && KNOWN_PLATFORMS.some((p) => p.toLowerCase() === x.platform!.toLowerCase());
  if (!known) flags.push(`Unrecognised layout${x.platform ? ` (${x.platform})` : ''} — check every value`);
  else if (x.confidence === 'low') flags.push('Low confidence read — check every value');
  if (x.pick_count != null && x.pick_count !== x.legs.length) flags.push(`Header says ${x.pick_count} picks, ${x.legs.length} listed`);
  const low = x.legs.map((l, i) => (l.confidence === 'low' && !legMissing(x, l).length ? i + 1 : 0)).filter(Boolean);
  if (low.length) flags.push(`Unsure about leg(s) ${low.join(', ')}`);
  if (x.notes) flags.push(x.notes);
  return { blocking, flags };
}

/** Whole-image read -> normalized slips (empty + notSlip when the model is sure there's no slip). */
export function normalizeRead(raw: unknown): { slips: Extraction[]; notSlip: boolean } {
  const r = raw as PhotoRead;
  if (!r || typeof r !== 'object') return { slips: [blankSlip()], notSlip: false };
  if (r.is_slip_image === false) return { slips: [], notSlip: true };
  const slips = (Array.isArray(r.slips) ? r.slips : []).slice(0, 6).map(normalizeSlip).filter((s) => s.is_slip);
  return slips.length ? { slips, notSlip: false } : { slips: [blankSlip()], notSlip: false };
}

const LEAGUE_MAP: Record<string, string> = { nba: 'nba', nbap: 'nba', nba1h: 'nba', wnba: 'wnba', nfl: 'nfl', nflp: 'nfl', nhl: 'nhl', nhlp: 'nhl', mlb: 'mlb', mlbp: 'mlb', cfb: 'ncaaf', ncaaf: 'ncaaf', cbb: 'ncaab', ncaab: 'ncaab' };
const TEAM_ALIASES: Record<string, string> = { SAS: 'SA', GSW: 'GS', NYK: 'NY', NOP: 'NO', UTA: 'UTAH', WAS: 'WSH', PHO: 'PHX', BRK: 'BKN', CHO: 'CHA', GSV: 'GS' };
export function normStat(s: string): string {
  return s.toLowerCase().trim()
    .replace(/^3-?pt(?:s)? made$/, '3pm').replace(/^3-?pointers made$/, '3pm')
    .replace(/\brebs\b/g, 'reb').replace(/\basts\b/g, 'ast').replace(/\bstls\b/g, 'stl').replace(/\bblks\b/g, 'blk')
    .replace(/^blk\+stl$/, 'stl+blk').replace(/\s+/g, ' ');
}
const team = (t: string | null) => (t ? TEAM_ALIASES[t.trim().toUpperCase()] ?? t.trim().toUpperCase() : null);

export function parseMatchupScores(m: string | null): { team: string; score: number }[] | null {
  if (!m) return null;
  const out = [...m.matchAll(/\b([A-Z]{2,4})\s+(\d{1,3})\b/g)].map((x) => ({ team: x[1], score: Number(x[2]) }));
  return out.length === 2 ? out : null;
}

export interface PhotoImport {
  legs: ImportLeg[]; stake: number; payout: number | null; odds: number | null; oddsText: string | null; title: string; book: string | null; playType: string | null;
  result: { status: FinalStatus; profit: number } | null; date: string | null; searchBackFrom: string | null; contentKey: string;
}

/** Turn a complete, confirmed slip into an import request. Throws if anything is still blank (the card blocks that). */
export function toImport(x: Extraction): PhotoImport {
  const { blocking } = checkSlip(x);
  if (blocking.length) throw new VisionError(`still missing: ${blocking.join('; ')}`);
  const stake = x.stake!;
  const kalshi = isKalshi(x);
  const legs: ImportLeg[] = x.legs.map((l) => {
    const player = l.player!.trim();
    const t = kalshi ? null : team(l.team);
    const lg = kalshi ? 'kalshi' : l.league ? LEAGUE_MAP[l.league.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? null : null;
    const subject = t ? `${player} (${t})` : player;
    const stat = l.stat!.trim();
    const parsed: ParsedLeg = {
      raw: kalshi ? `${player} — ${stat}` : `${player}${t ? ` (${t})` : ''} ${l.direction === 'over' ? 'o' : 'u'}${l.line} ${stat}`,
      // Unknown league tags (LoL, Kalshi…) are kept as-is so the importer stores them as manual legs graded from the slip.
      league: lg ?? (l.league ? l.league.trim() : null), type: 'prop', subject, subject2: null,
      side: kalshi ? null : l.direction, line: kalshi ? null : l.line, statText: kalshi ? stat.toUpperCase() : normStat(stat), odds: null,
    };
    return { parsed, hint: { actual: l.actual, result: (l.leg_result === 'pending' ? null : l.leg_result) as LegStatus | null, scores: parseMatchupScores(l.matchup), leagueLabel: kalshi ? 'Kalshi' : l.league, statLabel: kalshi ? stat.toUpperCase() : stat } };
  });
  let payout = x.payout;
  if (kalshi && payout == null && x.kalshi?.contracts) payout = x.kalshi.contracts; // each contract pays $1
  let dec: number | null = payout != null && payout > stake ? payout / stake : null;
  if (kalshi && x.kalshi?.price_cents && x.kalshi.price_cents > 0 && x.kalshi.price_cents < 100) dec = 100 / x.kalshi.price_cents;
  let odds: number | null = null;
  if (dec && dec > 1) { const a = decimalToAmerican(dec); odds = Math.abs(a) >= 100 && Math.abs(a) <= 100000 ? a : null; }
  const oddsText = kalshi && x.kalshi
    ? [x.kalshi.side?.toUpperCase(), x.kalshi.price_cents != null ? `${x.kalshi.price_cents}¢` : null, x.kalshi.contracts != null ? `× ${x.kalshi.contracts}` : null].filter(Boolean).join(' ') || x.odds_text
    : x.odds_text;
  // push/void = stake back (net 0), never a win.
  const result = x.status === 'open' ? null
    : { status: x.status as FinalStatus, profit: x.status === 'won' ? round2(payout! - stake) : x.status === 'lost' ? round2(-stake) : 0 };
  const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  const n = x.legs.length;
  const what = kalshi ? 'Kalshi' : `${n}-pick`;
  const title = `${money(stake)} ${what}${x.status === 'won' && payout != null ? ` — paid ${money(payout)}` : payout != null ? ` — to pay ${money(payout)}` : ''}`.slice(0, 60);
  const contentKey = 'c:' + sha256(JSON.stringify([stake, payout, x.games_date ?? x.screenshot_date,
    x.legs.map((l) => [l.player!.toLowerCase().trim(), l.line, l.direction, normStat(l.stat!)])]));
  return { legs, stake, payout, odds, oddsText, title, book: x.platform, playType: x.play_type, result, date: x.games_date, searchBackFrom: x.screenshot_date, contentKey };
}

/** Lines for the Edit form: "[NBA] Giannis Antetokounmpo (MIA) u20 Points = push 20". Blanks are "?". */
export function legsToText(x: Extraction): string {
  return x.legs.map((l) => {
    if (isKalshi(x)) return `${l.player ?? '?'} | ${l.stat ?? '?'}${l.leg_result ? ` = ${l.leg_result}` : ''}`;
    const res = l.leg_result ? ` = ${l.leg_result}${l.actual != null ? ' ' + l.actual : ''}` : '';
    return `${l.league ? `[${l.league}] ` : ''}${l.player ?? '?'}${l.team ? ` (${l.team})` : ''} ${l.direction === 'over' ? 'o' : l.direction === 'under' ? 'u' : '?'}${l.line ?? '?'} ${l.stat ?? '?'}${res}`;
  }).join('\n');
}

/** Parse the Edit form back. Order is kept as typed; matchup/scores carry over from the read when the player matches. */
export function textToLegs(text: string, x: Extraction): ExtractedLeg[] {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 25) throw new VisionError('Max 25 legs.');
  const q = (v: string | undefined) => (v == null || v.trim() === '' || v.trim() === '?' ? null : v.trim());
  return lines.map((line, i) => {
    let s = line;
    let leg_result: ExtractedLeg['leg_result'] = null; let actual: number | null = null;
    const rm = s.match(/\s*=\s*(won|win|hit|lost|loss|miss|push|void|dnp|pending)(?:\s+(-?\d+(?:\.\d+)?))?\s*$/i);
    if (rm) {
      const w = rm[1].toLowerCase();
      leg_result = w === 'win' || w === 'hit' ? 'won' : w === 'loss' || w === 'miss' ? 'lost' : w === 'dnp' ? 'void' : (w as ExtractedLeg['leg_result']);
      actual = rm[2] != null ? Number(rm[2]) : null; s = s.slice(0, rm.index).trim();
    }
    const prev = x.legs[i];
    if (isKalshi(x)) {
      const [market, side] = s.split('|');
      return { ...blankLeg(), player: q(market), stat: q(side)?.toUpperCase() ?? null, leg_result, actual, confidence: 'high' };
    }
    let league: string | null = null;
    const lm = s.match(/^\[([^\]]+)\]\s*/);
    if (lm) { league = q(lm[1]); s = s.slice(lm[0].length); }
    const m = s.match(/^(.+?)\s+(o|u|over|under|\?)\s*(\d+(?:\.\d+)?|\?)\s+(.+)$/i);
    if (!m) throw new VisionError(`Line ${i + 1}: write it like "Jayson Tatum (BOS) u19.5 Points = won 19".`);
    let player = m[1].trim(); let teamTxt: string | null = null;
    const tm = player.match(/^(.*?)\s*\(([^)]+)\)$/);
    if (tm) { player = tm[1].trim(); teamTxt = tm[2].trim(); }
    const d = m[2].toLowerCase();
    const same = prev && prev.player && q(player) && prev.player.toLowerCase() === player.toLowerCase();
    return {
      player: q(player), team: teamTxt, league, matchup: same ? prev.matchup : null,
      line: m[3] === '?' ? null : Number(m[3]), direction: d.startsWith('o') ? 'over' : d.startsWith('u') ? 'under' : null, stat: q(m[4]),
      actual, leg_result, confidence: 'high',
    };
  });
}
