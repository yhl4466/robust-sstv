/*
 * Verify the frequency-shift impairment against an FFT-based reference, on REAL signal content.
 *
 * The matrix reports a strong asymmetry - +50 Hz decodes at 31.29 dB but -50 Hz at 17.30 dB - and an
 * asymmetry that large cannot come from a spectral shift, which is symmetric by construction. Either
 * the decoder handles negative offsets badly or the shift itself is one-sided, and a tone test cannot
 * tell them apart (a tone shifts correctly by construction of the formula).
 *
 * So this compares our Hilbert-based shift against an independent reference that shares no code with
 * it: the analytic-signal method built with a full FFT (zero the negative frequencies, rotate, take the
 * real part). The test signal is real SSTV audio, so any dependence on content or on frequency appears.
 *
 * Usage: node tests/verify-freqshift.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SR = 48000;
require(path.join(ROOT, 'js', 'lib', 'fft.js'));

// lift our implementation from the matrix, so both harnesses cannot drift apart
const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const from = SRC.indexOf('function hilbertFIR');
const to = SRC.indexOf('/** Decoder lock residuals');
const OURS = new Function('SR', SRC.slice(from, to) + '\nreturn { freqShift: freqShift };')(SR).freqShift;

/** Reference: exact analytic-signal frequency shift via a full FFT. */
function referenceShift(x, hz) {
  const N = x.length;
  const re = new Float32Array(N), out = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) re[i] = x[i];
  new globalThis.FFT(N).realTransform(out, re);
  // positive-frequency part doubled, negative zeroed - the standard analytic signal - then rotate
  const half = N / 2;
  const R = new Float64Array(N), I = new Float64Array(N);
  for (let k = 0; k <= half; k++) {
    const a = out[2 * k], b = out[2 * k + 1];
    if (k === 0 || k === half) { R[k] = a; I[k] = b; }
    else { R[k] = 2 * a; I[k] = 2 * b; }
  }
  const w = 2 * Math.PI * hz / SR;
  for (let k = 0; k <= half; k++) {
    const c = Math.cos(w * k), s = Math.sin(w * k);
    const nr = R[k] * c - I[k] * s, ni = R[k] * s + I[k] * c;
    R[k] = nr; I[k] = ni;
  }
  // Hermitian completion for a real output
  for (let k = 1; k < half; k++) { R[N - k] = R[k]; I[N - k] = -I[k]; }
  const inRe = new Float32Array(N), inIm = new Float32Array(N);
  for (let k = 0; k < N; k++) { inRe[k] = R[k]; inIm[k] = I[k]; }
  const o2 = new Float32Array(2 * N);
  for (let k = 0; k < N; k++) { o2[2 * k] = inRe[k]; o2[2 * k + 1] = inIm[k]; }
  const back = new Float32Array(2 * N);
  new globalThis.FFT(N).inverseTransform(back, o2);
  const y = new Float32Array(N);
  for (let i = 0; i < N; i++) y[i] = back[2 * i];
  return y;
}

/** Dominant frequency in a window, with a coarse+fine search. */
function dom(x, off, len, lo, hi) {
  const N = 32768;
  const re = new Float32Array(N), out = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) re[i] = (x[off + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  new globalThis.FFT(N).realTransform(out, re);
  const k0 = Math.max(1, Math.ceil(lo * N / SR)), k1 = Math.min(N / 2 - 1, Math.floor(hi * N / SR));
  let best = -1, bk = k0;
  for (let k = k0; k <= k1; k++) {
    const m = Math.hypot(out[2 * k], out[2 * k + 1]);
    if (m > best) { best = m; bk = k; }
  }
  return bk * SR / N;
}

console.log('=== 频移实现校验（与 FFT 参考实现对拍）===\n');

// ---------------------------------------------------------------- synthetic multitrack
{
  const N = 65536;
  const x = new Float32Array(N);
  // three tones at non-harmonically-related frequencies, plus a DC-ish very low tone
  for (let i = 0; i < N; i++) {
    x[i] = 0.2 * Math.sin(2 * Math.PI * 1200 * i / SR)
         + 0.2 * Math.sin(2 * Math.PI * 1733 * i / SR)
         + 0.2 * Math.sin(2 * Math.PI * 2291 * i / SR);
  }
  console.log('[1] 三音信号（1200 / 1733 / 2291 Hz）');
  console.log('    hz    我们-1200  我们-1733  我们-2291  |  参考-1200  参考-1733  参考-2291  |  差异(dB)');
  for (const hz of [0, 20, -20, 50, -50, 200, -200]) {
    const a = OURS(x, hz), b = referenceShift(x, hz);
    const fa = [1200, 1733, 2291].map((f) => dom(a, 0, N, f - 300, f + 300) - f);
    const fb = [1200, 1733, 2291].map((f) => dom(b, 0, N, f - 300, f + 300) - f);
    // waveform difference, restricted to the middle where both are free of edge effects
    let se = 0, sr = 0;
    for (let i = 8000; i < N - 8000; i++) { const d = a[i] - b[i]; se += d * d; sr += b[i] * b[i]; }
    const db = 10 * Math.log10(sr / Math.max(se, 1e-20));
    console.log('  ' + String(hz).padStart(4) + '  ' +
      fa.map((v) => v.toFixed(1).padStart(9)).join('') + '  |  ' +
      fb.map((v) => v.toFixed(1).padStart(9)).join('') + '  |  ' + db.toFixed(1));
  }
}

// ---------------------------------------------------------------- real SSTV audio
console.log('\n[2] 真实 SSTV 音频（合成 S1 控制图的前 65536 采样）');
{
  require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
  const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline, Synth = globalThis.SSTVSynth;
  const mode = Modes.get('S1');
  const w = 320, h = 256;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x2 = 0; x2 < w; x2++) {
    const i = (y * w + x2) * 4, v = Math.round(255 * (0.5 + 0.5 * Math.sin(x2 / 11)));
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  const tl = Timeline.build({ data: data, width: w, height: h }, mode);
  const full = Synth.synthesize(tl, SR).samples;
  const N = 65536;
  const x = full.subarray(400000, 400000 + N);   // inside the image body
  console.log('    hz    相对参考的波形差(dB)   我们 RMS   参考 RMS   时长是否一致');
  for (const hz of [0, 20, -20, 50, -50, 100, -100]) {
    const a = OURS(x, hz), b = referenceShift(Float32Array.from(x), hz);
    let se = 0, sr = 0, sa = 0;
    for (let i = 3000; i < N - 3000; i++) {
      const d = a[i] - b[i]; se += d * d; sr += b[i] * b[i]; sa += a[i] * a[i];
    }
    const db = 10 * Math.log10(sr / Math.max(se, 1e-20));
    console.log('  ' + String(hz).padStart(4) + '   ' + db.toFixed(1).padStart(14) + '   ' +
      Math.sqrt(sa / (N - 6000)).toFixed(4).padStart(9) + '  ' +
      Math.sqrt(sr / (N - 6000)).toFixed(4).padStart(9) + '   ' + (a.length === b.length));
  }
  console.log('\n  （波形差 > 30 dB 表示两者实质相同；< 15 dB 表示我们的实现与参考不一致）');
}
