/*
 * ============================ RESULT INVALIDATED - DO NOT USE ============================
 *
 * The frequency readings this script prints for the phigros recording are NOT usable, and neither are
 * those of its two successors (diagnose-real-drift-confirm.js, diagnose-calibrate-consistency.js).
 * They reported +100..150 Hz, +226..395 Hz and +65 Hz respectively for the same quantity, and
 * tests/diagnose-measurement-validation.js now shows why: every one of these methods is pulled by a
 * strong neighbour 150 Hz away, by an amount comparable to the effect being claimed.
 *
 *   method B (the matched filter used here, 7.5 ms window)  bias -51.5 Hz under a +150 Hz neighbour
 *   method C (long spectrum window, 27 ms)                  reads the neighbour outright at one spacing
 *   method D (pulse-length window, 9 ms)                    bias -14.0 Hz under the same neighbour
 *
 * Measured on synthetic tones, in tests/diagnose-measurement-validation.js. The structural reason is
 * that the 1200 Hz sync is immediately followed by the porch and the scan, so any window able to resolve
 * the sync also contains image content - and a clean-tone control cannot reveal that.
 *
 * The script is kept rather than deleted because the round-1 output is what motivated the validation
 * harness, but its findings must not be cited. The phase-49 report's statement that the real recording's
 * per-segment frequency offset is UNKNOWN still stands.
 * ========================================================================================
 *
 * Does the real phigros recording carry a TIME-VARYING frequency error the global AFC cannot see?
 *
 * A first pass measured the 1200 Hz sync tone at six points using a plain dominant-frequency window and
 * got -13 / -12 / -5 / +44 / +140 / +165 Hz, while the decoder's AFC reports one global b = -0.29 Hz.
 * If real, that matters a great deal: the phase-49 matrix shows +/-20 Hz already costs 8 dB, so a
 * stretch of the recording sitting 150 Hz off is decoded with a badly wrong frequency axis however good
 * the global fit is.
 *
 * A dominant-frequency window is NOT trustworthy here - the recording is music, image content sits
 * immediately after every sync, and a window that clips the scan reads a biased peak. So this uses a
 * matched filter, which is amplitude-independent by construction and cannot be pulled by a neighbouring
 * tone:
 *
 *   stage 1  locate candidate syncs with a 1200 Hz quadrature ENVELOPE. The envelope only has to say
 *            WHERE a pulse is; its amplitude bias never enters the reported number.
 *   stage 2  measure each candidate by complex correlation against 1200 Hz shifted over a candidate
 *            range, taking the argmax. Averaging over the ~46 pulses in a 20 s segment takes the bin
 *            noise down as 1/sqrt(N), so the segment median is far more precise than one window.
 *
 * Usage: node tests/diagnose-real-drift.js
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

const SYNC_NOMINAL = Modes.FREQ_SYNC;

/** Quadrature envelope at one frequency, decimated to `decim` samples: cheap pulse LOCATOR. */
function envelope(x, sr, freq, decim) {
  const w = 2 * Math.PI * freq / sr, c = Math.cos(w), s = Math.sin(w);
  const a = Math.exp(-1 / (sr * 0.002));
  const n = Math.floor(x.length / decim);
  const o = new Float32Array(n);
  let ci = 1, si = 0, I = 0, Q = 0, oi = 0;
  for (let i = 0; i < x.length; i++) {
    const nci = ci * c - si * s, nsi = si * c + ci * s; ci = nci; si = nsi;
    const v = x[i];
    I = a * I + (1 - a) * (v * ci); Q = a * Q + (1 - a) * (v * si);
    if (i % decim === 0 && oi < n) o[oi++] = Math.sqrt(I * I + Q * Q);
  }
  return o;
}

/** Hann-windowed complex correlation: which candidate frequency best matches this window. */
function matchedFreq(x, off, len, lo, hi, step) {
  const w = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    w[i] = (x[off + i] || 0) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
  }
  let best = -1, bestF = SYNC_NOMINAL;
  const cos = new Float64Array(len), sin = new Float64Array(len);
  for (let f = lo; f <= hi; f += step) {
    const om = 2 * Math.PI * f / SR;
    for (let i = 0; i < len; i++) { cos[i] = Math.cos(om * i); sin[i] = Math.sin(om * i); }
    let re = 0, im = 0;
    for (let i = 0; i < len; i++) { re += w[i] * cos[i]; im -= w[i] * sin[i]; }
    const m = re * re + im * im;
    if (m > best) { best = m; bestF = f; }
  }
  return bestF;
}

