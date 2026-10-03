/*
 * Are the three colour planes aligned? Measuring the inter-channel pixel shift directly.
 *
 * WHY
 *   Phase 38 established that "no colour" is really "too much colour, structured wrongly": the real
 *   recording gives sigma(G-R) = 94.6 grey levels against sigma(L) = 65.3, i.e. a chroma/luma ratio of
 *   1.45 where a normal image sits below 1, and it looks like row-coherent magenta/cyan banding rather
 *   than picture content. The leading explanation is that the G, B and R slots sample the right band
 *   but not the same image geometry, so this measures the shift between the planes instead of arguing
 *   about it.
 *
 * WHAT IT MEASURES
 *   [1] For every line, the zero-mean normalised cross-correlation of the G plane against R and B for
 *       displacements -20..+20 px, and the argmax. A constant shift is a geometry error; a per-line
 *       varying shift is an instability.
 *   [2] Chroma after compensating by the median (and, separately, by the per-line) shift.
 *   [3] Structure along x and along y for the chroma image, on all three sources - the discriminator
 *       phase 38 was missing, since row-coherent NOISE also scores high on an inter-row metric.
 *   [4] The channel start spacing actually in use, against the standard Scottie S1 layout.
 *
 * Uses the brute-force DFT validated in phase 37 (5.3 Hz mean error on a known ramp).
 *
 * Usage: node tests/diagnose-channel-shift.js
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
const greyOf = (f) => Math.max(0, Math.min(255, Math.round(255 * (f - 1500) / 800)));

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

/** Full-resolution grey planes for one source. */
function planesOf(x, refs, winPx) {
  const len = Math.max(16, Math.round(PIXEL * winPx));
  const P = { G: [], B: [], R: [] };
  for (let i = 0; i < refs.length; i++) {
    for (const role of ['G', 'B', 'R']) {
      const s0 = refs[i].ref + STARTS[role] * SR, row = [];
      for (let px = 0; px < MODE.width; px++) row.push(greyOf(dftAt(x, Math.round(s0 + (px + 0.5) * PIXEL), len)));
      P[role].push(row);
    }
  }
  return P;
}

/** Zero-mean normalised cross-correlation of a against b at displacement d. */
function xcorr(a, b, d) {
  const n = a.length;
  let ma = 0, mb = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const j = i + d;
    if (j < 0 || j >= n) continue;
    ma += a[i]; mb += b[j]; cnt++;
  }
  if (cnt < 16) return 0;
  ma /= cnt; mb /= cnt;
  let nu = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const j = i + d;
    if (j < 0 || j >= n) continue;
    const u = a[i] - ma, v = b[j] - mb;
    nu += u * v; da += u * u; db += v * v;
  }
  return (da > 0 && db > 0) ? nu / Math.sqrt(da * db) : 0;
}
function bestShift(a, b, maxD) {
  let bd = 0, bv = -2;
  for (let d = -maxD; d <= maxD; d++) { const v = xcorr(a, b, d); if (v > bv) { bv = v; bd = d; } }
  return { d: bd, r: bv };
}

