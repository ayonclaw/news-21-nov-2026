// Draws the 21 November 2026 world news poster as one 1024x1024 PNG.
// Pure Node: reads two bundled TrueType faces, rasterises their outlines itself, and writes the
// PNG with zlib. No npm, no canvas, no network, no system fonts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SS = 2; // supersampling factor: draw at 2x, box-filter down to 1024
const W = 1024;
const H = 1024;
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const HERE = fileURLToPath(new URL('.', import.meta.url));

const INK = [11, 11, 12] as const;
const PAPER = [244, 243, 240] as const;
const MUTED = [148, 148, 143] as const;
const ACCENT = [232, 163, 61] as const;
const RULE = [58, 58, 56] as const;

type RGB = readonly [number, number, number];

// ---------------------------------------------------------------- font tables

type Face = {
  upem: number;
  numGlyphs: number;
  loca: number[];
  glyf: number;
  cmap: Map<number, number>;
  adv: number[];
  buf: Buffer;
};

function u16(b: Buffer, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function i16(b: Buffer, o: number): number {
  const v = (b[o] << 8) | b[o + 1];
  return v >= 0x8000 ? v - 0x10000 : v;
}
function u32(b: Buffer, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function loadFace(path: string): Face {
  const buf = readFileSync(path);
  const tables = new Map<string, { off: number; len: number }>();
  const n = u16(buf, 4);
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const tag = buf.toString('ascii', rec, rec + 4);
    tables.set(tag, { off: u32(buf, rec + 8), len: u32(buf, rec + 12) });
  }
  const head = tables.get('head')!.off;
  const upem = u16(buf, head + 18);
  const longLoca = i16(buf, head + 50) === 1;
  const numGlyphs = u16(buf, tables.get('maxp')!.off + 4);

  const locaOff = tables.get('loca')!.off;
  const loca: number[] = [];
  for (let i = 0; i <= numGlyphs; i++) {
    loca.push(longLoca ? u32(buf, locaOff + i * 4) : u16(buf, locaOff + i * 2) * 2);
  }

  const nMetrics = u16(buf, tables.get('hhea')!.off + 34);
  const hmtx = tables.get('hmtx')!.off;
  const adv: number[] = [];
  let last = 0;
  for (let i = 0; i < numGlyphs; i++) {
    if (i < nMetrics) last = u16(buf, hmtx + i * 4);
    adv.push(last);
  }

  // cmap: a Unicode BMP subtable — platform 3 encoding 1, else platform 0.
  const cmapOff = tables.get('cmap')!.off;
  const subs = u16(buf, cmapOff + 2);
  let best = -1;
  for (let i = 0; i < subs; i++) {
    const rec = cmapOff + 4 + i * 8;
    const plat = u16(buf, rec);
    const enc = u16(buf, rec + 2);
    const off = cmapOff + u32(buf, rec + 4);
    if (u16(buf, off) !== 4) continue;
    if (plat === 3 && enc === 1) best = off;
    else if (plat === 0 && best === -1) best = off;
  }
  const cmap = new Map<number, number>();
  if (best >= 0) {
    const segX2 = u16(buf, best + 6);
    const ends = best + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segX2; s += 2) {
      const end = u16(buf, ends + s);
      const start = u16(buf, starts + s);
      const delta = i16(buf, deltas + s);
      const rangeOffPos = ranges + s;
      const rangeOff = u16(buf, rangeOffPos);
      for (let ch = start; ch <= end && ch < 0xffff; ch++) {
        let gid = 0;
        if (rangeOff === 0) {
          gid = (ch + delta) & 0xffff;
        } else {
          gid = u16(buf, rangeOffPos + rangeOff + (ch - start) * 2);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid) cmap.set(ch, gid);
      }
    }
  }

  return { upem, numGlyphs, loca, glyf: tables.get('glyf')!.off, cmap, adv, buf };
}

type Pt = { x: number; y: number; on: boolean };

