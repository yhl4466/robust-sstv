/*
 * Why is the frequency-offset response one-sided?
 *
 * The matrix measures a large asymmetry (+50 Hz decodes at 31.29 dB, -50 Hz at 17.30 dB) with the AFC
 * estimating the offset accurately in BOTH directions, and tests/model-selftest.js rules out the
 * impairment model. This looks for the mechanism in the two places a frequency shift meets a
 * FIXED, UNCONVERTED threshold:
 *
 *   SYNC_DETECT_HZ = 1350
 *     alignSync's walk decides "this window still contains a sync pulse" by testing
 *     est.peak(...) <= 1350 against a RAW frequency. Under a +100 Hz tuning error the sync pulse itself
 *     sits at 1300 Hz, only 50 Hz below the threshold, and the 1.4x-pulse window also covers the
 *     following porch and the first part of the scan - so what the test reads depends on the CONTENT
 *     after the sync, which is exactly what a one-sided response would look like.
 *
 *   IMAGE_BAND_MARGIN_HZ = 200, applied on the raw axis
 *     imageBandRaw maps 1500/2300 nominal through the calibration, which is right, but then subtracts a
 *     margin that is a nominal-space quantity from a raw-space bound. Small at 1% clock error (0.3%),
 *     so probably not the cause here - measured rather than assumed below.
 *
 * Usage: node tests/diagnose-sync-threshold.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Decode = globalThis.SSTVDecode;

const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const freqShift = new Function('SR',
  SRC.slice(SRC.indexOf('function hilbertFIR'), SRC.indexOf('/** Decoder lock residuals')) +
  '\nreturn freqShift;')(SR);

const MODE = Modes.get('S1');
const SYNC_DETECT_HZ = 1350;

/*
 * The walk's own test, reproduced exactly: a 1.4 x pulse window, dominant frequency over the whole
 * spectrum, compared against the raw threshold. This is the quantity that decides whether alignSync
 * believes it is inside a pulse.
 */
function walkReading(samples, offset, mult) {
  const est = new Decode._internal.Estimator(SR, mult == null ? 16 : mult);
  const syncWindow = Math.round(MODE.syncPulse * 1.4 * SR);
  return est.peak(samples, offset, syncWindow);
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const tl = Timeline.build(img, MODE);
  const clean = Synth.synthesize(tl, SR).samples;

  // the encoder's own sync segment starts, so the reading can be taken exactly ON a pulse
  const syncs = [];
  let acc = 0;
  for (let i = 0; i < tl.segments.length; i++) {
    const s = tl.segments[i];
    if (i >= tl.headerSegments && s.kind === 'tone' && Math.abs(s.freq - Modes.FREQ_SYNC) < 1) syncs.push(Math.round(acc * SR));
    acc += s.dur;
  }
  console.log('=== 同步检测门限的原始频率读数 ===\n');
  console.log('  阈值 SYNC_DETECT_HZ = ' + SYNC_DETECT_HZ + ' Hz，作用在未标定的原始频率上');
  console.log('  同步标称 1200 Hz · 窗长 ' + (MODE.syncPulse * 1.4 * 1000).toFixed(2) + ' ms（脉冲本身 ' +
    (MODE.syncPulse * 1000).toFixed(2) + ' ms，余量覆盖后续 porch 与扫描开头）\n');

  // sample many sync pulses; some rows have bright content right after the sync, some dark
  const probe = [];
  for (let i = 8; i < Math.min(syncs.length, 248); i += 1) probe.push(syncs[i]);

  console.log('  频偏   脉冲上读数(中位/最小/最大)   超阈值的比例   解码 PSNR');
  const rows = [];
  for (const hz of [0, 10, -10, 20, -20, 30, -30, 50, -50, 80, -80, 100, -100]) {
    const sig = hz === 0 ? clean : freqShift(clean, hz);
    const est = new Decode._internal.Estimator(SR, 16);
    const syncWindow = Math.round(MODE.syncPulse * 1.4 * SR);
    const vals = probe.map((p) => est.peak(sig, p, syncWindow)).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    const over = vals.filter((v) => v > SYNC_DETECT_HZ).length;
    const r = await Decode.decode(sig, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    let ps = null;
    if (r.ok) {
      let se = 0, n = 0;
      for (let i = 0; i < r.imageData.data.length; i++) {
        if (i % 4 === 3) continue;
        const d = r.imageData.data[i] - img.data[i]; se += d * d; n++;
      }
      ps = 10 * Math.log10(65025 / (se / n));
    }
    rows.push({ hz, med, min: vals[0], max: vals[vals.length - 1], overPct: 100 * over / vals.length, psnr: ps });
    console.log('  ' + String(hz).padStart(4) + '   ' + med.toFixed(0).padStart(6) + ' / ' +
      vals[0].toFixed(0).padStart(5) + ' / ' + vals[vals.length - 1].toFixed(0).padStart(5) +
      '        ' + (100 * over / vals.length).toFixed(1).padStart(5) + '%        ' +
      (ps == null ? '失败' : ps.toFixed(2)));
  }

  console.log('\n  预期：真实调谐误差把 1200 Hz 平移到 1200+Δ。因此正偏读数应约 ' +
    '1200+Δ，负偏约 1200-Δ，');
  console.log('        而阈值固定为 1350 —— 只有当读数超阈值时 walk 才会认定"已经离开脉冲"。');

  /* ---- how much of the gap is explained by the threshold, and how much is not ---- */
  const plus = rows.find((r) => r.hz === 50), minus = rows.find((r) => r.hz === -50);
  if (plus && minus) {
    console.log('\n  对照 ±50 Hz: 正偏读数 ' + plus.med.toFixed(0) + ' Hz（超阈值 ' +
      plus.overPct.toFixed(1) + '%）→ PSNR ' + (plus.psnr == null ? '失败' : plus.psnr.toFixed(2)) +
      ' · 负偏读数 ' + minus.med.toFixed(0) + ' Hz（超阈值 ' + minus.overPct.toFixed(1) + '%）→ PSNR ' +
      (minus.psnr == null ? '失败' : minus.psnr.toFixed(2)));
    console.log('  若负偏的读数更多落入"未超阈值"（即被判为仍在脉冲内），同步锁定就会停在预测位置，');
    console.log('  这正是修复前的 phigros 缺陷形态。');
  }

  /* ---- the band margin, on the raw axis ---- */
  console.log('\n  图像带边界（imageBandRaw，标定后 ±200 Hz 余量）');
  console.log('  频偏    标定 a       标定 b      带下界   带上界   带外比例');
  for (const hz of [0, 50, -50, 100, -100]) {
    const sig = hz === 0 ? clean : freqShift(clean, hz);
    const r = await Decode.decode(sig, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    if (!r.ok) { console.log('  ' + String(hz).padStart(4) + '   解码失败'); continue; }
    const a = r.calibration.scale, b = r.calibration.offsetHz;
    const lo = a * 1500 + b - 200, hi = a * 2300 + b + 200;
    console.log('  ' + String(hz).padStart(4) + '   ' + a.toFixed(6) + '   ' + b.toFixed(2).padStart(8) +
      '   ' + lo.toFixed(0).padStart(6) + '   ' + hi.toFixed(0).padStart(6) + '   ' +
      (((hi - lo) - 800) / 800 * 100).toFixed(1) + '%');
  }

  fs.writeFileSync(path.join(OUT, 'sync-threshold.json'), JSON.stringify(rows, null, 2));
  console.log('\n证据 -> tests/diag-quality/sync-threshold.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
