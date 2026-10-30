import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlip, manualSettle } from '../src/store.ts';
import type { ResolvedLeg } from '../src/resolve.ts';
import { bookBucket, boardView, profitSeries, slipSports } from '../src/views.ts';
import { makeCtx } from './helpers.ts';

const leg = (league: string): ResolvedLeg => ({ league, event_id: null, event_name: null, start_time: null, type: 'prop', team: null, player: 'P', athlete_id: null, stat: 'pts', side: 'over', line: 1.5, odds: null, raw: 'P o1.5' });

test('bookBucket: PrizePicks / Kalshi / Other, case-insensitive', () => {
  for (const b of ['PrizePicks', 'prizepicks', 'PRIZEPICKS', 'Prize Picks', 'PP', 'pp']) assert.equal(bookBucket(b), 'prizepicks', b);
  for (const b of ['Kalshi', 'KALSHI', 'kalshi ']) assert.equal(bookBucket(b), 'kalshi', b);
  for (const b of ['FanDuel', 'Underdog', 'DraftKings', '', null, undefined]) assert.equal(bookBucket(b), 'other', String(b));
  assert.equal(bookBucket(null, ['kalshi']), 'kalshi'); // market legs without a book name
  assert.equal(bookBucket('FanDuel', ['kalshi']), 'other'); // explicit book wins
});

test('slipSports: per-leg leagues, aliases, multi-sport, case-insensitive', () => {
  assert.deepEqual(slipSports(['nba']), ['nba']);
  assert.deepEqual(slipSports(['NBA', 'nbap', 'TENNIS']), ['nba', 'tennis']);
  assert.deepEqual(slipSports(['Tennis', 'atp', 'WTA']), ['tennis']);
  assert.deepEqual(slipSports(['wnba', 'NBL', 'mlb', 'nfl']), ['wnba', 'nbl', 'mlb', 'nfl']);
  assert.deepEqual(slipSports(['other', 'kalshi', '', null]), []);
});

test('board open slips carry bookKey + sports; hidden slips expose no sport', () => {
  const { ctx, db } = makeCtx();
  const u = { user_id: 'u', user_name: 'Lelouch', stake: 1, oddsOptional: true };
  const pp = createSlip(db, { ...u, book: 'PRIZEPICKS' }, [leg('nba'), leg('tennis')]);
  const pick = createSlip(db, { ...u, odds: 200 }, [leg('nfl')]);
  const k = createSlip(db, { ...u, book: 'Kalshi' }, [leg('kalshi')]);
  const hid = createSlip(db, { ...u, book: 'PrizePicks', hidden: true }, [leg('nbl')]);
  const by = Object.fromEntries(boardView(ctx, 'all').open.map((s) => [s.id, s]));
  assert.equal(by[pp.id].bookKey, 'prizepicks'); assert.deepEqual(by[pp.id].sports, ['nba', 'tennis']);
  assert.equal(by[pick.id].bookKey, 'other'); assert.deepEqual(by[pick.id].sports, ['nfl']);
  assert.equal(by[k.id].bookKey, 'kalshi'); assert.deepEqual(by[k.id].sports, []);
  assert.equal(by[hid.id].bookKey, 'prizepicks'); assert.deepEqual(by[hid.id].sports, []);
  ctx.engine.stop();
});

test('profitSeries: cumulative per user in settle order; push/void = 0; tests excluded; created_at fallback flagged', () => {
  const { ctx, db } = makeCtx();
  const mk = (user: string, extra: object = {}) => createSlip(db, { user_id: user, user_name: user.toUpperCase(), stake: 10, oddsOptional: true, ...extra }, [leg('nba')]);
  const at = (id: string, status: string, profit: number, t: string | null) => db.prepare('UPDATE slips SET status=?, profit=?, settled_at=? WHERE id=?').run(status, profit, t, id);
  const a1 = mk('a'), a2 = mk('a'), a3 = mk('a'), a4 = mk('a'), b1 = mk('b'), t1 = mk('a', { is_test: true }), open = mk('b');
  at(a2.id, 'lost', -10, '2026-10-02T00:00:00.000Z');
  at(a1.id, 'won', 25.5, '2026-10-01T00:00:00.000Z');
  at(a3.id, 'push', 0, '2026-10-03T00:00:00.000Z');
  at(a4.id, 'void', 3, '2026-10-04T00:00:00.000Z'); // void never moves the line
  at(t1.id, 'won', 999, '2026-10-02T00:00:00.000Z');
  db.prepare("UPDATE slips SET created_at='2026-10-05T00:00:00.000Z' WHERE id=?").run(b1.id);
  at(b1.id, 'lost', -10, null);
  void open;
  const r = profitSeries(ctx);
  const a = r.users.find((u) => u.userId === 'a')!, b = r.users.find((u) => u.userId === 'b')!;
  assert.deepEqual(a.points.map((p) => [p.slipId, p.delta, p.cum]), [[a1.id, 25.5, 25.5], [a2.id, -10, 15.5], [a3.id, 0, 15.5], [a4.id, 0, 15.5]]);
  assert.equal(a.profit, 15.5); assert.equal(a.user, 'A');
  assert.deepEqual(b.points.map((p) => [p.cum, p.approxTime, p.t]), [[-10, true, '2026-10-05T00:00:00.000Z']]);
  assert.deepEqual(r.users.map((u) => u.userId), ['a', 'b']); // best first
  assert.equal(profitSeries(ctx, 'b').users.length, 1);
  assert.deepEqual(profitSeries(ctx, 'nobody').users, []);
  manualSettle(db, open.id, 'won', 5);
  assert.equal(profitSeries(ctx, 'b').users[0].profit, -5);
  ctx.engine.stop();
});
