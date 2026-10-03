/*
 * Detrended channel shift, low-frequency mismatch, and a calibrated structural criterion.
 *
 * FROM PHASE 39
 *   G-B is aligned (191/256 lines at delta 0) but the G-R cross-correlation locked onto the search
 *   boundary for 247/256 lines, because G-R has a lag-1 intra-row autocorrelation of 0.87 - i.e. it is
 *   trend-dominated, and a zero-mean normalised correlation of a trending signal against itself rises
 *   monotonically with |delta|. The real finding was structural: our chroma correlates far too much in
 *   BOTH directions (x 0.87 / y 0.54) against the reference's 0.55 / 0.15.
 *
 * THIS SCRIPT
 *   [1] detrend (first difference) before correlating, and widen the search to +/-160 px, so a genuine
 *       large shift can be seen and a trend cannot fake one
 *   [2] classify the magnitude: a few pixels means a pixel-index error, ~320 px means the slots are
 *       sampling neighbouring scans
 *   [3] remove each channel's per-row mean to test whether the chroma is a low-frequency MISMATCH
 *       between channels rather than per-pixel content
 *   [4] measure the structural criterion on all three sources, using the CALIBRATED frequency axis
 *       (the phase-38 quality gate now falls back to the header fit, scale 0.989806, offset 19.282)
 *
 * Usage: node tests/diagnose-detrend-shift.js
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
  let v2 = 0; const mean = sum / f.length;
  for (const v of f) v2 += (v - mean) * (v - mean);
  return { n: f.length, median: med, mad: mad, mean: mean, sd: Math.sqrt(v2 / f.length), min: s[0], max: s[s.length - 1] };
}

/** Grey planes at full 320-pixel resolution, with the decoder's calibration applied. */
function planesOf(x, refs, winPx, calF) {
  const len = Math.max(16, Math.round(PIXEL * winPx));
  const P = { G: [], B: [], R: [] };
  for (let i = 0; i < refs.length; i++) {
    for (const role of ['G', 'B', 'R']) {
      const s0 = refs[i].ref + STARTS[role] * SR, row = [];
      for (let px = 0; px < MODE.width; px++) {
        let f = dftAt(x, Math.round(s0 + (px + 0.5) * PIXEL), len);
        if (calF) f = calF(f);
        row.push(Math.max(0, Math.min(255, Math.round(255 * (f - 1500) / 800))));
      }
      P[role].push(row);
    }
  }
  return P;
}

/** Detrended (first-difference) normalised cross-correlation, wide search. */
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

function corrVec(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 8) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let nu = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; nu += u * v; da += u * u; db += v * v; }
  return (da > 0 && db > 0) ? nu / Math.sqrt(da * db) : 0;
}

/** Chroma statistics, optionally removing each channel's own per-row mean first. */
function chromaStats(P, demean) {
  const H = P.G.length, W = P.G[0].length;
  const gr = [], gb = [], lum = [], rowsGR = [];
  for (let y = 0; y < H; y++) {
    let mG = 0, mR = 0, mB = 0;
    for (let x = 0; x < W; x++) { mG += P.G[y][x]; mR += P.R[y][x]; mB += P.B[y][x]; }
    mG /= W; mR /= W; mB /= W;
    const rGR = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      const G = demean ? P.G[y][x] - mG : P.G[y][x];
      const R = demean ? P.R[y][x] - mR : P.R[y][x];
      const B = demean ? P.B[y][x] - mB : P.B[y][x];
      gr.push(G - R); gb.push(G - B); lum.push((R + G + B) / 3);
      rGR[x] = G - R;
    }
    rowsGR.push(rGR);
  }
  const alongX = (lag) => { let s = 0, n = 0; for (const r of rowsGR) { s += corrVec(Array.from(r.slice(0, r.length - lag)), Array.from(r.slice(lag))); n++; } return n ? s / n : 0; };
  const alongY = (lag) => { let s = 0, n = 0; for (let y = 0; y + lag < rowsGR.length; y++) { s += corrVec(Array.from(rowsGR[y]), Array.from(rowsGR[y + lag])); n++; } return n ? s / n : 0; };
  const sgr = stats(gr), sgb = stats(gb), sl = stats(lum);
  return { sdGR: sgr.sd, sdGB: sgb.sd, sdL: sl.sd, ratioGR: sl.sd ? sgr.sd / sl.sd : 0,
    ratioGB: sl.sd ? sgb.sd / sl.sd : 0, meanL: sl.mean,
    grX1: alongX(1), grX4: alongX(4), grY1: alongY(1), grY4: alongY(4) };
}

