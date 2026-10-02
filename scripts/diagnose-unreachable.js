/*
 * B2 diagnostic: WHERE are the un-embeddable blocks, and WHY?
 *
 * Phase 3 reported ~3.1% un-embeddable blocks and attributed them to the letterbox
 * black bars. That attribution is mechanically suspicious: QIM blocks are HORIZONTAL
 * (1 row x B pixels) while the letterbox is two horizontal bands, so a block can never
 * straddle the boundary. A fully black block also has a full [0,255] achievable mean
 * range, so it should be perfectly embeddable.
 *
 * This script prints the actual row/column distribution of emb.unreachable plus, for a
 * sample of them, min/max/mean and the target the embedder was trying to reach - so the
 * real cause is measured rather than assumed.
 *
 * Usage: node scripts/diagnose-unreachable.js [classLetter]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const IMGDIR = path.join(ROOT, 'tests', 'fixtures', 'images');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'payload-qim.js'));
const Modes = globalThis.SSTVModes, PayloadQIM = globalThis.PayloadQIM;
const { PNG } = require(path.join(RESEARCH, 'pngjs'));

const mode = Modes.get('M1');
const B = 16, DELTA = 12;
const wantClass = process.argv[2] || 'E';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Exactly the fitToMode used by eval-content.js (black letterbox, centered). */
function fitToMode(png, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
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

const manifest = JSON.parse(fs.readFileSync(path.join(IMGDIR, 'manifest.json'), 'utf8'));
const items = manifest.filter((m) => m.cls === wantClass);
console.log(`Unreachable-block diagnostic - class ${wantClass}, ${items.length} images`);
console.log(`mode=${mode.name} (${mode.width}x${mode.height})  B=${B}  delta=${DELTA}\n`);

const perLine = Math.floor(mode.width / B);
const lines = mode.height;

for (const m of items.slice(0, 3)) {
  const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, m.file)));
  const img = fitToMode(png, mode.width, mode.height);
  const bits = new Uint8Array(perLine * lines);
  const rnd = mulberry32(4242);
  for (let i = 0; i < bits.length; i++) bits[i] = rnd() < 0.5 ? 0 : 1;

  const emb = PayloadQIM.embed(img, bits, { blockSize: B, delta: DELTA });
  const total = perLine * lines;

  // which rows / columns hold the un-embeddable blocks?
  const rowHist = new Array(lines).fill(0);
  const colHist = new Array(perLine).fill(0);
  const samples = [];
  let n = 0;
  for (let line = 0; line < lines; line++) {
    for (let blk = 0; blk < perLine; blk++) {
      const idx = line * perLine + blk;
      // emb.erasures is 1 where the embedder could not place the block on its level
      if (!emb.erasures[idx]) continue;
      n++;
      rowHist[line]++; colHist[blk]++;
      if (samples.length < 6) {
        let mn = 255, mx = 0, sum = 0;
        for (let k = 0; k < B; k++) {
          const v = img.data[((line * img.width + blk * B + k) << 2) + 1];
          if (v < mn) mn = v; if (v > mx) mx = v; sum += v;
        }
        const mean = sum / B;
        samples.push({ line, blk, bit: bits[idx], mn, mx, mean: +mean.toFixed(2),
          // achievable mean range has width 255 - (mx - mn)
          headroom: 255 - (mx - mn) });
      }
    }
  }
  const letterboxRows = new Set([...Array(8).keys(), ...Array(8).keys()].map(() => 0)); // placeholder
  let inBlackRows = 0;
  for (let line = 0; line < lines; line++) if (rowHist[line]) {
    // a row is "black letterbox" if every pixel in it is 0
    let allZero = true;
    for (let x = 0; x < img.width; x++) if (img.data[((line * img.width + x) << 2) + 1] !== 0) { allZero = false; break; }
    if (allZero) inBlackRows += rowHist[line];
  }

  console.log(`${m.key}  unreachable ${n}/${total} = ${(100 * n / total).toFixed(2)}%` +
    `   (of which in all-black letterbox rows: ${inBlackRows})`);
  const rowsWith = rowHist.map((v, i) => [i, v]).filter(([, v]) => v > 0);
  console.log(`  rows affected: ${rowsWith.length} distinct` +
    `  first=${rowsWith.length ? rowsWith[0][0] : '-'} last=${rowsWith.length ? rowsWith[rowsWith.length - 1][0] : '-'}`);
  console.log(`  columns affected: ${colHist.filter((v) => v > 0).length}/${perLine}`);
  console.log('  samples (line, blk, bit, min, max, mean, achievable-range-width):');
  for (const s of samples) {
    console.log(`    line=${String(s.line).padStart(3)} blk=${String(s.blk).padStart(2)} bit=${s.bit}` +
      ` min=${String(s.mn).padStart(3)} max=${String(s.mx).padStart(3)} mean=${String(s.mean).padStart(7)}` +
      ` range=${String(255 - s.headroom).padStart(3)} achievableWidth=${String(s.headroom).padStart(3)}`);
  }
  console.log('');
}
