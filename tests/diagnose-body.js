/*
 * Inside transmission B: which slot has no tone, on which lines, and is the chroma structured?
 *
 * PHASE 33 ESTABLISHED
 *   The decoder's segment choice is correct (it skipped the 103-line transmission A and started at
 *   transmission B, 48.285 s), so the colour failure is INSIDE the body. The phase-30/31/32 metrics
 *   could not localise it: per-pixel saturation is dominated by independent noise between the three
 *   planes, so "colour noise" and "colour content" score the same. This measures two things the
 *   earlier rounds could not:
 *
 *   [1] PROMINENCE per line per slot - the peak-to-median ratio of the Hann-FFT magnitude over
 *       1000..2400 Hz. A slot sitting on real image content shows a clear tone (prominence high); a
 *       slot sitting on silence or on a smeared boundary does not. Reported as a per-line curve so
 *       the bad region is visible rather than sampled.
 *
 *   [2] STRUCTURED CHROMA - the adjacent-row correlation of the chroma image (G-R). Chroma that is
 *       real content stays correlated from row to row; chroma that is independent noise does not.
 *       This is the discriminator the saturation metric lacked.
 *
 * ALSO FIXES THREE SCRIPT DEFECTS FOUND IN PHASE 33
 *   - peakFreq searched the WHOLE spectrum and locked onto DC (11.7 Hz) or music (~1075 Hz), which
 *     made every header check in that round void.
 *   - the segment interval was printed as a MEAN, which gaps inflate (486 ms against a 428.22 ms
 *     grid whose MAD was 0.64 ms). The median is printed now.
 *   - segments were split at 2x the line period, which cut transmission B in two across a 0.86 s
 *     detection gap. Now 3x.
 *
 * Usage: node tests/diagnose-body.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000, DECIM = Math.round(0.00025 * SR);
const FFT_PAD = 512;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, FFT = globalThis.FFT;
const MODE = Modes.get('S1');
const NOMINAL_LINE = Modes.lineTime(MODE) * SR;
const LINE_MS = NOMINAL_LINE / SR * 1000;
const SCAN = MODE.scanTime, SEP = MODE.sepPulse;
const PIXEL = SCAN / MODE.width * SR;
const WIN = Math.round(PIXEL * 2.48);
const HANN = new Float64Array(WIN);
for (let i = 0; i < WIN; i++) HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (WIN - 1)));

let pngjs = null;
try { pngjs = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); } catch (e) {}

const BAND_LO = 1000, BAND_HI = 2400;   // FIX 1: the search band, not the whole spectrum

const fftCache = {};
/** Peak frequency and prominence inside [BAND_LO, BAND_HI] only. */
function probe(x, at) {
  const n = FFT_PAD;
  let e = fftCache[n];
  if (!e) { e = { fft: new FFT(n), out: new Float32Array(2 * n) }; fftCache[n] = e; }
  const data = new Float32Array(2 * n), half = WIN >> 1;
  for (let i = 0; i < WIN; i++) { const j = at - half + i; if (j >= 0 && j < x.length) data[2 * i] = x[j] * HANN[i]; }
  e.fft.realTransform(e.out, data);
  e.fft.completeSpectrum(e.out);
  const m = e.out, bins = n / 2 + 1;
  const kLo = Math.max(1, Math.ceil(BAND_LO * n / SR));
  const kHi = Math.min(bins - 2, Math.floor(BAND_HI * n / SR));
  let bk = kLo, bv = -1;
  const vals = [];
  for (let k = kLo; k <= kHi; k++) {
    const mag = Math.sqrt(m[2 * k] * m[2 * k] + m[2 * k + 1] * m[2 * k + 1]);
    vals.push(mag);
    if (mag > bv) { bv = mag; bk = k; }
  }
  const magOf = (k) => Math.sqrt(m[2 * k] * m[2 * k] + m[2 * k + 1] * m[2 * k + 1]);
  const m0 = magOf(bk - 1), m1 = bv, m2 = magOf(bk + 1);
  const d = m0 - 2 * m1 + m2, sh = d === 0 ? 0 : 0.5 * (m0 - m2) / d;
  vals.sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)] || 1e-9;
  return { hz: (bk + sh) * SR / n, prom: bv / med };
}

