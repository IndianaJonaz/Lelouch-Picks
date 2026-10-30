import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickModal } from '../src/bot.ts';

// Discord rejects modal titles and text-input labels over 45 chars, placeholders over 100.
// discord.js builders run the same validation (ExpectedConstraintError) when the modal is built.
test('/pick modal builds within Discord limits', () => {
  for (const hidden of [false, true]) {
    const json = pickModal({ stake: 25, odds: 450, hidden, title: 'TNF sweat', note: 'Why I like it' }).toJSON();
    assert.ok(json.title.length <= 45);
    const inputs = json.components.map((row: any) => row.components[0]);
    assert.equal(inputs.length, 5);
    for (const t of inputs) {
      assert.ok(t.label.length <= 45, t.label);
      assert.ok((t.placeholder ?? '').length <= 100, t.placeholder);
    }
    assert.equal(inputs.find((t: any) => t.custom_id === 'odds').label, 'Slip odds (American, optional)');
    assert.equal(inputs.find((t: any) => t.custom_id === 'stake').label, 'Stake ($)');
  }
});

test('/pick modal builds with no optional values', () => {
  assert.doesNotThrow(() => pickModal({ stake: 1, odds: null, hidden: false, title: null, note: null }).toJSON());
});
