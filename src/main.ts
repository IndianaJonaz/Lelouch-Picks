import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config, resolveSecret } from './config.ts';
import { kvGet, kvSet, openDb } from './db.ts';
import { Espn } from './espn.ts';
import { Engine } from './engine.ts';
import { Auth } from './auth.ts';
import { Resolver } from './resolve.ts';
import { createServer } from './server.ts';
import { Bot } from './bot.ts';
import { hasDemo, seedDemo } from './demo.ts';
import type { Ctx } from './views.ts';

const GROUP = process.env.GROUP_NAME || 'PICKS HQ';
const db = openDb(config.dbPath);
const secret = resolveSecret(() => kvGet(db, 'app_secret'), (v) => kvSet(db, 'app_secret', v));
if (!config.appSecret) console.warn('[config] APP_SECRET not set — using a generated secret stored in the database. Set APP_SECRET in production.');
const espn = new Espn();
const engine = new Engine(db, espn, { liveMs: config.pollLiveMs, idleMs: config.pollIdleMs });
const auth = new Auth(db, secret, config.tz);
const resolver = new Resolver(espn);

let bot: Bot | null = null;
const ctx: Ctx = { db, espn, engine, tz: config.tz, leagues: config.leagues, demo: config.demo, bot: () => bot?.status ?? { status: 'idle', detail: 'not started', tag: null } };
bot = new Bot({ ctx, auth, resolver, engine, token: config.discordToken, guildId: config.discordGuildId, adminRoles: config.discordAdminRoles, publicUrl: config.publicUrl, groupName: GROUP,
  vision: config.xaiApiKey ? { apiKey: config.xaiApiKey, model: config.xaiModel || undefined } : null, slipChannelIds: config.slipChannelIds, staffChannelIds: config.staffChannelIds });

const { server } = createServer({ ctx, auth, resolver, adminToken: config.adminToken, publicUrl: config.publicUrl, groupName: GROUP });
server.listen(config.port, () => console.log(`[web] ${GROUP} listening on http://localhost:${config.port}  (public URL ${config.publicUrl})`));

// Demo key file (path only is ever logged; value is written to disk for local preview)
const demoKeyFile = path.join(config.dataDir, 'demo-access-key.txt');
function writeDemoKey() {
  if (!config.demo) return;
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(demoKeyFile, `${auth.keyFor()}\n# Today's (${auth.today()}, ${config.tz}) dashboard access key. Rotates daily; this file is refreshed automatically.\n`, { mode: 0o600 });
}

(async () => {
  if (config.demo) {
    writeDemoKey();
    console.log(`[demo] DEMO_MODE on — today's access key written to ${demoKeyFile}`);
    if (!hasDemo(db)) await seedDemo(db, espn, resolver, config.tz).catch((e) => console.error('[demo] seeding failed', e));
  }
  engine.start();
  await bot!.start();
  if (!config.discordToken) console.log('[bot] DISCORD_BOT_TOKEN not set — Discord bot disabled; web dashboard fully functional.');
})();

setInterval(() => { writeDemoKey(); auth.purge(); }, 10 * 60_000).unref();

const shutdown = async () => { console.log('shutting down'); engine.stop(); await bot?.stop(); server.close(); db.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
