// Screenshot → confirm card → board. xAI is mocked; ESPN comes from fixtures (MIA 129 @ ATL 117, 2026-10-28).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits } from 'discord.js';
import { Resolver } from '../src/resolve.ts';
import { confirmDraft, deleteDraft, draftCard, editDefaults, editDraft, getDraft, readPhoto } from '../src/photoslips.ts';
import { checkSlip, extractSlips, normalizeSlip, normStat, parseMatchupScores, toImport, XAI_URL } from '../src/slipvision.ts';
import { botIntents, ticketEmbed } from '../src/bot.ts';
import { deleteSlip } from '../src/store.ts';
import { leaderboard, slipView, ticket } from '../src/views.ts';
import { fx, makeCtx as mk } from './helpers.ts';

// Stop every engine even when an assertion fails (its poll timer would keep the run alive).
const made: ReturnType<typeof mk>[] = [];
const makeCtx = (r: Record<string, unknown>) => { const c = mk(r); made.push(c); return c; };
after(() => { for (const c of made) c.engine.stop(); });

const routes = {
  'nba/scoreboard?dates=20261028': fx('nba_scoreboard_final'),
  'nba/summary?event=401909881': fx('nba_summary_final'),
  'nba/teams/14/roster': fx('nba_roster_mia'),
  'nba/teams/1/roster': fx('nba_roster_atl'),
};
const L = (o: Record<string, unknown>) => ({ player: null, team: null, league: 'NBA', matchup: 'MIA 129 vs ATL 117', line: null, direction: null, stat: null, actual: null, leg_result: null, confidence: 'high', ...o });
const slip = (o: Record<string, unknown> = {}) => ({
  is_slip: true, confidence: 'high', platform: 'PrizePicks', play_type: '3-Pick Power Play', pick_count: 3, stake: 55, payout: 330, odds_text: '6x', kalshi: null,
  status: 'won', games_date: null, screenshot_date: '2026-10-29', notes: null,
  legs: [
    L({ player: 'Giannis Antetokounmpo', team: 'MIA', line: 25.5, direction: 'under', stat: 'Points', actual: 24, leg_result: 'won' }),
    L({ player: 'Bam Adebayo', team: 'MIA', line: 20.5, direction: 'over', stat: 'Points', actual: 24, leg_result: 'won' }),
    L({ player: 'Faker', team: 'T1', league: 'LoL', matchup: 'T1 vs GEN', line: 5.5, direction: 'over', stat: 'MAPS 1-3 Kills', actual: 7, leg_result: 'won' }),
  ],
  ...o,
});
const read = (...slips: unknown[]) => ({ is_slip_image: true, slips });

/** Mock xAI: returns the queued payloads in order (last one repeats). */
function mockXai(payloads: unknown[], status = 200) {
  const calls: any[] = [];
  const f = (async (url: string, init: any) => {
    const p = payloads[Math.min(calls.length, payloads.length - 1)];
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(status === 200 ? JSON.stringify({ model: 'grok-4.3', choices: [{ message: { content: JSON.stringify(p) } }], usage: { prompt_tokens: 1800, completion_tokens: 400 } }) : '{"error":"bad key"}', { status });
  }) as unknown as typeof fetch;
  return { f, calls, v: { apiKey: 'test-key', fetch: f } };
}
const IMG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const who = { userId: '111222333444555666', userName: 'Lelouch', mime: 'image/jpeg', sourceUrl: 'https://discord.com/channels/1/2/3' };
const NOW = new Date('2026-10-29T15:00:00Z');

