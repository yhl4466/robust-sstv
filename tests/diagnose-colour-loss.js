/*
 * Where is the colour lost?  Three-layer chroma analysis of the new OBS recording.
 *
 * SYMPTOM
 *   The new recording decodes to a recognisable figure but almost colourless - grey overall, colour
 *   only along edges - while Robot36 renders the same audio in colour with contrast.
 *
 * WHY THREE LAYERS
 *   "It has no colour" can be true at three different places, and only separating them says which:
 *     (1) THE SOURCE  - chroma present in the audio itself, measured on the sampled colour planes
 *     (2) OUR OUTPUT  - chroma surviving our own composition of those planes
 *     (3) REFERENCE   - chroma in Robot36's render of the same audio
 *   If (1) is already low the recording is the limit and no algorithm change helps; if (1) is healthy
 *   but (2) is not, our composition is at fault; if (1) and (2) match but (3) is much higher, it is a
 *   contrast/level question rather than an absence of colour.
 *
 * ESTIMATOR
 *   A Hann-windowed FFT magnitude peak with parabolic refinement, matching the production estimator
 *   rather than the phase-difference tracker used in phases 30/31. That tracker carried ~80 Hz of
 *   per-pixel noise, which is ~26 grey levels - enough to drown the chroma this script is trying to
 *   measure.
 *
 * Usage: node tests/diagnose-colour-loss.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000, FFT_PAD = 512;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, FFT = globalThis.FFT;
const MODE = Modes.get('S1');
const NOMINAL_LINE = Modes.lineTime(MODE) * SR;
const CHAN = MODE.sepPulse + MODE.scanTime;
const PIXEL_SAMPLES = MODE.scanTime / MODE.width * SR;
const WIN = Math.round(PIXEL_SAMPLES * 2.48);            // production windowFactor for S1
const HANN = new Float64Array(WIN);
for (let i = 0; i < WIN; i++) HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (WIN - 1)));

let pngjs = null;
try { pngjs = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); } catch (e) {}

const fftCache = {};
/** Frequency (Hz) at one sample offset: Hann window + zero-padded FFT magnitude peak. */
function freqAt(x, at, size) {
  const n = size || FFT_PAD;
  let e = fftCache[n];
  if (!e) { e = { fft: new FFT(n), out: new Float32Array(2 * n), mags: new Float32Array(n / 2 + 1) }; fftCache[n] = e; }
  const data = new Float32Array(2 * n);
  const half = WIN >> 1;
  for (let i = 0; i < WIN; i++) {
    const j = at - half + i;
    if (j >= 0 && j < x.length) data[2 * i] = x[j] * HANN[i];
  }
  e.fft.realTransform(e.out, data);
  e.fft.completeSpectrum(e.out);
  const mags = e.mags, m = e.out;
  const bins = n / 2 + 1;
  for (let k = 0; k < bins; k++) mags[k] = Math.sqrt(m[2 * k] * m[2 * k] + m[2 * k + 1] * m[2 * k + 1]);
  const lo = Math.max(1, Math.floor(1300 * n / SR)), hi = Math.min(bins - 2, Math.ceil(2500 * n / SR));
  let bk = lo, bv = -1;
  for (let k = lo; k <= hi; k++) if (mags[k] > bv) { bv = mags[k]; bk = k; }
  const y0 = mags[bk - 1], y1 = mags[bk], y2 = mags[bk + 1];
  const d = y0 - 2 * y1 + y2;
  const shift = d === 0 ? 0 : 0.5 * (y0 - y2) / d;
  return (bk + shift) * SR / n;
}

/** Sample the three colour planes for all lines at the standard Scottie offsets. */
function samplePlanes(x, refs, shiftSamples) {
  const starts = {
    G: -(2 * MODE.sepPulse + 2 * MODE.scanTime) + MODE.sepPulse,
    B: -(MODE.sepPulse + MODE.scanTime),
    R: (MODE.syncPulse + MODE.syncPorch)
  };
  const planes = { R: [], G: [], B: [] };
  for (const r of refs) {
    for (const role of ['G', 'B', 'R']) {
      const s0 = r.ref + (shiftSamples || 0) + starts[role] * SR;
      const v = new Float64Array(MODE.width);
      for (let px = 0; px < MODE.width; px++) v[px] = freqAt(x, Math.round(s0 + (px + 0.5) * PIXEL_SAMPLES));
      planes[role].push(v);
    }
  }
  return planes;
}

