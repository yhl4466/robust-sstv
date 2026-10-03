/*
 * Diagnostic re-decoder for the real Scottie S1 recording.
 *
 * WHY
 *   Phase 29 got the real recording past the "is it a picture" line (adjacent-row correlation
 *   0.1962 -> 0.5703) but it still looks nothing like Robot36's render of the same audio: colour
 *   blocks and magenta/cyan banding where a figure is clearly visible in theirs. The correlation
 *   number cannot distinguish "a picture" from "a picture with the channels in the wrong places", so
 *   this rebuilds the image under explicit hypotheses instead of trusting one composition.
 *
 * HOW, AND WHY IT IS BUILT THIS WAY
 *   The decoder's per-line sync lock is reused (via the auditLineRefs hook) - it is the part phase 29
 *   fixed - but the channel positions, channel order, colour space and frequency->grey mapping are all
 *   supplied here. To keep that cheap the frequency axis is measured ONCE as an absolute per-sample
 *   track in Hz:
 *
 *     complex baseband at 1900 Hz -> 1 ms boxcar low-pass -> phase difference per sample -> Hz
 *
 *   An earlier attempt expressed this in "normalised" units and got the scale wrong, which cost a
 *   whole round; absolute Hz has no scale to get wrong. Sampling that track is then the only per-
 *   hypothesis cost, and the frequency mapping and colour space are pure post-processing on the
 *   sampled values.
 *
 * SELF-CHECK
 *   The same pipeline runs on OUR synthetic S1, where the transmitted values are known. If it does
 *   not reproduce ~0.99 correlation there with the standard layout, the pipeline is wrong and the
 *   phigros conclusions are worthless - so that check runs first and is printed either way.
 *
 * Usage: node tests/diagnose-s1-quality.js
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
const NOMINAL_LINE = Modes.lineTime(MODE) * SR;
const CHAN = MODE.sepPulse + MODE.scanTime;                 // 139.74 ms
const PIXEL_SAMPLES = MODE.scanTime / MODE.width * SR;      // 20.74 samples

let pngjs = null;
try { pngjs = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); } catch (e) {}

/** Absolute per-sample frequency track in Hz (see the header for why it is in Hz). */
function frequencyTrack(x, sr) {
  const CENTER = 1900;
  const lpLen = Math.round(0.001 * sr) | 1;                 // 1 ms boxcar: null at 1000 Hz offset
  /*
   * s is NEGATED: the mixing must be a down-conversion by 1900 Hz, i.e. multiply by exp(-j*w0*n).
   *
   * The recurrence below (ci,si) <- (ci*c - si*s, si*c + ci*s) starting at (1,0) rotates FORWARD,
   * so with s = +sin(w) it mixes UP by 1900 Hz instead of down. The discriminator then reports
   * 1900 - (f - 1900), a mirror about the baseband centre. Phase 30 saw the symptom (405.7 Hz mean
   * error on a known ramp, 44.4 colour fringe on a GREY image) and guessed at this cause without
   * checking; the pure-tone test in tests/diagnose-track-calibration.js settles it exactly -
   * 1200->2600, 1500->2300, 1700->2100, all with zero residual against the mirror, and 1900 is the
   * fixed point, which is why centring the baseband at 1900 hid the bug from every earlier check.
   *
   * This is confined to the diagnostic: the production estimator (Estimator.peak) searches the
   * MAGNITUDE spectrum from an FFT and is immune to I/Q sign conventions, which is why the real photo
   * round trip reaches 30.50 dB and the phase-23 probe matches a ramp at 0.996.
   */
  const w = 2 * Math.PI * CENTER / sr, c = Math.cos(w), s = -Math.sin(w);
  const ringI = new Float64Array(lpLen), ringQ = new Float64Array(lpLen);
  let sumI = 0, sumQ = 0, ri = 0, ci = 1, si = 0;
  let pI = 0, pQ = 0, have = false;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
    const mI = x[i] * ci, mQ = x[i] * si;
    sumI += mI - ringI[ri]; ringI[ri] = mI;
    sumQ += mQ - ringQ[ri]; ringQ[ri] = mQ;
    ri = (ri + 1) % lpLen;
    const I = sumI / lpLen, Q = sumQ / lpLen;
    if (have) {
      const re = I * pI + Q * pQ, im = Q * pI - I * pQ;
      out[i] = CENTER + Math.atan2(im, re) * sr / (2 * Math.PI);
    } else {
      out[i] = CENTER;
    }
    pI = I; pQ = Q; have = true;
  }
  return out;
}

