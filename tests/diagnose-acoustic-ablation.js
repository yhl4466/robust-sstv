/*
 * Which ingredient of `acoustic-band` breaks the header search?
 *
 * tests/diagnose-acoustic.js found the only decode FAILURE in the acoustic group: `acoustic-band`
 * (recipe "room RT60 0.4 s; band tilt -8/-14 dB; AWGN 24 dB") never finds the SSTV calibration header,
 * while `acoustic-rt03` and `acoustic-rt06` - the same real recording, heavier reverb, mains hum and
 * MORE noise - decode fine. So the failure is not "too much acoustic degradation"; it is one specific
 * ingredient, and the recipe's own README cannot say which.
 *
 * The phase-6 root-cause notes for this fixture say the failure is at findHeader, which makes the
 * suspicion chemical rather than statistical: `tilt` applies two PEAK biquads at 900 Hz (-8 dB) and
 * 2600 Hz (-14 dB) with Q = 1.0. The 900 Hz peak is only 300 Hz below the 1200 Hz sync, and the
 * 2600 Hz peak is only 300 Hz above the top of the 2300 Hz image band - so a tilt meant to model a
 * speaker's passband may be punching holes into the signal itself.
 *
 * One-factor-at-a-time ablation on the real recording, exactly as scripts/diagnose-failures.js did for
 * the SSB cases, plus a direct measurement of what each op does to the three tones the header search
 * depends on (1900 Hz leader, 1200 Hz break/sync, 2300 Hz top of band).
 *
 * Usage: node tests/diagnose-acoustic-ablation.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 8000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;

const SRC = path.resolve(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.wav');
const REF = path.resolve(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.png');

// ---- the impairment ops, transcribed from scripts/build-real-portfolio.js so the ablation is faithful
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function biquad(x, sr, type, f0, q, gainDb) {
  const w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else if (type === 'peak') {
    const A = Math.pow(10, gainDb / 40);
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function makeRIR(sr, rt60, seed) {
  const n = Math.max(64, Math.round(rt60 * sr * 1.2));
  const rnd = mulberry32(seed || 11);
  const h = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    h[i] = (rnd() * 2 - 1) * Math.pow(10, -3 * t / rt60);
    acc += h[i] * h[i];
  }
  const norm = Math.sqrt(acc) || 1;
  for (let i = 0; i < n; i++) h[i] /= norm;
  h[0] += 1.0;
  return h;
}

function convolve(x, h) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    const k = Math.min(h.length, x.length - i);
    for (let j = 0; j < k; j++) acc += h[j] * x[i + j];
    out[i] = acc;
  }
  return out;
}

function addHum(x, sr, levelDb) {
  const out = Float32Array.from(x);
  let rms = 0;
  for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
  rms = Math.sqrt(rms / x.length);
  const amp = rms * Math.pow(10, levelDb / 20);
  for (let i = 0; i < x.length; i++) out[i] += amp * Math.sin(2 * Math.PI * 50 * i / sr);
  return out;
}

function addNoise(x, snrDb, seed) {
  const rnd = mulberry32(seed || 31);
  const out = Float32Array.from(x);
  let rms = 0;
  for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
  rms = Math.sqrt(rms / x.length);
  const sigma = rms / Math.pow(10, snrDb / 20);
  for (let i = 0; i < x.length; i++) {
    const u1 = rnd() || 1e-12, u2 = rnd();
    out[i] += sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return out;
}

/** Goertzel-style amplitude of one tone over a window: what the header probes actually see. */
function toneLevel(x, sr, freq, off, len) {
  const w = 2 * Math.PI * freq / sr;
  let re = 0, im = 0;
  for (let i = 0; i < len; i++) {
    const v = x[off + i] || 0;
    re += v * Math.cos(w * i); im -= v * Math.sin(w * i);
  }
  return 2 * Math.hypot(re, im) / len;
}

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}