const grey = (hz) => Math.max(0, Math.min(255, Math.round(255 * (hz - 1500) / 800)));

/** Chroma metrics on three grey planes: how far each pixel is from grey, plus plane correlations. */
function planeChroma(P) {
  let satSum = 0, n = 0, lumaVar = 0, lumaSum = 0;
  const cross = { RG: 0, RB: 0, GB: 0 };
  const vsum = { R: 0, G: 0, B: 0 }, vsum2 = { R: 0, G: 0, B: 0 };
  const pts = [];
  for (let y = 0; y < P.R.length; y++) {
    for (let x = 0; x < P.R[y].length; x++) {
      const R = grey(P.R[y][x]), G = grey(P.G[y][x]), B = grey(P.B[y][x]);
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      satSum += mx - mn; n++;
      const L = (R + G + B) / 3;
      lumaSum += L;
      pts.push({ R: R, G: G, B: B, L: L });
      vsum.R += R; vsum.G += G; vsum.B += B;
      vsum2.R += R * R; vsum2.G += G * G; vsum2.B += B * B;
    }
  }
  const meanL = lumaSum / n;
  for (const p of pts) lumaVar += (p.L - meanL) * (p.L - meanL);
  const sd = {};
  for (const c of ['R', 'G', 'B']) sd[c] = Math.sqrt(vsum2[c] / n - (vsum[c] / n) * (vsum[c] / n));
  const cov = (a, b) => {
    let s = 0;
    for (const p of pts) s += (p[a] - vsum[a] / n) * (p[b] - vsum[b] / n);
    return s / n;
  };
  const corr = (a, b) => { const c = cov(a, b); return (sd[a] > 0 && sd[b] > 0) ? c / (sd[a] * sd[b]) : 0; };
  return { n: n, satMean: satSum / n, lumaVar: lumaVar / n, lumaSd: Math.sqrt(lumaVar / n),
    meanL: meanL, sdR: sd.R, sdG: sd.G, sdB: sd.B,
    corrRG: corr('R', 'G'), corrRB: corr('R', 'B'), corrGB: corr('G', 'B'),
    chromaVar: (cov('R', 'R') + cov('G', 'G') + cov('B', 'B')) / 3 - cov('R', 'G') * 0 + 0 };
}

/** Same metrics on an RGBA image (ours or Robot36's), so the three layers are comparable. */
function imageChroma(img) {
  const d = img.data, w = img.width, h = img.height;
  let satSum = 0, n = 0, lumaSum = 0;
  const pts = [];
  const vs = { R: 0, G: 0, B: 0 }, vs2 = { R: 0, G: 0, B: 0 };
  for (let i = 0; i < w * h; i++) {
    const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2];
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    satSum += mx - mn; n++;
    const L = (R + G + B) / 3; lumaSum += L;
    pts.push({ R: R, G: G, B: B, L: L });
    vs.R += R; vs.G += G; vs.B += B; vs2.R += R * R; vs2.G += G * G; vs2.B += B * B;
  }
  const meanL = lumaSum / n, sd = {};
  for (const c of ['R', 'G', 'B']) sd[c] = Math.sqrt(vs2[c] / n - (vs[c] / n) * (vs[c] / n));
  let lv = 0;
  for (const p of pts) lv += (p.L - meanL) * (p.L - meanL);
  const cov = (a, b) => { let s = 0; for (const p of pts) s += (p[a] - vs[a] / n) * (p[b] - vs[b] / n); return s / n; };
  const corr = (a, b) => { const c = cov(a, b); return (sd[a] > 0 && sd[b] > 0) ? c / (sd[a] * sd[b]) : 0; };
  return { n: n, satMean: satSum / n, lumaSd: Math.sqrt(lv / n), meanL: meanL,
    sdR: sd.R, sdG: sd.G, sdB: sd.B,
    corrRG: corr('R', 'G'), corrRB: corr('R', 'B'), corrGB: corr('G', 'B') };
}

function histogram(img, bins) {
  const d = img.data, h = new Array(bins).fill(0), n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const L = Math.round((d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3);
    h[Math.min(bins - 1, Math.floor(L * bins / 256))]++;
  }
  return h.map((v) => v / n);
}

function bboxOfColour(img, thr) {
  const d = img.data, w = img.width, h = img.height;
  let x0 = w, x1 = -1, y0 = h, y1 = -1, cnt = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mx - mn > thr) { cnt++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return cnt > 100 ? { x0: x0, y0: y0, x1: x1, y1: y1, frac: cnt / (w * h) } : null;
}

