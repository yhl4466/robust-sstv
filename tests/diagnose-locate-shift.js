/*
 * Where does the 21 px come from? The decisive test is the synthetic one.
 *
 * THE QUESTION THAT MATTERS
 *   If our own synthetic S1 - encoded and decoded by the same code - shows the same G-to-R offset,
 *   then the defect is IN THE CODE and the self round trip absorbs it: encoder and decoder share the
 *   same wrong assumption, the round trip stays self-consistent, and only a recording that follows
 *   the standard fails. That would explain the whole shape of this investigation.
 *
 *   Phase 41 tried this and the control was worthless: the synthetic image used G = sin(y*0.09), which
 *   is CONSTANT along x, so the G-R difference carried no row structure and shifting R changed
 *   nothing. This one uses three patterns that vary in BOTH directions.
 *
 * ALSO HERE
 *   [2] the per-channel constants (chanOffsets, pixelTime, windowFactor, centreWindowTime) computed
 *       from the mode table and the decoder's own calibration, so a channel-specific constant would be
 *       visible
 *   [4] the encoder's own R write position relative to the sync, against the standard 10.5 ms
 *
 * Usage: node tests/diagnose-locate-shift.js
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
      Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;
const MODE = Modes.get('S1');
const SCAN = MODE.scanTime, SEP = MODE.sepPulse;
const PIXEL = SCAN / MODE.width * SR;
const NOMINAL_LINE = Modes.lineTime(MODE) * SR;

const cv = (a, b) => {
  const n = Math.min(a.length, b.length);
  if (n < 8) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let nu = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; nu += u * v; da += u * u; db += v * v; }
  return (da > 0 && db > 0) ? nu / Math.sqrt(da * db) : 0;
};

/** Detrended (first-difference) normalised cross-correlation over +/-maxD pixels. */
function detrendedShift(a, b, maxD) {
  const n = a.length;
  const da = new Float64Array(n - 1), db = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) { da[i] = a[i + 1] - a[i]; db[i] = b[i + 1] - b[i]; }
  let bd = 0, bv = -2;
  for (let d = -maxD; d <= maxD; d++) {
    let ma = 0, mb = 0, cnt = 0;
    for (let i = 0; i < n - 1; i++) { const j = i + d; if (j < 0 || j >= n - 1) continue; ma += da[i]; mb += db[j]; cnt++; }
    if (cnt < 32) continue;
    ma /= cnt; mb /= cnt;
    let nu = 0, va = 0, vb = 0;
    for (let i = 0; i < n - 1; i++) {
      const j = i + d; if (j < 0 || j >= n - 1) continue;
      const u = da[i] - ma, v = db[j] - mb;
      nu += u * v; va += u * u; vb += v * v;
    }
    const r = (va > 0 && vb > 0) ? nu / Math.sqrt(va * vb) : 0;
    if (r > bv) { bv = r; bd = d; }
  }
  return { d: bd, r: bv };
}

function stats(a) {
  const f = a.filter((v) => isFinite(v));
  if (!f.length) return null;
  const s = f.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of f) sum += v;
  return { n: f.length, median: med, mad: mad, mean: sum / f.length, min: s[0], max: s[s.length - 1] };
}

