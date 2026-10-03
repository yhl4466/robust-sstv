/*
 * phigros: is the damage in the PER-PIXEL ESTIMATOR or in the LINE TIMING?
 *
 * THE CRACK THAT MUST BE EXPLAINED
 *   Our own synthetic S1 round-trips at PSNR 31.7 dB with each plane matching its own truth at 0.998
 *   and cross-talk of 0.002 - the channel handling is right. Yet the real recording renders as
 *   magenta/cyan horizontal streaking. Something about the recording, not the algorithm, triggers it.
 *
 * THE DISCRIMINATING EXPERIMENT
 *   Both hypotheses are testable with ONE comparison, because the estimator and the timing are
 *   separable: build the image twice from THE SAME per-line sync references (so the timing is
 *   identical) and vary only the frequency estimator.
 *
 *     A. the production estimator: Hann FFT magnitude peak on a ~1 ms window, per pixel
 *     B. a phase-difference discriminator: complex baseband, low-pass, then the per-sample phase
 *        increment of the filtered analytic signal - the approach slowrx and Robot36 use
 *
 *   If B is dramatically cleaner, the per-pixel estimator is the problem: an FFT peak on a 1 ms window
 *   is a high-variance estimate, and AAC compression plus the recording chain raises the noise floor
 *   enough to wreck it. If B looks the same, the timing/reference is the problem instead.
 *
 * The discriminator here uses the sign convention corrected in phase 31 (s = -sin(w)) - differencing
 * or mirroring mistakes have cost this project several rounds, so the earlier sign bug is fixed in
 * both places.
 *
 * Usage: node tests/diagnose-estimator-vs-timing.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, FFT = globalThis.FFT;
const MODE = Modes.get('S1');
const SCAN = MODE.scanTime, SEP = MODE.sepPulse;
const PIXEL = SCAN / MODE.width * SR;
const STARTS = { G: -(2 * SEP + 2 * SCAN) + SEP, B: -SCAN, R: (MODE.syncPulse + MODE.syncPorch) };

let pngjs = null;
try { pngjs = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); } catch (e) {}

/** B. Phase-difference discriminator: absolute Hz per sample, sign convention corrected. */
function discriminatorTrack(x, sr, lpMs) {
  const CENTER = 1900;
  const lpLen = Math.max(8, Math.round(lpMs / 1000 * sr) | 1);
  const w = 2 * Math.PI * CENTER / sr, c = Math.cos(w), s = -Math.sin(w);   // NEGATED: down-conversion
  const ringI = new Float64Array(lpLen), ringQ = new Float64Array(lpLen);
  let sumI = 0, sumQ = 0, ri = 0, ci = 1, si = 0, pI = 0, pQ = 0, have = false;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
    const mI = x[i] * ci, mQ = x[i] * si;
    sumI += mI - ringI[ri]; ringI[ri] = mI;
    sumQ += mQ - ringQ[ri]; ringQ[ri] = mQ;
    ri = (ri + 1) % lpLen;
    const I = sumI / lpLen, Q = sumQ / lpLen;
    if (have) {
      const re = I * pI + Q * pQ, im = Q * pI - I * pQ;
      out[i] = CENTER + Math.atan2(im, re) * sr / (2 * Math.PI);
    } else out[i] = CENTER;
    pI = I; pQ = Q; have = true;
  }
  return out;
}

/** A. Production-style per-pixel estimator: Hann FFT magnitude peak, parabolic refinement. */
const fftCache = {};
function fftPeak(x, at, len, lo, hi) {
  let n = 256; while (n < len) n <<= 1;
  let e = fftCache[n];
  if (!e) { e = { fft: new FFT(n), out: new Float32Array(2 * n), data: new Float32Array(2 * n) }; fftCache[n] = e; }
  const H = new Float64Array(len);
  for (let i = 0; i < len; i++) H[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
  e.data.fill(0);
  for (let i = 0; i < len; i++) {
    const j = at - (len >> 1) + i;
    if (j >= 0 && j < x.length) e.data[2 * i] = x[j] * H[i];
  }
  e.fft.realTransform(e.out, e.data);
  e.fft.completeSpectrum(e.out);
  const bins = n / 2 + 1;
  const kLo = Math.max(1, Math.ceil(lo * n / SR)), kHi = Math.min(bins - 2, Math.floor(hi * n / SR));
  const mag = (k) => Math.sqrt(e.out[2 * k] * e.out[2 * k] + e.out[2 * k + 1] * e.out[2 * k + 1]);
  let bk = kLo, bv = -1;
  for (let k = kLo; k <= kHi; k++) { const v = mag(k); if (v > bv) { bv = v; bk = k; } }
  const m0 = mag(bk - 1), m1 = bv, m2 = mag(bk + 1);
  const d = m0 - 2 * m1 + m2, sh = d === 0 ? 0 : 0.5 * (m0 - m2) / d;
  return (bk + sh) * SR / n;
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round((v - 1500) / 800 * 255)));

