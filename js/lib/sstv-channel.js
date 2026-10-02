/*
 * Extension seams for phase 2 (LDPC channel coding + image hiding) and for the
 * "non-pure-frontend" mode.
 *
 * Everything here is wired into the working pipeline in phase 1, but the only
 * registered implementation is an IDENTITY pass-through. That is deliberate:
 * a seam that is merely described in a document is not a seam. The pipeline
 * really does call these hooks, so phase 2 only needs to register an
 * implementation - the mode/timing layer and the modulated signal do not change.
 *
 * Pipeline in phase 1:
 *
 *   ImageData --[sstv-timeline]--> frequency timeline
 *                                     |
 *                       Codec.applyEmbed()   <-- identity in phase 1
 *                                     |
 *                       [sstv-synth] --> Float32 samples
 *                                     |
 *                       Codec.applyExtract() <-- identity in phase 1
 *
 * Where the payload physically goes is an embedder's business, not this module's.
 * An embedder receives the samples plus the timeline's segment map, so it can
 * target, for example, per-pixel luminance quantisation, the chroma scans, the
 * inter-line porches, or the post-VIS guard interval.
 */
(function (root, factory) {
  var api = factory(root.SSTVModes);
  root.SSTVChannel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Modes) {
  'use strict';

  var VERSION = '0.1.0-phase1';

  // ------------------------------------------------------------------
  // Registry
  // ------------------------------------------------------------------
  function Registry(kind) {
    this.kind = kind;
    this.items = {};
  }
  Registry.prototype.register = function (id, impl) {
    if (!id || typeof id !== 'string') throw new Error(this.kind + ' id must be a non-empty string');
    if (!impl || typeof impl !== 'object') throw new Error(this.kind + ' ' + id + ' must be an object');
    this.items[id] = impl;
    return impl;
  };
  Registry.prototype.get = function (id) {
    var it = this.items[id];
    if (!it) throw new Error('Unknown ' + this.kind + ': ' + id);
    return it;
  };
  Registry.prototype.has = function (id) { return Object.prototype.hasOwnProperty.call(this.items, id); };
  Registry.prototype.list = function () { return Object.keys(this.items); };

  var embedders = new Registry('embedder');
  var fecs = new Registry('FEC');

  /*
   * Identity embedder / extractor.
   * capacity() reports 0 bits so the UI never advertises phantom payload space.
   */
  embedders.register('identity', {
    id: 'identity',
    label: '直通（不嵌入）',
    capacity: function () { return 0; },
    embed: function (samples /*, bits, meta */) {
      return { samples: samples, meta: { embedded: 0, embedder: 'identity' } };
    },
    extract: function (/* samples, meta */) {
      return { bits: new Uint8Array(0), confidence: 0, embedder: 'identity' };
    }
  });

  var activeEmbedder = 'identity';

  // ------------------------------------------------------------------
  // Capacity accounting
  //
  // These are ANALYTICAL estimates from the timeline, reported per mode so that
  // phase 2 can pick a carrier with open eyes. They are not measurements of a
  // working steganographic channel (there isn't one yet) - they are how much
  // signal structure is available to carry one.
  // ------------------------------------------------------------------
  function capacity(timeline, mode) {
    var porchSeconds = 0, syncSeconds = 0, scanSeconds = 0, visSeconds = 0;
    var segs = timeline.segments;
    // Analyse only the image body. The VIS header is transmitted once, carries a
    // fixed payload, and contains 1200 Hz segments that are not line syncs.
    var start = timeline.headerSegments || 0;
    for (var i = start; i < segs.length; i++) {
      var s = segs[i];
      if (s.kind === 'scan') { scanSeconds += s.dur; continue; }
      if (s.freq === Modes.FREQ_SYNC) syncSeconds += s.dur;
      else if (s.freq === Modes.FREQ_PORCH) porchSeconds += s.dur;
      else visSeconds += s.dur;
    }

    var pixels = timeline.pixelCount;
    var sr = 48000; // reference rate for sample-denominated budgets

    return {
      mode: timeline.mode,
      modeName: timeline.modeName,
      pixelSlots: pixels,
      seconds: {
        visAndLeader: +visSeconds.toFixed(4),
        sync: +syncSeconds.toFixed(4),
        porch: +porchSeconds.toFixed(4),
        scan: +scanSeconds.toFixed(4),
        total: +timeline.duration.toFixed(4)
      },
      // Candidate carriers, with the caveat attached to each.
      estimates: {
        // 1 bit per pixel via luminance quantisation index.
        // Largest capacity, worst robustness - needs LDPC + interleaving.
        luminanceQim1bit: pixels,
        // 2 bits per pixel via a 4-level quantiser. More capacity, much worse SNR margin.
        luminanceQim2bit: pixels * 2,
        // Chroma is perceptually cheaper: PD shares chroma across line pairs so its
        // chroma slot count is halved.
        chromaQim1bit: timeline.colorSpace === 'YUV'
          ? Math.floor(pixels / 2)
          : pixels,
        // Porch/sync intervals are fixed-frequency and photo-independent, so they
        // are ideal for a low-rate robust side channel. A 50 Hz-spaced 2-FSK at
        // ~10 ms per symbol is a rough planning figure, not a spec.
        porchFsk: Math.floor(porchSeconds / 0.010),
        syncFsk: Math.floor(syncSeconds / 0.010),
        // Guard window between the VIS stop bit and the first scan line.
        guardBytes: Math.floor(sr * 0.005 / 8) // 5 ms of guard at 48 kHz
      },
      note: 'Analytical estimates from mode structure; no steganographic channel is implemented in phase 1.'
    };
  }

  // ------------------------------------------------------------------
  // Channel impairments (anti-jamming test bed).
  //
  // Phase 1 ships the ones needed to sanity-check the modem and to give phase 2
  // something to measure against. Narrowband interference and burst models are
  // phase-2 work and are intentionally absent rather than stubbed.
  // ------------------------------------------------------------------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var Channel = {
    /** Additive white Gaussian noise at a target SNR (signal power measured, not assumed). */
    awgn: function (samples, snrDb, seed) {
      var rnd = mulberry32(seed == null ? 1 : seed);
      var sum = 0;
      for (var i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      var sigPower = sum / samples.length;
      var noisePower = sigPower / Math.pow(10, snrDb / 10);
      var sigma = Math.sqrt(noisePower);
      var out = new Float32Array(samples.length);
      for (var j = 0; j < samples.length; j++) {
        // Box-Muller
        var u1 = rnd() || 1e-12, u2 = rnd();
        var g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        out[j] = samples[j] + sigma * g;
      }
      return out;
    },

    gain: function (samples, factor) {
      var out = new Float32Array(samples.length);
      for (var i = 0; i < samples.length; i++) out[i] = samples[i] * factor;
      return out;
    },

    /**
     * Simulate a receive-side clock/tuning error by resampling at `ratio`
     * (e.g. 1.0002 = 200 ppm fast). Linear interpolation; enough to expose
     * timing-drift sensitivity.
     */
    freqOffset: function (samples, ratio) {
      var n = Math.floor(samples.length / ratio);
      var out = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var x = i * ratio;
        var i0 = Math.floor(x);
        var frac = x - i0;
        var a = samples[i0] || 0;
        var b = samples[i0 + 1] || 0;
        out[i] = a + (b - a) * frac;
      }
      return out;
    }
  };

  // ------------------------------------------------------------------
  // Metrics
  // ------------------------------------------------------------------
  var Metrics = {
    psnr: function (a, b, channels) {
      var ch = channels || 4;
      var se = 0, n = 0;
      for (var i = 0; i < a.length; i++) {
        if ((i % ch) === ch - 1) continue;
        var d = a[i] - b[i];
        se += d * d; n++;
      }
      var mse = se / n;
      return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
    },
    ber: function (a, b) {
      var n = Math.min(a.length, b.length);
      if (n === 0) return 0;
      var errors = 0;
      for (var i = 0; i < n; i++) if (a[i] !== b[i]) errors++;
      return errors / n;
    }
  };

  // ------------------------------------------------------------------
  // Backend seam ("pure frontend" vs "non-pure-frontend")
  // ------------------------------------------------------------------
  var Backend = {
    mode: 'local',
    setMode: function (m) {
      if (m !== 'local' && m !== 'remote') throw new Error("Backend mode must be 'local' or 'remote'");
      this.mode = m;
      return this.mode;
    },
    isLocal: function () { return this.mode === 'local'; },
    /** Phase 2: dispatch to a server. Same signature as the local path. */
    encode: function () { throw new Error('remote backend not implemented in phase 1'); },
    decode: function () { throw new Error('remote backend not implemented in phase 1'); }
  };

  return {
    VERSION: VERSION,
    Codec: {
      registerEmbedder: function (id, impl) { return embedders.register(id, impl); },
      getEmbedder: function (id) { return embedders.get(id); },
      hasEmbedder: function (id) { return embedders.has(id); },
      listEmbedders: function () { return embedders.list(); },
      registerFEC: function (id, impl) { return fecs.register(id, impl); },
      getFEC: function (id) { return fecs.get(id); },
      listFECs: function () { return fecs.list(); },
      activeEmbedder: function () { return activeEmbedder; },
      useEmbedder: function (id) { embedders.get(id); activeEmbedder = id; return id; },
      /** Called by the encoder. Phase 1: identity. */
      applyEmbed: function (timeline, samples, meta) {
        return embedders.get(activeEmbedder).embed(samples, new Uint8Array(0), {
          timeline: timeline, meta: meta, capacity: capacity(timeline)
        });
      },
      /** Called by the decoder. Phase 1: identity. */
      applyExtract: function (samples, meta) {
        return embedders.get(activeEmbedder).extract(samples, meta);
      },
      capacity: capacity
    },
    Channel: Channel,
    Metrics: Metrics,
    Backend: Backend
  };
});
