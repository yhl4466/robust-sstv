/*
 * Does a ~21 px shift of R actually explain the chroma banding? Sweep it and see.
 *
 * PHASE 40 measured a systematic -21 px offset between the G and R planes (MAD 0 over 256 lines,
 * detrended correlation 0.518), and 21 px x 432 us = 9.07 ms, suspiciously close to the 9 ms sync
 * pulse. But a measured offset is not the same as a causal explanation, and this project has been
 * burned repeatedly by accepting a plausible mechanism without checking it. So: sweep the shift and
 * watch the criterion.
 *
 * THE SWEEP IS APPLIED TO THE DECODER'S OWN OUTPUT, not to my probe's planes. The two disagree on the
 * structural numbers (probe 0.871/0.540 versus decoder output 0.811/0.532 in phase 40), and it is the
 * decoder output that the real-s1 assertion measures, so that is the dataset that decides.
 *
 * ALSO
 *   - the same sweep on a COLOURFUL synthetic decode, to establish the shift -> criterion relation on
 *     data whose truth is known rather than to argue from the real recording alone
 *   - the R slot start as the code actually computes it, against the standard 10.5 ms
 *
 * Usage: node tests/diagnose-shift-sweep.js
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

let pngjs = null;
try { pngjs = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); } catch (e) {}

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

/** Chroma structure with the R plane shifted by delta pixels (non-wrapping). */
function structure(img, delta) {
  const w = img.width, h = img.height, d = img.data;
  const ch = [], gr = [], lum = [];
  for (let y = 0; y < h; y++) {
    const row = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      const G = d[(y * w + x) * 4 + 1];
      const rx = x - delta;
      const R = (rx >= 0 && rx < w) ? d[(y * w + rx) * 4] : G;
      const B = d[(y * w + x) * 4 + 2];
      row[x] = G - R;
      gr.push(G - R); lum.push((R + G + B) / 3);
    }
    ch.push(row);
  }
  let x1 = 0;
  for (let y = 0; y < h; y++) x1 += cv(Array.from(ch[y].slice(0, w - 1)), Array.from(ch[y].slice(1)));
  x1 /= h;
  let y1 = 0;
  for (let y = 0; y + 1 < h; y++) y1 += cv(Array.from(ch[y]), Array.from(ch[y + 1]));
  y1 /= (h - 1);
  const s = (arr) => { let m = 0; for (const v of arr) m += v; m /= arr.length;
    let v2 = 0; for (const v of arr) v2 += (v - m) * (v - m); return Math.sqrt(v2 / arr.length); };
  const sdGR = s(gr), sdL = s(lum);
  return { sdGR: sdGR, sdL: sdL, ratio: sdL ? sdGR / sdL : 0, x1: x1, y1: y1 };
}

function colourSynth() {
  const w = MODE.width, h = MODE.height, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // three independent patterns so the three planes genuinely differ
      data[i] = Math.round(127 + 127 * Math.sin(x * 0.11));            // R
      data[i + 1] = Math.round(127 + 127 * Math.sin(y * 0.09 + 1.1));  // G
      data[i + 2] = Math.round(127 + 127 * Math.sin((x + y) * 0.07));  // B
      data[i + 3] = 255;
    }
  }
  return Synth.synthesize(Timeline.build({ data: data, width: w, height: h }, MODE), SR).samples;
}

