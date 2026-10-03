/*
 * Fix the probe, validate it against known truth, then trust it - in that order.
 *
 * WHAT WAS BROKEN
 *   probeBand() allocated a FFT_PAD of 4096 points and then wrote the window into data[2*i] for
 *   i < len. With len = 0.25 s = 12000 that writes far past the end of a Float32Array, which fails
 *   SILENTLY - so every long-window probe (all the leader/header checks in phases 33 and 34) was
 *   measuring whatever the first 4096 samples happened to contain, shaped by a Hann window built for
 *   12000. The fix decouples the two: the FFT length is derived from the window length and is never
 *   smaller than it, so nothing can be dropped without an explicit error.
 *
 * ORDER OF WORK (from the phase-35 plan, deliberately not reordered)
 *   [1] pure-tone check of the repaired probe
 *   [2] SYNTHETIC S1, where the truth is known: the three slots must read inside 1500..2300 Hz and
 *       reproduce the ramp. Until this passes, no measurement on the real recording means anything.
 *   [3] why syncResidualRms is 20822 samples (about one line period)
 *   [4] which of the two calibrations is right, tested against the measured sync
 *   [5] only then: the three slots inside transmission B
 *
 * Usage: node tests/diagnose-probe-fix.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline, Synth = globalThis.SSTVSynth,
      Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, FFT = globalThis.FFT;
const MODE = Modes.get('S1');
const SCAN = MODE.scanTime, SEP = MODE.sepPulse;
const PIXEL = SCAN / MODE.width * SR;
const NOMINAL_LINE = Modes.lineTime(MODE) * SR;

const nextPow2 = (v) => { let n = 256; while (n < v) n <<= 1; return n; };
const cache = {};

/**
 * REPAIRED probe: Hann window of `len` samples, FFT of at least that many points.
 * The window length and the transform length are independent, and the transform is never shorter
 * than the window - the defect that made every long-window probe in phases 33/34 meaningless.
 */
function probeBand(x, at, len, lo, hi) {
  len = Math.max(8, Math.round(len));
  const n = nextPow2(len);
  let e = cache[n];
  if (!e) { e = { fft: new FFT(n), out: new Float32Array(2 * n) }; cache[n] = e; }
  const data = new Float32Array(2 * n);
  const H = new Float64Array(len);
  for (let i = 0; i < len; i++) H[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
  let used = 0;
  for (let i = 0; i < len; i++) {
    const j = at - (len >> 1) + i;
    if (j >= 0 && j < x.length) { data[2 * i] = x[j] * H[i]; used++; }
  }
  if (!used) return { hz: NaN, prom: 0, n: n, len: len };
  e.fft.realTransform(e.out, data);
  e.fft.completeSpectrum(e.out);
  const m = e.out, bins = n / 2 + 1;
  const kLo = Math.max(1, Math.ceil(lo * n / SR)), kHi = Math.min(bins - 2, Math.floor(hi * n / SR));
  const mag = (k) => Math.sqrt(m[2 * k] * m[2 * k] + m[2 * k + 1] * m[2 * k + 1]);
  let bk = kLo, bv = -1;
  const vals = [];
  for (let k = kLo; k <= kHi; k++) { const v = mag(k); vals.push(v); if (v > bv) { bv = v; bk = k; } }
  const m0 = mag(bk - 1), m1 = bv, m2 = mag(bk + 1);
  const d = m0 - 2 * m1 + m2, sh = d === 0 ? 0 : 0.5 * (m0 - m2) / d;
  vals.sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)] || 1e-9;
  return { hz: (bk + sh) * SR / n, prom: bv / med, n: n, len: len };
}

function stats(a) {
  const f = a.filter((v) => isFinite(v));
  if (!f.length) return null;
  const s = f.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of s) sum += v;
  return { n: s.length, median: med, mad: mad, mean: sum / s.length, min: s[0], max: s[s.length - 1] };
}

const STARTS = { G: -(2 * SEP + 2 * SCAN) + SEP, B: -SCAN, R: (MODE.syncPulse + MODE.syncPorch) };

/** Probe the three slots of one line at `NS` evenly spaced pixels; returns raw Hz medians. */
function slotHzForLine(x, ref, NS, len, lo, hi) {
  const out = {};
  for (const role of ['G', 'B', 'R']) {
    const s0 = ref + STARTS[role] * SR, hs = [];
    for (let k = 0; k < NS; k++) {
      const px = Math.floor((k + 0.5) * MODE.width / NS);
      hs.push(probeBand(x, Math.round(s0 + (px + 0.5) * PIXEL), len, lo, hi).hz);
    }
    const st = stats(hs);
    out[role] = st ? st.median : NaN;
  }
  return out;
}

