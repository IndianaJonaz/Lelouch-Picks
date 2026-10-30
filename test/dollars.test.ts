import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands, units } from '../src/bot.ts';

test('units formats dollars with no plus sign', () => {
  assert.equal(units(200), '$200.00');
  assert.equal(units(50), '$50.00');
  assert.equal(units(-12), '$-12.00');
  assert.equal(units(1), '$1.00');
  assert.equal(units(0), '$0.00');
  assert.equal(units(null), '—');
  assert.equal(units(undefined), '—');
});

test('slash command help text says dollars and keeps option names', () => {
  const pick = commands.find((c) => c.name === 'pick')!;
  const stake = pick.options!.find((o) => o.name === 'stake')!;
  assert.equal(stake.name, 'stake');
  assert.equal(stake.description, 'Dollars risked (default 1)');
  const lb = commands.find((c) => c.name === 'leaderboard')!;
  assert.equal(lb.description, 'Ranked by profit (dollars), not volume');
  const settle = commands.find((c) => c.name === 'settle')!;
  const profit = settle.options!.find((o) => o.name === 'profit')!;
  assert.equal(profit.name, 'profit');
  assert.equal(profit.description, 'Profit in dollars (negative for a loss)');
  assert.ok(!JSON.stringify(commands).includes('units'));
});
