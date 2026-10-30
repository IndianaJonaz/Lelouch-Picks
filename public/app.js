// Lelouch HQ client — vanilla JS, no framework, ~1 request per view + SSE push.
'use strict';
const $app = document.getElementById('app');
const S = { me: null, view: null, data: {}, at: {}, err: {}, period: 'all', showAll: false, es: null, sseOk: false, newsTab: 'sports' };
const LS = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
S.bookF = LS.get('lhq.bookFilter', 'all'); S.sportF = LS.get('lhq.sportFilter', 'all'); S.pgOpen = LS.get('lhq.profitOpen', '1') === '1'; S.pgHidden = new Set(); S.pgFocus = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const u = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const tzAbbr = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' ' + tzAbbr : '';
const fmtDay = (iso) => { if (!iso) return ''; const d = new Date(iso), t = new Date(); const tm = new Date(t); tm.setDate(t.getDate() + 1);
  if (d.toDateString() === t.toDateString()) return 'Today'; if (d.toDateString() === tm.toDateString()) return 'Tomorrow'; return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };
const ago = (ms) => { if (ms == null) return 'never'; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const av = (name) => `<span class="av" style="background:hsl(${hue(name)} 70% 68%)">${esc(String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase())}</span>`;
const ICON = { won: '✓', lost: '✕', push: '–', void: '∅', pending: '•', review: '?' };
const stIc = (st) => `<span class="st-ic ${st}" title="${st}">${ICON[st] ?? '•'}</span>`;
const svg = {
  live: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  board: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>',
  news: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  lock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  img: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  out: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
};

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/api/login')) { S.me = { ...(S.me || {}), authed: false }; render(); throw new Error('signed out'); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ---------- routing ----------
const ROUTES = { '/live': 'live', '/board': 'board', '/news': 'news' };
function route() {
  const sm = location.pathname.match(/^\/slip\/([A-Za-z0-9]+)$/);
  if (sm) { S.slipId = sm[1].toUpperCase(); return 'slip'; }
  const v = ROUTES[location.pathname]; if (!v) { history.replaceState(null, '', '/board'); return 'board'; } return v;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); history.pushState(null, '', a.getAttribute('href')); go(); window.scrollTo({ top: 0 }); }
});
addEventListener('popstate', () => go());
let wasNarrow = innerWidth < 600, rsT = null; // profit graph picks its viewBox by width: redraw when crossing the breakpoint
addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { const n = innerWidth < 600; if (n !== wasNarrow) { wasNarrow = n; if (S.view === 'board') render(); } }, 150); });

async function boot() {
  try { S.me = await api('/api/me'); } catch { S.me = { authed: false }; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  go();
}
function go() { S.view = route(); render(); if (S.me?.authed) { load(S.view); connect(); } }

async function load(view) {
  try {
    if (view === 'slip') { S.data.slip = await api(`/api/slips/${encodeURIComponent(S.slipId)}`); S.at.slip = Date.now(); S.err.slip = null; if (S.view === view) render(); return; }
    const path = view === 'live' ? `/api/live${S.showAll ? '?all=1' : ''}` : view === 'board' ? `/api/board?period=${S.period}` : null;
    if (view === 'news') {
      const [n, h] = await Promise.all([api('/api/news'), api('/api/health')]);
      S.data.news = n; S.data.health = h;
    } else if (view === 'board') {
      const [b, pr] = await Promise.all([api(path), api('/api/profit').catch(() => S.data.profit ?? null)]);
      S.data.board = b; S.data.profit = pr;
    } else S.data[view] = await api(path);
    S.at[view] = Date.now(); S.err[view] = null;
  } catch (e) { if (e.message !== 'signed out') S.err[view] = e.message; }
  if (S.view === view) render();
}

let tickT = null;
function connect() {
  if (S.es) return;
  const es = new EventSource('/api/stream');
  S.es = es;
  es.addEventListener('hello', () => { S.sseOk = true; renderFresh(); });
  es.addEventListener('tick', () => { clearTimeout(tickT); tickT = setTimeout(() => load(S.view), 300); });
  es.onerror = () => { S.sseOk = false; renderFresh(); };
}
// Fallback refresh even if SSE is blocked by a proxy
setInterval(() => { if (S.me?.authed && !document.hidden && (!S.sseOk || Date.now() - (S.at[S.view] || 0) > 60_000)) load(S.view); }, 20_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me?.authed) load(S.view); });
setInterval(renderFresh, 1000);

