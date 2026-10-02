/*
 * Payload carrier: one bit per horizontal block, carried by the block's MEAN.
 *
 * Why a block mean and not per-pixel QIM
 * --------------------------------------
 * Measured on the SSTV channel (scripts/measure-floor.js, measure-carrier.js):
 *
 *   - The clean-tier per-pixel luminance error is sigma ~ 7.0 grey levels (heavy
 *     tailed: p95 ~ 12, max > 100 at edges), i.e. the channel is only ~31 dB.
 *   - A single pixel therefore cannot carry a bit reliably. Per-pixel QIM needs a
 *     step of ~2.8 * 2 * sigma ~ 39 levels to reach a useful error rate, which
 *     costs ~21 dB of image quality. Ruled out by measurement.
 *   - The channel's per-pixel window is a low-pass ALONG the scan line that
 *     recovers only ~73% of any per-pixel displacement, and the loss is COHERENT
 *     across neighbouring pixels - so spreading a bit over K pixels and majority
 *     voting does NOT work (measured: K 64 -> 256 moved BER only 0.502 -> 0.487).
 *   - A block MEAN, however, behaves: measured sigma of the block-mean error falls
 *     as 1/sqrt(B) almost exactly as independent-error theory predicts
 *     (B=16: 0.274 measured vs 0.250 theory; B=64: 0.146 vs 0.125).
 *
 * So the carrier averages over a block. Blocks are HORIZONTAL because that is the
 * axis the SSTV window blurs along; rows are independent, so a vertical block would
 * not gain the same averaging.
 *
 * Encoding rule
 * -------------
 * The block mean is placed on a multiple of `delta` whose parity is the payload bit:
 *
 *     target = nearest multiple of delta to the block mean, with parity == bit
 *
 * The distance to that target is at most `delta` (NOT delta/2 - the correct-parity
 * grid is spaced 2*delta). An earlier version clamped the shift to +/-delta/2, which
 * left roughly half the blocks off their target grid point and their parity
 * deterministically wrong; that bug dominated the measured BER.
 *
 * Headroom
 * --------
 * Adding a constant to every pixel can push the block past 0/255, and clamping the
 * extremes would shrink the achieved mean shift. Instead of clamping the whole
 * block, the needed shift is distributed iteratively over the pixels that still have
 * headroom in the required direction, so the mean reaches its target whenever the
 * block's own dynamic range permits. Blocks that genuinely cannot reach a valid
 * target are reported as ERASURES, which the RS decoder can use.
 */
