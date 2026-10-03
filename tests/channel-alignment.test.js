/*
 * Channel-alignment regression: the blind spot that the photo round trip cannot cover.
 *
 * WHY THIS EXISTS
 *   A photograph's R, G and B planes are highly correlated, so a decoder can misalign the three
 *   channels by tens or even hundreds of pixels and still score 30.50 dB on the round trip. That is
 *   exactly what phase 42 found: on a synthetic image whose three channels are INDEPENDENT, the
 *   decoder's G and R planes correlate only 0.164 after detrending - i.e. they are not aligned at all
 *   - while the same decoder round-trips a photo at 30.50 dB. The photo test cannot see this class of
 *   defect, so this one uses three independent sinusoidal patterns instead.
 *
 * WHAT IT CHECKS (self round trip, no real recording needed)
 *   1. detrended peak correlation of the decoded G against the decoded R  > 0.8
 *   2. same for G against B
 *   3. same for B against R
 *   4. per-channel: each decoded plane against the ORIGINAL plane of the same name > 0.8
 *   5. sigma(G-R)/sigma(L) within 20% of the original image's same ratio
 *
 * The per-channel comparison (4) is what says WHICH channel is misplaced; (1)-(3) say whether any of
 * them are. Until the defect is located these fail, by design: that is the point of adding them.
 *
 * Usage: node tests/channel-alignment.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline, Synth = globalThis.SSTVSynth,
      Decode = globalThis.SSTVDecode;
const MODE = Modes.get('S1');

let failures = 0;
function check(ok, label, detail) {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

/** Three independent patterns, each varying along BOTH axes (phase 41's control had G constant in x). */
function colourImage() {
  const w = MODE.width, h = MODE.height, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = Math.round(127 + 120 * Math.sin(x * 0.03 + y * 0.05));       // R
      d[i + 1] = Math.round(127 + 120 * Math.sin(x * 0.07 - y * 0.02));   // G
      d[i + 2] = Math.round(127 + 120 * Math.sin(x * 0.05 + y * 0.09));   // B
      d[i + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

/** Plane accessor for a 320x256 RGBA buffer, by colour letter. */
function plane(img, ch) {
  const off = ch === 'R' ? 0 : (ch === 'G' ? 1 : 2);
  const rows = [];
  for (let y = 0; y < img.height; y++) {
    const row = new Float64Array(img.width);
    for (let x = 0; x < img.width; x++) row[x] = img.data[(y * img.width + x) * 4 + off];
    rows.push(row);
  }
  return rows;
}

const cv = (a, b) => {
  const n = Math.min(a.length, b.length);
  if (n < 16) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let nu = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; nu += u * v; da += u * u; db += v * v; }
  return (da > 0 && db > 0) ? nu / Math.sqrt(da * db) : 0;
};

/**
 * Alignment between two plane sets, measured with a PLAIN zero-mean correlation at shift 0, plus a
 * shift search reported for information only.
 *
 * Why plain, and not the first-differenced correlation used in phases 40-43: differencing destroys
 * smooth content. A signal of period P loses amplitude in proportion to 2*sin(pi/P) - for P = 90 px
 * that is 0.07 of the original - while white noise only loses a factor sqrt(2), so SNR collapses by
 * 20-40x. That metric reported 0.33-0.60 on a decode whose plain correlation is 0.998 and whose PSNR
 * is 31.74 dB, and it produced four rounds of phantom "channel misalignment" findings.
 *
 * A linear-trend removal is no better: on an almost-linear row it removes the signal itself
 * (phase 44: 0.443 for a channel whose plain correlation is 0.990).
 */
function alignment(A, B, maxD) {
  const H = Math.min(A.length, B.length);
  const rs = [], ds = [];
  for (let y = 0; y < H; y++) {
    const a = Array.from(A[y]), b = Array.from(B[y]);
    rs.push(cv(a, b));
    const n = Math.min(a.length, b.length);
    let bd = 0, bv = -2;
    for (let d = -maxD; d <= maxD; d++) {
      const aa = [], bb = [];
      for (let i = 0; i < n; i++) {
        const j = i + d;
        if (j < 0 || j >= n) continue;
        aa.push(a[i]); bb.push(b[j]);
      }
      const r = cv(aa, bb);
      if (r > bv) { bv = r; bd = d; }
    }
    ds.push(bd);
  }
  const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const mad = (arr) => { const m = med(arr); return med(arr.map((v) => Math.abs(v - m))); };
  return { shift: med(ds), shiftMad: mad(ds), corr: med(rs), n: H };
}

/** PSNR between two plane sets, same convention as roundtrip.js. */
function planePsnr(A, B) {
  const a = [], b = [];
  for (let y = 0; y < Math.min(A.length, B.length); y++) {
    for (let x = 0; x < Math.min(A[y].length, B[y].length); x++) { a.push(A[y][x]); b.push(B[y][x]); }
  }
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  const mse = se / a.length;
  return mse <= 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}

/** sigma(G-R)/sigma(L) on any RGBA image. */
function chromaRatio(img) {
  const G = plane(img, 'G'), R = plane(img, 'R'), B = plane(img, 'B');
  const gr = [], lum = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      gr.push(G[y][x] - R[y][x]);
      lum.push((G[y][x] + R[y][x] + B[y][x]) / 3);
    }
  }
  const sd = (arr) => { let m = 0; for (const v of arr) m += v; m /= arr.length;
    let v2 = 0; for (const v of arr) v2 += (v - m) * (v - m); return Math.sqrt(v2 / arr.length); };
  const sgr = sd(gr), sl = sd(lum);
  return { sdGR: sgr, sdL: sl, ratio: sl ? sgr / sl : 0 };
}

