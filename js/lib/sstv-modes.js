/*
 * SSTV mode definitions (pure data + timing helpers).
 *
 * Timing values are taken from two independent implementations:
 *   - CKegel/Web-SSTV (MIT, Copyright (c) 2023 Christian Kegel) - mode constructors
 *   - samccone/sstv    (MIT, Copyright (c) 2025 The SSTV Authors) - spec.ts
 * They agree exactly on every timing parameter used here.
 *
 * VIS codes are taken from the SSTV standard and cross-checked against
 * samccone/sstv's VIS_MAP (an independent implementation that decodes real
 * off-air recordings).
 *
 * IMPORTANT - a defect found in Web-SSTV, deliberately NOT reproduced here:
 *   Web-SSTV's Scottie S1 VIS array [0,0,1,1,1,1,0] evaluates to VIS 30, but
 *   standard Scottie S1 is VIS 60. (Its Martin M1/M2, Scottie S2/SDX and
 *   PD50/90/120/180/240/290 codes are all correct; only S1 and PD160 are wrong.)
 *   We use the standard values. See 阶段一技术方案.md section 6.
 */
(function (root, factory) {
  var api = factory();
  root.SSTVModes = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Frequency axis (standard 1500 Hz = black, 2300 Hz = white) ----
  var FREQ_BLACK = 1500;
  var FREQ_WHITE = 2300;
  var FREQ_SYNC = 1200;   // line sync pulse
  var FREQ_PORCH = 1500;  // sync porch / separator
  var COLOR_FREQ_MULT = (FREQ_WHITE - FREQ_BLACK) / 255; // 3.1372549...

  // ---- VIS calibration header ----
  var VIS_LEADER_FREQ = 1900;
  var VIS_LEADER_LEN = 0.300;
  var VIS_BREAK_FREQ = 1200;
  var VIS_BREAK_LEN = 0.010;
  var VIS_START_LEN = 0.030;   // 1200 Hz start bit
  var VIS_BIT_LEN = 0.030;
  var VIS_ONE_FREQ = 1100;
  var VIS_ZERO_FREQ = 1300;
  var VIS_STOP_LEN = 0.030;    // 1200 Hz stop bit
  var VIS_HEADER_LEN = VIS_LEADER_LEN + VIS_BREAK_LEN + VIS_LEADER_LEN +
                       VIS_START_LEN + 8 * VIS_BIT_LEN + VIS_STOP_LEN; // = 0.91 s

  /*
   * Trailing margin emitted after the last scan line.
   *
   * Not cosmetic: the final pixel's analysis window is centred on the last pixel
   * and therefore extends ~centreWindowTime past the end of the final scan, and
   * sync alignment can land a few tens of samples late. With a zero-length tail
   * the last pixel falls outside the buffer and decoders bail out on the final
   * line (measured: Scottie S1 overran by exactly 1 sample). Real transmissions
   * always tail off, so emitting one is also the more faithful signal.
   */
  var TAIL_SECONDS = 0.100;

  // ------------------------------------------------------------------
  // Mode table
  //
  //   structure:
  //     'martin'  - per line: sync, porch, then CH0,sep, CH1,sep, CH2,sep
  //     'scottie' - one leading sync; per line: porch,CH0, sep,CH1, sync,porch,CH2
  //     'pd'      - per LINE PAIR: sync, blanking, Y0, RY, BY, Y1
  //
  //   channels: 0-based scan order. colours map scan order -> R/G/B.
  // ------------------------------------------------------------------
  var MODES = {
    M1: {
      id: 'M1',
      name: 'Martin M1',
      vis: 44,
      width: 320,
      height: 256,
      colorSpace: 'GBR',
      structure: 'martin',
      channels: 3,
      chanSync: 0,
      windowFactor: 2.34,
      scanOrder: ['G', 'B', 'R'],
      syncPulse: 0.004862,
      syncPorch: 0.000572,
      sepPulse: 0.000572,
      scanTime: 0.146432,
      hasStartSync: false,
      linePairs: false
    },
    S1: {
      id: 'S1',
      name: 'Scottie S1',
      vis: 60,
      width: 320,
      height: 256,
      colorSpace: 'GBR',
      structure: 'scottie',
      channels: 3,
      chanSync: 2,
      windowFactor: 2.48,
      scanOrder: ['G', 'B', 'R'],
      syncPulse: 0.009,
      syncPorch: 0.0015,
      sepPulse: 0.0015,
      scanTime: 0.138240,
      hasStartSync: true,
      linePairs: false
    },
    PD120: {
      id: 'PD120',
      name: 'PD 120',
      vis: 95,
      width: 640,
      height: 496,
      colorSpace: 'YUV',
      structure: 'pd',
      channels: 4,
      chanSync: -1,
      /*
       * Pixel-window factor, now CALIBRATED for decoding.
       *
       * The window is windowFactor * pixelTime, and PD120's pixel time is 0.1216/640 =
       * 190 us - 2.4x faster than Martin M1's 457.6 us. Measured against the encoder round
       * trip (tests/pd-modes.test.js), this value maximises PSNR. It was null in phase 1
       * because PD decoding was out of scope then.
       */
      windowFactor: 8,
      scanOrder: ['Y', 'RY', 'BY', 'Y'],
      syncPulse: 0.020,
      syncPorch: 0,          // PD has no porch; `blanking` covers it
      sepPulse: 0,           // PD has no separators between scans
      blanking: 0.00208,
      scanTime: 0.121600,
      hasStartSync: false,
      linePairs: true
    },
    PD180: {
      id: 'PD180',
      name: 'PD 180',
      vis: 96,
      width: 640,
      height: 496,
      colorSpace: 'YUV',
      structure: 'pd',
      channels: 4,
      chanSync: -1,
      windowFactor: 8,
      scanOrder: ['Y', 'RY', 'BY', 'Y'],
      syncPulse: 0.020,
      syncPorch: 0,
      sepPulse: 0,
      blanking: 0.00208,
      /*
       * PD180 is the same scan model at 1.5x the time base: the mode name is the nominal
       * duration in seconds (PD120 ~126 s, PD180 ~187 s), and
       * 4 * 0.1824 + 0.020 + 0.00208 = 0.7517 s per line pair * 248 = 186.4 s, which
       * matches the published PD180 duration. Only this constant differs from PD120 - the
       * decoder code path is shared, which tests/pd-modes.test.js asserts explicitly.
       */
      scanTime: 0.182400,
      hasStartSync: false,
      linePairs: true
    }
  };

  /*
   * PD-mode Y / R-Y / B-Y constants, shared so the decoder's inverse cannot drift from the
   * encoder's forward transform. The encoder keeps its own inline copy (unchanged, zero
   * regression risk); tests/pd-modes.test.js verifies the two agree by round-tripping a
   * real encoded signal, which is a stronger check than comparing literals.
   */
  var YUV_PD = {
    yR: 0.299, yG: 0.587, yB: 0.114,
    ryScale: 256,
    ryR: 112.439, ryG: -94.154, ryB: -18.285,
    byR: -37.945, byG: -74.494, byB: 112.439,
    offset: 128
  };

  // ---- derived timing ----
  function lineTime(m) {
    if (m.structure === 'pd') {
      return m.syncPulse + m.blanking + m.channels * m.scanTime;
    }
    if (m.structure === 'martin') {
      return m.syncPulse + m.syncPorch + m.channels * (m.sepPulse + m.scanTime);
    }
    // scottie: sync is carried inside the line, before the chanSync channel
    return m.syncPulse + m.channels * (m.sepPulse + m.scanTime);
  }

  /** Total signal duration in seconds, including the VIS header and trailing margin. */
  function totalDuration(m) {
    var lines = m.linePairs ? m.height / 2 : m.height;
    var body = lines * lineTime(m);
    if (m.hasStartSync) body += m.syncPulse;
    return VIS_HEADER_LEN + body + TAIL_SECONDS;
  }

  /** VIS bits in transmission order (LSB first), including the parity bit. */
  function visBits(m) {
    var v = m.vis;
    var ones = 0;
    var bits = [];
    for (var i = 0; i < 7; i++) {
      var b = (v >> i) & 1;
      bits.push(b);
      ones += b;
    }
    bits.push(ones % 2 === 0 ? 0 : 1); // even parity over all 8 bits
    return bits;
  }

  function get(id) {
    var m = MODES[id];
    if (!m) throw new Error('Unknown SSTV mode: ' + id);
    return m;
  }

  function list() {
    return Object.keys(MODES).map(function (k) { return MODES[k]; });
  }

  /** Decoder-side lookup: VIS value -> mode (only modes our decoder supports). */
  var DECODABLE = {};
  Object.keys(MODES).forEach(function (k) {
    if (MODES[k].id === 'M1' || MODES[k].id === 'S1' ||
        MODES[k].id === 'PD120' || MODES[k].id === 'PD180') DECODABLE[MODES[k].vis] = MODES[k];
  });

  return {
    FREQ_BLACK: FREQ_BLACK,
    FREQ_WHITE: FREQ_WHITE,
    FREQ_SYNC: FREQ_SYNC,
    FREQ_PORCH: FREQ_PORCH,
    COLOR_FREQ_MULT: COLOR_FREQ_MULT,
    VIS_LEADER_FREQ: VIS_LEADER_FREQ,
    VIS_LEADER_LEN: VIS_LEADER_LEN,
    VIS_BREAK_FREQ: VIS_BREAK_FREQ,
    VIS_BREAK_LEN: VIS_BREAK_LEN,
    VIS_START_LEN: VIS_START_LEN,
    VIS_BIT_LEN: VIS_BIT_LEN,
    VIS_ONE_FREQ: VIS_ONE_FREQ,
    VIS_ZERO_FREQ: VIS_ZERO_FREQ,
    VIS_STOP_LEN: VIS_STOP_LEN,
    VIS_HEADER_LEN: VIS_HEADER_LEN,
    TAIL_SECONDS: TAIL_SECONDS,
    MODES: MODES,
    DECODABLE: DECODABLE,
    YUV_PD: YUV_PD,
    get: get,
    list: list,
    lineTime: lineTime,
    totalDuration: totalDuration,
    visBits: visBits
  };
});
