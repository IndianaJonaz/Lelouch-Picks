// PrizePicks + DraftKings settlement on top of real ESPN box scores.
// Kalshi (and every other book) keeps the existing settleSlip result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLeg, settleSlip } from '../src/grading.ts';
import { gameFromSummary } from '../src/espn.ts';
import { parseBox } from '../src/stats.ts';
import { parseLeg } from '../src/parse.ts';
import { gradeSource, settleForBook } from '../src/books.ts';
import { fx, leg } from './helpers.ts';

const nba = fx('nba_summary_final');
const final = gameFromSummary('nba', nba)!;
const box = parseBox('nba', nba);
const giannis = { athlete_id: '3032977', player: 'Giannis Antetokounmpo', team: 'MIA' };
const pre = { ...final, state: 'pre' as const, completed: false, statusName: 'STATUS_SCHEDULED' };

const graded = (p: object, g = final) => ({ ...gradeLeg(leg(p), g, box), odds: (p as { odds?: number | null }).odds ?? null });
const slip = (book: string, extra: object = {}) => ({ stake: 1, odds: null as number | null, book, play_type: null as string | null, payout: null as number | null, ...extra });

test('gradeSource recognises PrizePicks, the PricePicks spelling, DraftKings, and Kalshi', () => {
  assert.equal(gradeSource('PrizePicks'), 'prizepicks');
  assert.equal(gradeSource('PricePicks'), 'prizepicks');
  assert.equal(gradeSource('PP'), 'prizepicks');
  assert.equal(gradeSource('DraftKings'), 'draftkings');
  assert.equal(gradeSource('draft kings'), 'draftkings');
  assert.equal(gradeSource('Kalshi'), 'kalshi');
  assert.equal(gradeSource('FanDuel'), null);
  assert.equal(gradeSource(null), null);
});

test('more / less read as over / under', () => {
  assert.equal(parseLeg('Jokic more 22.5 pts').side, 'over');
  assert.equal(parseLeg('Jokic less 22.5 pts').side, 'under');
  assert.equal(parseLeg('Jokic more 22.5 pts').line, 22.5);
});

test('fixture box score: prop over wins, under loses, whole number pushes, DNP voids, pre-game stays pending', () => {
  assert.equal(graded({ ...giannis, stat: 'pts', side: 'over', line: 22.5 }).status, 'won');
  assert.equal(graded({ ...giannis, stat: 'pts', side: 'under', line: 22.5 }).status, 'lost');
  assert.equal(graded({ ...giannis, stat: 'pts', side: 'over', line: 24 }).status, 'push');
  assert.equal(graded({ player: 'Simone Fontecchio', athlete_id: '3899664', stat: 'pts', side: 'over', line: 5.5 }).status, 'void');
  assert.equal(gradeLeg(leg({ ...giannis, stat: 'pts', side: 'over', line: 22.5 }), pre, box).status, 'pending');
});

test('PrizePicks power play: all legs hit cashes, one miss loses, a push pushes, a DNP is removed', () => {
  const over = graded({ ...giannis, stat: 'pts', side: 'over', line: 22.5, odds: -110 });
  const cover = graded({ type: 'spread', team: 'MIA', line: -11.5, odds: -110 });
  const miss = graded({ ...giannis, stat: 'pts', side: 'over', line: 30.5, odds: -110 });
  const push = graded({ ...giannis, stat: 'pts', side: 'over', line: 24, odds: -110 });
  const dnp = graded({ player: 'Simone Fontecchio', athlete_id: '3899664', stat: 'pts', side: 'over', line: 5.5, odds: -110 });
  const pp = slip('PrizePicks');

  const won = settleForBook(pp, [over, cover]);
  assert.equal(won.status, 'won');
  assert.equal(won.profit, 2.64); // two -110 legs, same math as today

  const lost = settleForBook(pp, [over, miss]);
  assert.equal(lost.status, 'lost');
  assert.equal(lost.profit, -1);

  const pushed = settleForBook(pp, [push]);
  assert.equal(pushed.status, 'push');
  assert.equal(pushed.profit, 0);

  // DNP drops out. The remaining -110 leg is the bet — the original slip price is not reused.
  const afterDnp = settleForBook({ ...pp, odds: 500 }, [dnp, over]);
  assert.equal(afterDnp.status, 'won');
  assert.equal(afterDnp.profit, 0.91);

  const waiting = graded({ ...giannis, stat: 'pts', side: 'over', line: 22.5 }, pre);
  assert.equal(settleForBook(pp, [waiting, over]).status, 'open');
  assert.equal(settleForBook(pp, [waiting, over]).profit, null);
});

