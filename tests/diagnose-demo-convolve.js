/*
 * Is the demo page's overlap-add convolution actually correct?
 *
 * THE SYMPTOM: with the baked room IR mixed in at only 8%, the header stops being detectable - but 8% wet
 * against a unit-energy IR should be a subtle change, not a fatal one. That points at the convolution
 * rather than at the room, so this measures the convolution against cases with known answers:
 *
 *   1. delta in  -> the output must equal the IR. This is the definition, and an FFT scaling error shows
 *      up here immediately as a constant factor.
 *   2. a steady tone -> the output RMS must equal the input RMS times the IR's response magnitude at that
 *      frequency. For a unit-energy IR the response is O(1), so the ratio must be O(1); a ratio of 4096 or
 *      1/4096 means the transform pair is mismatched.
 *
 * Usage: node tests/diagnose-demo-convolve.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));

const page = fs.readFileSync(path.join(ROOT, 'demo-degradation.html'), 'utf8');
const a0 = page.indexOf('var ROOM_IR_B64');
const a1 = page.indexOf('";', a0) + 2;
const asset = page.slice(a0, a1);
const s0 = page.indexOf('var SR = 8000;');
const s1 = page.indexOf('</script>', s0);
const body = asset + '\n' + page.slice(s0, s1) +
  '\nreturn { convolve: convolve, roomMix: roomMix, ROOM_IR: ROOM_IR };';
const M = new Function('globalThis', 'atob', body)(globalThis,
  (s) => Buffer.from(s, 'base64').toString('binary'));

function rms(a, s, e) { let t = 0, n = 0; for (let i = s; i < e; i++) { t += a[i] * a[i]; n++; } return Math.sqrt(t / n); }
function maxAbsDiff(a, b, n) { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }

console.log('IR taps ' + M.ROOM_IR.length + ' · RMS ' +
  rms(M.ROOM_IR, 0, M.ROOM_IR.length).toFixed(6) + '（单位能量归一化后应约为 1/sqrt(taps)）');

// --- 1. delta in -> IR out
const d = new Float32Array(8192);
d[0] = 1;
const deltaOut = M.convolve(d, M.ROOM_IR);
console.log('\n[1] delta 响应 vs IR');
console.log('  前 6 项  输出 ' + Array.from(deltaOut.slice(0, 6)).map((v) => v.toFixed(5)).join(', '));
console.log('  前 6 项  IR   ' + Array.from(M.ROOM_IR.slice(0, 6)).map((v) => v.toFixed(5)).join(', '));
const dMax = maxAbsDiff(deltaOut, M.ROOM_IR, Math.min(deltaOut.length, M.ROOM_IR.length));
console.log('  最大逐点误差 ' + dMax.toExponential(3) + (dMax < 1e-4 ? '  ✓' : '  ✗ 卷积不正确'));

// --- 2. steady tone -> RMS ratio must be O(1)
const N = 44100;
const x = new Float32Array(N);
for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 1500 * i / 8000);
const y = M.convolve(x, M.ROOM_IR);
const rin = rms(x, 8000, N - 8000);
const rout = rms(y, 8000, N - 8000);
console.log('\n[2] 1500 Hz 单音 RMS');
console.log('  输入 ' + rin.toFixed(5) + ' · 输出 ' + rout.toFixed(5) + ' · 比 ' + (rout / rin).toFixed(4) +
  (rout / rin > 0.2 && rout / rin < 5 ? '  ✓' : '  ✗ 增益不在 O(1) 量级'));

// --- 3. dry/wet mix at 8% must be close to the dry signal
const w = M.roomMix(x, 0.08);
const rw = rms(w, 8000, N - 8000);
let rel = 0;
for (let i = 8000; i < N - 8000; i++) rel += (w[i] - x[i]) * (w[i] - x[i]);
console.log('\n[3] 8% 混响');
console.log('  混合后 RMS ' + rw.toFixed(5) + ' · 与干信号之差 RMS ' + Math.sqrt(rel / (N - 16000)).toFixed(5) +
  '（应远小于 ' + rin.toFixed(3) + '）');