/** Average the track over a few taps around a sample index (the pixel window). */
function tap(track, at, half) {
  let s = 0, n = 0;
  for (let d = -half; d <= half; d++) {
    const i = at + d;
    if (i >= 0 && i < track.length) { s += track[i]; n++; }
  }
  return n ? s / n : 1500;
}

/**
 * Sample the three colour planes for every line.
 *   chanStartMs : channel start relative to the SYNC position, in ms, keyed by colour role.
 *                 Standard Scottie layout [sep][G][sep][B][SYNC][porch][R]: G and B precede the sync.
 *   shiftSamples: applied to every channel start, to test the sync-position hypotheses.
 * Returns { planes: {R,B,G}[line][x] in Hz, refs }.
 */
function samplePlanes(track, refs, chanStartMs, shiftSamples, halfTaps) {
  const planes = { R: [], G: [], B: [] };
  for (const r of refs) {
    const row = {};
    for (const role of ['G', 'B', 'R']) {
      const start = r.ref + shiftSamples + chanStartMs[role] / 1000 * SR;
      const vals = new Float64Array(MODE.width);
      for (let px = 0; px < MODE.width; px++) {
        vals[px] = tap(track, Math.round(start + (px + 0.5) * PIXEL_SAMPLES), halfTaps);
      }
      row[role] = vals;
    }
    for (const role of ['R', 'G', 'B']) planes[role].push(row[role]);
  }
  return planes;
}

/** frequency -> grey with a configurable nominal range. */
function toGrey(hz, lo, hi) {
  const v = 255 * (hz - lo) / (hi - lo);
  return v < 0 ? 0 : (v > 255 ? 255 : Math.round(v));
}

/** Compose RGBA from three grey planes under a channel order and a colour space.
 *
 *  `order` maps PHYSICAL SLOT -> COLOUR ROLE: order[0] supplies red, order[1] green, order[2] blue.
 *  The first version wrote `v[order[k]] = ...` and then read `v.R/v.G/v.B` back by role, which
 *  cancels the permutation completely - the four "channel order" images came out byte-for-byte
 *  identical, which is how the bug was caught. The colour-space branch genuinely consumed `order`,
 *  so the RGB-vs-YUV comparison from phase 30 still stands; only the order test was void.
 */
function compose(planes, order, greyRange, colourSpace, width, height) {
  const [lo, hi] = greyRange;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p0 = toGrey(planes[order[0]][y][x], lo, hi);
      const p1 = toGrey(planes[order[1]][y][x], lo, hi);
      const p2 = toGrey(planes[order[2]][y][x], lo, hi);
      let R = p0, G = p1, B = p2;
      if (colourSpace === 'yuv601' || colourSpace === 'yuv709') {
        // treat the three slots as Y, Cb, Cr (BT.601 / BT.709 limited-range matrices)
        const Y = p0, Cb = p1 - 128, Cr = p2 - 128;
        if (colourSpace === 'yuv601') {
          R = Y + 1.402 * Cr; G = Y - 0.344136 * Cb - 0.714136 * Cr; B = Y + 1.772 * Cb;
        } else {
          R = Y + 1.5748 * Cr; G = Y - 0.1873 * Cb - 0.4681 * Cr; B = Y + 1.8556 * Cb;
        }
      }
      const i = (y * width + x) * 4;
      data[i] = R; data[i + 1] = G; data[i + 2] = B; data[i + 3] = 255;
    }
  }
  return { data: data, width: width, height: height };
}

/** Adjacent-row Pearson correlation on the green channel - the ground-truth-free "is it a picture". */
function rowCorr(img) {
  const w = img.width, h = img.height, d = img.data;
  let s = 0, n = 0;
  for (let y = 0; y + 1 < h; y++) {
    let ma = 0, mb = 0;
    for (let x = 0; x < w; x++) { ma += d[(y * w + x) * 4 + 1]; mb += d[((y + 1) * w + x) * 4 + 1]; }
    ma /= w; mb /= w;
    let nu = 0, da = 0, db = 0;
    for (let x = 0; x < w; x++) {
      const u = d[(y * w + x) * 4 + 1] - ma, v = d[((y + 1) * w + x) * 4 + 1] - mb;
      nu += u * v; da += u * u; db += v * v;
    }
    if (da > 0 && db > 0) { s += nu / Math.sqrt(da * db); n++; }
  }
  return n ? s / n : 0;
}

