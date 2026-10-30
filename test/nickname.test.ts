import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { applyGuildNicknames, type GuildNickTarget } from '../src/bot.ts';

const member = (opts: { ok?: boolean; nick?: string | null; fail?: boolean; set?: string[] }) => ({
  nickname: opts.nick ?? null,
  permissions: { has: (bit: bigint) => !!opts.ok && bit === PermissionFlagsBits.ChangeNickname },
  setNickname: async (n: string) => {
    if (opts.fail) throw new Error('Missing Permissions');
    opts.set?.push(n);
  },
});

test('applyGuildNicknames sets each guild nickname and never throws', async () => {
  const set: string[] = [];
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  const guilds: GuildNickTarget[] = [
    { id: 'g1', name: 'One', members: { me: member({ ok: true, set }), fetchMe: async () => { throw new Error('unused'); } } },
    { id: 'g2', name: 'Two', members: { me: member({ ok: false, set }), fetchMe: async () => { throw new Error('unused'); } } },
    { id: 'g3', name: 'Three', members: { me: null, fetchMe: async () => member({ ok: true, fail: true, set }) } },
    { id: 'g4', name: 'Four', members: { me: member({ ok: true, nick: 'Lelouch HQ', set }), fetchMe: async () => { throw new Error('unused'); } } },
  ];
  try {
    await applyGuildNicknames(guilds, 'Lelouch HQ');
    await applyGuildNicknames([
      { id: 'g5', name: 'Five', members: { me: member({ ok: true, set }), fetchMe: async () => { throw new Error('unused'); } } },
    ], '   ');
  } finally {
    console.warn = orig;
  }
  assert.deepEqual(set, ['Lelouch HQ', 'Lelouch HQ']);
  assert.equal(warns.length, 2);
  assert.match(warns[0]!, /Two/);
  assert.match(warns[0]!, /Change Nickname/);
  assert.match(warns[1]!, /g3/);
});