test('normalize: never invents — partial reads become blank legs that block Confirm; push/void is never a win', () => {
  const part = normalizeSlip(slip({ pick_count: 4, legs: [slip().legs[0], L({ player: 'Bam Adebayo', line: null, direction: 'over', stat: 'Points', confidence: 'low' })] }));
  assert.equal(part.legs.length, 4);                       // padded to the header's pick count
  assert.equal(part.legs[1].line, null);                   // never filled in
  const c = checkSlip(part);
  assert.ok(c.blocking.includes('leg 2: line'));
  assert.ok(c.blocking.includes('leg 3: player, line, over/under, stat'));
  assert.throws(() => toImport(part), /still missing/);
  const pushy = normalizeSlip(slip({ legs: [L({ player: 'A', line: 1, direction: 'over', stat: 'Points', leg_result: 'push' }), L({ player: 'B', line: 1, direction: 'over', stat: 'Points', leg_result: 'void' })], pick_count: 2 }));
  assert.equal(pushy.status, 'push');
  assert.equal(toImport(pushy).result!.profit, 0);
  // unknown layout / low confidence legs are flagged, not dropped
  const odd = checkSlip(normalizeSlip(slip({ platform: 'BetMGM', legs: [{ ...slip().legs[0], confidence: 'low' }, ...slip().legs.slice(1)] })));
  assert.match(odd.flags.join('|'), /Unrecognised layout \(BetMGM\)/);
  assert.match(odd.flags.join('|'), /Unsure about leg\(s\) 1/);
  assert.equal(normStat('3-PT Made'), '3pm');
  assert.deepEqual(parseMatchupScores('BKN 128 vs MIA 144'), [{ team: 'BKN', score: 128 }, { team: 'MIA', score: 144 }]);
});

test('mapping: payout → odds/profit, legs in printed order, Kalshi odds kept as logged', () => {
  const imp = toImport(normalizeSlip(slip()));
  assert.equal(imp.odds, 500); assert.deepEqual(imp.result, { status: 'won', profit: 275 }); assert.equal(imp.title, '$55 3-pick — paid $330');
  assert.deepEqual(imp.legs.map((l) => l.parsed!.subject), ['Giannis Antetokounmpo (MIA)', 'Bam Adebayo (MIA)', 'Faker (T1)']);
  assert.equal(toImport(normalizeSlip(slip({ status: 'lost' }))).result!.profit, -55);
  const k = normalizeSlip({ ...slip(), platform: 'Kalshi', play_type: null, pick_count: 1, stake: null, payout: null, odds_text: null, kalshi: { side: 'yes', price_cents: 40, contracts: 25 },
    legs: [L({ player: 'Will the Heat win vs ATL?', league: null, stat: 'Yes', leg_result: 'won' })] });
  assert.equal(k.stake, 10);
  const ki = toImport(k);
  assert.equal(ki.oddsText, 'YES 40¢ × 25'); assert.equal(ki.payout, 25); assert.equal(ki.odds, 150); assert.deepEqual(ki.result, { status: 'won', profit: 15 });
});

