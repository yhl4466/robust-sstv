/*
 * Phase-4 image corpus generator - PURE NODE + pngjs, no browser.
 *
 * The browser generator failed repeatedly on DevTools target/navigation timing (the
 * driver kept attaching to about:blank), burning budget on harness mechanics instead of
 * measurement. pngjs is already available offline and every class except C is plain
 * pixel arithmetic.
 *
 * Class fidelity, stated honestly:
 *   A photo variants   - real pixels from sample.png, cropped/flipped/exposed
 *   B bars/graphics    - faithful
 *   C screen capture   - ASCII text drawn with a BUILT-IN 8x8 BITMAP FONT, so there is NO
 *                        antialiasing. Real system-font rasterisation has smoother glyph
 *                        edges. This is the one fidelity compromise and the manifest
 *                        records it.
 *   D cartoon/vector   - faithful
 *   E low contrast     - faithful
 *   F 1/f synthetic    - faithful (exact 2D FFT)
 *
 * Usage: node scripts/gen-image-corpus.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUTDIR = path.join(ROOT, 'tests', 'fixtures', 'images');
const { PNG } = require(path.join(RESEARCH, 'pngjs'));

const W = 400, H = 300;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function blank() {
  const png = new PNG({ width: W, height: H });
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  return png;
}
function px(png, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const o = ((y | 0) * png.width + (x | 0)) << 2;
  png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
}
function rect(png, x, y, w, h, r, g, b) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(png, xx, yy, r, g, b);
}
function circle(png, cx, cy, rad, r, g, b) {
  for (let yy = Math.floor(cy - rad); yy <= cy + rad; yy++) {
    for (let xx = Math.floor(cx - rad); xx <= cx + rad; xx++) {
      const dx = xx - cx, dy = yy - cy;
      if (dx * dx + dy * dy <= rad * rad) px(png, xx, yy, r, g, b);
    }
  }
}
function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/* 8x8 bitmap font, MSB = leftmost pixel. Only the glyphs the sample text needs. */
const FONT = (() => {
  const f = {};
  const put = (chars, rows) => { for (let i = 0; i < chars.length; i++) f[chars[i]] = rows[i]; };
  f[' '] = [0, 0, 0, 0, 0, 0, 0, 0];
  f['.'] = [0, 0, 0, 0, 0, 0x18, 0x18, 0];   f[','] = [0, 0, 0, 0, 0x18, 0x18, 0x30, 0];
  f[':'] = [0, 0x18, 0x18, 0, 0x18, 0x18, 0, 0]; f[';'] = [0, 0x18, 0x18, 0, 0x18, 0x18, 0x30, 0];
  f['('] = [0x0C, 0x18, 0x30, 0x30, 0x30, 0x18, 0x0C, 0]; f[')'] = [0x30, 0x18, 0x0C, 0x0C, 0x0C, 0x18, 0x30, 0];
  f['{'] = [0x0E, 0x18, 0x18, 0x70, 0x18, 0x18, 0x0E, 0]; f['}'] = [0x70, 0x18, 0x18, 0x0E, 0x18, 0x18, 0x70, 0];
  f['['] = [0x3C, 0x30, 0x30, 0x30, 0x30, 0x30, 0x3C, 0]; f[']'] = [0x3C, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x3C, 0];
  f['='] = [0, 0, 0x7E, 0, 0, 0x7E, 0, 0];   f['+'] = [0, 0x18, 0x18, 0x7E, 0x18, 0x18, 0, 0];
  f['-'] = [0, 0, 0, 0x7E, 0, 0, 0, 0];      f['/'] = [0x06, 0x0C, 0x18, 0x30, 0x60, 0xC0, 0x80, 0];
  f['_'] = [0, 0, 0, 0, 0, 0, 0xFF, 0];      f['*'] = [0, 0x66, 0x3C, 0xFF, 0x3C, 0x66, 0, 0];
  put('0123456789', [
    [0x3C,0x66,0x6E,0x76,0x66,0x66,0x3C,0], [0x18,0x38,0x18,0x18,0x18,0x18,0x7E,0],
    [0x3C,0x66,0x06,0x0C,0x30,0x60,0x7E,0], [0x3C,0x66,0x06,0x1C,0x06,0x66,0x3C,0],
    [0x0C,0x1C,0x3C,0x6C,0x7E,0x0C,0x0C,0], [0x7E,0x60,0x7C,0x06,0x06,0x66,0x3C,0],
    [0x1C,0x30,0x60,0x7C,0x66,0x66,0x3C,0], [0x7E,0x06,0x0C,0x18,0x30,0x30,0x30,0],
    [0x3C,0x66,0x66,0x3C,0x66,0x66,0x3C,0], [0x3C,0x66,0x66,0x3E,0x06,0x0C,0x38,0]
  ]);
  put('ABCDEFGHIJKLMNOPQRSTUVWXYZ', [
    [0x18,0x3C,0x66,0x66,0x7E,0x66,0x66,0], [0x7C,0x66,0x66,0x7C,0x66,0x66,0x7C,0],
    [0x3C,0x66,0x60,0x60,0x60,0x66,0x3C,0], [0x78,0x6C,0x66,0x66,0x66,0x6C,0x78,0],
    [0x7E,0x60,0x60,0x7C,0x60,0x60,0x7E,0], [0x7E,0x60,0x60,0x7C,0x60,0x60,0x60,0],
    [0x3C,0x66,0x60,0x6E,0x66,0x66,0x3C,0], [0x66,0x66,0x66,0x7E,0x66,0x66,0x66,0],
    [0x3C,0x18,0x18,0x18,0x18,0x18,0x3C,0], [0x1E,0x0C,0x0C,0x0C,0x0C,0x6C,0x38,0],
    [0x66,0x6C,0x78,0x70,0x78,0x6C,0x66,0], [0x60,0x60,0x60,0x60,0x60,0x60,0x7E,0],
    [0x63,0x77,0x7F,0x6B,0x63,0x63,0x63,0], [0x66,0x76,0x7E,0x7E,0x6E,0x66,0x66,0],
    [0x3C,0x66,0x66,0x66,0x66,0x66,0x3C,0], [0x7C,0x66,0x66,0x7C,0x60,0x60,0x60,0],
    [0x3C,0x66,0x66,0x66,0x66,0x3C,0x0E,0], [0x7C,0x66,0x66,0x7C,0x78,0x6C,0x66,0],
    [0x3C,0x66,0x60,0x3C,0x06,0x66,0x3C,0], [0x7E,0x18,0x18,0x18,0x18,0x18,0x18,0],
    [0x66,0x66,0x66,0x66,0x66,0x66,0x3C,0], [0x66,0x66,0x66,0x66,0x66,0x3C,0x18,0],
    [0x63,0x63,0x63,0x6B,0x7F,0x77,0x63,0], [0x66,0x66,0x3C,0x18,0x3C,0x66,0x66,0],
    [0x66,0x66,0x66,0x3C,0x18,0x18,0x18,0], [0x7E,0x06,0x0C,0x18,0x30,0x60,0x7E,0]
  ]);
  put('abcdefghijklmnopqrstuvwxyz', [
    [0,0,0x3C,0x06,0x3E,0x66,0x3E,0], [0x60,0x60,0x7C,0x66,0x66,0x66,0x7C,0],
    [0,0,0x3C,0x66,0x60,0x66,0x3C,0], [0x06,0x06,0x3E,0x66,0x66,0x66,0x3E,0],
    [0,0,0x3C,0x66,0x7E,0x60,0x3C,0], [0x1C,0x30,0x30,0x7C,0x30,0x30,0x30,0],
    [0,0,0x3E,0x66,0x66,0x3E,0x06,0x3C], [0x60,0x60,0x7C,0x66,0x66,0x66,0x66,0],
    [0x18,0,0x38,0x18,0x18,0x18,0x3C,0], [0x0C,0,0x1C,0x0C,0x0C,0x0C,0x6C,0x38],
    [0x60,0x60,0x66,0x6C,0x78,0x6C,0x66,0], [0x38,0x18,0x18,0x18,0x18,0x18,0x3C,0],
    [0,0,0x66,0x7F,0x7F,0x6B,0x63,0], [0,0,0x7C,0x66,0x66,0x66,0x66,0],
    [0,0,0x3C,0x66,0x66,0x66,0x3C,0], [0,0,0x7C,0x66,0x66,0x7C,0x60,0x60],
    [0,0,0x3E,0x66,0x66,0x3E,0x06,0x06], [0,0,0x6E,0x70,0x60,0x60,0x60,0],
    [0,0,0x3E,0x60,0x3C,0x06,0x7C,0], [0x30,0x30,0x7C,0x30,0x30,0x36,0x1C,0],
    [0,0,0x66,0x66,0x66,0x66,0x3E,0], [0,0,0x66,0x66,0x66,0x3C,0x18,0],
    [0,0,0x63,0x6B,0x7F,0x3E,0x36,0], [0,0,0x66,0x3C,0x18,0x3C,0x66,0],
    [0,0,0x66,0x66,0x66,0x3E,0x06,0x3C], [0,0,0x7E,0x0C,0x18,0x30,0x7E,0]
  ]);
  return f;
})();

