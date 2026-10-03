/*
 * How many transmissions does the recording hold, and did the decoder pick the right one?
 *
 * FROM PHASE 32
 *   The recording has signal from about 2 s onward, yet the decoder puts image row 0 at 49.203 s -
 *   a 47 second difference, about 110 lines. Its line timing is otherwise perfect (428.195 ms mean
 *   interval against a 428.22 nominal), which is exactly why the question matters: the timing is not
 *   broken, the CHOICE of where the image starts might be.
 *
 * WHAT SETTLES IT
 *   A real Scottie S1 transmission is preceded by a header: two 300 ms 1900 Hz leader tones with a
 *   1200 Hz break between them, then 610 ms of VIS. So a segment is only a transmission if
 *   (a) its sync pulses sit on a regular 428.22 ms grid, and (b) there is a header just before it.
 *   If the first 47 seconds are music or other programme material they will fail both tests, the
 *   decoder's choice is CORRECT, and the earlier "choosing bug" reading is refuted.
 *
 * WHY "GRID INLIERS" AND NOT THE RAW COUNT
 *   Phase 25 measured that a raw pulse census over-counts badly (557 raw against 340 on the grid),
 *   because music looks like sync pulses. Only the grid inlier count is a trustworthy transmission
 *   length, so both numbers are reported but the verdict uses the inliers.
 *
 * Usage: node tests/diagnose-segments.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000, DECIM = Math.round(0.00025 * SR);

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, FFT = globalThis.FFT;
const MODE = Modes.get('S1');
const NOMINAL_LINE = Modes.lineTime(MODE) * SR;
const LINE_MS = NOMINAL_LINE / SR * 1000;
const SYNC_MS = MODE.syncPulse * 1000;

/** Phase-26 detector: quadrature envelope + local-dominance, 0.25 ms resolution. */
function detectSyncs(x, sr) {
  const freqs = [1200, 1500, 1900, 2300];
  const env = freqs.map((f) => {
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w);
    const a = Math.exp(-1 / (sr * 0.002));
    const n = Math.floor(x.length / DECIM), out = new Float32Array(n);
    let ci = 1, si = 0, I = 0, Q = 0, o = 0;
    for (let i = 0; i < x.length; i++) {
      const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
      I = a * I + (1 - a) * (x[i] * ci); Q = a * Q + (1 - a) * (x[i] * si);
      if (i % DECIM === 0 && o < n) out[o++] = Math.sqrt(I * I + Q * Q);
    }
    return out;
  });
  const n = env[0].length, msPerBin = DECIM / sr * 1000;
  const MINRUN = Math.round(4 / msPerBin), MAXRUN = Math.round(18 / msPerBin);
  const pulses = [];
  let run = -1;
  for (let k = 0; k < n; k++) {
    const on = env[0][k] > 1.4 * Math.max(env[1][k], env[2][k], env[3][k], 1e-4);
    if (on && run < 0) run = k;
    else if (!on && run >= 0) {
      if (k - run >= MINRUN && k - run <= MAXRUN) {
        let best = -1, bk = run;
        for (let q = run; q < k; q++) if (env[0][q] > best) { best = env[0][q]; bk = q; }
        const y1 = env[0][Math.max(0, bk - 1)], y2 = env[0][bk], y3 = env[0][Math.min(n - 1, bk + 1)];
        const den = y1 - 2 * y2 + y3, sh = den === 0 ? 0 : 0.5 * (y1 - y3) / den;
        pulses.push({ start: (bk + 0.5 + sh) * msPerBin / 1000 - SYNC_MS / 2000,
          ms: (k - run) * msPerBin });
      }
      run = -1;
    }
  }
  return { pulses: pulses, env: env, msPerBin: msPerBin };
}

function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of s) sum += v;
  return { n: s.length, median: med, mad: mad, mean: sum / s.length };
}

