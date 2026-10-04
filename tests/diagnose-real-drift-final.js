/*
 * ============================ RESULT INVALIDATED - DO NOT USE ============================
 *
 * Measured with the script's own synthetic control: this procedure reads +94.22 Hz on a signal whose true
 * offset is 0.000 Hz, because the 10 ms window starting at the decoder's lock also contains the porch and
 * the start of the scan. A 94 Hz bias cannot speak to a 65 Hz effect, so its phigros numbers are unusable.
 *
 * See the header of tests/diagnose-real-drift.js for the full account, and
 * tests/diagnose-measurement-validation.js for the measured contamination bias of every method tried.
 * The phase-49 statement that the real recording's per-segment frequency offset is UNKNOWN still stands.
 * ========================================================================================
 *
 * Settle the phigros drift question by measuring the sync tone AT THE DECODER'S OWN LOCK POSITIONS.
 *
 * Two earlier attempts disagreed and BOTH are suspect:
 *   - tests/diagnose-real-drift.js used a matched filter and reported 100-150 Hz (several segments
 *     pinned at its 1350 Hz search bound, i.e. saturated).
 *   - tests/diagnose-real-drift-confirm.js used a long-window spectrum and reported up to +395 Hz, but
 *     its own synthetic control reads +22.5 Hz on a signal whose true offset is 0.000 Hz. A method with
 *     a 22 Hz bias cannot speak to a 100 Hz question, and its envelope-strength column is inconsistent
 *     (strength RISES in the segments it claims are far off-pitch, which is impossible).
 *
 * What both got wrong is where to measure. An envelope peak lands somewhere inside a 9 ms pulse plus
 * whatever image content follows, and with 400 ms between pulses there are far more strong musical
 * tones than syncs. The decoder, by contrast, produces a per-line lock that phase 48 verified to within
 * ~1 px (~20 samples, 0.4 ms) - a position good enough that a short window contains the sync and
 * essentially nothing else.
 *
 * So: take the decoder's own auditLineRefs, measure the tone at each, and VALIDATE the whole procedure
 * on synthetic audio where the answer is known exactly (including a deliberately shifted control, so
 * the method's bias is measured rather than assumed).
 *
 * Usage: node tests/diagnose-real-drift-final.js
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

/**
 * Frequency of a tone in a window, by coarse FFT peak then a fine matched filter around it.
 *
 * The window is deliberately SHORT (the 9 ms pulse plus a little) so it contains the sync and as little
 * scan content as possible; the coarse/fine split keeps a bias from the neighbouring tone out of the
 * answer, which is what the long-window method got wrong.
 */
function toneAt(x, off, len, lo, hi) {
  const N = 8192;
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
  const coarse = bk * SR / N;
  // fine: matched filter +/-30 Hz at 0.25 Hz
  let bf = coarse, bm = -1;
  const taper = new Float64Array(len);
  for (let i = 0; i < len; i++) taper[i] = (x[off + i] || 0) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
  for (let f = coarse - 30; f <= coarse + 30; f += 0.25) {
    const om = 2 * Math.PI * f / SR;
    let rr = 0, ii = 0;
    for (let i = 0; i < len; i++) { rr += taper[i] * Math.cos(om * i); ii -= taper[i] * Math.sin(om * i); }
    const m = rr * rr + ii * ii;
    if (m > bm) { bm = m; bf = f; }
  }
  return bf;
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Measure the sync tone at every lock the decoder reported, optionally per segment. */
function measureAtRefs(x, refs, segSeconds, len) {
  const segs = {};
  for (const r of refs) {
    if (r.freeRun) continue;
    if (r.line + 1 < refs.length && !refs[r.line + 1]) continue;
    const at = r.ref;
    if (at + 8192 >= x.length) continue;
    const f = toneAt(x, at, len, 1100, 1350);
    const key = Math.floor((at / SR) / segSeconds) * segSeconds;
    (segs[key] = segs[key] || []).push(f);
  }
  return segs;
}

(async function main() {
  console.log('=== phigros 频偏：以解码器自身的锁定位置为准 ===\n');

  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(img, Modes.get('S1')), SR).samples;
  const LEN = Math.round(0.010 * SR);   // 10 ms: the 9 ms pulse plus 1 ms

  console.log('  [控制] 合成 S1 施加已知频偏，用完全相同的流程测量（含解码器锁定位置）：');
  console.log('    施加平移   本方法读数(中位 Hz)   误差(Hz)   参与行数');
  for (const hz of [0, 50, 100, 150]) {
    const sig = hz === 0 ? clean : freqShift(clean, hz);
    const refs = [];
    const d = await Decode.decode(sig, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off', auditLineRefs: refs });
    if (!d.ok) { console.log('    +' + hz + ' Hz  解码失败'); continue; }
    const segs = measureAtRefs(sig, refs, 1000, LEN);
    const vals = [].concat.apply([], Object.keys(segs).map((k) => segs[k]));
    const m = median(vals);
    console.log('    +' + String(hz).padStart(3) + ' Hz     ' + m.toFixed(2).padStart(15) + '   ' +
      (m - 1200 - hz).toFixed(2).padStart(8) + '   ' + String(vals.length).padStart(8));
  }

  console.log('\n  [实录音] phigros，每 20 s 段内所有锁定行的读数：');
  const pa = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  const buf = fs.readFileSync(pa);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const x = info.samples;
  const refs = [];
  const d = await Decode.decode(x, info.sampleRate,
    { quality: 'standard', yieldEvery: 0, postprocess: 'off', auditLineRefs: refs });
  console.log('    解码 ok=' + d.ok + ' · 锁定行 ' + refs.filter((r) => !r.freeRun).length +
    ' / ' + refs.length + ' · 全局 AFC b = ' + (d.ok ? d.calibration.offsetHz.toFixed(2) : '—') + ' Hz');

  const segs = measureAtRefs(x, refs, 20, LEN);
  const keys = Object.keys(segs).map(Number).sort((a, b) => a - b);
  console.log('\n    时间窗(s)   行数   读数中位(Hz)   相对标称(Hz)   MAD(Hz)');
  const rows = [];
  for (const k of keys) {
    const v = segs[k];
    const m = median(v);
    const mad = median(v.map((q) => Math.abs(q - m)));
    rows.push({ t0: k, n: v.length, median: m, rel: m - 1200, mad: mad });
    console.log('    ' + (k + '-' + (k + 20)).padStart(10) + '   ' + String(v.length).padStart(4) +
      '   ' + m.toFixed(2).padStart(12) + '   ' + (m - 1200).toFixed(1).padStart(13) + '   ' +
      mad.toFixed(1).padStart(7));
  }

  const rel = rows.map((r) => r.rel);
  const allVals = [].concat.apply([], keys.map((k) => segs[k]));
  console.log('\n  全体锁定行读数中位 = ' + median(allVals).toFixed(2) + ' Hz · 相对标称 ' +
    (median(allVals) - 1200).toFixed(1) + ' Hz · N=' + allVals.length);
  console.log('  分段中位范围 ' + Math.min.apply(null, rel).toFixed(1) + ' .. ' +
    Math.max.apply(null, rel).toFixed(1) + ' Hz · 极差 ' + (Math.max.apply(null, rel) - Math.min.apply(null, rel)).toFixed(1));

  fs.writeFileSync(path.join(__dirname, 'diag-quality', 'real-drift-final.json'),
    JSON.stringify({ overallMedian: median(allVals), overallRel: median(allVals) - 1200,
      segments: rows }, null, 2));
  console.log('\n证据 -> tests/diag-quality/real-drift-final.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
