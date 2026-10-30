import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanText, Headlines, parseRss, safeLink, type FeedDef } from '../src/news.ts';

const xml = (n: string) => readFileSync(new URL(`./fixtures/${n}.xml`, import.meta.url), 'utf8');

test('rss parser: CDATA, entities, markup stripped, only http(s) links, dates to ISO', () => {
  const items = parseRss(xml('rss_espn'), { id: 'espn', name: 'ESPN' });
  assert.deepEqual(items.map((i) => i.title), ['Josh Jacobs scores twice as Packers dispatch Panthers', 'alert(1) Evil & bold headline', 'No date item']);
  assert.equal(items[0].link, 'https://www.espn.com/nfl/story/_/id/50322670/packers-panthers');
  assert.equal(items[0].source, 'ESPN');
  assert.equal(items[0].published, '2026-10-30T08:09:53.000Z'); // EST = UTC-5
  assert.equal(items[1].link, 'https://www.espn.com/x?a=1&b=2');
  assert.ok(!items.some((i) => /[<>]/.test(i.title)));
  assert.equal(items[2].published, null);
});

test('rss parser: Google News <source> becomes the source name and is trimmed from the title', () => {
  const items = parseRss(xml('rss_gnews'), { id: 'g', name: 'Google News' });
  assert.equal(items.length, 1); // data: link dropped
  assert.equal(items[0].title, 'Public health leaders remind Californians to vaccinate – flu & RSV');
  assert.equal(items[0].source, 'Yahoo');
});

test('safeLink / cleanText', () => {
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink(' /relative '), null);
  assert.equal(safeLink('http://a.example/x'), 'http://a.example/x');
  assert.equal(cleanText('a'.repeat(400)).length, 300);
  assert.equal(cleanText('<![CDATA[ x &lt;img src=x onerror=1&gt; y ]]>'), 'x y');
});

const FEEDS: FeedDef[] = [
  { id: 'espn', name: 'ESPN', section: 'sports', url: 'https://fake/espn' },
  { id: 'dead', name: 'Dead Feed', section: 'sports', url: 'https://fake/dead' },
  { id: 'g', name: 'Google News · Health', section: 'health', url: 'https://fake/g' },
];

test('headlines: merged per section, newest first, dead feed fails soft, cached ~10 min', async () => {
  let calls = 0, now = 1_000_000, espnUp = true;
  const h = new Headlines({ feeds: FEEDS, now: () => now, fetcher: async (url) => {
    calls++;
    if (url.endsWith('/dead')) throw new Error('HTTP 503');
    if (url.endsWith('/espn')) { if (!espnUp) throw new Error('HTTP 500'); return xml('rss_espn'); }
    return xml('rss_gnews');
  } });
  const a = await h.get();
  assert.equal(a.sections.sports.length, 3);
  assert.equal(a.sections.sports[0].title, 'Josh Jacobs scores twice as Packers dispatch Panthers');
  assert.equal(a.sections.sports.at(-1)!.published, null); // undated last
  assert.equal(a.sections.health[0].source, 'Yahoo');
  const dead = a.feeds.find((f) => f.id === 'dead')!;
  assert.equal(dead.ok, false); assert.equal(dead.error, 'HTTP 503');
  assert.equal(calls, 3);
  await h.get(); assert.equal(calls, 3); // cached
  now += 10 * 60_000 + 1; espnUp = false;
  const b = await h.get(); assert.equal(calls, 6);
  assert.equal(b.sections.sports.length, 3); // last good ESPN copy kept when it goes down
  assert.equal(b.feeds.find((f) => f.id === 'espn')!.ok, false);
});

test('headlines: a hung feed times out instead of hanging the page', async () => {
  const h = new Headlines({ feeds: FEEDS.slice(0, 1), timeoutMs: 50, fetcher: (_u, signal) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  const r = await h.get();
  assert.equal(r.feeds[0].error, 'timeout');
  assert.deepEqual(r.sections.sports, []);
});