/** Local maxima of the envelope, spaced at least `minGap` apart. */
function peaks(env, decim, minGapSamples, limit) {
  const out = [];
  const gap = Math.ceil(minGapSamples / decim);
  for (let i = gap; i < env.length - gap; i++) {
    if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    out.push({ at: i * decim, v: env[i] });
  }
  out.sort((a, b) => b.v - a.v);
  const kept = [];
  for (const p of out) {
    if (kept.length >= limit) break;
    let ok = true;
    for (const k of kept) if (Math.abs(k.at - p.at) < minGapSamples) { ok = false; break; }
    if (ok) kept.push(p);
  }
  kept.sort((a, b) => a.at - b.at);
  return kept;
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

(async function main() {
  const pa = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  const buf = fs.readFileSync(pa);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const x = info.samples, sr = info.sampleRate;

  console.log('=== phigros 真实录音的频偏随时间变化 ===\n');
  console.log('  音频 ' + info.duration.toFixed(1) + ' s @ ' + sr + ' Hz');

  // ---- detector baseline on our own synthetic S1 audio, where the truth is exactly 1200.000 Hz ----
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const tl = Timeline.build(img, Modes.get('S1'));
  const clean = Synth.synthesize(tl, SR).samples;
  const cleanSyncs = [];
  {
    let acc = 0;
    for (let i = 0; i < tl.segments.length; i++) {
      const s = tl.segments[i];
      if (i >= tl.headerSegments && s.kind === 'tone' && Math.abs(s.freq - Modes.FREQ_SYNC) < 1) cleanSyncs.push(Math.round(acc * SR));
      acc += s.dur;
    }
  }
  const MLEN = Math.round(0.0075 * SR);
  const cleanVals = cleanSyncs.slice(5, 60).map((p) => matchedFreq(clean, p, MLEN, 1150, 1250, 0.25));
  const cleanMed = median(cleanVals);
  console.log('\n  [校验] 匹配滤波对合成 S1（真值 1200.000 Hz）读数中位 = ' + cleanMed.toFixed(3) +
    ' Hz · N=' + cleanVals.length + ' · 检测器基线偏差 ' + (cleanMed - SYNC_NOMINAL).toFixed(3) + ' Hz');
  console.log('  下面所有读数都减去该基线，因此 0 表示"与合成信号一样准"。\n');

  // ---- sliding segments over the real recording ----
  const SEG = 20;
  const nSeg = Math.floor(info.duration / SEG);
  const decim = Math.round(sr / 1000);
  console.log('  分段（每 ' + SEG + ' s）：先用 1200 Hz 包络定位同步候选，再用匹配滤波测频');
  console.log('    时间窗(s)    候选数  保留数   中位(Hz)   相对标称(Hz)   修正基线后(Hz)');
  const rows = [];
  for (let s = 0; s < nSeg; s++) {
    const t0 = s * SEG * sr, t1 = Math.min((s + 1) * SEG * sr, x.length - MLEN - 1);
    if (t1 <= t0) break;
    const sub = x.subarray(t0, t1);
    const env = envelope(sub, sr, SYNC_NOMINAL, decim);
    const ps = peaks(env, decim, Math.round(0.30 * sr), 120);
    const vals = ps.map((p) => matchedFreq(x, t0 + p.at, MLEN, 1100, 1350, 0.5));
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med)));
    const kept = vals.filter((v) => Math.abs(v - med) <= 3 * Math.max(mad, 1.5));
    const med2 = median(kept);
    rows.push({ t0: s * SEG, t1: (s + 1) * SEG, candidates: vals.length, kept: kept.length,
      median: med2, relNominal: med2 - SYNC_NOMINAL, relDetector: med2 - cleanMed });
    console.log('    ' + (s * SEG + '-' + ((s + 1) * SEG)).padStart(10) + '   ' +
      String(vals.length).padStart(6) + '  ' + String(kept.length).padStart(6) + '   ' +
      med2.toFixed(2).padStart(9) + '   ' + (med2 - SYNC_NOMINAL).toFixed(1).padStart(13) + '   ' +
      (med2 - cleanMed).toFixed(1).padStart(19));
  }

  const rel = rows.map((r) => r.relDetector);
  const lo = Math.min.apply(null, rel), hi = Math.max.apply(null, rel);
  const medAll = median(rel);
  console.log('\n  修正基线后的偏移：中位 ' + medAll.toFixed(1) + ' Hz · 范围 ' + lo.toFixed(1) +
    ' .. ' + hi.toFixed(1) + ' Hz · 极差 ' + (hi - lo).toFixed(1) + ' Hz');
  const r = await Decode.decode(x, sr, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  if (r.ok) console.log('  解码器全局 AFC 报告 b = ' + r.calibration.offsetHz.toFixed(2) +
    ' Hz（单一常数，无法表达上面的范围）');
  console.log('\n  对照（阶段四十九矩阵，合成 S1）：±20 Hz 损失 8.5 dB，±50 Hz 损失 13.2 dB。');
  console.log('  判读：若范围远大于 20 Hz，则全程的全局 AFC 标定对部分时段是错的，');
  console.log('        这既是真实录音残留噪点的一个候选来源，也说明 AFC 应为分段/自适应而非全局。');

  fs.writeFileSync(path.join(__dirname, 'diag-quality', 'real-drift.json'),
    JSON.stringify({ detectorBaselineHz: cleanMed - SYNC_NOMINAL, segments: rows,
      summary: { medianRel: medAll, min: lo, max: hi, spread: hi - lo } }, null, 2));
  console.log('\n证据 -> tests/diag-quality/real-drift.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
