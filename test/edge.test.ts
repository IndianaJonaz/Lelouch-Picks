import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands, botIntents } from '../src/bot.ts';
import { GatewayIntentBits } from 'discord.js';
import { parseLeg } from '../src/parse.ts';
import { blankSlip } from '../src/slipvision.ts';
import {
  edgeConfigured, edgeLinesFromExtraction, edgeStatCode, formatEdgeAsOf, formatEdgeReport, namesMatch, parseBoardHtml, queryFromLeg, rateEdgeLegs,
  type EdgeProp, type EdgeQuery,
} from '../src/edgerate.ts';
import { EdgeCache, edgeLogin, fetchEdgeBoard, safeEdgeError } from '../src/edgeengine.ts';

const STRUS_HTML = `
<div class="bp bp-nba">
  <div class="brow"><div class="btop"><span class="bn">Max Strus</span><span class="bteam">LAC</span>
    <span class="bgrade"><span class="bgl">A</span><span class="bpill o">OVER 91.7%</span></span></div>
    <div class="bmkt">Assists &middot; MIA @ LAC</div>
    <div class="bstats"><span class="k">Line</span> <b>2.5</b> <span class="k">Sim</span> <span class="sim">5.6</span>
      <span class="k">Diff</span> <span class="sim">+3.1</span> <span class="dim mn">Min 23.4</span>
      <span class="dim gm">10g</span> <span class="dim">-137</span> <span class="k">EV</span> <span class="ev">+58.6%</span></div>
    <div class="bsub">Over 91.7% &middot; Under 8.3%</div></div>
  <div class="brow"><div class="btop"><span class="bn">Tyrese Maxey</span><span class="bteam">PHI</span>
    <span class="bgrade"><span class="bgl">A</span><span class="bpill o">OVER 96%</span></span></div>
    <div class="bmkt">Pts + Reb &middot; PHI @ IND</div>
    <div class="bstats"><span class="k">Line</span> <b>26.5</b> <span class="k">Sim</span> <span class="sim">36.7</span>
      <span class="k">Diff</span> <span class="sim">+10.2</span> <span class="dim mn">Min 36.5</span>
      <span class="dim gm">10g</span> <span class="dim">-137</span> <span class="k">EV</span> <span class="ev">+66.2%</span></div>
    <div class="bsub">Over 96% &middot; Under 4%</div></div>
  <div class="brow"><div class="btop"><span class="bn">Tyrese Maxey</span><span class="bteam">PHI</span>
    <span class="bgrade"><span class="bgl">B</span><span class="bpill o">OVER 71%</span></span></div>
    <div class="bmkt">Pts + Reb &middot; PHI @ IND</div>
    <div class="bstats"><span class="k">Line</span> <b>30.5</b> <span class="k">Sim</span> <span class="sim">36.7</span>
      <span class="dim gm">10g</span> <span class="dim">+120</span> <span class="k">EV</span> <span class="ev">+12%</span></div>
    <div class="bsub">Over 71% &middot; Under 29%</div></div>
</div>
<div class="bp bp-nba">
  <div class="brow"><div class="btop"><span class="bn">Nikola Jokić</span><span class="bteam">DEN</span>
    <span class="bgrade"><span class="bgl">C</span><span class="bpill u">UNDER 62%</span></span></div>
    <div class="bmkt">Rebounds &middot; DEN vs LAL</div>
    <div class="bstats"><span class="k">Line</span> <b>12.5</b> <span class="k">Sim</span> <span class="simd">11.1</span>
      <span class="dim mn">Min 34</span> <span class="dim gm">10 games</span> <span class="dim">&minus;115</span>
      <span class="k">EV</span> <span class="ev">+8.0%</span></div>
    <div class="bsub">Over 38% &middot; Under 62%</div></div>
  <div class="brow"><div class="btop"><span class="bn">Kelly Oubre Jr.</span><span class="bteam">PHI</span>
    <span class="bgrade"><span class="bgl">A</span><span class="bpill o">OVER 55%</span></span></div>
    <div class="bmkt">Points &middot; PHI @ IND</div>
    <div class="bstats"><span class="k">Line</span> <b>15.5</b> <span class="k">Sim</span> <span class="sim">18</span>
      <span class="dim gm">8g</span> <span class="dim">+100</span></div>
    <div class="bsub">Over 55% &middot; Under 45%</div></div>
  <div class="brow"><div class="btop"><span class="bn">Jalen Smith</span><span class="bteam">CHI</span>
    <span class="bgrade"><span class="bgl">B</span><span class="bpill o">OVER 60%</span></span></div>
    <div class="bmkt">Points &middot; CHI @ MIL</div>
    <div class="bstats"><span class="k">Line</span> <b>10.5</b> <span class="k">Sim</span> <span class="sim">14</span>
      <span class="dim gm">9g</span> <span class="dim">-110</span></div>
    <div class="bsub">Over 60% &middot; Under 40%</div></div>
  <div class="brow"><div class="btop"><span class="bn">Jabari Smith</span><span class="bteam">HOU</span>
    <span class="bgrade"><span class="bgl">A</span><span class="bpill o">OVER 70%</span></span></div>
    <div class="bmkt">Points &middot; HOU @ DAL</div>
    <div class="bstats"><span class="k">Line</span> <b>10.5</b> <span class="k">Sim</span> <span class="sim">16</span>
      <span class="dim gm">9g</span> <span class="dim">-120</span></div>
    <div class="bsub">Over 70% &middot; Under 30%</div></div>
</div>`;

