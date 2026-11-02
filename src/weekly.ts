// Weekly record, profit and ROI. Weeks start Monday 00:00 in the group timezone
// (WEEK_START=sunday switches that). ROI uses stake from wins and losses only —
// a push returns the stake, a void was never a bet — matching the all-time board.
import { addDays, dayInTz, round2 } from './util.ts';

export type WeekStart = 'monday' | 'sunday';
export type WeekBy = 'analyst' | 'sport';

export interface WeekWindow { offset: number; start: string; end: string; label: string }

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedWeekday(d: Date, tz: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  return WD[name] ?? 0;
}

/** UTC instant of YYYY-MM-DD 00:00:00 in `tz`. */
export function startOfDayUtc(ymd: string, tz: string): number {
  let t = Date.parse(`${ymd}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (let i = 0; i < 4; i++) {
    const parts = fmt.formatToParts(new Date(t));
    const get = (ty: string) => parts.find((p) => p.type === ty)?.value ?? '00';
    let hour = get('hour');
    if (hour === '24') hour = '00';
    const got = Date.parse(`${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}Z`);
    const delta = got - Date.parse(`${ymd}T00:00:00Z`);
    if (delta === 0) break;
    t -= delta;
  }
  return t;
}

function labelFor(startYmd: string, tz: string): string {
  const start = new Date(startOfDayUtc(startYmd, tz));
  const end = new Date(startOfDayUtc(addDays(startYmd, 6), tz));
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
  return `${fmt(start)} – ${fmt(end)}`;
}

export function weekWindow(now: Date, tz: string, offset: number, weekStarts: WeekStart = 'monday'): WeekWindow {
  const today = dayInTz(now, tz);
  const wd = zonedWeekday(now, tz);
  const back = weekStarts === 'sunday' ? wd : (wd + 6) % 7;
  const startYmd = addDays(today, -(back + 7 * Math.max(0, offset)));
  const endYmd = addDays(startYmd, 7);
  return {
    offset,
    start: new Date(startOfDayUtc(startYmd, tz)).toISOString(),
    end: new Date(startOfDayUtc(endYmd, tz)).toISOString(),
    label: labelFor(startYmd, tz),
  };
}

export interface WeekInput {
  key: string;
  label: string;
  status: string;
  stake: number;
  profit: number;
  sports: string[];
  demo?: boolean;
}

export interface WeekRow {
  key: string;
  label: string;
  w: number;
  l: number;
  p: number;
  profit: number;
  staked: number;
  roi: number;
  slips: number;
  demo: boolean;
  rank: number;
}

function blank(key: string, label: string, demo = false): Omit<WeekRow, 'rank' | 'roi'> & { roi?: number } {
  return { key, label, w: 0, l: 0, p: 0, profit: 0, staked: 0, slips: 0, demo };
}

function add(row: ReturnType<typeof blank>, r: WeekInput) {
  if (r.status === 'void') return;
  row.slips++;
  row.profit += r.profit;
  if (r.demo) row.demo = true;
  if (r.status === 'won') { row.w++; row.staked += r.stake; }
  else if (r.status === 'lost') { row.l++; row.staked += r.stake; }
  else if (r.status === 'push') row.p++;
}

export function summarizeWeek(rows: WeekInput[], by: WeekBy): WeekRow[] {
  const m = new Map<string, ReturnType<typeof blank>>();
  for (const r of rows) {
    if (r.status === 'void') continue;
    if (by === 'analyst') {
      const row = m.get(r.key) ?? blank(r.key, r.label, !!r.demo);
      row.label = r.label;
      add(row, r);
      m.set(r.key, row);
    } else {
      const sport = r.sports.length === 1 ? r.sports[0] : r.sports.length > 1 ? 'multi' : 'other';
      const label = sport === 'multi' ? 'Multi' : sport === 'other' ? 'Other' : sport.toUpperCase();
      const row = m.get(sport) ?? blank(sport, label);
      add(row, r);
      m.set(sport, row);
    }
  }
  const list = [...m.values()].map((u) => ({
    ...u,
    profit: round2(u.profit),
    staked: round2(u.staked),
    roi: u.staked ? round2((u.profit / u.staked) * 100) : 0,
  }));
  list.sort((a, b) => b.profit - a.profit || b.roi - a.roi || a.label.localeCompare(b.label));
  return list.map((u, i) => ({ ...u, rank: i + 1 }));
}
