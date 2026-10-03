/*
 * Apply the decoder's own calibration to the diagnostics, then redo every frequency measurement.
 *
 * WHAT PHASE 34 CLAIMED, AND WHAT WAS WRONG WITH IT
 *   Phase 34 reported that the recording's frequency axis is shifted by 12.9% (the 1200 Hz sync
 *   "reading" ~1045 Hz) and retracted three rounds of chroma results on that basis. But that number
 *   was inferred from probes placed INSIDE THE IMAGE SLOTS - the sync pulse itself was never probed.
 *   Worse, the decoder's own scale (a = 1/clockScale) is 1/1.001226 = 0.9988, i.e. essentially 1, so
 *   the calibration has no 12.9% scaling in it at all: it is dominated by an OFFSET. A 12.9% scale
 *   error cannot be absorbed by something that is 1.000.
 *
 *   So this measures the thing that was never measured:
 *     - the sync pulse frequency, directly, per line
 *     - the leader tone, directly
 *     - then the same two through calF(f) = (f - offsetHz) / scale, which is the raw->nominal map
 *       the decoder actually uses
 *   If calF leaves the sync at 1200 Hz then the decoder is consistent and the phase-34 "shift" story
 *   is wrong; if it does not, the shortfall is quantified instead of guessed.
 *
 * THEN: with the calibration applied, redo the three-slot frequency distribution, the
 * prominence-vs-frequency joint distribution, and the structure-aware chroma comparison.
 *
 * Usage: node tests/diagnose-calibrated.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000, FFT_PAD = 4096;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, FFT = globalThis.FFT;
const MODE = Modes.get('S1');
const SCAN = MODE.scanTime, SEP = MODE.sepPulse;
const PIXEL = SCAN / MODE.width * SR;

let pngjs = null;
try { pngjs = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); } catch (e) {}

/** Hann-windowed FFT peak inside a band, with prominence relative to the in-band median bin. */
function probeBand(x, at, len, lo, hi) {
  const n = FFT_PAD;
  const fft = new FFT(n), out = new Float32Array(2 * n), data = new Float32Array(2 * n);
  const H = new Float64Array(len);
  for (let i = 0; i < len; i++) H[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
  for (let i = 0; i < len; i++) { const j = at - (len >> 1) + i; if (j >= 0 && j < x.length) data[2 * i] = x[j] * H[i]; }
  fft.realTransform(out, data); fft.completeSpectrum(out);
  const bins = n / 2 + 1;
  const kLo = Math.max(1, Math.ceil(lo * n / SR)), kHi = Math.min(bins - 2, Math.floor(hi * n / SR));
  const mag = (k) => Math.sqrt(out[2 * k] * out[2 * k] + out[2 * k + 1] * out[2 * k + 1]);
  let bk = kLo, bv = -1;
  const vals = [];
  for (let k = kLo; k <= kHi; k++) { const v = mag(k); vals.push(v); if (v > bv) { bv = v; bk = k; } }
  const m0 = mag(bk - 1), m1 = bv, m2 = mag(bk + 1);
  const d = m0 - 2 * m1 + m2, sh = d === 0 ? 0 : 0.5 * (m0 - m2) / d;
  vals.sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)] || 1e-9;
  return { hz: (bk + sh) * SR / n, prom: bv / med };
}

function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of s) sum += v;
  return { n: s.length, median: med, mad: mad, mean: sum / s.length, min: s[0], max: s[s.length - 1] };
}

function chromaRowCorr(A, B) {
  const H = A.length, W = A[0].length;
  const ch = [];
  for (let y = 0; y < H; y++) {
    const row = new Float64Array(W);
    for (let x = 0; x < W; x++) row[x] = A[y][x] - B[y][x];
    ch.push(row);
  }
  let s = 0, n = 0;
  for (let y = 0; y + 1 < H; y++) {
    let ma = 0, mb = 0;
    for (let x = 0; x < W; x++) { ma += ch[y][x]; mb += ch[y + 1][x]; }
    ma /= W; mb /= W;
    let nu = 0, da = 0, db = 0;
    for (let x = 0; x < W; x++) {
      const u = ch[y][x] - ma, v = ch[y + 1][x] - mb;
      nu += u * v; da += u * u; db += v * v;
    }
    if (da > 0 && db > 0) { s += nu / Math.sqrt(da * db); n++; }
  }
  return n ? s / n : 0;
}

function imgPlanes(img) {
  const P = { R: [], G: [], B: [] };
  for (let y = 0; y < img.height; y++) {
    for (const c of ['R', 'G', 'B']) {
      const off = c === 'R' ? 0 : (c === 'G' ? 1 : 2);
      const row = [];
      for (let x = 0; x < img.width; x++) row.push(img.data[(y * img.width + x) * 4 + off]);
      P[c].push(row);
    }
  }
  return P;
}

