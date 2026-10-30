// Polls ESPN for every event the group has legs on, grades legs, settles slips, and emits changes.
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { getLegs, getSlip, type Leg, type Slip } from './db.ts';
import { gameFromSummary, type Espn, type Game } from './espn.ts';
import { gradeLeg, settleSlip } from './grading.ts';
import { parseBox, type Box } from './stats.ts';

export interface EventSnap { league: string; game: Game; box: Box; at: number; stale: boolean; error: string | null }
export interface SettledEvent { slip: Slip; legs: Leg[] }

export class Engine extends EventEmitter {
  snaps = new Map<string, EventSnap>();
  lastTick: { at: number; ms: number; events: number; error: string | null } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private db: DatabaseSync; private espn: Espn; private opts: { liveMs: number; idleMs: number };

  constructor(db: DatabaseSync, espn: Espn, opts: { liveMs: number; idleMs: number }) {
    super(); this.db = db; this.espn = espn; this.opts = opts;
  }

  /** Events worth polling: any pending leg, plus anything that started in the last 18h (keeps live view fresh after early cashes). */
  trackedEvents(): { league: string; event_id: string }[] {
    const since = new Date(Date.now() - 18 * 3600_000).toISOString();
    return this.db.prepare(`SELECT DISTINCT league, event_id FROM legs WHERE event_id IS NOT NULL AND (status = 'pending' OR start_time >= ?)`).all(since) as any;
  }

  async tick(): Promise<{ changedSlips: string[] }> {
    const t0 = Date.now();
    const events = this.trackedEvents();
    const changedSlips = new Set<string>();
    let error: string | null = null;
    await Promise.all(events.map(async ({ league, event_id }) => {
      try {
        for (const id of await this.gradeEvent(league, event_id)) changedSlips.add(id);
      } catch (e) {
        error = (e as Error).message;
        const prev = this.snaps.get(event_id);
        if (prev) prev.error = `feed error: ${error}`;
      }
    }));
    for (const id of changedSlips) this.settle(id);
    this.lastTick = { at: Date.now(), ms: Date.now() - t0, events: events.length, error };
    this.emit('tick', { changed: [...changedSlips] });
    return { changedSlips: [...changedSlips] };
  }

  /** Fetch one event's summary, update the snapshot, grade its pending legs. Returns the slip ids whose legs changed. */
  async gradeEvent(league: string, eventId: string): Promise<string[]> {
    const s = await this.espn.summary(league, eventId);
    const game = gameFromSummary(league, s.data, s.at);
    if (!game) throw new Error('summary had no header');
    const box = parseBox(league, s.data);
    this.snaps.set(eventId, { league, game, box, at: s.at, stale: s.stale, error: s.stale ? 'serving cached data — feed not answering' : null });
    const changed = new Set<string>();
    const legs = this.db.prepare(`SELECT * FROM legs WHERE event_id = ? AND status = 'pending'`).all(eventId) as unknown as Leg[];
    for (const leg of legs) {
      const g = gradeLeg(leg, game, box);
      if (g.status !== leg.status || g.actual !== leg.actual || g.detail !== leg.detail) {
        this.db.prepare(`UPDATE legs SET status = ?, actual = ?, detail = ?, graded_at = CASE WHEN ? != 'pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE graded_at END WHERE id = ?`)
          .run(g.status, g.actual, g.detail, g.status, leg.id);
        changed.add(leg.slip_id);
      }
    }
    return [...changed];
  }

  /** Grade one slip's legs right now from ESPN box scores (does not settle the slip). Feed errors leave legs pending. */
  async gradeSlipLegs(slipId: string): Promise<void> {
    const events = this.db.prepare(`SELECT DISTINCT league, event_id FROM legs WHERE slip_id = ? AND event_id IS NOT NULL AND status = 'pending'`).all(slipId) as { league: string; event_id: string }[];
    await Promise.all(events.map((e) => this.gradeEvent(e.league, e.event_id).catch(() => [])));
  }

  settle(slipId: string) {
    const slip = getSlip(this.db, slipId);
    if (!slip || (slip.status !== 'open' && slip.status !== 'review')) return;
    const legs = getLegs(this.db, slipId);
    const s = settleSlip(slip, legs);
    if (s.status === slip.status && s.profit === slip.profit) return;
    const settled = s.status !== 'open';
    // Hidden slips are revealed once they settle, so the record stays honest.
    this.db.prepare(`UPDATE slips SET status = ?, profit = ?, settled_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
      revealed_at = CASE WHEN hidden = 1 AND revealed_at IS NULL AND ? IN ('won','lost','push','void') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE revealed_at END WHERE id = ?`)
      .run(s.status, s.profit, settled ? 1 : 0, s.status, slipId);
    if (settled && s.status !== 'review') this.emit('settled', { slip: getSlip(this.db, slipId)!, legs } satisfies SettledEvent);
  }

  nextDelay(): number {
    const soon = Date.now() + 10 * 60_000;
    const live = [...this.snaps.values()].some((s) => s.game.state === 'in' || (s.game.state === 'pre' && Date.parse(s.game.start) < soon));
    return live ? this.opts.liveMs : this.opts.idleMs;
  }

  start() {
    const loop = async () => {
      if (this.running) return;
      this.running = true;
      try { await this.tick(); } catch (e) { console.error('[engine] tick failed', e); }
      this.running = false;
      this.timer = setTimeout(loop, this.nextDelay());
    };
    loop();
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
  poke() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.start(), 250); }
}