// ---------- render ----------
function render() {
  if (!S.me) return;
  if (!S.me.authed) { document.body.dataset.view = 'login'; return renderLogin(); }
  const v = S.view;
  document.body.dataset.view = v;
  const nav = (p, label, ic) => `<a data-nav href="/${p}" class="${v === p ? 'on' : ''}">${ic}<span>${label}</span></a>`;
  const body = S.err[v] && !S.data[v === 'news' ? 'news' : v] ? errBox(S.err[v]) : v === 'live' ? viewLive() : v === 'board' ? viewBoard() : v === 'slip' ? viewSlip() : viewNews();
  $app.innerHTML = `
  <header class="top"><div class="top-in">
    <a data-nav href="/board" class="brand"><span class="logo-mark"></span><span>Lelouch <b>HQ</b></span></a>
    <nav class="nav">${nav('live', 'Live', '')}${nav('board', 'The Board', '')}${nav('news', 'News & health', '')}</nav>
    <div class="spacer"></div>
    <div class="fresh" id="fresh"></div>
    <button class="icon-btn" id="logout" title="Sign out" aria-label="Sign out">${svg.out}</button>
  </div></header>
  ${S.me.demo ? `<div class="demo-banner"><div><span class="chip demo">DEMO</span><span>Demo mode: sample slips from made-up members on <b>real</b> ESPN games — scores, stats and grades are live, the picks are not.</span></div></div>` : ''}
  <main>${S.err[v] && S.data[v === 'news' ? 'news' : v] ? errBox(S.err[v], true) : ''}${body}</main>
  <nav class="tabbar">${nav('live', 'Live', svg.live)}${nav('board', 'Board', svg.board)}${nav('news', 'News', svg.news)}</nav>`;
  document.getElementById('logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); S.es?.close(); S.es = null; S.me.authed = false; S.data = {}; render(); };
  $app.querySelectorAll('[data-period]').forEach((b) => (b.onclick = () => { S.period = b.dataset.period; load('board'); }));
  $app.querySelectorAll('[data-more]').forEach((b) => (b.onclick = () => { S.allRecent = true; render(); }));
  $app.querySelectorAll('[data-bookf]').forEach((b) => (b.onclick = () => { S.bookF = b.dataset.bookf; LS.set('lhq.bookFilter', S.bookF); render(); }));
  $app.querySelectorAll('[data-sportf]').forEach((b) => (b.onclick = () => { S.sportF = b.dataset.sportf; LS.set('lhq.sportFilter', S.sportF); render(); }));
  $app.querySelectorAll('[data-pgtog]').forEach((b) => (b.onclick = () => { S.pgOpen = !S.pgOpen; LS.set('lhq.profitOpen', S.pgOpen ? '1' : '0'); render(); }));
  // Chip: 1st tap highlights that line, 2nd tap hides it, 3rd tap shows it again.
  $app.querySelectorAll('[data-pgchip]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.pgchip;
    if (S.pgHidden.has(id)) S.pgHidden.delete(id); else if (S.pgFocus === id) { S.pgHidden.add(id); S.pgFocus = null; } else S.pgFocus = id;
    render();
  }));
  $app.querySelectorAll('[data-pguser]').forEach((r) => (r.onclick = () => {
    const id = r.dataset.pguser; S.pgHidden.delete(id); S.pgFocus = S.pgFocus === id ? null : id;
    if (!S.pgOpen) { S.pgOpen = true; LS.set('lhq.profitOpen', '1'); }
    render(); document.querySelector('.pg')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $app.querySelectorAll('[data-img]').forEach((r) => {
    r.onclick = () => openSlipImage(r.dataset.img, r);
    r.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSlipImage(r.dataset.img, r); } };
  });
  $app.querySelectorAll('[data-newstab]').forEach((b) => (b.onclick = () => { S.newsTab = b.dataset.newstab; render(); }));
  $app.querySelectorAll('[data-all]').forEach((b) => (b.onclick = () => { S.showAll = b.dataset.all === '1'; render(); load('live'); }));
  renderFresh();
}

// ---------- slip screenshot lightbox (image fetched live from Discord; never stored) ----------
let lbClose = null;
function openSlipImage(id, opener) {
  lbClose?.();
  const el = document.createElement('div');
  el.className = 'lbx';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', `Slip ${id} screenshot`);
  el.innerHTML = `<div class="lbx-box"><div class="lbx-head"><span>Slip <b>${esc(id)}</b></span><button class="lbx-x" aria-label="Close">✕</button></div>
    <div class="lbx-body"><div class="lbx-state"><span class="logo-mark big"></span><span>Summoning the slip from Discord…</span></div></div></div>`;
  const body = el.querySelector('.lbx-body');
  const img = new Image();
  img.alt = `Slip ${id} screenshot`;
  img.onload = () => { body.replaceChildren(img); };
  img.onerror = () => { body.innerHTML = '<div class="lbx-state err"><b>Image no longer available on Discord</b><span class="dim">The original message or attachment was deleted.</span></div>'; };
  img.src = `/api/slips/${encodeURIComponent(id)}/image`;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('lbx-open'); lbClose = null; img.onload = img.onerror = null; opener?.focus?.(); };
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('.lbx-x')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(el); document.body.classList.add('lbx-open');
  el.querySelector('.lbx-x').focus();
  lbClose = close;
}

function renderFresh() {
  const el = document.getElementById('fresh');
  if (!el) return;
  const at = S.at[S.view];
  const err = S.err[S.view];
  const st = err ? 'down' : S.sseOk ? 'ok' : 'warn';
  el.innerHTML = `<span class="dot ${st}"></span><span class="num">${err ? 'Update failed' : at ? `Updated ${ago(at)}` : 'Loading…'}</span><span class="lbl dim">· ${S.sseOk ? 'live push' : 'polling'}</span>`;
  document.querySelectorAll('[data-ago]').forEach((n) => (n.textContent = ago(Number(n.dataset.ago))));
}

const errBox = (msg, inline) => `<div class="card err" style="margin-bottom:14px"><div class="empty"><b>${inline ? 'Couldn’t refresh — showing the last good data' : 'Couldn’t load this page'}</b>${esc(msg)}</div></div>`;
const skel = (n = 4) => `<div class="grid g2">${'<div class="skel"></div>'.repeat(n)}</div>`;

