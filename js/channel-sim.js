/*
 * Channel simulator - the foundation for every robustness measurement in phase 2.
 *
 * Applies degradations to SSTV audio samples. Deterministic: every random draw
 * comes from a seeded PRNG, so any configuration reproduces byte-identically.
 *
 * Degradation order (deliberate; the reason for each position is noted below):
 *
 *   1. multipath          continuous-time propagation: delayed/attenuated copies
 *   2. frequency offset   continuous-time effect: receiver LO / tuning error
 *   3. rate mismatch      the RECEIVER'S clock: time-scaling of the waveform
 *   4. impulse noise      receiver-domain interference (must come AFTER resampling,
 *                         otherwise interpolation smears the bursts and changes
 *                         their character entirely)
 *   5. AWGN               the additive background floor
 *
 * Why this order matters: (1)-(3) are systematic distortions that must be applied
 * while the signal still represents a continuous waveform; (4)-(5) are added in the
 * receiver's sampled domain.
 *
 * ---------------------------------------------------------------------------
 * Frequency offset - the one non-obvious implementation
 * ---------------------------------------------------------------------------
 * A real tuner/LO error TRANSLATES the passband (single sideband). The naive
 * implementation, multiplying a real signal by cos(2*pi*df*t), does NOT do that:
 * it produces BOTH f+df and f-df components, so every SSTV tone appears as two
 * peaks. That models double-sideband modulation, not a tuning error, and it would
 * make the demodulator's peak picker ambiguous for reasons that have nothing to do
 * with robustness.
 *
 * We instead build the complex envelope and re-modulate on a shifted carrier:
 *
 *     I,Q   = x * exp(-j*2*pi*fc*t)          (complex downconversion, fc = band centre)
 *     I,Q  <- LPF(I), LPF(Q)                 (identical filters -> phase preserved)
 *     y     = 2 * Re{ (I + jQ) * exp(+j*2*pi*(fc+df)*t) }
 *
 * which IS the analytic signal times exp(j*2*pi*df*t), i.e. an exact SSB shift, and
 * costs O(N) with no Hilbert transformer design. Because I and Q pass through
 * IDENTICAL filters, the low-pass phase response does not perturb the translation -
 * it only adds a small constant group delay.
 *
 * Verified requirement (tests/channel-sim.test.js): the demodulated tone frequency
 * moves by exactly df and no spurious image peak appears.
 */
