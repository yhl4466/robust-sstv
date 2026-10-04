/*
 * Verify the frequency-shift impairment against an FFT-based reference, on REAL signal content.
 *
 * WHY: the matrix reports a strong asymmetry (+50 Hz decodes at 31.29 dB, -50 Hz at 17.30 dB) and a
 * spectral shift is symmetric by construction, so either the decoder handles negative offsets badly or
 * the impairment model is one-sided. A tone test cannot tell those apart, so this compares against an
 * independent reference that shares no code with the Hilbert implementation.
 *
 * THE FIRST VERSION OF THIS REFERENCE WAS ITSELF BROKEN, and the way it was broken is worth recording
 * because the failure was silent:
 *
 *   - it copied only the first half of the spectrum (k <= N/2) into R/I and left the second half at ZERO
 *   - it therefore never zeroed the negative frequencies; it just deleted them, which is not the same
 *     operation
 *   - with the negative half gone it applied a Hermitian completion that rebuilt them WITHOUT the
 *     rotation, so the negative-frequency energy stayed at its original phase
 *
 * The result was a "reference" that shifted nothing: it reported a 0 Hz shift for every input, at 2x
 * amplitude (measured RMS 0.7071 against an input of 0.3535). Any implementation compared against it
 * would have looked wrong.
 *
 * The corrected reference therefore also VERIFIES ITSELF before being used - it is run on a pure tone of
 * known frequency and its output frequency is measured, because an unvalidated reference is worse than
 * no reference at all. That lesson is the reason tests/model-selftest.js exists for the impairment
 * models; this file now carries the same discipline for the one model that had escaped it.
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
const OURS = new Function('SR', SRC.slice(from, from >= 0 && to > from ? to : undefined) +
  '\nreturn { freqShift: freqShift };')(SR).freqShift;

/**
 * Reference: exact frequency shift by spectral translation of the analytic signal.
 *
 * The construction, and the reason each step exists:
 *
 *   1. take the real-input DFT. For a real signal it is conjugate-symmetric: bin k and bin N-k carry the
 *      same component with half the amplitude each.
 *   2. build the ANALYTIC spectrum: double the positive bins (1..N/2-1), zero everything above N/2. This
 *      is the frequency-domain form of x + j*Hilbert(x), which is the whole point - with only positive
 *      frequencies left, a translation by `hz` is just a rotation, with no negative-frequency image to
 *      fold back on top of the result.
 *   3. apply a FRACTIONAL bin shift, not an integer one: split hz into whole bins m and a fractional
 *      part fr, move the analytic bins by m with wraparound, then multiply each by exp(+j*2*pi*fr*k/N).
 *      Handling only the integer part was the first version's second mistake - it quantised the shift to
 *      0.73 Hz bins.
 *   4. inverse transform and take the real part, times 2. The analytic signal has no negative-frequency
 *      half, so the inverse transform is a full complex result whose REAL part is the shifted signal;
 *      the factor 2 restores the amplitude that step 2's single-sided spectrum represents.
 *
 * This is deliberately an independent implementation path from the Hilbert-FIR one in
 * tests/degradation-matrix.js: it uses the FFT, a fractional-bin rotation and a different scaling law,
 * so agreement between the two is meaningful evidence rather than a tautology.
 */
function referenceShift(x, hz) {
  const N = x.length;
  const fft = new globalThis.FFT(N);
  const inp = new Float32Array(N), spec = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) inp[i] = x[i];
  fft.realTransform(spec, inp);

  const half = N / 2;
  const binHz = SR / N;
  const m = Math.round(hz / binHz);          // whole bins
  const fr = (hz - m * binHz) / binHz;       // fractional remainder, |fr| <= 0.5
  const w = 2 * Math.PI * fr / N;            // fractional-shift phase ramp per bin

  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 1; k < half; k++) {
    /*
     * The analytic spectrum keeps only the positive bins, and a real signal splits each component's
     * amplitude between bin k and bin N-k. Discarding the negative side therefore halves the amplitude,
     * so the SAME factor 2 has to come back here. Applying it in both places (the first version) gave an
     * amplitude ratio of 2.0000; applying it in neither (the second) gave 0.5000. Once, here, is right.
     */
    const a = spec[2 * k], b = spec[2 * k + 1];
    // fractional rotation
    const c = Math.cos(w * k), s = Math.sin(w * k);
    const nr = a * c - b * s, ni = a * s + b * c;
    // whole-bin translation with wraparound
    const dest = ((k + m) % N + N) % N;
    re[dest] += 2 * nr; im[dest] += 2 * ni;
  }
  const cin = new Float32Array(2 * N), cout = new Float32Array(2 * N);
  for (let k = 0; k < N; k++) { cin[2 * k] = re[k]; cin[2 * k + 1] = im[k]; }
  fft.inverseTransform(cout, cin);          // library divides by N
  const y = new Float32Array(N);
  for (let i = 0; i < N; i++) y[i] = cout[2 * i];
  return y;
}

