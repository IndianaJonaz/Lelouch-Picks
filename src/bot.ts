// Discord bot. Starts only when DISCORD_BOT_TOKEN is set; the web app never depends on it.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle, type ButtonInteraction, type ChatInputCommandInteraction, type Interaction, type Message, type ModalSubmitInteraction,
} from 'discord.js';
import { confirmDraft, deleteDraft, draftCard, editDefaults, editDraft, getDraft, purgeDrafts, readPhoto, type Draft } from './photoslips.ts';
import { VisionError, type XaiOpts } from './slipvision.ts';
import type { APIEmbed } from 'discord.js';
import { getSlip } from './db.ts';
import type { Auth } from './auth.ts';
import { getLegs, type Leg, type Slip } from './db.ts';
import type { Engine, SettledEvent } from './engine.ts';
import { ParseError, splitLegs } from './parse.ts';
import type { Resolver, ResolvedLeg } from './resolve.ts';
import { createSlip, deleteSlip, isPublic, manualSettle, revealSlip, setPoster, SlipError, slipWithLegs } from './store.ts';
import { dayInTz, fmtOdds } from './util.ts';
import { boardView, leaderboard, legText, liveView, slipView, type Ctx } from './views.ts';

const BRAND = 0xc8102e; // Geass theme: Britannia crimson
const WON = 0xd4af37; // imperial gold
const LOST = 0x8b0000; // deep blood crimson
const ICON: Record<string, string> = { pending: '⏳', won: '✅', lost: '❌', push: '➖', void: '⚪', review: '🔎', open: '🟣' };
const units = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}u`);
const bar = (pct: number | null, width = 10) => { const n = Math.round(Math.max(0, Math.min(1, pct ?? 0)) * width); return '▰'.repeat(n) + '▱'.repeat(width - n); };

export const commands = [
  new SlashCommandBuilder().setName('pick').setDescription('Post a slip (leave legs empty to open a multi-line form)')
    .addStringOption((o) => o.setName('legs').setDescription('e.g. "Jokic o10.5 reb; GB -3.5; CAR/GB u47.5" — separate legs with ;'))
    .addNumberOption((o) => o.setName('stake').setDescription('Units risked (default 1)').setMinValue(0.01).setMaxValue(1000))
    .addIntegerOption((o) => o.setName('odds').setDescription('American odds for the whole slip, e.g. 450 or -110'))
    .addBooleanOption((o) => o.setName('hidden').setDescription('Keep the legs hidden until you /reveal (or it settles)'))
    .addStringOption((o) => o.setName('title').setDescription('Optional name, e.g. "TNF sweat"').setMaxLength(60))
    .addStringOption((o) => o.setName('note').setDescription('Optional write-up / reasoning').setMaxLength(500)),
  new SlashCommandBuilder().setName('slips').setDescription('Open slips')
    .addUserOption((o) => o.setName('user').setDescription('Only this member')),
  new SlashCommandBuilder().setName('slip').setDescription('Show one slip').addStringOption((o) => o.setName('id').setDescription('Slip id').setRequired(true)),
  new SlashCommandBuilder().setName('live').setDescription('Live games with every public leg and pace bars'),
  new SlashCommandBuilder().setName('board').setDescription('Open slips, tonight’s poster, recent results'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Ranked by profit (units), not volume')
    .addStringOption((o) => o.setName('period').setDescription('Window').addChoices({ name: 'All time', value: 'all' }, { name: 'Last 30 days', value: '30d' }, { name: 'Last 7 days', value: '7d' }, { name: 'Today', value: 'today' })),
  new SlashCommandBuilder().setName('dashboard').setDescription('Get the dashboard link and today’s access key (only you see it)'),
  new SlashCommandBuilder().setName('reveal').setDescription('Reveal one of your hidden slips').addStringOption((o) => o.setName('id').setDescription('Slip id').setRequired(true)),
  new SlashCommandBuilder().setName('delete').setDescription('Delete one of your slips before its games start').addStringOption((o) => o.setName('id').setDescription('Slip id').setRequired(true)),
  new SlashCommandBuilder().setName('poster').setDescription('Admin: pin a slip as tonight’s poster').addStringOption((o) => o.setName('id').setDescription('Slip id').setRequired(true)),
  new SlashCommandBuilder().setName('settle').setDescription('Admin: manually settle a slip that needs review')
    .addStringOption((o) => o.setName('id').setDescription('Slip id').setRequired(true))
    .addStringOption((o) => o.setName('result').setDescription('Result').setRequired(true).addChoices({ name: 'won', value: 'won' }, { name: 'lost', value: 'lost' }, { name: 'push', value: 'push' }, { name: 'void', value: 'void' }))
    .addNumberOption((o) => o.setName('profit').setDescription('Profit in units (negative for a loss)').setRequired(true)),
  new SlashCommandBuilder().setName('rotatekey').setDescription('Admin: rotate today’s dashboard key now')
    .addBooleanOption((o) => o.setName('signout').setDescription('Also sign out every dashboard session')),
].map((c) => c.toJSON());

export interface BotDeps {
  ctx: Ctx; auth: Auth; resolver: Resolver; engine: Engine; token: string; guildId: string; adminRoles: string[]; publicUrl: string; groupName: string;
  /** Screenshot reading (xAI). null = feature off. */
  vision?: XaiOpts | null;
  /** Only read screenshots in these channels (or threads under them). Empty = any channel the bot can see. */
  slipChannelIds?: string[];
  /** Staff channels: screenshots there become test slips, kept out of standings. */
  staffChannelIds?: string[];
}

const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Intents the bot needs. Reading screenshots needs message events + the privileged Message Content intent. */
export function botIntents(visionOn: boolean): GatewayIntentBits[] {
  return visionOn ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : [GatewayIntentBits.Guilds];
}

/** Ticket embed for a logged slip (pure data, so it is tested without Discord). Everything comes from slipView/ticket(). */
export function ticketEmbed(v: ReturnType<typeof slipView>, publicUrl: string, tz: string): APIEmbed {
  const t = v.ticket;
  if (!t) return { color: BRAND, title: `🔒 Hidden slip · #${v.id}` };
  const money = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);
  const net = t.net == null ? '' : ` · net ${t.net > 0 ? '+' : t.net < 0 ? '−' : ''}${money(Math.abs(t.net))}`;
  const badge = [t.book ? `**${t.book.toUpperCase()}**` : null, t.playBadge ? `\`${t.playBadge}\`` : null, t.isTest ? '`TEST`' : null].filter(Boolean).join('  ');
  const color = v.status === 'won' ? WON : v.status === 'lost' ? LOST : v.status === 'review' ? 0xf59e0b : v.status === 'open' ? BRAND : 0x94a3b8;
  const rows = v.legs.map((l) => `${ICON[l.status] ?? '•'} ${l.ticketText}${l.actual != null ? ` — **${l.actual}**` : ''} · _${l.statusWord}_`);
  const logged = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(v.createdAt.endsWith('Z') ? v.createdAt : v.createdAt + 'Z'));
  return {
    color, url: `${publicUrl}/slip/${v.id}`,
    author: { name: badge.replace(/[*`]/g, '') || 'Slip' },
    title: `${money(t.risk)} → ${money(t.pays)}   ·   #${v.id}`,
    description: [
      `${badge}`,
      `${t.sports.join(' / ')} · ${t.legCount} leg${t.legCount === 1 ? '' : 's'} · **${t.hits}/${t.legCount} HIT**`,
      `**${t.statusLine}**${net}${t.oddsAsLogged ? ` · odds ${t.oddsAsLogged}` : ''}`,
      '',
      ...rows,
    ].join('\n').slice(0, 4000),
    thumbnail: v.legs.find((l) => l.headshot)?.headshot ? { url: v.legs.find((l) => l.headshot)!.headshot! } : undefined,
    footer: { text: `logged by ${v.user} · ${logged} CT${t.isTest ? ' · test slip (not in standings)' : ''}` },
  };
}

const UNSUPPORTED_REPLY = (mime: string) => /heic|heif/i.test(mime)
  ? '📷 iPhone HEIC photos can’t be read yet — please send a screenshot (PNG) or a JPG of the slip.'
  : `📷 I can only read PNG or JPG slip images (that one was ${mime || 'unknown'}).`;

export class Bot {
  status: { status: string; detail: string | null; tag: string | null } = { status: 'idle', detail: 'DISCORD_BOT_TOKEN not set — bot disabled, web app running', tag: null };
  private client: Client | null = null;
  private announcing = false;
  private d: BotDeps;
  constructor(d: BotDeps) { this.d = d; }

  async start(): Promise<void> {
    if (!this.d.token) return;
    this.status = { status: 'connecting', detail: 'logging in to Discord…', tag: null };
    const client = new Client({ intents: botIntents(!!this.d.vision) });
    this.client = client;
    client.once(Events.ClientReady, async (c) => {
      this.status = { status: 'ok', detail: `connected as ${c.user.tag} · ${c.guilds.cache.size} server(s)`, tag: c.user.tag };
      try {
        if (this.d.guildId) await c.application.commands.set(commands, this.d.guildId);
        else await c.application.commands.set(commands);
        console.log(`[bot] ready as ${c.user.tag}; ${commands.length} commands registered ${this.d.guildId ? 'to guild ' + this.d.guildId : 'globally'}`);
      } catch (e) { console.error('[bot] command registration failed', e); this.status.detail += ' · command registration failed: ' + (e as Error).message; }
    });
    client.on(Events.InteractionCreate, (i) => this.onInteraction(i).catch((e) => console.error('[bot] interaction error', e)));
    if (this.d.vision) {
      client.on(Events.MessageCreate, (m) => this.onMessage(m).catch((e) => console.error('[bot] screenshot import error', e)));
      console.log(`[bot] slip screenshots: on (${this.d.slipChannelIds?.length ? this.d.slipChannelIds.length + ' channel(s)' : 'any channel'})`);
    }
    client.on(Events.ShardDisconnect, () => { this.status = { ...this.status, status: 'down', detail: 'disconnected from gateway, reconnecting' }; });
    client.on(Events.ShardResume, () => { this.status = { ...this.status, status: 'ok', detail: `connected as ${this.status.tag}` }; });
    client.on(Events.Error, (e) => { this.status = { ...this.status, status: 'down', detail: e.message }; });
    if (!this.announcing) { this.announcing = true; this.d.engine.on('settled', (e: SettledEvent) => this.announce(e).catch(() => {})); }
    try { await client.login(this.d.token); }
    catch (e) {
      // Message Content is a privileged intent: if it isn't enabled in the Developer Portal, keep the bot up without screenshots.
      if (this.d.vision && /disallowed intents/i.test((e as Error).message)) {
        console.warn('[bot] Message Content intent not enabled in the Discord Developer Portal — slip screenshots disabled; slash commands still work.');
        await client.destroy().catch(() => {});
        this.d = { ...this.d, vision: null };
        return this.start();
      }
      this.status = { status: 'down', detail: `login failed: ${(e as Error).message}`, tag: null }; console.error('[bot] login failed:', (e as Error).message); }
  }

  async stop() { await this.client?.destroy(); }

  private isAdmin(i: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction) {
    if (i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    const roles = (i.member as any)?.roles;
    const ids: string[] = Array.isArray(roles) ? roles : roles?.cache ? [...roles.cache.keys()] : [];
    return this.d.adminRoles.some((r) => ids.includes(r));
  }

  private async onInteraction(i: Interaction) {
    if (i.isModalSubmit() && i.customId.startsWith('pick:')) return this.onPickModal(i);
    if (i.isButton() && i.customId.startsWith('photodel:')) return this.onPhotoDelete(i);
    if (i.isButton() && i.customId.startsWith('pd:')) return this.onDraftButton(i);
    if (i.isModalSubmit() && i.customId.startsWith('pdm:')) return this.onDraftModal(i);
    if (!i.isChatInputCommand()) return;
    try {
      switch (i.commandName) {
        case 'pick': return await this.cmdPick(i);
        case 'slips': return await this.cmdSlips(i);
        case 'slip': return await this.cmdSlip(i);
        case 'live': return await this.cmdLive(i);
        case 'board': return await this.cmdBoard(i);
        case 'leaderboard': return await this.cmdLeaderboard(i);
        case 'dashboard': return await i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(BRAND).setTitle(`${this.d.groupName} dashboard`).setURL(this.d.publicUrl)
          .setDescription(`**Link:** ${this.d.publicUrl}\n**Today’s key:** \`${this.d.auth.keyFor()}\`\n\nKeys rotate daily at midnight (${this.d.ctx.tz}). Tick *Keep me signed in* to stay in for 30 days. On iPhone: Share → Add to Home Screen.`)] });
        case 'reveal': { const s = revealSlip(this.d.ctx.db, i.options.getString('id', true), i.user.id, this.isAdmin(i)); this.d.engine.emit('tick', { changed: [s.id] }); return await i.reply({ embeds: [this.slipEmbed(s, getLegs(this.d.ctx.db, s.id), '🔓 Revealed')] }); }
        case 'delete': deleteSlip(this.d.ctx.db, i.options.getString('id', true), i.user.id, this.isAdmin(i)); this.d.engine.emit('tick', { changed: [] }); return await i.reply({ ephemeral: true, content: 'Slip deleted.' });
        case 'poster': if (!this.isAdmin(i)) throw new SlipError('Admins only.'); setPoster(this.d.ctx.db, i.options.getString('id', true), dayInTz(new Date(), this.d.ctx.tz)); this.d.engine.emit('tick', { changed: [] }); return await i.reply({ content: `📌 Slip \`${i.options.getString('id', true).toUpperCase()}\` is tonight’s poster.` });
        case 'settle': if (!this.isAdmin(i)) throw new SlipError('Admins only.'); manualSettle(this.d.ctx.db, i.options.getString('id', true), i.options.getString('result', true) as any, i.options.getNumber('profit', true)); this.d.engine.emit('tick', { changed: [] }); return await i.reply({ content: `Settled \`${i.options.getString('id', true).toUpperCase()}\` as ${i.options.getString('result', true)} (${units(i.options.getNumber('profit', true))}).` });
        case 'rotatekey': { if (!this.isAdmin(i)) throw new SlipError('Admins only.'); if (i.options.getBoolean('signout')) this.d.auth.revokeAll(); const k = this.d.auth.rotate(); return await i.reply({ ephemeral: true, content: `New key for today: \`${k}\`${i.options.getBoolean('signout') ? ' · all sessions signed out' : ''}` }); }
      }
    } catch (e) {
      const msg = e instanceof ParseError || e instanceof SlipError ? e.message : 'Something went wrong — check the bot logs.';
      if (!(e instanceof ParseError || e instanceof SlipError)) console.error('[bot]', e);
      if (i.deferred || i.replied) await i.editReply({ content: `⚠️ ${msg}`, embeds: [] }); else await i.reply({ ephemeral: true, content: `⚠️ ${msg}` });
    }
  }

  private async cmdPick(i: ChatInputCommandInteraction) {
    const legs = i.options.getString('legs');
    const opts = { stake: i.options.getNumber('stake') ?? 1, odds: i.options.getInteger('odds'), hidden: !!i.options.getBoolean('hidden'), title: i.options.getString('title'), note: i.options.getString('note') };
    if (!legs) {
      const m = new ModalBuilder().setCustomId(`pick:${opts.hidden ? 1 : 0}`).setTitle(opts.hidden ? 'New hidden slip' : 'New slip');
      const ti = (id: string, label: string, style: TextInputStyle, req: boolean, ph: string, val?: string) => new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(req).setPlaceholder(ph).setValue(val ?? ''));
      m.addComponents(
        ti('legs', 'Legs — one per line', TextInputStyle.Paragraph, true, 'Jokic o10.5 reb\nGB -3.5\nCAR/GB u47.5\nJosh Jacobs anytime td (+110)'),
        ti('stake', 'Stake (units)', TextInputStyle.Short, true, '1', String(opts.stake)),
        ti('odds', 'Slip odds (American) — or put odds on each leg', TextInputStyle.Short, false, '+450', opts.odds != null ? String(opts.odds) : undefined),
        ti('title', 'Title (optional)', TextInputStyle.Short, false, 'TNF sweat', opts.title ?? undefined),
        ti('note', 'Write-up (optional)', TextInputStyle.Paragraph, false, 'Why I like it', opts.note ?? undefined),
      );
      return i.showModal(m);
    }
    await i.deferReply({ ephemeral: opts.hidden });
    await this.finishPick(i, legs, opts);
  }

  private async onPickModal(i: ModalSubmitInteraction) {
    const hidden = i.customId === 'pick:1';
    await i.deferReply({ ephemeral: hidden });
    const oddsRaw = i.fields.getTextInputValue('odds').trim();
    try {
      await this.finishPick(i, i.fields.getTextInputValue('legs'), {
        stake: Number(i.fields.getTextInputValue('stake') || 1), odds: oddsRaw ? Number(oddsRaw.replace(/^\+/, '')) : null, hidden,
        title: i.fields.getTextInputValue('title') || null, note: i.fields.getTextInputValue('note') || null,
      });
    } catch (e) { await i.editReply({ content: `⚠️ ${(e as Error).message}` }); }
  }

  private async finishPick(i: ChatInputCommandInteraction | ModalSubmitInteraction, text: string, o: { stake: number; odds: number | null; hidden: boolean; title: string | null; note: string | null }) {
    const parts = splitLegs(text);
    const resolved: ResolvedLeg[] = [];
    const errors: string[] = [];
    for (const p of parts) { try { resolved.push(await this.d.resolver.resolve(p, { tz: this.d.ctx.tz, leagues: this.d.ctx.leagues })); } catch (e) { errors.push(`• ${(e as Error).message}`); } }
    if (errors.length) throw new ParseError(`Nothing saved — fix these leg(s):\n${errors.join('\n')}`);
    const slip = createSlip(this.d.ctx.db, { user_id: i.user.id, user_name: (i.member as any)?.displayName ?? i.user.globalName ?? i.user.username, ...o, source: 'discord', guild_id: i.guildId, channel_id: i.channelId }, resolved);
    this.d.engine.poke();
    this.d.engine.emit('tick', { changed: [slip.id] });
    const legs = getLegs(this.d.ctx.db, slip.id);
    await i.editReply({ embeds: [this.slipEmbed(slip, legs, o.hidden ? '🔒 Hidden slip saved (only you can see this)' : undefined, true)] });
    if (o.hidden && i.channel && 'send' in i.channel) {
      await (i.channel as any).send({ content: `🔒 **${slip.user_name}** locked in a hidden ${legs.length}-leg slip (\`${slip.id}\`, ${slip.stake}u). Legs stay hidden until revealed.` }).catch(() => {});
    }
  }

  private inList(m: Message, ids: string[] | undefined): boolean {
    if (!ids?.length) return false;
    const parent = (m.channel as any)?.parentId as string | undefined;
    return ids.includes(m.channelId) || (!!parent && ids.includes(parent));
  }

  private draftComponents(d: Draft, canConfirm: boolean) {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pd:ok:${d.id}`).setStyle(ButtonStyle.Success).setLabel('Confirm').setDisabled(!canConfirm),
      new ButtonBuilder().setCustomId(`pd:edit:${d.id}`).setStyle(ButtonStyle.Secondary).setLabel('Edit'),
      new ButtonBuilder().setCustomId(`pd:no:${d.id}`).setStyle(ButtonStyle.Danger).setLabel('Cancel'),
    )];
  }

  private async onMessage(m: Message) {
    if (m.author.bot || !m.inGuild() || !this.d.vision) return;
    const isStaff = this.inList(m, this.d.staffChannelIds);
    const watched = isStaff || this.inList(m, this.d.slipChannelIds);
    if (this.d.slipChannelIds?.length && !watched) return;
    const atts = [...m.attachments.values()].filter((a) => (a.contentType ?? '').startsWith('image/') || /\.(heic|heif)$/i.test(a.name ?? '')).slice(0, MAX_IMAGES_PER_MESSAGE);
    purgeDrafts(this.d.ctx);
    for (const a of atts) {
      const mime = (a.contentType ?? (/\.(heic|heif)$/i.test(a.name ?? '') ? 'image/heic' : '')).split(';')[0];
      if (a.size > MAX_IMAGE_BYTES) continue;
      if (!/^image\/(png|jpe?g)$/.test(mime)) {
        // Only nag about formats where we expect slips, or for iPhone HEIC photos anywhere.
        if (watched || /heic|heif/i.test(mime)) await m.reply({ content: UNSUPPORTED_REPLY(mime), allowedMentions: { repliedUser: false } }).catch(() => {});
        continue;
      }
      await (m.channel as any).sendTyping?.().catch(() => {});
      let image: Uint8Array;
      try {
        const r = await fetch(a.url, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`attachment HTTP ${r.status}`);
        image = new Uint8Array(await r.arrayBuffer()); // in memory only — never written anywhere
      } catch (e) { console.error('[bot] attachment fetch failed', (e as Error).message); continue; }
      const out = await readPhoto(this.d.ctx, this.d.vision, {
        image, mime, userId: m.author.id, userName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
        guildId: m.guildId, channelId: m.channelId, messageId: m.id, sourceUrl: m.url, isTest: isStaff, forceCard: watched,
      });
      if (out.kind === 'not_slip') continue;
      if (out.kind === 'unsupported') { await m.reply({ content: UNSUPPORTED_REPLY(out.mime), allowedMentions: { repliedUser: false } }).catch(() => {}); continue; }
      if (out.kind === 'duplicate') { await m.reply({ content: `This slip is already logged as \`${out.slipId}\`.`, allowedMentions: { repliedUser: false } }).catch(() => {}); continue; }
      for (const [i, d] of out.drafts.entries()) {
        const card = draftCard(d, { i: i + 1, of: out.drafts.length });
        await m.reply({ content: card.text, components: this.draftComponents(d, card.canConfirm), allowedMentions: { repliedUser: false } })
          .catch((e) => console.error('[bot] card reply failed', e.message));
      }
    }
  }

  private canAct(i: ButtonInteraction | ModalSubmitInteraction, ownerId: string) { return i.user.id === ownerId || this.isAdmin(i); }

  private async onDraftButton(i: ButtonInteraction) {
    const [, action, id] = i.customId.split(':');
    const d = getDraft(this.d.ctx, id);
    if (!d) return i.update({ content: `${i.message.content.split('\n')[0]}\n_This card expired or was already handled._`, components: [] });
    if (!this.canAct(i, d.userId)) return i.reply({ ephemeral: true, content: `Only ${d.userName} or an admin can do that.` });
    if (action === 'no') { deleteDraft(this.d.ctx, id); return i.update({ content: '🗑️ Cancelled — nothing was logged.', components: [] }); }
    if (action === 'edit') {
      const v = editDefaults(d);
      const ti = (cid: string, label: string, style: TextInputStyle, val: string, ph: string, max = 4000) => new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(style).setRequired(false).setValue(val.slice(0, max)).setPlaceholder(ph).setMaxLength(max));
      const modal = new ModalBuilder().setCustomId(`pdm:${id}`).setTitle('Fix the slip').addComponents(
        ti('sp', 'Stake / payout ($)', TextInputStyle.Short, v.stakePayout, '55 / 330', 40),
        ti('res', 'Result: won / lost / push / void / open', TextInputStyle.Short, v.result, 'won', 10),
        ti('odds', 'Odds as logged (optional)', TextInputStyle.Short, v.odds, '+500 · 6x · YES 40¢ × 25', 60),
        ti('date', 'Games date YYYY-MM-DD (optional)', TextInputStyle.Short, v.date, '2026-10-14', 10),
        ti('legs', 'Legs, one per line ("?" = blank)', TextInputStyle.Paragraph, v.legs, 'Jayson Tatum (BOS) u19.5 Points = won 19'),
      );
      return i.showModal(modal);
    }
    // confirm
    await i.deferUpdate();
    const out = await confirmDraft(this.d.ctx, this.d.resolver, id);
    if (out.kind === 'gone') return i.editReply({ content: '_This card expired — post the screenshot again._', components: [] });
    if (out.kind === 'blocked') return i.followUp({ ephemeral: true, content: `Can’t log it yet — fill in: ${out.missing.join('; ')}` });
    if (out.kind === 'duplicate') return i.editReply({ content: `Already logged as \`${out.slipId}\`.`, components: [] });
    const v = slipView(out.slip, out.legs, this.d.ctx);
    this.d.engine.emit('tick', { changed: [out.slip.id] });
    const warn = out.problems.length ? `⚠️ Parked for review — ${out.problems.join('; ')}. An admin can fix it with /settle.` : '';
    return i.editReply({
      content: [`✅ Logged \`${out.slip.id}\`${out.unresolved ? ` · ${out.unresolved} leg(s) aren't on ESPN, so their results come from the slip` : ''}`, warn].filter(Boolean).join('\n'),
      embeds: [new EmbedBuilder(ticketEmbed(v, this.d.publicUrl, this.d.ctx.tz))],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`photodel:${out.slip.id}`).setStyle(ButtonStyle.Danger).setEmoji('❌').setLabel('Delete (misread)'))],
    });
  }

  private async onDraftModal(i: ModalSubmitInteraction) {
    const id = i.customId.slice('pdm:'.length);
    const d = getDraft(this.d.ctx, id);
    if (!d) return i.reply({ ephemeral: true, content: 'That card expired — post the screenshot again.' });
    if (!this.canAct(i, d.userId)) return i.reply({ ephemeral: true, content: `Only ${d.userName} or an admin can edit this.` });
    try {
      const nd = editDraft(this.d.ctx, id, { stakePayout: i.fields.getTextInputValue('sp'), result: i.fields.getTextInputValue('res'), odds: i.fields.getTextInputValue('odds'), date: i.fields.getTextInputValue('date'), legs: i.fields.getTextInputValue('legs') });
      const card = draftCard(nd);
      if (i.isFromMessage()) return i.update({ content: card.text, components: this.draftComponents(nd, card.canConfirm) });
      return i.reply({ content: card.text, components: this.draftComponents(nd, card.canConfirm) });
    } catch (e) {
      if (e instanceof VisionError) return i.reply({ ephemeral: true, content: `⚠️ ${e.message}` });
      throw e;
    }
  }

  private async onPhotoDelete(i: ButtonInteraction) {
    const id = i.customId.slice('photodel:'.length);
    const slip = getSlip(this.d.ctx.db, id);
    if (!slip) return i.update({ content: `${i.message.content}\n~~deleted~~`, embeds: [], components: [] });
    if (slip.user_id !== i.user.id && !this.isAdmin(i)) return i.reply({ ephemeral: true, content: 'Only the person who posted it (or an admin) can delete this slip.' });
    deleteSlip(this.d.ctx.db, id, slip.user_id, true);
    this.d.engine.emit('tick', { changed: [] });
    return i.update({ content: `🗑️ Deleted slip \`${id}\` — post it again or use \`/pick\`.`, embeds: [], components: [] });
  }

  slipEmbed(slip: Slip, legs: Leg[], header?: string, ownerView = false) {
    const pub = isPublic(slip) || ownerView;
    const v = slipView({ ...slip, hidden: pub ? 0 : slip.hidden }, legs, this.d.ctx);
    const e = new EmbedBuilder().setColor(slip.status === 'won' ? WON : slip.status === 'lost' ? LOST : BRAND)
      .setAuthor({ name: `${slip.user_name}${slip.is_demo ? ' · DEMO' : ''}` })
      .setTitle(`${header ? header + ' · ' : ''}${slip.title ?? `${legs.length}-leg slip`} · ${slip.id}`)
      .setURL(this.d.publicUrl + '/board');
    if (!pub) e.setDescription(`🔒 ${legs.length} hidden leg(s) · ${slip.stake}u`);
    else e.setDescription(v.legs.map((l) => `${ICON[l.status]} ${l.text}${l.oddsText ? ` (${l.oddsText})` : ''}${l.actual != null ? ` — **${l.actual}**` : ''} · ${l.event?.name ?? ''}`).join('\n') + (slip.note ? `\n\n> ${slip.note}` : ''));
    e.addFields(
      { name: 'Stake', value: `${slip.stake}u`, inline: true },
      { name: 'Odds', value: fmtOdds(v.odds) || '—', inline: true },
      { name: slip.status === 'open' ? 'To win' : 'Result', value: slip.status === 'open' ? units(v.toWin) : `${ICON[slip.status]} ${slip.status} ${units(slip.profit)}`, inline: true },
    );
    return e.setFooter({ text: 'Scores & stats: ESPN · auto-graded' }).setTimestamp(new Date(slip.created_at));
  }

  private async cmdSlips(i: ChatInputCommandInteraction) {
    const u = i.options.getUser('user');
    const b = boardView(this.d.ctx, 'all');
    const open = b.open.filter((s) => !u || s.userId === u.id).slice(0, 15);
    const lines = open.map((s) => s.hidden ? `🔒 **${s.user}** · \`${s.id}\` · ${s.legCount} hidden leg(s) · ${s.stake}u`
      : `🟣 **${s.user}** · \`${s.id}\` · ${s.legs.map((l) => `${ICON[l.status]}${l.text}`).join(', ')} · ${s.stake}u → ${units(s.toWin)}`);
    await i.reply({ embeds: [new EmbedBuilder().setColor(BRAND).setTitle(`Open slips${u ? ' · ' + u.username : ''} (${open.length})`).setDescription(lines.join('\n').slice(0, 4000) || 'No open slips.').setURL(this.d.publicUrl + '/board')] });
  }

  private async cmdSlip(i: ChatInputCommandInteraction) {
    const s = slipWithLegs(this.d.ctx.db, i.options.getString('id', true));
    if (!s) throw new SlipError('No slip with that id.');
    await i.reply({ embeds: [this.slipEmbed(s.slip, s.legs, undefined, s.slip.user_id === i.user.id)], ephemeral: !isPublic(s.slip) });
  }

  private async cmdLive(i: ChatInputCommandInteraction) {
    await i.deferReply();
    const v = await liveView(this.d.ctx, false);
    const games = v.games.filter((g: any) => g.state === 'in' || g.state === 'pre').slice(0, 10);
    const e = new EmbedBuilder().setColor(BRAND).setTitle('Live').setURL(this.d.publicUrl + '/live');
    if (!games.length) e.setDescription('No live or upcoming games with public legs.' + (v.hiddenLegs ? ` (${v.hiddenLegs} hidden leg(s) in play)` : ''));
    for (const g of games) {
      const head = g.pending ? `${g.name} · loading` : `${g.away.abbr} ${g.away.score ?? ''} @ ${g.home.abbr} ${g.home.score ?? ''} · ${g.detail}`;
      const rows = g.legs.slice(0, 8).map((x: any) => {
        const p = x.leg.pace;
        const paceTxt = p && p.pct != null ? ` ${bar(p.pct)} ${p.label}${p.projected != null && x.leg.status === 'pending' ? ` → proj ${p.projected}` : ''}${p.onPace == null ? '' : p.onPace ? ' 🟢' : ' 🔴'}` : p?.label ? ` · ${p.label}` : '';
        return `${ICON[x.leg.status]} **${x.user}** ${x.leg.text}${paceTxt}`;
      });
      e.addFields({ name: head.slice(0, 256), value: rows.join('\n').slice(0, 1024) || '—' });
    }
    e.setFooter({ text: `ESPN · updated ${new Date(v.asOf).toLocaleTimeString('en-US', { timeZone: this.d.ctx.tz })}` });
    await i.editReply({ embeds: [e] });
  }

  private async cmdBoard(i: ChatInputCommandInteraction) {
    const b = boardView(this.d.ctx, 'all');
    const e = new EmbedBuilder().setColor(BRAND).setTitle(`${this.d.groupName} · The Board`).setURL(this.d.publicUrl + '/board');
    if (b.poster) e.addFields({ name: `📌 Tonight’s poster${b.poster.pinned ? '' : ' (auto)'} — ${b.poster.user}`, value: b.poster.legs.map((l: any) => `${ICON[l.status]} ${l.text}`).join('\n').slice(0, 1000) + `\n${b.poster.stake}u @ ${b.poster.oddsText} → ${units(b.poster.toWin)}` });
    e.addFields({ name: `Open slips (${b.open.length})`, value: b.open.slice(0, 6).map((s) => s.hidden ? `🔒 ${s.user} · ${s.legCount} legs` : `🟣 ${s.user} · ${s.legCount} legs · ${s.stake}u @ ${s.oddsText}`).join('\n') || '—' });
    e.addFields({ name: 'Recent results', value: b.recent.slice(0, 6).map((s) => `${ICON[s.status]} ${s.user} · ${s.title ?? s.legCount + ' legs'} · ${units(s.profit)}`).join('\n') || '—' });
    e.addFields({ name: 'Top 5 (profit)', value: b.leaderboard.slice(0, 5).map((u) => `**${u.rank}.** ${u.user} ${units(u.profit)} · ${u.w}-${u.l}-${u.p}`).join('\n') || '—' });
    await i.reply({ embeds: [e] });
  }

  private async cmdLeaderboard(i: ChatInputCommandInteraction) {
    const period = i.options.getString('period') ?? 'all';
    const lb = leaderboard(this.d.ctx, period);
    const medal = ['🥇', '🥈', '🥉'];
    const lines = lb.slice(0, 20).map((u) => `${medal[u.rank - 1] ?? `**${u.rank}.**`} ${u.user} · **${units(u.profit)}** · ${u.w}-${u.l}-${u.p} · ROI ${u.roi}%${u.streak ? ' · ' + u.streak : ''}`);
    await i.reply({ embeds: [new EmbedBuilder().setColor(BRAND).setTitle(`Leaderboard · ${({ all: 'All time', '30d': 'Last 30 days', '7d': 'Last 7 days', today: 'Today' } as any)[period]}`).setDescription(lines.join('\n') || 'No settled slips yet.').setFooter({ text: 'Ranked by profit in units, not volume' }).setURL(this.d.publicUrl + '/board')] });
  }

  private async announce(e: SettledEvent) {
    if (!this.client?.isReady() || !e.slip.channel_id || e.slip.is_demo) return;
    const ch = await this.client.channels.fetch(e.slip.channel_id).catch(() => null);
    if (!ch || !('send' in ch)) return;
    const head = e.slip.status === 'won' ? '💰 Cashed' : e.slip.status === 'lost' ? '💀 Lost' : '➖ Settled';
    await (ch as any).send({ embeds: [this.slipEmbed(e.slip, getLegs(this.d.ctx.db, e.slip.id), head)] });
  }
}

export { legText };