/** FIX 1 applied to the standalone leader probe as well. */
function peakFreq(x, at, len, fftSize) {
  const n = fftSize || 2048;
  const fft = new FFT(n), out = new Float32Array(2 * n), data = new Float32Array(2 * n);
  const H = new Float64Array(len);
  for (let i = 0; i < len; i++) H[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
  for (let i = 0; i < len; i++) { const j = at + i; if (j >= 0 && j < x.length) data[2 * i] = x[j] * H[i]; }
  fft.realTransform(out, data); fft.completeSpectrum(out);
  const bins = n / 2 + 1;
  const kLo = Math.max(1, Math.ceil(1000 * n / SR)), kHi = Math.min(bins - 2, Math.floor(2400 * n / SR));
  let bk = kLo, bv = -1;
  const mag = (k) => Math.sqrt(out[2 * k] * out[2 * k] + out[2 * k + 1] * out[2 * k + 1]);
  for (let k = kLo; k <= kHi; k++) { const v = mag(k); if (v > bv) { bv = v; bk = k; } }
  const m0 = mag(bk - 1), m1 = bv, m2 = mag(bk + 1);
  const d = m0 - 2 * m1 + m2, sh = d === 0 ? 0 : 0.5 * (m0 - m2) / d;
  return (bk + sh) * SR / n;
}

function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of s) sum += v;
  return { n: s.length, median: med, mad: mad, mean: sum / s.length };
}

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
  const pulses = []; let run = -1;
  for (let k = 0; k < n; k++) {
    const on = env[0][k] > 1.4 * Math.max(env[1][k], env[2][k], env[3][k], 1e-4);
    if (on && run < 0) run = k;
    else if (!on && run >= 0) {
      if (k - run >= MINRUN && k - run <= MAXRUN) {
        let best = -1, bk = run;
        for (let q = run; q < k; q++) if (env[0][q] > best) { best = env[0][q]; bk = q; }
        pulses.push((bk + 0.5) * msPerBin / 1000);
      }
      run = -1;
    }
  }
  return pulses.sort((a, b) => a - b);
}

