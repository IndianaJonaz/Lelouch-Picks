import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/bot.ts';
import { parseGameLog, parseMarketOdds } from '../src/espn.ts';
import { fakeEspn } from './helpers.ts';
import { extractedLegLine } from '../src/photoslips.ts';
import {
  formatLegLine, formatParlayLine, impliedProbability, rateSlip, ratingSummary, scoreMoneyline, scoreParlay, scoreProp, scoreSpread, scoreTotal,
  type ParlayRating,
} from '../src/rate.ts';
import { blankLeg, blankSlip } from '../src/slipvision.ts';
import type { LogGame } from '../src/espn.ts';

const g = (date: string, stats: Record<string, number | null>, pre = false, eventId = date): LogGame =>
  ({ eventId, date, opponent: null, preseason: pre, stats });

test('prop score: L10 hit rate, season cushion, and a push is not a hit', () => {
  const over = scoreProp({
    league: 'nba', stat: 'reb', side: 'over', line: 10.5, opponent: 'DAL', columns: ['reb'],
    games: [g('2026-10-29', { reb: 14 }), g('2026-10-27', { reb: 12 }), g('2026-10-25', { reb: 11 }), g('2026-10-23', { reb: 8 })],
  });
  assert.equal(over.hits, 3);
  assert.equal(over.n, 4);
  assert.ok(Math.abs((over.seasonAvg ?? 0) - 11.25) < 1e-9);
  assert.ok(Math.abs((over.margin ?? 0) - 0.75) < 1e-9);
  assert.ok((over.cushion ?? 0) > 0);
  assert.equal(over.score, 8);
  assert.equal(over.reason, 'hit 3/4, avg 11.3, margin +0.8 vs DAL');

  const under = scoreProp({
    league: 'nba', stat: 'reb', side: 'under', line: 10.5, columns: ['reb'],
    games: [g('2026-10-29', { reb: 5 }), g('2026-10-27', { reb: 8 }), g('2026-10-25', { reb: 12 }), g('2026-10-23', { reb: 9 })],
  });
  assert.equal(under.hits, 3);
  assert.equal(under.n, 4);
  assert.ok(Math.abs((under.seasonAvg ?? 0) - 8.5) < 1e-9);
  assert.equal(under.score, 8);

  const push = scoreProp({
    league: 'nba', stat: 'pts', side: 'over', line: 10, columns: ['pts'],
    games: [g('2026-10-29', { pts: 10 }), g('2026-10-27', { pts: 11 })],
  });
  assert.equal(push.hits, 1);
  assert.equal(push.score, 5);
});

test('combo stats sum components and ignore a pre-baked total', () => {
  const pra = scoreProp({
    league: 'nba', stat: 'pra', side: 'over', line: 30, columns: ['pts', 'reb', 'ast'],
    games: [
      g('2026-10-02', { pts: 20, reb: 10, ast: 5, pra: 99 }),
      g('2026-10-01', { pts: 10, reb: 5, ast: 5, pra: 99 }),
    ],
  });
  assert.equal(pra.hits, 1);
  assert.equal(pra.n, 2);
  assert.equal(pra.score, 5);

  const missing = scoreProp({
    league: 'nba', stat: 'pra', side: 'over', line: 30, columns: ['pts', 'reb'],
    games: [g('2026-10-01', { pts: 20, reb: 10 })],
  });
  assert.equal(missing.score, null);
  assert.equal(missing.reason, 'game log has no ast');
  const parlay = scoreParlay([{ label: 'missing', score: missing.score }, { label: 'other', score: 8 }]);
  assert.equal(parlay.overall, 8);
  assert.deepEqual(parlay.weakest, ['other']);
});

test('anytime TD / HR uses games with at least one; a higher line uses the line', () => {
  const td = scoreProp({
    league: 'nfl', stat: 'td', side: 'over', line: 0.5, columns: ['rush_td', 'rec_td'],
    games: [
      g('2026-10-03', { rush_td: 1, rec_td: 0 }),
      g('2026-10-02', { rush_td: 0, rec_td: 0 }),
      g('2026-10-01', { rush_td: 1, rec_td: 1 }),
    ],
  });
  assert.equal(td.hits, 2);
  assert.equal(td.n, 3);

  const noRec = scoreProp({
    league: 'nfl', stat: 'td', side: 'over', line: 0.5, columns: ['rush_td'],
    games: [g('2026-10-01', { rush_td: 1 })],
  });
  assert.equal(noRec.score, null);
  assert.equal(noRec.reason, 'game log has no rec td');

  const games = [g('2026-10-03', { hr: 1 }), g('2026-10-02', { hr: 0 }), g('2026-10-01', { hr: 2 })];
  assert.equal(scoreProp({ league: 'mlb', stat: 'hr', side: 'over', line: 0.5, columns: ['hr'], games }).hits, 2);
  assert.equal(scoreProp({ league: 'mlb', stat: 'hr', side: 'over', line: 1.5, columns: ['hr'], games }).hits, 1);
});