/**
 * Dominant frequency in a band, from a Hann-windowed FFT.
 *
 * The window is not optional here: an unwindowed segment leaks a strong tone across dozens of bins, and
 * when the band is only +/-200 Hz wide that leakage can outrank the true peak - which made an early
 * version of this file report a 1.07 Hz error on a shift that was exact.
 */
function dom(x, off, len, lo, hi) {
  const N = 32768;
  const re = new Float32Array(N), out = new Float32Array(2 * N);
  const use = Math.min(len, N);
  for (let i = 0; i < N; i++) {
    const v = i < use ? (x[off + i] || 0) : 0;
    re[i] = v * 0.5 * (1 - Math.cos(2 * Math.PI * i / (use - 1)));
  }
  new globalThis.FFT(N).realTransform(out, re);
  const k0 = Math.max(1, Math.ceil(lo * N / SR)), k1 = Math.min(N / 2 - 1, Math.floor(hi * N / SR));
  let best = -1, bk = k0;
  for (let k = k0; k <= k1; k++) {
    const m = Math.hypot(out[2 * k], out[2 * k + 1]);
    if (m > best) { best = m; bk = k; }
  }
  // quadratic interpolation: the true peak rarely lands on a bin
  const y0 = Math.hypot(out[2 * (bk - 1)], out[2 * (bk - 1) + 1]);
  const y1 = Math.hypot(out[2 * bk], out[2 * bk + 1]);
  const y2 = Math.hypot(out[2 * (bk + 1)], out[2 * (bk + 1) + 1]);
  const den = y0 - 2 * y1 + y2;
  const d = den === 0 ? 0 : 0.5 * (y0 - y2) / den;
  return (bk + d) * SR / N;
}

console.log('=== 频移实现校验（与 FFT 参考实现对拍）===\n');

/*
 * [0] VALIDATE THE REFERENCE BEFORE TRUSTING IT.
 *
 * This is the step the first version of this file was missing, and skipping it is how a reference that
 * shifted nothing survived long enough to produce a wrong "our model is fine" conclusion. A pure tone of
 * known frequency goes in; the output frequency and amplitude are measured against the requested shift.
 * If this section fails, nothing below it means anything.
 */
{
  console.log('[0] 参考实现自校验（纯音，真值已知）');
  const N = 65536;
  const f0 = 1500;
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = 0.4 * Math.sin(2 * Math.PI * f0 * i / SR);
  let bad = 0;
  console.log('    施加(hz)   读数(Hz)   频率误差(Hz)   幅度比   长度');
  for (const hz of [0, 10, -10, 37.5, -37.5, 100, -100]) {
    const y = referenceShift(x, hz);
    const f = dom(y, 0, N, f0 + hz - 200, f0 + hz + 200);
    let pk = 0;
    for (let i = 4000; i < N - 4000; i++) if (Math.abs(y[i]) > pk) pk = Math.abs(y[i]);
    const okF = Math.abs(f - (f0 + hz)) < 1.0;
    const okA = Math.abs(pk - 0.4) < 0.01;
    const okL = y.length === N;
    if (!okF || !okA || !okL) bad++;
    console.log('    ' + String(hz).padStart(8) + '   ' + f.toFixed(2).padStart(9) + '   ' +
      (f - f0 - hz).toFixed(3).padStart(12) + '   ' + (pk / 0.4).toFixed(4).padStart(7) +
      '   ' + (okL ? 'OK' : 'BAD') + (okF ? '' : '  频率不符') + (okA ? '' : '  幅度不符'));
  }
  console.log('    ' + (bad === 0 ? '参考实现自校验通过 ✓' : '参考实现自校验失败 ✗ —— 下面的对拍结论无效'));
  if (bad !== 0) { process.exitCode = 1; return; }
}

// ---------------------------------------------------------------- synthetic multitrack
{
  const N = 65536;
  const x = new Float32Array(N);
  // three tones at non-harmonically-related frequencies
  for (let i = 0; i < N; i++) {
    x[i] = 0.2 * Math.sin(2 * Math.PI * 1200 * i / SR)
         + 0.2 * Math.sin(2 * Math.PI * 1733 * i / SR)
         + 0.2 * Math.sin(2 * Math.PI * 2291 * i / SR);
  }
  console.log('\n[1] 三音信号（1200 / 1733 / 2291 Hz）');
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