(async function main() {
  console.log('=== 探针修复与校准 ===\n');

  // ---------------------------------------------------------------- [1] pure tone
  console.log('[任务 1] 修复后的探针：合成纯音测试');
  console.log('  窗长       FFT   输入Hz   读出Hz    误差Hz');
  let toneOk = true;
  for (const [lenMs, f] of [[0.25, 1900], [0.25, 1200], [0.004, 1200], [0.006, 1200], [0.25, 2300]]) {
    const len = Math.round(lenMs / 1000 * SR);
    const x = new Float32Array(SR);
    for (let i = 0; i < SR; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR);
    const pr = probeBand(x, SR >> 1, len, 900, 2600);
    const err = pr.hz - f;
    if (Math.abs(err) > 2) toneOk = false;
    console.log('  ' + (lenMs + ' ms').padEnd(9) + String(pr.n).padStart(6) + ' ' +
      String(f).padStart(8) + ' ' + pr.hz.toFixed(2).padStart(9) + ' ' + err.toFixed(3).padStart(9));
  }
  console.log('  => ' + (toneOk ? '全部误差 < 2 Hz，越界 bug 已修 ✓' : '仍有误差 ✗'));

  // ---------------------------------------------------------------- [2] synthetic S1
  console.log('\n[任务 2] 合成 S1 校准（真值：灰度斜坡，频率 1500→2300 Hz）');
  const w = MODE.width, h = MODE.height, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, v = Math.round(255 * x / (w - 1));
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const tl = Timeline.build({ data: data, width: w, height: h }, MODE);
  const syn = Synth.synthesize(tl, SR).samples;
  const synRefs = [];
  await Decode.decode(syn, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: synRefs });
  console.log('  合成音频 ' + (syn.length / SR).toFixed(3) + ' s · 解码器逐行参考 ' + synRefs.length + ' 行');
  console.log('  探针窗长 ' + (PIXEL * 2.48).toFixed(1) + ' 采样（= 像素 × 2.48，与生产 windowFactor 一致）');

  const L = 128;
  console.log('\n  第 ' + L + ' 行：逐槽读出 vs 真值');
  console.log('   px   真值Hz   G读出   B读出   R读出');
  const rampErr = { G: [], B: [], R: [] };
  for (let px = 0; px < 8; px++) {
    const truth = 1500 + 800 * px / (w - 1);
    const vals = {};
    for (const role of ['G', 'B', 'R']) {
      const s0 = synRefs[L].ref + STARTS[role] * SR;
      vals[role] = probeBand(syn, Math.round(s0 + (px + 0.5) * PIXEL), Math.round(PIXEL * 2.48), 900, 2600).hz;
    }
    console.log('  ' + String(px).padStart(3) + ' ' + truth.toFixed(1).padStart(8) + ' ' +
      vals.G.toFixed(1).padStart(8) + ' ' + vals.B.toFixed(1).padStart(8) + ' ' + vals.R.toFixed(1).padStart(8));
  }
  let maxErr = 0, inBand = 0, tot = 0;
  for (let px = 0; px < w; px++) {
    const truth = 1500 + 800 * px / (w - 1);
    for (const role of ['G', 'B', 'R']) {
      const s0 = synRefs[L].ref + STARTS[role] * SR;
      const got = probeBand(syn, Math.round(s0 + (px + 0.5) * PIXEL), Math.round(PIXEL * 2.48), 900, 2600).hz;
      const e = Math.abs(got - truth);
      if (e > maxErr) maxErr = e;
      rampErr[role].push(e);
      tot++; if (got >= 1500 && got <= 2300) inBand++;
    }
  }
  console.log('\n  全行 ' + w + ' 像素 × 3 槽:');
  for (const role of ['G', 'B', 'R']) {
    const st = stats(rampErr[role]);
    console.log('    ' + role + ' 槽 平均误差 ' + st.mean.toFixed(1) + ' Hz · 中位 ' + st.median.toFixed(1) +
      ' · 最大 ' + st.max.toFixed(1));
  }
  console.log('    最大误差 ' + maxErr.toFixed(1) + ' Hz · 落在 1500–2300 内 ' + inBand + '/' + tot +
    ' (' + (100 * inBand / tot).toFixed(1) + '%)');
  const synOk = inBand / tot > 0.95 && maxErr < 60;
  console.log('  => ' + (synOk ? '合成 S1 上探针可读出真值 ✓ 可以用于 phigros'
    : '合成 S1 上探针仍偏离 ✗ 还不能用于 phigros'));

  // ---------------------------------------------------------------- [4] two calibrations
  const pb = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const pinfo = Wav.parse(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
  const px_ = pinfo.samples;
  const phRefs = [];
  const pdec = await Decode.decode(px_, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: phRefs });
  const cal = pdec.calibration || {};
  console.log('\n[任务 4] 两套标定的对比');
  const calSync = (f) => (f - cal.offsetHz) / cal.scale;
  const calHdr = (f) => (f - cal.headerOffsetHz) / cal.headerScale;
  console.log('  同步拟合: scale=' + cal.scale + ' offsetHz=' + cal.offsetHz +
    '  → 1200 标称 对应原始 ' + (cal.scale * 1200 + cal.offsetHz).toFixed(2) + ' Hz');
  console.log('  HEADER  : scale=' + cal.headerScale + ' offsetHz=' + cal.headerOffsetHz +
    '  → 1200 标称 对应原始 ' + (cal.headerScale * 1200 + cal.headerOffsetHz).toFixed(2) + ' Hz');
  console.log('  leaderFreqHz=' + (cal.leaderFreqHz == null ? '-' : Number(cal.leaderFreqHz).toFixed(2)) +
    ' · observations=' + cal.observations + ' · syncResidualRms=' +
    (cal.syncResidualRms == null ? '-' : Number(cal.syncResidualRms).toFixed(1)));

  // measure the sync with the repaired probe, several window lengths
  console.log('\n  [任务 4/AC3] 用修复后的探针测同步音（限带 900–1600 Hz）');
  console.log('    窗长     原始中位Hz  MAD    经同步标定后  经 HEADER 标定后');
  for (const lenMs of [0.004, 0.006]) {
    const len = Math.round(lenMs / 1000 * SR);
    const hz = [], prom = [];
    for (let i = 0; i < phRefs.length; i++) {
      const pr = probeBand(px_, Math.round(phRefs[i].ref + 0.004 * SR), len, 900, 1600);
      hz.push(pr.hz); prom.push(pr.prom);
    }
    const st = stats(hz), sp = stats(prom);
    const a = stats(hz.map(calSync)), b2 = stats(hz.map(calHdr));
    console.log('    ' + (lenMs * 1000 + ' ms').padEnd(9) + st.median.toFixed(1).padStart(10) +
      ' ' + st.mad.toFixed(1).padStart(7) + '  ' + a.median.toFixed(1).padStart(13) + '  ' +
      b2.median.toFixed(1).padStart(15) + '   (prom 中位 ' + sp.median.toFixed(2) + ')');
  }
  // residual of the decoder's own per-line refs against a straight line
  let n = phRefs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += phRefs[i].ref; sxx += i * i; sxy += i * phRefs[i].ref; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), inter = (sy - slope * sx) / n;
  let ss = 0, mx = 0;
  for (let i = 0; i < n; i++) { const r = phRefs[i].ref - (slope * i + inter); ss += r * r; if (Math.abs(r) > Math.abs(mx)) mx = r; }
  console.log('\n  [任务 3/AC3] 解码器逐行参考自身的直线拟合');
  console.log('    斜率 ' + slope.toFixed(2) + ' 采样/行（标称 ' + NOMINAL_LINE.toFixed(2) + '）· 残差 RMS ' +
    Math.sqrt(ss / n).toFixed(1) + ' 采样 · 最大 ' + mx.toFixed(0));
  console.log('    解码器自报 syncResidualRms = ' +
    (cal.syncResidualRms == null ? '-' : Number(cal.syncResidualRms).toFixed(1)) + ' 采样');
  console.log('    => ' + (Math.sqrt(ss / n) < 200
    ? '逐行参考本身【高度贴合直线】→ 自报的那个大残差来自另一个（前导/标定阶段的）拟合 ✗'
    : '逐行参考本身就不贴合直线 ✗'));

  // ---------------------------------------------------------------- [5] phigros slots
  console.log('\n[任务 5/AC5] phigros 传输 B 内部三槽（修复后的探针，原始频率）');
  const NS = 32;
  const rows = [];
  for (let i = 0; i < phRefs.length; i++) rows.push(slotHzForLine(px_, phRefs[i].ref, NS, Math.round(PIXEL * 2.48), 900, 2600));
  console.log('  槽   原始中位Hz  MAD    极值            同步标定后中位  在 1500–2300(原始)?');
  const slotRaw = { G: rows.map((r) => r.G), B: rows.map((r) => r.B), R: rows.map((r) => r.R) };
  for (const role of ['G', 'B', 'R']) {
    const st = stats(slotRaw[role]);
    const inb = slotRaw[role].filter((f) => f >= 1500 && f <= 2300).length;
    const c = stats(slotRaw[role].map(calSync));
    console.log('  ' + role + '  ' + st.median.toFixed(1).padStart(10) + ' ' + st.mad.toFixed(1).padStart(7) +
      '   ' + (st.min.toFixed(0) + '..' + st.max.toFixed(0)).padEnd(14) + ' ' + c.median.toFixed(1).padStart(13) +
      '   ' + inb + '/' + slotRaw[role].length);
  }
  const allRaw = [].concat(slotRaw.G, slotRaw.B, slotRaw.R);
  const rawSt = stats(allRaw);
  const allInBand = rawSt.median >= 1500 && rawSt.median <= 2300;
  const allNearSync = Math.abs(rawSt.median - 1200) < 250;
  console.log('\n  三槽合计: 原始中位 ' + rawSt.median.toFixed(1) + ' Hz · MAD ' + rawSt.mad.toFixed(1));
  console.log('  G-B 差 ' + (stats(slotRaw.G).median - stats(slotRaw.B).median).toFixed(1) +
    ' · G-R 差 ' + (stats(slotRaw.G).median - stats(slotRaw.R).median).toFixed(1) +
    ' · B-R 差 ' + (stats(slotRaw.B).median - stats(slotRaw.R).median).toFixed(1));

  // ---------------------------------------------------------------- verdicts
  console.log('\n===== 判定 =====');
  console.log('  AC1 探针修复: ' + (toneOk ? '通过 ✓' : '未通过 ✗'));
  console.log('  AC2 合成 S1 校准: ' + (synOk ? '通过 ✓（落在带内 ' + (100 * inBand / tot).toFixed(1) +
    '%，最大误差 ' + maxErr.toFixed(0) + ' Hz）' : '未通过 ✗'));
  console.log('  AC6 槽位置: ' + (allInBand ? '三槽在图象带 1500–2300 内 ✓ → "没色"另有原因'
    : (allNearSync ? '三槽在【同步音 1200 Hz 附近】✗ → 槽位置错，与阶段二十三探针结论冲突'
      : '三槽在图象带之外但也不在 1200 附近（中位 ' + rawSt.median.toFixed(0) + ' Hz）✗')));
  console.log('  G/B/R 是否互不相同: 三个中位差 ' +
    Math.abs(stats(slotRaw.G).median - stats(slotRaw.B).median).toFixed(1) + ' / ' +
    Math.abs(stats(slotRaw.G).median - stats(slotRaw.R).median).toFixed(1) + ' Hz → ' +
    (Math.abs(stats(slotRaw.G).median - stats(slotRaw.R).median) > 50 ? '有区分 ✓' : '几乎相同 ✗'));

  fs.writeFileSync(path.join(OUT, 'probe-fix.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    pureTone: { ok: toneOk },
    syntheticS1: { decodeRows: synRefs.length, maxRampErrHz: maxErr, inBandFraction: inBand / tot,
      perSlotMeanErrHz: { G: stats(rampErr.G).mean, B: stats(rampErr.B).mean, R: stats(rampErr.R).mean },
      pass: synOk },
    calibration: { sync: { scale: cal.scale, offsetHz: cal.offsetHz },
      header: { scale: cal.headerScale, offsetHz: cal.headerOffsetHz },
      leaderFreqHz: cal.leaderFreqHz, observations: cal.observations, syncResidualRms: cal.syncResidualRms },
    refsLineFit: { slopeSamples: slope, nominal: NOMINAL_LINE, residualRms: Math.sqrt(ss / n), residualMax: mx },
    phigrosSlotsRaw: { G: stats(slotRaw.G), B: stats(slotRaw.B), R: stats(slotRaw.R), all: rawSt },
    phigrosSlotsPerLine: rows
  }, null, 2));
  console.log('\n证据 -> tests/diag-quality/probe-fix.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
