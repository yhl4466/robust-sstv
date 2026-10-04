/*
 * LOCALISING THE FREQUENCY-OFFSET ASYMMETRY - the decisive measurement.
 *
 * WHAT IS ALREADY ESTABLISHED (phase 49/51, each measured, none of them the cause):
 *   - the impairment model is symmetric (verified against an FFT reference that self-validates)
 *   - SYNC_DETECT_HZ read on the raw axis: the walk's reading tracks the shift correctly; 0% over
 *     threshold on either side
 *   - alignSync takes IDENTICAL branches on both signs (514 calls, 512 start in a pulse, 2 searches)
 *   - the header calibration slope `a` has no sign-dependent bias (short-window bias 0.01 Hz)
 *   - the loss is spread evenly over all three channels and all three scan thirds
 *   - the lock residuals and clock scale are identical on both signs
 *
 * THE REMAINING SUSPECT is the per-pixel estimator and its search band, which had NO observability at
 * all. That is what phase 51 added: an opt-in `auditPixels` sink that records, for every pixel, the RAW
 * frequency the estimator read, the frequency after calibration, the resulting grey level, the search
 * band, and the calibration used.
 *
 * WHY A FLAT FIELD MAKES THIS DECISIVE
 *   A flat grey image transmits the SAME tone for every pixel of a given channel. So under a pure
 *   offset of +D or -D the raw-frequency distribution must simply translate - same shape, same spread.
 *   If the two distributions differ in shape or spread, the estimator or the band is the cause. If they
 *   only translate, the estimator is innocent and the fault is downstream of it.
 *
 * Usage: node tests/diagnose-pixel-audit.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Decode = globalThis.SSTVDecode;

const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const freqShift = new Function('SR',
  SRC.slice(SRC.indexOf('function hilbertFIR'), SRC.indexOf('/** Decoder lock residuals')) +
  '\nreturn freqShift;')(SR);

const MODE = Modes.get('S1');

/** Flat field: every pixel of every channel carries the same level, so the truth is known exactly. */
function flat(level) {
  const w = MODE.width, h = MODE.height;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = level; d[i + 3] = 255; }
  return { data: d, width: w, height: h };
}

function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = a.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(a.length / 2)];
  let sum = 0; for (const v of a) sum += v;
  const mean = sum / a.length;
  let v2 = 0; for (const v of a) v2 += (v - mean) * (v - mean);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { n: a.length, median: med, mean: mean, mad: mad, sd: Math.sqrt(v2 / a.length),
    min: s[0], max: s[s.length - 1], p05: q(0.05), p95: q(0.95) };
}

const LEVEL = 127;

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const img = flat(LEVEL);
  const clean = Synth.synthesize(Timeline.build(img, MODE), SR).samples;

  console.log('=== 逐像素频率审计（平坦图，真值已知）===\n');
  console.log('  平坦图灰度 ' + LEVEL + ' → 传输音对每个像素相同。');
  console.log('  纯频偏 Δ 下，raw 频率分布应只是整体平移：形状与离散度不变。\n');
  console.log('  频偏   a         b(Hz)    带下界  带上界 |  raw 中位  raw SD  raw范围      | nominal 中位  nominal SD | 灰度 中位  SD    饱和%');
  const rows = [];
  for (const hz of [0, 20, -20, 50, -50]) {
    const sig = hz === 0 ? clean : freqShift(clean, hz);
    const audit = [];
    const r = await Decode.decode(sig, SR,
      { quality: 'standard', yieldEvery: 0, postprocess: 'off', auditPixels: audit });
    if (!r.ok) { console.log('  ' + String(hz).padStart(4) + '   解码失败: ' + r.message); continue; }
    const raw = audit.map((p) => p.raw);
    const nom = audit.map((p) => p.nominal);
    const lum = audit.map((p) => p.lum);
    const sr2 = stats(raw), sn = stats(nom), sl = stats(lum);
    const sat = lum.filter((v) => v <= 0 || v >= 255).length / lum.length * 100;
    const A = audit[0].a, B = audit[0].b;
    rows.push({ hz: hz, a: A, b: B, bandLo: audit[0].bandLo, bandHi: audit[0].bandHi,
      raw: sr2, nominal: sn, lum: sl, satPct: sat });
    console.log('  ' + String(hz).padStart(4) + '  ' + A.toFixed(6) + '  ' + B.toFixed(2).padStart(7) +
      '  ' + audit[0].bandLo.toFixed(0).padStart(6) + '  ' + audit[0].bandHi.toFixed(0).padStart(6) + ' | ' +
      sr2.median.toFixed(1).padStart(8) + ' ' + sr2.sd.toFixed(2).padStart(6) + '  ' +
      (sr2.min.toFixed(0) + '..' + sr2.max.toFixed(0)).padStart(11) + ' | ' +
      sn.median.toFixed(1).padStart(12) + ' ' + sn.sd.toFixed(2).padStart(10) + ' | ' +
      sl.median.toFixed(1).padStart(9) + ' ' + sl.sd.toFixed(2).padStart(6) + ' ' + sat.toFixed(1).padStart(6));
  }

  /* ---- the decisive comparison: is the raw distribution the SAME SHAPE at +D and -D? ---- */
  console.log('\n  --- 同幅反号对照：raw 分布的形状是否一致 ---');
  for (const mag of [20, 50]) {
    const p = rows.find((r) => r.hz === mag), m = rows.find((r) => r.hz === -mag);
    if (!p || !m) continue;
    const dMedian = p.raw.median - m.raw.median;
    const expected = 2 * mag;   // a pure offset should separate the two medians by exactly 2*D in raw Hz
    console.log('    ±' + String(mag).padStart(3) + ' Hz: raw 中位差 ' + dMedian.toFixed(1) +
      ' Hz（纯平移应为 ' + expected + ' Hz，偏差 ' + (dMedian - expected).toFixed(1) + '）');
    console.log('              raw SD  ' + p.raw.sd.toFixed(2) + ' vs ' + m.raw.sd.toFixed(2) +
      '（比 ' + (p.raw.sd / m.raw.sd).toFixed(3) + '）· 极差 ' +
      (p.raw.max - p.raw.min).toFixed(0) + ' vs ' + (m.raw.max - m.raw.min).toFixed(0));
    console.log('              灰度 SD ' + p.lum.sd.toFixed(2) + ' vs ' + m.lum.sd.toFixed(2) +
      ' · 饱和 ' + p.satPct.toFixed(2) + '% vs ' + m.satPct.toFixed(2) + '%' +
      ' · 灰度中位 ' + p.lum.median.toFixed(1) + ' vs ' + m.lum.median.toFixed(1));
  }

  console.log('\n  判读：');
  console.log('    · 若 raw 中位差 ≈ 2Δ 且 SD/极差相近 → 估计器与搜索带对称，问题在估计器之后；');
  console.log('    · 若某一侧的 SD 或极差明显更大 → 估计器/带边界在该侧失衡；');
  console.log('    · 若灰度 SD 或饱和率两侧差异大而 raw 对称 → 问题在标定映射 calcLum(calF(f))。');

  fs.writeFileSync(path.join(OUT, 'pixel-audit.json'), JSON.stringify(rows, null, 2));
  console.log('\n证据 -> tests/diag-quality/pixel-audit.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
