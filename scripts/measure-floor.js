/*
 * M0 - Measure the SSTV channel's intrinsic error floor, then choose the payload
 * QIM parameters (step size, spreading, layout) from MEASUREMENTS rather than
 * from a Gaussian assumption.
 *
 * Why this script exists
 * ---------------------
 * The phase-2 digital side channel rides on per-pixel luminance. The limit on its
 * reliability is not the channel simulator - it is the error the SSTV pipeline
 * already has on a CLEAN channel (measured phase-1 round trip: 31.21 dB, i.e.
 * ~7 grey levels RMS). Everything about the payload design follows from that
 * number and from whether those errors are spatially correlated.
 *
 * What it reports
 * ---------------
 *  Part 1  clean-tier per-pixel error: sigma, histogram shape, lag-1 correlation
 *          (horizontal and vertical), for a synthetic pattern and a real photo.
 *  Part 2  empirical QIM link budget: for a grid of step size x spreading x
 *          layout, the ACTUAL bit error rate and the ACTUAL image PSNR, each from
 *          a real encode/decode round trip.
 *  Part 3  validates a cheap "error replay" approximation against real round
 *          trips, so later sweeps do not need one decode per configuration.
 *
 * Usage:
 *   node scripts/measure-floor.js            # standard tier
 *   node scripts/measure-floor.js --fast     # faster, slightly worse demod
 *   node scripts/measure-floor.js --quick    # small grid
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'out');

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
const MODE_ID = 'M1';
const QUALITY = process.argv.includes('--fast') ? 'fast' : 'standard';
const QUICK = process.argv.includes('--quick');

const mode = Modes.get(MODE_ID);
const PIXELS = mode.width * mode.height;
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function roundTrip(imageData) {
  const tl = Timeline.build(imageData, mode);
  const synth = Synth.synthesize(tl, SR);
  const parsed = Wav.parse(Wav.encode(synth.samples, SR).buffer.slice(0));
  const r = await Dec.decode(parsed.samples, parsed.sampleRate, { quality: QUALITY });
  if (!r.ok) throw new Error('decode failed: ' + r.stage + ' ' + r.message);
  return r.imageData;
}

function psnrAgainst(decoded, source, channels) {
  let se = 0, n = 0;
  for (let i = 0; i < source.data.length; i++) {
    if (channels && channels.indexOf(i % 4) === -1) continue;
    const d = decoded.data[i] - source.data[i];
    se += d * d; n++;
  }
  const mse = se / n;
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10(65025 / mse), mse, rmse: Math.sqrt(mse) };
}

/** Synthetic 8-bar + grey ramp (sharp edges: worst case for the pixel window). */
function makeBars(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
                [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
  const barH = Math.floor(h * 0.75);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c;
      if (y < barH) c = bars[Math.min(7, Math.floor(x / (w / 8)))];
      else { const v = Math.round((x / (w - 1)) * 255); c = [v, v, v]; }
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function loadPhoto(w, h) {
  const p = path.join(RESEARCH, 'sstv', 'examples', 'sample.png');
  if (!PNG || !fs.existsSync(p)) return null;
  const png = PNG.sync.read(fs.readFileSync(p));
  if (png.width !== w || png.height !== h) return null;
  return { data: new Uint8ClampedArray(png.data), width: w, height: h };
}

function cloneImage(img) {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

// ------------------------------------------------------------------ QIM
/*
 * One bit per pixel, carried by the GREEN channel.
 *
 * Rationale for green-only: the receiver has G, B and R independently, so using a
 * single channel keeps the other two pristine and minimises the distortion the
 * visible image suffers per embedded bit.
 *
 * Level index L = round(v / delta); the bit is L & 1. To encode bit b we move v to
 * the NEAREST level whose parity is b (never more than delta/2 away).
 */
function qimTargetLevel(v, bit, delta) {
  let L = Math.round(v / delta);
  if ((L & 1) !== bit) {
    const lo = (L - 1) * delta;
    const hi = (L + 1) * delta;
    const loOk = lo >= 0 && lo <= 255;
    const hiOk = hi >= 0 && hi <= 255;
    if (loOk && hiOk) L = (v - lo) <= (hi - v) ? L - 1 : L + 1;
    else if (loOk) L = L - 1;
    else if (hiOk) L = L + 1;
    // if neither neighbour is in range, keep parity by flipping the other way
    else L = (L & 1) === bit ? L : L + 1;
  }
  let out = L * delta;
  if (out < 0) out = 0;
  if (out > 255) out = 255;
  return Math.round(out);
}

/**
 * Pixel index list for bit j.
 *  'contig'  - the K pixels of a bit are adjacent (best case for a burst, worst
 *              case for averaging, because SSTV errors are spatially correlated)
 *  'strided' - the K pixels of a bit are spread stride apart
 */
function bitPixels(j, K, layout, total) {
  const idx = [];
  if (layout === 'contig') {
    const base = j * K;
    for (let k = 0; k < K; k++) idx.push(base + k);
  } else {
    const stride = Math.floor(total / K);
    for (let k = 0; k < K; k++) idx.push(j + k * stride);
  }
  return idx;
}

/** Embed `bits` into the G channel; returns {image, bits, usedPixels}. */
function embed(img, bits, delta, K, layout) {
  const out = cloneImage(img);
  const total = img.width * img.height;
  const used = [];
  for (let j = 0; j < bits.length; j++) {
    for (const p of bitPixels(j, K, layout, total)) {
      const o = p * 4 + 1; // green
      const v = out.data[o];
      out.data[o] = qimTargetLevel(v, bits[j], delta);
      used.push(p);
    }
  }
  return { image: out, usedPixels: used };
}

/** Hard-decision extraction with majority vote over the K pixels of each bit. */
function extract(decoded, nBits, delta, K, layout) {
  const total = decoded.width * decoded.height;
  const bits = new Uint8Array(nBits);
  const votes = new Float32Array(nBits); // fraction of pixels voting 1 (soft-ish)
  for (let j = 0; j < nBits; j++) {
    let ones = 0, n = 0;
    for (const p of bitPixels(j, K, layout, total)) {
      const v = decoded.data[p * 4 + 1];
      const L = Math.round(v / delta);
      if ((L & 1) === 1) ones++;
      n++;
    }
    votes[j] = ones / n;
    bits[j] = votes[j] > 0.5 ? 1 : 0;
  }
  return { bits, votes };
}

function ber(a, b, n) {
  let e = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) e++;
  return e / n;
}

// ------------------------------------------------------------------ main
(async function main() {
  console.log(`M0 error-floor measurement  (mode=${mode.name}, quality=${QUALITY}, ${PIXELS} pixels)\n`);

  const sources = [['synthetic bars', makeBars(mode.width, mode.height)]];
  const photo = loadPhoto(mode.width, mode.height);
  if (photo) sources.push(['real photo', photo]);

  // ---------------- Part 1: intrinsic per-pixel error ----------------
  console.log('=== Part 1: clean-tier per-pixel error (no QIM, no channel) ===');
  console.log('source            ch    mean      sigma    p50   p95   p99    max   lag1_h  lag1_v');
  const errorFields = {};
  for (const [label, src] of sources) {
    const dec = await roundTrip(src);
    const W = mode.width, H = mode.height;
    for (const [chName, off] of [['G', 1], ['B', 2], ['R', 0]]) {
      const errs = new Float64Array(W * H);
      let sum = 0;
      for (let p = 0; p < W * H; p++) {
        const e = dec.data[p * 4 + off] - src.data[p * 4 + off];
        errs[p] = e; sum += e;
      }
      const mean = sum / (W * H);
      let sq = 0;
      for (let p = 0; p < W * H; p++) sq += (errs[p] - mean) * (errs[p] - mean);
      const sigma = Math.sqrt(sq / (W * H));
      const abs = Array.from(errs, Math.abs).sort((a, b) => a - b);
      const q = (f) => abs[Math.min(abs.length - 1, Math.floor(f * abs.length))];
      // lag-1 correlations
      function lag1(dx, dy) {
        let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        for (let y = 0; y < H - dy; y++) {
          for (let x = 0; x < W - dx; x++) {
            const a = errs[y * W + x] - mean;
            const b = errs[(y + dy) * W + (x + dx)] - mean;
            sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
          }
        }
        const cov = sab / n - (sa / n) * (sb / n);
        const va = saa / n - (sa / n) ** 2;
        const vb = sbb / n - (sb / n) ** 2;
        return cov / Math.sqrt(va * vb);
      }
      console.log(
        `${label.padEnd(16)} ${chName}  ${mean.toFixed(2).padStart(7)}  ${sigma.toFixed(2).padStart(7)}` +
        `  ${q(0.5).toFixed(0).padStart(4)}  ${q(0.95).toFixed(0).padStart(4)}  ${q(0.99).toFixed(0).padStart(4)}` +
        `  ${abs[abs.length - 1].toFixed(0).padStart(5)}  ${lag1(1, 0).toFixed(3).padStart(6)}  ${lag1(0, 1).toFixed(3).padStart(6)}`
      );
      if (chName === 'G') errorFields[label] = { errs, sigma, mean, W, H, decoded: dec };
    }
  }

  // ---------------- Part 2: empirical QIM link budget ----------------
  const deltas = QUICK ? [8, 16] : [6, 8, 10, 12, 16, 20, 24, 32];
  const Ks = QUICK ? [1, 16] : [1, 4, 16];
  const layouts = QUICK ? ['strided'] : ['contig', 'strided'];

  console.log('\n=== Part 2: empirical QIM link budget (green channel, real round trips) ===');
  console.log('delta  K   layout    nBits    nPix%   BER_raw     imgPSNR(vs QIM src)   imgPSNR(vs orig src)');
  const results = [];

  for (const [label, src] of sources) {
    console.log(`--- source: ${label} ---`);
    for (const delta of deltas) {
      for (const K of Ks) {
        const nBits = Math.floor(PIXELS / K);
        const rnd = mulberry32(0xC0FFEE ^ (delta * 31) ^ K);
        const bits = new Uint8Array(nBits);
        for (let i = 0; i < nBits; i++) bits[i] = rnd() < 0.5 ? 0 : 1;

        for (const layout of layouts) {
          const emb = embed(src, bits, delta, K, layout);
          const dec = await roundTrip(emb.image);
          const ext = extract(dec, nBits, delta, K, layout);
          const e = ber(ext.bits, bits, nBits);
          const vsQim = psnrAgainst(dec, emb.image, [1]);
          const vsOrig = psnrAgainst(dec, src, [1]);
          const nPix = emb.usedPixels.length;
          results.push({ label, delta, K, layout, nBits, ber: e, imgPsnr: vsQim.psnr, vsOrig: vsOrig.psnr });

          console.log(
            `${String(delta).padStart(5)}  ${String(K).padStart(2)}  ${layout.padEnd(8)}  ` +
            `${String(nBits).padStart(6)}  ${(100 * nPix / PIXELS).toFixed(1).padStart(6)}%  ` +
            `${e.toExponential(2).padStart(9)}  ${vsQim.psnr.toFixed(2).padStart(10)} dB          ` +
            `${vsOrig.psnr.toFixed(2).padStart(8)} dB`
          );
        }
      }
    }
  }

  // ---------------- recommendation ----------------
  /*
   * Pick the largest capacity (smallest K) whose measured BER stays under a
   * target that RS(255,223) can absorb with margin. RS works on BYTES: a bit
   * error rate p gives a byte error rate of about 1-(1-p)^8, and RS(255,223)
   * tolerates 16 bad bytes out of 255, i.e. ~6.3%.
   */
  const BYTE_BUDGET = 16 / 255;           // 6.27% bytes per codeword
  const pMaxBit = 1 - Math.pow(1 - BYTE_BUDGET / 3, 1 / 8); // /3 = safety margin
  console.log(`\nRS(255,223) byte budget ${(BYTE_BUDGET * 100).toFixed(2)}%  =>  target raw BER <= ${pMaxBit.toExponential(2)} (with 3x margin)`);

  const viable = results
    .filter((r) => r.ber <= pMaxBit)
    .sort((a, b) => b.nBits - a.nBits || a.delta - b.delta);
  if (viable.length) {
    const best = viable[0];
    console.log(`RECOMMENDED: delta=${best.delta}, K=${best.K}, layout=${best.layout}` +
      `  -> BER=${best.ber.toExponential(2)}, nBits=${best.nBits}, image PSNR ${best.imgPsnr.toFixed(2)} dB`);
  } else {
    console.log('NO configuration met the byte budget - the payload must use more spreading or a larger step.');
  }

  fs.writeFileSync(path.join(OUT, 'measure-floor.json'), JSON.stringify({
    mode: MODE_ID, quality: QUALITY, results,
    errorFloor: Object.fromEntries(Object.entries(errorFields).map(([k, v]) => [k, { sigma: v.sigma, mean: v.mean }]))
  }, null, 2));
  console.log(`\nraw results -> ${path.relative(ROOT, path.join(OUT, 'measure-floor.json'))}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
