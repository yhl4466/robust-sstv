/*
 * Per-line sync tracking diagnosis: is the recording's clock drifting, or is the decoder's
 * line-slope estimate simply wrong?
 *
 * WHY
 *   Phase 25 could not build a phase-coherent grid over the real recording (61% inliers vs 99.6% for
 *   our own audio) and concluded "the clock is incoherent". But that measurement used a 1 ms-binned
 *   one-pole envelope, i.e. a time resolution of 48 samples, so the incoherence may have been its
 *   own artefact. This uses a much finer detector (1.5 ms Hann window on 1200 Hz, 0.25 ms hop) and
 *   asks the sharper question:
 *
 *     the decoder reports clockScale = 0.97852, i.e. it fitted a line period of 20113 samples
 *     against a nominal 20554.56 - 2.15% SHORT. If the true period is nominal, that fit is the
 *     defect, and a 441 sample/line error walks the per-line prediction out of the sync search
 *     window within ~24 lines. Phase 20 already saw the smoking gun: the pulse intervals have a
 *     MEAN of 377 ms against a MEDIAN of 428 ms, i.e. spurious short intervals from music dragging a
 *     least-squares fit downwards.
 *
 * WHAT IT DOES
 *   [1] fine sync detection, with the same detector run on OUR OWN audio as a control
 *   [2] LS + RANSAC line fit: skip, rate, rate - nominal, R^2, residual, inlier rate, accumulated drift
 *   [3] the same fit restricted to the largest coherent run (robustness check)
 *   [4] comparison with the decoder's own fitted slope
 *
 * Usage: node tests/diagnose-sync-tracking.js [--self]
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
const SR = 48000;
const NOMINAL_LINE = ((MODE.syncPulse || 0) + (MODE.syncPorch || 0) +
  MODE.channels * MODE.scanTime + (MODE.chanSync || 0) * (MODE.sepPulse || 0)) * SR;
const SYNC_MS = (MODE.syncPulse || 0.009) * 1000;

/**
 * Sync detection: quadrature envelope at 1200 Hz plus the three competing tones, sampled every
 * DECIM samples (0.25 ms).
 *
 * The task suggested a 1.5 ms Hann window. That cannot work here, and the self-diagnosis said so
 * plainly: a 1.5 ms window resolves roughly 667 Hz, while the sync tone and the image band's lower
 * edge are only 300 Hz apart (0.45 of a resolution cell), so 1200 Hz was NEVER the locally strongest
 * tone - the maximum ratio was 1.248 against a 1.4 threshold, i.e. zero pulses on our own audio.
 * Separating 300 Hz needs at least ~3.3 ms of window and practically ~8 ms.
 *
 * So this keeps the detector that already works (quadrature mixing plus a short one-pole envelope,
 * which gave 256 pulses with 0.000 ms interval MAD on the control) and tightens only its TIME
 * resolution: the earlier version decimated to 1 ms bins, which is what quantised every interval to
 * whole milliseconds and produced the bogus "the line period is 428.000 ms" of phases 20/24/25.
 */
const DECIM = Math.round(0.00025 * SR);   // 0.25 ms between envelope samples
function detectSyncs(x, sr) {
  const freqs = [1200, 1500, 1900, 2300];
  const env = freqs.map((f) => {
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w);
    const a = Math.exp(-1 / (sr * 0.002));           // ~2 ms one-pole envelope
    const n = Math.floor(x.length / DECIM);
    const out = new Float32Array(n);
    let ci = 1, si = 0, I = 0, Q = 0, o = 0;
    for (let i = 0; i < x.length; i++) {
      const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
      const v = x[i];
      I = a * I + (1 - a) * (v * ci);
      Q = a * Q + (1 - a) * (v * si);
      if (i % DECIM === 0 && o < n) out[o++] = Math.sqrt(I * I + Q * Q);
    }
    return out;
  });
  const n = env[0].length;
  const msPerBin = DECIM / sr * 1000;                 // 0.25 ms
  const K = 1.4;
  const MINRUN = Math.round(0.004 / (msPerBin / 1000));
  const MAXRUN = Math.round(0.018 / (msPerBin / 1000));
  const pulses = [];
  let run = -1;
  for (let k = 0; k < n; k++) {
    const rivals = Math.max(env[1][k], env[2][k], env[3][k]);
    const on = env[0][k] > K * Math.max(rivals, 1e-4);
    if (on && run < 0) run = k;
    else if (!on && run >= 0) {
      if (k - run >= MINRUN && k - run <= MAXRUN) {
        /* centre = strongest bin in the run, refined parabolically for sub-bin timing;
           onset = centre - half a sync pulse. */
        let best = -1, bk = run;
        for (let q = run; q < k; q++) if (env[0][q] > best) { best = env[0][q]; bk = q; }
        const y1 = env[0][Math.max(0, bk - 1)], y2 = env[0][bk], y3 = env[0][Math.min(n - 1, bk + 1)];
        const den = y1 - 2 * y2 + y3;
        const shift = den === 0 ? 0 : 0.5 * (y1 - y3) / den;
        const centreMs = (bk + 0.5 + shift) * msPerBin;
        pulses.push({ startSample: centreMs * sr / 1000 - (SYNC_MS / 2) * sr / 1000,
          centreMs: centreMs, ms: (k - run) * msPerBin });
      }
      run = -1;
    }
  }
  return { pulses: pulses, dbg: { n: n, e0: env[0], e1: env[1], e2: env[2], e3: env[3] } };
}

