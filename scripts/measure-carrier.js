/*
 * Carrier diagnosis + candidate comparison.
 *
 * Triggered by M0's surprise: pixel-QIM BER did not improve with spreading the way
 * independent-error theory predicts (K: 1 -> 16 only moved BER 0.308 -> 0.193).
 *
 * Part A tests the mechanism hypothesis: the SSTV pixel window is a low-pass along
 * the scan line, so it partially UNDOES the QIM displacement itself. If so, a
 * bit's K pixels are weakened COHERENTLY, majority voting cannot help, and the
 * carrier - not the FEC - is the problem.
 *
 * Part B tests a carrier that is structurally immune to that: instead of moving
 * individual pixels, shift the MEAN of a horizontal block. A low-pass with unit DC
 * gain preserves a block mean, so the demodulator's blur cannot undo it.
 *
 * Usage: node scripts/measure-carrier.js [--standard]
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
const QUALITY = process.argv.includes('--standard') ? 'standard' : 'fast';
const mode = Modes.get('M1');
const W = mode.width, H = mode.height, PIXELS = W * H;

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
function clone(img) { return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height }; }

async function roundTrip(img) {
  const tl = Timeline.build(img, mode);
  const s = Synth.synthesize(tl, SR);
  const parsed = Wav.parse(Wav.encode(s.samples, SR).buffer.slice(0));
  const r = await Dec.decode(parsed.samples, parsed.sampleRate, { quality: QUALITY });
  if (!r.ok) throw new Error('decode failed: ' + r.stage + ' ' + r.message);
  return r.imageData;
}

function chPsnr(a, b, off) {
  let se = 0, n = 0;
  for (let p = 0; p < PIXELS; p++) { const d = a.data[p * 4 + off] - b.data[p * 4 + off]; se += d * d; n++; }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
function ber(a, b) { let e = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) e++; return e / a.length; }

// ------------------------------------------------------------ carriers
function qimLevel(v, bit, delta) {
  let L = Math.round(v / delta);
  if ((L & 1) !== bit) {
    const lo = (L - 1) * delta, hi = (L + 1) * delta;
    const loOk = lo >= 0 && lo <= 255, hiOk = hi >= 0 && hi <= 255;
    if (loOk && hiOk) L = (v - lo) <= (hi - v) ? L - 1 : L + 1;
    else if (loOk) L = L - 1; else if (hiOk) L = L + 1;
  }
  return Math.max(0, Math.min(255, Math.round(L * delta)));
}

/* Pixel QIM: K pixels per bit, strided so the pixels of one bit are far apart. */
function pixelQimEmbed(img, bits, delta, K) {
  const out = clone(img);
  const stride = Math.floor(PIXELS / K);
  for (let j = 0; j < bits.length; j++) {
    for (let k = 0; k < K; k++) {
      const p = j + k * stride;
      if (p >= PIXELS) continue;
      out.data[p * 4 + 1] = qimLevel(out.data[p * 4 + 1], bits[j], delta);
    }
  }
  return out;
}
function pixelQimExtract(dec, nBits, delta, K) {
  const stride = Math.floor(PIXELS / K);
  const bits = new Uint8Array(nBits);
  const soft = new Float32Array(nBits);
  for (let j = 0; j < nBits; j++) {
    let ones = 0, n = 0;
    for (let k = 0; k < K; k++) {
      const p = j + k * stride;
      if (p >= PIXELS) continue;
      if ((Math.round(dec.data[p * 4 + 1] / delta) & 1) === 1) ones++;
      n++;
    }
    soft[j] = ones / n;
    bits[j] = soft[j] > 0.5 ? 1 : 0;
  }
  return { bits, soft };
}

/*
 * Block-mean carrier: horizontal 1 x B blocks along each scan line.
 *
 * Rationale: the SSTV impairment that hurts pixel QIM is a low-pass along the scan
 * line with (approximately) unit DC gain. A block MEAN therefore survives it, while
 * an individual pixel's displacement does not. This is the classic patchwork /
 * block-mean watermark, chosen here because it matches the actual distortion.
 *
 * One bit per block: shift the whole block by a constant so the block mean lands on
 * the nearest multiple of `delta` with the wanted parity. The shift never exceeds
 * delta/2, which bounds the visible distortion.
 */
