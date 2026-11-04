// Edge Engine session, board fetch and in-memory cache.
// Login is POST /auth/login → { ok, token }. The board numbers are computed in the browser, so a refresh
// reads rendered cards (HTML if the server sent them, otherwise a short-lived headless Chromium).
// The password is only sent in the login body. It is never logged. Errors are scrubbed of tokens.
import { existsSync } from 'node:fs';
import { cardToProp, parseBoardHtml, type EdgeProp, type RawEdgeCard } from './edgerate.ts';

export const EDGE_ORIGIN = 'https://edge-engine.up.railway.app';

export interface EdgeSession { token: string; email: string }
export interface EdgeBoard { props: EdgeProp[]; fetchedAt: number }
export interface EdgeSnapshot { board: EdgeBoard | null; stale: boolean; error: string | null }

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export function safeEdgeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/ee_sess=[^;\s&]+/gi, 'ee_sess=REDACTED')
    .replace(/Bearer\s+\S+/gi, 'Bearer REDACTED')
    .replace(/X-EE-Token["']?\s*[:=]\s*\S+/gi, 'X-EE-Token REDACTED')
    .slice(0, 300);
}

export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.EDGE_CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter((p): p is string => !!p);
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export async function edgeLogin(email: string, password: string, fetchImpl: FetchLike = fetch, origin = EDGE_ORIGIN): Promise<EdgeSession> {
  const url = `${origin.replace(/\/$/, '')}/auth/login`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error('Edge login failed: could not reach Edge Engine');
  }
  type LoginBody = { ok?: boolean; token?: unknown; email?: unknown; error?: unknown };
  let data: LoginBody | null = null;
  try { data = await res.json() as LoginBody; } catch { throw new Error(`Edge login failed (HTTP ${res.status})`); }
  if (!data?.ok || typeof data.token !== 'string' || !data.token) {
    const reason = typeof data?.error === 'string' && data.error ? data.error : `HTTP ${res.status}`;
    throw new Error(`Edge login failed: ${reason}`);
  }
  return { token: data.token, email: typeof data.email === 'string' && data.email ? data.email : email };
}

function authHeaders(token: string): Record<string, string> {
  return {
    accept: 'text/html',
    'x-ee-token': token,
    authorization: `Bearer ${token}`,
    cookie: `ee_sess=${encodeURIComponent(token)}`,
  };
}

export async function fetchEdgeBoard(session: EdgeSession, opts?: {
  origin?: string;
  fetch?: FetchLike;
  scrape?: (session: EdgeSession) => Promise<EdgeProp[]>;
}): Promise<EdgeProp[]> {
  const origin = (opts?.origin ?? EDGE_ORIGIN).replace(/\/$/, '');
  const fetchImpl = opts?.fetch ?? fetch;
  try {
    const res = await fetchImpl(`${origin}/app`, { headers: authHeaders(session.token), redirect: 'manual' });
    if (res.ok) {
      const html = await res.text();
      const props = parseBoardHtml(html);
      if (props.length) return props;
    }
  } catch (e) {
    if (!opts?.scrape) throw new Error(safeEdgeError(e));
  }
  if (opts?.scrape) return opts.scrape(session);
  return scrapeEdgeBoard(session, { origin });
}