function q(partial: Partial<EdgeQuery> & Pick<EdgeQuery, 'raw'>): EdgeQuery {
  return {
    kind: 'prop', player: null, team: null, league: 'nba', statText: null, side: 'over', line: null,
    ...partial, names: partial.names ?? (partial.player ? [partial.player] : []),
  };
}

test('parseBoardHtml reads a rendered Edge card into a prop', () => {
  const props = parseBoardHtml(STRUS_HTML);
  const strus = props.find((p) => p.player === 'Max Strus');
  assert.ok(strus);
  assert.equal(strus.team, 'LAC');
  assert.equal(strus.league, 'nba');
  assert.equal(strus.stat, 'ast');
  assert.equal(strus.statLabel, 'Assists');
  assert.equal(strus.matchup, 'MIA @ LAC');
  assert.equal(strus.line, 2.5);
  assert.equal(strus.sim, 5.6);
  assert.equal(strus.minutes, 23.4);
  assert.equal(strus.games, 10);
  assert.equal(strus.odds, -137);
  assert.equal(strus.evPct, 58.6);
  assert.equal(strus.overPct, 91.7);
  assert.equal(strus.underPct, 8.3);
  assert.equal(strus.grade, 'A');
  assert.equal(strus.featuredSide, 'over');
  const jokic = props.find((p) => p.player.includes('Joki'));
  assert.equal(jokic?.odds, -115);
  assert.equal(jokic?.featuredSide, 'under');
  assert.equal(jokic?.stat, 'reb');
  assert.equal(props.filter((p) => p.player === 'Tyrese Maxey').length, 2);
});

test('a fixed marketing snapshot is not a live board', () => {
  const html = STRUS_HTML + '<p>A fixed snapshot of the board. Not live picks.</p>';
  assert.equal(parseBoardHtml(html).length, 0);
});

