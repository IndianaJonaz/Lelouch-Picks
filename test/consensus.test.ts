import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConsensusFeed, combineSources, espnPropProbability, implied, kalshiEventFor, kalshiProbability, kalshiRows, oddsApiProbability,
  probToScore, propRowsFromEspn, type PropRow,
} from '../src/consensus.ts';
import { buildTriple, edgeScore, formatTripleReport, isStrongLeg, isWeakLeg, legEmoji, STRONG_MIN, WEAK_MAX } from '../src/tripleview.ts';
import { rateEdgeSlip, tripleLabel } from '../src/edgeslip.ts';
import type { EdgeLegRating, EdgeProp } from '../src/edgerate.ts';
import { fakeEspn, leg } from './helpers.ts';

const close = (a: number | null | undefined, b: number, eps = 1e-3) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// Shaped like ESPN core propBets (DraftKings, provider 100), trimmed to the fields we read.
const bet = (aid: string, type: string, american: string, target?: number) => ({
  athlete: { $ref: `http://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2027/athletes/${aid}?lang=en` },
  type: { name: type }, odds: { american: { value: american } },
  ...(target == null ? {} : { current: { target: { value: target } } }),
});
const PROPS = {
  count: 9, pageCount: 1,
  items: [
    bet('1', 'Total Rebounds', '+113', 4.5), bet('1', 'Total Rebounds', '-150', 4.5),
    bet('1', 'Rebounds Milestones', '+114', 5),
    bet('2', 'Total Assists', '+134', 2.5), bet('2', 'Total Assists', '-178', 2.5),
    bet('2', 'Assists Milestones', '+337', 4),
    // under listed first: the milestone decides which row is the over
    bet('3', 'Total 3-Point Field Goals', '+120', 2.5), bet('3', 'Total 3-Point Field Goals', '-158', 2.5),
    bet('3', '3-Point Field Goals Milestones', '-163', 3),
    // conflicting duplicate milestones are ignored
    bet('4', 'Rebounds Milestones', '+416', 3), bet('4', 'Rebounds Milestones', '-577', 3),
    bet('5', 'Anytime Touchdown Scorer', '+150'),
  ],
};

test('1–10 mapping: probability × 10, rounded and clamped', () => {
  assert.equal(probToScore(0.5), 5);
  assert.equal(probToScore(0.44), 4);
  assert.equal(probToScore(0.62), 6);
  assert.equal(probToScore(0.01), 1);
  assert.equal(probToScore(0.99), 10);
  assert.equal(probToScore(null), null);
  close(implied(-150), 0.6);
  close(implied(+113), 100 / 213);
  assert.equal(implied(50), null);
});

test('DK via ESPN: exact two-way line is de-vigged', () => {
  const rows = propRowsFromEspn(PROPS);
  const s = espnPropProbability(rows, { league: 'nba', athleteId: '1', stat: 'reb', side: 'over', line: 4.5 });
  const po = 100 / 213, pu = 0.6;
  close(s?.p, po / (po + pu));
  assert.match(s!.detail, /DK o4\.5 \+113 → 44% no-vig/);
  const u = espnPropProbability(rows, { league: 'nba', athleteId: '1', stat: 'reb', side: 'under', line: 4.5 });
  close(u?.p, pu / (po + pu));
});

test('DK via ESPN: over row found by milestone when ESPN lists the under first', () => {
  const rows = propRowsFromEspn(PROPS);
  const s = espnPropProbability(rows, { league: 'nba', athleteId: '3', stat: '3pm', side: 'over', line: 2.5 });
  const po = implied(-158)!, pu = implied(120)!;
  close(s?.p, po / (po + pu));
  assert.match(s!.detail, /o2\.5 −158/);
});

