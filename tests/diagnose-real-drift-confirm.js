/*
 * ============================ RESULT INVALIDATED - DO NOT USE ============================
 *
 * This script's own control is what invalidates it: it reads +22.5 Hz on a synthetic signal whose true
 * offset is 0.000 Hz, and its envelope-strength column RISES in the segments it claims are far
 * off-pitch, which is impossible. Its phigros readings (up to +395 Hz) are therefore not usable.
 *
 * See the header of tests/diagnose-real-drift.js for the full account, and
 * tests/diagnose-measurement-validation.js for the measured contamination bias of each method. The
 * phase-49 statement that the real recording's per-segment frequency offset is UNKNOWN still stands.
 * ========================================================================================
 *
 * Independent check of the phigros drift finding, with a detector that shares no code with the first.
 *
 * tests/diagnose-real-drift.js reports the 1200 Hz sync sitting 100-150 Hz high through most of the
 * recording (corrected by a detector baseline that it verifies as exactly 0.000 Hz on synthetic truth),
 * while the decoder's global AFC reports b = -0.29 Hz. Several segments read exactly 1350.00, which is
 * that search's upper BOUND, so those are saturation and cannot be trusted as numbers.
 *
 * This confirms or refutes the finding three ways, deliberately chosen not to reuse the first script:
 *
 *   1. SPECTRUM PEAK over a long window at several offsets, restricted to 1000-1500 Hz. A long window
 *      resolves the tone finely and cannot saturate at a bound set by the caller.
 *   2. SYNTHETIC CONTROL at a KNOWN offset (+150 Hz), so the method's own bias is measured rather than
 *      assumed. If method (1) reads 1350 on a signal that really is 1350, it works.
 *   3. ENVELOPE STRENGTH: an amplitude detector tuned to 1200 Hz loses output when the real tone is
 *      100 Hz away. If the segment strength against a 1200 Hz reference collapses in the same segments
 *      that read high, the offset is real and not a detector artefact.
 *
 * Usage: node tests/diagnose-real-drift-confirm.js
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

/** Spectrum peak in a band, interpolated between bins. Long window => fine resolution, no bound. */
function bandPeak(x, off, len, lo, hi) {
  const N = 65536;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) {
    const v = x[off + i] || 0;
    re[i] = v * 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
  }
  new globalThis.FFT(N).realTransform(o, re);
  const k0 = Math.max(1, Math.ceil(lo * N / SR)), k1 = Math.min(N / 2 - 1, Math.floor(hi * N / SR));
  let best = -1, bk = k0;
  for (let k = k0; k <= k1; k++) {
    const m = o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
    if (m > best) { best = m; bk = k; }
  }
  // quadratic interpolation on the three bins around the peak
  const y0 = Math.hypot(o[2 * (bk - 1)], o[2 * (bk - 1) + 1]);
  const y1 = Math.hypot(o[2 * bk], o[2 * bk + 1]);
  const y2 = Math.hypot(o[2 * (bk + 1)], o[2 * (bk + 1) + 1]);
  const den = y0 - 2 * y1 + y2;
  const d = den === 0 ? 0 : 0.5 * (y0 - y2) / den;
  return (bk + d) * SR / N;
}

