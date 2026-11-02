// Pick visibility by Discord tier role.
// Default order (low → high): Free Member < Moneyline < VIP < Deluxe < Lifetime.
// A member sees a pick at their tier or below. Staff see every tier.
// Override the ladder with TIER_LADDER=id:Label,id:Label (left = lowest).
// Staff role names: STAFF_ROLE_NAMES=Admin,Moderator,Analyst Mods,Support.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TierDef { id: string; label: string; rank: number }

export const DEFAULT_LADDER: TierDef[] = [
  { id: 'free', label: 'Free Member', rank: 0 },
  { id: 'moneyline', label: 'Moneyline', rank: 1 },
  { id: 'vip', label: 'VIP', rank: 2 },
  { id: 'deluxe', label: 'Deluxe', rank: 3 },
  { id: 'lifetime', label: 'Lifetime', rank: 4 },
];

export const DEFAULT_STAFF = ['Admin', 'Moderator', 'Analyst Mods', 'Support'];

export function parseLadder(raw?: string | null): TierDef[] {
  const s = (raw ?? '').trim();
  if (!s) return DEFAULT_LADDER.map((t) => ({ ...t }));
  const out: TierDef[] = [];
  for (const part of s.split(',')) {
    const [idRaw, ...labelParts] = part.split(':');
    const id = (idRaw ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    const label = labelParts.join(':').trim();
    if (!id || !label || out.some((t) => t.id === id)) continue;
    out.push({ id, label, rank: out.length });
  }
  return out.length ? out : DEFAULT_LADDER.map((t) => ({ ...t }));
}

export function parseStaff(raw?: string | null): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [...DEFAULT_STAFF];
  const names = s.split(',').map((x) => x.trim()).filter(Boolean);
  return names.length ? names : [...DEFAULT_STAFF];
}

/** Empty / "free" is the public tier. An id that is not on the ladder is unknown (null). */
export function canonicalTier(id: string | null | undefined, ladder: TierDef[] = DEFAULT_LADDER): string | null {
  if (id == null || String(id).trim() === '') return 'free';
  const q = String(id).trim().toLowerCase();
  const hit = ladder.find((t) => t.id === q || t.label.toLowerCase() === q);
  return hit ? hit.id : null;
}

/** Rank of a stored tier. Null/free is the bottom. Unknown ids sit above every real tier so they stay staff-only. */
export function tierRank(id: string | null | undefined, ladder: TierDef[] = DEFAULT_LADDER): number {
  if (id == null || id === '' || id === 'free') return ladder.find((t) => t.id === 'free')?.rank ?? 0;
  const hit = ladder.find((t) => t.id === id);
  return hit ? hit.rank : Number.POSITIVE_INFINITY;
}

export interface Viewer { userId: string | null; tier: string; staff: boolean }

export function viewerFromRoles(roleNames: string[], ladder: TierDef[] = DEFAULT_LADDER, staffNames: string[] = DEFAULT_STAFF): { tier: string; staff: boolean } {
  const norms = roleNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  const staff = staffNames.some((s) => norms.includes(s.trim().toLowerCase()));
  let best = ladder[0] ?? { id: 'free', label: 'Free Member', rank: 0 };
  for (const t of ladder) {
    if (norms.includes(t.id.toLowerCase()) || norms.includes(t.label.toLowerCase())) {
      if (t.rank >= best.rank) best = t;
    }
  }
  return { tier: best.id, staff };
}

export function canSeePick(
  slip: { tier?: string | null; user_id?: string | null },
  viewer: Viewer,
  ladder: TierDef[] = DEFAULT_LADDER,
): boolean {
  if (viewer.staff) return true;
  if (viewer.userId && slip.user_id && viewer.userId === slip.user_id) return true;
  return tierRank(slip.tier, ladder) <= tierRank(viewer.tier, ladder);
}

export interface ViewerToken { userId: string; name: string; tier: string; staff: boolean; exp: number }

/** Signed viewer link so the dashboard knows which Discord member opened it. The secret never leaves the server. */
export function signViewerToken(secret: string, v: Omit<ViewerToken, 'exp'>, ttlMs = 12 * 3600_000, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...v, exp: now + ttlMs })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readViewerToken(secret: string, token: string, now = Date.now()): ViewerToken | null {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  const expect = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString()) as ViewerToken;
    if (!v || typeof v.userId !== 'string' || typeof v.tier !== 'string' || typeof v.exp !== 'number') return null;
    if (v.exp < now) return null;
    return { userId: v.userId, name: String(v.name ?? ''), tier: v.tier, staff: !!v.staff, exp: v.exp };
  } catch { return null; }
}
