/*
 * Robot36-style sync pulse detector, ported faithfully, and compared against our own.
 *
 * REFERENCE (verified against the actual sources, not from memory):
 *   - smolgroot/sstv-decoder  src/lib/sstv/sync-detector.ts   (TypeScript port)
 *   - xdsopl/robot36          decode.c / ddc.c                (the original, which is C, not Java)
 *
 * THE ROBOT36 RECIPE, exactly as implemented there
 *   1. Mix to complex baseband at the centre of the band: centerFrequency = (1000+2800)/2 = 1900 Hz,
 *      with a complex low-pass of cutoff (2800-1000)/2 = 900 Hz over 2 ms.
 *   2. FM-demodulate with the deviation set by scanLineBandwidth = WHITE-BLACK = 800 Hz, so the
 *      normalised value is norm(f) = (f - 1900) / 400. Hence norm(1200) = -1.75, norm(1500) = -1.0.
 *   3. Smooth the demodulated value with a SimpleMovingAverage of 2.5 ms (5ms/2, forced odd) and keep
 *      a matching Delay so the width measurement is compared against the delayed value.
 *   4. SCHMITT TRIGGER with the two thresholds placed at the MIDPOINTS:
 *          syncHigh = (1200+1500)/2 = 1350 Hz -> norm = -1.375
 *          syncLow  = (1200+1350)/2 = 1275 Hz -> norm = -1.5625
 *      A sync pulse pulls the value down past -1.5625 and latches; it unlatches above -1.375.
 *   5. At the FALLING edge, the latch length in samples is the pulse WIDTH. Validation:
 *          width in [5ms/2, 20ms+5ms] = [2.5, 25] ms
 *      and  |delayedValue - norm(1200)| <= (50*2)/800 = 0.125      <- this IS the +/-50 Hz test
 *   6. Classify by MIDPOINTS: < 7 ms -> 5 ms, < 14.5 ms -> 9 ms (Scottie S1), else 20 ms.
 *   7. Report the pulse END offset (delay-compensated) and the frequency offset, which upstream uses
 *      for AFC.
 *
 * TWO CORRECTIONS TO THE BRIEF, both measured rather than argued:
 *   - An 8..10 ms width gate would be wrong. Upstream brackets the 9 ms class at [7, 14.5) ms, and the
 *     phase-26 measurement of the real capture gives a pulse-width MEDIAN of 7.75 ms (our own audio:
 *     8.5 ms). An 8..10 ms gate would reject most genuine pulses on the real recording.
 *   - There is NO adaptive noise floor upstream. The thresholds are fixed, derived from the mode's own
 *     frequency constants; noise immunity comes from the Schmitt hysteresis, the width gate and the
 *     +/-50 Hz gate.
 *
 * Usage: node tests/diagnose-sync-robot36.js [--self]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-intraline');
const SELF = process.argv.indexOf('--self') >= 0;
const AUDIO = SELF ? path.join(OUT, 'audit-self-s1.wav')
  : path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;
const MODE = Modes.get('S1');
const NOMINAL_LINE = Modes.lineTime(MODE) * 48000;
const SYNC_HZ = 1200, BLACK_HZ = 1500, WHITE_HZ = 2300;

/* ---------------------------------------------------------------- Robot36 port */

