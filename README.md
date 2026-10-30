# Lelouch HQ

A Discord bot plus a live web dashboard for a group that posts sports picks. People post slips in Discord, the
server grades every leg from real ESPN box scores, and the dashboard shows live games with pace bars, the board,
a leaderboard ranked by profit, injury notes and the health of each data feed.

* **Stack:** Node 24 running TypeScript directly (built-in type stripping, so there's no build step), `node:sqlite`
  (no native modules), `node:http`, `discord.js` v14, and a vanilla-JS PWA (about 8 KB of JS and 4 KB of CSS after brotli).
* **Data:** ESPN's public JSON for the scoreboard, game summaries/box scores, injuries and team rosters. Every number
  shows its source and how old it is. When a feed goes down, the page shows an error state and never fills in a value.
* **Runs without Discord.** If `DISCORD_BOT_TOKEN` isn't set, the web app still works completely. Add the token and
  restart, and the bot connects.

## What's in it

| Area | Details |
|---|---|
| **Discord** | `/pick` (inline `legs:` or a multi-line form), `/rate` (score a parlay without saving it), `/slips`, `/slip`, `/live`, `/board`, `/leaderboard`, `/dashboard` (link and today's key, shown only to you), `/reveal`, `/delete`. Admin commands: `/poster`, `/settle`, `/rotatekey`. The bot posts in the channel when a slip cashes or loses. |
| **Pick entry** | Plain text, matched to real games and ESPN athlete IDs: `Jokic o10.5 reb`, `Tatum 30+ pts (+150)`, `Giannis pra u45.5`, `Josh Allen o245.5 pass yds`, `Josh Jacobs anytime td +110`, `McDavid 1+ sog`, `GB -3.5`, `CAR/GB u47.5`, `GB ML -180`. You can add a league prefix (`NBA:`) or a team hint (`Name (TEAM)`). College props need the team hint. If a name is ambiguous, nothing is saved and you get a suggestion instead of a guess. |
| **Grading** | Legs grade when the game ends. Overs cash, and unders bust, as soon as the line is passed. Whole-number lines can push. A DNP or a postponed game voids the leg. Parlays re-price when a leg pushes or voids. If the price can't be known, the slip goes to **review** (`/settle`) so the bot never invents a number. NFL players missing from the box score also go to review, because ESPN leaves out players with zero stats. |
| **Hidden picks** | `/pick hidden:true`. The legs are removed server-side in one place (`src/views.ts`) and never reach any API, SSE message, injury lookup or error text. The channel only sees "🔒 hidden 3-leg slip". The legs are revealed by `/reveal`, or automatically when the slip settles so the record stays honest. |
| **Live** | Score, clock and every public leg. Prop and total legs get a pace bar with a projected-finish marker, and spreads and moneylines show "Covering by 4.5". You can switch to see all of today's games. |
| **The Board** | Group stats, tonight's poster (pinned by an admin or picked automatically), open slips, recent results, and a leaderboard by **profit in dollars** with record, ROI, amount risked and last-10 form (All, 30d, 7d, Today). |
| **News & health** | ESPN injury notes for players on public open slips, plus Out/Questionable notes for teams on game-line legs. Status for the DB, the grading engine and Discord, and for each ESPN feed: last answer, latency, ok/total calls, last error. |
| **Auth** | The access key is `PHQ-XXXX-XXXX`, derived with an HMAC from `APP_SECRET` and the date in `GROUP_TZ`, so it changes automatically every day. `/rotatekey` changes it immediately and can also sign everyone out. "Keep me signed in" gives a 30-day HttpOnly cookie; otherwise the session ends when the browser closes. Failed logins are limited to 10 per 10 minutes per IP. |
| **Speed** | The ESPN client caches responses in memory (live games 12–15 s, scoreboards 60 s, injuries 10 min, rosters 12 h, athlete game logs 30 min) and merges duplicate in-flight requests. Static assets are brotli/gzip-compressed ahead of time and served with ETags. Updates reach the browser over SSE (with a polling fallback), and the engine polls every 15 s while a game is live or about to start and every 60 s otherwise. |
| **PWA** | Manifest, maskable icons, Apple touch icon, and a service worker that caches only the app shell. Data is never cached, so stale numbers are never shown as live. |

## Run locally

```bash
npm install
cp .env.example .env          # set APP_SECRET; DEMO_MODE=1 to preview
npm run demo                  # or: npm start
# open http://localhost:8080 — the key is in data/demo-access-key.txt (demo) or: npm run key
npm test                      # 85 tests: parser, box scores, grading, settlement, parlay rating, hidden-pick leaks, auth, HTTP
npm run screenshots           # BASE=http://localhost:8080; needs Chrome (CHROME_PATH)
```

**Demo mode** (`DEMO_MODE=1`) adds slips from five made-up members (Ace, Marlo, Kesh, Vee, Dutch), all tagged DEMO
in the UI. They're placed on **real** ESPN games: yesterday's finals use real box scores and real DraftKings closing
lines from ESPN, and today's and tomorrow's slate uses ESPN's posted spreads and totals. Only the picks are made up.
`npm run key -- clear-demo` removes them, and `npm run key -- seed-demo` reseeds.

CLI: `npm run key` (show today's key) · `npm run key -- rotate` · `npm run register-commands`.

### Admin HTTP API (optional, `ADMIN_TOKEN`)
```bash
curl -X POST $URL/api/admin/slips -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"user":"Lelouch","text":"GB -3.5; CAR/GB u46.5","odds":264,"stake":1,"hidden":false}'
curl $URL/api/admin/key -H "authorization: Bearer $ADMIN_TOKEN"
# also: POST /api/admin/rotate-key {"revokeSessions":true}, POST /api/admin/slips/:id/{reveal|poster|settle}
# backup / restore the whole SQLite DB (raw bytes):
curl $URL/api/admin/export -H "authorization: Bearer $ADMIN_TOKEN" -o picks-backup.db
curl -X POST $URL/api/admin/import -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/octet-stream' --data-binary @picks-backup.db
```

## Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `APP_SECRET` | **prod** | auto-generated and stored in the DB | Long random string. Signs the daily keys. If you change it, every key changes. |
| `PORT` | | `8080` | Railway sets this for you. |
| `PUBLIC_URL` | | `http://localhost:$PORT` | Used in `/dashboard` replies and embed links. `https://` turns on `Secure` cookies. |
| `GROUP_TZ` | | `America/Chicago` | Sets when the key rotates and what counts as "tonight". |
| `DATABASE_PATH` | | `./data/picks.db` | Use `/data/picks.db` with a Railway volume. |
| `DATABASE_URL` | | unset | Optional Postgres URL (e.g. Neon, `?sslmode=require`). When set, the SQLite DB is snapshotted into table `app_snapshot` (~5 s after writes settle, at most every 60 s under constant writes, and on SIGTERM/SIGINT) and restored from it on boot — so ephemeral disks (Render free plan) don't lose slips. Unset = SQLite only, as before. Never logged. |
| `LEAGUES` | | `nba,nfl,nhl,mlb,ncaaf,ncaab,wnba` | Leagues searched when a pick doesn't name one. |
| `DISCORD_BOT_TOKEN` | for bot | | Bot → Reset Token. |
| `DISCORD_APP_ID` | for CLI register | | General Information → Application ID. |
| `DISCORD_GUILD_ID` | recommended | | Registers commands to your server instantly. Without it they're global and can take up to an hour. |
| `DISCORD_ADMIN_ROLE_IDS` | | | Comma-separated role IDs. Members with Manage Server always count as admins. |
| `ADMIN_TOKEN` | | | Turns on the admin HTTP API. |
| `GROUP_NAME` | | `Lelouch HQ` | Shown in bot embeds. |
| `BOT_NICKNAME` | | `Lelouch HQ` | Server nickname set on ready in each guild. Does not change the global bot username. If Change Nickname is missing, the bot logs a warning and continues. |
| `DEMO_MODE` | | `0` | `1` seeds the labelled demo data and writes the key file. |
| `POLL_LIVE_MS` / `POLL_IDLE_MS` | | `15000` / `60000` | Grading engine poll intervals. |
| `XAI_API_KEY` | for screenshots | | Turns on reading slip screenshots posted in Discord (xAI vision). Unset = feature off. |
| `XAI_MODEL` | | `grok-4.3` | Any vision-capable xAI model. |
| `DISCORD_STAFF_CHANNEL_IDS` | | | Staff channel IDs. Screenshots confirmed there are marked **test** and left out of standings. |
| `DISCORD_SLIP_CHANNEL_IDS` | | | Comma-separated channel IDs to read screenshots in (threads under them count). Blank = any channel the bot can see. |

## Create the Discord bot and invite it

1. Go to <https://discord.com/developers/applications>, click **New Application**, and name it.
2. Copy the **Application ID** from **General Information** into `DISCORD_APP_ID`.
3. Under **Bot**, click **Reset Token** and put the token in `DISCORD_BOT_TOKEN`. Never commit it. No privileged
   intents are needed for slash commands. **Slip screenshots** (`XAI_API_KEY` set) also need **Bot → Privileged Gateway
   Intents → Message Content Intent** turned on; if it's off, the bot logs a warning and runs without screenshots.
4. Under **OAuth2 → URL Generator**, tick the scopes **`bot`** and **`applications.commands`**, and the bot permissions
   **View Channels, Send Messages, Embed Links, Read Message History**. Open the generated URL and pick your server.
   The URL looks like this:
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=84992`
5. In Discord, go to User Settings → Advanced → **Developer Mode**, then right-click your server → **Copy Server ID**,
   and put it in `DISCORD_GUILD_ID`.
6. Restart the app. The bot registers its slash commands when it starts. The health page should show
   "Discord bot · connected as …". You can also run `npm run register-commands`.

## Deploy to Railway

The repo includes a `Dockerfile` (`node:24-slim`, production dependencies only, runs as a non-root user, has a
healthcheck) and a `railway.json` (Dockerfile builder, `/healthz` healthcheck, restart on failure, 1 replica).

1. Push this folder to a GitHub repo. In Railway, choose **New Project → Deploy from GitHub repo**.
2. **Add a Volume** to the service mounted at `/data`. SQLite lives at `/data/picks.db` (this is already the
   Dockerfile's default `DATABASE_PATH`). Without a volume, slips are lost on every deploy.
3. Under **Variables**, set `APP_SECRET` (`openssl rand -hex 32`), `PUBLIC_URL` (your Railway domain, `https://…`),
   `GROUP_TZ`, `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, and `ADMIN_TOKEN` if you want the API. Leave `DEMO_MODE` unset.
4. Under **Settings → Networking**, click **Generate Domain**, then set `PUBLIC_URL` to that domain.
5. Keep **one replica**. SQLite and the in-process bot each assume a single instance.

Any other Docker host works the same way: `docker build -t picks-hq . && docker run -p 8080:8080 -v picks:/data --env-file .env picks-hq`.

## Layout

```
src/
  main.ts       wiring: DB, ESPN client, engine, web server, bot, demo
  config.ts     env + .env loader
  db.ts         SQLite schema (slips, legs, sessions, kv)
  espn.ts       ESPN client: cache, de-dupe, feed health, game parsing, game logs, elapsed-time math
  stats.ts      box-score normalisation per sport + stat aliases
  parse.ts      free-text leg parser
  resolve.ts    match legs to real games / ESPN athlete IDs
  rate.ts       parlay rating (pure scoring + ESPN fetch)
  grading.ts    pure grading, pace and settlement logic
  engine.ts     polling loop: grade, settle, auto-reveal, emit events
  store.ts      slip create/reveal/delete/poster/manual settle
  views.ts      API payloads (the only place hidden legs are stripped)
  server.ts     HTTP, auth, SSE, static assets, admin API
  bot.ts        Discord slash commands, modal, embeds, settle announcements
  demo.ts       labelled demo seeding on real games
  cli.ts        key / rotate / register / demo commands
public/         index.html, app.js, app.css, sw.js, manifest, icons
test/           node:test suites + trimmed real ESPN fixtures
scripts/        screenshots.mjs, icons.mjs (playwright-core + Chrome)
```

## Slip screenshots

With `XAI_API_KEY` set, post a slip screenshot (PNG/JPG) in a watched channel. PrizePicks is read first; Underdog,
FanDuel, DraftKings, Sleeper and Kalshi are recognised too. Other layouts are read at low confidence and flagged. Dark
mode, tight crops and several slips in one image are fine. iPhone HEIC photos get a reply asking for a PNG or JPG.

1. **Read.** xAI vision returns strict JSON with per-leg confidence. If the first pass misses legs (fewer than the
   header's pick count, no stake, no line), the bot does **one** focused re-read and keeps the better result.
2. **Confirm card.** Nothing is logged automatically. Each slip gets a card with **Confirm / Edit / Rate / Cancel**. **Rate** scores the extracted legs and does not log the slip. Blanks
   (⬜) and unsure legs (⚠️) are marked. A line that can't be read is left blank, never guessed, and Confirm stays off
   until it's filled in through **Edit**. A failed read still gets a blank card. Only the poster or an admin can
   confirm, edit or cancel. Cards expire after 48 h.
3. **Log.** Uses the same path as the admin import. Settled slips: legs are matched to the finished ESPN games (the
   printed scores pick the right night), graded from the box score, then the slip result is applied (won → payout −
   stake, lost → −stake, push/void → 0; an all push/void slip is never a win). If the result contradicts the legs
   (for example "won" with a miss on a power play), the slip is parked as **needs review** instead of showing a
   contradiction. Legs ESPN doesn't cover (esports, Kalshi markets) keep the screenshot's result. Open slips grade
   live. Legs stay in printed order, and odds are kept as printed (Kalshi as `YES 40¢ × 25`).
4. **Ticket.** The card is replaced by a ticket embed showing the book and play type, `risk → pays`, sports, `n/N HIT`,
   status, a row per leg and "logged by", plus **Rate** and **❌ Delete (misread)**. The dashboard has the same ticket at
   `/slip/<id>`.

The image is never stored, only its hash (for dedupe) and the Discord message link. That link is not on the public
board; it's returned only by `GET /api/admin/slips/:id`. The same slip can't be added twice (image hash plus content
hash per member). Screenshots in `DISCORD_STAFF_CHANNEL_IDS` become **test** slips that are left out of standings.

Admin import (same path): `POST /api/admin/slips` with `{user, userId?, text, stake, odds?, date?, result?: {status, profit}}`;
`GET /api/admin/slips/:id` (includes the screenshot link) and `DELETE /api/admin/slips/:id`.

## Parlay rating

`/rate legs:` uses the same leg text as `/pick` (`splitLegs` / `parseLeg`, then the resolver) and replies only to you. It does not save a slip. The same score is on the **Rate** button of a `/pick` result and of a screenshot confirm card (and on the ticket after you confirm).

Each leg is `7/10 · Jokic o10.5 reb — hit 8/10, avg 12.4, margin +1.9 vs DAL`, and the slip is `Parlay: 5/10 · weakest: Tatum u27.5 pts`. A leg with no stat behind it is `—` and is left out of the parlay number. The formulas live in `src/rate.ts`:

* **Props.** Last-10 hit rate × 10, then nudged by at most ±1.5 for how far the season average sits from the line (a cushion of half the line is the cap). Combo stats add their components. Anytime TD, home run and goal legs count games with at least one. Blank game-log cells are skipped, not counted as zeros. No column, no athlete id, or no played games → no score.
* **Spread and total.** 5 when your number matches ESPN's current number. Each half-point you have on the market is worth one point of score (getting +4.5 when the market is +3.5 scores 7). No ESPN line → 5, "no market line found".
* **Moneyline.** 10 × the market's implied probability (50% → 5, about 64% → 6). Your own price moves that by roughly one point per 10 percentage points of difference. No market moneyline → 5, "no market line found".
* **Parlay.** Each leg score is read as a probability out of 10 and the scores are multiplied, then scaled back to 1–10. One leg is unchanged. A weak leg dominates. Unscored legs are excluded, and the lowest scored leg is flagged.

If `XAI_API_KEY` is set, a 2–3 sentence note is added from those numbers only. No key, or a failed call, just omits the note. The key is never logged. Line-movement history is not part of this. The dashboard slip page does not rate legs.

## Accuracy notes and limits

* ESPN's endpoints are public but **undocumented and unofficial**. They can change shape or rate-limit without warning,
  so the health page shows whether each feed is answering. Their live box scores usually run a few seconds to a minute
  behind TV.
* **Pace** is a straight-line projection from the share of regulation played (MLB uses innings). It doesn't model
  minutes, foul trouble or blowouts. Overtime counts as 100%.
* **Unsupported props:** MLB total bases (ESPN's box score has no 2B/3B), first or last scorer, quarter or half lines,
  alternate-period markets and team totals. A leg like `GB o47.5` is read as the game total.
* Rosters come from ESPN team rosters, cached for 12 h. A player traded within that window may not be found until the
  cache refreshes. Pass the team hint (`Name (TEAM)`) to narrow the search.
* The dates the resolver searches are based on `GROUP_TZ`, but ESPN's scoreboard days are roughly US Eastern. Late
  West Coast games still resolve because the search covers 7 days.
* Odds and stakes are whatever members enter. Profit is shown in dollars, and nothing connects to a sportsbook.
