/*
 * Driver for demo-degradation.html.
 *
 * THE ONE DESIGN CONSTRAINT THAT SHAPES EVERYTHING HERE: the page must work when someone double-clicks it.
 * On `file://` the origin is opaque, so `fetch()` of a sibling file is blocked, ES modules do not load, and
 * `decodeAudioData` on a blob is unreliable. That is why this page differs from index.html in two ways:
 *
 *   1. the base clip and the ground-truth raster are inlined as base64 by scripts/gen-demo-page.js, and
 *      are handed to this file as `BASE_WAV_B64` / `TRUTH_PNG_B64`. Nothing is fetched.
 *   2. it uses classic scripts and `SSTVWav.parse` directly rather than the Web Audio API.
 *
 * Decoding is done through `SSTVDecode.decode` (the library the tests use), not through js/decoder.js,
 * so the numbers shown here are the decoder's own numbers and not a second implementation's.
 *
 * DECODE COST: measured 1.8 s for this clip in the fast profile (tests/measure-demo-base.js). That is why
 * the page decodes on a BUTTON rather than live on every slider event - a live-while-dragging design would
 * queue up one 1.8 s job per input event and appear to hang. Slider movement is instant; the decode is
 * explicit.
 */
(function () {
  'use strict';

  var SR = 8000;
  var Q = 'fast';

  var el = function (id) { return document.getElementById(id); };
  var state = { type: 0, step: 0, base: null, clean: null, truth: null, busy: false };

  /* ------------------------------------------------------------------ base64 -> typed arrays */

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var n = bin.length;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Parse the inlined WAV into mono Float32 samples using the project's own reader. */
  function parseBaseWav() {
    var bytes = b64ToBytes(BASE_WAV_B64);
    var parsed = globalThis.SSTVWav.parse(bytes.buffer);
    return { samples: parsed.samples, sampleRate: parsed.sampleRate };
  }

  /* ------------------------------------------------------------------ image helpers */

  /** Decode the inlined ground-truth PNG into {data,w,h} via a canvas. */
  function loadTruth() {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var id = ctx.getImageData(0, 0, c.width, c.height);
        resolve({ data: id.data, width: c.width, height: c.height });
      };
      img.onerror = function () { reject(new Error('真值图解码失败')); };
      img.src = 'data:image/png;base64,' + TRUTH_PNG_B64;
    });
  }

  function drawTo(canvas, image) {
    canvas.width = image.width;
    canvas.height = image.height;
    var ctx = canvas.getContext('2d');
    var id = ctx.createImageData(image.width, image.height);
    id.data.set(image.data);
    ctx.putImageData(id, 0, 0);
  }

  /* ------------------------------------------------------------------ metrics */

  function psnr(a, b) {
    var se = 0, n = 0;
    for (var i = 0; i < a.length; i++) {
      if (i % 4 === 3) continue;
      var d = a[i] - b[i];
      se += d * d; n++;
    }
    var mse = se / n;
    return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
  }

  /** σ(G−R) / σ(luma), the project's chroma-band indicator. */
  function chromaRatio(image) {
    var d = image.data, sGR = 0, s2GR = 0, sL = 0, s2L = 0, n = 0;
    for (var i = 0; i < d.length; i += 4) {
      var gr = d[i + 1] - d[i];
      var L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sGR += gr; s2GR += gr * gr; sL += L; s2L += L * L; n++;
    }
    var vGR = s2GR / n - (sGR / n) * (sGR / n);
    var vL = s2L / n - (sL / n) * (sL / n);
    return vL <= 0 ? null : Math.sqrt(Math.max(0, vGR) / vL);
  }

  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    return s[s.length >> 1];
  }

  /**
   * Lock-quality metrics from the decoder's own per-line sync audit.
   *
   * `auditLineRefs` records `{line, ref}` per observed line, where `ref` is the sample at which the decoder
   * locked that line's sync. Two numbers are derived, and the derivation is stated because it decides what
   * they mean:
   *
   *   - period: a robust slope of `ref` against line index. The line period is constant, so the refs lie on
   *     a straight line; the slope IS the observed period. A robust slope (median of pairwise slopes over
   *     a coarse grid) is used rather than least squares, because a handful of mislocked lines would drag a
   *     least-squares fit and make a badly-locked decode look well-locked.
   *   - 抖动 (jitter): the median absolute deviation of `ref` from that fitted line, in samples. This is the
   *     quantity that matters - a decoder can track the right average rate while wandering line to line.
   *
   * The first attempt here computed "deviation" as the median of |ref| itself, which is meaningless: `ref`
   * is an absolute sample index into a 110 s file, so its magnitude is ~800000 regardless of lock quality.
   * The metrics are therefore taken from the RESIDUALS against the fitted line, never from the raw refs.
   */
  function lockStats(refs) {
    var pts = refs.filter(function (r) { return r && isFinite(r.ref); });
    if (pts.length < 8) return { period: null, jitter: null, n: pts.length };
    var slopes = [];
    var stride = Math.max(1, Math.floor(pts.length / 40));
    for (var i = 0; i < pts.length; i += stride) {
      for (var j = i + 1; j < pts.length; j += stride) {
        var dl = pts[j].line - pts[i].line;
        if (dl > 0) slopes.push((pts[j].ref - pts[i].ref) / dl);
      }
    }
    var period = median(slopes);
    var res = pts.map(function (p) { return p.ref - (pts[0].ref + period * (p.line - pts[0].line)); });
    var centred = res.map(function (v) { return Math.abs(v - median(res)); });
    return { period: period, jitter: median(centred), n: pts.length };
  }

  /* ------------------------------------------------------------------ UI construction */

  function buildTabs() {
    var box = el('typeTabs');
    box.innerHTML = '';
    TYPES.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'demo-tab' + (i === state.type ? ' active' : '');
      b.textContent = t.label;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', i === state.type ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.type = i;
        // land on the middle step so switching type shows a comparable intensity, not an extreme
        state.step = Math.min(2, TYPES[i].steps.length - 1);
        buildTabs();
        syncSliders();
      });
      box.appendChild(b);
    });
    var t = TYPES[state.type];
    el('typeDesc').textContent = t.desc;
  }

  function syncSliders() {
    var t = TYPES[state.type];
    var slider = el('strength');
    slider.max = String(t.steps.length - 1);
    if (state.step > t.steps.length - 1) state.step = t.steps.length - 1;
    slider.value = String(state.step);

    var ticks = el('ticks');
    ticks.innerHTML = '';
    t.steps.forEach(function (s, i) {
      var d = document.createElement('span');
      d.className = 'demo-tick' + (i === state.step ? ' active' : '');
      d.innerHTML = '<b></b><i></i>';
      d.firstChild.textContent = s.label;
      d.lastChild.textContent = s.sub;
      d.addEventListener('click', function () {
        state.step = i;
        syncSliders();
      });
      ticks.appendChild(d);
    });
  }

  function setStatus(text) { el('status').textContent = text; }

  function progress(frac) {
    var w = el('progressWrap');
    if (frac == null) { w.hidden = true; return; }
    w.hidden = false;
    el('progressBar').style.width = Math.round(frac * 100) + '%';
  }

  /* ------------------------------------------------------------------ the run */

  /**
   * Yield to the browser so the progress paint lands before the blocking decode starts.
   * The decode is synchronous and takes ~1.8 s; without this the "正在解码" state would never render.
   */
  function nextFrame() {
    return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); });
  }

  async function init() {
    try {
      setStatus('正在解析基础音频…');
      await nextFrame();
      var base = parseBaseWav();
      state.base = base;
      state.truth = await loadTruth();

      setStatus('正在解码原始音频（无退化）…');
      await nextFrame();
      progress(0.15);
      var t0 = performance.now();
      /*
       * AWAIT IS REQUIRED. SSTVDecode.decode is an `async function` (js/lib/sstv-decode.js), so it returns a
       * Promise even though every Node test in this repo appears to call it synchronously - they all await
       * it. The first version of this file did not, so `r.ok` was undefined on a Promise, the "decode
       * failed" branch was taken, and the error text came out as an empty object. The giveaway was
       * `r.constructor.name === 'Promise'`; a decode failure would have carried a `stage`.
       */
      var r = await globalThis.SSTVDecode.decode(base.samples, base.sampleRate,
        { quality: Q, yieldEvery: 0, postprocess: 'off' });
      var ms = Math.round(performance.now() - t0);
      if (!r.ok) {
        throw new Error('原始音频解码失败 · stage=' + (r.stage || '?') +
          ' · ' + (r.message || '(无消息)') +
          ' · samples=' + base.samples.length + ' @ ' + base.sampleRate + ' Hz');
      }
      state.clean = r.imageData;
      drawTo(el('cvClean'), state.clean);
      el('degCaption').textContent = '当前退化下的解码（还没跑）';

      var p = psnr(state.clean.data, state.truth.data);
      progress(null);
      setStatus('就绪 · 原始图 ' + p.toFixed(2) + ' dB · ' + ms + ' ms。' +
        '选好类型与强度后点「开始退化演示」。');
      el('runBtn').disabled = false;
      if (globalThis.DEMO_READY) globalThis.DEMO_READY({ cleanPsnr: p, cleanMs: ms });
    } catch (e) {
      progress(null);
      setStatus('初始化失败：' + (e && e.message ? e.message : e));
      el('runBtn').disabled = true;
      if (globalThis.DEMO_FAILED) globalThis.DEMO_FAILED(String(e && e.message || e));
    }
  }

  async function run() {
    if (state.busy || !state.base) return;
    state.busy = true;
    el('runBtn').disabled = true;
    var t = TYPES[state.type];
    var step = t.steps[state.step];

    try {
      setStatus('正在施加退化：' + t.label + ' · ' + step.label + ' …');
      await nextFrame();
      progress(0.1);

      // ---- degradation, in memory, on the samples. This is the "real-time" part: no pre-rendered audio.
      var tD0 = performance.now();
      var degraded = step.apply(state.base.samples);
      var degMs = Math.round(performance.now() - tD0);

      setStatus('正在解码…（' + Q + ' 档，约 2 秒）');
      await nextFrame();
      progress(0.35);

      /*
       * ONE decode, with the audit sink attached. An earlier version decoded twice - once for the image and
       * once more with `auditLineRefs` - which doubled the wall-clock cost of every button press for no
       * reason, since both outputs come from the same call.
       */
      var refs = [];
      var t0 = performance.now();
      var r = await globalThis.SSTVDecode.decode(degraded, state.base.sampleRate,
        { quality: Q, yieldEvery: 0, postprocess: 'off', auditLineRefs: refs });
      var decMs = Math.round(performance.now() - t0);
      progress(1);

      if (!r.ok) {
        el('degCaption').textContent = '解码失败：' + r.message;
        var cvs = el('cvDeg');
        cvs.width = state.clean.width; cvs.height = state.clean.height;
        var ctx = cvs.getContext('2d');
        ctx.fillStyle = '#1a1d23'; ctx.fillRect(0, 0, cvs.width, cvs.height);
        ctx.fillStyle = '#ff9a9a'; ctx.font = '14px sans-serif';
        ctx.fillText('解码失败', 12, 24);
        showMetrics(null, degMs, decMs, t, step, '解码器在这个退化下完全没有读出图像：' + r.message);
        return;
      }

      drawTo(el('cvDeg'), r.imageData);
      el('degCaption').textContent = '当前退化下的解码 · ' + t.label + ' · ' + step.label;

      var p = psnr(r.imageData.data, state.truth.data);
      var srcChroma = chromaRatio(state.truth);
      var ch = chromaRatio(r.imageData);
      var lock = lockStats(refs);
      showMetrics({ psnr: p, chroma: ch, srcChroma: srcChroma,
        jitter: lock.jitter, period: lock.period, lines: lock.n, mode: r.mode },
        degMs, decMs, t, step, null);
    } catch (e) {
      setStatus('出错：' + (e && e.message ? e.message : e));
    } finally {
      progress(null);
      state.busy = false;
      el('runBtn').disabled = false;
      if (globalThis.DEMO_DONE) globalThis.DEMO_DONE();
    }
  }

  function showMetrics(m, degMs, decMs, type, step, note) {
    el('metrics').hidden = false;
    if (!m) {
      el('verdict').className = 'demo-verdict bad';
      el('verdict').textContent = '不可用 · 解码失败';
      ['mPsnr', 'mPeriod', 'mJitter', 'mChroma'].forEach(function (k) { el(k).textContent = '—'; });
    } else {
      var usable = m.psnr >= 25;
      el('verdict').className = 'demo-verdict ' + (usable ? 'good' : 'bad');
      el('verdict').textContent = (usable ? '可用' : '不可用') + ' · ' +
        (usable ? '还能还原出图像' : '图像已经读不出来') +
        '（PSNR ' + m.psnr.toFixed(2) + ' dB，判据 25 dB）';
      el('mPsnr').textContent = m.psnr.toFixed(2) + ' dB';
      el('mPeriod').textContent = m.period == null ? '—' : m.period.toFixed(1) + ' 采样/行';
      // the grid period is 20.74 samples for S1 at 8 kHz; express the error as a percentage of it
      el('mJitter').textContent = m.jitter == null ? '—'
        : m.jitter.toFixed(2) + ' 采样（' + (m.jitter / 20.74 * 100).toFixed(1) + '% 行周期）';
      var extra = (m.srcChroma != null && m.chroma != null)
        ? '（原图 ' + m.srcChroma.toFixed(3) + '，' +
          (m.chroma > m.srcChroma * 1.25 ? '明显偏高' : '基本一致') + '）'
        : '';
      el('mChroma').textContent = (m.chroma == null ? '—' : m.chroma.toFixed(3)) + extra;
      if (m.lines != null) el('mLines').textContent = m.lines + ' 行';
    }
    el('mDegMs').textContent = degMs + ' ms';
    el('mDecMs').textContent = decMs + ' ms';
    el('degNote').textContent = note
      ? note
      : '退化在浏览器内存里即时施加（' + degMs + ' ms），随后用解码器重新解码。' +
        '基础音频 ' + BASE_META.modeName + ' · ' + BASE_META.sampleRate + ' Hz · ' +
        BASE_META.durationS.toFixed(0) + ' 秒。';
    setStatus('完成 · ' + type.label + ' · ' + step.label + ' · PSNR ' +
      (m ? m.psnr.toFixed(2) + ' dB' : '解码失败'));
  }

  /* ------------------------------------------------------------------ wire up */

  document.addEventListener('DOMContentLoaded', function () {
    el('runBtn').disabled = true;
    buildTabs();
    syncSliders();
    el('strength').addEventListener('input', function (e) {
      state.step = Number(e.target.value);
      syncSliders();
      setStatus('强度已改为「' + TYPES[state.type].steps[state.step].label + '」——点「开始退化演示」运行。');
    });
    el('runBtn').addEventListener('click', run);
    el('resetBtn').addEventListener('click', function () {
      state.type = 0; state.step = 0;
      buildTabs(); syncSliders();
      el('metrics').hidden = true;
      el('degCaption').textContent = '当前退化下的解码（还没跑）';
      var ctx = el('cvDeg').getContext('2d');
      ctx.clearRect(0, 0, el('cvDeg').width, el('cvDeg').height);
      setStatus('已重置。选好类型与强度后点「开始退化演示」。');
    });
    init();
  });
})();
