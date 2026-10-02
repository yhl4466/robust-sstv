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

  var SYNC_DETECT_HZ = 1350;   // above this = not a 1200 Hz sync pulse
  var HEADER_TOLERANCE = 50;   // Hz

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
   * @returns {number} frequency in Hz
   */
  Estimator.prototype.peak = function (samples, offset, len, confOut, capOverride) {
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
    var best = -1, bx = 0;
    for (var k = 0; k < mags.length; k++) {
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
      // Best magnitude at least 3 bins away from the peak, as a noise-floor proxy.
      var guard = 3, floor = 1e-12;
      for (var q = 0; q < mags.length; q++) {
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
        calib.a = cal.scale;
        calib.b = cal.offsetHz;
        calib.source = 'sync-calibration';
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
      if (!clockRecovery) calib.clockScale = 1;
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
      timings.total = Date.now() - started;

      return {
        ok: true,
        imageData: pdResult ? pdResult.imageData : composeImageData(decoded, mode),
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
          syncResidualMax: calib.syncResidualMax,
          mislockedLines: calib.mislockedLines,
          headerScale: hdr.a,
          headerOffsetHz: hdr.b,
          leaderFreqHz: hdr.leaderFreq,
          // diagnostics: where the body was taken to start, and where PD actually locked
          imageStart: visEnd,
          pdBlockStarts: pdResult ? Array.prototype.slice.call(pdResult.blockStarts, 0, 8) : null
        },
        warnings: warnings,
        timings: timings
      };
    } catch (err) {
      if (err && err.cancelled) {
        return { ok: false, stage: 'cancelled', cancelled: true, message: '已取消。', timings: timings };
      }
      return { ok: false, stage: 'unexpected', message: err && err.message ? err.message : String(err), timings: timings };
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
  function alignSync(est, samples, sampleRate, mode, alignStart, startOfSync, cal) {
    var syncWindow = Math.round(mode.syncPulse * 1.4 * sampleRate);
    var alignStop = samples.length - syncWindow;
    if (alignStop <= alignStart) return null;
    var f = cal || function (x) { return x; };

    // Coarse fix: advance until the dominant tone is no longer the 1200 Hz sync.
    var cs = alignStart;
    for (; cs < alignStop; cs++) {
      if (f(est.peak(samples, cs, syncWindow)) > SYNC_DETECT_HZ) break;
    }
    var endSync = cs + Math.floor(syncWindow / 2);
    var coarse = startOfSync ? endSync - Math.round(mode.syncPulse * sampleRate) : endSync;
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
      var aligned = alignSync(est, samples, sampleRate, mode, imageStart, false, calF);
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
    var syncObs = [];
    var measuredLineSamples = nominalLineSamples;
    var syncFreqSum = 0, syncFreqN = 0;

    function noteSync(pos) {
      syncObs.push({ i: syncObs.length, p: pos });
      if (syncObs.length >= 8) {
        var n = syncObs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (var q = 0; q < n; q++) {
          var o = syncObs[q];
          sx += o.i; sy += o.p; sxx += o.i * o.i; sxy += o.i * o.p;
        }
        var den = n * sxx - sx * sx;
        if (den) {
          var slope = (n * sxy - sx * sy) / den;
          // sanity-gate: a wild slope means a mis-lock, not a clock error
          if (slope > nominalLineSamples * 0.9 && slope < nominalLineSamples * 1.1) {
            measuredLineSamples = slope;
          }
        }
      }
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
          var res = alignSync(est, samples, sampleRate, mode, seqStart, true, calF);
          if (res == null) {
            warnings.push('第 ' + line + ' 行后音频结束，图像不完整。');
            truncated = true;
            break;
          }
          seqStart = res;
          noteSync(res);
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
          var freq = est.peak(samples, pos, pixelWindow, confBox);
          data[baseIdx + px] = calcLum(calF(freq));
          if (confidence) confidence[baseIdx + px] = confBox[0];
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
      calib.clockScale = measuredLineSamples / nominalLineSamples;
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
          var fr = est.peak(samples, off, pixelWindow, wantConfidence ? cn : null);
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
