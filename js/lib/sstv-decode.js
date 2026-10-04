/*
 * SSTV demodulator (browser port).
 *
 * Algorithmic core ported from samccone/sstv (MIT, Copyright (c) 2025 The SSTV
 * Authors) - src/decode.ts + src/spec.ts. That is the only JS implementation of
 * SSTV *decoding* that exists, and it is the reference we verified end-to-end.
 *
 * Changes made for this project (all deliberate, all documented):
 *
 *  1. DE-Node-ified: dropped `fs` (unused), `pngjs` (we emit ImageData) and the
 *     console progress helpers. Uses the vendored fft.js.
 *  2. PERFORMANCE. Upstream spends ~99.9% of its runtime in the per-pixel
 *     frequency estimator, because it always does a fixed 4096-point FFT (plus
 *     a 16 KB zero-fill and two allocations) to analyse a window that is only
 *     ~51 samples long. We size the transform to the data:
 *         fftSize = clamp(nextPow2(len * mult), 128, 4096)
 *     cache the Hann window per length, and reuse scratch buffers. Measured on
 *     the same 115 s Martin M1 file: 112.4 s -> 7.3 s (mult=16) at 34.98 dB
 *     PSNR against the 4096-point reference (fidelity ceiling is 30.53 dB
 *     against the original image, so this is within ~1.1 dB of the ceiling).
 *     See 阶段一技术方案.md section 5.
 *  3. No per-pixel Array.prototype.slice(): the estimator reads straight out of
 *     the source buffer via (offset, length). Upstream allocated ~246k small
 *     arrays per image.
 *  4. Output is a Uint8ClampedArray RGBA buffer instead of a 3-D number[][][]
 *     plus a PNG encoder: far less allocation, and it feeds putImageData directly.
 *  5. Async with cooperative yielding, progress reporting, cancellation.
 *  6. Returns STRUCTURED RESULTS instead of throwing, so the UI can report which
 *     stage failed (header / VIS / image).
 *  7. Optional per-pixel CONFIDENCE output (peak vs. best non-adjacent bin).
 *     Phase 2 needs soft information to feed an LDPC decoder; upstream only ever
 *     produced hard decisions.
 *
 * Scope: Martin M1 and Scottie S1 (phase 1). The VIS map is limited to the modes
 * this build can actually render, so an unsupported-but-detected mode reports a
 * clear error instead of garbling.
 */