test('edge stat labels map onto internal codes', () => {
  assert.equal(edgeStatCode('nba', 'Pts + Reb'), 'pr');
  assert.equal(edgeStatCode('nba', 'Pts + Ast'), 'pa');
  assert.equal(edgeStatCode('nba', 'Pts + Reb + Ast'), 'pra');
  assert.equal(edgeStatCode('nba', 'Assists'), 'ast');
  assert.equal(edgeStatCode('nhl', 'Assists'), 'assists');
  assert.equal(edgeStatCode('nfl', 'Rush + Rec Yards'), 'rush_rec_yds');
  assert.equal(edgeStatCode('nfl', 'Passing Yards'), 'pass_yds');
  assert.equal(edgeStatCode('nba', 'Rebounds'), 'reb');
  assert.equal(edgeStatCode('mlb', 'Total Bases'), null);
});

test('a team hint in the leg text is split off for the tiebreak', () => {
  const parsed = queryFromLeg(parseLeg('Smith (HOU) o10.5 pts'));
  assert.equal(parsed.kind, 'prop');
  assert.equal(parsed.player, 'Smith');
  assert.equal(parsed.team, 'HOU');
  assert.equal(parsed.statText, 'pts');
  assert.equal(parsed.side, 'over');
  assert.equal(parsed.line, 10.5);
  assert.deepEqual(parsed.names, ['Smith']);
});

test('names match across case, accents, periods and suffixes', () => {
  assert.equal(namesMatch('maxey', 'Tyrese Maxey'), true);
  assert.equal(namesMatch('Nikola Jokic', 'Nikola Jokić'), true);
  assert.equal(namesMatch('P.J. Washington', 'PJ Washington'), true);
  assert.equal(namesMatch('Kelly Oubre', 'Kelly Oubre Jr.'), true);
  assert.equal(namesMatch('Tim Hardaway', 'Tim Hardaway III'), true);
  assert.equal(namesMatch('Jokic', 'Nikola Jokic'), true);
  assert.equal(namesMatch('Max Strus', 'Maxey Strus'), false);
});

test('same line shows Edge percent, projection, grade, EV and odds', () => {
  const board = parseBoardHtml(STRUS_HTML);
  const rated = rateEdgeLegs([q({ raw: 'Maxey o26.5 pts+reb', player: 'Maxey', statText: 'pts+reb', side: 'over', line: 26.5 })], board);
  const leg = rated.legs[0]!;
  assert.equal(leg.status, 'same_line');
  assert.equal(leg.edgePct, 96);
  assert.equal(leg.countsInParlay, true);
  assert.match(leg.text, /OVER 96%/);
  assert.match(leg.text, /sim 36\.7/);
  assert.match(leg.text, /grade A/);
  assert.match(leg.text, /EV \+66\.2%/);
  assert.match(leg.text, /odds -137/);
});

test('the other side of the same line uses that side’s percent and does not borrow EV', () => {
  const board = parseBoardHtml(STRUS_HTML);
  const rated = rateEdgeLegs([q({ raw: 'Maxey u26.5 pts+reb', player: 'Maxey', statText: 'pts+reb', side: 'under', line: 26.5 })], board);
  const leg = rated.legs[0]!;
  assert.equal(leg.status, 'same_line');
  assert.equal(leg.edgePct, 4);
  assert.match(leg.text, /UNDER 4%/);
  assert.match(leg.text, /not your side/);
  assert.doesNotMatch(leg.text, /EV \+66\.2%/);
});

