/*
 * Decoder facade: audio bytes -> ImageData.
 *
 * Wraps the input layer (format sniffing + WAV parser + the non-WAV fallback) and the
 * demodulator, and pulls in the extraction seam (identity by default).
 *
 * Choices worth knowing about:
 *  - WAV keeps the strict native-rate path. AudioContext.decodeAudioData() resamples to the
 *    device rate, and SSTV demodulation is timed in seconds against the file's NATIVE sample
 *    rate, so for WAV we still parse the container ourselves. See js/lib/wav.js.
 *  - Non-WAV (M4A / MP4 / WebM / MP3 / OGG ...) DOES use decodeAudioData, as a fallback rather
 *    than a replacement: without it a phone screen recording is refused outright even though its
 *    audio is perfectly decodable. The rate of the decoded buffer is read back and reported, and
 *    a rate too low for the PD family is surfaced as a warning rather than a refusal.
 *    See js/lib/audio-input.js for the full reasoning.
 *  - Decoding yields to the event loop between line batches. Under file:// there
 *    is no Web Worker (workers are blocked from an opaque origin), so keeping the
 *    page responsive has to be cooperative.
 */
(function (root, factory) {
  var api = factory(root.SSTVWav, root.SSTVDecode, root.SSTVChannel, root.SSTVModes, root.SSTVAudioInput);
  root.SSTVDecoder = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Wav, Decode, Channel, Modes, AudioInput) {
  'use strict';

  var QUALITY = Decode.QUALITY;
  var supported = Decode.SUPPORTED;

  /** Below this rate the PD family cannot be demodulated; other modes are unaffected. */
  var PD_MIN_RATE = 16000;

  /** Let the browser paint between decode batches. */
  function rafYield() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { resolve(); });
      else setTimeout(resolve, 0);
    });
  }

  function parseWav(arrayBuffer) {
    try {
      var info = Wav.parse(arrayBuffer);
      return {
        ok: true,
        samples: info.samples,
        sampleRate: info.sampleRate,
        channels: info.channels,
        bitsPerSample: info.bitsPerSample,
        format: info.format,
        duration: info.duration
      };
    } catch (e) {
      return { ok: false, stage: 'wav', message: e.message };
    }
  }

  /** Reads a File into an ArrayBuffer without fetch() (unavailable on file://). */
  function readFileBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Format-aware entry point: WAV keeps the strict path, anything else is handed to the browser.
   *
   * Returns the SAME shape as parseWav, so callers do not care which route was taken.
   *
   * @param {File} file
   * @param {{onStage?: function(string)}} [opts]
   */
  async function parseAudio(file, opts) {
    opts = opts || {};
    var onStage = opts.onStage || function () {};

    if (file && file.size > AudioInput.MAX_BYTES) {
      return { ok: false, stage: 'size',
        message: '文件过大（' + (file.size / 1048576).toFixed(0) +
          ' MB），浏览器音频解码上限约 100 MB，请先裁剪。' };
    }

    onStage('读取文件');
    var buf;
    try {
      buf = await readFileBuffer(file);
    } catch (e) {
      return { ok: false, stage: 'read', message: '读取文件失败：' + e.message };
    }
    if (!buf || !buf.byteLength) {
      return { ok: false, stage: 'empty', message: '音频被截断或损坏：文件是空的。' };
    }

    /*
     * Sniff BEFORE handing the buffer over: decodeAudioData DETACHES (neuters) the ArrayBuffer it
     * is given, so the header must be read while the bytes are still there. A view, not a copy -
     * views stay valid and cost nothing.
     */
    var head = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
    var fmt = AudioInput.detectFormat(head);
    /*
     * Snapshot the preview NOW. `head` is a view onto `buf`, and decodeAudioData detaches `buf`,
     * which empties the view - so reading it after a failed decode yields an empty string, exactly
     * the diagnostic that is needed at that moment.
     */
    var headHex = AudioInput.hexPreview(head);

    var result;
    if (fmt.wav) {
      result = parseWav(buf);
      if (!result.ok) {
        /*
         * A RIFF/WAVE header that the strict parser still rejects is a broken WAV, not an unknown
         * format. The parser's own reason is English and developer-facing, so it is kept for
         * diagnostics rather than shown.
         */
        result.detail = result.message;
        result.message = '音频被截断或损坏：WAV 文件不完整，缺少必要的数据块。';
        return result;
      }
      result.transcoded = false;
    } else {
      onStage('检测到 ' + fmt.label + '，正在转码');
      result = await AudioInput.decodeToSamples(buf, opts);
      if (!result.ok) {
        /*
         * The browser is asked to decode ANY non-WAV buffer, because it knows more containers than
         * a magic-number table does - so a decode failure means two very different things, and the
         * user needs to be told which: either we did not recognise the file at all, or we did and
         * its contents are broken. Only the former offers the format list as a remedy.
         */
        if (result.stage === 'decode' && fmt.kind === 'unknown') {
          return {
            ok: false, stage: 'format', format: fmt.label,
            detail: result.message,
            message: '无法识别的音频格式（前 12 字节 ' + headHex + '）。' +
              '支持 WAV / M4A / MP3 / OGG / WebM / MP4。'
          };
        }
        return result;
      }
      result.transcoded = true;
      result.channels = 1;              // the fallback always mixes down to mono
      result.bitsPerSample = 32;        // decoded float samples
    }

    result.format = fmt.label;
    /*
     * The rate is whatever the decoder actually produced - for the fallback that is the
     * AudioContext rate, NOT the file's own rate, and it is reported as such rather than
     * pretending otherwise. A low rate only rules out the PD family, so it warns.
     */
    if (result.sampleRate && result.sampleRate < PD_MIN_RATE) {
      result.warning = '采样率 ' + result.sampleRate +
        ' Hz 低于 PD120 / PD180 所需的 16 kHz，这两种模式可能无法解码；' +
        'Martin M1 与 Scottie S1 不受影响。';
    }
    return result;
  }

  async function decode(samples, sampleRate, opts) {
    opts = opts || {};
    var result = await Decode.decode(samples, sampleRate, {
      quality: opts.quality,
      mult: opts.mult,
      wantConfidence: opts.wantConfidence,
      onProgress: opts.onProgress,
      shouldCancel: opts.shouldCancel,
      yieldFn: opts.yieldFn || rafYield,
      yieldEvery: opts.yieldEvery == null ? 4 : opts.yieldEvery
    });

    if (result.ok) {
      // Phase-2 seam: identity in phase 1.
      var extracted = Channel.Codec.applyExtract(samples, { mode: result.mode.id });
      result.payload = extracted.bits;
      result.payloadConfidence = extracted.confidence;
    }
    return result;
  }

  return {
    QUALITY: QUALITY,
    PD_MIN_RATE: PD_MIN_RATE,
    supported: supported,
    parseWav: parseWav,
    parseAudio: parseAudio,
    readFileBuffer: readFileBuffer,
    decode: decode
  };
});
