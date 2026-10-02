/*
 * Classic (non-deep-learning) post-processing for decoded SSTV images.
 *
 * Direction matters here. SSTV degradation is not isotropic gaussian noise:
 *   - impulse noise from static arrives along the SCAN LINE, so a horizontal median is the
 *     matched filter;
 *   - a dropped or faded line appears as a vertical streak, so a vertical median is the
 *     matched filter;
 *   - broadband noise is isotropic and is what the bilateral filter is for.
 *
 * Every filter makes the image worse when the image was already clean, so the module also
 * exposes `suggest()`: the UI should OFFER filtering based on measured no-reference
 * statistics, not apply it unconditionally. `scripts/eval-postprocess.js` measures both the
 * gain on noisy input and the loss on clean input.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImagePostprocess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function grayPlane(imageData) {
    var n = imageData.width * imageData.height, g = new Float32Array(n), d = imageData.data;
    for (var i = 0; i < n; i++) {
      var o = i << 2;
      g[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    }
    return { g: g, w: imageData.width, h: imageData.height };
  }
  function planeToImageData(p) {
    var n = p.w * p.h, out = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) {
      var v = p.g[i] < 0 ? 0 : (p.g[i] > 255 ? 255 : p.g[i]);
      var o = i << 2;
      out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
    }
    return { data: out, width: p.w, height: p.h };
  }
  function rgbaFilter(imageData, fn) {
    // filter the green channel (the SSTV luminance-ish channel) and keep the colour ratio
    var p = grayPlane(imageData);
    var q = fn(p);
    var out = new Uint8ClampedArray(imageData.data.length);
    for (var i = 0; i < p.w * p.h; i++) {
      var o = i << 2;
      var delta = q.g[i] - p.g[i];
      out[o] = Math.max(0, Math.min(255, imageData.data[o] + delta));
      out[o + 1] = Math.max(0, Math.min(255, imageData.data[o + 1] + delta));
      out[o + 2] = Math.max(0, Math.min(255, imageData.data[o + 2] + delta));
      out[o + 3] = 255;
    }
    return { data: out, width: p.w, height: p.h };
  }

  function median1D(src, w, h, len, horizontal) {
    const out = new Float32Array(w * h);
    const half = (len - 1) >> 1;
    const buf = new Float32Array(len);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let k = 0;
        for (let t = -half; t <= half; t++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + t)) : x;
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + t));
          buf[k++] = src[yy * w + xx];
        }
        // insertion sort, len is small
        for (let i = 1; i < len; i++) {
          const v = buf[i];
          let j = i - 1;
          while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
          buf[j + 1] = v;
        }
        out[y * w + x] = buf[half];
      }
    }
    return out;
  }
  /** Horizontal median - matched to impulse noise arriving along the scan line. */
  function medianHorizontal(p, len) {
    return { g: median1D(p.g, p.w, p.h, len || 3, true), w: p.w, h: p.h };
  }
  /** Vertical median - matched to dropped/faded lines (streaks). */
  function medianVertical(p, len) {
    return { g: median1D(p.g, p.w, p.h, len || 3, false), w: p.w, h: p.h };
  }
  /** 3x3 median: the usual first-aid filter, strongest detail loss. */
  function median3x3(p) {
    const h1 = median1D(p.g, p.w, p.h, 3, true);
    return { g: median1D(h1, p.w, p.h, 3, false), w: p.w, h: p.h };
  }

  /**
   * Bilateral filter: gaussian in space times gaussian in intensity, so edges survive.
   * @param sigmaS spatial sigma (pixels)
   * @param sigmaR intensity sigma (grey levels)
   */
  function bilateral(p, sigmaS, sigmaR) {
    const { g, w, h } = p;
    const rad = Math.max(1, Math.ceil(sigmaS * 1.5));
    const spatial = new Float32Array(2 * rad + 1);
    for (let i = -rad; i <= rad; i++) spatial[i + rad] = Math.exp(-(i * i) / (2 * sigmaS * sigmaS));
    const out = new Float32Array(w * h);
    const inv2r2 = 1 / (2 * sigmaR * sigmaR);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = g[y * w + x];
        let acc = 0, wsum = 0;
        for (let dy = -rad; dy <= rad; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const wy = spatial[dy + rad];
          for (let dx = -rad; dx <= rad; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const v = g[yy * w + xx];
            const d = v - c;
            const wt = wy * spatial[dx + rad] * Math.exp(-d * d * inv2r2);
            acc += v * wt; wsum += wt;
          }
        }
        out[y * w + x] = wsum > 0 ? acc / wsum : c;
      }
    }
    return { g: out, w: w, h: h };
  }

  function upscaleNearest(imageData, factor) {
    const f = Math.max(1, Math.round(factor));
    const w = imageData.width * f, h = imageData.height * f;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = (((y / f) | 0) * imageData.width + ((x / f) | 0)) << 2;
        const o = (y * w + x) << 2;
        out[o] = imageData.data[s]; out[o + 1] = imageData.data[s + 1];
        out[o + 2] = imageData.data[s + 2]; out[o + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }
  function upscaleBilinear(imageData, factor) {
    const f = Math.max(1, Math.round(factor));
    const sw = imageData.width, sh = imageData.height;
    const w = sw * f, h = sh * f;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1, (y + 0.5) / f - 0.5);
      const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1, (x + 0.5) / f - 0.5);
        const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
        const o = (y * w + x) << 2;
        for (let c = 0; c < 3; c++) {
          const a = imageData.data[(y0 * sw + x0) * 4 + c], b = imageData.data[(y0 * sw + x1) * 4 + c];
          const cc = imageData.data[(y1 * sw + x0) * 4 + c], d = imageData.data[(y1 * sw + x1) * 4 + c];
          const top = a + (b - a) * wx, bot = cc + (d - cc) * wx;
          out[o + c] = top + (bot - top) * wy;
        }
        out[o + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }

  /** No-reference statistics used to decide whether filtering is warranted. */
  function stats(imageData) {
    const p = grayPlane(imageData);
    let acc = 0, n = 0;
    for (let y = 1; y < p.h - 1; y++) {
      for (let x = 1; x < p.w - 1; x++) {
        const i = y * p.w + x;
        const mean = (p.g[i - 1] + p.g[i + 1] + p.g[i - p.w] + p.g[i + p.w]) / 4;
        const r = p.g[i] - mean;
        acc += r * r; n++;
      }
    }
    const sigmaHF = Math.sqrt(acc / n / 1.25);
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x + 1 < p.w; x++) {
        const a = p.g[y * p.w + x], b = p.g[y * p.w + x + 1];
        sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b; m++;
      }
    }
    const cov = sxy / m - (sx / m) * (sy / m);
    const sd = Math.sqrt((sxx / m - (sx / m) ** 2) * (syy / m - (sy / m) ** 2));
    return { sigmaHF: sigmaHF, lag1: sd ? cov / sd : 0 };
  }

  /**
   * Should the user be offered filtering?
   *
   * Thresholds come from the phase-6 measurements: the clean real recording sits at
   * sigmaHF ~ 10.9 and a decode that is still usable sits below ~25. Above that the
   * measured PSNR has already fallen below ~18 dB and filtering starts to win.
   */
  function suggest(st) {
    if (st.sigmaHF < 13) return { filter: false, reason: '图像已足够干净（σ_HF ' + st.sigmaHF.toFixed(1) + ' < 13），滤波只会让细节变糊' };
    if (st.sigmaHF < 25) return { filter: 'horizontal-median', reason: '轻度噪声（σ_HF ' + st.sigmaHF.toFixed(1) + '），建议水平中值 3 去脉冲' };
    return { filter: 'median+bilateral', reason: '噪声较大（σ_HF ' + st.sigmaHF.toFixed(1) + '），建议水平中值 3 + 双边滤波' };
  }

  return {
    VERSION: 1,
    grayPlane: grayPlane, planeToImageData: planeToImageData, rgbaFilter: rgbaFilter,
    medianHorizontal: medianHorizontal, medianVertical: medianVertical, median3x3: median3x3,
    bilateral: bilateral, upscaleNearest: upscaleNearest, upscaleBilinear: upscaleBilinear,
    stats: stats, suggest: suggest,
    apply: function (imageData, name, opts) {
      opts = opts || {};
      switch (name) {
        case 'medianH3': return rgbaFilter(imageData, function (p) { return medianHorizontal(p, 3); });
        case 'medianH5': return rgbaFilter(imageData, function (p) { return medianHorizontal(p, 5); });
        case 'medianV3': return rgbaFilter(imageData, function (p) { return medianVertical(p, 3); });
        case 'median3x3': return rgbaFilter(imageData, function (p) { return median3x3(p); });
        case 'bilateral': return rgbaFilter(imageData, function (p) { return bilateral(p, opts.sigmaS || 1.2, opts.sigmaR || 24); });
        case 'medianH3+bilateral':
          return rgbaFilter(imageData, function (p) {
            return bilateral(medianHorizontal(p, 3), opts.sigmaS || 1.2, opts.sigmaR || 24);
          });
        default: throw new Error('unknown post-processing filter ' + name);
      }
    }
  };
});