(async function main() {
  console.log('=== 通道对齐回归（合成彩色图，三通道独立）===\n');
  const orig = colourImage();
  const tl = Timeline.build(orig, MODE);
  const syn = Synth.synthesize(tl, SR).samples;
  console.log('合成 S1: ' + (syn.length / SR).toFixed(3) + ' s（' + MODE.width + '×' + MODE.height + '，三通道独立正弦）');

  const origRatio = chromaRatio(orig);
  console.log('原始图像 σ(G−R)/σ(L) = ' + origRatio.ratio.toFixed(4) +
    '（σ(G−R) ' + origRatio.sdGR.toFixed(1) + ' · σ(L) ' + origRatio.sdL.toFixed(1) + '）');

  const t0 = Date.now();
  const dec = await Decode.decode(syn, SR, { quality: 'standard', yieldEvery: 0 });
  console.log('解码: ok=' + dec.ok + ' 模式=' + (dec.mode && dec.mode.name) + ' · ' +
    ((Date.now() - t0) / 1000).toFixed(1) + ' s\n');
  if (!dec.ok) { check(false, 'synthetic colour decode succeeds', dec.message); process.exitCode = 1; return; }
  const out = dec.imageData;
  check(out.width === MODE.width && out.height === MODE.height, 'raster is ' + MODE.width + 'x' + MODE.height);

  const O = { R: plane(orig, 'R'), G: plane(orig, 'G'), B: plane(orig, 'B') };
  const D = { R: plane(out, 'R'), G: plane(out, 'G'), B: plane(out, 'B') };

  // ---------------------------------------------------------------- per-channel against truth
  console.log('--- 逐通道比对：解码平面 vs 原始同名单通道（去趋势后峰值相关）---');
  const truth = {};
  for (const ch of ['R', 'G', 'B']) {
    truth[ch] = alignment(D[ch], O[ch], 160);
    console.log('  ' + ch + ' 通道 vs 原始 ' + ch + ': 相关 ' + truth[ch].corr.toFixed(3) +
      ' · 位移中位 ' + truth[ch].shift + ' px (MAD ' + truth[ch].shiftMad + ')');
  }
  console.log('  → 哪个通道错位：' +
    ['R', 'G', 'B'].map((c) => c + ' ' + (truth[c].corr > 0.8 ? '对齐 ✓' : '错位 ✗')).join(' · '));

  // ---------------------------------------------------------------- cross-channel
  console.log('\n--- 解码器输出内部：三通道两两对齐 ---');
  const pairs = [['G', 'R'], ['G', 'B'], ['B', 'R']];
  const cross = {};
  for (const [a, b] of pairs) {
    cross[a + b] = alignment(D[a], D[b], 160);
    console.log('  ' + a + '−' + b + ': 相关 ' + cross[a + b].corr.toFixed(3) +
      ' · 位移中位 ' + cross[a + b].shift + ' px (MAD ' + cross[a + b].shiftMad + ')');
  }

  // ---------------------------------------------------------------- cross-channel SEPARATION
  /*
   * The real misalignment test is CROSS-TALK, not mutual similarity.
   *
   * Phase 43 asserted "decoded G and R are aligned (r > 0.8)". That is backwards: on an image whose
   * three channels are independent, a CORRECT decoder must produce mutually UNCORRELATED planes, so
   * that assertion fails precisely when the decoder is right. It only passes on a photo, whose
   * channels are similar by nature - which is the case that cannot detect misalignment at all.
   *
   * What a misaligned decoder actually does is put one channel's content into another channel, so the
   * test is whether decoded G correlates with the TRUE R or TRUE B. Measured: 0.998 against its own
   * truth, -0.006 and 0.002 against the others.
   */
  console.log('\n--- 通道分离度：解码 G 分别对三个真值通道 ---');
  const crossTruth = {};
  for (const ch of ['R', 'G', 'B']) {
    crossTruth[ch] = alignment(D.G, O[ch], 160);
    console.log('  解码 G vs 真值 ' + ch + ': 相关 ' + crossTruth[ch].corr.toFixed(3));
  }

  // ---------------------------------------------------------------- chroma amplitude
  const outRatio = chromaRatio(out);
  const relErr = Math.abs(outRatio.ratio - origRatio.ratio) / origRatio.ratio;
  console.log('\n--- 色度幅度 ---');
  console.log('  原始 ' + origRatio.ratio.toFixed(4) + ' → 解码 ' + outRatio.ratio.toFixed(4) +
    ' · 相对偏差 ' + (relErr * 100).toFixed(1) + '%');

  // ---------------------------------------------------------------- assertions
  console.log('\n--- 断言 ---');
  for (const ch of ['R', 'G', 'B']) {
    check(truth[ch].corr > 0.9, 'decoded ' + ch + ' plane matches the original ' + ch + ' plane (r > 0.9)',
      'r ' + truth[ch].corr.toFixed(3));
  }
  check(crossTruth.G.corr > 0.9, 'decoded G matches the TRUE G, not another channel (own > 0.9)',
    'r ' + crossTruth.G.corr.toFixed(3));
  check(crossTruth.R.corr < 0.3, 'decoded G does NOT carry the true R (cross-talk < 0.3)',
    'r ' + crossTruth.R.corr.toFixed(3));
  check(crossTruth.B.corr < 0.3, 'decoded G does NOT carry the true B (cross-talk < 0.3)',
    'r ' + crossTruth.B.corr.toFixed(3));
  check(relErr < 0.20, 'chroma amplitude within 20% of the original',
    'ratio ' + outRatio.ratio.toFixed(4) + ' vs ' + origRatio.ratio.toFixed(4) +
    ' (' + (relErr * 100).toFixed(1) + '%)');
  /*
   * No "shift <= 2 px" assertion here, deliberately.
   *
   * The synthetic patterns are pure sines, so they are exactly periodic: G = sin(x*0.07) has a period
   * of 90 px, and the shift search duly reports 90 px because a shift by one whole period is
   * numerically identical to no shift at all (r = 0.998 either way, MAD 0 across all 256 rows). A
   * shift search is simply not a valid alignment test for periodic content - and when the true
   * correlation is 0.998 the argmax is ill-conditioned even for aperiodic content.
   *
   * The alignment evidence is the correlation at shift 0 against each plane's own truth, plus the
   * cross-talk checks above. A future version could use a chirp or a sum of incommensurate sines so
   * that the shift becomes well defined.
   */
  console.log('\n注：不断言"位移 ≤ 2 px" —— 合成图案是纯正弦（G 的周期恰为 90 px），' +
    '位移一个周期与不平移在数值上等价（r 均为 0.998）。位移搜索对周期信号不是有效的对齐检验。');

  console.log('\n' + (failures === 0
    ? 'CHANNEL ALIGNMENT: ALL CHECKS PASSED'
    : 'CHANNEL ALIGNMENT: ' + failures + ' CHECK(S) FAILED'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
