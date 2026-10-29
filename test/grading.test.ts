import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLeg, paceFor, settleSlip, toWin } from '../src/grading.ts';
import { gameFromSummary, elapsedFraction, type Game } from '../src/espn.ts';
import { parseBox } from '../src/stats.ts';
import { fx, leg } from './helpers.ts';

const nba = fx('nba_summary_final');
const final = gameFromSummary('nba', nba)!;
const box = parseBox('nba', nba);
const live = (over: Partial<Game> = {}): Game => ({ ...final, state: 'in', completed: false, statusName: 'STATUS_IN_PROGRESS', period: 3, clock: 360, detail: 'Q3 6:00', ...over });
const giannis = { athlete_id: '3032977', player: 'Giannis Antetokounmpo', team: 'MIA' };

test('final game parsed from summary header', () => {
  assert.equal(final.state, 'post'); assert.equal(final.completed, true);
  assert.equal(final.home.abbr, 'ATL'); assert.equal(final.home.score, 117);
  assert.equal(final.away.abbr, 'MIA'); assert.equal(final.away.score, 129);
});

test('prop over/under at final, incl. push on whole-number line', () => {
  assert.equal(gradeLeg(leg({ ...giannis, stat: 'pts', side: 'over', line: 22.5 }), final, box).status, 'won');
  assert.equal(gradeLeg(leg({ ...giannis, stat: 'pts', side: 'over', line: 24.5 }), final, box).status, 'lost');
  assert.equal(gradeLeg(leg({ ...giannis, stat: 'pts', side: 'over', line: 24 }), final, box).status, 'push');
  const u = gradeLeg(leg({ ...giannis, stat: 'pra', side: 'under', line: 45.5 }), final, box);
  assert.deepEqual([u.status, u.actual], ['won', 45]);
});

test('over cashes early mid-game; under busts early; otherwise stays pending', () => {
  const g = live();
  assert.equal(gradeLeg(leg({ ...giannis, stat: 'reb', side: 'over', line: 15.5 }), g, box).status, 'won');
  assert.equal(gradeLeg(leg({ ...giannis, stat: 'reb', side: 'under', line: 15.5 }), g, box).status, 'lost');
  const p = gradeLeg(leg({ ...giannis, stat: 'pts', side: 'over', line: 30.5 }), g, box);
  assert.deepEqual([p.status, p.actual], ['pending', 24]);
  assert.equal(gradeLeg(leg({ ...giannis, stat: 'pts', side: 'under', line: 30.5 }), g, box).status, 'pending');
});

test('DNP voids; settled legs never change; pre-game untouched; postponed voids', () => {
  assert.equal(gradeLeg(leg({ player: 'Simone Fontecchio', athlete_id: '3899664', stat: 'pts', side: 'over', line: 5.5 }), final, box).status, 'void');
  assert.equal(gradeLeg(leg({ ...giannis, stat: 'pts', side: 'over', line: 50.5, status: 'won' }), final, box).status, 'won');
  assert.equal(gradeLeg(leg({ ...giannis, stat: 'pts', side: 'over', line: 1.5 }), { ...final, state: 'pre', completed: false }, box).status, 'pending');
  assert.equal(gradeLeg(leg({ type: 'spread', team: 'MIA', line: -3 }), { ...final, statusName: 'STATUS_POSTPONED' }, null).status, 'void');
});

test('football: player missing from final box score goes to review, not a guess', () => {
  const nfl = fx('nfl_summary');
  const g = { ...gameFromSummary('nfl', nfl)!, state: 'post' as const, completed: true };
  const r = gradeLeg(leg({ league: 'nfl', player: 'Nobody Here', athlete_id: '1', stat: 'rec_yds', side: 'over', line: 10.5 }), g, parseBox('nfl', nfl));
  assert.equal(r.status, 'review');
});