function drawText(png, text, x0, y0, scale, r, g, b) {
  let x = x0;
  for (const ch of text) {
    const glyph = FONT[ch] || FONT[' '];
    for (let gy = 0; gy < 8; gy++) {
      const bits = glyph[gy];
      for (let gx = 0; gx < 8; gx++) {
        if (bits & (0x80 >> gx)) rect(png, x + gx * scale, y0 + gy * scale, scale, scale, r, g, b);
      }
    }
    x += 8 * scale;
  }
}

/** B: high-contrast bars / graphics - the known-bad case. */
function makeBars(i) {
  const png = blank();
  const n = 4 + (i % 6);
  const vertical = i % 3 !== 0;
  for (let k = 0; k < n; k++) {
    const [r, g, b] = hsl2rgb(k * 360 / n + i * 23, 100, (k % 2) ? 50 : 100);
    if (vertical) rect(png, Math.floor(k * W / n), 0, Math.ceil(W / n) + 1, H, r, g, b);
    else rect(png, 0, Math.floor(k * H / n), W, Math.ceil(H / n) + 1, r, g, b);
  }
  for (let k = 0; k < 3 + (i % 5); k++) {
    rect(png, (i * 37 + k * 61) % W, (i * 53 + k * 29) % H, 20 + (k * 13) % 60, 20 + (k * 17) % 50, 0, 0, 0);
  }
  return png;
}
/** C: screen capture with text and rule lines (bitmap font - no antialiasing). */
function makeScreenshot(i) {
  const png = blank();
  const dark = i % 2 === 0;
  const bg = dark ? 30 : 255, fg = dark ? 212 : 17;
  rect(png, 0, 0, W, H, bg, bg, bg);
  const chrome = dark ? 45 : 232;
  rect(png, 0, 0, W, 22, chrome, chrome, chrome);
  drawText(png, 'editor - sample' + i + '.js', 8, 7, 1, fg, fg, fg);
  const lines = [
    'function decode(bytes) {',
    '  const syn = syndromes(bytes, 32);',
    '  if (allZero(syn)) return bytes;',
    '  let loc = berlekampMassey(syn);',
    '  const pos = chienSearch(loc, 255);',
    '  return solveMagnitudes(syn, pos);',
    '}',
    'const table = [1, 2, 3, 4, 5, 6, 7, 8];',
    'export default { decode, table };'
  ];
  const scale = 1 + (i % 3);
  for (let k = 0; k < lines.length; k++) drawText(png, lines[k], 10, 30 + k * (9 * scale + 3), scale, fg, fg, fg);
  const rule = dark ? 85 : 187;
  for (let k = 0; k < 4 + (i % 4); k++) rect(png, 0, H - 20 - k * 12, W, 1, rule, rule, rule);
  const cell = dark ? 58 : 221;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 6; c++) if ((r + c + i) % 3 === 0) rect(png, 250 + c * 24, 40 + r * 14, 22, 12, cell, cell, cell);
  }
  return png;
}
/** D: cartoon / vector - flat fills with hard black outlines. */
function makeCartoon(i) {
  const png = blank();
  const [br0, bg0, bb0] = hsl2rgb(i * 40, 60, 92);
  rect(png, 0, 0, W, H, br0, bg0, bb0);
  for (let k = 0; k < 8 + (i % 6); k++) {
    const x = (i * 31 + k * 47) % (W - 80), y = (i * 59 + k * 41) % (H - 80);
    const w = 40 + (k * 23) % 90, h = 40 + (k * 31) % 80;
    const [r, g, b] = hsl2rgb(i * 71 + k * 37, 85, 55);
    if (k % 2) {
      const rad = Math.min(w, h) / 2;
      circle(png, x + w / 2, y + h / 2, rad + 2, 0, 0, 0);
      circle(png, x + w / 2, y + h / 2, rad, r, g, b);
    } else {
      rect(png, x - 2, y - 2, w + 4, h + 4, 0, 0, 0);
      rect(png, x, y, w, h, r, g, b);
    }
  }
  const [sr, sg, sb] = hsl2rgb(200, 70, 60);
  rect(png, 0, Math.floor(H * 0.7) - 2, W, H, sr, sg, sb);
  rect(png, 0, Math.floor(H * 0.7) - 2, W, 3, 0, 0, 0);
  return png;
}
/** E: low-contrast smooth - the friendliest case. */
function makeSmooth(i) {
  const png = blank();
  const base = 100 + (i % 5) * 10;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x / W + y / H) / 2;
      let v = base + 12 * (1 - Math.abs(2 * t - 1)) - 8 * t;
      for (let k = 0; k < 6; k++) {
        const cx = (i * 43 + k * 67) % W, cy = (i * 29 + k * 53) % H;
        const rr = 60 + (k * 31) % 90;
        const d = Math.hypot(x - cx, y - cy);
        if (d < rr) v += ((k % 2) ? 7 : -7) * (1 - d / rr) * 0.6;
      }
      const vi = Math.max(0, Math.min(255, Math.round(v)));
      px(png, x, y, vi, vi, vi);
    }
  }
  return png;
}
/** F: 1/f^alpha spectral synthetic - natural second-order statistics, new realisation. */
function makeSpectral(i, alpha) {
  const png = blank();
  const N = 256;
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  const rnd = mulberry32(5000 + i * 977);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const kx = x <= N / 2 ? x : x - N, ky = y <= N / 2 ? y : y - N;
      const f = Math.hypot(kx, ky);
      const amp = f === 0 ? 0 : Math.pow(f, -alpha / 2);
      const ph = rnd() * Math.PI * 2;
      re[y * N + x] = amp * Math.cos(ph);
      im[y * N + x] = amp * Math.sin(ph);
    }
  }
  fft2(re, im, N);
  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < N * N; k++) { if (re[k] < mn) mn = re[k]; if (re[k] > mx) mx = re[k]; }
  const span = (mx - mn) || 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.round(60 + 140 * ((re[Math.floor(y * N / H) * N + Math.floor(x * N / W)] - mn) / span));
      px(png, x, y, v, v, v);
    }
  }
  return png;
}
/** A: variants of the one real photograph we have. */
function makePhotoVariant(src, i) {
  const png = blank();
  const sw = src.width, sh = src.height;
  const zoom = 1 + (i % 4) * 0.06;
  const cw = sw / zoom, ch = sh / zoom;
  const sx0 = (i * 13) % Math.max(1, Math.floor(sw - cw));
  const sy0 = (i * 7) % Math.max(1, Math.floor(sh - ch));
  const flip = i % 2 === 1;
  const gain = i % 3 === 1 ? 1.10 : (i % 3 === 2 ? 0.88 : 1.0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = flip ? (W - 1 - x) : x;
      const sxp = Math.min(sw - 1, Math.floor(sx0 + u * cw / W));
      const syp = Math.min(sh - 1, Math.floor(sy0 + y * ch / H));
      const o = (syp * sw + sxp) << 2;
      px(png, x, y,
        Math.min(255, Math.round(src.data[o] * gain)),
        Math.min(255, Math.round(src.data[o + 1] * gain)),
        Math.min(255, Math.round(src.data[o + 2] * gain)));
    }
  }
  return png;
}