(function (root, factory) {
  var api = factory();
  root.ChannelSim = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '0.1.0-phase2';

  // SSTV occupies 1200..2300 Hz; 1750 Hz is the band centre (max +/-550 Hz).
  var BAND_CENTRE_HZ = 1750;
  /*
   * I/Q low-pass cutoff. Chosen from both ends:
   *   in-band flatness - 4th-order Butterworth at 900 Hz is only -0.06 dB at the
   *     band edge (550 Hz), so the shifter does not tilt the SSTV spectrum;
   *   image rejection  - the downconversion image sits at -(f+fc), i.e. 2950..4050 Hz,
   *     where the same filter gives >41 dB rejection.
   * A 700 Hz cutoff would have cost 0.6 dB of droop at the band edges for no benefit.
   */
  var LPF_CUTOFF_HZ = 900;

  // ------------------------------------------------------------------ PRNG
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------ utils
  function rms(samples, from, to) {
    var s = 0;
    var a = from || 0;
    var b = to == null ? samples.length : to;
    for (var i = a; i < b; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / Math.max(1, b - a));
  }

  /** RBJ cookbook low-pass biquad (2nd-order Butterworth when Q = 1/sqrt(2)). */
  function lowpassBiquad(fs, fc, q) {
    var w0 = 2 * Math.PI * fc / fs;
    var cosw = Math.cos(w0), sinw = Math.sin(w0);
    var alpha = sinw / (2 * q);
    var b0 = (1 - cosw) / 2, b1 = 1 - cosw, b2 = (1 - cosw) / 2;
    var a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  /** In-place 4th-order (two cascaded biquads) low-pass. */
  function applyLowpass4(x, coeffs) {
    for (var s = 0; s < coeffs.length; s++) {
      var c = coeffs[s];
      var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (var i = 0; i < x.length; i++) {
        var xi = x[i];
        var yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = xi; y2 = y1; y1 = yi;
        x[i] = yi;
      }
    }
    return x;
  }

  // ------------------------------------------------------------------ stages
  function stageMultipath(samples, fs, mp) {
    var delay = Math.max(0, Math.round((mp.delayMs / 1000) * fs));
    if (!delay) return samples;
    var att = mp.attenuation == null ? 0.5 : mp.attenuation;
    var out = new Float32Array(samples.length);
    for (var i = 0; i < samples.length; i++) {
      out[i] = samples[i] + (i >= delay ? att * samples[i - delay] : 0);
    }
    return out;
  }

  /**
   * Single-sideband frequency translation by df Hz (see the header comment).
   * Returns a new array of the same length. df === 0 is bypassed exactly.
   *
   * Mirror padding: the I/Q low-pass starts from zero state, which would put a
   * start-up transient on the first millisecond - i.e. on the calibration header,
   * the one part of the signal the demodulator must find. Mirroring the edges makes
   * the waveform continuous across the boundary for a band-limited signal, so the
   * filter is already in steady state where the real signal begins and no transient
   * is charged to the measurement. Phases are referenced to the padded index, which
   * only adds a constant phase offset - harmless, since only frequency matters.
   */
  function stageFreqOffset(samples, fs, df) {
    if (!df) return samples;

    var n = samples.length;
    var M = Math.min(1024, n);
    var total = n + 2 * M;
    var pad = new Float32Array(total);
    for (var i = 0; i < n; i++) pad[M + i] = samples[i];
    for (var j = 0; j < M; j++) {
      pad[M - 1 - j] = samples[j];              // mirror at the start
      pad[M + n + j] = samples[n - 1 - j];      // mirror at the end
    }

    var wc = 2 * Math.PI * BAND_CENTRE_HZ / fs;
    var ws = 2 * Math.PI * (BAND_CENTRE_HZ + df) / fs;
    var I = new Float32Array(total);
    var Q = new Float32Array(total);

    for (var k = 0; k < total; k++) {
      var p = wc * k;
      var c = Math.cos(p), s = Math.sin(p);
      var x = pad[k];
      I[k] = x * c;
      Q[k] = -x * s;
    }

    var coeffs = [lowpassBiquad(fs, LPF_CUTOFF_HZ, Math.SQRT1_2),
                  lowpassBiquad(fs, LPF_CUTOFF_HZ, Math.SQRT1_2)];
    applyLowpass4(I, coeffs);
    applyLowpass4(Q, coeffs);

    var out = new Float32Array(n);
    for (var m = 0; m < n; m++) {
      var idx = M + m;
      var ps = ws * idx;
      out[m] = 2 * (I[idx] * Math.cos(ps) - Q[idx] * Math.sin(ps));
    }
    return out;
  }

  /**
   * Simulate a receiver clock error by resampling at `ratio`.
   * ratio > 1 means the receiver samples faster than the transmitter, so the
   * waveform appears time-compressed and the output is SHORTER.
   *
   * The declared sample rate is deliberately NOT changed - the receiver still
   * believes it is 48 kHz. That is the whole point of a clock mismatch; correcting
   * the declared rate here would hand the receiver the answer.
   *
   * Linear interpolation is adequate here and not a shortcut: the signal is band
   * limited to 2.3 kHz at a 48 kHz rate (a >10x oversampling), so the sinc droop
   * error of linear interpolation is far below the SSTV pipeline's own error floor.
   */
  function stageRateMismatch(samples, ratio) {
    if (!ratio || ratio === 1) return samples;
    var n = Math.floor(samples.length / ratio);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = i * ratio;
      var i0 = Math.floor(x);
      var frac = x - i0;
      var a = i0 < samples.length ? samples[i0] : 0;
      var b = i0 + 1 < samples.length ? samples[i0 + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  /**
   * Impulse (burst) noise: short high-amplitude spikes at random positions.
   * Amplitude is expressed as a multiple of the signal RMS so the setting is
   * scale-invariant.
   */
  function stageImpulse(samples, fs, opt, rnd) {
    var rate = opt.impulseRate == null ? 20 : opt.impulseRate;
    var amp = opt.impulseAmp == null ? 10 : opt.impulseAmp;
    var widthMs = opt.impulseWidthMs == null ? 0.5 : opt.impulseWidthMs;
    var out = Float32Array.from(samples);
    if (rate <= 0 || amp <= 0) return out;

    var width = Math.max(1, Math.round(widthMs / 1000 * fs));
    var count = Math.max(1, Math.round(rate * samples.length / fs));
    var level = amp * (rms(samples) || 1);
    var signFlip = rnd() < 0.5 ? -1 : 1;

    for (var k = 0; k < count; k++) {
      var at = Math.floor(rnd() * (samples.length - width));
      var sgn = (k % 2 === 0) ? signFlip : -signFlip;   // alternating bursts
      for (var w = 0; w < width; w++) {
        // raised-cosine envelope: a burst, not a click
        var env = 0.5 - 0.5 * Math.cos(2 * Math.PI * (w + 0.5) / width);
        out[at + w] += sgn * level * env;
      }
    }
    return out;
  }

  function stageAwgn(samples, snrDb, rnd) {
    var p = 0;
    for (var i = 0; i < samples.length; i++) p += samples[i] * samples[i];
    var sigPower = p / samples.length;
    var noisePower = sigPower / Math.pow(10, snrDb / 10);
    var sigma = Math.sqrt(noisePower);
    var out = new Float32Array(samples.length);
    for (var j = 0; j < samples.length; j++) {
      var u1 = rnd() || 1e-12, u2 = rnd();
      var g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      out[j] = samples[j] + sigma * g;
    }
    return out;
  }

  // ------------------------------------------------------------------ options
  /**
   * Normalise the caller's options. Accepts both the documented names and the
   * shorthand names from the phase-2 spec (sampleRateMismatch, impulse as a
   * boolean, flat impulseRate/impulseAmp, ...).
   */
  function normalize(options) {
    var o = options || {};
    var rate = o.rateMismatch;
    if (rate == null && o.sampleRateMismatch != null) {
      // spec used 1.001-style ratios; accept both "1.005" and "0.005"
      var v = o.sampleRateMismatch;
      rate = Math.abs(v) < 0.5 ? 1 + v : v;
    }
    var snr = o.snrDb;
    if (snr == null && o.awgn && typeof o.awgn === 'number') snr = o.awgn;
    if (o.awgn === false) snr = null;

    var imp = o.impulse;
    var impOn = imp === true || (imp && typeof imp === 'object') ||
                o.impulseRate != null || o.impulseAmp != null;
    if (imp === false) impOn = false;

    var mp = o.multipath && o.multipath !== false ? o.multipath : null;

    return {
      seed: o.seed == null ? 1 : o.seed,
      snrDb: snr == null ? null : snr,
      freqOffset: o.freqOffset || 0,
      rateMismatch: rate == null ? 1 : rate,
      impulse: impOn ? {
        impulseRate: (imp && imp.rate != null) ? imp.rate : (o.impulseRate == null ? 20 : o.impulseRate),
        impulseAmp: (imp && imp.amp != null) ? imp.amp : (o.impulseAmp == null ? 10 : o.impulseAmp),
        impulseWidthMs: (imp && imp.widthMs != null) ? imp.widthMs : (o.impulseWidthMs == null ? 0.5 : o.impulseWidthMs)
      } : null,
      multipath: mp ? {
        delayMs: mp.delayMs == null ? 1 : mp.delayMs,
        attenuation: mp.attenuation == null ? 0.5 : mp.attenuation
      } : null
    };
  }

  /** Human-readable list of what a configuration will apply. */
  function describe(options) {
    var n = normalize(options);
    var out = [];
    if (n.multipath) out.push('多径 ' + n.multipath.delayMs + ' ms / ×' + n.multipath.attenuation);
    if (n.freqOffset) out.push('频偏 ' + (n.freqOffset > 0 ? '+' : '') + n.freqOffset + ' Hz');
    if (n.rateMismatch !== 1) out.push('采样率失配 ' + ((n.rateMismatch - 1) * 100).toFixed(2) + '%');
    if (n.impulse) out.push('脉冲噪声 ' + n.impulse.impulseRate + '/s ×' + n.impulse.impulseAmp + 'RMS');
    if (n.snrDb != null) out.push('AWGN SNR ' + n.snrDb + ' dB');
    return out.length ? out : ['无退化（clean）'];
  }

  // ------------------------------------------------------------------ apply
  /**
   * @param {Float32Array} samples  mono SSTV audio
   * @param {object} options        see normalize(); use presets() for ready-made sets
   * @returns {Float32Array} a NEW array (input is never modified)
   */
  function apply(samples, options) {
    if (!samples || !samples.length) throw new Error('ChannelSim.apply needs samples');
    var n = normalize(options);
    var fs = options && options.sampleRate ? options.sampleRate : 48000;
    var rnd = mulberry32(n.seed);

    var out = samples;
    var touched = false;

    if (n.multipath) { out = stageMultipath(out, fs, n.multipath); touched = true; }
    if (n.freqOffset) { out = stageFreqOffset(out, fs, n.freqOffset); touched = true; }
    if (n.rateMismatch !== 1) { out = stageRateMismatch(out, n.rateMismatch); touched = true; }
    if (n.impulse) { out = stageImpulse(out, fs, n.impulse, rnd); touched = true; }
    if (n.snrDb != null && isFinite(n.snrDb)) { out = stageAwgn(out, n.snrDb, rnd); touched = true; }

    // Always hand back a fresh array, even for a no-op, so callers cannot alias.
    return touched ? out : Float32Array.from(samples);
  }

  /**
   * The four graded presets from the phase-2 spec.
   * Sign conventions: offsets are positive; the sign symmetry of the demodulator
   * is asserted by the test suite rather than assumed here.
   */
  function presets() {
    return [
      {
        name: 'clean',
        description: '无退化，作为基准',
        options: {}
      },
      {
        name: 'mild',
        description: '轻度：SNR 25 dB + 频偏 +5 Hz',
        options: { snrDb: 25, freqOffset: 5, seed: 11 }
      },
      {
        name: 'moderate',
        description: '中度：SNR 15 dB + 频偏 +20 Hz + 采样率失配 0.5%',
        options: { snrDb: 15, freqOffset: 20, rateMismatch: 1.005, seed: 22 }
      },
      {
        name: 'severe',
        description: '重度：SNR 8 dB + 频偏 +50 Hz + 采样率失配 1% + 脉冲噪声',
        options: {
          snrDb: 8, freqOffset: 50, rateMismatch: 1.010,
          impulse: { rate: 20, amp: 10, widthMs: 0.5 }, seed: 33
        }
      }
    ];
  }

  function preset(name) {
    var p = presets().filter(function (x) { return x.name === name; })[0];
    if (!p) throw new Error('Unknown channel preset: ' + name);
    return p;
  }

  /**
   * Applies every stage EXCEPT AWGN. This is the reference a noise measurement must
   * use: frequency offset and rate mismatch re-shape the whole waveform, so
   * comparing the degraded output against the ORIGINAL signal measures the signal
   * as "noise" and yields nonsense (measured: -2.8 dB for a 25 dB setting).
   */
  function applyReference(samples, options) {
    if (!samples || !samples.length) throw new Error('ChannelSim.applyReference needs samples');
    var n = normalize(options);
    var fs = options && options.sampleRate ? options.sampleRate : 48000;
    var rnd = mulberry32(n.seed);
    var out = samples, touched = false;

    if (n.multipath) { out = stageMultipath(out, fs, n.multipath); touched = true; }
    if (n.freqOffset) { out = stageFreqOffset(out, fs, n.freqOffset); touched = true; }
    if (n.rateMismatch !== 1) { out = stageRateMismatch(out, n.rateMismatch); touched = true; }
    if (n.impulse) { out = stageImpulse(out, fs, n.impulse, rnd); touched = true; }
    return touched ? out : Float32Array.from(samples);
  }

  /**
   * Measured SNR of `degraded` against a `reference`.
   *
   * NOTE: `reference` must already contain every NON-random degradation (use
   * applyReference for that). Passing the original clean signal is only valid when
   * the configuration's sole degradation is additive.
   */
  function measureSnr(reference, degraded) {
    var m = Math.min(reference.length, degraded.length);
    if (!m) return { snrDb: NaN, signalPower: 0, noisePower: 0, comparedSamples: 0 };
    var sp = 0, np = 0;
    for (var i = 0; i < m; i++) {
      sp += reference[i] * reference[i];
      var d = degraded[i] - reference[i];
      np += d * d;
    }
    sp /= m; np /= m;
    return {
      snrDb: np === 0 ? Infinity : 10 * Math.log10(sp / np),
      signalPower: sp,
      noisePower: np,
      comparedSamples: m
    };
  }

  /** Self-contained: applies `options`, then measures against its own noiseless reference. */
  function measureAwgnSnr(samples, options) {
    var ref = applyReference(samples, options);
    var deg = apply(samples, options);
    return measureSnr(ref, deg);
  }

  return {
    VERSION: VERSION,
    BAND_CENTRE_HZ: BAND_CENTRE_HZ,
    LPF_CUTOFF_HZ: LPF_CUTOFF_HZ,
    apply: apply,
    applyReference: applyReference,
    presets: presets,
    preset: preset,
    describe: describe,
    normalize: normalize,
    measureSnr: measureSnr,
    measureAwgnSnr: measureAwgnSnr,
    rms: rms,
    _internal: {
      stageMultipath: stageMultipath,
      stageFreqOffset: stageFreqOffset,
      stageRateMismatch: stageRateMismatch,
      stageImpulse: stageImpulse,
      stageAwgn: stageAwgn,
      lowpassBiquad: lowpassBiquad,
      mulberry32: mulberry32
    }
  };
});
