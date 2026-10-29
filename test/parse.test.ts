import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeg, splitLegs, ParseError } from '../src/parse.ts';

const cases: [string, Record<string, unknown>][] = [
  ['Jokic o10.5 reb', { type: 'prop', subject: 'Jokic', side: 'over', line: 10.5, statText: 'reb', odds: null }],
  ['NBA: LeBron James over 25.5 points (-115)', { league: 'nba', type: 'prop', subject: 'LeBron James', line: 25.5, statText: 'points', odds: -115 }],
  ['Tatum 30+ pts (+150)', { type: 'prop', side: 'over', line: 29.5, statText: 'pts', odds: 150 }],
  ['Giannis pra u45.5', { type: 'prop', side: 'under', line: 45.5, statText: 'pra' }],
  ['Christian McCaffrey rush yds o85.5', { type: 'prop', subject: 'Christian McCaffrey', statText: 'rush yds', line: 85.5 }],
  ['Josh Jacobs anytime td +120', { type: 'prop', statText: 'anytime td', line: 0.5, side: 'over', odds: 120 }],
  ['Ohtani hr +250', { type: 'prop', statText: 'hr', line: 0.5, odds: 250 }],
  ['Jokic (DEN) o10.5 reb', { type: 'prop', subject: 'Jokic (DEN)' }],
  ['GB -3.5', { type: 'spread', subject: 'GB', line: -3.5, odds: null }],
  ['Packers +7 -105', { type: 'spread', subject: 'Packers', line: 7, odds: -105 }],
  ['GB pk', { type: 'spread', line: 0 }],
  ['CAR/GB u47.5', { type: 'total', subject: 'CAR', subject2: 'GB', side: 'under', line: 47.5 }],
  ['CAR @ GB over 47.5 +100', { type: 'total', side: 'over', line: 47.5, odds: 100 }],
  ['GB o47.5', { type: 'total', subject: 'GB', line: 47.5 }],
  ['GB ML', { type: 'ml', subject: 'GB', odds: null }],
  ['Green Bay Packers moneyline (-180)', { type: 'ml', subject: 'Green Bay Packers', odds: -180 }],
  ['GB -150', { type: 'ml', subject: 'GB', odds: -150 }],
];

for (const [input, want] of cases) {
  test(`parse: ${input}`, () => {
    const got = parseLeg(input) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${k} for "${input}"`);
  });
}

test('parse: garbage is a friendly ParseError', () => {
  assert.throws(() => parseLeg('the packers look good'), ParseError);
});

test('splitLegs handles newlines, ; and | and list markers', () => {
  assert.deepEqual(splitLegs('1. Jokic o10.5 reb\n2) GB -3.5; CAR/GB u47.5 | GB ML\n- Tatum 30+ pts'), ['Jokic o10.5 reb', 'GB -3.5', 'CAR/GB u47.5', 'GB ML', 'Tatum 30+ pts']);
});
