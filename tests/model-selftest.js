/*
 * Self-test for the impairment MODELS the degradation matrix uses.
 *
 * The matrix is only worth reading if each impairment does what its label says. Three separate model
 * bugs were found while building it, and NONE of them were visible from the matrix output alone:
 *
 *   1. frequency offset was implemented as a resample, so "5 Hz of tuning error" was really 0.26% of
 *      CLOCK error - a completely different (and much larger) impairment. A +50 Hz cell "failed" and a
 *      -50 Hz cell "decoded", an asymmetry that a true spectral shift cannot produce.
 *   2. the reverb was a sum of feedback combs. With RT60 0.15 s the loop gain is 0.79, so it put a
 *      20+ dB deep comb over the whole signal and EVERY reverb cell failed, including the mildest.
 *   3. the Hilbert FIR used for the spectral shift came out sign-inverted: +20 Hz on a 1200 Hz tone
 *      gave 1180.66 Hz. The matrix would have reported that as "the decoder handles negative offsets
 *      better than positive".
 *
 * This file asserts the properties directly, so a future change to a model cannot silently turn the
 * baseline into a measurement of the wrong thing.
 *
 * Usage: node tests/model-selftest.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SR = 48000;
require(path.join(ROOT, 'js', 'lib', 'fft.js'));

// ---- lift the model functions out of the matrix, so the test cannot drift from the real code ----
const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const MODELS = (function () {
  const from = SRC.indexOf('function clip(');
  const to = SRC.indexOf('// ---------------------------------------------------------------- measurement');
  if (from < 0 || to < 0) throw new Error('could not locate the model section of degradation-matrix.js');
  const code = SRC.slice(from, to);
  const sandbox = { SR: SR, Channel: require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js')), globalThis: globalThis };
  // eslint-disable-next-line no-new-func
  const fn = new Function('SR', 'Channel', code +
    '\nreturn { clip: clip, reverb: reverb, buildIR: buildIR, measureRT60: measureRT60, gainScaleFor: gainScaleFor, freqShift: freqShift, hilbertFIR: hilbertFIR, combCoef: combCoef };');
  return fn(SR, sandbox.Channel);
})();

let failures = 0;
function check(ok, label, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

/** Dominant frequency of the middle of a signal, via the project's own FFT. */
function toneFreq(x, sr, from) {
  const N = 16384;
  const re = new Float32Array(N), out = new Float32Array(2 * N);
  const start = from == null ? 2000 : from;
  for (let i = 0; i < N; i++) re[i] = x[start + i] || 0;
  new globalThis.FFT(N).realTransform(out, re);
  let best = -1, bk = 0;
  for (let k = 1; k < N / 2; k++) {
    const m = Math.hypot(out[2 * k], out[2 * k + 1]);
    if (m > best) { best = m; bk = k; }
  }
  return bk * sr / N;
}

console.log('=== 退化模型自检 ===\n');
const N = SR * 2;

// ---------------------------------------------------------------- 1. spectral shift
console.log('[1] 频率偏移 = 真正的频谱平移（不是重采样）');
{
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 1200 * i / SR);
  const base = toneFreq(x, SR);
  check(Math.abs(base - 1200) < 5, '基准音 1200 Hz', base.toFixed(2) + ' Hz');
  for (const hz of [5, 20, 50, 100, -50, -100]) {
    const y = MODELS.freqShift(x, hz);
    const f = toneFreq(y, SR);
    check(Math.abs(f - (1200 + hz)) < 3, '偏移 ' + (hz > 0 ? '+' : '') + hz + ' Hz',
      f.toFixed(2) + ' Hz（期望 ' + (1200 + hz) + '）');
  }
  // a shift must NOT change the duration, unlike a resample
  check(MODELS.freqShift(x, 50).length === x.length, '频谱平移不改变长度（重采样会改变）');
  // amplitude preserved
  const y = MODELS.freqShift(x, 50);
  let pk = 0;
  for (let i = 3000; i < N; i++) if (Math.abs(y[i]) > pk) pk = Math.abs(y[i]);
  check(Math.abs(pk - 0.5) < 0.03, '幅度保持', '峰值 ' + pk.toFixed(3));
  // TWO tones must shift by the SAME absolute amount - the property a resample cannot have
  const z = new Float32Array(N), S = 0.25;
  for (let i = 0; i < N; i++) { z[i] = S * Math.sin(2 * Math.PI * 1200 * i / SR) + S * Math.sin(2 * Math.PI * 2300 * i / SR); }
  const zs = MODELS.freqShift(z, 30);
  // measure each tone by scanning only its neighbourhood
  const f1 = peakNear(zs, SR, 1230), f2 = peakNear(zs, SR, 2330);
  check(Math.abs((f1 - 1200) - 30) < 3 && Math.abs((f2 - 2300) - 30) < 3,
    '两个音平移量相同（重采样会按比例缩放）',
    f1.toFixed(1) + ' / ' + f2.toFixed(1) + ' Hz（期望 1230 / 2330）');
}

function peakNear(x, sr, want) {
  const N = 16384;
  const re = new Float32Array(N), out = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) re[i] = x[4000 + i] || 0;
  new globalThis.FFT(N).realTransform(out, re);
  let best = -1, bk = 0;
  const kc = want * N / sr, span = 40 * N / sr;
  for (let k = Math.max(1, Math.floor(kc - span)); k <= Math.ceil(kc + span); k++) {
    const m = Math.hypot(out[2 * k], out[2 * k + 1]);
    if (m > best) { best = m; bk = k; }
  }
  return bk * sr / N;
}

