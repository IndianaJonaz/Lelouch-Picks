import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFileSync, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import type { Auth } from './auth.ts';
import { ROOT } from './config.ts';
import { ParseError } from './parse.ts';
import type { Resolver } from './resolve.ts';
import { deleteSlip, isPublic, manualSettle, revealSlip, setPoster, SlipError, slipWithLegs } from './store.ts';
import { importSlip, isFinalStatus, type FinalStatus } from './importer.ts';
import { boardView, healthView, liveView, newsView, slipImageRef, slipView, type Ctx } from './views.ts';
import type { SlipImage } from './bot.ts';
import { dayInTz } from './util.ts';
import { Headlines } from './news.ts';
import { importInto, snapshotBytes, type Snapshotter } from './persist.ts';
import { openDb } from './db.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

interface Asset { body: Buffer; br: Buffer | null; gz: Buffer | null; type: string; etag: string; immutable: boolean }

function loadAssets(dir: string): Map<string, Asset> {
  const out = new Map<string, Asset>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const body = readFileSync(p);
      const ext = path.extname(f);
      const type = MIME[ext] ?? 'application/octet-stream';
      const text = /text|json|svg|manifest/.test(type);
      out.set('/' + path.relative(dir, p).split(path.sep).join('/'), {
        body, type, etag: '"' + createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"',
        br: text ? brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }) : null,
        gz: text ? gzipSync(body, { level: 9 }) : null,
        immutable: /icons\//.test(p),
      });
    }
  };
  walk(dir);
  return out;
}

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data: https://a.espncdn.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function rawBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new SlipError(`upload too large (max ${limit / 1024 / 1024} MB)`); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}

async function body(req: http.IncomingMessage, limit = 64 * 1024): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('body too large'); chunks.push(c as Buffer); }
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  if ((req.headers['content-type'] ?? '').includes('application/json')) return JSON.parse(s);
  return Object.fromEntries(new URLSearchParams(s));
}

export interface ServerDeps { ctx: Ctx; auth: Auth; resolver: Resolver; adminToken: string; publicUrl: string; groupName: string; onSlipCreated?: () => void; headlines?: Headlines; snapshots?: Snapshotter | null;
  /** Re-fetch a slip screenshot from its saved Discord message (Bot.slipImage). Absent = bot off, no images. */
  slipImage?: (channelId: string, messageId: string) => Promise<SlipImage | null>;
  /** HTTP client for the Discord CDN (tests inject a fake). */
  imageFetch?: typeof fetch }

