/*
 * The frequency-offset asymmetry, explained: the image search band's LOWER edge walks onto the sync tone.
 *
 * LOCALISED IN tests/diagnose-pixel-audit.js, which added the per-pixel frequency audit that was missing.
 * On a flat field (every pixel carries the same tone, so the truth is known exactly):
 *
 *   频偏    带下界   raw 中位   raw SD   raw 范围       灰度 SD
 *      0     1300    1875.0    25.16   1336..1922      7.55
 *    +20     1320    1921.9     8.45   1383..1922      2.61
 *    -20     1279    1875.0    26.81   1336..1875      7.48
 *    +50     1350    1968.7    24.19   1383..1969      7.71
 *    -50     1250    1828.2    50.16   1289..1875     14.06
 *
 * The pattern is not "negative offsets are worse". It is "a band lower edge near 1300 Hz is worse":
 *
 *   - the 1200 Hz sync tone is present in ~2% of every line, and a pixel analysis window that overlaps a
 *     sync pulse sees a tone about 20 dB stronger than the scan content;
 *   - the pixel window is only ~2.5 px (~119 samples at 48 kHz, about 6 cycles of 1200 Hz), so its FFT
 *     main lobe is very wide - a tone 100 Hz outside the band still leaks in at a level that can beat a
 *     1500-2300 Hz scan tone;
 *   - the band lower edge is `a*1500 + b - MARGIN`. At b = -50 that is 1250 Hz, only 50 Hz from the sync,
 *     so leakage lands in-band and the estimator reports ~1330 Hz instead of ~1500. At b = +20 the edge is
 *     1320 Hz and the readings are clean.
 *
 * So the asymmetry is real but its CAUSE is symmetric code meeting an asymmetric spectrum: the band is
 * allowed to reach down towards a strong fixed tone that the scan never legitimately occupies.
 *
 * The fix has to reduce how far the lower edge may descend without clipping the legitimate dark end of the
 * scan (nominal 1500 Hz). This sweeps the lower margin on three axes at once, because the right value is
 * not obvious: contamination on impaired audio, PSNR on the truth-known control, and behaviour on the real
 * acoustic recording.
 *
 * Usage: node tests/sweep-band-margin.js
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
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const freqShift = new Function('SR',
  SRC.slice(SRC.indexOf('function hilbertFIR'), SRC.indexOf('/** Decoder lock residuals')) +
  '\nreturn freqShift;')(SR);

const MODE = Modes.get('S1');

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}
function sd(a) {
  let s = 0, s2 = 0;
  for (const v of a) { s += v; s2 += v * v; }
  const n = a.length, m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}
function flat(level) {
  const w = MODE.width, h = MODE.height;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = level; d[i + 3] = 255; }
  return { data: d, width: w, height: h };
}

/*
 * The sweep drives the REAL decoder and moves the shipped margin through the module's own setter, so the
 * numbers describe the production path. (Patching the exported `imageBandRaw` instead does nothing: the
 * pixel loop calls the closure-local function directly.)
 *
 * ASYNC SAFETY: this takes a PROMISE-returning function and awaits it BEFORE restoring the margin.
 * A synchronous `try/finally` around an `async` callback restores the margin the moment the callback
 * returns its promise - i.e. before any decode actually runs - which made an earlier version of this
 * sweep report identical numbers for every margin. That failure looked exactly like "the margin does not
 * matter", which is the most expensive kind of wrong result.
 */
const FA = Decode._internal.frequencyAxis;