function blockEmbed(img, bits, B, delta) {
  const out = clone(img);
  const perLine = Math.floor(W / B);
  for (let j = 0; j < bits.length; j++) {
    const line = Math.floor(j / perLine), blk = j % perLine;
    const x0 = blk * B, y = line;
    if (y >= H) break;
    let sum = 0;
    for (let k = 0; k < B; k++) sum += out.data[(y * W + x0 + k) * 4 + 1];
    const m = sum / B;
    let L = Math.round(m / delta);
    if ((L & 1) !== bits[j]) {
      const lo = (L - 1) * delta, hi = (L + 1) * delta;
      L = (m - lo) <= (hi - m) ? L - 1 : L + 1;
    }
    let d = L * delta - m;
    if (d > delta / 2) d = delta / 2;
    if (d < -delta / 2) d = -delta / 2;
    for (let k = 0; k < B; k++) {
      const o = (y * W + x0 + k) * 4 + 1;
      out.data[o] = Math.max(0, Math.min(255, Math.round(out.data[o] + d)));
    }
  }
  return out;
}
function blockExtract(dec, nBits, B, delta) {
  const perLine = Math.floor(W / B);
  const bits = new Uint8Array(nBits);
  const soft = new Float32Array(nBits);
  for (let j = 0; j < nBits; j++) {
    const line = Math.floor(j / perLine), blk = j % perLine;
    const x0 = blk * B, y = line;
    if (y >= H) { bits[j] = 0; continue; }
    let sum = 0;
    for (let k = 0; k < B; k++) sum += dec.data[(y * W + x0 + k) * 4 + 1];
    const m = sum / B;
    const q = m / delta;
    const L = Math.round(q);
    bits[j] = L & 1;
    // distance to the decision boundary, as a soft value (fraction of a level)
    soft[j] = Math.abs(q - L);
  }
  return { bits, soft };
}

