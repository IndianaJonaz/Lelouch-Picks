// Sports + health headlines from free, keyless public RSS feeds.
// Tiny dependency-free RSS parser, in-memory cache, per-feed timeouts, and fail-soft:
// a dead feed is reported in `feeds[]` but never breaks the response.

export type Section = 'sports' | 'health';
export interface Headline { title: string; link: string; source: string; published: string | null; feed: string }
export interface FeedDef { id: string; name: string; section: Section; url: string }
export interface FeedStatus { id: string; name: string; section: Section; url: string; ok: boolean; count: number; error: string | null; at: number | null }
export interface HeadlinesPayload { asOf: number; cachedUntil: number; sections: Record<Section, Headline[]>; feeds: FeedStatus[] }

export const FEEDS: FeedDef[] = [
  { id: 'espn', name: 'ESPN', section: 'sports', url: 'https://www.espn.com/espn/rss/news' },
  { id: 'gnews-sports', name: 'Google News · Sports', section: 'sports', url: 'https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-US&gl=US&ceid=US:en' },
  { id: 'npr-health', name: 'NPR Health', section: 'health', url: 'https://feeds.npr.org/1128/rss.xml' },
  { id: 'gnews-health', name: 'Google News · Health', section: 'health', url: 'https://news.google.com/rss/headlines/section/topic/HEALTH?hl=en-US&gl=US&ceid=US:en' },
];

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Plain text from an RSS field: unwraps CDATA, decodes entities, strips any markup, collapses whitespace. */
export function cleanText(raw: string, max = 300): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s.replace(/&amp;/g, '&')); // double-encoded feeds
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/** Only absolute http(s) URLs survive; everything else (javascript:, data:, relative) is dropped. */
export function safeLink(raw: string): string | null {
  const s = cleanText(raw, 2000);
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

const field = (block: string, tag: string) => block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] ?? null;

export function parseRss(xml: string, feed: Pick<FeedDef, 'id' | 'name'>, limit = 30): Headline[] {
  const out: Headline[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    if (out.length >= limit) break;
    const rawTitle = field(b, 'title');
    let link = field(b, 'link');
    if (link == null) link = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? null; // Atom
    if (!rawTitle || !link) continue;
    const href = safeLink(link);
    let title = cleanText(rawTitle);
    if (!href || !title) continue;
    // Aggregators (Google News) name the publisher in <source>; their titles end in " - Publisher".
    const src = field(b, 'source');
    const source = src ? cleanText(src, 80) : feed.name;
    if (src && source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const dateRaw = field(b, 'pubDate') ?? field(b, 'dc:date') ?? field(b, 'published') ?? field(b, 'updated');
    const t = dateRaw ? Date.parse(cleanText(dateRaw, 80)) : NaN;
    out.push({ title, link: href, source: source || feed.name, published: Number.isFinite(t) ? new Date(t).toISOString() : null, feed: feed.id });
  }
  return out;
}

export type Fetcher = (url: string, signal: AbortSignal) => Promise<string>;
const httpFetch: Fetcher = async (url, signal) => {
  const r = await fetch(url, { signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; Lelouch-HQ/1.0; +rss)', accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > 3_000_000) throw new Error('feed too large');
  return text;
};

export interface HeadlinesOpts { feeds?: FeedDef[]; fetcher?: Fetcher; ttlMs?: number; timeoutMs?: number; perSection?: number; now?: () => number }

export class Headlines {
  private feeds: FeedDef[]; private fetcher: Fetcher; private ttl: number; private timeout: number; private perSection: number; private now: () => number;
  private cache: HeadlinesPayload | null = null;
  private lastGood = new Map<string, Headline[]>();
  private inflight: Promise<HeadlinesPayload> | null = null;
  constructor(o: HeadlinesOpts = {}) {
    this.feeds = o.feeds ?? FEEDS; this.fetcher = o.fetcher ?? httpFetch; this.ttl = o.ttlMs ?? 10 * 60_000;
    this.timeout = o.timeoutMs ?? 8000; this.perSection = o.perSection ?? 20; this.now = o.now ?? Date.now;
  }

  async get(): Promise<HeadlinesPayload> {
    if (this.cache && this.now() < this.cache.cachedUntil) return this.cache;
    this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async refresh(): Promise<HeadlinesPayload> {
    const statuses = await Promise.all(this.feeds.map(async (f): Promise<[FeedStatus, Headline[]]> => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(new Error('timeout')), this.timeout);
      try {
        const items = parseRss(await this.fetcher(f.url, ac.signal), f);
        if (!items.length) throw new Error('no items');
        this.lastGood.set(f.id, items);
        return [{ id: f.id, name: f.name, section: f.section, url: f.url, ok: true, count: items.length, error: null, at: this.now() }, items];
      } catch (e) {
        const msg = ac.signal.aborted ? 'timeout' : String((e as Error)?.message ?? e).slice(0, 120);
        const stale = this.lastGood.get(f.id) ?? []; // keep showing the last good copy
        return [{ id: f.id, name: f.name, section: f.section, url: f.url, ok: false, count: stale.length, error: msg, at: null }, stale];
      } finally { clearTimeout(t); }
    }));
    const sections: Record<Section, Headline[]> = { sports: [], health: [] };
    for (const sec of ['sports', 'health'] as const) {
      const seen = new Set<string>();
      const all = statuses.filter(([s]) => s.section === sec).flatMap(([, items]) => items)
        .filter((h) => { const k = h.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => (b.published ? Date.parse(b.published) : 0) - (a.published ? Date.parse(a.published) : 0));
      sections[sec] = all.slice(0, this.perSection);
    }
    const now = this.now();
    // If everything failed, retry sooner than the full TTL.
    const anyOk = statuses.some(([s]) => s.ok);
    this.cache = { asOf: now, cachedUntil: now + (anyOk ? this.ttl : Math.min(this.ttl, 60_000)), sections, feeds: statuses.map(([s]) => s) };
    return this.cache;
  }
}
