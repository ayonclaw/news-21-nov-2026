// @ts-nocheck -- intentionally dependency-free JavaScript in Node's .ts entrypoint.
// Original offline raster news poster. Node 22 standard library only.
// All coordinates are in poster pixels; rasterization is supersampled 3x.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 1024, SS = 3, W = SIZE * SS;
const BG = [15, 18, 21], WHITE = [240, 238, 231];
const MUTED = [167, 172, 174], BORDER = [69, 74, 76];
const ACCENT = [242, 166, 93];
const pixels = new Uint8Array(W * W * 3);
for (let i = 0; i < pixels.length; i += 3) pixels.set(BG, i);

function span(y, x0, x1, color) {
  y = Math.floor(y);
  if (y < 0 || y >= W) return;
  const left = Math.max(0, Math.ceil(x0 - 0.5));
  const right = Math.min(W - 1, Math.floor(x1 - 0.5));
  for (let x = left; x <= right; x++) pixels.set(color, (y * W + x) * 3);
}
function rect(x, y, w, h, color) {
  for (let sy = Math.round(y * SS); sy < Math.round((y + h) * SS); sy++) {
    span(sy, x * SS, (x + w) * SS, color);
  }
}
function line(x0, y0, x1, y1, color = ACCENT, width = 2) {
  const ax = x0 * SS, ay = y0 * SS, bx = x1 * SS, by = y1 * SS;
  const radius = width * SS / 2;
  const dx = bx - ax, dy = by - ay, d2 = dx * dx + dy * dy;
  for (let y = Math.max(0, Math.floor(Math.min(ay, by) - radius));
    y <= Math.min(W - 1, Math.ceil(Math.max(ay, by) + radius)); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - radius));
      x <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + radius)); x++) {
      const t = d2 ? Math.max(0, Math.min(1, ((x + .5 - ax) * dx + (y + .5 - ay) * dy) / d2)) : 0;
      if ((x + .5 - ax - t * dx) ** 2 + (y + .5 - ay - t * dy) ** 2 <= radius ** 2) {
        pixels.set(color, (y * W + x) * 3);
      }
    }
  }
}
function path(points, color = ACCENT, width = 2, closed = false) {
  for (let i = 1; i < points.length; i++) line(...points[i - 1], ...points[i], color, width);
  if (closed) line(...points.at(-1), ...points[0], color, width);
}
function circle(cx, cy, radius, color = ACCENT, width = 2) {
  const points = [];
  for (let i = 0; i <= 64; i++) {
    const a = i * Math.PI / 32;
    points.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  path(points, color, width);
}

// Minimal TrueType reader: cmap 4/12, hmtx, loca and simple/composite glyf.
// Quadratic contours are flattened and filled with the non-zero winding rule.
class Face {
  constructor(name) {
    const base = fileURLToPath(new URL('.', import.meta.url));
    try { this.b = readFileSync(join(base, 'assets', name)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.b = readFileSync(join('/usr/share/fonts/truetype/dejavu', name));
    }
    this.tables = {};
    for (let i = 0; i < this.u16(4); i++) {
      const p = 12 + i * 16;
      this.tables[this.b.toString('ascii', p, p + 4)] = this.u32(p + 8);
    }
    const head = this.tables.head, hhea = this.tables.hhea;
    this.units = this.u16(head + 18);
    this.longLoca = this.i16(head + 50) !== 0;
    this.metrics = this.u16(hhea + 34);
    this.cache = new Map();
    const cmap = this.tables.cmap;
    this.cmap = 0;
    for (let i = 0; i < this.u16(cmap + 2); i++) {
      const p = cmap + 4 + i * 8, sub = cmap + this.u32(p + 4);
      if (this.u16(sub) === 12) { this.cmap = sub; break; }
      if (this.u16(sub) === 4) this.cmap = sub;
    }
    if (!this.cmap) throw new Error('Missing Unicode cmap');
  }
  u16(p) { return this.b.readUInt16BE(p); }
  i16(p) { return this.b.readInt16BE(p); }
  u32(p) { return this.b.readUInt32BE(p); }
  glyphId(cp) {
    const p = this.cmap;
    if (this.u16(p) === 12) {
      for (let i = 0; i < this.u32(p + 12); i++) {
        const q = p + 16 + i * 12, start = this.u32(q), end = this.u32(q + 4);
        if (cp >= start && cp <= end) return this.u32(q + 8) + cp - start;
      }
    } else {
      const n = this.u16(p + 6) / 2;
      const end = p + 14, start = end + n * 2 + 2;
      const delta = start + n * 2, ranges = delta + n * 2;
      for (let i = 0; i < n; i++) {
        if (cp < this.u16(start + i * 2) || cp > this.u16(end + i * 2)) continue;
        const d = this.i16(delta + i * 2), r = this.u16(ranges + i * 2);
        if (!r) return (cp + d) & 65535;
        const g = this.u16(ranges + i * 2 + r + 2 * (cp - this.u16(start + i * 2)));
        return g ? (g + d) & 65535 : 0;
      }
    }
    return 0;
  }
  advance(id) { return this.u16(this.tables.hmtx + Math.min(id, this.metrics - 1) * 4); }
  location(id) {
    return this.tables.glyf + (this.longLoca
      ? this.u32(this.tables.loca + id * 4) : this.u16(this.tables.loca + id * 2) * 2);
  }
  contours(id, depth = 0) {
    if (depth > 12) throw new Error('Composite recursion');
    if (this.cache.has(id)) return this.cache.get(id);
    let p = this.location(id);
    if (p === this.location(id + 1)) return [];
    const n = this.i16(p), contours = [];
    p += 10;
    if (n >= 0) {
      const ends = [];
      for (let i = 0; i < n; i++, p += 2) ends.push(this.u16(p));
      const instructions = this.u16(p); p += 2 + instructions;
      const count = n ? ends.at(-1) + 1 : 0, flags = [];
      while (flags.length < count) {
        const f = this.b[p++]; flags.push(f);
        if (f & 8) { const repeats = this.b[p++]; for (let j = 0; j < repeats; j++) flags.push(f); }
      }
      const xs = [], ys = [];
      let x = 0, y = 0;
      for (const f of flags) {
        if (f & 2) x += (f & 16 ? 1 : -1) * this.b[p++];
        else if (!(f & 16)) { x += this.i16(p); p += 2; }
        xs.push(x);
      }
      for (const f of flags) {
        if (f & 4) y += (f & 32 ? 1 : -1) * this.b[p++];
        else if (!(f & 32)) { y += this.i16(p); p += 2; }
        ys.push(y);
      }
      let start = 0;
      for (const end of ends) {
        contours.push(xs.slice(start, end + 1).map((x, j) => ({ x, y: ys[start + j], on: !!(flags[start + j] & 1) })));
        start = end + 1;
      }
    } else {
      let flags;
      do {
        flags = this.u16(p); const child = this.u16(p + 2); p += 4;
        let a, b;
        if (flags & 1) { a = this.i16(p); b = this.i16(p + 2); p += 4; }
        else { a = this.b.readInt8(p); b = this.b.readInt8(p + 1); p += 2; }
        if (!(flags & 2)) throw new Error('Unsupported point-matched composite');
        let xx = 1, yy = 1, xy = 0, yx = 0;
        const f2 = () => { const v = this.i16(p) / 16384; p += 2; return v; };
        if (flags & 8) xx = yy = f2();
        else if (flags & 64) { xx = f2(); yy = f2(); }
        else if (flags & 128) { xx = f2(); xy = f2(); yx = f2(); yy = f2(); }
        for (const c of this.contours(child, depth + 1)) {
          contours.push(c.map(v => ({ x: xx * v.x + xy * v.y + a, y: yx * v.x + yy * v.y + b, on: v.on })));
        }
      } while (flags & 32);
    }
    this.cache.set(id, contours);
    return contours;
  }
}
const bold = new Face('DejaVuSans-Bold.ttf');
const regular = new Face('DejaVuSans.ttf');
const textRecords = [];
function measure(text, size, face = bold) {
  let width = 0;
  for (const c of text) {
    const id = face.glyphId(c.codePointAt(0));
    if (!id) throw new Error('Font lacks glyph: ' + c);
    width += face.advance(id) * size / face.units;
  }
  return width;
}
function text(str, x, baseline, size, color = WHITE, face = bold, maxWidth = SIZE - x - 48) {
  const width = measure(str, size, face);
  if (width > maxWidth + .01) throw new Error('Text overflow: ' + str + ' (' + width + ' > ' + maxWidth + ')');
  const scale = size * SS / face.units, edges = [];
  let pen = x * SS, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function edge(a, b) {
    const x0 = pen + a.x * scale, y0 = baseline * SS - a.y * scale;
    const x1 = pen + b.x * scale, y1 = baseline * SS - b.y * scale;
    minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
    minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
    if (y0 !== y1) edges.push([x0, y0, x1, y1]);
  }
  for (const char of str) {
    const id = face.glyphId(char.codePointAt(0));
    for (const contour of face.contours(id)) {
      if (!contour.length) continue;
      const expanded = [];
      for (let i = 0; i < contour.length; i++) {
        const a = contour[i], b = contour[(i + 1) % contour.length];
        expanded.push(a);
        if (!a.on && !b.on) expanded.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
      }
      const first = expanded.findIndex(p => p.on);
      const pts = expanded.slice(first).concat(expanded.slice(0, first));
      pts.push(pts[0]);
      let current = pts[0];
      for (let i = 1; i < pts.length; i++) {
        const next = pts[i];
        if (next.on) { edge(current, next); current = next; }
        else {
          const end = pts[++i], start = current;
          const steps = Math.max(6, Math.ceil((Math.hypot(next.x - start.x, next.y - start.y) + Math.hypot(end.x - next.x, end.y - next.y)) * scale / 3));
          for (let j = 1; j <= steps; j++) {
            const t = j / steps, u = 1 - t;
            const point = { x: u * u * start.x + 2 * u * t * next.x + t * t * end.x, y: u * u * start.y + 2 * u * t * next.y + t * t * end.y };
            edge(current, point); current = point;
          }
        }
      }
    }
    pen += face.advance(id) * scale;
  }
  if (minX < 0 || maxX >= W || minY < 0 || maxY >= W) throw new Error('Clipped text: ' + str);
  // Some TrueType capitals have a fractional negative left side-bearing.
  // Reserve two pixels within the tile padding for that legitimate ink.
  if (minX < (x - 2) * SS || maxX > (x + maxWidth) * SS + .01) throw new Error('Ink exceeds text box: ' + str);
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const scan = y + .5, hits = [];
    for (const [x0, y0, x1, y1] of edges) {
      if (scan >= Math.min(y0, y1) && scan < Math.max(y0, y1)) hits.push([x0 + (scan - y0) * (x1 - x0) / (y1 - y0), y1 > y0 ? 1 : -1]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    let winding = 0, start = 0;
    for (const [x, direction] of hits) {
      if (winding === 0) start = x;
      winding += direction;
      if (winding === 0) span(y, start, x, color);
    }
  }
  textRecords.push({ text: str, size, x, baseline, width: +width.toFixed(2), bounds: [minX, minY, maxX, maxY].map(v => +(v / SS).toFixed(2)) });
}

// Six bespoke line illustrations, not fonts or external image assets.
function icon(kind, x, y) {
  const p = points => path(points.map(([a, b]) => [x + a, y + b]));
  const l = (a, b, c, d) => line(x + a, y + b, x + c, y + d);
  const c = (a, b, r) => circle(x + a, y + b, r);
  if (kind === 'war') {
    p([[2, 49], [2, 34], [16, 34], [16, 49], [23, 49], [23, 25], [38, 25], [38, 49], [49, 49]]);
    p([[32, 3], [50, 15], [43, 22], [25, 10], [32, 3]]);
    l(22, 14, 12, 22); l(27, 20, 18, 28);
    l(52, 29, 52, 39); l(47, 34, 57, 34);
  } else if (kind === 'markets') {
    l(2, 5, 2, 50); l(2, 50, 59, 50);
    p([[8, 12], [21, 22], [32, 16], [46, 37], [58, 43]]);
    p([[48, 43], [58, 43], [58, 33]]);
    l(12, 33, 12, 43); l(25, 31, 25, 43); l(38, 39, 38, 43);
  } else if (kind === 'shipping') {
    p([[2, 31], [59, 31], [49, 45], [13, 45], [2, 31]]);
    p([[13, 31], [13, 18], [44, 18], [44, 31]]);
    l(21, 18, 21, 31); l(31, 18, 31, 31);
    p([[44, 18], [44, 10], [53, 10], [53, 31]]);
    p([[1, 52], [11, 55], [21, 52], [31, 55], [41, 52], [51, 55], [61, 52]]);
    l(30, 2, 30, 9); l(23, 5, 18, 10); l(37, 5, 42, 10);
  } else if (kind === 'diplomacy') {
    p([[5, 52], [5, 6], [32, 6], [32, 25], [5, 25]]);
    l(15, 6, 15, 25); l(5, 15, 32, 15);
    p([[39, 4], [57, 4], [57, 53], [39, 53]]);
    l(24, 38, 49, 38); p([[43, 32], [49, 38], [43, 44]]);
  } else if (kind === 'fire') {
    p([[3, 52], [3, 29], [19, 36], [19, 29], [34, 36], [34, 52], [3, 52]]);
    p([[8, 28], [8, 15], [16, 15], [16, 32]]);
    p([[44, 48], [39, 39], [42, 29], [47, 20], [46, 7], [56, 21], [60, 33], [58, 43], [51, 49], [44, 48]]);
    p([[47, 43], [47, 35], [51, 28], [54, 37], [51, 44]]);
  } else {
    // Pill plus orbital path: the two science stories in one small drawing.
    p([[6, 38], [27, 17]]); p([[16, 48], [37, 27]]);
    const arc = (cx, cy, a0) => {
      const points = [];
      for (let i = 0; i <= 20; i++) { const a = a0 + i / 20 * Math.PI; points.push([cx + 7 * Math.cos(a), cy + 7 * Math.sin(a)]); }
      p(points);
    };
    arc(11, 43, Math.PI / 4); arc(32, 22, -3 * Math.PI / 4);
    l(16, 28, 26, 38); c(46, 12, 9);
    p([[35, 4], [39, 0], [50, 0], [58, 5], [60, 13], [56, 22]]);
  }
}

text('THE WORLD / DAILY BRIEF', 48, 49, 17, MUTED);
text('SATURDAY 21', 43, 125, 72);
text('NOVEMBER 2026', 43, 205, 72, ACCENT);
// A quiet globe balances the date without competing with its type hierarchy.
circle(865, 138, 63, ACCENT, 1.5);
line(802, 138, 928, 138, ACCENT, 1.2);
for (const latitude of [-27, 27]) {
  const half = Math.sqrt(63 * 63 - latitude * latitude);
  line(865 - half, 138 + latitude, 865 + half, 138 + latitude, ACCENT, 1.2);
}
for (const sign of [-1, 1]) {
  const points = [];
  for (let i = 0; i <= 48; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 48;
    points.push([865 + sign * 28 * Math.cos(a), 138 + 63 * Math.sin(a)]);
  }
  path(points, ACCENT, 1.2);
}
rect(48, 231, 928, 3, ACCENT);
text('SIX STORIES. ONE DAY.', 48, 258, 16, MUTED);
text('21 / 11 / 26', 860, 258, 16, MUTED, regular, 116);

const stories = [
  { label: 'EUROPE / WAR', title: ['Russia hits', 'Ukraine, Poland'], detail: '400+ drones; 110 missiles; Kyiv: 8+ killed', extra: 'Power cut in 10 regions', note: 'NATO calls Poland hit a grave violation', icon: 'war' },
  { label: 'NORTH AMERICA / MARKETS', title: ['AI sell-off hits', 'world stocks'], detail: 'S&P 500 in correction; Nikkei falls 5.1%', extra: 'An AI-led global retreat', note: 'US technology losses ripple across markets', icon: 'markets' },
  { label: 'MIDDLE EAST / SHIPPING', title: ['Tankers struck', 'near Hormuz'], detail: 'Two tanker incidents near Khasab, Oman', extra: 'US-Iran talks stalled', note: 'Trump warns Iran over reported dirty-bomb plot', icon: 'shipping' },
  { label: 'EUROPE / DIPLOMACY', title: ['Denmark expels', 'Russian attache'], detail: 'Defence attache ordered out in seven days', extra: 'Copenhagen tightens entry', note: 'Non-essential visas for Russians halted', icon: 'diplomacy' },
  { label: 'IRAQ / DISASTER', title: ['Basra plant fire', 'kills four'], detail: 'Power plant blaze leaves at least 30 hurt', extra: 'At least four people dead', note: 'A deadly day for the southern Iraqi city', icon: 'fire' },
  { label: 'SCIENCE / HEALTH', title: ['Trial pill', 'shrinks tumours'], detail: 'Pancreatic tumours vanish in some patients', extra: 'BepiColombo at Mercury', note: 'The spacecraft reaches orbit around Mercury', icon: 'science' },
];
for (let i = 0; i < stories.length; i++) {
  const s = stories[i], x = 48 + i % 2 * 472, y = 278 + Math.floor(i / 2) * 238;
  rect(x, y, 456, 1, BORDER); rect(x, y + 221, 456, 1, BORDER);
  rect(x, y, 1, 222, BORDER); rect(x + 455, y, 1, 222, BORDER);
  rect(x, y, 3, 36, ACCENT);
  text(s.label, x + 20, y + 29, 15, ACCENT, bold, 337);
  icon(s.icon, x + 369, y + 17);
  text(s.title[0], x + 20, y + 93, 32, WHITE, bold, 416);
  text(s.title[1], x + 20, y + 131, 32, WHITE, bold, 416);
  text(s.detail, x + 20, y + 157, 14, MUTED, regular, 416);
  text(s.extra, x + 20, y + 186, 19, ACCENT, bold, 416);
  text(s.note, x + 20, y + 208, 14, MUTED, regular, 416);
}
text('WORLD NEWS', 48, 1001, 13, MUTED);
text('SATURDAY EDITION', 826, 1001, 13, MUTED, bold, 150);

// PNG encoding: RGB, no ancillary metadata, fixed deflate settings, valid CRCs.
function crc32(buf) {
  let c = 0xffffffff;
  for (const value of buf) {
    c ^= value;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0); body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4); return result;
}
const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 3); raw[row] = 0;
  for (let x = 0; x < SIZE; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) sum += pixels[((y * SS + sy) * W + x * SS + sx) * 3 + c];
      raw[row + 1 + x * 3 + c] = Math.round(sum / (SS * SS));
    }
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
if (png.length > 1048576) throw new Error('PNG exceeds contest size cap');
const output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'entry.png'), png);
console.log(JSON.stringify({ image: 'entry.png', width: SIZE, height: SIZE, bytes: png.length, text: textRecords }));