/** Adjacent-row correlation of a chroma plane -- the structure-aware colour metric. */
function chromaRowCorr(planes, a, b) {
  // planes: {G:[[..]], R:[[..]]} in grey levels; chroma = a - b per pixel
  const H = planes[a].length, W = planes[a][0].length;
  const ch = [];
  for (let y = 0; y < H; y++) {
    const row = new Float64Array(W);
    for (let x = 0; x < W; x++) row[x] = planes[a][y][x] - planes[b][y][x];
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

function greyOf(hz) { return Math.max(0, Math.min(255, Math.round(255 * (hz - 1500) / 800))); }

(async function main() {
  const b = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const info = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const x = info.samples;
  console.log('=== 传输 B 内部诊断 ===\n');

  // ---------------------------------------------------------------- FIX 3 (3x) + FIX 2 (median)
  const pulses = detectSyncs(x, SR);
  const segs = [];
  let cur = [pulses[0]];
  for (let i = 1; i < pulses.length; i++) {
    if ((pulses[i] - pulses[i - 1]) * 1000 > 3 * LINE_MS) { segs.push(cur); cur = []; }   // FIX 3
    cur.push(pulses[i]);
  }
  if (cur.length) segs.push(cur);
  console.log('[修 2/3] 切段阈值 3× 行周期 = ' + (3 * LINE_MS).toFixed(1) + ' ms');
  console.log('  段  起始(s)    结束(s)   跨度(s)  原始脉冲  间隔中位(ms)  MAD(ms)  平均(ms)');
  const segRows = [];
  for (let i = 0; i < segs.length; i++) {
    const dif = [];
    for (let k = 1; k < segs[i].length; k++) dif.push((segs[i][k] - segs[i][k - 1]) * 1000);
    const st = stats(dif);
    segRows.push({ seg: i + 1, t0: segs[i][0], t1: segs[i][segs[i].length - 1], n: segs[i].length, st: st });
    console.log('  ' + String(i + 1).padStart(2) + '  ' + segs[i][0].toFixed(3).padStart(9) + ' ' +
      segs[i][segs[i].length - 1].toFixed(3).padStart(9) + ' ' +
      (segs[i][segs[i].length - 1] - segs[i][0]).toFixed(3).padStart(8) + ' ' +
      String(segs[i].length).padStart(8) + '  ' +
      (st ? st.median.toFixed(3) : '-').padStart(11) + ' ' + (st ? st.mad.toFixed(3) : '-').padStart(8) +
      '  ' + (st ? st.mean.toFixed(3) : '-').padStart(8));
  }
  console.log('  （中位数才是真实行周期；均值被缺脉冲空档抬高 ✗ 修 2）');

  // ---------------------------------------------------------------- header check (FIX 1)
  console.log('\n[修 1] 前导音核对（峰值搜索限带 1000–2400 Hz）');
  console.log('  段   前导音频率(Hz)          break 频率(Hz)   判定');
  for (const r of segRows) {
    const f1 = peakFreq(x, Math.round((r.t0 - 1.5) * SR), Math.round(0.25 * SR), 4096);
    const f2 = peakFreq(x, Math.round((r.t0 - 0.9) * SR), Math.round(0.25 * SR), 4096);
    const fb = peakFreq(x, Math.round((r.t0 - 1.2) * SR), Math.round(0.05 * SR), 4096);
    r.leader = [f1, f2, fb];
    const ok = (Math.abs(f1 - 1900) < 60 || Math.abs(f2 - 1900) < 60) && Math.abs(fb - 1200) < 80;
    r.hasHeader = ok;
    console.log('  ' + String(r.seg).padStart(2) + '   ' + f1.toFixed(1).padStart(7) + ' / ' +
      f2.toFixed(1).padStart(7) + '    ' + fb.toFixed(1).padStart(8) + '      ' +
      (ok ? '有前导 ✓' : '无前导 ✗'));
  }

  // ---------------------------------------------------------------- the body of transmission B
  const refs = [];
  const dec = await Decode.decode(x, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  const cal = dec.calibration || {};
  console.log('\n解码器 imageStart=' + (cal.imageStart / SR).toFixed(3) + ' s · 行 0=' +
    (refs[0].ref / SR).toFixed(3) + ' s · 行 ' + (refs.length - 1) + '=' +
    (refs[refs.length - 1].ref / SR).toFixed(3) + ' s');

  const STARTS = { G: -(2 * SEP + 2 * SCAN) + SEP, B: -SCAN, R: (MODE.syncPulse + MODE.syncPorch) };
  const NSAMP = 32;                       // evenly spaced probes per slot per line
  console.log('\n[任务 2] 传输 B 内部逐行三槽 prominence（每槽 ' + NSAMP + ' 个均匀探针）');
  console.log('  槽起点(相对同步, ms): G ' + (STARTS.G * 1000).toFixed(2) + ' · B ' +
    (STARTS.B * 1000).toFixed(2) + ' · R ' + (STARTS.R * 1000).toFixed(2));
  const t0 = Date.now();
  const perLine = [];
  for (let i = 0; i < refs.length; i++) {
    const rec = { line: i, ref: refs[i].ref, slots: {} };
    for (const role of ['G', 'B', 'R']) {
      const s0 = refs[i].ref + STARTS[role] * SR;
      let ps = 0, hs = 0, hz = [];
      for (let k = 0; k < NSAMP; k++) {
        const px = Math.floor((k + 0.5) * MODE.width / NSAMP);
        const pr = probe(x, Math.round(s0 + (px + 0.5) * PIXEL));
        ps += pr.prom; hs += pr.hz; hz.push(pr.hz);
      }
      hz.sort((a, b2) => a - b2);
      rec.slots[role] = { prom: ps / NSAMP, hzMean: hs / NSAMP, hzMed: hz[Math.floor(hz.length / 2)],
        hzMin: hz[0], hzMax: hz[hz.length - 1] };
    }
    perLine.push(rec);
  }
  console.log('  完成 (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');

  console.log('\n  行号  G: prom  中位Hz   B: prom  中位Hz   R: prom  中位Hz');
  for (let i = 0; i < refs.length; i += 8) {
    const r = perLine[i];
    console.log('  ' + String(i).padStart(4) + '  ' +
      r.slots.G.prom.toFixed(1).padStart(7) + ' ' + r.slots.G.hzMed.toFixed(0).padStart(7) + '  ' +
      r.slots.B.prom.toFixed(1).padStart(7) + ' ' + r.slots.B.hzMed.toFixed(0).padStart(7) + '  ' +
      r.slots.R.prom.toFixed(1).padStart(7) + ' ' + r.slots.R.hzMed.toFixed(0).padStart(7));
  }

  console.log('\n  全帧 prominence 曲线（每字符 = 1 行；. <2  : <4  o <8  O <16  # >=16）');
  for (const role of ['G', 'B', 'R']) {
    let s = '';
    for (const r of perLine) {
      const p = r.slots[role].prom;
      s += p < 2 ? '.' : (p < 4 ? ':' : (p < 8 ? 'o' : (p < 16 ? 'O' : '#')));
    }
    console.log('  ' + role + ' ' + s);
  }

  console.log('\n  全帧中位频率曲线（每字符 = 1 行；<1400 用 '<'，1400-1700 用 '-'，>1700 用 '+')');
  for (const role of ['G', 'B', 'R']) {
    let s = '';
    for (const r of perLine) {
      const f = r.slots[role].hzMed;
      s += f < 1400 ? '<' : (f < 1700 ? '-' : '+');
    }
    console.log('  ' + role + ' ' + s);
  }

  // ---------------------------------------------------------------- location of the anomaly
  console.log('\n[任务 3 / AC5] 异常定位');
  for (const role of ['G', 'B', 'R']) {
    const proms = perLine.map((r) => r.slots[role].prom);
    const st = stats(proms);
    const low = perLine.filter((r) => r.slots[role].prom < 4).map((r) => r.line);
    const hz = perLine.map((r) => r.slots[role].hzMed);
    const hst = stats(hz);
    console.log('  ' + role + ' 槽: prominence 中位 ' + st.median.toFixed(2) + ' (MAD ' +
      st.mad.toFixed(2) + ', 极值 ' + Math.min.apply(null, proms).toFixed(1) + '..' +
      Math.max.apply(null, proms).toFixed(1) + ') · promin<4 的行数 ' + low.length + '/' + perLine.length);
    console.log('        中位频率 中位 ' + hst.median.toFixed(1) + ' Hz (MAD ' + hst.mad.toFixed(1) +
      ', 极值 ' + Math.min.apply(null, hz).toFixed(0) + '..' + Math.max.apply(null, hz).toFixed(0) + ')');
  }

  // frequency histogram per slot: does B/R sit on the separator?
  console.log('\n  [AC6] 各槽中位频率的分布（判断 B/R 是否落在分隔音 1500 Hz / 同步 1200 Hz 上）');
  const edges = [0, 1250, 1350, 1450, 1550, 1650, 1800, 2000, 2200, 4000];
  console.log('    区间(Hz)      G 行数   B 行数   R 行数');
  for (let e = 0; e < edges.length - 1; e++) {
    let cg = 0, cb = 0, cr = 0;
    for (const r of perLine) {
      const inb = (f) => f >= edges[e] && f < edges[e + 1];
      if (inb(r.slots.G.hzMed)) cg++;
      if (inb(r.slots.B.hzMed)) cb++;
      if (inb(r.slots.R.hzMed)) cr++;
    }
    console.log('    ' + String(edges[e] + '-' + edges[e + 1]).padEnd(13) + String(cg).padStart(5) +
      String(cb).padStart(8) + String(cr).padStart(8));
  }

  // ---------------------------------------------------------------- structure-aware chroma
  console.log('\n[任务 3 / AC7] 结构感知色度：色差图的相邻行相关（结构化色度 >> 0，噪声 ≈ 0）');
  const planes = { R: [], G: [], B: [] };
  for (let i = 0; i < refs.length; i++) {
    for (const role of ['R', 'G', 'B']) {
      const s0 = refs[i].ref + STARTS[role] * SR;
      const row = [];
      for (let px = 0; px < MODE.width; px++) {
        const hz = probe(x, Math.round(s0 + (px + 0.5) * PIXEL)).hz;
        row.push(greyOf(hz));
      }
      planes[role].push(row);
    }
  }
  const srcGR = chromaRowCorr(planes, 'G', 'R');
  const srcBR = chromaRowCorr(planes, 'B', 'R');
  const srcGB = chromaRowCorr(planes, 'G', 'B');
  console.log('  源平面(音频):  G-R ' + srcGR.toFixed(4) + ' · G-B ' + srcGB.toFixed(4) + ' · B-R ' + srcBR.toFixed(4));

  /** Same metric on an RGBA image. */
  function imgPlanes(img) {
    const P = { R: [], G: [], B: [] };
    for (let y = 0; y < img.height; y++) {
      for (const c of ['R', 'G', 'B']) {
        const row = [];
        const off = c === 'R' ? 0 : (c === 'G' ? 1 : 2);
        for (let xx = 0; xx < img.width; xx++) row.push(img.data[(y * img.width + xx) * 4 + off]);
        P[c].push(row);
      }
    }
    return P;
  }
  const ourImg = pngjs.PNG.sync.read(fs.readFileSync(path.join(OUT, 'new-ours.png')));
  const op = imgPlanes(ourImg);
  console.log('  我们的输出:    G-R ' + chromaRowCorr(op, 'G', 'R').toFixed(4) + ' · G-B ' +
    chromaRowCorr(op, 'G', 'B').toFixed(4) + ' · B-R ' + chromaRowCorr(op, 'B', 'R').toFixed(4));

  const refImg = pngjs.PNG.sync.read(fs.readFileSync(path.join(OUT, 'ref-robot36.png')));
  // resize to 320x256 with the bbox of colourful content, same as phase 32
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
  console.log('  Robot36 参照:  G-R ' + chromaRowCorr(rp, 'G', 'R').toFixed(4) + ' · G-B ' +
    chromaRowCorr(rp, 'G', 'B').toFixed(4) + ' · B-R ' + chromaRowCorr(rp, 'B', 'R').toFixed(4));

  // ---------------------------------------------------------------- verdict
  const gProm = stats(perLine.map((r) => r.slots.G.prom));
  const bProm = stats(perLine.map((r) => r.slots.B.prom));
  const rProm = stats(perLine.map((r) => r.slots.R.prom));
  console.log('\n===== 结论 =====');
  console.log('  prominence 中位: G ' + gProm.median.toFixed(2) + ' · B ' + bProm.median.toFixed(2) +
    ' · R ' + rProm.median.toFixed(2));
  const worst = gProm.median <= bProm.median ? 'G' : (bProm.median <= rProm.median ? 'B' : 'R');
  console.log('  → 最缺音调的槽: ' + worst);
  console.log('  结构感知色度 G-R: 源 ' + srcGR.toFixed(4) + ' · 我们 ' +
    chromaRowCorr(op, 'G', 'R').toFixed(4) + ' · 参照 ' + chromaRowCorr(rp, 'G', 'R').toFixed(4));
  console.log('  → ' + (srcGR < 0.15
    ? '源头的色度【没有结构】(≈0) → 色度是噪声，不是内容 ✗ 这就是"没色"的机制'
    : '源头色度有结构 ✓ → 问题在后续环节'));

  fs.writeFileSync(path.join(OUT, 'body.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    fixes: { bandHz: [BAND_LO, BAND_HI], intervalStatistic: 'median', splitThresholdLines: 3 },
    segments: segRows.map((r) => ({ seg: r.seg, startS: r.t0, endS: r.t1, raw: r.n,
      medianIntervalMs: r.st ? r.st.median : null, madMs: r.st ? r.st.mad : null,
      meanIntervalMs: r.st ? r.st.mean : null, leaderHz: r.leader, hasHeader: r.hasHeader })),
    perLine: perLine.map((r) => ({ line: r.line,
      G: { prom: +r.slots.G.prom.toFixed(2), hzMed: +r.slots.G.hzMed.toFixed(1) },
      B: { prom: +r.slots.B.prom.toFixed(2), hzMed: +r.slots.B.hzMed.toFixed(1) },
      R: { prom: +r.slots.R.prom.toFixed(2), hzMed: +r.slots.R.hzMed.toFixed(1) } })),
    prominenceMedians: { G: gProm.median, B: bProm.median, R: rProm.median },
    chromaRowCorr: { sourceGR: srcGR, sourceGB: srcGB, sourceBR: srcBR,
      oursGR: chromaRowCorr(op, 'G', 'R'), refGR: chromaRowCorr(rp, 'G', 'R') }
  }, null, 2));
  console.log('\n证据 -> tests/diag-quality/body.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