// ---------- login ----------
function renderLogin() {
  $app.innerHTML = `
  <div class="login"><form class="card login-card" id="lf" autocomplete="off">
    <div class="brand"><span class="logo-mark"></span><span>Lelouch <b>HQ</b></span></div>
    <h1>Welcome back</h1>
    <p>Enter today’s access key. Run <b>/dashboard</b> in Discord to get it — keys rotate every day.</p>
    <label class="field" for="key">Access key</label>
    <input class="input" id="key" name="key" placeholder="PHQ-XXXX-XXXX" autocapitalize="characters" spellcheck="false" required maxlength="20" inputmode="text">
    <div class="opts">
      <label class="opt"><input type="radio" name="remember" value="1"><span>Keep me signed in<small>Stay signed in on this device for 30 days</small></span></label>
      <label class="opt"><input type="radio" name="remember" value="0" checked><span>This browser session only<small>Signed out when you close the browser</small></span></label>
    </div>
    <button class="btn" id="lb" type="submit">Enter Lelouch HQ</button>
    <div class="form-err" id="le" role="alert"></div>
    <div class="hint">Private to your Discord group. Hidden picks stay hidden until they’re revealed.<br>On iPhone: Share → Add to Home Screen.</div>
  </form></div>`;
  const key = document.getElementById('key');
  key.focus();
  key.addEventListener('input', () => {
    let s = key.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.startsWith('PHQ')) s = s.slice(3);
    s = s.slice(0, 8);
    key.value = s ? 'PHQ-' + (s.length > 4 ? s.slice(0, 4) + '-' + s.slice(4) : s) : '';
  });
  document.getElementById('lf').onsubmit = async (e) => {
    e.preventDefault();
    const b = document.getElementById('lb'), le = document.getElementById('le');
    b.disabled = true; le.textContent = '';
    try {
      const remember = new FormData(e.target).get('remember') === '1';
      await api('/api/login', { method: 'POST', body: JSON.stringify({ key: key.value, remember }) });
      S.me.authed = true;
      if (!ROUTES[location.pathname]) history.replaceState(null, '', '/board');
      go();
    } catch (err) { le.textContent = err.message; b.disabled = false; key.select(); }
  };
}

// ---------- shared pieces ----------
function paceHtml(leg) {
  const p = leg.pace;
  if (!p || leg.event?.state === 'pre' || p.label === 'Not started') return '';
  if (p.pct == null) return p.label ? `<div class="pace"><span class="v">${esc(p.label)}</span></div>` : '';
  const done = leg.status !== 'pending';
  const state = leg.status === 'won' ? 'on' : leg.status === 'lost' ? 'off' : p.onPace == null ? '' : p.onPace ? 'on' : 'off';
  const projPct = p.projected != null && p.target ? Math.min(100, (p.projected / Math.ceil(p.target)) * 100) : null;
  const proj = !done && p.projected != null ? ` · proj ${p.projected}` : '';
  return `<div class="pace"><div class="bar ${state}"><i style="width:${(p.pct * 100).toFixed(1)}%"></i>${projPct != null && !done ? `<u style="left:calc(${projPct.toFixed(1)}% - 1px)" title="projected"></u>` : ''}</div>
    <span class="v">${esc(p.label)}${proj}${!done && p.onPace != null ? (p.onPace ? ' · on pace' : ' · behind') : ''}</span></div>`;
}
function legRow(x) {
  const l = x.leg;
  return `<div class="leg">${av(x.user)}<div><div class="t">${esc(l.text)} ${l.oddsText ? `<span class="dim num" style="font-weight:500">${esc(l.oddsText)}</span>` : ''}</div>
    <div class="s">${esc(x.user)} · slip ${esc(x.slipId)}${l.detail ? ' · ' + esc(l.detail) : ''}${x.demo ? ' · <span class="chip demo">DEMO</span>' : ''}</div>${paceHtml(l)}</div>
    <span class="chip ${l.status}">${l.status === 'pending' ? (l.event?.state === 'in' ? 'LIVE' : 'OPEN') : l.status.toUpperCase()}</span></div>`;
}
function gameCard(g, legsHtml) {
  if (g.pending) return `<div class="card game"><div class="game-hd"><span class="chip">${esc(String(g.league).toUpperCase())}</span><span>${esc(g.name)}</span></div><div class="empty">Waiting for the first ESPN update…</div><div class="legs">${legsHtml}</div></div>`;
  const live = g.state === 'in', fin = g.state === 'post';
  const hs = g.home.score, as = g.away.score;
  const row = (t, lose, win) => `<div class="trow ${lose ? 'lose' : ''}">${t.logo ? `<img src="${esc(t.logo)}" alt="" width="28" height="28">` : '<span class="nologo"></span>'}<b>${esc(t.abbr)}</b><span class="tn">${esc(t.short || '')}${t.record ? ` <span class="dim">${esc(t.record)}</span>` : ''}</span><span class="pts num">${g.state === 'pre' ? '' : esc(t.score ?? '')}</span>${win ? '<span class="win-mark">◀</span>' : '<span class="win-mark"></span>'}</div>`;
  const status = live ? `<span class="chip live"><span class="dot live"></span>${esc(g.detail)}</span>` : fin ? `<span class="chip">${esc(g.detail || 'Final')}</span>` : `<span class="when">${esc(fmtDay(g.start))} · ${esc(fmtTime(g.start))}</span>`;
  return `<div class="card game ${g.error ? 'err' : ''}">
    <div class="game-hd"><span class="chip">${esc(g.leagueLabel)}</span>${status}<span class="spacer"></span><span class="dim">${esc(g.broadcast || '')}</span></div>
    <div class="teams">${row(g.away, fin && as < hs, fin && as > hs)}${row(g.home, fin && hs < as, fin && hs > as)}</div>
    ${g.odds?.details && g.state === 'pre' ? `<div class="oddsline">${esc(g.odds.details)}${g.odds.overUnder ? ' · O/U ' + esc(g.odds.overUnder) : ''}${g.odds.provider ? ' · ' + esc(g.odds.provider) : ''}</div>` : ''}
    ${legsHtml ? `<div class="legs">${legsHtml}</div>` : ''}
    ${g.error ? `<div class="err-line">⚠ ${esc(g.error)}</div>` : ''}
    <div class="foot"><span class="dot ${g.stale || g.error ? 'down' : 'ok'}"></span>ESPN · fetched <span data-ago="${g.fetchedAt}">${ago(g.fetchedAt)}</span>${g.stale ? ' · <b style="color:#fda4af">stale</b>' : ''}</div>
  </div>`;
}

