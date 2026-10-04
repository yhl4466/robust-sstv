/*
 * The header's true position, and whether low SNR is what kills it.
 *
 * The RMS profile settled what three earlier probes got wrong: the `sstv` package's real recording has
 * ~2.5 s of leading silence, so the calibration header is at t ~ 2.6 s, NOT at t = 0. Every fixture
 * derived from it inherits that offset, which is why probing t = 0.31-1.22 s measured silence in one
 * file and noise in another and produced meaningless frequencies.
 *
 * The profile also showed the candidate mechanism for `acoustic-band`'s header failure, quantitatively:
 *
 *   real-npm-8k     noise floor 0.0000  ->  signal 0.5000   (preamble effectively SNR-infinite)
 *   acoustic-rt03   noise floor 0.0062  ->  signal ~0.129-0.139  (about 26 dB)
 *   acoustic-band   noise floor 0.0041  ->  signal ~0.139-0.158  (about 30 dB)
 *
 * so acoustic-band's preamble is not worse in SNR - it is BETTER. If that holds when measured on the
 * header tones themselves, then "too noisy" is not the explanation and the search is failing for a
 * different reason, which is worth knowing before any fix is attempted.
 *
 * Usage: node tests/diagnose-header-position.js
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

function load(p) {
  const b = fs.readFileSync(p);
  return Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** Band energy in a narrow band around one tone, relative to the whole signal: the tone's own SNR. */
function toneSnr(x, sr, off, len, freq) {
  const N = 2048;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  const use = Math.min(len, N);
  for (let i = 0; i < N; i++) re[i] = i < use ? (x[off + i] || 0) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (use - 1))) : 0;
  new globalThis.FFT(N).realTransform(o, re);
  const binHz = sr / N;
  const kc = Math.round(freq / binHz);
  let band = 0;
  for (let k = Math.max(1, kc - 2); k <= kc + 2; k++) band += o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
  let total = 0;
  for (let k = 1; k < N / 2; k++) total += o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
  return { toneDb: 10 * Math.log10(Math.max(band, 1e-20)), totalDb: 10 * Math.log10(Math.max(total, 1e-20)),
    snrDb: 10 * Math.log10(Math.max(band / Math.max(total - band, 1e-20), 1e-12)) };
}

/** Where the signal starts, at 10 ms resolution: first window above 10% of the file RMS. */
function signalStart(x, sr) {
  let total = 0;
  for (let i = 0; i < x.length; i++) total += x[i] * x[i];
  const rms = Math.sqrt(total / x.length);
  const win = Math.round(0.010 * sr);
  for (let t = 0; t < 10; t += 0.005) {
    const off = Math.round(t * sr);
    let s = 0, n = 0;
    for (let i = 0; i < win; i++) { const v = x[off + i]; if (v === undefined) break; s += v * v; n++; }
    if (n && Math.sqrt(s / n) > 0.30 * rms) return Number(t.toFixed(3));
  }
  return null;
}

const FILES = [
  ['real-npm-8k', path.resolve(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.wav')],
  ['real-colaclanth-8k', path.resolve(ROOT, '..', '.research', 'real-sstv', 'colaclanth-m1-8k.wav')],
  ['acoustic-rt03', path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-rt03.wav')],
  ['acoustic-rt06', path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-rt06.wav')],
  ['acoustic-band', path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-band.wav')]
];

// header geometry, from the same constants findHeader uses
const BRK = 0.000, LEADER = 0.310, VIS = 0.610, LEADER2 = 0.920;

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== 标定头真实位置与各音的信噪比 ===\n');
  const out = {};
  console.log('  文件                  信号起  头相对起点的四个探针 (目标Hz → 实测Hz / 该音SNR dB)');
  for (const [name, file] of FILES) {
    if (!fs.existsSync(file)) { console.log('  ' + name + ': 缺失'); continue; }
    const i = load(file);
    const sr = i.sampleRate, x = i.samples;
    const start = signalStart(x, sr);
    let line = '  ' + name.padEnd(20) + String(start).padStart(7) + '   ';
    const probes = [];
    if (start != null) {
      const est = new Decode._internal.Estimator(sr, 16);
      for (const [label, dt, want, len] of [['brk', BRK, 1200, 0.25], ['ld', LEADER, 1900, 0.25],
                                            ['vis', VIS, 1200, 0.025], ['ld2', LEADER2 + 0.31, 1900, 0.25]]) {
        const off = Math.round((start + dt) * sr);
        const f = est.peak(x, off, Math.round(0.010 * sr));
        const s = toneSnr(x, sr, off, Math.round(len * sr), want);
        probes.push({ label: label, want: want, freq: f, snrDb: s.snrDb });
        line += label + ' ' + String(want).padStart(4) + '→' + f.toFixed(0).padStart(5) + '/' +
          s.snrDb.toFixed(1).padStart(6) + '  ';
      }
    }
    const r = await Decode.decode(x, sr, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    console.log(line + (r.ok ? ' 解码ok' : ' 失败'));
    out[name] = { sampleRate: sr, signalStart: start, probes: probes, decodeOk: r.ok };
  }

  /*
   * Direct test of the SNR hypothesis: take a fixture that decodes, attenuate the signal and raise the
   * noise floor until the header search fails, and report the SNR at which it fails. If acoustic-band's
   * preamble SNR is ABOVE that threshold, then "too noisy" is ruled out for it.
   */
  console.log('\n  --- 头搜索的 SNR 门槛（用 acoustic-rt03 直接压 SNR）---');
  const base = load(path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-rt03.wav'));
  const sr = base.sampleRate;
  console.log('    使头区 SNR(dB)   解码结果');
  const sweep = [];
  for (const targetSnr of [30, 25, 20, 17, 15, 13, 11, 9, 7]) {
    // scale so that the header region's tone-to-rest ratio lands near the target
    const g = Math.pow(10, -(30 - targetSnr) / 20);
    const y = new Float32Array(base.samples.length);
    for (let k = 0; k < y.length; k++) y[k] = base.samples[k] * g;
    const r = await Decode.decode(y, sr, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    const off = Math.round((signalStart(base.samples, sr) + LEADER) * sr);
    const s = toneSnr(y, sr, off, Math.round(0.25 * sr), 1900);
    sweep.push({ targetSnr: targetSnr, measuredToneSnr: s.snrDb, ok: r.ok });
    console.log('    ' + targetSnr.toString().padStart(6) + '  (实测头区 ' + s.snrDb.toFixed(1) + ' dB)   ' +
      (r.ok ? 'ok' : '失败'));
  }

  console.log('\n  判读：若 acoustic-band 的头区 SNR 高于上表的失败门槛，则"太吵"不是它的失败原因。');
  fs.writeFileSync(path.join(OUT, 'header-position.json'), JSON.stringify({ files: out, snrSweep: sweep }, null, 2));
  console.log('\n证据 -> tests/diag-quality/header-position.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
