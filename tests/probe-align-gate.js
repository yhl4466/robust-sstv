/*
 * Phase-48 gate observation: which alignSync branch does the production decoder actually take?
 *
 * The whole argument for plan A is "the synthetic path is untouched because its prediction always
 * starts inside a pulse, and the real recording is fixed because its prediction does not". That is a
 * claim about control flow, so it is MEASURED here rather than inferred from the PSNR not moving:
 *
 *   synthetic S1 round trip  -> searchElected must be 0 (the walk ran every time)
 *   phigros real recording   -> searchElected must be > 0, and bestFromSearch must be > 0
 *
 * Usage: node tests/probe-align-gate.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PHIGROS = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

function freshStats() {
  return { calls: 0, startOfSyncCalls: 0, endOfSyncCalls: 0,
           startInSync: 0, startInImage: 0, searchElected: 0, bestFromSearch: 0, bestFromSearch0: 0 };
}

/** A grey-ramp S1 raster, i.e. the same shape roundtrip.js exercises. */
function rampImage(mode) {
  const w = mode.width, h = mode.height;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, v = Math.round(255 * (0.5 + 0.5 * Math.sin(x / 19 + y / 23)));
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
  }
  return { data: data, width: w, height: h };
}

(async function main() {
  const SR = 48000;
  const mode = Modes.get('S1');

  // ------------------------------------------------------------ synthetic
  const tl = Timeline.build(rampImage(mode), mode);
  const syn = Synth.synthesize(tl, SR);
  let st = freshStats();
  Decode._internal.setAlignStats(st);
  const dsyn = await Decode.decode(syn.samples, SR, { quality: 'standard', yieldEvery: 0 });
  Decode._internal.setAlignStats(null);
  console.log('=== synthetic S1 (our own encoder) ===');
  console.log('  decode ok=' + dsyn.ok + '  ' + (dsyn.mode && dsyn.mode.name));
  console.log('  alignSync calls        ' + st.calls + '  (startOfSync ' + st.startOfSyncCalls +
              ' · endOfSync ' + st.endOfSyncCalls + ')');
  console.log('  started IN sync       ' + st.startInSync);
  console.log('  started IN IMAGE      ' + st.startInImage);
  console.log('  --> search elected    ' + st.searchElected +
              (st.searchElected === 0 ? '   ✓ synthetic stayed on the original walk' : '   ✗ REGRESSION'));
  console.log('  search replaced pred  ' + st.bestFromSearch + ' · kept prediction ' + st.bestFromSearch0);

  // ------------------------------------------------------------ real recording
  if (!fs.existsSync(PHIGROS)) { console.log('\nmissing ' + PHIGROS + ' - skipping real audio'); return; }
  const buf = fs.readFileSync(PHIGROS);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  st = freshStats();
  Decode._internal.setAlignStats(st);
  const t0 = Date.now();
  const dreal = await Decode.decode(info.samples, info.sampleRate, { quality: 'standard', yieldEvery: 0 });
  Decode._internal.setAlignStats(null);
  console.log('\n=== phigros real recording ===');
  console.log('  decode ok=' + dreal.ok + '  ' + (dreal.mode && dreal.mode.name) +
              '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  console.log('  alignSync calls        ' + st.calls + '  (startOfSync ' + st.startOfSyncCalls +
              ' · endOfSync ' + st.endOfSyncCalls + ')');
  console.log('  started IN sync       ' + st.startInSync);
  console.log('  started IN IMAGE      ' + st.startInImage);
  console.log('  --> search elected    ' + st.searchElected +
              (st.searchElected > 0 ? '   ✓ the defect path was exercised' : '   ✗ never taken'));
  console.log('  search replaced pred  ' + st.bestFromSearch + ' · kept prediction ' + st.bestFromSearch0);
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