test('read → card: request shape, several slips per photo, nothing logged before Confirm', async () => {
  const { ctx, db } = makeCtx(routes);
  const x = mockXai([read(slip(), slip({ stake: 10, payout: 60, legs: slip().legs.slice(0, 2), pick_count: 2 }))]);
  const out = await readPhoto(ctx, x.v, { ...who, image: IMG, now: NOW });
  assert.equal(out.kind, 'drafts');
  if (out.kind !== 'drafts') return;
  const req = x.calls[0];
  assert.equal(req.url, XAI_URL); assert.equal(req.init.headers.authorization, 'Bearer test-key'); assert.equal(req.body.model, 'grok-4.3');
  assert.match(req.body.messages[1].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(req.body.response_format.type, 'json_schema');
  assert.equal(out.drafts.length, 2); assert.equal(out.reread, false);
  const card = draftCard(out.drafts[0], { i: 1, of: 2 });
  assert.equal(card.canConfirm, true);
  assert.match(card.text, /PrizePicks · 3-Pick Power Play\*\* \(slip 1\/2\)/);
  assert.match(card.text, /Only Lelouch or an admin can confirm/);
  assert.equal((db.prepare('SELECT count(*) n FROM slips').get() as any).n, 0);
  // the image itself is never stored — drafts hold only its hash + the read
  const cols = (db.prepare('PRAGMA table_info(photo_drafts)').all() as any[]).map((c) => c.name);
  assert.ok(!cols.some((c) => /image$|blob|bytes/.test(c)));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM photo_drafts').all()).includes(Buffer.from(IMG).toString('base64')));
  ctx.engine.stop();
});

test('one focused re-read when the first pass misses legs', async () => {
  const { ctx } = makeCtx(routes);
  const first = slip({ pick_count: 3, legs: slip().legs.slice(0, 2) });
  const x = mockXai([read(first), read(slip())]);
  const out = await readPhoto(ctx, x.v, { ...who, image: IMG });
  assert.equal(x.calls.length, 2);
  assert.match(x.calls[1].body.messages[1].content[1].text, /header says 3 picks but only 2 legs/);
  assert.ok(out.kind === 'drafts' && out.reread && out.drafts[0].x.legs.every((l) => l.player));
  // still incomplete after the re-read: no third call, blanks stay blank
  const y = mockXai([read(first)]);
  const o2 = await readPhoto(ctx, y.v, { ...who, image: new Uint8Array([8]) });
  assert.equal(y.calls.length, 2);
  assert.ok(o2.kind === 'drafts' && o2.drafts[0].x.legs[2].player === null && !draftCard(o2.drafts[0]).canConfirm);
  ctx.engine.stop();
});

test('failed read still offers a (blank) card; not-a-slip is silent unless in a slip channel; HEIC is refused', async () => {
  const { ctx } = makeCtx(routes);
  const bad = await readPhoto(ctx, mockXai([read(slip())], 401).v, { ...who, image: IMG });
  assert.equal(bad.kind, 'drafts');
  if (bad.kind === 'drafts') {
    assert.match(bad.drafts[0].readError!, /xAI HTTP 401/);
    const c = draftCard(bad.drafts[0]);
    assert.equal(c.canConfirm, false); assert.match(c.text, /couldn't read this image/);
  }
  const noKey = await readPhoto(ctx, { apiKey: '' }, { ...who, image: new Uint8Array([4]) });
  assert.ok(noKey.kind === 'drafts' && /XAI_API_KEY/.test(noKey.drafts[0].readError!));
  const ns = { is_slip_image: false, slips: [] };
  assert.deepEqual(await readPhoto(ctx, mockXai([ns]).v, { ...who, image: new Uint8Array([1]) }), { kind: 'not_slip' });
  const forced = await readPhoto(ctx, mockXai([ns]).v, { ...who, image: new Uint8Array([1]), forceCard: true });
  assert.equal(forced.kind, 'drafts');
  assert.deepEqual(await readPhoto(ctx, mockXai([ns]).v, { ...who, mime: 'image/heic', image: new Uint8Array([2]) }), { kind: 'unsupported', mime: 'image/heic' });
  ctx.engine.stop();
});

test('confirm: legs graded from ESPN first, then the slip result; poster\'s row; ticket consistent; dedupe; delete frees it', async () => {
  const { ctx, espn, db } = makeCtx(routes);
  const r = new Resolver(espn);
  const x = mockXai([read(slip())]);
  const rd = await readPhoto(ctx, x.v, { ...who, image: IMG, now: NOW });
  assert.ok(rd.kind === 'drafts');
  if (rd.kind !== 'drafts') return;
  const out = await confirmDraft(ctx, r, rd.drafts[0].id, NOW);
  assert.equal(out.kind, 'added', JSON.stringify(out));
  if (out.kind !== 'added') return;
  const s = out.slip;
  assert.deepEqual([s.status, s.profit, s.odds, s.user_id, s.source, s.book, s.play_type, s.payout, s.odds_text, s.source_url, s.is_test],
    ['won', 275, 500, who.userId, 'photo', 'PrizePicks', '3-Pick Power Play', 330, '6x', who.sourceUrl, 0]);
  const [g, b, lol] = out.legs;
  assert.deepEqual([g.status, g.actual, g.event_id], ['won', 24, '401909881']); // from the ESPN box score
  assert.deepEqual([b.status, b.actual], ['won', 24]);
  assert.deepEqual([lol.status, lol.actual, lol.event_id, lol.detail], ['won', 7, null, 'From the slip screenshot']);
  assert.ok(out.legs.every((l) => l.detail !== 'Manually settled'));
  assert.equal(getDraft(ctx, rd.drafts[0].id), null);
  const row = leaderboard(ctx, 'all').find((u) => u.userId === who.userId)!;
  assert.deepEqual([row.user, row.w, row.l, row.profit], ['Lelouch', 1, 0, 275]);

  // ticket + embed: status, hit count and net agree
  const v = slipView(s, out.legs, ctx);
  assert.deepEqual([v.ticket!.statusLine, v.ticket!.hits, v.ticket!.legCount, v.ticket!.net, v.ticket!.pays, v.ticket!.playBadge], ['SETTLED · CASHED', 3, 3, 275, 330, 'POWER PLAY']);
  assert.equal((v as any).sourceUrl, undefined); // original screenshot link is not in the public view
  assert.ok(!JSON.stringify(v).includes(who.sourceUrl));
  const e = ticketEmbed(v, 'https://x.test', 'America/Chicago');
  assert.equal(e.title, `$55.00 → $330.00   ·   #${s.id}`);
  assert.match(e.description!, /\*\*PRIZEPICKS\*\*  `POWER PLAY`/);
  assert.match(e.description!, /NBA \/ LOL · 3 legs · \*\*3\/3 HIT\*\*/);
  assert.match(e.description!, /\*\*SETTLED · CASHED\*\* · net \+\$275\.00/);
  assert.match(e.description!, /Giannis Antetokounmpo under 25\.5 Points — \*\*24\*\*/);
  assert.match(e.footer!.text, /^logged by Lelouch · .+ CT$/);
  assert.equal(e.url, `https://x.test/slip/${s.id}`);

  // same image again: caught by image hash before any model call
  const before = x.calls.length;
  assert.deepEqual(await readPhoto(ctx, x.v, { ...who, image: IMG }), { kind: 'duplicate', slipId: s.id });
  assert.equal(x.calls.length, before);
  // re-cropped screenshot of the same slip: caught on confirm by content
  const rd2 = await readPhoto(ctx, x.v, { ...who, image: new Uint8Array([9, 9]) });
  assert.ok(rd2.kind === 'drafts');
  if (rd2.kind === 'drafts') assert.deepEqual(await confirmDraft(ctx, r, rd2.drafts[0].id, NOW), { kind: 'duplicate', slipId: s.id });
  // ❌ delete frees it to be posted again
  deleteSlip(db, s.id, who.userId, true);
  const rd3 = await readPhoto(ctx, x.v, { ...who, image: IMG });
  assert.ok(rd3.kind === 'drafts');
  ctx.engine.stop();
});

test('edit fills blanks; bad input is rejected with a readable message', async () => {
  const { ctx, espn } = makeCtx(routes);
  const rd = await readPhoto(ctx, mockXai([read(slip({ stake: null, status: 'unknown', legs: [L({ player: 'Bam Adebayo', team: 'MIA', direction: 'over', stat: 'Points' })], pick_count: 1 }))]).v, { ...who, image: IMG });
  assert.ok(rd.kind === 'drafts');
  if (rd.kind !== 'drafts') return;
  const id = rd.drafts[0].id;
  assert.equal(draftCard(rd.drafts[0]).canConfirm, false);
  assert.equal((await confirmDraft(ctx, new Resolver(espn), id, NOW)).kind, 'blocked');
  const def = editDefaults(rd.drafts[0]);
  assert.equal(def.stakePayout, '? / 330');
  assert.equal(def.legs, '[NBA] Bam Adebayo (MIA) o? Points');
  assert.throws(() => editDraft(ctx, id, { stakePayout: 'abc / 1' }), /Stake \/ payout/);
  assert.throws(() => editDraft(ctx, id, { result: 'maybe' }), /Result must be/);
  assert.throws(() => editDraft(ctx, id, { legs: 'nonsense' }), /Line 1/);
  const d = editDraft(ctx, id, { stakePayout: '$20 / 60', result: 'loss', legs: '[NBA] Bam Adebayo (MIA) o30.5 Points = miss 24' });
  assert.equal(draftCard(d).canConfirm, true);
  assert.equal(d.x.legs[0].matchup, 'MIA 129 vs ATL 117'); // carried over from the read
  const out = await confirmDraft(ctx, new Resolver(espn), id, NOW);
  assert.ok(out.kind === 'added' && out.slip.status === 'lost' && out.slip.profit === -20 && out.legs[0].status === 'lost');
  ctx.engine.stop();
});

test('consistency: a "win" that ESPN says missed is parked for review, never shown as WIN with a miss', async () => {
  const { ctx, espn } = makeCtx(routes);
  const bad = slip({ pick_count: 1, payout: 110, legs: [L({ player: 'Bam Adebayo', team: 'MIA', line: 30.5, direction: 'over', stat: 'Points', leg_result: 'won' })] });
  const rd = await readPhoto(ctx, mockXai([read(bad)]).v, { ...who, image: IMG });
  assert.ok(rd.kind === 'drafts');
  if (rd.kind !== 'drafts') return;
  const out = await confirmDraft(ctx, new Resolver(espn), rd.drafts[0].id, NOW);
  assert.ok(out.kind === 'added');
  if (out.kind !== 'added') return;
  assert.equal(out.legs[0].status, 'lost'); // ESPN: 24 < 30.5
  assert.deepEqual([out.slip.status, out.slip.profit], ['review', null]);
  assert.match(out.problems.join(), /missed on a non-flex play/);
  assert.equal(ticket(out.slip, out.legs).statusLine, 'NEEDS REVIEW');
  assert.equal(leaderboard(ctx, 'all').find((u) => u.userId === who.userId)?.w ?? 0, 0);
  ctx.engine.stop();
});

test('staff-channel test slips are marked and left out of standings; cancel drops a card', async () => {
  const { ctx, espn } = makeCtx(routes);
  const rd = await readPhoto(ctx, mockXai([read(slip())]).v, { ...who, image: IMG, isTest: true });
  assert.ok(rd.kind === 'drafts');
  if (rd.kind !== 'drafts') return;
  assert.match(draftCard(rd.drafts[0]).text, /test slip and stays out of the standings/);
  const out = await confirmDraft(ctx, new Resolver(espn), rd.drafts[0].id, NOW);
  assert.ok(out.kind === 'added' && out.slip.is_test === 1 && out.slip.title!.startsWith('[TEST] '));
  assert.equal(leaderboard(ctx, 'all').find((u) => u.userId === who.userId), undefined);
  const rd2 = await readPhoto(ctx, mockXai([read(slip({ stake: 5 }))]).v, { ...who, image: new Uint8Array([3]) });
  assert.ok(rd2.kind === 'drafts');
  if (rd2.kind === 'drafts') { deleteDraft(ctx, rd2.drafts[0].id); assert.deepEqual(await confirmDraft(ctx, new Resolver(espn), rd2.drafts[0].id), { kind: 'gone' }); }
  ctx.engine.stop();
});

test('open slip: legs land on the upcoming game and stay pending for live grading', async () => {
  const pre = structuredClone(fx('nba_scoreboard_final'));
  const ev = pre.events[0];
  ev.id = 'PRE1'; ev.competitions[0].id = 'PRE1';
  for (const st of [ev.status, ev.competitions[0].status].filter(Boolean)) st.type = { ...st.type, state: 'pre', completed: false, name: 'STATUS_SCHEDULED', detail: 'Tonight', shortDetail: 'Tonight' };
  for (const c of ev.competitions[0].competitors) c.score = '0';
  const { ctx, espn } = makeCtx({ ...routes, 'nba/scoreboard': pre });
  const open = slip({ status: 'open', pick_count: 1, legs: [L({ player: 'Giannis Antetokounmpo', team: 'MIA', matchup: 'MIA @ ATL', line: 25.5, direction: 'under', stat: 'Points', leg_result: 'pending' })] });
  const rd = await readPhoto(ctx, mockXai([read(open)]).v, { ...who, image: IMG });
  assert.ok(rd.kind === 'drafts');
  if (rd.kind !== 'drafts') return;
  const out = await confirmDraft(ctx, new Resolver(espn), rd.drafts[0].id);
  assert.equal(out.kind, 'added', JSON.stringify(out));
  if (out.kind === 'added') {
    assert.deepEqual([out.slip.status, out.legs[0].status, out.legs[0].event_id, out.slip.odds], ['open', 'pending', 'PRE1', 500]);
    assert.equal(ticket(out.slip, out.legs).statusLine, 'OPEN');
  }
  ctx.engine.stop();
});

test('bot intents: message intents only when screenshot reading is on', () => {
  assert.deepEqual(botIntents(false), [GatewayIntentBits.Guilds]);
  assert.deepEqual(botIntents(true), [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]);
});

test('xAI: falls back to json_object mode if the strict schema is rejected', async () => {
  const bodies: any[] = [];
  const f = (async (_u: string, init: any) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if (b.response_format.type === 'json_schema') return new Response('{"error":"response_format json_schema not supported"}', { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(read(slip())) + '\n```' } }] }));
  }) as unknown as typeof fetch;
  const r = await extractSlips(IMG, 'image/jpeg', { apiKey: 'k', fetch: f });
  assert.equal((r.read as any).slips[0].stake, 55);
  assert.deepEqual(bodies.map((b) => b.response_format.type), ['json_schema', 'json_object']);
});