// ---------- Live ----------
function viewLive() {
  const d = S.data.live;
  const head = `<div class="page-head"><div><h1>Live</h1><p>Every public leg the group is on, with pace. Updates push automatically.</p></div><div class="spacer"></div>
    <div class="seg"><button data-all="0" class="${S.showAll ? '' : 'on'}">Our games</button><button data-all="1" class="${S.showAll ? 'on' : ''}">All games today</button></div></div>`;
  if (!d) return head + skel();
  const games = d.games;
  const liveN = games.filter((g) => g.state === 'in').length;
  let html = head;
  if (d.hiddenLegs) html += `<div class="card" style="padding:12px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:center;font-size:13.5px;color:var(--tx2)">${svg.lock} ${d.hiddenLegs} hidden leg(s) in play — revealed when the owner reveals them or the slip settles.</div>`;
  if (!games.length) html += `<div class="card empty"><b>No public legs right now</b>Post a slip with /pick in Discord and its games show up here.</div>`;
  else {
    const groups = [['in', `Live now · ${liveN}`], ['pre', 'Up next'], ['post', 'Final']];
    for (const [st, label] of groups) {
      const gs = games.filter((g) => (g.state ?? 'pre') === st);
      if (!gs.length) continue;
      html += `<section class="sec"><div class="sec-head"><h2>${label}</h2></div><div class="grid g2">${gs.map((g) => gameCard(g, g.legs.map(legRow).join(''))).join('')}</div></section>`;
    }
  }
  if (S.showAll) {
    html += `<section class="sec slate"><div class="sec-head"><h2>Rest of today’s slate</h2><span class="count">${d.slate.length} games</span></div>`;
    if (d.slateErrors?.length) html += `<div class="card err" style="margin-bottom:12px"><div class="err-line" style="border:0">⚠ Feed not answering: ${d.slateErrors.map((e) => esc(e.league.toUpperCase()) + ' (' + esc(e.error) + ')').join(', ')}</div></div>`;
    html += d.slate.length ? `<div class="grid g3">${d.slate.map((g) => gameCard(g, '')).join('')}</div>` : `<div class="card empty">No other games today.</div>`;
    html += `</section>`;
  }
  return html + `<p class="dim" style="font-size:12px;margin-top:22px">Source: ${esc(d.source)}. Pace = current stat ÷ share of regulation played. Over props cash (and unders bust) the moment the line is passed; everything else grades at final.</p>`;
}

// ---------- Board ----------
function miniLegs(s) {
  return `<div class="mini-legs">${s.legs.map((l) => `<div class="mini-leg">${stIc(l.status)}<div class="x">${esc(l.text)}<small>${esc(l.leagueLabel)} · ${esc(l.event?.name || '')}${l.event?.state === 'pre' && l.event?.start ? ' · ' + esc(fmtDay(l.event.start)) + ' ' + esc(fmtTime(l.event.start)) : l.event?.detail ? ' · ' + esc(l.event.detail) : ''}${l.actual != null && l.type === 'prop' ? ' · <b style="color:var(--tx)">' + esc(l.actual) + '</b>' : ''}${l.detail ? ' · ' + esc(l.detail) : ''}</small></div><span class="o">${esc(l.oddsText)}</span></div>`).join('')}</div>`;
}
function slipCard(s) {
  const hd = `<div class="slip-hd">${av(s.user)}<div><div class="who">${esc(s.user)} ${s.demo ? '<span class="chip demo">DEMO</span>' : ''}</div><div class="sid"><a data-nav href="/slip/${esc(s.id)}">${esc(s.title || `${s.legCount}-leg slip`)} · ${esc(s.id)}</a></div></div><span class="spacer"></span>
    ${s.hidden ? `<span class="chip hidden">HIDDEN</span>` : `<span class="chip ${s.status}">${s.status === 'open' ? `${s.progress.won}/${s.legCount} HIT` : s.status.toUpperCase()}</span>`}</div>`;
  if (s.hidden) return `<div class="card slip">${hd}<div class="locked">${svg.lock}<span>${s.legCount} leg(s) locked until ${esc(s.user)} reveals them or the slip settles.</span></div><div class="slip-ft"><span>Stake <b>${u(s.stake)}</b></span><span>Posted <span data-ago="${Date.parse(s.createdAt)}">${ago(Date.parse(s.createdAt))}</span></span></div></div>`;
  return `<div class="card slip">${hd}${miniLegs(s)}${s.note ? `<div class="note">“${esc(s.note)}”</div>` : ''}
    <div class="slip-ft"><span>Stake <b>${u(s.stake)}</b></span><span>Odds <b>${esc(s.oddsText || '—')}</b></span><span>${s.status === 'open' ? 'To win' : 'Result'} <b class="${s.status === 'open' ? '' : cls(s.profit)}">${s.status === 'open' ? u(s.toWin) : s.status === 'review' ? 'needs review' : u(s.profit)}</b></span></div></div>`;
}
// ---------- open slips: book + sport filter tabs ----------
const BOOKS = [['all', 'All'], ['prizepicks', 'PrizePicks'], ['kalshi', 'Kalshi'], ['other', 'Other']];
const SPORTS = [['all', 'All'], ['nba', 'NBA'], ['mlb', 'MLB'], ['wnba', 'WNBA'], ['tennis', 'Tennis'], ['nfl', 'NFL'], ['nbl', 'NBL']];
const byBook = (k) => (s) => k === 'all' || (s.bookKey ?? 'other') === k;
const bySport = (k) => (s) => k === 'all' || (s.sports ?? []).includes(k);
function viewOpenSlips(open) {
  if (!BOOKS.some(([k]) => k === S.bookF)) S.bookF = 'all';
  if (!SPORTS.some(([k]) => k === S.sportF)) S.sportF = 'all';
  const shown = open.filter(byBook(S.bookF)).filter(bySport(S.sportF));
  const tabs = (list, cur, attr, count) => `<div class="ftabs" role="tablist">${list.map(([k, l]) => `<button role="tab" aria-selected="${cur === k}" ${attr}="${k}" class="${cur === k ? 'on' : ''}">${l}<span class="n">${count(k)}</span></button>`).join('')}</div>`;
  const bookTabs = tabs(BOOKS, S.bookF, 'data-bookf', (k) => open.filter(bySport(S.sportF)).filter(byBook(k)).length);
  const sportTabs = tabs(SPORTS, S.sportF, 'data-sportf', (k) => open.filter(byBook(S.bookF)).filter(bySport(k)).length);
  const label = [S.bookF !== 'all' ? BOOKS.find(([k]) => k === S.bookF)[1] : '', S.sportF !== 'all' ? SPORTS.find(([k]) => k === S.sportF)[1] : ''].filter(Boolean).join(' · ');
  const body = !open.length ? `<div class="card empty"><b>No open slips</b>Use /pick in Discord to post one.</div>`
    : shown.length ? `<div class="grid g3">${shown.map(slipCard).join('')}</div>`
    : `<div class="card empty"><b>No open ${esc(label)} slips</b>Try another tab, or pick All.</div>`;
  return `<section class="sec"><div class="sec-head"><h2>Open slips</h2><span class="count">${shown.length === open.length ? open.length : `${shown.length} of ${open.length}`}</span></div>
    <div class="filters">${bookTabs}${sportTabs}</div>${body}</section>`;
}