test('PrizePicks flex records hits out of the remaining legs and pays the flex chart', () => {
  const hit = (odds = -110) => graded({ ...giannis, stat: 'pts', side: 'over', line: 22.5, odds });
  const miss = () => graded({ ...giannis, stat: 'pts', side: 'over', line: 30.5, odds: -110 });
  const flex = slip('PricePicks', { play_type: '5-Pick Flex Play' });
  // 3-pick flex: 2 of 3 returns stake (push), 3 of 3 cashes 3x, 1 of 3 loses.
  const two = settleForBook({ ...flex, play_type: 'Flex Play' }, [hit(), hit(), miss()]);
  assert.equal(two.status, 'push');
  assert.equal(two.profit, 0);
  assert.equal(two.detail, '2/3 hits');
  const three = settleForBook({ ...flex, play_type: 'Flex', odds: null, payout: null }, [hit(), hit(), hit()]);
  assert.equal(three.status, 'won');
  assert.equal(three.profit, 2); // 3x payout → +2
  assert.match(three.detail ?? '', /^3\/3 hits/);
  const one = settleForBook({ ...flex, play_type: 'flex' }, [hit(), miss(), miss()]);
  assert.equal(one.status, 'lost');
  assert.equal(one.profit, -1);
  assert.equal(one.detail, '1/3 hits');
});

test('DraftKings: parlay needs every remaining leg, push and void drop out, a single is graded as is', () => {
  const over = graded({ ...giannis, stat: 'pts', side: 'over', line: 22.5, odds: -110 });
  const cover = graded({ type: 'spread', team: 'MIA', line: -11.5, odds: -110 });
  const miss = graded({ ...giannis, stat: 'pts', side: 'over', line: 30.5, odds: -110 });
  const push = graded({ ...giannis, stat: 'pts', side: 'over', line: 24, odds: -110 });
  const dnp = graded({ player: 'Simone Fontecchio', athlete_id: '3899664', stat: 'pts', side: 'over', line: 5.5 });
  const dk = slip('DraftKings', { odds: 400 });

  assert.equal(settleForBook(dk, [over, cover]).status, 'won');
  assert.equal(settleForBook(dk, [over, miss]).status, 'lost');
  assert.equal(settleForBook(dk, [over, miss]).profit, -1);
  // Push drops. Remaining -110 wins. The 400 slip price was for both legs, so it is not used.
  const dropped = settleForBook(dk, [push, over]);
  assert.equal(dropped.status, 'won');
  assert.equal(dropped.profit, 0.91);
  // Single push is a push. Single loss is a loss. Void single returns stake.
  assert.deepEqual(settleForBook(dk, [push]), { status: 'push', profit: 0, detail: null });
  assert.equal(settleForBook(dk, [miss]).status, 'lost');
  assert.equal(settleForBook(dk, [dnp]).status, 'void');
  const waiting = graded({ ...giannis, stat: 'pts', side: 'over', line: 22.5 }, pre);
  assert.equal(settleForBook(dk, [waiting]).status, 'open');
});

test('Kalshi settlement is unchanged from settleSlip', () => {
  const legs = [
    graded({ ...giannis, stat: 'pts', side: 'over', line: 22.5, odds: -110 }),
    graded({ type: 'spread', team: 'MIA', line: -11.5, odds: -110 }),
  ];
  const s = { stake: 1, odds: 250, book: 'Kalshi', play_type: null, payout: null };
  assert.deepEqual(settleForBook(s, legs), settleSlip(s, legs));
  const pushed = [
    graded({ ...giannis, stat: 'pts', side: 'over', line: 22.5, odds: -110 }),
    graded({ ...giannis, stat: 'pts', side: 'over', line: 24, odds: -110 }),
  ];
  assert.deepEqual(settleForBook({ ...s, book: 'Kalshi' }, pushed), settleSlip(s, pushed));
  // A book we do not special-case also stays on the original grader.
  assert.deepEqual(settleForBook({ ...s, book: null }, legs), settleSlip(s, legs));
});
