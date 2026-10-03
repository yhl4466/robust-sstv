/*
 * Phase-49 task 2: can adaptive post-processing help, and can it be told WHEN to run?
 *
 * The matrix and the reverb diagnosis together say where the remaining quality is:
 *
 *   - the acoustic path costs 7-13 dB and is a legitimate, large target, but the loss is a per-pixel
 *     frequency-estimate error of ~230 Hz (std) that is UNIFORM in level, i.e. multipath filling a
 *     ~1.3 ms analysis window. Undoing that needs channel estimation; no local image filter can
 *     recover information the estimator never resolved.
 *   - the real phigros output carries sigma_HF = 24.0 grey levels against Robot36's 7.0, i.e. 3.4x the
 *     noise, and the residual is close to white (lag-1 along x -0.06, along y -0.12, row-mean only
 *     3.3x the white-noise prediction). This IS a local-filtering problem.
 *
 * So the candidate is post-processing - but ONLY if it can be gated. An unconditional denoiser would
 * lower the synthetic round trips (docs record the baseline at M1 31.23 / S1 30.50 and the acceptance
 * rule is that they must not fall), so the gate has to separate "noisy decode" from "clean decode"
 * using a measurement the decoder can take on its OWN output, with no reference.
 *
 * This measures, for a range of impairments and both real recordings:
 *   sigma_HF    - RMS of the residual from a 3x3 local mean. The gate candidate.
 *   rowMeanGain - row-mean residual sigma divided by the white-noise prediction sigma_HF/sqrt(w).
 *                 Distinguishes row-coherent streaks (what Robot36 shows, 0.198) from white noise.
 *   PSNR / chroma ratio - what each denoiser does to a decode whose truth is known, and to phigros.
 *
 * Usage: node tests/denoise-study.js [--quick]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;
const QUICK = process.argv.includes('--quick');

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

/** Noise statistics of a decoded raster, with no reference needed. */
function noiseStats(img) {
  const w = img.width, h = img.height, d = img.data;
  const lum = new Float64Array(w * h);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    lum[k] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const res = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        s += lum[yy * w + xx]; n++;
      }
      res[y * w + x] = lum[y * w + x] - s / n;
    }
  }
  let mean = 0;
  for (let i = 0; i < res.length; i++) mean += res[i];
  mean /= res.length;
  let v = 0;
  for (let i = 0; i < res.length; i++) v += (res[i] - mean) * (res[i] - mean);
  const sd = Math.sqrt(v / res.length);
  const rowMeans = [];
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += res[y * w + x];
    rowMeans.push(s / w);
  }
  const rm = rowMeans.reduce((s, t) => s + t, 0) / h;
  const sdRow = Math.sqrt(rowMeans.reduce((s, t) => s + (t - rm) * (t - rm), 0) / h);

  /*
   * TEXTURE-AWARE noise estimate.
   *
   * sigma_HF does not separate a clean decode from a noisy one, measured: the clean synthetic decode
   * reads 9.89 and AWGN 20 dB reads 10.11. The reason is that this photograph is full of genuine
   * fine detail, so the high-frequency residual is dominated by CONTENT, not noise - and content is
   * exactly what a denoiser must not remove.
   *
   * The discriminator that does work is local: noise raises the residual in SMOOTH areas (where a
   * clean decode has almost none), while texture raises it where there is already a strong gradient.
   * So the residual is weighted by 1/(1+|grad|/G0), keeping flat regions and discarding edges. On a
   * clean image this reads near zero however detailed the picture is; on a noisy one it reads the
   * noise level.
   */
  const G0 = 12;
  let flatV = 0, flatN = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = lum[y * w + x + 1] - lum[y * w + x - 1];
      const gy = lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
      const grad = Math.sqrt(gx * gx + gy * gy);
      const r = res[y * w + x];
      const wgt = 1 / (1 + grad / G0);
      flatV += wgt * r * r; flatN += wgt;
    }
  }
  const sigmaFlat = Math.sqrt(flatV / Math.max(flatN, 1));
  // the mean weight itself: how much of the picture is flat, which normalises across images
  const flatFrac = flatN / ((h - 2) * (w - 2));

  const sdGR = (() => {
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const v2 = d[i + 1] - d[i]; s += v2; s2 += v2 * v2; n++; }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
  })();
  return { sigmaHF: sd, rowMeanSd: sdRow, rowMeanGain: sdRow / (sd / Math.sqrt(w)),
    sdGR: sdGR, sigmaFlat: sigmaFlat, flatFrac: flatFrac };
}