/** Chroma statistics with optional per-plane integer shifts. */
function chromaStats(P, sh) {
  const H = P.G.length, W = P.G[0].length;
  const sg = sh || { R: 0, B: 0 };
  const gr = [], gb = [], lum = [];
  const rowsGR = [], rowsGB = [];
  for (let y = 0; y < H; y++) {
    const rGR = new Float64Array(W), rGB = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      const G = P.G[y][x];
      const rx = x + sg.R, bx = x + sg.B;
      const R = (rx >= 0 && rx < W) ? P.R[y][rx] : G;
      const B = (bx >= 0 && bx < W) ? P.B[y][bx] : G;
      gr.push(G - R); gb.push(G - B); lum.push((R + G + B) / 3);
      rGR[x] = G - R; rGB[x] = G - B;
    }
    rowsGR.push(rGR); rowsGB.push(rGB);
  }
  const corrVec = (a, b) => {
    const n = Math.min(a.length, b.length);
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let nu = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; nu += u * v; da += u * u; db += v * v; }
    return (da > 0 && db > 0) ? nu / Math.sqrt(da * db) : 0;
  };
  const alongX = (rows, lag) => { let s = 0, n = 0; for (const r of rows) { s += corrVec(Array.from(r.slice(0, r.length - lag)), Array.from(r.slice(lag))); n++; } return n ? s / n : 0; };
  const alongY = (rows, lag) => { let s = 0, n = 0; for (let y = 0; y + lag < rows.length; y++) { s += corrVec(Array.from(rows[y]), Array.from(rows[y + lag])); n++; } return n ? s / n : 0; };
  const sgr = stats(gr), sgb = stats(gb), sl = stats(lum);
  return { sdGR: sgr.sd, sdGB: sgb.sd, sdL: sl.sd, ratioGR: sl.sd ? sgr.sd / sl.sd : 0,
    ratioGB: sl.sd ? sgb.sd / sl.sd : 0, meanL: sl.mean,
    grX: [1, 2, 4, 8].map((l) => alongX(rowsGR, l)), grY: [1, 2, 4, 8].map((l) => alongY(rowsGR, l)),
    gbX: [1, 2, 4, 8].map((l) => alongX(rowsGB, l)), gbY: [1, 2, 4, 8].map((l) => alongY(rowsGB, l)) };
}

