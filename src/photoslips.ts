// Discord-independent core of "post a slip screenshot → confirm card → board".
// Nothing is logged until the poster (or an admin) confirms. The image itself is never stored — only its hash.
import type { Leg, Slip } from './db.ts';
import { DuplicateSlipError, findDuplicate, importSlip, sha256 } from './importer.ts';
import type { Resolver } from './resolve.ts';
import {
  blankSlip, checkSlip, extractSlips, isKalshi, legMissing, legsToText, normalizeRead, textToLegs, toImport, VisionError,
  type Extraction, type XaiOpts,
} from './slipvision.ts';
import { ParseError } from './parse.ts';
import { SlipError } from './store.ts';
import { dayInTz, shortId } from './util.ts';
import type { Ctx } from './views.ts';

export const SUPPORTED_IMAGE = /^image\/(png|jpe?g)$/;
export interface PhotoInput {
  image: Uint8Array; mime: string; userId: string; userName: string; guildId?: string | null; channelId?: string | null; messageId?: string | null;
  sourceUrl?: string | null; isTest?: boolean; now?: Date;
  /** Watched slip channel: offer a (blank) card even when the model sees no slip. */
  forceCard?: boolean;
}
export interface Draft {
  id: string; userId: string; userName: string; guildId: string | null; channelId: string | null; messageId: string | null; sourceUrl: string | null;
  imageKey: string; isTest: boolean; x: Extraction; readError: string | null; createdAt: string;
}
export type ReadOutcome =
  | { kind: 'drafts'; drafts: Draft[]; reread: boolean; usage: any[] }
  | { kind: 'duplicate'; slipId: string }
  | { kind: 'not_slip' }
  | { kind: 'unsupported'; mime: string };
export type ConfirmOutcome =
  | { kind: 'added'; slip: Slip; legs: Leg[]; unresolved: number; problems: string[] }
  | { kind: 'blocked'; missing: string[] }
  | { kind: 'duplicate'; slipId: string }
  | { kind: 'gone' };

const imageKeyFor = (hash: string, idx: number) => `i:${hash}:${idx}`;

