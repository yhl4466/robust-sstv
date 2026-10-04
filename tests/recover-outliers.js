/*
 * Phase 50: does CONFIDENCE-BASED PIXEL RECOVERY help the real acoustic recording?
 *
 * THE RECORDING IS REAL ACOUSTIC DATA - established this round, and it corrects a misunderstanding that
 * had persisted for several rounds. `tests/fixtures/phigros.wav` and `acoustic-real-m1.m4a.mp3` are the
 * same file (byte-identical, MP3 at 48 kHz stereo, 220.5 s, despite the .wav extension), and the user
 * confirms it is a phone recording of the transmission played through the computer's speakers. So this
 * project HAS had real speaker-to-microphone data all along; it was simply being described as an
 * off-air/electrical recording.
 *
 * What the acoustic chain left behind, measured on the file itself:
 *   - room noise floor: sigma_flat 15.16 against a clean-decode reference of 5.4, so the denoiser's gate
 *     (9.72) engages on it
 *   - low-frequency rumble: <100 Hz at -25.6 dB of total
 *   - the decoder still locks all 256 lines with 0 free-runs and reports a = 1.000108, b = -0.29 Hz
 *   - row correlation 0.6855, chroma ratio 0.6292 (Robot36 reference render measures 0.7952)
 *
 * The residual after that is the remaining defect. Phase 49 measured its shape on synthetic reverb: the
 * estimator's VARIANCE barely moves (sigma 7.40 -> 8.18 levels, clean -> RT60 0.30 s) while the EXTREMES
 * blow up (134 -> 224/254) and the MAD goes 0 -> 14. The damage is therefore concentrated in a minority
 * of pixels that have been captured outright, not spread as a uniform precision loss.
 *
 * That is a specific, testable claim about the real recording too: if it holds, then identifying and
 * repairing only those outlier pixels should reduce noise a lot while touching the rest of the picture
 * not at all - which is the property that makes it safe for the synthetic baselines, where the same
 * operation must NOT fire (or must cost almost nothing).
 *
 * This measures, on the real recording and on truth-known synthetic controls:
 *   - how many pixels are classified as outliers at each threshold
 *   - what happens to the image when they are replaced by a local median
 *   - the PSNR cost on the controls, which decides whether the operation is safe to ship
 *
 * Usage: node tests/recover-outliers.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Channel = require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** sigma_flat: the production gate's own measurement, so results are in the same units. */
function noiseStats(img) {
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
  const sdHF = Math.sqrt(v / n);
  const gs = Array.prototype.slice.call(grad).sort((a, b) => a - b);
  const cut = gs[Math.floor(0.25 * n)];
  let ss = 0, c2 = 0;
  for (let i = 0; i < n; i++) if (grad[i] <= cut) { ss += res[i] * res[i]; c2++; }
  const sdGR = (() => {
    let s = 0, s2 = 0, c = 0;
    for (let i = 0; i < d.length; i += 4) { const t = d[i + 1] - d[i]; s += t; s2 += t * t; c++; }
    return Math.sqrt(Math.max(0, s2 / c - (s / c) * (s / c)));
  })();
  return { sigmaFlat: Math.sqrt(ss / (c2 || 1)), sigmaHF: sdHF, sdGR: sdGR };
}

/**
 * Replace pixels that are OUTLIERS against their own neighbourhood, using the local median.
 *
 * The classifier is deliberately local and relative: a pixel is an outlier when it departs from the
 * median of its 3x3 neighbourhood by more than `k` times the image's own flat-region sigma. Using the
 * image's own sigma makes the threshold content-independent, and using a local median means a genuine
 * edge (where the neighbourhood straddles two levels) does not look like an outlier.
 */
