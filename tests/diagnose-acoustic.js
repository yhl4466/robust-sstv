/*
 * Acoustic-path diagnosis over the existing portfolio, including the GENUINELY REAL recordings.
 *
 * WHY THIS EXISTS
 *   Phase 50 task 1 asks for a phone recording of speaker playback. None has been supplied, and this
 *   script does not pretend otherwise: `kind: real` below means an untouched real-world recording, and
 *   `realistic-synthetic` means a real recording passed through the phase-6 impairment suite. The
 *   distinction comes from tests/fixtures/real/manifest.json and is kept in every line of output.
 *
 *   What this DOES establish, and what the earlier phase-49 work missed:
 *
 *   1. There are TWO genuinely real recordings available (an off-air reception shipped with the `sstv`
 *      npm package, and colaclanth's example). The phase-49 matrix only ever compared synthetic against
 *      synthetic, so it never anchored "how bad is real" at all.
 *   2. The portfolio already contains an ACOUSTIC model richer than the one the phase-49 matrix used:
 *      `acoustic-band` adds a speaker/microphone band tilt and mains hum to RT60 0.4 s. The matrix's
 *      reverb-only cells cannot show what a band tilt does, and a tilt is exactly the kind of thing a
 *      pre-filter CAN fix - unlike reverb, which phase 49 proved it cannot.
 *
 *   So this measures, per fixture: decode success, PSNR against the reference where one exists, the
 *   lock residuals, the chroma ratio and sigma_HF, and - for the acoustic group - the spectral
 *   difference from the real recording it was derived from, which is what names the mechanism.
 *
 * Usage: node tests/diagnose-acoustic.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const REALDIR = path.join(ROOT, 'tests', 'fixtures', 'real');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, Modes = globalThis.SSTVModes;
let PNG = null;
try { PNG = require(path.join(RESEARCH, 'pngjs')).PNG; } catch (e) {}

const MANIFEST = JSON.parse(fs.readFileSync(path.join(REALDIR, 'manifest.json'), 'utf8'));

function resolve(p) {
  /*
   * The manifest mixes two path conventions and they are NOT relative to the same base:
   *   'tests/...'   -> relative to the project root
   *   '../...'      -> relative to the project root as well (scripts/diagnose-failures.js joins it the
   *                    same way), NOT to tests/fixtures/real where the manifest lives
   * Resolving both against REALDIR made every sample report as missing, which at least failed loudly
   * rather than silently decoding the wrong file.
   */
  return path.resolve(ROOT, p);
}

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Residual spread of the per-line lock, after removing the linear trend. */
function lockStats(refs) {
  const locked = refs.filter((r) => !r.freeRun);
  if (locked.length < 8) return null;
  const N = locked.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += i; sy += locked[i].ref; sxx += i * i; sxy += i * locked[i].ref; }
  const den = N * sxx - sx * sx;
  const slope = den ? (N * sxy - sx * sy) / den : 0, inter = (sy - slope * sx) / N;
  const res = locked.map((r, i) => r.ref - (inter + slope * i));
  const s = res.slice().sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  const mad = res.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(res.length / 2)];
  return { n: N, freeRun: refs.length - N, mad: mad, periodSamples: slope };
}

/** Image statistics with no reference needed: chroma ratio and the flat-region noise. */
function imageStats(img) {
  const w = img.width, h = img.height, d = img.data, n = w * h;
  const lum = new Float64Array(n);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    lum[k] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const grad = new Float64Array(n), res = new Float64Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
      const gx = lum[y * w + xp] - lum[y * w + xm];
      const gy = lum[yp * w + x] - lum[ym * w + x];
      grad[y * w + x] = Math.hypot(gx, gy);
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        s += lum[yy * w + xx]; c++;
      }
      res[y * w + x] = lum[y * w + x] - s / c;
    }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += res[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (res[i] - m) * (res[i] - m);
  let sL = 0, sL2 = 0, sGR = 0, sGR2 = 0;
  for (let i = 0; i < d.length; i += 4) {
    const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const gr = d[i + 1] - d[i];
    sL += L; sL2 += L * L; sGR += gr; sGR2 += gr * gr;
  }
  const sdL = Math.sqrt(Math.max(0, sL2 / n - (sL / n) * (sL / n)));
  const sdGR = Math.sqrt(Math.max(0, sGR2 / n - (sGR / n) * (sGR / n)));
  return { sigmaHF: Math.sqrt(v / n), ratioGR: sdL > 1e-9 ? sdGR / sdL : null, sdL: sdL, sdGR: sdGR };
}

