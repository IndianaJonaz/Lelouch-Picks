import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injuryBadge, parseInjuryFeed, InjuryReport } from '../src/injuries.ts';

const feed = {
  injuries: [
    {
      displayName: 'Miami Heat',
      injuries: [
        { status: 'Out', date: '2026-10-28T12:00:00Z', shortComment: 'Ankle', athlete: { displayName: 'Bam Adebayo', team: { abbreviation: 'MIA' } } },
        { status: 'Questionable', shortComment: 'Knee', athlete: { displayName: 'Tyler Herro', team: { abbreviation: 'MIA' } } },
        { status: 'Day-To-Day', athlete: { displayName: 'Kyle Anderson', team: { abbreviation: 'MIA' } } },
        { status: '', athlete: { displayName: 'Nikola Jovic', team: { abbreviation: 'MIA' } } },
        { status: 'Out', athlete: { displayName: '', team: { abbreviation: 'MIA' } } }, // no name → omitted
        { athlete: { team: { abbreviation: 'MIA' } } },
      ],
    },
    {
      displayName: 'Atlanta Hawks',
      injuries: [
        { status: 'Injured Reserve', longComment: 'Shoulder', athlete: { displayName: 'Jalen Johnson', team: { abbreviation: 'ATL' } } },
        { status: 'Doubtful', athlete: { displayName: 'Trae Young', team: { abbreviation: 'ATL' } } },
      ],
    },
  ],
};

test('official designations map to Active or Out; the original text is kept', () => {
  for (const s of ['Out', 'OUT', 'Out for Season', 'Injured Reserve', 'IR', 'Suspended', 'Suspension', 'PUP', 'Physically Unable to Perform', 'NFI', 'Non-Football Injury', 'Injured List', '10-Day IL', '15-Day IL', '60-Day IL', 'IL', 'Season-Ending']) {
    assert.equal(injuryBadge(s), 'Out', s);
  }
  for (const s of ['Questionable', 'Probable', 'Day-To-Day', 'Day-to-Day', 'Doubtful', 'Active', '', null, undefined]) {
    assert.equal(injuryBadge(s as string), 'Active', String(s));
  }
});

test('parse keeps designation and note, skips players with no name, and does not invent a designation', () => {
  const rows = parseInjuryFeed('nba', feed);
  const names = rows.map((r) => r.player);
  assert.deepEqual(names, ['Bam Adebayo', 'Tyler Herro', 'Kyle Anderson', 'Nikola Jovic', 'Jalen Johnson', 'Trae Young']);
  const bam = rows[0];
  assert.equal(bam.badge, 'Out');
  assert.equal(bam.designation, 'Out');
  assert.equal(bam.note, 'Ankle');
  assert.equal(bam.team, 'MIA');
  assert.equal(rows.find((r) => r.player === 'Tyler Herro')!.badge, 'Active');
  assert.equal(rows.find((r) => r.player === 'Trae Young')!.badge, 'Active');
  assert.equal(rows.find((r) => r.player === 'Trae Young')!.designation, 'Doubtful');
  const jovic = rows.find((r) => r.player === 'Nikola Jovic')!;
  assert.equal(jovic.badge, 'Active');
  assert.equal(jovic.designation, null);
  assert.equal(rows.find((r) => r.player === 'Jalen Johnson')!.badge, 'Out');
  assert.equal(rows.find((r) => r.player === 'Jalen Johnson')!.note, 'Shoulder');
});

test('injury report caches a good answer and does not call the feed again until the ttl', async () => {
  let calls = 0;
  let now = 1_000_000;
  const report = new InjuryReport({
    leagues: ['nba'],
    ttlMs: 60_000,
    now: () => now,
    fetchLeague: async () => { calls++; return feed; },
  });
  const a = await report.get();
  const b = await report.get();
  assert.equal(calls, 1);
  assert.equal(a.unavailable, false);
  assert.equal(b.players.length, a.players.length);
  assert.equal(a.source, 'ESPN public injuries');
  assert.equal(a.players[0].badge, 'Out');
  now += 60_001;
  await report.get();
  assert.equal(calls, 2);
});

test('a failed feed is unavailable and contains no invented players', async () => {
  const report = new InjuryReport({
    leagues: ['nba', 'nfl'],
    ttlMs: 60_000,
    fetchLeague: async (lg) => {
      if (lg === 'nfl') throw new Error('HTTP 500');
      return feed;
    },
  });
  const mixed = await report.get();
  assert.equal(mixed.unavailable, false);
  assert.equal(mixed.leagues.find((l) => l.league === 'nfl')!.ok, false);
  assert.ok(mixed.players.every((p) => p.league === 'nba'));
  assert.equal(mixed.players.find((p) => p.player === 'Bam Adebayo')!.badge, 'Out');

  const dead = new InjuryReport({
    leagues: ['nba'],
    fetchLeague: async () => { throw new Error('HTTP 503'); },
  });
  const fail = await dead.get();
  assert.equal(fail.unavailable, true);
  assert.deepEqual(fail.players, []);
  assert.match(fail.error ?? '', /503|unavailable/i);
});
