/*
 * Tuning harness for the ADAPTIVE POST-PROCESSING STAGE.
 *
 * What the data says the stage has to be:
 *   - AWGN 10 dB: a weak bilateral filter GAINS 2.58 dB (24.99 -> 27.57). Denoising helps when the
 *     decode is genuinely noise-limited.
 *   - synthetic clean: the same filter LOSES 1.35 dB and a 3x3 median loses 5.89 dB. This photograph
 *     is full of fine detail that no filter can tell from noise, so denoising must NOT run here.
 *   - phigros: sigma_flat 19.69 with a white-ish residual, and a 3x3 median visibly removes the
 *     speckle without softening the figure. Denoising should run here.
 *
 * So the two things to settle are (a) a gate that separates those cases using only the decoder's own
 * output, and (b) a filter whose cost on a CLEAN image is small enough that a gate error is survivable.
 *
 * The gate is calibrated on the flat-region residual, deliberately:
 *   sigma_flat  = residual RMS over pixels whose local gradient is in the lowest quartile
 *                 (a pixel is "flat" when its 3x3 gradient magnitude is below the image's own 25th
 *                 percentile, so "flat" is relative to the picture and not a fixed threshold)
 *   flatGain    = sigma_flat / (sigma_HF / sqrt(width)) : how far the row-mean residual sits above the
 *                 white-noise prediction. Row-coherent streaks raise this; white noise does not.
 *
 * Usage: node tests/denoise-tune.js [--quick]
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

// ---------------------------------------------------------------- measurement

/**
 * Flat-region noise measurement, plus the row-coherence gain.
 *
 * A pixel is defined as FLAT when its 3x3 gradient magnitude is below the picture's own 25th
 * percentile. That makes "flat" relative to the image instead of a fixed threshold, which matters
 * because the two images being compared have very different detail levels.
 */
function flatNoise(img, pct) {
  const w = img.width, h = img.height, d = img.data;
  const lum = new Float64Array(w * h);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    lum[k] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const grad = new Float64Array(w * h);
  const res = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
      const gx = lum[y * w + xp] - lum[y * w + xm];
      const gy = lum[yp * w + x] - lum[ym * w + x];
      grad[y * w + x] = Math.sqrt(gx * gx + gy * gy);
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        s += lum[yy * w + xx]; n++;
      }
      res[y * w + x] = lum[y * w + x] - s / n;
    }
  }
  // percentile of the gradient, computed by sorting a subsample (256x256 is small but this is called
  // many times per variant)
  const gs = Array.prototype.slice.call(grad).sort((a, b) => a - b);
  const q = gs[Math.min(gs.length - 1, Math.floor((pct == null ? 0.25 : pct) * gs.length))];
  let sum = 0, n2 = 0;
  for (let i = 0; i < grad.length; i++) {
    if (grad[i] <= q) { sum += res[i] * res[i]; n2++; }
  }
  const sigmaHF = (() => {
    let m = 0;
    for (let i = 0; i < res.length; i++) m += res[i];
    m /= res.length;
    let v = 0;
    for (let i = 0; i < res.length; i++) v += (res[i] - m) * (res[i] - m);
    return Math.sqrt(v / res.length);
  })();
  const sdRow = (() => {
    const rm = [];
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) s += res[y * w + x];
      rm.push(s / w);
    }
    const m = rm.reduce((s, t) => s + t, 0) / h;
    return Math.sqrt(rm.reduce((s, t) => s + (t - m) * (t - m), 0) / h);
  })();
  const sdGR = (() => {
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const t = d[i + 1] - d[i]; s += t; s2 += t * t; n++; }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
  })();
  return {
    sigmaFlat: Math.sqrt(sum / Math.max(n2, 1)), flatCount: n2, flatFrac: n2 / grad.length,
    sigmaHF: sigmaHF, rowGain: sdRow / (sigmaHF / Math.sqrt(w)), sdGR: sdGR
  };
}

// ---------------------------------------------------------------- filters

/**
 * Selective edge-preserving denoiser.
 *
 * For each pixel and channel, a 3x3 median is formed and applied ONLY when both
 *   |pixel - median| > tDiff   (the pixel is an outlier against its own neighbourhood), and
 *   local gradient <= tGrad     (that neighbourhood is flat, so the median is a noise estimate rather
 *                               than a mix of two sides of an edge),
 * which is what keeps edges and fine detail intact instead of smearing them.
 *
 * `tDiff` is the noise-driven knob: the caller passes a multiple of the measured sigma, so the filter
 * adapts to the image's own noise level instead of a hard-coded constant.
 */
