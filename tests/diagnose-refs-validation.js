/*
 * The last unvalidated link: are the per-line sync references right?
 *
 * WHERE WE ARE
 *   Phase 45 showed the estimator is not the problem: on the same references, the production FFT-peak
 *   estimator beat a phase-difference discriminator on row correlation (0.6126 vs 0.4690) and on the
 *   chroma ratio (1.4061 vs 1.6416 against a reference of 0.7952). A 0.4 ms discriminator scored
 *   "closer" to the reference only on the structure metrics, and that was NOISE - its row correlation
 *   collapsed to 0.0959. Swapping the estimator does not help.
 *
 *   So the line timing is the only link never verified with a trustworthy instrument. The phase-24
 *   comparison used a 1 ms-quantised envelope whose intervals were quantised to whole milliseconds
 *   (the artefact that produced the bogus "428.000 ms" line period); the phase-26 detector resolves
 *   0.25 ms and was validated at 0.0076 ms interval MAD on our own audio, and it has never been used
 *   for this comparison.
 *
 * WHAT THIS MEASURES
 *   Every per-line reference the decoder reports, against the nearest independently detected sync pulse
 *   start, plus the implied line interval. If the references track the true syncs, the recording
 *   itself is the limit and the honest answer is a boundary; if they drift or sit somewhere else, the
 *   line-lock is the defect.
 *
 * Usage: node tests/diagnose-refs-validation.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000, DECIM = Math.round(0.00025 * SR);

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline, Synth = globalThis.SSTVSynth,
      Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;
const MODE = Modes.get('S1');
const NOMINAL_LINE = Modes.lineTime(MODE) * SR;
const LINE_MS = NOMINAL_LINE / SR * 1000;

/** Phase-26 detector: quadrature envelope + local dominance, 0.25 ms resolution (validated). */
function detectSyncs(x, sr) {
  const freqs = [1200, 1500, 1900, 2300];
  const env = freqs.map((f) => {
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w);
    const a = Math.exp(-1 / (sr * 0.002));
    const n = Math.floor(x.length / DECIM), out = new Float32Array(n);
    let ci = 1, si = 0, I = 0, Q = 0, o = 0;
    for (let i = 0; i < x.length; i++) {
      const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
      I = a * I + (1 - a) * (x[i] * ci); Q = a * Q + (1 - a) * (x[i] * si);
      if (i % DECIM === 0 && o < n) out[o++] = Math.sqrt(I * I + Q * Q);
    }
    return out;
  });
  const n = env[0].length, msPerBin = DECIM / sr * 1000;
  const MINRUN = Math.round(4 / msPerBin), MAXRUN = Math.round(18 / msPerBin);
  const pulses = []; let run = -1;
  for (let k = 0; k < n; k++) {
    const on = env[0][k] > 1.4 * Math.max(env[1][k], env[2][k], env[3][k], 1e-4);
    if (on && run < 0) run = k;
    else if (!on && run >= 0) {
      if (k - run >= MINRUN && k - run <= MAXRUN) {
        let best = -1, bk = run;
        for (let q = run; q < k; q++) if (env[0][q] > best) { best = env[0][q]; bk = q; }
        const y1 = env[0][Math.max(0, bk - 1)], y2 = env[0][bk], y3 = env[0][Math.min(n - 1, bk + 1)];
        const den = y1 - 2 * y2 + y3, sh = den === 0 ? 0 : 0.5 * (y1 - y3) / den;
        pulses.push((bk + 0.5 + sh) * msPerBin / 1000 - MODE.syncPulse / 2);
      }
      run = -1;
    }
  }
  return pulses.sort((a, b) => a - b);
}

function stats(a) {
  const f = a.filter((v) => isFinite(v));
  if (!f.length) return null;
  const s = f.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of f) sum += v;
  return { n: f.length, median: med, mad: mad, mean: sum / f.length, min: s[0], max: s[s.length - 1] };
}

