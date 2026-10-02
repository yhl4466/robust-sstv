/*
 * Phase-6 root-cause analysis (AC4) + AFC/clock crossover search (AC3).
 *
 * Two questions the portfolio alone cannot answer:
 *
 *  1. WHY do ssb-hum / ssb-adjacent / acoustic-band fail at findHeader while ssb-agc and
 *     the QSB cases (same SSB filter) decode fine? One-factor-at-a-time ablation: apply
 *     each ingredient alone to the clean real recording and see which one reproduces the
 *     failure. Guessing from the combined recipes would be unscientific.
 *
 *  2. AFC and clock recovery contributed ~0 dB across the portfolio. That is expected when
 *     the impairment is much smaller than the SSTV pixel window, so the crossover is
 *     searched explicitly with growing clock error until the correction starts to pay.
 *
 * Usage: node scripts/diagnose-failures.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'out');
const REALDIR = path.join(ROOT, 'tests', 'fixtures', 'real');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const SSTVWav = globalThis.SSTVWav, Dec = globalThis.SSTVDecode;
const { PNG } = require(path.join(RESEARCH, 'pngjs'));

const SRC = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.wav');
const REF = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.png');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); };
const peak = (x) => { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; };

function biquad(x, sr, type, f0, q, gainDb) {
  const w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peak') {
    const A = Math.pow(10, gainDb / 40);
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
function addTone(x, sr, f, levelDb) {
  const r = rms(x), amp = r * Math.pow(10, levelDb / 20), out = Float32Array.from(x);
  for (let i = 0; i < out.length; i++) out[i] += amp * Math.sin(2 * Math.PI * f * i / sr);
  return out;
}
function addHumTones(x, sr, levelDb) {
  const r = rms(x), amp = r * Math.pow(10, levelDb / 20), out = Float32Array.from(x);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] += amp * (Math.sin(2 * Math.PI * 50 * t) + 0.4 * Math.sin(2 * Math.PI * 150 * t) + 0.2 * Math.sin(2 * Math.PI * 250 * t));
  }
  return out;
}
function convolve(x, h) {
  const y = new Float32Array(x.length);
  for (let j = 0; j < h.length; j++) {
    const hj = h[j];
    if (!hj) continue;
    for (let i = 0; i + j < x.length; i++) y[i + j] += x[i] * hj;
  }
  return y;
}
function makeRIR(sr, rt60, seed) {
  const n = Math.max(64, Math.round(rt60 * sr * 1.2)), rnd = mulberry32(seed);
  const h = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const env = Math.pow(10, -3 * (i / sr) / rt60);
    h[i] = (rnd() * 2 - 1) * env; acc += h[i] * h[i];
  }
  const norm = Math.sqrt(acc) || 1;
  for (let i = 0; i < n; i++) h[i] /= norm;
  h[0] += 1;
  return h;
}
function clockWarp(x, sr, ppm) {
  const out = new Float32Array(x.length);
  let t = 0;
  const rate = 1 + ppm * 1e-6;
  for (let i = 0; i < x.length; i++) {
    t += rate;
    const i0 = Math.floor(t), i1 = Math.min(x.length - 1, i0 + 1), w = t - i0;
    out[i] = i0 < x.length ? x[i0] * (1 - w) + x[i1] * w : 0;
  }
  return out;
}
function norm(x, target) {
  const g = (target || 0.7) / (peak(x) || 1);
  const y = Float32Array.from(x);
  for (let i = 0; i < y.length; i++) y[i] *= g;
  return y;
}
function psnr(img, ref) {
  if (!img || !ref || img.width !== ref.width || img.height !== ref.height) return null;
  let se = 0, n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    for (const o of [0, 1, 2]) { const d = img.data[i * 4 + o] - ref.data[i * 4 + o]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
async function run(samples, sr, opts) {
  try {
    const r = await Dec.decode(samples, sr, Object.assign({ quality: 'standard', yieldFn: () => Promise.resolve() }, opts));
    return r;
  } catch (e) { return { ok: false, stage: 'exception', message: e.message }; }
}

(async function main() {
  const parsed = SSTVWav.parse(fs.readFileSync(SRC).buffer.slice(0));
  const base = parsed.samples, sr = parsed.sampleRate;
  const refPng = PNG.sync.read(fs.readFileSync(REF));
  const ref = { data: new Uint8ClampedArray(refPng.data), width: refPng.width, height: refPng.height };

  // ---------------- AC4: one-factor ablation ----------------
  console.log('=== AC4 root cause: one-factor-at-a-time ablation on the clean real recording ===\n');
  const ssb = (x) => biquad(biquad(x, sr, 'lp', 300, 0.7), 0, 'lp', 1, 1); // placeholder replaced below
  const variants = [
    { id: 'clean', label: 'untouched', x: base },
    { id: 'ssb-only', label: 'SSB 300-2700 only', x: biquad(biquad(base, sr, 'hp', 300, 0.7), sr, 'lp', 2700, 0.7) },
    { id: 'hum-only', label: '50 Hz hum -20 dB only', x: addHumTones(base, sr, -20) },
    { id: 'adjacent-only', label: 'adjacent 2700 Hz tone -14 dB only', x: addTone(base, sr, 2700, -14) },
    { id: 'adjacent-2850', label: 'adjacent 2850 Hz tone -14 dB only', x: addTone(base, sr, 2850, -14) },
    { id: 'lp-only', label: 'low-pass 2700 Hz only (no HP)', x: biquad(base, sr, 'lp', 2700, 0.7) },
    { id: 'tilt-only', label: 'band tilt -8/-14 dB only', x: biquad(biquad(base, sr, 'peak', 900, 1.0, -8), sr, 'peak', 2600, 1.0, -14) },
    { id: 'rir-only', label: 'room RT60 0.4 s only', x: convolve(base, makeRIR(sr, 0.4, 13)) },
    { id: 'tilt+rir', label: 'tilt + room 0.4 s', x: convolve(biquad(biquad(base, sr, 'peak', 900, 1.0, -8), sr, 'peak', 2600, 1.0, -14), makeRIR(sr, 0.4, 13)) },
    { id: 'ssb-hum', label: 'SSB + hum (the failing recipe)', x: addHumTones(biquad(biquad(base, sr, 'hp', 300, 0.7), sr, 'lp', 2700, 0.7), sr, -20) },
    { id: 'ssb-adjacent', label: 'SSB + adjacent (the failing recipe)', x: addTone(biquad(biquad(base, sr, 'hp', 300, 0.7), sr, 'lp', 2700, 0.7), sr, 2700, -14) }
  ];
  console.log('| ablation | result | stage | PSNR | sigmaHF | notes |');
  console.log('|---|---|---|---|---|---|');
  const ablation = [];
  for (const v of variants) {
    const x = norm(v.x, 0.7);
    const r = await run(x, sr, {});
    let line;
    if (r.ok) {
      const p = psnr(r.imageData, ref);
      line = `| ${v.label} | OK | - | ${p != null ? p.toFixed(2) + ' dB' : '-'} | - | |`;
    } else {
      line = `| ${v.label} | **FAIL** | ${r.stage} | - | - | ${(r.message || '').slice(0, 28)} |`;
    }
    console.log(line);
    ablation.push({ id: v.id, label: v.label, ok: !!r.ok, stage: r.stage || null, psnr: r.ok ? psnr(r.imageData, ref) : null });
  }

  // ---------------- AC3: where does clock recovery start to pay? ----------------
  console.log('\n=== AC3 crossover: growing clock error, raw vs clock recovery vs affine ===\n');
  console.log('| clock error | true a | raw PSNR | affine+clock PSNR | affine a | raw sigmaHF | affine sigmaHF |');
  console.log('|---|---|---|---|---|---|---|');
  const cross = [];
  for (const ppm of [0, 200, 1000, 5000, 10000, 20000, 50000]) {
    const x = norm(ppm ? clockWarp(base, sr, ppm) : base, 0.7);
    const raw = await run(x, sr, { afc: false, clockRecovery: false });
    const aff = await run(x, sr, { afc: 'affine', clockRecovery: true });
    const pr = raw.ok ? psnr(raw.imageData, ref) : null;
    const pa = aff.ok ? psnr(aff.imageData, ref) : null;
    const shf = (r) => {
      if (!r.ok) return null;
      const d = r.imageData.data, w = r.imageData.width, h = r.imageData.height;
      let acc = 0, n = 0;
      for (let y = 1; y < h - 1; y++) for (let xx = 1; xx < w - 1; xx++) {
        const i = (y * w + xx) << 2;
        const mean = (d[i - 4] + d[i + 4] + d[i - w * 4] + d[i + w * 4]) / 4;
        acc += (d[i] - mean) * (d[i] - mean); n++;
      }
      return Math.sqrt(acc / n / 1.25);
    };
    console.log(`| ${(ppm / 10000).toFixed(4)} (${ppm} ppm) | ${(1 + ppm * 1e-6).toFixed(5)} | ` +
      `${pr != null ? pr.toFixed(2) + ' dB' : 'FAIL'} | ${pa != null ? pa.toFixed(2) + ' dB' : 'FAIL'} | ` +
      `${aff.ok ? aff.calibration.scale.toFixed(5) : '-'} | ${shf(raw) != null ? shf(raw).toFixed(2) : '-'} | ${shf(aff) != null ? shf(aff).toFixed(2) : '-'} |`);
    cross.push({ ppm, trueA: 1 + ppm * 1e-6, rawPsnr: pr, affinePsnr: pa,
      affineA: aff.ok ? aff.calibration.scale : null,
      rawOk: !!raw.ok, affineOk: !!aff.ok,
      rawStage: raw.stage || null, affineStage: aff.stage || null });
  }

  fs.writeFileSync(path.join(OUT, 'diagnose-failures.json'), JSON.stringify({ ablation, crossover: cross }, null, 2));
  console.log(`\n-> ${path.relative(ROOT, path.join(OUT, 'diagnose-failures.json'))}`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
