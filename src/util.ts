export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** YYYY-MM-DD for a date in a given IANA zone. */
export function dayInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export const espnDate = (ymd: string) => ymd.replace(/-/g, '');
export function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Normalise a player/team name for matching: lowercase, strip accents, punctuation, suffixes. */
export function normName(s: string): string {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.'’`-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** American odds -> decimal odds. */
export function americanToDecimal(a: number): number {
  if (!Number.isFinite(a) || a === 0 || (a > -100 && a < 100)) throw new Error(`invalid American odds: ${a}`);
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}
export function decimalToAmerican(d: number): number {
  if (d <= 1) throw new Error('decimal odds must be > 1');
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const fmtOdds = (a: number | null | undefined) => (a == null ? '' : a > 0 ? `+${a}` : `${a}`);

export function shortId(n = 6): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const buf = crypto.getRandomValues(new Uint8Array(n));
  for (const b of buf) s += abc[b % abc.length];
  return s;
}