// ---------- profit over time: every member's cumulative profit as step lines (inline SVG) ----------
const PG_COLORS = ['#f2c94c', '#ff4d5e', '#3ddc97', '#4fc3f7', '#ff9f43', '#e879f9', '#a3e635', '#f8fafc', '#fb7185', '#22d3ee', '#fde047', '#c4b5fd'];
const pgMoney = (n) => `${n < 0 ? '-' : n > 0 ? '+' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const axisMoney = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
function niceStep(range) { const raw = range / 5, p = 10 ** Math.floor(Math.log10(raw || 1)), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
function viewProfitGraph(pr) {
  const head = `<div class="sec-head"><h2>Profit over time</h2><span class="count">cumulative $ by member · settled slips</span><span class="spacer" style="flex:1"></span><button class="pg-tog" data-pgtog aria-expanded="${S.pgOpen}">${S.pgOpen ? 'Hide' : 'Show'}</button></div>`;
  if (!S.pgOpen) return `<section class="sec pg">${head}</section>`;
  const users = (pr?.users ?? []).map((u, i) => ({ ...u, color: PG_COLORS[i % PG_COLORS.length] }));
  if (!pr) return `<section class="sec pg">${head}<div class="card empty">Loading…</div></section>`;
  if (!users.length) return `<section class="sec pg">${head}<div class="card empty"><b>No settled slips yet</b>The graph fills in as slips grade.</div></section>`;
  const narrow = innerWidth < 600, W = narrow ? 360 : 720, H = narrow ? 240 : 260, L = narrow ? 50 : 58, R = 12, T = 12, B = 28; // viewBox ≈ CSS px so labels stay legible
  const ts = (p) => Date.parse(p.t.endsWith('Z') ? p.t : p.t + 'Z');
  const all = users.flatMap((u) => u.points.map(ts));
  let t0 = Math.min(...all), t1 = Math.max(...all);
  if (t1 - t0 < 86400_000) { t0 -= 43200_000; t1 += 43200_000; } // 1 point / same day: give the x axis some width
  const vals = [0, ...users.flatMap((u) => u.points.map((p) => p.cum))];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { hi += 5; lo -= 5; }
  const step = niceStep(hi - lo); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R), y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += step) grid += `<line class="${Math.abs(v) < 1e-9 ? 'zero' : 'gl'}" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="yl" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}">${axisMoney(v)}</text>`;
  const days = Math.max(1, Math.round((t1 - t0) / 86400_000)), every = Math.max(1, Math.ceil(days / 4));
  const start = new Date(t0); start.setHours(0, 0, 0, 0);
  for (let d = new Date(start), i = 0; d.getTime() <= t1; d.setDate(d.getDate() + 1), i++) {
    if (i % every || d.getTime() < t0) continue;
    grid += `<text class="xl" x="${x(d.getTime()).toFixed(1)}" y="${H - 8}">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</text>`;
  }
  const focus = S.pgFocus && users.some((u) => u.userId === S.pgFocus) ? S.pgFocus : null;
  const lines = users.filter((u) => !S.pgHidden.has(u.userId)).map((u) => {
    let px = x(Math.min(...u.points.map(ts))), py = y(0), d = `M${px.toFixed(1)},${py.toFixed(1)}`;
    for (const p of u.points) { const nx = x(ts(p)), ny = y(p.cum); d += `H${nx.toFixed(1)}V${ny.toFixed(1)}`; px = nx; py = ny; } // step-after
    const dim = focus && focus !== u.userId ? ' dim' : '';
    const dots = u.points.map((p) => `<circle class="hit" cx="${x(ts(p)).toFixed(1)}" cy="${y(p.cum).toFixed(1)}" r="7"><title>${esc(u.user)} · ${new Date(ts(p)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${p.approxTime ? ' (logged)' : ''} · #${esc(p.slipId)} ${esc(p.status)} ${pgMoney(p.delta)} → ${pgMoney(p.cum)}</title></circle>`).join('');
    return `<g class="pg-line${dim}" style="--c:${u.color}"><path d="${d}"/><circle class="end" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5"/>${dots}</g>`;
  }).join('');
  const chips = users.map((u) => `<button class="pg-chip${S.pgHidden.has(u.userId) ? ' off' : ''}${focus === u.userId ? ' on' : ''}" data-pgchip="${esc(u.userId)}" style="--c:${u.color}" aria-pressed="${!S.pgHidden.has(u.userId)}"><i></i>${esc(u.user)}${u.demo ? ' <span class="chip demo">DEMO</span>' : ''} <b class="${cls(u.profit)}">${pgMoney(u.profit)}</b></button>`).join('');
  return `<section class="sec pg">${head}<div class="card pg-card"><svg class="pg-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative profit by member">${grid}${lines}</svg>
    <div class="pg-legend">${chips}</div><div class="pg-hint dim">Tap a name to highlight · tap again to hide · tap a point for details</div></div></section>`;
}

