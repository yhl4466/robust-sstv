/*
 * The frequency-calibration slope is computed from a 10 ms probe, and 10 ms of a 1200 Hz tone is not
 * enough to measure it to the precision the slope needs.
 *
 * WHY THIS IS THE LEADING EXPLANATION FOR THE ONE-SIDED OFFSET RESPONSE
 *   findHeader derives the affine scale from the 700 Hz leader/break separation:
 *
 *     a = (f_leader - f_break) / 700
 *
 *   It measures f_leader over 250 ms (475 cycles, 4 Hz bins) - the source comments say so, and say the
 *   reason: the short sync is only ~233 samples and carried a systematic +18.6 Hz bias. But f_break and
 *   the VIS start bit f4 are measured with `win` = HDR_WINDOW_SIZE = 10 ms, i.e. 5.7 cycles of 1200 Hz.
 *
 *   The code protects the OFFSET (b) by re-anchoring it on the long leader measurement, but `a` is
 *   still (f1Long - f4)/700 with a short-window f4 inside it. Any bias in f4 lands directly in `a`, and a
 *   scale error changes the measured separation in proportion to the separation - which is exactly how a
 *   response can come out one-sided: the +700 Hz leader/break gap and the -700 Hz one are biased by
 *   opposite amounts when the tone sits above or below the FFT grid.
 *
 * THIS TEST
 *   Measures the same quantity the decoder measures - a 1200 Hz tone through a 10 ms Hann-windowed FFT
 *   peak - over a range of true frequencies, so the bias curve is measured rather than argued. Then it
 *   runs the exact `a` formula with a long-window leader and the short-window break, and reports the
 *   resulting scale error as a function of tuning offset. If that error changes sign across zero, the
 *   asymmetry is explained; if it is symmetric, this hypothesis is dead too.
 *
 * Usage: node tests/diagnose-header-slope-bias.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SR = 48000;
require(path.join(ROOT, 'js', 'lib', 'fft.js'));

const HDR_WINDOW_SIZE = 0.010;

/** The decoder's own measurement: Hann-windowed FFT peak, quadratically interpolated. */
function peakEstimate(x, off, len, cap) {
  const size = Math.min(cap || 4096, 32768);
  const re = new Float32Array(size), o = new Float32Array(2 * size);
  for (let i = 0; i < size; i++) {
    const v = (i < len ? x[off + i] : 0) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
    re[i] = v;
  }
  new globalThis.FFT(size).realTransform(o, re);
  let best = -1, bk = 1;
  for (let k = 1; k < size / 2; k++) {
    const m = o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
    if (m > best) { best = m; bk = k; }
  }
  const y0 = Math.hypot(o[2 * (bk - 1)], o[2 * (bk - 1) + 1]);
  const y1 = Math.hypot(o[2 * bk], o[2 * bk + 1]);
  const y2 = Math.hypot(o[2 * (bk + 1)], o[2 * (bk + 1) + 1]);
  const den = y0 - 2 * y1 + y2;
  const d = den === 0 ? 0 : 0.5 * (y0 - y2) / den;
  return (bk + d) * SR / size;
}

function tone(freq, len) {
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / SR);
  return x;
}

console.log('=== 标定斜率 a 的短窗偏置 ===\n');
console.log('  探针：HDR_WINDOW_SIZE = ' + (HDR_WINDOW_SIZE * 1000) + ' ms');
console.log('  1200 Hz 在 10 ms 内只有 ' + (1200 * HDR_WINDOW_SIZE).toFixed(1) + ' 个周期');
console.log('  1900 Hz 在 250 ms 内有 ' + (1900 * 0.25).toFixed(0) + ' 个周期\n');

// ---- the bias curve of the short probe, as a function of true frequency ----
const shortLen = Math.round(HDR_WINDOW_SIZE * SR);
const longLen = Math.round(0.25 * SR);
console.log('  [1] 短窗（10 ms）对 1200 Hz 附近纯音的读数偏置');
console.log('      真实频率(Hz)   读数(Hz)    偏置(Hz)    |  同频率长窗(250 ms)偏置(Hz)');
for (const f of [1100, 1150, 1180, 1200, 1220, 1250, 1300]) {
  const s = tone(f, shortLen);
  const l = tone(f, longLen);
  const ps = peakEstimate(s, 0, shortLen, 4096);
  const pl = peakEstimate(l, 0, longLen, 32768);
  console.log('      ' + f.toFixed(0).padStart(8) + '     ' + ps.toFixed(2).padStart(8) + '   ' +
    (ps - f).toFixed(2).padStart(8) + '    |  ' + (pl - f).toFixed(2).padStart(8));
}

/*
 * [2] The a formula, exactly as findHeader computes it:
 *       a = (f_leader_long - f_break_short) / 700
 * with a true tuning offset applied to the whole signal. The un-biased answer is always 1.000000 for a
 * pure offset (an offset shifts, it does not scale). Any departure from 1 is slope error.
 */
console.log('\n  [2] 斜率 a = (长窗 1900 - 短窗 1200) / 700，在纯调谐误差下的误差');
console.log('      频偏(Hz)   f_leader(长窗)  f_break(短窗)   a           a 误差(%)   像素亮度误差(灰度级)');
for (const hz of [-200, -100, -50, -20, 0, 20, 50, 100, 200]) {
  const fl = peakEstimate(tone(1900 + hz, longLen), 0, longLen, 32768);
  const fb = peakEstimate(tone(1200 + hz, shortLen), 0, shortLen, 4096);
  const a = (fl - fb) / 700;
  // one grey level is COLOR_FREQ_MULT Hz in the nominal axis
  const MULT = 3.1372549019607843;   // 800 Hz / 255 levels, the standard SSTV ramp
  // a luminance error of one level near mid-grey corresponds to a frequency error of MULT Hz / a
  const errHzAt1800 = (1 / a - 1) * 1800;
  console.log('      ' + String(hz).padStart(6) + '     ' + fl.toFixed(2).padStart(10) + '     ' +
    fb.toFixed(2).padStart(9) + '   ' + a.toFixed(6) + '   ' +
    ((a - 1) * 100).toFixed(3).padStart(8) + '     ' + (errHzAt1800 / MULT).toFixed(1).padStart(10));
}

console.log('\n  判读：a 误差在 0 Hz 两侧若呈同号且单调，则短窗偏置只造成一个恒定的尺度偏差（可整体标定）；');
console.log('        若在 0 Hz 两侧符号相反，则标定误差随频偏方向反向，解码质量对 +Δ 与 −Δ 不对称。');