/** Nearest-neighbour downscale to 320x256 so a screenshot is comparable with a native decode. */
function resize(img, W, H) {
  const out = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x * img.width / W));
      const sy = Math.min(img.height - 1, Math.floor(y * img.height / H));
      const s = (sy * img.width + sx) * 4, t = (y * W + x) * 4;
      out.data[t] = img.data[s]; out.data[t + 1] = img.data[s + 1];
      out.data[t + 2] = img.data[s + 2]; out.data[t + 3] = 255;
    }
  }
  return out;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const audioPath = path.join(OUT, 'new-rec-48k-mono.wav');
  const b = fs.readFileSync(audioPath);
  const info = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const x = info.samples;
  console.log('=== "没色" 三层色度诊断 ===\n');
  console.log('音频: 新 OBS 录音 ' + info.duration.toFixed(3) + ' s @ ' + info.sampleRate + ' Hz');
  console.log('估计器: Hann 窗 ' + WIN + ' 采样 (' + (WIN / SR * 1000).toFixed(2) +
    ' ms = 像素 × 2.48) + 零填充 ' + FFT_PAD + ' 点 FFT 峰 + 抛物线细化');

  const refs = [];
  const dec = await Decode.decode(x, info.sampleRate, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  const cal = dec.calibration || {};
  console.log('\n生产解码器: clockScale=' + cal.clockScale.toFixed(6) + ' 行周期=' +
    (cal.clockScale * NOMINAL_LINE).toFixed(1) + ' · 逐行参考 ' + refs.length + ' 行');

  // ---------------------------------------------------------------- layer 1: source
  console.log('\n[层 1] 源头：从音频直接采出的三个色平面');
  const t0 = Date.now();
  const P = samplePlanes(x, refs, 0);
  console.log('  采样完成 (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  const src = planeChroma(P);
  console.log('  色度饱和度均值 ' + src.satMean.toFixed(1) + ' 灰阶 · 亮度标准差 ' + src.lumaSd.toFixed(1));
  console.log('  平面标准差: R ' + src.sdR.toFixed(1) + ' · G ' + src.sdG.toFixed(1) + ' · B ' + src.sdB.toFixed(1));
  console.log('  平面相关: R-G ' + src.corrRG.toFixed(4) + ' · R-B ' + src.corrRB.toFixed(4) +
    ' · G-B ' + src.corrGB.toFixed(4) + '   (接近 1 = 三通道内容雷同 = 必然发灰)');

  // ---------------------------------------------------------------- layer 2: our output
  console.log('\n[层 2] 我们的输出（生产解码器 PNG）');
  const ourBuf = fs.readFileSync(path.join(OUT, 'new-ours.png'));
  const ourImg = pngjs.PNG.sync.read(ourBuf);
  const ours = imageChroma(ourImg);
  console.log('  色度饱和度均值 ' + ours.satMean.toFixed(1) + ' · 亮度标准差 ' + ours.lumaSd.toFixed(1) +
    ' · 亮度均值 ' + ours.meanL.toFixed(1));
  console.log('  平面标准差: R ' + ours.sdR.toFixed(1) + ' · G ' + ours.sdG.toFixed(1) + ' · B ' + ours.sdB.toFixed(1));
  console.log('  平面相关: R-G ' + ours.corrRG.toFixed(4) + ' · R-B ' + ours.corrRB.toFixed(4) +
    ' · G-B ' + ours.corrGB.toFixed(4));
  const ourHist = histogram(ourImg, 16);
  console.log('  灰度直方图(16 档): ' + ourHist.map((v) => (v * 100).toFixed(0)).join(' '));

  // ---------------------------------------------------------------- layer 3: reference
  console.log('\n[层 3] Robot36 参照（864×1920 手机截图，含 App UI）');
  const refImg = pngjs.PNG.sync.read(fs.readFileSync(path.join(OUT, 'ref-robot36.png')));
  console.log('  原始尺寸 ' + refImg.width + '×' + refImg.height);
  const bb = bboxOfColour(refImg, 40);
  let crop = refImg;
  if (bb) {
    const cw = bb.x1 - bb.x0 + 1, ch = bb.y1 - bb.y0 + 1;
    const c = { data: new Uint8ClampedArray(cw * ch * 4), width: cw, height: ch };
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const s = ((bb.y0 + y) * refImg.width + (bb.x0 + x)) * 4, t = (y * cw + x) * 4;
        c.data[t] = refImg.data[s]; c.data[t + 1] = refImg.data[s + 1];
        c.data[t + 2] = refImg.data[s + 2]; c.data[t + 3] = 255;
      }
    }
    crop = c;
    console.log('  彩色内容包围盒 x ' + bb.x0 + '..' + bb.x1 + ' · y ' + bb.y0 + '..' + bb.y1 +
      ' (' + cw + '×' + ch + ', 占全图 ' + (bb.frac * 100).toFixed(1) + '%)');
  } else {
    console.log('  未能检出彩色区域，改用全图统计');
  }
  const refSmall = resize(crop, 320, 256);
  const ref = imageChroma(refSmall);
  console.log('  裁区域降采样到 320×256 后:');
  console.log('  色度饱和度均值 ' + ref.satMean.toFixed(1) + ' · 亮度标准差 ' + ref.lumaSd.toFixed(1) +
    ' · 亮度均值 ' + ref.meanL.toFixed(1));
  console.log('  平面标准差: R ' + ref.sdR.toFixed(1) + ' · G ' + ref.sdG.toFixed(1) + ' · B ' + ref.sdB.toFixed(1));
  console.log('  平面相关: R-G ' + ref.corrRG.toFixed(4) + ' · R-B ' + ref.corrRB.toFixed(4) +
    ' · G-B ' + ref.corrGB.toFixed(4));
  const refHist = histogram(refSmall, 16);
  console.log('  灰度直方图(16 档): ' + refHist.map((v) => (v * 100).toFixed(0)).join(' '));

  // ---------------------------------------------------------------- three-layer table
  console.log('\n===== 三层对比 =====');
  console.log('  层                 饱和度均值   亮度标准差    R-G 相关    G-B 相关');
  console.log('  1 源头(音频平面)   ' + src.satMean.toFixed(1).padStart(11) + ' ' +
    src.lumaSd.toFixed(1).padStart(12) + ' ' + src.corrRG.toFixed(4).padStart(11) + ' ' +
    src.corrGB.toFixed(4).padStart(11));
  console.log('  2 我们的输出       ' + ours.satMean.toFixed(1).padStart(11) + ' ' +
    ours.lumaSd.toFixed(1).padStart(12) + ' ' + ours.corrRG.toFixed(4).padStart(11) + ' ' +
    ours.corrGB.toFixed(4).padStart(11));
  console.log('  3 Robot36 参照     ' + ref.satMean.toFixed(1).padStart(11) + ' ' +
    ref.lumaSd.toFixed(1).padStart(12) + ' ' + ref.corrRG.toFixed(4).padStart(11) + ' ' +
    ref.corrGB.toFixed(4).padStart(11));

  // ---------------------------------------------------------------- line dump (task 1)
  const L = Math.min(128, refs.length - 1);
  console.log('\n[任务 1] 第 ' + L + ' 行完整 dump');
  console.log('  同步锁定 = ' + refs[L].ref + ' 采样 (' + (refs[L].ref / SR).toFixed(4) + ' s)');
  const span = Math.round(MODE.scanTime * SR);
  for (const role of ['G', 'B', 'R']) {
    const off = role === 'G' ? -(2 * MODE.sepPulse + 2 * MODE.scanTime) + MODE.sepPulse
      : (role === 'B' ? -(MODE.sepPulse + MODE.scanTime) : (MODE.syncPulse + MODE.syncPorch));
    const s0 = Math.round(refs[L].ref + off * SR);
    console.log('  ' + role + ': 起点 ' + s0 + ' 终点 ' + (s0 + span) + ' 跨度 ' + span +
      ' 采样 (' + (MODE.scanTime * 1000).toFixed(2) + ' ms)');
  }
  const s1 = Math.round(refs[L].ref + (-(MODE.sepPulse + MODE.scanTime)) * SR) + span;
  const s2 = Math.round(refs[L].ref + (MODE.syncPulse + MODE.syncPorch) * SR);
  console.log('  通道间空隙: B 终点 → R 起点 = ' + (s2 - s1) + ' 采样 (同步 ' +
    Math.round(MODE.syncPulse * SR) + ' + 台阶 ' + Math.round(MODE.syncPorch * SR) + ')');
  console.log('\n  前 20 像素：');
  console.log('   px     G(Hz)  G灰     B(Hz)  B灰     R(Hz)  R灰    G-B灰  G-R灰');
  for (let px = 0; px < 20; px++) {
    const g = P.G[L][px], bb2 = P.B[L][px], r = P.R[L][px];
    const gg = grey(g), gb = grey(bb2), gr = grey(r);
    console.log('  ' + String(px).padStart(3) + ' ' + g.toFixed(1).padStart(9) + ' ' +
      String(gg).padStart(4) + ' ' + bb2.toFixed(1).padStart(9) + ' ' + String(gb).padStart(4) + ' ' +
      r.toFixed(1).padStart(9) + ' ' + String(gr).padStart(4) + ' ' +
      String(gg - gb).padStart(6) + ' ' + String(gg - gr).padStart(6));
  }

  // ---------------------------------------------------------------- offset sweep (task 4)
  console.log('\n[任务 4] 同步位置偏移扫描（色度饱和度为主判据）');
  const shifts = [['原位置', 0], ['−0.5 ms', -24], ['+0.5 ms', 24], ['−1 ms', -48], ['+1 ms', 48],
    ['−2 ms', -96], ['+2 ms', 96], ['−半通道', -Math.round(CHAN * SR / 2)], ['+半通道', Math.round(CHAN * SR / 2)]];
  const sweep = [];
  console.log('  偏移           采样      饱和度均值   亮度标准差   R-G 相关');
  for (const [lbl, sh] of shifts) {
    const PP = sh === 0 ? P : samplePlanes(x, refs, sh);
    const st = planeChroma(PP);
    sweep.push({ label: lbl, shift: sh, satMean: st.satMean, lumaSd: st.lumaSd, corrRG: st.corrRG });
    console.log('  ' + lbl.padEnd(12) + String(sh).padStart(7) + ' ' + st.satMean.toFixed(1).padStart(12) +
      ' ' + st.lumaSd.toFixed(1).padStart(12) + ' ' + st.corrRG.toFixed(4).padStart(11));
  }
  const best = sweep.slice().sort((a, b2) => b2.satMean - a.satMean)[0];

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 结论 =====');
  const srcOk = src.satMean > 0.5 * ref.satMean;
  console.log('  源头饱和度 ' + src.satMean.toFixed(1) + ' vs 参照 ' + ref.satMean.toFixed(1) +
    ' → ' + (srcOk ? '源头色度充足 ✓ 不是录音缺色' : '源头色度明显偏低 ✗ 录音/编码本身缺色'));
  console.log('  输出饱和度 ' + ours.satMean.toFixed(1) + ' vs 源头 ' + src.satMean.toFixed(1) +
    ' → ' + (ours.satMean > 0.8 * src.satMean ? '合成未丢色 ✓' : '合成把色丢了 ✗'));
  console.log('  G-B 平面相关 源头 ' + src.corrGB.toFixed(4) + ' / 参照 ' + ref.corrGB.toFixed(4) +
    ' → ' + (src.corrGB > 0.9 ? '三通道内容高度雷同（这就是发灰的机械原因）✗' : '三通道内容确有区分 ✓'));
  console.log('  最佳偏移 ' + best.label + ' (' + best.shift + ' 采样) 饱和度 ' + best.satMean.toFixed(1) +
    ' vs 原位置 ' + sweep[0].satMean.toFixed(1) +
    ' → ' + (Math.abs(best.satMean - sweep[0].satMean) < 0.5 ? '偏移没有改善色度 ✗'
      : '偏移改善 ' + (best.satMean - sweep[0].satMean).toFixed(1) + ' ✓'));

  fs.writeFileSync(path.join(OUT, 'colour-loss.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), audio: 'new-rec-48k-mono.wav',
    durationS: info.duration, estimator: { winSamples: WIN, winMs: WIN / SR * 1000, fftPad: FFT_PAD },
    decoder: { clockScale: cal.clockScale, lineSamples: cal.clockScale * NOMINAL_LINE, rows: refs.length },
    layer1_source: src, layer2_ours: ours, layer3_reference: ref,
    referenceBBox: bb, histogramOurs: ourHist, histogramReference: refHist,
    lineDump: { line: L, ref: refs[L].ref,
      first20: Array.from({ length: 20 }, (_, px) => ({ px: px,
        G: +P.G[L][px].toFixed(1), B: +P.B[L][px].toFixed(1), R: +P.R[L][px].toFixed(1) })) },
    offsetSweep: sweep, verdict: { sourceHasChroma: srcOk,
      compositionLosesChroma: !(ours.satMean > 0.8 * src.satMean), bestShift: best }
  }, null, 2));
  console.log('\n证据 -> tests/diag-quality/colour-loss.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