function viewBoard() {
  const d = S.data.board;
  const head = `<div class="page-head"><div><h1>The Board</h1><p>Open slips, tonight’s poster, results and who’s actually up.</p></div></div>`;
  if (!d) return head + skel();
  const t = d.totals;
  let html = head + `<div class="stats">
    <div class="card stat"><div class="k">Open slips</div><div class="v num">${d.open.length}</div></div>
    <div class="card stat"><div class="k">Group record</div><div class="v num">${t.w ?? 0}-${t.l ?? 0}</div></div>
    <div class="card stat"><div class="k">Group profit</div><div class="v num ${cls(t.profit)}">${u(t.profit)}</div></div>
    <div class="card stat"><div class="k">Settled (7d)</div><div class="v num">${d.recent.length}</div></div></div>`;
  if (d.poster) {
    const p = d.poster;
    html += `<section class="sec"><div class="poster"><div class="card"><div class="eyebrow">Tonight’s poster${p.pinned ? '' : ' · auto-picked (biggest to-win tonight)'}</div>
      <h3>${esc(p.title || `${p.user}’s ${p.legCount}-leg`)} ${p.demo ? '<span class="chip demo">DEMO</span>' : ''}</h3><div class="muted" style="font-size:13px;margin-bottom:12px">${esc(p.user)} · slip ${esc(p.id)}</div>
      ${miniLegs(p).replace('class="mini-legs"', 'class="mini-legs" style="padding:0"')}
      <div class="meta"><span>Stake <b>${u(p.stake)}</b></span><span>Odds <b>${esc(p.oddsText)}</b></span><span>To win <b class="pos">${u(p.toWin)}</b></span>${p.firstStart ? `<span>First leg <b>${esc(fmtTime(p.firstStart))}</b></span>` : ''}</div></div></div></section>`;
  }
  html += viewOpenSlips(d.open);
  html += viewProfitGraph(S.data.profit);
  const periods = [['all', 'All time'], ['30d', '30 days'], ['7d', '7 days'], ['today', 'Today']];
  const lb = d.leaderboard;
  const maxAbs = Math.max(1, ...lb.map((x) => Math.abs(x.profit)));
  html += `<section class="sec"><div class="sec-head"><h2>Leaderboard · Holiday Season ❄️💸</h2><span class="count">ranked by profit, not volume</span><span class="spacer" style="flex:1"></span><div class="seg">${periods.map(([k, l]) => `<button data-period="${k}" class="${d.period === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="card scroll-x">${lb.length ? `<table class="lb"><thead><tr><th>#</th><th>Member</th><th>Profit</th><th>Record</th><th>ROI</th><th class="hm">Risked</th><th class="hm">Form</th></tr></thead><tbody>
    ${lb.map((r) => `<tr data-pguser="${esc(r.userId)}" class="${S.pgFocus === r.userId ? 'pg-on' : ''}" title="Show on profit graph"><td class="rk">${r.rank}</td><td><div class="u">${av(r.user)}${esc(r.user)}${r.demo ? ' <span class="chip demo">DEMO</span>' : ''}</div></td>
      <td class="num"><span class="pbar"><i style="width:${(Math.abs(r.profit) / maxAbs * 100).toFixed(0)}%;background:${r.profit >= 0 ? 'var(--win)' : 'var(--loss)'}"></i></span><b class="${cls(r.profit)}">${u(r.profit)}</b></td>
      <td class="num">${r.w}-${r.l}${r.p ? '-' + r.p : ''}</td><td class="num ${cls(r.roi)}">${r.roi > 0 ? '+' : ''}${r.roi}%</td><td class="num hm muted">${u(r.staked)}</td>
      <td class="hm"><span class="form">${r.last.map((x) => `<i class="${x}"></i>`).join('')}</span> <span class="dim num" style="font-size:12px">${esc(r.streak)}</span></td></tr>`).join('')}
    </tbody></table>` : `<div class="empty"><b>No settled slips in this window</b>Rankings appear once slips grade.</div>`}</div></section>`;
  html += `<section class="sec"><div class="sec-head"><h2>Recent results</h2><span class="count">last 7 days</span></div><div class="card">${d.recent.length ? d.recent.slice(0, S.allRecent ? 999 : 12).map((s) => `<div class="res${s.hasImage ? ' has-img' : ''}"${s.hasImage ? ` data-img="${esc(s.id)}" role="button" tabindex="0" aria-label="View slip screenshot ${esc(s.id)}"` : ''}>${stIc(s.status === 'open' ? 'pending' : s.status)}<div class="x"><b>${esc(s.user)}</b> ${s.demo ? '<span class="chip demo">DEMO</span>' : ''} <span class="dim" style="font-size:12px">· ${esc(s.id)}${s.wasHidden ? ' · was hidden' : ''}</span><div>${esc(s.legs.map((l) => l.text).join(' · ') || s.title || '')}</div></div>${s.hasImage ? `<span class="img-ic" title="View slip screenshot">${svg.img}</span>` : ''}<span class="p num ${cls(s.profit)}">${u(s.profit)}</span></div>`).join('') + (d.recent.length > 12 && !S.allRecent ? `<button class="more" data-more>Show all ${d.recent.length} results</button>` : '') : '<div class="empty">Nothing settled this week yet.</div>'}</div></section>`;
  return html;
}

