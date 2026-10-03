/*
 * Intra-line instrumentation for the real Scottie S1 recording (phigros).
 *
 * WHY THIS EXISTS
 *   The timing diagnosis (phase 20) eliminated speed and mode-variant as causes, and showed the
 *   decoder locks onto a stretch whose sync train is textbook-clean (428.000 ms median, MAD 1 ms).
 *   So the damage happens INSIDE a line - between the sync pulse and the pixel values.
 *
 *   One number stands out: the decoder's own calibration reports clockScale = 0.9785, while the
 *   line period it is supposed to describe measures 428.000 ms against a nominal 428.22 ms, i.e.
 *   0.99949. A 2.1% error in that scale is applied to EVERY intra-line window
 *   (sstv-decode.js: pixelTime = nominalPixelTime * clockScale, scanSamples = scanTime * clockScale *
 *   sampleRate), so it displaces the pixel grid progressively along each line.
 *
 * WHAT IT DOES
 *   A  independent calibration measurement (long window on the 1900 Hz leader, SHORT window inside
 *      the 9 ms 1200 Hz sync - the previous round used a 42.7 ms window there, which was invalid)
 *   B  four controlled decodes using EXISTING public options, no decoder change:
 *      baseline / clockRecovery:false / afc:false / both off
 *   C  an intra-line dump of one clean line: both pixel grids, per-pixel frequency, confidence,
 *      grey, and a regression of the grid difference against pixel index
 *   D  a receive report collecting the numbers that identify a failure
 *
 * It only ADDS instrumentation; the decoder is not modified.
 *
 * Usage: node tests/diagnose-intra-line.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-intraline');
const SRC = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');   // cached from phase 20

const FFT = require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
const Modes = globalThis.SSTVModes;
const Wav = globalThis.SSTVWav;
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Decode = globalThis.SSTVDecode;

const M = Modes.get('S1');
const FRAME = Modes.totalDuration(M);
const LINE_MS = 1000 * ((M.syncPulse || 0) + (M.syncPorch || 0) +
  M.channels * M.scanTime + (M.chanSync || 0) * (M.sepPulse || 0));
const PIXEL_US = 1e6 * M.scanTime / M.width;          // 432.0 us for S1 (457.6 is Martin M1)

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/**
 * Mirror of Estimator.peak (sstv-decode.js:117-165): Hann window over `len` samples, zero padded to
 * nextPow2(len*mult) clamped to cap, real FFT, magnitude peak, barycentric sub-bin refinement, and
 * the same confidence definition (peak over the furthest-from-peak magnitude).
 * Mirrored rather than exported because the estimator is not part of the public API and the decoder
 * must not be modified.
 */
function peakMirror(x, offset, len, sr, mult, capOverride, confOut) {
  if (len < 4) return 0;
  const cap = capOverride || 4096;
  let size = nextPow2(len * (mult || 1));
  if (size < 128) size = 128;
  if (size > cap) size = cap;
  const input = new Float64Array(size);
  for (let i = 0; i < len; i++) {
    input[i] = (x[offset + i] || 0) * (0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1))));
  }
  const fft = new FFT(size), out = fft.createComplexArray();
  fft.realTransform(out, input);
  fft.completeSpectrum(out);
  const nb = size / 2 + 1;
  const mags = new Float64Array(nb);
  let best = -1, bx = 0;
  for (let k = 0; k < nb; k++) {
    const m = Math.hypot(out[2 * k], out[2 * k + 1]);
    mags[k] = m;
    if (m > best) { best = m; bx = k; }
  }
  const y1 = bx <= 0 ? mags[bx] : mags[bx - 1];
  const y3 = bx + 1 >= nb ? mags[bx] : mags[bx + 1];
  const den = y3 + mags[bx] + y1;
  const peakIdx = den === 0 ? 0 : (y3 - y1) / den + bx;
  if (confOut) {
    let floor = 1e-12;
    for (let q = 0; q < nb; q++) {
      if (q >= bx - 3 && q <= bx + 3) continue;
      if (mags[q] > floor) floor = mags[q];
    }
    confOut[0] = 20 * Math.log10((best + 1e-12) / (floor + 1e-12));
  }
  return peakIdx * sr / size;
}

