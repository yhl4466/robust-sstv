/*
 * Carrier parameter sweep with the CORRECTED block-mean embedder
 * (js/payload-qim.js: nearest correct-parity grid point, headroom-aware
 * distribution, erasure reporting).
 *
 * The model to confirm: block-mean error sigma falls as 1/sqrt(B), so a target of
 * "boundary >= 2.8 sigma" should predict BER, and the image penalty should follow
 * E[shift^2] with shift uniform on [0, delta] -> MSE = delta^2/3.
 *
 * Usage: node scripts/sweep-carrier.js [--standard]
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
require(path.join(ROOT, 'js', 'payload-qim.js'));

const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Dec = globalThis.SSTVDecode,
      ChannelSim = globalThis.ChannelSim, PayloadQIM = globalThis.PayloadQIM;
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;

const SR = 48000;
const QUALITY = process.argv.includes('--standard') ? 'standard' : 'fast';
const mode = Modes.get('M1');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function loadPhoto() {
  const p = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
}
async function roundTrip(img, channelOpts) {
  const tl = Timeline.build(img, mode);
  const s = Synth.synthesize(tl, SR);
  let samples = s.samples;
  if (channelOpts && Object.keys(channelOpts).length) samples = ChannelSim.apply(samples, channelOpts);
  const parsed = Wav.parse(Wav.encode(samples, SR).buffer.slice(0));
  const r = await Dec.decode(parsed.samples, parsed.sampleRate, { quality: QUALITY });
  return r;
}
function chPsnr(a, b) {
  let se = 0, n = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    const d = a.data[p * 4 + 1] - b.data[p * 4 + 1]; se += d * d; n++;
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
function ber(a, b, mask) {
  let e = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (mask && mask[i]) continue;   // skip erasures: FEC's job, not the carrier's
    if (a[i] !== b[i]) e++;
    n++;
  }
  return n ? e / n : 0;
}

(async function main() {
  const src = loadPhoto();
  console.log(`Carrier sweep with corrected block-mean embedder (${mode.name}, ${QUALITY})\n`);
  console.log('   B  delta  nBits  bytes   BER(hard)  BER(no-erasure)  erasure%  unreach  PSNR_G vs orig');
  const rows = [];

  for (const B of [16, 32, 64, 128]) {
    for (const delta of [4, 6, 8, 10, 12]) {
      const cap = PayloadQIM.capacity(src, { blockSize: B });
      const nBits = cap.bits;
      const rnd = mulberry32(31337 + B * 7 + delta);
      const bits = new Uint8Array(nBits);
      for (let i = 0; i < nBits; i++) bits[i] = rnd() < 0.5 ? 0 : 1;

      const emb = PayloadQIM.embed(src, bits, { blockSize: B, delta });
      const r = await roundTrip(emb.imageData);
      if (!r.ok) { console.log(`  ${B} ${delta}: decode failed ${r.message}`); continue; }
      const ex = PayloadQIM.extract(r.imageData, nBits, { blockSize: B, delta });
      const eHard = ber(ex.bits, bits, null);
      const eValid = ber(ex.bits, bits, ex.erasures);
      const erPct = 100 * ex.erasures.reduce((a, b) => a + b, 0) / nBits;
      const p = chPsnr(r.imageData, src);
      rows.push({ B, delta, nBits, bytes: Math.floor(nBits / 8), eHard, eValid, erPct, unreach: emb.unreachable, psnr: p });

      console.log(`  ${String(B).padStart(3)}  ${String(delta).padStart(4)}  ${String(nBits).padStart(6)}  ${String(Math.floor(nBits / 8)).padStart(5)}   ` +
        `${eHard.toExponential(2).padStart(9)}  ${eValid.toExponential(2).padStart(14)}  ${erPct.toFixed(1).padStart(7)}%  ${String(emb.unreachable).padStart(7)}  ${p.toFixed(2).padStart(9)} dB`);
    }
    console.log('');
  }

  // ---- pick a design point: lowest BER with image PSNR >= 29.5 dB ----
  const BYTE_BUDGET = 16 / 255;
  const pMaxBit = 1 - Math.pow(1 - BYTE_BUDGET / 3, 1 / 8);
  console.log(`RS(255,223) budget: byte error <= ${(BYTE_BUDGET * 100).toFixed(2)}%  =>  raw bit BER target <= ${pMaxBit.toExponential(2)}\n`);
  const viable = rows.filter((r) => r.eValid <= pMaxBit && r.psnr >= 29.5)
    .sort((a, b) => b.nBits - a.nBits);
  if (viable.length) {
    const best = viable[0];
    console.log(`BEST (BER budget met, PSNR >= 29.5 dB): B=${best.B}, delta=${best.delta}` +
      ` -> BER=${best.eValid.toExponential(2)}, payload=${best.bytes} B, PSNR=${best.psnr.toFixed(2)} dB`);
  } else {
    const relaxed = rows.filter((r) => r.eValid <= pMaxBit).sort((a, b) => b.psnr - a.psnr)[0];
    console.log(relaxed
      ? `No config meets both. Best within budget: B=${relaxed.B}, delta=${relaxed.delta}, ${relaxed.bytes} B, PSNR ${relaxed.psnr.toFixed(2)} dB`
      : 'No configuration meets the RS byte budget at all.');
  }

  fs.writeFileSync(path.join(__dirname, 'out', 'sweep-carrier.json'), JSON.stringify({ quality: QUALITY, rows }, null, 2));
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });

