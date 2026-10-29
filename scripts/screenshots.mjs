// Headless screenshots of every dashboard page (desktop + mobile). Usage: BASE=http://localhost:8810 npm run screenshots
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:8080';
const key = process.env.KEY || readFileSync(new URL('../data/demo-access-key.txt', import.meta.url), 'utf8').split('\n')[0].trim();
const out = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, colorScheme: 'dark', timezoneId: 'America/Chicago', isMobile: label === 'mobile', hasTouch: label === 'mobile' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  await p.goto(BASE + '/board', { waitUntil: 'networkidle' });
  await p.waitForSelector('#key');
  await p.screenshot({ path: `${out}${label}-0-login.png` });
  await p.fill('#key', 'PHQ-BAD0-KEY0'); await p.click('#lb');
  await p.waitForFunction(() => document.getElementById('le')?.textContent?.length > 0);
  await p.fill('#key', key); await p.check('input[name=remember][value="1"]'); await p.click('#lb');
  await p.waitForSelector('.stats');
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}${label}-1-board.png`, fullPage: label === 'desktop' });
  await p.click('a[href="/live"] >> visible=true'); await p.waitForSelector('.game'); await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}${label}-2-live.png`, fullPage: label === 'desktop' });
  await p.click('button[data-all="1"]'); await p.waitForSelector('.slate'); await p.waitForTimeout(800);
  await p.screenshot({ path: `${out}${label}-3-live-all-games.png`, fullPage: label === 'desktop' });
  await p.click('a[href="/news"] >> visible=true'); await p.waitForSelector('.hrow'); await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}${label}-4-news-health.png`, fullPage: label === 'desktop' });
  await ctx.close();
}
await b.close();
const over = [];
console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