test('missing log, DNP blanks, and preseason-only samples', () => {
  const none = scoreProp({ league: 'nba', stat: 'reb', side: 'over', line: 10.5, columns: ['pts'], games: [g('2026-10-01', { pts: 20 })] });
  assert.equal(none.score, null);
  assert.equal(none.reason, 'game log has no reb');

  const dnp = scoreProp({
    league: 'nba', stat: 'pts', side: 'over', line: 20, columns: ['pts'],
    games: [g('2026-10-02', { pts: null }), g('2026-10-01', { pts: 30 })],
  });
  assert.equal(dnp.n, 1);
  assert.equal(dnp.hits, 1);

  const empty = scoreProp({ league: 'nba', stat: 'pts', side: 'over', line: 20, columns: ['pts'], games: [g('2026-10-01', { pts: null })] });
  assert.equal(empty.score, null);
  assert.equal(empty.reason, 'no played games in the log');

  const pre = scoreProp({
    league: 'nba', stat: 'pts', side: 'over', line: 10, columns: ['pts'],
    games: [g('2026-10-01', { pts: 18 }, true), g('2026-10-08', { pts: 22 })],
  });
  assert.equal(pre.n, 1);
  assert.equal(pre.hits, 1);
  assert.equal(pre.reason.includes('preseason'), false);

  const onlyPre = scoreProp({
    league: 'nba', stat: 'pts', side: 'over', line: 10, columns: ['pts'],
    games: [g('2026-10-01', { pts: 18 }, true)],
  });
  assert.match(onlyPre.reason, /preseason/);
});

test('parlay score multiplies leg scores and flags every weakest leg', () => {
  assert.deepEqual(scoreParlay([{ label: 'only', score: 7 }]), { overall: 7, weakest: ['only'] });
  assert.deepEqual(scoreParlay([{ label: 'a', score: 10 }, { label: 'b', score: 1 }]), { overall: 1, weakest: ['b'] });
  assert.deepEqual(scoreParlay([{ label: 'a', score: null }]), { overall: null, weakest: [] });
  const tied = scoreParlay([{ label: 'a', score: 4 }, { label: 'b', score: 4 }, { label: 'c', score: 9 }]);
  assert.equal(tied.overall, 1);
  assert.deepEqual(tied.weakest, ['a', 'b']);
  const view: ParlayRating = { legs: [{ label: 'A', score: 8, reason: 'x' }, { label: 'B', score: null, reason: 'nope' }], overall: 8, weakest: ['A'], summary: null };
  assert.equal(formatParlayLine(view), 'Parlay: 8/10 · weakest: A · 1 unscored');
  assert.equal(formatLegLine({ label: 'Jokic o10.5 reb', score: null, reason: 'game log has no reb' }), '— · Jokic o10.5 reb — game log has no reb');
});

test('spread, total and moneyline compare to the market number', () => {
  const better = scoreSpread(4.5, 3.5);
  const worse = scoreSpread(2.5, 3.5);
  assert.equal(better.score, 7);
  assert.equal(better.reason, 'market +3.5, you +4.5 (+1.0 pts)');
  assert.equal(worse.score, 3);
  assert.ok(better.score > worse.score);
  assert.deepEqual(scoreSpread(3.5, 3.5), { score: 5, reason: 'market +3.5, same number' });
  assert.deepEqual(scoreSpread(4.5, null), { score: 5, reason: 'no market line found' });
  assert.equal(scoreTotal('over', 46.5, 47.5).score, 7);
  assert.equal(scoreTotal('under', 48.5, 47.5).score, 7);
  assert.equal(scoreTotal('over', 47.5, null).reason, 'no market line found');

  assert.equal(impliedProbability(-175), 175 / 275);
  assert.equal(impliedProbability(100), 0.5);
  assert.equal(impliedProbability(50), null);
  const fav = scoreMoneyline(-175, null);
  assert.equal(fav.score, 6);
  assert.match(fav.reason, /64% implied/);
  assert.equal(scoreMoneyline(100, null).score, 5);
  assert.equal(scoreMoneyline(-110, null).score, 5);
  assert.equal(scoreMoneyline(-110, 150).score, 6);
  assert.equal(scoreMoneyline(null, -150).reason, 'no market line found');
});

