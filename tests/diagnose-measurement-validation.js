/*
 * Retrospective: the three measurement methods that failed during phase 49, put to a known-truth test.
 *
 * Each of these was used to support a claim about the phigros recording's per-segment frequency offset,
 * and each was eventually shown to have a bias of the same order as the effect it reported. This script
 * reproduces all three on synthetic tones of KNOWN frequency and lets the validation harness say what
 * each is actually worth - so the failure is recorded as a measured property of the method rather than
 * as a story about one bad afternoon.
 *
 * The three:
 *   A. short-window dominant-frequency peak        (tests/diagnose-asymmetry-branches.js)
 *   B. Hann-windowed matched filter, 7.5 ms         (tests/diagnose-real-drift.js)
 *   C. long-window (27 ms) spectrum peak            (tests/diagnose-real-drift-confirm.js)
 *
 * All three are measured on a 1200 Hz tone - the sync whose frequency was in question - at the window
 * lengths each method actually used on the real recording.
 *
 * Usage: node tests/diagnose-measurement-validation.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SR = 48000;
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
const { makeTone, makeContaminated, validate, summarise } = require('./lib/measure-validate');

/** A: short-window dominant-frequency peak, no window taper - the crudest of the three. */
function methodA(x, lo, hi) {
  const N = 512;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) re[i] = (x[i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  new globalThis.FFT(N).realTransform(o, re);
  const k0 = Math.max(1, Math.ceil(lo * N / SR)), k1 = Math.min(N / 2 - 1, Math.floor(hi * N / SR));
  let best = -1, bk = k0;
  for (let k = k0; k <= k1; k++) {
    const m = o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
    if (m > best) { best = m; bk = k; }
  }
  return bk * SR / N;
}

/** B: Hann-windowed complex matched filter over a candidate range. */
function methodB(x, len, lo, hi, step) {
  const taper = new Float64Array(len);
  for (let i = 0; i < len; i++) taper[i] = (x[i] || 0) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
  let best = -1, bf = lo;
  for (let f = lo; f <= hi; f += step) {
    const om = 2 * Math.PI * f / SR;
    let re = 0, im = 0;
    for (let i = 0; i < len; i++) { re += taper[i] * Math.cos(om * i); im -= taper[i] * Math.sin(om * i); }
    const m = re * re + im * im;
    if (m > best) { best = m; bf = f; }
  }
  return bf;
}

/** C: long-window spectrum peak with quadratic interpolation. */
function methodC(x, len, lo, hi) {
  const N = 65536;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  const use = Math.min(len, N);
  for (let i = 0; i < N; i++) {
    const v = i < use ? (x[i] || 0) : 0;
    re[i] = v * 0.5 * (1 - Math.cos(2 * Math.PI * i / (use - 1)));
  }
  new globalThis.FFT(N).realTransform(o, re);
  const k0 = Math.max(1, Math.ceil(lo * N / SR)), k1 = Math.min(N / 2 - 1, Math.floor(hi * N / SR));
  let best = -1, bk = k0;
  for (let k = k0; k <= k1; k++) {
    const m = Math.hypot(o[2 * k], o[2 * k + 1]);
    if (m > best) { best = m; bk = k; }
  }
  const y0 = Math.hypot(o[2 * (bk - 1)], o[2 * (bk - 1) + 1]);
  const y1 = Math.hypot(o[2 * bk], o[2 * bk + 1]);
  const y2 = Math.hypot(o[2 * (bk + 1)], o[2 * (bk + 1) + 1]);
  const den = y0 - 2 * y1 + y2;
  const d = den === 0 ? 0 : 0.5 * (y0 - y2) / den;
  return (bk + d) * SR / N;
}

console.log('=== 测量方法回顾性校验（合成信号，真值已知）===\n');
console.log('  对 1200 Hz 纯音，用各方法在真实录音上实际使用的参数测量。\n');

const tones = [1100, 1150, 1200, 1250, 1300, 1200].map((f, i) => ({
  signal: makeTone(f, Math.round(0.030 * SR)), truth: f,
  label: i === 5 ? '（重复，用于看离散）' : ''
}));

const results = [];

// A: 512-sample (=10.7 ms) FFT peak, searched 1300-2500 as the pixel path does
results.push(validate('A 短窗主频（512 点）', tones, (x) => methodA(x, 1100, 1400),
  { toleranceHz: 2, notes: 'diagnose-asymmetry-branches.js 使用的量' }));

// B: 7.5 ms Hann matched filter, 0.5 Hz steps over 1100-1350
results.push(validate('B 匹配滤波（7.5 ms, 0.5 Hz）', tones,
  (x) => methodB(x, Math.round(0.0075 * SR), 1100, 1350, 0.5), { toleranceHz: 1 }));

// C: 27 ms Hann spectrum peak - the method that claimed +395 Hz on real audio
const tones27 = [1100, 1150, 1200, 1250, 1300, 1200].map((f) => ({
  signal: makeTone(f, Math.round(0.027 * SR)), truth: f
}));
results.push(validate('C 长窗频谱峰（27 ms）', tones27, (x) => methodC(x, Math.round(0.027 * SR), 1000, 1600),
  { toleranceHz: 2 }));

for (const r of results) {
  console.log(r.report());
  console.log('');
}

/*
 * TIER 2 - CONTAMINATION. The tier that would have caught the real failure.
 *
 * Each method is given the same 1200 Hz tone with a strong neighbour 150 Hz away, which is what a window
 * long enough to resolve the sync actually sees on an SSTV line (the porch, then image content). A
 * method may pass tier 1 and fail here, and it is a tier-2 failure that makes the real-recording numbers
 * meaningless.
 */
console.log('  --- 第二层：邻音污染（目标 1200 Hz + 150 Hz 处等幅邻音）---\n');
const contaminated = [1150, 1200, 1250].map((f) => ({
  signal: makeContaminated(f, Math.round(0.030 * SR), { spacingHz: 150, ampRatio: 1.0 }),
  truth: f, label: '（+150 Hz 邻音）'
}));
const tier2 = [];
tier2.push(validate('B 匹配滤波（7.5 ms）· 污染', contaminated,
  (x) => methodB(x, Math.round(0.0075 * SR), 1050, 1250, 0.5), { toleranceHz: 5 }));
tier2.push(validate('C 长窗频谱峰（27 ms）· 污染', contaminated,
  (x) => methodC(x, Math.round(0.027 * SR), 1000, 1400), { toleranceHz: 5 }));
/*
 * And the method that avoids the problem by construction: measure the sync in a window no longer than the
 * pulse itself, positioned at the decoder's own lock. The 9 ms pulse is the longest window that contains
 * sync and nothing else, which is why it is the one a defensible measurement has to use.
 */
tier2.push(validate('D 脉冲等长窗（9 ms）· 污染', contaminated,
  (x) => methodB(x, Math.round(0.009 * SR), 1050, 1250, 0.5), { toleranceHz: 5 }));
for (const r of tier2) {
  console.log(r.report());
  console.log('');
}

console.log(summarise(tier2));

/*
 * The consequence that matters: what effect size can each method support? This is the question that was
 * never asked before the numbers were used.
 */
console.log('  各方法能支撑的最小效应量（偏置/MAD 的 3 倍）：');
for (const r of results) {
  const u = r.usableFor(50);   // 50 Hz is the smallest offset the matrix shows a >1 dB effect at
  console.log('    ' + r.name.padEnd(30) + ' 下限 ' + u.limitHz.toFixed(2).padStart(8) +
    ' Hz → 对 50 Hz 的效应 ' + (u.usable ? '可用' : '不可用'));
}

console.log('\n' + summarise(results));

/*
 * The conclusion this file exists to record: the phase-49 claims about a per-segment frequency offset in
 * the phigros recording are NOT supported by any of these methods, whatever their verdict above turns
 * out to be, because all three measure the tone through a window that also contains the porch and the
 * start of the scan. The validation here bounds each method's behaviour on a CLEAN tone; on the real
 * recording none of them was ever validated, and that is the actual defect.
 */
console.log('\n  注：即使某项通过，它在真实录音上的使用也从未做过对照 —— 三个方法都把同步音放在一个');
console.log('      同时包含 porch 与扫描开头的窗里测量，清醒音上的通过不能推广到那种输入。');
console.log('      因此阶段四十九关于"分段频偏"的说法仍然【不成立】，无论上面结果如何。');