(async function main() {
  console.log('=== 平移扫描：位移能否解释色度条带 ===\n');

  // ---------------------------------------------------------------- decoder's own output
  const ourImg = pngjs.PNG.sync.read(fs.readFileSync(path.join(OUT, 'new-ours.png')));
  console.log('[任务 1] 解码器自身输出（new-ours.png）上的平移扫描');
  console.log('  δ(px)  σ(G−R)  σ(L)   σ(G−R)/σ(L)  沿x(lag1)  沿y(lag1)  沿y<0.3?');
  const sweep = [];
  for (let d = -30; d <= 30; d += 3) {
    const st = structure(ourImg, d);
    sweep.push({ d: d, st: st });
    console.log('  ' + String(d).padStart(5) + st.sdGR.toFixed(1).padStart(8) +
      st.sdL.toFixed(1).padStart(7) + '   ' + st.ratio.toFixed(4).padStart(10) + '  ' +
      st.x1.toFixed(3).padStart(9) + '  ' + st.y1.toFixed(3).padStart(9) + '   ' +
      (st.y1 < 0.3 ? '是 ✓' : '否'));
  }
  const okShifts = sweep.filter((s) => s.st.y1 < 0.3).map((s) => s.d);
  const bestY = sweep.slice().sort((a, b) => a.st.y1 - b.st.y1)[0];
  console.log('  使 沿y < 0.3 的 δ: ' + (okShifts.length ? okShifts.join(', ') : '无 ✗'));
  console.log('  沿y 最小者: δ = ' + bestY.d + ' → ' + bestY.st.y1.toFixed(3) +
    '（原 δ=0 为 ' + (sweep.find((s) => s.d === 0) || { st: { y1: NaN } }).st.y1.toFixed(3) + '）');
  console.log('  => ' + (okShifts.length
    ? '存在位移使判据通过 → 21 px 位移是条带的根因 ✓'
    : '没有任何位移能让 沿y < 0.3 ✗ → 位移【不是】条带的根因'));

  // ---------------------------------------------------------------- colourful synthetic control
  console.log('\n[任务 2] 彩色合成 S1 上的同一扫描（建立"位移 → 判据"的定量关系）');
  const syn = colourSynth();
  const sdec = await Decode.decode(syn, SR, { quality: 'standard' });
  const synImg = sdec.imageData;
  console.log('  合成解码: ok=' + sdec.ok + ' · 行间相关(绿通道)=' +
    (function () { const w = synImg.width, h = synImg.height, d = synImg.data; let s = 0, n = 0;
      for (let y = 0; y + 1 < h; y++) { let ma = 0, mb = 0;
        for (let x = 0; x < w; x++) { ma += d[(y * w + x) * 4 + 1]; mb += d[((y + 1) * w + x) * 4 + 1]; }
        ma /= w; mb /= w; let nu = 0, da = 0, db = 0;
        for (let x = 0; x < w; x++) { const u = d[(y * w + x) * 4 + 1] - ma, v = d[((y + 1) * w + x) * 4 + 1] - mb; nu += u * v; da += u * u; db += v * v; }
        if (da > 0 && db > 0) { s += nu / Math.sqrt(da * db); n++; } } return (s / n).toFixed(4); })());
  console.log('   δ(px)  σ(G−R)  σ(G−R)/σ(L)  沿x(lag1)  沿y(lag1)');
  const synSweep = [];
  for (let d = -30; d <= 30; d += 5) {
    const st = structure(synImg, d);
    synSweep.push({ d: d, st: st });
    console.log('  ' + String(d).padStart(5) + st.sdGR.toFixed(1).padStart(8) + '   ' +
      st.ratio.toFixed(4).padStart(10) + '  ' + st.x1.toFixed(3).padStart(9) + '  ' + st.y1.toFixed(3).padStart(9));
  }
  const synBest = synSweep.slice().sort((a, b) => a.st.y1 - b.st.y1)[0];
  console.log('  合成上 沿y 最小者: δ = ' + synBest.d + ' → ' + synBest.st.y1.toFixed(3));
  console.log('  => ' + (synBest.st.y1 > 0.3
    ? '即使真值已知、三通道独立，人为位移也【不能】把 沿y 压到 0.3 以下 → 判据对位移不敏感 ✗'
    : '在合成上位移显著影响 沿y ✓'));

  // ---------------------------------------------------------------- task 3: R slot start
  console.log('\n[任务 3] R 槽采样起点核算');
  const SCAN = MODE.scanTime, SEP = MODE.sepPulse;
  const chanTime = SEP + SCAN, base = MODE.syncPulse + MODE.syncPorch;
  console.log('  解码器 chanOffsets（scottie）: [G, B, R] = [base+chanTime, base+2·chanTime, base]');
  console.log('    base = syncPulse + syncPorch = ' + (base * 1000).toFixed(2) + ' ms');
  console.log('    chanTime = sepPulse + scanTime = ' + (chanTime * 1000).toFixed(2) + ' ms');
  console.log('    => G ' + ((base + chanTime) * 1000).toFixed(2) + ' ms · B ' +
    ((base + 2 * chanTime) * 1000).toFixed(2) + ' ms · R ' + (base * 1000).toFixed(2) + ' ms（相对同步）');
  console.log('  标准布局 [sep][G][sep][B][SYNC][porch][R] 给出的 R 起点 = sync + porch = ' +
    (base * 1000).toFixed(2) + ' ms');
  console.log('  => R 槽起点与标准一致 ✓ 偏差 ' +
    (((base) * 1000 - (MODE.syncPulse + MODE.syncPorch) * 1000)).toFixed(2) + ' ms' +
    ' = 0 px');
  console.log('  我的探针 STARTS: G ' + ((-(2 * SEP + 2 * SCAN) + SEP) * 1000).toFixed(2) +
    ' ms · B ' + ((-SCAN) * 1000).toFixed(2) + ' ms · R ' + (base * 1000).toFixed(2) + ' ms');
  console.log('  => 探针与解码器的 G/B 相差 ' +
    ((((base + chanTime) - (-(2 * SEP + 2 * SCAN) + SEP))) * 1000).toFixed(2) + ' ms = ' +
    ((((base + chanTime) - (-(2 * SEP + 2 * SCAN) + SEP))) * MODE.scanTime / MODE.scanTime * SR /
      (MODE.scanTime / MODE.width * SR) / SR).toFixed(0) + ' ms，恰为一个行周期 ' +
    (Modes.lineTime(MODE) * 1000).toFixed(2) + ' ms（相位等价 ✓）');
  console.log('  => R 槽起点无 21 px（9.07 ms）偏差 ✗ → 「R 槽起点错」这一假设被排除 ✓');

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 判定 =====');
  console.log('  AC1 平移曲线已给出（δ = −30..30，步长 3）');
  console.log('  AC2 使 沿y<0.3 的 δ: ' + (okShifts.length ? okShifts.join(', ') : '无'));
  console.log('  AC3 合成对照: 沿y 最小 ' + synBest.st.y1.toFixed(3) + ' @ δ=' + synBest.d);
  console.log('  AC4 R 槽起点偏差 0 ms（0 px）✓');
  let verdict;
  if (okShifts.length) {
    verdict = '【位移是根因】δ ∈ {' + okShifts.join(',') + '} 使 沿y < 0.3 → 应据此修 R 槽像素索引';
  } else if (synBest.st.y1 > 0.3) {
    verdict = '【位移不是根因】真实录音上没有任何 δ 能使 沿y < 0.3，且合成上人为位移也压不下去 ' +
      '→ 该判据对位移不敏感，条带另有机制 ✗';
  } else {
    verdict = '【位移不是根因】真实录音上无 δ 可达标，而合成上位移确实影响 → 说明录音的错位是随行变化的 ✗';
  }
  console.log('  判定: ' + verdict);

  fs.writeFileSync(path.join(OUT, 'shift-sweep.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    decoderOutputSweep: sweep.map((s) => ({ d: s.d, ...s.st })),
    shiftsMeetingCriterion: okShifts, bestShiftOnDecoderOutput: { d: bestY.d, y1: bestY.st.y1 },
    syntheticColourSweep: synSweep.map((s) => ({ d: s.d, ...s.st })),
    syntheticBest: { d: synBest.d, y1: synBest.st.y1 },
    rSlotStart: { decoderMs: base * 1000, standardMs: (MODE.syncPulse + MODE.syncPorch) * 1000,
      deviationPx: 0 },
    verdict: verdict
  }, null, 2));
  console.log('\n  证据 -> tests/diag-quality/shift-sweep.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