/** The glyph's contours as point rings in font units, y up. */
function glyphContours(face: Face, gid: number): Pt[][] {
  const b = face.buf;
  const start = face.glyf + face.loca[gid];
  const end = face.glyf + face.loca[gid + 1];
  if (end <= start) return [];
  const nContours = i16(b, start);
  if (nContours < 0) return []; // composite glyph: none of the poster's characters need one
  const endPts: number[] = [];
  for (let i = 0; i < nContours; i++) endPts.push(u16(b, start + 10 + i * 2));
  const nPts = endPts.length ? endPts[endPts.length - 1] + 1 : 0;
  let p = start + 10 + nContours * 2;
  p += 2 + u16(b, p); // skip the hinting instructions
  const flags: number[] = [];
  while (flags.length < nPts) {
    const f = b[p++];
    flags.push(f);
    if (f & 8) {
      const rep = b[p++];
      for (let r = 0; r < rep; r++) flags.push(f);
    }
  }
  const xs: number[] = [];
  let x = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i];
    if (f & 2) {
      const d = b[p++];
      x += f & 16 ? d : -d;
    } else if (!(f & 16)) {
      x += i16(b, p);
      p += 2;
    }
    xs.push(x);
  }
  const ys: number[] = [];
  let y = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i];
    if (f & 4) {
      const d = b[p++];
      y += f & 32 ? d : -d;
    } else if (!(f & 32)) {
      y += i16(b, p);
      p += 2;
    }
    ys.push(y);
  }
  const contours: Pt[][] = [];
  let first = 0;
  for (const lastPt of endPts) {
    const pts: Pt[] = [];
    for (let i = first; i <= lastPt; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
    contours.push(pts);
    first = lastPt + 1;
  }
  return contours;
}

/** Flatten quadratic contours into closed polygons (font units, y up). */
function flatten(contours: Pt[][], steps = 6): number[][] {
  const out: number[][] = [];
  for (const ringIn of contours) {
    if (ringIn.length === 0) continue;
    const pts = ringIn.slice();
    let shift = pts.findIndex((q) => q.on);
    if (shift < 0) {
      pts.push({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, on: true });
      shift = pts.length - 1;
    }
    const ring = [...pts.slice(shift), ...pts.slice(0, shift)];
    const poly: number[] = [ring[0].x, ring[0].y];
    for (let i = 1; i <= ring.length; i++) {
      const q = ring[i % ring.length];
      const prev = ring[(i - 1) % ring.length];
      if (q.on) {
        poly.push(q.x, q.y);
        continue;
      }
      const next = ring[(i + 1) % ring.length];
      const endPt = next.on ? next : { x: (q.x + next.x) / 2, y: (q.y + next.y) / 2, on: true };
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const mt = 1 - t;
        poly.push(
          mt * mt * prev.x + 2 * mt * t * q.x + t * t * endPt.x,
          mt * mt * prev.y + 2 * mt * t * q.y + t * t * endPt.y,
        );
      }
    }
    out.push(poly);
  }
  return out;
}

// ---------------------------------------------------------------- canvas

type Canvas = { data: Uint8ClampedArray; w: number; h: number };

function makeCanvas(w: number, h: number): Canvas {
  const data = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = INK[0];
    data[i * 3 + 1] = INK[1];
    data[i * 3 + 2] = INK[2];
  }
  return { data, w, h };
}

function fillPoly(c: Canvas, poly: number[], color: RGB): void {
  if (poly.length < 6) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < poly.length; i += 2) {
    if (poly[i] < minY) minY = poly[i];
    if (poly[i] > maxY) maxY = poly[i];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(c.h - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < poly.length; i += 2) {
      const ax = poly[i];
      const ay = poly[i + 1];
      const j = (i + 2) % poly.length;
      const bx = poly[j];
      const by = poly[j + 1];
      if (ay === by) continue;
      if ((sy >= ay && sy < by) || (sy >= by && sy < ay)) {
        xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(c.w - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) {
        const o = (y * c.w + x) * 3;
        c.data[o] = color[0];
        c.data[o + 1] = color[1];
        c.data[o + 2] = color[2];
      }
    }
  }
}

function rect(c: Canvas, x: number, y: number, w: number, h: number, color: RGB): void {
  fillPoly(c, [x, y, x + w, y, x + w, y + h, x, y + h], color);
}

function frame(c: Canvas, x: number, y: number, w: number, h: number, t: number, color: RGB): void {
  rect(c, x, y, w, t, color);
  rect(c, x, y + h - t, w, t, color);
  rect(c, x, y, t, h, color);
  rect(c, x + w - t, y, t, h, color);
}

function stroke(c: Canvas, pts: [number, number][], t: number, color: RGB): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / len) * (t / 2);
    const ny = ((bx - ax) / len) * (t / 2);
    fillPoly(c, [ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny], color);
  }
}

function circle(c: Canvas, cx: number, cy: number, r: number, t: number, color: RGB): void {
  const ring: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  stroke(c, ring, t, color);
}

// ---------------------------------------------------------------- type

const FONT_DIR = join(HERE, 'assets');

type Font = { face: Face; cache: Map<number, number[][]> };

function openFont(name: string): Font {
  const candidates = [join(FONT_DIR, name), join('/usr/share/fonts/truetype/dejavu', name)];
  for (const p of candidates) {
    try {
      return { face: loadFace(p), cache: new Map() };
    } catch {
      continue;
    }
  }
  throw new Error(`no face ${name}`);
}