// ---------------------------------------------------------------- 2. reverb
console.log('\n[2] 声学路径 = 稀疏早期反射 + 扩散尾巴（不是梳状谐振）');
{
  for (const rt of [0.15, 0.3, 0.6, 1.0]) {
    // measure through the SAME function the matrix uses, so the label is verified as delivered.
    // The 0.15 s request lands at ~0.20 s: the diffuse sections are 30-44 ms long, so a tail cannot be
    // much shorter than a few of them. The matrix labels rows with the MEASURED value for this reason,
    // so the tolerance here is on the calibration actually hitting its target where a target is
    // reachable, and on the floor being stable and sane where it is not.
    const measured = MODELS.measureRT60(rt, MODELS.gainScaleFor(rt));
    const within = Math.abs(measured - rt) <= Math.max(rt * 0.25, 0.06);
    check(within, 'RT60 请求 ' + rt.toFixed(2) + ' s 实测',
      (isFinite(measured) ? measured.toFixed(2) : '>') + ' s');
    check(measured >= rt * 0.9, 'RT60 实测不低于请求（偏离方向必须是"更混响"）',
      measured.toFixed(2) + ' vs ' + rt.toFixed(2));
  }
  // band ripple must be small
  const NFFT = 32768;
  const ir = MODELS.buildIR(0.3, 1, NFFT);
  const re = new Float32Array(NFFT), out = new Float32Array(2 * NFFT);
  for (let i = 0; i < NFFT; i++) re[i] = ir[i];
  new globalThis.FFT(NFFT).realTransform(out, re);
  const k0 = Math.ceil(300 * NFFT / SR), k1 = Math.floor(3000 * NFFT / SR);
  let pk = 0, mn = Infinity;
  for (let k = k0; k <= k1; k++) {
    const m = Math.hypot(out[2 * k], out[2 * k + 1]);
    if (m > pk) pk = m;
    if (m < mn) mn = m;
  }
  const ripple = 20 * Math.log10(pk / Math.max(mn, 1e-12));
  check(ripple < 15, '300-3000 Hz 带内起伏 < 15 dB', ripple.toFixed(1) + ' dB（梳状模型 20 dB 以上）');
  // energy must be preserved within a few dB, so a cell is not judged on a level change
  const x = new Float32Array(SR);
  for (let i = 0; i < SR; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 1500 * i / SR);
  let e0 = 0, e1 = 0;
  const y = MODELS.reverb(x, 0.3);
  for (let i = SR / 2; i < SR; i++) { e0 += x[i] * x[i]; e1 += y[i] * y[i]; }
  const dB = 10 * Math.log10(e1 / e0);
  check(Math.abs(dB) < 6, '混响前后能量差 < 6 dB', dB.toFixed(2) + ' dB');
}

// ---------------------------------------------------------------- 3. clipping
console.log('\n[3] 削波 = 硬限幅，系数 k = 峰值/限幅门限');
{
  const x = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * i / 50);
  const c1 = MODELS.clip(x, 1);
  let same = true;
  for (let i = 0; i < 1000; i++) if (c1[i] !== x[i]) same = false;
  check(same, '1× 不改变信号（峰值 0.5 = 门限 0.5）');
  const c8 = MODELS.clip(x, 8);
  let clipped = 0;
  for (let i = 0; i < 1000; i++) if (Math.abs(c8[i] - x[i]) > 1e-9) clipped++;
  check(clipped > 400, '8× 产生明显失真', clipped + ' / 1000 采样被限幅');
  // distortion must be monotone in k, measured RELATIVE to the fundamental: heavier clipping pushes a
  // sine towards a square, whose 3rd harmonic is 1/3 of its fundamental. The absolute 3rd-harmonic
  // level therefore FALLS as k rises (the signal is squashed towards +/-limit), so testing the raw
  // magnitude would "fail" a correctly working model - which is exactly what the first version did.
  const N2 = 16384;
  const a = new Float32Array(N2);
  for (let i = 0; i < N2; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * 1500 * i / SR);
  const bin = (k, f) => {
    const c = MODELS.clip(a, k);
    const o = new Float32Array(2 * N2);
    new globalThis.FFT(N2).realTransform(o, c);
    const kk = Math.round(f * N2 / SR);
    return Math.hypot(o[2 * kk], o[2 * kk + 1]);
  };
  const ratio = (k) => bin(k, 4500) / Math.max(bin(k, 1500), 1e-9);
  const r1 = ratio(1), r2 = ratio(2), r4 = ratio(4), r8 = ratio(8);
  check(r2 > r1 * 10 && r4 > r2 * 0.9 && r8 > r4 * 0.9, '三次谐波/基波 随 k 单调上升到方波的 1/3 附近',
    [r1, r2, r4, r8].map((v) => v.toFixed(4)).join(' -> ') + '（方波理论值 0.333）');
}

console.log('\n' + (failures === 0 ? 'MODEL SELF-TEST PASSED' : failures + ' MODEL CHECK(S) FAILED'));
process.exitCode = failures === 0 ? 0 : 1;
