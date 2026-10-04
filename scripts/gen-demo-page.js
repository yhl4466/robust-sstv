/*
 * Generate demo-degradation.html.
 *
 * WHY THIS IS A GENERATOR AND NOT A HAND-WRITTEN PAGE
 *   The demo has to work when someone double-clicks the file (`file://`), and on that origin the browser
 *   blocks `fetch()` of a sibling file - so an external WAV would work when served over http and silently
 *   fail when opened from disk, which is exactly the case this project promises to support. The base clip
 *   is therefore inlined as base64 into the page.
 *
 *   Inlining a 1.76 MB WAV makes the page ~2.4 MB, which is too large to keep in a hand-written file and
 *   too easy to let drift out of sync with the clip it embeds. Generating it from tests/demo-audio/ keeps
 *   one source of truth: change the clip, re-run this script.
 *
 * Usage: node scripts/gen-demo-page.js      (after node tests/measure-demo-base.js)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AUDIO_DIR = path.join(ROOT, 'tests', 'demo-audio');
const manifestPath = path.join(AUDIO_DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('缺少 tests/demo-audio/manifest.json —— 先跑 node tests/measure-demo-base.js');
  process.exit(1);
}
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const wavPath = path.join(AUDIO_DIR, m.audio);
const truthPath = path.join(AUDIO_DIR, m.truth);
for (const p of [wavPath, truthPath]) {
  if (!fs.existsSync(p)) { console.error('缺少 ' + p); process.exit(1); }
}
const audioB64 = fs.readFileSync(wavPath).toString('base64');
const truthB64 = fs.readFileSync(truthPath).toString('base64');

/*
 * The room impulse response, baked by tests/bake-demo-ir.js from the matrix's own buildIR.
 *
 * The acoustic dimension controls the WET LEVEL against this fixed IR rather than an RT60. That is not a
 * dodge: the matrix's allpass room has gains of 0.05 for every RT60 at or below 0.20 s and then breaks the
 * header outright from 0.30 s, so an RT60 ladder has no usable middle - measured, and recorded in
 * tests/verify-demo-ladder.js. Wet level against a real IR gives a smooth, physically meaningful knob
 * ("how much room do you hear") and its endpoints are honest: 0% is the dry signal, 100% is the room alone.
 */
const irPath = path.join(AUDIO_DIR, 'room-ir-8k.f32');
const irJsonPath = path.join(AUDIO_DIR, 'room-ir.json');
if (!fs.existsSync(irPath) || !fs.existsSync(irJsonPath)) {
  console.error('缺少 tests/demo-audio/room-ir-8k.f32 —— 先跑 node tests/bake-demo-ir.js');
  process.exit(1);
}
const irMeta = JSON.parse(fs.readFileSync(irJsonPath, 'utf8'));
const irB64 = fs.readFileSync(irPath).toString('base64');

const nav = require('./nav-partial.js');
const navHtml = nav.navHtml('demo-degradation.html');

/*
 * The degradation ladder.
 *
 * Each type declares five steps from clean to severe, and the step value is the number the slider snaps
 * to - so a slider position is always a real, named impairment rather than an arbitrary interpolation.
 * `apply` receives normalized audio and returns degraded audio; the implementations mirror
 * tests/degradation-matrix.js so the demo and the published matrix describe the same channel:
 *
 *   - AWGN / 频率偏移 / 采样率失配 call ChannelSim's own stages, so there is ONE implementation.
 *   - 削波 and 声学路径 are implemented here because ChannelSim has no clipping stage and its multipath
 *     stage is a discrete echo, whereas the matrix models a diffuse room tail. They are transcribed from
 *     the matrix (same allpass topology, same early-reflection table) rather than re-invented, and the
 *     comment says so - a demo that quietly measured a different channel than the report would be worse
 *     than no demo.
 */
