/*
 * Is the block-mean error random or systematic?
 *
 * A 16-pixel block mean of independent sigma=7 errors should be sigma~1.8, which
 * would make a QIM step of 8 comfortably reliable. Measured behaviour implies
 * sigma~5 instead, so something systematic dominates. This isolates it with a
 * SINGLE clean round trip (no embedding at all), by measuring how the block-mean
 * error scales with block size and how it depends on saturation and local contrast.
 *
 * Usage: node scripts/diagnose-blockmean.js [--fast]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));

const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Dec = globalThis.SSTVDecode;
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;

const SR = 48000;
const QUALITY = process.argv.includes('--fast') ? 'fast' : 'standard';
const mode = Modes.get('M1');
const W = mode.width, H = mode.height;

function loadPhoto() {
  const p = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
}
function makeFlat(w, h, v) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  return { data: d, width: w, height: h };
}

async function roundTrip(img) {
  const tl = Timeline.build(img, mode);
  const s = Synth.synthesize(tl, SR);
  const parsed = Wav.parse(Wav.encode(s.samples, SR).buffer.slice(0));
  const r = await Dec.decode(parsed.samples, parsed.sampleRate, { quality: QUALITY });
  if (!r.ok) throw new Error('decode failed: ' + r.stage + ' ' + r.message);
  return r.imageData;
}

function std(a) {
  if (!a.length) return NaN;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
}

(async function main() {
  const src = loadPhoto();
  console.log(`Block-mean error analysis (mode=${mode.name}, quality=${QUALITY})\n`);

  const dec = await roundTrip(src);

  // ---- 1. how does block-mean error scale with block size? (green channel) ----
  console.log('=== 1. block-mean error vs block size (green, all blocks) ===');
  console.log('  B    #blocks    sigma(block mean err)   sigma/sigma(B=1)   random-theory 1/sqrt(B)');
  const perPixelErr = [];
  for (let p = 0; p < W * H; p++) perPixelErr.push(dec.data[p * 4 + 1] - src.data[p * 4 + 1]);
  const s1 = std(perPixelErr);
  for (const B of [1, 4, 8, 16, 64, 320]) {
    const errs = [];
    const perLine = Math.floor(W / B);
    for (let y = 0; y < H; y++) {
      for (let b = 0; b < perLine; b++) {
        let sm = 0, sd = 0;
        for (let k = 0; k < B; k++) {
          const p = y * W + b * B + k;
          sm += src.data[p * 4 + 1];
          sd += dec.data[p * 4 + 1];
        }
        errs.push(sd / B - sm / B);
      }
    }
    console.log(`  ${String(B).padStart(3)}  ${String(errs.length).padStart(7)}    ${std(errs).toFixed(3).padStart(18)}   ${(std(errs) / s1).toFixed(3).padStart(15)}   ${(1 / Math.sqrt(B)).toFixed(3)}`);
  }

  // ---- 2. is it saturation? split blocks by headroom ----
  console.log('\n=== 2. block-mean error vs saturation (B=16), green ===');
  const groups = { 'no saturation (headroom>=16)': [], 'near saturation (5..15)': [], 'saturated (<5)': [] };
  const perLine16 = Math.floor(W / 16);
  for (let y = 0; y < H; y++) {
    for (let b = 0; b < perLine16; b++) {
      let sm = 0, sd = 0, minv = 255, maxv = 0;
      for (let k = 0; k < 16; k++) {
        const p = y * W + b * 16 + k;
        const v = src.data[p * 4 + 1];
        sm += v; sd += dec.data[p * 4 + 1];
        if (v < minv) minv = v;
        if (v > maxv) maxv = v;
      }
      const headroom = Math.min(minv, 255 - maxv);
      const e = sd / 16 - sm / 16;
      if (headroom >= 16) groups['no saturation (headroom>=16)'].push(e);
      else if (headroom >= 5) groups['near saturation (5..15)'].push(e);
      else groups['saturated (<5)'].push(e);
    }
  }
  for (const k of Object.keys(groups)) {
    console.log(`  ${k.padEnd(30)} n=${String(groups[k].length).padStart(5)}  sigma=${std(groups[k]).toFixed(3)}`);
  }

  // ---- 3. is it local contrast? ----
  console.log('\n=== 3. block-mean error vs local contrast (B=16, green) ===');
  const byContrast = { 'flat (range<=8)': [], 'moderate (9..40)': [], 'high (>40)': [] };
  for (let y = 0; y < H; y++) {
    for (let b = 0; b < perLine16; b++) {
      let sm = 0, sd = 0, minv = 255, maxv = 0;
      for (let k = 0; k < 16; k++) {
        const p = y * W + b * 16 + k;
        const v = src.data[p * 4 + 1];
        sm += v; sd += dec.data[p * 4 + 1];
        if (v < minv) minv = v;
        if (v > maxv) maxv = v;
      }
      const e = sd / 16 - sm / 16;
      const range = maxv - minv;
      if (range <= 8) byContrast['flat (range<=8)'].push(e);
      else if (range <= 40) byContrast['moderate (9..40)'].push(e);
      else byContrast['high (>40)'].push(e);
    }
  }
  for (const k of Object.keys(byContrast)) {
    console.log(`  ${k.padEnd(30)} n=${String(byContrast[k].length).padStart(5)}  sigma=${std(byContrast[k]).toFixed(3)}`);
  }

  // ---- 4. flat mid-grey image: the best case the channel can offer ----
  console.log('\n=== 4. flat mid-grey image (no image content at all) ===');
  for (const v of [64, 128, 200]) {
    const flat = makeFlat(W, H, v);
    const d2 = await roundTrip(flat);
    const errs = [];
    for (let p = 0; p < W * H; p++) errs.push(d2.data[p * 4 + 1] - flat.data[p * 4 + 1]);
    const means = [];
    for (let y = 0; y < H; y++) {
      for (let b = 0; b < perLine16; b++) {
        let s = 0;
        for (let k = 0; k < 16; k++) s += d2.data[(y * W + b * 16 + k) * 4 + 1];
        means.push(s / 16 - v);
      }
    }
    console.log(`  flat G=${String(v).padStart(3)}  per-pixel sigma=${std(errs).toFixed(3).padStart(7)}  block16-mean sigma=${std(means).toFixed(3).padStart(7)}`);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