/**
 * Spectrum of a signal in dB on a coarse grid, restricted to the SSTV band plus margin.
 *
 * Welch-style: many short segments, Hann-windowed, averaged. The averaging is what makes the comparison
 * meaningful - a single long FFT of a signal whose content sweeps 1500-2300 Hz continuously just shows
 * the sweep, not the channel.
 */
function spectrum(x, nfft, hop) {
  const N = nfft || 2048;
  const H = hop || N / 2;
  const acc = new Float64Array(N / 2 + 1);
  let count = 0;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  for (let off = 0; off + N <= x.length; off += H) {
    for (let i = 0; i < N; i++) re[i] = (x[off + i] || 0) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    new globalThis.FFT(N).realTransform(o, re);
    for (let k = 0; k <= N / 2; k++) acc[k] += o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
    count++;
  }
  if (!count) return null;
  const db = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) db[k] = 10 * Math.log10(Math.max(acc[k] / count, 1e-20));
  return { db: db, binHz: 8000 / N, nfft: N };
}

/** Band energy in dB relative to the total, over named bands. */
function bandEnergy(x, bands) {
  const sp = spectrum(x);
  if (!sp) return null;
  let total = 0;
  for (let k = 1; k <= sp.nfft / 2; k++) total += Math.pow(10, sp.db[k] / 10);
  const out = {};
  for (const b of bands) {
    let e = 0;
    const k0 = Math.max(1, Math.round(b[0] / sp.binHz)), k1 = Math.min(sp.nfft / 2, Math.round(b[1] / sp.binHz));
    for (let k = k0; k <= k1; k++) e += Math.pow(10, sp.db[k] / 10);
    out[b[2]] = 10 * Math.log10(Math.max(e / total, 1e-20));
  }
  return out;
}