test('DK via ESPN: no exact line falls back to the N+ milestone; under is 1 − p', () => {
  const rows = propRowsFromEspn(PROPS);
  const o = espnPropProbability(rows, { league: 'nba', athleteId: '2', stat: 'ast', side: 'over', line: 3.5 });
  close(o?.p, 100 / 437);
  assert.match(o!.detail, /alt 4\+ \+337 → 23% \(incl\. vig\)/);
  const u = espnPropProbability(rows, { league: 'nba', athleteId: '2', stat: 'ast', side: 'under', line: 3.5 });
  close(u?.p, 1 - 100 / 437);
  // whole-number line: no milestone math (push risk), so nothing
  assert.equal(espnPropProbability(rows, { league: 'nba', athleteId: '2', stat: 'ast', side: 'over', line: 4 }), null);
  // conflicting duplicates → n/a, never a guess
  assert.equal(espnPropProbability(rows, { league: 'nba', athleteId: '4', stat: 'reb', side: 'over', line: 2.5 }), null);
  // unknown player
  assert.equal(espnPropProbability(rows, { league: 'nba', athleteId: '99', stat: 'reb', side: 'over', line: 4.5 }), null);
});

test('DK via ESPN: anytime TD uses the anytime scorer price', () => {
  const rows: PropRow[] = propRowsFromEspn(PROPS);
  const s = espnPropProbability(rows, { league: 'nfl', athleteId: '5', stat: 'td', side: 'over', line: 0.5 });
  close(s?.p, 0.4);
});

const KALSHI = {
  markets: [
    { title: 'Jamal Murray: 4+ threes', strike_type: 'greater', floor_strike: 3.5, yes_bid_dollars: '0.3800', yes_ask_dollars: '0.4000' },
    { title: 'Jamal Murray: 6+ threes', strike_type: 'greater', floor_strike: 5.5, yes_bid_dollars: '0.0300', yes_ask_dollars: '0.2000' },
    { title: 'Kyle Kuzma: 6+ assists', strike_type: 'greater', floor_strike: 5.5, yes_bid_dollars: '0.0000', yes_ask_dollars: '0.0600' },
  ],
};

test('Kalshi: mid of a tight two-sided book; thin books are skipped', () => {
  const rows = kalshiRows(KALSHI);
  const o = kalshiProbability(rows, { player: 'Jamal Murray', side: 'over', line: 3.5 });
  close(o?.p, 0.39);
  assert.match(o!.detail, /Kalshi 4\+ 38\/40¢ → 39%/);
  close(kalshiProbability(rows, { player: 'jamal murray', side: 'under', line: 3.5 })?.p, 0.61);
  assert.equal(kalshiProbability(rows, { player: 'Jamal Murray', side: 'over', line: 5.5 }), null, 'spread 17¢ > 15¢');
  assert.equal(kalshiProbability(rows, { player: 'Kyle Kuzma', side: 'over', line: 5.5 }), null, 'no bid');
  assert.equal(kalshiProbability(rows, { player: 'Jamal Murray', side: 'over', line: 4 }), null, 'whole-number line');
});

test('Kalshi event matched by both teams, with ESPN→Kalshi abbreviations', () => {
  const events = [{ event_ticker: 'KXNBA3PT-26NOV04UTANOP' }, { event_ticker: 'KXNBA3PT-26NOV04TORDEN' }, { event_ticker: 'KXNBA3PT-26NOV05DENTOR' }];
  assert.equal(kalshiEventFor(events, ['UTAH', 'NO']), 'KXNBA3PT-26NOV04UTANOP');
  assert.equal(kalshiEventFor(events, ['TOR', 'DEN']), 'KXNBA3PT-26NOV04TORDEN');
  assert.equal(kalshiEventFor(events, ['LAL', 'SAC']), null);
});

test('Odds API (optional): mean no-vig across books at the exact line', () => {
  const book = (over: number, under: number, point = 3.5) => ({ markets: [{ key: 'player_assists', outcomes: [
    { name: 'Over', description: 'Kyle Kuzma', price: over, point }, { name: 'Under', description: 'Kyle Kuzma', price: under, point },
  ] }] });
  const s = oddsApiProbability({ bookmakers: [book(150, -190), book(140, -180), book(-110, -110, 4.5)] }, { player: 'Kyle Kuzma', side: 'over', line: 3.5, market: 'player_assists' });
  const nv = (o: number, u: number) => implied(o)! / (implied(o)! + implied(u)!);
  close(s?.p, (nv(150, -190) + nv(140, -180)) / 2);
  assert.match(s!.detail, /2 books/);
});