/** Compose an image from a per-pixel sampler. */
function compose(freqAt, refs, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < height && i < refs.length; i++) {
    for (const role of ['G', 'B', 'R']) {
      const off = role === 'R' ? 0 : (role === 'G' ? 1 : 2);
      const s0 = refs[i].ref + STARTS[role] * SR;
      for (let px = 0; px < width; px++) {
        const g = clamp255(freqAt(Math.round(s0 + (px + 0.5) * PIXEL)));
        data[(i * width + px) * 4 + off] = g;
      }
    }
  }
  return { data: data, width: width, height: height };
}

function rowCorr(img) {
  const w = img.width, h = img.height, d = img.data;
  let s = 0, n = 0;
  for (let y = 0; y + 1 < h; y++) {
    let ma = 0, mb = 0;
    for (let x = 0; x < w; x++) { ma += d[(y * w + x) * 4 + 1]; mb += d[((y + 1) * w + x) * 4 + 1]; }
    ma /= w; mb /= w;
    let nu = 0, da = 0, db = 0;
    for (let x = 0; x < w; x++) {
      const u = d[(y * w + x) * 4 + 1] - ma, v = d[((y + 1) * w + x) * 4 + 1] - mb;
      nu += u * v; da += u * u; db += v * v;
    }
    if (da > 0 && db > 0) { s += nu / Math.sqrt(da * db); n++; }
  }
  return n ? s / n : 0;
}

/** Chroma/luma ratio and the two structure metrics, all with PLAIN correlation (no differencing). */
function chromaMetrics(img) {
  const w = img.width, h = img.height, d = img.data;
  const cv = (a, b) => {
    const n = Math.min(a.length, b.length);
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let nu = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; nu += u * v; da += u * u; db += v * v; }
    return (da > 0 && db > 0) ? nu / Math.sqrt(da * db) : 0;
  };
  const gr = [], lum = [];
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const G = d[(y * w + x) * 4 + 1], R = d[(y * w + x) * 4], B = d[(y * w + x) * 4 + 2];
      gr.push(G - R); lum.push((G + R + B) / 3); row.push(G - R);
    }
    rows.push(row);
  }
  const sd = (a) => { let m = 0; for (const v of a) m += v; m /= a.length;
    let v2 = 0; for (const v of a) v2 += (v - m) * (v - m); return Math.sqrt(v2 / a.length); };
  let x1 = 0;
  for (const r of rows) x1 += cv(r.slice(0, r.length - 1), r.slice(1));
  x1 /= h;
  let y1 = 0;
  for (let y = 0; y + 1 < h; y++) y1 += cv(rows[y], rows[y + 1]);
  y1 /= (h - 1);
  const sgr = sd(gr), sl = sd(lum);
  return { sdGR: sgr, sdL: sl, ratio: sl ? sgr / sl : 0, x1: x1, y1: y1 };
}