/** Read .brow cards inside the logged-in app. Playwright runs this in the page, not in Node. */
function extractCards(): RawEdgeCard[] {
  const doc = (globalThis as { document?: { querySelectorAll: (s: string) => Iterable<{ textContent?: string | null; className?: string; parentElement?: unknown; querySelector: (s: string) => { textContent?: string | null } | null }> } }).document;
  const text = (el: { textContent?: string | null } | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const leagueOf = (el: { className?: string; parentElement?: unknown }) => {
    let n: { className?: string; parentElement?: unknown } | null = el;
    while (n) {
      const m = String(n.className || '').match(/\bbp-(nba|wnba|nfl|nhl|mlb|cfb|cbb)\b/);
      if (m) return m[1]!;
      n = (n.parentElement as typeof n | null) ?? null;
    }
    return '';
  };
  return [...(doc?.querySelectorAll('.brow') ?? [])].map((el) => ({
    league: leagueOf(el),
    player: text(el.querySelector('.bn')),
    team: text(el.querySelector('.bteam')),
    market: text(el.querySelector('.bmkt')),
    grade: text(el.querySelector('.bgl')),
    pill: text(el.querySelector('.bpill')),
    statsText: text(el.querySelector('.bstats')),
    sub: text(el.querySelector('.bsub')),
  }));
}

function dedupeProps(props: EdgeProp[]): EdgeProp[] {
  const by = new Map<string, EdgeProp>();
  for (const p of props) {
    const key = `${p.player.toLowerCase()}|${p.team.toUpperCase()}|${p.stat ?? p.statLabel.toLowerCase()}|${p.line}`;
    const prev = by.get(key);
    if (!prev || (prev.games == null && p.games != null)) by.set(key, p);
  }
  return [...by.values()];
}

/**
 * Log in is already done. Open /app, click FETCH LIVE, and read the rendered board.
 * Chromium is launched for this call only and then closed. Peak RAM is the cost to watch on Render.
 */
export async function scrapeEdgeBoard(session: EdgeSession, opts?: { origin?: string; chromePath?: string | null }): Promise<EdgeProp[]> {
  const origin = (opts?.origin ?? EDGE_ORIGIN).replace(/\/$/, '');
  let chrome = opts?.chromePath === undefined ? findChrome() : opts.chromePath;
  const { chromium } = await import('playwright-core');
  if (!chrome) {
    try {
      const bundled = chromium.executablePath();
      if (bundled && existsSync(bundled)) chrome = bundled;
    } catch { /* no bundled browser */ }
  }
  if (!chrome) throw new Error('Chromium is not installed (set EDGE_CHROME_PATH). The Edge board is computed in the browser.');
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--renderer-process-limit=1'],
  });
  try {
    const host = new URL(origin).hostname;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      timezoneId: 'America/Chicago',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    await context.addCookies([{ name: 'ee_sess', value: session.token, domain: host, path: '/', secure: origin.startsWith('https'), sameSite: 'Lax' }]);
    await context.setExtraHTTPHeaders({ 'X-EE-Token': session.token, Authorization: `Bearer ${session.token}` });
    await context.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    await page.addInitScript((saved: { token: string; email: string }) => {
      try {
        localStorage.setItem('ee_token', saved.token);
        if (saved.email) localStorage.setItem('ee_email', saved.email);
      } catch { /* storage blocked */ }
    }, { token: session.token, email: session.email });
    await page.goto(`${origin}/app`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const fetchBtn = page.getByText(/fetch live/i).first();
    if (await fetchBtn.count().catch(() => 0)) await fetchBtn.click({ timeout: 15_000 }).catch(() => {});
    await page.waitForSelector('.brow', { timeout: 120_000 }).catch(() => {});
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { __eeN?: number; __eeT?: number; document: { querySelectorAll: (s: string) => { length: number } } };
      const n = w.document.querySelectorAll('.brow').length;
      if (n > 0 && n === w.__eeN && Date.now() - (w.__eeT ?? 0) > 2500) return true;
      if (n !== w.__eeN) { w.__eeN = n; w.__eeT = Date.now(); }
      return false;
    }, { timeout: 90_000 }).catch(() => {});
    const raw: RawEdgeCard[] = [];
    const pull = async () => { raw.push(...await page.evaluate(extractCards)); };
    await pull();
    for (const name of ['MLB', 'NFL', 'CFB', 'NBA', 'CBB', 'WNBA', 'NHL']) {
      const tab = page.getByText(name, { exact: true }).first();
      if (await tab.count().catch(() => 0)) {
        await tab.click({ timeout: 3_000 }).catch(() => {});
        await page.waitForTimeout(400);
        await pull();
      }
    }
    const more = page.getByText(/\+\s*\d+\s+lines/i);
    const nMore = Math.min(await more.count().catch(() => 0), 40);
    for (let i = 0; i < nMore; i++) await more.nth(i).click({ timeout: 2_000 }).catch(() => {});
    if (nMore) await pull();
    const props = dedupeProps(raw.map(cardToProp).filter((p): p is EdgeProp => !!p));
    await context.close();
    if (!props.length) throw new Error('Edge board rendered no prop cards');
    return props;
  } finally {
    await browser.close().catch(() => {});
  }
}

export class EdgeCache {
  private board: EdgeBoard | null = null;
  private lastError: string | null = null;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: {
    email: string;
    password: string;
    ttlMs: number;
    minIntervalMs?: number;
    now?: () => number;
    origin?: string;
    login?: (email: string, password: string) => Promise<EdgeSession>;
    load?: (session: EdgeSession) => Promise<EdgeProp[]>;
  };
  constructor(opts: EdgeCache['opts']) { this.opts = opts; }

  private now(): number { return this.opts.now?.() ?? Date.now(); }
  private minInterval(): number { return this.opts.minIntervalMs ?? 60_000; }

  /** Check once a minute; a real refresh only runs when the copy is older than the TTL. */
  start(): void {
    if (this.timer) return;
    const warm = setTimeout(() => { void this.get(); }, 60_000);
    warm.unref?.();
    this.timer = setInterval(() => { void this.get(); }, 60_000);
    this.timer.unref?.();
  }

  async get(): Promise<EdgeSnapshot> {
    const age = this.board ? this.now() - this.board.fetchedAt : Infinity;
    const stale = !this.board || age >= this.opts.ttlMs;
    if (stale && this.now() - this.lastAttempt >= this.minInterval()) await this.refresh();
    const age2 = this.board ? this.now() - this.board.fetchedAt : Infinity;
    return { board: this.board, stale: !this.board || age2 >= this.opts.ttlMs, error: this.lastError };
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastAttempt = this.now();
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    try {
      const login = this.opts.login ?? ((email, password) => edgeLogin(email, password, fetch, this.opts.origin));
      const session = await login(this.opts.email, this.opts.password);
      const load = this.opts.load ?? ((s) => fetchEdgeBoard(s, { origin: this.opts.origin }));
      const props = await load(session);
      if (!props.length) throw new Error('Edge board came back empty');
      this.board = { props, fetchedAt: this.now() };
      this.lastError = null;
      console.log(`[edge] board ${props.length} props`);
    } catch (e) {
      this.lastError = safeEdgeError(e);
      console.error(`[edge] refresh failed: ${this.lastError}`);
    }
  }
}
