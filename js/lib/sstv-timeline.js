/*
 * Image -> SSTV frequency timeline.
 *
 * This stage deliberately knows NOTHING about audio samples: it only produces
 * "what frequency should be transmitted over what time span". Turning that into
 * samples is sstv-synth.js's job, and the gap between the two is the hook where
 * phase 2 (LDPC coding + image hiding) will inject its channel layer.
 *
 * Timeline shape:
 *   {
 *     mode, width, height,
 *     segments: [ {kind:'tone', freq, dur}
 *               | {kind:'scan', dur, freqs:Float32Array} ],   // freqs in Hz, one per pixel
 *     duration,      // seconds (excluding any lead-in silence)
 *     pixelCount     // number of modulated pixels (phase-2 capacity input)
 *   }
 *
 * Colours: GBR modes transmit G, B, R in that order (both reference
 * implementations agree). PD modes transmit Y, RY, BY, Y with chroma averaged
 * across each line pair.
 *
 * NOTE on PD colour mapping: Web-SSTV's PD Y term carries a +6 offset
 * (Y = 6 + (...)/256) so white lands near 2206 Hz instead of 2300 Hz, costing
 * contrast. We use the clean BT.601 mapping instead. PD decoding is not in this
 * phase's scope, and encode/decode stay self-consistent either way.
 */