/** Colour-fringing proxy: how far each pixel is from grey, and how much is clipped. */
function colourStats(img) {
  const w = img.width, h = img.height, d = img.data;
  let fringe = 0, satW = 0, satB = 0, sum = 0, n = w * h;
  for (let i = 0; i < n; i++) {
    const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2];
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    fringe += mx - mn;
    if (mx >= 250 && mn <= 5) { /* extreme */ }
    if (mx >= 250) satW++;
    if (mx <= 5) satB++;
    sum += (R + G + B) / 3;
  }
  return { fringeMean: fringe / n, mean: sum / n, whiteFrac: satW / n, blackFrac: satB / n };
}

function savePng(img, name) {
  if (!pngjs) return null;
  const png = new pngjs.PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  const p = path.join(OUT, name);
  fs.writeFileSync(p, pngjs.PNG.sync.write(png));
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function greyPng(plane, width, height, lo, hi, name) {
  const img = { data: new Uint8ClampedArray(width * height * 4), width: width, height: height };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const g = toGrey(plane[y][x], lo, hi), i = (y * width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g; img.data[i + 3] = 255;
    }
  }
  return savePng(img, name);
}

function synthS1() {
  const w = MODE.width, h = MODE.height, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = Math.round(255 * x / (w - 1));
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const tl = Timeline.build({ data: data, width: w, height: h }, MODE);
  return Synth.synthesize(tl, SR).samples;
}

async function loadAudio(file) {
  const b = fs.readFileSync(file);
  const info = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  return info.samples;
}

