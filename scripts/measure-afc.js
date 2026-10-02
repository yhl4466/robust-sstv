/*
 * Quantifies AFC + clock recovery.
 *
 * For each channel preset: encode the reference photo, apply the channel, then decode
 * twice - once with the affine frequency calibration and once with it disabled - and
 * report image PSNR, header detection and the calibration the receiver estimated.
 *
 * This is the evidence for whether the systematic impairments (tuning error, clock
 * error) need receiver-side correction or can be left to FEC. They cannot be left to
 * FEC, so this measurement is what makes the rest of the robustness matrix meaningful.
 *
 * Usage: node scripts/measure-afc.js [--fast]
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
require(path.join(ROOT, 'js', 'channel-sim.js'));

const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Dec = globalThis.SSTVDecode,
      ChannelSim = globalThis.ChannelSim;
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;

const SR = 48000;
const QUALITY = process.argv.includes('--fast') ? 'fast' : 'standard';
const mode = Modes.get('M1');

function loadPhoto() {
  const p = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
}
function psnr(a, b) {
  let se = 0, n = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    for (const off of [0, 1, 2]) { const d = a.data[p * 4 + off] - b.data[p * 4 + off]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}

(async function main() {
  const src = loadPhoto();
  const tl = Timeline.build(src, mode);
  const clean = Synth.synthesize(tl, SR).samples;
  console.log(`AFC / clock-recovery value (${mode.name}, ${QUALITY}, ${(clean.length / SR).toFixed(1)}s)\n`);
  console.log('preset      afc    found   src            scale    offset(Hz)  hdrScale  clockScale  PSNR(dB)');
  const rows = [];

  for (const p of ChannelSim.presets()) {
    const degraded = ChannelSim.apply(clean, p.options);
    const parsed = Wav.parse(Wav.encode(degraded, SR).buffer.slice(0));
    for (const afc of [true, false]) {
      const r = await Dec.decode(parsed.samples, parsed.sampleRate, {
        quality: QUALITY, afc: afc, yieldFn: () => Promise.resolve()
      });
      let line = `${p.name.padEnd(10)}  ${String(afc).padEnd(5)}  ${(r.ok ? 'yes' : 'NO ').padEnd(5)}`;
      if (r.ok) {
        const c = r.calibration || {};
        const ps = psnr(r.imageData, src);
        line += `   ${String(c.source || '-').padEnd(13)} ${(c.scale || 1).toFixed(5)}  ${(c.offsetHz || 0).toFixed(2).padStart(9)}  ` +
                `${(c.headerScale || 1).toFixed(5)}  ${(c.clockScale || 1).toFixed(5)}  ${ps.toFixed(2).padStart(8)}`;
        rows.push({ preset: p.name, afc, psnr: ps, scale: c.scale, offset: c.offsetHz,
                    headerScale: c.headerScale, clock: c.clockScale, source: c.source });
      } else {
        line += `   -             -          -          -          -                ${(r.stage || '?')}`;
        rows.push({ preset: p.name, afc, psnr: null, stage: r.stage });
      }
      console.log(line);
    }
    // quantify the comparison honestly
    const on = rows.find((r) => r.preset === p.name && r.afc === true);
    const off = rows.find((r) => r.preset === p.name && r.afc === false);
    if (on && off) {
      const gain = (on.psnr == null ? NaN : on.psnr) - (off.psnr == null ? NaN : off.psnr);
      if (on.psnr != null && off.psnr != null) {
        console.log(`             -> AFC gain ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} dB`);
      } else if (on.psnr != null && off.psnr == null) {
        console.log(`             -> without AFC the decode FAILED entirely (${off.stage}); with AFC ${on.psnr.toFixed(2)} dB`);
      } else if (on.psnr == null && off.psnr == null) {
        console.log('             -> fails with and without AFC');
      }
    }
    console.log('');
  }

  fs.writeFileSync(path.join(__dirname, 'out', 'measure-afc.json'),
    JSON.stringify({ quality: QUALITY, rows }, null, 2));
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