test('combine: mean of sources, n/a when none', () => {
  const c = combineSources([{ name: 'DK', p: 0.44, detail: 'a' }, { name: 'Kalshi', p: 0.36, detail: 'b' }]);
  close(c.p, 0.4);
  assert.equal(c.score, 4);
  const none = combineSources([]);
  assert.equal(none.score, null);
  assert.equal(none.p, null);
});

function feedFor(routes: Record<string, unknown>, calls: string[] = []) {
  return new ConsensusFeed({ fetcher: async (url) => {
    calls.push(url);
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) { if (v instanceof Error) throw v; return structuredClone(v); }
    throw new Error('HTTP 404');
  } });
}

test('feed: DK + Kalshi averaged; results cached; a down source is just absent', async () => {
  const calls: string[] = [];
  const feed = feedFor({
    '/events/E1/competitions/E1/odds/100/propBets': { pageCount: 1, items: [bet('3', '3-Point Field Goals Milestones', '+148', 4)] },
    'events?series_ticker=KXNBA3PT': { events: [{ event_ticker: 'KXNBA3PT-26NOV04TORDEN' }] },
    'markets?event_ticker=KXNBA3PT-26NOV04TORDEN': KALSHI,
  }, calls);
  const q = { league: 'nba', eventId: 'E1', eventName: 'TOR @ DEN', athleteId: '3', player: 'Jamal Murray', team: 'DEN', stat: '3pm', side: 'over' as const, line: 3.5 };
  const c = await feed.rate(q);
  assert.equal(c.sources.length, 2);
  close(c.p, (100 / 248 + 0.39) / 2);
  assert.equal(c.score, 4);
  const n = calls.length;
  await feed.rate(q);
  assert.equal(calls.length, n, 'second rate is served from cache');

  const down = feedFor({ propBets: new Error('HTTP 500'), series_ticker: new Error('HTTP 500') });
  const d = await down.rate(q);
  assert.equal(d.score, null);
  assert.match(d.note, /no market/);
});

test('feed: Kalshi 429 is retried once', async () => {
  let n = 0;
  const feed = new ConsensusFeed({ fetcher: async (url) => {
    if (url.includes('series_ticker')) return { events: [{ event_ticker: 'KXNBA3PT-26NOV04TORDEN' }] };
    if (url.includes('event_ticker')) { n++; if (n === 1) throw new Error('HTTP 429'); return KALSHI; }
    throw new Error('HTTP 404');
  } });
  const rows = await feed.kalshiRowsFor('nba', '3pm', ['TOR', 'DEN']);
  assert.equal(rows.length, 3);
  assert.equal(n, 2);
});

const miss = (raw: string): EdgeLegRating => ({ raw, status: 'miss', text: '', edgePct: null, countsInParlay: false, grade: null, edgeLine: null, gap: null, cushion: null, player: null });

test('Edge score: sim % ÷ 10 on your exact line, n/a otherwise', () => {
  assert.deepEqual(edgeScore({ ...miss('x'), status: 'same_line', edgePct: 62.4, grade: 'B' }).score, 6);
  assert.equal(edgeScore({ ...miss('x'), status: 'same_line', edgePct: 3 }).score, 1);
  assert.equal(edgeScore(miss('x')).score, null);
  assert.equal(edgeScore({ ...miss('x'), status: 'different_line', edgeLine: 4.5 }).score, null);
  assert.match(edgeScore({ ...miss('x'), status: 'different_line', edgeLine: 4.5 }).note, /4\.5/);
});

