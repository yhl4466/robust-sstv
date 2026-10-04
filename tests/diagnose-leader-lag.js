/*
 * Where does the header locator's constant +13 ms lag come from?
 *
 * findHeaderByLeader reports the 1900 Hz leader at 0.547 s on a synthetic preamble where it provably
 * starts at 0.550 s, and the lag stayed at +10..+14 ms across window lengths of 2, 6, 8 and 20 ms and after
 * switching from a rectangular matched filter to a Hann-windowed FFT. A window-smearing explanation would
 * scale with window length, so that explanation is dead and the cause is something else.
 *
 * This prints the two tone envelopes around the boundary with no detection logic at all, so the crossover
 * can be read directly instead of inferred from where an algorithm fired.
 *
 * Usage: node tests/diagnose-leader-lag.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SR = 8000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));

const seg = [[1200, 0.300], [1900, 0.300], [1200, 0.030], [1900, 0.300]];
const lead = 0.25;
let t = lead;
const truth = [];
for (const [f, d] of seg) { truth.push({ f: f, start: t, dur: d }); t += d; }
console.log('合成前导真实布局:');
for (const r of truth) console.log('  ' + r.f + ' Hz  起点 ' + r.start.toFixed(4) + ' s  时长 ' + r.dur + ' s');

const total = lead + seg.reduce((s, q) => s + q[1], 0) + 0.20;
const n = Math.round(total * SR);
const x = new Float32Array(n);
for (const r of truth) {
  const off = Math.round(r.start * SR), len = Math.round(r.dur * SR);
  for (let i = 0; i < len; i++) x[off + i] = 0.4 * Math.sin(2 * Math.PI * r.f * i / SR);
}
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
for (let i = 0; i < n; i++) x[i] += 0.01 * rnd();
const rampLen = Math.round(0.100 * SR);
for (let i = 0; i < rampLen && i < n; i++) x[i] *= 0.88 + 0.12 * (i / rampLen);

/** Rectangular quadrature amplitude (what toneRms does). */
function quad(x, sr, off, len, freq) {
  const w = 2 * Math.PI * freq / sr;
  let re = 0, im = 0, c = 0;
  for (let i = 0; i < len; i++) {
    const v = x[off + i];
    if (v === undefined) break;
    re += v * Math.cos(w * i); im -= v * Math.sin(w * i); c++;
  }
  return c ? 2 * Math.hypot(re, im) / c : 0;
}

console.log('\n边界附近两音的幅度包络（矩形正交解调，窗长 8 ms）：');
console.log('  窗起点(s)   1200Hz      1900Hz     1900/1200');
const win = Math.round(0.008 * SR);
for (let tt = 0.530; tt <= 0.575; tt += 0.002) {
  const off = Math.round(tt * SR);
  const a12 = quad(x, SR, off, win, 1200);
  const a19 = quad(x, SR, off, win, 1900);
  console.log('  ' + tt.toFixed(3).padStart(9) + '  ' + a12.toFixed(5).padStart(9) + '  ' +
    a19.toFixed(5).padStart(9) + '  ' + (a19 / Math.max(a12, 1e-9)).toFixed(3).padStart(9) +
    (a19 / Math.max(a12, 1e-9) > 1.5 ? '   ← 判据在此成立' : ''));
}

console.log('\n同一段用 Hann-FFT（窗长 8 ms）：');
function hann(x, sr, off, len, freq) {
  const N = 1024;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  const use = Math.min(len, N);
  for (let i = 0; i < N; i++) {
    const v = i < use ? (x[off + i] || 0) : 0;
    re[i] = v * 0.5 * (1 - Math.cos(2 * Math.PI * i / (use - 1)));
  }
  new globalThis.FFT(N).realTransform(o, re);
  const kc = Math.round(freq * N / sr);
  let best = 0;
  for (let k = Math.max(1, kc - 2); k <= Math.min(N / 2 - 1, kc + 2); k++) {
    const m = Math.hypot(o[2 * k], o[2 * k + 1]);
    if (m > best) best = m;
  }
  return best;
}
console.log('  窗起点(s)   1200Hz      1900Hz     1900/1200');
for (let tt = 0.530; tt <= 0.575; tt += 0.002) {
  const off = Math.round(tt * SR);
  const a12 = hann(x, SR, off, win, 1200);
  const a19 = hann(x, SR, off, win, 1900);
  console.log('  ' + tt.toFixed(3).padStart(9) + '  ' + a12.toFixed(4).padStart(9) + '  ' +
    a19.toFixed(4).padStart(9) + '  ' + (a19 / Math.max(a12, 1e-9)).toFixed(3).padStart(9) +
    (a19 / Math.max(a12, 1e-9) > 1.5 ? '   ← 判据在此成立' : ''));
}
