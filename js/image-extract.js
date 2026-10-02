/*
 * Phase-5 receive side: recover the public image AND the hidden secret image.
 *
 * Pipeline:
 *   audio -> SSTVDecode.decode          -> public image + per-pixel confidence + calibration
 *         -> PayloadPipeline.extractPayload -> generic frame + RS decode + deinterleave
 *         -> ImageCodec.decodeImageFrame -> secret grey plane
 *
 * The public image comes from the ordinary analogue SSTV path; the secret image comes from
 * the digital side channel. They are recovered from the SAME samples in one pass.
 *
 * Usage (browser): ImageExtract.extractImage(samples, sampleRate, opts)
 * Usage (node):    require('./js/image-extract.js')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./image-codec.js'),
      require('./payload-pipeline.js'),
      require('./lib/sstv-decode.js'));
  } else {
    root.ImageExtract = factory(root.ImageCodec, root.PayloadPipeline, root.SSTVDecode);
  }
})(typeof self !== 'undefined' ? self : this, function (Codec, Pipeline, Decode) {
  'use strict';

  var DEFAULTS = {
    blockSize: 32,
    delta: 12,
    nsym: 32,
    interleaveDepth: 32,
    quality: 'standard',
    knownCodedBytes: null,
    onProgress: null,
    yieldFn: null,
    yieldEvery: 0
  };

  function options(o) {
    var r = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) r[k] = DEFAULTS[k];
    for (var k2 in (o || {})) if (Object.prototype.hasOwnProperty.call(o, k2)) r[k2] = o[k2];
    return r;
  }

  /** Wrap a grey plane as RGBA so it can be drawn on a canvas directly. */
  function grayToImageData(gray) {
    var n = gray.width * gray.height;
    var out = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) {
      var v = gray.data[i], o = i << 2;
      out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
    }
    return { data: out, width: gray.width, height: gray.height };
  }

  /** Nearest-neighbour upscale, for showing a 16x13 secret at a viewable size. */
  function upscaleNearest(gray, factor) {
    var f = factor || 8;
    var w = gray.width * f, h = gray.height * f;
    var out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var v = gray.data[((y / f) | 0) * gray.width + ((x / f) | 0)];
        var o = (y * w + x) << 2;
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }

  /**
   * @param samples Float32Array (mono) of the received audio
   * @returns {{ok:boolean, stage:string, reason:string,
   *            publicImage:object|null, secretImage:object|null, secretImageNative:object|null,
   *            secretMeta:object, publicMeta:object}}
   */
  async function extractImage(samples, sampleRate, opts) {
    var o = options(opts);
    var result = {
      ok: false, stage: 'init', reason: '',
      publicImage: null, secretImage: null, secretImageNative: null,
      secretMeta: { success: false, reason: 'not attempted' },
      publicMeta: {}
    };

    // 1. analogue SSTV demodulation -> public image (+ confidence, + calibration)
    var dec = await Decode.decode(samples, sampleRate, {
      quality: o.quality,
      onProgress: o.onProgress || undefined,
      yieldFn: o.yieldFn || undefined,
      yieldEvery: o.yieldEvery || 0
    });
    if (!dec.ok) {
      result.stage = 'demodulate';
      result.reason = 'SSTV 解调失败（' + (dec.stage || '?') + '）：' + dec.message;
      return result;
    }
    result.publicImage = dec.imageData;
    result.publicMeta = {
      mode: dec.mode.name, modeId: dec.mode.id, width: dec.mode.width, height: dec.mode.height,
      calibration: dec.calibration || null, timings: dec.timings || null
    };

    // 2. digital side channel: generic frame + RS + deinterleave
    var cfg = {
      blockSize: o.blockSize, delta: o.delta, nsym: o.nsym,
      codewordLength: 'auto', interleaveDepth: o.interleaveDepth
    };
    var ex = Pipeline.extractPayload(dec.imageData, cfg, o.knownCodedBytes || undefined);
    result.stats = ex.stats || null;
    if (!ex.ok) {
      result.stage = 'payload';
      result.reason = '数字边带帧校验失败：' + (ex.reason || 'unknown');
      result.secretMeta = { success: false, reason: ex.reason, payloadRecovered: false };
      // still a useful outcome: the public image is fine
      result.ok = true;
      result.partial = true;
      return result;
    }

    // 3. image frame -> secret grey plane
    var img = Codec.decodeImageFrame(ex.payload);
    if (!img.ok) {
      result.stage = 'image-frame';
      result.reason = '图片帧解析失败：' + img.reason;
      result.secretMeta = { success: false, reason: img.reason, payloadRecovered: true };
      result.ok = true;
      result.partial = true;
      return result;
    }

    result.secretImageNative = grayToImageData(img.gray);
    var factor = Math.max(1, Math.min(16, Math.round(320 / Math.max(img.gray.width, 1))));
    result.secretImage = upscaleNearest(img.gray, factor);
    result.secretMeta = {
      success: true, W: img.meta.W, H: img.meta.H, format: img.meta.format,
      formatName: 'QIMG', bpp: img.meta.bpp, dither: img.meta.dither,
      autoScaled: img.meta.autoScaled, dataBytes: img.meta.dataBytes,
      frameBytes: img.meta.frameBytes, displayScale: factor,
      payloadBytes: ex.payload.length,
      payloadRecovered: true, reason: ''
    };
    result.ok = true;
    result.stage = 'done';
    return result;
  }

  return { extractImage: extractImage, grayToImageData: grayToImageData, upscaleNearest: upscaleNearest, DEFAULTS: DEFAULTS };
});