function fft1(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function fft2(re, im, N) {
  const a = new Float64Array(N), b = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) { a[x] = re[y * N + x]; b[x] = im[y * N + x]; }
    fft1(a, b);
    for (let x = 0; x < N; x++) { re[y * N + x] = a[x]; im[y * N + x] = b[x]; }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { a[y] = re[y * N + x]; b[y] = im[y * N + x]; }
    fft1(a, b);
    for (let y = 0; y < N; y++) { re[y * N + x] = a[y]; im[y * N + x] = b[y]; }
  }
}

function imageStats(png) {
  const w = png.width, h = png.height, d = png.data;
  const G = (x, y) => d[((y * w + x) << 2) + 1];
  let grad = 0, n = 0, hfE = 0, totE = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = G(x, y);
      totE += v * v;
      if (x + 1 < w) { const dv = G(x + 1, y) - v; grad += Math.abs(dv); hfE += dv * dv; n++; }
    }
  }
  return { grad: grad / n, hf: totE ? hfE / totE : 0 };
}

(function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  for (const f of fs.existsSync(OUTDIR) ? fs.readdirSync(OUTDIR) : []) {
    if (/\.png$/i.test(f)) fs.unlinkSync(path.join(OUTDIR, f));
  }
  const photoPath = path.join(RESEARCH, 'sstv', 'examples', 'sample.png');
  const photo = fs.existsSync(photoPath) ? PNG.sync.read(fs.readFileSync(photoPath)) : null;

  const manifest = [];
  const save = (key, png) => {
    const file = path.join(OUTDIR, key + '.png');
    fs.writeFileSync(file, PNG.sync.write(png));
    manifest.push({
      key, cls: key[0], file: path.relative(ROOT, file).replace(/\\/g, '/'),
      source: key[0] === 'A' ? 'sample.png variant (same scene)' : 'synthetic (pure node)',
      note: key[0] === 'C' ? 'bitmap-font text, no antialiasing' : ''
    });
  };

  for (let i = 0; i < 10; i++) {
    if (photo) save('A' + i, makePhotoVariant(photo, i));
    save('B' + i, makeBars(i));
    save('C' + i, makeScreenshot(i));
    save('D' + i, makeCartoon(i));
    save('E' + i, makeSmooth(i));
    save('F' + i, makeSpectral(i, 1.1 + (i % 3) * 0.15));
  }
  fs.writeFileSync(path.join(OUTDIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const byClass = {};
  for (const m of manifest) byClass[m.cls] = (byClass[m.cls] || 0) + 1;
  console.log(`Generated ${manifest.length} corpus images (pure Node + pngjs, no browser)`);
  console.log('  per class: ' + Object.keys(byClass).sort().map((c) => c + '=' + byClass[c]).join(', '));
  console.log('\nclass  mean|dI/dx|  HF energy ratio   (green channel, 400x300 source)');
  const stats = {};
  for (const m of manifest) {
    const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, m.file)));
    (stats[m.cls] = stats[m.cls] || []).push(imageStats(png));
  }
  for (const c of Object.keys(stats).sort()) {
    const arr = stats[c];
    const g = arr.reduce((a, v) => a + v.grad, 0) / arr.length;
    const h = arr.reduce((a, v) => a + v.hf, 0) / arr.length;
    console.log(`  ${c}     ${g.toFixed(3).padStart(9)}      ${h.toFixed(4).padStart(9)}`);
  }
})();