/** Measured magnitude response of a cascade of ops, by running an impulse through the same code. */
function impulseResponseGain(ops, freqs, sr) {
  const N = 16384;
  const imp = new Float32Array(N);
  imp[0] = 1;
  let y = imp;
  for (const op of ops) y = op(y, sr);
  const out = {};
  for (const f of freqs) out[f] = 20 * Math.log10(Math.max(toneLevel(y, sr, f, 0, N), 1e-12));
  return out;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const buf = fs.readFileSync(SRC);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const base = info.samples;
  const sr = info.sampleRate;
  const ref = PNG.sync.read(fs.readFileSync(REF));

  console.log('=== acoustic-band 失败归因（单因素消融）===\n');
  console.log('  真实录音 real-npm-8k，' + sr + ' Hz, ' + info.duration.toFixed(1) + ' s');
  console.log('  配方原文：room RT60 0.4 s; band tilt -8/-14 dB; AWGN 24 dB\n');

  const tilt = (x, s) => biquad(biquad(x, s, 'peak', 900, 1.0, -8), s, 'peak', 2600, 1.0, -14);
  const rir = (x, s) => convolve(x, makeRIR(s, 0.4, 13));
  const hum = (x, s) => addHum(x, s, -22);
  const noise = (x, s) => addNoise(x, s, 24, 31);

  const cases = [
    { label: '无退化（对照）', ops: [] },
    { label: '仅 RT60 0.4', ops: [rir] },
    { label: '仅 tilt -8/-14', ops: [tilt] },
    { label: '仅 hum -22 dB', ops: [hum] },
    { label: '仅 AWGN 24 dB', ops: [noise] },
    { label: 'tilt + RT60', ops: [rir, tilt] },
    { label: '完整配方', ops: [rir, tilt, hum, noise] },
    { label: '完整配方去掉 tilt', ops: [rir, hum, noise] }
  ];

  console.log('  条件                   解码    PSNR     模式           备注');
  const rows = [];
  for (const c of cases) {
    let x = base;
    for (const op of c.ops) x = op(x, sr);
    const r = await Decode.decode(x, sr, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    const p = r.ok ? psnr(r.imageData.data, ref.data) : null;
    rows.push({ label: c.label, ok: r.ok, psnr: p, mode: r.ok && r.mode ? r.mode.name : null,
      message: r.ok ? null : r.message });
    console.log('  ' + c.label.padEnd(22) + (r.ok ? ' ok  ' : ' 失败') + '  ' +
      (p == null ? '   --  ' : p.toFixed(2).padStart(6)) + '  ' +
      (r.ok && r.mode ? r.mode.name.padEnd(12) : '            ') + '  ' +
      (r.ok ? '' : (r.message || '').slice(0, 34)));
  }

  /* ---- what the tilt does to the tones the header search needs ---- */
  console.log('\n  --- 各退化对关键音的实际增益（dB，脉冲响应实测）---');
  const freqs = [1200, 1500, 1900, 2100, 2300, 2600, 3000];
  console.log('    条件                ' + freqs.map((f) => (f + 'Hz').padStart(9)).join(''));
  const gains = {};
  for (const c of cases) {
    if (!c.ops.length) continue;
    const g = impulseResponseGain(c.ops.map((op) => (x, s) => op(x, s)), freqs, sr);
    gains[c.label] = g;
    console.log('    ' + c.label.padEnd(20) + freqs.map((f) => g[f].toFixed(1).padStart(9)).join(''));
  }

  /* ---- the header probes on the real signal, under the full recipe and without the tilt ---- */
  console.log('\n  --- 标定头三个探针在真实信号上的电平（相对无退化）---');
  const HEAD = { leader: [1.900, 0.310], leader2: [1.900, 0.920], brk: [1.200, 0.300], vis: [1.200, 0.610] };
  function probeGains(x) {
    const out = {};
    for (const k of Object.keys(HEAD)) {
      const f = HEAD[k][0], t = HEAD[k][1];
      const len = Math.round((k === 'leader' || k === 'leader2' ? 0.25 : 0.010) * sr);
      const off = Math.round(t * sr) + Math.round(0.02 * sr);
      out[k] = 20 * Math.log10(Math.max(toneLevel(x, sr, f, off, len), 1e-12));
    }
    return out;
  }
  const g0 = probeGains(base);
  const full = (() => { let x = base; for (const op of [rir, tilt, hum, noise]) x = op(x, sr); return x; })();
  const noTilt = (() => { let x = base; for (const op of [rir, hum, noise]) x = op(x, sr); return x; })();
  const gFull = probeGains(full), gNoTilt = probeGains(noTilt);
  console.log('    探针      完整配方      去掉 tilt');
  for (const k of Object.keys(HEAD)) {
    console.log('    ' + k.padEnd(10) + (gFull[k] - g0[k]).toFixed(1).padStart(8) + ' dB' +
      (gNoTilt[k] - g0[k]).toFixed(1).padStart(9) + ' dB');
  }

  fs.writeFileSync(path.join(OUT, 'acoustic-ablation.json'),
    JSON.stringify({ cases: rows, gains: gains, probes: { clean: g0, full: gFull, noTilt: gNoTilt } }, null, 2));
  console.log('\n证据 -> tests/diag-quality/acoustic-ablation.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