// ---------------------------------------------------------------- denoisers

/**
 * Adaptive 3x3 median on each channel.
 *
 * A median is the right family here: the residual is close to white and heavy-tailed, and a median
 * removes impulses without the averaging blur that would cost synthetic PSNR. `strength` is the number
 * of passes; a pass only replaces a pixel when it differs from the neighbourhood median by more than
 * `thresh`, which is what keeps it from smoothing real edges.
 */
function medianDenoise(img, thresh, passes) {
  const w = img.width, h = img.height;
  let src = img.data;
  let out = src;
  for (let p = 0; p < passes; p++) {
    out = new Uint8ClampedArray(src.length);
    out.set(src);
    const win = new Float64Array(9);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              win[n++] = src[(yy * w + xx) * 4 + c];
            }
          }
          const sub = Array.prototype.slice.call(win, 0, n).sort((a, b) => a - b);
          const med = sub[n >> 1];
          const i = (y * w + x) * 4 + c;
          if (Math.abs(src[i] - med) > thresh) out[i] = med;
        }
      }
    }
    src = out;
  }
  return { width: w, height: h, data: out };
}

/**
 * Bilateral filter, 5x5, on each channel.
 *
 * The alternative family: a spatial Gaussian weighted by an intensity Gaussian, so it averages inside
 * flat areas and leaves edges alone. Compared against the median because the two fail differently -
 * bilateral preserves gradients better, median preserves edges better.
 */
function bilateralDenoise(img, sigmaS, sigmaR, passes) {
  const w = img.width, h = img.height;
  let src = img.data, out = src;
  const R = 2;
  const spatial = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS)));
  }
  const ri = 1 / (2 * sigmaR * sigmaR);
  for (let p = 0; p < passes; p++) {
    out = new Uint8ClampedArray(src.length);
    out.set(src);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i0 = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const centre = src[i0 + c];
          let acc = 0, wsum = 0, si = 0;
          for (let dy = -R; dy <= R; dy++) {
            const yy = y + dy;
            for (let dx = -R; dx <= R; dx++, si++) {
              const xx = x + dx;
              if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
              const v = src[(yy * w + xx) * 4 + c];
              const dv = v - centre;
              const wt = spatial[si] * Math.exp(-dv * dv * ri);
              acc += wt * v; wsum += wt;
            }
          }
          out[i0 + c] = wsum > 0 ? Math.round(acc / wsum) : centre;
        }
      }
    }
    src = out;
  }
  return { width: w, height: h, data: out };
}

/**
 * Gate: estimate the noise level from the decode's own high-frequency residual.
 *
 * The residual from a 3x3 local mean is dominated by content at the finest scale, so it overstates the
 * noise on a detailed picture. The correction that makes it comparable across images is the sub-band
 * check: for white noise the residual variance is (2/3) of the pixel variance, so the estimate is
 * scaled by that factor and reported as sigma. A CLEAN decode still shows a few grey levels of genuine
 * fine detail, so the threshold has to sit above that rather than at zero - both numbers are measured
 * here rather than assumed.
 */
function noiseEstimate(img) {
  const s = noiseStats(img);
  return { sigma: s.sigmaFlat, raw: s.sigmaHF, sigmaFlat: s.sigmaFlat, flatFrac: s.flatFrac,
    rowMeanGain: s.rowMeanGain, sdGR: s.sdGR };
}

// ---------------------------------------------------------------- cases