test('game log parser: made-attempted, DNP dash, preseason, pitching outs, QB sacks ignored', () => {
  const nba = parseGameLog('nba', {
    names: ['points', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'],
    events: { A: { gameDate: '2026-10-01T00:00:00Z' }, B: { gameDate: '2026-10-03T00:00:00Z', opponent: { abbreviation: 'DAL' } } },
    seasonTypes: [
      { displayName: '2026-27 Preseason', categories: [{ displayName: 'Preseason', events: [{ eventId: 'A', stats: ['-', '2-6'] }] }] },
      { displayName: '2026-27 Regular Season', categories: [{ displayName: 'october', events: [{ eventId: 'B', stats: ['22', '0-0'] }] }] },
    ],
  });
  assert.deepEqual(nba.columns.sort(), ['3pm', 'pts']);
  const a = nba.games.find((x) => x.eventId === 'A')!;
  const b = nba.games.find((x) => x.eventId === 'B')!;
  assert.equal(a.preseason, true);
  assert.equal(a.stats.pts, null);
  assert.equal(a.stats['3pm'], 2);
  assert.equal(b.preseason, false);
  assert.equal(b.stats.pts, 22);
  assert.equal(b.stats['3pm'], 0);
  assert.equal(b.opponent, 'DAL');

  const qb = parseGameLog('nfl', {
    names: ['passingYards', 'sacks'],
    categories: [{ name: 'passing' }],
    events: { Q: { gameDate: '2026-10-01' } },
    seasonTypes: [{ displayName: '2026 Regular Season', categories: [{ events: [{ eventId: 'Q', stats: ['255', '2'] }] }] }],
  });
  assert.deepEqual(qb.columns, ['pass_yds']);
  assert.equal(qb.games[0].stats.sacks, undefined);

  const arm = parseGameLog('mlb', {
    names: ['innings', 'strikeouts', 'hits', 'earnedRuns'],
    events: { P: { gameDate: '2025-06-01' } },
    seasonTypes: [{ displayName: '2025 Regular Season', categories: [{ events: [{ eventId: 'P', stats: ['6.0', '7', '4', '0'] }] }] }],
  });
  assert.equal(arm.games[0].stats.outs, 18);
  assert.equal(arm.games[0].stats.pk, 7);
  assert.equal(arm.games[0].stats.h_allowed, 4);
  assert.equal(arm.games[0].stats.hits, undefined);
});

test('market odds: close spread, total and moneylines; details fallback', () => {
  const q = parseMarketOdds({
    provider: { name: 'DraftKings' }, details: 'GB -3.5', overUnder: 47.5, spread: -3.5,
    pointSpread: { home: { close: { line: '-3.5' } }, away: { close: { line: '+3.5' } } },
    moneyline: { home: { close: { odds: '-180' } }, away: { close: { odds: '+154' } } },
  }, 'GB', 'CAR');
  assert.equal(q!.provider, 'DraftKings');
  assert.equal(q!.spreadByAbbr.GB, -3.5);
  assert.equal(q!.spreadByAbbr.CAR, 3.5);
  assert.equal(q!.total, 47.5);
  assert.equal(q!.mlByAbbr.GB, -180);
  assert.equal(q!.mlByAbbr.CAR, 154);

  const fallback = parseMarketOdds({ details: 'BUF -3', spread: -3, overUnder: 54.5 }, 'BUF', 'BAL');
  assert.equal(fallback!.spreadByAbbr.BUF, -3);
  assert.equal(fallback!.spreadByAbbr.BAL, 3);
  assert.equal(parseMarketOdds({}, 'A', 'B'), null);
});

test('rateSlip wires a fixture game log and a fixture market line', async () => {
  const espn = fakeEspn({
    'athletes/3112335/gamelog': {
      names: ['minutes', 'points', 'totalRebounds', 'assists'],
      events: {
        A: { gameDate: '2026-10-29T00:00:00Z' }, B: { gameDate: '2026-10-27T00:00:00Z' },
        C: { gameDate: '2026-10-25T00:00:00Z' }, D: { gameDate: '2026-10-23T00:00:00Z' },
      },
      seasonTypes: [{ displayName: '2026-27 Regular Season', categories: [{ displayName: 'october', events: [
        { eventId: 'A', stats: ['34', '22', '14', '10'] },
        { eventId: 'B', stats: ['34', '20', '12', '8'] },
        { eventId: 'C', stats: ['34', '18', '11', '7'] },
        { eventId: 'D', stats: ['30', '15', '8', '6'] },
      ] }] }],
    },
    'summary?event=E1': {
      header: { id: 'E1', competitions: [{ date: '2026-11-01T18:00:00Z', status: { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED', shortDetail: 'Sun' }, period: 0, clock: 0, displayClock: '' },
        competitors: [
          { homeAway: 'home', team: { id: '9', abbreviation: 'GB', displayName: 'Green Bay Packers' } },
          { homeAway: 'away', team: { id: '29', abbreviation: 'CAR', displayName: 'Carolina Panthers' } },
        ] }] },
      pickcenter: [{ provider: { name: 'DraftKings' }, details: 'GB -3.5', overUnder: 47.5, spread: -3.5,
        pointSpread: { home: { close: { line: '-3.5' } }, away: { close: { line: '+3.5' } } },
        moneyline: { home: { close: { odds: '-180' } }, away: { close: { odds: '+154' } } } }],
    },
  });
  const rating = await rateSlip(espn, [
    { league: 'nba', event_id: 'UP1', event_name: 'DAL @ DEN', type: 'prop', team: 'DEN', player: 'Jokic', athlete_id: '3112335', stat: 'reb', side: 'over', line: 10.5, odds: null, raw: 'Jokic o10.5 reb' },
    { league: 'nfl', event_id: 'E1', event_name: 'CAR @ GB', type: 'spread', team: 'CAR', player: null, athlete_id: null, stat: null, side: null, line: 4.5, odds: -110, raw: 'CAR +4.5' },
  ]);
  assert.equal(formatLegLine(rating.legs[0]), '8/10 · Jokic o10.5 reb — hit 3/4, avg 11.3, margin +0.8 vs DAL');
  assert.equal(formatLegLine(rating.legs[1]), '7/10 · CAR +4.5 — market +3.5, you +4.5 (+1.0 pts)');
  assert.equal(rating.overall, 6);
  assert.deepEqual(rating.weakest, ['CAR +4.5']);
  assert.equal(rating.summary, null);
});

test('screenshot legs become /pick text; Kalshi is not rated as an ESPN leg', () => {
  const x = blankSlip();
  const prop = { ...blankLeg(), player: 'Nikola Jokic', team: 'DEN', league: 'NBA', line: 10.5, direction: 'over' as const, stat: 'Rebounds' };
  assert.equal(extractedLegLine(x, prop), 'NBA Nikola Jokic (DEN) o10.5 Rebounds');
  const spread = { ...blankLeg(), player: 'Packers', team: 'GB', league: 'NFL', line: -3.5 };
  assert.equal(extractedLegLine(x, spread), 'NFL GB -3.5');
  const kalshi = blankSlip();
  kalshi.platform = 'Kalshi';
  assert.equal(extractedLegLine(kalshi, prop), null);
});

test('/rate is registered with descriptions inside Discord limits', () => {
  const rate = commands.find((c) => c.name === 'rate') as { description: string; options?: { name: string; description: string; required?: boolean }[] };
  assert.ok(rate);
  assert.ok(rate.description.length <= 100, rate.description);
  assert.equal(rate.options?.[0].name, 'legs');
  assert.equal(rate.options?.[0].required, true);
  assert.ok((rate.options?.[0].description.length ?? 0) <= 100);
});

test('AI summary uses only the computed JSON and is omitted when the key is missing or the call fails', async () => {
  const rating: ParlayRating = {
    legs: [{ label: 'Jokic o10.5 reb', score: 8, reason: 'hit 3/4, avg 11.3, margin +0.8 vs DAL' }],
    overall: 8, weakest: ['Jokic o10.5 reb'], summary: null,
  };
  assert.equal(await ratingSummary(rating, null), null);
  assert.equal(await ratingSummary(rating, { apiKey: '', fetch: async () => { throw new Error('should not be called'); } }), null);
  let body = '';
  const text = await ratingSummary(rating, {
    apiKey: 'secret-key',
    fetch: async (_url, init) => {
      body = String(init?.body ?? '');
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer secret-key');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'The rebound leg scores 8 out of 10. That is the whole note.' } }] }), { status: 200 });
    },
  });
  assert.equal(text, 'The rebound leg scores 8 out of 10. That is the whole note.');
  assert.equal(body.includes('secret-key'), false);
  assert.equal(await ratingSummary(rating, { apiKey: 'secret-key', fetch: async () => { throw new Error('down secret-key'); } }), null);
});
