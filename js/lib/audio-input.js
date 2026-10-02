/*
 * Audio input layer: format sniffing + the decodeAudioData fallback for non-WAV files.
 *
 * WHY THIS EXISTS
 *   The project's WAV reader is deliberately strict: it rejects anything without a RIFF/WAVE
 *   header. That is right for WAV files - it preserves the NATIVE sample rate, which every timing
 *   calculation depends on - but it means a phone screen recording (M4A/MP4/WebM) is refused
 *   outright with "Not a RIFF file", even though the audio inside is perfectly decodable.
 *
 *   So the rule is: WAV keeps the strict native-rate path, and everything else is handed to the
 *   browser's own decoder. This module is that hand-off.
 *
 * THE RESAMPLING TRADE-OFF (an earlier decision, now deliberately narrowed)
 *   js/lib/wav.js and js/decoder.js used to say "we do NOT use decodeAudioData because it
 *   resamples to the AudioContext's rate". That reasoning still holds for WAV, which is why the
 *   WAV path is untouched. It is acceptable for the fallback because:
 *     - it is only reached when the strict path cannot help at all,
 *     - the resample target is the AudioContext rate (48 kHz on desktop), and the demodulator is
 *       rate-agnostic well above Nyquist - measured working from 8 kHz through 44.1 kHz,
 *     - the ACTUAL rate of the decoded buffer is read back and reported, never assumed.
 *   The one mode family that cares is PD120/PD180 (they need >= 16 kHz), and a low rate is
 *   surfaced as a non-blocking warning by the caller.
 *
 * Container support comes from the browser, not from this table: the table only produces a
 * readable NAME, and any non-RIFF buffer is offered to decodeAudioData anyway, because the
 * browser knows more formats than a magic-number list does.
 */
