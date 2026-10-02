/*
 * Payload pipeline: frames a digital payload, applies CRC + RS + interleaving, embeds
 * it in the SSTV image via the block-mean carrier, and reverses all of that at the
 * receiver.
 *
 * Layer order (fixed, and the order matters):
 *
 *   TX  payload bytes
 *        -> frame: magic | version | length | CRC32 | data
 *        -> pad to a whole number of RS codewords
 *        -> RS encode each codeword                      (js/fec-rs.js)
 *        -> interleave across codewords                  (js/interleaver.js)
 *        -> bits, mapped one per carrier block           (js/payload-qim.js)
 *        -> quantise the image's green channel
 *        -> [unchanged phase-1 SSTV encoder]
 *
 *   RX  audio -> [unchanged phase-1 demodulator] -> recovered image
 *        -> per-block hard decisions + soft confidence + erasure flags
 *        -> deinterleave
 *        -> RS decode each codeword, using erasures where flagged
 *        -> CRC32 check, length check, magic check
 *        -> payload bytes
 *
 * The CRC is not decoration. RS can MIS-CORRECT beyond its bound: measured on 400
 * over-budget frames the syndrome check rejected all of them, but that is a
 * statistical result, not a guarantee, and a frame CRC is the only thing that turns
 * "the decoder thought it worked" into "the data is actually right".
 *
 * This module does not touch the SSTV codec: the embedding is a pre-processing step on
 * the image and the extraction is a post-processing step on the demodulated pixels,
 * which is precisely why phase 1 stays regression-clean.
 */
