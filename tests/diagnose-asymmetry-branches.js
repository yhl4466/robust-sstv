/*
 * Narrowing the frequency-offset asymmetry: does alignSync take a different BRANCH on the two sides?
 *
 * tests/diagnose-sync-threshold.js ruled out the SYNC_DETECT_HZ hypothesis: under +/-50 Hz the walk's
 * raw reading tracks the shift correctly (1254 / 1160 Hz) and crosses the 1350 Hz threshold in 0% of
 * cases on either side, so the sync detector is not what differs.
 *
 * The remaining difference has to be in what the decoder DOES with the lock, and phase 48 left an
 * instrument for exactly that: _internal.setAlignStats counts which alignSync branch runs. If the two
 * sides differ in how often the prediction starts inside a pulse, or in how often the phase-48 search
 * is elected, the asymmetry is a TIMING effect; if the branch counts match, it is downstream of the
 * lock (pixel estimation / calibration), which is a different repair.
 *
 * Also measures the frequency offset of the REAL phigros recording, because that decides whether this
 * defect matters for the actual target or is a synthetic-only curiosity.
 *
 * Usage: node tests/diagnose-asymmetry-branches.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const freqShift = new Function('SR',
  SRC.slice(SRC.indexOf('function hilbertFIR'), SRC.indexOf('/** Decoder lock residuals')) +
  '\nreturn freqShift;')(SR);

function freshStats() {
  return { calls: 0, startOfSyncCalls: 0, endOfSyncCalls: 0, startInSync: 0,
    startInImage: 0, searchElected: 0, bestFromSearch: 0, bestFromSearch0: 0 };
}

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  return 10 * Math.log10(65025 / (se / n));
}

/** Dominant frequency of a window, for the phigros offset measurement. */
function dom(x, off, len, lo, hi) {
  const N = 32768;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) re[i] = (x[off + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  new globalThis.FFT(N).realTransform(o, re);
  const k0 = Math.max(1, Math.ceil(lo * N / SR)), k1 = Math.min(N / 2 - 1, Math.floor(hi * N / SR));
  let best = -1, bk = k0;
  for (let k = k0; k <= k1; k++) {
    const m = Math.hypot(o[2 * k], o[2 * k + 1]);
    if (m > best) { best = m; bk = k; }
  }
  return bk * SR / N;
}

(async function main() {
  console.log('=== 频偏不对称：alignSync 分支是否不同 ===\n');
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(img, Modes.get('S1')), SR).samples;

  console.log('  频偏   调用  起始在脉冲内  起始在图象  搜索被选中  搜索改变预测  PSNR');
  for (const hz of [0, 20, -20, 50, -50, 80, -80]) {
    const sig = hz === 0 ? clean : freqShift(clean, hz);
    const st = freshStats();
    Decode._internal.setAlignStats(st);
    const r = await Decode.decode(sig, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    Decode._internal.setAlignStats(null);
    const ps = r.ok ? psnr(r.imageData.data, img.data) : null;
    console.log('  ' + String(hz).padStart(4) + '   ' + String(st.calls).padStart(5) + '   ' +
      String(st.startInSync).padStart(11) + '   ' + String(st.startInImage).padStart(9) + '   ' +
      String(st.searchElected).padStart(10) + '   ' + String(st.bestFromSearch).padStart(12) + '   ' +
      (ps == null ? '失败' : ps.toFixed(2)));
  }

  console.log('\n=== 真实 phigros 录音的实际频偏 ===\n');
  const pa = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  if (fs.existsSync(pa)) {
    const buf = fs.readFileSync(pa);
    const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const x = info.samples;
    // Measure the sync pulses directly: 1200 Hz nominal. Several windows across the recording, so a
    // drifting tuning error would show as a spread rather than one number.
    const offs = [];
    for (const t of [20, 40, 60, 80, 100, 120]) {
      offs.push(dom(x, Math.round(t * info.sampleRate), Math.round(0.020 * info.sampleRate), 1000, 1500) - 1200);
    }
    offs.sort((a, b) => a - b);
    console.log('  在 20/40/60/80/100/120 s 处测得 1200 Hz 脉冲相对标称的偏差：' +
      offs.map((v) => v.toFixed(0)).join(' / ') + ' Hz');
    console.log('  中位 ' + offs[3].toFixed(0) + ' Hz —— ' +
      (Math.abs(offs[3]) < 15 ? '远小于出现损失的 ±20 Hz 门槛，故本轮的频偏缺陷【不影响】真实录音'
                              : '已进入出现损失的区间，频偏缺陷【直接相关】'));
    const r = await Decode.decode(x, info.sampleRate, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    if (r.ok) {
      console.log('  解码器 AFC 报告的偏移 b = ' + r.calibration.offsetHz.toFixed(2) +
        ' Hz · 标定 a = ' + r.calibration.scale.toFixed(6));
    }
  } else {
    console.log('  缺少 phigros 音频');
  }
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
