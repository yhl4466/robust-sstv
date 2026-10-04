/*
 * Why does the onset detector break immediately?
 * Prints the short-window frequency estimate across the true sync onset of block 1.
 * Usage: node scripts/probe-pd-edge.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Dec = globalThis.SSTVDecode;
const SR = 48000;
const mode = Modes.get('PD120');
const W = mode.width, H = mode.height;

function ramp(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    d[o] = Math.round(127 + 120 * Math.sin(x / 17));
    d[o + 1] = Math.round(127 + 120 * Math.sin(y / 13 + 1));
    d[o + 2] = Math.round(127 + 120 * Math.sin((x + y) / 23));
    d[o + 3] = 255;
  }
  return { data: d, width: w, height: h };
}

(function main() {
  const img = ramp(W, H);
  const samples = Synth.synthesize(Timeline.build(img, mode), SR).samples;
  const analyticStart = Math.round(Modes.VIS_HEADER_LEN * SR);
  const syncSamples = Math.round(mode.syncPulse * SR);
  const blankSamples = Math.round(mode.blanking * SR);
  const scanSamples = mode.scanTime * SR;
  const blockSamples = syncSamples + blankSamples + mode.channels * scanSamples;
  const est = new Dec._internal.Estimator(SR, 16);
  const p1 = Math.round(analyticStart + blockSamples);   // true block-1 sync onset

  console.log(`true block-1 onset = ${p1}`);
  console.log('\nshort window (3 ms = 144 samples), offset relative to the true onset:');
  console.log('   rel(ms)   abs      f@offset   f@+2ms');
  for (let rel = -16; rel <= 4; rel += 1) {
    const o = p1 + Math.round(rel * 0.001 * SR);
    const a = est.peak(samples, o, 144);
    const b = est.peak(samples, o + Math.round(0.002 * SR), 144);
    console.log(`  ${String(rel).padStart(6)}  ${o}   ${a.toFixed(1).padStart(8)}  ${b.toFixed(1).padStart(8)}`);
  }
  console.log('\nlong window (20 ms) for reference:');
  for (let rel = -16; rel <= 4; rel += 4) {
    const o = p1 + Math.round(rel * 0.001 * SR);
    console.log(`  ${String(rel).padStart(6)}  ${o}   ${est.peak(samples, o, syncSamples).toFixed(1)}`);
  }
  // what is the actual pixel frequency in the tail of the previous scan?
  const tail = analyticStart + blockSamples - 200;
  console.log(`\nprevious scan tail estimate (offset ${tail}): ${est.peak(samples, tail, 144).toFixed(1)} Hz`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
