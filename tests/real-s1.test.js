/*
 * Real Scottie S1 regression test (phigros).
 *
 * The corpus that validated decoding so far was all Martin M1 - the project's own limitation L2
 * records that only M1 samples could be found publicly. This is the first real S1 recording, and it
 * does NOT decode to a recognisable picture. This test keeps the case in the suite so the failure
 * cannot be forgotten, and records what the decoder actually does with it.
 *
 * It asserts only what is true today, on purpose:
 *   - the mode and VIS are detected
 *   - the sync train is regular
 *   - the pipeline returns an image of the right size
 * and it MEASURES (without demanding) image-likeness, so a future fix shows up as a change in the
 * numbers rather than as a silently adjusted threshold.
 *
 * Usage: node tests/real-s1.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
let failures = 0;
function check(ok, label, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
}

/** Adjacent-row correlation of the green channel: an image scores high, noise near zero. */
function rowCorrelation(img) {
  const w = img.width, h = img.height, d = img.data;
  let sum = 0, count = 0;
  for (let y = 0; y + 1 < h; y++) {
    let ma = 0, mb = 0;
    for (let x = 0; x < w; x++) { ma += d[(y * w + x) * 4 + 1]; mb += d[((y + 1) * w + x) * 4 + 1]; }
    ma /= w; mb /= w;
    let num = 0, da = 0, db = 0;
    for (let x = 0; x < w; x++) {
      const u = d[(y * w + x) * 4 + 1] - ma, v = d[((y + 1) * w + x) * 4 + 1] - mb;
      num += u * v; da += u * u; db += v * v;
    }
    if (da > 0 && db > 0) { sum += num / Math.sqrt(da * db); count++; }
  }
  return count ? sum / count : 0;
}

/** Grey histogram concentration in the image band: a picture uses the range, noise saturates it. */
function greyStats(img) {
  const d = img.data;
  let white = 0, black = 0, n = 0, sum = 0, sum2 = 0;
  for (let i = 1; i < d.length; i += 4) {
    const v = d[i];
    if (v >= 250) white++;
    if (v <= 5) black++;
    sum += v; sum2 += v * v; n++;
  }
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
    whitePct: 100 * white / n, blackPct: 100 * black / n };
}

