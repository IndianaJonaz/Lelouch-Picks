import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Minimal .env loader (no dependency). Real env vars win.
function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv(path.resolve(process.cwd(), '.env'));

const env = process.env;
const flag = (v?: string) => v === '1' || v === 'true' || v === 'yes';

export const ROOT = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(ROOT, 'data');

export const config = {
  port: Number(env.PORT || 8080),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 8080}`).replace(/\/$/, ''),
  appSecret: env.APP_SECRET || '',
  adminToken: env.ADMIN_TOKEN || '',
  tz: env.GROUP_TZ || 'America/Chicago',
  dbPath: path.resolve(ROOT, env.DATABASE_PATH || path.join(dataDir, 'picks.db')),
  dataDir,
  leagues: (env.LEAGUES || 'nba,nfl,nhl,mlb,ncaaf,ncaab,wnba').split(',').map((s) => s.trim()).filter(Boolean),
  discordToken: env.DISCORD_BOT_TOKEN || '',
  discordAppId: env.DISCORD_APP_ID || '',
  discordGuildId: env.DISCORD_GUILD_ID || '',
  discordAdminRoles: (env.DISCORD_ADMIN_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  demo: flag(env.DEMO_MODE),
  xaiApiKey: env.XAI_API_KEY || '',
  xaiModel: env.XAI_MODEL || '',
  staffChannelIds: (env.DISCORD_STAFF_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  slipChannelIds: (env.DISCORD_SLIP_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  pollLiveMs: Number(env.POLL_LIVE_MS || 15000),
  pollIdleMs: Number(env.POLL_IDLE_MS || 60000),
  // Optional Postgres (e.g. Neon) URL: when set, the SQLite DB is snapshotted there and restored on boot. Never logged.
  databaseUrl: env.DATABASE_URL || '',
  isTest: env.NODE_ENV === 'test',
};

export type Config = typeof config;

/** Secret used to derive keys. If none is configured we persist a random one so restarts keep sessions. */
export function resolveSecret(get: () => string | null, set: (v: string) => void): string {
  if (config.appSecret) return config.appSecret;
  const existing = get();
  if (existing) return existing;
  const s = randomBytes(32).toString('hex');
  set(s);
  return s;
}
