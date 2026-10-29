import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBox, statValue, findStat, findInBox } from '../src/stats.ts';
import { fx } from './helpers.ts';

test('NBA box score: real MIA@ATL final', () => {
  const box = parseBox('nba', fx('nba_summary_final'));
  const g = box.get('3032977')!; // Giannis
  assert.equal(g.name, 'Giannis Antetokounmpo');
  assert.equal(g.team, 'MIA');
  assert.equal(g.stats.pts, 24); assert.equal(g.stats.reb, 18); assert.equal(g.stats.ast, 3);
  assert.equal(statValue('nba', 'pra', g), 45);
  assert.equal(box.get('6475')!.stats['3pm'], 1); // Klay 1-4 from three
  assert.equal(box.get('4997528')!.dnp, false);
  assert.equal(findInBox(box, null, 'Simone Fontecchio')!.dnp, true);
});

test('NHL box score uses shotsTotal for SOG (ESPN labels are misaligned)', () => {
  const box = parseBox('nhl', fx('nhl_summary_final'));
  const tuch = box.get('3114766')!;
  assert.deepEqual([tuch.stats.goals, tuch.stats.sog], [2, 5]);
  assert.equal(statValue('nhl', 'points', tuch), 2);
  assert.equal(box.get('4271575')!.stats.saves, 25);
});

test('MLB box score: pitcher outs from IP, batter hits', () => {
  const box = parseBox('mlb', fx('mlb_summary_final'));
  const p = box.get('5080761')!; // Misiorowski 5.2 IP, 2 K
  assert.equal(p.stats.outs, 17); assert.equal(p.stats.pk, 2);
  assert.equal(box.get('4917869')!.stats.hits, 1);
});

test('NFL box score merges passing/rushing/receiving groups', () => {
  const box = parseBox('nfl', fx('nfl_summary'));
  assert.equal(box.get('2577417')!.stats.pass_yds, 5);
  assert.equal(box.get('4361579')!.stats.rush_yds, 23);
});

test('stat aliases are sport-aware', () => {
  assert.equal(findStat('nba', 'points')!.key, 'pts');
  assert.equal(findStat('nhl', 'points')!.key, 'points');
  assert.equal(findStat('nhl', 'shots')!.key, 'sog');
  assert.equal(findStat('mlb', 'ks')!.key, 'pk');
  assert.equal(findStat('nfl', 'anytime td')!.key, 'td');
  assert.equal(findStat('nba', 'p+r+a')!.key, 'pra');
  assert.equal(findStat('nba', 'pass yds'), null);
});
