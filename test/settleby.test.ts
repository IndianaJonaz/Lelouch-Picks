import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSettleBy, GAME_GRACE_MS, isOverdue, openLegMark } from '../src/settleby.ts';
import { gradeLeg } from '../src/grading.ts';
import { gameFromSummary } from '../src/espn.ts';
import { parseBox } from '../src/stats.ts';
import { createSlip } from '../src/store.ts';
import { getLegs, getSlip } from '../src/db.ts';
import { slipView } from '../src/views.ts';
import { fx, leg, makeCtx } from './helpers.ts';

test('open legs: a cleared over is a hit, a miss is a miss, pending has no mark', () => {
  const nba = fx('nba_summary_final');
  const final = gameFromSummary('nba', nba)!;
  const box = parseBox('nba', nba);
  const live = { ...final, state: 'in' as const, completed: false, statusName: 'STATUS_IN_PROGRESS' };
  const giannis = { athlete_id: '3032977', player: 'Giannis Antetokounmpo', team: 'MIA', stat: 'pts', side: 'over' as const };
  assert.equal(openLegMark(gradeLeg(leg({ ...giannis, line: 20.5 }), live, box).status), 'hit'); // already cleared
  assert.equal(openLegMark(gradeLeg(leg({ ...giannis, line: 40.5 }), live, box).status), null); // still pending
  assert.equal(openLegMark(gradeLeg(leg({ ...giannis, side: 'under', line: 20.5 }), live, box).status), 'miss');
  assert.equal(openLegMark(gradeLeg(leg({ ...giannis, line: 20.5 }), final, box).status), 'hit');
  assert.equal(openLegMark('pending'), null);
  assert.equal(openLegMark('push'), null);
  // Printed Kalshi / esports result: the stored leg status is the mark. No extra guess.
  assert.equal(openLegMark('won'), 'hit');
  assert.equal(openLegMark('lost'), 'miss');
});

test('settle_by is the latest start plus 12h, or a Kalshi close when one is known', () => {
  const early = '2026-10-28T23:00:00.000Z';
  const late = '2026-10-29T01:00:00.000Z';
  const at = computeSettleBy([
    { start_time: early, league: 'nba' },
    { start_time: late, league: 'nfl' },
  ]);
  assert.equal(at, new Date(Date.parse(late) + GAME_GRACE_MS).toISOString());
  assert.equal(computeSettleBy([{ start_time: null, league: 'nba' }]), null);
  const close = '2026-11-03T21:00:00Z';
  assert.equal(computeSettleBy([{ start_time: early, league: 'kalshi', raw: `Will it happen? Closes ${close}` }], 'Kalshi'), new Date(close).toISOString());
  // No close on the Kalshi leg: its start_time is the close, with no 12h grace added.
  assert.equal(computeSettleBy([{ start_time: early, league: 'kalshi', raw: 'Some market' }]), early);
});

test('past settle_by with a leg still pending is overdue; a resolved slip is not', () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(isOverdue({ status: 'open', settle_by: past }, [{ status: 'pending' }]), true);
  assert.equal(isOverdue({ status: 'open', settle_by: past }, [{ status: 'won' }, { status: 'lost' }]), false);
  assert.equal(isOverdue({ status: 'open', settle_by: future }, [{ status: 'pending' }]), false);
  assert.equal(isOverdue({ status: 'won', settle_by: past }, [{ status: 'pending' }]), false);
  assert.equal(isOverdue({ status: 'open', settle_by: null }, [{ status: 'pending' }]), false);
});

test('engine final pass: an unresolvable leg stays pending and the slip is overdue; a final game settles', async () => {
  const start = new Date(Date.now() - 20 * 3600_000).toISOString();
  const { db, engine, ctx } = makeCtx({ 'nba/scoreboard': { events: [] } });
  const stuck = createSlip(db, { user_id: 'u', user_name: 'U', stake: 1, odds: -110 }, [{
    league: 'nba', event_id: 'missing-game', event_name: 'Nowhere', start_time: start, type: 'prop',
    team: 'MIA', player: 'Nobody', athlete_id: null, stat: 'pts', side: 'over', line: 10.5, odds: -110, raw: 'Nobody o10.5 pts',
  }]);
  await engine.tick();
  const after = getSlip(db, stuck.id)!;
  assert.equal(after.status, 'open');
  assert.equal(getLegs(db, stuck.id)[0].status, 'pending');
  assert.ok(after.settle_by && Date.parse(after.settle_by) < Date.now());
  const view = slipView(after, getLegs(db, stuck.id), ctx);
  assert.equal(view.overdue, true);
  assert.equal((view as { legs: { mark: string | null }[] }).legs[0].mark, null);

  const { db: db2, engine: engine2, ctx: ctx2 } = makeCtx({
    'nba/scoreboard?dates=20261028': fx('nba_scoreboard_final'),
    'nba/scoreboard?dates=20261027': { events: [] },
  });
  const hit = createSlip(db2, { user_id: 'u', user_name: 'U', stake: 1, odds: -110 }, [{
    league: 'nba', event_id: '401909881', event_name: 'MIA @ ATL', start_time: '2026-10-28T23:00:00.000Z', type: 'spread',
    team: 'MIA', player: null, athlete_id: null, stat: null, side: null, line: -11.5, odds: -110, raw: 'MIA -11.5',
  }]);
  await engine2.tick();
  const settled = getSlip(db2, hit.id)!;
  assert.equal(settled.status, 'won');
  assert.equal(slipView(settled, getLegs(db2, hit.id), ctx2).overdue, false);
  assert.equal(getLegs(db2, hit.id)[0].status, 'won');
});
