/*
 * Why does the stored `acoustic-band` fixture fail findHeader, when a faithful re-run of its own recipe
 * decodes at 14.53 dB?
 *
 * tests/diagnose-acoustic-ablation.js rebuilt the recipe ("room RT60 0.4 s; band tilt -8/-14 dB; AWGN
 * 24 dB") from scripts/build-real-portfolio.js and every variant decoded, including the full recipe -
 * while the committed fixture fails with "未找到 SSTV 标定头". So the fixture on disk is NOT what the
 * current recipe produces, and the interesting question is no longer "which ingredient is too harsh"
 * but "what does the committed file actually contain".
 *
 * Measured here, on the fixture itself:
 *   - its true duration, level and sample rate (a truncation or a level change would both break a search
 *     that looks for specific tones)
 *   - the level of the three header tones, measured over the windows findHeader itself uses
 *   - the same for the un-degraded real recording, so the comparison is in like units
 *   - a fine scan for the leader tone, to see whether the header is present but displaced in time
 *
 * Usage: node tests/diagnose-acoustic-band-fixture.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

const FIX = path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-band.wav');
const BASE = path.resolve(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.wav');
const RT03 = path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-rt03.wav');

function load(p) {
  const b = fs.readFileSync(p);
  const i = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  return i;
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}
function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > p) p = Math.abs(x[i]);
  return p;
}

/**
 * Dominant frequency in a window, using the SAME estimator the decoder's header search uses, so the
 * numbers are the ones the search actually compares against its thresholds rather than a proxy.
 */