function saveDraft(ctx: Ctx, d: Omit<Draft, 'id' | 'createdAt'>): Draft {
  const id = 'D' + shortId(7);
  ctx.db.prepare(`INSERT INTO photo_drafts (id,user_id,user_name,guild_id,channel_id,message_id,source_url,image_key,is_test,data,read_error) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, d.userId, d.userName, d.guildId, d.channelId, d.messageId, d.sourceUrl, d.imageKey, d.isTest ? 1 : 0, JSON.stringify(d.x), d.readError);
  return getDraft(ctx, id)!;
}
export function getDraft(ctx: Ctx, id: string): Draft | null {
  const r = ctx.db.prepare('SELECT * FROM photo_drafts WHERE id = ?').get(id) as any;
  if (!r) return null;
  return { id: r.id, userId: r.user_id, userName: r.user_name, guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id, sourceUrl: r.source_url,
    imageKey: r.image_key, isTest: !!r.is_test, x: JSON.parse(r.data), readError: r.read_error, createdAt: r.created_at };
}
export function deleteDraft(ctx: Ctx, id: string) { ctx.db.prepare('DELETE FROM photo_drafts WHERE id = ?').run(id); }
export function purgeDrafts(ctx: Ctx, maxAgeH = 48) {
  ctx.db.prepare(`DELETE FROM photo_drafts WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`).run(`-${maxAgeH} hours`);
}

/** Read a photo into one confirm-card draft per slip. A failed read still yields a (blank) draft to fill in. */
export async function readPhoto(ctx: Ctx, v: XaiOpts, p: PhotoInput): Promise<ReadOutcome> {
  if (!SUPPORTED_IMAGE.test(p.mime)) return { kind: 'unsupported', mime: p.mime };
  const hash = sha256(p.image);
  const dup = findDuplicate(ctx, p.userId, [imageKeyFor(hash, 0)]);
  if (dup) return { kind: 'duplicate', slipId: dup };
  let slips: Extraction[] = [], readError: string | null = null, reread = false, usage: any[] = [];
  try {
    const r = await extractSlips(p.image, p.mime, v);
    reread = r.reread; usage = r.usage;
    const n = normalizeRead(r.read);
    if (n.notSlip && !p.forceCard) return { kind: 'not_slip' };
    slips = n.slips.length ? n.slips : [blankSlip()];
  } catch (e) {
    if (!(e instanceof VisionError)) throw e;
    readError = e.message; slips = [blankSlip()];
    console.warn('[photo] read failed:', e.message.slice(0, 200));
  }
  const base = { userId: p.userId, userName: p.userName, guildId: p.guildId ?? null, channelId: p.channelId ?? null, messageId: p.messageId ?? null,
    sourceUrl: p.sourceUrl ?? null, isTest: !!p.isTest, readError };
  const drafts = slips.map((x, i) => {
    if (!x.screenshot_date) x.screenshot_date = null;
    return saveDraft(ctx, { ...base, imageKey: imageKeyFor(hash, i), x });
  });
  return { kind: 'drafts', drafts, reread, usage };
}

export interface EditFields { stakePayout?: string; result?: string; odds?: string; date?: string; legs?: string }
/** Apply the Edit form. Throws VisionError with a user-facing message on bad input. */
export function editDraft(ctx: Ctx, id: string, f: EditFields): Draft {
  const d = getDraft(ctx, id);
  if (!d) throw new VisionError('That card expired — post the screenshot again.');
  const x: Extraction = structuredClone(d.x);
  if (f.stakePayout != null) {
    const [a, b] = f.stakePayout.split('/').map((s) => s.replace(/[$,\s]/g, ''));
    const n = (s: string | undefined) => (s == null || s === '' || s === '?' ? null : Number(s));
    const stake = n(a), payout = n(b);
    if ((stake != null && !(stake > 0)) || (payout != null && !(payout >= 0))) throw new VisionError('Stake / payout must look like "55 / 330".');
    x.stake = stake; x.payout = payout;
  }
  if (f.result != null && f.result.trim()) {
    const r = f.result.trim().toLowerCase();
    const m = r === 'win' || r === 'cashed' ? 'won' : r === 'loss' ? 'lost' : r === 'pending' || r === 'live' ? 'open' : r;
    if (!['won', 'lost', 'push', 'void', 'open'].includes(m)) throw new VisionError('Result must be won, lost, push, void or open.');
    x.status = m as Extraction['status'];
  }
  if (f.odds != null) x.odds_text = f.odds.trim() || null;
  if (f.date != null) {
    const t = f.date.trim();
    if (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new VisionError('Games date must be YYYY-MM-DD (or blank).');
    x.games_date = t || null;
  }
  if (f.legs != null) { x.legs = textToLegs(f.legs, x); x.pick_count = x.legs.length; }
  // Edited by a human: their values are the source of truth.
  x.confidence = 'high';
  if (x.status === 'won' && x.legs.length && x.legs.every((l) => l.leg_result === 'push' || l.leg_result === 'void')) x.status = x.legs.every((l) => l.leg_result === 'void') ? 'void' : 'push';
  ctx.db.prepare('UPDATE photo_drafts SET data = ?, read_error = NULL WHERE id = ?').run(JSON.stringify(x), id);
  return getDraft(ctx, id)!;
}

export function editDefaults(d: Draft): Required<EditFields> {
  const x = d.x;
  return {
    stakePayout: `${x.stake ?? '?'} / ${x.payout ?? '?'}`, result: x.status === 'unknown' ? '' : x.status, odds: x.odds_text ?? '',
    date: x.games_date ?? '', legs: legsToText(x) || (isKalshi(x) ? 'Market title | YES = won' : 'Player (TEAM) u19.5 Points = won 19'),
  };
}

/** Log a confirmed draft (same path as the admin import). */
export async function confirmDraft(ctx: Ctx, resolver: Resolver, id: string, now = new Date()): Promise<ConfirmOutcome> {
  const d = getDraft(ctx, id);
  if (!d) return { kind: 'gone' };
  const { blocking } = checkSlip(d.x);
  if (blocking.length) return { kind: 'blocked', missing: blocking };
  const imp = toImport(d.x);
  try {
    const r = await importSlip(ctx, resolver, imp.legs, {
      userId: d.userId, userName: d.userName, title: `${d.isTest ? '[TEST] ' : ''}${imp.title}`.slice(0, 60), stake: imp.stake, odds: imp.odds, source: 'photo',
      guildId: d.guildId, channelId: d.channelId, messageId: d.messageId, sourceUrl: d.sourceUrl,
      date: imp.date, searchBackFrom: imp.searchBackFrom ?? dayInTz(Number.isNaN(Date.parse(d.createdAt)) ? now : new Date(d.createdAt), ctx.tz),
      result: imp.result, allowUnresolved: true, dedupeKeys: [d.imageKey, imp.contentKey],
      book: imp.book, playType: imp.playType, oddsText: imp.oddsText, payout: imp.payout, isTest: d.isTest,
      note: d.x.notes ? `From screenshot · ${d.x.notes}`.slice(0, 300) : 'From screenshot',
    });
    deleteDraft(ctx, id);
    return { kind: 'added', slip: r.slip, legs: r.legs, unresolved: r.unresolved, problems: r.problems };
  } catch (e) {
    if (e instanceof DuplicateSlipError) { deleteDraft(ctx, id); return { kind: 'duplicate', slipId: e.slipId }; }
    if (e instanceof ParseError || e instanceof SlipError) return { kind: 'blocked', missing: [e.message] };
    throw e;
  }
}

const RES_ICON: Record<string, string> = { won: '✅', lost: '❌', push: '➖', void: '⚪', pending: '⏳' };
/** The confirm card text (pure). Blank fields show as ⬜ and block Confirm. */
export function draftCard(d: Draft, index?: { i: number; of: number }): { text: string; canConfirm: boolean } {
  const x = d.x;
  const { blocking, flags } = checkSlip(x);
  const money = (n: number | null) => (n == null ? '⬜ ?' : `$${n.toFixed(2)}`);
  const head = `📸 **${d.isTest ? '[TEST] ' : ''}${x.platform ?? 'Unknown book'}${x.play_type ? ` · ${x.play_type}` : ''}**${index && index.of > 1 ? ` (slip ${index.i}/${index.of})` : ''} — check it, then **Confirm**`;
  const legs = x.legs.map((l, i) => {
    const miss = legMissing(x, l);
    const icon = miss.length ? '⬜' : l.leg_result ? RES_ICON[l.leg_result] : '•';
    const body = isKalshi(x) ? `${l.player ?? '?'} — ${l.stat ?? '?'}`
      : `${l.player ?? '?'}${l.team ? ` (${l.team})` : ''} ${l.direction ?? '?'} ${l.line ?? '?'} ${l.stat ?? '?'}`;
    const warn = miss.length ? ` ⚠️ needs ${miss.join(', ')}` : l.confidence === 'low' ? ' ⚠️ unsure' : '';
    return `${i + 1}. ${icon} ${body}${l.actual != null ? ` — **${l.actual}**` : ''}${l.league ? ` · ${l.league}` : ''}${warn}`;
  });
  const status = x.status === 'unknown' ? '⬜ ?' : x.status;
  const lines = [
    head,
    d.readError ? `⚠️ I couldn't read this image${/^unsupported/.test(d.readError) ? ` (${d.readError})` : ''}. Tap **Edit** to fill it in, or **Cancel**.` : '',
    ...legs,
    `Risk ${money(x.stake)} · Pays ${money(x.payout)}${x.odds_text ? ` · Odds ${x.odds_text}` : ''} · Result ${status}${x.games_date ? ` · Games ${x.games_date}` : ''}`,
    flags.length ? flags.map((f) => `⚠️ ${f}`).join('\n') : '',
    blocking.length ? `⬜ Fill in before confirming: ${blocking.join('; ')}` : '',
    d.isTest ? '🧪 Staff channel: this is a test slip and stays out of the standings.' : '',
    `_Only ${d.userName} or an admin can confirm._`,
  ];
  return { text: lines.filter(Boolean).join('\n').slice(0, 1950), canConfirm: !blocking.length };
}