test('spread / total / moneyline at final (MIA 129 @ ATL 117)', () => {
  const s = (p: object) => gradeLeg(leg({ type: 'spread', ...p }), final, box).status;
  assert.equal(s({ team: 'MIA', line: -11.5 }), 'won');
  assert.equal(s({ team: 'MIA', line: -12.5 }), 'lost');
  assert.equal(s({ team: 'MIA', line: -12 }), 'push');
  assert.equal(s({ team: 'ATL', line: 12.5 }), 'won');
  const t = (side: 'over' | 'under', line: number) => gradeLeg(leg({ type: 'total', side, line }), final, box).status;
  assert.equal(t('over', 245.5), 'won'); assert.equal(t('under', 245.5), 'lost'); assert.equal(t('over', 246), 'push');
  assert.equal(gradeLeg(leg({ type: 'ml', team: 'MIA' }), final, box).status, 'won');
  assert.equal(gradeLeg(leg({ type: 'ml', team: 'ATL' }), final, box).status, 'lost');
  assert.equal(gradeLeg(leg({ type: 'ml', team: 'ATL' }), { ...final, home: { ...final.home, score: 129 } }, box).status, 'push');
});

test('live totals: over cashes once passed, under busts once passed', () => {
  const g = live({ home: { ...final.home, score: 100 }, away: { ...final.away, score: 101 } });
  assert.equal(gradeLeg(leg({ type: 'total', side: 'over', line: 200.5 }), g, null).status, 'won');
  assert.equal(gradeLeg(leg({ type: 'total', side: 'under', line: 200.5 }), g, null).status, 'lost');
  assert.equal(gradeLeg(leg({ type: 'total', side: 'over', line: 230.5 }), g, null).status, 'pending');
});

test('pace: Q3 6:00 left = 62.5% of regulation; projection is linear', () => {
  const g = live();
  assert.equal(elapsedFraction(g), 0.625);
  const p = paceFor(leg({ ...giannis, stat: 'pts', side: 'over', line: 30.5 }), g, box);
  assert.equal(p.current, 24); assert.equal(p.projected, 38.4); assert.equal(p.onPace, true);
  const q = paceFor(leg({ ...giannis, stat: 'pts', side: 'over', line: 40.5 }), g, box);
  assert.equal(q.onPace, false);
  assert.equal(elapsedFraction({ league: 'nhl', state: 'in', period: 4, clock: 100, detail: 'OT', completed: false }), 1);
  assert.equal(elapsedFraction({ league: 'mlb', state: 'in', period: 5, clock: 0, detail: 'Bot 5th', completed: false }), 4.5 / 9);
  assert.equal(elapsedFraction({ ...g, state: 'pre' }), null);
});

test('settle: parlay math, losses, pushes re-price, review when unknowable', () => {
  // two -110 legs = +264.46
  assert.deepEqual(settleSlip({ stake: 1, odds: null }, [{ status: 'won', odds: -110 }, { status: 'won', odds: -110 }]), { status: 'won', profit: 2.64, detail: null });
  assert.equal(settleSlip({ stake: 2, odds: 450 }, [{ status: 'won', odds: null }, { status: 'won', odds: null }]).profit, 9);
  assert.deepEqual(settleSlip({ stake: 2, odds: 450 }, [{ status: 'lost', odds: null }, { status: 'pending', odds: null }]), { status: 'lost', profit: -2, detail: null });
  assert.equal(settleSlip({ stake: 1, odds: null }, [{ status: 'won', odds: null }, { status: 'pending', odds: null }]).status, 'open');
  // push drops the leg: remaining single -110 leg pays 0.91
  const pushed = settleSlip({ stake: 1, odds: 264 }, [{ status: 'won', odds: -110 }, { status: 'push', odds: -110 }]);
  assert.deepEqual([pushed.status, pushed.profit], ['won', 0.91]);
  // push with slip odds only and unknown leg odds -> review rather than inventing a price
  assert.equal(settleSlip({ stake: 1, odds: 264 }, [{ status: 'won', odds: null }, { status: 'push', odds: null }]).status, 'review');
  assert.deepEqual(settleSlip({ stake: 1, odds: -110 }, [{ status: 'void', odds: -110 }]), { status: 'void', profit: 0, detail: 'Stake returned' });
  assert.equal(settleSlip({ stake: 1, odds: null }, [{ status: 'review', odds: -110 }, { status: 'won', odds: -110 }]).status, 'review');
  assert.equal(toWin({ stake: 1, odds: null }, [{ odds: 100 }, { odds: 100 }]), 3);
});

test('settle: slip price beats leg product when all legs stand (SGP pricing)', () => {
  assert.equal(settleSlip({ stake: 1, odds: 200 }, [{ status: 'won', odds: -110 }, { status: 'won', odds: -110 }]).profit, 2);
});
