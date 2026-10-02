/*
 * Decoder facade: WAV bytes -> ImageData.
 *
 * Wraps the WAV parser and the demodulator, and pulls in the phase-2 extraction
 * seam (identity in phase 1).
 *
 * Two deliberate choices worth knowing about:
 *  - We do NOT use AudioContext.decodeAudioData(). It resamples to the device's
 *    rate, and SSTV demodulation is timed in seconds against the file's NATIVE
 *    sample rate. See js/lib/wav.js.
 *  - Decoding yields to the event loop between line batches. Under file:// there
 *    is no Web Worker (workers are blocked from an opaque origin), so keeping the
 *    page responsive has to be cooperative.
 */
(function (root, factory) {
  var api = factory(root.SSTVWav, root.SSTVDecode, root.SSTVChannel, root.SSTVModes);
  root.SSTVDecoder = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Wav, Decode, Channel, Modes) {
  'use strict';

  var QUALITY = Decode.QUALITY;
  var supported = Decode.SUPPORTED;

  /** Let the browser paint between decode batches. */
  function rafYield() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { resolve(); });
      else setTimeout(resolve, 0);
    });
  }

  function parseWav(arrayBuffer) {
    try {
      var info = Wav.parse(arrayBuffer);
      return {
        ok: true,
        samples: info.samples,
        sampleRate: info.sampleRate,
        channels: info.channels,
        bitsPerSample: info.bitsPerSample,
        format: info.format,
        duration: info.duration
      };
    } catch (e) {
      return { ok: false, stage: 'wav', message: e.message };
    }
  }

  /** Reads a File into an ArrayBuffer without fetch() (unavailable on file://). */
  function readFileBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  async function decode(samples, sampleRate, opts) {
    opts = opts || {};
    var result = await Decode.decode(samples, sampleRate, {
      quality: opts.quality,
      mult: opts.mult,
      wantConfidence: opts.wantConfidence,
      onProgress: opts.onProgress,
      shouldCancel: opts.shouldCancel,
      yieldFn: opts.yieldFn || rafYield,
      yieldEvery: opts.yieldEvery == null ? 4 : opts.yieldEvery
    });

    if (result.ok) {
      // Phase-2 seam: identity in phase 1.
      var extracted = Channel.Codec.applyExtract(samples, { mode: result.mode.id });
      result.payload = extracted.bits;
      result.payloadConfidence = extracted.confidence;
    }
    return result;
  }

  return {
    QUALITY: QUALITY,
    supported: supported,
    parseWav: parseWav,
    readFileBuffer: readFileBuffer,
    decode: decode
  };
});
