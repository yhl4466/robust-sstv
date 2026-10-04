/*
 * Locate the overlap-add error: is the complex FFT round trip exact, and does delta convolution reproduce
 * the IR at every tap?
 *
 * tests/diagnose-demo-convolve.js showed the 1500 Hz gain is O(1) (so the overall scaling is sane) but the
 * delta response does not equal the IR - the error (~0.86) is the same magnitude as the IR's largest tap
 * (~0.22 after normalisation), which points at whole taps being lost rather than a gradual distortion.
 *
 * This pins it down in two steps, because "convolution is wrong" is not a debuggable statement:
 *   [1] FFT round trip on random data. If this is not exact to ~1e-5 the transform pair is broken and
 *       nothing downstream can be trusted.
 *   [2] Delta response sampled at several taps across the IR, plus the total energy of both, so a missing
 *       region of the tail is visible as a specific index range rather than as one scalar error.
 *
 * Usage: node tests/diagnose-convolve-fft.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js', 'lib', 'fft.js'));

const page = fs.readFileSync(path.join(ROOT, 'demo-degradation.html'), 'utf8');
const a0 = page.indexOf('var ROOM_IR_B64');
const a1 = page.indexOf('";', a0) + 2;
const s0 = page.indexOf('var SR = 8000;');
const s1 = page.indexOf('</script>', s0);
const M = new Function('globalThis', 'atob',
  page.slice(a0, a1) + '\n' + page.slice(s0, s1) +
  '\nreturn { convolve: convolve, fftComplex: fftComplex, ROOM_IR: ROOM_IR };')(
  globalThis, (s) => Buffer.from(s, 'base64').toString('binary'));

const N = 8192;

// ---------------------------------------------------------------- [1] round trip
console.log('[1] 复数 FFT 往返');
{
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const re0 = new Float64Array(N), im0 = new Float64Array(N);
  for (let i = 0; i < N; i++) { re0[i] = rnd(); im0[i] = rnd(); }
  const re = Float32Array.from(re0), im = Float32Array.from(im0);
  M.fftComplex(re, im, false);
  M.fftComplex(re, im, true);
  let maxErr = 0, maxMag = 0;
  for (let i = 0; i < N; i++) {
    maxErr = Math.max(maxErr, Math.abs(re[i] - re0[i]), Math.abs(im[i] - im0[i]));
    maxMag = Math.max(maxMag, Math.abs(re0[i]));
  }
  console.log('  最大幅度 ' + maxMag.toFixed(4) + ' · 往返最大误差 ' + maxErr.toExponential(3) +
    (maxErr < 1e-3 ? '  ✓ 精确' : '  ✗ 变换对不成立'));
}

// ---------------------------------------------------------------- [2] delta response per tap
console.log('\n[2] delta 响应对照 IR');
{
  const d = new Float32Array(20000);
  d[0] = 1;
  const y = M.convolve(d, M.ROOM_IR);
  const h = M.ROOM_IR;
  const idxs = [0, 1, 10, 34, 100, 400, 1000, 2000, 3000, 4000, 4700, 4799, 4810];
  console.log('  索引      IR           卷积输出       差');
  for (const i of idxs) {
    const hv = i < h.length ? h[i] : 0;
    const yv = y[i];
    console.log('  ' + String(i).padStart(5) + '  ' + hv.toFixed(6).padStart(12) + '  ' +
      (yv === undefined ? '  --  ' : yv.toFixed(6).padStart(12)) + '  ' +
      (yv === undefined ? '' : (yv - hv).toExponential(2).padStart(10)));
  }
  let eH = 0, eY = 0, firstBad = -1;
  for (let i = 0; i < h.length; i++) { eH += h[i] * h[i]; eY += (y[i] || 0) * (y[i] || 0); }
  for (let i = 0; i < h.length; i++) { if (Math.abs((y[i] || 0) - h[i]) > 1e-4) { firstBad = i; break; } }
  console.log('  IR 总能量 ' + eH.toExponential(4) + ' · 卷积输出总能量 ' + eY.toExponential(4) +
    ' · 比 ' + (eY / eH).toFixed(4));
  console.log('  第一个显著不符的索引: ' + (firstBad < 0 ? '（无）' : firstBad));
}
