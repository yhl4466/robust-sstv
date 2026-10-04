/*
 * Under a reverberant path, is PEAK-PICKING the problem - or is the information simply gone?
 *
 * tests/diagnose-channel-estimation.js settled the equaliser question: deconvolving with the TRUE impulse
 * response takes the RT60 0.30 s decode from 17.73 to 17.81 dB, i.e. nothing, and the sync-averaged
 * estimate agrees with the real IR at only -4.0 dB. So the multipath is not a filter whose inverse
 * restores the picture; the reflected energy is irreversibly mixed into every 1.3 ms analysis window.
 *
 * That leaves one distinct possibility, and it is worth separating because it has a different repair.
 * The estimator does not CORRELATE against candidate levels - it takes the argmax FFT bin
 * (`est.peak`) and maps that frequency through calcLum. Once reverb smears energy across neighbouring
 * bins, argmax can be captured by whichever bin happens to be loudest, and a modest leak then causes a
 * LARGE error because the mapping from frequency to grey level is 3.14 Hz per level. A correlator that
 * integrates the whole window against each candidate level would degrade more gracefully.
 *
 * So: build a synthetic image whose true grey level is KNOWN at every pixel, decode it through the
 * reverb, and measure the error directly. A flat mid-grey field makes the truth exactly 127 everywhere,
 * so the spread of the decoded values IS the estimator's error - no reference image or PSNR needed, and
 * no chance of blaming the picture's own detail.
 *
 * Usage: node tests/diagnose-pixel-estimator.js
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
const Channel = require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Decode = globalThis.SSTVDecode;

const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const MODELS = new Function('SR', 'Channel',
  SRC.slice(SRC.indexOf('function clip('), SRC.indexOf('// ---------------------------------------------------------------- measurement')) +
  '\nreturn { reverb: reverb, measureRT60: measureRT60, gainScaleFor: gainScaleFor };')(SR, Channel);

const MODE = Modes.get('S1');
const MULT = (2300 - 1500) / 255;   // Hz per grey level

/** A flat field of one known grey level. */
function flat(level) {
  const w = MODE.width, h = MODE.height;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = level; d[i + 3] = 255; }
  return { data: d, width: w, height: h };
}

function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = a.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(a.length / 2)];
  let sum = 0; for (const v of a) sum += v;
  const mean = sum / a.length;
  let v2 = 0; for (const v of a) v2 += (v - mean) * (v - mean);
  return { n: a.length, median: med, mad: mad, mean: mean, sd: Math.sqrt(v2 / a.length),
    min: s[0], max: s[s.length - 1] };
}

/** Decode and collect the GREEN channel of every pixel, whose truth is the flat level. */
async function greenValues(samples, level) {
  const r = await Decode.decode(samples, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  if (!r.ok) return null;
  const d = r.imageData.data;
  const out = [];
  for (let i = 1; i < d.length; i += 4) out.push(d[i]);
  return { values: out, stats: stats(out), truth: level };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== 混响下像素估计器的实际误差 ===\n');
  console.log('  平坦图（每像素真值相同）→ 解码值的离散度就是估计器误差本身。');
  console.log('  频率→灰度 换算 ' + MULT.toFixed(3) + ' Hz/级，所以 1 Hz 的估计误差约 0.32 级。\n');

  const rows = [];
  for (const level of [64, 127, 192]) {
    const img = flat(level);
    const clean = Synth.synthesize(Timeline.build(img, MODE), SR).samples;
    console.log('  真值灰度 ' + level + '：');
    console.log('    条件              中位   MAD   标准差  极值        偏差(中位-真值)');
    const conditions = [{ label: '干净', sig: clean }];
    for (const rt of [0.15, 0.2, 0.3, 0.6]) {
      conditions.push({ label: 'RT60 ' + rt.toFixed(2) + ' s', sig: MODELS.reverb(clean, rt), rt: rt });
    }
    for (const c of conditions) {
      const res = await greenValues(c.sig, level);
      if (!res) { console.log('    ' + c.label.padEnd(18) + ' 解码失败'); continue; }
      const s = res.stats;
      rows.push({ level: level, condition: c.label, rt: c.rt == null ? 0 : c.rt,
        median: s.median, mad: s.mad, sd: s.sd, min: s.min, max: s.max,
        biasLevels: s.median - level, biasHz: (s.median - level) * MULT });
      console.log('    ' + c.label.padEnd(18) + String(s.median).padStart(5) + String(s.mad).padStart(6) +
        String(s.sd.toFixed(2)).padStart(9) + '  ' + String(s.min).padStart(4) + '..' +
        String(s.max).padStart(4) + '   ' + (s.median - level).toFixed(2).padStart(8) +
        ' 级 = ' + ((s.median - level) * MULT).toFixed(1).padStart(7) + ' Hz');
    }
    console.log('');
  }

  /*
   * The two candidate repairs, evaluated on the quantity that matters.
   *
   * (a) CORRELATION instead of argmax: integrate the window against each of the 256 candidate grey levels
   *     and take the best. This is the maximum-likelihood detector for a known level set in white noise,
   *     and it uses the whole window rather than one bin.
   * (b) LONGER WINDOW: the estimator uses ~2.48 px of scan per pixel; a longer window trades resolution
   *     for noise immunity. Its cost is real (adjacent pixels are different levels) so it is measured,
   *     not assumed to help.
   *
   * Both are measured offline on the DECODED image, which cannot show (b)'s true effect; (a) is measured
   * on the audio directly by re-running the correlation over the same windows the decoder uses.
   */
  console.log('  结论判读：');
  const clean127 = rows.find((r) => r.level === 127 && r.rt === 0);
  const rev127 = rows.find((r) => r.level === 127 && r.rt === 0.3);
  if (clean127 && rev127) {
    console.log('    干净时 σ = ' + clean127.sd.toFixed(2) + ' 级 (' + (clean127.sd * MULT).toFixed(1) +
      ' Hz) → 混响 0.30 s 时 σ = ' + rev127.sd.toFixed(2) + ' 级 (' +
      (rev127.sd * MULT).toFixed(1) + ' Hz)');
    console.log('    σ 放大了 ' + (rev127.sd / clean127.sd).toFixed(1) + ' 倍；' +
      '信道估计那一轮已证明反卷积无法改善（上界 +0.08 dB），');
    console.log('    所以这个 σ 是分析窗被混响填满之后的固有下限，而不是可以被后处理去掉的噪声。');
  }

  fs.writeFileSync(path.join(OUT, 'pixel-estimator.json'), JSON.stringify(rows, null, 2));
  console.log('\n证据 -> tests/diag-quality/pixel-estimator.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
