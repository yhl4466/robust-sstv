/*
 * Side-by-side plate: our production decoder's phigros output next to the user's Robot36 app screenshot.
 *
 * The Robot36 reference is a phone screenshot (864x1920) whose top ~700 px and bottom ~200 px are app
 * chrome, so the 320x256 raster has to be located instead of assumed. Locating it: the TV raster is
 * the only region that is not near-uniform, so the row where vertical variance first and last clears a
 * threshold brackets it.
 *
 * Usage: node tests/compare-phigros.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OURS = path.join(__dirname, 'diag-quality', 'phigros-decoded.png');
const REF = path.join(ROOT, '测试结果', 'robot36.jpg');
const OUT = path.join(__dirname, 'diag-quality', 'phigros-vs-robot36.png');

const zlibDecode = zlib.inflateSync;
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function writePNG(file, width, height, rgba) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; raw[p++] = rgba[i]; raw[p++] = rgba[i + 1]; raw[p++] = rgba[i + 2]; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]));
}

/** Minimal PNG reader (8-bit RGB/RGBA, no interlace) - enough for our own render. */
function readPNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlibDecode(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = new Uint8ClampedArray(w * h * 4);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.from(line);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      if (ft === 1) cur[i] = (cur[i] + a) & 255;
      else if (ft === 2) cur[i] = (cur[i] + b) & 255;
      else if (ft === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
    }
    cur.copy(prev);
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** JPEG dimensions from the SOF marker (fast, no decoder needed). */
function jpegSize(file) {
  const b = fs.readFileSync(file);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function nearest(img, fx, fy) {
  const x = Math.min(img.width - 1, Math.max(0, Math.round(fx)));
  const y = Math.min(img.height - 1, Math.max(0, Math.round(fy)));
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/**
 * Approximate JPEG decode is not available without a dependency, so the reference plate is rendered
 * through the browser canvas instead (see compare-phigros.html). Here we only place OUR raster and
 * report the reference's true size so the two panels are described accurately.
 */
(async function main() {
  if (!fs.existsSync(OURS)) { console.log('missing ' + OURS + ' - run render-phigros.js first'); process.exitCode = 1; return; }
  const ours = readPNG(OURS);
  const sz = fs.existsSync(REF) ? jpegSize(REF) : null;
  console.log('ours   : ' + ours.width + 'x' + ours.height);
  console.log('robot36: ' + (sz ? sz.width + 'x' + sz.height : 'missing'));

  // 2x nearest-neighbour upscale of our plate, so it is readable next to a phone screenshot.
  const S = 2;
  const W = ours.width * S, H = ours.height * S;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = nearest(ours, x / S, y / S);
    const d = (y * W + x) * 4;
    out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2]; out[d + 3] = 255;
  }
  writePNG(path.join(__dirname, 'diag-quality', 'phigros-2x.png'), W, H, out);
  console.log('-> tests/diag-quality/phigros-2x.png');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
