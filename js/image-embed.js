/*
 * Phase-5 transmit side: hide a secret IMAGE inside an SSTV carrier image.
 *
 * Pipeline (nothing below the payload layer is touched):
 *   secret image -> grey -> candidate ladder -> chosen (size, bpp) by reconstruction PSNR
 *                -> image frame (15 B header + QIMG data)
 *                -> PayloadPipeline.embedPayload  (generic 8 B frame + RS + interleave)
 *                -> QIM into the carrier's green channel
 *                -> SSTVTimeline + SSTVSynth -> audio samples
 *
 * The public image and the secret image share the SAME analogue SSTV waveform: the secret is
 * a parasitic digital side channel in the pixel domain, so the receiver needs no extra band.
 *
 * Usage (browser): ImageEmbed.embedImage(carrierImageData, secretImageData, opts)
 * Usage (node):    require('./js/image-embed.js')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./image-codec.js'),
      require('./payload-pipeline.js'),
      require('./lib/sstv-modes.js'),
      require('./lib/sstv-timeline.js'),
      require('./lib/sstv-synth.js'));
  } else {
    root.ImageEmbed = factory(root.ImageCodec, root.PayloadPipeline, root.SSTVModes,
      root.SSTVTimeline, root.SSTVSynth);
  }
})(typeof self !== 'undefined' ? self : this, function (Codec, Pipeline, Modes, Timeline, Synth) {
  'use strict';

  var DEFAULTS = {
    mode: 'M1',
    sampleRate: 48000,
    blockSize: 32,          // phase-3 goodput optimum
    delta: 12,
    nsym: 32,               // RS(255,223)
    interleaveDepth: 32,
    autoScale: true,
    dither: true,
    minSide: 8,
    // optional ladder overrides, e.g. to bias towards more pixels
    sides: null,
    bpps: null
  };

  function options(o) {
    var r = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) r[k] = DEFAULTS[k];
    for (var k2 in (o || {})) if (Object.prototype.hasOwnProperty.call(o, k2)) r[k2] = o[k2];
    return r;
  }

  /**
   * @param carrierImageData carrier raster, already fitted to the mode geometry
   * @param secretImageData  arbitrary-size RGBA raster (any aspect ratio)
   * @returns {{ok:true, audioSamples:Float32Array, embeddedInfo:object, frame:Uint8Array}
   *          |{ok:false, reason:string, candidates?:Array}}
   */
  function embedImage(carrierImageData, secretImageData, opts) {
    var o = options(opts);
    var mode = Modes.get(o.mode);
    if (!mode) return { ok: false, reason: 'unknown mode ' + o.mode };

    // 1. capacity of the payload layer under this carrier configuration
    var cfg = {
      blockSize: o.blockSize, delta: o.delta, nsym: o.nsym,
      codewordLength: 'auto', interleaveDepth: o.interleaveDepth
    };
    var cap = Pipeline.capacity(carrierImageData, cfg);
    var dataBudget = cap.payloadBytes - Codec.HEADER_BYTES;
    if (dataBudget < 8) {
      return { ok: false, reason: 'carrier capacity too small: payload ' + cap.payloadBytes +
        ' B leaves ' + dataBudget + ' B for image data' };
    }

    // 2. preprocess the secret image, choosing (size, bpp) by measured reconstruction PSNR
    var t0 = Date.now();
    var sel = Codec.chooseBest(secretImageData, {
      dataBudget: dataBudget,
      minSide: o.minSide,
      autoScale: o.autoScale,
      dither: o.dither,
      sides: o.sides || undefined,
      bpps: o.bpps || undefined
    });
    if (!sel.ok) return { ok: false, reason: sel.reason, candidates: sel.candidates };
    var best = sel.best;
    var preprocessMs = Date.now() - t0;

    // 3. image frame - pass the quantized plane through so the transmitted image is exactly
    //    the one the caller previewed
    var frame = Codec.encodeImageFrame(best.gray, {
      bpp: best.bpp, dither: o.dither, autoScaled: best.autoScaled,
      maxDataBytes: dataBudget, levels: best.levels
    });
    if (!frame.ok) return { ok: false, reason: frame.reason };

    // 4. generic payload layer (unchanged): frame header + RS + interleave + QIM
    var t1 = Date.now();
    var emb = Pipeline.embedPayload(carrierImageData, frame.bytes, cfg);
    if (!emb.ok) return { ok: false, reason: 'payload layer refused the image frame: ' + emb.reason };
    var encodeMs = Date.now() - t1;

    // 5. SSTV modulation
    var t2 = Date.now();
    var tl = Timeline.build(emb.imageData, mode);
    var samples = Synth.synthesize(tl, o.sampleRate).samples;
    var synthMs = Date.now() - t2;

    return {
      ok: true,
      audioSamples: samples,
      frame: frame.bytes,
      embeddedInfo: {
        secretFinalSize: { W: best.w, H: best.h },
        secretSourceSize: { W: secretImageData.width, H: secretImageData.height },
        secretDataBytes: best.dataBytes,
        // kept for report/UI compatibility with the task spec; the QIMG path has no JPEG
        secretJpegBytes: null,
        frameBytes: frame.bytes.length,
        capacity: cap.payloadBytes,
        dataBudget: dataBudget,
        autoResized: best.autoScaled,
        format: 'QIMG',
        formatId: frame.meta.format,
        bpp: best.bpp,
        levels: best.levels_count || (1 << best.bpp),
        dither: o.dither,
        reconstructionPsnr: best.psnr,
        mode: mode.name,
        duration: tl.duration,
        blockSize: o.blockSize, delta: o.delta, nsym: o.nsym,
        codewords: cap.codewords, codewordLength: cap.codewordLength, depth: cap.effectiveDepth,
        preprocessMs: preprocessMs, encodeMs: encodeMs, synthMs: synthMs,
        carrierPenaltyDb: null,
        // the preview the UI should show (native-size grey plane of the secret)
        secretPreview: best.gray
      }
    };
  }

  return { embedImage: embedImage, DEFAULTS: DEFAULTS };
});