/** Per-segment grid fit at LINE_MS with a +/-2 ms tolerance; inliers are the real transmission. */
function gridFit(pulsesSec, tolMs) {
  const best = { inliers: [], count: 0 };
  const cand = Math.min(40, pulsesSec.length);
  for (let i = 0; i < cand; i++) {
    const t0 = pulsesSec[i];
    const inl = [];
    for (const p of pulsesSec) {
      const k = Math.round((p - t0) * 1000 / LINE_MS);
      if (Math.abs((p - t0) * 1000 - k * LINE_MS) <= tolMs) inl.push(p);
    }
    if (inl.length > best.count) { best.count = inl.length; best.inliers = inl; }
  }
  best.inliers.sort((a, b) => a - b);
  return best;
}

/** Hann-FFT peak frequency in a window (for the leader tone). */
function peakFreq(x, at, len, fftSize) {
  const n = fftSize || 2048;
  const fft = new FFT(n), out = new Float32Array(2 * n), data = new Float32Array(2 * n);
  const H = new Float64Array(len);
  for (let i = 0; i < len; i++) H[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
  for (let i = 0; i < len; i++) { const j = at + i; if (j >= 0 && j < x.length) data[2 * i] = x[j] * H[i]; }
  fft.realTransform(out, data); fft.completeSpectrum(out);
  const bins = n / 2 + 1;
  let bk = 1, bv = -1;
  for (let k = 1; k < bins - 1; k++) {
    const m = Math.sqrt(out[2 * k] * out[2 * k] + out[2 * k + 1] * out[2 * k + 1]);
    if (m > bv) { bv = m; bk = k; }
  }
  const m0 = Math.sqrt(out[2 * (bk - 1)] ** 2 + out[2 * (bk - 1) + 1] ** 2);
  const m1 = Math.sqrt(out[2 * bk] ** 2 + out[2 * bk + 1] ** 2);
  const m2 = Math.sqrt(out[2 * (bk + 1)] ** 2 + out[2 * (bk + 1) + 1] ** 2);
  const d = m0 - 2 * m1 + m2, sh = d === 0 ? 0 : 0.5 * (m0 - m2) / d;
  return (bk + sh) * SR / n;
}

function rms(x, a, b) {
  let acc = 0, n = 0;
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) { acc += x[i] * x[i]; n++; }
  return n ? Math.sqrt(acc / n) : 0;
}