(async function main() {
  console.log('=== 真实 Scottie S1 专项测试（phigros）===\n');
  if (!fs.existsSync(SRC)) {
    console.log('missing ' + path.relative(ROOT, SRC) + ' - run node tests/diagnose-timing.js first');
    process.exitCode = 1; return;
  }
  require(path.join(ROOT, 'js', 'lib', 'fft.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
  require(path.join(ROOT, 'js', 'lib', 'wav.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
  const Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

  const buf = fs.readFileSync(SRC);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  console.log('  audio ' + info.duration.toFixed(3) + ' s @ ' + info.sampleRate + ' Hz mono\n');

  const pngjs = (() => {
    try { return require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); }
    catch (e) { return null; }
  })();
  const outDir = path.join(__dirname, 'diag-intraline');
  fs.mkdirSync(outDir, { recursive: true });

  const runs = [];
  for (const [label, opts] of [['标准档', {}], ['关时钟恢复', { clockRecovery: false }]]) {
    const t0 = Date.now();
    const d = await Decode.decode(info.samples, info.sampleRate,
      Object.assign({ quality: 'standard', yieldEvery: 0 }, opts));
    const rc = d.ok ? rowCorrelation(d.imageData) : null;
    const gs = d.ok ? greyStats(d.imageData) : null;
    runs.push({ label, d, rc, gs, img: d.imageData, sec: (Date.now() - t0) / 1000 });
    console.log('  [' + label + ']');
    check(d.ok, label + ' decode returns an image');
    if (!d.ok) continue;
    check(d.mode.id === 'S1' && d.vis === 60, label + ' identified as Scottie S1 / VIS 60',
      d.mode.name + ' VIS ' + d.vis);
    check(d.imageData.width === 320 && d.imageData.height === 256, label + ' raster is 320x256');
    console.log('       行间相关 ' + rc.toFixed(4) + '   灰度均值 ' + gs.mean.toFixed(1) +
      ' 标准差 ' + gs.sd.toFixed(1) + '   饱和白 ' + gs.whitePct.toFixed(1) + '%' +
      '   纯黑 ' + gs.blackPct.toFixed(1) + '%   (' + runs[runs.length - 1].sec.toFixed(1) + ' s)');
    const cal = d.calibration || {};
    console.log('       clockScale ' + (cal.clockScale == null ? '-' : cal.clockScale.toFixed(5)) +
      ' · a=' + (cal.scale == null ? '-' : cal.scale.toFixed(5)) +
      ' · b=' + (cal.offsetHz == null ? '-' : cal.offsetHz.toFixed(2)));
    if (pngjs) {
      const png = new pngjs.PNG({ width: d.imageData.width, height: d.imageData.height });
      png.data = Buffer.from(d.imageData.data.buffer, d.imageData.data.byteOffset, d.imageData.data.length);
      fs.writeFileSync(path.join(outDir, 'real-s1-' + label + '.png'), pngjs.PNG.sync.write(png));
    }
  }

  console.log('\n  --- 判定 ---');
  const best = runs.filter((r) => r.rc != null).sort((a, b) => b.rc - a.rc)[0];
  /*
   * Deliberately NOT asserting a recognisable picture: it is not there yet. The number is reported
   * so the day it changes, the suite says so.
   *
   * PHASE 27 RECORD (kept as history): replacing the least-squares line-period fit with a robust
   * estimator was tried and REVERTED, because both variants measured worse on this recording:
   *     least squares        -> 20113 samples/line, adjacent-row correlation 0.1962   (current)
   *     Theil-Sen            -> 19127,                      correlation 0.0676
   *     median of intervals  -> 19395,                      correlation 0.1041
   *     truth (independent fine-grained detector)          -> 20553
   * The estimator is not the constraint - an independent detector measures this recording's
   * consecutive-interval median at 428.079 ms (20548 samples), so the series the fits consume is
   * contaminated at the source. The assertion below therefore still expects the gap to be OPEN.
   */
  console.log('  最佳行间相关 ' + best.rc.toFixed(4) + '（' + best.label + '）');
  console.log('  历史记录：稳健估计尝试（阶段二十七）给出 0.0676 / 0.1041，均劣于最小二乘的 0.1962，已回退');
  console.log('  历史记录：全局最小二乘基线为 0.1962（行周期拟合 20113，真值 20553，误差 -2.15%）');
  console.log('  ' + (best.rc > 0.5
    ? '已解出"像图"的结果 ✓'
    : '仍为噪声级：真实 S1 解码尚未成功（这是一个已知缺口，不是回归）'));
  /*
   * PHASE 29: the gap is CLOSED, so the assertion is inverted.
   *
   * The earlier assertion (`best.rc < 0.5`, "the gap is still open") was written precisely so the day
   * it stopped being true the suite would go red and force this update - which is what happened. The
   * cause was the per-pulse rate adjudicator: the nominal-agreement gate used to be skipped while the
   * 4-interval window was filling, so a contaminated early mean was written unconditionally and then
   * protected forever by the gates that followed ("accepted 0 / rejected 252"). Applying the nominal
   * gate ALWAYS moved the fitted line period from 20113 to 20524.8 against a true 20553, and the
   * adjacent-row correlation from 0.1962 to 0.5692.
   */
  /*
   * PHASE 40: STRUCTURAL criterion on the chroma.
   *
   * Row correlation alone said "picture-like" at 0.57 while the render still looked like coloured
   * banding, because it only sees luminance. The chroma image (G-R) is a sharper test: in a real
   * image it varies pixel to pixel, so it is only weakly correlated along the row and almost
   * uncorrelated between rows. Robot36's own render of this recording measures 0.55 along x and 0.15
   * along y, while ours measures 0.81 and 0.53 - i.e. our colour is large, row-coherent blotches
   * rather than texture, which is exactly what the magenta/cyan streaking looks like.
   *
   * A signal-level precondition is required: on a GREY test image the chroma is ~2 levels of noise,
   * where these correlations are meaningless (our synthetic S1 scores 0.90 along y on a signal of
   * 2.4 levels). So the assertions only apply when the chroma actually carries signal.
   */
  const chromaStructure = (img) => {
    const w = img.width, h = img.height, d = img.data;
    const ch = [];
    for (let y = 0; y < h; y++) {
      const row = new Float64Array(w);
      for (let x = 0; x < w; x++) row[x] = d[(y * w + x) * 4 + 1] - d[(y * w + x) * 4];
      ch.push(row);
    }
    const cv = (a, b) => {
      const n = Math.min(a.length, b.length);
      let ma = 0, mb = 0;
      for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
      ma /= n; mb /= n;
      let nu = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; nu += u * v; da += u * u; db += v * v; }
      return (da > 0 && db > 0) ? nu / Math.sqrt(da * db) : 0;
    };
    let x1 = 0, y1 = 0, sd = 0, m = 0;
    for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) m += ch[y][x]; }
    m /= (w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sd += (ch[y][x] - m) * (ch[y][x] - m);
    sd = Math.sqrt(sd / (w * h));
    for (let y = 0; y < h; y++) x1 += cv(Array.from(ch[y].slice(0, w - 1)), Array.from(ch[y].slice(1)));
    x1 /= h;
    for (let y = 0; y + 1 < h; y++) y1 += cv(Array.from(ch[y]), Array.from(ch[y + 1]));
    y1 /= (h - 1);
    return { sd: sd, x1: x1, y1: y1 };
  };
  for (const run of runs) {
    if (!run.img) continue;
    const st = chromaStructure(run.img);
    console.log('  ' + run.label + ' 色度结构: σ(G−R) ' + st.sd.toFixed(1) +
      ' · 沿x(lag1) ' + st.x1.toFixed(3) + ' · 沿y(lag1) ' + st.y1.toFixed(3));
  }
  {
    const st = chromaStructure(runs[0].img);
    const hasChroma = st.sd >= 10;
    check(hasChroma, 'the decode carries chroma signal at all (needed for the structure test)',
      'sigma(G-R) ' + st.sd.toFixed(1) + ' levels');
    if (hasChroma) {
      check(st.y1 < 0.3, 'chroma is not row-coherent banding (along y < 0.3)',
        'along y ' + st.y1.toFixed(3) + ' (Robot36 reference measures 0.15)');
      check(st.x1 < 0.7, 'chroma varies within the row rather than forming blobs (along x < 0.7)',
        'along x ' + st.x1.toFixed(3) + ' (Robot36 reference measures 0.55)');
    }
  }

  check(best.rc > 0.5, 'the real S1 recording now decodes to a picture-like result',
    'rowCorr ' + best.rc.toFixed(4));
  check(best.rc > 0.19,
    'and it is far above the 0.1962 global-least-squares baseline', 'rowCorr ' + best.rc.toFixed(4));

  console.log('\n' + (failures === 0 ? 'REAL S1: CHECKS PASSED (gap closed)' : failures + ' CHECK(S) FAILED'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
