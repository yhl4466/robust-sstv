/*
 * Performance + fidelity across the three decoder quality tiers.
 *
 * Produces the numbers behind the UI's 快速 / 标准 / 精细 selector (AC5).
 *
 * Usage: node tests/perf.js
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

const Modes = globalThis.SSTVModes;
const Timeline = globalThis.SSTVTimeline;
const Synth = globalThis.SSTVSynth;
const Wav = globalThis.SSTVWav;
const Dec = globalThis.SSTVDecode;

let PNG = null;
try { PNG = require(path.join(RESEARCH, 'pngjs')).PNG; } catch (e) { }

const SR = 48000;

function makeTestImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const bars = [
    [255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
    [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]
  ];
  const barH = Math.floor(h * 0.75);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r, g, b;
      if (y < barH) {
        const c = bars[Math.min(bars.length - 1, Math.floor(x / (w / bars.length)))];
        r = c[0]; g = c[1]; b = c[2];
      } else { const v = Math.round((x / (w - 1)) * 255); r = g = b = v; }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}

(async function main() {
  console.log('Decoder quality tiers (48 kHz, Node)\n');
  console.log('mode    tier      mult  decode(s)   PSNR(dB)  pixels');
  console.log('-----------------------------------------------------------');

  for (const id of ['M1', 'S1']) {
    const mode = Modes.get(id);
    const img = makeTestImage(mode.width, mode.height);
    const timeline = Timeline.build(img, mode);
    const synth = Synth.synthesize(timeline, SR);
    const parsed = Wav.parse(Wav.encode(synth.samples, SR).buffer.slice(0));

    for (const tier of ['fast', 'standard', 'fine']) {
      const t0 = Date.now();
      const r = await Dec.decode(parsed.samples, parsed.sampleRate, { quality: tier });
      const ms = Date.now() - t0;
      if (!r.ok) { console.log(`${id}  ${tier}: FAILED ${r.message}`); continue; }
      const p = psnr(r.imageData.data, img.data);
      console.log(`${id.padEnd(7)} ${tier.padEnd(9)} ${String(Dec.QUALITY[tier].mult).padStart(4)}  ` +
                  `${(ms / 1000).toFixed(2).padStart(9)}   ${p.toFixed(2).padStart(8)}  ` +
                  `${r.imageData.width * r.imageData.height}`);
    }
    console.log('');
  }

  console.log('For reference, the unoptimised upstream decoder took 112.4 s on Martin M1');
  console.log('with no quality selector (fixed 4096-point FFT per pixel).');
})();