(async function main() {
  const b = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const info = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const x = info.samples;
  console.log('=== 传输段核对 ===\n');
  console.log('音频 ' + info.duration.toFixed(3) + ' s · 标称行 ' + LINE_MS.toFixed(2) + ' ms');

  // ---------------------------------------------------------------- 1. detect + segment
  const det = detectSyncs(x, SR);
  console.log('\n[1] 独立检测器: 原始脉冲 ' + det.pulses.length + ' 个');
  const pulses = det.pulses.map((p) => p.start).sort((a, b2) => a - b2);
  const segs = [];
  let cur = [pulses[0]];
  for (let i = 1; i < pulses.length; i++) {
    if ((pulses[i] - pulses[i - 1]) * 1000 > 2 * LINE_MS) { segs.push(cur); cur = []; }
    cur.push(pulses[i]);
  }
  if (cur.length) segs.push(cur);

  console.log('\n[2] 逐段栅格拟合（' + LINE_MS.toFixed(2) + ' ms 栅格, ±2 ms 容差）');
  console.log('  段  起始(s)    结束(s)   跨度(s)  原始  栅格内  平均间隔(ms)  MAD(ms)  完整性  RMS');
  const rows = [];
  const maxRms = (() => {
    let m = 0;
    for (let s = 0; s < info.duration; s += 1) m = Math.max(m, rms(x, s * SR, (s + 1) * SR));
    return m;
  })();
  for (let i = 0; i < segs.length; i++) {
    const g = gridFit(segs[i], 2.0);
    const inl = g.inliers;
    const dif = [];
    for (let k = 1; k < inl.length; k++) dif.push((inl[k] - inl[k - 1]) * 1000);
    const st = stats(dif);
    const t0 = segs[i][0], t1 = segs[i][segs[i].length - 1];
    const comp = inl.length >= 240 ? '完整 ✓' : (inl.length >= 180 ? '部分' : '碎片');
    const r = rms(x, Math.round(t0 * SR), Math.round(t1 * SR));
    rows.push({ seg: i + 1, t0: t0, t1: t1, raw: segs[i].length, inliers: inl.length,
      meanInt: st ? st.mean : null, mad: st ? st.mad : null, comp: comp, rms: r,
      rmsRel: r / maxRms, inlierTimes: inl });
    console.log('  ' + String(i + 1).padStart(2) + '  ' + t0.toFixed(3).padStart(9) + ' ' +
      t1.toFixed(3).padStart(9) + ' ' + (t1 - t0).toFixed(3).padStart(8) + ' ' +
      String(segs[i].length).padStart(5) + ' ' + String(inl.length).padStart(6) + ' ' +
      (st ? st.mean.toFixed(3) : '-').padStart(12) + ' ' + (st ? st.mad.toFixed(3) : '-').padStart(8) +
      '  ' + comp.padEnd(7) + ' ' + (r / maxRms).toFixed(2));
  }

  // ---------------------------------------------------------------- 3. header check per segment
  console.log('\n[3] 各段前导音核对（真传输在首个同步前应有 1900 Hz 前导 + 1200 Hz break + VIS）');
  console.log('  段  前导窗(s)          1900Hz 命中  测得上导频率(Hz)  1200Hz break 命中  hasHeader');
  for (const r of rows) {
    const a = Math.max(0, Math.round((r.t0 - 1.6) * SR)), b2 = Math.round((r.t0 - 0.6) * SR);
    // 1900 Hz dominance in the window
    const f1 = peakFreq(x, Math.round((r.t0 - 1.5) * SR), Math.round(0.25 * SR), 4096);
    const f2 = peakFreq(x, Math.round((r.t0 - 0.9) * SR), Math.round(0.25 * SR), 4096);
    const is19 = (f) => Math.abs(f - 1900) < 60;
    const is12 = (f) => Math.abs(f - 1200) < 60;
    const fBreak = peakFreq(x, Math.round((r.t0 - 1.2) * SR), Math.round(0.05 * SR), 4096);
    r.leader1 = f1; r.leader2 = f2; r.breakF = fBreak;
    r.hasHeader = (is19(f1) && is19(f2)) || (is19(f1) && is12(fBreak)) || (is19(f2) && is12(fBreak));
    console.log('  ' + String(r.seg).padStart(2) + '  ' + (r.t0 - 1.6).toFixed(2) + '..' +
      (r.t0 - 0.6).toFixed(2).padStart(6) + '   ' +
      (is19(f1) ? '✓' : '✗') + '/' + (is19(f2) ? '✓' : '✗') + '      ' +
      f1.toFixed(1) + ' / ' + f2.toFixed(1) + '      ' +
      (is12(fBreak) ? '✓ (' + fBreak.toFixed(0) + ')' : '✗ (' + fBreak.toFixed(0) + ')') +
      '            ' + (r.hasHeader ? '是 ✓' : '否 ✗'));
  }

  // ---------------------------------------------------------------- decoder comparison
  const refs = [];
  const dec = await Decode.decode(x, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  const cal = dec.calibration || {};
  const imageStart = cal.imageStart == null ? null : cal.imageStart / SR;
  const row0 = refs.length ? refs[0].ref / SR : null;
  const rowN = refs.length ? refs[refs.length - 1].ref / SR : null;
  console.log('\n[4] 解码器');
  console.log('  imageStart = ' + (imageStart == null ? '-' : imageStart.toFixed(3) + ' s'));
  console.log('  行 0 参考  = ' + (row0 == null ? '-' : row0.toFixed(3) + ' s') +
    ' · 行 ' + (refs.length - 1) + ' 参考 = ' + (rowN == null ? '-' : rowN.toFixed(3) + ' s'));
  console.log('  clockScale = ' + (cal.clockScale == null ? '-' : cal.clockScale.toFixed(6)) +
    ' · 行周期 = ' + (cal.clockScale * NOMINAL_LINE).toFixed(1) + ' 采样');
  let host = null;
  for (const r of rows) if (row0 != null && row0 >= r.t0 - 0.5 && row0 <= r.t1 + 0.5) host = r;
  console.log('  行 0 落在: ' + (host ? '段 ' + host.seg + '（' + host.t0.toFixed(2) + '–' +
    host.t1.toFixed(2) + ' s, 栅格内 ' + host.inliers + ', ' + host.comp + ', hasHeader ' +
    (host.hasHeader ? '是' : '否') + '）' : '未落在任何检出段内'));

  // ---------------------------------------------------------------- what is in the first 47 s
  console.log('\n[5] 录音前段（0 – ' + (row0 == null ? '?' : row0.toFixed(1)) + ' s）到底是什么');
  const early = rows.filter((r) => row0 != null && r.t1 < row0 - 1);
  if (!early.length) console.log('  前段没有任何检出的规则同步脉冲 → 不是 SSTV 传输');
  for (const r of early) {
    console.log('  段 ' + r.seg + ': ' + r.t0.toFixed(2) + '–' + r.t1.toFixed(2) + ' s · 原始 ' +
      r.raw + ' · 栅格内 ' + r.inliers + ' · ' + r.comp + ' · hasHeader ' +
      (r.hasHeader ? '是' : '否') + ' · RMS ' + r.rmsRel.toFixed(2));
  }
  const complete = rows.filter((r) => r.inliers >= 240);
  const withHeader = rows.filter((r) => r.hasHeader);

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 判定 =====');
  console.log('  检出的段数 ' + rows.length + ' · 其中"完整"（栅格内 ≥240）' + complete.length +
    ' 个 · 有前导音 ' + withHeader.length + ' 个');
  console.log('  解码器选中的段: ' + (host ? '段 ' + host.seg : '无') +
    (host ? '（' + host.comp + ', hasHeader ' + (host.hasHeader ? '是' : '否') + ', RMS ' +
      host.rmsRel.toFixed(2) + '）' : ''));
  const bestSeg = rows.slice().sort((a, b2) => (b2.inliers * (b2.hasHeader ? 1.5 : 0.3)) -
    (a.inliers * (a.hasHeader ? 1.5 : 0.3)))[0];
  console.log('  综合最优段（栅格内点数 × 前导音加权）: 段 ' + bestSeg.seg + ' @ ' +
    bestSeg.t0.toFixed(2) + ' s（栅格内 ' + bestSeg.inliers + ', hasHeader ' +
    (bestSeg.hasHeader ? '是' : '否') + '）');
  let verdict;
  if (!host) {
    verdict = '【情况 (b)】解码器的行 0 不落在任何检出段内 —— 锁定有问题 ✗';
  } else if (host.hasHeader && host.inliers >= 240 && early.every((r) => !r.hasHeader || r.inliers < 240)) {
    verdict = '【情况 (a)】选中段完整且有前导音，而更早的段都不具备传输特征 → ' +
      '解码器选段正确，不是 bug ✓ 应转去查 B/R 槽无音调的真因';
  } else if (early.some((r) => r.hasHeader && r.inliers >= 240)) {
    verdict = '【情况 (a)→可疑】更早存在同样完整且有前导音的段 → 选段策略值得商榷 ✗';
  } else if (host.inliers < 240) {
    verdict = '【情况 (b)】选中段不完整 → 锁定有问题 ✗';
  } else {
    verdict = '【情况 (a)】选中段成立，但需要人工确认前段性质 ✓';
  }
  console.log('  判定: ' + verdict);

  fs.writeFileSync(path.join(OUT, 'segments.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), durationS: info.duration,
    nominalLineMs: LINE_MS, rawPulses: det.pulses.length,
    segments: rows.map((r) => ({ seg: r.seg, startS: r.t0, endS: r.t1, raw: r.raw,
      gridInliers: r.inliers, meanIntervalMs: r.meanInt, madMs: r.mad, completeness: r.comp,
      rmsRel: r.rmsRel, leader1Hz: r.leader1, leader2Hz: r.leader2, breakHz: r.breakF,
      hasHeader: r.hasHeader })),
    noGridPulses: pulses.filter((p) => !rows.some((r) => r.inlierTimes.indexOf(p) >= 0)).length,
    decoder: { imageStartS: imageStart, row0S: row0, rowLastS: rowN, clockScale: cal.clockScale },
    hostSegment: host ? host.seg : null, bestSegment: bestSeg.seg, verdict: verdict
  }, null, 2));
  console.log('\n证据 -> tests/diag-quality/segments.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