(function (root, factory) {
  var api = factory(root);
  root.SSTVAudioInput = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var MAX_BYTES = 100 * 1024 * 1024;   // decodeAudioData is unreliable well beyond this

  function ascii(view, off, s) {
    if (view.length < off + s.length) return false;
    for (var i = 0; i < s.length; i++) if (view[off + i] !== s.charCodeAt(i)) return false;
    return true;
  }

  /** ISO-BMFF brands worth naming in the UI. */
  var BRANDS = { 'M4A ': 'M4A', 'mp42': 'MP4', 'mp41': 'MP4', 'isom': 'MP4', 'iso2': 'MP4',
    'qt  ': 'MOV', '3gp4': '3GP', '3gp5': '3GP', 'avc1': 'MP4', 'dash': 'MP4' };

  /**
   * Sniff the container from the leading bytes.
   * @param {Uint8Array} head  at least the first 12 bytes (more is fine)
   * @returns {{kind: string, label: string, wav: boolean}}
   */
  function detectFormat(head) {
    if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return { kind: 'wav', label: 'WAV', wav: true };
    if (ascii(head, 4, 'ftyp')) {
      var brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
      return { kind: 'isobmff', label: BRANDS[brand] || 'MP4', wav: false };
    }
    if (ascii(head, 0, 'OggS')) return { kind: 'ogg', label: 'OGG', wav: false };
    if (ascii(head, 0, 'ID3')) return { kind: 'mp3', label: 'MP3', wav: false };
    // bare MPEG audio frame sync: 11 set bits, and not a padded/empty tag byte
    if (head.length >= 2 && head[0] === 0xFF && (head[1] & 0xE0) === 0xE0 && (head[1] & 0x18) !== 0x08) {
      return { kind: 'mp3', label: 'MP3', wav: false };
    }
    if (head.length >= 4 && head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) {
      return { kind: 'webm', label: 'WebM', wav: false };
    }
    if (ascii(head, 0, 'fLaC')) return { kind: 'flac', label: 'FLAC', wav: false };
    if (ascii(head, 0, 'wvpk')) return { kind: 'wavpack', label: 'WavPack', wav: false };
    if (ascii(head, 0, 'FORM') && ascii(head, 8, 'AIFF')) return { kind: 'aiff', label: 'AIFF', wav: false };
    if (ascii(head, 0, 'caff')) return { kind: 'caf', label: 'CAF', wav: false };
    return { kind: 'unknown', label: '未知', wav: false };
  }

  function hexPreview(head, n) {
    var out = [];
    for (var i = 0; i < Math.min(n || 12, head.length); i++) {
      out.push(('0' + head[i].toString(16)).slice(-2));
    }
    return out.join(' ');
  }

  /*
   * One AudioContext for the whole session.
   * A context is a heavy object (its own audio thread and graph), and creating one per file both
   * leaks and is slow; the caller never sees this, it just gets samples back.
   */
  var ctxSingleton = null, ctxCreations = 0;
  function getContext() {
    if (ctxSingleton) return ctxSingleton;
    var Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return null;
    ctxSingleton = new Ctx();
    ctxCreations++;
    return ctxSingleton;
  }
  /** Creation count, so a test can assert the singleton really is one. */
  function contextCount() { return ctxCreations; }

  /** Mix every channel down to one: SSTV is a mono signal, so averaging beats picking a side. */
  function toMono(audioBuffer) {
    var n = audioBuffer.length, ch = audioBuffer.numberOfChannels;
    if (ch === 1) return audioBuffer.getChannelData(0);
    var out = new Float32Array(n);
    for (var c = 0; c < ch; c++) {
      var d = audioBuffer.getChannelData(c);
      for (var i = 0; i < n; i++) out[i] += d[i];
    }
    for (var k = 0; k < n; k++) out[k] /= ch;
    return out;
  }

  function decodeBuffer(ctx, arrayBuffer) {
    // Promise form in every current browser; the callback form keeps older Safari working.
    return new Promise(function (resolve, reject) {
      var ret;
      try {
        ret = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      } catch (e) {
        reject(e);
        return;
      }
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    });
  }

  /**
   * Decode a non-WAV buffer to mono Float32 samples.
   * @returns {Promise<{ok:boolean, samples?:Float32Array, sampleRate?:number, duration?:number,
   *                    stage?:string, message?:string, warning?:string}>}
   */
  async function decodeToSamples(arrayBuffer, opts) {
    opts = opts || {};
    var ctx = getContext();
    if (!ctx) {
      return { ok: false, stage: 'unsupported',
        message: '当前浏览器不支持音频解码（缺少 AudioContext），请改用 WAV 文件。' };
    }
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return { ok: false, stage: 'size',
        message: '文件过大（' + (arrayBuffer.byteLength / 1048576).toFixed(0) +
          ' MB），浏览器音频解码上限约 100 MB，请先裁剪或改用 WAV。' };
    }

    /*
     * decodeAudioData works on a SUSPENDED context - only playback needs it running - so a failed
     * resume is a warning, never a blocker. Kept because a suspended context is what a
     * gesture-gated browser reports, and the user should know why playback may stay silent.
     */
    var warning = null;
    if (ctx.state && ctx.state !== 'running' && typeof ctx.resume === 'function') {
      try { await ctx.resume(); } catch (e) { /* fall through to the check below */ }
      if (ctx.state !== 'running') {
        warning = '浏览器尚未允许播放音频（需要一次页面交互）；解码不受影响，但试听可能无声。';
      }
    }

    var audioBuffer;
    try {
      audioBuffer = await decodeBuffer(ctx, arrayBuffer);
    } catch (e) {
      var name = (e && e.name) || '';
      var detail = (e && e.message) || '';
      var why = /EncodingError/i.test(name)
        ? '文件损坏，或使用了当前浏览器不支持的编码。'
        : (detail || '浏览器未能解码该文件。');
      return { ok: false, stage: 'decode', message: '音频解码失败：' + why };
    }

    if (!audioBuffer || !audioBuffer.length) {
      return { ok: false, stage: 'empty', message: '音频被截断或损坏：未解出任何样本。请确认录音完整。' };
    }

    return {
      ok: true,
      samples: toMono(audioBuffer),
      sampleRate: audioBuffer.sampleRate,
      duration: audioBuffer.duration,
      warning: warning
    };
  }

  return {
    MAX_BYTES: MAX_BYTES,
    detectFormat: detectFormat,
    hexPreview: hexPreview,
    getContext: getContext,
    contextCount: contextCount,
    decodeToSamples: decodeToSamples
  };
});