(function (root, factory) {
  var api = factory();
  root.PayloadQIM = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '0.2.0-phase2';
  var CHANNEL_OFFSET = { G: 1, B: 2, R: 0 };

  /** Nearest multiple of delta to `mean` with the requested parity. */
  /**
   * Nearest level on the correct-parity grid, and the ACTUAL achievable mean range of
   * the block it belongs to.
   *
   * The parity-correct grid is spaced 2*delta, so for a mean sitting exactly between two
   * candidates the tie must be broken toward the side the block can actually move to.
   * Passing the block's min/max (not just its mean) is what makes that possible: an
   * all-black block (min=max=mean=0) can only move UP, because every pixel already sits
   * at its lower clamp. Choosing -delta there (which the old mean-only tie-break did,
   * since |-delta| == |+delta|) made the block un-embeddable for no physical reason -
   * measured, this accounted for a constant 3.13% of blocks on EVERY image that carries
   * a black letterbox, and it was misread in phase 3 as a dynamic-range effect.
   *
   * @param {number} mean block mean, in grey levels
   * @param {number} mn   block minimum pixel value
   * @param {number} mx   block maximum pixel value
   * @returns {{target:number, reachable:boolean, lo:number, hi:number}}
   *   lo/hi = inclusive achievable mean range: [mean - mn, mean + (255 - mx)]
   */
  function targetForBlock(mean, bit, delta, mn, mx) {
    var loBound = mean - mn;             // lowering every pixel to 0
    var hiBound = mean + (255 - mx);     // raising every pixel to 255
    var L = Math.round(mean / delta);
    if ((L & 1) !== bit) {
      // two candidate levels; prefer the closer one, but never one outside the block's
      // achievable range if the other side is usable
      var up = L + 1, down = L - 1;
      var dUp = Math.abs(up * delta - mean), dDown = Math.abs(down * delta - mean);
      var upOk = (up * delta) >= loBound - 1e-9 && (up * delta) <= hiBound + 1e-9;
      var downOk = (down * delta) >= loBound - 1e-9 && (down * delta) <= hiBound + 1e-9;
      if (upOk && downOk) L = dDown <= dUp ? down : up;
      else if (upOk) L = up;
      else if (downOk) L = down;
      else L = dDown <= dUp ? down : up;   // neither reachable; caller will flag it
    } else if ((L * delta) < loBound - 1e-9 || (L * delta) > hiBound + 1e-9) {
      // the nearest correct-parity level itself lies outside the achievable range
      var cand = [];
      if (((L + 1) & 1) === bit) cand.push(L + 1);
      if (((L - 1) & 1) === bit) cand.push(L - 1);
      for (var c = 0; c < cand.length; c++) {
        var t = cand[c] * delta;
        if (t >= loBound - 1e-9 && t <= hiBound + 1e-9) { L = cand[c]; break; }
      }
    }
    var t2 = L * delta;
    var reachable = t2 >= loBound - 1e-9 && t2 <= hiBound + 1e-9;
    return { target: t2, reachable: reachable, lo: loBound, hi: hiBound };
  }

  /** Legacy mean-only signature kept for callers that have no min/max available. */
  function targetFor(mean, bit, delta) {
    return targetForBlock(mean, bit, delta, mean, mean).target;
  }

  function blockGeom(imageData, blockSize) {
    var w = imageData.width, h = imageData.height;
    var perLine = Math.floor(w / blockSize);
    return { perLine: perLine, blocks: perLine * h, usableCols: perLine * blockSize };
  }

  function capacity(imageData, opts) {
    var g = blockGeom(imageData, (opts && opts.blockSize) || 32);
    return { bits: g.blocks, bytes: Math.floor(g.blocks / 8) };
  }

  /**
   * Dry-run reliability probe: how many blocks COULD NOT carry a bit?
   *
   * This modifies nothing and needs no payload, because reachability can be evaluated for
   * both bit values independently and averaged - a real payload only ever asks for one of
   * them, so the average is exactly the probability that a uniformly random bit fails.
   *
   * The point is to answer "will this image work?" BEFORE transmitting, in one cheap pass
   * (the app runs it on the raster it is about to send). It also returns the source
   * statistics used by the content-dependence model, so the UI can explain WHY.
   *
   * @returns {{blocks:number, unreachableFrac:number, unreachableBit0Frac:number,
   *            unreachableBit1Frac:number, meanBlockRange:number,
   *            hfRatio:number, gradX:number, mean:number}}
   */
  function probe(imageData, opts) {
    opts = opts || {};
    var blockSize = opts.blockSize || 32;
    var delta = opts.delta || 8;
    var off = opts.channel == null ? 1 : opts.channel;
    var g = blockGeom(imageData, blockSize);
    var w = imageData.width, d = imageData.data;

    var bad0 = 0, bad1 = 0, rangeSum = 0, blocks = 0;
    var gradSum = 0, gradN = 0, hfE = 0, totE = 0, sumAll = 0, nAll = 0;

    for (var line = 0; line < imageData.height; line++) {
      for (var blk = 0; blk < g.perLine; blk++) {
        var sum = 0, mn = 255, mx = 0;
        for (var k = 0; k < blockSize; k++) {
          var v = d[(line * w + blk * blockSize + k) * 4 + off];
          sum += v;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          if (k > 0) {
            var pv = d[(line * w + blk * blockSize + k - 1) * 4 + off];
            var dv = v - pv;
            gradSum += Math.abs(dv); hfE += dv * dv; gradN++;
          }
          totE += v * v; sumAll += v; nAll++;
        }
        var mean = sum / blockSize;
        if (!targetForBlock(mean, 0, delta, mn, mx).reachable) bad0++;
        if (!targetForBlock(mean, 1, delta, mn, mx).reachable) bad1++;
        rangeSum += mx - mn;
        blocks++;
      }
    }
    return {
      blocks: blocks,
      unreachableBit0Frac: blocks ? bad0 / blocks : 0,
      unreachableBit1Frac: blocks ? bad1 / blocks : 0,
      unreachableFrac: blocks ? (bad0 + bad1) / (2 * blocks) : 0,
      meanBlockRange: blocks ? rangeSum / blocks : 0,
      gradX: gradN ? gradSum / gradN : 0,
      hfRatio: totE ? hfE / totE : 0,
      mean: nAll ? sumAll / nAll : 0
    };
  }

  /**
   * Move a block's integer SUM by exactly `diff`, distributing the change as unit
   * steps over pixels that have headroom.
   *
   * Integer arithmetic is deliberate. An earlier version distributed a fractional
   * step and wrote it straight into the Uint8ClampedArray - but that array ROUNDS
   * every store to an integer, so a step of e.g. 0.09 moved nothing at all, ~87% of
   * blocks reported "unreachable", and the measured BER was pinned at 0.5 simply
   * because the image had not been modified. Working in unit increments makes the
   * result exact and the feasibility test honest.
   *
   * @returns {number} units that could NOT be placed (0 = target reached exactly)
   */
  function shiftBlockSum(data, width, y, x0, blockSize, off, diff) {
    if (!diff) return 0;
    var dir = diff > 0 ? 1 : -1;
    var remaining = Math.abs(diff);
    var i, o, v, can;

    // pass 1: give every pixel the same share, limited by its own headroom
    var share = Math.floor(remaining / blockSize);
    if (share > 0) {
      for (i = 0; i < blockSize && remaining > 0; i++) {
        o = (y * width + x0 + i) * 4 + off;
        v = data[o];
        can = dir > 0 ? 255 - v : v;
        var give = Math.min(share, can, remaining);
        data[o] = v + dir * give;
        remaining -= give;
      }
    }

    // pass 2: place the remainder one unit at a time, round-robin over free pixels
    var guard = 0;
    while (remaining > 0 && guard++ < blockSize * 4) {
      var placed = 0;
      for (i = 0; i < blockSize && remaining > 0; i++) {
        o = (y * width + x0 + i) * 4 + off;
        v = data[o];
        can = dir > 0 ? 255 - v : v;
        if (can > 0) { data[o] = v + dir; remaining--; placed++; }
      }
      if (!placed) break;   // genuinely out of headroom
    }
    return remaining;
  }

  /**
   * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
   * @param {Uint8Array} bits
   * @param {{blockSize?: number, delta?: number, channel?: string}} [opts]
   * @returns {{imageData: object, erasures: Uint8Array, unreachable: number, maxShift: number}}
   */
  function embed(imageData, bits, opts) {
    opts = opts || {};
    var blockSize = opts.blockSize || 32;
    var delta = opts.delta || 8;
    var off = CHANNEL_OFFSET[opts.channel || 'G'];
    var g = blockGeom(imageData, blockSize);
    var out = {
      data: new Uint8ClampedArray(imageData.data),
      width: imageData.width,
      height: imageData.height
    };
    var erasures = new Uint8Array(bits.length);
    var unreachable = 0, maxShift = 0;

    for (var j = 0; j < bits.length && j < g.blocks; j++) {
      var y = Math.floor(j / g.perLine);
      var x0 = (j % g.perLine) * blockSize;

      var sum = 0, mn = 255, mx = 0;
      for (var k = 0; k < blockSize; k++) {
        var pv = out.data[(y * out.width + x0 + k) * 4 + off];
        sum += pv;
        if (pv < mn) mn = pv;
        if (pv > mx) mx = pv;
      }

      var tf = targetForBlock(sum / blockSize, bits[j], delta, mn, mx);
      var target = tf.target;
      // work in integer sums so the achieved mean is exact
      var targetSum = Math.round(target * blockSize);
      var diff = targetSum - sum;

      var leftover = shiftBlockSum(out.data, out.width, y, x0, blockSize, off, diff);
      if (leftover || !tf.reachable) {
        erasures[j] = 1;
        unreachable++;
      }

      var finalSum = 0;
      for (var s = 0; s < blockSize; s++) finalSum += out.data[(y * out.width + x0 + s) * 4 + off];
      var shift = Math.abs(finalSum / blockSize - sum / blockSize);
      if (shift > maxShift) maxShift = shift;
    }

    return { imageData: out, erasures: erasures, unreachable: unreachable, maxShift: maxShift };
  }

  /**
   * Hard decisions from the received block means, with a per-bit soft value and an
   * erasure flag.
   *
   * `soft` is the distance from the received mean to its nearest level, in units of
   * a level (0 = exactly on a level, 0.5 = exactly on a decision boundary). A large
   * soft value means the bit is close to flipping, which is exactly what an erasure
   * should mark - the decoder cannot know the encoder's headroom, so this is the
   * honest, receiver-side confidence measure.
   */
  function extract(imageData, nBits, opts) {
    opts = opts || {};
    var blockSize = opts.blockSize || 32;
    var delta = opts.delta || 8;
    var off = CHANNEL_OFFSET[opts.channel || 'G'];
    var erasureSoft = opts.erasureSoft == null ? 0.30 : opts.erasureSoft;
    var g = blockGeom(imageData, blockSize);

    var bits = new Uint8Array(nBits);
    var soft = new Float32Array(nBits);
    var erasures = new Uint8Array(nBits);

    for (var j = 0; j < nBits; j++) {
      if (j >= g.blocks) { bits[j] = 0; soft[j] = 0.5; erasures[j] = 1; continue; }
      var y = Math.floor(j / g.perLine);
      var x0 = (j % g.perLine) * blockSize;
      var sum = 0;
      for (var k = 0; k < blockSize; k++) sum += imageData.data[(y * imageData.width + x0 + k) * 4 + off];
      var q = (sum / blockSize) / delta;
      var L = Math.round(q);
      bits[j] = L & 1;
      soft[j] = Math.abs(q - L);
      if (soft[j] > erasureSoft) erasures[j] = 1;
    }
    return { bits: bits, soft: soft, erasures: erasures };
  }

  /** Distance-to-threshold in level units is a natural soft metric for FEC. */
  function softToLlr(soft, bit) {
    // Positive LLR favours bit=1. Near a boundary (soft -> 0.5) the magnitude -> 0.
    var mag = (0.5 - soft) * 2;
    return (bit ? 1 : -1) * Math.max(0, mag);
  }

  return {
    VERSION: VERSION,
    embed: embed,
    extract: extract,
    capacity: capacity,
    probe: probe,
    targetFor: targetFor,
    targetForBlock: targetForBlock,
    softToLlr: softToLlr,
    _internal: { blockGeom: blockGeom, CHANNEL_OFFSET: CHANNEL_OFFSET }
  };
});
