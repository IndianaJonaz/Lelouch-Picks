import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Auth } from '../src/auth.ts';
import { Resolver } from '../src/resolve.ts';
import { createServer } from '../src/server.ts';
import { fx, makeCtx } from './helpers.ts';
import { leaderboard } from '../src/views.ts';

const { ctx, espn, db } = makeCtx({ 'nba/injuries': { injuries: [] }, 'nba/summary?event=401909881': fx('nba_summary_final'), 'nba/scoreboard': fx('nba_scoreboard_final'), 'nfl/scoreboard': { events: [] }, 'nhl/scoreboard': new Error('HTTP 500') });
const auth = new Auth(db, 'test-secret', 'America/Chicago');
const { server } = createServer({ ctx, auth, resolver: new Resolver(espn), adminToken: 'admintok', publicUrl: 'http://localhost', groupName: 'PICKS HQ' });
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); ctx.engine.stop(); });

const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('auth: daily key is deterministic, rotation invalidates the old key', () => {
  const k = auth.keyFor('2026-10-29', 0);
  assert.match(k, /^PHQ-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(auth.keyFor('2026-10-29', 0), k);
  assert.notEqual(auth.keyFor('2026-10-30', 0), k);
  const a2 = new Auth(db, 'test-secret', 'America/Chicago');
  const today = a2.keyFor();
  assert.ok(a2.checkKey(today)); assert.ok(a2.checkKey(today.toLowerCase().replace(/-/g, ' ')));
  const next = a2.rotate();
  assert.notEqual(next, today); assert.ok(!a2.checkKey(today)); assert.ok(a2.checkKey(next));
});

test('static shell, manifest and security headers', async () => {
  const r = await fetch(base + '/', { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.match(await r.text(), /manifest\.webmanifest/);
  const m = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(m.display, 'standalone');
  assert.equal((await fetch(base + '/board')).status, 200);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('API requires sign-in; wrong key rejected; right key sets HttpOnly cookie; remember => Max-Age', async () => {
  assert.equal((await fetch(base + '/api/board')).status, 401);
  assert.equal((await post('/api/login', { key: 'PHQ-NOPE-NOPE' })).status, 401);
  const ok = await post('/api/login', { key: auth.keyFor(), remember: true });
  assert.equal(ok.status, 200);
  const c = ok.headers.get('set-cookie')!;
  assert.match(c, /HttpOnly/); assert.match(c, /Max-Age=2592000/);
  const sess = await post('/api/login', { key: auth.keyFor(), remember: false });
  assert.doesNotMatch(sess.headers.get('set-cookie')!, /Max-Age/);
  const cookie = c.split(';')[0];
  for (const p of ['/api/board', '/api/live?all=1', '/api/news', '/api/health']) {
    const r = await fetch(base + p, { headers: { cookie } });
    assert.equal(r.status, 200, p);
  }
  const live = await (await fetch(base + '/api/live?all=1', { headers: { cookie } })).json();
  assert.deepEqual(live.slateErrors.map((e: any) => e.league), ['nhl']); // down feed surfaces as an error, not empty data
  await post('/api/logout', {}, { cookie });
  assert.equal((await fetch(base + '/api/board', { headers: { cookie } })).status, 401);
});

test('admin API: bearer token required; pick entry errors are readable', async () => {
  assert.equal((await post('/api/admin/slips', { text: 'ATL ML', odds: -110 })).status, 401);
  const bad = await post('/api/admin/slips', { text: 'MIA ML' , odds: -110 }, { authorization: 'Bearer admintok' });
  assert.equal(bad.status, 400); // the only fixture game is final -> no upcoming game
  assert.match((await bad.json()).error, /No upcoming/);
});

test('admin API: import a finished slip by date with a manual result', async () => {
  const h = { authorization: 'Bearer admintok' };
  assert.equal((await post('/api/admin/slips', { text: 'MIA ML', odds: -110, date: '10/28/2026' }, h)).status, 400);
  assert.equal((await post('/api/admin/slips', { text: 'MIA ML', odds: -110, date: '2026-10-28', result: { status: 'cashed', profit: 1 } }, h)).status, 400);
  const r = await post('/api/admin/slips', { user: 'Imp', text: 'MIA ML', stake: 55, odds: 500, date: '2026-10-28', result: { status: 'won', profit: 275 } }, h);
  assert.equal(r.status, 201);
  const s = await r.json();
  assert.equal(s.status, 'won'); assert.equal(s.profit, 275);
  assert.equal(s.legs[0].status, 'won'); // graded from the box score before the manual result, not "void — Manually settled"
  assert.equal(s.legs[0].actual, 12);
  const row = leaderboard(ctx, 'all').find((u) => u.user === 'Imp')!;
  assert.equal(row.w, 1); assert.equal(row.l, 0); assert.equal(row.profit, 275);
  // userId puts an imported slip on the member's Discord row; admins can delete
  const r2 = await (await post('/api/admin/slips', { user: 'Lelouch', userId: '123456789012345678', text: 'MIA ML', stake: 1, odds: 100, date: '2026-10-28', result: { status: 'won', profit: 1 } }, h)).json();
  assert.equal(r2.userId, '123456789012345678');
  // slip page is an SPA route; the screenshot link is admin-only
  assert.equal((await fetch(base + '/slip/' + r2.id)).status, 200);
  ctx.db.prepare('UPDATE slips SET source_url = ? WHERE id = ?').run('https://discord.com/channels/1/2/3', r2.id);
  assert.equal((await (await fetch(base + '/api/admin/slips/' + r2.id, { headers: h })).json()).sourceUrl, 'https://discord.com/channels/1/2/3');
  assert.equal((await fetch(base + '/api/admin/slips/' + r2.id)).status, 401);
  const del = await fetch(base + '/api/admin/slips/' + r2.id, { method: 'DELETE', headers: h });
  assert.equal(del.status, 200);
  assert.equal((await fetch(base + '/api/admin/slips/' + r2.id, { method: 'DELETE', headers: h })).status, 400);
});

test('login is rate limited per IP', async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await post('/api/login', { key: 'x' }, { 'x-forwarded-for': '9.9.9.9' })).status;
  assert.equal(last, 429);
});

test('successful logins do not count toward the limit', async () => {
  for (let i = 0; i < 15; i++) assert.equal((await post('/api/login', { key: auth.keyFor() }, { 'x-forwarded-for': '7.7.7.7' })).status, 200);
});