(async function main() {
  console.log('=== 通道间像素偏移 ===\n');
  const t0 = Date.now();

  const pb = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const pinfo = Wav.parse(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
  const px_ = pinfo.samples;
  const phRefs = [];
  const pdec = await Decode.decode(px_, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: phRefs });
  const cal = pdec.calibration || {};
  console.log('phigros 解码: clockScale=' + Number(cal.clockScale).toFixed(6) +
    ' · source=' + cal.source + ' · 行间相关=' +
    (function () { const im = pdec.imageData, w = im.width, h = im.height, d = im.data; let s = 0, n = 0;
      for (let y = 0; y + 1 < h; y++) { let ma = 0, mb = 0;
        for (let x = 0; x < w; x++) { ma += d[(y * w + x) * 4 + 1]; mb += d[((y + 1) * w + x) * 4 + 1]; }
        ma /= w; mb /= w; let nu = 0, da = 0, db = 0;
        for (let x = 0; x < w; x++) { const u = d[(y * w + x) * 4 + 1] - ma, v = d[((y + 1) * w + x) * 4 + 1] - mb; nu += u * v; da += u * u; db += v * v; }
        if (da > 0 && db > 0) { s += nu / Math.sqrt(da * db); n++; } } return (s / n).toFixed(4); })());

  console.log('\n提取 phigros 全分辨率三平面（320 px × 256 行 × 3 槽）…');
  const phP = planesOf(px_, phRefs, 2.48);
  console.log('  完成 (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');

  // ---------------------------------------------------------------- task 1
  console.log('\n[任务 1] 逐行通道互相关（δ ∈ [−20, 20]，零均值归一化）');
  const dGR = [], dGB = [], rGR = [], rGB = [];
  for (let y = 0; y < phP.G.length; y++) {
    const a = phP.G[y], r = bestShift(a, phP.R[y], 20), b = bestShift(a, phP.B[y], 20);
    dGR.push(r.d); rGR.push(r.r); dGB.push(b.d); rGB.push(b.r);
  }
  const sGR = stats(dGR), sGB = stats(dGB), sRGR = stats(rGR), sRGB = stats(rGB);
  console.log('  G-R 位移: 中位 ' + sGR.median + ' px · MAD ' + sGR.mad + ' · 均值 ' + sGR.mean.toFixed(2) +
    ' · 极值 ' + sGR.min + '..' + sGR.max + ' · 峰值相关中位 ' + sRGR.median.toFixed(3));
  console.log('  G-B 位移: 中位 ' + sGB.median + ' px · MAD ' + sGB.mad + ' · 均值 ' + sGB.mean.toFixed(2) +
    ' · 极值 ' + sGB.min + '..' + sGB.max + ' · 峰值相关中位 ' + sRGB.median.toFixed(3));
  const hist = (a) => { const h = {}; for (const v of a) h[v] = (h[v] || 0) + 1;
    return Object.keys(h).map(Number).sort((x, y) => x - y).map((k) => k + ':' + h[k]).join(' '); };
  console.log('  G-R 位移分布: ' + hist(dGR));
  console.log('  G-B 位移分布: ' + hist(dGB));
  console.log('  逐行位移曲线（每字符 1 行；0 用 "."，正用分档数字）');
  for (const [nm, arr] of [['G-R', dGR], ['G-B', dGB]]) {
    let s = '';
    for (const v of arr) s += v === 0 ? '.' : (Math.abs(v) <= 2 ? '1' : (Math.abs(v) <= 5 ? '2' : (Math.abs(v) <= 10 ? '3' : '4')));
    console.log('  ' + nm + ' ' + s);
  }
  const sysGR = Math.abs(sGR.median) >= 1, sysGB = Math.abs(sGB.median) >= 1;
  console.log('  => ' + ((sysGR || sysGB)
    ? '存在系统性偏移 ✗（G-R ' + sGR.median + ' px, G-B ' + sGB.median + ' px）'
    : '位移中位数为 0 → 通道对齐正确 ✓，"结构错"另有机制'));

  // ---------------------------------------------------------------- task 2
  console.log('\n[任务 2] 补偿后色度');
  const base = chromaStats(phP, { R: 0, B: 0 });
  const comp = chromaStats(phP, { R: -sGR.median, B: -sGB.median });
  const perLine = { R: [], B: [], G: [] };
  for (let y = 0; y < phP.G.length; y++) {
    perLine.G.push(phP.G[y]);
    const rs = new Array(320), bs = new Array(320);
    for (let x = 0; x < 320; x++) {
      const rx = x - dGR[y], bx = x - dGB[y];
      rs[x] = (rx >= 0 && rx < 320) ? phP.R[y][rx] : phP.G[y][x];
      bs[x] = (bx >= 0 && bx < 320) ? phP.B[y][bx] : phP.G[y][x];
    }
    perLine.R.push(rs); perLine.B.push(bs);
  }
  const compLine = chromaStats(perLine, { R: 0, B: 0 });
  console.log('  方案                σ(G−R)  σ(L)   σ(G−R)/σ(L)  G−R 行内(lag1)  G−R 行间(lag1)');
  const rowOut = (n, c) => console.log('  ' + n.padEnd(20) + c.sdGR.toFixed(1).padStart(7) +
    c.sdL.toFixed(1).padStart(7) + '   ' + c.ratioGR.toFixed(4).padStart(10) + '   ' +
    c.grX[0].toFixed(4).padStart(11) + '   ' + c.grY[0].toFixed(4).padStart(13));
  rowOut('原样', base);
  rowOut('按中位补偿', comp);
  rowOut('逐行补偿', compLine);

  // ---------------------------------------------------------------- task 3
  console.log('\n[任务 3] 行内 / 行间色差自相关（补上阶段三十八的缺口）');
  const syn = Synth.synthesize(Timeline.build((function () {
    const w = MODE.width, h = MODE.height, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, v = Math.round(255 * x / (w - 1));
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    return { data: data, width: w, height: h };
  })(), MODE), SR).samples;
  const synRefs = [];
  await Decode.decode(syn, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: synRefs });
  const synP = planesOf(syn, synRefs, 2.48);
  const synC = chromaStats(synP, { R: 0, B: 0 });

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
  const refC = chromaStats(refP, { R: 0, B: 0 });

  console.log('  来源            σ(G−R)  σ(L)   σ(G−R)/σ(L)  G−R 沿x(lag1/2/4/8)          G−R 沿y(lag1/2/4/8)');
  const full = (n, c) => console.log('  ' + n.padEnd(15) + c.sdGR.toFixed(1).padStart(7) +
    c.sdL.toFixed(1).padStart(7) + '   ' + c.ratioGR.toFixed(4).padStart(10) + '   ' +
    c.grX.map((v) => v.toFixed(2)).join('/').padEnd(22) + ' ' + c.grY.map((v) => v.toFixed(2)).join('/'));
  full('合成 S1（真值）', synC);
  full('phigros', base);
  full('phigros 补偿后', comp);
  full('Robot36 参照', refC);

  // ---------------------------------------------------------------- task 4
  console.log('\n[任务 4] 三通道采样起点与标准对比');
  console.log('  通道  相对同步起点(ms)  采样间距(ms, 相邻)');
  const order = ['G', 'B', 'R'];
  for (let i = 0; i < order.length; i++) {
    const role = order[i];
    console.log('  ' + role + '   ' + (STARTS[role] * 1000).toFixed(2).padStart(17) +
      (i ? '  ' + ((STARTS[role] - STARTS[order[i - 1]]) * 1000).toFixed(2).padStart(16) : '  ' + '—'.padStart(16)));
  }
  console.log('  标准间距: 相邻扫描间隔 = sep(' + (SEP * 1000).toFixed(2) + ') + scan(' +
    (SCAN * 1000).toFixed(2) + ') = ' + ((SEP + SCAN) * 1000).toFixed(2) + ' ms');
  console.log('  实测 G→B ' + ((STARTS.B - STARTS.G) * 1000).toFixed(2) + ' ms · B→R ' +
    ((STARTS.R - STARTS.B) * 1000).toFixed(2) + ' ms');
  console.log('  => G→B ' + (((SEP + SCAN) * 1000 - (STARTS.B - STARTS.G) * 1000).toFixed(2)) +
    ' ms 差（一个分隔 + 一个扫描应为 ' + ((SEP + SCAN) * 1000).toFixed(2) + ' ms）' +
    ' · 与标准 ' + (((STARTS.B - STARTS.G) * 1000) === ((SEP + SCAN) * 1000) ? '一致 ✓' : '不一致 ✗'));
  console.log('  生产 chanOffsets: scottie = [base+chanTime, base+2·chanTime, base]' +
    '（base = sync+porch, chanTime = sep+scan）');

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 判定 =====');
  console.log('  AC1 位移: G-R 中位 ' + sGR.median + ' (MAD ' + sGR.mad + ') · G-B 中位 ' + sGB.median +
    ' (MAD ' + sGB.mad + ')');
  console.log('  AC2 系统性偏移: ' + ((sysGR || sysGB) ? '有 ✗' : '无 ✓'));
  console.log('  AC3 补偿前 σ(G−R)/σ(L) = ' + base.ratioGR.toFixed(4) + ' → 中位补偿后 ' +
    comp.ratioGR.toFixed(4) + ' → 逐行补偿后 ' + compLine.ratioGR.toFixed(4));
  console.log('  AC4 行内(lag1) vs 行间(lag1): phigros ' + base.grX[0].toFixed(3) + ' / ' +
    base.grY[0].toFixed(3) + ' · 参照 ' + refC.grX[0].toFixed(3) + ' / ' + refC.grY[0].toFixed(3));
  let verdict;
  if (comp.ratioGR < 1 && base.ratioGR >= 1) {
    verdict = '【偏移是根因】补偿后色度比降到 1 以下 ✓ 应改 chanOffsets';
  } else if (!sysGR && !sysGB) {
    verdict = '【通道对齐正确】位移中位数为 0 ✗ → "结构错"不是通道间像素偏移造成的';
  } else {
    verdict = '【偏移存在但补偿不足】中位补偿后仍 ' + comp.ratioGR.toFixed(2) + ' ✗ → 结构错另有机制';
  }
  console.log('  判定: ' + verdict);
  console.log('\n  总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

  fs.writeFileSync(path.join(OUT, 'channel-shift.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    shiftGR: sGR, shiftGB: sGB, peakCorrGR: sRGR, peakCorrGB: sRGB,
    shiftGRPerLine: dGR, shiftGBPerLine: dGB,
    chroma: { base: base, medianCompensated: comp, perLineCompensated: compLine,
      synthetic: synC, robot36: refC },
    channelStartsMs: STARTS, standardSpacingMs: (SEP + SCAN) * 1000, verdict: verdict
  }, null, 2));
  console.log('  证据 -> tests/diag-quality/channel-shift.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