(async function main() {
  console.log('=== 去趋势位移 + 低频失配 + 结构判据 ===\n');
  const t0 = Date.now();

  const pb = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const pinfo = Wav.parse(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
  const px_ = pinfo.samples;
  const phRefs = [];
  const pdec = await Decode.decode(px_, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: phRefs });
  const cal = pdec.calibration || {};
  const scale = Number(cal.scale), off = Number(cal.offsetHz);
  const calF = (f) => (f - off) / scale;
  console.log('标定: source=' + cal.source + ' · scale=' + scale.toFixed(6) + ' · offsetHz=' + off.toFixed(3));

  console.log('\n提取 phigros 三平面（已应用标定）…');
  const phP = planesOf(px_, phRefs, 2.48, calF);
  console.log('  完成 (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');

  // ---------------------------------------------------------------- task 1
  console.log('\n[任务 1] 去趋势（一阶差分）后的 G−R / G−B 互相关，搜索 ±160 px');
  const dGR = [], rGR = [], dGB = [], rGB = [];
  for (let y = 0; y < phP.G.length; y++) {
    const a = phP.G[y];
    const gr = detrendedShift(a, phP.R[y], 160), gb = detrendedShift(a, phP.B[y], 160);
    dGR.push(gr.d); rGR.push(gr.r); dGB.push(gb.d); rGB.push(gb.r);
  }
  const sGR = stats(dGR), sGB = stats(dGB), pGR = stats(rGR), pGB = stats(rGB);
  console.log('  G−R: 中位 ' + sGR.median + ' px · MAD ' + sGR.mad + ' · 均值 ' + sGR.mean.toFixed(1) +
    ' · 极值 ' + sGR.min + '..' + sGR.max + ' · 峰值相关中位 ' + pGR.median.toFixed(3));
  console.log('  G−B: 中位 ' + sGB.median + ' px · MAD ' + sGB.mad + ' · 均值 ' + sGB.mean.toFixed(1) +
    ' · 极值 ' + sGB.min + '..' + sGB.max + ' · 峰值相关中位 ' + pGB.median.toFixed(3));
  const hist = (a) => { const h = {}; for (const v of a) h[v] = (h[v] || 0) + 1;
    return Object.keys(h).map(Number).sort((x, y) => x - y).slice(0, 14).map((k) => k + ':' + h[k]).join('  '); };
  console.log('  G−R 分布(前 14 档): ' + hist(dGR));
  console.log('  G−B 分布(前 14 档): ' + hist(dGB));
  const nearBoundary = dGR.filter((v) => Math.abs(v) >= 150).length;
  console.log('  G−R 落在搜索边界(|δ|≥150)的行数: ' + nearBoundary + '/' + dGR.length +
    (nearBoundary > 50 ? '  ← 仍然锁边界 ✗ 去趋势未解决问题' : '  ✓ 未锁边界'));

  // ---------------------------------------------------------------- task 2
  console.log('\n[任务 2] 位移量级判定');
  console.log('  G−R 精确中位 ' + sGR.median + ' px · G−B 精确中位 ' + sGB.median + ' px');
  console.log('  参照量级: 一行 = 320 px；Scottie S1 的 G→R 时间间距 = ' +
    ((STARTS.R - STARTS.G) * 1000).toFixed(2) + ' ms = ');
  console.log('  => 若 |δ| 接近 320 → 槽起点错（采到相邻通道）；若 |δ| 小且非零 → 像素索引错；' +
    '若 δ 分散 → 无系统性位移');
  let mag;
  if (Math.abs(sGR.median) >= 280) mag = '≈一行（320 px）→ 槽起点错 ✗';
  else if (Math.abs(sGR.median) >= 2) mag = Math.abs(sGR.median) + ' px（行内像素级）→ 像素索引错 ✗';
  else mag = '中位 0 → 无系统性位移 ✓';
  console.log('  判定: ' + mag);

  // ---------------------------------------------------------------- task 3
  console.log('\n[任务 3] 逐通道低频失配检验（各通道减去本行均值）');
  const base = chromaStats(phP, false), dem = chromaStats(phP, true);
  console.log('  方案              σ(G−R)  σ(L)   σ(G−R)/σ(L)  σ(G−B)/σ(L)');
  const rowOut = (n, c) => console.log('  ' + n.padEnd(16) + c.sdGR.toFixed(1).padStart(7) +
    c.sdL.toFixed(1).padStart(7) + '   ' + c.ratioGR.toFixed(4).padStart(10) + '   ' + c.ratioGB.toFixed(4).padStart(10));
  rowOut('原样', base);
  rowOut('各通道减行均值', dem);
  console.log('  => 色度比 ' + base.ratioGR.toFixed(4) + ' → ' + dem.ratioGR.toFixed(4) +
    '（' + ((dem.ratioGR / base.ratioGR - 1) * 100).toFixed(1) + '%）' +
    (dem.ratioGR < base.ratioGR * 0.7 ? '  ← 大幅下降：色度主要来自通道间低频失配 ✗'
      : '  ← 基本不变：色度来自逐像素变化 ✓'));

  // ---------------------------------------------------------------- task 5 / 4 criterion
  console.log('\n[任务 4/5] 结构判据（校准后频率）：沿 x / 沿 y 的 G−R 自相关');
  const syn = Synth.synthesize(Timeline.build((function () {
    const w = MODE.width, h = MODE.height, d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, v = Math.round(255 * x / (w - 1));
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    return { data: d, width: w, height: h };
  })(), MODE), SR).samples;
  const synRefs = [];
  const sdec = await Decode.decode(syn, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: synRefs });
  const synCal = sdec.calibration || {};
  const synCalF = (f) => (f - Number(synCal.offsetHz)) / Number(synCal.scale);
  const synP = planesOf(syn, synRefs, 2.48, synCalF);
  const synC = chromaStats(synP, false);
  const ourImg = pngjs.PNG.sync.read(fs.readFileSync(path.join(OUT, 'new-ours.png')));
  // our decoder's OWN output as a fourth source
  const ownP = { G: [], B: [], R: [] };
  for (let y = 0; y < ourImg.height; y++) {
    const rG = [], rB = [], rR = [];
    for (let x = 0; x < ourImg.width; x++) {
      const i = (y * ourImg.width + x) * 4;
      rR.push(ourImg.data[i]); rG.push(ourImg.data[i + 1]); rB.push(ourImg.data[i + 2]);
    }
    ownP.R.push(rR); ownP.G.push(rG); ownP.B.push(rB);
  }
  const ownC = chromaStats(ownP, false);

  const refImg = pngjs.PNG.sync.read(fs.readFileSync(path.join(OUT, 'ref-robot36.png')));
  const dd = refImg.data;
  let x0 = refImg.width, x1 = -1, y0 = refImg.height, y1 = -1;
  for (let y = 0; y < refImg.height; y++) for (let xx = 0; xx < refImg.width; xx++) {
    const i = (y * refImg.width + xx) * 4;
    const mx = Math.max(dd[i], dd[i + 1], dd[i + 2]), mn = Math.min(dd[i], dd[i + 1], dd[i + 2]);
    if (mx - mn > 40) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
  const refP = { G: [], B: [], R: [] };
  for (let y = 0; y < 256; y++) {
    const rG = [], rB = [], rR = [];
    for (let xx = 0; xx < 320; xx++) {
      const sx = x0 + Math.min(cw - 1, Math.floor(xx * cw / 320));
      const sy = y0 + Math.min(chh - 1, Math.floor(y * chh / 256));
      const s = (sy * refImg.width + sx) * 4;
      rR.push(dd[s]); rG.push(dd[s + 1]); rB.push(dd[s + 2]);
    }
    refP.R.push(rR); refP.G.push(rG); refP.B.push(rB);
  }
  const refC = chromaStats(refP, false);

  console.log('  来源                  σ(G−R)  σ(L)   σ(G−R)/σ(L)  沿x(lag1)  沿y(lag1)  判据(沿y<0.3 且 沿x<0.7)');
  const full = (n, c) => {
    const ok = c.grY1 < 0.3 && c.grX1 < 0.7;
    console.log('  ' + n.padEnd(20) + c.sdGR.toFixed(1).padStart(7) + c.sdL.toFixed(1).padStart(7) +
      '   ' + c.ratioGR.toFixed(4).padStart(10) + '  ' + c.grX1.toFixed(3).padStart(9) + '  ' +
      c.grY1.toFixed(3).padStart(9) + '   ' + (ok ? '通过 ✓' : '失败 ✗'));
  };
  full('合成 S1（真值）', synC);
  full('phigros（本脚本）', base);
  full('我们的解码输出', ownC);
  full('Robot36 参照', refC);

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 判定 =====');
  console.log('  AC1 去趋势后 G−R 中位 ' + sGR.median + ' px（MAD ' + sGR.mad + '），峰值相关中位 ' +
    pGR.median.toFixed(3) + '，锁边界 ' + nearBoundary + '/' + dGR.length);
  console.log('  AC2 位移量级: ' + mag);
  console.log('  AC3 低频失配: 减均值后色度比 ' + dem.ratioGR.toFixed(4) + '（原 ' + base.ratioGR.toFixed(4) + '）');
  console.log('  AC5 结构: phigros 沿x ' + base.grX1.toFixed(3) + ' 沿y ' + base.grY1.toFixed(3) +
    ' · 参照 沿x ' + refC.grX1.toFixed(3) + ' 沿y ' + refC.grY1.toFixed(3));
  let root;
  if (pGR.median < 0.3) {
    root = '【去趋势后 G−R 不相关】峰值相关 ' + pGR.median.toFixed(3) +
      ' < 0.3 → G 与 R 逐像素无关 ✗ 结合"色度是低频失配"的检验结果可定位机制';
  } else if (Math.abs(sGR.median) >= 2) {
    root = '【存在系统性位移 ' + sGR.median + ' px】→ ' + mag;
  } else {
    root = '【无系统性位移】色度结构错来自通道间的低频/增益失配，而非几何位移 ✗';
  }
  console.log('  AC6 根因: ' + root);

  fs.writeFileSync(path.join(OUT, 'detrend-shift.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    calibration: { source: cal.source, scale: scale, offsetHz: off },
    detrendedShift: { GR: sGR, GB: sGB, peakCorrGR: pGR, peakCorrGB: pGB,
      boundaryLockGR: nearBoundary, perLineGR: dGR, perLineGB: dGB },
    lowFreqMismatch: { raw: base, demeaned: dem },
    structure: { synthetic: synC, phigros: base, ours: ownC, robot36: refC,
      criterion: { maxGrY1: 0.3, maxGrX1: 0.7 } },
    magnitude: mag, rootCause: root
  }, null, 2));
  console.log('\n  总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  console.log('  证据 -> tests/diag-quality/detrend-shift.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