// ---------- News & health ----------
function viewNews() {
  const n = S.data.news, h = S.data.health;
  const head = `<div class="page-head"><div><h1>News & health</h1><p>Sports and health headlines, injury notes for players on public slips, and whether every data feed is answering.</p></div></div>`;
  if (!n || !h) return head + skel(2);
  const sev = (s) => /out|reserve/i.test(s) ? 'out' : /doubt|quest|day/i.test(s) ? 'q' : 'ok';
  let html = head + viewHeadlines(n.headlines);
  const feedErr = Object.entries(n.feeds).filter(([, f]) => !f.ok);
  html += `<section class="sec" style="margin-top:0"><div class="sec-head"><h2>Injury notes</h2><span class="count">${n.injuries.length} note(s) · ${n.tracked.length} player(s) tracked</span></div>
    ${feedErr.length ? `<div class="card err" style="margin-bottom:12px"><div class="err-line" style="border:0">⚠ Injury feed not answering for ${feedErr.map(([k, f]) => esc(k.toUpperCase()) + ' (' + esc(f.error) + ')').join(', ')} — notes for those leagues may be missing.</div></div>` : ''}
    <div class="card">${n.injuries.length ? n.injuries.map((i, ix, arr) => (ix === 0 || arr[ix - 1].onSlip !== i.onSlip ? `<div class="subh">${i.onSlip ? 'Players on public slips' : 'Key absences on teams you’re backing'}</div>` : '') + `<div class="inj"><span class="sev ${sev(i.status)}">${esc(String(i.status).toUpperCase())}</span><div><div class="who">${esc(i.player)} <span class="dim" style="font-weight:500">· ${esc(i.team)} · ${esc(i.leagueLabel)}</span></div>
      <div class="why">${esc(i.short || i.long || 'No details provided.')}</div>
      <div class="meta"><span>${i.onSlip ? '🎯 on slip' : 'ℹ ' + esc(i.via)} ${i.slips.map((s) => esc(s)).join(', ')}</span>${i.type ? `<span>${esc(i.type)}</span>` : ''}${i.returnDate ? `<span>Est. return ${esc(i.returnDate)}</span>` : ''}<span>Updated ${esc(new Date(i.date).toLocaleDateString())}</span><span>${esc(i.source)}</span></div></div></div>`).join('')
      : `<div class="empty"><b>No injury notes</b>None of the players or teams on public open slips are on ESPN’s injury report.</div>`}</div>
    ${n.tracked.length ? `<div class="card" style="margin-top:12px"><div class="tracked">${n.tracked.map((p) => `<span class="${p.hasNote ? 'has' : ''}">${esc(p.name)} · ${esc(p.team || '')}</span>`).join('')}</div></div>` : ''}</section>`;
  const comps = h.components.map((c) => `<div class="hrow"><span class="dot ${c.status}"></span><div><div class="n">${esc(c.name)}</div><div class="d">${esc(c.detail || '')}</div></div><span class="r">${esc(c.status)}</span></div>`).join('');
  const feeds = h.feeds.map((f) => `<div class="hrow"><span class="dot ${f.status}"></span><div><div class="n">${esc(f.feed.replace(':', ' · ').toUpperCase())}</div><div class="d">${f.lastOkAt ? `last answer <span data-ago="${f.lastOkAt}">${ago(f.lastOkAt)}</span>` : 'no successful answer yet'}${f.lastError ? ` · last error: ${esc(f.lastError)} (<span data-ago="${f.lastErrAt}">${ago(f.lastErrAt)}</span>)` : ''}</div></div>
    <span class="r">${f.latencyMs != null ? f.latencyMs + 'ms' : '—'}<br><span class="dim">${f.calls - f.failures}/${f.calls} ok</span></span></div>`).join('');
  html += `<section class="sec"><div class="sec-head"><h2>System</h2><span class="chip ${h.overall === 'ok' ? 'won' : 'lost'}">${h.overall.toUpperCase()}</span></div><div class="card">${comps}</div></section>
    <section class="sec"><div class="sec-head"><h2>Data feeds</h2><span class="count">ESPN public JSON · calls since server start</span></div><div class="card">${feeds || '<div class="empty">No feed calls yet.</div>'}</div></section>`;
  return html;
}

