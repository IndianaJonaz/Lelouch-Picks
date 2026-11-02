import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSeePick, canonicalTier, parseLadder, parseStaff, viewerFromRoles, DEFAULT_LADDER } from '../src/tiers.ts';
import { createSlip } from '../src/store.ts';
import { boardView, leaderboard } from '../src/views.ts';
import { makeCtx, leg } from './helpers.ts';

const free = { userId: 'free-user', tier: 'free', staff: false };
const vip = { userId: 'vip-user', tier: 'vip', staff: false };
const staff = { userId: 'mod', tier: 'free', staff: true };

test('default ladder is Free < Moneyline < VIP < Deluxe < Lifetime and is configurable', () => {
  assert.deepEqual(DEFAULT_LADDER.map((t) => t.id), ['free', 'moneyline', 'vip', 'deluxe', 'lifetime']);
  const custom = parseLadder('public:Public,gold:Gold');
  assert.deepEqual(custom.map((t) => [t.id, t.label, t.rank]), [['public', 'Public', 0], ['gold', 'Gold', 1]]);
  assert.deepEqual(parseStaff('Admin, Analyst Mods ,Support'), ['Admin', 'Analyst Mods', 'Support']);
});

test('role names pick the highest tier; staff roles see everything; no tier role is Free', () => {
  assert.deepEqual(viewerFromRoles(['Free Member']), { tier: 'free', staff: false });
  assert.deepEqual(viewerFromRoles(['Free Member', 'VIP']), { tier: 'vip', staff: false });
  assert.deepEqual(viewerFromRoles(['Lifetime', 'Moneyline']), { tier: 'lifetime', staff: false });
  assert.equal(viewerFromRoles(['Moderator']).staff, true);
  assert.equal(viewerFromRoles(['analyst mods']).staff, true);
  assert.equal(viewerFromRoles(['Support']).tier, 'free');
  assert.equal(viewerFromRoles(['Support']).staff, true);
  assert.deepEqual(viewerFromRoles([]), { tier: 'free', staff: false });
});

test('members see their tier and below; staff and the owner see the rest; default tier is free', () => {
  const row = (tier: string | null, user_id = 'someone') => ({ tier, user_id });
  assert.equal(canonicalTier(null), 'free');
  assert.equal(canonicalTier('VIP'), 'vip');
  assert.equal(canonicalTier('nope'), null);
  assert.equal(canSeePick(row(null), free), true);
  assert.equal(canSeePick(row('free'), free), true);
  assert.equal(canSeePick(row('moneyline'), free), false);
  assert.equal(canSeePick(row('vip'), vip), true);
  assert.equal(canSeePick(row('deluxe'), vip), false);
  assert.equal(canSeePick(row('lifetime'), vip), false);
  assert.equal(canSeePick(row('lifetime'), staff), true);
  assert.equal(canSeePick(row('lifetime', 'vip-user'), vip), true); // owner
});

test('board and leaderboard hide picks above the viewer; existing free picks stay visible', () => {
  const { db, ctx } = makeCtx();
  const L = (league: string) => leg({ type: 'spread', league, team: 'MIA', line: -3, event_id: null, odds: -110, raw: 'MIA -3' });
  const u = { user_id: 'analyst', user_name: 'Analyst', stake: 1, odds: -110, oddsOptional: true };
  const pub = createSlip(db, u, [L('nba')]);
  const hid = createSlip(db, { ...u, tier: 'vip' }, [L('nfl')]);
  db.prepare(`UPDATE slips SET status = 'won', profit = 1, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(pub.id);
  db.prepare(`UPDATE slips SET status = 'won', profit = 5, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(hid.id);

  const asFree = boardView(ctx, 'all', free);
  assert.ok(asFree.open.concat(asFree.recent).every((s) => s.id !== hid.id));
  assert.equal(leaderboard(ctx, 'all', free).find((r) => r.user === 'Analyst')!.profit, 1);

  const asVip = boardView(ctx, 'all', vip);
  assert.ok(asVip.recent.some((s) => s.id === hid.id));
  assert.equal(leaderboard(ctx, 'all', vip).find((r) => r.user === 'Analyst')!.profit, 6);

  const asStaff = boardView(ctx, 'all', staff);
  assert.ok(asStaff.recent.some((s) => s.id === hid.id));
  // No viewer (internal / admin) still sees every row, which is today's behavior.
  assert.equal(leaderboard(ctx, 'all').find((r) => r.user === 'Analyst')!.profit, 6);
});
