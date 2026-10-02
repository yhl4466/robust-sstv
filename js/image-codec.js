/*
 * Secret-image codec + image frame format (phase 5).
 *
 * WHY NOT JPEG, in one line: the smallest JPEG the browser can produce is 757 bytes for a
 * 1x1 pixel image (measured, scripts/measure-secret-matrix.js), and the budget is 200 bytes
 * of image data. Even a hand-stripped baseline JPEG needs ~170 B of fixed header. JPEG is
 * therefore unusable here, and the format id is kept only so the numbering is documented.
 *
 * WHY NOT PNG either: canvas.toDataURL('image/png') exports RGBA, so a 256x205 grayscale
 * image becomes 66 KB. Only 4x3 and smaller fit. A hand-written 8-bit grayscale PNG would
 * be ~4x smaller, but it still cannot compete with a purpose-built format at this scale.
 *
 * WHAT IS USED: QIMG - a fixed-length quantized grayscale raster.
 *   - size is known BEFORE encoding: ceil(w*h*bpp/8) bytes, so "does it fit" is decidable
 *     without compressing and hoping
 *   - no entropy coding, so there is no size surprise and no decoder state
 *   - pure integer arithmetic, therefore byte-identical in Node and in the browser
 *   - optional 4x4 ordered dithering to trade tonal banding for apparent grey levels
 *
 * Frame layout (15-byte header, then image data), total <= the payload capacity:
 *   0-1    magic 0x49 0x53 ("IS")
 *   2      version = 1
 *   3      format: 0 = QIMG gray, 1 = PNG gray (reserved), 2 = JPEG gray (measured unusable)
 *   4-5    W uint16 BE
 *   6-7    H uint16 BE
 *   8      quality: QIMG -> (bpp << 4) | flags ; PNG/JPEG -> round(q*100)
 *   9-10   dataLength uint16 BE
 *   11-14  CRC32 over bytes [0..10]
 *   15..   image data
 *
 * Note on the header CRC: it covers bytes 0..10, exactly as specified. It does NOT cover
 * dataLength-implied payload... it does cover dataLength itself (offset 9-10) but not the
 * image data. Integrity of the image data is guaranteed by the GENERIC payload frame's
 * CRC32, which covers the whole image frame. So "byte-exact recovery" is decided there.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImageCodec = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var MAGIC0 = 0x49, MAGIC1 = 0x53;      // "IS"
  var HEADER_BYTES = 15;
  var FORMAT_QIMG = 0, FORMAT_PNG = 1, FORMAT_JPEG = 2;
  var FLAG_DITHER = 1, FLAG_AUTOSCALED = 2;

  // ------------------------------------------------------------------ crc32
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, start, end) {
    var c = 0xFFFFFFFF;
    for (var i = start || 0; i < (end == null ? bytes.length : end); i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ------------------------------------------------------------------ colour / geometry
  /** RGBA raster -> single-channel grey plane (0..255). */
  function toGray(imageData) {
    var d = imageData.data, n = imageData.width * imageData.height;
    var g = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var o = i << 2;
      g[i] = (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2] + 0.5) | 0;
    }
    return { data: g, width: imageData.width, height: imageData.height };
  }
  /** Bilinear resize of a grey plane. */
  function resizeGray(src, nw, nh) {
    var sw = src.width, sh = src.height, sd = src.data;
    var out = new Uint8Array(nw * nh);
    if (nw === sw && nh === sh) { out.set(sd); return { data: out, width: nw, height: nh }; }
    for (var y = 0; y < nh; y++) {
      var fy = nh > 1 ? (y * (sh - 1)) / (nh - 1) : 0;
      var y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
      for (var x = 0; x < nw; x++) {
        var fx = nw > 1 ? (x * (sw - 1)) / (nw - 1) : 0;
        var x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
        var a = sd[y0 * sw + x0], b = sd[y0 * sw + x1], c = sd[y1 * sw + x0], e = sd[y1 * sw + x1];
        var top = a + (b - a) * wx, bot = c + (e - c) * wx;
        out[y * nw + x] = (top + (bot - top) * wy + 0.5) | 0;
      }
    }
    return { data: out, width: nw, height: nh };
  }
  /** Fit into a longest-side box, preserving aspect, with a minimum short side. */
  function fitSize(sw, sh, longest, minSide) {
    var s = longest / Math.max(sw, sh);
    var w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    if (Math.min(w, h) < minSide) return null;
    return { w: w, h: h };
  }

  // ------------------------------------------------------------------ quantization
  // 4x4 Bayer matrix, normalised to [-0.5, +0.5) - the classic ordered-dither threshold
  var BAYER4 = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5
  ].map(function (v) { return (v + 0.5) / 16 - 0.5; });

  /**
   * Quantize to 2^bpp levels, optionally with ordered dithering.
   *
   * Dithering matters here because bpp can be as low as 1: without it, a 2-level image is
   * a hard threshold and all mid-tones collapse to black. With it, the *average* over a
   * small neighbourhood approximates the original tone, which is the whole point at this
   * resolution.
   */
  function quantize(gray, bpp, dither) {
    var levels = (1 << bpp) - 1;
    var src = gray.data, out = new Uint8Array(src.length);
    for (var y = 0; y < gray.height; y++) {
      for (var x = 0; x < gray.width; x++) {
        var i = y * gray.width + x;
        var v = src[i] / 255;
        if (dither) v += BAYER4[(y & 3) * 4 + (x & 3)] / levels;
        var q = Math.round(Math.max(0, Math.min(1, v)) * levels);
        out[i] = q;
      }
    }
    return { data: out, width: gray.width, height: gray.height, levels: levels };
  }
  /** Quantized levels -> 0..255 grey (mid-point of each bin). */
  function dequantize(q, bpp) {
    var levels = (1 << bpp) - 1;
    var out = new Uint8Array(q.data.length);
    for (var i = 0; i < out.length; i++) out[i] = Math.round(q.data[i] * 255 / levels);
    return { data: out, width: q.width, height: q.height };
  }

  // ------------------------------------------------------------------ bit packing
  /** Pack sub-byte samples MSB-first, row-major. */
  function packBits(levels, bpp) {
    var total = levels.length * bpp;
    var bytes = new Uint8Array(Math.ceil(total / 8));
    var bit = 0;
    for (var i = 0; i < levels.length; i++) {
      var v = levels[i];
      for (var b = bpp - 1; b >= 0; b--) {
        if ((v >> b) & 1) bytes[bit >> 3] |= (0x80 >> (bit & 7));
        bit++;
      }
    }
    return bytes;
  }
  function unpackBits(bytes, count, bpp) {
    var levels = new Uint8Array(count);
    var bit = 0;
    for (var i = 0; i < count; i++) {
      var v = 0;
      for (var b = 0; b < bpp; b++) {
        v = (v << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
        bit++;
      }
      levels[i] = v;
    }
    return levels;
  }

  /** Analytic size of a QIMG plane - the number that decides "does it fit". */
  function qimgSize(w, h, bpp) { return Math.ceil(w * h * bpp / 8); }

  // ------------------------------------------------------------------ quality byte
  function makeQuality(format, bpp, flags) {
    if (format === FORMAT_QIMG) return (((bpp & 0x0F) << 4) | (flags & 0x0F)) & 0xFF;
    return 0;   // PNG/JPEG path is not used in this build
  }
  function parseQuality(format, q) {
    if (format === FORMAT_QIMG) return { bpp: (q >> 4) & 0x0F, dither: !!(q & FLAG_DITHER), autoScaled: !!(q & FLAG_AUTOSCALED) };
    return { quality: q / 100, dither: false, autoScaled: false };
  }

  // ------------------------------------------------------------------ frame
  /**
   * Build an image frame.
   *
   * @param gray 8-bit grey plane (quantized internally to `bpp` levels)
   * @param opts.bpp     bits per pixel
   * @param opts.dither  ordered dithering on/off
   * @param opts.levels  OPTIONAL already-quantized level plane (Uint8Array, same w*h as gray).
   *                     Pass this to transmit EXACTLY the plane the preview was built from:
   *                     re-quantizing a dequantized plane is not idempotent once dithering is
   *                     involved (the dither threshold shifts borderline samples), so a caller
   *                     that quantizes on its own must hand the level plane over directly.
   * @returns {{ok:true, bytes:Uint8Array, meta:object}|{ok:false, reason:string, meta:object}}
   */
  function encodeImageFrame(gray, opts) {
    opts = opts || {};
    var budget = opts.dataBudget == null ? 200 : opts.dataBudget;
    var bpp = opts.bpp || 4;
    var dither = opts.dither !== false;
    var autoScaled = !!opts.autoScaled;

    var size = qimgSize(gray.width, gray.height, bpp);
    if (opts.maxDataBytes != null && size > opts.maxDataBytes) {
      return { ok: false, reason: 'image data ' + size + ' B exceeds budget ' + opts.maxDataBytes + ' B', meta: { dataBytes: size, w: gray.width, h: gray.height, bpp: bpp } };
    }
    if (HEADER_BYTES + size > budget + HEADER_BYTES) {
      return { ok: false, reason: 'image data ' + size + ' B exceeds budget ' + budget + ' B', meta: { dataBytes: size, w: gray.width, h: gray.height, bpp: bpp } };
    }

    var levels;
    if (opts.levels) {
      if (opts.levels.length !== gray.width * gray.height) {
        return { ok: false, reason: 'levels plane size mismatch', meta: {} };
      }
      levels = opts.levels;
    } else {
      levels = quantize(gray, bpp, dither).data;
    }
    var data = packBits(levels, bpp);

    var out = new Uint8Array(HEADER_BYTES + data.length);
    out[0] = MAGIC0; out[1] = MAGIC1;
    out[2] = VERSION;
    out[3] = FORMAT_QIMG;
    out[4] = (gray.width >> 8) & 0xFF; out[5] = gray.width & 0xFF;
    out[6] = (gray.height >> 8) & 0xFF; out[7] = gray.height & 0xFF;
    out[8] = makeQuality(FORMAT_QIMG, bpp, (dither ? FLAG_DITHER : 0) | (autoScaled ? FLAG_AUTOSCALED : 0));
    out[9] = (data.length >> 8) & 0xFF; out[10] = data.length & 0xFF;
    var c = crc32(out, 0, 11);
    out[11] = (c >>> 24) & 0xFF; out[12] = (c >>> 16) & 0xFF; out[13] = (c >>> 8) & 0xFF; out[14] = c & 0xFF;
    out.set(data, HEADER_BYTES);

    return {
      ok: true, bytes: out,
      meta: { W: gray.width, H: gray.height, format: FORMAT_QIMG, bpp: bpp, dither: dither,
              autoScaled: autoScaled, dataBytes: data.length, frameBytes: out.length, levels: (1 << bpp) }
    };
  }

  /** Parse + verify + decode an image frame. */
  function decodeImageFrame(bytes) {
    if (!bytes || bytes.length < HEADER_BYTES) return { ok: false, reason: 'frame shorter than header' };
    if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) {
      return { ok: false, reason: 'bad image magic (0x' + (bytes[0] || 0).toString(16) + (bytes[1] || 0).toString(16) + ')' };
    }
    if (bytes[2] !== VERSION) return { ok: false, reason: 'unsupported image frame version ' + bytes[2] };
    var format = bytes[3];
    if (format !== FORMAT_QIMG) {
      return { ok: false, reason: 'format ' + format + ' (' + (format === FORMAT_JPEG ? 'JPEG' : 'PNG') + ') is not supported: measured unusable at this capacity' };
    }
    var want = crc32(bytes, 0, 11);
    var got = ((bytes[11] << 24) | (bytes[12] << 16) | (bytes[13] << 8) | bytes[14]) >>> 0;
    if (want !== got) return { ok: false, reason: 'header CRC mismatch' };

    var W = (bytes[4] << 8) | bytes[5];
    var H = (bytes[6] << 8) | bytes[7];
    var pq = parseQuality(format, bytes[8]);
    var len = (bytes[9] << 8) | bytes[10];
    if (W < 1 || H < 1) return { ok: false, reason: 'degenerate dimensions ' + W + 'x' + H };
    if (bytes.length < HEADER_BYTES + len) return { ok: false, reason: 'truncated image data' };
    if (pq.bpp < 1 || pq.bpp > 8) return { ok: false, reason: 'bad bpp ' + pq.bpp };

    var levels = unpackBits(bytes.subarray(HEADER_BYTES, HEADER_BYTES + len), W * H, pq.bpp);
    var gray = dequantize({ data: levels, width: W, height: H }, pq.bpp);
    return {
      ok: true, gray: gray,
      meta: { W: W, H: H, format: format, bpp: pq.bpp, dither: pq.dither,
              autoScaled: pq.autoScaled, dataBytes: len, frameBytes: bytes.length }
    };
  }

  // ------------------------------------------------------------------ preprocessing
  function psnr(a, b) {
    var se = 0, n = Math.min(a.data.length, b.data.length);
    for (var i = 0; i < n; i++) { var d = a.data[i] - b.data[i]; se += d * d; }
    var mse = se / n;
    return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
  }

  var DEFAULT_SIDES = [256, 192, 128, 96, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8];
  var DEFAULT_BPPS = [8, 6, 4, 3, 2, 1];

  /**
   * The preprocessing pipeline: grey -> candidate ladder -> pick by measured quality.
   *
   * Selection is by RECONSTRUCTION PSNR against the original, not by "first candidate that
   * fits". Ladder order would otherwise decide the outcome (1bpp at a large size always
   * fits, and so does 8bpp at a tiny size, but they are not equally good). PSNR compares
   * them on one scale by decoding each candidate and re-upscaling to the original size.
   *
   * @returns {{ok:true, best:object, candidates:Array}|{ok:false, reason:string, candidates:Array}}
   */
  function chooseBest(imageData, opts) {
    opts = opts || {};
    var budget = opts.dataBudget == null ? 200 : opts.dataBudget;
    var minSide = opts.minSide == null ? 8 : opts.minSide;
    var sides = opts.sides || DEFAULT_SIDES;
    var bpps = opts.bpps || DEFAULT_BPPS;
    var dither = opts.dither !== false;
    var allowAutoScale = opts.autoScale !== false;

    var full = toGray(imageData);
    var candidates = [];

    for (var si = 0; si < sides.length; si++) {
      var box = sides[si];
      var fit = allowAutoScale ? fitSize(full.width, full.height, box, minSide) : null;
      if (!allowAutoScale) {
        fit = { w: full.width, h: full.height };
        if (box !== sides[0]) continue;      // without auto-scaling there is exactly one size
      }
      if (!fit) continue;
      var scaled = resizeGray(full, fit.w, fit.h);
      var autoScaled = fit.w !== full.width || fit.h !== full.height;

      for (var bi = 0; bi < bpps.length; bi++) {
        var bpp = bpps[bi];
        var size = qimgSize(fit.w, fit.h, bpp);
        if (size > budget) continue;
        var q = quantize(scaled, bpp, dither);
        var back = dequantize(q, bpp);
        var up = resizeGray(back, full.width, full.height);
        candidates.push({
          w: fit.w, h: fit.h, bpp: bpp, dataBytes: size, autoScaled: autoScaled,
          psnr: psnr(full, up), gray: back,
          // the exact quantized plane, so the embedder can transmit what the preview shows
          levels: q.data, levelsW: fit.w, levelsH: fit.h
        });
      }
      if (!allowAutoScale) break;
    }

    if (!candidates.length) {
      return { ok: false, reason: '秘密图过大，无法嵌入：最小尺寸（长边 ' + sides[sides.length - 1] +
        '，短边 ≥ ' + minSide + '）在 ' + budget + ' B 预算内仍放不下', candidates: [] };
    }
    candidates.sort(function (a, b) { return (b.psnr - a.psnr) || (b.w * b.h - a.w * a.h) || (b.bpp - a.bpp); });
    return { ok: true, best: candidates[0], candidates: candidates };
  }

  return {
    VERSION: VERSION, HEADER_BYTES: HEADER_BYTES,
    FORMAT_QIMG: FORMAT_QIMG, FORMAT_PNG: FORMAT_PNG, FORMAT_JPEG: FORMAT_JPEG,
    FLAG_DITHER: FLAG_DITHER, FLAG_AUTOSCALED: FLAG_AUTOSCALED,
    toGray: toGray, resizeGray: resizeGray, fitSize: fitSize,
    quantize: quantize, dequantize: dequantize,
    packBits: packBits, unpackBits: unpackBits, qimgSize: qimgSize,
    makeQuality: makeQuality, parseQuality: parseQuality,
    encodeImageFrame: encodeImageFrame, decodeImageFrame: decodeImageFrame,
    chooseBest: chooseBest, psnr: psnr, crc32: crc32,
    _internal: { BAYER4: BAYER4, DEFAULT_SIDES: DEFAULT_SIDES, DEFAULT_BPPS: DEFAULT_BPPS }
  };
});