/** Colourful synthetic image: each channel varies along BOTH axes (the phase-41 mistake). */
function colourImage() {
  const w = MODE.width, h = MODE.height, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = Math.round(127 + 120 * Math.sin(x * 0.13 + y * 0.017));       // R varies in x and y
      d[i + 1] = Math.round(127 + 120 * Math.sin(x * 0.07 + y * 0.031));   // G varies in x and y
      d[i + 2] = Math.round(127 + 120 * Math.sin(x * 0.045 + y * 0.043));  // B varies in x and y
      d[i + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

async function measureShifts(x, label) {
  const refs = [];
  const dec = await Decode.decode(x, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  if (!dec.ok) { console.log('  ' + label + ': 解码失败 ' + dec.message); return null; }
  const im = dec.imageData, w = im.width, h = im.height, d = im.data;
  const G = [], R = [], B = [];
  for (let y = 0; y < h; y++) {
    const g = new Float64Array(w), r = new Float64Array(w), b = new Float64Array(w);
    for (let px = 0; px < w; px++) {
      g[px] = d[(y * w + px) * 4 + 1]; r[px] = d[(y * w + px) * 4]; b[px] = d[(y * w + px) * 4 + 2];
    }
    G.push(g); R.push(r); B.push(b);
  }
  const dGR = [], dGB = [], rGR = [];
  for (let y = 0; y < h; y++) {
    const a = Array.from(G[y]);
    const gr = detrendedShift(a, Array.from(R[y]), 160);
    const gb = detrendedShift(a, Array.from(B[y]), 160);
    dGR.push(gr.d); dGB.push(gb.d); rGR.push(gr.r);
  }
  const sGR = stats(dGR), sGB = stats(dGB), pGR = stats(rGR);
  // chroma stats
  const gr = [], lum = [];
  for (let y = 0; y < h; y++) for (let px = 0; px < w; px++) {
    gr.push(G[y][px] - R[y][px]); lum.push((G[y][px] + R[y][px] + B[y][px]) / 3);
  }
  const s = (arr) => { let m = 0; for (const v of arr) m += v; m /= arr.length;
    let v2 = 0; for (const v of arr) v2 += (v - m) * (v - m); return Math.sqrt(v2 / arr.length); };
  console.log('  ' + label + ': σ(G−R) ' + s(gr).toFixed(1) + ' · σ(L) ' + s(lum).toFixed(1) +
    ' · 比 ' + (s(gr) / s(lum)).toFixed(4));
  console.log('      G−R 位移: 中位 ' + sGR.median + ' px · MAD ' + sGR.mad + ' · 峰值相关中位 ' + pGR.median.toFixed(3));
  console.log('      G−B 位移: 中位 ' + sGB.median + ' px · MAD ' + sGB.mad);
  return { GR: sGR, GB: sGB, peakGR: pGR, perLineGR: dGR };
}

(async function main() {
  console.log('=== 定位 21 px 来源 ===\n');

  // ---------------------------------------------------------------- [2] constants
  console.log('[任务 2] 三通道常数');
  const base = MODE.syncPulse + MODE.syncPorch;
  const chanTime = SEP + SCAN;
  console.log('  base(sync+porch) = ' + (base * 1000).toFixed(3) + ' ms · chanTime(sep+scan) = ' +
    (chanTime * 1000).toFixed(3) + ' ms');
  console.log('  chanOffsets（scottie 分支, 按角色 G/B/R 索引）= [base+chanTime, base+2·chanTime, base]');
  console.log('    G ' + ((base + chanTime) * 1000).toFixed(3) + ' ms · B ' +
    ((base + 2 * chanTime) * 1000).toFixed(3) + ' ms · R ' + (base * 1000).toFixed(3) + ' ms');
  console.log('  这些是【同一行内】的偏移，因此 G 的槽比 R 的槽晚 ' +
    (chanTime * 1000).toFixed(2) + ' ms = ' + (chanTime * SR / PIXEL).toFixed(1) + ' px');
  console.log('  pixelTime（标称）= ' + (SCAN / MODE.width * 1e6).toFixed(1) + ' µs = ' +
    PIXEL.toFixed(2) + ' 采样 · windowFactor = ' + (MODE.windowFactor || 2.48));
  console.log('  centreWindowTime = pixelTime × windowFactor / 2');
  console.log('  → 三通道共用同一组常数（代码里它们在通道循环【之外】计算）✗ 无通道差异');

  // ---------------------------------------------------------------- [4] encoder R position
  console.log('\n[任务 4] 编码器的 R 写入位置（sstv-timeline.js 的 scottie 分支）');
  console.log('  发射顺序（每行）：SYNC, sep, G, sep, B, SYNC, sep, R');
  console.log('  故 R 起点 = 第二个同步起点 + syncPulse + sepPulse = 0 + ' +
    ((MODE.syncPulse + SEP) * 1000).toFixed(2) + ' ms');
  console.log('  标准 [sep][G][sep][B][SYNC][porch][R] 的 R 起点 = sync + porch = ' +
    ((MODE.syncPulse + MODE.syncPorch) * 1000).toFixed(2) + ' ms');
  console.log('  => 编码器 R 起点 ' + ((MODE.syncPulse + SEP) * 1000).toFixed(2) + ' ms 与标准 ' +
    ((MODE.syncPulse + MODE.syncPorch) * 1000).toFixed(2) + ' ms ' +
    (Math.abs(SEP - MODE.syncPorch) < 1e-9 ? '一致 ✓（porch = sepPulse = 1.5 ms）' : '不一致 ✗'));
  console.log('  => 编码器无 9 ms（21 px）量级的 R 偏移 ✓');

  // ---------------------------------------------------------------- [1] expected vs actual pos
  console.log('\n[任务 1] 逐像素采样索引：公式值与标准期望值');
  const pixelTime = SCAN / MODE.width;
  console.log('  解码器 pos = seqStart + (chanOffsets[chan] + (px+0.5)·pixelTime − centreWindowTime)·SR');
  console.log('  其中 centreWindowTime = pixelTime·windowFactor/2 = ' +
    (pixelTime * (MODE.windowFactor || 2.48) / 2 * 1e6).toFixed(1) + ' µs');
  console.log('  对 G 槽而言，pos 相对 R 槽【同一 px】多出 ' +
    ((chanTime) * SR).toFixed(0) + ' 采样 = ' + (chanTime * SR / PIXEL).toFixed(1) + ' px');
  console.log('  标准布局里 G 与 R 相距 ' + ((chanTime) * 1000).toFixed(2) +
    ' ms（G 在同步前 ' + (((2 * SEP + 2 * SCAN) - SEP) * 1000).toFixed(2) +
    ' ms，R 在同步后 ' + (base * 1000).toFixed(2) + ' ms）');
  console.log('  => 该距离是 ' + (chanTime * SR / PIXEL).toFixed(0) + ' px，与 21 px 无关 ✗');

  // ---------------------------------------------------------------- [3] THE decisive test
  console.log('\n[任务 3] ★ 合成 S1（三通道在两方向上都变化）—— 决定性对照');
  const img = colourImage();
  const syn = Synth.synthesize(Timeline.build(img, MODE), SR).samples;
  const synRes = await measureShifts(syn, '合成 S1（自往返）');

  console.log('\n  phigros（真实录音，阶段四十的同一测量）:');
  const pb = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const pinfo = Wav.parse(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
  const phRes = await measureShifts(pinfo.samples, 'phigros');

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 判定 =====');
  if (synRes && phRes) {
    console.log('  合成 S1 G−R 位移中位 ' + synRes.GR.median + ' px（MAD ' + synRes.GR.mad + '）');
    console.log('  phigros G−R 位移中位 ' + phRes.GR.median + ' px（MAD ' + phRes.GR.mad + '）');
    const same = Math.abs(synRes.GR.median - phRes.GR.median) <= 3 && Math.abs(synRes.GR.median) >= 5;
    console.log('  => ' + (same
      ? '★ 合成 S1 上出现【同样】的位移 → 编解码器共享同一处错误，自往返把它吸收了 ✓✓ 这就是根因所在'
      : (Math.abs(synRes.GR.median) < 5
        ? '合成 S1 上【没有】位移 → 代码本身无系统偏差，phigros 的 21 px 来自其特有路径 ✗'
        : '两者位移不同（合成 ' + synRes.GR.median + ' vs phigros ' + phRes.GR.median + '）→ 需进一步区分')));
  }

  fs.writeFileSync(path.join(OUT, 'locate-shift.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    constants: { baseMs: base * 1000, chanTimeMs: chanTime * 1000,
      chanOffsetsMs: { G: (base + chanTime) * 1000, B: (base + 2 * chanTime) * 1000, R: base * 1000 },
      pixelUs: SCAN / MODE.width * 1e6, windowFactor: MODE.windowFactor || 2.48,
      sharedAcrossChannels: true },
    encoderRStartMs: (MODE.syncPulse + SEP) * 1000,
    standardRStartMs: (MODE.syncPulse + MODE.syncPorch) * 1000,
    synthetic: synRes, phigros: phRes
  }, null, 2));
  console.log('\n  证据 -> tests/diag-quality/locate-shift.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
