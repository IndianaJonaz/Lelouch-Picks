// Scoreboard grading: match a pending leg to one final game, or leave it pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScoreboardGrade, matchLeg } from '../src/scoregrade.ts';
import { claimGradePost, releaseGradePost } from '../src/layup.ts';
import { createSlip } from '../src/store.ts';
import { getLegs, getSlip } from '../src/db.ts';
import { fx, leg, makeCtx } from './helpers.ts';
import type { Game, TeamSide } from '../src/espn.ts';

const side = (abbr: string, score: number | null): TeamSide => ({
  id: abbr, abbr, name: abbr, short: abbr, location: abbr, score, logo: null, color: null, record: null,
});

function game(p: Partial<Game> & { id: string; home: string; away: string; hs?: number | null; as?: number | null }): Game {
  const { home, away, hs, as, ...rest } = p;
  return {
    league: 'nba', name: `${away} at ${home}`, shortName: `${away} @ ${home}`, start: '2026-10-28T23:00:00Z',
    state: 'post', completed: true, statusName: 'STATUS_FINAL', detail: 'Final', period: 4, clock: 0, displayClock: '0:00',
    odds: null, broadcast: null, fetchedAt: 0,
    ...rest,
    home: side(home, hs === undefined ? 110 : hs), away: side(away, as === undefined ? 100 : as),
  };
}

const spread = (p: object) => leg({ type: 'spread', team: 'MIA', line: -5.5, event_id: null, event_name: 'BOS @ MIA', start_time: '2026-10-28T23:00:00Z', ...p });

test('exact event id on a final game is a confident match and grades the spread', () => {
  const g = game({ id: '401', home: 'MIA', away: 'BOS', hs: 110, as: 100 });
  const live = game({ id: '401', home: 'MIA', away: 'BOS', state: 'in', completed: false, statusName: 'STATUS_IN_PROGRESS' });
  assert.equal(matchLeg(spread({ event_id: '401' }), [g]).ok, true);
  assert.equal(applyScoreboardGrade(spread({ event_id: '401' }), [g]).status, 'won'); // 110 - 5.5 - 100 = 4.5
  assert.equal(applyScoreboardGrade(spread({ event_id: '401', line: -10.5 }), [g]).status, 'lost');
  assert.equal(applyScoreboardGrade(spread({ event_id: '401', line: -10 }), [g]).status, 'push');
  // Not final yet: leave the leg pending. Do not post a result.
  assert.equal(applyScoreboardGrade(spread({ event_id: '401' }), [live]).status, 'pending');
  assert.equal(matchLeg(spread({ event_id: '401' }), [live]).reason, 'not-final');
});

test('no match and ambiguous matches stay pending — the grader does not guess a game', () => {
  const mia = game({ id: '1', home: 'MIA', away: 'BOS' });
  const mia2 = game({ id: '2', home: 'MIA', away: 'NYK', start: '2026-10-28T23:30:00Z' });
  const phi = spread({ team: 'PHI', event_name: 'PHI @ NYK' });
  assert.equal(matchLeg(phi, [mia]).reason, 'none');
  assert.equal(applyScoreboardGrade(phi, [mia]).status, 'pending');
  // Team only, on two finals, with nothing that picks a side: ambiguous.
  const amb = spread({ event_id: null, event_name: null, team: 'MIA' });
  assert.equal(matchLeg(amb, [mia, mia2]).reason, 'ambiguous');
  assert.equal(applyScoreboardGrade(amb, [mia, mia2]).status, 'pending');
  // An event id that is not on the board does not fall through to a team guess.
  assert.equal(matchLeg(spread({ event_id: 'missing', team: 'MIA' }), [mia]).reason, 'none');
});

test('props are not graded from the scoreboard alone', () => {
  const g = game({ id: '401', home: 'MIA', away: 'BOS' });
  const prop = leg({ type: 'prop', event_id: '401', player: 'Giannis', stat: 'pts', side: 'over', line: 0.5, team: 'MIA' });
  assert.equal(applyScoreboardGrade(prop, [g]).status, 'pending');
});

test('grading the same final twice does not change a settled leg', () => {
  const g = game({ id: '401', home: 'MIA', away: 'BOS' });
  const once = applyScoreboardGrade(spread({ event_id: '401' }), [g]);
  assert.equal(once.status, 'won');
  const twice = applyScoreboardGrade(spread({ event_id: '401', status: 'won', actual: once.actual }), [g]);
  assert.equal(twice.status, 'won');
  assert.equal(twice.actual, once.actual);
});

test('engine: scoreboard grades a final spread once; an unmatched team stays pending', async () => {
  const { db, engine } = makeCtx({ 'nba/scoreboard?dates=20261028': fx('nba_scoreboard_final'), 'nba/scoreboard?dates=20261027': { events: [] } });
  const base = { league: 'nba', event_name: 'MIA @ ATL', start_time: '2026-10-28T23:00:00.000Z', player: null, athlete_id: null, stat: null, side: null as const, odds: -110 };
  const hit = createSlip(db, { user_id: 'u', user_name: 'U', stake: 1, odds: -110 }, [
    { ...base, event_id: '401909881', type: 'spread', team: 'MIA', line: -11.5, raw: 'MIA -11.5' },
  ]);
  const miss = createSlip(db, { user_id: 'u', user_name: 'U', stake: 1, odds: -110 }, [
    { ...base, event_id: null, event_name: 'PHI @ NYK', type: 'spread', team: 'PHI', line: -3, raw: 'PHI -3' },
  ]);
  await engine.tick();
  assert.equal(getSlip(db, hit.id)!.status, 'won');
  assert.equal(getLegs(db, hit.id)[0].status, 'won');
  assert.equal(getSlip(db, miss.id)!.status, 'open');
  assert.equal(getLegs(db, miss.id)[0].status, 'pending');
  const profit = getSlip(db, hit.id)!.profit;
  await engine.tick();
  assert.equal(getSlip(db, hit.id)!.status, 'won');
  assert.equal(getSlip(db, hit.id)!.profit, profit);
  assert.equal(getLegs(db, miss.id)[0].status, 'pending');
});

test('layup post claim is idempotent across repeats', () => {
  const { db } = makeCtx();
  assert.equal(claimGradePost(db, 'ABCDE', 'won'), true);
  assert.equal(claimGradePost(db, 'ABCDE', 'won'), false);
  releaseGradePost(db, 'ABCDE');
  assert.equal(claimGradePost(db, 'ABCDE', 'won'), true);
});
