// Renders public/icons/icon.svg into the PNG sizes the manifest and iOS need, plus public/favicon.ico and public/favicon.svg.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
const svg = readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['apple-touch-icon.png', 180, 0], ['maskable-512.png', 512, 0.12]]) {
  await p.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  await p.setContent(`<body style="margin:0;background:#0b0b0d;display:grid;place-items:center;width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</body>`);
  await p.screenshot({ path: new URL(`../public/icons/${name}`, import.meta.url).pathname, omitBackground: false });
}
const favs = [];
for (const size of [16, 32, 48]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<body style="margin:0;background:#0b0b0d;width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  favs.push([size, await p.screenshot({ omitBackground: false })]);
}
// favicon.ico: ICO container with embedded PNGs (supported by all current browsers).
const head = Buffer.alloc(6 + 16 * favs.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(favs.length, 4);
let off = head.length;
favs.forEach(([size, png], i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(size, e); head.writeUInt8(size, e + 1); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(off, e + 12); off += png.length;
});
writeFileSync(new URL('../public/favicon.ico', import.meta.url), Buffer.concat([head, ...favs.map(([, png]) => png)]));
writeFileSync(new URL('../public/favicon.svg', import.meta.url), svg);
await b.close();
console.log('icons written');
