/*
 * Block interleaver - turns burst errors into spread errors.
 *
 * Layout
 * ------
 * Symbols are written ROW-WISE into a depth x codewordLength matrix and read
 * COLUMN-WISE:
 *
 *     input index  = row * N + col
 *     output index = col * D + row
 *
 * Consequence: consecutive symbols in the CHANNEL belong to D different codewords.
 * A channel burst of length b therefore deposits at most ceil(b / D) errors in any
 * one codeword (measured by tests/interleaver.test.js, not assumed).
 *
 * Why the matrix must be aligned to WHOLE codewords
 * -------------------------------------------------
 * Interleaving symbols WITHIN a codeword does nothing: RS counts errors, it does not
 * care where in the codeword they sit, so permuting one codeword's own symbols
 * leaves its error count unchanged. Spreading must be ACROSS codewords, so the row
 * width IS the codeword length. (The phase-2 spec suggested blockSize=64 with
 * depth=8; that gives ceil(100/8) = 13 errors per codeword, which does NOT meet the
 * "<5 bytes per codeword for a 100-byte burst" acceptance criterion. Depth 32 does:
 * ceil(100/32) = 4. See requiredDepth().)
 *
 * Depth is bounded by the payload
 * -------------------------------
 * A depth-D interleaver needs D codewords present. The measured payload capacity of
 * the SSTV side channel is a few hundred bytes, i.e. only a handful of 255-byte
 * codewords, so the achievable depth in the end-to-end chain is much smaller than 32.
 * capacityDepthInfo() reports this honestly instead of pretending otherwise.
 */
(function (root, factory) {
  var api = factory();
  root.Interleaver = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '0.1.0-phase2';
  var DEFAULTS = { depth: 32, codewordLength: 255 };

  var cfg = { depth: DEFAULTS.depth, codewordLength: DEFAULTS.codewordLength };

  /**
   * Set the geometry. `blockSize` is accepted as an alias for codewordLength so the
   * names used in the phase-2 spec keep working.
   */
  function configure(opts) {
    opts = opts || {};
    var n = opts.codewordLength != null ? opts.codewordLength
          : (opts.blockSize != null ? opts.blockSize : cfg.codewordLength);
    var d = opts.depth != null ? opts.depth : cfg.depth;
    if (!(n > 0) || !(d > 0)) throw new Error('depth and codewordLength must be positive');
    cfg.depth = d | 0;
    cfg.codewordLength = n | 0;
    return { depth: cfg.depth, codewordLength: cfg.codewordLength, blockBytes: cfg.depth * cfg.codewordLength };
  }

  function geometry(opts) {
    if (!opts) return { depth: cfg.depth, codewordLength: cfg.codewordLength };
    var n = opts.codewordLength != null ? opts.codewordLength
          : (opts.blockSize != null ? opts.blockSize : cfg.codewordLength);
    var d = opts.depth != null ? opts.depth : cfg.depth;
    return { depth: d | 0, codewordLength: n | 0 };
  }

  /**
   * Interleave. Complete depth x N blocks are transposed; any trailing partial block
   * is copied through unchanged (documented, and it carries no burst protection).
   */
  function interleave(bytes, opts) {
    var g = geometry(opts);
    var D = g.depth, N = g.codewordLength;
    var block = D * N;
    var out = new Uint8Array(bytes.length);
    var full = Math.floor(bytes.length / block) * block;
    for (var base = 0; base < full; base += block) {
      for (var row = 0; row < D; row++) {
        for (var col = 0; col < N; col++) {
          out[base + col * D + row] = bytes[base + row * N + col];
        }
      }
    }
    for (var i = full; i < bytes.length; i++) out[i] = bytes[i];
    return out;
  }

  /** Exact inverse of interleave(). */
  function deinterleave(bytes, opts) {
    var g = geometry(opts);
    var D = g.depth, N = g.codewordLength;
    var block = D * N;
    var out = new Uint8Array(bytes.length);
    var full = Math.floor(bytes.length / block) * block;
    for (var base = 0; base < full; base += block) {
      for (var row = 0; row < D; row++) {
        for (var col = 0; col < N; col++) {
          out[base + row * N + col] = bytes[base + col * D + row];
        }
      }
    }
    for (var i = full; i < bytes.length; i++) out[i] = bytes[i];
    return out;
  }

  /** Worst-case errors a burst of `burstLen` channel symbols puts in one codeword. */
  function burstErrorsPerCodeword(burstLen, opts) {
    var g = geometry(opts);
    return Math.ceil(burstLen / g.depth);
  }

  /** Minimum depth so that a burst of `burstLen` stays within `maxPerCodeword`. */
  function requiredDepth(burstLen, maxPerCodeword) {
    if (!(maxPerCodeword > 0)) throw new Error('maxPerCodeword must be positive');
    return Math.ceil(burstLen / maxPerCodeword);
  }

  /**
   * Per-codeword error counts for a given channel error mask (before interleaving).
   * Used by the tests and the evaluation report to quantify burst spreading.
   */
  function analyzeSpread(errorMask, opts) {
    var g = geometry(opts);
    var D = g.depth, N = g.codewordLength;
    var deint = deinterleave(Uint8Array.from(errorMask, function (v) { return v ? 1 : 0; }), opts);
    var counts = new Array(D).fill(0);
    var block = D * N;
    var full = Math.floor(deint.length / block) * block;
    for (var base = 0; base < full; base += block) {
      for (var row = 0; row < D; row++) {
        var c = 0;
        for (var col = 0; col < N; col++) if (deint[base + row * N + col]) c++;
        counts[row] += c;
      }
    }
    var worst = 0;
    for (var k = 0; k < counts.length; k++) if (counts[k] > worst) worst = counts[k];
    return { perCodeword: counts, worst, blocks: full / block };
  }

  /** How much depth is actually usable for a payload of `payloadBytes`. */
  function capacityDepthInfo(payloadBytes, codewordLength) {
    var N = codewordLength || cfg.codewordLength;
    var codewords = Math.max(1, Math.floor(payloadBytes / N));
    return {
      codewordLength: N,
      codewords: codewords,
      maxUsefulDepth: codewords,
      note: 'Depth cannot exceed the number of codewords in the payload; a small ' +
            'payload therefore gets less burst protection than the nominal depth.'
    };
  }

  return {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    configure: configure,
    getConfig: function () { return { depth: cfg.depth, codewordLength: cfg.codewordLength }; },
    interleave: interleave,
    deinterleave: deinterleave,
    burstErrorsPerCodeword: burstErrorsPerCodeword,
    requiredDepth: requiredDepth,
    analyzeSpread: analyzeSpread,
    capacityDepthInfo: capacityDepthInfo
  };
});
