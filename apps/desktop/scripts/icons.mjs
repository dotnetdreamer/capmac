// Draws capmac Studio's icons (SVG) and rasterizes them into the .ico/.png files
// in resources/icons. Small sizes use a heavier drawing so they stay crisp.
// Run with `npm run icons -w @capmac/desktop`; the outputs are committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { desktopDir } from './config.mjs';

const dir = path.join(desktopDir, 'resources', 'icons');
mkdirSync(dir, { recursive: true });

const defs = `
  <defs>
    <linearGradient id="tile" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#8F82FF"/>
      <stop offset="0.55" stop-color="#5B4BF0"/>
      <stop offset="1" stop-color="#3B2BC4"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.28"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>`;

/** The full-size mark: a phone running your app, on a violet tile. */
const large = (extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${defs}
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#tile)"/>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#shine)"/>
  <rect x="8.75" y="8.75" width="238.5" height="238.5" rx="57.25" fill="none" stroke="#1E1470" stroke-opacity="0.35" stroke-width="1.5"/>
  <rect x="80" y="36" width="96" height="184" rx="25" fill="#fff" fill-opacity="0.12" stroke="#fff" stroke-width="13"/>
  <rect x="114" y="54" width="28" height="9" rx="4.5" fill="#fff"/>
  <path d="M113 99v58l46-29z" fill="#fff" stroke="#fff" stroke-width="12" stroke-linejoin="round"/>
  ${extra}
</svg>`;

/** 16–24 px: same idea, fewer details, heavier strokes. */
const small = (extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${defs}
  <rect x="4" y="4" width="248" height="248" rx="52" fill="url(#tile)"/>
  <rect x="70" y="28" width="116" height="200" rx="28" fill="none" stroke="#fff" stroke-width="22"/>
  <path d="M106 94v68l56-34z" fill="#fff" stroke="#fff" stroke-width="14" stroke-linejoin="round"/>
  ${extra}
</svg>`;

/** A green "something is running" dot for the tray icon. */
const dot = '<circle cx="204" cy="204" r="52" fill="#1E1470"/><circle cx="204" cy="204" r="38" fill="#3DDC84"/>';

function png(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

/** ICO with PNG-encoded entries (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;
  images.forEach(({ size, data }, i) => {
    const e = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, e);
    entries.writeUInt8(size >= 256 ? 0 : size, e + 1);
    entries.writeUInt16LE(1, e + 4);
    entries.writeUInt16LE(32, e + 6);
    entries.writeUInt32LE(data.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, entries, ...images.map((i) => i.data)]);
}

const pick = (size, extra) => (size <= 24 ? small(extra) : large(extra));
const sizes = (list, extra) => list.map((size) => ({ size, data: png(pick(size, extra), size) }));

writeFileSync(path.join(dir, 'icon.svg'), large());
writeFileSync(path.join(dir, 'icon.ico'), ico(sizes([16, 20, 24, 32, 40, 48, 64, 96, 128, 256])));
writeFileSync(path.join(dir, 'icon.png'), png(large(), 512));
writeFileSync(path.join(dir, 'icon-256.png'), png(large(), 256));
writeFileSync(path.join(dir, 'tray.ico'), ico(sizes([16, 20, 24, 32, 40, 48])));
writeFileSync(path.join(dir, 'tray-active.ico'), ico(sizes([16, 20, 24, 32, 40, 48], dot)));
console.log(`icons written to ${dir}`);
