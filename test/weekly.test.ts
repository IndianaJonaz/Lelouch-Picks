import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWeek, weekWindow } from '../src/weekly.ts';
import { weeklyView } from '../src/views.ts';
import { createSlip } from '../src/store.ts';
import { makeCtx, leg } from './helpers.ts';

test('week window is Monday–Monday in the group timezone and can step back', () => {
  // Wednesday 2026-10-28, afternoon Chicago (CDT, UTC-5).
  const now = new Date('2026-10-28T18:00:00Z');
  const cur = weekWindow(now, 'America/Chicago', 0, 'monday');
  assert.equal(cur.start, '2026-10-26T05:00:00.000Z');
  assert.equal(cur.end, '2026-11-02T06:00:00.000Z'); // CST starts Nov 1 2026
  assert.equal(cur.label.includes('Oct'), true);
  const prev = weekWindow(now, 'America/Chicago', 1, 'monday');
  assert.equal(prev.end, cur.start);
  const sun = weekWindow(now, 'America/Chicago', 0, 'sunday');
  assert.equal(sun.start, '2026-10-25T05:00:00.000Z');
});

test('weekly math: record, profit, ROI; pushes are not risked; voids are skipped; sport vs analyst', () => {
  const rows = [
    { key: 'a', label: 'Ace', status: 'won', stake: 10, profit: 5, sports: ['nba'] },
    { key: 'a', label: 'Ace', status: 'lost', stake: 10, profit: -10, sports: ['nba'] },
    { key: 'a', label: 'Ace', status: 'push', stake: 10, profit: 0, sports: ['nfl'] },
    { key: 'a', label: 'Ace', status: 'void', stake: 10, profit: 0, sports: ['nba'] },
    { key: 'b', label: 'Bea', status: 'won', stake: 20, profit: 20, sports: ['nfl', 'nba'] },
  ];
  const byAnalyst = summarizeWeek(rows, 'analyst');
  const ace = byAnalyst.find((r) => r.key === 'a')!;
  assert.deepEqual([ace.w, ace.l, ace.p], [1, 1, 1]);
  assert.equal(ace.profit, -5);
  assert.equal(ace.staked, 20); // push and void stakes are not risked
  assert.equal(ace.roi, -25);
  const bea = byAnalyst.find((r) => r.key === 'b')!;
  assert.equal(bea.roi, 100);
  assert.deepEqual(byAnalyst.map((r) => r.key), ['b', 'a']); // profit desc

  const bySport = summarizeWeek(rows, 'sport');
  const nba = bySport.find((r) => r.key === 'nba')!;
  const nfl = bySport.find((r) => r.key === 'nfl')!;
  const multi = bySport.find((r) => r.key === 'multi')!;
  assert.deepEqual([nba.w, nba.l, nba.p, nba.profit], [1, 1, 0, -5]);
  assert.equal(nfl.p, 1);
  assert.equal(nfl.profit, 0);
  assert.equal(multi.profit, 20);
  assert.equal(multi.w, 1);
});

test('weeklyView reads the selected week and skips test slips', () => {
  const { db, ctx } = makeCtx();
  const L = (league: string) => leg({ type: 'ml', league, team: 'MIA', odds: -110, raw: 'MIA ML' });
  const mk = (user: string, league: string) => createSlip(db, { user_id: user, user_name: user, stake: 10, odds: -110, oddsOptional: true }, [L(league)]);
  const a = mk('Ace', 'nba');
  const b = mk('Bea', 'nfl');
  const t = createSlip(db, { user_id: 'Ace', user_name: 'Ace', stake: 10, odds: -110, oddsOptional: true, is_test: true }, [L('nba')]);
  // Inside the week of 2026-10-28 (Mon Oct 26 – Mon Nov 2, Chicago).
  db.prepare(`UPDATE slips SET status = 'won', profit = 10, settled_at = '2026-10-27T18:00:00.000Z' WHERE id = ?`).run(a.id);
  db.prepare(`UPDATE slips SET status = 'lost', profit = -10, settled_at = '2026-10-27T19:00:00.000Z' WHERE id = ?`).run(b.id);
  db.prepare(`UPDATE slips SET status = 'won', profit = 99, settled_at = '2026-10-27T20:00:00.000Z' WHERE id = ?`).run(t.id);
  const now = new Date('2026-10-28T18:00:00Z');
  const cur = weeklyView(ctx, 0, 'analyst', undefined, now);
  assert.equal(cur.rows.find((r) => r.label === 'Ace')!.profit, 10);
  assert.equal(cur.rows.find((r) => r.label === 'Bea')!.l, 1);
  assert.equal(cur.rows.some((r) => r.profit === 99), false);
  const sport = weeklyView(ctx, 0, 'sport', undefined, now);
  assert.equal(sport.rows.find((r) => r.key === 'nba')!.w, 1);
  assert.equal(sport.rows.find((r) => r.key === 'nfl')!.l, 1);
  const prev = weeklyView(ctx, 1, 'analyst', undefined, now);
  assert.equal(prev.rows.length, 0);
});
