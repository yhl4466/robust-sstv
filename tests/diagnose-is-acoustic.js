/*
 * Is `acoustic-real-m1.m4a.mp3` a speaker-to-microphone recording, or a copy of the source file?
 *
 * The user reports it was made by playing the transmission through the computer's speaker and recording
 * it with a phone. But it is BIT-IDENTICAL to tests/diag-timing/phigros-48k-mono.wav - 10567296 samples,
 * maxDiff exactly 0. A real acoustic capture cannot be bit-identical to its own source: the chain is
 * digital -> DAC -> speaker -> air -> room -> microphone -> ADC, and every stage is lossy and noisy. The
 * probability of recovering 10.6 million samples exactly is zero.
 *
 * Rather than rest on that argument - which is sound but abstract - this measures the ACOUSTIC
 * SIGNATURE that any speaker-to-microphone path must leave, and reports whether it is present:
 *
 *   1. Noise floor. A room has one; a digital copy has the source's own floor, whatever that is. The
 *      test is not "is there noise" but "does the noise look like a room".
 *   2. Low-frequency rumble. Phone microphones pick up HVAC, traffic and handling noise below 100 Hz
 *      that the electrical source does not carry.
 *   3. High-frequency roll-off. Speaker and microphone responses fall off, and AAC/MP3 encoding of the
 *      capture adds its own low-pass. A copy carries the source's own top end.
 *   4. Inter-sample correlation. A copy is bit-exact; even a single resample or level change breaks
 *      bit-exactness and shows up as a nonzero residual.
 *
 * The first two are the ones that matter, because they are measured on the FILES rather than argued from
 * provenance, and because a genuine acoustic capture cannot fail them.
 *
 * Usage: node tests/diagnose-is-acoustic.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
const Wav = globalThis.SSTVWav;

function load(p) {
  const b = fs.readFileSync(p);
  return Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** Fraction of samples that are exactly zero: a copy of digital silence gives a huge value. */
function zeroFrac(x) {
  let z = 0;
  for (let i = 0; i < x.length; i++) if (x[i] === 0) z++;
  return z / x.length;
}

/** Band energy ratio, averaged over Welch segments. */
function bandRatio(x, sr, lo, hi) {
  const N = 4096;
  const acc = new Float64Array(N / 2 + 1);
  let count = 0;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  for (let off = 0; off + N <= x.length; off += N / 2) {
    for (let k = 0; k < N; k++) re[k] = (x[off + k] || 0) * 0.5 * (1 - Math.cos(2 * Math.PI * k / (N - 1)));
    new globalThis.FFT(N).realTransform(o, re);
    for (let k = 0; k <= N / 2; k++) acc[k] += o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
    count++;
  }
  const binHz = sr / N;
  let band = 0, total = 0;
  for (let k = 1; k <= N / 2; k++) {
    const f = k * binHz;
    total += acc[k];
    if (f >= lo && f <= hi) band += acc[k];
  }
  return 10 * Math.log10(Math.max(band / total, 1e-20));
}

/** Where the signal starts: first sample above 25% of peak. */
function onset(x, sr) {
  let pk = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > pk) pk = Math.abs(x[i]);
  if (!(pk > 0)) return null;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.25 * pk) return i / sr;
  return null;
}

/** Noise floor measured in the quietest 10% of 100 ms windows: what the room sounds like between bursts. */
function quietFloor(x, sr) {
  const w = Math.round(0.100 * sr);
  const vals = [];
  for (let off = 0; off + w <= x.length; off += w) {
    let s = 0;
    for (let i = 0; i < w; i++) s += x[off + i] * x[off + i];
    vals.push(Math.sqrt(s / w));
  }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.05)];   // 5th percentile
}