function robot36Detect(x, sr) {
  const BANDWIDTH = WHITE_HZ - BLACK_HZ;                 // 800
  const CENTER = (1000 + 2800) / 2;                      // 1900
  const norm = (f) => (f - CENTER) * 2 / BANDWIDTH;      // norm(1200) = -1.75
  const syncValueTarget = norm(SYNC_HZ);
  const tol = (50 * 2) / BANDWIDTH;                      // 0.125  <- the +/-50 Hz test
  const syncHigh = norm((SYNC_HZ + BLACK_HZ) / 2);       // -1.375
  const syncLow = norm((SYNC_HZ + (SYNC_HZ + BLACK_HZ) / 2) / 2); // -1.5625

  // 1. complex baseband + low-pass.
  /*
   * A boxcar, not a one-pole. The first attempt used a one-pole whose "cutoff" was 900 Hz, which at
   * 48 kHz is barely any filtering at all: the FM discriminator then saw out-of-band noise and
   * produced phase spikes up to -54 in normalised units (the valid range is about +/-2), and the
   * smoothed value never reached the -1.5625 Schmitt threshold - zero pulses detected, with zero
   * rejections, which is what exposed it. Upstream structures this as a real FIR low-pass of 2 ms
   * length at 900 Hz cutoff, and a 2 ms boxcar has its first null at 500 Hz offset, which is the
   * behaviour wanted here.
   */
  const lpLen = Math.round(0.002 * sr) | 1;              // 2 ms boxcar
  const ringI = new Float64Array(lpLen), ringQ = new Float64Array(lpLen);
  let sumI = 0, sumQ = 0, ri = 0;
  const w0 = 2 * Math.PI * CENTER / sr, c0 = Math.cos(w0), s0 = Math.sin(w0);
  let ci = 1, si = 0;
  const base = new Float64Array(2 * x.length);
  for (let i = 0; i < x.length; i++) {
    const nc = ci * c0 - si * s0, ns = si * c0 + ci * s0; ci = nc; si = ns;
    const mixI = x[i] * ci, mixQ = x[i] * si;
    sumI += mixI - ringI[ri]; ringI[ri] = mixI;
    sumQ += mixQ - ringQ[ri]; ringQ[ri] = mixQ;
    ri = (ri + 1) % lpLen;
    base[2 * i] = sumI / lpLen; base[2 * i + 1] = sumQ / lpLen;
  }

  // 2. FM demodulation: normalised to +/-1 at +/-bandwidth/2
  const fm = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) {
    const re = base[2 * i] * base[2 * (i - 1)] + base[2 * i + 1] * base[2 * (i - 1) + 1];
    const im = base[2 * i + 1] * base[2 * (i - 1)] - base[2 * i] * base[2 * (i - 1) + 1];
    fm[i] = Math.atan2(im, re) * sr / (2 * Math.PI * (BANDWIDTH / 2));
  }

  // 3. SimpleMovingAverage over 2.5 ms, forced odd, plus the matching delay
  const filtLen = (Math.round(0.0025 * sr) | 1);
  const delay = (filtLen - 1) / 2;
  const sv = new Float64Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += fm[i];
    if (i >= filtLen) acc -= fm[i - filtLen];
    sv[i] = acc / Math.min(i + 1, filtLen);
  }

  // 4/5/6. Schmitt trigger, width gate, +/-50 Hz gate, midpoint classification
  const minSamples = Math.round(0.0025 * sr);            // 2.5 ms
  const fiveMax = Math.round(((0.005 + 0.009) / 2) * sr);   // 7 ms
  const nineMax = Math.round(((0.009 + 0.020) / 2) * sr);   // 14.5 ms
  const twentyMax = Math.round(0.025 * sr);                 // 25 ms
  const pulses = [];
  let latched = false, counter = 0, rejected = { tooShort: 0, tooLong: 0, freq: 0 };
  for (let i = 0; i < x.length; i++) {
    const v = sv[i];
    if (!latched) {
      if (v < syncLow) { latched = true; counter = 1; }     // trigger: in sync pulse
    } else {
      counter++;
      if (v > syncHigh) {                                    // unlatch: pulse ended
        latched = false;
        const n = counter;
        const delayed = sv[Math.max(0, i - delay)];
        const fOff = Math.abs(delayed - syncValueTarget);
        if (n < minSamples) rejected.tooShort++;
        else if (n > twentyMax) rejected.tooLong++;
        else if (fOff > tol) rejected.freq++;
        else {
          let cls;
          if (n < fiveMax) cls = 5;
          else if (n < nineMax) cls = 9;
          else cls = 20;
          pulses.push({ endSample: i - delay, widthMs: n / sr * 1000, cls: cls,
            freqHz: CENTER + delayed * (BANDWIDTH / 2), freqOffsetHz: delayed * (BANDWIDTH / 2) });
        }
        counter = 0;
      }
    }
  }
  return { pulses: pulses, rejected: rejected, thresholds: { syncLow: syncLow, syncHigh: syncHigh, tol: tol },
    dbg: { fm: fm, sv: sv, syncLow: syncLow, syncHigh: syncHigh, target: syncValueTarget, filtLen: filtLen } };
}

