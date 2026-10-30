import type { DatabaseSync } from 'node:sqlite';
import { getLegs, getSlip, type Leg, type Slip, type SlipStatus } from './db.ts';
import type { ResolvedLeg } from './resolve.ts';
import { shortId } from './util.ts';

export class SlipError extends Error {}

export interface NewSlip {
  user_id: string; user_name: string; title?: string | null; stake: number; odds?: number | null; hidden?: boolean; note?: string | null;
  source?: string; is_demo?: boolean; guild_id?: string | null; channel_id?: string | null; message_id?: string | null;
  /** Imports with a known result don't need odds to compute profit. */
  oddsOptional?: boolean;
  book?: string | null; play_type?: string | null; odds_text?: string | null; payout?: number | null; is_test?: boolean; source_url?: string | null;
}

export function validateOdds(o: number | null | undefined) {
  if (o == null) return;
  if (!Number.isInteger(o) || (o > -100 && o < 100) || Math.abs(o) > 100000) throw new SlipError(`Odds ${o} aren't valid American odds (e.g. -110, +250).`);
}

export function createSlip(db: DatabaseSync, s: NewSlip, legs: ResolvedLeg[]): Slip {
  if (!legs.length) throw new SlipError('A slip needs at least one leg.');
  if (legs.length > 25) throw new SlipError('Max 25 legs per slip.');
  if (!(s.stake > 0 && s.stake <= 1000)) throw new SlipError('Stake must be between 0 and 1000 units.');
  validateOdds(s.odds);
  legs.forEach((l) => validateOdds(l.odds));
  const odds = s.odds ?? null;
  // Single leg: slip odds and leg odds are the same thing.
  if (legs.length === 1 && odds != null && legs[0].odds != null && legs[0].odds !== odds) throw new SlipError(`Conflicting odds: the leg says ${legs[0].odds} but the slip says ${odds}.`);
  if (legs.length === 1 && odds != null && legs[0].odds == null) legs = [{ ...legs[0], odds }];
  const slipOdds = legs.length === 1 && odds == null ? legs[0].odds : odds;
  if (slipOdds == null && legs.some((l) => l.odds == null) && !s.oddsOptional) {
    throw new SlipError('Odds are needed to track profit: give the slip odds (odds: +450) or put odds on every leg, e.g. "GB -3.5 (-110)".');
  }
  const id = shortId(5);
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO slips (id,user_id,user_name,title,stake,odds,hidden,note,source,is_demo,guild_id,channel_id,message_id,book,play_type,odds_text,payout,is_test,source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, s.user_id, s.user_name, s.title ?? null, s.stake, slipOdds, s.hidden ? 1 : 0, s.note ?? null, s.source ?? 'discord', s.is_demo ? 1 : 0, s.guild_id ?? null, s.channel_id ?? null, s.message_id ?? null,
        s.book ?? null, s.play_type ?? null, s.odds_text ?? null, s.payout ?? null, s.is_test ? 1 : 0, s.source_url ?? null);
    const ins = db.prepare(`INSERT INTO legs (slip_id,idx,league,event_id,event_name,start_time,type,team,player,athlete_id,stat,side,line,odds,raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    legs.forEach((l, i) => ins.run(id, i, l.league, l.event_id, l.event_name, l.start_time, l.type, l.team, l.player, l.athlete_id, l.stat, l.side, l.line, l.odds, l.raw));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getSlip(db, id)!;
}

export function slipWithLegs(db: DatabaseSync, id: string): { slip: Slip; legs: Leg[] } | null {
  const slip = getSlip(db, id.toUpperCase());
  return slip ? { slip, legs: getLegs(db, slip.id) } : null;
}

function mustOwn(slip: Slip | undefined, userId: string, isAdmin: boolean): Slip {
  if (!slip) throw new SlipError('No slip with that id.');
  if (slip.user_id !== userId && !isAdmin) throw new SlipError('Only the slip owner or an admin can do that.');
  return slip;
}

export function revealSlip(db: DatabaseSync, id: string, userId: string, isAdmin: boolean): Slip {
  const slip = mustOwn(getSlip(db, id.toUpperCase()), userId, isAdmin);
  if (!slip.hidden || slip.revealed_at) throw new SlipError('That slip is already public.');
  db.prepare("UPDATE slips SET revealed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(slip.id);
  return getSlip(db, slip.id)!;
}

export function deleteSlip(db: DatabaseSync, id: string, userId: string, isAdmin: boolean) {
  const slip = mustOwn(getSlip(db, id.toUpperCase()), userId, isAdmin);
  if (slip.status !== 'open' && !isAdmin) throw new SlipError('Settled slips can only be removed by an admin.');
  const started = getLegs(db, slip.id).some((l) => l.start_time && Date.parse(l.start_time) < Date.now());
  if (started && !isAdmin) throw new SlipError('A game on this slip has started — ask an admin to void it.');
  db.prepare('DELETE FROM slips WHERE id = ?').run(slip.id);
}

export function manualSettle(db: DatabaseSync, id: string, status: SlipStatus, profit: number) {
  const slip = getSlip(db, id.toUpperCase());
  if (!slip) throw new SlipError('No slip with that id.');
  db.prepare("UPDATE slips SET status = ?, profit = ?, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), note = trim(coalesce(note,'') || ' [manually settled]') WHERE id = ?").run(status, profit, slip.id);
  db.prepare("UPDATE legs SET status = CASE WHEN status IN ('pending','review') THEN 'void' ELSE status END, detail = CASE WHEN status IN ('pending','review') THEN 'Manually settled' ELSE detail END WHERE slip_id = ?").run(slip.id);
}

export function setPoster(db: DatabaseSync, id: string, day: string) {
  const slip = getSlip(db, id.toUpperCase());
  if (!slip) throw new SlipError('No slip with that id.');
  if (slip.hidden && !slip.revealed_at) throw new SlipError('Hidden slips can’t be the poster until revealed.');
  db.prepare('UPDATE slips SET poster_day = NULL WHERE poster_day = ?').run(day);
  db.prepare('UPDATE slips SET poster_day = ? WHERE id = ?').run(day, slip.id);
}

export const isPublic = (s: Pick<Slip, 'hidden' | 'revealed_at'>) => !s.hidden || !!s.revealed_at;
