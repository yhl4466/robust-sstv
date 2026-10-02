/*
 * Phase-3 content-dependence study (ASCII-only source: an earlier version was corrupted
 * by a PowerShell UTF-8/GBK round trip, so all output text is deliberately ASCII).
 *
 * Measures clean-channel carrier BER for an image corpus (classes x 10) and fits a
 * USER-OPERABLE predictor computable in one pass before transmission.
 *
 * Two competing explanations are tested head to head:
 *   (i)  EDGE / gradient statistics - the phase-2 hypothesis: inter-pixel interference
 *        grows with local horizontal contrast, and averaging then fails because the
 *        errors are correlated.
 *   (ii) HEADROOM / per-block dynamic range - a block containing both near-0 and
 *        near-255 pixels has an achievable mean range of almost a single point, so its
 *        bit CANNOT be written at all, regardless of averaging or FEC.
 *
 * Usage: node scripts/eval-content.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const IMGDIR = path.join(ROOT, 'tests', 'fixtures', 'images');
const OUT = path.join(__dirname, 'out');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
require(path.join(ROOT, 'js', 'channel-sim.js'));
require(path.join(ROOT, 'js', 'payload-qim.js'));
require(path.join(ROOT, 'js', 'fec-rs.js'));
require(path.join(ROOT, 'js', 'interleaver.js'));
require(path.join(ROOT, 'js', 'payload-pipeline.js'));

const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Dec = globalThis.SSTVDecode,
      PayloadQIM = globalThis.PayloadQIM;
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;

const SR = 48000;
const MODE_ID = 'M1';
const QUALITY = 'standard';
const B = 16, DELTA = 12;
const P_TARGET = 2.6e-3;          // RS(255,223) byte budget with margin, from phase 2
const mode = Modes.get(MODE_ID);
fs.mkdirSync(OUT, { recursive: true });

const CLASS_LABEL = {
  A: 'natural photo (same-scene variants)',
  B: 'high-contrast bars/graphics',
  C: 'screen capture (with text)',
  D: 'cartoon / vector',
  E: 'low-contrast smooth',
  F: '1/f spectral synthetic (statistics control)'
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Fit a source image into the mode raster the same way the app's fitToMode does. */
function fitToMode(png, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;   // black letterbox
  const scale = Math.min(width / png.width, height / png.height);
  const dw = Math.max(1, Math.round(png.width * scale)), dh = Math.max(1, Math.round(png.height * scale));
  const dx = Math.floor((width - dw) / 2), dy = Math.floor((height - dh) / 2);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(png.width - 1, Math.floor(x * png.width / dw));
      const sy = Math.min(png.height - 1, Math.floor(y * png.height / dh));
      const s = (sy * png.width + sx) << 2;
      const d = ((y + dy) * width + (x + dx)) << 2;
      out[d] = png.data[s]; out[d + 1] = png.data[s + 1];
      out[d + 2] = png.data[s + 2]; out[d + 3] = 255;
    }
  }
  return { data: out, width: width, height: height };
}

/** Single-pass source statistics (cheap enough to run live in the browser). */
function features(img) {
  const w = img.width, h = img.height, d = img.data;
  const G = (x, y) => d[((y * w + x) << 2) + 1];
  let sgx = 0, sgx2 = 0, totE = 0, sgy = 0, n = 0, edges = 0, localRange = 0, nLocal = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = G(x, y);
      totE += v * v;
      if (x + 1 < w) {
        const dv = G(x + 1, y) - v;
        sgx += Math.abs(dv); sgx2 += dv * dv;
        if (Math.abs(dv) > 40) edges++;
        n++;
      }
      if (y + 1 < h) sgy += Math.abs(G(x, y + 1) - v);
    }
  }
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      let mn = 255, mx = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = G(x + dx, y + dy);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      localRange += mx - mn; nLocal++;
    }
  }
  return {
    F1_gradX: sgx / n,
    F2_gradXY: (sgx + sgy) / (2 * n),
    F3_hfRatio: totE ? sgx2 / totE : 0,
    F4_edgeDensity: edges / n,
    F5_localRange: localRange / nLocal
  };
}