(function (root, factory) {
  var qim = root.PayloadQIM, rs = root.FECRS, il = root.Interleaver;
  if (typeof require === 'function') {
    if (!qim) qim = require('./payload-qim.js');
    if (!rs) rs = require('./fec-rs.js');
    if (!il) il = require('./interleaver.js');
  }
  var api = factory(qim, rs, il);
  root.PayloadPipeline = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PayloadQIM, FECRS, Interleaver) {
  'use strict';

  if (!PayloadQIM || !FECRS || !Interleaver) {
    throw new Error('payload-pipeline.js requires payload-qim.js, fec-rs.js and interleaver.js');
  }

  var VERSION = '0.1.0-phase2';
  var MAGIC = 0x53;        // 'S'
  var VERSION_BYTE = 0x02;
  // magic(1) | version(1) | payload length(2) | CRC32 of payload(4)
  var HEADER_BYTES = 8;

  // ------------------------------------------------------------------ CRC32
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, from, to) {
    var c = 0xFFFFFFFF;
    var a = from || 0, b = to == null ? bytes.length : to;
    for (var i = a; i < b; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ------------------------------------------------------------------ framing
  function parseFrame(bytes) {
    if (bytes.length < HEADER_BYTES) return { ok: false, reason: 'frame shorter than its header' };
    if (bytes[0] !== MAGIC) return { ok: false, reason: 'bad magic (0x' + bytes[0].toString(16) + ')' };
    if (bytes[1] !== VERSION_BYTE) return { ok: false, reason: 'unsupported frame version ' + bytes[1] };
    var len = bytes[2] | (bytes[3] << 8);
    if (len > bytes.length - HEADER_BYTES) return { ok: false, reason: 'declared length exceeds frame' };
    var want = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
    var data = bytes.subarray(HEADER_BYTES, HEADER_BYTES + len);
    var got = crc32(data);
    if (got !== want) return { ok: false, reason: 'CRC mismatch' };
    return { ok: true, payload: Uint8Array.from(data) };
  }

  // ------------------------------------------------------------------ configuration
  /**
   * @param {object} opts
   *   blockSize      carrier block length in pixels (horizontal), default 32
   *   delta          carrier quantisation step in grey levels, default 8
   *   nsym           RS parity bytes; 0 disables FEC, default 32 (RS(255,223))
   *   interleaveDepth  default 32; 1 disables interleaving
   */
  function normalize(opts) {
    opts = opts || {};
    var nsym = opts.nsym == null ? 32 : opts.nsym;
    return {
      blockSize: opts.blockSize || 32,
      delta: opts.delta || 8,
      nsym: nsym,
      /*
       * Codeword length. 255 (the classic full-length RS code) by default, or 'auto'
       * to shorten the code to whatever the carrier can hold.
       *
       * 'auto' exists because of a hard structural fact of this carrier: capacity is
       * floor(320/B) * 256 bits, so a 255-byte codeword no longer fits once B >= 48
       * (B=64 leaves only 160 carrier bytes). With 'auto' the codeword is shortened to
       * fit and the code RATE is held fixed instead, so a block-size sweep compares the
       * CHANNEL rather than the code parameters. GF(2^8) supports any n <= 255, so a
       * shortened code is a normal RS code, not an approximation.
       */
      codewordLength: opts.codewordLength == null ? 255 : opts.codewordLength,
      // when set (e.g. 0.125) nsym is derived from the resolved codeword length
      parityFraction: opts.parityFraction == null ? null : opts.parityFraction,
      interleaveDepth: opts.interleaveDepth == null ? 32 : opts.interleaveDepth,
      /*
       * Fraction of the parity budget that may be spent on ERASURES.
       *
       * Default 0 - erasures are OFF, and that is a measured decision, not an
       * oversight. Marking a symbol as an erasure tells the decoder "this value is
       * unknown, solve for it"; if the symbol was in fact CORRECT, the decoder is
       * forced to change it, and because the result is still a valid codeword the
       * syndrome check cannot catch it. Measured on clean-tier audio: flagging every
       * byte containing an uncertain bit (a 10% bit-erasure rate inflates to ~57% of
       * bytes) drove the RS decoder to report success with ~50% of the payload wrong.
       * Spending the whole budget on erasures also leaves nothing for real errors
       * under 2e + f <= nsym.
       *
       * Uncertain is NOT the same as wrong. Set this to a small value (e.g. 0.5) only
       * when the erasure positions are genuinely known to be lost.
       */
      erasureBudgetFraction: opts.erasureBudgetFraction == null ? 0 : opts.erasureBudgetFraction
    };
  }

  /**
   * Turn a requested configuration into a concrete one for a given image.
   * Called by BOTH embed and extract from the same inputs, so the receiver always
   * mirrors the transmitter's code geometry.
   */
  function resolve(imageData, opts) {
    var o = normalize(opts);
    var qim = PayloadQIM.capacity(imageData, { blockSize: o.blockSize });
    var carrierBytes = Math.floor(qim.bits / 8);

    var n = (o.codewordLength === 'auto' || !o.codewordLength)
      ? Math.min(255, carrierBytes)
      : o.codewordLength;

    var nsym;
    if (o.parityFraction != null && n > 0) {
      nsym = Math.max(2, Math.round(n * o.parityFraction));
    } else {
      nsym = o.nsym;
    }
    if (n > 0 && nsym >= n) nsym = Math.max(0, n - 1);
    var k = n - nsym;
    var codewords = n > 0 ? Math.floor(carrierBytes / n) : 0;
    var usableBytes = codewords * k;
    var depth = nsym > 0 ? Math.max(1, Math.min(o.interleaveDepth, codewords)) : 1;

    return {
      config: o,
      carrierBits: qim.bits,
      carrierBytes: carrierBytes,
      codewordLength: n,
      nsym: nsym,
      k: k,
      codewords: codewords,
      interleaveDepth: depth,
      usableBytes: usableBytes,
      payloadBytes: Math.max(0, usableBytes - HEADER_BYTES),
      parityFraction: n > 0 ? nsym / n : 0,
      codeRate: n > 0 ? k / n : 0
    };
  }

  /** Bits available for the framed payload under a configuration. */
  function capacity(imageData, opts) {
    var r = resolve(imageData, opts);
    var nsym = r.nsym;
    return {
      carrierBits: r.carrierBits,
      carrierBytes: r.carrierBytes,
      codewords: r.codewords,
      codewordLength: r.codewordLength,
      parityFraction: r.parityFraction,
      codeRate: r.codeRate,
      rs: nsym ? { n: r.codewordLength, k: r.k, nsym: nsym, correctionCapacity: FECRS.maxErrors(nsym) } : null,
      payloadBytes: r.payloadBytes,
      effectiveDepth: r.interleaveDepth,
      config: r.config
    };
  }

  // ------------------------------------------------------------------ transmit
  /**
   * @returns {{ok:true, imageData, bits, frames, meta}|{ok:false, reason}}
   */
  function embedPayload(imageData, payload, opts) {
    var r = resolve(imageData, opts);
    var o = r.config;
    if (r.codewords < 1) {
      return { ok: false, reason: 'carrier holds ' + r.carrierBytes + ' B, too little for one ' + r.codewordLength + '-byte codeword', capacity: r };
    }
    if (payload.length + HEADER_BYTES > r.usableBytes) {
      return { ok: false, reason: 'payload ' + payload.length + ' B exceeds capacity ' + r.payloadBytes + ' B', capacity: r };
    }

    var frame = new Uint8Array(HEADER_BYTES + payload.length);
    frame[0] = MAGIC;
    frame[1] = VERSION_BYTE;
    frame[2] = payload.length & 0xFF;
    frame[3] = (payload.length >> 8) & 0xFF;
    var crc = crc32(payload);
    frame[4] = crc & 0xFF; frame[5] = (crc >>> 8) & 0xFF;
    frame[6] = (crc >>> 16) & 0xFF; frame[7] = (crc >>> 24) & 0xFF;
    frame.set(payload, HEADER_BYTES);

    var codewordBytes = r.codewordLength;
    var k = r.k;
    var nCodewords = r.codewords;
    var nsym = r.nsym;

    // pad the frame to the exact codeword grid the receiver will assume
    var padded = new Uint8Array(nCodewords * k);
    padded.set(frame, 0);

    var coded = new Uint8Array(nCodewords * codewordBytes);
    for (var c = 0; c < nCodewords; c++) {
      var cw = nsym > 0
        ? FECRS.encode(padded.subarray(c * k, (c + 1) * k), nsym)
        : padded.subarray(c * k, (c + 1) * k);
      coded.set(cw, c * codewordBytes);
    }

    // interleave across codewords
    var depth = r.interleaveDepth;
    var interleaved = depth > 1
      ? Interleaver.interleave(coded, { depth: depth, codewordLength: codewordBytes })
      : coded;

    // bytes -> bits (MSB first within each byte)
    var nBits = interleaved.length * 8;
    if (nBits > r.carrierBits) {
      return { ok: false, reason: 'coded stream ' + nBits + ' bits exceeds carrier ' + r.carrierBits + ' bits', capacity: r };
    }
    var bits = new Uint8Array(nBits);
    for (var i = 0; i < interleaved.length; i++) {
      for (var b = 0; b < 8; b++) bits[i * 8 + b] = (interleaved[i] >> (7 - b)) & 1;
    }

    var emb = PayloadQIM.embed(imageData, bits, { blockSize: o.blockSize, delta: o.delta });
    return {
      ok: true,
      imageData: emb.imageData,
      bits: bits,
      meta: {
        config: o, codec: { n: codewordBytes, k: k, nsym: nsym, codewords: nCodewords, depth: depth },
        payloadBytes: payload.length, frameBytes: frame.length, codedBytes: interleaved.length,
        unreachableBlocks: emb.unreachable, capacity: r
      }
    };
  }

  // ------------------------------------------------------------------ receive
  /**
   * @param {object} imageData    demodulated image
   * @param {object} opts         same configuration used to transmit
   * @param {number} [knownCodedBytes] coded stream length, if known out of band
   * @returns {{ok:true, payload, stats}|{ok:false, reason, stats}}
   */
  function extractPayload(imageData, opts, knownCodedBytes) {
    var r = resolve(imageData, opts);
    var o = r.config;
    var codewordBytes = r.codewordLength;
    var k = r.k;
    var nsym = r.nsym;
    var nCodewords = r.codewords;

    if (nCodewords < 1) {
      return { ok: false, reason: 'carrier too small for one codeword', stats: { codewords: 0, codewordsOk: 0 } };
    }

    var nBits = knownCodedBytes
      ? knownCodedBytes * 8
      : nCodewords * codewordBytes * 8;
    if (nBits <= 0 || nBits > r.carrierBits) {
      return { ok: false, reason: 'coded stream length ' + (nBits / 8) + ' B exceeds carrier ' + r.carrierBytes + ' B', stats: {} };
    }

    var ex = PayloadQIM.extract(imageData, nBits, { blockSize: o.blockSize, delta: o.delta });

    // bits -> bytes (MSB first)
    var nBytes = Math.floor(nBits / 8);
    var received = new Uint8Array(nBytes);
    for (var i = 0; i < nBytes; i++) {
      var v = 0;
      for (var b = 0; b < 8; b++) v = (v << 1) | ex.bits[i * 8 + b];
      received[i] = v;
    }

    // ---- erasure selection with a budget ----
    /*
     * A byte is only worth marking as an erasure if the RS decoder can afford it:
     * with nsym parity symbols at most nsym erasures can ever be handled (2e + f <=
     * nsym). Marking every byte that contains ANY uncertain bit is far too greedy -
     * measured, a 10% bit erasure rate inflates to ~57% of bytes, which is why an
     * earlier version reported 0/N codewords decoded at EVERY channel setting, even
     * clean. Instead the most uncertain bytes are kept as erasures up to the budget
     * and the rest are handed over as ordinary errors.
     */
    var byteUncert = new Uint8Array(nBytes);
    var anyErased = new Uint8Array(nBytes);
    var erasedBits = 0;
    for (var j = 0; j < nBytes; j++) {
      var mx = 0;
      for (var q = 0; q < 8; q++) {
        var s = ex.soft[j * 8 + q];
        if (s > mx) mx = s;
        if (ex.erasures[j * 8 + q]) { anyErased[j] = 1; erasedBits++; }
      }
      byteUncert[j] = Math.min(255, Math.round((mx / 0.5) * 255));
    }

    // codeword geometry comes from resolve(), so the receiver mirrors the transmitter
    var depth = r.interleaveDepth;
    var useInterleave = depth > 1 && nCodewords > 1;
    var span = nCodewords * codewordBytes;
    var deint = useInterleave
      ? Interleaver.deinterleave(received.subarray(0, span), { depth: depth, codewordLength: codewordBytes })
      : received;
    var deintEr = useInterleave
      ? Interleaver.deinterleave(anyErased.subarray(0, span), { depth: depth, codewordLength: codewordBytes })
      : anyErased;
    var deintUncert = useInterleave
      ? Interleaver.deinterleave(byteUncert.subarray(0, span), { depth: depth, codewordLength: codewordBytes })
      : byteUncert;

    // budget: never flag more than this many symbols per codeword
    var erasureBudget = nsym > 0
      ? Math.max(0, Math.min(nsym, Math.floor(nsym * (o.erasureBudgetFraction == null ? 1 : o.erasureBudgetFraction))))
      : 0;

    var decoded = new Uint8Array(nCodewords * k);
    var okCodewords = 0;
    var failedCodewords = 0;
    var totalErasures = 0;
    var reasons = [];
    for (var c = 0; c < nCodewords; c++) {
      var off = c * codewordBytes;
      var slice = deint.subarray(off, off + codewordBytes);
      if (nsym <= 0) {
        decoded.set(slice.subarray(0, k), c * k);
        okCodewords++;
        continue;
      }

      // pick the least-certain candidates, best-first, up to the budget
      var cand = [];
      for (var p = 0; p < codewordBytes; p++) if (deintEr[off + p]) cand.push(p);
      if (cand.length > erasureBudget && erasureBudget >= 0) {
        cand.sort(function (a, b) { return deintUncert[off + b] - deintUncert[off + a]; });
        cand = cand.slice(0, erasureBudget);
      }
      var erSlice = new Uint8Array(codewordBytes);
      for (var e2 = 0; e2 < cand.length; e2++) erSlice[cand[e2]] = 1;
      totalErasures += cand.length;

      var decRes = FECRS.decode(slice, k, nsym, erSlice);
      if (decRes.success) { decoded.set(decRes.srcBytes, c * k); okCodewords++; }
      else {
        // Best effort: keep the uncorrected bytes so a failed codeword still yields a
        // GRADED quality measure rather than a binary "failed". The CRC is what tells
        // the caller whether the result can be trusted.
        decoded.set(slice.subarray(0, k), c * k);
        reasons.push('cw' + c + ': ' + decRes.reason);
        failedCodewords++;
      }
    }

    var stats = {
      carrierBits: r.carrierBits, bitsUsed: nBits, codedBytes: nBytes,
      codewords: nCodewords, codewordsOk: okCodewords, codewordsFailed: failedCodewords,
      depth: useInterleave ? depth : 1, erasureBudget: erasureBudget,
      erasuresUsed: totalErasures,
      bitErasureRate: erasedBits / nBits,
      byteErasureRate: anyErased.reduce(function (a, b) { return a + b; }, 0) / nBytes,
      // hard decisions before FEC, for measuring the pre-FEC bit error rate
      rawBits: ex.bits,
      softBits: ex.soft,
      bitErasures: ex.erasures,
      config: o,
      // the CONCRETE geometry actually used - the code may have been SHORTENED to fit
      // the carrier, so reporting the requested config alone would mislead
      resolved: { codewordLength: codewordBytes, k: k, nsym: nsym, codewords: nCodewords,
                  parityFraction: r.parityFraction, codeRate: r.codeRate,
                  carrierBytes: r.carrierBytes, payloadCapacity: r.payloadBytes },
      reasons: reasons.slice(0, 4)
    };

    var parsed = parseFrame(decoded);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, stats: stats, bestEffort: decoded };
    }
    return { ok: true, payload: parsed.payload, stats: stats, bestEffort: decoded };
  }

  /*
   * Image-frame convenience wrappers (phase 5).
   *
   * The generic byte-stream interface above is UNCHANGED - these two only build/parse the
   * 15-byte image header that the secret-image feature puts inside a payload, and delegate
   * the pixel work to js/image-codec.js. They live here so a caller that already uses the
   * payload layer can hide an image without learning a second module.
   *
   * ImageCodec is resolved lazily so payload-pipeline.js keeps working on its own, exactly
   * as it did before this feature existed.
   */
  function codecModule() {
    if (typeof module === 'object' && module.exports) return require('./image-codec.js');
    if (typeof self !== 'undefined' && self.ImageCodec) return self.ImageCodec;
    if (typeof window !== 'undefined' && window.ImageCodec) return window.ImageCodec;
    return null;
  }

  function encodeImageFrame(imageData, opts) {
    var C = codecModule();
    if (!C) return { ok: false, reason: 'ImageCodec not loaded' };
    var o = opts || {};
    var budget = o.imageDataBudget == null ? 200 : o.imageDataBudget;
    var sel = C.chooseBest(imageData, {
      dataBudget: budget,
      autoScale: o.autoScale !== false,
      dither: o.dither !== false,
      minSide: o.minSide
    });
    if (!sel.ok) return { ok: false, reason: sel.reason, candidates: sel.candidates };
    var fr = C.encodeImageFrame(sel.best.gray, {
      bpp: sel.best.bpp, dither: o.dither !== false, autoScaled: sel.best.autoScaled,
      maxDataBytes: budget, levels: sel.best.levels
    });
    if (fr.ok) fr.meta.reconstructionPsnr = sel.best.psnr;
    return fr;
  }

  function decodeImageFrame(bytes) {
    var C = codecModule();
    if (!C) return { ok: false, reason: 'ImageCodec not loaded' };
    return C.decodeImageFrame(bytes);
  }

  return {
    VERSION: VERSION,
    HEADER_BYTES: HEADER_BYTES,
    crc32: crc32,
    capacity: capacity,
    normalize: normalize,
    embedPayload: embedPayload,
    extractPayload: extractPayload,
    parseFrame: parseFrame,
    encodeImageFrame: encodeImageFrame,
    decodeImageFrame: decodeImageFrame
  };
});