function savePng(img, name) {
  if (!pngjs) return null;
  const png = new pngjs.PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  const p = path.join(OUT, name);
  fs.writeFileSync(p, pngjs.PNG.sync.write(png));
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

(async function main() {
  console.log('=== 估计器 vs 时序：phigros 的伤害在哪一环 ===\n');
  const b = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const info = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const x = info.samples;
  console.log('音频 ' + info.duration.toFixed(2) + ' s @ ' + info.sampleRate + ' Hz');

  const refs = [];
  const dec = await Decode.decode(x, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  const cal = dec.calibration || {};
  const scale = Number(cal.scale), off = Number(cal.offsetHz);
  console.log('解码器: source=' + cal.source + ' · scale=' + scale.toFixed(6) + ' · rows=' + refs.length);

  // A: production output, and A': my own FFT-peak estimator on the same refs (sanity: should match A)
  const A = dec.imageData;
  const mA = chromaMetrics(A), rA = rowCorr(A);
  console.log('\n[A] 生产解码器输出      行间相关 ' + rA.toFixed(4) + ' · σ(G−R) ' + mA.sdGR.toFixed(1) +
    ' · σ(L) ' + mA.sdL.toFixed(1) + ' · 比 ' + mA.ratio.toFixed(4) +
    ' · 沿x ' + mA.x1.toFixed(3) + ' · 沿y ' + mA.y1.toFixed(3));
  const fileA = savePng(A, 'estim-A-production.png');

  // B: phase-difference discriminator on the SAME refs
  const t0 = Date.now();
  const track = discriminatorTrack(x, SR, 1.0);
  console.log('\n[B] 相位差鉴频器（同一 refs）· 轨迹构建 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  const calF = (f) => (f - off) / scale;
  const B = compose((at) => calF(track[Math.max(0, Math.min(track.length - 1, at))]), refs, MODE.width, MODE.height);
  const mB = chromaMetrics(B), rB = rowCorr(B);
  console.log('    输出                行间相关 ' + rB.toFixed(4) + ' · σ(G−R) ' + mB.sdGR.toFixed(1) +
    ' · σ(L) ' + mB.sdL.toFixed(1) + ' · 比 ' + mB.ratio.toFixed(4) +
    ' · 沿x ' + mB.x1.toFixed(3) + ' · 沿y ' + mB.y1.toFixed(3));
  const fileB = savePng(B, 'estim-B-discriminator.png');

  // C: discriminator with a shorter low-pass (more bandwidth, more noise)
  const track2 = discriminatorTrack(x, SR, 0.4);
  const C = compose((at) => calF(track2[Math.max(0, Math.min(track2.length - 1, at))]), refs, MODE.width, MODE.height);
  const mC = chromaMetrics(C), rC = rowCorr(C);
  console.log('\n[C] 鉴频器（0.4 ms 低通）行间相关 ' + rC.toFixed(4) + ' · 比 ' + mC.ratio.toFixed(4) +
    ' · 沿x ' + mC.x1.toFixed(3) + ' · 沿y ' + mC.y1.toFixed(3));
  const fileC = savePng(C, 'estim-C-discriminator-fast.png');

  // D: A's own estimator, but averaging a few taps (tests whether per-pixel variance is the issue)
  const D = compose((at) => {
    let s = 0, n = 0;
    for (let d = -5; d <= 5; d++) { const j = at + d; if (j >= 0 && j < x.length) { s += fftPeak(x, j, Math.round(PIXEL * 2.48), 1000, 2600); n++; } }
    return n ? s / n : 1500;
  }, refs, MODE.width, MODE.height);
  const mD = chromaMetrics(D), rD = rowCorr(D);
  console.log('\n[D] 生产估计器 + 11 点平滑 行间相关 ' + rD.toFixed(4) + ' · 比 ' + mD.ratio.toFixed(4) +
    ' · 沿x ' + mD.x1.toFixed(3) + ' · 沿y ' + mD.y1.toFixed(3));
  const fileD = savePng(D, 'estim-D-smoothed.png');

  // ---------------------------------------------------------------- verdict
  const REF = { ratio: 0.7952, x1: 0.548, y1: 0.150 };   // Robot36 reference, measured earlier
  console.log('\n===== 对照（Robot36 参照: 比 0.795 · 沿x 0.548 · 沿y 0.150）=====');
  const rows = [['A 生产', rA, mA, fileA], ['B 鉴频 1.0ms', rB, mB, fileB],
    ['C 鉴频 0.4ms', rC, mC, fileC], ['D FFT+平滑', rD, mD, fileD]];
  console.log('  方案            行间相关   色度比   沿x     沿y    与参照差距(比/沿x/沿y)');
  for (const [nm, rc, m, f] of rows) {
    console.log('  ' + nm.padEnd(14) + rc.toFixed(4).padStart(8) + '  ' + m.ratio.toFixed(4).padStart(8) +
      '  ' + m.x1.toFixed(3).padStart(6) + '  ' + m.y1.toFixed(3).padStart(6) + '   ' +
      Math.abs(m.ratio - REF.ratio).toFixed(3) + '/' + Math.abs(m.x1 - REF.x1).toFixed(3) + '/' +
      Math.abs(m.y1 - REF.y1).toFixed(3));
  }
  const best = rows.slice(1).sort((a, b2) =>
    (Math.abs(a[2].ratio - REF.ratio) + Math.abs(a[2].x1 - REF.x1) + Math.abs(a[2].y1 - REF.y1)) -
    (Math.abs(b2[2].ratio - REF.ratio) + Math.abs(b2[2].x1 - REF.x1) + Math.abs(b2[2].y1 - REF.y1)))[0];
  const distA = Math.abs(mA.ratio - REF.ratio) + Math.abs(mA.x1 - REF.x1) + Math.abs(mA.y1 - REF.y1);
  const distBest = Math.abs(best[2].ratio - REF.ratio) + Math.abs(best[2].x1 - REF.x1) + Math.abs(best[2].y1 - REF.y1);
  console.log('\n  最接近参照的是: ' + best[0] + '（总差距 ' + distBest.toFixed(3) + ' vs 生产 A 的 ' +
    distA.toFixed(3) + '）');
  console.log('  => ' + (distBest < distA * 0.7
    ? '★ 换估计器可显著接近参照 → 伤害在【逐像素估计器】✓'
    : (distBest < distA
      ? '换估计器有改善但不显著 → 需要更根本的改变'
      : '换估计器无改善 → 伤害不在估计器，而在【时序/参考】✗')));

  fs.writeFileSync(path.join(OUT, 'estimator-vs-timing.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), calibration: { scale: scale, offsetHz: off, source: cal.source },
    reference: REF,
    variants: rows.map(([nm, rc, m, f]) => ({ name: nm, rowCorr: rc, metrics: m, file: f })),
    best: best[0], distA: distA, distBest: distBest
  }, null, 2));
  console.log('\n  图片与数据 -> tests/diag-quality/estim-*.png · estimator-vs-timing.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