function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of s) sum += v;
  const mean = sum / s.length;
  let v2 = 0; for (const v of s) v2 += (v - mean) * (v - mean);
  return { n: s.length, median: med, mad: mad, mean: mean, sd: Math.sqrt(v2 / s.length), min: s[0], max: s[s.length - 1] };
}

/** Least squares of pos = skip + rate * n over the given (n, pos) pairs. */
function lsLine(pairs) {
  const n = pairs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pairs) { sx += p.n; sy += p.pos; sxx += p.n * p.n; sxy += p.n * p.pos; }
  const d = n * sxx - sx * sx;
  if (d === 0) return null;
  const rate = (n * sxy - sx * sy) / d;
  const skip = (sy - rate * sx) / n;
  let ss = 0, st = 0; const my = sy / n;
  for (const p of pairs) {
    const r = p.pos - (skip + rate * p.n);
    ss += r * r; st += (p.pos - my) * (p.pos - my);
  }
  return { skip: skip, rate: rate, r2: st === 0 ? 0 : 1 - ss / st,
    residualSd: Math.sqrt(ss / Math.max(1, n - 2)), n: n };
}

/** RANSAC over pairs, then a final LS on the inliers. Returns the fit plus the inlier set. */
function ransacLine(pulses, tolSamples, iters) {
  const pts = pulses.map((p, i) => ({ n: i, pos: p.startSample }));
  if (pts.length < 3) return null;
  let best = null;
  const rnd = (m) => Math.floor(Math.random() * m);
  for (let it = 0; it < (iters || 600); it++) {
    const a = pts[rnd(pts.length)], b = pts[rnd(pts.length)];
    if (a.n === b.n) continue;
    const rate = (b.pos - a.pos) / (b.n - a.n);
    if (!(rate > 1000 && rate < 100000)) continue;
    const skip = a.pos - rate * a.n;
    let count = 0;
    for (const p of pts) if (Math.abs(p.pos - (skip + rate * p.n)) <= tolSamples) count++;
    if (!best || count > best.count) best = { count: count, skip: skip, rate: rate };
  }
  if (!best) return null;
  const inliers = pts.filter((p) => Math.abs(p.pos - (best.skip + best.rate * p.n)) <= tolSamples);
  const fit = lsLine(inliers);
  return { fit: fit, inliers: inliers.length, total: pts.length,
    inlierRate: inliers.length / pts.length, ransac: best };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(AUDIO)) { console.log('missing ' + AUDIO); process.exitCode = 1; return; }
  const buf = fs.readFileSync(AUDIO);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const x = info.samples, sr = info.sampleRate;

  console.log('=== 逐行同步跟踪诊断 ===\n');
  console.log('音频   : ' + path.relative(ROOT, AUDIO) + (SELF ? '   (对照组)' : '   (真实录音)'));
  console.log('        ' + info.duration.toFixed(3) + ' s @ ' + sr + ' Hz');
  console.log('检测器 : 正交包络 @1200/1500/1900/2300 Hz · 抽取 ' +
    (DECIM / SR * 1000).toFixed(2) + ' ms · 要求 1200 Hz 为局部最强音 (k=1.4)');
  console.log('标称行 : ' + NOMINAL_LINE.toFixed(2) + ' 采样（' + (NOMINAL_LINE / sr * 1000).toFixed(2) + ' ms）');

  // ---------------------------------------------------------------- [1]
  console.log('\n[1] 同步脉冲探测');
  const t0 = Date.now();
  const det = detectSyncs(x, sr);
  const pulses = det.pulses, dbg = det.dbg;
  console.log('    脉冲数 ' + pulses.length + '   (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  if (!pulses.length) {
    /*
     * Self-diagnosis rather than a bare zero: show what the detector actually saw, so a threshold
     * or window-size mistake is visible instead of being reported as "no syncs in the audio".
     */
    let maxE = 0, maxRatio = 0, onCount = 0;
    const runHist = {};
    let run = 0;
    for (let k = 0; k < dbg.n; k++) {
      const rivals = Math.max(dbg.e1[k], dbg.e2[k], dbg.e3[k]);
      const ratio = dbg.e0[k] / Math.max(rivals, 1e-12);
      if (dbg.e0[k] > maxE) maxE = dbg.e0[k];
      if (ratio > maxRatio) maxRatio = ratio;
      if (ratio > 1.4) { onCount++; run++; } else { if (run) { runHist[run] = (runHist[run] || 0) + 1; run = 0; } }
    }
    console.log('    !! 零脉冲，自诊断: 最大 E1200 = ' + maxE.toExponential(3) +
      ' · 最大比值 E1200/max(其他) = ' + maxRatio.toFixed(3) +
      ' · 比值 > 1.4 的 bin 数 = ' + onCount);
    const keys = Object.keys(runHist).map(Number).sort((a, b) => a - b).slice(-8);
    console.log('    连续命中段的长度分布(hop): ' + (keys.length
      ? keys.map((k2) => k2 + '×' + runHist[k2]).join(' ') : '（无任何命中段）') +
      '   需要 ' + Math.round(0.004 / (HOP / sr)) + '..' + Math.round(0.018 / (HOP / sr)) + ' hop');
    if (maxRatio < 1.4) {
      console.log('    => 1200 Hz 从来不是局部最强音: 阈值 k=1.4 太严，或基频/采样率口径有误');
    } else if (onCount > 0 && !keys.length) {
      console.log('    => 有命中但段太短: MINRUN 太严');
    }
    process.exitCode = 1; return;
  }
  const diffs = [];
  for (let i = 1; i < pulses.length; i++) {
    const d = pulses[i].startSample - pulses[i - 1].startSample;
    if (d > 100 && d < 4 * NOMINAL_LINE) diffs.push(d / sr * 1000);
  }
  const ds = stats(diffs);
  if (ds) {
    console.log('    间隔: 中位 ' + ds.median.toFixed(4) + ' ms · MAD ' + ds.mad.toFixed(4) +
      ' ms · 均值 ' + ds.mean.toFixed(4) + ' ms · 标准差 ' + ds.sd.toFixed(4) + ' ms');
    console.log('          极值 ' + ds.min.toFixed(3) + ' .. ' + ds.max.toFixed(3) + ' ms');
    console.log('    中位 vs 标称 ' + (NOMINAL_LINE / sr * 1000).toFixed(4) + ' ms: 偏差 ' +
      ((ds.median / (NOMINAL_LINE / sr * 1000) - 1) * 100).toFixed(4) + '%');
    console.log('    均值 vs 中位: ' + (ds.mean - ds.median).toFixed(4) + ' ms  ' +
      (Math.abs(ds.mean - ds.median) > 5 ? '← 均值被短间隔严重拖低（LS 拟合会被它带偏）' : '← 两者接近'));
  }
  const pulseMs = stats(pulses.map((p) => p.ms));
  console.log('    脉冲宽度: 中位 ' + pulseMs.median.toFixed(3) + ' ms (标准 ' + SYNC_MS + ' ms)');

  // ---------------------------------------------------------------- [2]
  console.log('\n[2] 直线拟合 pos = skip + rate · n   (LS + RANSAC)');
  const TOL = Math.round(0.0005 * sr);   // 0.5 ms inlier tolerance
  const r = ransacLine(pulses, TOL, 800);
  if (!r) { console.log('    拟合失败'); process.exitCode = 1; return; }
  const f = r.fit;
  const drift = f.rate - NOMINAL_LINE;
  console.log('    skip = ' + f.skip.toFixed(1) + ' 采样 (' + (f.skip / sr).toFixed(4) + ' s)');
  console.log('    rate = ' + f.rate.toFixed(3) + ' 采样/行 (' + (f.rate / sr * 1000).toFixed(4) + ' ms/行)');
  console.log('    标称 = ' + NOMINAL_LINE.toFixed(3) + ' 采样/行');
  console.log('    ** 每行漂移 rate − 标称 = ' + drift.toFixed(3) + ' 采样/行 (' +
    (drift / NOMINAL_LINE * 100).toFixed(4) + '%) **');
  console.log('    R² = ' + f.r2.toFixed(6) + ' · 残差标准差 = ' + f.residualSd.toFixed(2) + ' 采样 (' +
    (f.residualSd / sr * 1e6).toFixed(0) + ' us)');
  console.log('    inlier ' + r.inliers + ' / ' + r.total + ' (' + (100 * r.inlierRate).toFixed(1) + '%)');
  console.log('    256 行累计漂移 = ' + (drift * 256).toFixed(0) + ' 采样 = ' +
    (drift * 256 / NOMINAL_LINE).toFixed(2) + ' 行');

  // ---------------------------------------------------------------- [2b] largest coherent run
  const inl = pulses.filter((p, i) => Math.abs(p.startSample - (f.skip + f.rate * i)) <= TOL);
  let runStart = 0, runLen = 0, curStart = 0, curLen = 0;
  for (let i = 0; i < pulses.length; i++) {
    const inside = Math.abs(pulses[i].startSample - (f.skip + f.rate * i)) <= TOL;
    if (inside) { if (curLen === 0) curStart = i; curLen++; if (curLen > runLen) { runLen = curLen; runStart = curStart; } }
    else curLen = 0;
  }
  console.log('\n[2b] 最长连续 inlier 段: 行 ' + runStart + ' .. ' + (runStart + runLen - 1) +
    '（' + runLen + ' 行连续）');
  console.log('     ' + (runLen >= 32 ? '存在长段锁相 —— 漂移是缓慢的，不是随机的 ✓'
    : '没有长段锁相 —— 同步位置不服从单一线性模型 ✗'));

  // ---------------------------------------------------------------- [3]
  console.log('\n[3] 与解码器自报的斜率对比');
  const refs = [];
  const dec = await Decode.decode(x, sr, { quality: 'fast', yieldEvery: 0, auditLineRefs: refs });
  const cal = dec.calibration || {};
  const decLine = (cal.clockScale == null ? null : cal.clockScale * NOMINAL_LINE);
  console.log('    解码器 clockScale = ' + (cal.clockScale == null ? '-' : cal.clockScale.toFixed(5)) +
    '  ->  隐含行周期 ' + (decLine == null ? '-' : decLine.toFixed(1) + ' 采样') +
    '  (标称 ' + NOMINAL_LINE.toFixed(1) + ')');
  if (decLine != null) {
    console.log('    解码器斜率误差 = ' + (decLine - NOMINAL_LINE).toFixed(1) + ' 采样/行 (' +
      ((decLine / NOMINAL_LINE - 1) * 100).toFixed(3) + '%)');
    console.log('    实测 rate 误差  = ' + drift.toFixed(1) + ' 采样/行 (' +
      (drift / NOMINAL_LINE * 100).toFixed(3) + '%)');
    const gap = Math.abs(decLine - f.rate);
    console.log('    ** 两者相差 ' + gap.toFixed(1) + ' 采样/行 **  ' +
      (gap > 200 ? '-> 解码器的斜率估计与实测显著不符，预测会逐行走偏 ✗'
        : '-> 两者一致，斜率不是问题'));
    console.log('    以实测 rate 为准，解码器预测在 ' +
      Math.round(TOL / Math.abs(decLine - f.rate)) + ' 行后就会偏出一个 inlier 容差');
  }

  fs.writeFileSync(path.join(OUT, 'diagnose-sync-tracking' + (SELF ? '-self' : '') + '.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(), audio: path.relative(ROOT, AUDIO).replace(/\\/g, '/'),
      selfControl: SELF, sampleRate: sr, nominalLineSamples: NOMINAL_LINE,
      detector: { scheme: 'quadrature envelope', decimMs: DECIM / SR * 1000,
        tones: [1200, 1500, 1900, 2300], k: 1.4 },
      pulseCount: pulses.length, intervalStats: ds, pulseWidthMs: pulseMs,
      fit: f, driftPerLineSamples: drift, driftPerLinePercent: drift / NOMINAL_LINE * 100,
      driftOver256Lines: drift * 256, inlierRate: r.inlierRate,
      longestRun: { from: runStart, length: runLen },
      decoderClockScale: cal.clockScale, decoderImpliedLine: decLine,
      firstPulses: pulses.slice(0, 20).map((p) => Math.round(p.startSample))
    }, null, 2));
  console.log('\n证据 -> ' + path.relative(ROOT, path.join(OUT, 'diagnose-sync-tracking' + (SELF ? '-self' : '') + '.json')));
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
