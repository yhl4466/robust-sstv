/*
 * Where does the colour go? Per-pixel chroma amplitude, three ways, plus a window-length sweep.
 *
 * WHY PER-PIXEL AND NOT PER-SLOT
 *   Phase 37 measured the three slots' MEDIAN frequencies (G 2093, B 2086.5, R 2123.3 Hz) and they
 *   looked nearly identical. But a slot median is a channel-MEAN statistic: for Scottie S1 the three
 *   scans of one line are the R, G and B channels of the SAME image row, whose means are naturally
 *   close. Chroma lives in the per-pixel variation, so that is what has to be measured.
 *
 * THE THREE-WAY COMPARISON
 *   sigma(G-R) against sigma(L) for:
 *     (1) synthetic S1  - the truth is known, so this calibrates the measurement itself
 *     (2) phigros       - the real recording
 *     (3) Robot36's PNG - the reference render, resampled to the same 320x256 raster
 *   If (1) is healthy and (2) is not, the source or capture chain is the limit; if both are low the
 *   decoder's own pixel window is; if (2) matches (3) then colour is there and the problem is
 *   downstream in how it is displayed.
 *
 * THE WINDOW SWEEP (task 2) needs no production change: the per-pixel analysis window is a parameter
 * of MY probe, so sweeping it answers "does a shorter window recover chroma" directly.
 *
 * Usage: node tests/diagnose-chroma-pixels.js
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
const STARTS = { G: -(2 * SEP + 2 * SCAN) + SEP, B: -SCAN, R: (MODE.syncPulse + MODE.syncPorch) };

let pngjs = null;
try { pngjs = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); } catch (e) {}

function windowAt(x, at, len) {
  const w = new Float64Array(len), half = len >> 1;
  for (let i = 0; i < len; i++) {
    const j = at - half + i;
    const h = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
    w[i] = (j >= 0 && j < x.length) ? x[j] * h : 0;
  }
  return w;
}

/** Brute-force DFT (phase 37): incremental phasor, 4 Hz coarse then 0.25 Hz fine. */
function bruteDFT(w, lo, hi, step) {
  let best = -1, bf = NaN;
  const dw = 2 * Math.PI * step / SR, cS = Math.cos(dw), sS = Math.sin(dw);
  for (let f = lo; f <= hi; f += step) {
    let re = 0, im = 0;
    const w0 = 2 * Math.PI * f / SR;
    let c = Math.cos(w0), s = Math.sin(w0), ci = 1, si = 0;
    for (let i = 0; i < w.length; i++) {
      re += w[i] * ci; im -= w[i] * si;
      const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
    }
    const m = Math.sqrt(re * re + im * im);
    if (m > best) { best = m; bf = f; }
  }
  return bf;
}
function dftAt(x, at, len) {
  const c = bruteDFT(windowAt(x, at, len), 1000, 2400, 4);
  return bruteDFT(windowAt(x, at, len), Math.max(1000, c - 4), Math.min(2400, c + 4), 0.25);
}

function stats(a) {
  const f = a.filter((v) => isFinite(v));
  if (!f.length) return null;
  const s = f.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of f) sum += v;
  const mean = sum / f.length;
  let v2 = 0; for (const v of f) v2 += (v - mean) * (v - mean);
  return { n: f.length, median: med, mad: mad, mean: mean, sd: Math.sqrt(v2 / f.length), min: s[0], max: s[s.length - 1] };
}

/** Chroma statistics on three grey planes (0..255). */
function chromaStats(P) {
  const H = P.G.length, W = P.G[0].length;
  const gr = [], gb = [], lum = [];
  const chromaRows = { gr: [], gb: [] };
  for (let y = 0; y < H; y++) {
    const rowGR = new Float64Array(W), rowGB = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      const G = P.G[y][x], R = P.R[y][x], B = P.B[y][x];
      const dgr = G - R, dgb = G - B;
      gr.push(dgr); gb.push(dgb);
      lum.push((R + G + B) / 3);
      rowGR[x] = dgr; rowGB[x] = dgb;
    }
    chromaRows.gr.push(rowGR); chromaRows.gb.push(rowGB);
  }
  const rowCorr = (rows) => {
    let s = 0, n = 0;
    for (let y = 0; y + 1 < rows.length; y++) {
      let ma = 0, mb = 0;
      for (let x = 0; x < W; x++) { ma += rows[y][x]; mb += rows[y + 1][x]; }
      ma /= W; mb /= W;
      let nu = 0, da = 0, db = 0;
      for (let x = 0; x < W; x++) {
        const u = rows[y][x] - ma, v = rows[y + 1][x] - mb;
        nu += u * v; da += u * u; db += v * v;
      }
      if (da > 0 && db > 0) { s += nu / Math.sqrt(da * db); n++; }
    }
    return n ? s / n : 0;
  };
  const sgr = stats(gr), sgb = stats(gb), sl = stats(lum);
  return { sdGR: sgr.sd, sdGB: sgb.sd, sdL: sl.sd,
    ratioGR: sl.sd > 0 ? sgr.sd / sl.sd : 0, ratioGB: sl.sd > 0 ? sgb.sd / sl.sd : 0,
    meanL: sl.mean, chromaRowCorrGR: rowCorr(chromaRows.gr), chromaRowCorrGB: rowCorr(chromaRows.gb) };
}

