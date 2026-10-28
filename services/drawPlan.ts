import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { Diagram } from './sinucaCoach.js';
import type { SupportedMime } from './media.js';

const require = createRequire(import.meta.url);
/** Fontes embutidas (o servidor pode não ter fontes instaladas). */
const FONT_DIR = join(dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const FONT_FILES = [join(FONT_DIR, 'DejaVuSans.ttf'), join(FONT_DIR, 'DejaVuSans-Bold.ttf')];

const COLORS = { verde: '#2ecc71', amarelo: '#f1c40f', vermelho: '#e74c3c' } as const;

/** Lê largura e altura de JPEG, PNG ou WebP sem decodificar a imagem. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) return { w: u32(16), h: u32(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = u16(i + 2);
      // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: u16(i + 5), w: u16(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (chunk === 'VP8L') {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** Monta o SVG com os traçados por cima da foto (mesmo desenho da página de demonstração). */
export function buildOverlaySvg(d: Diagram, photo: Uint8Array, mime: SupportedMime, size: { w: number; h: number }): string {
  const W = size.w, H = size.h, U = Math.max(W, H) / 100;
  const X = (x: number) => (x * W).toFixed(1);
  const Y = (y: number) => (y * H).toFixed(1);
  const href = `data:${mime};base64,${Buffer.from(photo).toString('base64')}`;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<image href="${href}" xlink:href="${href}" x="0" y="0" width="${W}" height="${H}"/>`;
  const text = (x: number | string, y: number | string, size: number, fill: string, t: string) =>
    `<text x="${x}" y="${y}" fill="${fill}" font-family="DejaVu Sans" font-size="${size.toFixed(1)}" font-weight="bold" text-anchor="middle">${t}</text>`;

  for (const p of d.pockets) {
    svg += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${2.6 * U}" fill="#000" fill-opacity="0.75" stroke="#fff" stroke-width="${0.3 * U}"/>`;
    svg += text(X(p.x), (p.y * H + 0.95 * U).toFixed(1), 2.8 * U, '#fff', String(p.n));
  }
  d.plays.slice().reverse().forEach((pl, iRev) => {
    const i = d.plays.length - 1 - iRev;
    const c = COLORS[pl.level];
    const pts = pl.path.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ');
    svg += `<polyline points="${pts}" fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="${1.6 * U}" stroke-linejoin="round" stroke-linecap="round"/>`;
    svg += `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="${0.9 * U}" stroke-linejoin="round" stroke-linecap="round"${i === 0 ? '' : ` stroke-dasharray="${2.2 * U} ${1.4 * U}"`}/>`;
    const last = pl.path[pl.path.length - 1];
    svg += `<circle cx="${X(last.x)}" cy="${Y(last.y)}" r="${1.3 * U}" fill="${c}" stroke="#000" stroke-width="${0.3 * U}"/>`;
    if (pl.cueEnd && pl.path.length >= 2) {
      const hit = pl.path[pl.path.length - 2];
      svg += `<line x1="${X(hit.x)}" y1="${Y(hit.y)}" x2="${X(pl.cueEnd.x)}" y2="${Y(pl.cueEnd.y)}" stroke="#fff" stroke-width="${0.5 * U}" stroke-dasharray="${0.8 * U} ${0.8 * U}" opacity="0.9"/>`;
      svg += `<circle cx="${X(pl.cueEnd.x)}" cy="${Y(pl.cueEnd.y)}" r="${1.6 * U}" fill="none" stroke="#fff" stroke-width="${0.5 * U}"/>`;
      svg += text(X(pl.cueEnd.x), (pl.cueEnd.y * H + 0.9 * U).toFixed(1), 2.2 * U, '#fff', String(i + 1));
    }
  });
  const placed: { x: number; y: number }[] = [];
  d.plays.forEach((pl, i) => {
    const c = COLORS[pl.level];
    const a = pl.path[pl.path.length - 2], b = pl.path[pl.path.length - 1];
    const bw = 12.5 * U, bh = 3.8 * U;
    const lx = Math.min(W - bw / 2, Math.max(bw / 2, (a.x + (b.x - a.x) * 0.5) * W));
    let ly = Math.min(H - bh, Math.max(bh, (a.y + (b.y - a.y) * 0.5) * H));
    for (let k = 0; k < 6 && placed.some((p) => Math.abs(p.x - lx) < bw && Math.abs(p.y - ly) < bh); k++) ly += bh * 1.15;
    placed.push({ x: lx, y: ly });
    svg += `<rect x="${(lx - bw / 2).toFixed(1)}" y="${(ly - bh * 0.72).toFixed(1)}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="${c}" stroke="#000" stroke-width="${0.25 * U}"/>`;
    svg += text(lx.toFixed(1), (ly + bh * 0.08).toFixed(1), 2.4 * U, '#111', `${i + 1} · ${pl.chance}%`);
  });
  return svg + '</svg>';
}

/** Desenha os traçados em cima da foto e devolve um PNG (até ~1080 px de largura). Null se não der. */
export function renderPlanImage(d: Diagram | null, photo: Uint8Array, mime: SupportedMime): Uint8Array | null {
  if (!d || !d.plays.length) return null;
  const size = imageSize(photo);
  if (!size || size.w < 50 || size.h < 50) return null;
  const svg = buildOverlaySvg(d, photo, mime, size);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.min(1080, size.w) },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
  });
  return new Uint8Array(resvg.render().asPng());
}

/** Legenda curta com as 3 jogadas (vai junto da imagem). */
export function planCaption(d: Diagram): string {
  const dot = { verde: '🟢', amarelo: '🟡', vermelho: '🔴' } as const;
  return d.plays.map((p, i) => `${dot[p.level]} ${i + 1}) ${p.name} — ${p.chance}%${p.spin ? ` · ${p.spin}` : ''}`).join('\n') + '\n⚪ pontilhado = onde a branca para';
}