/** 1200 Hz quadrature envelope RMS over a window: drops when the real tone is not at 1200. */
function envStrength(x, off, len, freq) {
  const w = 2 * Math.PI * freq / SR;
  let I = 0, Q = 0, a = Math.exp(-1 / (SR * 0.002)), acc = 0;
  let c = Math.cos(w), s = Math.sin(w), ci = 1, si = 0;
  for (let i = 0; i < len; i++) {
    const nci = ci * c - si * s, nsi = si * c + ci * s; ci = nci; si = nsi;
    const v = x[off + i] || 0;
    I = a * I + (1 - a) * (v * ci); Q = a * Q + (1 - a) * (v * si);
    acc += I * I + Q * Q;
  }
  return Math.sqrt(acc / len);
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

(async function main() {
  fs.mkdirSync(path.join(__dirname, 'diag-quality'), { recursive: true });
  const pa = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  const buf = fs.readFileSync(pa);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const x = info.samples;

  console.log('=== phigros 频偏：独立方法确认 ===\n');

  // ---- 2. synthetic control with a KNOWN offset, to measure this method's own bias ----
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const tl = Timeline.build(img, Modes.get('S1'));
  const clean = Synth.synthesize(tl, SR).samples;
  const syncs = [];
  {
    let acc = 0;
    for (let i = 0; i < tl.segments.length; i++) {
      const s = tl.segments[i];
      if (i >= tl.headerSegments && s.kind === 'tone' && Math.abs(s.freq - Modes.FREQ_SYNC) < 1) syncs.push(Math.round(acc * SR));
      acc += s.dur;
    }
  }
  const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
  const freqShift = new Function('SR',
    SRC.slice(SRC.indexOf('function hilbertFIR'), SRC.indexOf('/** Decoder lock residuals')) +
    '\nreturn freqShift;')(SR);

  console.log('  [控制] 合成 S1，同步真值 1200.000 Hz。把整段平移已知量，看本方法读出多少：');
  console.log('    施加平移    读数(中位 Hz)   误差(Hz)   包络强度@1200');
  for (const hz of [0, 50, 100, 150, 200]) {
    const sig = hz === 0 ? clean : freqShift(clean, hz);
    // read the sync tone with a 27 ms window centred just past each pulse start
    const vals = syncs.slice(5, 60).map((p) => bandPeak(sig, p + Math.round(0.002 * SR), Math.round(0.027 * SR), 1000, 1600));
    const m = median(vals);
    const str = syncs.slice(5, 60).map((p) => envStrength(sig, p + Math.round(0.002 * SR), Math.round(0.027 * SR), 1200));
    console.log('    +' + String(hz).padStart(3) + ' Hz      ' + m.toFixed(2).padStart(9) + '   ' +
      (m - 1200 - hz).toFixed(2).padStart(7) + '   ' + median(str).toFixed(4).padStart(10));
  }

  // ---- 1 + 3. the real recording ----
  console.log('\n  [实录音] 每 20 s 取 46 个同步位置，用长窗频谱读频，并给出 1200 Hz 包络强度：');
  console.log('    时间窗(s)   频谱读数中位(Hz)   相对标称(Hz)   包络强度@1200   相对 0-20 s');
  const SEG = 20;
  const nSeg = Math.floor(info.duration / SEG);
  const rows = [];
  let refStrength = null;
  for (let s = 0; s < nSeg; s++) {
    const t0 = s * SEG * SR, t1 = Math.min((s + 1) * SEG * SR, x.length);
    // locate sync candidates by the 1200 Hz envelope, then measure each with the long-window spectrum
    const decim = Math.round(SR / 1000);
    const env = (function () {
      const w = 2 * Math.PI * 1200 / SR, c = Math.cos(w), sn = Math.sin(w);
      const a = Math.exp(-1 / (SR * 0.002));
      const n = Math.floor((t1 - t0) / decim), o = new Float32Array(n);
      let ci = 1, si = 0, I = 0, Q = 0, oi = 0;
      for (let i = t0; i < t1; i++) {
        const nci = ci * c - si * sn, nsi = si * c + ci * sn; ci = nci; si = nsi;
        const v = x[i];
        I = a * I + (1 - a) * (v * ci); Q = a * Q + (1 - a) * (v * si);
        if ((i - t0) % decim === 0 && oi < n) o[oi++] = Math.sqrt(I * I + Q * Q);
      }
      return o;
    })();
    const gap = Math.ceil(0.30 * SR / decim);
    const cands = [];
    for (let i = gap; i < env.length - gap; i++) {
      if (env[i] >= env[i - 1] && env[i] >= env[i + 1]) cands.push(i * decim);
      if (cands.length > 400) break;
    }
    const vals = [], strs = [];
    for (const c of cands) {
      const at = t0 + c + Math.round(0.002 * SR);
      if (at + 65536 >= x.length) continue;
      vals.push(bandPeak(x, at, Math.round(0.027 * SR), 1000, 1600));
      strs.push(envStrength(x, at, Math.round(0.027 * SR), 1200));
    }
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med)));
    const keepIdx = vals.map((v, i) => (Math.abs(v - med) <= 3 * Math.max(mad, 2) ? i : -1)).filter((i) => i >= 0);
    const med2 = median(keepIdx.map((i) => vals[i]));
    const st = median(keepIdx.map((i) => strs[i]));
    if (refStrength == null) refStrength = st;
    rows.push({ t0: s * SEG, t1: (s + 1) * SEG, n: keepIdx.length, freq: med2,
      rel: med2 - 1200, strength: st });
    console.log('    ' + (s * SEG + '-' + ((s + 1) * SEG)).padStart(10) + '   ' +
      med2.toFixed(2).padStart(14) + '   ' + (med2 - 1200).toFixed(1).padStart(13) + '   ' +
      st.toFixed(4).padStart(13) + '   ' + (st / refStrength).toFixed(3).padStart(10));
  }

  const rel = rows.map((r) => r.rel);
  console.log('\n  相对标称：中位 ' + median(rel).toFixed(1) + ' Hz · 范围 ' +
    Math.min.apply(null, rel).toFixed(1) + ' .. ' + Math.max.apply(null, rel).toFixed(1) + ' Hz');
  const r2 = await Decode.decode(x, info.sampleRate, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  if (r2.ok) console.log('  解码器全局 AFC: b = ' + r2.calibration.offsetHz.toFixed(2) +
    ' Hz · 诊断字段 syncFreqAvg = ' +
    (r2.calibration.syncFreqAvg == null ? '—' : r2.calibration.syncFreqAvg.toFixed(2)));

  fs.writeFileSync(path.join(__dirname, 'diag-quality', 'real-drift-confirm.json'),
    JSON.stringify({ segments: rows }, null, 2));
  console.log('\n证据 -> tests/diag-quality/real-drift-confirm.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