async function check(label, x, sr) {
  const refs = [];
  const dec = await Decode.decode(x, sr, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  const pulses = detectSyncs(x, sr);
  const truth = pulses.map((p) => p * sr);
  const dists = [], signs = [];
  for (const r of refs) {
    let best = Infinity, bp = 0;
    for (const t of truth) { const d = Math.abs(t - r.ref); if (d < best) { best = d; bp = t; } }
    dists.push(best); signs.push(r.ref - bp);
  }
  const ds = stats(dists), ss = stats(signs);
  // implied line interval from the decoder's own references
  const iv = [];
  for (let i = 1; i < refs.length; i++) iv.push((refs[i].ref - refs[i - 1].ref) / sr * 1000);
  const ivs = stats(iv);
  console.log('\n[' + label + ']');
  console.log('  独立检测到 ' + pulses.length + ' 个同步脉冲 · 解码器报告 ' + refs.length + ' 行');
  console.log('  行 0 参考 ' + (refs[0].ref / sr).toFixed(3) + ' s · 末行 ' +
    (refs[refs.length - 1].ref / sr).toFixed(3) + ' s');
  console.log('  |到最近真值同步|: 中位 ' + ds.median.toFixed(0) + ' 采样 (' +
    (ds.median / (Modes.get('S1').scanTime / 320 * sr)).toFixed(2) + ' 像素) · 最大 ' +
    ds.max.toFixed(0) + ' · MAD ' + ds.mad.toFixed(1));
  console.log('  带符号偏差: 中位 ' + ss.median.toFixed(0) + ' 采样 · MAD ' + ss.mad.toFixed(1) +
    ' · 极值 ' + ss.min.toFixed(0) + '..' + ss.max.toFixed(0));
  console.log('  解码器自身行间隔: 中位 ' + ivs.median.toFixed(4) + ' ms · MAD ' + ivs.mad.toFixed(4) +
    ' ms（标称 ' + LINE_MS.toFixed(4) + ' ms）');
  return { pulses: pulses.length, rows: refs.length, distToNearest: ds, signedBias: ss,
    lineInterval: ivs, refs: refs.map((r) => r.ref) };
}

(async function main() {
  console.log('=== 逐行同步参考的验证（用已校准的 0.25 ms 检测器）===\n');
  console.log('标称行 ' + LINE_MS.toFixed(4) + ' ms · 像素 ' +
    (MODE.scanTime / MODE.width * SR).toFixed(2) + ' 采样');

  // control: our own synthetic audio, where the decoder is known to be correct
  const w = MODE.width, h = MODE.height, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const i = (y * w + xx) * 4, v = Math.round(255 * xx / (w - 1));
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  const syn = Synth.synthesize(Timeline.build({ data: d, width: w, height: h }, MODE), SR).samples;
  const ctl = await check('对照组：合成 S1（解码器已知正确）', syn, SR);

  const pb = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const pinfo = Wav.parse(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
  const ph = await check('phigros（真实录音）', pinfo.samples, SR);

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 判定 =====');
  console.log('  对照组合成: |到最近真值同步| 中位 ' + ctl.distToNearest.median.toFixed(0) +
    ' 采样 · 带符号偏差中位 ' + ctl.signedBias.median.toFixed(0) + ' · 行间隔 MAD ' +
    ctl.lineInterval.mad.toFixed(4) + ' ms');
  console.log('  phigros  : |到最近真值同步| 中位 ' + ph.distToNearest.median.toFixed(0) +
    ' 采样 · 带符号偏差中位 ' + ph.signedBias.median.toFixed(0) + ' · 行间隔 MAD ' +
    ph.lineInterval.mad.toFixed(4) + ' ms');
  const px = MODE.scanTime / MODE.width * SR;
  const ratio = ph.distToNearest.median / Math.max(1, ctl.distToNearest.median);
  console.log('  phigros / 对照组 的参考误差比 = ' + ratio.toFixed(1) + ' 倍');
  const okRef = ph.distToNearest.median < px * 4;      // within ~4 px of a true sync
  console.log('  => ' + (okRef
    ? '★ phigros 的逐行参考【落在真同步脉冲附近】（' + (ph.distToNearest.median / px).toFixed(1) +
      ' 像素内）→ 时序正确 → 伤害来自录音本身，估计器与参考都无罪 ✗ 这是边界'
    : '★ phigros 的逐行参考【未落在真同步脉冲附近】（' + (ph.distToNearest.median / px).toFixed(1) +
      ' 像素外）→ 时序是缺陷所在 ✓ 可修'));

  fs.writeFileSync(path.join(OUT, 'refs-validation.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), nominalLineMs: LINE_MS, pixelSamples: px,
    control: ctl, phigros: ph, ratio: ratio, referencesNearTrueSync: okRef
  }, null, 2));
  console.log('\n  证据 -> tests/diag-quality/refs-validation.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