/* Standard Scottie channel starts relative to the SYNC, in ms (phase 23/24 geometry). */
const STD = { G: -(2 * MODE.sepPulse + 2 * MODE.scanTime) * 1000 + MODE.sepPulse * 1000,
  B: -(MODE.sepPulse + MODE.scanTime) * 1000, R: (MODE.syncPulse + MODE.syncPorch) * 1000 };

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== phigros 解码质量诊断（重解器）===\n');
  console.log('几何: 行 ' + NOMINAL_LINE.toFixed(2) + ' 采样 · 通道 ' + (CHAN * SR).toFixed(0) +
    ' 采样 · 像素 ' + PIXEL_SAMPLES.toFixed(2) + ' 采样');
  console.log('标准通道起点（相对同步, ms）: G ' + STD.G.toFixed(2) + ' · B ' + STD.B.toFixed(2) +
    ' · R ' + STD.R.toFixed(2));
  console.log('频率轨迹: 复基带 1900 Hz + 1 ms 盒式低通 + 相位差分 → 绝对 Hz');
  if (!pngjs) console.log('  !! pngjs 未找到，将不保存图片');

  // ---------------------------------------------------------------- self-check on synthetic
  console.log('\n[自校验] 我们的合成 S1（真值已知）—— 管线不对则本节就会暴露');
  const synthRefs = [];
  const synthSamples = synthS1();
  const synthDec = await Decode.decode(synthSamples, SR, { quality: 'standard', yieldEvery: 0,
    auditLineRefs: synthRefs });
  const synthTrack = frequencyTrack(synthSamples, SR);
  const synthPlanes = samplePlanes(synthTrack, synthRefs, STD, 0, 2);
  const synthImg = compose(synthPlanes, ['R', 'G', 'B'], [1500, 2300], 'rgb', MODE.width, MODE.height);
  const sc = rowCorr(synthImg), scs = colourStats(synthImg);
  console.log('  行间相关 ' + sc.toFixed(4) + ' (应 ≈0.99) · 灰度均值 ' + scs.mean.toFixed(1) +
    ' · 色边 ' + scs.fringeMean.toFixed(1) + ' (应 ≈0)');
  // ground truth of the ramp: the corrected decode should be a horizontal ramp
  let rampErr = 0, rampN = 0;
  for (let x = 0; x < MODE.width; x++) {
    const want = Math.round(255 * x / (MODE.width - 1));
    rampErr += Math.abs(synthPlanes.G[128][x] - (1500 + want * 800 / 255));
    rampN++;
  }
  console.log('  第 128 行 G 平面相对真值斜坡的平均频率误差 ' + (rampErr / rampN).toFixed(1) + ' Hz' +
    '（1 灰阶 = 3.14 Hz）');
  if (pngjs) greyPng(synthPlanes.G, MODE.width, MODE.height, 1500, 2300, 'synth-G-plane.png');

  // ---------------------------------------------------------------- phigros
  console.log('\n[1] phigros 一行完整 dump（第 128 行）');
  const phSamples = await loadAudio(path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav'));
  const phRefs = [];
  const phDec = await Decode.decode(phSamples, SR, { quality: 'standard', yieldEvery: 0,
    auditLineRefs: phRefs });
  const phTrack = frequencyTrack(phSamples, SR);
  const phPlanes = samplePlanes(phTrack, phRefs, STD, 0, 2);
  const cal = phDec.calibration || {};
  const L = Math.min(128, phRefs.length - 1);
  console.log('  解码器自报: imageStart=' + cal.imageStart + '  clockScale=' +
    (cal.clockScale == null ? '-' : cal.clockScale.toFixed(6)) +
    '  行周期=' + (cal.clockScale * NOMINAL_LINE).toFixed(1));
  console.log('  第 ' + L + ' 行解码器同步锁定位置 = ' + phRefs[L].ref + ' 采样 (' +
    (phRefs[L].ref / SR).toFixed(4) + ' s)');
  console.log('  三通道采样起点（按标准相对同步推算）: G ' +
    Math.round(phRefs[L].ref + STD.G / 1000 * SR) + ' · B ' +
    Math.round(phRefs[L].ref + STD.B / 1000 * SR) + ' · R ' +
    Math.round(phRefs[L].ref + STD.R / 1000 * SR));
  console.log('\n  前 20 像素：频率(Hz) → 灰度');
  console.log('   px      G(Hz)  G灰     B(Hz)  B灰     R(Hz)  R灰');
  for (let x = 0; x < 20; x++) {
    const g = phPlanes.G[L][x], b = phPlanes.B[L][x], r = phPlanes.R[L][x];
    console.log('  ' + String(x).padStart(3) + ' ' + g.toFixed(1).padStart(9) + ' ' +
      String(toGrey(g, 1500, 2300)).padStart(4) + ' ' + b.toFixed(1).padStart(9) + ' ' +
      String(toGrey(b, 1500, 2300)).padStart(4) + ' ' + r.toFixed(1).padStart(9) + ' ' +
      String(toGrey(r, 1500, 2300)).padStart(4));
  }
  console.log('\n  整帧频率分布（标准起点）:');
  for (const role of ['G', 'B', 'R']) {
    let mn = 1e9, mx = -1e9, s = 0, n = 0, below = 0, above = 0;
    for (const row of phPlanes[role]) for (const v of row) {
      if (v < mn) mn = v; if (v > mx) mx = v; s += v; n++;
      if (v < 1500) below++; if (v > 2300) above++;
    }
    console.log('    ' + role + ': 均值 ' + (s / n).toFixed(1) + ' Hz · 极值 ' + mn.toFixed(0) + '..' +
      mx.toFixed(0) + ' · <1500 占 ' + (100 * below / n).toFixed(1) + '% · >2300 占 ' +
      (100 * above / n).toFixed(1) + '%');
  }

  // ---------------------------------------------------------------- hypothesis grid
  const results = [];
  const orders = [['R', 'G', 'B'], ['R', 'B', 'G'], ['B', 'G', 'R'], ['G', 'R', 'B']];
  const orderNames = ['RGB', 'RBG', 'BGR', 'GRB'];
  console.log('\n[2] 通道顺序（4 种）× [3] 色彩空间');
  for (let oi = 0; oi < orders.length; oi++) {
    for (const cs of ['rgb', 'yuv601']) {
      const img = compose(phPlanes, orders[oi], [1500, 2300], cs, MODE.width, MODE.height);
      const rc = rowCorr(img), st = colourStats(img);
      const name = 'order-' + orderNames[oi] + '-' + cs + '.png';
      const rel = savePng(img, name);
      results.push({ kind: 'order', order: orderNames[oi], colourSpace: cs, rc: rc, stats: st, file: rel });
      console.log('  ' + orderNames[oi].padEnd(4) + ' ' + cs.padEnd(7) + ' 相关 ' + rc.toFixed(4) +
        ' · 色边 ' + st.fringeMean.toFixed(1) + ' · 均值 ' + st.mean.toFixed(1) +
        ' · 白 ' + (100 * st.whiteFrac).toFixed(1) + '%');
    }
  }

  console.log('\n[4] 频率映射范围（在 RGB 顺序上）');
  for (const rng of [[1500, 2300], [1480, 2320], [1450, 2350], [1520, 2280]]) {
    const img = compose(phPlanes, ['R', 'G', 'B'], rng, 'rgb', MODE.width, MODE.height);
    const rc = rowCorr(img), st = colourStats(img);
    const name = 'range-' + rng[0] + '-' + rng[1] + '.png';
    const rel = savePng(img, name);
    results.push({ kind: 'range', range: rng, rc: rc, stats: st, file: rel });
    console.log('  ' + rng[0] + '..' + rng[1] + ' Hz  相关 ' + rc.toFixed(4) + ' · 均值 ' +
      st.mean.toFixed(1) + ' · 白 ' + (100 * st.whiteFrac).toFixed(1) + '% · 黑 ' +
      (100 * st.blackFrac).toFixed(1) + '%');
  }

  console.log('\n[5] 同步位置偏移（在 RGB 顺序、1500..2300 上）');
  const shifts = [['原位置', 0], ['−半通道', -Math.round(CHAN * SR / 2)], ['+半通道', Math.round(CHAN * SR / 2)],
    ['−一个通道', -Math.round(CHAN * SR)], ['+一个通道', Math.round(CHAN * SR)]];
  for (const [lbl, sh] of shifts) {
    const pl = sh === 0 ? phPlanes : samplePlanes(phTrack, phRefs, STD, sh, 2);
    const img = compose(pl, ['R', 'G', 'B'], [1500, 2300], 'rgb', MODE.width, MODE.height);
    const rc = rowCorr(img), st = colourStats(img);
    const name = 'shift-' + (sh === 0 ? 'none' : (sh > 0 ? 'plus' : 'minus') + Math.abs(sh)) + '.png';
    const rel = savePng(img, name);
    results.push({ kind: 'shift', label: lbl, shiftSamples: sh, rc: rc, stats: st, file: rel });
    console.log('  ' + lbl.padEnd(8) + ' (' + String(sh).padStart(7) + ' 采样)  相关 ' + rc.toFixed(4) +
      ' · 均值 ' + st.mean.toFixed(1) + ' · 色边 ' + st.fringeMean.toFixed(1));
  }

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 结论 =====');
  const bestOrder = results.filter((r) => r.kind === 'order').sort((a, b) => b.rc - a.rc)[0];
  const bestRange = results.filter((r) => r.kind === 'range').sort((a, b) => b.rc - a.rc)[0];
  const bestShift = results.filter((r) => r.kind === 'shift').sort((a, b) => b.rc - a.rc)[0];
  console.log('  最佳通道顺序/色彩空间: ' + bestOrder.order + ' + ' + bestOrder.colourSpace +
    '  (相关 ' + bestOrder.rc.toFixed(4) + ')');
  console.log('  最佳频率范围: ' + bestRange.range.join('..') + ' Hz  (相关 ' + bestRange.rc.toFixed(4) + ')');
  console.log('  最佳同步偏移: ' + bestShift.label + '  (相关 ' + bestShift.rc.toFixed(4) + ')');
  const standard = results.find((r) => r.kind === 'order' && r.order === 'RGB' && r.colourSpace === 'rgb');
  console.log('  当前基线（RGB 顺序 + RGB 合成 + 1500..2300 + 原位置）相关 ' + standard.rc.toFixed(4));
  console.log('  → ' + (bestOrder.rc - standard.rc > 0.05 || bestShift.rc - standard.rc > 0.05
    ? '存在显著更优的假设，值得改算法 ✓'
    : '没有假设显著优于当前基线 —— 问题不在通道顺序/色彩空间/频率范围/同步偏移 ✗'));

  fs.writeFileSync(path.join(OUT, 'diagnose-s1-quality.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    geometry: { nominalLineSamples: NOMINAL_LINE, chanSamples: CHAN * SR, pixelSamples: PIXEL_SAMPLES,
      standardChannelStartsMs: STD },
    syntheticSelfCheck: { rowCorr: sc, stats: scs, rampErrHz: rampErr / rampN },
    lineDump: { line: L, ref: phRefs[L].ref, startsSample: {
      G: Math.round(phRefs[L].ref + STD.G / 1000 * SR),
      B: Math.round(phRefs[L].ref + STD.B / 1000 * SR),
      R: Math.round(phRefs[L].ref + STD.R / 1000 * SR) },
      first20: Array.from({ length: 20 }, (_, x) => ({ x: x,
        G: +phPlanes.G[L][x].toFixed(2), B: +phPlanes.B[L][x].toFixed(2), R: +phPlanes.R[L][x].toFixed(2) })) },
    phigrosDecoder: { imageStart: cal.imageStart, clockScale: cal.clockScale,
      lineWindow: cal.lineWindow || null },
    results: results
  }, null, 2));
  console.log('\n证据 -> ' + path.relative(ROOT, path.join(OUT, 'diagnose-s1-quality.json')));
  console.log('图片 -> ' + path.relative(ROOT, OUT) + '\\*.png');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
