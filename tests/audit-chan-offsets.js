/*
 * Channel-offset audit: does the decoder sample the channel slots the encoder actually wrote?
 *
 * WHY A BLACK-BOX PROBE
 *   The open question from phase 23 is whether the Scottie `chanOffsets` convention (which puts G
 *   and B AFTER the mid-line sync) is on the wrong side of the sync. Reading the arithmetic is how
 *   the previous two rounds went wrong, so this measures it instead: the three channels are given
 *   mutually unmistakable signatures, and the decoded planes are matched back against the
 *   transmitted ones. Nothing in the decoder is touched.
 *
 * PROBE IMAGE (320x256, exactly the Scottie S1 raster, so the encoder does not rescale it)
 *   G : grey ramp 0..255 across x, with a 5 px white spike at x=160
 *   B : constant 0 (black), with a spike at x=80
 *   R : constant 255 (white), with a spike at x=240
 *   -> the decoded MEAN says which slot was read (G~127, B~0, R~255) and the spike position says
 *      how far the read is shifted horizontally.
 *
 * Usage: node tests/audit-chan-offsets.js [M1|S1]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-intraline');
const ID = process.argv[2] || 'S1';

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Decode = globalThis.SSTVDecode;

const MODE = Modes.get(ID);
const SR = 48000;
/** Mirror of sstv-decode.js:73-74 (freq -> grey), needed to compare against the timeline. */
function calcLum(freq) {
  const f = Math.max(1500, Math.min(2300, freq));
  return Math.round((f - 1500) / Modes.COLOR_FREQ_MULT);
}

function probeImage(mode) {
  const w = mode.width, h = mode.height;
  const data = new Uint8ClampedArray(w * h * 4);
  const spike = (arr, at, width) => {
    for (let d = -Math.floor(width / 2); d <= Math.floor(width / 2); d++) {
      const x = at + d;
      if (x >= 0 && x < arr.length) arr[x] = 255;
    }
  };
  const gRow = new Float64Array(w), bRow = new Float64Array(w), rRow = new Float64Array(w);
  for (let x = 0; x < w; x++) gRow[x] = Math.round(255 * x / (w - 1));
  spike(gRow, 160, 5);
  for (let x = 0; x < w; x++) { bRow[x] = 0; rRow[x] = 255; }
  spike(bRow, 80, 5);
  spike(rRow, 240, 5);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = rRow[x]; data[i + 1] = gRow[x]; data[i + 2] = bRow[x]; data[i + 3] = 255;
    }
  }
  return { data: data, width: w, height: h, gRow: gRow, bRow: bRow, rRow: rRow };
}

/** Walk the timeline into an absolute-positioned segment table. */
function segmentTable(timeline, mode, sr) {
  const scans = [], syncs = [];
  let at = 0, scanIdx = 0;
  for (const seg of timeline.segments) {
    const n = Math.round(seg.dur * sr);
    if (seg.kind === 'scan') {
      scans.push({ index: scanIdx, row: Math.floor(scanIdx / mode.channels),
        chan: mode.scanOrder[scanIdx % mode.channels], start: at, samples: n, freqs: seg.freqs });
      scanIdx++;
    } else if (seg.freq && Math.abs(seg.freq - Modes.FREQ_SYNC) < 1) {
      syncs.push({ start: at, samples: n, afterScan: scanIdx - 1 });
    }
    at += n;
  }
  return { scans, syncs, total: at };
}

/** Pearson correlation of two equal-length series. */
function corr(a, b) {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const u = a[i] - ma, v = b[i] - mb;
    num += u * v; da += u * u; db += v * v;
  }
  return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
}

/** Standard deviation, used to decide whether a channel can be judged at all. */
function sd(series, n) {
  let m = 0;
  for (let i = 0; i < n; i++) m += series[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = series[i] - m; v += d * d; }
  return Math.sqrt(v / n);
}

