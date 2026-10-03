/*
 * Is the decoder's frequency-offset response really one-sided?
 *
 * The degradation matrix reports a severe asymmetry: +50 Hz decodes at 31.29 dB (basically clean) while
 * -50 Hz gives 17.30 dB, and the sign flip happens between +10 and -10 Hz. A spectral shift is
 * symmetric, tests/verify-freqshift.js confirms our impairment model shifts both directions correctly,
 * and the AFC estimates the offset accurately in BOTH directions (b = +49.74 / -49.91). So the
 * asymmetry is real and is in the decoder - this dumps enough about each decode to say WHERE.
 *
 * Reported per case: PSNR, per-channel mean/sd of the output, how many samples saturate at 0 or 255,
 * the warnings, and the calibration actually applied.
 *
 * Usage: node tests/diagnose-freq-asymmetry.js
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

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}

function channelStats(img) {
  const d = img.data, n = img.width * img.height;
  const sum = [0, 0, 0], sq = [0, 0, 0];
  let lo = 0, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) { sum[c] += d[i + c]; sq[c] += d[i + c] * d[i + c]; }
    const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (L <= 1) lo++;
    if (L >= 254) hi++;
  }
  return {
    mean: sum.map((v) => v / n),
    sd: sum.map((v, c) => Math.sqrt(Math.max(0, sq[c] / n - (v / n) * (v / n)))),
    blackPct: 100 * lo / n, whitePct: 100 * hi / n
  };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(img, Modes.get('S1')), SR).samples;

  console.log('=== 频偏响应对称性诊断 ===\n');
  console.log('  hz   PSNR    a         b(Hz)     clockScale  黑%   白%   R/G/B 标准差    警告');
  const rows = [];
  const decoded = {};
  for (const hz of [0, 10, -10, 20, -20, 30, -30, 50, -50]) {
    const sig = hz === 0 ? clean : freqShift(clean, hz);
    const r = await Decode.decode(sig, SR, { quality: 'standard', yieldEvery: 0 });
    if (!r.ok) { console.log('  ' + String(hz).padStart(4) + '  解码失败: ' + r.message); continue; }
    const m = psnr(r.imageData.data, img.data);
    const st = channelStats(r.imageData);
    decoded[hz] = r.imageData;
    rows.push({ hz, psnr: m, a: r.calibration.scale, b: r.calibration.offsetHz,
      clockScale: r.calibration.clockScale, st, warnings: r.warnings });
    console.log('  ' + String(hz).padStart(4) + ' ' + m.toFixed(2).padStart(6) + '  ' +
      r.calibration.scale.toFixed(6) + '  ' + r.calibration.offsetHz.toFixed(2).padStart(8) + '  ' +
      r.calibration.clockScale.toFixed(6) + '  ' + st.blackPct.toFixed(1).padStart(5) + ' ' +
      st.whitePct.toFixed(1).padStart(5) + '  ' +
      st.sd.map((v) => v.toFixed(1)).join('/').padStart(15) + '  ' +
      (r.warnings || []).length);
    fs.writeFileSync(path.join(OUT, 'freqshift-' + (hz >= 0 ? 'p' : 'm') + Math.abs(hz) + '.png'),
      PNG.sync.write({ width: r.imageData.width, height: r.imageData.height,
        data: Buffer.from(r.imageData.data.buffer.slice(0)) }));
  }

  // Is the negative decode a MIRROR or a SHIFT of the positive one? Both are plausible signatures.
  if (decoded[50] && decoded[-50]) {
    const a = decoded[50].data, b = decoded[-50].data;
    const W = decoded[50].width, H = decoded[50].height;
    const cmp = (shift) => {
      let se = 0, n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const xs = x + shift;
          if (xs < 0 || xs >= W) continue;
          const i = (y * W + x) * 4, j = (y * W + xs) * 4;
          for (let c = 0; c < 3; c++) { const d = a[i + c] - b[j + c]; se += d * d; n++; }
        }
      }
      return 10 * Math.log10(65025 / (se / n));
    };
    let line = '  +50 vs -50 横向位移下的 PSNR: ';
    for (let s = -6; s <= 6; s += 2) line += s + ':' + cmp(s).toFixed(1) + '  ';
    console.log('\n' + line);
    // vertical mirror
    let se = 0, n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, j = ((H - 1 - y) * W + x) * 4;
        for (let c = 0; c < 3; c++) { const d = a[i + c] - b[j + c]; se += d * d; n++; }
      }
    }
    console.log('  +50 vs -50 上下翻转的 PSNR: ' + (10 * Math.log10(65025 / (se / n))).toFixed(2));
  }

  fs.writeFileSync(path.join(OUT, 'freq-asymmetry.json'),
    JSON.stringify(rows.map((r) => ({ hz: r.hz, psnr: r.psnr, a: r.a, b: r.b,
      clockScale: r.clockScale, blackPct: r.st.blackPct, whitePct: r.st.whitePct,
      sd: r.st.sd, mean: r.st.mean, warnings: r.warnings })), null, 2));
  console.log('\n证据 -> tests/diag-quality/freq-asymmetry.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
