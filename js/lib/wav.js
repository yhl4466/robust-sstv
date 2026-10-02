/*
 * Minimal, dependency-free WAV (RIFF/WAVE) reader and writer.
 *
 * Why not use AudioContext.decodeAudioData() for WAV?
 *   decodeAudioData() RESAMPLES the audio to the AudioContext's sample rate.
 *   SSTV decoding needs the file's NATIVE sample rate and samples, because the
 *   whole demodulation is timed in seconds against that rate. Real SSTV
 *   recordings are commonly 8000, 11025 or 48000 Hz; resampling them to the
 *   device rate would silently corrupt every timing calculation. So we parse the
 *   WAV container ourselves, and this stays the only path for RIFF/WAVE files.
 *
 *   That reasoning is about WAV, not about every format. A file this parser
 *   cannot read at all - a phone screen recording in M4A/MP4/WebM - is handed to
 *   decodeAudioData instead of being refused; see js/lib/audio-input.js.
 *
 * Supported on read: PCM 8/16/24/32-bit int, 32-bit IEEE float, WAVE_FORMAT_EXTENSIBLE,
 *                    mono or multi-channel (mixed down to mono), extra/unknown chunks.
 * Writer: 16-bit PCM mono.
 */
(function (root, factory) {
  var api = factory();
  root.SSTVWav = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fourcc(view, off) {
    return String.fromCharCode(
      view.getUint8(off), view.getUint8(off + 1),
      view.getUint8(off + 2), view.getUint8(off + 3)
    );
  }

  /**
   * @param {ArrayBuffer} buffer
   * @returns {{samples: Float32Array, sampleRate: number, channels: number,
   *            bitsPerSample: number, format: string, duration: number}}
   */
  function parse(buffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error('WAV parse expects an ArrayBuffer');
    }
    if (buffer.byteLength < 44) throw new Error('File is too small to be a WAV file');

    var view = new DataView(buffer);
    if (fourcc(view, 0) !== 'RIFF') throw new Error('Not a RIFF file (missing "RIFF" header)');
    if (fourcc(view, 8) !== 'WAVE') throw new Error('Not a WAVE file (missing "WAVE" marker)');

    var fmt = null;
    var dataChunks = [];
    var off = 12;

    while (off + 8 <= buffer.byteLength) {
      var id = fourcc(view, off);
      var size = view.getUint32(off + 4, true);
      var body = off + 8;
      // Guard against a corrupt/truncated final chunk size
      var avail = buffer.byteLength - body;
      if (size > avail) size = avail;

      if (id === 'fmt ') {
        if (size < 16) throw new Error('Malformed "fmt " chunk');
        var audioFormat = view.getUint16(body, true);
        var channels = view.getUint16(body + 2, true);
        var sampleRate = view.getUint32(body + 4, true);
        var bitsPerSample = view.getUint16(body + 14, true);
        // WAVE_FORMAT_EXTENSIBLE: real format lives in the sub-format GUID
        if (audioFormat === 0xFFFE && size >= 26) {
          audioFormat = view.getUint16(body + 24, true);
        }
        fmt = {
          audioFormat: audioFormat,
          channels: channels,
          sampleRate: sampleRate,
          bitsPerSample: bitsPerSample,
          blockAlign: view.getUint16(body + 12, true)
        };
      } else if (id === 'data') {
        dataChunks.push({ offset: body, size: size });
      }

      off = body + size + (size % 2); // chunks are word-aligned
    }

    if (!fmt) throw new Error('WAV file has no "fmt " chunk');
    if (!dataChunks.length) throw new Error('WAV file has no "data" chunk');
    if (!fmt.channels) throw new Error('WAV file declares 0 channels');
    if (!fmt.sampleRate) throw new Error('WAV file declares a 0 Hz sample rate');

    var isFloat = fmt.audioFormat === 3;
    var isPcm = fmt.audioFormat === 1;
    if (!isFloat && !isPcm) {
      throw new Error(
        'Unsupported WAV encoding (audioFormat=' + fmt.audioFormat +
        '). Only uncompressed PCM and 32-bit float are supported.'
      );
    }
    if (isFloat && fmt.bitsPerSample !== 32) {
      throw new Error('Unsupported float WAV bit depth: ' + fmt.bitsPerSample);
    }
    if (isPcm && [8, 16, 24, 32].indexOf(fmt.bitsPerSample) === -1) {
      throw new Error('Unsupported PCM WAV bit depth: ' + fmt.bitsPerSample);
    }

    var bytesPerSample = fmt.bitsPerSample / 8;
    var frameBytes = bytesPerSample * fmt.channels;
    var totalFrames = 0;
    for (var i = 0; i < dataChunks.length; i++) {
      totalFrames += Math.floor(dataChunks[i].size / frameBytes);
    }
    if (totalFrames === 0) throw new Error('WAV file contains no audio frames');

    var out = new Float32Array(totalFrames);
    var w = 0;

    for (var c = 0; c < dataChunks.length; c++) {
      var chunk = dataChunks[c];
      var frames = Math.floor(chunk.size / frameBytes);
      for (var f = 0; f < frames; f++) {
        var sum = 0;
        for (var ch = 0; ch < fmt.channels; ch++) {
          var p = chunk.offset + f * frameBytes + ch * bytesPerSample;
          sum += readSample(view, p, fmt.bitsPerSample, isFloat);
        }
        out[w++] = sum / fmt.channels;
      }
    }

    return {
      samples: out,
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitsPerSample: fmt.bitsPerSample,
      format: isFloat ? 'float' : 'pcm',
      duration: totalFrames / fmt.sampleRate
    };
  }

  function readSample(view, p, bits, isFloat) {
    if (isFloat) return view.getFloat32(p, true);
    if (bits === 8) return (view.getUint8(p) - 128) / 128;
    if (bits === 16) return view.getInt16(p, true) / 32768;
    if (bits === 24) {
      var b0 = view.getUint8(p);
      var b1 = view.getUint8(p + 1);
      var b2 = view.getUint8(p + 2);
      var v = b0 | (b1 << 8) | (b2 << 16);
      if (v & 0x800000) v |= ~0xFFFFFF; // sign-extend
      return v / 8388608;
    }
    return view.getInt32(p, true) / 2147483648; // 32-bit int
  }

  /**
   * Encode mono Float32 samples as a 16-bit PCM WAV.
   * @returns {Uint8Array}
   */
  function encode(samples, sampleRate) {
    var n = samples.length;
    var dataBytes = n * 2;
    var buf = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(buf);

    function str(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }

    str(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);       // fmt chunk size
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, 1, true);        // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);        // block align
    view.setUint16(34, 16, true);       // bits per sample
    str(36, 'data');
    view.setUint32(40, dataBytes, true);

    var o = 44;
    for (var i = 0; i < n; i++) {
      var s = samples[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      // asymmetric scaling avoids clipping the positive peak
      view.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), true);
      o += 2;
    }
    return new Uint8Array(buf);
  }

  return { parse: parse, encode: encode };
});