test('report: three separate ratings, ⚠️ on each weak rating and on weak legs', () => {
  const legs = buildTriple(
    ['Kyle Kuzma o3.5 AST', 'Jamal Murray o3.5 3PM'],
    [miss('a'), miss('b')],
    [{ label: 'a', score: 6, reason: 'hit 6/10' }, { label: 'b', score: 2, reason: 'hit 2/10' }],
    [{ score: 4, p: 0.4, sources: [], note: 'DK 40%' }, { score: 3, p: 0.3, sources: [], note: 'DK 30%' }],
  );
  const text = formatTripleReport(legs);
  assert.match(text, /\*\*Kyle Kuzma o3\.5 AST\*\* — Edge n\/a · ESPN 6\/10 · Consensus 4\/10 ⚠️/);
  assert.ok(!/^1\. ⚠️/m.test(text), 'avg 5 is not a weak leg');
  assert.match(text, /^2\. ⚠️ \*\*Jamal Murray o3\.5 3PM\*\* — Edge n\/a · ESPN 2\/10 ⚠️ · Consensus 3\/10 ⚠️/m);
  assert.equal(isWeakLeg(legs[1]!), true);
  assert.match(text, /Consensus 12% \(2\/2 legs priced\)/);
  assert.match(text, new RegExp(`Caution \\(a rating ≤${WEAK_MAX}/10\\): Kyle Kuzma o3\\.5 AST, Jamal Murray o3\\.5 3PM`));
  assert.match(text, /\*\*Slip\*\* \(avg of rated legs\): Edge n\/a · ESPN 4\/10 ⚠️ · Consensus 3\.5\/10 ⚠️/);
});

test('label: "Player o3.5 AST"', () => {
  assert.equal(tripleLabel(leg({ player: 'Kyle Kuzma', stat: 'ast', side: 'over', line: 3.5 }), 'raw'), 'Kyle Kuzma o3.5 AST');
  assert.equal(tripleLabel(leg({ player: 'Jamal Murray', stat: '3pm', side: 'over', line: 3.5 }), 'raw'), 'Jamal Murray o3.5 3PM');
  assert.equal(tripleLabel(null, ' GB -3.5 '), 'GB -3.5');
});

test('pipeline: Edge board hit, ESPN down, consensus from DK — nothing invented', async () => {
  const espn = fakeEspn({ gamelog: new Error('HTTP 500') });
  const board: EdgeProp[] = [{
    player: 'Jamal Murray', team: 'DEN', league: 'nba', statLabel: '3PT Made', stat: '3pm', matchup: 'TOR @ DEN', line: 3.5, sim: 3.9,
    diff: 0.4, minutes: 34, games: 10, odds: -110, evPct: 5, overPct: 57, underPct: 43, grade: 'B', featuredSide: 'over',
  }];
  const resolve = async (t: string) => {
    if (/murray/i.test(t)) return leg({ raw: t, player: 'Jamal Murray', team: 'DEN', athlete_id: '3', event_id: 'E1', event_name: 'TOR @ DEN', stat: '3pm', side: 'over', line: 3.5 });
    return leg({ raw: t, player: 'Kyle Kuzma', team: 'MIL', athlete_id: '2', event_id: 'E2', event_name: 'MIL @ BOS', stat: 'ast', side: 'over', line: 3.5 });
  };
  const consensus = feedFor({
    '/events/E1/': { pageCount: 1, items: [bet('3', '3-Point Field Goals Milestones', '+148', 4)] },
    '/events/E2/': PROPS,
    series_ticker: { events: [] },
  });
  const r = await rateEdgeSlip({ espn, resolve, edge: { get: async () => ({ board: { props: board, fetchedAt: Date.UTC(2026, 10, 4, 19, 40) }, stale: false, error: null }) }, consensus, tz: 'America/Chicago' },
    ['Jamal Murray over 3.5 3PTM', 'Kyle Kuzma over 3.5 assists']);
  assert.equal(r.legs[0]!.edge.score, 6);
  assert.equal(r.legs[0]!.espn.score, null);
  assert.equal(r.legs[0]!.consensus.score, 4);
  assert.equal(r.legs[1]!.edge.score, null);
  assert.equal(r.legs[1]!.consensus.score, 2);
  assert.match(r.description, /Jamal Murray o3\.5 3PM\*\* — Edge 6\/10 · ESPN n\/a · Consensus 4\/10 ⚠️/);
  assert.match(r.description, /Kyle Kuzma o3\.5 AST\*\* — Edge n\/a · ESPN n\/a · Consensus 2\/10 ⚠️/);
  assert.match(r.description, /Edge data as of Nov 4, 1:40 PM CT/);
});

