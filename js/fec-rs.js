/*
 * Reed-Solomon FEC over GF(2^8) - systematic, errors AND erasures.
 *
 * Why GF(2^8)
 * -----------
 * The requested code sizes are RS(255,223) and RS(255,191): N = 255 symbols, i.e.
 * one byte per symbol. GF(2^8) makes each symbol a byte, needs only two 256-entry
 * tables, and keeps the code roughly a third the size of a GF(2^16) implementation.
 * GF(2^16) only pays off when a block is large enough that the number of codewords
 * matters - our payload is a handful of codewords, so it buys nothing.
 *
 * Conventions (chosen to match Python's `reedsolo` defaults so the implementation can
 * be cross-checked against an independent library):
 *   primitive polynomial 0x11D, generator alpha = 2, first consecutive root fcr = 0.
 *   Codeword = [K message bytes][nsym parity bytes], message first.
 *
 * Why errors AND erasures
 * -----------------------
 * The carrier (js/payload-qim.js) reports a per-bit confidence: a block whose mean
 * landed near a decision boundary is flagged as an erasure. Throwing that away and
 * treating every bad symbol as an unknown-position error would waste half the
 * correcting power (2e + f <= nsym). The phase-1 demodulator's per-pixel confidence
 * output exists for exactly this purpose.
 *
 * Decoder structure
 * -----------------
 *   1. syndromes
 *   2. erasure locator from the known erasure positions
 *   3. Forney syndromes (removes the erasures from the problem)
 *   4. Berlekamp-Massey on the Forney syndromes -> ERROR locator only
 *   5. full locator = error locator * erasure locator; Chien search its roots
 *   6. magnitudes by solving the syndrome equations as a linear system over GF(256)
 *      (Gauss-Jordan) instead of the Forney formula
 *   7. verify by recomputing the syndromes
 *
 * Step 6 is deliberate: once the positions are known the magnitudes are a linear
 * problem, and Gauss-Jordan on a <= 32x32 system is both trivial to implement
 * correctly and easy to cross-check. It removes the Forney-formula convention
 * (signs, derivative, locator ordering) that is the usual source of silent
 * mis-correction in hand-written RS decoders.
 *
 * IMPORTANT: RS can MIS-CORRECT when the true error count exceeds the bound. Step 7
 * catches most cases, but the correct engineering answer is that a frame CRC must
 * always be present. This module never claims success without the syndrome check.
 */