export function createServer(deps: ServerDeps) {
  const { ctx, auth } = deps;
  const headlines = deps.headlines ?? new Headlines();
  const pub = path.join(ROOT, 'public');
  let assets = loadAssets(pub);
  // Hot-reload static files in dev; production images are immutable anyway.
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
    let t: NodeJS.Timeout | undefined;
    try { watch(pub, { recursive: true }, () => { clearTimeout(t); t = setTimeout(() => { assets = loadAssets(pub); }, 100); }).unref(); } catch { /* fs.watch unsupported */ }
  }
  const secure = deps.publicUrl.startsWith('https://');
  const sse = new Set<http.ServerResponse>();
  const COOKIE = 'phq_session';

  const send = (req: http.IncomingMessage, res: http.ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}) => {
    let buf: Buffer = Buffer.from(JSON.stringify(data));
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...extra };
    const ae = String(req.headers['accept-encoding'] ?? '');
    if (buf.length > 1024 && ae.includes('br')) { buf = brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 4 } }); headers['content-encoding'] = 'br'; }
    else if (buf.length > 1024 && ae.includes('gzip')) { buf = gzipSync(buf, { level: 6 }); headers['content-encoding'] = 'gzip'; }
    headers['vary'] = 'accept-encoding';
    res.writeHead(status, headers).end(buf);
  };

  const serveAsset = (req: http.IncomingMessage, res: http.ServerResponse, p: string) => {
    const a = assets.get(p);
    if (!a) return false;
    const h: Record<string, string> = { 'content-type': a.type, etag: a.etag, vary: 'accept-encoding', ...SEC_HEADERS,
      'cache-control': a.immutable ? 'public, max-age=604800' : p === '/sw.js' ? 'no-cache' : 'public, max-age=0, must-revalidate' };
    if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, h).end(); return true; }
    const ae = String(req.headers['accept-encoding'] ?? '');
    let b = a.body;
    if (a.br && ae.includes('br')) { b = a.br; h['content-encoding'] = 'br'; }
    else if (a.gz && ae.includes('gzip')) { b = a.gz; h['content-encoding'] = 'gzip'; }
    res.writeHead(200, h).end(req.method === 'HEAD' ? undefined : b);
    return true;
  };

  const authed = (req: http.IncomingMessage) => auth.validSession(cookies(req)[COOKIE]);
  const isAdmin = (req: http.IncomingMessage) => !!deps.adminToken && req.headers.authorization === `Bearer ${deps.adminToken}`;
  const ip = (req: http.IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';

  ctx.engine.on('tick', (t: { changed: string[] }) => broadcast('tick', { at: Date.now(), changed: t.changed.length }));
  function broadcast(event: string, data: unknown) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of sse) r.write(msg);
  }
  setInterval(() => { for (const r of sse) r.write(`: ping ${Date.now()}\n\n`); }, 25_000).unref();

  const MAX_SLIP_IMAGE = 20 * 1024 * 1024;
  /** Stream a slip's screenshot straight from Discord. Nothing is written to disk or the DB; the CDN url is never logged. */
  const slipImage = async (req: http.IncomingMessage, res: http.ServerResponse, id: string) => {
    const slip = slipWithLegs(ctx.db, id)?.slip;
    if (!slip) return send(req, res, 404, { error: 'no such slip' });
    const ref = isPublic(slip) ? slipImageRef(slip) : null;
    if (!ref) return send(req, res, 404, { error: 'This slip has no screenshot (it was entered with /pick).' });
    const gone = () => send(req, res, 404, { error: 'Image no longer available on Discord.' });
    const img = deps.slipImage ? await deps.slipImage(ref.channelId, ref.messageId).catch(() => null) : null;
    if (!img) return gone();
    let r: Response;
    try { r = await (deps.imageFetch ?? fetch)(img.url, { signal: AbortSignal.timeout(15_000) }); }
    catch (e) { console.warn(`[image] slip ${slip.id}: CDN fetch failed (${(e as Error).name})`); return gone(); }
    const type = (r.headers.get('content-type') ?? img.contentType).split(';')[0].trim().toLowerCase();
    const len = Number(r.headers.get('content-length') ?? 0);
    if (!r.ok || !r.body || !type.startsWith('image/') || type.includes('svg') || len > MAX_SLIP_IMAGE) {
      console.warn(`[image] slip ${slip.id}: CDN responded ${r.status}`);
      await r.body?.cancel().catch(() => {});
      return gone();
    }
    res.writeHead(200, { ...SEC_HEADERS, 'content-type': type, 'cache-control': 'private, max-age=300', ...(len && !r.headers.get('content-encoding') ? { 'content-length': String(len) } : {}) });
    if (req.method === 'HEAD') { await r.body.cancel().catch(() => {}); res.end(); return; }
    let sent = 0;
    const cap = new Transform({ transform(chunk: Buffer, _enc, cb) { sent += chunk.length; cb(sent > MAX_SLIP_IMAGE ? new Error('image too large') : null, chunk); } });
    await pipeline(Readable.fromWeb(r.body as any), cap, res).catch(() => { res.destroy(); });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    try {
      if (p === '/healthz') return send(req, res, 200, { ok: true, at: new Date().toISOString() });
      if (!p.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveAsset(req, res, p === '/' ? '/index.html' : p)) return;
        // SPA routes
        if (req.method === 'GET' && (['/live', '/board', '/news', '/login', '/dashboard'].includes(p) || /^\/slip\/[A-Za-z0-9]+$/.test(p))) { serveAsset(req, res, '/index.html'); return; }
        return send(req, res, 404, { error: 'not found' });
      }

      // ---- public API ----
      if (p === '/api/me') return send(req, res, 200, { authed: authed(req), demo: ctx.demo, group: deps.groupName, tz: ctx.tz });
      if (p === '/api/login' && req.method === 'POST') {
        if (!auth.allowAttempt(ip(req))) return send(req, res, 429, { error: 'Too many attempts. Wait 10 minutes.' });
        const b = await body(req);
        if (!auth.checkKey(String(b.key ?? ''))) { auth.recordFailure(ip(req)); return send(req, res, 401, { error: 'That key isn’t valid. Keys rotate daily — run /dashboard in Discord for today’s.' }); }
        const remember = b.remember === true || b.remember === 'true' || b.remember === 'on';
        const s = auth.createSession(remember, String(req.headers['user-agent'] ?? ''));
        const cookie = `${COOKIE}=${s.token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${s.maxAge ? `; Max-Age=${s.maxAge}` : ''}`;
        return send(req, res, 200, { ok: true, persistent: remember }, { 'set-cookie': cookie });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        auth.destroySession(cookies(req)[COOKIE]);
        return send(req, res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      }

      // ---- admin API (Bearer ADMIN_TOKEN) ----
      if (p.startsWith('/api/admin/')) {
        if (!isAdmin(req)) return send(req, res, 401, { error: 'admin token required' });
        if (p === '/api/admin/key' && req.method === 'GET') return send(req, res, 200, { key: auth.keyFor(), day: auth.today(), url: deps.publicUrl });
        if (p === '/api/admin/rotate-key' && req.method === 'POST') { const b = await body(req); if (b.revokeSessions) auth.revokeAll(); return send(req, res, 200, { key: auth.rotate() }); }
        if (p === '/api/admin/slips' && req.method === 'POST') {
          const b = await body(req);
          const texts: string[] = (Array.isArray(b.legs) ? b.legs : String(b.text ?? '').split(/\r?\n|;|\|/)).map((s: unknown) => String(s).trim()).filter(Boolean);
          if (b.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) throw new SlipError('date must be YYYY-MM-DD.');
          const result = b.result == null ? null : { status: String(b.result.status), profit: Number(b.result.profit) };
          if (result && (!isFinalStatus(result.status) || !Number.isFinite(result.profit))) throw new SlipError('result needs status won|lost|push|void and a numeric profit.');
          // `date` imports a slip on that day's games (finished ones included); `result` settles it after the legs are graded.
          const r = await importSlip(ctx, deps.resolver, texts.map((text) => ({ text })), {
            userId: String(b.userId ?? b.user ?? 'api'), userName: String(b.user ?? 'api'), title: b.title ?? null, stake: Number(b.stake ?? 1),
            odds: b.odds == null || b.odds === '' ? null : Number(b.odds), hidden: !!b.hidden, note: b.note ?? null, source: 'api',
            date: b.date ? String(b.date) : null, result: result as { status: FinalStatus; profit: number } | null,
          });
          deps.onSlipCreated?.();
          broadcast('tick', { at: Date.now(), changed: 1 });
          return send(req, res, 201, slipView(r.slip, r.legs, ctx));
        }
        const dm = p.match(/^\/api\/admin\/slips\/([A-Za-z0-9]+)$/);
        if (dm && req.method === 'GET') {
          const full = slipWithLegs(ctx.db, dm[1]);
          if (!full) return send(req, res, 404, { error: 'no such slip' });
          return send(req, res, 200, { ...slipView({ ...full.slip, hidden: 0 }, full.legs, ctx), sourceUrl: full.slip.source_url });
        }
        if (dm && req.method === 'DELETE') {
          deleteSlip(ctx.db, dm[1], 'admin', true);
          broadcast('tick', { at: Date.now(), changed: 1 });
          return send(req, res, 200, { ok: true, deleted: dm[1].toUpperCase() });
        }
        const m = p.match(/^\/api\/admin\/slips\/([A-Za-z0-9]+)\/(reveal|poster|settle)$/);
        if (m && req.method === 'POST') {
          const b = await body(req);
          if (m[2] === 'reveal') revealSlip(ctx.db, m[1], 'admin', true);
          if (m[2] === 'poster') setPoster(ctx.db, m[1], dayInTz(new Date(), ctx.tz));
          if (m[2] === 'settle') manualSettle(ctx.db, m[1], b.status, Number(b.profit));
          broadcast('tick', { at: Date.now(), changed: 1 });
          const full = slipWithLegs(ctx.db, m[1])!;
          return send(req, res, 200, slipView(full.slip, full.legs, ctx));
        }
        // Full raw SQLite snapshot (consistent copy) — backup / move between hosts.
        if (p === '/api/admin/export' && req.method === 'GET') {
          const data = snapshotBytes(ctx.db);
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length), 'cache-control': 'no-store',
            'content-disposition': `attachment; filename="picks-hq-${dayInTz(new Date(), ctx.tz)}.db"`, ...SEC_HEADERS }).end(data);
          return;
        }
        // Replace all data with an uploaded SQLite file (raw bytes body). Validated + all-or-nothing.
        if (p === '/api/admin/import' && req.method === 'POST') {
          const data = await rawBody(req, 50 * 1024 * 1024);
          let r: { tables: Record<string, number> };
          try { r = importInto(ctx.db, data, openDb); } catch (e) { throw new SlipError(`Import rejected: ${(e as Error).message}`); }
          const saved = deps.snapshots ? await deps.snapshots.saveNow() : null;
          broadcast('tick', { at: Date.now(), changed: 1 });
          return send(req, res, 200, { ok: true, bytes: data.length, tables: r.tables, snapshotSaved: saved });
        }
        return send(req, res, 404, { error: 'not found' });
      }

      // ---- signed-in API ----
      if (!authed(req)) return send(req, res, 401, { error: 'sign in required' });
      if (p === '/api/live') return send(req, res, 200, await liveView(ctx, url.searchParams.get('all') === '1'));
      if (p === '/api/board') return send(req, res, 200, boardView(ctx, url.searchParams.get('period') ?? 'all'));
      if (p === '/api/news') { const [n, headlines_] = await Promise.all([newsView(ctx), headlines.get()]); return send(req, res, 200, { ...n, headlines: headlines_ }); }
      if (p === '/api/health') return send(req, res, 200, healthView(ctx));
      const im = p.match(/^\/api\/slips\/([A-Za-z0-9]+)\/image$/);
      if (im && (req.method === 'GET' || req.method === 'HEAD')) return slipImage(req, res, im[1].toUpperCase());
      const sm = p.match(/^\/api\/slips\/([A-Za-z0-9]+)$/);
      if (sm) { const s = slipWithLegs(ctx.db, sm[1].toUpperCase()); return s ? send(req, res, 200, slipView(s.slip, s.legs, ctx)) : send(req, res, 404, { error: 'no such slip' }); }
      if (p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
        sse.add(res);
        req.on('close', () => sse.delete(res));
        return;
      }
      return send(req, res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof ParseError || e instanceof SlipError) return send(req, res, 400, { error: e.message });
      console.error('[http]', p, e);
      return send(req, res, 500, { error: 'server error' });
    }
  });
  return { server, broadcast, sseCount: () => sse.size };
}