const LADDER_JS = String.raw`
var SR = 8000;

/* ---- room model: real impulse response + a wet-level control ----
 *
 * The IR is baked by tests/bake-demo-ir.js from the matrix's own buildIR and normalised to unit energy, so
 * "50% wet" means exactly that and the dry component is never quietly attenuated.
 *
 * THREE TRANSCRIPTION ERRORS WERE MADE ON THE WAY HERE, AND ALL THREE PRODUCED A PAGE THAT LOOKED FINE:
 *
 *   1. The matrix's allpass gains are COMPUTED (combCoef x gainScaleFor, clamped at 0.97), not the 'g'
 *      field of its DIFFUSE table. That field belongs to the convolution constructor. Taking it literally
 *      gave gains of 0.52-0.62 instead of ~0.026-0.075, i.e. ~20x too much feedback: every acoustic step
 *      reported "decode failed" while the page rendered perfectly.
 *   2. A "tail scale so a longer RT60 does not get louder" was invented when an earlier draft set the
 *      gains to zero and the output looked hot. The matrix has no such scale.
 *   3. gForSection depended on gainScaleFor, which is SOLVED NUMERICALLY at build time by measuring IRs -
 *      so it cannot be evaluated in a browser at all. That is what forced the IR approach above.
 *
 * tests/verify-demo-ladder.js is what catches this class of error: it decodes every step and reports a
 * no-op or a uniform failure instead of letting it pass as a strong result.
 */
var ROOM_IR = (function () {
  var bin = atob(ROOM_IR_B64);
  var n = bin.length / 4;
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, n);
})();

/*
 * CS() is how the ladder reaches the channel model: js/lib/sstv-channel.js exposes Channel.awgn,
 * Channel.gain and Channel.freqOffset, and that is the SAME module the matrix's noise and clock steps
 * use, so there is one implementation rather than two that can drift.
 *
 * This indirection was MISSING from the page in the first build, and the failure was specific and
 * instructive: the Node harness in tests/verify-demo-ladder.js passed CS in as a function parameter, so
 * every step worked there while the page threw "CS is not defined" on the first noise step. A harness that
 * supplies a symbol the page is supposed to define is not testing the page.
 */
function CS() { return globalThis.SSTVChannel; }

/**
 * Complex FFT using fft.js's ACTUAL complex API.
 *
 * Three attempts were needed here, and the second is the instructive one:
 *   v1 fed a hand-built Hermitian half-spectrum to inverseTransform -> all NaN.
 *   v2 built a complex FFT out of realTransform, on the assumption that it was the only primitive
 *      available. It compiled, produced finite numbers, and was WRONG: realTransform ignores the imaginary
 *      part of its input, so a complex round trip lost half the signal (delta response energy came out at
 *      0.15 of the IR's, and a random complex vector failed to round-trip at all - max error 1.8 on unit
 *      amplitudes). The library does expose transform/inverseTransform for interleaved complex data,
 *      plus fromComplexArray/toComplexArray; not reading the whole API cost two attempts.
 *
 * tests/diagnose-convolve-fft.js keeps the round-trip and delta checks, so this cannot silently regress.
 */
function fftComplex(re, im, inverse) {
  var N = re.length;
  var fft = new globalThis.FFT(N);
  var cplx = new Float32Array(2 * N);
  for (var i = 0; i < N; i++) { cplx[2 * i] = re[i]; cplx[2 * i + 1] = im[i]; }
  var out = new Float32Array(2 * N);
  if (inverse) fft.inverseTransform(out, cplx); else fft.transform(out, cplx);
  for (i = 0; i < N; i++) { re[i] = out[2 * i]; im[i] = out[2 * i + 1]; }
}

/**
 * Overlap-add convolution (direct definition, so it can be checked against a delta at any time - see
 * tests/diagnose-demo-convolve.js, which is what caught the NaN above).
 *
 * N = 8192 with B = 4096 keeps each block's tail (B + taps - 1 = 8895) inside the transform, so the IR is
 * fully represented without chunking it.
 */
function convolve(x, h) {
  var N = 8192, B = 4096;
  var Hr = new Float32Array(N), Hi = new Float32Array(N);
  for (var i = 0; i < N; i++) { Hr[i] = i < h.length ? h[i] : 0; Hi[i] = 0; }
  fftComplex(Hr, Hi, false);

  var out = new Float32Array(x.length + h.length);
  var re = new Float32Array(N), im = new Float32Array(N);
  for (var off = 0; off < x.length; off += B) {
    for (i = 0; i < N; i++) { re[i] = (off + i) < x.length ? x[off + i] : 0; im[i] = 0; }
    fftComplex(re, im, false);
    for (var k = 0; k < N; k++) {
      var pr = re[k] * Hr[k] - im[k] * Hi[k];
      var pi = re[k] * Hi[k] + im[k] * Hr[k];
      re[k] = pr; im[k] = pi;
    }
    fftComplex(re, im, true);
    for (i = 0; i < N && off + i < out.length; i++) out[off + i] += re[i];
  }
  return out.subarray(0, x.length);
}

/** Mix the room in at a given wet fraction; 0 is dry, 1 is the room alone. */
function roomMix(samples, wet) {
  if (!wet) return samples;
  var wetSig = convolve(samples, ROOM_IR);
  var out = new Float32Array(samples.length);
  for (var i = 0; i < samples.length; i++) out[i] = samples[i] * (1 - wet) + wetSig[i] * wet;
  return out;
}

function clip(samples, k) {
  var peak = 0, i;
  for (i = 0; i < samples.length; i++) { var a = Math.abs(samples[i]); if (a > peak) peak = a; }
  if (peak <= 0) return Float32Array.from(samples);
  var lim = peak / k;
  var out = new Float32Array(samples.length);
  for (i = 0; i < samples.length; i++) {
    var v = samples[i];
    out[i] = v > lim ? lim : (v < -lim ? -lim : v);
  }
  return out;
}

/* ---- true spectral shift (Hilbert analytic signal), transcribed from the matrix ----
 * A tuning error shifts the whole spectrum by a fixed number of Hz; it is NOT a resample. Resampling
 * scales frequency proportionally and also changes the line rate, i.e. it is a clock error. The matrix
 * documents that conflating the two made 5 Hz of tuning look catastrophic; the demo must not repeat it,
 * which is why this is a real shift and 采样率失配 below uses resample semantics. */
function hilbertFIR(taps) {
  var M = taps - 1;
  var h = new Float32Array(taps);
  for (var n = 0; n < taps; n++) {
    var k = n - M / 2;
    var v = 0;
    if (k !== 0 && (k % 2) !== 0) v = 2 / (Math.PI * k);
    var w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / M);
    h[n] = v * w;
  }
  return h;
}

var HILBERT_201 = hilbertFIR(201);

function shiftBy(samples, hz) {
  if (!hz) return samples;
  var nt = 201, h = HILBERT_201, M = (nt - 1) / 2;
  var n = samples.length, out = new Float32Array(n);
  var w = 2 * Math.PI * hz / SR;
  var span = 2 * M + 1;
  var buf = new Float32Array(nt), qRing = new Float32Array(span);
  var pos = 0;
  for (var i = 0; i < n; i++) {
    buf[pos] = samples[i];
    var q = 0, idx = pos;
    for (var k = 0; k < nt; k++) {
      q += h[nt - 1 - k] * buf[idx];
      idx = idx === 0 ? nt - 1 : idx - 1;
    }
    pos = pos === nt - 1 ? 0 : pos + 1;
    qRing[i % span] = q;
    var e = i - M;
    if (e >= 0) {
      var a = w * e;
      out[e] = samples[e] * Math.cos(a) + qRing[(e + M) % span] * Math.sin(a);
    }
  }
  for (var e2 = Math.max(0, n - M); e2 < n; e2++) {
    var a2 = w * e2;
    out[e2] = samples[e2] * Math.cos(a2) + qRing[(e2 + M) % span] * Math.sin(a2);
  }
  return out;
}

function applyAwgn(x, db) { return CS().Channel.awgn(x, db, 12345); }
function applyRate(x, ratio) { return CS().Channel.freqOffset(x, ratio); }

/*
 * Six steps per type, benign -> severe, so the slider always runs the same way and switching type
 * preserves the position. Step 0 is clean for every type, which is what makes the slider's left end the
 * reference decode rather than a special case.
 *
 * 频率失谐 lists negative offsets as the SEVERE end deliberately: measured, a negative shift costs far
 * more than the same positive shift (the search band's lower edge walks onto the 1500 Hz blanking tone).
 * Ordering by severity rather than by sign puts the failing cases where a user expects to find them, and
 * the description in the page says so.
 */
var TYPES = [
  { id: 'awgn', label: '加性噪声', desc: '把声音淹没在白噪声里，模拟弱信号接收。数值为信噪比，越低越吵。',
    steps: [
      { label: 'clean', sub: '无噪声', apply: function (x) { return x; } },
      { label: '30 dB', sub: '很轻', apply: function (x) { return applyAwgn(x, 30); } },
      { label: '20 dB', sub: '轻度', apply: function (x) { return applyAwgn(x, 20); } },
      { label: '15 dB', sub: '中度', apply: function (x) { return applyAwgn(x, 15); } },
      { label: '10 dB', sub: '严重', apply: function (x) { return applyAwgn(x, 10); } },
      { label: '6 dB', sub: '接近淹没', apply: function (x) { return applyAwgn(x, 6); } }
    ] },
  { id: 'clip', label: '硬削波', desc: '音量过大把波形顶部削平，模拟过载。倍数越高削得越狠。',
    steps: [
      { label: 'clean', sub: '不削波', apply: function (x) { return x; } },
      { label: '1.5×', sub: '轻微', apply: function (x) { return clip(x, 1.5); } },
      { label: '2×', sub: '轻度', apply: function (x) { return clip(x, 2); } },
      { label: '3×', sub: '中度', apply: function (x) { return clip(x, 3); } },
      { label: '4×', sub: '严重', apply: function (x) { return clip(x, 4); } },
      { label: '8×', sub: '极端', apply: function (x) { return clip(x, 8); } }
    ] },
  { id: 'freq', label: '频率失谐', desc: '收发双方频率对不准（单边带失谐）。注意负方向容限明显更差，这是实测结论。',
    steps: [
      { label: 'clean', sub: '无失谐', apply: function (x) { return x; } },
      { label: '+10 Hz', sub: '轻微（正向）', apply: function (x) { return shiftBy(x, 10); } },
      { label: '+30 Hz', sub: '中度（正向）', apply: function (x) { return shiftBy(x, 30); } },
      { label: '−10 Hz', sub: '轻微（反向）', apply: function (x) { return shiftBy(x, -10); } },
      { label: '−30 Hz', sub: '中度（反向）', apply: function (x) { return shiftBy(x, -30); } },
      { label: '−50 Hz', sub: '严重（反向）', apply: function (x) { return shiftBy(x, -50); } }
    ] },
  { id: 'rate', label: '采样率失配', desc: '两边时钟快慢不一致，画面会被逐行拉长或压扁。',
    steps: [
      { label: 'clean', sub: '无失配', apply: function (x) { return x; } },
      { label: '0.1 %', sub: '极轻', apply: function (x) { return applyRate(x, 1.001); } },
      { label: '0.2 %', sub: '轻微', apply: function (x) { return applyRate(x, 1.002); } },
      { label: '0.5 %', sub: '中度', apply: function (x) { return applyRate(x, 1.005); } },
      { label: '1 %', sub: '严重', apply: function (x) { return applyRate(x, 1.01); } },
      { label: '2 %', sub: '超出适用范围', apply: function (x) { return applyRate(x, 1.02); } }
    ] },
  { id: 'acoustic', label: '声学路径', desc: '外放后用麦克风录，房间混响把声音糊掉。这里的强度是"混响占比"：0% 是干信号，100% 只剩房间声。房间冲激响应由矩阵模型烘焙而成（RT60 0.30 s）。',
    steps: [
      { label: 'clean', sub: '干信号', apply: function (x) { return x; } },
      { label: '混响 8 %', sub: '轻微房间感', apply: function (x) { return roomMix(x, 0.08); } },
      { label: '混响 18 %', sub: '明显房间感', apply: function (x) { return roomMix(x, 0.18); } },
      { label: '混响 35 %', sub: '混响偏重', apply: function (x) { return roomMix(x, 0.35); } },
      { label: '混响 60 %', sub: '混响主导', apply: function (x) { return roomMix(x, 0.60); } },
      { label: '混响 100 %', sub: '只剩房间声', apply: function (x) { return roomMix(x, 1.0); } }
    ] },
  { id: 'combo', label: '组合退化', desc: '多种损伤同时出现——这才是真实传输的样子。',
    steps: [
      { label: 'clean', sub: '无退化', apply: function (x) { return x; } },
      { label: '噪声 20 dB + 失谐 +20 Hz', sub: '弱信号叠加失谐',
        apply: function (x) { return applyAwgn(shiftBy(x, 20), 20); } },
      { label: '削波 3× + 噪声 15 dB', sub: '过载 + 弱信号',
        apply: function (x) { return clip(applyAwgn(x, 15), 3); } },
      { label: '混响 30 % + 失谐 −10 Hz', sub: '房间 + 失谐',
        apply: function (x) { return shiftBy(roomMix(x, 0.30), -10); } },
      { label: '削波 3× + 时钟 0.5 %', sub: '过载 + 时钟差',
        apply: function (x) { return clip(applyRate(x, 1.005), 3); } },
      { label: '混响 50 % + 削波 3× + 失谐 −20 Hz', sub: '最坏情况',
        apply: function (x) { return clip(shiftBy(roomMix(x, 0.50), -20), 3); } }
    ] }
];
`;