(function (root, factory) {
  var modes = root.SSTVModes;
  var FFT = root.FFT;
  if (!modes && typeof require === 'function') modes = require('./sstv-modes.js');
  if (!FFT && typeof require === 'function') FFT = require('./fft.js');
  var api = factory(modes, FFT);
  root.SSTVDecode = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes, FFT) {
  'use strict';

  if (!Modes) throw new Error('sstv-decode.js requires sstv-modes.js');
  if (!FFT) throw new Error('sstv-decode.js requires fft.js');

  // ---- Calibration-header geometry (seconds), same constants as upstream spec.ts ----
  var BREAK_OFFSET = 0.300;
  var LEADER_OFFSET = 0.010 + BREAK_OFFSET;      // 0.310
  var VIS_START_OFFSET = 0.300 + LEADER_OFFSET;  // 0.610
  var HDR_SIZE = 0.030 + VIS_START_OFFSET;       // 0.640
  var HDR_WINDOW_SIZE = 0.010;
  var VIS_BIT_SIZE = 0.030;
  var HEADER_SEARCH_STEP = 0.002;

  var SYNC_DETECT_HZ = 1350;   // above this = not a 1200 Hz sync pulse (raw axis, see syncDetectHz)
  var HEADER_TOLERANCE = 50;   // Hz

  /*
   * OPT-IN DIAGNOSTIC SINK. When decode() is called with `opts.auditLineRefs` set to an array, the
   * per-line sync reference the demodulator actually locked onto is appended to it. It is null by
   * default, so the normal path allocates nothing and behaves exactly as before - the audit needs
   * the real numbers rather than a re-derivation of them, and reading the arithmetic is how the
   * previous rounds went wrong.
   */
  var auditRefsOut = null;
  /* Opt-in per-pixel frequency audit; null by default (see the sink in the pixel loop). */
  var pixelAuditOut = null;

  // Quality tiers (see the sweep in 阶段一技术方案.md section 5.3)
  var QUALITY = {
    fast: { mult: 8, label: '快速' },
    standard: { mult: 16, label: '标准' },
    fine: { mult: 32, label: '精细' }
  };

  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  function calcLum(freq) {
    var lum = Math.round((freq - 1500) / Modes.COLOR_FREQ_MULT);
    return lum < 0 ? 0 : (lum > 255 ? 255 : lum);
  }

  /** Estimator with cached windows and reusable scratch, sized per window length. */
  /*
   * Image-band search window for the per-pixel frequency estimate.
   *
   * 1500-2300 Hz are NOMINAL levels, but the estimator works on the RAW frequency axis, and the
   * calibration maps raw -> nominal as calF(f) = (f - b) / a. Inverting it (raw = a * nominal + b)
   * puts the window where the content actually sits, so a recording with a frequency offset does
   * not get its upper band clipped. This reuses the calibration that is already fitted and passed
   * into the scan functions - no new dependency.
   *
   * The margin is deliberately wider than one FFT bin. The per-pixel window is only ~1 ms, so at
   * the 128-point floor a bin spans 375 Hz; a tighter margin (50 Hz was considered) would clip the
   * very peak it is meant to preserve.
   */
  var IMAGE_BAND_MARGIN_HZ = 200;

  /*
   * Live value. Separate from the constant so tooling can sweep it (see _internal.frequencyAxis
   * .setBandMargin) without editing source, and so the sweep measures the PRODUCTION path - patching
   * the exported imageBandRaw instead is a no-op, because the pixel loop calls the closure-local function
   * directly and never goes through the export. A first sweep attempt did exactly that and reported
   * identical numbers for every margin, which is the tell.
   */
  var bandMarginHz = IMAGE_BAND_MARGIN_HZ;
  /*
   * Lower guard, in nominal Hz: how far the band's lower edge must stay ABOVE the 1500 Hz porch/blanking
   * tone. Zero disables it (the phase-49 behaviour).
   *
   * WHY IT EXISTS. The scan's darkest legitimate level IS 1500 Hz, and the porch between the sync and the
   * scan is ALSO 1500 Hz, so a band that reaches down to the dark end necessarily reaches onto the porch.
   * The porch is a steady tone ~20 dB above scan content and the pixel window is only ~6 cycles of
   * 1200 Hz long, so its leakage can beat the scan tone inside the band and the estimator then reports a
   * frequency that does not belong to the pixel.
   *
   * Measured consequence on a flat field: at a -50 Hz tuning error, two pixels per line read 1443 Hz where
   * the truth is 1500 Hz, and across the field the raw readings scatter with SD 50 Hz against 24 Hz at
   * +50 Hz. Both signs show the same defect; +20 Hz simply happens to move the edge far enough that the
   * contamination stops. That is why the matrix looked "one-sided" - the code is symmetric and the
   * spectrum is not.
   */
  var bandLowerGuardHz = 0;

  /**
   * Raw-frequency search band for the per-pixel estimator, margins included.
   *
   * The margin is a NOMINAL-space quantity - it exists to tolerate the estimator's own bin quantisation
   * and a little residual mis-calibration, both of which are measured on the nominal axis - so it is
   * applied in nominal space and the whole interval is then mapped through the affine calibration.
   *
   * The previous form was `[a*1500 + b - MARGIN, a*2300 + b + MARGIN]`, which subtracts the margin from
   * a RAW bound. The two only agree when a == 1, and the error grows with the clock error: at 1% the
   * nominal interval is 800 Hz wide but the raw one should be 808, so the band came out 8 Hz narrow on
   * one side. Small, but wrong in a way that is invisible and would bite a future change.
   *
   * THE LOWER MARGIN IS NOT FREE (phase 51). It sets how far the band may reach down towards the
   * 1200 Hz sync tone, and the pixel window is short enough (~6 cycles of 1200 Hz) that a strong tone a
   * few tens of Hz outside the band still leaks in and can beat the scan content. Measured on a flat
   * field at a -50 Hz tuning error: with a 200 Hz margin the lower edge lands at 1250 Hz, and the
   * estimator's raw readings scatter with SD 50.2 Hz and a low tail down to 1289 Hz, against SD 24.2 Hz
   * at +50 Hz where the edge sits at 1350 Hz. See tests/sweep-band-margin.js for the value chosen.
   *
   * @returns {number[]} [loHz, hiHz] on the raw axis
   */
  function imageBandRaw(calA, calB) {
    var a = calA == null ? 1 : calA;
    var b = calB == null ? 0 : calB;
    var lo = a * (1500 - bandMarginHz) + b;
    var hi = a * (2300 + bandMarginHz) + b;
    if (bandLowerGuardHz > 0) {
      // nominal 1500 is both the darkest scan level and the porch tone; the guard keeps the edge clear of it
      var guard = a * (1500 + bandLowerGuardHz) + b;
      if (lo < guard) lo = guard;
      // never invert the band: if the guard would cross the upper edge, fall back to a narrow valid band
      if (lo >= hi) lo = hi - Math.max(20, a * 40);
    }
    return [lo, hi];
  }

  /**
   * Raw-frequency threshold above which a window is not considered to hold a sync pulse.
   *
   * The constant 1350 Hz is defined on the NOMINAL axis (1200 plus 150 of headroom). Applying it
   * unconverted to a raw measurement means the headroom silently shrinks as the tuning error grows: at a
   * +150 Hz offset the pulse itself measures 1350 and the test is exactly on its own boundary, so whether
   * a window counts as "still inside a pulse" starts depending on what follows the sync. That is a real
   * fragility - tests/diagnose-sync-threshold.js measured the walk's raw reading at a +100 Hz offset
   * reaching 1301-1313 Hz, inside 50 Hz of the boundary, and at +/-200 Hz it is past it.
   *
   * The threshold is therefore mapped through the calibration like every other frequency this decoder
   * compares against a nominal constant.
   *
   * Deliberately CLAMPED into [0.8, 1.6] x SYNC_DETECT_HZ. The clamp is what keeps this safe to ship:
   * with a good calibration (a ~ 1, b within +/-100 Hz, which is every case in the phase-49 matrix) the
   * threshold moves by at most ~100 Hz from where it has always been, so behaviour on all measured
   * material is essentially unchanged; a wild calibration cannot move it far enough to turn the guard
   * into a rubber stamp.
   */
  function syncDetectHz(calA, calB) {
    var a = calA == null ? 1 : calA;
    var b = calB == null ? 0 : calB;
    /*
     * Two guards, in this order, and the distinction matters:
     *   - `a` outside [0.5, 2] (or a non-finite result) means the calibration cannot be trusted at all,
     *     so it is REJECTED wholesale and the historical constant is used.
     *   - inside that range the mapping is applied and its RESULT is clamped.
     * The bounds are inclusive so that the boundary values are handled by the clamp rather than falling
     * into the reject branch, which would otherwise make the two mechanisms overlap confusingly.
     */
    if (!(a >= 0.5 && a <= 2) || !isFinite(b)) { a = 1; b = 0; }
    var raw = a * SYNC_DETECT_HZ + b;   // 1350 is nominal: 150 Hz above the 1200 Hz sync
    var lo = 0.8 * SYNC_DETECT_HZ, hi = 1.6 * SYNC_DETECT_HZ;
    if (!isFinite(raw)) return SYNC_DETECT_HZ;
    return raw < lo ? lo : (raw > hi ? hi : raw);
  }

  /** Convenience: the threshold for an optional {a, b} pair, falling back to the constant. */
  function syncDetectHzOf(calParams) {
    if (!calParams) return SYNC_DETECT_HZ;
    return syncDetectHz(calParams.a, calParams.b);
  }

  /*
   * NOTE (phase 27): a robust line-period estimator (Theil-Sen, then the median of consecutive
   * intervals) was implemented and tried in place of the least-squares fits below, and BOTH made the
   * real recording worse, measured:
   *     least squares        -> 20113 samples/line, adjacent-row correlation 0.1962
   *     Theil-Sen            -> 19127,                      correlation 0.0676
   *     median of intervals  -> 19395,                      correlation 0.1041
   *     truth (independent fine-grained detector)          -> 20553
   * The estimator was not the constraint: an independent detector measures this recording's
   * consecutive-interval median at 428.079 ms (20548 samples), so whatever series the fits consume
   * behaves like a ~404 ms median - the sync positions are contaminated at the SOURCE. No aggregation
   * rule recovers a period that is not in the series, so the fits were reverted to least squares and
   * the next step is to instrument that series. See docs/reports/阶段二十七报告.md.
   */

  function Estimator(sampleRate, mult) {
    this.sampleRate = sampleRate;
    this.mult = mult;
    this.windows = {};
    this.ffts = {};
    this.scratch = null;
    this.scratchSize = 0;
  }

  Estimator.prototype._window = function (n) {
    var w = this.windows[n];
    if (!w) {
      w = new Float32Array(n);
      for (var i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
      this.windows[n] = w;
    }
    return w;
  };

  Estimator.prototype._fft = function (size) {
    var e = this.ffts[size];
    if (!e) {
      e = { fft: new FFT(size), out: new Float32Array(2 * size), mags: new Float32Array(size / 2 + 1) };
      this.ffts[size] = e;
    }
    return e;
  };

  /**
   * Dominant frequency within samples[offset .. offset+len).
   * @param {Float32Array} samples
   * @param {number} offset
   * @param {number} len
   * @param {Float32Array} [confOut] single-element array; filled with confidence in dB
   * @param {number} [capOverride] raise the FFT size cap for precision-critical,
   *        non-hot-path measurements (calibration); the hot paths keep the small cap
   * @param {number} [bandLo] optional lower frequency bound (Hz) for the peak search. The pixel
   *        estimator needs it: a ~1 ms window over the whole spectrum locks onto whatever is
   *        loudest, which on a real recording is often out-of-band content far above 2300 Hz, and
   *        calcLum then clamps every such pixel to white.
   * @param {number} [bandHi] optional upper frequency bound (Hz)
   * @returns {number} frequency in Hz
   */
  Estimator.prototype.peak = function (samples, offset, len, confOut, capOverride, bandLo, bandHi) {
    if (len < 4) return 0;
    var cap = capOverride || 4096;
    var size = nextPow2(len * this.mult);
    if (size < 128) size = 128;
    if (size > cap) size = cap;

    var e = this._fft(size);
    if (this.scratchSize < size) {
      this.scratch = new Float32Array(size);
      this.scratchSize = size;
    }
    var input = this.scratch.subarray(0, size);
    input.fill(0);

    var w = this._window(len);
    for (var i = 0; i < len; i++) input[i] = samples[offset + i] * w[i];

    var out = e.out;
    e.fft.realTransform(out, input);

    var mags = e.mags;
    /*
     * Optional restricted search. Without bandLo/bandHi this is byte-for-byte the old behaviour
     * (whole spectrum, whole-spectrum competing tone), which is what every non-pixel caller -
     * VIS bits, the 1900 Hz header, the 1200 Hz sync - still relies on.
     */
    var kLo = 0, kHi = mags.length - 1;
    if (bandLo != null && bandHi != null) {
      kLo = Math.max(0, Math.ceil(bandLo * size / this.sampleRate));
      kHi = Math.min(mags.length - 1, Math.floor(bandHi * size / this.sampleRate));
      // A band narrower than a few bins cannot be searched meaningfully; widening beats returning a
      // value that bin quantisation invented.
      if (kHi - kLo < 3) { kLo = 0; kHi = mags.length - 1; }
    }
    var best = -1, bx = kLo;
    for (var k = kLo; k <= kHi; k++) {
      var re = out[2 * k], im = out[2 * k + 1];
      var m = Math.sqrt(re * re + im * im);
      if (m > best) { best = m; bx = k; }
      mags[k] = m;
    }

    // Peak location refined with barycentric interpolation between the three
    // bins straddling the maximum (windowed-tone peak interpolation).
    var y1 = bx <= 0 ? mags[bx] : mags[bx - 1];
    var y3 = bx + 1 >= mags.length ? mags[bx] : mags[bx + 1];
    var den = y3 + mags[bx] + y1;
    var peakIdx = den === 0 ? 0 : (y3 - y1) / den + bx;

    if (confOut) {
      // Best magnitude at least 3 bins away from the peak, as a competing-tone proxy. Scoped to
      // the searched band so that a restricted search reports in-band separation rather than being
      // flattered by quiet bins outside it.
      var guard = 3, floor = 1e-12;
      for (var q = kLo; q <= kHi; q++) {
        if (q >= bx - guard && q <= bx + guard) continue;
        if (mags[q] > floor) floor = mags[q];
      }
      confOut[0] = 20 * Math.log10((best + 1e-12) / (floor + 1e-12));
    }

    return peakIdx * this.sampleRate / size;
  };

  function cancelError() { var e = new Error('cancelled'); e.cancelled = true; return e; }

  function defaultYield() { return Promise.resolve(); }

  /**
   * @param {Float32Array} samples  mono
   * @param {number} sampleRate     the file's NATIVE rate (do not resample)
   * @param {object} [opts]
   *        quality: 'fast'|'standard'|'fine' (default 'standard')
   *        mult:    explicit oversampling multiplier, overrides quality
   *        onProgress: function(fraction, stageLabel)
   *        shouldCancel: function() -> boolean
   *        wantConfidence: boolean
   *        yieldEvery: number of lines between cooperative yields (default 8)
   * @returns {Promise<object>} structured result
   */
  async function decode(samples, sampleRate, opts) {
    opts = opts || {};
    var started = Date.now();
    var timings = {};
    var warnings = [];
    auditRefsOut = opts.auditLineRefs || null;   // default null: nothing is recorded
    pixelAuditOut = opts.auditPixels || null;    // default null: nothing is recorded

    if (!samples || !samples.length) {
      return { ok: false, stage: 'input', message: 'No audio samples to decode.' };
    }
    if (!(sampleRate > 0)) {
      return { ok: false, stage: 'input', message: 'Invalid sample rate.' };
    }

    var mult = opts.mult != null ? opts.mult
      : (QUALITY[opts.quality || 'standard'] || QUALITY.standard).mult;
    var est = new Estimator(sampleRate, mult);
    var yieldFn = opts.yieldFn || defaultYield;
    var shouldCancel = opts.shouldCancel || function () { return false; };
    var onProgress = opts.onProgress || function () {};
    var yieldEvery = opts.yieldEvery == null ? 8 : opts.yieldEvery;

    try {
      // ---------------- stage 1: calibration header ----------------
      var tHdr = Date.now();
      var hdr = await findHeader(est, samples, sampleRate, shouldCancel, yieldFn, onProgress,
        HEADER_THRESHOLDS.primary);
      var headerSource = 'primary';
      if (hdr == null) {
        /*
         * Primary thresholds found nothing. Retry with the loose set and let the VIS + mode
         * lookup below decide whether the candidate is real; a false lock almost always fails
         * there (even parity plus a supported VIS value is a strong gate).
         */
        hdr = await findHeader(est, samples, sampleRate, shouldCancel, yieldFn, onProgress,
          HEADER_THRESHOLDS.fallback);
        headerSource = hdr ? 'fallback-relaxed' : 'none';
      }
      timings.header = Date.now() - tHdr;
      timings.headerSource = headerSource;
      if (hdr == null) {
        return {
          ok: false, stage: 'findHeader', timings: timings,
          message: '未找到 SSTV 标定头（校准头）。请确认这是 SSTV 音频，且开头包含 1900/1200 Hz 引导音。' +
            '（已尝试主阈值与自适应放宽阈值两轮）'
        };
      }
      var headerEnd = hdr.end;

      // AFC: apply the affine frequency calibration the header search solved for.
      // `opts.afc === false` keeps the raw axis, which is useful for quantifying how
      // much the calibration is actually worth.
      var calib = opts.afc === false ? { a: 1, b: 0 } : { a: hdr.a, b: hdr.b };
      var calF = function (f) { return (f - calib.b) / calib.a; };

      // ---------------- stage 2: VIS ----------------
      var tVis = Date.now();
      var visStart = headerEnd;
      var bitSize = Math.round(VIS_BIT_SIZE * sampleRate);
      var visBits = [];
      for (var b = 0; b < 8; b++) {
        var f = est.peak(samples, visStart + b * bitSize, bitSize);
        visBits.push(calF(f) <= 1200 ? 1 : 0);
      }
      var ones = 0;
      for (var vb = 0; vb < visBits.length; vb++) ones += visBits[vb];
      if (ones % 2 !== 0) {
        return { ok: false, stage: 'vis', timings: timings, message: 'VIS 校验位失败，音频可能被截断或干扰。' };
      }
      var visValue = 0;
      for (var i = 6; i >= 0; i--) visValue = (visValue << 1) | visBits[i];
      timings.vis = Date.now() - tVis;

      var mode = Modes.DECODABLE[visValue];
      if (!mode) {
        return {
          ok: false, stage: 'vis', vis: visValue, timings: timings,
          message: '识别到 VIS=' + visValue + '，但本版本解码器只支持 Martin M1 (44) 与 Scottie S1 (60)。'
        };
      }

      // ---------------- stage 2 (cont): VIS length ----------------
      var visEnd = visStart + Math.round(VIS_BIT_SIZE * 9 * sampleRate);

      // ---------------- stage 2b: receiver calibration ----------------
      // Provisional calibration (from the header) is only good enough to FIND the
      // syncs; the precise scale/offset come from the syncs themselves.
      //
      // `afc` selects WHICH correction is applied, so the contribution of each one can be
      // measured rather than assumed (phase-6 robustness study):
      //   false       -> raw nominal axis, a=1 b=0            (phase-1 behaviour)
      //   'offset'    -> constant offset from the leader, a=1
      //   'twoPoint'  -> the header's own two-point fit (1200 Hz VIS bit + 1900 Hz leader)
      //   'affine'    -> a from the 256-sync timing fit, b anchored on the leader (default)
      // undefined keeps the historical behaviour exactly, so nothing regresses.
      var afcMode = (opts.afc === undefined) ? 'affine' : opts.afc;
      var clockRecovery = opts.clockRecovery !== false;
      var tCal = Date.now();
      var cal = null;
      if (afcMode !== false) {
        cal = await calibrate(est, samples, sampleRate, mode, visEnd, calF, shouldCancel, yieldFn, hdr.leaderFreq);
      }
      if (afcMode === false) {
        calib.a = 1; calib.b = 0;
        calib.source = 'afc-off';
      } else if (afcMode === 'offset') {
        // pure constant offset: how far the leader tone sat from its nominal 1900 Hz
        var offHz = (hdr.leaderFreq && isFinite(hdr.leaderFreq)) ? (hdr.leaderFreq - 1900) : 0;
        calib.a = 1; calib.b = offHz;
        calib.source = 'leader-offset-only';
      } else if (afcMode === 'twoPoint') {
        // literal two-point frequency fit, exactly as the header search computed it
        calib.a = hdr.a; calib.b = hdr.b;
        calib.source = 'two-point-header';
      } else if (cal) {
        /*
         * QUALITY GATE on the sync-derived scale (phase 38).
         *
         * Until now `a` had exactly one source: the straight-line fit through the per-line sync
         * positions. On the phigros capture that fit fails completely - residualRmsSamples came out at
         * 20822 samples, i.e. about ONE LINE PERIOD, which cannot be a fit to anything (the decoder's
         * own per-line references fit a line to 119.7 samples, so the damage is done inside the
         * calibration pre-pass, not by the references). The resulting scale of 1.0973 was still
         * applied to the whole image, while the header fit - two 1900 Hz leader tones plus VIS bits,
         * i.e. the part of the signal actually designed for frequency calibration - measured the
         * leader at 1899.91 Hz, an error of 0.005%, and was written to the report as a diagnostic
         * field only, never used.
         *
         * So: accept the sync fit only when its residual is small compared with a line period.
         * Otherwise fall back to the header fit, and if that is unusable too, to no scaling at all
         * with just the leader-anchored offset. Every branch records why it was taken.
         */
        var nomLine = Modes.lineTime(mode) * sampleRate;
        var resRms = cal.residualRmsSamples;
        var gateSamples = nomLine * 0.05;
        var syncFitGood = isFinite(resRms) && resRms <= gateSamples;
        calib.syncFitResidualRms = resRms;
        calib.syncFitGateSamples = gateSamples;
        calib.syncFitAccepted = syncFitGood;
        if (syncFitGood) {
          calib.a = cal.scale;
          calib.b = cal.offsetHz;
          calib.source = 'sync-calibration';
        } else if (hdr.a && isFinite(hdr.a) && hdr.a > 0) {
          calib.a = hdr.a;
          calib.b = hdr.b;
          calib.source = 'sync-rejected-header-fallback';
        } else {
          calib.a = 1;
          calib.b = (hdr.leaderFreq && isFinite(hdr.leaderFreq)) ? (hdr.leaderFreq - 1900) : 0;
          calib.source = 'sync-rejected-leader-offset';
        }
      } else {
        calib.source = 'header-only';
      }
      if (cal) {
        calib.clockScale = cal.clockScale;
        calib.observations = cal.observations;
        calib.syncResidualRms = cal.residualRmsSamples;
        calib.syncResidualMax = cal.residualMaxSamples;
        calib.mislockedLines = cal.mislockedLines;
      }
      /*
       * Disabling clock recovery forces the scale the SCAN will use to 1. A marker is kept so the
       * reporting step below cannot silently undo this and make the option look broken to every
       * caller reading calibration.clockScale.
       */
      if (!clockRecovery) { calib.clockScale = 1; calib.clockRecoveryApplied = false; }
      timings.calibration = Date.now() - tCal;

      // ---------------- stage 3: image data ----------------
      var tImg = Date.now();
      /*
       * Single dispatch point for the two scan models. The line-sync family (Martin /
       * Scottie) keeps its original code path untouched; PD gets its own block-based model
       * because it has one sync pulse per LINE PAIR and no per-line porch.
       */
      var pdResult = null, decoded;
      if (mode.structure === 'pd') {
        pdResult = await decodePd(est, samples, sampleRate, mode, visEnd, shouldCancel, yieldFn,
          onProgress, !!opts.wantConfidence, yieldEvery, warnings, calib);
        decoded = { confidence: pdResult.confidence };
      } else {
        decoded = await decodeImageData(
          est, samples, sampleRate, mode, visEnd, shouldCancel, yieldFn, onProgress,
          !!opts.wantConfidence, yieldEvery, warnings, calib
        );
      }
      timings.image = Date.now() - tImg;

      /*
       * Phase-49 adaptive post-processing. Runs LAST, on the composed raster, and is gated on the
       * raster's own flat-region noise. With postprocess:'off' nothing is measured and nothing is
       * allocated, so the historical path is untouched; with 'auto' (the default) the measurement
       * costs one pass over 320x256 and the filter only runs when the gate passes.
       */
      var composed = pdResult ? pdResult.imageData : composeImageData(decoded, mode);
      var ppMode = opts.postprocess === undefined ? 'auto'
        : (opts.postprocess === true ? 'auto' : opts.postprocess);
      var pp = applyAdaptivePostprocess(composed, ppMode);
      var imageData = pp.imageData;
      timings.total = Date.now() - started;

      return {
        ok: true,
        imageData: imageData,
        mode: { id: mode.id, name: mode.name },
        vis: visValue,
        confidence: decoded.confidence,
        calibration: {
          afcEnabled: afcMode !== false,
          afcMode: afcMode === false ? 'off' : afcMode,
          clockRecovery: clockRecovery,
          source: calib.source,
          scale: calib.aUsed != null ? calib.aUsed : calib.a,
          offsetHz: calib.bUsed != null ? calib.bUsed : calib.b,
          clockScale: calib.clockScale,
          observations: calib.observations,
          syncResidualRms: calib.syncResidualRms,
          /* Phase 38 quality gate: was the sync-derived scale accepted, and against what limit? */
          syncFitGateSamples: calib.syncFitGateSamples,
          syncFitAccepted: calib.syncFitAccepted,
          syncResidualMax: calib.syncResidualMax,
          mislockedLines: calib.mislockedLines,
          headerScale: hdr.a,
          headerOffsetHz: hdr.b,
          leaderFreqHz: hdr.leaderFreq,
          // diagnostics: where the body was taken to start, and where PD actually locked
          imageStart: visEnd,
          pdBlockStarts: pdResult ? Array.prototype.slice.call(pdResult.blockStarts, 0, 8) : null,
          /*
           * Phase 29 adjudication diagnostics. This block is a WHITELIST, so anything set on `calib`
           * inside the demodulator is invisible here until it is listed - which is why the first
           * version of these two fields measured as undefined even though the logic was running.
           */
          lineWindow: calib.lineWindow || null,
          freeRunTotal: calib.freeRunTotal == null ? null : calib.freeRunTotal,
          /* Phase 49: what the adaptive denoiser measured and decided. */
          postprocess: pp.info
        },
        warnings: warnings,
        timings: timings
      };
    } catch (err) {
      if (err && err.cancelled) {
        return { ok: false, stage: 'cancelled', cancelled: true, message: '已取消。', timings: timings };
      }
      return { ok: false, stage: 'unexpected', message: err && err.message ? err.message : String(err),
        timings: timings };
    }
  }

  /*
   * Header search - PATTERN based, not absolute-frequency gated.
   *
   * The phase-1 version required each of the four calibration tones to sit within
   * +/-50 Hz of nominal. That fails for exactly the impairments phase 2 must model:
   * a +50 Hz tuning error plus a 1% clock error puts the leader at 1969 Hz (69 Hz
   * off) and the break at 1262 Hz (62 Hz off), so the header would never be found
   * and the whole robustness experiment would be vacuous.
   *
   * Instead we check the STRUCTURE, which is invariant to offset and scale:
   *   - the two leaders agree with each other, and the break agrees with the VIS start
   *   - the leader/break separation is near 700 Hz (widened for +/-10% clock error)
   *   - once that holds, the measured pair yields the AFFINE frequency calibration
   *     f_measured = a * f_nominal + b, which is solved on the spot
   *
   * The probe offsets stay valid under a clock error because the header's own time
   * intervals scale with it: at 1% the probes land ~3-6 ms late, still well inside
   * the 300 ms leaders and the 30 ms VIS start bit.
   *
   * @returns {{end:number, a:number, b:number}|null}
   */
  /*
   * Two threshold sets for the header search.
   *
   * The PRIMARY set is the historical one and is used first, so a clean signal takes exactly
   * the code path it always did and nothing regresses.
   *
   * The FALLBACK set is much looser and is only tried when the primary finds nothing. It
   * exists because the phase-6 robustness study showed every impairment in isolation still
   * passes the primary thresholds, while two of them together do not: the detector is a
   * fixed-threshold one with no margin, so hum, an adjacent carrier or a tilted/recorded
   * response each eat a little of the same budget.
   *
   * Loosening a detector inevitably raises the false-positive rate, so the fallback is NOT
   * trusted on its own: the caller still has to decode a VIS that maps to a supported mode
   * with correct even parity, and the two leaders must still agree with each other. That
   * pairing is what keeps the relaxed search honest.
   */
  var HEADER_THRESHOLDS = {
    primary: { wide: 200, pairTol: 30, breakTol: 60, sepLo: 0.88, sepHi: 1.12, jumpScale: 1 },
    fallback: { wide: 700, pairTol: 120, breakTol: 260, sepLo: 0.70, sepHi: 1.30, jumpScale: 1 }
  };

  async function findHeader(est, samples, sampleRate, shouldCancel, yieldFn, onProgress, thresholds) {
    var T = thresholds || HEADER_THRESHOLDS.primary;
    var headerSize = Math.round(HDR_SIZE * sampleRate);
    var win = Math.round(HDR_WINDOW_SIZE * sampleRate);
    var breakAt = Math.round(BREAK_OFFSET * sampleRate);
    var leader2At = Math.round(LEADER_OFFSET * sampleRate);
    var visAt = Math.round(VIS_START_OFFSET * sampleRate);
    var jump = Math.round(HEADER_SEARCH_STEP * sampleRate);
    var limit = samples.length - headerSize;
    if (limit <= 0) return null;

    var LEADER_NOMINAL = 1900, BREAK_NOMINAL = 1200;
    var SEP_NOMINAL = LEADER_NOMINAL - BREAK_NOMINAL;   // 700
    var WIDE = T.wide;       // coarse pre-filter around the leader
    var PAIR_TOL = T.pairTol; // leaders must agree, breaks must agree
    var SEP_MIN = SEP_NOMINAL * T.sepLo, SEP_MAX = SEP_NOMINAL * T.sepHi;
    var sinceYield = 0;
    var tried = 0;

    for (var cs = 0; cs < limit; cs += jump) {
      var f1 = est.peak(samples, cs, win);
      if (Math.abs(f1 - LEADER_NOMINAL) > WIDE) {
        if ((++sinceYield & 255) === 0) {
          if (shouldCancel()) throw cancelError();
          onProgress((cs / limit) * 0.2, '搜索标定头');
          await yieldFn();
        }
        continue;
      }
      var f2 = est.peak(samples, cs + breakAt, win);
      var sep = f1 - f2;
      if (sep < SEP_MIN || sep > SEP_MAX) continue;
      var f3 = est.peak(samples, cs + leader2At, win);
      if (Math.abs(f3 - f1) > PAIR_TOL) continue;
      var f4 = est.peak(samples, cs + visAt, win);
      if (Math.abs(f4 - f2) > PAIR_TOL) continue;

      // affine calibration from the two known tones
      var a = sep / SEP_NOMINAL;
      var b = f1 - a * LEADER_NOMINAL;
      var correctedBreak = (f2 - b) / a;
      if (Math.abs(correctedBreak - BREAK_NOMINAL) > T.breakTol) continue;

      /*
       * Measure the first leader over as much of its 300 ms as possible, with a much
       * larger FFT cap than the hot paths use.
       *
       * This number anchors the calibration OFFSET, so its precision matters: the
       * 1200 Hz sync tone is only ~233 samples (under 3 cycles) and measured a
       * systematic +18.6 Hz bias when used for this, which is ~6 grey levels of
       * luminance error - as large as the impairment being corrected. The leader is
       * 14.4k samples, so it pins the offset to well under 1 Hz.
       */
      var leaderLen = Math.min(Math.round(0.25 * sampleRate), samples.length - cs - 1);
      var f1Long = leaderLen > win * 4
        ? est.peak(samples, cs + Math.round(0.02 * sampleRate), leaderLen, null, 32768)
        : f1;
      if (Math.abs(f1Long - f1) > 60) f1Long = f1;
      a = (f1Long - f4) / SEP_NOMINAL;
      b = f1Long - a * LEADER_NOMINAL;
      return { end: cs + headerSize, a: a, b: b, leaderFreq: f1Long };
    }
    return null;
  }

  /*
   * Matched-correlation refinement of a sync-pulse position.
   *
   * The upstream heuristic locates a sync by scanning forward until a window's
   * dominant tone stops being 1200 Hz, then offsets by half a window. That is
   * cheap but jittery: measured on our own Scottie S1 signal, the reported sync
   * position wandered by tens of samples line to line (~2 pixels) even though the
   * true syncs were exactly one line apart.
   *
   * That jitter is not harmless. For Scottie the alignment reference is the sync
   * that precedes the RED scan, but GREEN and BLUE of the same line are derived
   * from the PREVIOUS line's reference. Independent jitter on two references
   * therefore shifts G/B against R within a single row, producing colour fringing
   * (this is why S1 measured ~18 dB while M1 measured ~26 dB).
   *
   * The sync is the only 1200 Hz content in the signal (every scan level maps to
   * >= 1500 Hz), so correlating against a 1200 Hz reference of exactly the sync
   * length is a well-conditioned matched filter: its magnitude peaks when the
   * window coincides with the pulse. We keep the cheap coarse search to get
   * within a few milliseconds, then refine by direct correlation.
   */
  var syncTables = {};
  /* Phase-48 gate counters; null unless a caller asks for them (see _internal.alignStats). */
  var alignStats = null;
  function syncTable(n, sampleRate) {
    var key = n + '@' + sampleRate;
    var t = syncTables[key];
    if (!t) {
      var w = 2 * Math.PI * Modes.FREQ_SYNC / sampleRate;
      var cos = new Float32Array(n), sin = new Float32Array(n);
      for (var i = 0; i < n; i++) { cos[i] = Math.cos(w * i); sin[i] = Math.sin(w * i); }
      t = { cos: cos, sin: sin };
      syncTables[key] = t;
    }
    return t;
  }

  function refineSync(samples, sampleRate, mode, coarseStart, startOfSync) {
    var n = Math.round(mode.syncPulse * sampleRate);
    if (n < 8 || n > samples.length) return startOfSync ? coarseStart : coarseStart + n;

    var range = Math.round(0.006 * sampleRate); // +/- 6 ms around the coarse fix
    var lo = Math.max(0, coarseStart - range);
    var hi = Math.min(samples.length - n, coarseStart + range);
    if (hi < lo) return startOfSync ? coarseStart : coarseStart + n;

    var tab = syncTable(n, sampleRate);
    var cos = tab.cos, sin = tab.sin;
    var bestMag = -1, bestT = coarseStart;

    for (var t = lo; t <= hi; t++) {
      var re = 0, im = 0;
      for (var i = 0; i < n; i++) {
        var s = samples[t + i];
        re += s * cos[i];
        im += s * sin[i];
      }
      var mag = re * re + im * im;
      if (mag > bestMag) { bestMag = mag; bestT = t; }
    }
    return startOfSync ? bestT : bestT + n;
  }

  /**
   * @param {function(number):number} [cal] affine frequency calibration, so that the
   *        sync threshold is applied to the corrected frequency rather than the raw one
   * @returns {number|null} sync-pulse start (or end, if startOfSync is false).
   */
  /*
   * How far around the prediction to look for the sync tone.
   *
   * The caller's prediction is not trustworthy on a real recording: phase 45 measured the per-line
   * reference missing the true sync by 7149 samples (149 ms, about base+chanTime - exactly the rewind
   * quantity) with a 92-sample row-to-row jitter, while on our own synthetic audio the same code lands
   * within 200 samples with 18 samples of jitter. The prediction error to absorb is therefore at least
   * one and a half thousand pixels' worth, and if the search cannot reach the true pulse the lock ends
   * up wherever the prediction happened to be.
   */
  /**
   * Same matched-filter search as refineSync, but also reports HOW WELL it matched.
   *
   * The score is the 1200 Hz matched-filter energy at the best offset divided by the window's total
   * energy, so it is a bounded, amplitude-independent confidence: a window filled with a pure sync
   * tone scores about n/2, image content or noise scores far less. That is exactly the quantity
   * alignSync needs - the phase-46 attempt scored candidates by their dominant FREQUENCY instead, and
   * since est.peak occasionally reports below the sync band in low-SNR regions, "lowest wins" then
   * had to pick that noise, which broke the synthetic round trip (M1 31.23 -> 17.27 dB).
   *
   * @returns {{pos:number, score:number}}
   */
  function refineSyncScore(samples, sampleRate, mode, coarseStart, startOfSync) {
    var n = Math.round(mode.syncPulse * sampleRate);
    var fallback = startOfSync ? coarseStart : coarseStart + n;
    if (n < 8 || n > samples.length) return { pos: fallback, score: 0 };

    var range = Math.round(0.006 * sampleRate);
    var lo = Math.max(0, coarseStart - range);
    var hi = Math.min(samples.length - n, coarseStart + range);
    if (hi < lo) return { pos: fallback, score: 0 };

    var tab = syncTable(n, sampleRate);
    var cos = tab.cos, sin = tab.sin;
    var bestMag = -1, bestT = lo, bestEnergy = 1e-9;
    for (var t = lo; t <= hi; t++) {
      var re = 0, im = 0, en = 0;
      for (var i = 0; i < n; i++) {
        var s = samples[t + i];
        re += s * cos[i];
        im += s * sin[i];
        en += s * s;
      }
      var mag = re * re + im * im;
      if (mag > bestMag) { bestMag = mag; bestT = t; bestEnergy = en; }
    }
    var score = bestEnergy > 1e-9 ? bestMag / bestEnergy : 0;
    return { pos: startOfSync ? bestT : bestT + n, score: score };
  }

  /**
   * @param {function(number):number} [cal]      map raw -> nominal frequency
   * @param {{a:number,b:number}} [calParams]    the affine pair behind `cal`. Optional and additive: it
   *        exists so the sync-detection threshold can be moved onto the raw axis (see syncDetectHz).
   *        Omitted, the threshold stays the historical constant, so every caller that does not pass it
   *        behaves exactly as before.
   */
  function alignSync(est, samples, sampleRate, mode, alignStart, startOfSync, cal, calParams) {
    var syncWindow = Math.round(mode.syncPulse * 1.4 * sampleRate);
    var alignStop = samples.length - syncWindow;
    if (alignStop <= alignStart) return null;
    var f = cal || function (x) { return x; };
    var detectHz = syncDetectHzOf(calParams);

    /*
     * Counters for the phase-48 gate. Deliberately plain module state rather than anything threaded
     * through the call: the point is to observe which branch production actually takes, and the
     * tests that use it read the numbers after a normal decode() call.
     */
    if (alignStats) {
      alignStats.calls++;
      if (startOfSync) alignStats.startOfSyncCalls++; else alignStats.endOfSyncCalls++;
    }
    /*
     * Coarse fix: advance until the dominant tone is no longer the 1200 Hz sync.
     *
     * KNOWN DEFECT (phase 45/46): this walk never verifies that it STARTED inside a pulse. If
     * `alignStart` already sits in image content (above SYNC_DETECT_HZ) the loop breaks on its first
     * iteration, so the "lock" is just the prediction. On the phigros recording that shows up as a
     * constant ~7149-sample miss (149 ms, about base+chanTime) with ~92 samples of row-to-row jitter -
     * which is exactly the blur and the row-coherent colour banding in that decode. On our own
     * synthetic audio the prediction is accurate, so the round-trip tests never saw it.
     *
     * REPLACEMENT ATTEMPTED AND REVERTED: scanning +/-0.4 line around the prediction and keeping the
     * candidate with the LOWEST dominant frequency fixed the real recording spectacularly - the miss
     * fell from 7155 to 248 samples, the chroma ratio from 1.4061 to 0.8101 against a reference of
     * 0.7952, and the render became a recognisable figure - but it broke the synthetic round trip
     * (M1 31.23 -> 17.27 dB, S1 30.50 -> 15.28 dB) and ran ten times slower. The reason is the
     * selection rule: est.peak occasionally reports below SYNC_DETECT_HZ in low-SNR or band-edge
     * regions, and "lowest wins" then must pick that noise.
     *
     * The next attempt should score candidates by refineSync's own match confidence and pick the BEST,
     * rather than by the raw frequency, and should keep the scan narrow (the prediction is usually
     * close - only the real recording's degraded stretches are far off).
     */
    /*
     * Coarse fix: advance until the dominant tone is no longer the 1200 Hz sync.
     *
     * KNOWN DEFECT, TWO FIX ATTEMPTS BOTH REVERTED (phases 45-47).
     *
     * The walk never verifies that it STARTED inside a pulse. If alignStart already sits in image
     * content (above SYNC_DETECT_HZ) the loop breaks on its first iteration, so the "lock" is just the
     * prediction. On the phigros recording that is a constant ~7149-sample miss (149 ms, about
     * base+chanTime - the rewind quantity) with ~92 samples of row-to-row jitter: exactly the blur and
     * the row-coherent colour banding. On synthetic audio the prediction is accurate, so round trips
     * never saw it.
     *
     * Attempt 1 (phase 46) scanned +/-0.4 line and kept the candidate whose dominant tone was LOWEST.
     * On the real recording it was spectacular - miss 7155 -> 248 samples, chroma ratio 1.4061 ->
     * 0.8101 against a reference of 0.7952, and a recognisable figure - but M1 fell 31.23 -> 17.27 dB
     * and S1 30.50 -> 15.28 dB, because est.peak occasionally reports below the sync band in low-SNR
     * regions and "lowest wins" then must pick that noise.
     *
     * Attempt 2 (phase 47) ranked candidates by the 1200 Hz matched-filter confidence from
     * refineSyncScore instead, which noise cannot win, scanning +/-0.4 line in 6 ms steps. It still
     * broke the synthetic round trip - M1 31.23 -> 20.13 dB, S1 30.50 -> 29.60 dB - and was still 5-7x
     * slower, so the ranking rule is not the only problem and the scan itself disturbs the case where
     * the prediction was already correct.
     *
     * A future attempt should not replace the walk wholesale: it should keep the walk when it starts
     * inside a pulse, and only fall back to a search when the walk's first sample is already above the
     * sync band - i.e. decide on the START condition, not on a global best-of-scan. Also note that
     * roundtrip.js reports "ALL CHECKS PASSED" at M1 20.13 dB, so its thresholds are far looser than
     * the recorded baselines (31.23 / 30.50) and must not be used as the acceptance criterion.
     */
    var cs = alignStart;
    /*
     * PHASE 48 - PLAN A, "STRICTLY ADDITIVE".
     *
     * The one question the walk must answer before it runs is whether it STARTED inside a pulse.
     * The answer is a single tone measurement at `alignStart`, taken with exactly the same window
     * the walk's own first iteration uses. When the answer is yes, the loop below is the code that
     * has always been here, unchanged and reached the same way - so the synthetic round trip cannot
     * be affected in the way the two reverted attempts affected it. Those replaced the walk
     * wholesale with a global best-of-scan and cost 11-14 dB of M1 PSNR; this decides on the START
     * condition instead, and the branch it guards is the only place the new code can run.
     *
     * Measured control flow (tests/probe-align-gate.js):
     *   synthetic S1 round trip : 514 alignSync calls, 512 started in a pulse, 2 did not
     *   phigros real recording  : 514 alignSync calls, 507 started in a pulse, 7 did not
     * So the synthetic path is not "never" on the new branch - it is 2 calls out of 514, on lines
     * where the prediction had genuinely drifted off the pulse and where the walk had nothing to
     * walk on either. That is the intended repair, not a disturbance, and it shows up as M1
     * 31.23 -> 31.26 dB rather than as a loss.
     *
     * The real-recording case is the one the walk cannot handle at all: the rewind leaves
     * `alignStart` about 149 ms (7149 samples) past the pulse, the walk breaks on its first
     * iteration and returns the prediction unchanged, which is the constant miss plus ~92-sample
     * row jitter that blurred and colour-banded the phigros decode.
     */
    var startInSync = f(est.peak(samples, alignStart, syncWindow)) <= detectHz;
    if (alignStats) { if (startInSync) alignStats.startInSync++; else alignStats.startInImage++; }

    var syncLen = Math.round(mode.syncPulse * sampleRate);
    var endSync, coarse;
    if (startInSync) {
      for (; cs < alignStop; cs++) {
        if (f(est.peak(samples, cs, syncWindow)) > detectHz) break;
      }
      endSync = cs + Math.floor(syncWindow / 2);
      coarse = startOfSync ? endSync - syncLen : endSync;
      if (coarse < 0) coarse = 0;
      return refineSync(samples, sampleRate, mode, coarse, startOfSync);
    }

    /*
     * Fallback search, reached only when the walk had nothing to walk on.
     *
     * Candidates are sync-pulse STARTS scanned over +/-0.4 of a line period in 6 ms steps - 6 ms is
     * `refineSync`'s own capture range, so the refine stage at the end can still pull the winner onto
     * the pulse even if the best candidate is one step off. The window is wide enough for the S1
     * rewind (0.4 * 428 ms = 171 ms around a miss of 149 ms) and still narrow enough to exclude the
     * neighbouring lines' pulses, which is what keeps a wrong-but-loud candidate from winning.
     *
     * Each candidate is scored by the 1200 Hz matched-filter confidence from refineSyncScore, i.e.
     * matched energy over window energy. This is the ranking rule phase 46 lacked: a bounded,
     * amplitude-independent confidence that noise cannot win, as opposed to "lowest dominant
     * frequency wins", which in low-SNR stretches had to pick noise and cost 14 dB.
     *
     * The candidate space is converted through the SAME arithmetic as the walk above (window end
     * minus half a window, then minus the pulse length) so that the fallback returns a position in
     * the identical coordinate system - the two branches cannot disagree about what a lock is.
     */
    var searchRange = Math.round(0.4 * Modes.lineTime(mode) * sampleRate);
    if (alignStats) alignStats.searchElected++;
    var searchStep = Math.max(1, Math.round(0.006 * sampleRate));
    var loC = Math.max(0, alignStart - searchRange);
    var hiC = Math.min(alignStop - 1, alignStart + searchRange);
    var bestScore = -1, bestCs = alignStart;
    for (var cand = loC; cand <= hiC; cand += searchStep) {
      // Window centred on the CANDIDATE pulse: a window anchored at the candidate covers its whole
      // pulse, so an in-pulse candidate is actually seen as one. (The walk's window is a 1.4x pulse
      // window starting at its own cursor; reproducing that geometry here would push the window past
      // a candidate that is still perfectly good.)
      var probe = Math.min(cand, Math.max(0, samples.length - syncWindow));
      var candEnd = probe + Math.floor(syncWindow / 2);
      var candCoarse = startOfSync ? candEnd - syncLen : candEnd;
      if (candCoarse < 0) candCoarse = 0;
      var r = refineSyncScore(samples, sampleRate, mode, candCoarse, startOfSync);
      if (r.score > bestScore) { bestScore = r.score; bestCs = cand; }
    }
    if (bestScore < 0) {
      // Degenerate window: keep the prediction rather than invent a position.
      endSync = alignStart + Math.floor(syncWindow / 2);
    } else {
      endSync = Math.min(bestCs, Math.max(0, samples.length - syncWindow)) +
                Math.floor(syncWindow / 2);
      if (alignStats) {
        if (bestCs === alignStart) alignStats.bestFromSearch0++; else alignStats.bestFromSearch++;
      }
    }
    coarse = startOfSync ? endSync - syncLen : endSync;
    if (coarse < 0) coarse = 0;

    return refineSync(samples, sampleRate, mode, coarse, startOfSync);
  }

  /*
   * Calibration pre-pass: walk the sync pulses only (no pixel decoding) to obtain a
   * PRECISE affine frequency calibration and the true line period.
   *
   * Why a separate pass is needed
   * -----------------------------
   * The header search can only offer a crude calibration, because its 1200 Hz
   * reference is the 30 ms VIS start bit - measured precision ~+/-4 Hz, which is a
   * 0.6% error in `a`. Measured on a CLEAN signal that produced a=1.0062 instead of
   * 1.0, i.e. a calibration error as large as the impairment it was meant to remove,
   * and the measured AFC gain was consequently ~0 dB.
   *
   * The sync pulses are far better references:
   *   - there is one per line, so the 1200 Hz tone frequency can be averaged over
   *     hundreds of measurements;
   *   - their sample positions give the true line period by least squares, and a
   *     sample-rate mismatch scales the TIME axis and the FREQUENCY axis by the same
   *     factor, so the frequency scale is a = 1 / clockScale.
   * (Measured: clockScale came out 0.99503 against a true 1/1.005 = 0.99502, and
   * 0.99010 against a true 1/1.010 = 0.99010.)
   *
   * The walk advances by the OBSERVED sync interval rather than the nominal one, so
   * it tracks a clock error instead of drifting off; the fine slope is then obtained
   * by least squares over all observations.
   */
  async function calibrate(est, samples, sampleRate, mode, imageStart, provisionalCal,
                           shouldCancel, yieldFn, leaderFreq) {
    var syncLen = Math.round(mode.syncPulse * sampleRate);
    var nominalLineSamples = Modes.lineTime(mode) * sampleRate;
    var chanTime = mode.sepPulse + mode.scanTime;
    var base = mode.syncPulse + mode.syncPorch;
    var chanOffsets = mode.structure === 'martin'
      ? [base, base + chanTime, base + 2 * chanTime]
      : [base + chanTime, base + 2 * chanTime, base];

    var seqStart = imageStart;
    if (mode.hasStartSync) {
      var a0 = alignSync(est, samples, sampleRate, mode, imageStart, false, provisionalCal);
      if (a0 == null) return null;
      seqStart = a0;
    }
    if (mode.chanSync > 0) {
      seqStart -= Math.round((chanOffsets[mode.chanSync] + mode.scanTime) * sampleRate);
    }

    var obs = [];
    var freqSum = 0, freqN = 0;
    var advance = nominalLineSamples;
    var prev = null;
    var half = Math.round(syncLen * 0.25);
    var span = Math.max(8, Math.round(syncLen * 0.5));

    for (var line = 0; line < mode.height; line++) {
      // Mirror the main loop's advance rule exactly: the sync channel advances on
      // every line except the very first channel of the very first line. For Martin
      // (chanSync = 0) that means line > 0; for Scottie (chanSync = 2) the first line
      // advances too. Getting this wrong left every observation on the same sync,
      // the fitted slope at 0, and the pre-pass silently discarded.
      if (line > 0 || mode.chanSync > 0) seqStart += Math.round(advance);
      var res = alignSync(est, samples, sampleRate, mode, seqStart, true, provisionalCal);
      if (res == null) break;
      seqStart = res;

      obs.push(res);
      if (prev != null) {
        var interval = res - prev;
        if (interval > nominalLineSamples * 0.9 && interval < nominalLineSamples * 1.1) advance = interval;
      }
      prev = res;

      var at = res + half;
      if (at + span < samples.length) {
        freqSum += est.peak(samples, at, span);
        freqN++;
      }
      if (yieldFn && (line & 31) === 0) {
        if (shouldCancel && shouldCancel()) throw cancelError();
        await yieldFn();
      }
    }

    if (obs.length < 8) return null;

    /*
     * LEAST SQUARES, deliberately restored.
     *
     * A robust estimator was tried here and at the noteSync() site (phase 27) and made things WORSE
     * on the real recording, measured:
     *     least squares        -> 20113 samples/line, adjacent-row correlation 0.1962
     *     Theil-Sen            -> 19127,                      correlation 0.0676
     *     median of intervals  -> 19395,                      correlation 0.1041
     *     truth (independent fine-grained detector)          -> 20553
     * The reason is not the estimator but the INPUT: an independent detector measures this
     * recording's consecutive-interval median at 428.079 ms (20548 samples), yet whatever series
     * these fits consume behaves like a ~404 ms median, i.e. the sync positions fed in are
     * contaminated at the source. No aggregation rule can recover a period from a series that does
     * not contain it, so the next step is to instrument that series, not to change the fit.
     * See docs/reports/阶段二十七报告.md.
     */
    var n = obs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sx += i; sy += obs[i]; sxx += i * i; sxy += i * obs[i]; }
    var den = n * sxx - sx * sx;
    if (!den) return null;
    var slope = (n * sxy - sx * sy) / den;
    if (!(slope > nominalLineSamples * 0.9 && slope < nominalLineSamples * 1.1)) return null;

    var clockScale = slope / nominalLineSamples;
    var syncFreqAvg = freqN ? freqSum / freqN : 1200;
    /*
     * Frequency axis scales inversely to the time axis (one physical clock error).
     * The OFFSET is anchored on the 300 ms leader, not on the sync tone: the sync is
     * under 3 cycles long and biased the offset estimate by ~+18.6 Hz, which is about
     * 6 grey levels - comparable to the whole random error floor. The leader pins it
     * to sub-1 Hz. syncFreqAvg is kept for diagnostics only.
     */
    var a = 1 / clockScale;
    var anchor = (leaderFreq && isFinite(leaderFreq)) ? leaderFreq : syncFreqAvg;
    var anchorNominal = (leaderFreq && isFinite(leaderFreq)) ? 1900 : 1200;
    var b = anchor - anchorNominal * a;

    /*
     * Sync-fit residual statistics.
     *
     * The line-start positions should lie on a straight line. A line whose sync search
     * snapped to the wrong offset shows up as a large residual, so these numbers are the
     * quantitative evidence for "sync mis-lock" as a failure mode - which is exactly the
     * question a robustness study has to answer, instead of guessing.
     */
    var resSum = 0, resMax = 0, resBig = 0;
    var bigThreshold = Math.max(2, nominalLineSamples * 0.03);
    // least-squares line: y = slope*x + intercept, with intercept = ybar - slope*xbar.
    // sx and sy are SUMS, so the intercept needs one more division by n - omitting it
    // (as an earlier version did) inflates every residual and flags all lines as mislocked.
    var intercept = (sy - slope * sx) / n;
    for (var k = 0; k < n; k++) {
      var pred = slope * k + intercept;
      var r = obs[k] - pred;
      resSum += r * r;
      if (Math.abs(r) > Math.abs(resMax)) resMax = r;
      if (Math.abs(r) > bigThreshold) resBig++;
    }

    return {
      scale: a, offsetHz: b, clockScale: clockScale,
      syncFreqAvg: syncFreqAvg, anchorFreq: anchor, anchorNominal: anchorNominal,
      observations: n,
      residualRmsSamples: Math.sqrt(resSum / n),
      residualMaxSamples: resMax,
      mislockedLines: resBig,
      residualThresholdSamples: bigThreshold
    };
  }

  async function decodeImageData(est, samples, sampleRate, mode, imageStart,
                                 shouldCancel, yieldFn, onProgress, wantConfidence,
                                 yieldEvery, warnings, calib) {
    var width = mode.width;
    var height = mode.height;
    var channels = mode.channels;
    var windowFactor = mode.windowFactor;
    var nominalPixelTime = mode.scanTime / width;
    var lineTime = Modes.lineTime(mode);
    var nominalLineSamples = lineTime * sampleRate;
    var syncLen = Math.round(mode.syncPulse * sampleRate);

    /*
     * Affine frequency calibration f_nominal = (f_measured - b) / a.
     *
     * `a` (the frequency-axis SCALE) comes from the header, where two known tones
     * 700 Hz apart are available. A clock error scales the whole frequency axis, so
     * no constant offset can substitute for it.
     *
     * `b` (the offset) is then REFINED line by line from the 1200 Hz sync tone: every
     * line carries one, so averaging ~16 of them gives a far better offset estimate
     * than the 30 ms header VIS bit alone. This also tracks slow drift.
     */
    var calA = (calib && calib.a) ? calib.a : 1;
    var calB = (calib && calib.b) ? calib.b : 0;
    function calF(f) { return (f - calB) / calA; }

    // Flat typed output: channels * width per line, no nested JS arrays.
    var data = new Float32Array(height * channels * width);
    var confidence = wantConfidence ? new Float32Array(height * channels * width) : null;
    var confBox = wantConfidence ? new Float32Array(1) : null;

    // Channel start offsets, in the SAME convention as the upstream reference:
    // measured from a sync pulse, indexed by COLOUR ROLE, not by physical order.
    // For all GBR modes the physical order after a sync is  R, G, B  while the
    // array is indexed 0=G, 1=B, 2=R - so index 2 (Red) is the one adjacent to
    // the sync. Reproducing this exactly is what makes the chanSync rewind below
    // land on the right samples.
    var chanTime = mode.sepPulse + mode.scanTime;
    var base = mode.syncPulse + mode.syncPorch;
    var chanOffsets;
    if (mode.structure === 'martin') {
      chanOffsets = [base, base + chanTime, base + 2 * chanTime];
    } else {
      // scottie: split chroma layout - R sits immediately after the sync
      chanOffsets = [base + chanTime, base + 2 * chanTime, base];
    }

    var seqStart = imageStart;
    if (mode.hasStartSync) {
      var aligned = alignSync(est, samples, sampleRate, mode, imageStart, false, calF, calib);
      if (aligned == null) {
        warnings.push('音频在图像数据开始前就结束了。');
        return { data: data, confidence: confidence };
      }
      seqStart = aligned;
    }

    /*
     * Clock recovery.
     *
     * A sample-rate mismatch time-scales the waveform, so the true line period
     * differs from nominal and, within a line, the pixel clock is scaled too. The
     * sync pulses are already located once per line, so a least-squares fit of sync
     * position against line index gives the true period directly - no extra
     * detection needed. Measured benefit: this is what makes the 0.5%/1% presets
     * decodable at all.
     */
    var measuredLineSamples = nominalLineSamples;
    var syncFreqSum = 0, syncFreqN = 0;

    /*
     * Per-pulse line-rate adjudication, ported from Robot36's Decoder.processSyncPulse().
     *
     * The three global estimators tried earlier (least squares, Theil-Sen, median of intervals) all
     * failed on the real recording, and the reason is structural rather than statistical: a global fit
     * lets contamination ACCUMULATE, whereas upstream REJECTS it per pulse. Its rule is:
     *   - keep the last LINE_WINDOW (=4) consecutive sync intervals;
     *   - mean = their average, stdDev = their standard deviation;
     *   - if stdDev > LINE_TOLERANCE_SAMPLES (1 ms) the whole update is DISCARDED and the previous
     *     rate is kept;
     *   - likewise if |mean - nominal line period| > 1 ms.
     * A spurious sync therefore corrupts at most one window and is then thrown away, instead of
     * dragging a fitted slope. Phase 26 measured the real recording's interval MAD at 0.4389 ms, well
     * inside the 1 ms gate, so this adjudicator accepts its good pulses and rejects the music-borne
     * ones - which is exactly what the global fit could not do.
     */
    var LINE_WINDOW = 4;
    var LINE_TOLERANCE_SAMPLES = Math.round(0.001 * sampleRate);
    var lineIntervals = [];
    var lastSyncPos = null;
    var lineWindow = { n: 0, mean: null, sd: null, applied: false, updates: 0, rejected: 0 };
    var freeRunLines = 0;
    var freeRunTotal = 0;
    /*
     * Upper bound on consecutive free-running lines. Upstream re-locks from its header path and does
     * not need a cap, but we decode a whole file in one pass: without one, a recording that ends in
     * pure noise would be "decoded" into a full frame of fabricated content instead of stopping.
     */
    var MAX_FREE_RUN_LINES = 32;

    function noteSync(pos) {
      if (lastSyncPos != null) {
        lineIntervals.push(pos - lastSyncPos);
        if (lineIntervals.length > LINE_WINDOW) lineIntervals.shift();
        var wn = lineIntervals.length;
        var wm = 0;
        for (var wi = 0; wi < wn; wi++) wm += lineIntervals[wi];
        wm /= wn;
        var wv = 0;
        for (var wj = 0; wj < wn; wj++) { var wd = lineIntervals[wj] - wm; wv += wd * wd; }
        var wsd = Math.sqrt(wv / wn);
        /*
         * The gates apply only once the window is full. Before that the mean of whatever is present is
         * used, with no gate - upstream behaves the same way while its history is filling.
         */
        var gated = wn >= LINE_WINDOW;
        /*
         * The nominal-agreement gate applies ALWAYS, including while the window is filling; only the
         * std-dev gate waits for a full window.
         *
         * Measured on the real recording: the very first intervals are already contaminated (window
         * mean 20085 against a nominal 20555), and because the gates used to be skipped until the
         * window filled, that bad value was written unconditionally - after which every gated update
         * failed the nominal check (469 samples out, i.e. 10x the 48-sample tolerance) and was
         * discarded, leaving the contaminated rate in place for the entire frame. The gate ends up
         * protecting the very value it was meant to reject. Diagnostics showed it plainly as
         * "accepted 0 / rejected 252".
         */
        var nominalOk = Math.abs(wm - nominalLineSamples) <= LINE_TOLERANCE_SAMPLES;
        var pass = nominalOk && (!gated || wsd <= LINE_TOLERANCE_SAMPLES);
        lineWindow.n = wn;
        lineWindow.mean = wm;
        lineWindow.sd = wsd;
        lineWindow.applied = pass;
        if (pass) {
          measuredLineSamples = wm;
          if (gated) lineWindow.updates++;
        } else {
          lineWindow.rejected++;
        }
      }
      lastSyncPos = pos;
      if (syncLen > 8) {
        var at = pos + Math.round(syncLen * 0.25);
        var len = Math.round(syncLen * 0.5);
        if (at + len < samples.length) {
          /*
           * DIAGNOSTIC ONLY. This must not drive the frequency offset: the sync is
           * under 3 cycles of 1200 Hz at 48 kHz, and its measured frequency carries a
           * systematic bias (measured +18.6 Hz on a clean signal, i.e. ~6 grey levels -
           * as large as the entire random error floor). An earlier version averaged
           * this into `b` and cancelled out the accurate leader-anchored value. The
           * offset is estimated once in calibrate() from the 300 ms leader.
           */
          syncFreqSum += est.peak(samples, at, len);
          syncFreqN++;
        }
      }
    }

    var truncated = false;

    for (var line = 0; line < height; line++) {
      if (shouldCancel()) throw cancelError();

      // Clock recovery is what turns a constant-rate error into a corrected pixel pitch.
      // Disabling it (calib.clockScale === 1) is the control condition for measuring its
      // contribution on real recordings.
      var clockScale = (calib && calib.clockScale != null) ? calib.clockScale
        : (measuredLineSamples / nominalLineSamples);
      var pixelTime = nominalPixelTime * clockScale;
      var centreWindowTime = (pixelTime * windowFactor) / 2;
      var pixelWindow = Math.round(centreWindowTime * 2 * sampleRate);
      if (pixelWindow < 8) pixelWindow = 8;

      if (mode.chanSync > 0 && line === 0) {
        var syncOffset = chanOffsets[mode.chanSync];
        seqStart -= Math.round((syncOffset + mode.scanTime) * sampleRate);
      }

      for (var chan = 0; chan < channels; chan++) {
        if (chan === mode.chanSync) {
          if (line > 0 || chan > 0) seqStart += Math.round(measuredLineSamples);
          var res = alignSync(est, samples, sampleRate, mode, seqStart, true, calF, calib);
          if (res == null) {
            /*
             * FREE RUN, the Robot36 1.25-line rule.
             *
             * Upstream does not stop when a sync is missed: once 1.25 line periods pass without one it
             * keeps decoding at the last known rate and re-locks when a pulse reappears. Our loop
             * advances one line at a time, so "this line's sync was not found" is the discrete
             * equivalent of that 1.25-line deadline. Previously this branch pushed a warning and broke
             * out of the whole decode, so ONE missed sync - which the real recording produces
             * constantly, since its music looks like sync pulses - threw away every remaining line.
             *
             * `seqStart` already carries the `+= measuredLineSamples` prediction from above, so the
             * free-running line is demodulated at the last adjudicated rate, and the search for a real
             * pulse continues on the next iteration.
             */
            freeRunLines++;
            freeRunTotal++;
            if (freeRunLines > MAX_FREE_RUN_LINES) {
              warnings.push('第 ' + line + ' 行起连续 ' + MAX_FREE_RUN_LINES +
                ' 行未找到同步脉冲，解码终止。');
              truncated = true;
              break;
            }
            if (auditRefsOut) auditRefsOut.push({ line: line, ref: seqStart, freeRun: true });
          } else {
            freeRunLines = 0;
            seqStart = res;
            if (auditRefsOut) auditRefsOut.push({ line: line, ref: res });
            noteSync(res);
          }
        }

        var baseIdx = (line * channels + chan) * width;
        for (var px = 0; px < width; px++) {
          /*
           * The analysis window must be centred on the pixel's CENTRE.
           *
           * A pixel's tone occupies [x, x+1) * pixelTime, so its centre is at
           * (x + 0.5) * pixelTime. The upstream reference omits the +0.5, which
           * centres the window on the pixel's leading edge - skewed half a pixel
           * towards the previous pixel. That error happened to be partly cancelled
           * by its sync heuristic landing about half a pixel late, which is why it
           * was never noticed. Now that sync alignment is accurate to ~0.2 px the
           * omission is exposed, so it is corrected here rather than left to
           * cancel against a second defect.
           */
          var pos = Math.round(seqStart + (chanOffsets[chan] + (px + 0.5) * pixelTime - centreWindowTime) * sampleRate);
          if (pos < 0) pos = 0;
          var end = pos + pixelWindow;
          // `end` is an exclusive bound, so a window ending exactly at the last
          // sample is still complete. (The upstream reference used >=, which
          // rejects a signal that ends flush with its final pixel.)
          if (end > samples.length) {
            warnings.push('音频在解码完成前结束（行 ' + line + '），图像不完整。');
            truncated = true;
            break;
          }
          /*
           * Restricted to the image band: without it this ~1 ms window searches the whole
           * spectrum and locks onto whatever is loudest - on the real Scottie S1 recording that
           * was content near 3 kHz, and calcLum clamped every such pixel to white.
           */
          /*
           * ==================================================================================
           * MEASURED DEAD END, phase 50: the REVERBERANT (speaker-to-microphone) case cannot be
           * improved from here, and three independent measurements say so. Recorded because it is
           * the largest remaining gap in the robustness matrix - RT60 0.20 s costs 7.1 dB and
           * 0.30 s costs 12.7 dB - and the obvious ideas have now been tried and ruled out:
           *
           *   1. Deconvolving with the TRUE impulse response gains +0.08 dB (17.73 -> 17.81 at
           *      RT60 0.30 s, 256-tap Tikhonov). Knowing the channel perfectly does not help, so
           *      the problem is not channel estimation.
           *   2. The channel is not recoverable from the signal's own structure either: averaged
           *      over all 257 sync pulses, the estimate agrees with the real IR at -4.0 dB over the
           *      9-50 ms tail. The 9 ms sync does not excite a long tail, and the diffusion network
           *      used to model the room has a FLAT magnitude and violent phase response, i.e. it is
           *      not stably invertible in the first place.
           *   3. This estimator's own variance barely moves: on a flat field of known level 127 the
           *      per-pixel sigma goes 7.40 -> 8.18 levels (23 -> 26 Hz) from clean to RT60 0.30 s.
           *      What collapses PSNR is EXTREME OUTLIERS, not precision - the extremes go 134 ->
           *      224/254 and the MAD 0 -> 14. So "swap in a more robust peak estimator" addresses
           *      the part that is not broken.
           *
           * Consequence: closing this gap needs waveform recovery BEFORE demodulation (a
           * multi-microphone or dereverberation front end, or iterative decoding across the frame
           * redundancy), which is a separate work package rather than a change here. Do not start
           * an equaliser in this function on the assumption that it must help - it was measured,
           * and it does not.
           * ==================================================================================
           */
          var band = imageBandRaw(calA, calB);
          var freq = est.peak(samples, pos, pixelWindow, confBox, 0, band[0], band[1]);
          data[baseIdx + px] = calcLum(calF(freq));
          /*
           * `confBox` is null unless the caller asked for confidence, so it must be guarded here.
           * est.peak already tolerates a null confOut; this read did not, and the new audit sink is what
           * exposed it - reading confBox[0] threw on every pixel for any caller that passed an audit
           * array without wantConfidence. Guarded rather than assumed because the cost is one comparison
           * per pixel and the failure mode is a total decode loss.
           */
          if (confidence && confBox) confidence[baseIdx + px] = confBox[0];
          /*
           * OPT-IN per-pixel audit sink. Null by default, so the hot path is unchanged.
           *
           * It exists because the frequency-offset asymmetry could not be localised: six candidate
           * mechanisms on the sync/header side were each measured and eliminated, and the remaining
           * suspect is this pixel path - which had no observability at all. Without the raw frequency
           * and the calibrated level that produced each pixel, every remaining hypothesis is a guess.
           *
           * A flat-grey test image makes this decisive: the transmitted tone is the same for every
           * pixel, so the DISTRIBUTION of `rawFreq` should be identical between a +D and a -D offset
           * (shifted, not reshaped). If it is, the estimator is fine and the asymmetry is downstream;
           * if it is not, the estimator or the search band is the cause.
           */
          if (pixelAuditOut) {
            pixelAuditOut.push({ line: line, chan: chan, px: px, raw: freq,
              nominal: calF(freq), lum: data[baseIdx + px],
              conf: confBox ? confBox[0] : null,
              bandLo: band[0], bandHi: band[1], a: calA, b: calB });
          }
        }
        if (truncated) break;
      }
      if (truncated) break;

      if (onProgress && ((line & 15) === 0)) onProgress(0.2 + 0.8 * (line / height), '解调图像');
      if (yieldEvery > 0 && (line % yieldEvery) === 0) await yieldFn();
    }

    onProgress(1, '解调图像');
    // report what calibration was actually applied, for the UI and the reports
    if (calib) {
      calib.aUsed = calA;
      calib.bUsed = calB;
      /*
       * The measured line slope is always recorded, but it must NOT overwrite the scale that was
       * actually used. With clockRecovery:false the scan ran with clockScale = 1, and clobbering
       * that here made calibration.clockScale report 0.9785 anyway - which is exactly how the
       * option came to look inoperative.
       */
      calib.measuredClockScale = measuredLineSamples / nominalLineSamples;
      if (calib.clockRecoveryApplied !== false) calib.clockScale = calib.measuredClockScale;
      /* Diagnostics for the per-pulse rate adjudication and the free-run fallback (phase 29). */
      calib.lineWindow = {
        window: LINE_WINDOW, toleranceSamples: LINE_TOLERANCE_SAMPLES,
        lastN: lineWindow.n, lastMeanSamples: lineWindow.mean, lastSdSamples: lineWindow.sd,
        accepted: lineWindow.updates, rejected: lineWindow.rejected
      };
      calib.freeRunTotal = freeRunTotal;
      calib.syncFreqAvg = syncFreqN ? syncFreqSum / syncFreqN : null;
    }
    return { data: data, confidence: confidence };
  }

  /** GBR scan order -> RGBA ImageData. */
  /*
   * PD-mode colour transform.
   *
   * Built by INVERTING the encoder's forward matrix numerically instead of transcribing a
   * published inverse formula, so a transcription slip cannot hide. The forward matrix is
   * shared through Modes.YUV_PD; tests/pd-modes.test.js checks the inverse against a real
   * encoded signal, which also confirms the two copies of the constants agree.
   */
  var PD_INV = (function () {
    var C = Modes.YUV_PD;
    var m = [
      [C.yR, C.yG, C.yB],
      [C.ryR / C.ryScale, C.ryG / C.ryScale, C.ryB / C.ryScale],
      [C.byR / C.ryScale, C.byG / C.ryScale, C.byB / C.ryScale]
    ];
    // 3x3 inverse via adjugate
    var a = m[0][0], b = m[0][1], c = m[0][2];
    var d = m[1][0], e = m[1][1], f = m[1][2];
    var g = m[2][0], h = m[2][1], i = m[2][2];
    var A = (e * i - f * h), B = -(d * i - f * g), Cc = (d * h - e * g);
    var det = a * A + b * B + c * Cc;
    var inv = [
      [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
      [Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det]
    ];
    return { m: inv, offset: C.offset };
  })();

  /**
   * PD-family decode (PD120 / PD180).
   *
   * The structural difference from Martin/Scottie is the whole reason this is a separate
   * scan model rather than a table entry in the existing loop:
   *
   *   line-sync family : every LINE starts with its own sync pulse, so alignSync can lock
   *                      each line independently.
   *   PD family        : ONE 20 ms sync pulse per LINE PAIR, no per-line porch, and the
   *                      four scans in a pair are Y(line p), R-Y, B-Y, Y(line p+1) - the
   *                      chroma is shared between the two lines (vertically subsampled 2x).
   *
   * So alignment happens at the block level and the phase must be tracked across the four
   * scans of a pair. Every scan carries exactly `mode.width` samples over `mode.scanTime`,
   * which makes PD120's pixel time 190 us - 2.4x faster than Martin M1's 457.6 us. That is
   * also why PD audio needs a high sample rate: the modulation rate is ~5.3 kHz, so an
   * 8 kHz recording is below Nyquist for this mode.
   */
  async function decodePd(est, samples, sampleRate, mode, imageStart, shouldCancel, yieldFn,
                          onProgress, wantConfidence, yieldEvery, warnings, calib) {
    var W = mode.width, H = mode.height;
    var scanOrder = mode.scanOrder;                 // ['Y','RY','BY','Y']
    var nScans = scanOrder.length;
    var pairs = Math.floor(H / 2);
    var clockScale = (calib && calib.clockScale != null) ? calib.clockScale : 1;
    var calA = (calib && calib.a) ? calib.a : 1;
    var calB = (calib && calib.b) || 0;
    var cf = function (f) { return (f - calB) / calA; };

    var syncSamples = Math.round(mode.syncPulse * sampleRate);
    var blankSamples = Math.round(mode.blanking * sampleRate);
    var scanSamples = mode.scanTime * clockScale * sampleRate;
    var blockSamples = syncSamples + blankSamples + nScans * scanSamples;

    // Per-component pixel window: PD's chroma scans are the SAME sample count over the same
    // time, so one window factor covers all four scans here (unlike modes where components
    // have different scan times).
    var pixT = mode.scanTime / W;
    var pixelWindow = Math.round(pixT * clockScale * (mode.windowFactor || 2.34) * sampleRate);
    if (pixelWindow < 8) pixelWindow = 8;
    var halfWindow = pixelWindow / 2;

    var Yp = new Float32Array(W * H);
    var RYp = new Float32Array(W * pairs);
    var BYp = new Float32Array(W * pairs);
    var conf = wantConfidence ? new Uint8Array(W * H) : null;
    var cn = new Float32Array(1);

    // ---- stage 1: block alignment ----
    // The sync pulse is the LOWEST tone in the SSTV palette (1200 Hz), so the block start is
    // the offset whose 20 ms window measures the lowest frequency. Tracking from the
    // previous MEASURED start (not the nominal grid) keeps small drifts from accumulating.
    var syncLen = Math.max(64, syncSamples);
    var coarse = Math.max(1, Math.round(0.003 * sampleRate));
    var fine = Math.max(1, Math.round(0.001 * sampleRate));
    var coarseWin = Math.max(coarse, Math.round(0.006 * sampleRate));
    var fineWin = coarse;
    var worstSyncHz = 0, offToneSyncs = 0, missing = 0;
    var starts = new Int32Array(pairs);
    var pos = imageStart;

    for (var p = 0; p < pairs; p++) {
      if (shouldCancel()) throw cancelError();
      /*
       * Search bounds must be clamped, and this is not a detail.
       *
       * The PD sync pulse is 1200 Hz, and the VIS header ENDS with a 1200 Hz stop bit that
       * is emitted immediately before the body - so for the FIRST block the stop bit and the
       * sync pulse form one contiguous 1200 Hz region with no separating gap. An unclamped
       * backwards search therefore locks onto the VIS stop bit instead of the sync pulse,
       * shifting every block by the same amount and dragging the whole decode down (measured:
       * 12.3 dB unclamped vs 26.4 dB with analytic offsets).
       *
       * Clamping the lower bound to imageStart fixes block 0 exactly, and from block 1 on the
       * preceding content is the previous pair's Y scan, which is never a 1200 Hz plateau, so
       * the minimum-frequency search is unambiguous there.
       */
      var lo = (p === 0) ? imageStart : (starts[p - 1] + syncSamples);
      var bestOff = pos, bestF = Infinity;
      for (var o1 = pos - coarseWin; o1 <= pos + coarseWin; o1 += coarse) {
        var c1 = o1 < lo ? lo : o1;
        if (c1 < 0 || c1 + syncLen > samples.length) continue;
        var f1 = est.peak(samples, c1, syncLen);
        if (f1 > 0 && f1 < bestF) { bestF = f1; bestOff = c1; }
      }
      for (var o2 = bestOff - fineWin; o2 <= bestOff + fineWin; o2 += fine) {
        var c2 = o2 < lo ? lo : o2;
        if (c2 < 0 || c2 + syncLen > samples.length) continue;
        var f2 = est.peak(samples, c2, syncLen);
        if (f2 > 0 && f2 < bestF) { bestF = f2; bestOff = c2; }
      }
      /*
       * Stage B: find the pulse ONSET with a SHORT window, scanning FORWARD.
       *
       * Two traps here, both measured rather than reasoned:
       *
       * 1. "Lowest frequency" cannot localise the pulse at all. A 20 ms analysis window is
       *    exactly as long as the pulse, so the estimate is a shallow 1195.5 Hz plateau over
       *    the whole pulse AND several ms either side; the search therefore returned whatever
       *    offset its own window started at, i.e. 288 samples (6 ms, ~32 pixels) early.
       *
       * 2. bestOff lands BEFORE the true onset, so an onset scan that starts at bestOff and
       *    walks BACKWARDS never reaches the edge (measured: 33 candidates tried, none hit).
       *    The scan must go forward.
       *
       * The edge itself is located by the frequency crossing ~1350 Hz with a 3 ms window.
       * When a 3 ms window straddles the edge it reports roughly halfway between the previous
       * scan's tone and 1200 Hz, so the true onset is the crossing offset plus half the
       * window - which the probe confirms: crossing at -1.5 ms -> onset 0.0 ms.
       */
      var edgeLen = Math.max(48, Math.round(0.003 * sampleRate));
      var edgeStep = Math.max(1, Math.round(0.00025 * sampleRate));
      var halfEdge = Math.round(edgeLen / 2);
      var onset;
      if (p === 0) {
        /*
         * Block 0 needs no search: the body starts exactly where the VIS header ends, and
         * `imageStart` is already verified to be sample-exact (measured delta 0). Searching
         * here is actively harmful because the VIS stop bit is also 1200 Hz and contiguous
         * with the sync pulse, so the pulse has no distinguishable leading edge.
         */
        onset = imageStart;
      } else {
        var scanFrom = Math.max(lo, bestOff - Math.round(0.001 * sampleRate));
        var scanTo = bestOff + Math.round(0.014 * sampleRate);
        // Measured bias: the crossing estimate overshoots by ~24 samples (0.5 ms), visible as
        // a constant +23..24 sample offset on every block. Correcting it centres the lock.
        var bias = Math.round(0.0005 * sampleRate);
        onset = bestOff + halfEdge - bias;
        for (var o3 = scanFrom; o3 <= scanTo; o3 += edgeStep) {
          if (o3 < 0 || o3 + 2 * edgeLen > samples.length) continue;
          var fe = est.peak(samples, o3, edgeLen);
          if (cf(fe) >= 1350) continue;
          var fe2 = est.peak(samples, o3 + edgeLen, edgeLen);
          if (cf(fe2) >= 1280) continue;              // confirm we are inside the pulse
          onset = o3 + halfEdge - bias;
          break;
        }
      }
      if (onset < lo) onset = lo;
      bestOff = onset;
      if (!isFinite(bestF)) { missing++; starts[p] = pos; }
      else {
        starts[p] = bestOff;
        // a sync pulse should measure close to 1200 Hz; far from it means the block lost lock
        var nf = cf(bestF);
        if (nf > 1450 || nf < 950) { offToneSyncs++; }
        if (Math.abs(nf - 1200) > Math.abs(worstSyncHz - 1200)) worstSyncHz = nf;
      }
      pos = starts[p] + Math.round(blockSamples);
      if ((p & 15) === 0) {
        if (onProgress) onProgress((p / pairs) * 0.35, 'PD 行对同步 ' + p + '/' + pairs);
        await yieldFn();
      }
    }
    if (offToneSyncs > 0) {
      warnings.push('PD 同步脉冲有 ' + offToneSyncs + '/' + pairs + ' 个测得频率偏离 1200 Hz 超过 250 Hz，这些行对可能失锁。');
    }
    if (missing > 0) warnings.push('PD 有 ' + missing + ' 个行对的同步脉冲落在音频之外（信号被截断？）。');

    // ---- stage 2: sample the four scans of every pair ----
    for (var p2 = 0; p2 < pairs; p2++) {
      if (shouldCancel()) throw cancelError();
      var base = starts[p2] + syncSamples + blankSamples;
      for (var s = 0; s < nScans; s++) {
        var comp = scanOrder[s];
        var sc0 = base + s * scanSamples;
        var step = scanSamples / W;
        for (var x = 0; x < W; x++) {
          var centre = sc0 + (x + 0.5) * step;
          var off = Math.round(centre - halfWindow);
          if (off < 0) off = 0;
          if (off + pixelWindow > samples.length) off = Math.max(0, samples.length - pixelWindow);
          /* Same restricted search as the line-sync family: the pixel window is only ~1 ms, so an
             unrestricted peak follows whatever is loudest rather than the image tone. */
          var bandPd = imageBandRaw(calA, calB);
          var fr = est.peak(samples, off, pixelWindow, wantConfidence ? cn : null, 0, bandPd[0], bandPd[1]);
          var lum = calcLum(cf(fr));
          if (comp === 'Y') {
            var row = (s === 0) ? (p2 * 2) : (p2 * 2 + 1);
            var idx = row * W + x;
            Yp[idx] = lum;
            if (conf) conf[idx] = cn[0] > 40 ? 255 : (cn[0] < 6 ? 0 : Math.round((cn[0] - 6) / 34 * 255));
          } else if (comp === 'RY') {
            RYp[p2 * W + x] = lum;
          } else if (comp === 'BY') {
            BYp[p2 * W + x] = lum;
          }
        }
      }
      if ((p2 & 15) === 0) {
        if (onProgress) onProgress(0.35 + (p2 / pairs) * 0.65, 'PD 像素 ' + p2 + '/' + pairs);
        await yieldFn();
      }
    }

    // ---- stage 3: YUV -> RGB, with chroma expanded vertically 2x ----
    var out = new Uint8ClampedArray(W * H * 4);
    var inv = PD_INV.m, off128 = PD_INV.offset;
    for (var y = 0; y < H; y++) {
      var cp = (y >> 1) * W;
      for (var x2 = 0; x2 < W; x2++) {
        var Y = Yp[y * W + x2];
        var u = RYp[cp + x2] - off128;
        var v = BYp[cp + x2] - off128;
        var R = inv[0][0] * Y + inv[0][1] * u + inv[0][2] * v;
        var G = inv[1][0] * Y + inv[1][1] * u + inv[1][2] * v;
        var B2 = inv[2][0] * Y + inv[2][1] * u + inv[2][2] * v;
        var o = (y * W + x2) * 4;
        out[o] = R < 0 ? 0 : (R > 255 ? 255 : R);
        out[o + 1] = G < 0 ? 0 : (G > 255 ? 255 : G);
        out[o + 2] = B2 < 0 ? 0 : (B2 > 255 ? 255 : B2);
        out[o + 3] = 255;
      }
    }

    return { imageData: { data: out, width: W, height: H }, confidence: conf, blockStarts: starts };
  }

  /*
   * ============================================================================================
   * PHASE 49 - ADAPTIVE POST-PROCESSING (the noise gate).
   *
   * WHY IT EXISTS
   *   The phase-49 degradation matrix shows the decoder is already robust where it matters most for
   *   signal integrity: AWGN 6 dB still returns 21.93 dB and 8x clipping 29.50 dB, so neither noise nor
   *   level is the weak axis. What it also shows is that the REAL phigros recording's decoded output
   *   carries sigma_HF = 24.0 grey levels against the Robot36 reference render's 7.0 - 3.4x the
   *   residual noise - and that residual is white (lag-1 along x -0.06, along y -0.12). That is
   *   exactly the case a local filter can improve.
   *
   * WHY IT MUST BE GATED, AND WHY AN UNCONDITIONAL FILTER IS NOT ACCEPTABLE
   *   Measured on the synthetic S1 control (truth known, baseline 30.50 dB), an unconditional 3x3
   *   median drops PSNR to 24.61 dB - a 5.89 dB loss - because this photograph is full of genuine
   *   fine detail that no filter can distinguish from noise. The acceptance rule is that the synthetic
   *   round trips must not fall, so the filter is only ever applied when the decoder can show, from
   *   its OWN output and with no reference, that the picture is noise-limited.
   *
   * THE GATE
   *   sigmaFlat = RMS of the high-pass residual over pixels whose local gradient is in the picture's
   *   lowest quartile. "Flat" is relative to the image itself, so the measure does not depend on the
   *   picture's detail level in the way plain sigma_HF does - and plain sigma_HF genuinely does not
   *   work, measured: a clean synthetic decode reads 12.12 and AWGN 20 dB reads 12.38.
   *   Measured: synthetic clean 5.54, AWGN 20 dB 6.39, AWGN 10 dB 10.56, AWGN 6 dB 14.46,
   *   phigros 15.16.
   *   The threshold is 1.8 x the ~5.4 that a clean decode of a detailed picture reads, i.e. 9.67 -
   *   deliberately above the AWGN 20 dB case, because at that level the filter gains ~0.1 dB and is
   *   not worth the risk of touching a clean decode, and comfortably below phigros so the real
   *   recording is filtered.
   *
   * WHAT THE SHIPPED DEFAULT ACTUALLY DOES (postprocess:'auto'), measured end to end:
   *   synthetic S1 control   PSNR 30.50 -> 30.50  (gate bypasses: sigmaFlat 5.54 < 9.67)
   *   synthetic M1 control   PSNR 31.26 -> 31.26  (same)
   *   PD120 / PD180          32.46 / 32.62 unchanged
   *   phigros                sigmaFlat 15.16 -> 10.08 (-33%), sigmaHF 24.03 -> 22.99,
   *                          row correlation 0.6676 -> 0.6855
   *
   * THE FILTER
   *   A 3x3 median applied ONLY where both hold:
   *     |pixel - median| > tDiff   (the pixel is an outlier against its own neighbourhood), and
   *     local gradient <= tGrad    (that neighbourhood is flat, so the median estimates noise rather
   *                                 than straddling an edge).
   *
   * WHERE THE OPERATING POINT CAME FROM, AND WHY IT IS CONSERVATIVE
   *   tests/denoise-calibrate.js sweeps both thresholds against four truth-known synthetic controls and
   *   phigros. The measured trade-off, as (cost on the S1 control, phigros sigma_HF 24.03 -> ):
   *
   *     tGrad 1.5 sigma, 1 pass    30.50 -> 29.85  (-0.65 dB)   24.03 -> 21.94  (-8.7%)
   *     tGrad 2.0 sigma, 1 pass    30.50 -> 29.51  (-0.99 dB)   24.03 -> 20.89  (-13.1%)
   *     tGrad 3.0 sigma, 1 pass    30.50 -> 28.90  (-1.60 dB)   24.03 -> 19.56  (-18.6%)
   *     tGrad 6.0 sigma, 1 pass    30.50 -> 27.70  (-2.80 dB)   24.03 -> 16.00  (-33.4%)
   *
   *   Dropping the gradient condition entirely was also measured and rejected: an outlier-only median
   *   takes phigros a long way (sigma_HF -> 9.65, row correlation 0.6676 -> 0.9210) but costs 4.62 dB on
   *   the control (30.50 -> 25.88), because this photograph's genuine fine detail is exactly as much of
   *   an outlier against its neighbourhood as noise is.
   *
   *   The acceptance rule for this project is that the synthetic round trips must not fall, and every
   *   setting that does anything substantial to phigros breaks it. The shipped DEFAULT is therefore the
   *   conservative point below, whose cost on the control is small enough to remain inside the gate's
   *   own margin; the useful-but-costly points are reachable with opts.postprocess = 'strong'.
   * ============================================================================================
   */
  var POSTPROCESS_GATE_RATIO = 1.8;   // gate = ratio x the clean-decode reference level
  /*
   * Level a clean decode of a DETAILED picture reaches, measured on tests/denoise-calibrate.js's
   * synthetic S1 control (5.54) and roundtrip.js's photo (which yields the same 9.67 gate). The value
   * below is deliberately the lower of the two measurements so the gate does not creep upward, and it
   * is an approximation of a content-dependent quantity - if a future change makes the gate misfire,
   * re-measure it there rather than nudging this number.
   */
  var CLEAN_SIGMA_FLAT_REF = 5.4;
  /* Strength presets: [tDiff multiplier, tGrad multiplier, passes]. See the table above. */
  var PP_PRESETS = {
    gentle: [1.0, 0.5, 1]
  };
  /*
   * Second gate for the strong tier. Placed at 2.4 x the reference (13.0) from the measured sigmaFlat of
   * every available case - see the table in applyAdaptivePostprocess - so that clean, AWGN 20 dB and
   * AWGN 10 dB material stays on the gentle path, which is where the strong filter would cost 2.9-3.5 dB
   * for no gain. The real acoustic recording (15.16) and AWGN 6 dB (14.46) sit above it.
   */
  var STRONG_GATE_RATIO = 2.4;
  /* Outlier threshold for the strong tier, in multiples of sigmaFlat. Measured in tests/recover-outliers.js. */
  var PP_STRONG_K = 3.0;

  /**
   * Flat-region noise estimate. No reference needed, which is what lets the decoder gate itself.
   *
   * @returns {{sigmaFlat:number, sigmaHF:number, flatFrac:number, rowGain:number}}
   */
  function measureFlatNoise(image) {
    var w = image.width, h = image.height, d = image.data;
    var n = w * h;
    var lum = new Float64Array(n);
    for (var i = 0, k = 0; i < d.length; i += 4, k++) {
      lum[k] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    var grad = new Float64Array(n);
    var res = new Float64Array(n);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
        var ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
        var gx = lum[y * w + xp] - lum[y * w + xm];
        var gy = lum[yp * w + x] - lum[ym * w + x];
        grad[y * w + x] = Math.sqrt(gx * gx + gy * gy);
        var s = 0, c = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += lum[yy * w + xx]; c++;
          }
        }
        res[y * w + x] = lum[y * w + x] - s / c;
      }
    }
    // gradient percentile, by a 16-bin histogram rather than a sort: this runs on every decode
    var gmin = Infinity, gmax = -Infinity;
    for (var q = 0; q < n; q++) { if (grad[q] < gmin) gmin = grad[q]; if (grad[q] > gmax) gmax = grad[q]; }
    var BINS = 64, hist = new Int32Array(BINS);
    var span = gmax - gmin;
    if (span > 1e-9) {
      for (var q2 = 0; q2 < n; q2++) {
        var b = Math.floor((grad[q2] - gmin) / span * BINS);
        if (b >= BINS) b = BINS - 1;
        if (b < 0) b = 0;
        hist[b]++;
      }
    } else {
      hist[0] = n;
    }
    var want = 0.25 * n, acc = 0, cut = gmax;
    for (var bi = 0; bi < BINS; bi++) {
      acc += hist[bi];
      if (acc >= want) { cut = gmin + span * (bi + 1) / BINS; break; }
    }
    var sumSq = 0, cnt = 0;
    for (var q3 = 0; q3 < n; q3++) {
      if (grad[q3] <= cut) { sumSq += res[q3] * res[q3]; cnt++; }
    }
    var mean = 0;
    for (var r = 0; r < n; r++) mean += res[r];
    mean /= n;
    var v = 0;
    for (var r2 = 0; r2 < n; r2++) { var t = res[r2] - mean; v += t * t; }
    var sigmaHF = Math.sqrt(v / n);
    // row-mean residual, as a row-coherence indicator (white noise gives ~ sigmaHF/sqrt(w))
    var rowSq = 0;
    for (var ry = 0; ry < h; ry++) {
      var rs = 0;
      for (var rx = 0; rx < w; rx++) rs += res[ry * w + rx];
      var rm = rs / w;
      rowSq += rm * rm;
    }
    var rowGain = sigmaHF > 1e-9 ? Math.sqrt(rowSq / h) / (sigmaHF / Math.sqrt(w)) : 0;
    return {
      sigmaFlat: Math.sqrt(sumSq / (cnt || 1)),
      sigmaHF: sigmaHF,
      flatFrac: cnt / n,
      rowGain: rowGain
    };
  }

  /**
   * Selective median: only outliers inside flat neighbourhoods are replaced.
   *
   * @param {object} image  {width, height, data} RGBA
   * @param {number} sigma  the image's own measured sigmaFlat, from measureFlatNoise
   * @param {number} [tDiffMul]  outlier threshold, in multiples of sigma (default below)
   * @param {number} [tGradMul]  flatness threshold, in multiples of sigma (default below)
   */
  function selectiveDenoise(image, sigma, tDiffMul, tGradMul) {
    var w = image.width, h = image.height, src = image.data;
    var out = new Uint8ClampedArray(src.length);
    out.set(src);
    var tDiff = (tDiffMul == null ? 1.0 : tDiffMul) * sigma;
    var tGrad = (tGradMul == null ? 0.5 : tGradMul) * sigma;
    var n = w * h;
    var lum = new Float64Array(n);
    for (var i = 0, k = 0; i < src.length; i += 4, k++) {
      lum[k] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    }
    var win = new Float64Array(9);
    var sub = new Float64Array(9);
    for (var c = 0; c < 3; c++) {
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var gx = lum[y * w + x + 1] - lum[y * w + x - 1];
          var gy = lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
          if (Math.sqrt(gx * gx + gy * gy) > tGrad) continue;
          var cnt = 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              win[cnt++] = src[((y + dy) * w + (x + dx)) * 4 + c];
            }
          }
          for (var a = 0; a < cnt; a++) sub[a] = win[a];
          // insertion sort: 9 elements, faster than Array.sort here and allocation-free
          for (var a2 = 1; a2 < cnt; a2++) {
            var key = sub[a2], b2 = a2 - 1;
            while (b2 >= 0 && sub[b2] > key) { sub[b2 + 1] = sub[b2]; b2--; }
            sub[b2 + 1] = key;
          }
          var med = sub[cnt >> 1];
          var idx = (y * w + x) * 4 + c;
          if (Math.abs(src[idx] - med) > tDiff) out[idx] = med;
        }
      }
    }
    return { width: w, height: h, data: out };
  }

  /**
   * OUTLIER RECOVERY - the strong tier, for recordings whose pixels have been captured outright.
   *
   * WHY IT EXISTS, AND WHY IT IS SEPARATE FROM selectiveDenoise ABOVE
   *   Phase 49 measured the shape of the remaining damage on synthetic reverb: the estimator's VARIANCE
   *   barely moves (sigma 7.40 -> 8.18 grey levels from clean to RT60 0.30 s) while the EXTREMES blow up
   *   (134 -> 224/254) and the MAD goes 0 -> 14. Phase 50 confirmed the same signature on the REAL
   *   speaker-to-microphone recording (`tests/fixtures/phigros.wav`), which is genuine acoustic data:
   *   sigma_flat 15.16 against a clean-decode reference of 5.4, while the sync still locks all 256 lines
   *   with b = -0.29 Hz. So the defect is a minority of pixels captured outright, not a uniform loss of
   *   precision - and selectiveDenoise, which is restricted to flat neighbourhoods, barely touches it:
   *   it moved sigma_HF only 24.03 -> 22.99 (-4%).
   *
   *   This stage replaces any pixel that departs from its own 3x3 median by more than k*sigma, wherever
   *   it is. Measured on the real recording at k = 3: sigma_HF 24.03 -> 13.21 (-45%) and chroma noise
   *   57.2 -> 34.4 (-40%) while touching ~6.5% of samples.
   *
   * THE COST, AND THE REASON FOR THE SECOND GATE
   *   An isolated noise spike and a single pixel of genuine fine detail are indistinguishable without a
   *   reference, so this is destructive on detailed pictures. Measured on the synthetic control (truth
   *   known, baseline 30.50 dB): k = 3 costs 3.53 dB and k = 2 costs 4.62 dB. Those numbers break the
   *   S1 acceptance floor of 30.40 dB, so this MUST NOT run on material that does not need it - hence a
   *   second, higher gate, set so that every clean and moderately impaired case stays on the gentle path.
   *
   * @param {object} image
   * @param {number} sigma   the image's own sigmaFlat
   * @param {number} k       outlier threshold in multiples of sigma
   */
  function recoverOutliers(image, sigma, k) {
    var w = image.width, h = image.height, src = image.data;
    var out = new Uint8ClampedArray(src.length);
    out.set(src);
    var thr = k * sigma;
    /*
     * The 9-slot scratch buffer lives OUTSIDE the pixel loop: allocating it per pixel would be 245k
     * allocations for a 320x256 raster, which the decoder cannot afford and does not need - the values
     * are consumed before the next pixel is visited.
     */
    var win = new Float64Array(9);
    var touched = 0;
    for (var c = 0; c < 3; c++) {
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var cnt = 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              win[cnt++] = src[((y + dy) * w + (x + dx)) * 4 + c];
            }
          }
          for (var a = 1; a < cnt; a++) {
            var key = win[a], b = a - 1;
            while (b >= 0 && win[b] > key) { win[b + 1] = win[b]; b--; }
            win[b + 1] = key;
          }
          var med = win[cnt >> 1];
          var idx = (y * w + x) * 4 + c;
          if (Math.abs(src[idx] - med) > thr) { out[idx] = med; touched++; }
        }
      }
    }
    return { width: w, height: h, data: out, touched: touched, total: w * h * 3 };
  }

  /**
   * Apply the gate and, if it passes, the right filter.
   *
   * TWO TIERS, because the two filters have opposite risk profiles:
   *
   *   gentle (>= POSTPROCESS_GATE_RATIO x reference, i.e. sigmaFlat >= 9.72)
   *     the phase-49 selective median. Restricted to flat neighbourhoods, so its worst case on a
   *     detailed picture is bounded: measured -0.23 dB, and +0.08 dB on an AWGN 10 dB decode. Cost-effective
   *     only in the moderate band, which is what the gate selects.
   *
   *   strong (>= STRONG_GATE_RATIO x reference, i.e. sigmaFlat >= 13.0)
   *     outlier recovery at k = 3.0. Large effect on captured pixels, destructive on clean detail, so it
   *     is gated well above every case measured to be only moderately impaired.
   *
   * The two thresholds were placed from the measured sigmaFlat of every case available:
   *   合成 clean 5.54 · AWGN 20 dB 6.39 · AWGN 10 dB 10.56 · 真实录音 15.16 · AWGN 6 dB 14.46
   * so 13.0 puts clean / AWGN 20 / AWGN 10 on gentle or bypass - the two cases where the strong filter
   * would cost 2.9-3.5 dB for no benefit - and the real recording and AWGN 6 on strong.
   *
   * @param {string} mode 'auto' | 'gentle' | 'strong' | 'off'
   */
  function applyAdaptivePostprocess(imageData, mode) {
    /*
     * GUARD FIRST. Post-processing is an optional refinement and must never be the reason a decode
     * fails. This is not hypothetical: the AWGN 6 dB case returned an incomplete raster object
     * (`{data, confidence}` without width/height) from an early error path in decodeImageData, and
     * measureFlatNoise then threw on `image.data.length`, turning a degraded decode into a total
     * failure. Before this stage was wired in unconditionally that case only ever ran with
     * postprocess:'off' and therefore never reached here.
     *
     * This project already treats post-processing as a refinement of the raster, so the right behaviour
     * for any malformed raster is to skip the refinement, not to lose the picture.
     */
    if (!imageData || !imageData.data || !imageData.width || !imageData.height ||
        typeof imageData.data.length !== 'number' || imageData.data.length < 16) {
      return { imageData: imageData, info: { applied: false, requested: mode || 'auto',
        tier: 'skipped-malformed-raster' } };
    }
    var noise = measureFlatNoise(imageData);
    var gate = POSTPROCESS_GATE_RATIO * CLEAN_SIGMA_FLAT_REF;
    var strongGate = STRONG_GATE_RATIO * CLEAN_SIGMA_FLAT_REF;
    var requested = mode || 'auto';
    if (requested === 'off') {
      return { imageData: imageData, info: {
        applied: false, requested: requested, sigmaFlat: noise.sigmaFlat, gate: gate,
        strongGate: strongGate, sigmaHF: noise.sigmaHF, flatFrac: noise.flatFrac, rowGain: noise.rowGain
      } };
    }
    var tier;
    if (requested === 'strong' || (requested === 'auto' && noise.sigmaFlat > strongGate)) tier = 'strong';
    else if (requested === 'gentle' || (requested === 'auto' && noise.sigmaFlat > gate)) tier = 'gentle';
    else tier = null;
    if (!tier) {
      return { imageData: imageData, info: {
        applied: false, requested: requested, tier: 'bypass',
        sigmaFlat: noise.sigmaFlat, gate: gate, strongGate: strongGate,
        sigmaHF: noise.sigmaHF, flatFrac: noise.flatFrac, rowGain: noise.rowGain
      } };
    }
    var filtered = imageData;
    if (tier === 'strong') {
      // NOTE: keep the whole {width, height, data} object. Assigning `rec.data` here - a bare
      // Uint8ClampedArray - is what broke this branch: the gentle filter returns an object and this one
      // has to as well, because measureFlatNoise below reads image.width/height/data from it.
      filtered = recoverOutliers(filtered, noise.sigmaFlat, PP_STRONG_K);
    } else {
      var preset = PP_PRESETS.gentle;
      for (var p = 0; p < preset[2]; p++) {
        filtered = selectiveDenoise(filtered, noise.sigmaFlat, preset[0], preset[1]);
      }
    }
    var after = measureFlatNoise(filtered);
    return { imageData: filtered, info: {
      applied: true, requested: requested, tier: tier,
      sigmaFlat: noise.sigmaFlat, sigmaFlatAfter: after.sigmaFlat, gate: gate, strongGate: strongGate,
      sigmaHF: noise.sigmaHF, sigmaHFAfter: after.sigmaHF, sdGRAfter: null,
      flatFrac: noise.flatFrac, rowGain: noise.rowGain
    } };
  }

  function composeImageData(decoded, mode) {
    var width = mode.width;
    var height = mode.height;
    var channels = mode.channels;
    var src = decoded.data;
    var out = new Uint8ClampedArray(width * height * 4);

    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var b = (y * channels) * width + x;
        // scanOrder is ['G','B','R']
        var g = src[b];
        var bl = src[b + width];
        var r = src[b + 2 * width];
        var o = (y * width + x) * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = bl;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: width, height: height };
  }

  return {
    decode: decode,
    QUALITY: QUALITY,
    SUPPORTED: Object.keys(Modes.DECODABLE).map(function (k) {
      return { vis: Number(k), id: Modes.DECODABLE[k].id, name: Modes.DECODABLE[k].name };
    }),
    // Exposed for regression/diagnostic tooling (and reused by phase 2's demod work).
    _internal: {
      Estimator: Estimator,
      alignSync: alignSync,
      /**
       * Phase-49 item 1: the nominal-space constants that used to be applied on the raw axis, exposed so
       * tests/frequency-axis.test.js can check the mapping directly instead of inferring it from a decode.
       */
      frequencyAxis: {
        imageBandRaw: imageBandRaw,
        syncDetectHz: syncDetectHz,
        syncDetectHzOf: syncDetectHzOf,
        /** Sweep hook (tests/sweep-band-margin.js); pass null to restore the shipped constant. */
        setBandMargin: function (hz) { bandMarginHz = hz == null ? IMAGE_BAND_MARGIN_HZ : hz; },
        getBandMargin: function () { return bandMarginHz; },
        /** Lower guard above the 1500 Hz porch tone, in nominal Hz; 0 disables. */
        setLowerGuard: function (hz) { bandLowerGuardHz = hz == null ? 0 : hz; },
        getLowerGuard: function () { return bandLowerGuardHz; },
        constants: { IMAGE_BAND_MARGIN_HZ: IMAGE_BAND_MARGIN_HZ, SYNC_DETECT_HZ: SYNC_DETECT_HZ,
          PORCH_NOMINAL_HZ: 1500 }
      },
      /**
       * Phase-49 adaptive post-processing, exposed so tests/denoise-calibrate.js can sweep the gate
       * and the filter against the SAME implementation that ships, instead of a copy that drifts.
       */
      postprocess: {
        measureFlatNoise: measureFlatNoise,
        selectiveDenoise: selectiveDenoise,
        recoverOutliers: recoverOutliers,
        applyAdaptivePostprocess: applyAdaptivePostprocess,
        constants: { POSTPROCESS_GATE_RATIO: POSTPROCESS_GATE_RATIO,
          CLEAN_SIGMA_FLAT_REF: CLEAN_SIGMA_FLAT_REF,
          STRONG_GATE_RATIO: STRONG_GATE_RATIO, PP_STRONG_K: PP_STRONG_K }
      },
      /**
       * Phase-48 gate observation. Set `_internal.alignStats = {calls:0,startOfSyncCalls:0,
       * endOfSyncCalls:0,startInSync:0,startInImage:0,searchElected:0,bestFromSearch:0}` before a
       * decode to count which branch alignSync took; set it back to null to remove the overhead.
       * Null by default, so the production path is unaffected.
       */
      setAlignStats: function (s) { alignStats = s; },
      nextPow2: nextPow2,
      calcLum: calcLum,
      constants: {
        BREAK_OFFSET: BREAK_OFFSET,
        LEADER_OFFSET: LEADER_OFFSET,
        VIS_START_OFFSET: VIS_START_OFFSET,
        HDR_SIZE: HDR_SIZE,
        HDR_WINDOW_SIZE: HDR_WINDOW_SIZE,
        VIS_BIT_SIZE: VIS_BIT_SIZE
      }
    }
  };
});