function recoverOutliers(img, sigmaFlat, k) {
  const w = img.width, h = img.height, src = img.data;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  const thr = k * sigmaFlat;
  const win = new Float64Array(9);
  let touched = 0;
  for (let c = 0; c < 3; c++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          win[n++] = src[((y + dy) * w + (x + dx)) * 4 + c];
        }
        for (let a = 1; a < n; a++) {
          const key = win[a]; let b = a - 1;
          while (b >= 0 && win[b] > key) { win[b + 1] = win[b]; b--; }
          win[b + 1] = key;
        }
        const med = win[n >> 1];
        const i = (y * w + x) * 4 + c;
        if (Math.abs(src[i] - med) > thr) { out[i] = med; touched++; }
      }
    }
  }
  return { width: w, height: h, data: out, touched: touched, total: w * h * 3 };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== 置信度/离群像素恢复 ===\n');

  const cases = [];
  // ---- the real recording: real acoustic data ----
  const buf = fs.readFileSync(path.join(OUT, 'acoustic-real-48k-mono.wav'));
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const rr = await Decode.decode(info.samples, info.sampleRate,
    { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  cases.push({ label: '真机手机录音 (phigros)', img: rr.imageData, truth: null });

  // ---- truth-known controls, where the PSNR cost is what decides safety ----
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const src = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(src, Modes.get('S1')), SR).samples;
  for (const [label, sig] of [['合成 S1 clean（基线 30.50）', clean],
                              ['合成 S1 AWGN 20 dB', Channel.Channel.awgn(clean, 20, 12345)],
                              ['合成 S1 AWGN 10 dB', Channel.Channel.awgn(clean, 10, 12345)]]) {
    const r = await Decode.decode(sig, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    cases.push({ label: label, img: r.imageData, truth: src,
      base: psnr(r.imageData.data, src.data) });
  }

  console.log('  用例                           σ_flat  σ_HF   基线PSNR');
  for (const c of cases) {
    const s = noiseStats(c.img);
    c.noise = s;
    console.log('  ' + c.label.padEnd(30) + s.sigmaFlat.toFixed(2).padStart(7) +
      s.sigmaHF.toFixed(2).padStart(7) + (c.base == null ? '      --' : c.base.toFixed(2).padStart(10)));
  }

  console.log('\n  离群阈值 k 下的效果（阈值 = k × 该图自身 σ_flat）');
  const ks = [1.5, 2.0, 2.5, 3.0, 4.0];
  const table = [];
  for (const k of ks) {
    console.log('\n  k = ' + k.toFixed(1));
    const row = { k: k, cells: [] };
    for (const c of cases) {
      const rec = recoverOutliers(c.img, c.noise.sigmaFlat, k);
      const ns = noiseStats(rec);
      const p = c.truth ? psnr(rec.data, c.truth.data) : null;
      row.cells.push({ label: c.label, pct: 100 * rec.touched / rec.total,
        sigmaFlat: ns.sigmaFlat, sigmaHF: ns.sigmaHF, sdGR: ns.sdGR, psnr: p,
        dPsnr: p == null ? null : p - c.base });
      console.log('    ' + c.label.padEnd(30) + ' 触及 ' + (100 * rec.touched / rec.total).toFixed(2).padStart(6) +
        '%  σ_flat ' + c.noise.sigmaFlat.toFixed(2) + '→' + ns.sigmaFlat.toFixed(2) +
        '  σ_HF ' + c.noise.sigmaHF.toFixed(2) + '→' + ns.sigmaHF.toFixed(2) +
        '  色度σ ' + c.noise.sdGR.toFixed(1) + '→' + ns.sdGR.toFixed(1) +
        (p == null ? '' : '  PSNR ' + p.toFixed(2) + ' (' + (p - c.base >= 0 ? '+' : '') + (p - c.base).toFixed(2) + ')'));
    }
    table.push(row);
  }

  /*
   * The decision. A setting is ship-able only if it leaves the truth-known controls inside the
   * acceptance floors (M1 >= 31.13, S1 >= 30.40 dB) - so at most 0.10 dB of loss on S1 - while doing
   * something measurable on the real recording. Both halves are read off the table, not assumed.
   */
  console.log('\n  --- 可发布性判断（合成 S1 允许的最大损失 0.10 dB）---');
  for (const row of table) {
    const syn = row.cells.find((c) => c.label.indexOf('clean') >= 0);
    const real = row.cells.find((c) => c.label.indexOf('真机') >= 0);
    const ok = syn.dPsnr >= -0.10;
    console.log('    k = ' + row.k.toFixed(1) + '  合成损失 ' + syn.dPsnr.toFixed(3) + ' dB  ' +
      (ok ? '✓ 可发布' : '✗ 超出容差') + ' · 真机触及 ' + real.pct.toFixed(2) + '%  σ_HF ' +
      real.sigmaHF.toFixed(2));
  }

  fs.writeFileSync(path.join(OUT, 'outlier-recovery.json'), JSON.stringify(table, null, 2));
  console.log('\n证据 -> tests/diag-quality/outlier-recovery.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