(function (root, factory) {
  var api = factory(root.SSTVModes);
  root.SSTVTimeline = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes) {
  'use strict';

  function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }
  function toFreq(v) { return Modes.FREQ_BLACK + clamp255(v) * Modes.COLOR_FREQ_MULT; }

  function tone(freq, dur) { return { kind: 'tone', freq: freq, dur: dur }; }

  /** VIS calibration header as timeline segments. */
  function headerSegments(mode) {
    var segs = [];
    segs.push(tone(Modes.VIS_LEADER_FREQ, Modes.VIS_LEADER_LEN));
    segs.push(tone(Modes.VIS_BREAK_FREQ, Modes.VIS_BREAK_LEN));
    segs.push(tone(Modes.VIS_LEADER_FREQ, Modes.VIS_LEADER_LEN));
    segs.push(tone(Modes.VIS_BREAK_FREQ, Modes.VIS_START_LEN)); // VIS start bit
    var bits = Modes.visBits(mode);
    for (var i = 0; i < bits.length; i++) {
      segs.push(tone(bits[i] ? Modes.VIS_ONE_FREQ : Modes.VIS_ZERO_FREQ, Modes.VIS_BIT_LEN));
    }
    segs.push(tone(Modes.VIS_BREAK_FREQ, Modes.VIS_STOP_LEN)); // VIS stop bit
    return segs;
  }

  /**
   * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
   *        Must already be exactly mode.width x mode.height.
   * @param {object} mode  entry from SSTVModes
   * @returns {object} timeline
   */
  function build(imageData, mode) {
    if (!imageData || !imageData.data) throw new Error('build() needs an ImageData-like object');
    if (imageData.width !== mode.width || imageData.height !== mode.height) {
      throw new Error(
        'Image must be exactly ' + mode.width + 'x' + mode.height +
        ' for ' + mode.name + ' (got ' + imageData.width + 'x' + imageData.height + ')'
      );
    }

    var px = imageData.data;
    var W = mode.width;
    var H = mode.height;
    var header = headerSegments(mode);
    var segs = header.slice();

    // Per-channel frequency rows for one line (GBR modes)
    function rgbRows(y) {
      var g = new Float32Array(W), b = new Float32Array(W), r = new Float32Array(W);
      var base = y * W * 4;
      for (var x = 0; x < W; x++) {
        var i = base + x * 4;
        g[x] = toFreq(px[i + 1]);
        b[x] = toFreq(px[i + 2]);
        r[x] = toFreq(px[i]);
      }
      return { G: g, B: b, R: r };
    }

    // Y / RY / BY rows for one line, as 0..255 component values (PD modes).
    // Kept as values so line-pair chroma averaging is a plain average.
    function yuvRows(y) {
      var Y = new Float32Array(W), RY = new Float32Array(W), BY = new Float32Array(W);
      var base = y * W * 4;
      for (var x = 0; x < W; x++) {
        var i = base + x * 4;
        var r = px[i], g = px[i + 1], b = px[i + 2];
        Y[x] = clamp255(0.299 * r + 0.587 * g + 0.114 * b);
        RY[x] = clamp255(128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256);
        BY[x] = clamp255(128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256);
      }
      return { Y: Y, RY: RY, BY: BY };
    }

    /** Map a 0..255 component row to a frequency row. */
    function rowToFreq(row) {
      var out = new Float32Array(row.length);
      for (var i = 0; i < row.length; i++) out[i] = toFreq(row[i]);
      return out;
    }

    var pixelCount = 0;

    if (mode.structure === 'pd') {
      for (var p = 0; p < H; p += 2) {
        var a = yuvRows(p);
        var c = yuvRows(p + 1);
        // Chroma is shared across the line pair: average RY and BY
        var RYa = new Float32Array(W), BYa = new Float32Array(W);
        for (var x2 = 0; x2 < W; x2++) {
          RYa[x2] = (a.RY[x2] + c.RY[x2]) / 2;
          BYa[x2] = (a.BY[x2] + c.BY[x2]) / 2;
        }
        segs.push(tone(Modes.FREQ_SYNC, mode.syncPulse));
        segs.push(tone(Modes.FREQ_PORCH, mode.blanking));
        segs.push({ kind: 'scan', dur: mode.scanTime, freqs: rowToFreq(a.Y) });
        segs.push({ kind: 'scan', dur: mode.scanTime, freqs: rowToFreq(RYa) });
        segs.push({ kind: 'scan', dur: mode.scanTime, freqs: rowToFreq(BYa) });
        segs.push({ kind: 'scan', dur: mode.scanTime, freqs: rowToFreq(c.Y) });
        pixelCount += 4 * W;
      }
    } else if (mode.structure === 'scottie') {
      segs.push(tone(Modes.FREQ_SYNC, mode.syncPulse)); // single leading sync
      for (var y = 0; y < H; y++) {
        var rows = rgbRows(y);
        for (var ci = 0; ci < mode.scanOrder.length; ci++) {
          if (ci === mode.chanSync) segs.push(tone(Modes.FREQ_SYNC, mode.syncPulse));
          segs.push(tone(Modes.FREQ_PORCH, mode.sepPulse));
          segs.push({ kind: 'scan', dur: mode.scanTime, freqs: rows[mode.scanOrder[ci]] });
          pixelCount += W;
        }
      }
    } else { // martin
      for (var ym = 0; ym < H; ym++) {
        var r2 = rgbRows(ym);
        segs.push(tone(Modes.FREQ_SYNC, mode.syncPulse));
        segs.push(tone(Modes.FREQ_PORCH, mode.syncPorch));
        for (var cj = 0; cj < mode.scanOrder.length; cj++) {
          segs.push({ kind: 'scan', dur: mode.scanTime, freqs: r2[mode.scanOrder[cj]] });
          segs.push(tone(Modes.FREQ_PORCH, mode.sepPulse));
          pixelCount += W;
        }
      }
    }

    var duration = 0;
    for (var s = 0; s < segs.length; s++) duration += segs[s].dur;

    // Trailing margin so the final pixel's analysis window fits inside the buffer
    // (see TAIL_SECONDS in sstv-modes.js).
    segs.push(tone(Modes.FREQ_PORCH, Modes.TAIL_SECONDS));
    duration += Modes.TAIL_SECONDS;

    return {
      mode: mode.id,
      modeName: mode.name,
      width: W,
      height: H,
      colorSpace: mode.colorSpace,
      segments: segs,
      // Number of leading segments that form the VIS calibration header. Consumers
      // (e.g. capacity accounting) use this to analyse only the image body; the
      // header contains 1200 Hz segments that are not line syncs.
      headerSegments: header.length,
      duration: duration,
      pixelCount: pixelCount,
      vis: mode.vis
    };
  }

  return { build: build, headerSegments: headerSegments };
});
