/*
 * Measures the decoder's sync-alignment error exactly.
 *
 * Because we generate the signal ourselves we know the TRUE sample index of every
 * sync pulse from the encoder's segment map. This walks the decoder's alignment
 * state machine line by line and reports the error against that ground truth, so
 * alignment accuracy is a number rather than an inference from image PSNR.
 *
 * Usage: node tests/diagnose-align.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));

const Modes = globalThis.SSTVModes;
const Timeline = globalThis.SSTVTimeline;
const Synth = globalThis.SSTVSynth;
const Dec = globalThis.SSTVDecode;

const SR = 48000;

function makeTestImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = Math.round((x / (w - 1)) * 255);
      data[i] = v; data[i + 1] = (x + y) % 256; data[i + 2] = 255 - v; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function stats(arr) {
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of arr) { min = Math.min(min, v); max = Math.max(max, v); sum += v; }
  const mean = sum / arr.length;
  let sq = 0;
  for (const v of arr) sq += (v - mean) * (v - mean);
  return { min, max, mean, std: Math.sqrt(sq / arr.length) };
}

for (const id of ['M1', 'S1']) {
  const mode = Modes.get(id);
  const img = makeTestImage(mode.width, mode.height);
  const timeline = Timeline.build(img, mode);
  const res = Synth.synthesize(timeline, SR);
  const samples = res.samples;
  const map = res.segmentMap;

  const est = new Dec._internal.Estimator(SR, 16);

  // Ground truth: sample index of every body sync pulse, in transmission order.
  const trueSyncs = [];
  for (let i = 0; i < map.length; i++) {
    const s = map[i];
    if (s.kind === 'tone' && s.freq === Modes.FREQ_SYNC) trueSyncs.push(s.s0);
  }
  // The header's break and VIS start/stop are also 1200 Hz; drop everything
  // before the first scan segment.
  const firstScan = map.findIndex((m) => m.kind === 'scan');
  const bodySyncs = trueSyncs.filter((v) => v >= map[firstScan].s0 - Math.round(mode.syncPulse * SR));

  const visEnd = map[firstScan].s0;
  let seqStart = Dec._internal.alignSync(est, samples, SR, mode, visEnd, false);
  const chanTime = mode.sepPulse + mode.scanTime;
  const base = mode.syncPulse + mode.syncPorch;
  const chanOffsets = mode.structure === 'martin'
    ? [base, base + chanTime, base + 2 * chanTime]
    : [base + chanTime, base + 2 * chanTime, base];
  const lineTime = Modes.lineTime(mode);

  if (mode.chanSync > 0) seqStart -= Math.round((chanOffsets[mode.chanSync] + mode.scanTime) * SR);

  const errors = [];
  let nulls = 0;
  let b = 0;
  for (let line = 0; line < mode.height; line++) {
    for (let chan = 0; chan < mode.channels; chan++) {
      if (chan !== mode.chanSync) continue;
      if (line > 0 || chan > 0) seqStart += Math.round(lineTime * SR);
      const res2 = Dec._internal.alignSync(est, samples, SR, mode, seqStart, true);
      if (res2 == null) { nulls++; continue; }
      seqStart = res2;
      // the true sync for this line is the (line+1)-th body sync for M1,
      // for S1 the leading sync is body sync #0 and each line's sync follows
      const truth = bodySyncs[b];
      if (truth != null) errors.push(seqStart - truth);
      b++;
    }
  }

  const s = stats(errors);
  console.log(`${mode.name}: aligned sync error vs ground truth over ${errors.length} lines`);
  console.log(`  min=${s.min} max=${s.max} mean=${s.mean.toFixed(2)} std=${s.std.toFixed(2)} samples` +
              `  (= ${(s.std / ((mode.scanTime / mode.width) * SR)).toFixed(2)} px std)`);
  if (nulls) console.log(`  ${nulls} alignments returned null`);
  // first few individual errors
  console.log('  first 8 errors: ' + errors.slice(0, 8).join(', '));
}

const { alignSync } = Dec._internal;
console.log('\nalignSync exported: ' + (typeof alignSync === 'function'));
