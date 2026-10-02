/*
 * Frequency timeline -> PCM samples.
 *
 * We synthesise samples ourselves rather than scheduling an OscillatorNode with
 * setValueCurveAtTime(), for four reasons:
 *   1. Determinism - the same image always yields byte-identical audio.
 *   2. Per-sample control - phase 2 must be able to write individual samples
 *      (LDPC payloads / steganographic carriers). An AudioParam cannot be
 *      touched at sample resolution.
 *   3. Testability - this module is plain arithmetic, so the whole
 *      image -> audio pipeline can be regression-tested in Node without a browser.
 *   4. No OfflineAudioContext length bugs - we size the buffer from the exact
 *      segment timings instead of a separately maintained length formula.
 *
 * Phase is continuous across every segment (never reset), so segment boundaries
 * produce no discontinuities/clicks. Sample counts are derived from cumulative
 * exact times (not per-segment rounding) so timing never drifts.
 *
 * Modulation is a staircase: each pixel holds its frequency for exactly
 * scanTime/pixelsPerLine seconds. That is what SSTV actually specifies, and it
 * is what samccone/sstv's encoder does - the reference that round-trips at
 * 30.53 dB against the source image.
 */
(function (root, factory) {
  var api = factory();
  root.SSTVSynth = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var AMPLITUDE = 0.5; // matches both reference encoders

  /**
   * @param {object} timeline  from SSTVTimeline.build()
   * @param {number} sampleRate
   * @param {{amplitude?: number, leadInSeconds?: number, onProgress?: function}} [opts]
   * @returns {{samples: Float32Array, sampleRate: number, segmentMap: Array}}
   */
  function synthesize(timeline, sampleRate, opts) {
    opts = opts || {};
    if (!(sampleRate > 0)) throw new Error('synthesize() needs a positive sample rate');

    var amp = opts.amplitude == null ? AMPLITUDE : opts.amplitude;
    var leadIn = opts.leadInSeconds || 0;
    var leadSamples = Math.round(leadIn * sampleRate);

    var segs = timeline.segments;
    var totalSamples = leadSamples;
    var i;

    // First pass: exact total length from cumulative times.
    var t = 0;
    for (i = 0; i < segs.length; i++) t += segs[i].dur;
    totalSamples += Math.round(t * sampleRate);

    var out = new Float32Array(totalSamples);
    var phase = 0;
    var w = leadSamples;
    var segMap = new Array(segs.length);
    var cursor = 0; // cumulative exact seconds

    for (i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var t0 = cursor;
      cursor += seg.dur;
      var n = Math.round(cursor * sampleRate) - Math.round(t0 * sampleRate);
      if (n < 0) n = 0;

      var s0 = w;
      var freqStep = TWO_PI / sampleRate;

      if (seg.kind === 'tone') {
        var inc = seg.freq * freqStep;
        for (var k = 0; k < n; k++) {
          phase += inc;
          if (phase > TWO_PI) phase -= TWO_PI;
          out[w++] = amp * Math.sin(phase);
        }
        segMap[i] = { kind: 'tone', t0: t0, t1: cursor, s0: s0, s1: w, freq: seg.freq };

      } else { // 'scan'
        var freqs = seg.freqs;
        var np = freqs.length;
        var perPixel = n / np;
        var curPixel = -1;
        var curInc = 0;
        for (var j = 0; j < n; j++) {
          var pi = Math.floor(j / perPixel);
          if (pi > np - 1) pi = np - 1;
          if (pi !== curPixel) {
            curPixel = pi;
            curInc = freqs[pi] * freqStep;
          }
          phase += curInc;
          if (phase > TWO_PI) phase -= TWO_PI;
          out[w++] = amp * Math.sin(phase);
        }
        segMap[i] = { kind: 'scan', t0: t0, t1: cursor, s0: s0, s1: w, pixels: np, freqs: freqs };
      }

      if (opts.onProgress && (i % 64 === 0)) opts.onProgress(i / segs.length);
    }

    return { samples: out, sampleRate: sampleRate, segmentMap: segMap };
  }

  return { synthesize: synthesize, AMPLITUDE: AMPLITUDE };
});
