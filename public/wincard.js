// PICKS HQ win card — browser canvas only. No network, no images, no new libraries.
// Hidden slips are refused even if a caller still has leg objects; we only draw public wins.
'use strict';
(function () {
  const W = 1080;
  const SANS = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const TZ = 'America/Chicago';

  const font = (weight, size, mono) => `${weight} ${size}px ${mono ? MONO : SANS}`;

  function clean(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || s === 'null' || s === 'undefined' || s === 'NaN') return null;
    return s;
  }
  function finiteNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  function fmtNum(n) {
    const r = Math.round(n * 100) / 100;
    if (Object.is(r, -0)) return '0';
    return String(r);
  }
  function money(n, dollars, signed) {
    if (!Number.isFinite(n)) return null;
    const core = dollars ? `$${Math.abs(n).toFixed(2)}` : `${Math.abs(n).toFixed(2)}u`;
    if (signed) return n > 0 ? `+${core}` : n < 0 ? `-${core}` : core;
    return n < 0 ? `-${core}` : core;
  }
  function signedLine(n) {
    if (n === 0) return 'PK';
    return n > 0 ? `+${fmtNum(n)}` : fmtNum(n);
  }

  function describeLeg(l) {
    if (!l || typeof l !== 'object') return null;
    const player = clean(l.player);
    const team = clean(l.team);
    const stat = clean(l.statLabel) || clean(l.stat);
    const sideRaw = clean(l.side);
    const side = sideRaw && /^over$/i.test(sideRaw) ? 'Over' : sideRaw && /^under$/i.test(sideRaw) ? 'Under' : null;
    const lineN = finiteNum(l.line);
    const lineTxt = lineN == null ? null : fmtNum(lineN);
    const ou = side && lineTxt ? `${side} ${lineTxt}` : side;
    const league = clean(l.leagueLabel);
    const type = (clean(l.type) || '').toLowerCase();
    const ticketText = clean(l.ticketText) || clean(l.text);
    const actualN = finiteNum(l.actual);
    let title = null;
    const bits = [];
    if (player) {
      title = player;
      if (team) bits.push(team);
      if (stat) bits.push(stat);
      if (ou) bits.push(ou);
    } else if (team && (type === 'spread' || type === 'ml' || type === 'total')) {
      title = team;
      if (type === 'ml') bits.push('ML');
      else if (ou) bits.push(ou);
      else if (lineN != null && type === 'spread') bits.push(signedLine(lineN));
      else if (lineTxt) bits.push(lineTxt);
      if (stat) bits.push(stat);
    } else if (ticketText) {
      title = ticketText;
      if (team && !ticketText.includes(team)) bits.push(team);
      if (stat && !ticketText.toLowerCase().includes(stat.toLowerCase())) bits.push(stat);
      if (ou && side && !ticketText.toLowerCase().includes(side.toLowerCase()) && !(lineTxt && ticketText.includes(lineTxt))) bits.push(ou);
    } else if (team) {
      title = team;
      if (stat) bits.push(stat);
      if (ou) bits.push(ou);
      else if (lineN != null) bits.push(signedLine(lineN));
    } else {
      title = 'Pick';
      if (stat) bits.push(stat);
      if (ou) bits.push(ou);
    }
    if (league && !bits.includes(league)) bits.push(league);
    const status = ['won', 'lost', 'push', 'void', 'pending', 'review'].includes(l.status) ? l.status : 'pending';
    return { title, meta: bits.join(' · '), actual: actualN == null ? null : fmtNum(actualN), status };
  }

  function formatSettled(iso) {
    const s = clean(iso);
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    let date;
    try {
      date = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
    } catch { return null; }
    let abbr = 'CT';
    try {
      abbr = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || abbr;
    } catch { /* keep CT */ }
    return `Settled ${date} ${abbr}`;
  }

  function build(slip) {
    if (!slip || typeof slip !== 'object') return { ok: false, reason: 'No slip to draw.' };
    if (slip.hidden) return { ok: false, reason: 'This slip is hidden.' };
    if (String(slip.status || '').toLowerCase() !== 'won') return { ok: false, reason: 'Win cards are for cashed slips.' };
    const ticket = slip.ticket;
    if (!ticket || typeof ticket !== 'object') return { ok: false, reason: 'This slip isn’t available.' };
    if (!Array.isArray(slip.legs) || slip.legs.length === 0) return { ok: false, reason: 'No picks on this slip.' };
    const legs = slip.legs.map(describeLeg).filter(Boolean);
    if (!legs.length) return { ok: false, reason: 'No picks on this slip.' };

    const book = clean(ticket.book) || clean(slip.book);
    const dollars = !!book;
    const playType = clean(ticket.playType) || clean(ticket.playBadge);
    const odds = clean(ticket.oddsAsLogged) || clean(slip.oddsText);
    const riskN = finiteNum(ticket.risk) ?? finiteNum(slip.stake);
    const paysN = finiteNum(ticket.pays);
    const netN = finiteNum(ticket.net) ?? finiteNum(slip.profit);
    const tags = [];
    if (slip.demo || slip.is_demo) tags.push('DEMO');
    if (slip.test || slip.is_test || ticket.isTest) tags.push('TEST');
    const sports = Array.isArray(ticket.sports) ? ticket.sports.map(clean).filter(Boolean) : [];
    const nLegs = finiteNum(ticket.legCount) ?? legs.length;
    const hits = finiteNum(ticket.hits);
    const hitLabel = hits == null ? `${legs.length} LEG${legs.length === 1 ? '' : 'S'}` : `${fmtNum(hits)}/${fmtNum(nLegs)} HIT`;
    const stats = [];
    const stake = riskN == null ? null : money(riskN, dollars, false);
    const pays = paysN == null ? null : money(paysN, dollars, false);
    if (stake) stats.push({ k: dollars ? 'RISK' : 'STAKE', v: stake });
    if (pays) stats.push({ k: 'PAYS', v: pays });
    if (odds) stats.push({ k: 'ODDS', v: odds });

    const card = {
      user: clean(slip.user),
      book, playType, odds, stake, pays,
      net: netN == null ? null : money(netN, dollars, true),
      settled: formatSettled(slip.settledAt),
      tags, sports: sports.join(' · '), hitLabel,
      id: clean(slip.id),
      legs, stats,
      compact: legs.length >= 7,
    };
    return { ok: true, card };
  }

  function ellipsis(ctx, text, maxW) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
    return `${s}…`;
  }
  function fitSize(ctx, text, maxW, weight, size, min, mono) {
    let s = size;
    while (s > min) {
      ctx.font = font(weight, s, mono);
      if (ctx.measureText(text).width <= maxW) return s;
      s -= 2;
    }
    ctx.font = font(weight, min, mono);
    return min;
  }
  function spacedWidth(ctx, text, tracking) {
    let w = 0;
    for (const ch of text) w += ctx.measureText(ch).width + tracking;
    return Math.max(0, w - tracking);
  }
  function fillSpaced(ctx, text, x, y, tracking) {
    const prev = ctx.textAlign;
    ctx.textAlign = 'left';
    for (const ch of text) {
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width + tracking;
    }
    ctx.textAlign = prev;
  }
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  function gold(ctx, x, y, w) {
    const g = ctx.createLinearGradient(x, y, x + Math.max(w, 1), y);
    g.addColorStop(0, '#f2c94c');
    g.addColorStop(0.55, '#d4af37');
    g.addColorStop(1, '#a8832a');
    return g;
  }

  function drawSigil(ctx, x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 512, size / 512);
    ctx.beginPath();
    ctx.arc(256, 256, 214, 0, Math.PI * 2);
    ctx.strokeStyle = gold(ctx, 40, 40, 430);
    ctx.lineWidth = 16;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(256, 256, 188, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(200,16,46,0.16)';
    ctx.fill();
    const bird = ctx.createLinearGradient(0, 140, 0, 420);
    bird.addColorStop(0, '#ff2a45');
    bird.addColorStop(0.55, '#c8102e');
    bird.addColorStop(1, '#8b0000');
    ctx.fillStyle = bird;
    for (const d of [
      'M256 150c26 52 34 112 0 236c-34-124-26-184 0-236z',
      'M244 262C200 214 140 186 76 190c52 18 98 52 132 104c12-14 24-24 36-32z',
      'M268 262c44-48 104-76 168-72c-52 18-98 52-132 104c-12-14-24-24-36-32z',
      'M240 318c-44 4-88 26-118 64c40-18 80-24 124-18z',
      'M272 318c44 4 88 26 118 64c-40-18-80-24-124-18z',
    ]) ctx.fill(new Path2D(d));
    ctx.beginPath();
    ctx.arc(256, 232, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#f2c94c';
    ctx.fill();
    ctx.restore();
  }

  function drawMark(ctx, cx, cy, status, r) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    const stroke = (color, fill) => {
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (status === 'won') {
      stroke('#e2c044', 'rgba(212,175,55,0.18)');
      ctx.beginPath();
      ctx.strokeStyle = '#f2c94c';
      ctx.lineWidth = 3.5;
      ctx.moveTo(cx - r * 0.38, cy + r * 0.02);
      ctx.lineTo(cx - r * 0.08, cy + r * 0.34);
      ctx.lineTo(cx + r * 0.42, cy - r * 0.32);
      ctx.stroke();
    } else if (status === 'lost') {
      stroke('#ff4d5e', 'rgba(200,16,46,0.24)');
      ctx.beginPath();
      ctx.strokeStyle = '#ff4d5e';
      ctx.lineWidth = 3.5;
      const d = r * 0.32;
      ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
      ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
      ctx.stroke();
    } else if (status === 'push') {
      stroke('#c4b5e6', 'rgba(196,181,230,0.16)');
      ctx.beginPath();
      ctx.strokeStyle = '#c4b5e6';
      ctx.lineWidth = 3.5;
      ctx.moveTo(cx - r * 0.36, cy);
      ctx.lineTo(cx + r * 0.36, cy);
      ctx.stroke();
    } else {
      stroke('#8f8387', 'rgba(255,255,255,0.06)');
      ctx.beginPath();
      ctx.strokeStyle = '#8f8387';
      ctx.lineWidth = 2.5;
      ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function chipStyle(kind) {
    if (kind === 'book') return { bg: '#c8102e', fg: '#fff7ea', stroke: 'rgba(212,175,55,0.7)' };
    if (kind === 'play') return { bg: 'rgba(255,255,255,0.06)', fg: '#f2c94c', stroke: 'rgba(212,175,55,0.5)' };
    return { bg: 'rgba(234,179,8,0.14)', fg: '#fde68a', stroke: 'rgba(234,179,8,0.45)' };
  }

  function drawChips(ctx, draw, labels, x, y, maxW) {
    if (!labels.length) return y;
    const h = 44;
    const gap = 10;
    let cx = x;
    let cy = y;
    for (const lab of labels) {
      ctx.font = font(800, 20);
      ctx.textBaseline = 'middle';
      const text = ellipsis(ctx, lab.text, Math.max(40, maxW - 36));
      const rw = Math.min(maxW, ctx.measureText(text).width + 36);
      if (cx > x && cx + rw > x + maxW) { cx = x; cy += h + gap; }
      if (draw) {
        const st = chipStyle(lab.kind);
        roundRect(ctx, cx, cy, rw, h, h / 2);
        ctx.fillStyle = st.bg;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = st.stroke;
        ctx.stroke();
        ctx.fillStyle = st.fg;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = font(800, 20);
        ctx.fillText(text, cx + 18, cy + h / 2 + 1);
      }
      cx += rw + gap;
    }
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    return cy + h;
  }

  function drawStats(ctx, draw, stats, x, y, width) {
    const gap = 14;
    const n = stats.length;
    const cw = (width - gap * (n - 1)) / n;
    const h = 122;
    stats.forEach((s, i) => {
      const sx = x + i * (cw + gap);
      ctx.font = font(800, 34, true);
      const size = fitSize(ctx, s.v, cw - 28, 800, n > 2 ? 32 : 36, 16, true);
      if (!draw) return;
      roundRect(ctx, sx, y, cw, h, 20);
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(212,175,55,0.32)';
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = font(700, 16);
      ctx.fillStyle = '#8f8387';
      fillSpaced(ctx, s.k, sx + cw / 2 - spacedWidth(ctx, s.k, 2.4) / 2, y + 24, 2.4);
      ctx.font = font(800, size, true);
      ctx.fillStyle = '#fbf3e0';
      ctx.fillText(ellipsis(ctx, s.v, cw - 24), sx + cw / 2, y + 58);
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    return y + h;
  }

  function renderCard(ctx, card, draw, knownH) {
    const pad = 72;
    const left = pad;
    const right = W - pad;
    const contentW = right - left;
    const sigil = 150;
    const sigilX = right - sigil;
    const sigilY = 52;
    const textMax = Math.max(280, sigilX - 28 - left);
    const paint = (fn) => { if (draw) fn(); };

    if (draw) {
      const h = knownH || W;
      ctx.fillStyle = '#0b0b0d';
      ctx.fillRect(0, 0, W, h);
      const g1 = ctx.createRadialGradient(80, 0, 20, 80, 40, W * 0.85);
      g1.addColorStop(0, 'rgba(200,16,46,0.42)');
      g1.addColorStop(1, 'rgba(200,16,46,0)');
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, W, h);
      const g2 = ctx.createRadialGradient(W, 0, 10, W, 0, W * 0.7);
      g2.addColorStop(0, 'rgba(91,42,134,0.28)');
      g2.addColorStop(1, 'rgba(91,42,134,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, W, h);
      const g3 = ctx.createRadialGradient(W * 0.5, h, 20, W * 0.5, h, h * 0.55);
      g3.addColorStop(0, 'rgba(139,0,0,0.35)');
      g3.addColorStop(1, 'rgba(139,0,0,0)');
      ctx.fillStyle = g3;
      ctx.fillRect(0, 0, W, h);
      const bar = ctx.createLinearGradient(0, 0, W, 0);
      bar.addColorStop(0, '#8b0000');
      bar.addColorStop(0.5, '#c8102e');
      bar.addColorStop(1, '#d4af37');
      ctx.fillStyle = bar;
      ctx.fillRect(0, 0, W, 12);
      ctx.fillStyle = gold(ctx, 0, 0, W);
      ctx.fillRect(0, h - 10, W, 10);
      roundRect(ctx, 26, 28, W - 52, h - 54, 36);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(212,175,55,0.55)';
      ctx.stroke();
      drawSigil(ctx, sigilX, sigilY, sigil);
    }

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    let y = 58;
    ctx.font = font(800, 22);
    paint(() => {
      ctx.fillStyle = '#f4eee6';
      fillSpaced(ctx, 'PICKS', left, y, 2.6);
      const pw = spacedWidth(ctx, 'PICKS', 2.6);
      ctx.fillStyle = '#f2c94c';
      ctx.fillText('HQ', left + pw + 10, y);
    });
    y += 40;
    ctx.font = font(800, 26);
    paint(() => {
      ctx.fillStyle = gold(ctx, left, y, spacedWidth(ctx, 'CASHED', 6));
      fillSpaced(ctx, 'CASHED', left, y, 6);
    });
    y += 46;
    if (card.user) {
      ctx.font = font(800, 54);
      const name = ellipsis(ctx, card.user, textMax);
      paint(() => { ctx.fillStyle = '#fbf3e0'; ctx.font = font(800, 54); ctx.fillText(name, left, y); });
      y += 68;
    }
    const labels = [];
    if (card.book) labels.push({ kind: 'book', text: card.book.toUpperCase() });
    if (card.playType) labels.push({ kind: 'play', text: card.playType });
    for (const t of card.tags) labels.push({ kind: 'tag', text: t });
    const chipMax = y + 44 < sigilY + sigil ? textMax : contentW;
    if (labels.length) {
      y = drawChips(ctx, draw, labels, left, y, chipMax);
      y += 8;
    }
    y = Math.max(y, sigilY + sigil) + 26;

    if (card.net) {
      const size = fitSize(ctx, card.net, contentW - 16, 800, 92, 48, true);
      paint(() => {
        ctx.textAlign = 'center';
        ctx.font = font(800, size, true);
        ctx.fillStyle = gold(ctx, W / 2 - 280, y, 560);
        ctx.fillText(card.net, W / 2, y);
        ctx.font = font(800, 16);
        ctx.fillStyle = '#d4af37';
        const nw = spacedWidth(ctx, 'NET', 4);
        fillSpaced(ctx, 'NET', W / 2 - nw / 2, y + size + 8, 4);
      });
      y += size + 40;
      ctx.textAlign = 'left';
    }

    if (card.stats.length) {
      y = drawStats(ctx, draw, card.stats, left, y, contentW);
      y += 8;
    }
    if (card.settled) {
      y += 16;
      ctx.font = font(600, 22);
      paint(() => {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#bdb1b4';
        ctx.font = font(600, 22);
        ctx.fillText(card.settled, W / 2, y);
      });
      y += 32;
      ctx.textAlign = 'left';
    }

    y += 22;
    paint(() => {
      ctx.strokeStyle = 'rgba(212,175,55,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    });
    y += 20;
    ctx.font = font(800, 18);
    paint(() => {
      ctx.font = font(800, 18);
      ctx.fillStyle = '#d4af37';
      fillSpaced(ctx, 'PICKS', left, y, 2.2);
      let sx = left + spacedWidth(ctx, 'PICKS', 2.2) + 16;
      if (card.sports) {
        ctx.font = font(600, 18);
        ctx.fillStyle = '#8f8387';
        ctx.fillText(ellipsis(ctx, card.sports, right - 220 - sx), sx, y);
      }
      ctx.font = font(800, 18, true);
      ctx.fillStyle = '#f2c94c';
      ctx.textAlign = 'right';
      ctx.fillText(card.hitLabel, right, y);
      ctx.textAlign = 'left';
    });
    y += 36;

    const rowH = card.compact ? 78 : 106;
    const titleSize = card.compact ? 26 : 30;
    const metaSize = card.compact ? 18 : 20;
    const markR = card.compact ? 15 : 18;
    card.legs.forEach((leg, i) => {
      const markCx = left + markR;
      const markCy = y + rowH / 2;
      const textX = markCx + markR + 18;
      const actualCol = 148;
      const textW = right - textX - actualCol;
      ctx.font = font(700, titleSize);
      const title = ellipsis(ctx, leg.title, textW);
      ctx.font = font(600, metaSize);
      const meta = leg.meta ? ellipsis(ctx, leg.meta, textW) : '';
      paint(() => {
        drawMark(ctx, markCx, markCy, leg.status, markR);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = font(700, titleSize);
        ctx.fillStyle = leg.status === 'lost' ? '#e7d4d4' : '#f4eee6';
        const titleY = meta ? y + (card.compact ? 14 : 22) : y + (rowH - titleSize) / 2;
        ctx.fillText(title, textX, titleY);
        if (meta) {
          ctx.font = font(600, metaSize);
          ctx.fillStyle = '#8f8387';
          ctx.fillText(meta, textX, titleY + titleSize + 6);
        }
        if (leg.actual) {
          ctx.textAlign = 'right';
          ctx.font = font(800, card.compact ? 26 : 30, true);
          ctx.fillStyle = leg.status === 'won' ? '#e2c044' : leg.status === 'lost' ? '#ff4d5e' : '#f4eee6';
          ctx.fillText(leg.actual, right, titleY);
          ctx.font = font(700, 12);
          ctx.fillStyle = '#8f8387';
          fillSpaced(ctx, 'FINAL', right - spacedWidth(ctx, 'FINAL', 1.4), titleY + (card.compact ? 30 : 36), 1.4);
          ctx.textAlign = 'left';
        }
        if (i < card.legs.length - 1) {
          ctx.strokeStyle = 'rgba(212,175,55,0.14)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(textX, y + rowH);
          ctx.lineTo(right, y + rowH);
          ctx.stroke();
        }
      });
      y += rowH;
    });

    y += 28;
    paint(() => {
      ctx.font = font(700, 20, true);
      ctx.fillStyle = '#8f8387';
      ctx.textAlign = 'left';
      if (card.id) ctx.fillText(`#${card.id}`, left, y);
      ctx.font = font(800, 16);
      ctx.fillStyle = '#d4af37';
      ctx.textAlign = 'right';
      const brand = 'PICKS HQ';
      fillSpaced(ctx, brand, right - spacedWidth(ctx, brand, 2), y + 2, 2);
      ctx.textAlign = 'left';
    });
    y += 36;
    return y + 40;
  }

  function exportScale(height) {
    const area = (s) => W * s * height * s;
    if (area(2) <= 12_000_000) return 2;
    return 1;
  }

  async function fontsReady() {
    const ready = document.fonts && document.fonts.ready;
    if (!ready || typeof ready.then !== 'function') return;
    await Promise.race([ready.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  }

  async function renderPng(slip) {
    await fontsReady();
    const built = build(slip);
    if (!built.ok) { const err = new Error(built.reason); err.reason = built.reason; throw err; }
    const scratch = document.createElement('canvas').getContext('2d');
    scratch.textBaseline = 'top';
    const height = Math.ceil(renderCard(scratch, built.card, false));
    const scale = exportScale(height);
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    renderCard(ctx, built.card, true, height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not export the win card.'))), 'image/png');
    });
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('Could not read the win card.'));
      fr.readAsDataURL(blob);
    });
    return { blob, dataUrl, width: canvas.width, height: canvas.height, card: built.card };
  }

  function fileName(card) {
    const id = String(card.id || 'slip').replace(/[^A-Za-z0-9_-]/g, '') || 'slip';
    return `picks-hq-${id}-win.png`;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  let gen = 0;
  let lastFocus = null;

  function close() {
    gen++;
    const modal = document.getElementById('wc-modal');
    if (modal) modal.remove();
    document.body.style.overflow = '';
    const app = document.getElementById('app');
    if (app) app.inert = false;
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
  }

  function shell() {
    close();
    const mine = gen;
    lastFocus = document.activeElement;
    const modal = document.createElement('div');
    modal.id = 'wc-modal';
    modal.className = 'wc-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'wc-title');
    modal.innerHTML = `<div class="wc-panel" role="document">
      <div class="wc-hd"><div class="wc-title" id="wc-title">Win card</div><button type="button" class="wc-x" aria-label="Close">×</button></div>
      <div class="wc-status">Drawing win card…</div>
      <img class="wc-img" alt="" hidden>
      <div class="wc-bar" hidden>
        <button type="button" class="btn wc-save">Save</button>
        <button type="button" class="btn wc-share">Share</button>
      </div>
      <p class="wc-note"></p>
    </div>`;
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('.wc-x').addEventListener('click', close);
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';
    const app = document.getElementById('app');
    if (app) app.inert = true;
    modal.querySelector('.wc-x').focus();
    return { modal, mine };
  }

  async function open(slip) {
    const { modal, mine } = shell();
    const status = modal.querySelector('.wc-status');
    const img = modal.querySelector('.wc-img');
    const bar = modal.querySelector('.wc-bar');
    const note = modal.querySelector('.wc-note');
    let png = null;
    try { png = await renderPng(slip); }
    catch (e) {
      if (mine !== gen) return;
      status.textContent = e.reason || e.message || 'Could not draw this win card.';
      return;
    }
    if (mine !== gen) return;
    const name = fileName(png.card);
    const file = new File([png.blob], name, { type: 'image/png' });
    let canShare = false;
    try { canShare = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch { canShare = false; }
    status.hidden = true;
    img.hidden = false;
    img.src = png.dataUrl;
    img.alt = png.card.user ? `Win card for ${png.card.user}` : 'Win card';
    bar.hidden = false;
    const shareBtn = modal.querySelector('.wc-share');
    if (!canShare) shareBtn.hidden = true;
    const save = () => download(png.blob, name);
    modal.querySelector('.wc-save').addEventListener('click', save);
    shareBtn.addEventListener('click', async () => {
      if (!canShare) { save(); return; }
      const text = png.card.user ? `${png.card.user} cashed${png.card.net ? ` ${png.card.net}` : ''} on PICKS HQ` : 'Cashed on PICKS HQ';
      try { await navigator.share({ files: [file], title: 'PICKS HQ win', text }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
      try { await navigator.share({ files: [file] }); return; }
      catch (e2) { if (e2 && e2.name === 'AbortError') return; }
      save();
    });
    const touch = navigator.maxTouchPoints > 0;
    note.textContent = touch
      ? 'Long-press the image to save it to Photos.'
      : (canShare ? '' : '');
  }

  window.PicksWinCard = { build, renderPng, open, close };
})();