function calcLum(freq) {            // mirror of sstv-decode.js:73
  const f = Math.max(1500, Math.min(2300, freq));
  return Math.round(255 * (f - 1500) / (2300 - 1500));
}

function rowCorrelation(img) {
  const w = img.width, h = img.height, d = img.data;
  let sum = 0, count = 0;
  for (let y = 0; y + 1 < h; y++) {
    let ma = 0, mb = 0;
    for (let x = 0; x < w; x++) { ma += d[(y * w + x) * 4 + 1]; mb += d[((y + 1) * w + x) * 4 + 1]; }
    ma /= w; mb /= w;
    let num = 0, da = 0, db = 0;
    for (let x = 0; x < w; x++) {
      const u = d[(y * w + x) * 4 + 1] - ma, v = d[((y + 1) * w + x) * 4 + 1] - mb;
      num += u * v; da += u * u; db += v * v;
    }
    if (da > 0 && db > 0) { sum += num / Math.sqrt(da * db); count++; }
  }
  return count ? sum / count : 0;
}

function linreg(ys) {               // y against index; returns slope, intercept, r2
  const n = ys.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const d = n * sxx - sx * sx;
  const slope = d === 0 ? 0 : (n * sxy - sx * sy) / d;
  const inter = (sy - slope * sx) / n;
  let ss = 0, st = 0;
  const my = sy / n;
  for (let i = 0; i < n; i++) {
    const p = inter + slope * i;
    ss += (ys[i] - p) * (ys[i] - p);
    st += (ys[i] - my) * (ys[i] - my);
  }
  return { slope, inter, r2: st === 0 ? 0 : 1 - ss / st, residualSd: Math.sqrt(ss / Math.max(1, n - 2)) };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(SRC)) {
    console.log('missing ' + SRC + ' - run node tests/diagnose-timing.js first (it builds the cache)');
    process.exitCode = 1; return;
  }
  const buf = fs.readFileSync(SRC);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const sr = info.sampleRate, x = info.samples;

  console.log('=== 行内仪器化诊断 ===\n');
  console.log('source   : ' + path.relative(ROOT, SRC));
  console.log('audio    : ' + sr + ' Hz mono, ' + info.duration.toFixed(3) + ' s');
  console.log('S1 timing: line ' + LINE_MS.toFixed(2) + ' ms · pixel ' + PIXEL_US.toFixed(1) +
    ' us · ' + M.channels + ' channels/line · windowFactor ' + M.windowFactor);

  // ---------------------------------------------------------------- [B] controlled decodes
  console.log('\n[B] 四组对照解码（全部使用已有公开选项，未改解码器）');
  const pngjs = (() => {
    try { return require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); }
    catch (e) { return null; }
  })();
  const variants = [
    ['基线（默认）', {}],
    ['关时钟恢复', { clockRecovery: false }],
    ['关频率标定', { afc: false }],
    ['两者都关', { afc: false, clockRecovery: false }]
  ];
  const runs = [];
  for (const [label, opts] of variants) {
    const t0 = Date.now();
    const d = await Decode.decode(x, sr, Object.assign({ quality: 'fast', yieldEvery: 0 }, opts));
    const cal = d.calibration || {};
    const rc = d.ok ? rowCorrelation(d.imageData) : null;
    runs.push({ label, opts, ok: d.ok, mode: d.mode && d.mode.name, cal, rc, img: d.imageData,
      sec: (Date.now() - t0) / 1000 });
    console.log('  ' + label.padEnd(12) + (d.ok ? 'ok  ' : 'FAIL') +
      '  clockScale ' + (cal.clockScale == null ? '-' : cal.clockScale.toFixed(5)) +
      '  a=' + (cal.scale == null ? '-' : cal.scale.toFixed(5)) +
      '  b=' + (cal.offsetHz == null ? '-' : cal.offsetHz.toFixed(2)) +
      '  行间相关 ' + (rc == null ? '  -  ' : rc.toFixed(4)) +
      '  (' + runs[runs.length - 1].sec.toFixed(1) + ' s)');
    if (d.ok && pngjs) {
      const png = new pngjs.PNG({ width: d.imageData.width, height: d.imageData.height });
      png.data = Buffer.from(d.imageData.data.buffer, d.imageData.data.byteOffset, d.imageData.data.length);
      const name = 'decode-' + label.replace(/[（）]/g, '') + '.png';
      fs.writeFileSync(path.join(OUT, name), pngjs.PNG.sync.write(png));
    }
  }
  const byCorr = runs.filter((r) => r.rc != null).sort((a, b) => b.rc - a.rc);
  console.log('  按行间相关排序: ' + byCorr.map((r) => r.label + ' ' + r.rc.toFixed(4)).join('  |  '));

  /*
   * [B2] Band-limit experiment.
   *
   * [C] below shows the per-pixel windows landing on 3.0-3.4 kHz, far above the SSTV image band
   * (1500-2300 Hz), which means the frequency estimator is picking the strongest thing in a very
   * short window and that thing is out-of-band content. If that is the mechanism, restricting the
   * audio to the SSTV band before demodulation should recover the picture. Diagnostic preprocessing
   * only - the decoder is untouched.
   */
  function biquad(sig, sr, type, f0, Q) {
    const w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q);
    let b0, b1, b2;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    const y = new Float32Array(sig.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < sig.length; i++) {
      const v = (b0 / a0) * sig[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
      x2 = x1; x1 = sig[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  const bands = [[1400, 2400], [1000, 2600], [1200, 2400]];
  console.log('\n[B2] 带限后再解码（诊断预处理，未改解码器）');
  for (const [lo, hi] of bands) {
    const y = biquad(biquad(x, sr, 'hp', lo, 0.707), sr, 'lp', hi, 0.707);
    const d = await Decode.decode(y, sr, { quality: 'fast', yieldEvery: 0 });
    const rc = d.ok ? rowCorrelation(d.imageData) : null;
    console.log('  带限 ' + lo + '-' + hi + ' Hz   ' + (d.ok ? 'ok  ' : 'FAIL') +
      '  行间相关 ' + (rc == null ? '  -  ' : rc.toFixed(4)));
    if (d.ok && pngjs) {
      const png = new pngjs.PNG({ width: d.imageData.width, height: d.imageData.height });
      png.data = Buffer.from(d.imageData.data.buffer, d.imageData.data.byteOffset, d.imageData.data.length);
      fs.writeFileSync(path.join(OUT, 'band-' + lo + '-' + hi + '.png'), pngjs.PNG.sync.write(png));
    }
  }

  // ---------------------------------------------------------------- pulse train (for a clean line)
  const decim = Math.round(sr / 1000);
  function envelope(freq, tauMs) {
    const w = 2 * Math.PI * freq / sr, c = Math.cos(w), s = Math.sin(w);
    const a = Math.exp(-1 / (sr * (tauMs || 2) / 1000));
    const n = Math.floor(x.length / decim), o = new Float32Array(n);
    let ci = 1, si = 0, I = 0, Q = 0, oi = 0;
    for (let i = 0; i < x.length; i++) {
      const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
      const v = x[i];
      I = a * I + (1 - a) * (v * ci); Q = a * Q + (1 - a) * (v * si);
      if (i % decim === 0 && oi < n) o[oi++] = Math.sqrt(I * I + Q * Q);
    }
    return o;
  }
  const e12 = envelope(1200, 2), e15 = envelope(1500, 2), e19 = envelope(1900, 2), e23 = envelope(2300, 2);
  const eRef = new Float32Array(e12.length);
  for (let i = 0; i < eRef.length; i++) eRef[i] = (e15[i] + e19[i] + e23[i]) / 3;
  const msPerBin = 1000 * decim / sr;
  const pulses = [];
  let run = -1;
  for (let i = 0; i < e12.length; i++) {
    const on = e12[i] > 1.55 * Math.max(eRef[i], 1e-4);
    if (on && run < 0) run = i;
    else if (!on && run >= 0) {
      const ms = (i - run) * msPerBin;
      if (ms >= 4 && ms <= 18) pulses.push({ t: run * msPerBin / 1000, ms });
      run = -1;
    }
  }
  const base = runs[0];
  const lockStart = (base.cal.imageStart || 0) / sr;

  /*
   * Choose a CLEAN line: the sync must sit inside the locked stretch and both neighbouring
   * intervals must be tight around the nominal 428.22 ms, so line-timing error cannot be blamed on
   * a bad sync detection.
   */
  let pick = -1;
  for (let i = 1; i + 1 < pulses.length; i++) {
    const a = (pulses[i].t - pulses[i - 1].t) * 1000;
    const b = (pulses[i + 1].t - pulses[i].t) * 1000;
    if (pulses[i].t > lockStart + 2 && Math.abs(a - LINE_MS) < 2 && Math.abs(b - LINE_MS) < 2) { pick = i; break; }
  }
  if (pick < 0) { console.log('\n!! 未找到干净行'); process.exitCode = 1; return; }
  const lineSync = pulses[pick];
  const nextSync = pulses[pick + 1];
  const lineIdx = Math.round((lineSync.t - lockStart) * 1000 / LINE_MS) + 1;

  // ---------------------------------------------------------------- [A] calibration truth
  console.log('\n[A] 标定真实性检查（独立测量，短窗修正）');
  /*
   * The leader is the 1900 Hz burst immediately BEFORE the locked stretch. An earlier version
   * searched from t=0 and took the global max over the first 60 s, which is nowhere near the
   * locked stretch (106.95 s) - it latched onto image content and reported 3323 Hz.
   */
  const lFrom = Math.max(0, Math.floor((lockStart - 1.6) * 1000));
  const lTo = Math.floor(lockStart * 1000);
  let leaderBin = -1, leaderBest = 0;
  for (let i = lFrom; i < lTo && i < e19.length; i++) {
    if (e19[i] > leaderBest) { leaderBest = e19[i]; leaderBin = i; }
  }
  const leaderT = leaderBin >= 0 ? leaderBin * msPerBin / 1000 : -1;
  const c1 = new Float32Array(1);
  /* 150 ms sits comfortably inside the 300 ms leader; zero-padding (mult) gives fine resolution. */
  const leaderHz = leaderT >= 0
    ? peakMirror(x, Math.floor((leaderT + 0.05) * sr), Math.round(0.15 * sr), sr, 1, 16384, c1) : null;
  /*
   * Sync: only 9 ms long, so the window MUST fit inside it - the previous round's 42.7 ms window
   * straddled the sync and the image content, so its "1312.5 Hz" was measuring content, not sync.
   * The transform is ALSO zero-padded: nextPow2(240) = 256 gives 187.5 Hz bins, far too coarse to
   * say anything about a 1200 Hz tone, so a high mult is passed to reach an 8192-point transform
   * (5.86 Hz bins).
   */
  const syncWin = Math.min(Math.round(0.005 * sr), Math.round(lineSync.ms / 1000 * sr));
  const syncHzs = [];
  for (let k = pick; k < Math.min(pick + 24, pulses.length - 1); k++) {
    const s0 = Math.floor((pulses[k].t + 0.002) * sr);
    const cc = new Float32Array(1);
    syncHzs.push({ hz: peakMirror(x, s0, syncWin, sr, 32, 16384, cc), conf: cc[0] });
  }
  syncHzs.sort((a, b) => a.hz - b.hz);
  const syncHz = syncHzs.length ? syncHzs[Math.floor(syncHzs.length / 2)].hz : null;
  console.log('  傅里叶分辨率检查: 同步窗 ' + syncWin + ' 采样, 零填充到 ' +
    nextPow2(syncWin * 32) + ' 点 -> ' + (sr / nextPow2(syncWin * 32)).toFixed(2) + ' Hz/bin');
  console.log('  前导音（150 ms 长窗）      : ' + (leaderHz == null ? '未检出' : leaderHz.toFixed(2) + ' Hz') +
    '   标准 1900   解码器自报 ' + (base.cal.leaderFreqHz == null ? '-' : base.cal.leaderFreqHz.toFixed(3)));
  console.log('  同步音（' + (syncWin / sr * 1000).toFixed(1) + ' ms 短窗, n=' + syncHzs.length + '）  : ' +
    (syncHz == null ? '未检出' : syncHz.toFixed(2) + ' Hz') + '   标准 1200   置信中位 ' +
    (syncHzs.length ? syncHzs[Math.floor(syncHzs.length / 2)].conf.toFixed(1) + ' dB' : '-'));
  console.log('  解码器反推的同步音         : ' +
    ((1200 - (base.cal.offsetHz || 0)) / (base.cal.scale || 1)).toFixed(2) + ' Hz  ' +
    '(由 a=' + (base.cal.scale || 0).toFixed(4) + ' b=' + (base.cal.offsetHz || 0).toFixed(2) + ' 反解)');
  if (leaderHz != null && syncHz != null) {
    console.log('  => 前导偏差 ' + (((leaderHz / 1900) - 1) * 100).toFixed(3) + '%   ' +
      '同步偏差 ' + (((syncHz / 1200) - 1) * 100).toFixed(3) + '%');
    const lDev = (leaderHz / 1900) - 1, sDev = (syncHz / 1200) - 1;
    if (Math.abs(lDev - sDev) > 0.002) {
      console.log('  => 两个音的偏差【不一致】。均匀的频率偏移会让两者同比例变化，' +
        '不一致说明其中一个的测量被污染，而不是音频真的偏了。');
    }
  }

  // ---------------------------------------------------------------- [C] intra-line dump
  console.log('\n[C] 行内 dump（干净行 #' + lineIdx + '）');
  const nominalLineSamples = M.scanTime * M.channels * sr;   // 3 scans, for reference
  const decoderScale = base.cal.clockScale == null ? 1 : base.cal.clockScale;
  const trueScale = 0.99949;                                  // measured 428.000 / 428.22
  const winSamples = Math.max(8, Math.round((M.scanTime / M.width) * M.windowFactor * sr));

  console.log('  同步脉冲: 起点 ' + lineSync.t.toFixed(4) + ' s, 宽度 ' + lineSync.ms.toFixed(2) + ' ms');
  console.log('  下一个同步: ' + nextSync.t.toFixed(4) + ' s, 实测间隔 ' +
    ((nextSync.t - lineSync.t) * 1000).toFixed(3) + ' ms');
  console.log('  clockScale: 解码器 ' + decoderScale.toFixed(5) + '  实测 ' + trueScale.toFixed(5) +
    '  偏差 ' + (((decoderScale / trueScale) - 1) * 100).toFixed(2) + '%');
  console.log('  像素窗: ' + winSamples + ' 采样 (' + (winSamples / sr * 1e6).toFixed(0) + ' us), windowFactor ' + M.windowFactor);

  /*
   * Reconstruct BOTH pixel grids from the same sync start.
   *   decoder grid : what sstv-decode.js computes, i.e. every scan/window duration multiplied by
   *                  clockScale (see sstv-decode.js lines 812-816 and 946-956)
   *   expected grid: the same geometry with clockScale = 1, which is what a standard S1 line is
   */
  function grid(clockScale) {
    const syncS = M.syncPulse * sr;
    const porchS = M.syncPorch * sr;
    const scanS = M.scanTime * clockScale * sr;
    const sepS = M.sepPulse * sr;
    const pixT = (M.scanTime / M.width) * clockScale;
    const pos = [];       // [channel][pixel] center offset in samples from the sync start
    for (let ch = 0; ch < M.channels; ch++) {
      const chStart = syncS + porchS + ch * (scanS + sepS);
      const row = [];
      for (let px = 0; px < M.width; px++) row.push(chStart + (px + 0.5) * pixT * sr);
      pos.push(row);
    }
    return { pos, scanS, chEnd: syncS + porchS + M.channels * scanS + (M.channels - 1) * sepS };
  }
  const gDec = grid(decoderScale), gExp = grid(1);
  const syncSample = Math.floor(lineSync.t * sr);
  console.log('  通道扫描长度: 解码器 ' + (gDec.scanS / sr * 1000).toFixed(3) + ' ms   期望 ' +
    (gExp.scanS / sr * 1000).toFixed(3) + ' ms   差 ' +
    (((gDec.scanS / gExp.scanS) - 1) * 100).toFixed(2) + '%');

  // per-pixel probe on the green channel
  const conv = new Float32Array(1);
  const dump = [];
  for (let px = 0; px < M.width; px++) {
    const cd = gDec.pos[0][px], ce = gExp.pos[0][px];
    const off = Math.round(syncSample + ce - winSamples / 2);
    const f = peakMirror(x, off, winSamples, sr, M.windowFactor || 2.34, 4096, conv);
    dump.push({ px, dec: syncSample + cd, exp: syncSample + ce, dSamples: cd - ce,
      f: f, conf: conv[0], grey: calcLum(f) });
  }
  console.log('\n  差异表（每 32 像素抽样；Δ = 解码器窗心 − 期望窗心）');
  console.log('  像素   解码器窗心(s)    期望窗心(s)     Δ(采样)  Δ(像素)   频率(Hz)  置信(dB)  灰度');
  for (let px = 0; px < M.width; px += 32) {
    const r = dump[px];
    console.log('  ' + String(px).padStart(4) + '   ' + (r.dec / sr).toFixed(6).padStart(12) +
      '  ' + (r.exp / sr).toFixed(6).padStart(12) +
      '  ' + String(r.dSamples).padStart(7) +
      '  ' + (r.dSamples / ((M.scanTime / M.width) * sr)).toFixed(2).padStart(7) +
      '  ' + r.f.toFixed(1).padStart(9) +
      '  ' + r.conf.toFixed(1).padStart(7) +
      '  ' + String(r.grey).padStart(4));
  }
  const reg = linreg(dump.map((r) => r.dSamples));
  const pixT = (M.scanTime / M.width) * sr;
  console.log('\n  差异回归 Δ(n) = 截距 + 斜率·n  (n = 像素索引)');
  console.log('    截距     ' + reg.inter.toFixed(3) + ' 采样 = ' + (reg.inter / pixT).toFixed(3) + ' 像素' +
    '   -> ' + (Math.abs(reg.inter) < pixT ? '近似为 0：同步定位没问题' : '非零：同步定位有偏'));
  console.log('    斜率     ' + reg.slope.toFixed(5) + ' 采样/像素 = ' + (reg.slope / pixT).toFixed(5) + ' 像素/像素');
  console.log('    末像素累计 ' + (reg.slope * (M.width - 1)).toFixed(1) + ' 采样 = ' +
    (reg.slope * (M.width - 1) / pixT).toFixed(2) + ' 像素');
  console.log('    R²       ' + reg.r2.toFixed(4) + '   残差标准差 ' + reg.residualSd.toFixed(2) + ' 采样');
  console.log('    => ' + (reg.r2 > 0.9
    ? '偏差【线性累积】，典型的像素时间/时钟尺度误差（正是 clockScale 的作用方式）'
    : (Math.abs(reg.residualSd) > pixT
      ? '偏差【无规律】，更像频率估计被内容干扰'
      : '偏差近乎恒定，指向同步定位')));

  // ---------------------------------------------------------------- [D] receive report
  const diffs = [];
  for (let i = pick; i + 1 < pulses.length; i++) {
    const d = (pulses[i + 1].t - pulses[i].t) * 1000;
    if (d > 4 && d < 2000) diffs.push(d);
  }
  diffs.sort((a, b) => a - b);
  const med = diffs[Math.floor(diffs.length / 2)];
  const mad = diffs.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(diffs.length / 2)];
  const confs = dump.map((r) => r.conf).sort((a, b) => a - b);
  console.log('\n[D] ================ 接收报告 ================');
  console.log('文件            phigros.wav（扩展名骗人：实为 MP3 48k stereo）-> 48k mono 缓存');
  console.log('时长 / 帧数     ' + info.duration.toFixed(3) + ' s   ' + (info.duration / FRAME).toFixed(3) +
    ' 帧（单帧 ' + FRAME.toFixed(3) + ' s）');
  console.log('锁定区段        ' + lockStart.toFixed(3) + ' .. ' + (lockStart + FRAME).toFixed(3) + ' s');
  console.log('同步脉冲        本地段 ' + diffs.length + ' 个间隔');
  console.log('行间隔          中位 ' + med.toFixed(3) + ' ms · MAD ' + mad.toFixed(3) + ' ms · 标准 ' +
    LINE_MS.toFixed(2) + ' ms · 偏差 ' + (((med / LINE_MS) - 1) * 100).toFixed(3) + '%');
  console.log('同步音频率      实测 ' + (syncHz == null ? '-' : syncHz.toFixed(2)) + ' Hz · 标准 1200 Hz');
  console.log('前导频率        实测 ' + (leaderHz == null ? '-' : leaderHz.toFixed(2)) +
    ' Hz · 标准 1900 Hz · 解码器自报 ' + (base.cal.leaderFreqHz == null ? '-' : base.cal.leaderFreqHz.toFixed(3)));
  console.log('标定 a, b       a=' + (base.cal.scale || 0).toFixed(5) + '  b=' + (base.cal.offsetHz || 0).toFixed(3) +
    '   反推同步音 ' + ((1200 - (base.cal.offsetHz || 0)) / (base.cal.scale || 1)).toFixed(2) + ' Hz');
  console.log('clockScale      自报 ' + decoderScale.toFixed(5) + ' · 实测应为 ' + trueScale.toFixed(5) +
    ' · 差 ' + (((decoderScale / trueScale) - 1) * 100).toFixed(2) + '%');
  console.log('像素时间        实测 ' + (((med - 1000 * ((M.syncPulse || 0) + (M.syncPorch || 0) +
    (M.chanSync || 0) * (M.sepPulse || 0))) / M.channels / M.width * 1000).toFixed(2)) +
    ' us · 标准 ' + PIXEL_US.toFixed(2) + ' us  (S1；457.6 us 是 M1)');
  console.log('通道扫描长度    解码器 ' + (gDec.scanS / sr * 1000).toFixed(2) + ' ms · 期望 ' +
    (gExp.scanS / sr * 1000).toFixed(2) + ' ms');
  console.log('像素窗          前 32 像素置信度中位 ' + confs[Math.floor(confs.length / 2)].toFixed(1) + ' dB');
  console.log('行间垂直相关    ' + byCorr.map((r) => r.label + ' ' + r.rc.toFixed(4)).join(' · '));
  console.log('诊断结论        ' + (byCorr[0].label === '基线（默认）'
    ? '默认配置即为最佳，clockScale 不是唯一原因，需看 [C] 的线性度'
    : '关闭「' + byCorr[0].label.replace('关', '') + '」后行间相关显著提升 -> 该环节是主因'));
  console.log('==========================================');
  console.log('\nPNG 产物: ' + path.relative(ROOT, OUT) + '/decode-*.png（请肉眼确认哪一版可辨认）');
})().catch((e) => { console.error('diagnosis error: ' + (e && e.stack || e)); process.exitCode = 1; });