(function (root, factory) {
  var api = factory();
  root.FECRS = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '0.1.0-phase2';
  var PRIM = 0x11D;   // x^8 + x^4 + x^3 + x^2 + 1
  var FCR = 0;
  var MAX_N = 255;

  // ------------------------------------------------------------------ GF(2^8)
  var EXP = new Uint8Array(512);   // alpha^i, doubled to avoid modular reduction in mul
  var LOG = new Int16Array(256);
  (function initTables() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= PRIM;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
    LOG[0] = -1; // undefined, guarded by callers
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }
  function gfDiv(a, b) {
    if (b === 0) throw new Error('GF division by zero');
    if (a === 0) return 0;
    return EXP[(LOG[a] - LOG[b] + 255) % 255];
  }
  function gfPow(a, n) {
    if (a === 0) return 0;
    var e = (LOG[a] * (n % 255)) % 255;
    if (e < 0) e += 255;
    return EXP[e];
  }
  function gfInv(a) { return gfDiv(1, a); }

  // ------------------------------------------------------------------ polynomials
  /** Coefficients are stored highest-degree first, as in reedsolo. */
  function polyMul(p, q) {
    var r = new Uint8Array(p.length + q.length - 1);
    for (var i = 0; i < p.length; i++) {
      if (!p[i]) continue;
      for (var j = 0; j < q.length; j++) {
        if (!q[j]) continue;
        r[i + j] ^= gfMul(p[i], q[j]);
      }
    }
    return r;
  }

  function polyEval(p, x) {
    var y = p[0];
    for (var i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
    return y;
  }

  /** Generator polynomial g(x) = prod_{i=0}^{nsym-1} (x - alpha^(i+FCR)). */
  var genCache = {};
  function generator(nsym) {
    if (genCache[nsym]) return genCache[nsym];
    var g = new Uint8Array([1]);
    for (var i = 0; i < nsym; i++) {
      g = polyMul(g, new Uint8Array([1, gfPow(2, i + FCR)]));
    }
    genCache[nsym] = g;
    return g;
  }

  // ------------------------------------------------------------------ encode
  /**
   * @param {Uint8Array|number[]} srcBytes  message, length K
   * @param {number} nsym                   number of parity bytes (N - K)
   * @returns {Uint8Array} length K + nsym, message followed by parity
   */
  function encode(srcBytes, nsym) {
    if (!(nsym > 0)) throw new Error('nsym must be > 0');
    var k = srcBytes.length;
    var n = k + nsym;
    if (n > MAX_N) {
      throw new Error('codeword too long: K + nsym = ' + n + ' exceeds ' + MAX_N + ' (shorten the message)');
    }
    var msg = Uint8Array.from(srcBytes);
    var out = new Uint8Array(n);
    out.set(msg, 0);

    var g = generator(nsym);
    // systematic remainder: divide msg(x)*x^nsym by g(x)
    for (var i = 0; i < k; i++) {
      var coef = out[i];
      if (coef === 0) continue;
      for (var j = 0; j < g.length; j++) {
        out[i + j] ^= gfMul(g[j], coef);
      }
    }
    out.set(msg, 0);              // restore the message (the loop consumed it)
    return out;
  }

  // ------------------------------------------------------------------ syndromes
  function syndromes(cw, nsym) {
    var s = new Uint8Array(nsym);
    for (var i = 0; i < nsym; i++) {
      s[i] = polyEval(cw, gfPow(2, i + FCR));
    }
    return s;
  }

  function allZero(a) {
    for (var i = 0; i < a.length; i++) if (a[i]) return false;
    return true;
  }

  /*
   * ------------------------------------------------------------------
   * TWO coefficient orders are in play, and mixing them is the classic way to
   * write an RS decoder that looks right and never works:
   *
   *   - The CODEWORD polynomial is stored HIGHEST-degree first (cw[0] is the
   *     coefficient of x^(n-1)), matching reedsolo. polyEval() Horner-evaluates in
   *     that order, and syndromes()/solveMagnitudes() assume it.
   *   - LOCATOR polynomials are stored LOWEST-degree first (loc[0] = 1 is the
   *     constant term), because Berlekamp-Massey and the erasure-locator product are
   *     naturally written that way (Lambda(x) = 1 + l1 x + l2 x^2 + ...).
   *
   * Convolution has the same formula in both orders, so polyMul serves both; only
   * EVALUATION differs, hence the separate evalLow().
   * ------------------------------------------------------------------
   */

  /** Evaluate a LOWEST-first polynomial at x. */
  function evalLow(p, x) {
    var y = 0;
    for (var i = p.length - 1; i >= 0; i--) y = gfMul(y, x) ^ p[i];
    return y;
  }

  function trimTrailing(p) {
    var end = p.length;
    while (end > 1 && p[end - 1] === 0) end--;
    return end === p.length ? p : Uint8Array.from(p.subarray(0, end));
  }

  /*
   * Locator convention - derived, not copied.
   *
   * With syndromes S_j = sum_k Y_k * V_k^j where V_k = alpha^(n-1-p_k), we need a
   * locator whose coefficients annihilate the erasures:
   *
   *     Lambda(x) = prod_k (1 + V_k^-1 x)      =>   sum_i lambda_i S_{j+i} = 0
   *
   * because sum_i lambda_i S_{j+i} = sum_k Y_k V_k^j * Lambda(V_k), and
   * Lambda(V_k) contains the factor (1 + V_k^-1 V_k) = 0.
   *
   * Building the locator from V_k instead of V_k^-1 (as an earlier version did) gives
   * a polynomial that does NOT annihilate the erasures, so the Forney syndromes were
   * meaningless. Note the knock-on effect on the root search: the roots of this
   * Lambda sit at x = V_k, so Chien search must EVALUATE at V_i, not at V_i^-1.
   */
  function locatorX(n, position) {
    return gfInv(gfPow(2, n - 1 - position));
  }

  /** Erasure locator Lambda_e(x) = prod (1 + V_k^-1 x), LOWEST-first. */
  function erasureLocator(erasePos, n) {
    var loc = new Uint8Array([1]);
    for (var e = 0; e < erasePos.length; e++) {
      loc = polyMul(loc, new Uint8Array([1, locatorX(n, erasePos[e])]));
    }
    return loc;
  }

  /**
   * Forney syndromes: S'_j = sum_k lambda_k * S_{j+k}.
   * Removes the known erasures so that Berlekamp-Massey only has to find ERRORS.
   */
  function forneySyndromes(syn, eloc, nErasures) {
    if (!nErasures) return Uint8Array.from(syn);
    var out = new Uint8Array(Math.max(0, syn.length - nErasures));
    for (var i = 0; i < out.length; i++) {
      var acc = 0;
      for (var j = 0; j < eloc.length; j++) {
        if (eloc[j] && i + j < syn.length) acc ^= gfMul(eloc[j], syn[i + j]);
      }
      out[i] = acc;
    }
    return out;
  }

  // ------------------------------------------------------------------ Berlekamp-Massey
  /** out = a - coef * x^shift * b   (LOWEST-first, subtraction is XOR). */
  function subShift(a, b, coef, shift) {
    var len = Math.max(a.length, b.length + shift);
    var out = new Uint8Array(len);
    out.set(a, 0);
    for (var j = 0; j < b.length; j++) out[j + shift] ^= gfMul(coef, b[j]);
    return out;
  }

  /**
   * Textbook Berlekamp-Massey (Massey's formulation), LOWEST-first.
   *
   * NOTE ON INPUT ORDER: BM solves the BACKWARD recurrence
   *     sum_i Lambda_i * S[n-i] = 0
   * whereas the key equation our locator satisfies (see locatorX) is the FORWARD one
   *     sum_i lambda_i * S[j+i] = 0
   * The two locators are reciprocals of each other. Reversing the syndrome sequence
   * before BM turns one into the other, so callers must pass REVERSED syndromes.
   * (An earlier version passed them in natural order, which is why errors failed
   * while erasures - whose locator comes from our own forward construction - passed.)
   */
  function berlekampMassey(syn) {
    var L = 0;
    var loc = new Uint8Array([1]);
    var B = new Uint8Array([1]);
    var b = 1;
    var m = 1;

    for (var n = 0; n < syn.length; n++) {
      var d = syn[n];
      for (var i = 1; i <= L; i++) {
        if (i < loc.length && n - i >= 0) d ^= gfMul(loc[i], syn[n - i]);
      }
      if (d === 0) { m++; continue; }

      if (2 * L <= n) {
        var T = loc;
        loc = subShift(loc, B, gfDiv(d, b), m);
        L = n + 1 - L;
        B = T;
        b = d;
        m = 1;
      } else {
        loc = subShift(loc, B, gfDiv(d, b), m);
        m++;
      }
    }
    return trimTrailing(loc);
  }

  /** Roots of the LOWEST-first locator -> symbol positions (see locatorX). */
  function chienSearch(loc, n) {
    var pos = [];
    for (var i = 0; i < n; i++) {
      var V = gfPow(2, n - 1 - i);
      if (evalLow(loc, V) === 0) pos.push(i);
    }
    return pos;
  }

  // ------------------------------------------------------------------ GF linear solve
  /** Solve A x = b over GF(256); A is m x m, returns null if singular. */
  function solveGF(A, b, m) {
    var M = [];
    for (var i = 0; i < m; i++) {
      M.push(Uint8Array.from(A[i]).slice ? Uint8Array.from(A[i]) : A[i]);
    }
    var aug = [];
    for (var r = 0; r < m; r++) {
      var row = new Uint8Array(m + 1);
      row.set(A[r], 0);
      row[m] = b[r];
      aug.push(row);
    }
    for (var col = 0; col < m; col++) {
      var piv = -1;
      for (var rr = col; rr < m; rr++) if (aug[rr][col]) { piv = rr; break; }
      if (piv < 0) return null;
      var tmp = aug[col]; aug[col] = aug[piv]; aug[piv] = tmp;
      var inv = gfInv(aug[col][col]);
      for (var c = col; c <= m; c++) aug[col][c] = gfMul(aug[col][c], inv);
      for (var r2 = 0; r2 < m; r2++) {
        if (r2 === col) continue;
        var f = aug[r2][col];
        if (!f) continue;
        for (var c2 = col; c2 <= m; c2++) aug[r2][c2] ^= gfMul(f, aug[col][c2]);
      }
    }
    var x = new Uint8Array(m);
    for (var k = 0; k < m; k++) x[k] = aug[k][m];
    return x;
  }

  /** Error magnitudes for the known positions, from the first `count` syndromes. */
  function solveMagnitudes(syn, positions, n) {
    var m = positions.length;
    if (m === 0) return new Uint8Array(0);
    if (m > syn.length) return null;
    var A = [], b = new Uint8Array(m);
    // S_j = sum_k Y_k * X_k^j
    for (var j = 0; j < m; j++) {
      var row = new Uint8Array(m);
      for (var k = 0; k < m; k++) {
        var X = gfPow(2, n - 1 - positions[k]);
        row[k] = gfPow(X, j);
      }
      A.push(row);
      b[j] = syn[j];
    }
    return solveGF(A, b, m);
  }

  // ------------------------------------------------------------------ decode
  /**
   * @param {Uint8Array|number[]} encodedBytes  received codeword, length N
   * @param {number} k                          message length
   * @param {number} nsym                       parity length
   * @param {Uint8Array|number[]} [erasures]    length N, 1 marks a symbol as erased
   * @returns {{success:true, srcBytes:Uint8Array, corrected:number, erasures:number}
   *          |{success:false, reason:string}}
   */
  function decode(encodedBytes, k, nsym, erasures) {
    var n = k + nsym;
    if (encodedBytes.length !== n) {
      return { success: false, reason: 'length mismatch: got ' + encodedBytes.length + ', expected ' + n };
    }
    if (n > MAX_N) return { success: false, reason: 'codeword too long' };

    var r = Uint8Array.from(encodedBytes);
    var erasePos = [];
    if (erasures) {
      for (var i = 0; i < n; i++) if (erasures[i]) erasePos.push(i);
    }
    if (erasePos.length > nsym) {
      return { success: false, reason: 'more erasures (' + erasePos.length + ') than parity symbols (' + nsym + ')' };
    }

    var syn = syndromes(r, nsym);
    if (allZero(syn)) {
      return { success: true, srcBytes: r.slice(0, k), corrected: 0, erasures: erasePos.length };
    }

    // erasure locator (forward convention), then the errors-only locator from the
    // Forney syndromes. BM needs the reversed sequence - see its doc comment.
    var eloc = erasureLocator(erasePos, n);
    var fsynd = forneySyndromes(syn, eloc, erasePos.length);
    var fsyndReversed = Uint8Array.from(fsynd).reverse();
    var errLoc = berlekampMassey(fsyndReversed);

    // full locator = error locator * erasure locator (convolution)
    var loc = erasePos.length ? polyMul(errLoc, eloc) : errLoc;

    var positions = chienSearch(loc, n);

    // the located positions must include every erasure, and their count must match
    // the locator degree - otherwise the solution is not trustworthy
    for (var q = 0; q < erasePos.length; q++) {
      if (positions.indexOf(erasePos[q]) < 0) {
        return { success: false, reason: 'erasure position not among locator roots (uncorrectable)' };
      }
    }
    var deg = loc.length - 1;
    if (positions.length !== deg) {
      return { success: false, reason: 'locator degree ' + deg + ' but ' + positions.length + ' roots found' };
    }
    if (2 * (deg - erasePos.length) + erasePos.length > nsym) {
      return { success: false, reason: 'beyond correcting capability' };
    }

    var mags = solveMagnitudes(syn, positions, n);
    if (!mags) return { success: false, reason: 'singular magnitude system (uncorrectable)' };

    for (var p = 0; p < positions.length; p++) r[positions[p]] ^= mags[p];

    if (!allZero(syndromes(r, nsym))) {
      return { success: false, reason: 'syndrome check failed after correction (mis-correction avoided)' };
    }

    return { success: true, srcBytes: r.slice(0, k), corrected: deg, erasures: erasePos.length };
  }

  /** Maximum random errors correctable for a given nsym. */
  function maxErrors(nsym) { return Math.floor(nsym / 2); }
  function maxErasures(nsym) { return nsym; }
  function rate(msglen, nsym) { return msglen / (msglen + nsym); }

  return {
    VERSION: VERSION,
    PRIM: PRIM,
    FCR: FCR,
    MAX_N: MAX_N,
    encode: encode,
    decode: decode,
    maxErrors: maxErrors,
    maxErasures: maxErasures,
    rate: rate,
    _internal: {
      gfMul: gfMul, gfDiv: gfDiv, gfPow: gfPow, gfInv: gfInv,
      polyMul: polyMul, polyEval: polyEval, generator: generator,
      evalLow: evalLow, erasureLocator: erasureLocator,
      syndromes: syndromes, forneySyndromes: forneySyndromes,
      berlekampMassey: berlekampMassey, chienSearch: chienSearch,
      solveGF: solveGF, solveMagnitudes: solveMagnitudes,
      EXP: EXP, LOG: LOG
    }
  };
});