async function withBandMargin(margin, fn) {
  const prev = FA.getBandMargin();
  FA.setBandMargin(margin);
  try { return await fn(); } finally { FA.setBandMargin(prev); }
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const flatImg = flat(127);
  const flatClean = Synth.synthesize(Timeline.build(flatImg, MODE), SR).samples;

  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const photo = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const photoClean = Synth.synthesize(Timeline.build(photo, MODE), SR).samples;

  const realPath = path.join(OUT, 'acoustic-real-48k-mono.wav');
  let real = null;
  if (fs.existsSync(realPath)) {
    const b = fs.readFileSync(realPath);
    real = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }

  console.log('=== 图像带下界余量扫描 ===\n');
  console.log('  余量 M 决定带下界 = a*1500 + b - M。问题在于 M 过大时下界会接近 1200 Hz 同步音。\n');
  console.log('  M(Hz) | 平坦图 Δ=−50: raw SD  灰度SD | Δ=+50: raw SD  灰度SD | 合成照片 PSNR | 真机 σ_HF  σ_flat');
  const margins = [200, 150, 120, 100, 80, 60, 40, 20, 0];
  const results = [];

  for (const M of margins) {
    // flat field, both signs
    const flatOut = await withBandMargin(M, async () => {
      const o = {};
      for (const hz of [-50, 50]) {
        const sig = freqShift(flatClean, hz);
        const audit = [];
        const r = await Decode.decode(sig, SR,
          { quality: 'standard', yieldEvery: 0, postprocess: 'off', auditPixels: audit });
        o[hz] = r.ok ? { rawSd: sd(audit.map((p) => p.raw)), lumSd: sd(audit.map((p) => p.lum)),
          lo: audit[0].bandLo, med: audit.map((p) => p.raw).sort((a, b) => a - b)[audit.length >> 1] }
          : null;
      }
      return o;
    });

    // synthetic photo: the truth-known control
    const photoRes = await withBandMargin(M, () => Decode.decode(photoClean, SR,
      { quality: 'standard', yieldEvery: 0, postprocess: 'off' }));
    const photoPsnr = photoRes.ok ? psnr(photoRes.imageData.data, photo.data) : null;

    // the real acoustic recording
    let realRes = null;
    if (real) {
      const rr = await withBandMargin(M, () => Decode.decode(real.samples, real.sampleRate,
        { quality: 'standard', yieldEvery: 0, postprocess: 'off' }));
      realRes = rr.ok ? rr.calibration.postprocess : null;
    }

    const m50 = flatOut[-50], p50 = flatOut[50];
    results.push({ margin: M, m50: m50, p50: p50, photoPsnr: photoPsnr, real: realRes });
    console.log('  ' + String(M).padStart(4) + '  |  ' +
      (m50 ? m50.rawSd.toFixed(2).padStart(7) + ' ' + m50.lumSd.toFixed(2).padStart(7) : '    --      --') +
      '  |  ' + (p50 ? p50.rawSd.toFixed(2).padStart(7) + ' ' + p50.lumSd.toFixed(2).padStart(7) : '    --      --') +
      '  |  ' + (photoPsnr == null ? '  --  ' : photoPsnr.toFixed(3).padStart(9)) + '  |  ' +
      (realRes ? realRes.sigmaHF.toFixed(2).padStart(7) + ' ' + realRes.sigmaFlat.toFixed(2).padStart(7) : '    --      --'));
  }

  /* ---- the decision ---- */
  console.log('\n  --- 判断 ---');
  console.log('  约束：合成照片 PSNR 不得低于基线 30.50（如启用后处理则看其自身门控）；');
  console.log('        真机不得变差。在此前提下取 ±50 Hz 两侧 raw SD 最接近的一组。');
  const base = results.find((r) => r.margin === 200);
  for (const r of results) {
    if (!r.m50 || !r.p50) continue;
    const sym = Math.max(r.m50.rawSd, r.p50.rawSd) / Math.min(r.m50.rawSd, r.p50.rawSd);
    const dPsnr = r.photoPsnr == null || base.photoPsnr == null ? null : r.photoPsnr - base.photoPsnr;
    console.log('    M=' + String(r.margin).padStart(3) + '  SD 比 ' + sym.toFixed(2) +
      '  （−50 ' + r.m50.rawSd.toFixed(1) + ' / +50 ' + r.p50.rawSd.toFixed(1) + '）' +
      '  PSNR 变化 ' + (dPsnr == null ? '--' : (dPsnr >= 0 ? '+' : '') + dPsnr.toFixed(3)));
  }

  fs.writeFileSync(path.join(OUT, 'band-margin-sweep.json'), JSON.stringify(results, null, 2));
  console.log('\n证据 -> tests/diag-quality/band-margin-sweep.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
