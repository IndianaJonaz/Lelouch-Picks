// npm run key -- [show|rotate|register|clear-demo|seed-demo]
import { REST, Routes } from 'discord.js';
import { config, resolveSecret } from './config.ts';
import { kvGet, kvSet, openDb } from './db.ts';
import { Auth } from './auth.ts';
import { commands } from './bot.ts';
import { clearDemo, seedDemo } from './demo.ts';
import { Espn } from './espn.ts';
import { Resolver } from './resolve.ts';

const db = openDb(config.dbPath);
const secret = resolveSecret(() => kvGet(db, 'app_secret'), (v) => kvSet(db, 'app_secret', v));
const auth = new Auth(db, secret, config.tz);
const cmd = process.argv[2] ?? 'show';

if (cmd === 'show') console.log(`${auth.keyFor()}  (valid ${auth.today()} ${config.tz})`);
else if (cmd === 'rotate') console.log(`new key: ${auth.rotate()}`);
else if (cmd === 'clear-demo') { clearDemo(db); console.log('demo slips removed'); }
else if (cmd === 'seed-demo') { clearDemo(db); const espn = new Espn(); await seedDemo(db, espn, new Resolver(espn), config.tz); }
else if (cmd === 'register') {
  if (!config.discordToken || !config.discordAppId) { console.error('Set DISCORD_BOT_TOKEN and DISCORD_APP_ID first.'); process.exit(1); }
  const rest = new REST().setToken(config.discordToken);
  const route = config.discordGuildId ? Routes.applicationGuildCommands(config.discordAppId, config.discordGuildId) : Routes.applicationCommands(config.discordAppId);
  await rest.put(route, { body: commands });
  console.log(`registered ${commands.length} commands ${config.discordGuildId ? 'to guild ' + config.discordGuildId : 'globally'}`);
} else { console.error('usage: npm run key -- [show|rotate|register|clear-demo|seed-demo]'); process.exit(1); }
db.close();
