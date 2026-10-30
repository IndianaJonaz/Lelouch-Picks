// End-to-end-ish: resolve real fixture games -> create slips -> engine grades -> views never leak hidden legs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resolver } from '../src/resolve.ts';
import { createSlip, revealSlip, SlipError } from '../src/store.ts';
import { boardView, liveView, newsView } from '../src/views.ts';
import { getSlip } from '../src/db.ts';
import { ParseError } from '../src/parse.ts';
import { fx, makeCtx } from './helpers.ts';

const routes = {
  'nba/scoreboard?dates=20261028': fx('nba_scoreboard_final'),
  'nba/summary?event=401909881': fx('nba_summary_final'),
  'nba/teams/14/roster': fx('nba_roster_mia'),
  'nba/teams/1/roster': fx('nba_roster_atl'),
  'nba/injuries': { injuries: [{ displayName: 'Miami Heat', injuries: [{ status: 'Questionable', date: '2026-10-28T12:00Z', shortComment: 'Ankle soreness', athlete: { displayName: 'Bam Adebayo', links: [{ href: 'https://www.espn.com/nba/player/_/id/4066261/bam-adebayo' }], team: { abbreviation: 'MIA' } } }] }] },
};
const opts = { tz: 'America/Chicago', leagues: ['nba'], days: ['2026-10-28'], allowFinal: true };

test('resolver: players by last name / first name / full name, teams by abbr or name', async () => {
  const { espn } = makeCtx(routes);
  const r = new Resolver(espn);
  const a = await r.resolve('Giannis pra o40.5 (-115)', opts);
  assert.deepEqual([a.player, a.athlete_id, a.team, a.stat, a.event_id, a.odds], ['Giannis Antetokounmpo', '3032977', 'MIA', 'pra', '401909881', -115]);
  assert.equal((await r.resolve('Adebayo o20.5 pts', opts)).player, 'Bam Adebayo');
  assert.equal((await r.resolve('Miami Heat -3.5', opts)).team, 'MIA');
  assert.equal((await r.resolve('ATL ML', opts)).team, 'ATL');
  assert.equal((await r.resolve('MIA/ATL o240.5', opts)).type, 'total');
  await assert.rejects(r.resolve('Wemby o20.5 pts', opts), ParseError);
  await assert.rejects(r.resolve('Giannis o20.5 pass yds', { ...opts, leagues: ['nba'] }), ParseError);
  // final games are rejected for real entries
  await assert.rejects(r.resolve('ATL ML', { ...opts, allowFinal: false }), ParseError);
});

test('slip validation: odds required, stake bounds, American odds sanity', async () => {
  const { db, espn } = makeCtx(routes);
  const r = new Resolver(espn);
  const l1 = await r.resolve('Giannis o20.5 pts', opts);
  const l2 = await r.resolve('MIA -3.5', opts);
  const u = { user_id: 'u1', user_name: 'Lelouch' };
  assert.throws(() => createSlip(db, { ...u, stake: 1 }, [l1, l2]), SlipError);
  assert.throws(() => createSlip(db, { ...u, stake: 0, odds: 200 }, [l1]), (err: unknown) => err instanceof SlipError && (err as Error).message === 'Stake must be between 0 and 1000 dollars.');
  assert.throws(() => createSlip(db, { ...u, stake: 1, odds: 50 }, [l1]), SlipError);
  const s = createSlip(db, { ...u, stake: 1, odds: -110 }, [l1]);
  assert.equal(s.odds, -110);
});