// Sports + health headlines (free public RSS, fetched + cached server-side). Fail-soft: a dead feed only adds a note.
const safeHref = (h) => { try { const x = new URL(h); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const fmtNewsTime = (iso) => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return '';
  const tz = S.me?.tz || 'America/Chicago';
  const abbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return d.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ' + abbr; };
function viewHeadlines(hl) {
  const tabs = [['sports', 'Sports'], ['health', 'Health']];
  const tab = S.newsTab === 'health' ? 'health' : 'sports';
  const seg = `<div class="seg" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}" data-newstab="${k}">${l}${hl ? ` <span class="dim">${(hl.sections?.[k] || []).length}</span>` : ''}</button>`).join('')}</div>`;
  const headHtml = `<div class="sec-head"><h2>Headlines</h2>${seg}<span class="count">${hl ? `updated <span data-ago="${hl.asOf}">${ago(hl.asOf)}</span>` : ''}</span></div>`;
  if (!hl) return `<section class="sec" style="margin-top:0">${headHtml}<div class="card"><div class="empty"><b>Headlines unavailable</b>The news feeds didn’t answer. Injury notes and system status below are unaffected.</div></div></section>`;
  const items = hl.sections?.[tab] || [];
  const down = (hl.feeds || []).filter((f) => f.section === tab && !f.ok);
  const rows = items.map((h) => { const href = safeHref(h.link); const t = esc(h.title);
    return `<div class="nws">${href ? `<a class="nws-t" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${t}</a>` : `<span class="nws-t">${t}</span>`}
      <div class="nws-m"><span class="nws-src">${esc(h.source)}</span>${h.published ? `<span data-ago="${Date.parse(h.published)}">${ago(Date.parse(h.published))}</span><span>${esc(fmtNewsTime(h.published))}</span>` : ''}</div></div>`; }).join('');
  return `<section class="sec" style="margin-top:0">${headHtml}
    ${down.length ? `<div class="card err" style="margin-bottom:12px"><div class="err-line" style="border:0">⚠ ${down.map((f) => esc(f.name)).join(', ')} not answering — showing what the other ${tab} feeds returned.</div></div>` : ''}
    <div class="card nws-list">${rows || `<div class="empty"><b>No ${tab} headlines right now</b>Feeds will be retried shortly.</div>`}</div>
    <div class="nws-cred dim">Sources: ${(hl.feeds || []).filter((f) => f.section === tab).map((f) => esc(f.name)).join(' · ')} · public RSS</div></section>`;
}

// ---------- Slip page (ticket) ----------
const money = (n) => u(n);
const signed = (n) => u(n);
const fmtDate = (iso) => (iso ? new Date(iso.endsWith('Z') ? iso : iso + 'Z').toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
const fmtStamp = (iso) => (iso ? new Date(iso.endsWith('Z') ? iso : iso + 'Z').toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const WORD_CLS = { waiting: 'pending', hit: 'won', miss: 'lost', push: 'push', void: 'void', check: 'review' };
function ticketHtml(s) {
  const t = s.ticket, $ = !!s.book;
  const ring = t.legCount ? Math.round((t.hits / t.legCount) * 100) : 0;
  const rows = s.legs.map((l) => `<div class="tk-row ${esc(l.status)}">${l.headshot ? `<img class="hs" src="${esc(l.headshot)}" alt="" loading="lazy">` : `<span class="hs ph">${esc(l.leagueLabel.slice(0, 3))}</span>`}<div class="x">${esc(l.ticketText)}${l.actual != null ? ` <b class="act">${esc(l.actual)}</b>` : ''}</div>${stIc(l.status)}</div>`).join('');
  return `<div class="ticket ${esc(s.status)}">
    <div class="tk-top">${t.book ? `<span class="tk-book">${esc(t.book.toUpperCase())}</span>` : ''}${t.playBadge ? `<span class="tk-play">${esc(t.playBadge)}</span>` : ''}${t.isTest ? '<span class="tk-play">TEST</span>' : ''}<span class="spacer"></span><span class="tk-id">#${esc(s.id)}</span></div>
    <div class="tk-mid"><div><div class="tk-big">${money(t.risk, $)} → ${money(t.pays, $)}</div><div class="tk-sub">${esc(t.sports.join(' / '))} · ${t.legCount} leg${t.legCount === 1 ? '' : 's'}${t.oddsAsLogged ? ' · ' + esc(t.oddsAsLogged) : ''}</div>
      <div class="tk-status">${esc(t.statusLine)}</div></div>
      <div class="tk-ring" style="--p:${ring}"><b>${t.hits}/${t.legCount}</b><small>HIT</small></div></div>
    <div class="tk-rows">${rows}</div>
    <div class="tk-ft">${av(s.user)}<div><b>${esc(s.user)}</b><small>logged ${esc(fmtStamp(s.createdAt))}</small></div></div></div>`;
}
function viewSlip() {
  const s = S.data.slip;
  const back = `<a data-nav href="/board" class="dim" style="font-size:13px">← The Board</a>`;
  if (S.err.slip && !s) return back + errBox(S.err.slip);
  if (!s || s.id !== S.slipId) return back + skel();
  if (s.hidden) return back + `<div class="card empty" style="margin-top:14px">${svg.lock}<b>Hidden slip</b>${s.legCount} leg(s) stay hidden until ${esc(s.user)} reveals them or it settles.</div>`;
  const t = s.ticket, $ = !!s.book;
  const chip = s.status === 'won' ? 'WIN' : s.status === 'lost' ? 'LOSS' : s.status.toUpperCase();
  const head = `<div class="sp-head">${av(s.user)}<div><h1>Slip #${esc(s.id)} <span class="chip ${esc(s.status)}">${chip}</span>${s.test ? ' <span class="chip demo">TEST</span>' : ''}</h1>
    <div class="sp-chips"><b>${esc(s.user)}</b>${t.book ? `<span class="chip">${esc(t.book)}</span>` : ''}${t.sports.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>
    <div class="dim" style="font-size:13px">Logged ${esc(fmtDate(s.createdAt))}${s.settledAt ? ` · settled ${esc(fmtDate(s.settledAt))}` : ''}</div></div></div>`;
  const tiles = `<div class="stats sp-tiles"><div class="card stat"><div class="k">Risk</div><div class="v num">${money(t.risk, $)}</div></div>
    <div class="card stat"><div class="k">Pays</div><div class="v num">${money(t.pays, $)}</div></div>
    <div class="card stat"><div class="k">Net</div><div class="v num ${cls(t.net)}">${t.net == null ? '—' : signed(t.net, $)}</div></div></div>`;
  const legs = `<section class="sec"><div class="sec-head"><h2>Legs</h2><span class="count">${s.legCount}</span></div><div class="card">${t.playType ? `<div class="dim" style="padding:10px 14px 0">${esc(t.playType)}</div>` : ''}
    ${s.legs.map((l) => `<div class="sp-leg">${stIc(l.status)}<div class="x">${esc(l.ticketText)}${l.detail ? `<small>${esc(l.detail)}</small>` : ''}</div><span class="w ${WORD_CLS[l.statusWord] || ''}">${esc(l.statusWord)}${l.actual != null ? ` · ${esc(l.actual)}` : ''}</span></div>`).join('')}</div></section>`;
  const src = s.book ? `<p class="dim" style="font-size:12px">The original screenshot isn’t stored here; it stays in the Discord message the ticket replies to.</p>` : '';
  return back + head + tiles + `<section class="sec">${ticketHtml(s)}</section>` + legs + src + (s.note ? `<div class="card note" style="padding:12px 14px">“${esc(s.note)}”</div>` : '');
}

boot();
