/*
 * Where does a reverberant path break the decode?
 *
 * The corrected matrix shows the acoustic path is the worst practical impairment: RT60 0.20 s costs
 * 7.1 dB (30.50 -> 23.39), RT60 0.30 s costs 12.8 dB (-> 17.73), and 0.60 s fails outright. A user
 * playing audio through a speaker and recording it with a phone is on exactly this axis, so before
 * touching anything the failing stage has to be named.
 *
 * Four candidates, four measurements, all against the SAME reverb the matrix applies:
 *   sync lock    - the per-line residual spread. 7 samples MAD at 0.20 s and 12 at 0.30 s, i.e.
 *                  under one pixel, which is already too small to explain 7-13 dB.
 *   header/VIS   - whether the mode is even found.
 *   pixel estimate - the dominant frequency readout over known image content, compared with clean.
 *                  A smeared tone makes every pixel's estimate noisy in the SAME way, which is the
 *                  signature that would explain a large uniform PSNR loss.
 *   band content - how much energy the reverb has moved OUTSIDE the 1500-2300 Hz image band.
 *
 * Usage: node tests/diagnose-reverb.js
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

// lift the reverb from the matrix so both use one implementation
const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const MODELS = new Function('SR', 'Channel', SRC.slice(SRC.indexOf('function clip('),
  SRC.indexOf('// ---------------------------------------------------------------- measurement')) +
  '\nreturn { reverb: reverb, measureRT60: measureRT60, gainScaleFor: gainScaleFor };')(
    SR, require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js')));

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}

/** Dominant frequency in a short window - the same quantity the pixel estimator reads. */
function dominant(x, off, len, lo, hi) {
  const N = 512;
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

/** Energy in 1500-2300 Hz vs total, over a window: how much of the image band survives. */
function bandFraction(x, off, len) {
  const N = 2048;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) re[i] = (x[off + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  new globalThis.FFT(N).realTransform(o, re);
  let inBand = 0, all = 0;
  for (let k = 1; k < N / 2; k++) {
    const m = o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
    all += m;
    const f = k * SR / N;
    if (f >= 1500 && f <= 2300) inBand += m;
  }
  return all > 0 ? inBand / all : 0;
}

/** Residual spread of the per-line lock against the encoder's own syncs. */
function lockSpread(refs) {
  const locked = refs.filter((r) => !r.freeRun);
  if (locked.length < 8) return null;
  const N = locked.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += i; sy += locked[i].ref; sxx += i * i; sxy += i * locked[i].ref; }
  const den = N * sxx - sx * sx;
  const slope = den ? (N * sxy - sx * sy) / den : 0, inter = (sy - slope * sx) / N;
  const res = locked.map((r, i) => r.ref - (inter + slope * i)).sort((a, b) => a - b);
  const bias = res[Math.floor(res.length / 2)];
  const mad = res.map((v) => Math.abs(v - bias)).sort((a, b) => a - b)[Math.floor(res.length / 2)];
  return { mad, freeRun: refs.length - locked.length, n: N };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(img, Modes.get('S1')), SR).samples;

  console.log('=== 混响（声学路径）破坏的是哪一级 ===\n');
  console.log('  RT60实测  模式   行锁MAD  丢锁行  带内能量比  像素频率误差(中位/标准差)  PSNR');
  const rows = [];

  // reference band fraction and the clean pixel-frequency trace, taken on the clean signal
  const probePos = [];
  for (let i = 0; i < 400; i++) probePos.push(700000 + i * 5000);
  const cleanFreq = probePos.map((p) => dominant(clean, p, 64, 1300, 2500));
  const cleanBand = probePos.map((p) => bandFraction(clean, p, 2048));

  for (const rt of [0.15, 0.3, 0.6]) {
    const measured = MODELS.measureRT60(rt, MODELS.gainScaleFor(rt));
    const sig = MODELS.reverb(clean, rt);
    const refs = [];
    const r = await Decode.decode(sig, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
    if (!r.ok) {
      console.log('  ' + measured.toFixed(2) + '     失败  ' + (r.message || '').slice(0, 44));
      rows.push({ rt, measured, ok: false, message: r.message });
      continue;
    }
    const ls = lockSpread(refs);
    const errs = probePos.map((p, i) => dominant(sig, p, 64, 1300, 2500) - cleanFreq[i]);
    errs.sort((a, b) => a - b);
    const med = errs[Math.floor(errs.length / 2)];
    const sd = Math.sqrt(errs.reduce((s, v) => s + (v - med) * (v - med), 0) / errs.length);
    const bandNow = probePos.map((p) => bandFraction(sig, p, 2048));
    const bandDrop = cleanBand.reduce((s, v) => s + v, 0) / cleanBand.length -
                     bandNow.reduce((s, v) => s + v, 0) / bandNow.length;
    const m = psnr(r.imageData.data, img.data);
    console.log('  ' + measured.toFixed(2) + '    ' + (r.mode ? r.mode.name.slice(0, 6) : '?') + '  ' +
      (ls ? ls.mad.toFixed(1) : '--').padStart(7) + '  ' + (ls ? ls.freeRun : '--').toString().padStart(6) +
      '  ' + bandDrop.toFixed(4).padStart(10) + '   ' +
      (med.toFixed(1) + ' / ' + sd.toFixed(1)).padStart(16) + '   ' + m.toFixed(2));
    rows.push({ rt, measured, ok: true, lockMad: ls ? ls.mad : null, freeRun: ls ? ls.freeRun : null,
      bandDrop, freqErrMed: med, freqErrSd: sd, psnr: m });
    fs.writeFileSync(path.join(OUT, 'reverb-' + rt + '.png'),
      PNG.sync.write({ width: r.imageData.width, height: r.imageData.height,
        data: Buffer.from(r.imageData.data.buffer.slice(0)) }));
  }

  console.log('\n  带内能量比 = 1500-2300 Hz 能量占 0-24 kHz 的比例，相对干净信号的下降量');
  console.log('  像素频率误差 = 64 采样（约 1.3 ms，与像素窗同量级）窗内主频，400 个位置的统计');
  fs.writeFileSync(path.join(OUT, 'reverb-diagnosis.json'), JSON.stringify(rows, null, 2));
  console.log('\n证据 -> tests/diag-quality/reverb-diagnosis.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