test('engine grades & settles from the box score; hidden slip legs never leak, then reveal on settle', async () => {
  const { db, espn, engine, ctx } = makeCtx(routes);
  const r = new Resolver(espn);
  const u = { user_id: 'u1', user_name: 'Lelouch' };
  const pub = createSlip(db, { ...u, stake: 1 }, [await r.resolve('Giannis o20.5 pts (-110)', opts), await r.resolve('MIA -3.5 (-110)', opts)]);
  const lose = createSlip(db, { user_id: 'u2', user_name: 'Ace', stake: 2, odds: 300 }, [await r.resolve('Giannis o30.5 pts', opts), await r.resolve('ATL ML', opts)]);

  // Hidden slip on a *pending* game: build it from the final game but pretend it is upcoming.
  const hiddenLeg = { ...(await r.resolve('Adebayo o31.5 pts (-120)', opts)), event_id: 'FUTURE1', event_name: 'SECRET @ GAME' };
  const hid = createSlip(db, { user_id: 'u3', user_name: 'Kesh', stake: 1, hidden: true }, [hiddenLeg]);

  const settled: string[] = [];
  engine.on('settled', (e) => settled.push(e.slip.id));
  await engine.tick();

  assert.equal(getSlip(db, pub.id)!.status, 'won');
  assert.equal(getSlip(db, pub.id)!.profit, 2.64);
  assert.equal(getSlip(db, lose.id)!.status, 'lost');
  assert.equal(getSlip(db, lose.id)!.profit, -2);
  assert.deepEqual(settled.sort(), [pub.id, lose.id].sort());
  assert.equal(getSlip(db, hid.id)!.status, 'open');

  const json = JSON.stringify([boardView(ctx, 'all'), await liveView(ctx, false), await newsView(ctx)]);
  for (const secret of ['Adebayo', 'SECRET', 'FUTURE1', '31.5', '-120']) assert.ok(!json.includes(secret), `leaked ${secret}`);
  const b = boardView(ctx, 'all');
  const h = b.open.find((s) => s.id === hid.id)!;
  assert.equal(h.hidden, true); assert.equal(h.legs.length, 0); assert.equal(h.legCount, 1);
  assert.equal((await liveView(ctx, false)).hiddenLegs, 1);

  // leaderboard ranks by profit
  assert.deepEqual(b.leaderboard.map((x) => [x.user, x.profit]), [['Lelouch', 2.64], ['Ace', -2]]);

  // only the owner (or admin) can reveal
  assert.throws(() => revealSlip(db, hid.id, 'someone-else', false), SlipError);
  revealSlip(db, hid.id, 'u3', false);
  assert.ok(JSON.stringify(boardView(ctx, 'all')).includes('Bam Adebayo'));
  // injury note shows once the player is on a public slip
  const n = await newsView(ctx);
  assert.equal(n.injuries.length, 1); assert.equal(n.injuries[0].player, 'Bam Adebayo'); assert.equal(n.injuries[0].onSlip, true);
});

test('hidden slips auto-reveal when they settle', async () => {
  const { db, espn, engine } = makeCtx(routes);
  const r = new Resolver(espn);
  const s = createSlip(db, { user_id: 'u', user_name: 'U', stake: 1, hidden: true }, [await r.resolve('Giannis o20.5 pts (-110)', opts)]);
  await engine.tick();
  const after = getSlip(db, s.id)!;
  assert.equal(after.status, 'won'); assert.ok(after.revealed_at);
});

test('feed down: engine keeps legs pending and health reports the failure', async () => {
  const { db, espn, engine, ctx } = makeCtx({ ...routes, 'nba/summary?event=401909881': new Error('HTTP 503') });
  const r = new Resolver(espn);
  const s = createSlip(db, { user_id: 'u', user_name: 'U', stake: 1 }, [await r.resolve('Giannis o20.5 pts (-110)', opts)]);
  await engine.tick();
  assert.equal(getSlip(db, s.id)!.status, 'open');
  const { healthView } = await import('../src/views.ts');
  const h = healthView(ctx);
  const f = h.feeds.find((x) => x.feed === 'summary:nba')!;
  assert.equal(f.status, 'down'); assert.equal(f.lastError, 'HTTP 503');
  assert.equal(h.overall, 'degraded');
});

test('single-leg slip with conflicting odds is rejected', async () => {
  const { db, espn } = makeCtx(routes);
  const l = await new Resolver(espn).resolve('Giannis o20.5 pts (-110)', opts);
  assert.throws(() => createSlip(db, { user_id: 'u', user_name: 'U', stake: 1, odds: 264 }, [l]), /Conflicting odds/);
});
