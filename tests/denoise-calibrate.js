/*
 * Phase-49: calibrate the adaptive denoiser's gate and strength TOGETHER, on a truth-known basis.
 *
 * The first shipped configuration was too conservative: on phigros it moved sigma_flat 15.16 -> 10.08
 * but sigma_HF only 24.03 -> 22.99, i.e. it removed isolated speckle and left the broadband residual
 * alone. The reference comparison says more is available - a full-image 3x3 median cuts OUR sigma_HF by
 * 65% (24.03 -> 8.34) but Robot36's by only 23% (7.04 -> 5.43), so our residual contains noise that the
 * reference render does not.
 *
 * The constraint is the other direction: a full-image median costs 5.89 dB on the synthetic control
 * (truth known). So the operating point has to be chosen from BOTH curves at once, and the gate has to
 * be reliable enough that the synthetic control never reaches the filter.
 *
 * This sweeps (tDiff, tGrad) as multiples of the image's own measured sigma and reports, for each
 * setting:
 *   - synthetic S1 control: PSNR vs truth (must stay >= 30.40, the S1 acceptance floor)
 *   - AWGN 20 dB and 10 dB controls: PSNR vs truth (the noisy cases the filter SHOULD help)
 *   - phigros: sigma_flat, sigma_HF, chroma sigma, row correlation (no truth; judged on the reference)
 * and separately sweeps the gate threshold to show the margin between "clean synthetic" and "phigros".
 *
 * Usage: node tests/denoise-calibrate.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Channel = require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}

function rowCorr(img) {
  const w = img.width, h = img.height, d = img.data;
  let sum = 0, cnt = 0;
  for (let y = 0; y + 1 < h; y++) {
    let ma = 0, mb = 0;
    for (let x = 0; x < w; x++) { ma += d[(y * w + x) * 4 + 1]; mb += d[((y + 1) * w + x) * 4 + 1]; }
    ma /= w; mb /= w;
    let num = 0, da = 0, db = 0;
    for (let x = 0; x < w; x++) {
      const u = d[(y * w + x) * 4 + 1] - ma, v = d[((y + 1) * w + x) * 4 + 1] - mb;
      num += u * v; da += u * u; db += v * v;
    }
    if (da > 0 && db > 0) { sum += num / Math.sqrt(da * db); cnt++; }
  }
  return cnt ? sum / cnt : 0;
}

// ---- use the PRODUCTION functions, so calibration cannot drift from what ships ----
const pp = Decode._internal.postprocess;
if (!pp) throw new Error('tests/decode.js has no _internal.postprocess - production functions not exported');
const measureFlatNoise = pp.measureFlatNoise;
const selectiveDenoise = (img, sigma, tDiffMul, tGradMul) => pp.selectiveDenoise(img, sigma, tDiffMul, tGradMul);

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const src = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(src, Modes.get('S1')), SR).samples;

  const cases = [];
  for (const c of [{ l: '合成 clean', s: clean }, { l: '合成 AWGN 20', s: Channel.Channel.awgn(clean, 20, 12345) },
                   { l: '合成 AWGN 10', s: Channel.Channel.awgn(clean, 10, 12345) },
                   { l: '合成 AWGN 6', s: Channel.Channel.awgn(clean, 6, 12345) }]) {
    const r = await Decode.decode(c.s, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    cases.push({ label: c.l, img: r.imageData, truth: src, base: psnr(r.imageData.data, src.data) });
  }
  const pa = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  const buf = fs.readFileSync(pa);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const rp = await Decode.decode(info.samples, info.sampleRate,
    { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  cases.push({ label: 'phigros', img: rp.imageData, truth: null, base: null });

  console.log('=== 自适应降噪：门控与强度的联合标定 ===\n');
  console.log('  用例门控读数（sigma_flat / sigma_HF / 行增益）');
  for (const c of cases) {
    const n = measureFlatNoise(c.img);
    c.noise = n;
    console.log('    ' + c.label.padEnd(16) + ' σ_flat ' + n.sigmaFlat.toFixed(2).padStart(6) +
      ' · σ_HF ' + n.sigmaHF.toFixed(2).padStart(6) + ' · 平坦占比 ' +
      (100 * n.flatFrac).toFixed(0).padStart(3) + '%' + ' · 行增益 ' + n.rowGain.toFixed(2).padStart(5) +
      (c.base == null ? '' : ' · PSNR ' + c.base.toFixed(2)));
  }

  const cleanCase = cases.find((c) => c.label === '合成 clean');
  const realCase = cases.find((c) => c.label === 'phigros');
  console.log('\n  门控间隔: clean ' + cleanCase.noise.sigmaFlat.toFixed(2) + ' vs phigros ' +
    realCase.noise.sigmaFlat.toFixed(2) + ' → 可选门限区间 [' +
    cleanCase.noise.sigmaFlat.toFixed(2) + ', ' + realCase.noise.sigmaFlat.toFixed(2) + ']');

  /* ---------------- strength sweep ---------------- */
  /*
   * Two families are swept, because the first calibration got the SELECTION WRONG:
   *
   *   (a) OUTLIER-ONLY  - replace a pixel when |pixel - 3x3 median| > tDiff, with no gradient
   *       condition at all. Noise is everywhere, so gating on flatness throws away most of the noise
   *       while still costing detail inside the flat areas it does touch. On an EDGE the pixel sits
   *       close to the median of its mixed neighbourhood (the median of a 3x3 straddling a step is
   *       usually the pixel's own side), so an edge pixel is not an outlier and survives anyway.
   *       This is the family the measured data points to.
   *   (b) GRADIENT-GATED - the first shipped version, kept for comparison so the two can be judged on
   *       the same numbers rather than on argument.
   */
  const settings = [];
  // gradient gate, pushed to the point where the synthetic cost becomes unacceptable
  for (const tDiffMul of [0.5, 0.75, 1.0]) {
    for (const tGradMul of [1.5, 2.0, 2.5, 3.0, 4.0, 6.0]) settings.push({ family: '梯度门', tDiffMul, tGradMul });
  }
  // and one repetition pass at the best-looking region, to see whether iterating buys anything
  for (const tGradMul of [1.5, 2.0]) settings.push({ family: '梯度门x2', tDiffMul: 0.75, tGradMul });
  console.log('\n  强度扫描（阈值均为该图自身 σ 的倍数）');
  console.log('    选择方式 tDiff tGrad | 合成clean PSNR | AWGN20 | AWGN10 | AWGN6 | phigros σ_flat σ_HF 色度σ 行相关');
  const rows = [];
  for (const s of settings) {
    const line = [];
    let phStats = null;
    for (const c of cases) {
      let out = selectiveDenoise(c.img, c.noise.sigmaFlat, s.tDiffMul, s.tGradMul);
      if (s.family === '梯度门x2') out = selectiveDenoise(out, c.noise.sigmaFlat, s.tDiffMul, s.tGradMul);
      if (c.truth) {
        line.push(psnr(out.data, c.truth.data));
      } else {
        const n2 = measureFlatNoise(out);
        const sdGR = (() => {
          const d = out.data;
          let a = 0, a2 = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { const t = d[i + 1] - d[i]; a += t; a2 += t * t; n++; }
          return Math.sqrt(Math.max(0, a2 / n - (a / n) * (a / n)));
        })();
        phStats = { sigmaFlat: n2.sigmaFlat, sigmaHF: n2.sigmaHF, sdGR: sdGR, rowCorr: rowCorr(out) };
      }
    }
    rows.push({ family: s.family, tDiffMul: s.tDiffMul, tGradMul: s.tGradMul, psnr: line, phigros: phStats });
    console.log('    ' + s.family.padEnd(8) + ' ' + s.tDiffMul.toFixed(2) + '  ' +
      (isFinite(s.tGradMul) ? s.tGradMul.toFixed(2) : '  无') + '  | ' +
      line.map((v) => v.toFixed(2).padStart(13)).join(' ') + ' | ' +
      phStats.sigmaFlat.toFixed(2).padStart(7) + ' ' + phStats.sigmaHF.toFixed(2).padStart(5) + ' ' +
      phStats.sdGR.toFixed(1).padStart(5) + ' ' + phStats.rowCorr.toFixed(4).padStart(7));
  }

  const base = { clean: cleanCase.base, awgn20: cases.find((c) => c.label === '合成 AWGN 20').base,
    awgn10: cases.find((c) => c.label === '合成 AWGN 10').base,
    awgn6: cases.find((c) => c.label === '合成 AWGN 6').base,
    phFlat: realCase.noise.sigmaFlat, phHF: realCase.noise.sigmaHF, phRow: rowCorr(realCase.img) };
  console.log('\n  基线: clean ' + base.clean.toFixed(2) + ' · AWGN20 ' + base.awgn20.toFixed(2) +
    ' · AWGN10 ' + base.awgn10.toFixed(2) + ' · AWGN6 ' + base.awgn6.toFixed(2) +
    ' · phigros σ_flat ' + base.phFlat.toFixed(2) + ' σ_HF ' + base.phHF.toFixed(2) +
    ' 行相关 ' + base.phRow.toFixed(4));

  fs.writeFileSync(path.join(OUT, 'denoise-calibrate.json'),
    JSON.stringify({ cases: cases.map((c) => ({ label: c.label, noise: c.noise, base: c.base })),
      settings: rows, base: base }, null, 2));
  console.log('\n证据 -> tests/diag-quality/denoise-calibrate.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