/** Per-block dynamic range vs available headroom (the competing explanation). */
function headroomFeatures(img, blockSize, delta) {
  const w = img.width, h = img.height, d = img.data;
  const perLine = Math.floor(w / blockSize);
  let noHeadroom = 0, total = 0, meanRange = 0;
  for (let line = 0; line < h; line++) {
    for (let blk = 0; blk < perLine; blk++) {
      let mn = 255, mx = 0;
      for (let k = 0; k < blockSize; k++) {
        const v = d[((line * w + blk * blockSize + k) << 2) + 1];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      // the achievable mean range has width 255 - (max - min); it must span a QIM level
      if (mx - mn > 255 - delta) noHeadroom++;
      meanRange += mx - mn;
      total++;
    }
  }
  return { H1_noHeadroomFrac: noHeadroom / total, H2_meanBlockRange: meanRange / total };
}

function ber(a, b) {
  let e = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) e++;
  return n ? e / n : 1;
}
function spearman(xs, ys) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    idx.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const rx = rank(xs), ry = rank(ys), n = xs.length, m = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - m) * (ry[i] - m); dx += (rx[i] - m) ** 2; dy += (ry[i] - m) ** 2; }
  return num / Math.sqrt(dx * dy);
}

(async function main() {
  const manifestPath = path.join(IMGDIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.log('corpus missing: run scripts/gen-image-corpus.js'); process.exitCode = 1; return; }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`Content-dependence study (${mode.name}, CLEAN channel, demod=${QUALITY}, B=${B}, delta=${DELTA})`);
  console.log(`${manifest.length} corpus images\n`);

  const rows = [];
  for (const m of manifest) {
    const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, m.file)));
    const img = fitToMode(png, mode.width, mode.height);
    const f = Object.assign(features(img), headroomFeatures(img, B, DELTA));

    const cap = PayloadQIM.capacity(img, { blockSize: B });
    const rnd = mulberry32(9000 + m.key.charCodeAt(1));
    const bits = new Uint8Array(cap.bits);
    for (let i = 0; i < bits.length; i++) bits[i] = rnd() < 0.5 ? 0 : 1;

    const emb = PayloadQIM.embed(img, bits, { blockSize: B, delta: DELTA });
    const tl = Timeline.build(emb.imageData, mode);
    const samples = Synth.synthesize(tl, SR).samples;
    const parsed = Wav.parse(Wav.encode(samples, SR).buffer.slice(0));
    const res = await Dec.decode(parsed.samples, parsed.sampleRate, { quality: QUALITY, yieldFn: () => Promise.resolve() });
    if (!res.ok) { console.log(`  ${m.key}: demod failed (${res.stage})`); continue; }
    const ex = PayloadQIM.extract(res.imageData, bits.length, { blockSize: B, delta: DELTA });
    const b = ber(bits, ex.bits);
    const ur = emb.unreachable / (Math.floor(img.width / B) * img.height);

    /*
     * B2: can the RECEIVER independently find the blocks that could not be written?
     *
     * The encoder knows emb.erasures exactly, but the receiver only has the demodulated
     * image. If a receiver-side rule agrees closely with the encoder's set, those bits can
     * be handed to RS as ERASURES - which does NOT change the block<->bit mapping and so
     * cannot desynchronise the stream. (Skipping/reallocating blocks would shift every
     * later bit on a single disagreement, which is why that design was rejected.)
     *
     * The rule tested here is structural: a block whose received dynamic range nearly
     * fills 0..255 has almost no room to move its mean, so its parity is essentially
     * whatever the content happened to be.
     */
    const recvPerLine = Math.floor(res.imageData.width / B);
    let agree = 0, encOnly = 0, recvOnly = 0;
    for (let line = 0; line < res.imageData.height; line++) {
      for (let blk = 0; blk < recvPerLine; blk++) {
        const idx = line * recvPerLine + blk;
        let mn = 255, mx = 0;
        for (let k = 0; k < B; k++) {
          const v = res.imageData.data[((line * res.imageData.width + blk * B + k) << 2) + 1];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const recvBad = (mx - mn) > (255 - DELTA - 24);   // margin below the hard limit
        const encBad = !!emb.erasures[idx];
        if (recvBad && encBad) agree++;
        else if (encBad) encOnly++;
        else if (recvBad) recvOnly++;
      }
    }
    const nEnc = agree + encOnly;
    const recvAgreement = nEnc ? agree / nEnc : 1;
    const recvPrecision = (agree + recvOnly) ? agree / (agree + recvOnly) : 1;

    rows.push(Object.assign({
      key: m.key, cls: m.cls, ber: b, unreachableFrac: ur,
      recvAgreement, recvPrecision, nEncBad: nEnc
    }, f));
    process.stdout.write(`  ${m.key} BER=${b.toExponential(2)} gradX=${f.F1_gradX.toFixed(2)} unreach=${(100 * ur).toFixed(2)}% recvAgree=${(100 * recvAgreement).toFixed(0)}%\n`);
  }

  // ---------------- per-class table ----------------
  console.log('\n=== class vs BER (clean channel, B=16, delta=12) ===');
  console.log('| cls | source | n | BER median | BER min | BER max | gradX | hfRatio | noHeadroom | unreachable |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  const classes = [...new Set(rows.map((r) => r.cls))].sort();
  const byClass = {};
  for (const c of classes) {
    const arr = rows.filter((r) => r.cls === c);
    byClass[c] = arr;
    const bers = arr.map((r) => r.ber).sort((a, b) => a - b);
    const med = bers[Math.floor(bers.length / 2)];
    const avg = (k) => arr.reduce((a, r) => a + r[k], 0) / arr.length;
    console.log(`| ${c} | ${CLASS_LABEL[c]} | ${arr.length} | ${med.toExponential(2)} | ` +
      `${bers[0].toExponential(2)} | ${bers[bers.length - 1].toExponential(2)} | ${avg('F1_gradX').toFixed(2)} | ` +
      `${avg('F3_hfRatio').toFixed(4)} | ${(100 * avg('H1_noHeadroomFrac')).toFixed(1)}% | ${(100 * avg('unreachableFrac')).toFixed(1)}% |`);
  }

  // ---------------- feature ranking ----------------
  const feats = ['F1_gradX', 'F2_gradXY', 'F3_hfRatio', 'F4_edgeDensity', 'F5_localRange',
                 'H1_noHeadroomFrac', 'H2_meanBlockRange', 'unreachableFrac'];
  const rho = feats.map((f) => ({ f, rho: spearman(rows.map((r) => r[f]), rows.map((r) => Math.log10(r.ber + 1e-9))) }))
    .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  console.log('\n=== predictor ranking (Spearman vs log10 BER over all images) ===');
  for (const r of rho) console.log(`  ${r.f.padEnd(20)} rho = ${r.rho.toFixed(3)}`);
  const best = rho[0].f;
  console.log(`  -> best single predictor: ${best}`);

  // ---------------- threshold + held-out validation ----------------
  let thr = -Infinity;
  for (const r of rows) if (r.ber <= P_TARGET) thr = Math.max(thr, r[best]);
  const thrM = thr === -Infinity ? Infinity : thr * 0.8;
  let fitRows = [], testRows = [];
  for (const c of classes) { testRows = testRows.concat(byClass[c].slice(0, 2)); fitRows = fitRows.concat(byClass[c].slice(2)); }
  const evalThr = (set) => {
    let fp = 0, fn = 0, n = 0;
    for (const r of set) {
      const predBad = r[best] > thrM, actBad = r.ber > P_TARGET;
      if (predBad && !actBad) fp++;
      if (!predBad && actBad) fn++;
      n++;
    }
    return { fp, fn, wrong: fp + fn, n };
  };
  const fit = evalThr(fitRows), test = evalThr(testRows);
  const nEncTot = rows.reduce((a, r) => a + r.nEncBad, 0);
  const wAgree = rows.reduce((a, r) => a + r.recvAgreement * r.nEncBad, 0);
  const recvAgreeAll = nEncTot ? 100 * wAgree / nEncTot : 100;
  console.log('\n=== receiver-side structural erasure (B2) ===');
  console.log(`  encoder-bad blocks across the corpus: ${nEncTot}`);
  console.log(`  receiver rule agreement with the encoder set: ${recvAgreeAll.toFixed(1)}%`);
  console.log('  (erasures do not move the block<->bit mapping, so agreement does not have to');
  console.log('   be perfect for safety - only for RS to gain anything)');
  console.log('\n=== user-operable threshold ===');
  console.log(`  target raw BER <= ${P_TARGET.toExponential(2)} (RS(255,223) byte budget with margin)`);
  console.log(`  rule: warn when ${best} > ${thrM.toFixed(4)}  (20% margin below the last passing image)`);
  console.log(`  fit set  (${fit.n}): wrong=${fit.wrong} (FP=${fit.fp}, FN=${fit.fn})`);
  console.log(`  held-out (${test.n}): wrong=${test.wrong} (FP=${test.fp}, FN=${test.fn})`);
  const missed = testRows.filter((r) => r[best] <= thrM && r.ber > P_TARGET);
  if (missed.length) {
    console.log('  MISSED FAILURES (would have been sent silently):');
    for (const r of missed) console.log(`    ${r.key} BER=${r.ber.toExponential(2)} ${best}=${r[best].toFixed(4)}`);
  }
  const cGH = spearman(rows.map((r) => r.H1_noHeadroomFrac), rows.map((r) => r.F1_gradX));
  console.log(`\n  headroom-vs-gradient Spearman = ${cGH.toFixed(3)} (how entangled the two mechanisms are)`);

  fs.writeFileSync(path.join(OUT, 'eval-content.json'), JSON.stringify({
    mode: MODE_ID, quality: QUALITY, B, delta: DELTA, pTarget: P_TARGET,
    rho, best, threshold: thrM, rows, fit, test
  }, null, 2));
  console.log(`\n-> ${path.relative(ROOT, path.join(OUT, 'eval-content.json'))}`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