function headerReadings(x, sr, offSecondsOut) {
  const est = new Decode._internal.Estimator(sr, 16);
  const win = Math.round(0.010 * sr);
  const out = [];
  for (const t of offSecondsOut) {
    out.push(est.peak(x, Math.round(t * sr), win));
  }
  return out;
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== acoustic-band 夹具本身到底怎么了 ===\n');

  const fi = load(FIX), bi = load(BASE), ri = load(RT03);
  console.log('  文件                 时长(s)   采样率  峰值      RMS      与基准时长差');
  const show = (name, i) => {
    console.log('  ' + name.padEnd(20) + i.duration.toFixed(3).padStart(8) + String(i.sampleRate).padStart(9) +
      peak(i.samples).toFixed(4).padStart(9) + rms(i.samples).toFixed(4).padStart(9) +
      (i.duration - bi.duration).toFixed(3).padStart(12));
  };
  show('real-npm-8k', bi);
  show('acoustic-rt03', ri);
  show('acoustic-band', fi);

  /* ---- header geometry: the same four probes findHeader tests ---- */
  const LEADER_OFFSET = 0.010 + 0.300, VIS_START_OFFSET = 0.300 + LEADER_OFFSET;
  const probes = [
    { k: 'leader (1900)', t: LEADER_OFFSET + 0.020, want: 1900 },
    { k: 'leader2 (1900)', t: LEADER_OFFSET + 0.310 + 0.020, want: 1900 },
    { k: 'brk (1200)', t: 0.300, want: 1200 },
    { k: 'vis (1200)', t: VIS_START_OFFSET, want: 1200 }
  ];
  console.log('\n  标定头探针（解码器自己的估计器，10 ms 窗，与无退化真值对比）');
  console.log('    探针              真值   real-npm-8k   acoustic-rt03   acoustic-band   期望');
  for (const p of probes) {
    const at = [p.t];
    const a = headerReadings(bi.samples, bi.sampleRate, at)[0];
    const b = headerReadings(ri.samples, ri.sampleRate, at)[0];
    const c = headerReadings(fi.samples, fi.sampleRate, at)[0];
    console.log('    ' + p.k.padEnd(18) + String(p.want).padStart(5) + a.toFixed(0).padStart(13) +
      b.toFixed(0).padStart(15) + c.toFixed(0).padStart(15) + p.want.toFixed(0).padStart(7));
  }

  /* ---- is the leader present anywhere near where it should be? ---- */
  console.log('\n  在 0.2-1.4 s 之间扫描是否存在 1900 Hz 主导的 10 ms 窗');
  console.log('    （若标定头存在，应在 0.31-0.61 s 出现一串 1900 Hz 读数）');
  for (const [name, i] of [['real-npm-8k', bi], ['acoustic-band', fi]]) {
    const est = new Decode._internal.Estimator(i.sampleRate, 16);
    const win = Math.round(0.010 * i.sampleRate);
    const hits = [];
    for (let t = 0.20; t < 1.40; t += 0.005) {
      const f = est.peak(i.samples, Math.round(t * i.sampleRate), win);
      if (Math.abs(f - 1900) < 60) hits.push(t.toFixed(3));
    }
    console.log('    ' + name.padEnd(16) + hits.length + ' 个 1900 Hz 窗' +
      (hits.length ? '：' + hits.slice(0, 4).join(', ') + (hits.length > 4 ? ' … ' + hits[hits.length - 1] : '') : ''));
  }

  /* ---- the decoder's own two-pass header search, to see which pass and which test it dies on ---- */
  console.log('\n  解码结果');
  for (const [name, i] of [['real-npm-8k', bi], ['acoustic-rt03', ri], ['acoustic-band', fi]]) {
    const r = await Decode.decode(i.samples, i.sampleRate, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    console.log('    ' + name.padEnd(16) + (r.ok ? 'ok  ' + (r.mode ? r.mode.name : '') : '失败 ' + r.message));
  }

  /* ---- energy in the bands the tilt was supposed to shape ---- */
  console.log('\n  频段能量占比（dB，相对总能量）');
  const BANDS = [[0, 100], [100, 300], [300, 1200], [1200, 1500], [1500, 2300], [2300, 2700], [2700, 4000]];
  function bandDb(x) {
    const N = 2048, half = N / 2;
    const acc = new Float64Array(half + 1);
    let count = 0;
    const re = new Float32Array(N), o = new Float32Array(2 * N);
    for (let off = 0; off + N <= x.length; off += half) {
      for (let k = 0; k < N; k++) re[k] = (x[off + k] || 0) * 0.5 * (1 - Math.cos(2 * Math.PI * k / (N - 1)));
      new globalThis.FFT(N).realTransform(o, re);
      for (let k = 0; k <= half; k++) acc[k] += o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
      count++;
    }
    const binHz = 8000 / N;
    let total = 0;
    for (let k = 1; k <= half; k++) total += acc[k];
    return BANDS.map((b) => {
      let e = 0;
      const k0 = Math.max(1, Math.round(b[0] / binHz)), k1 = Math.min(half, Math.round(b[1] / binHz));
      for (let k = k0; k <= k1; k++) e += acc[k];
      return 10 * Math.log10(Math.max(e / total, 1e-20));
    });
  }
  console.log('    文件              ' + BANDS.map((b) => (b[0] + '-' + b[1]).padStart(11)).join(''));
  const bd = {};
  for (const [name, i] of [['real-npm-8k', bi], ['acoustic-rt03', ri], ['acoustic-band', fi]]) {
    const v = bandDb(i.samples);
    bd[name] = v;
    console.log('    ' + name.padEnd(18) + v.map((x) => x.toFixed(1).padStart(11)).join(''));
  }
  console.log('    与 real 的差：');
  for (const name of ['acoustic-rt03', 'acoustic-band']) {
    const d = bd[name].map((v, k) => v - bd['real-npm-8k'][k]);
    console.log('    ' + name.padEnd(18) + d.map((x) => ((x >= 0 ? '+' : '') + x.toFixed(1)).padStart(11)).join(''));
  }

  fs.writeFileSync(path.join(OUT, 'acoustic-band-fixture.json'), JSON.stringify({
    durations: { base: bi.duration, rt03: ri.duration, band: fi.duration },
    peaks: { base: peak(bi.samples), rt03: peak(ri.samples), band: peak(fi.samples) },
    rms: { base: rms(bi.samples), rt03: rms(ri.samples), band: rms(fi.samples) },
    bandDb: bd
  }, null, 2));
  console.log('\n证据 -> tests/diag-quality/acoustic-band-fixture.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