/**
 * Position of a spike in a row-averaged profile, robust to a linear trend.
 *
 * Subtracting the median (the first attempt) left a RAMP rising to 255, so argmax reported the last
 * column instead of the spike - it invented a +151 px shift on the G channel. A least-squares line
 * is removed instead, and a channel whose spike is not clearly above its own noise (a constant
 * channel with a same-value spike cannot show one) reports as unmeasurable rather than as a number.
 */
function spikeAt(prof) {
  const n = prof.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += prof[i]; sxx += i * i; sxy += i * prof[i]; }
  const den = n * sxx - sx * sx;
  const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const inter = (sy - slope * sx) / n;
  const resid = new Float64Array(n);
  for (let i = 0; i < n; i++) resid[i] = prof[i] - (inter + slope * i);
  let best = -Infinity, bx = -1;
  for (let i = 1; i < n - 1; i++) {
    if (resid[i] > best) { best = resid[i]; bx = i; }
  }
  // noise level = median absolute residual, which a spike does not move
  const abs = Array.from(resid, Math.abs).sort((a, b) => a - b);
  const noise = abs[Math.floor(n / 2)] || 1e-9;
  return { at: bx, prominence: best / noise, measurable: best > 8 * noise };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== 通道偏移对账（黑盒探针）===');
  console.log('模式 ' + MODE.name + '（' + MODE.structure + '），栅格 ' + MODE.width + 'x' + MODE.height +
    '，scanOrder [' + MODE.scanOrder.join(',') + ']，chanSync ' + MODE.chanSync);
  console.log('线布局（编码器实际发射顺序）: ' +
    (MODE.structure === 'scottie' ? '[G扫描][B扫描][SYNC][R扫描]  ← 与 slowrx 的 Scottie 布局一致'
      : '[SYNC][G扫描][B扫描][R扫描]'));

  const probe = probeImage(MODE);
  const timeline = Timeline.build(probe, MODE);
  const table = segmentTable(timeline, MODE, SR);
  console.log('\n真值段表: ' + table.scans.length + ' 个扫描段, ' + table.syncs.length + ' 个同步段, 共 ' +
    table.total + ' 采样 = ' + (table.total / SR).toFixed(3) + ' s');
  console.log('  每行扫描长度 ' + (MODE.scanTime * SR).toFixed(0) + ' 采样（' +
    (MODE.scanTime * 1000).toFixed(2) + ' ms）; 通道间隔 ' +
    ((MODE.sepPulse + MODE.scanTime) * SR).toFixed(0) + ' 采样');
  for (const ch of MODE.scanOrder) {
    const s = table.scans.filter((x) => x.chan === ch && x.row === 0)[0];
    if (s) console.log('  第 0 行 ' + ch + ' 扫描起点 ' + s.start + ' 采样');
  }
  if (table.syncs.length) console.log('  第 0 行同步起点 ' + table.syncs[0].start + ' 采样');

  console.log('\n合成 + 解码 ...');
  const synth = Synth.synthesize(timeline, SR);
  const t0 = Date.now();
  const dec = await Decode.decode(synth.samples, SR, { quality: 'standard', yieldEvery: 0 });
  console.log('  解码 ok=' + dec.ok + ' 模式=' + (dec.mode && dec.mode.name) + ' 栅格 ' +
    (dec.ok ? dec.imageData.width + 'x' + dec.imageData.height : '-') +
    '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  if (!dec.ok) { console.log('  解码失败: ' + dec.message); process.exitCode = 1; return; }
  const img = dec.imageData, W = img.width, H = img.height;

  /*
   * Build the transmitted series per channel and the decoded series per channel, both indexed
   * [row][x], so decoded-vs-transmitted correlation can be taken without any assumption about where
   * the decoder sampled.
   */
  const chans = MODE.scanOrder.slice();
  const T = {}, D = {};
  for (const c of chans) {
    T[c] = new Float64Array(MODE.height * W);
    D[c] = new Float64Array(H * W);
  }
  for (const s of table.scans) {
    if (s.row >= MODE.height) continue;
    for (let x = 0; x < Math.min(W, s.freqs.length); x++) {
      T[s.chan][s.row * W + x] = calcLum(s.freqs[x]);
    }
  }
  // RGBA index per colour role
  const RGBA = { R: 0, G: 1, B: 2 };
  for (const c of chans) {
    const off = RGBA[c];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) D[c][y * W + x] = img.data[(y * W + x) * 4 + off];
    }
  }

  console.log('\n--- 真值 vs 解码：各通道均值（判断读到了哪个槽）---');
  const means = (A, n) => { let s = 0; for (let i = 0; i < n; i++) s += A[i]; return s / n; };
  const nT = MODE.height * W, nD = H * W;
  console.log('  通道   真值均值   解码均值   判定');
  for (const c of chans) {
    const mt = means(T[c], nT), md = means(D[c], nD);
    const near = chans.reduce((best, k) =>
      Math.abs(mt - means(T[k], nT)) < Math.abs(mt - means(T[best], nT)) ? k : best, chans[0]);
    console.log('  ' + c.padEnd(6) + mt.toFixed(1).padStart(9) + md.toFixed(1).padStart(11) +
      '   真值该通道应最接近 ' + near + (Math.abs(mt - md) < 12 ? '   ✓ 偏差小' : '   ✗ 偏差大'));
  }

  console.log('\n--- 3x3 相关矩阵（解码通道 × 发射通道）---');
  const short = (c) => c + '通道';
  process.stdout.write('  解码\\发射   ' + chans.map((c) => short(c).padStart(11)).join('') + '\n');
  const best = {};
  for (const dc of chans) {
    let line = '  ' + short(dc).padEnd(11);
    let bx = null, bv = -2;
    for (const tc of chans) {
      const v = corr(D[dc], T[tc]);
      if (v > bv) { bv = v; bx = tc; }
      line += v.toFixed(3).padStart(11);
    }
    best[dc] = { to: bx, v: bv };
    console.log(line);
  }
  const diagonal = chans.every((c) => best[c].to === c);

  console.log('\n--- 尖峰位置（行平均剖面，已去除线性趋势；真值 G=160 B=80 R=240）---');
  const spikeTable = [];
  for (const c of chans) {
    const prof = new Float64Array(W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) prof[x] += D[c][y * W + x];
    for (let x = 0; x < W; x++) prof[x] /= H;
    const sdDec = sd(D[c], nD);
    const sp = spikeAt(prof);
    const truth = c === 'G' ? 160 : (c === 'B' ? 80 : 240);
    if (!sp.measurable) {
      spikeTable.push({ c, at: null, truth, delta: null, measurable: false, sd: sdDec });
      console.log('  ' + c + '通道  尖峰不可测（剖面标准差 ' + sdDec.toFixed(1) +
        '：该通道本身近乎常数或尖峰与底色同值）—— 此项不参与判定');
      continue;
    }
    spikeTable.push({ c, at: sp.at, truth, delta: sp.at - truth, measurable: true,
      prominence: +sp.prominence.toFixed(1), sd: sdDec });
    console.log('  ' + c + '通道  尖峰 ' + String(sp.at).padStart(4) + '（真值 ' + String(truth).padStart(3) +
      '）  Δ = ' + (sp.at - truth >= 0 ? '+' : '') + (sp.at - truth) + ' 像素 = ' +
      ((sp.at - truth) * MODE.scanTime / W * 1e6).toFixed(0) + ' us   显著度 ' + sp.prominence.toFixed(1));
  }

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 判定 =====');
  /*
   * Correlation is only meaningful for a channel with variance. The R probe is a constant 255, so
   * every correlation involving it is ~0 by construction - which the first version of this script
   * reported as a channel MISMATCH and produced a false "layout is on the wrong side" verdict.
   */
  const usable = chans.filter((c) => sd(T[c], nT) > 10 && sd(D[c], nD) > 10);
  const unusable = chans.filter((c) => usable.indexOf(c) < 0);
  console.log('① 可用于相关判定的通道: [' + usable.join(',') + ']' +
    (unusable.length ? '   排除 [' + unusable.join(',') + ']（方差过小，相关在数学上无意义）' : ''));
  let mismatched = [];
  for (const dc of usable) {
    let bx = null, bv = -2;
    for (const tc of usable) {
      const v = corr(D[dc], T[tc]);
      if (v > bv) { bv = v; bx = tc; }
    }
    if (bx !== dc) mismatched.push(dc + '->' + bx + '(r=' + bv.toFixed(3) + ')');
  }
  const diagOk = mismatched.length === 0;
  console.log('② 通道归属: ' + (diagOk
    ? '每个可用通道都最佳匹配同名发射通道 ✓'
    : '存在错配 ✗ ' + mismatched.join(', ')));
  const meanTable = chans.map((c) => ({ c, mt: means(T[c], nT), md: means(D[c], nD) }));
  const meanWorst = Math.max.apply(null, meanTable.map((m) => Math.abs(m.mt - m.md)));
  console.log('③ 三通道均值最大偏差 ' + meanWorst.toFixed(1) + ' 灰阶' +
    (meanWorst < 12 ? '  ✓ 各通道读到了正确的槽' : '  ✗ 有通道读错了槽'));
  const measurable = spikeTable.filter((s) => s.measurable);
  const maxDelta = measurable.length ? Math.max.apply(null, measurable.map((s) => Math.abs(s.delta))) : null;
  const onePixSamples = MODE.scanTime / W * SR;
  console.log('④ 可测尖峰位移: ' + (maxDelta == null ? '无' : maxDelta + ' 像素') +
    '（1 像素 = ' + onePixSamples.toFixed(1) + ' 采样；1 通道 = ' +
    ((MODE.sepPulse + MODE.scanTime) * SR).toFixed(0) + ' 采样）');

  let verdict;
  if (!diagOk || meanWorst >= 12) {
    verdict = '【布局错侧】解码通道匹配到了别的发射槽 —— chanOffsets 需要修';
  } else if (maxDelta != null && maxDelta > 2) {
    verdict = '【同名通道但横向错位 ' + maxDelta + ' 像素】—— 偏移量不对（基准差），不是通道错侧';
  } else {
    verdict = '【补偿恰好成立】各通道读到正确的槽，可测位移 ≤ 2 像素 —— 布局不是根因';
  }
  console.log('判定: ' + verdict);

  // ---------------------------------------------------------------- evidence file
  const ev = {
    generatedAt: new Date().toISOString(), mode: ID, structure: MODE.structure, sampleRate: SR,
    encoderOrder: MODE.structure === 'scottie' ? 'Gscan,Bscan,SYNC,Rscan' : 'SYNC,Gscan,Bscan,Rscan',
    scanOrder: MODE.scanOrder, chanSync: MODE.chanSync,
    trueFirstLineStarts: table.scans.filter((s) => s.row === 0)
      .map((s) => ({ chan: s.chan, start: s.start, samples: s.samples })),
    firstSync: table.syncs.length ? table.syncs[0].start : null,
    decodedOk: dec.ok,
    channelMeans: chans.map((c) => ({ chan: c, truth: means(T[c], nT), decoded: means(D[c], nD) })),
    correlation: chans.map((dc) => ({ decoded: dc,
      vs: chans.map((tc) => ({ chan: tc, r: +corr(D[dc], T[tc]).toFixed(4) })) })),
    spikes: spikeTable, verdict: verdict
  };
  const evPath = path.join(OUT, 'audit-chan-offsets-' + ID + '.json');
  fs.writeFileSync(evPath, JSON.stringify(ev, null, 2));
  console.log('\n证据 -> ' + path.relative(ROOT, evPath));

  const pngjs = (() => {
    try { return require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); }
    catch (e) { return null; }
  })();
  if (pngjs) {
    const png = new pngjs.PNG({ width: W, height: H });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
    const p = path.join(OUT, 'audit-probe-' + ID + '.png');
    fs.writeFileSync(p, pngjs.PNG.sync.write(png));
    console.log('探针解码图 -> ' + path.relative(ROOT, p));
  }
})().catch((e) => { console.error('audit error: ' + (e && e.stack || e)); process.exitCode = 1; });