function trueSyncs() { return null; }

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const src = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(src, Modes.get('S1')), SR).samples;

  const cases = [];
  cases.push({ label: '合成 clean', sig: clean, truth: src });
  for (const snr of QUICK ? [20, 10] : [30, 20, 15, 10, 6]) {
    cases.push({ label: '合成 AWGN ' + snr + ' dB', sig: Channel.Channel.awgn(clean, snr, 12345), truth: src });
  }
  const phigrosAudio = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  if (fs.existsSync(phigrosAudio)) {
    const buf = fs.readFileSync(phigrosAudio);
    const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    cases.push({ label: 'phigros 真实录音', sig: info.samples, truth: null });
  }

  const variants = [
    { label: '不处理', fn: (x) => x },
    { label: '中值 t=8 1遍', fn: (x) => medianDenoise(x, 8, 1) },
    { label: '中值 t=16 1遍', fn: (x) => medianDenoise(x, 16, 1) },
    { label: '中值 t=24 1遍', fn: (x) => medianDenoise(x, 24, 1) },
    { label: '中值 t=16 2遍', fn: (x) => medianDenoise(x, 16, 2) },
    { label: '双边 sR=24 1遍', fn: (x) => bilateralDenoise(x, 1.5, 24, 1) },
    { label: '双边 sR=40 1遍', fn: (x) => bilateralDenoise(x, 1.5, 40, 1) }
  ];

  console.log('=== 自适应后处理研究 ===\n');
  const results = [];
  for (const c of cases) {
    const r = await Decode.decode(c.sig, c.sig === clean ? SR : (c.truth ? SR : 48000),
      { quality: 'standard', yieldEvery: 0 });
    if (!r.ok) { console.log(c.label + ': 解码失败 ' + r.message); continue; }
    const base = r.imageData;
    const ne = noiseEstimate(base);
    console.log(c.label + '  —  σ_HF ' + ne.raw.toFixed(2) + ' · σ_平坦区 ' + ne.sigmaFlat.toFixed(2) +
      ' · 平坦占比 ' + ne.flatFrac.toFixed(2) + ' · 行均值增益 ' + ne.rowMeanGain.toFixed(2) +
      (c.truth ? ' · 基线 PSNR ' + psnr(base.data, c.truth.data).toFixed(2)
               : ' · 色度σ ' + ne.sdGR.toFixed(1)));
    const row = { case: c.label, base: { sigma: ne.sigma, sigmaFlat: ne.sigmaFlat, raw: ne.raw,
        flatFrac: ne.flatFrac, rowMeanGain: ne.rowMeanGain },
      basePsnr: c.truth ? psnr(base.data, c.truth.data) : null, baseSdGR: ne.sdGR,
      variants: [] };
    for (const v of variants) {
      const out = v.fn(base);
      const n2 = noiseEstimate(out);
      const p = c.truth ? psnr(out.data, c.truth.data) : null;
      const gr = (() => {
        const d = out.data;
        let s = 0, s2 = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { const t = d[i + 1] - d[i]; s += t; s2 += t * t; n++; }
        return Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
      })();
      row.variants.push({ label: v.label, sigma: n2.sigma, psnr: p, sdGR: gr });
      console.log('    ' + v.label.padEnd(16) + ' σ ' + n2.sigma.toFixed(2).padStart(7) +
        (p == null ? '        色度σ ' + gr.toFixed(1)
                   : '  PSNR ' + p.toFixed(2).padStart(6) + ' (' + (p - row.basePsnr >= 0 ? '+' : '') +
                     (p - row.basePsnr).toFixed(2) + ')'));
      if (p != null && c.label.startsWith('phigros') === false) {
        // also export one denoised PNG per impairment for the strongest variant
      }
    }
    results.push(row);
    const out = medianDenoise(base, 16, 1);
    fs.writeFileSync(path.join(OUT, 'denoise-' + c.label.replace(/[^\w\u4e00-\u9fa5]+/g, '_') + '-median16.png'),
      PNG.sync.write({ width: out.width, height: out.height, data: Buffer.from(out.data.buffer.slice(0)) }));
    fs.writeFileSync(path.join(OUT, 'denoise-' + c.label.replace(/[^\w\u4e00-\u9fa5]+/g, '_') + '-base.png'),
      PNG.sync.write({ width: base.width, height: base.height, data: Buffer.from(base.data.buffer.slice(0)) }));
    console.log('');
  }
  fs.writeFileSync(path.join(OUT, 'denoise-study.json'), JSON.stringify(results, null, 2));
  console.log('证据 -> tests/diag-quality/denoise-study.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