const FILES = [
  ['项目 phigros 缓存（源）', path.join(ROOT, 'tests', 'diag-timing', 'phigros-48k-mono.wav')],
  ['提供的 acoustic-real-m1.m4a.mp3', path.join(ROOT, 'tests', 'diag-quality', 'acoustic-real-48k-mono.wav')],
  ['OBS 录屏 mp4', path.join(ROOT, 'tests', 'diag-quality', 'obs-mp4-48k-mono.wav')],
  ['真实接收 real-npm-8k（上游实收样本）', path.resolve(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.wav')],
  ['合成声学 acoustic-rt03（已知含房间+嗡声）', path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-rt03.wav')]
];

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== 该文件是否具备"外放+手机录"的声学指纹 ===\n');
  console.log('  文件                                   时长      RMS      静音占比  静音底RMS   <100Hz占比   >3.4kHz占比');
  const rows = [];
  for (const [name, file] of FILES) {
    if (!fs.existsSync(file)) { console.log('  ' + name + ': 缺失'); continue; }
    const i = load(file);
    const x = i.samples, sr = i.sampleRate;
    const lo = bandRatio(x, sr, 20, 100);
    const hi = bandRatio(x, sr, 3400, Math.min(20000, sr / 2 - 100));
    const r = { name: name, sr: sr, dur: i.duration, rms: rms(x), zeroFrac: zeroFrac(x),
      quiet: quietFloor(x, sr), lowBandDb: lo, highBandDb: hi, onset: onset(x, sr) };
    rows.push(r);
    console.log('  ' + name.padEnd(38) + i.duration.toFixed(1).padStart(7) + '  ' +
      r.rms.toFixed(5).padStart(8) + '  ' + (100 * r.zeroFrac).toFixed(2).padStart(8) + '%  ' +
      r.quiet.toFixed(6).padStart(10) + '  ' + lo.toFixed(1).padStart(10) + '  ' + hi.toFixed(1).padStart(11));
  }

  console.log('\n  声学路径必然留下的东西，与"数字副本"的对照：');
  console.log('    · 房间噪声底：真实录音的静音段不是数字零，而手机录音的底噪通常 ≥ -60 dBFS');
  console.log('    · <100 Hz 占比：手机麦克风会拾取空调/交通/手持噪声，源的电话线/线路录音不含');
  console.log('    · >3.4 kHz 占比：扬声器与麦克风频响下降，编码再低通一次，源则保留自身高端');
  console.log('    · 静音占比：逐位副本会继承源里成段的数字零，声学录音不会有成段精确零');

  const src = rows.find((r) => r.name.indexOf('源') >= 0);
  const cand = rows.find((r) => r.name.indexOf('提供的') >= 0);
  if (src && cand) {
    console.log('\n  --- 提供的文件 vs 源 ---');
    console.log('    静音底 RMS  源 ' + src.quiet.toExponential(3) + '  提供 ' + cand.quiet.toExponential(3) +
      '  比值 ' + (cand.quiet / Math.max(src.quiet, 1e-12)).toFixed(3));
    console.log('    <100 Hz     源 ' + src.lowBandDb.toFixed(1) + ' dB  提供 ' + cand.lowBandDb.toFixed(1) +
      ' dB  差 ' + (cand.lowBandDb - src.lowBandDb).toFixed(2) + ' dB');
    console.log('    >3.4 kHz    源 ' + src.highBandDb.toFixed(1) + ' dB  提供 ' + cand.highBandDb.toFixed(1) +
      ' dB  差 ' + (cand.highBandDb - src.highBandDb).toFixed(2) + ' dB');
    console.log('    静音占比    源 ' + (100 * src.zeroFrac).toFixed(3) + '%  提供 ' +
      (100 * cand.zeroFrac).toFixed(3) + '%');
  }

  /* bit-exactness test: even one resample breaks this, so it is the most direct statement available */
  const a = load(path.join(ROOT, 'tests', 'diag-quality', 'acoustic-real-48k-mono.wav')).samples;
  const b = load(path.join(ROOT, 'tests', 'diag-timing', 'phigros-48k-mono.wav')).samples;
  const n = Math.min(a.length, b.length);
  let maxDiff = 0, neq = 0;
  for (let k = 0; k < n; k++) { const d = Math.abs(a[k] - b[k]); if (d > maxDiff) maxDiff = d; if (d > 0) neq++; }
  console.log('\n  --- 逐位比较（外放+手机录不可能通过这一项）---');
  console.log('    样本数 ' + n + ' · 最大绝对差 ' + maxDiff + ' · 不同样本数 ' + neq);

  fs.writeFileSync(path.join(OUT, 'is-acoustic.json'), JSON.stringify({ rows: rows,
    bitexact: { samples: n, maxDiff: maxDiff, differingSamples: neq } }, null, 2));
  console.log('\n证据 -> tests/diag-quality/is-acoustic.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
