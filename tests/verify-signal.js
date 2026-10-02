/*
 * ENCODER-side verification, independent of any decoder.
 *
 * Two complementary checks:
 *
 *  A. ACOUSTIC. Measure the synthesised signal's actual dominant frequency at
 *     known points and compare with what the timeline intended. Header tones and
 *     VIS bits are long enough to measure directly. Scan pixels are only ~22
 *     samples (< 1 cycle of a 1500 Hz tone), which no estimator can resolve, so
 *     scan content is measured over FLAT RUNS of ~8 identical pixels instead -
 *     which is exactly where a staircase modulator should hold a constant tone.
 *
 *  B. EXACT. Compare the timeline's per-pixel frequency arrays against the values
 *     implied by the source image. This checks the colour mapping, channel order
 *     and scan structure with zero measurement error.
 *
 * Usage: node tests/verify-signal.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));

const Modes = globalThis.SSTVModes;
const Timeline = globalThis.SSTVTimeline;
const Synth = globalThis.SSTVSynth;
const FFT = globalThis.FFT;

const SR = 48000;
let failures = 0;

function measure(samples, atSample, len) {
  const size = 16384;
  const n = Math.min(len, samples.length - atSample);
  if (n < 24) return NaN;
  const f = new FFT(size);
  const inp = new Float32Array(size);
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    inp[i] = samples[atSample + i] * w;
  }
  const out = new Float32Array(2 * size);
  f.realTransform(out, inp);
  const mags = new Float32Array(size / 2 + 1);
  let best = -1, bx = 0;
  for (let k = 0; k < mags.length; k++) {
    const re = out[2 * k], im = out[2 * k + 1];
    const m = Math.sqrt(re * re + im * im);
    if (m > best) { best = m; bx = k; }
    mags[k] = m;
  }
  const y1 = bx > 0 ? mags[bx - 1] : mags[bx];
  const y3 = bx < mags.length - 1 ? mags[bx + 1] : mags[bx];
  const den = y3 + mags[bx] + y1;
  const pk = den === 0 ? bx : (y3 - y1) / den + bx;
  return pk * SR / size;
}

// 8 colour bars, each 40 px wide at 320 px -> flat runs are easy to find.
const BARS = [
  [255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
  [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]
];
function makeTestImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const barH = Math.floor(h * 0.75);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r, g, b;
      if (y < barH) {
        const c = BARS[Math.min(BARS.length - 1, Math.floor(x / (w / BARS.length)))];
        r = c[0]; g = c[1]; b = c[2];
      } else { const v = Math.round((x / (w - 1)) * 255); r = g = b = v; }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const toFreq = (v) => Modes.FREQ_BLACK + v * Modes.COLOR_FREQ_MULT;

function report(label, expected, actual, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(30)} want ${expected.toFixed(1).padStart(7)} Hz  got ${actual.toFixed(1).padStart(7)} Hz  (d=${(actual - expected).toFixed(1)}, tol ${tol})`);
}

console.log('SSTV encoder verification (decoder-independent)\n');

for (const id of ['M1', 'S1']) {
  const mode = Modes.get(id);
  const img = makeTestImage(mode.width, mode.height);
  const timeline = Timeline.build(img, mode);
  const res = Synth.synthesize(timeline, SR);
  const s = res.samples;
  const map = res.segmentMap;

  console.log(`=== ${mode.name} (${mode.width}x${mode.height}) ===`);
  console.log('  [A] acoustic checks');

  // header / VIS tones
  report('leader 1', 1900, measure(s, map[0].s0 + 2000, 8000), 20);
  report('break', 1200, measure(s, map[1].s0 + 100, 300), 40);
  report('leader 2', 1900, measure(s, map[2].s0 + 2000, 8000), 20);
  report('VIS start bit', 1200, measure(s, map[3].s0 + 300, 900), 30);

  const visBits = Modes.visBits(mode);
  let visBad = 0;
  for (let b = 0; b < 8; b++) {
    const seg = map[4 + b];
    const expect = visBits[b] ? 1100 : 1300;
    if (Math.abs(measure(s, seg.s0 + 300, 900) - expect) > 60) visBad++;
  }
  if (visBad) { failures++; console.log(`  FAIL VIS data bits: ${visBad}/8 wrong`); }
  else console.log('  OK   VIS data bits (8)            all 1100/1300 Hz correct');

  // long body tones
  let toneN = 0, toneBad = 0;
  for (const seg of map) {
    if (seg.kind !== 'tone') continue;
    const n = seg.s1 - seg.s0;
    if (n < 400) continue;
    if (seg.freq !== Modes.FREQ_SYNC && seg.freq !== Modes.FREQ_PORCH) continue;
    if (Math.abs(measure(s, seg.s0 + Math.floor(n * 0.25), Math.floor(n * 0.5)) - seg.freq) > 30) toneBad++;
    toneN++;
  }
  if (toneBad) { failures++; console.log(`  FAIL body sync/porch tones: ${toneBad}/${toneN} wrong`); }
  else console.log(`  OK   body sync/porch tones (${toneN})     all within 30 Hz`);

  // scan content over flat runs (8 identical pixels)
  const perPixelSamples = (mode.scanTime / mode.width) * SR;
  const runPx = 8;
  let flatN = 0, flatBad = 0;
  const scans = [];
  for (const seg of map) if (seg.kind === 'scan') scans.push(seg);
  const perLine = mode.structure === 'pd' ? 4 : mode.channels;

  for (const pick of [0, 1, 2, Math.floor(scans.length / 2), scans.length - 1]) {
    const seg = scans[pick];
    const idxInLine = pick % perLine;
    const scanName = mode.scanOrder[idxInLine];
    if (mode.structure === 'pd' && (scanName === 'RY' || scanName === 'BY')) continue; // chroma is averaged
    const line = mode.structure === 'pd' ? Math.floor(pick / perLine) * 2 : Math.floor(pick / perLine);
    if (line >= mode.height) continue;
    // Only the colour-bar region is flat; below it the test image is a grey ramp
    // whose value varies with x, so it is not a flat run.
    if (line >= Math.floor(mode.height * 0.75)) continue;

    for (let bi = 0; bi < BARS.length; bi++) {
      const cx = Math.floor((bi + 0.5) * (mode.width / BARS.length));
      const x0 = Math.max(0, cx - runPx / 2);
      const bar = BARS[bi];
      const val = scanName === 'R' ? bar[0] : scanName === 'G' ? bar[1] : scanName === 'B' ? bar[2]
        : Math.round(0.299 * bar[0] + 0.587 * bar[1] + 0.114 * bar[2]);
      const want = toFreq(val);
      const at = seg.s0 + Math.round(x0 * perPixelSamples);
      const len = Math.round(runPx * perPixelSamples);
      const got = measure(s, at, len);
      flatN++;
      if (Math.abs(got - want) > 70) {
        flatBad++;
        if (flatBad <= 6) console.log(`  FAIL flat run scan#${pick} ${scanName} line ${line} bar ${bi} (val ${val}) want ${want.toFixed(0)} got ${got.toFixed(0)}`);
      }
    }
  }
  if (flatBad) { failures++; console.log(`  FAIL scan flat runs: ${flatBad}/${flatN} off by >70 Hz`); }
  else console.log(`  OK   scan flat runs (${flatN})          all within 70 Hz`);

  // ---- [B] exact timeline check ----
  console.log('  [B] exact timeline checks');
  let exN = 0, exBad = 0, firstBad = null;
  let k = 0;
  for (let i = 0; i < map.length; i++) {
    const seg = map[i];
    if (seg.kind !== 'scan') continue;
    const idxInLine = k % perLine;
    const scanName = mode.scanOrder[idxInLine];
    const line = mode.structure === 'pd' ? Math.floor(k / perLine) * 2 : Math.floor(k / perLine);
    k++;
    if (line >= mode.height) continue;
    // skip averaged chroma for PD
    if (mode.structure === 'pd' && (scanName === 'RY' || scanName === 'BY')) continue;

    for (let x = 0; x < mode.width; x += 7) {
      const p = (line * mode.width + x) * 4;
      const bar = [img.data[p], img.data[p + 1], img.data[p + 2]];
      const val = scanName === 'R' ? bar[0] : scanName === 'G' ? bar[1] : scanName === 'B' ? bar[2]
        : Math.round(0.299 * bar[0] + 0.587 * bar[1] + 0.114 * bar[2]);
      const want = toFreq(val);
      const got = seg.freqs[x];
      exN++;
      if (Math.abs(got - want) > 0.01) { exBad++; if (!firstBad) firstBad = { scanName, line, x, val, want, got }; }
    }
  }
  if (exBad) {
    failures++;
    console.log(`  FAIL per-pixel frequency mapping: ${exBad}/${exN} wrong; first: ${JSON.stringify(firstBad)}`);
  } else {
    console.log(`  OK   per-pixel frequency mapping (${exN} samples) exact`);
  }

  // Structural check for the first scan line: sync/porch placement and channel order.
  // Anchor on the first SCAN segment (searching for a sync tone would find the
  // header's 1200 Hz break instead).
  const firstScan = map.findIndex((m) => m.kind === 'scan');
  const expectSeq = mode.structure === 'martin'
    ? ['sync', 'porch', 'G', 'porch', 'B', 'porch', 'R', 'porch']
    : ['porch', 'G', 'porch', 'B', 'sync', 'porch', 'R'];
  const lineIdx = mode.structure === 'martin' ? firstScan - 2 : firstScan - 1;
  const actualSeq = [];
  const scanNames = [];
  for (let j = 0; j < expectSeq.length; j++) {
    const seg = map[lineIdx + j];
    if (!seg) { actualSeq.push('MISSING'); continue; }
    if (seg.kind === 'tone') actualSeq.push(seg.freq === Modes.FREQ_SYNC ? 'sync' : 'porch');
    else { actualSeq.push(mode.scanOrder[scanNames.length]); scanNames.push(1); }
  }
  const seqOk = JSON.stringify(actualSeq) === JSON.stringify(expectSeq);
  if (!seqOk) { failures++; console.log(`  FAIL line structure: expected ${expectSeq.join(',')} got ${actualSeq.join(',')}`); }
  else console.log(`  OK   line structure              ${actualSeq.join(' -> ')}`);

  // The leading sync that Scottie requires before its first line must be present.
  if (mode.structure === 'scottie') {
    const leadOk = map[firstScan - 2] && map[firstScan - 2].kind === 'tone' && map[firstScan - 2].freq === Modes.FREQ_SYNC;
    if (!leadOk) { failures++; console.log('  FAIL leading start-of-image sync missing'); }
    else console.log('  OK   leading start-of-image sync present');
  }

  console.log('');
}

console.log('================================');
console.log(failures === 0 ? 'ENCODER VERIFIED' : failures + ' ENCODER CHECK(S) FAILED');
process.exitCode = failures === 0 ? 0 : 1;