test('a different line shows Edge’s line, the gap and the cushion, and does not apply Edge’s percent', () => {
  const board = parseBoardHtml(STRUS_HTML);
  const rated = rateEdgeLegs([q({ raw: 'Maxey o27.5 pts+reb', player: 'Maxey', statText: 'pts+reb', side: 'over', line: 27.5 })], board);
  const leg = rated.legs[0]!;
  assert.equal(leg.status, 'different_line');
  assert.equal(leg.countsInParlay, false);
  assert.equal(leg.edgeLine, 26.5);
  assert.equal(leg.gap, 1);
  assert.equal(leg.cushion, 9.2);
  assert.match(leg.text, /Edge's line is 26\.5/);
  assert.match(leg.text, /1 higher/);
  assert.match(leg.text, /cushion \+9\.2/);
  assert.match(leg.text, /not your line/);
  assert.equal(leg.edgePct, null);
});

test('demon line that Edge also posts is an exact match, not a gap', () => {
  const board = parseBoardHtml(STRUS_HTML);
  const rated = rateEdgeLegs([q({ raw: 'Maxey o30.5 pts+reb', player: 'Maxey', statText: 'pts+reb', side: 'over', line: 30.5 })], board);
  assert.equal(rated.legs[0]!.status, 'same_line');
  assert.equal(rated.legs[0]!.edgePct, 71);
  assert.equal(rated.legs[0]!.grade, 'B');
});

test('team hint breaks a shared last name; no hint stays unmatched', () => {
  const board = parseBoardHtml(STRUS_HTML);
  const hou = rateEdgeLegs([q({ raw: 'Smith (HOU) o10.5 pts', player: 'Smith', names: ['Smith'], team: 'HOU', statText: 'pts', side: 'over', line: 10.5 })], board);
  assert.equal(hou.legs[0]!.status, 'same_line');
  assert.match(hou.legs[0]!.text, /Jabari Smith/);
  assert.equal(hou.legs[0]!.edgePct, 70);
  const ambiguous = rateEdgeLegs([q({ raw: 'Smith o10.5 pts', player: 'Smith', statText: 'pts', side: 'over', line: 10.5 })], board);
  assert.equal(ambiguous.legs[0]!.status, 'ambiguous');
  assert.match(ambiguous.legs[0]!.text, /Jalen Smith/);
  assert.match(ambiguous.legs[0]!.text, /Jabari Smith/);
  assert.doesNotMatch(ambiguous.legs[0]!.text, /Not on Edge's board/);
});

test('suffixes and accents still find the player', () => {
  const board = parseBoardHtml(STRUS_HTML);
  const oubre = rateEdgeLegs([q({ raw: 'Kelly Oubre o15.5 pts', player: 'Kelly Oubre', statText: 'pts', side: 'over', line: 15.5 })], board);
  assert.equal(oubre.legs[0]!.status, 'same_line');
  const jokic = rateEdgeLegs([q({ raw: 'Jokic u12.5 reb', player: 'Jokic', statText: 'reb', side: 'under', line: 12.5 })], board);
  assert.equal(jokic.legs[0]!.status, 'same_line');
  assert.equal(jokic.legs[0]!.edgePct, 62);
});

test('no Edge row says so and keeps the ESPN leg score', () => {
  const board = parseBoardHtml(STRUS_HTML);
  const rated = rateEdgeLegs(
    [q({ raw: 'Someone Fake o10.5 pts', player: 'Someone Fake', statText: 'pts', side: 'over', line: 10.5 })],
    board,
    { espnLegs: [{ label: 'Someone Fake o10.5 pts', score: 7, reason: 'hit 8/10, avg 12.4, margin +1.9' }] },
  );
  assert.equal(rated.legs[0]!.status, 'miss');
  assert.match(rated.legs[0]!.text, /Not on Edge's board/);
  assert.match(rated.legs[0]!.text, /ESPN 7\/10/);
  assert.match(rated.legs[0]!.text, /hit 8\/10/);
});

test('combined chance is the product of same-line percents, with grade, count and weakest', () => {
  const board = parseBoardHtml(STRUS_HTML);
  const rated = rateEdgeLegs([
    q({ raw: 'Maxey o26.5 pts+reb', player: 'Maxey', statText: 'pts+reb', side: 'over', line: 26.5 }),
    q({ raw: 'Maxey o27.5 pts+reb', player: 'Maxey', statText: 'pts+reb', side: 'over', line: 27.5 }),
    q({ raw: 'Jokic u12.5 reb', player: 'Jokic', statText: 'reb', side: 'under', line: 12.5 }),
    q({ raw: 'Nobody o1.5 pts', player: 'Nobody', statText: 'pts', side: 'over', line: 1.5 }),
  ], board, {
    espn: { overall: 6, weakest: ['Tatum u27.5 pts'] },
    asOf: 'Edge data as of Nov 4, 5:42 PM CT',
  });
  assert.equal(rated.sameLine, 2);
  assert.equal(rated.matched, 3);
  assert.equal(rated.total, 4);
  assert.equal(rated.combinedPct, 59.5); // 0.96 * 0.62 = 0.5952
  assert.equal(rated.avgGrade?.letter, 'B'); // A, A, C → 7/3
  assert.ok(Math.abs((rated.avgGrade?.mean ?? 0) - 7 / 3) < 0.01);
  assert.equal(rated.weakest, 'Jokic u12.5 reb');
  const text = formatEdgeReport(rated);
  assert.match(text, /59\.5%/);
  assert.match(text, /assuming independence/);
  assert.match(text, /2\/4 legs on Edge's line/);
  assert.match(text, /weakest: Jokic u12\.5 reb/);
  assert.match(text, /ESPN second opinion: 6\/10/);
  assert.match(text, /weakest: Tatum u27\.5 pts/);
  assert.match(text, /Edge data as of Nov 4, 5:42 PM CT/);
  assert.match(text, /not your line/);
});

test('a spread is not on the prop board', () => {
  const rated = rateEdgeLegs([q({ raw: 'GB -3.5', kind: 'other', player: null, names: [], side: null, line: -3.5, league: 'nfl' })], []);
  assert.match(rated.legs[0]!.text, /Not on Edge's board/);
});

test('Edge data timestamp is Central Time', () => {
  const text = formatEdgeAsOf(Date.UTC(2026, 10, 4, 23, 42), 'America/Chicago').replace(/\u202f/g, ' ');
  assert.equal(text, 'Edge data as of Nov 4, 5:42 PM CT');
});

test('feature is off unless both EDGE_EMAIL and EDGE_PASSWORD are set', () => {
  assert.equal(edgeConfigured({ edgeEmail: '', edgePassword: 'x' }), false);
  assert.equal(edgeConfigured({ edgeEmail: 'a@b.c', edgePassword: '' }), false);
  assert.equal(edgeConfigured({ edgeEmail: 'a@b.c', edgePassword: 'x' }), true);
});

test('/edge uses the /pick leg syntax and says nothing is saved', () => {
  const edge = commands.find((c) => c.name === 'edge') as { description: string; options?: { name: string; required?: boolean }[] };
  assert.ok(edge);
  assert.match(edge.description, /nothing is saved/i);
  const legs = edge.options?.find((o) => o.name === 'legs');
  assert.equal(legs?.required, true);
});

test('bot intents add message and reaction intents only when Edge watching is on', () => {
  assert.deepEqual(botIntents(false), [GatewayIntentBits.Guilds]);
  assert.ok(botIntents(false, true).includes(GatewayIntentBits.GuildMessageReactions));
  assert.ok(botIntents(false, true).includes(GatewayIntentBits.MessageContent));
});

test('screenshot legs become /pick lines and skip a non-prop', () => {
  const x = blankSlip();
  x.platform = 'PrizePicks';
  x.legs = [
    { player: 'Tyrese Maxey', team: 'PHI', league: 'NBA', matchup: null, line: 26.5, direction: 'over', stat: 'Pts+Reb', actual: null, leg_result: null, confidence: 'high' },
    { player: null, team: 'GB', league: 'NFL', matchup: null, line: -3.5, direction: null, stat: null, actual: null, leg_result: null, confidence: 'high' },
  ];
  assert.deepEqual(edgeLinesFromExtraction(x), ['NBA Tyrese Maxey (PHI) o26.5 Pts+Reb', 'NFL GB -3.5']);
});

test('login posts to /auth/login and the error never contains the password', async () => {
  let seen = '';
  const session = await edgeLogin('owner@example.com', 's3cret-value', async (url, init) => {
    assert.equal(String(url), 'https://edge-engine.up.railway.app/auth/login');
    seen = String(init?.body);
    return new Response(JSON.stringify({ ok: true, token: 'tok-123', email: 'owner@example.com' }), { status: 200 });
  });
  assert.equal(session.token, 'tok-123');
  assert.deepEqual(JSON.parse(seen), { email: 'owner@example.com', password: 's3cret-value' });

  await assert.rejects(
    () => edgeLogin('owner@example.com', 's3cret-value', async () => new Response(JSON.stringify({ error: 'Wrong email or password' }), { status: 200 })),
    (err: Error) => {
      assert.match(err.message, /Wrong email or password/);
      assert.equal(err.message.includes('s3cret-value'), false);
      return true;
    },
  );
});

test('safeEdgeError redacts a session token', () => {
  const msg = safeEdgeError(new Error('cookie ee_sess=abc.def failed Bearer super-secret'));
  assert.equal(msg.includes('abc.def'), false);
  assert.equal(msg.includes('super-secret'), false);
});

test('fetchEdgeBoard uses rendered cards and does not open a browser', async () => {
  let scraped = false;
  const props = await fetchEdgeBoard(
    { token: 'tok-123', email: 'owner@example.com' },
    {
      origin: 'https://edge-engine.up.railway.app',
      fetch: async (url, init) => {
        assert.equal(String(url), 'https://edge-engine.up.railway.app/app');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('x-ee-token'), 'tok-123');
        assert.match(headers.get('cookie') ?? '', /ee_sess=/);
        return new Response(STRUS_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      },
      scrape: async () => { scraped = true; return []; },
    },
  );
  assert.equal(scraped, false);
  assert.equal(props.some((p) => p.player === 'Max Strus'), true);
});

test('fetchEdgeBoard ignores a login redirect and asks the browser scraper', async () => {
  const props = await fetchEdgeBoard(
    { token: 'tok-123', email: 'a@b.c' },
    {
      fetch: async () => new Response('', { status: 302, headers: { location: '/' } }),
      scrape: async () => [parseBoardHtml(STRUS_HTML)[0]!],
    },
  );
  assert.equal(props[0]?.player, 'Max Strus');
});

function oneProp(line: number): EdgeProp {
  return parseBoardHtml(STRUS_HTML).find((p) => p.player === 'Max Strus' && p.line === line)!;
}

test('cache refreshes on a stale read, keeps the last board, and will not refresh twice in a minute', async () => {
  let now = 1_000;
  let loads = 0;
  let fail = false;
  const cache = new EdgeCache({
    email: 'owner@example.com',
    password: 's3cret-value',
    ttlMs: 12 * 60_000,
    minIntervalMs: 60_000,
    now: () => now,
    login: async (email, password) => {
      assert.equal(password, 's3cret-value');
      assert.equal(email, 'owner@example.com');
      if (fail) throw new Error('login refused');
      return { token: 'tok', email };
    },
    load: async () => {
      loads++;
      if (fail) throw new Error('edge down');
      return [oneProp(2.5)];
    },
  });

  const first = await cache.get();
  assert.equal(loads, 1);
  assert.equal(first.board?.props.length, 1);
  assert.equal(first.stale, false);

  now += 30_000;
  await cache.get();
  assert.equal(loads, 1);

  now += 12 * 60_000;
  fail = true;
  const stale = await cache.get();
  assert.equal(loads, 1);
  assert.equal(stale.board?.props[0]?.player, 'Max Strus');
  assert.equal(stale.stale, true);
  assert.match(stale.error ?? '', /login refused/);

  now += 30_000;
  await cache.get();
  assert.equal(loads, 1);

  now += 60_000;
  fail = false;
  const again = await cache.get();
  assert.equal(loads, 2);
  assert.equal(again.stale, false);
  assert.equal(again.error, null);
});
