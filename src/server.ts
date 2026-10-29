import http from 'node:http';
import { readFileSync, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import type { Auth } from './auth.ts';
import { ROOT } from './config.ts';
import { ParseError } from './parse.ts';
import type { Resolver } from './resolve.ts';
import { createSlip, manualSettle, revealSlip, setPoster, SlipError, slipWithLegs } from './store.ts';
import { boardView, healthView, liveView, newsView, slipView, type Ctx } from './views.ts';
import { dayInTz } from './util.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain',
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

async function body(req: http.IncomingMessage, limit = 64 * 1024): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('body too large'); chunks.push(c as Buffer); }
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  if ((req.headers['content-type'] ?? '').includes('application/json')) return JSON.parse(s);
  return Object.fromEntries(new URLSearchParams(s));
}

export interface ServerDeps { ctx: Ctx; auth: Auth; resolver: Resolver; adminToken: string; publicUrl: string; groupName: string; onSlipCreated?: () => void }

export function createServer(deps: ServerDeps) {
  const { ctx, auth } = deps;
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    try {
      if (p === '/healthz') return send(req, res, 200, { ok: true, at: new Date().toISOString() });
      if (!p.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveAsset(req, res, p === '/' ? '/index.html' : p)) return;
        // SPA routes
        if (req.method === 'GET' && ['/live', '/board', '/news', '/login', '/dashboard'].includes(p)) { serveAsset(req, res, '/index.html'); return; }
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
          const legs = [];
          const texts = Array.isArray(b.legs) ? b.legs : String(b.text ?? '').split(/\r?\n|;|\|/).map((s: string) => s.trim()).filter(Boolean);
          for (const t of texts) legs.push(await deps.resolver.resolve(String(t), { tz: ctx.tz, leagues: ctx.leagues }));
          const slip = createSlip(ctx.db, { user_id: String(b.userId ?? b.user ?? 'api'), user_name: String(b.user ?? 'api'), title: b.title ?? null, stake: Number(b.stake ?? 1), odds: b.odds == null || b.odds === '' ? null : Number(b.odds), hidden: !!b.hidden, note: b.note ?? null, source: 'api' }, legs);
          deps.onSlipCreated?.(); ctx.engine.poke();
          const full = slipWithLegs(ctx.db, slip.id)!;
          return send(req, res, 201, slipView(full.slip, full.legs, ctx));
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
        return send(req, res, 404, { error: 'not found' });
      }

      // ---- signed-in API ----
      if (!authed(req)) return send(req, res, 401, { error: 'sign in required' });
      if (p === '/api/live') return send(req, res, 200, await liveView(ctx, url.searchParams.get('all') === '1'));
      if (p === '/api/board') return send(req, res, 200, boardView(ctx, url.searchParams.get('period') ?? 'all'));
      if (p === '/api/news') return send(req, res, 200, await newsView(ctx));
      if (p === '/api/health') return send(req, res, 200, healthView(ctx));
      const sm = p.match(/^\/api\/slips\/([A-Za-z0-9]+)$/);
      if (sm) { const s = slipWithLegs(ctx.db, sm[1]); return s ? send(req, res, 200, slipView(s.slip, s.legs, ctx)) : send(req, res, 404, { error: 'no such slip' }); }
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
