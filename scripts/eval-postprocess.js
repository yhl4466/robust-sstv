/*
 * Phase-6 post-processing evaluation (AC5).
 *
 * Reports BOTH directions, because classic filters always cost something on clean input:
 *   - gain on degraded samples (measured PSNR vs the reference, before -> after)
 *   - loss on the clean sample (the same filters applied to an already-good decode)
 * A report that only showed the gain would be misleading.
 *
 * Also writes side-by-side before/after PNG pairs for visual inspection.
 *
 * Usage: node scripts/eval-postprocess.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'out');
const REALDIR = path.join(ROOT, 'tests', 'fixtures', 'real');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const SSTVWav = globalThis.SSTVWav, Dec = globalThis.SSTVDecode;
const PP = require(path.join(ROOT, 'js', 'image-postprocess.js'));
const { PNG } = require(path.join(RESEARCH, 'pngjs'));

fs.mkdirSync(OUT, { recursive: true });
const REF = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.png');

function psnr(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
  let se = 0, n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    for (const o of [0, 1, 2]) { const d = a.data[i * 4 + o] - b.data[i * 4 + o]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
/** Side-by-side comparison strip: original | filtered. */
function sideBySide(left, right, labelGap) {
  const gap = labelGap == null ? 8 : labelGap;
  const w = left.width + gap + right.width, h = Math.max(left.height, right.height);
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) { png.data[i * 4 + 3] = 255; }
  const put = (img, ox) => {
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const s = (y * img.width + x) << 2, d = (y * w + ox + x) << 2;
        png.data[d] = img.data[s]; png.data[d + 1] = img.data[s + 1];
        png.data[d + 2] = img.data[s + 2]; png.data[d + 3] = 255;
      }
    }
  };
  put(left, 0); put(right, left.width + gap);
  return PNG.sync.write(png);
}

const FILTERS = ['medianH3', 'medianH5', 'medianV3', 'median3x3', 'bilateral', 'medianH3+bilateral'];

(async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REALDIR, 'manifest.json'), 'utf8'));
  const refPng = PNG.sync.read(fs.readFileSync(REF));
  const ref = { data: new Uint8ClampedArray(refPng.data), width: refPng.width, height: refPng.height };

  // a spread of degradation levels, plus the clean case as the control
  const wanted = ['real-npm-8k', 'awgn-20', 'awgn-12', 'awgn-6', 'clip-8x', 'ssb-agc',
                  'acoustic-rt03', 'ssb-qsb-deep', 'combo-hard', 'truncate-8pct'];
  const samples = manifest.samples.filter((s) => wanted.indexOf(s.id) >= 0);
  console.log('Phase-6 post-processing evaluation');
  console.log(`${samples.length} decoded images, ${FILTERS.length} filters each`);
  console.log('PSNR is measured against the transmitted source image (available because every');
  console.log('sample derives from the one real recording that ships with its reference PNG).\n');

  const rows = [];
  const visual = [];
  for (const s of samples) {
    // manifest paths are repo-root relative
    const parsed = SSTVWav.parse(fs.readFileSync(path.resolve(ROOT, s.file)).buffer.slice(0));
    let dec;
    try {
      dec = await Dec.decode(parsed.samples, parsed.sampleRate, { quality: 'standard', yieldFn: () => Promise.resolve() });
    } catch (e) { dec = { ok: false, stage: 'exception' }; }
    if (!dec.ok) { console.log(`SKIP ${s.id}: decode failed at ${dec.stage}`); continue; }

    const base = dec.imageData;
    const st = PP.stats(base);
    const p0 = psnr(base, ref);
    const rec = { id: s.id, group: s.group || 'real', sigmaHF: st.sigmaHF, lag1: st.lag1, psnr0: p0, filters: {} };

    for (const f of FILTERS) {
      const out = PP.apply(base, f);
      const p1 = psnr(out, ref);
      const st1 = PP.stats(out);
      rec.filters[f] = { psnr: p1, sigmaHF: st1.sigmaHF, lag1: st1.lag1, delta: (p1 != null && p0 != null) ? p1 - p0 : null };
    }
    rows.push(rec);
    if (rec.filters['medianH3'] && visual.length < 6) {
      visual.push({ id: s.id, png: sideBySide(base, PP.apply(base, 'medianH3+bilateral')) });
    }
    const sug = PP.suggest(st);
    console.log(`${s.id.padEnd(16)} sigmaHF=${st.sigmaHF.toFixed(1).padStart(5)} lag1=${st.lag1.toFixed(3)} ` +
      `PSNR=${p0 != null ? p0.toFixed(2).padStart(6) : '   -  '} dB | ` +
      FILTERS.map((f) => `${f}:${rec.filters[f].psnr != null ? rec.filters[f].psnr.toFixed(1) : '-'}`).join(' ') +
      `  | suggest: ${sug.filter || 'none'}`);
  }

  // ---------------- tables ----------------
  console.log('\n=== PSNR before -> after, per filter (dB) ===');
  console.log('| sample | group | before | ' + FILTERS.join(' | ') + ' |');
  console.log('|---|---|---|' + FILTERS.map(() => '---').join('|') + '|');
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.group} | ${r.psnr0 != null ? r.psnr0.toFixed(2) : '-'} | ` +
      FILTERS.map((f) => {
        const v = r.filters[f];
        return v.psnr != null ? `${v.psnr.toFixed(2)} (${v.delta >= 0 ? '+' : ''}${v.delta.toFixed(2)})` : '-';
      }).join(' | ') + ' |');
  }

  console.log('\n=== mean delta PSNR by degradation level (positive = filter helped) ===');
  console.log('| sample | mean delta over filters | best filter | best delta |');
  console.log('|---|---|---|---|');
  for (const r of rows) {
    const ds = FILTERS.map((f) => r.filters[f].delta).filter((x) => x != null);
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    let bestF = '-', bestD = -Infinity;
    for (const f of FILTERS) { const d = r.filters[f].delta; if (d != null && d > bestD) { bestD = d; bestF = f; } }
    console.log(`| ${r.id} | ${mean >= 0 ? '+' : ''}${mean.toFixed(2)} dB | ${bestF} | ${bestD >= 0 ? '+' : ''}${bestD.toFixed(2)} dB |`);
  }

  console.log('\n=== sigmaHF before -> after (no-reference check on the same runs) ===');
  console.log('| sample | before | ' + FILTERS.join(' | ') + ' |');
  console.log('|---|---|' + FILTERS.map(() => '---').join('|') + '|');
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.sigmaHF.toFixed(2)} | ` + FILTERS.map((f) => r.filters[f].sigmaHF.toFixed(2)).join(' | ') + ' |');
  }

  // ---------------- visual artefacts ----------------
  for (let i = 0; i < visual.length; i++) {
    const file = path.join(OUT, `postprocess-compare-${visual[i].id}.png`);
    fs.writeFileSync(file, visual[i].png);
  }
  console.log(`\nwrote ${visual.length} side-by-side comparison images (left = decoded, right = medianH3+bilateral):`);
  for (const v of visual) console.log(`  scripts/out/postprocess-compare-${v.id}.png`);

  fs.writeFileSync(path.join(OUT, 'eval-postprocess.json'), JSON.stringify({ filters: FILTERS, rows }, null, 2));
  console.log(`\n-> ${path.relative(ROOT, path.join(OUT, 'eval-postprocess.json'))}`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
