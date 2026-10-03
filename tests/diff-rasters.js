/*
 * Pixel-compare two decoded rasters of the phigros recording.
 *
 * The Node render (tests/render-phigros.js) and the browser render (tests/browser-visual.js, read
 * back from the real #decCanvas) go through different WAV loaders and different JS engines, so
 * "the browser shows what we measured" is a claim that has to be checked rather than assumed. Byte
 * equality of the PNG files would NOT show it - the browser's encoder makes different choices - so
 * this decodes both to RGBA and compares the pixels.
 *
 * Usage: node tests/diff-rasters.js a.png b.png
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

function readPNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8, w = 0, h = 0, ct = 0, depth = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error('only 8-bit PNGs supported, got ' + depth);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : (ct === 2 ? 3 : (ct === 0 ? 1 : 0));
  if (!bpp) throw new Error('unsupported colour type ' + ct);
  const stride = w * bpp;
  const out = new Uint8ClampedArray(w * h * 4);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
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

const A = readPNG(process.argv[2]);
const B = readPNG(process.argv[3]);
console.log('A ' + A.width + 'x' + A.height + '   B ' + B.width + 'x' + B.height);
if (A.width !== B.width || A.height !== B.height) { console.log('size mismatch'); process.exitCode = 1; return; }
let se = 0, n = 0, maxDiff = 0, differing = 0;
for (let i = 0; i < A.data.length; i++) {
  if (i % 4 === 3) continue;
  const d = Math.abs(A.data[i] - B.data[i]);
  se += d * d; n++;
  if (d > maxDiff) maxDiff = d;
  if (d > 0) differing++;
}
const mse = se / n;
console.log('channels compared ' + n);
console.log('PSNR ' + (mse === 0 ? 'inf (bit-identical)' : (10 * Math.log10(65025 / mse)).toFixed(4) + ' dB'));
console.log('maxDiff ' + maxDiff + ' · differing samples ' + differing + ' (' + (100 * differing / n).toFixed(4) + '%)');