test('pipeline: Edge off still rates ESPN and consensus', async () => {
  const r = await rateEdgeSlip({ espn: fakeEspn({}), resolve: async () => { throw new Error('nope'); }, edge: null, consensus: null, tz: 'America/Chicago' }, ['who knows']);
  assert.equal(r.legs[0]!.edge.score, null);
  assert.match(r.description, /Edge is off/);
});

test('feed: Kalshi failing twice never leaves an unhandled rejection', async () => {
  const seen: unknown[] = [];
  const onUnhandled = (e: unknown) => { seen.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const feed = new ConsensusFeed({ fetcher: async (url) => { throw new Error(url.includes('kalshi') ? 'HTTP 429' : 'HTTP 404'); } });
    const q = { league: 'nba', eventId: 'E', eventName: 'TOR @ DEN', athleteId: '1', player: 'X Y', team: null, stat: '3pm', side: 'over' as const, line: 3.5 };
    const r = await Promise.all([feed.rate(q), feed.rate(q)]);
    assert.deepEqual(r.map((x) => x.score), [null, null]);
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(seen, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('strong legs: ✅ when avg ≥7 and no rating ≤4; ✅ after each rating ≥7; in-between gets nothing', () => {
  const sameLine = (pct: number): EdgeLegRating => ({ ...miss('x'), status: 'same_line', edgePct: pct, grade: 'A' });
  const cons = (score: number) => ({ score, p: score / 10, sources: [], note: `${score * 10}%` });
  const legs = buildTriple(
    ['Strong o1.5 PTS', 'Mixed o2.5 AST', 'Middle o3.5 REB', 'NoEdge o4.5 REB'],
    [sameLine(80), sameLine(90), sameLine(60), miss('d')],
    [{ label: 'a', score: 7, reason: 'r' }, { label: 'b', score: 9, reason: 'r' }, { label: 'c', score: 6, reason: 'r' }, { label: 'd', score: 8, reason: 'r' }],
    [cons(7), cons(4), cons(5), cons(7)],
  );
  assert.equal(STRONG_MIN, 7);
  assert.deepEqual(legs.map(legEmoji), ['✅', '', '', '✅']);
  assert.equal(isStrongLeg(legs[1]!), false, 'avg 7.3 but Consensus 4 is weak');
  assert.equal(isWeakLeg(legs[1]!), false);
  const text = formatTripleReport(legs);
  assert.match(text, /^1\. ✅ \*\*Strong o1\.5 PTS\*\* — Edge 8\/10 ✅ · ESPN 7\/10 ✅ · Consensus 7\/10 ✅$/m);
  assert.match(text, /^2\. \*\*Mixed o2\.5 AST\*\* — Edge 9\/10 ✅ · ESPN 9\/10 ✅ · Consensus 4\/10 ⚠️$/m);
  assert.match(text, /^3\. \*\*Middle o3\.5 REB\*\* — Edge 6\/10 · ESPN 6\/10 · Consensus 5\/10$/m);
  assert.match(text, /^4\. ✅ \*\*NoEdge o4\.5 REB\*\* — Edge n\/a · ESPN 8\/10 ✅ · Consensus 7\/10 ✅$/m);
  assert.match(text, /✅ Strong legs \(avg ≥7, none ≤4\): Strong o1\.5 PTS, NoEdge o4\.5 REB/);
  assert.match(text, /⚠️ Caution \(a rating ≤4\/10\): Mixed o2\.5 AST/);
  assert.match(text, /✅ = strong \(rating ≥7; leg avg ≥7, none ≤4\) · ⚠️ = weak \(rating ≤4; leg avg ≤4\)/);
});

test('no strong legs says so', () => {
  const legs = buildTriple(['A o1.5 PTS'], [miss('a')], [{ label: 'a', score: 5, reason: 'r' }], [{ score: 5, p: 0.5, sources: [], note: '' }]);
  assert.match(formatTripleReport(legs), /^Strong legs: none$/m);
});
