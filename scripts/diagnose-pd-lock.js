/*
 * Where does the full PD decode diverge from the analytic one?
 *
 * The diagnostic (scripts/diagnose-pd.js) reaches 26.4 dB with ANALYTIC block starts, while
 * the full decoder sits at ~12.4 dB. This prints the three quantities that differ between
 * the two paths so the divergence is located instead of guessed:
 *   - where the decoder thinks the body starts (visEnd)
 *   - what clockScale the calibration estimated
 *   - the block starts it actually locked onto, against the analytic grid
 *
 * Usage: node scripts/diagnose-pd-lock.js
 */
'use strict';
const fs = require('fs');
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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] = Math.round(127 + 120 * Math.sin(x / 17));
      d[o + 1] = Math.round(127 + 120 * Math.sin(y / 13 + 1));
      d[o + 2] = Math.round(127 + 120 * Math.sin((x + y) / 23));
      d[o + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

(async function main() {
  const img = ramp(W, H);
  const samples = Synth.synthesize(Timeline.build(img, mode), SR).samples;

  const analyticStart = Math.round(Modes.VIS_HEADER_LEN * SR);
  const syncSamples = Math.round(mode.syncPulse * SR);
  const blankSamples = Math.round(mode.blanking * SR);
  const scanSamples = mode.scanTime * SR;
  const blockSamples = syncSamples + blankSamples + mode.channels * scanSamples;

  const res = await Dec.decode(samples, SR, { quality: 'standard', yieldFn: () => Promise.resolve() });
  console.log('decoder ok:', res.ok);
  const c = res.calibration || {};
  console.log('imageStart (visEnd)   :', c.imageStart, '  analytic:', analyticStart,
    '  delta:', c.imageStart - analyticStart, 'samples');
  console.log('clockScale            :', c.clockScale);
  console.log('scale a / offset b    :', c.scale, '/', c.offsetHz, ' source:', c.source);
  console.log('sync observations     :', c.observations);
  console.log('\nblock starts (locked vs analytic):');
  const got = c.pdBlockStarts || [];
  for (let p = 0; p < got.length; p++) {
    const want = Math.round(analyticStart + p * blockSamples);
    console.log(`  p=${p}  locked=${String(got[p]).padStart(7)}  analytic=${String(want).padStart(7)}  ` +
      `delta=${String(got[p] - want).padStart(6)} samples (${((got[p] - want) / SR * 1000).toFixed(2)} ms, ` +
      `${((got[p] - want) / (scanSamples / W)).toFixed(1)} px)`);
  }
  console.log('\ntimings:', JSON.stringify(res.timings));
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