// ------------------------------------------------------------ main
(async function main() {
  const src = loadPhoto();
  console.log(`Carrier diagnosis  (mode=${mode.name}, quality=${QUALITY}, photo ${W}x${H})\n`);

  // ---------- Part A: does the channel undo the QIM displacement? ----------
  const DELTA_A = 16, K_A = 1;
  const nA = PIXELS;
  const rndA = mulberry32(7);
  const bitsA = new Uint8Array(nA);
  for (let i = 0; i < nA; i++) bitsA[i] = rndA() < 0.5 ? 0 : 1;

  const qimImg = pixelQimEmbed(src, bitsA, DELTA_A, K_A);
  // displacement introduced by the embedder
  const disp = new Float64Array(PIXELS);
  for (let p = 0; p < PIXELS; p++) disp[p] = qimImg.data[p * 4 + 1] - src.data[p * 4 + 1];

  const decA = await roundTrip(qimImg);
  // residual displacement left after the channel
  const resid = new Float64Array(PIXELS);
  for (let p = 0; p < PIXELS; p++) resid[p] = decA.data[p * 4 + 1] - src.data[p * 4 + 1];

  function regress(x, y) { // slope of y on x, plus group means
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (let i = 0; i < x.length; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; n++; }
    const mx = sx / n, my = sy / n;
    return { slope: (sxy / n - mx * my) / (sxx / n - mx * mx), meanX: mx, meanY: my };
  }
  const r = regress(disp, resid);
  let upSum = 0, upN = 0, dnSum = 0, dnN = 0;
  for (let p = 0; p < PIXELS; p++) {
    if (disp[p] > 0.5) { upSum += resid[p]; upN++; }
    else if (disp[p] < -0.5) { dnSum += resid[p]; dnN++; }
  }
  const recovered = (r.slope) * 100;

  console.log('=== Part A: is the channel undoing the QIM displacement? ===');
  console.log(`  embedder displacement: mean ${r.meanX.toFixed(2)}, |mean| of nonzero groups below`);
  console.log(`  residual (received - original) regressed on displacement: slope = ${r.slope.toFixed(3)}  (${recovered.toFixed(1)}% of the displacement survives)`);
  console.log(`  pixels pushed UP   : residual mean = ${(upSum / upN).toFixed(2)}   (n=${upN})`);
  console.log(`  pixels pushed DOWN : residual mean = ${(dnSum / dnN).toFixed(2)}   (n=${dnN})`);
  console.log(`  => the channel recovers ${recovered.toFixed(1)}% of each displacement; the missing ${(100 - recovered).toFixed(1)}% is coherent across a bit's pixels,`);
  console.log(`     which is exactly why majority voting over K pixels does not help.`);

  // per-pixel flip probability vs measured
  let flips = 0;
  for (let p = 0; p < PIXELS; p++) {
    const L = Math.round(decA.data[p * 4 + 1] / DELTA_A);
    if ((L & 1) !== bitsA[p]) flips++;
  }
  console.log(`  per-pixel flip probability = ${(flips / PIXELS).toFixed(4)}  (this is the K=1 BER)`);

  // ---------- Part B: candidate carriers ----------
  console.log('\n=== Part B: candidate carriers (same photo, real round trips) ===');
  console.log('carrier              B/K   delta  nBits  payload(B)  BER        PSNR_G(vs QIM src)  PSNR_G(vs orig)');

  const rows = [];

  // pixel QIM with heavy spreading
  for (const [delta, K] of [[8, 64], [8, 256], [16, 64]]) {
    const nBits = Math.floor(PIXELS / K);
    const rnd = mulberry32(101 + K);
    const bits = new Uint8Array(nBits);
    for (let i = 0; i < nBits; i++) bits[i] = rnd() < 0.5 ? 0 : 1;
    const img = pixelQimEmbed(src, bits, delta, K);
    const dec = await roundTrip(img);
    const ex = pixelQimExtract(dec, nBits, delta, K);
    const e = ber(ex.bits, bits);
    const pQ = chPsnr(dec, img, 1), pO = chPsnr(dec, src, 1);
    rows.push({ carrier: 'pixelQIM', K, delta, nBits, e, pQ, pO });
    console.log(`pixelQIM             ${String(K).padStart(3)}   ${String(delta).padStart(4)}  ${String(nBits).padStart(6)}  ${String(Math.floor(nBits / 8)).padStart(9)}  ${e.toExponential(2).padStart(9)}  ${pQ.toFixed(2).padStart(16)} dB  ${pO.toFixed(2).padStart(13)} dB`);
  }

  // block-mean
  for (const B of [4, 8, 16]) {
    for (const delta of [4, 8, 16]) {
      const perLine = Math.floor(W / B);
      const nBits = perLine * H;
      const rnd = mulberry32(202 + B * 3 + delta);
      const bits = new Uint8Array(nBits);
      for (let i = 0; i < nBits; i++) bits[i] = rnd() < 0.5 ? 0 : 1;
      const img = blockEmbed(src, bits, B, delta);
      const dec = await roundTrip(img);
      const ex = blockExtract(dec, nBits, B, delta);
      const e = ber(ex.bits, bits);
      const pQ = chPsnr(dec, img, 1), pO = chPsnr(dec, src, 1);
      rows.push({ carrier: 'blockMean', B, delta, nBits, e, pQ, pO });
      console.log(`blockMean            ${String(B).padStart(3)}   ${String(delta).padStart(4)}  ${String(nBits).padStart(6)}  ${String(Math.floor(nBits / 8)).padStart(9)}  ${e.toExponential(2).padStart(9)}  ${pQ.toFixed(2).padStart(16)} dB  ${pO.toFixed(2).padStart(13)} dB`);
    }
  }

  fs.writeFileSync(path.join(__dirname, 'out', 'measure-carrier.json'),
    JSON.stringify({ quality: QUALITY, partA: { slope: r.slope, pFlip: flips / PIXELS, upMean: upSum / upN, dnMean: dnSum / dnN }, rows }, null, 2));

  const best = rows.slice().sort((a, b) => a.e - b.e)[0];
  console.log(`\nlowest BER: ${best.carrier} ${best.carrier === 'blockMean' ? 'B=' + best.B : 'K=' + best.K} delta=${best.delta}` +
              ` -> BER=${best.e.toExponential(2)}, payload=${Math.floor(best.nBits / 8)} B, image PSNR ${best.pO.toFixed(2)} dB`);
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
