import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Auth } from '../src/auth.ts';
import { Resolver } from '../src/resolve.ts';
import { createServer } from '../src/server.ts';
import { createSlip } from '../src/store.ts';
import type { ResolvedLeg } from '../src/resolve.ts';
import { fetchSlipImage, type MessageFetchClient } from '../src/bot.ts';
import { boardView, slipImageRef, slipView } from '../src/views.ts';
import { makeCtx } from './helpers.ts';

const L: ResolvedLeg = { league: 'nba', event_id: null, event_name: null, start_time: null, type: 'prop', team: 'ATL', player: 'Trae Young', athlete_id: null,
  stat: 'pts', side: 'over', line: 20.5, odds: null, raw: 'Trae Young o20.5 pts' };
const { ctx, db, espn } = makeCtx();
const base = { user_id: 'u1', user_name: 'Lelouch', stake: 5, oddsOptional: true };
const settle = (id: string) => db.prepare("UPDATE slips SET status='won', profit=10, settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(id);
const photo = createSlip(db, { ...base, source: 'photo', guild_id: '1', channel_id: '111111111111111111', message_id: '222222222222222222', source_url: 'https://discord.com/channels/1/111111111111111111/222222222222222222', book: 'PrizePicks' }, [L]);
const pick = createSlip(db, { ...base, source: 'discord', guild_id: '1', channel_id: '111111111111111111' }, [L]);
const linkOnly = createSlip(db, { ...base, source: 'photo', source_url: 'https://discord.com/channels/1/333333333333333333/444444444444444444' }, [L]);
const hidden = createSlip(db, { ...base, source: 'photo', hidden: true, channel_id: '111111111111111111', message_id: '555555555555555555' }, [L]);
const gone = createSlip(db, { ...base, source: 'photo', channel_id: '111111111111111111', message_id: '999999999999999999' }, [L]);
for (const s of [photo, pick, linkOnly, hidden, gone]) settle(s.id);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CDN = 'https://cdn.discordapp.com/attachments/111/222/slip.png?ex=abc&hm=SECRET';
const calls: string[] = [];
const auth = new Auth(db, 'test-secret', 'America/Chicago');
const { server } = createServer({ ctx, auth, resolver: new Resolver(espn), adminToken: 'admintok', publicUrl: 'http://localhost', groupName: 'Lelouch HQ',
  slipImage: async (c, m) => { calls.push(`${c}/${m}`); return m === '999999999999999999' ? null : { url: CDN, contentType: 'image/png' }; },
  imageFetch: (async (u: string) => { assert.equal(u, CDN); return new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } }); }) as typeof fetch });
await new Promise<void>((r) => server.listen(0, r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); ctx.engine.stop(); });
const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: auth.keyFor() }) });
const cookie = login.headers.get('set-cookie')!.split(';')[0];

test('hasImage: only public slips with a saved Discord message reference', () => {
  const by = Object.fromEntries(boardView(ctx, 'all').recent.map((s) => [s.id, s.hasImage]));
  assert.equal(by[photo.id], true);
  assert.equal(by[pick.id], false); // /pick: channel but no message id
  assert.equal(by[linkOnly.id], true); // older row: message link only
  assert.equal(by[hidden.id], false); // never leak a hidden slip's screenshot
  assert.deepEqual(slipImageRef(linkOnly), { channelId: '333333333333333333', messageId: '444444444444444444' });
  assert.equal(slipImageRef({ channel_id: null, message_id: null, source_url: 'https://evil.example/channels/1/2/3' }), null);
  assert.equal(slipView(pick, [], ctx).hasImage, false);
});

test('image endpoint: sign-in required, streams the image privately, 404s for /pick, hidden and deleted', async () => {
  assert.equal((await fetch(`${url}/api/slips/${photo.id}/image`)).status, 401);
  const r = await fetch(`${url}/api/slips/${photo.id.toLowerCase()}/image`, { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control')!, /^private, max-age=\d+$/);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), PNG);
  const p = await fetch(`${url}/api/slips/${pick.id}/image`, { headers: { cookie } });
  assert.equal(p.status, 404);
  assert.match((await p.json()).error, /\/pick/);
  assert.equal((await fetch(`${url}/api/slips/${hidden.id}/image`, { headers: { cookie } })).status, 404);
  const g = await fetch(`${url}/api/slips/${gone.id}/image`, { headers: { cookie } });
  assert.equal(g.status, 404);
  const gj = await g.json();
  assert.equal(gj.error, 'Image no longer available on Discord.');
  assert.doesNotMatch(JSON.stringify(gj), /SECRET|cdn\.discord/);
  assert.equal((await fetch(`${url}/api/slips/NOPE1/image`, { headers: { cookie } })).status, 404);
  assert.ok(!calls.includes(`111111111111111111/555555555555555555`)); // hidden slip never hits Discord
});

const mock = (o: { ready?: boolean; channel?: unknown; throwOn?: 'channel' | 'message'; atts?: any[] }): MessageFetchClient => ({
  isReady: () => o.ready ?? true,
  channels: { fetch: async () => {
    if (o.throwOn === 'channel') throw new Error('Unknown Channel');
    return o.channel ?? { messages: { fetch: async () => { if (o.throwOn === 'message') throw new Error('Unknown Message'); return { attachments: new Map((o.atts ?? []).map((a, i) => [String(i), a])) }; } } };
  } },
});

test('fetchSlipImage: first image attachment, or null when the bot/message/attachment is gone', async () => {
  const C = '111111111111111111', M = '222222222222222222';
  const img = { contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/a.png?x=1' };
  assert.deepEqual(await fetchSlipImage(mock({ atts: [{ contentType: 'text/plain', url: 'https://cdn.discordapp.com/x.txt' }, img] }), C, M), { url: img.url, contentType: 'image/png' });
  assert.equal(await fetchSlipImage(mock({ throwOn: 'message' }), C, M), null);
  assert.equal(await fetchSlipImage(mock({ throwOn: 'channel' }), C, M), null);
  assert.equal(await fetchSlipImage(mock({ atts: [] }), C, M), null);
  assert.equal(await fetchSlipImage(mock({ ready: false, atts: [img] }), C, M), null);
  assert.equal(await fetchSlipImage(null, C, M), null);
  assert.equal(await fetchSlipImage(mock({ channel: {} }), C, M), null); // not a text channel
  assert.equal(await fetchSlipImage(mock({ atts: [{ contentType: 'image/png', url: 'https://evil.example/a.png' }] }), C, M), null);
  assert.equal(await fetchSlipImage(mock({ atts: [img] }), 'abc', M), null);
});