const bold = openFont('DejaVuSans-Bold.ttf');
const regular = openFont('DejaVuSans.ttf');

function polys(font: Font, ch: string): number[][] {
  const gid = font.face.cmap.get(ch.codePointAt(0) ?? 63) ?? 0;
  let got = font.cache.get(gid);
  if (!got) {
    got = flatten(glyphContours(font.face, gid));
    font.cache.set(gid, got);
  }
  return got;
}

function textWidth(font: Font, s: string, size: number): number {
  let w = 0;
  for (const ch of s) {
    const gid = font.face.cmap.get(ch.codePointAt(0) ?? 63) ?? 0;
    w += font.face.adv[gid] ?? 0;
  }
  return (w * size) / font.face.upem;
}

/** Draw `s` with its left edge at x and its baseline at y, in device pixels. */
function text(c: Canvas, font: Font, s: string, x: number, y: number, size: number, color: RGB): number {
  const scale = (size * SS) / font.face.upem;
  let pen = x * SS;
  const base = y * SS;
  for (const ch of s) {
    const gid = font.face.cmap.get(ch.codePointAt(0) ?? 63) ?? 0;
    for (const poly of polys(font, ch)) {
      const shifted: number[] = new Array(poly.length);
      for (let i = 0; i < poly.length; i += 2) {
        shifted[i] = pen + poly[i] * scale;
        shifted[i + 1] = base - poly[i + 1] * scale;
      }
      fillPoly(c, shifted, color);
    }
    pen += (font.face.adv[gid] ?? 0) * scale;
  }
  return pen / SS;
}