function synthS1() {
  const w = MODE.width, h = MODE.height, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, v = Math.round(255 * x / (w - 1));
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return Synth.synthesize(Timeline.build({ data: data, width: w, height: h }, MODE), SR).samples;
}

/** Sample the three planes at `step`-pixel resolution with a window of `winPx` pixels. */
function planesOf(x, refs, winPx, step, lineStep) {
  const len = Math.max(16, Math.round(PIXEL * winPx));
  const P = { G: [], B: [], R: [] };
  for (let i = 0; i < refs.length; i += (lineStep || 1)) {
    for (const role of ['G', 'B', 'R']) {
      const s0 = refs[i].ref + STARTS[role] * SR, row = [];
      for (let px = 0; px < MODE.width; px += (step || 1)) {
        const f = dftAt(x, Math.round(s0 + (px + 0.5) * PIXEL), len);
        row.push(Math.max(0, Math.min(255, Math.round(255 * (f - 1500) / 800))));
      }
      P[role].push(row);
    }
  }
  return P;
}

(async function main() {
  console.log('=== 逐像素色度幅度 ===\n');
  const t00 = Date.now();

  // ---------------------------------------------------------------- sources
  const syn = synthS1();
  const synRefs = [];
  await Decode.decode(syn, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: synRefs });

  const pb = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const pinfo = Wav.parse(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
  const px_ = pinfo.samples;
  const phRefs = [];
  const pdec = await Decode.decode(px_, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: phRefs });

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
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const refP = { G: [], B: [], R: [] };
  for (let y = 0; y < 256; y++) {
    const rowG = [], rowB = [], rowR = [];
    for (let xx = 0; xx < 320; xx += 1) {
      const sx = x0 + Math.min(cw - 1, Math.floor(xx * cw / 320));
      const sy = y0 + Math.min(ch - 1, Math.floor(y * ch / 256));
      const s = (sy * refImg.width + sx) * 4;
      rowR.push(d[s]); rowG.push(d[s + 1]); rowB.push(d[s + 2]);
    }
    refP.R.push(rowR); refP.G.push(rowG); refP.B.push(rowB);
  }

  // ---------------------------------------------------------------- task 1
  console.log('[任务 1] 三方逐像素色度对照（窗长 2.48 像素，每 2 像素取样）');
  const W2 = Math.round(PIXEL * 2.48);
  let t1 = Date.now();
  const synP = planesOf(syn, synRefs, 2.48, 2);
  console.log('  合成 S1 平面完成 (' + ((Date.now() - t1) / 1000).toFixed(1) + ' s)');
  t1 = Date.now();
  const phP = planesOf(px_, phRefs, 2.48, 2);
  console.log('  phigros 平面完成 (' + ((Date.now() - t1) / 1000).toFixed(1) + ' s)');

  const synC = chromaStats(synP), phC = chromaStats(phP), refC = chromaStats(refP);
  console.log('\n  来源            σ(G−R)  σ(G−B)   σ(L)    σ(G−R)/σ(L)  σ(G−B)/σ(L)  亮度均值');
  const row = (name, c) => console.log('  ' + name.padEnd(15) + c.sdGR.toFixed(1).padStart(7) +
    c.sdGB.toFixed(1).padStart(8) + c.sdL.toFixed(1).padStart(8) + '   ' +
    c.ratioGR.toFixed(4).padStart(10) + '   ' + c.ratioGB.toFixed(4).padStart(10) +
    '   ' + c.meanL.toFixed(1).padStart(7));
  row('合成 S1（真值）', synC);
  row('phigros', phC);
  row('Robot36 参照', refC);

  console.log('\n[任务 1/AC2] 色度结构：色差图的逐行自相关（结构化色度 > 0，噪声 ≈ 0）');
  console.log('  来源            G−R 行间相关   G−B 行间相关');
  const rc = (name, c) => console.log('  ' + name.padEnd(15) + c.chromaRowCorrGR.toFixed(4).padStart(12) +
    '   ' + c.chromaRowCorrGB.toFixed(4).padStart(12));
  rc('合成 S1（真值）', synC);
  rc('phigros', phC);
  rc('Robot36 参照', refC);

  // ---------------------------------------------------------------- task 2 window sweep
  console.log('\n[任务 2/AC3] 窗长扫描（在 phigros 上，每 4 像素 × 每 4 行取样以控时）');
  console.log('  窗长(像素)  实际采样   σ(G−R)  σ(L)    σ(G−R)/σ(L)  G−R 行间相关');
  const sweep = [];
  for (const wp of [1.0, 1.5, 2.0, 2.48, 3.5]) {
    const len = Math.max(16, Math.round(PIXEL * wp));
    const P = planesOf(px_, phRefs, wp, 4, 4);
    const c = chromaStats(P);
    sweep.push({ winPx: wp, lenSamples: len, c: c });
    console.log('  ' + wp.toFixed(2).padStart(10) + String(len).padStart(11) + ' ' +
      c.sdGR.toFixed(1).padStart(8) + c.sdL.toFixed(1).padStart(7) + '   ' +
      c.ratioGR.toFixed(4).padStart(10) + '   ' + c.chromaRowCorrGR.toFixed(4).padStart(11));
  }
  const best = sweep.slice().sort((a, b) => b.c.ratioGR - a.c.ratioGR)[0];
  const cur = sweep.find((s) => Math.abs(s.winPx - 2.48) < 1e-6);

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 判定 =====');
  console.log('  合成 S1 σ(G−R)/σ(L) = ' + synC.ratioGR.toFixed(4) + '（真值基准：灰度斜坡应 ≈0，因为 R=G=B）');
  console.log('  phigros  σ(G−R)/σ(L) = ' + phC.ratioGR.toFixed(4) + ' · Robot36 参照 = ' + refC.ratioGR.toFixed(4));
  const phVsRef = phC.ratioGR / (refC.ratioGR || 1e-9);
  console.log('  phigros / 参照 = ' + phVsRef.toFixed(3));
  console.log('  窗长: 当前 2.48 → ' + cur.c.ratioGR.toFixed(4) + ' · 最佳 ' + best.winPx +
    ' → ' + best.c.ratioGR.toFixed(4) + '（提升 ' +
    ((best.c.ratioGR / cur.c.ratioGR - 1) * 100).toFixed(1) + '%）');
  let verdict;
  if (phVsRef > 0.7) {
    verdict = '【色度幅度正常】phigros 达到参照的 ' + (100 * phVsRef).toFixed(0) +
      '% → "没色"不是色度幅度问题，而在下游显示/映射 ✗';
  } else if (best.c.ratioGR > cur.c.ratioGR * 1.15) {
    verdict = '【窗长是原因】缩短窗长可提升色度 ' +
      ((best.c.ratioGR / cur.c.ratioGR - 1) * 100).toFixed(0) + '% → 当前 2.48 像素窗抹平了色度 ✗';
  } else {
    verdict = '【源头色度偏低】phigros 只有参照的 ' + (100 * phVsRef).toFixed(0) +
      '%，且窗长扫描无改善 → 色度在采集/编码链路上丢失 ✗';
  }
  console.log('  判定: ' + verdict);
  console.log('\n  总耗时 ' + ((Date.now() - t00) / 1000).toFixed(1) + ' s');

  fs.writeFileSync(path.join(OUT, 'chroma-pixels.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    windowFactorDefault: 2.48,
    threeWay: { synthetic: synC, phigros: phC, robot36: refC }, phVsRef: phVsRef,
    windowSweep: sweep.map((s) => ({ winPx: s.winPx, lenSamples: s.lenSamples, ratioGR: s.c.ratioGR,
      sdGR: s.c.sdGR, sdL: s.c.sdL, chromaRowCorrGR: s.c.chromaRowCorrGR })),
    bestWindow: best.winPx, verdict: verdict
  }, null, 2));
  console.log('  证据 -> ' + path.relative(ROOT, path.join(OUT, 'chroma-pixels.json')));
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