function selectiveMedian(img, tDiff, tGrad) {
  const w = img.width, h = img.height, src = img.data;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  const lum = new Float64Array(w * h);
  for (let i = 0, k = 0; i < src.length; i += 4, k++) {
    lum[k] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  }
  const grad = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
      const gx = lum[y * w + xp] - lum[y * w + xm];
      const gy = lum[yp * w + x] - lum[ym * w + x];
      grad[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  const win = new Float64Array(9);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gi = y * w + x;
        if (grad[gi] > tGrad) continue;
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
        const i = gi * 4 + c;
        if (Math.abs(src[i] - med) > tDiff) out[i] = med;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Selective bilateral: same two conditions, but a 5x5 Gaussian-weighted mean instead of a median.
 * Compared because the two fail differently - the median preserves edges but can flatten single-pixel
 * texture, the bilateral keeps gradients but leaks across nearby edges.
 */
function selectiveBilateral(img, tGrad, sigmaR) {
  const w = img.width, h = img.height, src = img.data;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  const R = 2;
  const sp = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    sp.push(Math.exp(-(dx * dx + dy * dy) / (2 * 1.5 * 1.5)));
  }
  const ri = 1 / (2 * sigmaR * sigmaR);
  const lum = new Float64Array(w * h);
  for (let i = 0, k = 0; i < src.length; i += 4, k++) {
    lum[k] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
      const gx = lum[y * w + xp] - lum[y * w + xm];
      const gy = lum[yp * w + x] - lum[ym * w + x];
      if (Math.sqrt(gx * gx + gy * gy) > tGrad) continue;
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
            const wt = sp[si] * Math.exp(-dv * dv * ri);
            acc += wt * v; wsum += wt;
          }
        }
        if (wsum > 0) out[i0 + c] = Math.round(acc / wsum);
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Unconditional 3x3 median, kept as the reference for "what a blunt filter costs". */
function median3(img) {
  const w = img.width, h = img.height, src = img.data;
  const out = new Uint8ClampedArray(src.length);
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
        out[(y * w + x) * 4 + c] = sub[n >> 1];
      }
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------- cases

async function buildCases() {
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const src = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(src, Modes.get('S1')), SR).samples;
  const cases = [{ label: '合成 S1 clean（基线 30.50）', sig: clean, truth: src, gate: false }];
  for (const snr of QUICK ? [20, 10] : [30, 20, 15, 10, 6]) {
    cases.push({ label: '合成 S1 AWGN ' + snr + ' dB', sig: Channel.Channel.awgn(clean, snr, 12345),
      truth: src, gate: snr <= 15 });
  }
  const pa = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  if (fs.existsSync(pa)) {
    const buf = fs.readFileSync(pa);
    const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    cases.push({ label: 'phigros 真实录音（应启用）', sig: info.samples, truth: null, gate: true });
  }
  return cases;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cases = await buildCases();
  console.log('=== 自适应后处理：门控与滤波器的联合标定 ===\n');

  const decoded = [];
  for (const c of cases) {
    const r = await Decode.decode(c.sig, SR, { quality: 'standard', yieldEvery: 0 });
    if (!r.ok) { console.log(c.label + ': 解码失败'); continue; }
    const f = flatNoise(r.imageData);
    decoded.push(Object.assign({}, c, { img: r.imageData, stats: f,
      basePsnr: c.truth ? psnr(r.imageData.data, c.truth.data) : null }));
    console.log('  ' + c.label.padEnd(30) + ' σ_flat ' + f.sigmaFlat.toFixed(2).padStart(7) +
      ' · σ_HF ' + f.sigmaHF.toFixed(2).padStart(7) + ' · 行增益 ' + f.rowGain.toFixed(2).padStart(6) +
      ' · 平坦占比 ' + (100 * f.flatFrac).toFixed(0).padStart(3) + '%' +
      (c.truth ? ' · PSNR ' + psnr(r.imageData.data, c.truth.data).toFixed(2) : ''));
  }

  /* ---------------- gate calibration ---------------- */
  console.log('\n--- 门控标定：只用干净解码与真实录音，不看退化档 ---');
  const cleanStat = decoded.find((d) => d.truth && d.label.indexOf('clean') >= 0);
  const realStat = decoded.find((d) => !d.truth);
  if (cleanStat && realStat) {
    const lo = cleanStat.stats.sigmaFlat, hi = realStat.stats.sigmaFlat;
    const thr = Math.sqrt(lo * hi);   // geometric mean: the natural separator between two levels
    console.log('  干净合成 σ_flat = ' + lo.toFixed(2) + ' · phigros σ_flat = ' + hi.toFixed(2) +
      ' → 几何中值门限 ' + thr.toFixed(2) + ' (x' + (thr / lo).toFixed(2) + ' 干净 / x' +
      (hi / thr).toFixed(2) + ' phigros)');
    // how much margin, in the units that matter: how many dB the filter costs if the gate is WRONG
    const b = selectiveBilateral(cleanStat.img, thr * 0.5, 24);
    console.log('  门控误判的代价（在干净合成上强行滤波，双边）: PSNR ' +
      cleanStat.basePsnr.toFixed(2) + ' → ' + psnr(b.data, cleanStat.truth.data).toFixed(2));
    const m = selectiveMedian(cleanStat.img, 1.2 * thr, thr * 0.5);
    console.log('  门控误判的代价（在干净合成上强行滤波，选择性中值）: PSNR ' +
      cleanStat.basePsnr.toFixed(2) + ' → ' + psnr(m.data, cleanStat.truth.data).toFixed(2));
  }

  /* ---------------- filter comparison ---------------- */
  const filters = [
    { label: '无条件中值3x3', fn: (x) => median3(x), needsSigma: false },
    { label: '选择中值 1.0σ', fn: (x, s) => selectiveMedian(x, 1.0 * s, 0.5 * s), needsSigma: true },
    { label: '选择中值 1.5σ', fn: (x, s) => selectiveMedian(x, 1.5 * s, 0.5 * s), needsSigma: true },
    { label: '选择中值 2.0σ', fn: (x, s) => selectiveMedian(x, 2.0 * s, 0.5 * s), needsSigma: true },
    { label: '选择双边 σR=1.0σ', fn: (x, s) => selectiveBilateral(x, 0.5 * s, 1.0 * s), needsSigma: true },
    { label: '选择双边 σR=1.5σ', fn: (x, s) => selectiveBilateral(x, 0.5 * s, 1.5 * s), needsSigma: true },
    { label: '选择双边 σR=2.0σ', fn: (x, s) => selectiveBilateral(x, 0.5 * s, 2.0 * s), needsSigma: true }
  ];

  console.log('\n--- 滤波器对比（σ 由各图自身门控测得；PSNR 只在有真值的用例上给出）---');
  const table = [];
  for (const f of filters) {
    console.log('\n  ' + f.label);
    const row = { filter: f.label, cells: [] };
    for (const d of decoded) {
      const s = d.stats.sigmaFlat;
      const out = f.needsSigma ? f.fn(d.img, s) : f.fn(d.img);
      const nf = flatNoise(out);
      const p = d.truth ? psnr(out.data, d.truth.data) : null;
      row.cells.push({ label: d.label, sigmaFlat: nf.sigmaFlat, sdGR: nf.sdGR, psnr: p,
        dPsnr: p == null ? null : p - d.basePsnr });
      console.log('    ' + d.label.padEnd(30) + ' σ_flat ' + s.toFixed(2).padStart(6) + ' → ' +
        nf.sigmaFlat.toFixed(2).padStart(6) + '  色度σ ' + d.stats.sdGR.toFixed(1).padStart(5) + ' → ' +
        nf.sdGR.toFixed(1).padStart(5) +
        (p == null ? '' : '  PSNR ' + p.toFixed(2).padStart(6) +
          ' (' + (p - d.basePsnr >= 0 ? '+' : '') + (p - d.basePsnr).toFixed(2) + ')'));
    }
    table.push(row);
  }

  /* ---------------- the shipped configuration, evaluated as it would actually run ---------------- */
  console.log('\n--- 按实际启用规则评估（仅当门控通过时滤波）---');
  const GATE = cleanStat && realStat ? Math.sqrt(cleanStat.stats.sigmaFlat * realStat.stats.sigmaFlat) : 12;
  const gated = [];
  for (const d of decoded) {
    const s = d.stats.sigmaFlat;
    const active = s > GATE;
    const out = active ? selectiveBilateral(d.img, 0.5 * s, 1.5 * s) : d.img;
    const nf = flatNoise(out);
    const p = d.truth ? psnr(out.data, d.truth.data) : null;
    gated.push({ label: d.label, active: active, sigmaFlat: s, out: nf.sigmaFlat, sdGR: nf.sdGR,
      psnr: p, basePsnr: d.basePsnr });
    console.log('  ' + d.label.padEnd(30) + (active ? ' 启用' : ' 旁路') +
      '  σ_flat ' + s.toFixed(2).padStart(6) + ' → ' + nf.sigmaFlat.toFixed(2).padStart(6) +
      '  色度σ ' + d.stats.sdGR.toFixed(1).padStart(5) + ' → ' + nf.sdGR.toFixed(1).padStart(5) +
      (p == null ? '  （无真值）' : '  PSNR ' + p.toFixed(2) + ' (' +
        (p - d.basePsnr >= 0 ? '+' : '') + (p - d.basePsnr).toFixed(2) + ')'));
    if (d.label.startsWith('phigros')) {
      fs.writeFileSync(path.join(OUT, 'phigros-denoised.png'),
        PNG.sync.write({ width: out.width, height: out.height, data: Buffer.from(out.data.buffer.slice(0)) }));
    }
  }

  fs.writeFileSync(path.join(OUT, 'denoise-tune.json'),
    JSON.stringify({ gate: GATE, decoded: decoded.map((d) => ({ label: d.label, stats: d.stats,
      basePsnr: d.basePsnr })), table, gated }, null, 2));
  console.log('\n证据 -> tests/diag-quality/denoise-tune.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
