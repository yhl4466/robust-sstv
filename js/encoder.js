/*
 * Encoder facade: ImageData -> SSTV audio samples -> WAV bytes.
 *
 * Browser-only (it uses a canvas to rescale the source image). The mode/timing,
 * synthesis and container layers it drives are environment-independent and are
 * regression-tested in Node by tests/.
 */
(function (root, factory) {
  var api = factory(
    root.SSTVModes, root.SSTVTimeline, root.SSTVSynth, root.SSTVWav, root.SSTVChannel
  );
  root.SSTVEncoder = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes, Timeline, Synth, Wav, Channel) {
  'use strict';

  var SAMPLE_RATE = 48000;

  /*
   * SSTV modes have fixed geometry (Martin M1 and Scottie S1 are 320x256, PD 120
   * is 640x496) - NOT the 320x240 that is often quoted. A 240-line image would be
   * decoded by real SSTV software with 16 lines of garbage, so we always render
   * the user's picture into the mode's true raster, fitting by aspect ratio and
   * letterboxing with black.
   */
  function fitToMode(source, mode) {
    var canvas = document.createElement('canvas');
    canvas.width = mode.width;
    canvas.height = mode.height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    var sw = source.naturalWidth || source.width;
    var sh = source.naturalHeight || source.height;
    if (!sw || !sh) throw new Error('无法读取图片尺寸');

    var scale = Math.min(canvas.width / sw, canvas.height / sh);
    var dw = Math.max(1, Math.round(sw * scale));
    var dh = Math.max(1, Math.round(sh * scale));
    var dx = Math.floor((canvas.width - dw) / 2);
    var dy = Math.floor((canvas.height - dh) / 2);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, dx, dy, dw, dh);

    return { imageData: ctx.getImageData(0, 0, canvas.width, canvas.height), canvas: canvas };
  }

  /**
   * @param {ImageData} imageData  must already match the mode geometry
   * @param {string} modeId        'M1' | 'S1' | 'PD120'
   * @param {object} [opts]        amplitude / progress passthrough
   * @returns {object} result with samples, timing, segment map and capacity info
   */
  function encode(imageData, modeId, opts) {
    var mode = Modes.get(modeId);
    var t0 = Date.now();
    var timeline = Timeline.build(imageData, mode);
    var synth = Synth.synthesize(timeline, SAMPLE_RATE, opts);

    // Phase-2 seam. Identity in phase 1, but genuinely in the signal path so the
    // hook cannot rot.
    var embedded = Channel.Codec.applyEmbed(timeline, synth.samples, { mode: mode.id });

    return {
      ok: true,
      mode: mode.id,
      modeName: mode.name,
      width: mode.width,
      height: mode.height,
      samples: embedded.samples,
      sampleRate: SAMPLE_RATE,
      duration: embedded.samples.length / SAMPLE_RATE,
      timeline: timeline,
      segmentMap: synth.segmentMap,
      capacity: Channel.Codec.capacity(timeline),
      embedMeta: embedded.meta,
      elapsedMs: Date.now() - t0
    };
  }

  function toWavBytes(samples, sampleRate) {
    return Wav.encode(samples, sampleRate || SAMPLE_RATE);
  }

  return {
    SAMPLE_RATE: SAMPLE_RATE,
    modes: function () { return Modes.list(); },
    getMode: function (id) { return Modes.get(id); },
    estimateDuration: function (id) { return Modes.totalDuration(Modes.get(id)); },
    fitToMode: fitToMode,
    encode: encode,
    toWavBytes: toWavBytes
  };
});
