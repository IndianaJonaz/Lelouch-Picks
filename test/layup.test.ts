import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layupChannelId } from '../src/layup.ts';

test('layup channel: env id wins, otherwise the channel whose name contains layup-feed', () => {
  const channels = [
    { id: '111', name: 'general' },
    { id: '222', name: '🏀︱layup-feed' },
    { id: '333', name: 'picks' },
  ];
  assert.equal(layupChannelId(channels, '999999999999999999'), '999999999999999999');
  assert.equal(layupChannelId(channels, ''), '222');
  assert.equal(layupChannelId(channels, '   '), '222');
  assert.equal(layupChannelId(channels, 'not-an-id'), '222');
  assert.equal(layupChannelId([{ id: '1', name: 'Layup-Feed' }], null), '1');
  assert.equal(layupChannelId([{ id: '1', name: 'general' }], null), null);
});
