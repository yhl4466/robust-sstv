/*
 * PD120 isolation diagnostic.
 *
 * The PD round trip scores ~5.8 dB, which is near-random. Two very different causes give
 * that symptom:
 *   (a) block ALIGNMENT is wrong, so every scan is sampled in the wrong place, or
 *   (b) the scan SAMPLING / colour maths is wrong even with perfect alignment.
 *
 * For a synthesised signal with no clock error the block starts are analytically known, so
 * running the sampling stage with nominal offsets separates the two. It also reports what
 * the "minimum frequency" sync search actually finds, because a 20 ms sync pulse is a
 * PLATEAU - the minimum-frequency offset is not unique inside it, which would explain a
 * search that cannot localise the pulse.
 *
 * Usage: node scripts/diagnose-pd.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Dec = globalThis.SSTVDecode;
const { PNG } = require(path.join(RESEARCH, 'pngjs'));

const SR = 48000;
const mode = Modes.get('PD120');
const W = mode.width, H = mode.height;

function calcLum(freq) {
  const v = Math.round((freq - Modes.FREQ_BLACK) / Modes.COLOR_FREQ_MULT);
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}
const INV = (function () {
  const C = Modes.YUV_PD;
  const m = [
    [C.yR, C.yG, C.yB],
    [C.ryR / C.ryScale, C.ryG / C.ryScale, C.ryB / C.ryScale],
    [C.byR / C.ryScale, C.byG / C.ryScale, C.byB / C.ryScale]
  ];
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det]
  ];
})();

function ramp(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] = Math.round(127 + 120 * Math.sin(x / 17));
      d[o + 1] = Math.round(127 + 120 * Math.sin(y / 13 + 1));
      d[o + 2] = Math.round(127 + 120 * Math.sin((x + y) / 23));
      d[o + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}
function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    for (const o of [0, 1, 2]) { const d = a.data[i * 4 + o] - b.data[i * 4 + o]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
function save(file, img) {
  const p = new PNG({ width: img.width, height: img.height });
  p.data = Buffer.from(img.data);
  fs.writeFileSync(file, PNG.sync.write(p));
}

(async function main() {
  const img = ramp(W, H);
  const tl = Timeline.build(img, mode);
  const samples = Synth.synthesize(tl, SR).samples;
  const imageStart = Math.round(Modes.VIS_HEADER_LEN * SR);

  const syncSamples = Math.round(mode.syncPulse * SR);
  const blankSamples = Math.round(mode.blanking * SR);
  const scanSamples = mode.scanTime * SR;
  const blockSamples = syncSamples + blankSamples + mode.channels * scanSamples;
  const pixT = mode.scanTime / W;
  const pixelWindow = Math.round(pixT * (mode.windowFactor || 2.34) * SR);

  console.log(`PD120 diagnostic: imageStart=${imageStart}, pixelWindow=${pixelWindow} samples, ` +
    `scanSamples=${scanSamples.toFixed(1)}, blockSamples=${blockSamples.toFixed(1)}`);
  console.log(`pixel step = ${(scanSamples / W).toFixed(3)} samples (${(pixT * 1e6).toFixed(1)} us)`);

  // ---- what does the minimum-frequency sync search actually see? ----
  const est = new Dec._internal.Estimator(SR, 16);
  console.log('\n=== sync-pulse plateau probe (nominal first block start ' + imageStart + ') ===');
  console.log('offset(samples)  offset(ms)  measured Hz');
  for (let d = -600; d <= 1600; d += 200) {
    const o = imageStart + d;
    if (o < 0 || o + syncSamples > samples.length) continue;
    const f = est.peak(samples, o, syncSamples);
    console.log(`  ${String(o).padStart(7)}   ${(d / SR * 1000).toFixed(2).padStart(7)}   ${f.toFixed(1)}`);
  }

  // ---- sample with ANALYTIC block starts ----
  const halfWindow = pixelWindow / 2;
  const Yp = new Float32Array(W * H);
  const RYp = new Float32Array(W * (H / 2));
  const BYp = new Float32Array(W * (H / 2));
  const pairs = H / 2;
  for (let p = 0; p < pairs; p++) {
    const base = Math.round(imageStart + p * blockSamples) + syncSamples + blankSamples;
    for (let s = 0; s < mode.channels; s++) {
      const comp = mode.scanOrder[s];
      const sc0 = base + s * scanSamples;
      const step = scanSamples / W;
      for (let x = 0; x < W; x++) {
        const centre = sc0 + (x + 0.5) * step;
        let off = Math.round(centre - halfWindow);
        if (off < 0) off = 0;
        if (off + pixelWindow > samples.length) off = samples.length - pixelWindow;
        const f = est.peak(samples, off, pixelWindow);
        const lum = calcLum(f);
        if (comp === 'Y') Yp[((s === 0 ? p * 2 : p * 2 + 1)) * W + x] = lum;
        else if (comp === 'RY') RYp[p * W + x] = lum;
        else if (comp === 'BY') BYp[p * W + x] = lum;
      }
    }
  }
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const cp = (y >> 1) * W;
    for (let x = 0; x < W; x++) {
      const Y = Yp[y * W + x], u = RYp[cp + x] - 128, v = BYp[cp + x] - 128;
      const R = INV[0][0] * Y + INV[0][1] * u + INV[0][2] * v;
      const G = INV[1][0] * Y + INV[1][1] * u + INV[1][2] * v;
      const B = INV[2][0] * Y + INV[2][1] * u + INV[2][2] * v;
      const o = (y * W + x) * 4;
      out[o] = R < 0 ? 0 : (R > 255 ? 255 : R);
      out[o + 1] = G < 0 ? 0 : (G > 255 ? 255 : G);
      out[o + 2] = B < 0 ? 0 : (B > 255 ? 255 : B);
      out[o + 3] = 255;
    }
  }
  const result = { data: out, width: W, height: H };
  save(path.join(ROOT, 'scripts', 'out', 'pd120-analytic.png'), result);
  // ---- window-length sweep: the decisive calibration ----
  /*
   * PD120's pixel time is 190 us = 9.12 samples at 48 kHz, so windowFactor 2.34 gives a
   * 21-sample window - LESS THAN ONE PERIOD of the 1200 Hz sync tone (40 samples). With
   * under a period inside the window the Hann mainlobe is ~9 kHz wide, the peak position
   * depends on the tone's phase, and the frequency estimate is meaningless. That is why the
   * round trip sits at ~6 dB even with PERFECT block alignment.
   *
   * The sweep below measures the real tradeoff: a longer window resolves frequency better
   * but smears across more pixels (190 us each).
   */
  console.log('\n=== windowFactor sweep (analytic block starts) ===');
  // source luminance plane for the Y-plane error, computed here so the sweep does not
  // depend on the plane-check section further down
  const srcY = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    srcY[i] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
  }
  console.log('windowFactor  window(samples)  window(ms)  periods@1200Hz  smeared px  PSNR  Y-RMS');
  for (const wf of [2.34, 4, 6, 8, 10, 12, 16, 20, 26, 32]) {
    const pw = Math.max(8, Math.round(pixT * wf * SR));
    const hw = pw / 2;
    const Y2 = new Float32Array(W * H), RY2 = new Float32Array(W * (H / 2)), BY2 = new Float32Array(W * (H / 2));
    for (let p = 0; p < pairs; p++) {
      const b2 = Math.round(imageStart + p * blockSamples) + syncSamples + blankSamples;
      for (let s = 0; s < mode.channels; s++) {
        const comp = mode.scanOrder[s];
        const sc0 = b2 + s * scanSamples;
        const st = scanSamples / W;
        for (let x = 0; x < W; x++) {
          const centre = sc0 + (x + 0.5) * st;
          let off = Math.round(centre - hw);
          if (off < 0) off = 0;
          if (off + pw > samples.length) off = samples.length - pw;
          const lum = calcLum(est.peak(samples, off, pw));
          if (comp === 'Y') Y2[(s === 0 ? p * 2 : p * 2 + 1) * W + x] = lum;
          else if (comp === 'RY') RY2[p * W + x] = lum;
          else if (comp === 'BY') BY2[p * W + x] = lum;
        }
      }
    }
    const o2 = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const cp = (y >> 1) * W;
      for (let x = 0; x < W; x++) {
        const Y = Y2[y * W + x], u = RY2[cp + x] - 128, v = BY2[cp + x] - 128;
        const R = INV[0][0] * Y + INV[0][1] * u + INV[0][2] * v;
        const G = INV[1][0] * Y + INV[1][1] * u + INV[1][2] * v;
        const B = INV[2][0] * Y + INV[2][1] * u + INV[2][2] * v;
        const o = (y * W + x) * 4;
        o2[o] = R < 0 ? 0 : (R > 255 ? 255 : R);
        o2[o + 1] = G < 0 ? 0 : (G > 255 ? 255 : G);
        o2[o + 2] = B < 0 ? 0 : (B > 255 ? 255 : B);
        o2[o + 3] = 255;
      }
    }
    let se2 = 0;
    for (let i = 0; i < W * H; i++) { const d = Y2[i] - srcY[i]; se2 += d * d; }
    const img2 = { data: o2, width: W, height: H };
    console.log(`  ${String(wf).padStart(6)}      ${String(pw).padStart(6)}        ${(pw / SR * 1000).toFixed(2).padStart(6)}   ` +
      `${(pw / 40).toFixed(2).padStart(6)}        ${(pw / (scanSamples / W)).toFixed(1).padStart(5)}    ` +
      `${psnr(img2, img).toFixed(2).padStart(6)}  ${Math.sqrt(se2 / (W * H)).toFixed(1)}`);
    if (wf === 12) save(path.join(ROOT, 'scripts', 'out', 'pd120-wf12.png'), img2);
  }

  console.log('\n=== analytic-start sampling with windowFactor ' + (mode.windowFactor || 2.34) + ': PSNR ' + psnr(result, img).toFixed(2) + ' dB ===');

  // ---- what does the full decoder do with the same signal? ----
  const dec = await Dec.decode(samples, SR, { quality: 'standard', yieldFn: () => Promise.resolve() });
  console.log(`=== full decoder (with sync search):       PSNR ${dec.ok ? psnr(dec.imageData, img).toFixed(2) : 'FAIL'} dB ===`);

  // ---- plane-level check: is the Y plane alone right? ----
  const srcGray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    srcGray[i] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
  }
  let se = 0;
  for (let i = 0; i < W * H; i++) { const d = Yp[i] - srcGray[i]; se += d * d; }
  console.log(`Y-plane RMS error: ${Math.sqrt(se / (W * H)).toFixed(2)} grey levels (0 = perfect)`);
  let ry = 0, by = 0;
  for (let i = 0; i < W * (H / 2); i++) {
    const y = (i / W | 0) * 2, x = i % W;
    const o1 = (y * W + x) * 4, o2 = ((y + 1) * W + x) * 4;
    const wantRY = (0.299 * 0 + 128 + (112.439 * img.data[o1] - 94.154 * img.data[o1 + 1] - 18.285 * img.data[o1 + 2]) / 256);
    const wantBY = (128 + (-37.945 * img.data[o1] - 74.494 * img.data[o1 + 1] + 112.439 * img.data[o1 + 2]) / 256);
    ry += (RYp[i] - wantRY) ** 2;
    by += (BYp[i] - wantBY) ** 2;
  }
  console.log(`RY-plane RMS error: ${Math.sqrt(ry / (W * (H / 2))).toFixed(2)} grey levels`);
  console.log(`BY-plane RMS error: ${Math.sqrt(by / (W * (H / 2))).toFixed(2)} grey levels`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