/** Break `s` into lines no wider than `max`, never splitting a word. */
function wrap(font: Font, s: string, size: number, max: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of s.split(' ')) {
    const trial = cur ? `${cur} ${word}` : word;
    if (textWidth(font, trial, size) <= max || !cur) cur = trial;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------- the poster

const c = makeCanvas(W * SS, H * SS);
const M = 44; // page margin
const S = (v: number) => v * SS;

function box(x: number, y: number, w: number, h: number): void {
  frame(c, S(x), S(y), S(w), S(h), S(1), RULE);
}

text(c, bold, 'THE WORLD / DAILY BRIEF', M, 58, 15, MUTED);
text(c, bold, 'SATURDAY 21', M - 3, 138, 74, PAPER);
const monthEnd = text(c, bold, 'NOVEMBER', M - 3, 212, 74, ACCENT);
text(c, bold, '2026', monthEnd + 12, 212, 74, ACCENT);
rect(c, S(M), S(234), S(W - 2 * M), S(2), ACCENT);
text(c, regular, 'SIX STORIES. ONE DAY.', M, 266, 15, PAPER);
text(c, regular, '21 / 11 / 26', W - M - textWidth(regular, '21 / 11 / 26', 15), 266, 15, MUTED);

// a wireframe globe, top right
const gx = W - M - 36;
const gy = 92;
circle(c, S(gx), S(gy), S(32), S(2), ACCENT);
stroke(c, [[S(gx - 32), S(gy)], [S(gx + 32), S(gy)]], S(2), ACCENT);
const meridian: [number, number][] = [];
for (let i = 0; i <= 48; i++) {
  const a = (i / 48) * Math.PI * 2;
  meridian.push([S(gx + Math.cos(a) * 15), S(gy + Math.sin(a) * 32)]);
}
stroke(c, meridian, S(1.4), ACCENT);

type Story = {
  region: string;
  head: string[];
  kicker: string;
  detail: string;
  icon: (x: number, y: number) => void;
};

const stories: Story[] = [
  {
    region: 'EUROPE / WAR',
    head: ['Russia hits', 'Ukraine, Poland'],
    kicker: '400+ drones, 110 missiles',
    detail: 'Eight killed in Kyiv, power cut in ten regions, projectiles landing in Poland',
    icon: (x, y) => {
      stroke(c, [[S(x), S(y + 30)], [S(x + 13), S(y + 6)], [S(x + 25), S(y + 30)], [S(x + 34), S(y + 16)]], S(2.4), ACCENT);
      stroke(c, [[S(x + 6), S(y + 38)], [S(x + 30), S(y + 38)]], S(2.4), ACCENT);
    },
  },
  {
    region: 'NORTH AMERICA / MARKETS',
    head: ['AI sell-off hits', 'world stocks'],
    kicker: 'S&P 500 in correction',
    detail: "Japan's Nikkei falls 5.1% as AI-led selling spreads across markets",
    icon: (x, y) => {
      stroke(c, [[S(x), S(y + 6)], [S(x + 11), S(y + 20)], [S(x + 21), S(y + 10)], [S(x + 34), S(y + 34)]], S(2.4), ACCENT);
      stroke(c, [[S(x + 25), S(y + 34)], [S(x + 34), S(y + 34)], [S(x + 34), S(y + 25)]], S(2.4), ACCENT);
    },
  },
  {
    region: 'MIDDLE EAST / SHIPPING',
    head: ['Tankers struck', 'near Hormuz'],
    kicker: 'Two incidents off Khasab',
    detail: 'US-Iran talks stalled as Trump warns Tehran over a reported bomb plot',
    icon: (x, y) => {
      stroke(c, [[S(x), S(y + 30)], [S(x + 38), S(y + 30)], [S(x + 32), S(y + 38)], [S(x + 6), S(y + 38)], [S(x), S(y + 30)]], S(2.2), ACCENT);
      stroke(c, [[S(x + 16), S(y + 30)], [S(x + 16), S(y + 8)], [S(x + 28), S(y + 30)]], S(2.2), ACCENT);
    },
  },
  {
    region: 'EUROPE / DIPLOMACY',
    head: ['Denmark expels', 'Russian attache'],
    kicker: 'Seven days to leave',
    detail: 'Copenhagen halts non-essential visas for Russians after the expulsion',
    icon: (x, y) => {
      stroke(c, [[S(x + 4), S(y + 38)], [S(x + 4), S(y + 6)], [S(x + 34), S(y + 6)], [S(x + 34), S(y + 38)]], S(2.2), ACCENT);
      stroke(c, [[S(x + 13), S(y + 18)], [S(x + 25), S(y + 30)]], S(2.2), ACCENT);
      stroke(c, [[S(x + 25), S(y + 18)], [S(x + 13), S(y + 30)]], S(2.2), ACCENT);
    },
  },
  {
    region: 'IRAQ / DISASTER',
    head: ['Basra plant fire', 'kills four'],
    kicker: 'Thirty more injured',
    detail: 'A blaze at a power plant in the southern city, its cause still unclear',
    icon: (x, y) => {
      stroke(c, [[S(x + 18), S(y + 4)], [S(x + 30), S(y + 18)], [S(x + 18), S(y + 38)], [S(x + 6), S(y + 18)], [S(x + 18), S(y + 4)]], S(2.2), ACCENT);
      stroke(c, [[S(x + 18), S(y + 18)], [S(x + 18), S(y + 30)]], S(2.2), ACCENT);
    },
  },
  {
    region: 'SCIENCE / HEALTH',
    head: ['Trial pill', 'shrinks tumours'],
    kicker: 'Pancreatic cancer study',
    detail: 'Tumours vanished in some patients; BepiColombo reached Mercury orbit',
    icon: (x, y) => {
      circle(c, S(x + 17), S(y + 21), S(15), S(2.2), ACCENT);
      stroke(c, [[S(x + 2), S(y + 21)], [S(x + 32), S(y + 21)]], S(2.2), ACCENT);
    },
  },
];

const tileW = 464;
const tileH = 224;
const top = 276;
stories.forEach((st, i) => {
  const x = M + (i % 2) * (tileW + 24);
  const y = top + Math.floor(i / 2) * (tileH + 18);
  box(x, y, tileW, tileH);
  text(c, bold, st.region, x + 18, y + 28, 14, ACCENT);
  st.icon(x + tileW - 58, y + 48);
  let base = y + 78;
  for (const line of st.head) {
    text(c, bold, line, x + 18, base, 32, PAPER);
    base += 37;
  }
  text(c, regular, st.kicker, x + 18, base + 4, 16, ACCENT);
  let dy = base + 26;
  for (const line of wrap(regular, st.detail, 15, tileW - 40)) {
    text(c, regular, line, x + 18, dy, 15, MUTED);
    dy += 20;
  }
});

text(c, regular, 'WORLD NEWS', M, H - 18, 13, MUTED);
const edition = 'SATURDAY EDITION';
text(c, regular, edition, W - M - textWidth(regular, edition, 13), H - 18, 13, MUTED);

// ---------------------------------------------------------------- downscale + PNG

const flat = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          sum += c.data[((y * SS + dy) * c.w + (x * SS + dx)) * 3 + ch];
        }
      }
      flat[(y * W + x) * 3 + ch] = Math.round(sum / (SS * SS));
    }
  }
}

const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  flat.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let v = n;
    for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    t[n] = v;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let v = -1;
  for (let i = 0; i < buf.length; i++) v = crcTable[(v ^ buf[i]) & 0xff] ^ (v >>> 8);
  return (v ^ -1) >>> 0;
}
function chunk(kind: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const type = Buffer.from(kind, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, body])));
  return Buffer.concat([len, type, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'entry.png'), png);
console.log(JSON.stringify({ image: 'entry.png', width: W, height: H, bytes: png.length }));