/** The detector used in phase 26 (quadrature envelope + local-dominance), for comparison. */
function envelopeDetect(x, sr) {
  const decim = Math.round(0.00025 * sr);
  const env = [1200, 1500, 1900, 2300].map((f) => {
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w);
    const a = Math.exp(-1 / (sr * 0.002));
    const n = Math.floor(x.length / decim), out = new Float32Array(n);
    let ci = 1, si = 0, I = 0, Q = 0, o = 0;
    for (let i = 0; i < x.length; i++) {
      const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
      I = a * I + (1 - a) * (x[i] * ci); Q = a * Q + (1 - a) * (x[i] * si);
      if (i % decim === 0 && o < n) out[o++] = Math.sqrt(I * I + Q * Q);
    }
    return out;
  });
  const msPerBin = decim / sr * 1000, n = env[0].length;
  const MINRUN = Math.round(0.004 / (msPerBin / 1000)), MAXRUN = Math.round(0.018 / (msPerBin / 1000));
  const pulses = []; let run = -1;
  for (let k = 0; k < n; k++) {
    const on = env[0][k] > 1.4 * Math.max(env[1][k], env[2][k], env[3][k], 1e-4);
    if (on && run < 0) run = k;
    else if (!on && run >= 0) {
      if (k - run >= MINRUN && k - run <= MAXRUN) {
        let best = -1, bk = run;
        for (let q = run; q < k; q++) if (env[0][q] > best) { best = env[0][q]; bk = q; }
        const y1 = env[0][Math.max(0, bk - 1)], y2 = env[0][bk], y3 = env[0][Math.min(n - 1, bk + 1)];
        const den = y1 - 2 * y2 + y3;
        const shift = den === 0 ? 0 : 0.5 * (y1 - y3) / den;
        pulses.push({ centreMs: (bk + 0.5 + shift) * msPerBin, ms: (k - run) * msPerBin });
      }
      run = -1;
    }
  }
  return pulses;
}