(async function main() {
  const b = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const info = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const x = info.samples;
  console.log('=== 接上标定后的频率测量 ===\n');
  console.log('音频 ' + info.duration.toFixed(3) + ' s @ ' + info.sampleRate + ' Hz');

  const refs = [];
  const dec = await Decode.decode(x, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  const cal = dec.calibration || {};
  const scale = cal.scale, offsetHz = cal.offsetHz;
  const calF = (f) => (f - offsetHz) / scale;
  console.log('\n[任务 1] 解码器标定值');
  console.log('  scale    = ' + scale);
  console.log('  offsetHz = ' + offsetHz);
  console.log('  映射 calF(f) = (f − offsetHz) / scale     ← 原始 → 标称');
  console.log('  即 1200 Hz 标称对应原始 ' + (scale * 1200 + offsetHz).toFixed(2) + ' Hz');
  console.log('     1500 Hz 标称对应原始 ' + (scale * 1500 + offsetHz).toFixed(2) + ' Hz');
  console.log('     2300 Hz 标称对应原始 ' + (scale * 2300 + offsetHz).toFixed(2) + ' Hz');
  console.log('  行 0=' + (refs[0].ref / SR).toFixed(3) + ' s · 行 ' + (refs.length - 1) + '=' +
    (refs[refs.length - 1].ref / SR).toFixed(3) + ' s');
  console.log('  headerScale=' + cal.headerScale + ' · headerOffsetHz=' + cal.headerOffsetHz +
    ' · leaderFreqHz=' + (cal.leaderFreqHz == null ? '-' : Number(cal.leaderFreqHz).toFixed(2)));
  console.log('  observations=' + cal.observations + ' · syncResidualRms=' +
    (cal.syncResidualRms == null ? '-' : Number(cal.syncResidualRms).toFixed(1)));

  // ---------------------------------------------------------------- sync pulse, measured directly
  console.log('\n[任务 1/AC2] 直接测同步音（9 ms 脉冲，探针锚在 ref + 4 ms）');
  const syncRaw = [], syncProm = [];
  for (let i = 0; i < refs.length; i++) {
    const pr = probeBand(x, Math.round(refs[i].ref + 0.004 * SR), Math.round(0.004 * SR), 900, 1600);
    syncRaw.push(pr.hz); syncProm.push(pr.prom);
  }
  const sr_ = stats(syncRaw), sp_ = stats(syncProm);
  console.log('  原始同步音频率: 中位 ' + sr_.median.toFixed(1) + ' Hz (MAD ' + sr_.mad.toFixed(2) +
    ', 极值 ' + sr_.min.toFixed(0) + '..' + sr_.max.toFixed(0) + ')');
  console.log('  同步音 prominence: 中位 ' + sp_.median.toFixed(2) + ' (MAD ' + sp_.mad.toFixed(2) + ')');
  const syncCal = syncRaw.map(calF);
  const sc_ = stats(syncCal);
  console.log('  标定后同步音频率: 中位 ' + sc_.median.toFixed(2) + ' Hz (MAD ' + sc_.mad.toFixed(2) +
    ', 极值 ' + sc_.min.toFixed(1) + '..' + sc_.max.toFixed(1) + ')');
  console.log('  ** 标称 1200 Hz，标定后偏差 ' + (sc_.median - 1200).toFixed(2) + ' Hz (' +
    ((sc_.median / 1200 - 1) * 100).toFixed(3) + '%) **');
  console.log('  => ' + (Math.abs(sc_.median - 1200) < 15
    ? '标定把同步音映射回 1200 Hz ✓ 解码器的标定是自洽的'
    : '标定后仍偏离 1200 Hz ✗ 差异如上'));

  // leader, direct
  const leadAt = Math.round(refs[0].ref - 1.6 * SR);
  const lead = probeBand(x, leadAt, Math.round(0.25 * SR), 900, 2600);
  console.log('\n  前导音（行 0 前 1.6 s，0.25 s 窗）: 原始 ' + lead.hz.toFixed(2) + ' Hz' +
    ' (prom ' + lead.prom.toFixed(1) + ') → 标定后 ' + calF(lead.hz).toFixed(2) + ' Hz (标称 1900)');

  // ---------------------------------------------------------------- three slots, calibrated
  console.log('\n[任务 2/AC3] 三槽频率分布（探针限带 900–2600 Hz，标定后转标称）');
  const STARTS = { G: -(2 * SEP + 2 * SCAN) + SEP, B: -SCAN, R: (MODE.syncPulse + MODE.syncPorch) };
  const NS = 32;
  const planes = { R: [], G: [], B: [] };            // calibrated grey planes
  const slotHz = { R: [], G: [], B: [] };
  const slotProm = { R: [], G: [], B: [] };
  for (let i = 0; i < refs.length; i++) {
    for (const role of ['R', 'G', 'B']) {
      const s0 = refs[i].ref + STARTS[role] * SR;
      const row = [];
      let ps = 0, hs = [];
      for (let k = 0; k < NS; k++) {
        const px = Math.floor((k + 0.5) * MODE.width / NS);
        const pr = probeBand(x, Math.round(s0 + (px + 0.5) * PIXEL), Math.round(PIXEL * 2.48), 900, 2600);
        const fc = calF(pr.hz);
        ps += pr.prom; hs.push(fc);
        row.push(px);
      }
      hs.sort((a, b2) => a - b2);
      slotHz[role].push(hs[Math.floor(hs.length / 2)]);
      slotProm[role].push(ps / NS);
      // full-resolution grey row for the chroma metric
      const full = [];
      for (let px = 0; px < MODE.width; px++) {
        const pr = probeBand(x, Math.round(s0 + (px + 0.5) * PIXEL), Math.round(PIXEL * 2.48), 900, 2600);
        const f = calF(pr.hz);
        full.push(Math.max(0, Math.min(255, Math.round(255 * (f - 1500) / 800))));
      }
      planes[role].push(full);
    }
  }
  console.log('  槽   标定后中位频率(Hz)  MAD   极值            落在 1500–2300 内的行数');
  for (const role of ['G', 'B', 'R']) {
    const st = stats(slotHz[role]);
    const inBand = slotHz[role].filter((f) => f >= 1500 && f <= 2300).length;
    console.log('  ' + role + '   ' + st.median.toFixed(1).padStart(12) + ' ' + st.mad.toFixed(1).padStart(8) +
      '   ' + (st.min.toFixed(0) + '..' + st.max.toFixed(0)).padEnd(14) + ' ' + inBand + '/' + slotHz[role].length);
  }
  console.log('\n  标定后频率直方图（各槽行数）');
  const edges = [0, 1000, 1200, 1400, 1500, 1600, 1700, 1800, 2000, 2300, 2600, 4000];
  console.log('    区间(Hz)        G     B     R');
  for (let e = 0; e < edges.length - 1; e++) {
    const c = { G: 0, B: 0, R: 0 };
    for (const role of ['G', 'B', 'R']) for (const f of slotHz[role]) if (f >= edges[e] && f < edges[e + 1]) c[role]++;
    console.log('    ' + (edges[e] + '-' + edges[e + 1]).padEnd(15) +
      String(c.G).padStart(4) + String(c.B).padStart(6) + String(c.R).padStart(6));
  }

  // ---------------------------------------------------------------- joint prominence x frequency
  console.log('\n[任务 2/AC5] Prominence × 频率 联合（prominence 与标定无关；频率已标定）');
  console.log('  槽   prominence 中位  频率中位(标定后,Hz)  prom 高(≥8) 的行里频率落在 1500–2300 的比例');
  for (const role of ['G', 'B', 'R']) {
    const st = stats(slotProm[role]);
    const fst = stats(slotHz[role]);
    let tot = 0, inb = 0;
    for (let i = 0; i < refs.length; i++) {
      if (slotProm[role][i] >= 8) { tot++; if (slotHz[role][i] >= 1500 && slotHz[role][i] <= 2300) inb++; }
    }
    console.log('  ' + role + '  ' + st.median.toFixed(2).padStart(14) + ' ' +
      fst.median.toFixed(1).padStart(19) + '  ' + (tot ? (100 * inb / tot).toFixed(1) + '% (' + inb + '/' + tot + ')'
        : '无此类行'));
  }
  console.log('\n  prominence 曲线（. <2  : <4  o <8  O <16  # ≥16）');
  for (const role of ['G', 'B', 'R']) {
    let s = '';
    for (const p of slotProm[role]) s += p < 2 ? '.' : (p < 4 ? ':' : (p < 8 ? 'o' : (p < 16 ? 'O' : '#')));
    console.log('  ' + role + ' ' + s);
  }
  console.log('\n  标定后频率曲线（每字符 1 行；<1500 用 <，1500-2300 用 =，>2300 用 >）');
  for (const role of ['G', 'B', 'R']) {
    let s = '';
    for (const f of slotHz[role]) s += f < 1500 ? '<' : (f <= 2300 ? '=' : '>');
    console.log('  ' + role + ' ' + s);
  }

  // ---------------------------------------------------------------- structure-aware chroma
  console.log('\n[任务 2/AC4] 结构感知色度：色差图相邻行相关（标定后）');
  const srcGR = chromaRowCorr(planes.G, planes.R);
  const srcGB = chromaRowCorr(planes.G, planes.B);
  const srcBR = chromaRowCorr(planes.B, planes.R);
  console.log('  源平面(音频, 已标定): G-R ' + srcGR.toFixed(4) + ' · G-B ' + srcGB.toFixed(4) +
    ' · B-R ' + srcBR.toFixed(4));
  const ourImg = pngjs.PNG.sync.read(fs.readFileSync(path.join(OUT, 'new-ours.png')));
  const op = imgPlanes(ourImg);
  console.log('  我们的输出:          G-R ' + chromaRowCorr(op.G, op.R).toFixed(4) + ' · G-B ' +
    chromaRowCorr(op.G, op.B).toFixed(4) + ' · B-R ' + chromaRowCorr(op.B, op.R).toFixed(4));
  const refImg = pngjs.PNG.sync.read(fs.readFileSync(path.join(OUT, 'ref-robot36.png')));
  const d = refImg.data;
  let x0 = refImg.width, x1 = -1, y0 = refImg.height, y1 = -1;
  for (let y = 0; y < refImg.height; y++) {
    for (let xx = 0; xx < refImg.width; xx++) {
      const i = (y * refImg.width + xx) * 4;
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mx - mn > 40) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
  const small = { data: new Uint8ClampedArray(320 * 256 * 4), width: 320, height: 256 };
  for (let y = 0; y < 256; y++) {
    for (let xx = 0; xx < 320; xx++) {
      const sx = x0 + Math.min(cw - 1, Math.floor(xx * cw / 320));
      const sy = y0 + Math.min(chh - 1, Math.floor(y * chh / 256));
      const s = (sy * refImg.width + sx) * 4, t = (y * 320 + xx) * 4;
      small.data[t] = d[s]; small.data[t + 1] = d[s + 1]; small.data[t + 2] = d[s + 2]; small.data[t + 3] = 255;
    }
  }
  const rp = imgPlanes(small);
  console.log('  Robot36 参照:        G-R ' + chromaRowCorr(rp.G, rp.R).toFixed(4) + ' · G-B ' +
    chromaRowCorr(rp.G, rp.B).toFixed(4) + ' · B-R ' + chromaRowCorr(rp.B, rp.R).toFixed(4));

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 结论 =====');
  const syncErr = sc_.median - 1200;
  const allInBand = ['G', 'B', 'R'].every((r) => {
    const st = stats(slotHz[r]);
    return st.median >= 1500 && st.median <= 2300;
  });
  console.log('  标定后同步音 ' + sc_.median.toFixed(2) + ' Hz（标称 1200，偏差 ' +
    syncErr.toFixed(2) + ' Hz）');
  console.log('  三槽标定后频率中位均在 1500–2300 内? ' + (allInBand ? '是 ✓' : '否 ✗'));
  console.log('  源平面结构化色度 G-R ' + srcGR.toFixed(4) + ' vs 参照 ' +
    chromaRowCorr(rp.G, rp.R).toFixed(4));
  let verdict;
  if (Math.abs(syncErr) < 15 && allInBand) {
    verdict = '【频率映射正常】标定把同步音送回 1200、三槽都在图象带内 → "没色"不是频率映射问题 ✗';
  } else if (Math.abs(syncErr) < 15) {
    verdict = '【同步音正确但三槽偏离图象带】→ 行内几何（槽位置）问题 ✓';
  } else {
    verdict = '【标定后同步音仍偏 ' + syncErr.toFixed(1) + ' Hz】→ 标定本身或搬移量需重新分析 ✗';
  }
  console.log('  判定: ' + verdict);

  fs.writeFileSync(path.join(OUT, 'calibrated.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), calibration: { scale: scale, offsetHz: offsetHz,
      headerScale: cal.headerScale, headerOffsetHz: cal.headerOffsetHz, leaderFreqHz: cal.leaderFreqHz },
    syncRaw: sr_, syncProminence: sp_, syncCalibrated: sc_, leaderRaw: lead.hz, leaderCal: calF(lead.hz),
    slotFrequencyCalibrated: { G: stats(slotHz.G), B: stats(slotHz.B), R: stats(slotHz.R) },
    slotProminence: { G: stats(slotProm.G), B: stats(slotProm.B), R: stats(slotProm.R) },
    slotHzPerLine: slotHz, slotPromPerLine: slotProm,
    chromaRowCorr: { sourceGR: srcGR, sourceGB: srcGB, sourceBR: srcBR,
      oursGR: chromaRowCorr(op.G, op.R), refGR: chromaRowCorr(rp.G, rp.R) },
    verdict: verdict
  }, null, 2));
  console.log('\n证据 -> tests/diag-quality/calibrated.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
