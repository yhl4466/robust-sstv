/* 抗干扰 SSTV 解码 · UI wiring
 *
 * Classic script (no modules): every module is already on window by load order.
 * Uses no fetch(), no Worker and no AudioWorklet, because file:// blocks all three.
 */
(function () {
  'use strict';

  var Encoder = window.SSTVEncoder;
  var Decoder = window.SSTVDecoder;
  var Channel = window.SSTVChannel;

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- helpers
  function fmtDuration(sec) {
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return (m > 0 ? m + ' 分 ' : '') + s.toFixed(1) + ' 秒';
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function setStatus(el, kind, html) {
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.innerHTML = html;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function blobUrl(bytes, mime) {
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  // ================================================================ ENCODER
  var enc = {
    sourceImg: null,       // decoded <img>, loaded from a data URL
    lastWavBytes: null,
    lastWavUrl: null
  };

  function initModes() {
    var sel = $('modeSelect');
    sel.innerHTML = '';
    Encoder.modes().forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name + '  (' + m.width + '×' + m.height + ')';
      sel.appendChild(o);
    });
    sel.value = 'M1';
    updateDurationReadout();
  }

  function updateDurationReadout() {
    var mode = Encoder.getMode($('modeSelect').value);
    $('durationReadout').textContent =
      fmtDuration(mode ? Encoder.estimateDuration(mode.id) : 0);
  }

  /* Draw the current source image fitted into the selected mode's raster, and
   * keep the resulting ImageData for encoding. Data URLs (never file:// paths)
   * keep the canvas untainted so getImageData() is allowed on file://. */
  function renderPreview() {
    if (!enc.sourceImg) return null;
    var mode = Encoder.getMode($('modeSelect').value);
    var fitted;
    try {
      fitted = Encoder.fitToMode(enc.sourceImg, mode);
    } catch (e) {
      setStatus($('encStatus'), 'err', '图片处理失败：' + esc(e.message));
      return null;
    }
    var canvas = $('imgCanvas');
    canvas.width = mode.width;
    canvas.height = mode.height;
    canvas.getContext('2d').putImageData(fitted.imageData, 0, 0);

    $('imgMeta').textContent =
      '已适配 ' + mode.width + '×' + mode.height +
      '（源图 ' + (enc.sourceImg.naturalWidth || '?') + '×' + (enc.sourceImg.naturalHeight || '?') + '）';
    return fitted.imageData;
  }

  $('imgInput').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      var img = new Image();
      img.onload = function () {
        enc.sourceImg = img;
        var ok = !!renderPreview();
        $('encodeBtn').disabled = !ok;
      };
      img.onerror = function () { setStatus($('encStatus'), 'err', '无法解码该图片文件?'); };
      img.src = ev.target.result;         // data: URL -> no canvas tainting
    };
    reader.onerror = function () { setStatus($('encStatus'), 'err', '读取图片失败。'); };
    reader.readAsDataURL(file);
  });

  $('modeSelect').addEventListener('change', function () {
    updateDurationReadout();
    if (enc.sourceImg) {
      var ok = !!renderPreview();
      $('encodeBtn').disabled = !ok;
    }
  });

  $('encodeBtn').addEventListener('click', function () {
    var mode = Encoder.getMode($('modeSelect').value);
    var imageData = renderPreview();
    if (!imageData) { setStatus($('encStatus'), 'err', '请先选择图片。'); return; }

    setStatus($('encStatus'), '', '正在编码…');
    var res;
    try {
      res = Encoder.encode(imageData, mode.id);
    } catch (e) {
      setStatus($('encStatus'), 'err', '编码失败：' + esc(e.message));
      return;
    }

    // Produce the WAV once and use it for BOTH playback and download, so the
    // audio you hear is byte-identical to the file you get.
    var wav = Encoder.toWavBytes(res.samples, res.sampleRate);
    enc.lastWavBytes = wav;
    if (enc.lastWavUrl) URL.revokeObjectURL(enc.lastWavUrl);
    enc.lastWavUrl = blobUrl(wav, 'audio/wav');

    var audio = $('encAudio');
    audio.src = enc.lastWavUrl;
    // Called synchronously inside the click handler, so the autoplay policy allows it.
    var p = audio.play();
    if (p && p.catch) p.catch(function () { /* user can press play manually */ });

    $('downloadBtn').disabled = false;

    setStatus($('encStatus'), 'ok',
      '编码完成 · 模式 <b>' + esc(mode.name) + '</b>（VIS ' + mode.vis + '）<br>' +
      '音频时长 <b>' + fmtDuration(res.duration) + '</b> · 采样率 ' + res.sampleRate + ' Hz · 单声道 16-bit<br>' +
      'WAV 大小 <b>' + fmtBytes(wav.length) + '</b> · 调制像素 ' + res.timeline.pixelCount.toLocaleString() +
      ' · 编码耗时 ' + res.elapsedMs + ' ms');
  });

  $('downloadBtn').addEventListener('click', function () {
    if (!enc.lastWavBytes) return;
    var mode = Encoder.getMode($('modeSelect').value);
    var a = document.createElement('a');
    a.href = enc.lastWavUrl;
    a.download = 'sstv_' + mode.id + '.wav';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  // ================================================================ DECODER
  var dec = {
    samples: null,
    sampleRate: 0,
    info: null,
    cancelled: false,
    busy: false,
    fileUrl: null
  };

  function initQuality() {
    var sel = $('qualitySelect');
    sel.innerHTML = '';
    Object.keys(Decoder.QUALITY).forEach(function (k) {
      var q = Decoder.QUALITY[k];
      var o = document.createElement('option');
      o.value = k;
      o.textContent = q.label + '（FFT ×' + q.mult + '）';
      sel.appendChild(o);
    });
    sel.value = 'standard';

    $('supportedReadout').textContent = Decoder.supported
      .map(function (s) { return s.name + ' (VIS ' + s.vis + ')'; }).join('、');
  }

  $('wavInput').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;

    // Play the uploaded file back through a blob URL: no fetch(), no decodeAudioData().
    if (dec.fileUrl) URL.revokeObjectURL(dec.fileUrl);
    dec.fileUrl = URL.createObjectURL(file);
    $('decAudio').src = dec.fileUrl;

    Decoder.readFileBuffer(file).then(function (buf) {
      var parsed = Decoder.parseWav(buf);
      if (!parsed.ok) {
        dec.samples = null;
        $('decodeBtn').disabled = true;
        setStatus($('decStatus'), 'err', 'WAV 解析失败：' + esc(parsed.message));
        return;
      }
      dec.samples = parsed.samples;
      dec.sampleRate = parsed.sampleRate;
      dec.info = parsed;
      $('decodeBtn').disabled = false;
      setStatus($('decStatus'), '',
        '已载入 <b>' + esc(file.name) + '</b> · ' + fmtBytes(file.size) + '<br>' +
        parsed.sampleRate + ' Hz · ' + parsed.channels + ' 声道 · ' + parsed.bitsPerSample + '-bit ' +
        parsed.format + ' · 时长 ' + fmtDuration(parsed.duration));
    }).catch(function (err) {
      setStatus($('decStatus'), 'err', '读取文件失败：' + esc(err.message));
    });
  });

  function showProgress(fraction, label) {
    $('progressWrap').hidden = false;
    $('progressBar').style.width = Math.max(0, Math.min(100, fraction * 100)).toFixed(1) + '%';
    if (label) $('progressBar').setAttribute('data-label', label);
  }

  $('decodeBtn').addEventListener('click', async function () {
    if (!dec.samples || dec.busy) return;
    dec.busy = true;
    dec.cancelled = false;
    $('decodeBtn').disabled = true;
    $('cancelBtn').disabled = false;
    $('savePngBtn').disabled = true;
    showProgress(0, '搜索标定头');
    setStatus($('decStatus'), '', '正在解码…（无 Worker 可用，采用分块让出以保持界面响应）');

    var timedOut = false;
    var res;
    try {
      res = await Decoder.decode(dec.samples, dec.sampleRate, {
        quality: $('qualitySelect').value,
        wantConfidence: true,
        shouldCancel: function () { return dec.cancelled; },
        onProgress: function (f, label) { showProgress(f, label); }
      });
    } catch (e) {
      res = { ok: false, stage: 'unexpected', message: e.message };
    }

    dec.busy = false;
    $('decodeBtn').disabled = false;
    $('cancelBtn').disabled = true;
    $('progressWrap').hidden = true;

    if (!res.ok) {
      var kind = res.cancelled ? '' : 'err';
      $('decStatus').title = res.cancelled ? '' : ('stage=' + (res.stage || '') + (res.message ? ' | ' + res.message : ''));
      setStatus($('decStatus'), kind,
        (res.cancelled ? '已取消。' : decodeErrorText(res)));
      return;
    }

    var canvas = $('decCanvas');
    canvas.width = res.imageData.width;
    canvas.height = res.imageData.height;
    canvas.getContext('2d').putImageData(
      new ImageData(res.imageData.data, res.imageData.width, res.imageData.height), 0, 0);
    $('savePngBtn').disabled = false;

    var t = res.timings || {};
    var warn = res.warnings && res.warnings.length
      ? '<br><span class="warn">提示：' + esc(res.warnings.join(' ')) + '</span>' : '';

    $('decMeta').textContent = res.mode.name + ' · ' + res.imageData.width + '×' + res.imageData.height;
    setStatus($('decStatus'), 'ok',
      '解码成功 · 模式 <b>' + esc(res.mode.name) + '</b>（VIS ' + res.vis + '）<br>' +
      '耗时 ' + ((t.total || 0) / 1000).toFixed(2) + ' 秒<br>' +
      '（标定头 ' + (t.header || 0) + ' ms · 图像 ' + (t.image || 0) + ' ms）' + warn);
  });

  $('cancelBtn').addEventListener('click', function () { dec.cancelled = true; });

  $('savePngBtn').addEventListener('click', function () {
    $('decCanvas').toBlob(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'sstv_decoded.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }, 'image/png');
  });

  // ============================================================ EXTENSIONS
  /* Renders the phase-2 seams that are already wired into the live pipeline.
   * Showing them here keeps the interfaces honest: they are called on every
   * encode/decode, not merely documented. */
  function renderExtensions() {
    var rows = [];
    rows.push('<p class="muted">接口层版本 <code>' + Channel.VERSION + '</code> · 后端模式 <code>' +
      Channel.Backend.mode + '</code>（<code>remote</code> 尚未实现）</p>');

    rows.push('<table><thead><tr><th>扩展点</th><th>已注册</th><th>当前生效</th></tr></thead><tbody>');
    rows.push('<tr><td>隐写嵌入：Codec.registerEmbedder</td><td>' +
      Channel.Codec.listEmbedders().map(esc).join('、') + '</td><td>' +
      esc(Channel.Codec.activeEmbedder()) + '</td></tr>');
    rows.push('<tr><td>信道编码 Codec.registerFEC（LDPC 预留）</td><td>' +
      (Channel.Codec.listFECs().length ? Channel.Codec.listFECs().map(esc).join('、') : '<span class="muted">（未注册）</span>') +
      '</td><td><span class="muted">—</span></td></tr>');
    rows.push('<tr><td>干扰模型 Channel</td><td>' +
      Object.keys(Channel.Channel).map(esc).join('、') + '</td><td><span class="muted">—</span></td></tr>');
    rows.push('</tbody></table>');

    rows.push('<h3>各模式可嵌入容量估算</h3>');
    rows.push('<p class="hint">按模式结构解析得出的<b>解析估算</b>，不是已实现的隐写信道测量值。' +
      '默认生效的 <code>identity</code> 嵌入器为直通（容量 0），下表为各模式在相应方案下的<b>上限估算</b>；' +
      '已实现的图片隐藏见 <a href="embed-image.html">图片隐藏 · 嵌入端</a>。</p>');
    rows.push('<table><thead><tr><th>模式</th><th>像素槽位</th><th>亮度QIM 1bit</th><th>亮度QIM 2bit</th>' +
      '<th>色度QIM 1bit</th><th>消隐段FSK符号</th><th>同步段FSK符号</th></tr></thead><tbody>');
    Encoder.modes().forEach(function (m) {
      var blank = document.createElement('canvas');
      blank.width = m.width; blank.height = m.height;
      var id = blank.getContext('2d').createImageData(m.width, m.height);
      var tl = window.SSTVTimeline.build(id, m);
      var cap = Channel.Codec.capacity(tl);
      rows.push('<tr><td>' + esc(m.name) + '</td>' +
        '<td>' + cap.pixelSlots.toLocaleString() + '</td>' +
        '<td>' + cap.estimates.luminanceQim1bit.toLocaleString() + ' bit</td>' +
        '<td>' + cap.estimates.luminanceQim2bit.toLocaleString() + ' bit</td>' +
        '<td>' + cap.estimates.chromaQim1bit.toLocaleString() + ' bit</td>' +
        '<td>' + cap.estimates.porchFsk + '</td>' +
        '<td>' + cap.estimates.syncFsk + '</td></tr>');
    });
    rows.push('</tbody></table>');
    $('extPanel').innerHTML = rows.join('');
  }
  $('extRefresh').addEventListener('click', renderExtensions);

  // ============================================================ PHASE-2 PANEL
  /* Runs the whole payload link in the browser: frame -> RS -> interleave ->
   * block-mean QIM -> (unchanged) SSTV encode -> ChannelSim -> (unchanged) SSTV
   * demodulate -> extract -> deinterleave -> RS decode -> CRC.
   *
   * The point of doing it live is that the toggles are real: switching FEC or the
   * interleaver changes the actual signal path, not a displayed number. */
  var Sim = window.ChannelSim;
  var Pay = window.PayloadPipeline;
  var THUMB = 16, THUMB_BYTES = THUMB * THUMB;
  var payload = { busy: false };

  /*
   * Internal decode stage -> plain-language message.
   *
   * Stage names are the real ones from js/lib/sstv-decode.js and js/decoder.js. Two entries have
   * no trigger path and are kept as defensive copy: 'pd-not-supported' (PD120/PD180 have been
   * decodable since phase 7) and 'timeout' (there is no timeout mechanism; cancellation arrives
   * as 'cancelled').
   */
  var DECODE_ERROR_TEXT = {
    wav: '这个音频文件读不出来，请换一个 WAV 文件。',
    input: '音频内容为空或格式异常，请换一个文件。',
    findHeader: '没检测到信号。请确认上传的是声音传图的音频，或让对方重新发送。',
    'calibrate-fail': '信号同步失败，音频可能被裁剪或损坏。',
    unexpected: '还原过程中出错，请重试或换一段音频。',
    cancelled: '已取消。',
    'pd-not-supported': '检测到高清格式，请让发送方改用其他音质。',
    timeout: '处理超时，请换一段更短的音频。'
  };

  /** Map a decode result to a sentence a non-specialist can act on. */
  function decodeErrorText(res) {
    if (res && res.cancelled) return DECODE_ERROR_TEXT.cancelled;
    if (res && res.stage === 'vis') {
      // vis is set only when the header decoded but the format is unsupported; a bare 'vis'
      // failure with no vis value means the parity bit did not check out.
      return res.vis != null ? '检测到未知格式，本工具可能不支持。'
                             : '信号不完整，可能被裁剪或干扰了，请让对方重新发送。';
    }
    if (res && DECODE_ERROR_TEXT[res.stage]) return DECODE_ERROR_TEXT[res.stage];
    return DECODE_ERROR_TEXT.unexpected;
  }

  var FEC_OPTS = [
    { id: 'none', label: '无 FEC', nsym: 0 },
    { id: 'rs223', label: 'RS(255,223) 纠16', nsym: 32 },
    { id: 'rs191', label: 'RS(255,191) 纠32', nsym: 64 }
  ];
  var IL_OPTS = [
    { id: 'off', label: '无交?', depth: 1 },
    { id: 'd32', label: '码字交织 深度32', depth: 32 }
  ];

  /*
   * Reliability predictor, fitted on the 60-image content corpus
   * (scripts/eval-content.js -> scripts/fit-predictor.js).
   *
   * Single feature, deliberately: with only 60 samples a 5-parameter fit reached R2=0.52
   * and generalises worse, while this one-parameter model reaches R2=0.33 with 78% of the
   * corpus predicted within half a decade - and it is interpretable as "the fraction of
   * blocks that cannot carry a bit at all".
   *
   *     log10(BER) = intercept + coef * (unreachableFrac - mean) / std
   *
   * The result is an INDICATIVE estimate, and the panel labels it as such.
   */
  var PREDICT = {
    intercept: -2.107182,
    unreachableFrac: { coef: 0.364202, mean: 0.026350911, std: 0.034927920 },
    r2: 0.328, within: 0.783
  };
  // raw BER at which RS(255,223) still has byte-error headroom (phase-2 byte budget)
  var BER_SAFE = 2.6e-3;
  // un-embeddable-block fraction above which the corpus says the image is not safe
  var UNREACHABLE_WARN = 0.0089;

  function predictBerFromProbe(p) {
    var z = (p.unreachableFrac - PREDICT.unreachableFrac.mean) / PREDICT.unreachableFrac.std;
    return Math.pow(10, PREDICT.intercept + PREDICT.unreachableFrac.coef * z);
  }

  function fillSelect(el, items, valueKey, labelKey, def) {
    el.innerHTML = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = String(it[valueKey]);
      o.textContent = it[labelKey];
      el.appendChild(o);
    });
    if (def != null) el.value = String(def);
  }

  function initPayloadPanel() {
    fillSelect($('chanSelect'), Sim.presets(), 'name', 'name', 'clean');
    fillSelect($('fecSelect'), FEC_OPTS, 'id', 'label', 'rs223');
    fillSelect($('ilSelect'), IL_OPTS, 'id', 'label', 'd32');
    // B=32 is the phase-3 measured goodput optimum (mild/moderate reach 100% here)
    fillSelect($('blockSelect'), [16, 32, 48, 64, 96, 128].map(function (b) {
      return { v: b, l: b + ' 像素/?' };
    }), 'v', 'l', 32);
    fillSelect($('deltaSelect'), [4, 6, 8, 12, 16].map(function (d) {
      return { v: d, l: 'Δ = ' + d + ' 灰阶' };
    }), 'v', 'l', 12);
    updatePayloadAvailability();
  }

  function currentPayloadConfig() {
    var fec = FEC_OPTS.filter(function (f) { return f.id === $('fecSelect').value; })[0] || FEC_OPTS[1];
    var il = IL_OPTS.filter(function (i) { return i.id === $('ilSelect').value })[0] || IL_OPTS[1];
    return {
      blockSize: parseInt($('blockSelect').value, 10) || 32,
      delta: parseInt($('deltaSelect').value, 10) || 12,
      nsym: fec.nsym,
      // 'auto' lets the code shorten to fit the carrier (required for B >= 48)
      codewordLength: 'auto',
      interleaveDepth: il.depth,
      fecLabel: fec.label,
      ilLabel: il.label
    };
  }

  /**
   * Refresh the pre-flight readout: current B, carrier/payload capacity, the predicted BER
   * and - most importantly - a warnable verdict on whether THIS image can carry the
   * payload at all. Runs on every image / mode / parameter change, costs one cheap pass.
   */
  function updatePrediction() {
    var box = $('predictBox');
    var raster = enc.sourceImg ? renderPreview() : null;
    if (!raster) { box.hidden = true; return; }
    var cfg = currentPayloadConfig();
    var probe = window.PayloadQIM.probe(raster, { blockSize: cfg.blockSize, delta: cfg.delta });
    var cap = window.PayloadPipeline.capacity(raster, cfg);
    var ber = predictBerFromProbe(probe);

    var cls = 'ok', verdict = '预计可靠（该图可直接承载）';
    var notes = [];
    if (probe.unreachableFrac > UNREACHABLE_WARN) {
      cls = 'bad';
      verdict = '当前图像有 ' + (100 * probe.unreachableFrac).toFixed(1) + '% 的区块不适合承载，建议换图';
      notes.push('这些块内同时存在接近黑与接近白的像素，均值几乎无法移动，比特写不进去。');
    } else if (ber > BER_SAFE) {
      cls = 'warn';
      verdict = '预计偏紧：估计误码率高于 RS 的纠错预算';
    }
    if (cap.payloadBytes < THUMB_BYTES) {
      cls = 'bad';
      notes.push('容量不足：可用载荷 ' + cap.payloadBytes + ' B，需 ' + THUMB_BYTES + ' B。请减小 B 或降低 FEC 强度。');
    }
    if (cap.codewords <= 1) {
      notes.push('该 B 下载波只有 ' + cap.codewords + ' 个码字，交织深度上限为 1（交织开关将不起作用）。');
    }

    var rows = [
      ['载体块长 B', cfg.blockSize + ' 像素/位'],
      ['QIM 步长 Δ', cfg.delta + ' 灰阶'],
      ['载波容量', cap.carrierBytes + ' B'],
      ['可用载荷', cap.payloadBytes + ' B' + (cap.payloadBytes >= THUMB_BYTES ? '（够 16×16 缩略图）' : '（不够）')],
      ['码几何', 'n=' + cap.codewordLength + ' / nsym=' + (cap.rs ? cap.rs.nsym : 0) + ' × ' + cap.codewords + ' 码字'],
      ['不可嵌入块', (100 * probe.unreachableFrac).toFixed(2) + '%' + (probe.unreachableFrac > UNREACHABLE_WARN ? '  ?超阈?' + (100 * UNREACHABLE_WARN).toFixed(2) + '%' : '')],
      ['预计 BER（FEC 前）', ber.toExponential(2) + '（RS 预算 ' + BER_SAFE.toExponential(1) + '）'],
      ['预测模型', '单特征 unreachableFrac，R²=' + PREDICT.r2 + '，' + Math.round(100 * PREDICT.within) + '% 落在半个数量级内']
    ];
    box.className = 'predict ' + cls;
    box.innerHTML = '<div class="predict-verdict">' + esc(verdict) + '</div>' +
      '<div class="grid-metrics">' + rows.map(function (r) {
        return '<div class="metric"><span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(r[1]) + '</span></div>';
      }).join('') + '</div>' +
      (notes.length ? '<div class="predict-notes">' + notes.map(function (n) { return '· ' + esc(n); }).join('<br>') + '</div>' : '');
    box.hidden = false;
  }

  function updatePayloadAvailability() {
    var ready = !!enc.sourceImg;
    $('runPayloadBtn').disabled = !ready || payload.busy;
    $('runPayloadBtn').title = ready ? '' : '请先在上方选择图片（载荷内容是该图的 16×16 缩略图）';
    updatePrediction();
  }

  function thumbnailOf(imageData) {
    var t = new Uint8Array(THUMB_BYTES);
    var bw = imageData.width / THUMB, bh = imageData.height / THUMB;
    for (var ty = 0; ty < THUMB; ty++) {
      for (var tx = 0; tx < THUMB; tx++) {
        var sum = 0, n = 0;
        for (var y = Math.floor(ty * bh); y < Math.floor((ty + 1) * bh); y++) {
          for (var x = Math.floor(tx * bw); x < Math.floor((tx + 1) * bw); x++) {
            var i = (y * imageData.width + x) * 4;
            sum += 0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2];
            n++;
          }
        }
        t[ty * THUMB + tx] = n ? Math.round(sum / n) : 0;
      }
    }
    return t;
  }

  function drawThumbPair(orig, rec) {
    var c = $('thumbCanvas');
    c.width = THUMB * 2 + 2;
    c.height = THUMB;
    var g = c.getContext('2d');
    function put(arr, ox) {
      var id = g.createImageData(THUMB, THUMB);
      for (var i = 0; i < arr.length; i++) {
        id.data[i * 4] = arr[i]; id.data[i * 4 + 1] = arr[i];
        id.data[i * 4 + 2] = arr[i]; id.data[i * 4 + 3] = 255;
      }
      g.putImageData(id, ox, 0);
    }
    put(orig, 0);
    put(rec, THUMB + 2);
  }

  function drawImageDataTo(canvas, imageData) {
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(
      new ImageData(imageData.data, imageData.width, imageData.height), 0, 0);
  }

  function imgPsnr(a, b) {
    var se = 0, n = 0;
    for (var p = 0; p < a.width * a.height; p++) {
      for (var off = 0; off < 3; off++) {
        var d = a.data[p * 4 + off] - b.data[p * 4 + off];
        se += d * d; n++;
      }
    }
    var mse = se / n;
    return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
  }
  function thumbPsnr(rec, orig) {
    var se = 0;
    for (var i = 0; i < orig.length; i++) { var d = rec[i] - orig[i]; se += d * d; }
    var mse = se / orig.length;
    return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
  }
  function bitErr(a, b) {
    var e = 0, n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) if (a[i] !== b[i]) e++;
    return n ? e / n : 1;
  }
  function byteErr(a, b) {
    var e = 0;
    for (var i = 0; i < b.length; i++) if (a[i] !== b[i]) e++;
    return b.length ? e / b.length : 1;
  }

  function metricRow(k, v, cls) {
    return '<div class="metric"><span class="k">' + esc(k) + '</span><span class="v ' + (cls || '') + '">' + esc(v) + '</span></div>';
  }

  $('runPayloadBtn').addEventListener('click', async function () {
    var mode = Encoder.getMode($('modeSelect').value);
    var src = renderPreview();
    if (!src) { setStatus($('payloadStatus'), 'err', '请先在上方选择图片。'); return; }

    var cfg = currentPayloadConfig();
    var cap = Pay.capacity(src, cfg);
    if (cap.payloadBytes < THUMB_BYTES) {
      setStatus($('payloadStatus'), 'err',
        '该配置容量不足：可用载荷 ' + cap.payloadBytes + ' B，需 ' + THUMB_BYTES + ' B?' +
        '请减小块长或降低 FEC 强度。');
      return;
    }

    payload.busy = true;
    updatePayloadAvailability();
    setStatus($('payloadStatus'), '', '正在运行载荷链路…（无 Worker，解码分块让出以保持界面响应）');
    $('payloadMetrics').hidden = true;
    var t0 = Date.now();

    try {
      // ---- transmit ----
      var thumb = thumbnailOf(src);
      var emb = Pay.embedPayload(src, thumb, cfg);
      if (!emb.ok) throw new Error(emb.reason);
      drawImageDataTo($('payloadSrcCanvas'), emb.imageData);
      var embedPenalty = imgPsnr(emb.imageData, src);

      var tl = window.SSTVTimeline.build(emb.imageData, mode);
      var synth = window.SSTVSynth.synthesize(tl, Encoder.SAMPLE_RATE);
      var preset = Sim.presets().filter(function (p) { return p.name === $('chanSelect').value; })[0];
      var degraded = Sim.apply(synth.samples, preset.options);
      var parsed = Decoder.parseWav(window.SSTVWav.encode(degraded, Encoder.SAMPLE_RATE).buffer.slice(0));
      if (!parsed.ok) throw new Error(parsed.message);

      // ---- receive ----
      showProgress(0, '解调');
      var dec = await Decoder.decode(parsed.samples, parsed.sampleRate, {
        /*
         * 'standard' (FFT x16) is REQUIRED here, not a nicety. Measured carrier BER at
         * clean: x16 gives 3.4e-3 (inside RS's byte budget), x8 gives ~9e-2 (far
         * outside it, so RS cannot recover anything). The quality tier changes the
         * outcome of the whole anti-jamming chain, so the panel must use the tier the
         * conclusions were drawn at.
         */
        quality: 'standard',
        // calibration pre-pass + AFC: show what the receiver estimated
        onProgress: function (f, label) { showProgress(f, label); },
        yieldFn: function () { return new Promise(function (r) { requestAnimationFrame(r); }); },
        yieldEvery: 4
      });
      $('progressWrap').hidden = true;
      if (!dec.ok) throw new Error('解调失败（' + dec.stage + '）：' + dec.message);

      drawImageDataTo($('payloadRxCanvas'), dec.imageData);
      var ex = Pay.extractPayload(dec.imageData, cfg, emb.meta.codedBytes);
      var st = ex.stats || {};

      var rec = new Uint8Array(THUMB_BYTES);
      var be = ex.bestEffort;
      if (be && be.length > Pay.HEADER_BYTES) {
        var declared = be[2] | (be[3] << 8);
        var take = (declared > 0 && declared <= THUMB_BYTES) ? declared : THUMB_BYTES;
        for (var i = 0; i < take && Pay.HEADER_BYTES + i < be.length; i++) rec[i] = be[Pay.HEADER_BYTES + i];
      }
      drawThumbPair(thumb, rec);

      var berPre = st.rawBits ? bitErr(emb.bits, st.rawBits) : 1;
      var berPost = ex.ok ? byteErr(ex.payload, thumb) : byteErr(rec, thumb);
      var tPsnr = thumbPsnr(rec, thumb);
      var aPsnr = imgPsnr(dec.imageData, src);
      var cal = dec.calibration || {};

      var m = [];
      m.push(metricRow('信道', preset.name + ' — ' + Sim.describe(preset.options).join(' / ')));
      m.push(metricRow('FEC / 交织', cfg.fecLabel + ' / ' + cfg.ilLabel));
      m.push(metricRow('载体', '块长 ' + cfg.blockSize + ' px，Δ=' + cfg.delta + '，载波 ' + cap.carrierBytes + ' B'));
      m.push(metricRow('容量 / 载荷', cap.payloadBytes + ' B / ' + THUMB_BYTES + ' B'));
      m.push(metricRow('实际码字数 / 深度', emb.meta.codec.codewords + ' / ' + emb.meta.codec.depth));
      m.push(metricRow('BER（FEC 前）', berPre.toExponential(2), berPre < 1e-2 ? 'good' : 'bad'));
      m.push(metricRow('BER（FEC 后）', berPost.toExponential(2), berPost === 0 ? 'good' : 'bad'));
      m.push(metricRow('RS 块正确率', (st.codewords ? (100 * st.codewordsOk / st.codewords).toFixed(0) : '0') + '% (' + st.codewordsOk + '/' + st.codewords + ')',
        st.codewordsOk === st.codewords ? 'good' : 'bad'));
      m.push(metricRow('帧 CRC', ex.ok ? '通过' : '失败 ?' + ex.reason, ex.ok ? 'good' : 'bad'));
      m.push(metricRow('擦除率（比特/字节）', (100 * (st.bitErasureRate || 0)).toFixed(1) + '% / ' + (100 * (st.byteErasureRate || 0)).toFixed(1) + '%'));
      m.push(metricRow('载荷图 PSNR', tPsnr.toFixed(2) + ' dB', tPsnr > 20 ? 'good' : (tPsnr > 12 ? 'warn' : 'bad')));
      m.push(metricRow('模拟图 PSNR vs 原图', aPsnr.toFixed(2) + ' dB', aPsnr > 29 ? 'good' : 'warn'));
      m.push(metricRow('嵌入代价（vs 发送前）', embedPenalty.toFixed(2) + ' dB'));
      m.push(metricRow('接收端标定', 'a=' + (cal.scale || 1).toFixed(5) + ' b=' + (cal.offsetHz || 0).toFixed(2) + ' Hz' +
        (cal.clockScale != null ? ' 时钟×' + cal.clockScale.toFixed(5) : ''), 'good'));
      m.push(metricRow('标定来源', (cal.source || '-') + (cal.observations ? '（' + cal.observations + ' 个同步）' : '')));
      m.push(metricRow('解调耗时', ((dec.timings && dec.timings.total) || 0) + ' ms'));
      m.push(metricRow('链路总耗时', (Date.now() - t0) + ' ms'));
      $('payloadMetrics').innerHTML = '<div class="grid-metrics">' + m.join('') + '</div>';
      $('payloadMetrics').hidden = false;

      setStatus($('payloadStatus'), ex.ok ? 'ok' : 'err',
        ex.ok
          ? '载荷解出且 <b>CRC 校验通过</b>，载荷逐字节与发送一致。'
          : '载荷未能完整恢复：<b>' + esc(ex.reason) + '</b>（下方为尽力恢复的结果与质量指标）');
      $('payloadRxMeta').textContent = '接收并解调后的图 · ' + dec.mode.name +
        (cal.clockScale != null ? ' · 时钟×' + cal.clockScale.toFixed(5) : '');
    } catch (e) {
      $('progressWrap').hidden = true;
      setStatus($('payloadStatus'), 'err', '运行失败：' + esc(e.message));
    } finally {
      payload.busy = false;
      updatePayloadAvailability();
    }
  });

  // ==================================================================== boot
  function boot() {
    initModes();
    initQuality();
    renderExtensions();
    initPayloadPanel();
    $('imgInput').addEventListener('change', function () { setTimeout(updatePayloadAvailability, 1200); });
    $('modeSelect').addEventListener('change', function () { setTimeout(updatePayloadAvailability, 600); });
    // re-run the pre-flight prediction whenever a carrier/QIM parameter changes
    ['blockSelect', 'deltaSelect', 'fecSelect', 'ilSelect'].forEach(function (id) {
      $(id).addEventListener('change', updatePayloadAvailability);
    });
    drawThumbPair(new Uint8Array(THUMB_BYTES), new Uint8Array(THUMB_BYTES));
    $('backendBadge').textContent = Channel.Backend.mode;
  }
  boot();
})();