function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of s) sum += v;
  const mean = sum / s.length;
  return { n: s.length, median: med, mad: mad, mean: mean, min: s[0], max: s[s.length - 1] };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(AUDIO)) { console.log('missing ' + AUDIO); process.exitCode = 1; return; }
  const buf = fs.readFileSync(AUDIO);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const x = info.samples, sr = info.sampleRate;

  console.log('=== Robot36 式同步检测 ===\n');
  console.log('音频 : ' + path.relative(ROOT, AUDIO) + (SELF ? '   (对照组：我们的合成 S1)' : '   (真实录音)'));
  console.log('       ' + info.duration.toFixed(3) + ' s @ ' + sr + ' Hz');
  console.log('阈值 : Schmitt ' + (-1.5625).toFixed(4) + ' / ' + (-1.375).toFixed(4) +
    ' (归一化, 即 1275 / 1350 Hz) · 频偏容差 ±0.125 (= ±50 Hz)');
  console.log('分档 : 有效 [2.5, 25] ms;  <7ms→5ms,  <14.5ms→9ms(Scottie S1),  else 20ms');
  console.log('标称行: ' + NOMINAL_LINE.toFixed(2) + ' 采样\n');

  const r36 = robot36Detect(x, sr);
  console.log('[1] Robot36 式检测器');
  console.log('    通过校验的脉冲 ' + r36.pulses.length + ' 个');
  console.log('    被拒: 过窄 ' + r36.rejected.tooShort + ' · 过宽 ' + r36.rejected.tooLong +
    ' · 频偏超限 ' + r36.rejected.freq);
  if (!r36.pulses.length) {
    /*
     * Self-diagnosis rather than a bare zero: show where the demodulated value actually sits against
     * the Schmitt thresholds, so a scaling mistake is visible instead of looking like "no syncs here".
     */
    const fmS = stats(Array.from(r36.dbg.fm));
    const svS = stats(Array.from(r36.dbg.sv));
    console.log('    !! 零脉冲，自诊断（归一化单位，±1 = ±400 Hz）:');
    console.log('       fm  : 中位 ' + fmS.median.toFixed(3) + ' · 均值 ' + fmS.mean.toFixed(3) +
      ' · 极值 ' + fmS.min.toFixed(3) + ' .. ' + fmS.max.toFixed(3));
    console.log('       sv  : 中位 ' + svS.median.toFixed(3) + ' · 均值 ' + svS.mean.toFixed(3) +
      ' · 极值 ' + svS.min.toFixed(3) + ' .. ' + svS.max.toFixed(3));
    console.log('       Schmitt: 需 sv < ' + r36.dbg.syncLow.toFixed(4) + ' 才触发；' +
      '1200 Hz 对应 ' + r36.dbg.target.toFixed(4));
    console.log('       => sv 最小值 ' + svS.min.toFixed(4) + ' 与触发门相差 ' +
      (svS.min - r36.dbg.syncLow).toFixed(4) +
      (svS.min > r36.dbg.syncLow ? '  (够不到，解调标度或极性有问题)' : '  (应能触发)'));
    console.log('       平滑长度 ' + r36.dbg.filtLen + ' 采样 = ' + (r36.dbg.filtLen / sr * 1000).toFixed(2) + ' ms');
  }
  const byCls = { 5: 0, 9: 0, 20: 0 };
  for (const p of r36.pulses) byCls[p.cls]++;
  console.log('    分档: 5ms ' + byCls[5] + ' · 9ms ' + byCls[9] + ' · 20ms ' + byCls[20]);
  const nine = r36.pulses.filter((p) => p.cls === 9);
  const wStat = stats(nine.map((p) => p.widthMs));
  if (wStat) console.log('    9ms 档脉宽: 中位 ' + wStat.median.toFixed(3) + ' ms · MAD ' +
    wStat.mad.toFixed(3) + ' · 极值 ' + wStat.min.toFixed(2) + '..' + wStat.max.toFixed(2));
  const fStat = stats(nine.map((p) => p.freqHz));
  if (fStat) console.log('    9ms 档中心频率: 中位 ' + fStat.median.toFixed(2) + ' Hz · MAD ' +
    fStat.mad.toFixed(2) + ' Hz');
  const endDiff = [];
  for (let i = 1; i < nine.length; i++) {
    const d = (nine[i].endSample - nine[i - 1].endSample) / sr * 1000;
    if (d > 100 && d < 3 * NOMINAL_LINE / sr * 1000) endDiff.push(d);
  }
  const dStat = stats(endDiff);
  if (dStat) console.log('    间隔(相邻 9ms 档): 中位 ' + dStat.median.toFixed(4) + ' ms · MAD ' +
    dStat.mad.toFixed(4) + ' · 均值 ' + dStat.mean.toFixed(4) + ' ms');

  console.log('\n[2] 对照：阶段二十六的包络检测器');
  const env = envelopeDetect(x, sr);
  console.log('    脉冲数 ' + env.length);
  const ed = [];
  for (let i = 1; i < env.length; i++) {
    const d = env[i].centreMs - env[i - 1].centreMs;
    if (d > 100 && d < 3 * NOMINAL_LINE / sr * 1000) ed.push(d);
  }
  const eStat = stats(ed);
  if (eStat) console.log('    间隔: 中位 ' + eStat.median.toFixed(4) + ' ms · MAD ' + eStat.mad.toFixed(4) + ' ms');

  /* Does the decoder's own per-line reference land on these pulses? That decides whether replacing
     the internal detector can help at all (phase 27 left exactly this question open). */
  const refs = [];
  const dec = await Decode.decode(x, sr, { quality: 'fast', yieldEvery: 0, auditLineRefs: refs });
  const truth = nine.map((p) => p.endSample);
  let near = 0, dists = [];
  for (const r of refs) {
    let best = Infinity;
    for (const t of truth) { const d = Math.abs(t - r.ref); if (d < best) best = d; }
    dists.push(best);
    if (best < 0.5 * NOMINAL_LINE * 0.25) near++;
  }
  const ds = stats(dists);
  console.log('\n[3] 解码器自己的逐行参考 vs 本检测器的脉冲');
  console.log('    解码器记录 ' + refs.length + ' 行 · 到最近真脉冲的距离: 中位 ' +
    (ds ? ds.median.toFixed(0) : '-') + ' 采样 · 最大 ' + (ds ? ds.max.toFixed(0) : '-'));
  console.log('    落在 1/8 行周期内的行数: ' + near + ' / ' + refs.length +
    '  ' + (near > 0.8 * refs.length ? '-> 解码器已能锁住真脉冲，问题不在检测 ✓'
      : '-> 解码器未锁住真脉冲，检测器是瓶颈 ✗'));

  fs.writeFileSync(path.join(OUT, 'diagnose-sync-robot36' + (SELF ? '-self' : '') + '.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(), audio: path.relative(ROOT, AUDIO).replace(/\\/g, '/'),
      selfControl: SELF, sampleRate: sr, nominalLineSamples: NOMINAL_LINE,
      robot36: { accepted: r36.pulses.length, rejected: r36.rejected, byClass: byCls,
        width9ms: wStat, freq9ms: fStat, interval: dStat, thresholds: r36.thresholds },
      envelope: { count: env.length, interval: eStat },
      decoderLock: { rows: refs.length, distMedian: ds ? ds.median : null,
        distMax: ds ? ds.max : null, rowsWithinEighthLine: near }
    }, null, 2));
  console.log('\n证据 -> ' + path.relative(ROOT, path.join(OUT,
    'diagnose-sync-robot36' + (SELF ? '-self' : '') + '.json')));
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
