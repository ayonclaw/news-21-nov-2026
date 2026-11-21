// Development verification only; the generator itself is main.ts.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('.', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'news21-verify-'));
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validatePNG(png) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert(png.length <= 1048576);
  const types = [], compressed = [];
  let offset = 8;
  while (offset < png.length) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + size)), png.readUInt32BE(offset + 8 + size), 'CRC ' + type);
    types.push(type);
    if (type === 'IHDR') {
      assert.equal(data.readUInt32BE(0), 1024); assert.equal(data.readUInt32BE(4), 1024);
      assert.deepEqual([...data.subarray(8)], [8, 2, 0, 0, 0]);
    }
    if (type === 'IDAT') compressed.push(data);
    offset += size + 12;
  }
  assert.equal(offset, png.length);
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  const raw = inflateSync(Buffer.concat(compressed)), stride = 3073;
  assert.equal(raw.length, 1024 * stride);
  let changed = 0;
  const panelCoverage = Array(6).fill(0), iconCoverage = Array(6).fill(0);
  for (let y = 0; y < 1024; y++) {
    assert.equal(raw[y * stride], 0);
    for (let x = 0; x < 1024; x++) {
      const p = y * stride + 1 + x * 3;
      const foreground = raw[p] !== 15 || raw[p + 1] !== 18 || raw[p + 2] !== 21;
      if (!foreground) continue;
      changed++;
      for (let i = 0; i < 6; i++) {
        const tx = 48 + i % 2 * 472, ty = 278 + Math.floor(i / 2) * 238;
        if (x > tx + 2 && x < tx + 454 && y > ty + 2 && y < ty + 220) panelCoverage[i]++;
        if (x >= tx + 368 && x <= tx + 432 && y >= ty + 16 && y <= ty + 74) iconCoverage[i]++;
      }
      assert(x >= 43 && x < 977 && y >= 35 && y < 1005, 'Stray pixels outside intended content bounds');
    }
  }
  assert(changed > 50000 && changed < 350000, 'Not blank or flooded');
  for (const count of panelCoverage) assert(count > 6000, 'Empty tile');
  for (const count of iconCoverage) assert(count > 200, 'Missing icon');
  return { changedPixels: changed, panelCoverage, iconCoverage };
}
function validateText(report) {
  assert.equal(report.text.length, 43);
  const dates = report.text.filter(t => t.size === 72);
  assert.deepEqual(dates.map(t => t.text), ['SATURDAY 21', 'NOVEMBER 2026']);
  assert(report.text.every(t => t.size === 72 || t.size < 72));
  for (let i = 0; i < report.text.length; i++) {
    const a = report.text[i];
    for (const b of report.text.slice(i + 1)) {
      const overlap = a.bounds[0] < b.bounds[2] && a.bounds[2] > b.bounds[0] && a.bounds[1] < b.bounds[3] && a.bounds[3] > b.bounds[1];
      assert(!overlap, 'Overlapping text: ' + a.text + ' / ' + b.text);
    }
  }
  for (let i = 0; i < 6; i++) {
    const lines = report.text.slice(5 + i * 6, 11 + i * 6);
    const x = 48 + i % 2 * 472, y = 278 + Math.floor(i / 2) * 238;
    assert.equal(lines.length, 6);
    assert(lines[0].text.includes(' / '));
    assert(lines.slice(1, 3).map(t => t.text).join(' ').split(/\s+/).length <= 5);
    assert(lines.slice(1, 3).every(t => t.size >= 26));
    assert(lines.slice(3).every(t => t.size >= 14));
    for (const line of lines) {
      const [left, top, right, bottom] = line.bounds;
      assert(left >= x + 15 && right <= x + 441 && top >= y + 12 && bottom <= y + 214, 'Tile overflow: ' + line.text);
      assert(!(left < x + 432 && right > x + 368 && top < y + 74 && bottom > y + 16), 'Text overlaps icon: ' + line.text);
    }
  }
}
try {
  const images = [], times = [];
  for (let i = 0; i < 2; i++) {
    const out = join(work, 'run-' + i); mkdirSync(out);
    const start = performance.now();
    const result = spawnSync(process.execPath, [join(root, 'main.ts')], {
      cwd: i === 0 ? root : '/',
      env: { ...process.env, MAKEFUN_OUTPUT_DIR: out },
      encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    times.push(Math.round(performance.now() - start));
    validateText(JSON.parse(result.stdout));
    images.push(readFileSync(join(out, 'entry.png')));
  }
  assert(images[0].equals(images[1]), 'Twice-run byte identity');
  assert(images[0].equals(readFileSync(join(root, 'entry.png'))), 'Committed image matches generated image');
  const pixels = validatePNG(images[0]);
  console.log(JSON.stringify({ result: 'PASS', dimensions: [1024, 1024], bytes: images[0].length,
    sha256: createHash('sha256').update(images[0]).digest('hex'), runtimeMs: times,
    twiceRunByteIdentical: true, cwdIndependent: true, committedImageMatches: true,
    pngCRCAndPayloadValid: true, textAndIconBoundsValid: true, ...pixels }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