/*
 * BUILD-TIME GUARD for the mistake this generator kept making.
 *
 * LADDER_JS is a String.raw template literal, so a single backtick anywhere inside it terminates the
 * literal and the file fails to parse - with an error pointing at the comment line rather than at the
 * template, which reads like a syntax problem in prose. It happened three times, each time from writing
 * `identifier` in a comment.
 *
 * This asserts the ladder is backtick-free and non-empty BEFORE the template is built, so the failure names
 * the real cause.
 */
if (LADDER_JS.indexOf('`') >= 0) {
  const line = LADDER_JS.slice(0, LADDER_JS.indexOf('`')).split('\n').length;
  console.error('LADDER_JS 第 ' + line + ' 行含反引号 —— 会截断 String.raw 模板。');
  console.error('请把反引号改成普通引号（注释里的反引号同样会触发）。');
  process.exit(1);
}
if (LADDER_JS.length < 500) {
  console.error('LADDER_JS 异常短（' + LADDER_JS.length + ' 字符）—— 模板可能已被截断。');
  process.exit(1);
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>抗干扰 SSTV 解码 · 实时演示</title>
<link rel="stylesheet" href="css/style.css">
</head>
<body>
${navHtml}

<div class="wrap page-head">
  <h1>抗干扰能力 · 实时演示</h1>
  <p class="muted">拖动强度滑块，当场对音频施加退化并重新解码，直接看结果。全部在你的浏览器里完成。</p>
</div>

<section class="wrap">
  <div class="card demo-card">
    <div class="demo-row">
      <span class="demo-label">退化类型</span>
      <div class="demo-tabs" id="typeTabs" role="tablist"></div>
    </div>
    <p class="hint" id="typeDesc"></p>

    <div class="demo-row">
      <span class="demo-label">退化强度</span>
      <div class="demo-slider">
        <input type="range" id="strength" min="0" max="5" step="1" value="0" aria-label="退化强度">
        <div class="demo-ticks" id="ticks"></div>
      </div>
    </div>

    <div class="demo-actions">
      <button id="runBtn" class="primary">开始退化演示</button>
      <button id="resetBtn" class="ghost">重置</button>
      <span class="demo-status" id="status" role="status" aria-live="polite">正在载入基础音频…</span>
    </div>

    <div class="demo-progress" id="progressWrap" hidden><div id="progressBar"></div></div>
  </div>
</section>

<section class="wrap">
  <div class="card">
    <div class="preview two">
      <div>
        <canvas id="cvClean" width="${m.mode === 'PD120' || m.mode === 'PD180' ? 640 : 320}" height="${m.mode === 'PD120' || m.mode === 'PD180' ? 496 : 256}" class="demo-canvas"></canvas>
        <div class="preview-meta">原始图（无退化，${m.modeName}）</div>
      </div>
      <div>
        <canvas id="cvDeg" width="${m.mode === 'PD120' || m.mode === 'PD180' ? 640 : 320}" height="${m.mode === 'PD120' || m.mode === 'PD180' ? 496 : 256}" class="demo-canvas"></canvas>
        <div class="preview-meta" id="degCaption">当前退化下的解码（还没跑）</div>
      </div>
    </div>

    <div class="demo-metrics" id="metrics" hidden>
      <div class="demo-verdict" id="verdict"></div>
      <table class="demo-metric-table">
        <tbody>
          <tr><th>PSNR（与真值对比）</th><td id="mPsnr">—</td><td class="demo-metric-note">越高越好，低于 25 dB 视为不可用</td></tr>
          <tr><th>逐行锁定行数</th><td id="mLines">—</td><td class="demo-metric-note">一共 256 行，锁得越少说明丢得越多</td></tr>
          <tr><th>实测行周期</th><td id="mPeriod">—</td><td class="demo-metric-note">对逐行同步位置做稳健拟合得到的每行采样数</td></tr>
          <tr><th>行抖动（MAD）</th><td id="mJitter">—</td><td class="demo-metric-note">每行同步相对拟合直线的离散程度，越小越稳</td></tr>
          <tr><th>色度比 σ(G−R)/σ(L)</th><td id="mChroma">—</td><td class="demo-metric-note">明显高于原图即为编码引入的色带</td></tr>
          <tr><th>退化耗时</th><td id="mDegMs">—</td><td class="demo-metric-note">在内存里即时施加，不读预生成文件</td></tr>
          <tr><th>解码耗时</th><td id="mDecMs">—</td><td class="demo-metric-note">快速档（窗因子 ×8）</td></tr>
        </tbody>
      </table>
      <p class="hint" id="degNote"></p>
    </div>
  </div>
</section>

<section class="wrap">
  <details class="card">
    <summary>这个演示在测什么？</summary>
    <p>页面上用的是同一段音频，每次只改一件事，然后重新解码一次。所以曲线不会骗人——
      你看到的就是解码器在那种退化下的真实表现。</p>
    <ul class="demo-notes">
      <li><b>基础音频</b>：一段 ${m.durationS.toFixed(0)} 秒的 ${m.modeName} 扫描，
        采样率 ${m.sampleRate / 1000} kHz，已内嵌在页面里（所以双击本文件也能用，不需要服务器）。
        它在无退化下解码为 <b>${m.cleanPsnrDb} dB</b>，这就是"满分"。</li>
      <li><b>真值图</b>：色块 + 灰阶渐变 + 细节棋盘。PSNR 是与这张已知原图逐像素比较得出的，
        所以它是绝对分数，不是估计。</li>
      <li><b>退化</b>：与 <code>tests/degradation-matrix.js</code> 用的是同一套实现
        （噪声／失谐／时钟失配复用信道模拟器，削波与混响按矩阵里的同一拓扑转写）。</li>
      <li><b>为什么只跑一次</b>：解码要一秒多，做不到真正连续。滑块选定后点按钮才跑，
        避免拖动过程中排队堆积。</li>
      <li><b>已知不对称</b>：频率失谐的正负方向容限不同，负方向明显更差。这是实测结论，
        根因已定位但修复会牺牲干净音频的画质，所以保留现状。详见
        <a href="tech.html">技术报告</a> 第 6 章。</li>
    </ul>
  </details>
</section>

<footer class="wrap site-footer">
  <p class="muted"><a href="https://yhl4466.github.io/robust-stego/" target="_blank" rel="noopener">另见 RobustStego →</a></p>
  <p class="muted">纯前端 · 可在浏览器直接双击本文件运行（file://）· 无任何后端依赖</p>
</footer>

<!-- Classic scripts only: ES modules are blocked on file:// (opaque origin), so load order matters. -->
<script src="js/lib/fft.js"></script>
<script src="js/lib/sstv-modes.js"></script>
<script src="js/lib/sstv-timeline.js"></script>
<script src="js/lib/sstv-synth.js"></script>
<script src="js/lib/wav.js"></script>
<script src="js/lib/sstv-decode.js"></script>
<script src="js/lib/sstv-channel.js"></script>
<script src="js/channel-sim.js"></script>
<script>
/* The base clip, its ground-truth raster and the room impulse response, inlined so the page works from
   file:// as well as http. */
var BASE_WAV_B64 = "${audioB64}";
var TRUTH_PNG_B64 = "${truthB64}";
var ROOM_IR_B64 = "${irB64}";
var BASE_META = ${JSON.stringify({ mode: m.mode, modeName: m.modeName, sampleRate: m.sampleRate,
  quality: m.quality, durationS: m.durationS, cleanPsnrDb: m.cleanPsnrDb, decodeMs: m.decodeMs })};
</script>
<script>
${LADDER_JS}
</script>
<script src="js/demo-degradation.js"></script>
</body>
</html>
`;

const out = path.join(ROOT, 'demo-degradation.html');
fs.writeFileSync(out, html, 'utf8');
console.log('wrote demo-degradation.html (' + (Buffer.byteLength(html) / 1024 / 1024).toFixed(2) + ' MB)');
console.log('  mode ' + m.modeName + ' · ' + m.sampleRate + ' Hz · clean ' + m.cleanPsnrDb + ' dB · ' +
  m.durationS.toFixed(0) + ' s');
console.log('  audio base64 ' + (audioB64.length / 1024 / 1024).toFixed(2) + ' MB · truth base64 ' +
  (truthB64.length / 1024).toFixed(1) + ' KB');
