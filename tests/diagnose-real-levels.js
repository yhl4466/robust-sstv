/*
 * What is the real phone recording's level structure, and is its calibration header detectable at all?
 *
 * The rebuilt header locator passes its synthetic self-test but finds a false positive on the real
 * recording: it reports a 1900 Hz leader at 0.531 s with an amplitude of 0.0003 against a file RMS of
 * 0.0198, i.e. 36 dB down. Either the locator is still wrong, or the header is buried - and those need
 * opposite responses, so this measures the levels rather than guessing.
 *
 * Prints the 1900 Hz / 1200 Hz / 1500 Hz envelopes across the first seconds at a fine step, alongside the
 * broadband RMS, so the header's presence and position can be read off directly.
 *
 * Usage: node tests/diagnose-real-levels.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
const Wav = globalThis.SSTVWav;

function load(p) {
  const b = fs.readFileSync(p);
  return Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
function rms(x, off, len) {
  let s = 0, n = 0;
  for (let i = 0; i < len; i++) { const v = x[off + i]; if (v === undefined) break; s += v * v; n++; }
  return n ? Math.sqrt(s / n) : 0;
}
/** Scalar quadrature amplitude, normalised so a full-scale sine of amplitude A reads A. */
let SRx = 48000;
function amp(x, off, len, freq) {
  const w = 2 * Math.PI * freq / SRx;
  let re = 0, im = 0, c = 0;
  for (let i = 0; i < len; i++) {
    const v = x[off + i];
    if (v === undefined) break;
    re += v * Math.cos(w * i); im -= v * Math.sin(w * i); c++;
  }
  return c ? 2 * Math.hypot(re, im) / c : 0;
}

const FILES = [
  ['真机手机录音 phigros', path.join(OUT, 'acoustic-real-48k-mono.wav')]
];

/*
 * Optional second argument: print a fine tone map over [a, b] seconds. Used to read the real recording's
 * header geometry directly rather than inferring it from a nominal 0.310 s leader offset, which did not
 * hold (the locator found a +54 dB leader at 106.049 s while the probes for the other three header tones
 * read near-silence at the implied positions).
 */
const WINDOW = process.argv[2] ? process.argv.slice(2).map(Number) : null;

for (const [name, file] of FILES) {
  if (!fs.existsSync(file)) { console.log(name + ': 缺失'); continue; }
  const i = load(file);
  SRx = i.sampleRate;
  const x = i.samples;
  const win = Math.round(0.020 * SRx);
  const fileRms = rms(x, 0, x.length);

  if (WINDOW) {
    const [a, b, stepS] = WINDOW;
    const step = Math.round((stepS || 0.01) * SRx);
    console.log('\n=== ' + name + ' 音调图 [' + a + ', ' + b + '] s ===');
    console.log('  t(s)      1200Hz    1500Hz    1900Hz   | 主音');
    for (let off = Math.round(a * SRx); off <= Math.round(b * SRx); off += step) {
      const a12 = amp(x, off, win, 1200), a15 = amp(x, off, win, 1500), a19 = amp(x, off, win, 1900);
      const m = Math.max(a12, a15, a19);
      const who = m < 1e-4 ? '—' : (m === a12 ? '1200' : m === a15 ? '1500' : '1900');
      console.log('  ' + (off / SRx).toFixed(3).padStart(8) + '  ' + a12.toFixed(5).padStart(9) + '  ' +
        a15.toFixed(5).padStart(9) + '  ' + a19.toFixed(5).padStart(9) + '   | ' + who);
    }
    continue;
  }

  console.log('\n=== ' + name + ' ===');
  console.log('  ' + SRx + ' Hz · ' + i.duration.toFixed(2) + ' s · 全文件 RMS ' + fileRms.toFixed(5));
  console.log('  t(s)    RMS      1900Hz    1200Hz    1500Hz   | 1900 相对文件RMS(dB)');
  for (let t = 0; t <= 3.2; t += 0.1) {
    const off = Math.round(t * SRx);
    if (off + win >= x.length) break;
    const a19 = amp(x, off, win, 1900), a12 = amp(x, off, win, 1200), a15 = amp(x, off, win, 1500);
    const r = rms(x, off, win);
    const rel = 20 * Math.log10(Math.max(a19, 1e-12) / Math.max(fileRms, 1e-12));
    console.log('  ' + t.toFixed(1).padStart(4) + '  ' + r.toFixed(5).padStart(8) + '  ' +
      a19.toFixed(5).padStart(8) + '  ' + a12.toFixed(5).padStart(8) + '  ' + a15.toFixed(5).padStart(8) +
      '   |  ' + rel.toFixed(1).padStart(7) + (rel > -20 ? '   ← 显著' : ''));
  }
  let pk19 = 0, at19 = 0;
  for (let off = 0; off + win < Math.min(x.length, 130 * SRx); off += Math.round(0.005 * SRx)) {
    const a = amp(x, off, win, 1900);
    if (a > pk19) { pk19 = a; at19 = off / SRx; }
  }
  console.log('  前 130 s 最强 1900 Hz 窗: ' + pk19.toFixed(5) + ' @ ' + at19.toFixed(3) +
    ' s（相对文件 RMS ' + (20 * Math.log10(pk19 / fileRms)).toFixed(1) + ' dB）');
}