const BANDS = [[0, 100, '0-100'], [100, 300, '100-300'], [300, 1200, '300-1200'],
  [1200, 1500, '1200-1500'], [1500, 2300, '1500-2300'], [2300, 2700, '2300-2700'],
  [2700, 4000, '2700-4000']];

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  console.log('=== 声学路径组合诊断 ===\n');
  console.log('  kind=real 为未经处理真实录音；kind=realistic-synthetic 为真实录音经阶段六退化套件派生。');
  console.log('  两者不得混报（tests/fixtures/real/manifest.json 的规定）。\n');

  const wanted = MANIFEST.samples.filter((s) => s.group === 'acoustic' || s.kind === 'real');
  console.log('  样本                    kind                  采样率  时长   解码   PSNR     锁MAD  σ_HF    色度比');
  for (const s of wanted) {
    const file = resolve(s.file);
    if (!fs.existsSync(file)) { console.log('  ' + s.id.padEnd(24) + ' 文件缺失: ' + s.file); continue; }
    const buf = fs.readFileSync(file);
    const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const refs = [];
    let r = null, err = null;
    try {
      r = await Decode.decode(info.samples, info.sampleRate,
        { quality: 'standard', yieldEvery: 0, postprocess: 'off', auditLineRefs: refs });
    } catch (e) { err = e.message; }
    const ls = r && r.ok ? lockStats(refs) : null;
    const st = r && r.ok ? imageStats(r.imageData) : null;
    let p = null;
    if (r && r.ok && s.reference && PNG) {
      const rp = resolve(s.reference);
      if (fs.existsSync(rp)) {
        const ref = PNG.sync.read(fs.readFileSync(rp));
        if (ref.width === r.imageData.width && ref.height === r.imageData.height) {
          p = psnr(r.imageData.data, ref.data);
        }
      }
    }
    rows.push({ id: s.id, kind: s.kind, group: s.group || null, label: s.label || null,
      sampleRate: info.sampleRate, duration: info.duration, ok: !!(r && r.ok),
      message: r && !r.ok ? r.message : (err || null),
      mode: r && r.ok && r.mode ? r.mode.name : null, psnr: p,
      lock: ls, image: st,
      clockScale: r && r.ok ? r.calibration.clockScale : null,
      scale: r && r.ok ? r.calibration.scale : null,
      offsetHz: r && r.ok ? r.calibration.offsetHz : null });
    console.log('  ' + s.id.padEnd(24) + ' ' + s.kind.padEnd(21) + String(info.sampleRate).padStart(6) +
      String(info.duration.toFixed(0)).padStart(6) + '  ' +
      (r && r.ok ? ' ok ' : ' 失败') + '  ' +
      (p == null ? '   --  ' : p.toFixed(2).padStart(6)) + '  ' +
      (ls ? ls.mad.toFixed(1).padStart(5) : '   --') + '  ' +
      (st ? st.sigmaHF.toFixed(2).padStart(6) : '    --') + '  ' +
      (st && st.ratioGR != null ? st.ratioGR.toFixed(3).padStart(6) : '    --') +
      (r && !r.ok ? '   ' + (r.message || '').slice(0, 30) : ''));
  }

  /* ------------------------------------------------------------------ spectral comparison */
  console.log('\n  --- 频谱对比：acoustic 组 vs 它派生自的真实录音 real-npm-8k ---');
  const base = resolve(MANIFEST.samples.find((s) => s.id === 'real-npm-8k').file);
  const acoustic = MANIFEST.samples.filter((s) => s.group === 'acoustic');
  if (fs.existsSync(base)) {
    const bb = fs.readFileSync(base);
    const bi = Wav.parse(bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength));
    const baseBands = bandEnergy(bi.samples, BANDS);
    console.log('    频段占比(dB)         ' + BANDS.map((b) => b[2].padStart(10)).join(''));
    console.log('    ' + 'real-npm-8k'.padEnd(20) + BANDS.map((b) => baseBands[b[2]].toFixed(1).padStart(10)).join(''));
    for (const s of acoustic) {
      const f = resolve(s.file);
      if (!fs.existsSync(f)) continue;
      const b2 = fs.readFileSync(f);
      const i2 = Wav.parse(b2.buffer.slice(b2.byteOffset, b2.byteOffset + b2.byteLength));
      const e2 = bandEnergy(i2.samples, BANDS);
      const diff = BANDS.map((b) => (e2[b[2]] - baseBands[b[2]]));
      console.log('    ' + s.id.padEnd(20) + diff.map((v) => (v >= 0 ? '+' : '') + v.toFixed(1)).map((v) => v.padStart(10)).join(''));
      rows.find((r) => r.id === s.id).bandDiffDb = {};
      BANDS.forEach((b, k) => { rows.find((r) => r.id === s.id).bandDiffDb[b[2]] = diff[k]; });
    }
    console.log('\n    差值 = 该样本频段能量占比 − 真实录音同频段占比（dB）。负值表示该频段被压低。');
  } else {
    console.log('    缺少 real-npm-8k，无法做频谱对比');
  }

  fs.writeFileSync(path.join(OUT, 'acoustic-diagnosis.json'), JSON.stringify({
    note: 'kind=real is untouched; kind=realistic-synthetic is derived. Never mix them in reporting.',
    rows: rows
  }, null, 2));
  console.log('\n证据 -> tests/diag-quality/acoustic-diagnosis.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
