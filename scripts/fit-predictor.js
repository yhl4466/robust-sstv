/*
 * Fit the user-operable reliability predictor from the measured content corpus.
 *
 * Single-feature models are not enough: class D (cartoon) has only ~5% un-embeddable
 * blocks yet the worst BER of any class (~1.6e-1), because its MODIFIABLE blocks are also
 * hard - large saturated flats next to hard outlines, which the pixel-window low-pass
 * then mixes together. So the model is fitted with two terms (unreachable fraction and
 * horizontal high-frequency energy) and the fit quality is reported, not assumed.
 *
 * Prints the coefficients as a ready-to-paste JS snippet for the web panel, which cannot
 * fetch a JSON file on file://.
 *
 * Usage: node scripts/fit-predictor.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'eval-content.json'), 'utf8'));
const rows = data.rows;

/** Ordinary least squares with an intercept. */
function ols(X, y) {
  const n = X.length, p = X[0].length + 1;
  const A = X.map((r) => [1].concat(r));
  // normal equations: (A'A) b = A'y
  const AtA = Array.from({ length: p }, () => new Array(p).fill(0));
  const Aty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Aty[a] += A[i][a] * y[i];
      for (let b = 0; b < p; b++) AtA[a][b] += A[i][a] * A[i][b];
    }
  }
  // gaussian elimination with partial pivoting
  const M = AtA.map((r, i) => r.concat(Aty[i]));
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    const t = M[c]; M[c] = M[piv]; M[piv] = t;
    const d = M[c][c] || 1e-12;
    for (let k = c; k <= p; k++) M[c][k] /= d;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r) => r[p]);
}

const feats = [
  ['unreachableFrac', (r) => r.unreachableFrac],
  ['F3_hfRatio', (r) => r.F3_hfRatio],
  ['F1_gradX', (r) => r.F1_gradX],
  ['F4_edgeDensity', (r) => r.F4_edgeDensity],
  ['H1_noHeadroomFrac', (r) => r.H1_noHeadroomFrac]
];

function fitAndScore(use) {
  const y = rows.map((r) => Math.log10(Math.max(r.ber, 1e-6)));
  const raw = rows.map((r) => use.map(([n, f]) => f(r)));
  /*
   * Standardise before solving. The candidate features differ in magnitude by ~100x
   * (hfRatio ~1e-2, gradX ~1e1), which made the normal equations ill-conditioned and
   * produced NaN coefficients for every multi-feature model. Standardising fixes the
   * conditioning; the panel applies the same centring/scaling.
   */
  const p = use.length;
  const mean = new Array(p).fill(0), std = new Array(p).fill(0);
  for (let k = 0; k < p; k++) {
    mean[k] = raw.reduce((a, r) => a + r[k], 0) / raw.length;
    std[k] = Math.sqrt(raw.reduce((a, r) => a + (r[k] - mean[k]) ** 2, 0) / raw.length) || 1;
  }
  const X = raw.map((r) => r.map((v, k) => (v - mean[k]) / std[k]));
  const b = ols(X, y);
  let sse = 0, sst = 0;
  const my = y.reduce((a, v) => a + v, 0) / y.length;
  const preds = rows.map((r, i) => {
    let v = b[0];
    for (let k = 0; k < p; k++) v += b[k + 1] * X[i][k];
    sse += (v - y[i]) ** 2;
    sst += (y[i] - my) ** 2;
    return v;
  });
  let within = 0;
  rows.forEach((r, i) => {
    const ratio = Math.log10(Math.max(Math.pow(10, preds[i]), 1e-9) / Math.max(r.ber, 1e-9));
    if (Math.abs(ratio) <= 0.5) within++;
  });
  return { b, mean, std, scale: use.map(([n]) => n), r2: 1 - sse / sst, within: within / rows.length, preds };
}

console.log(`Fitting on ${rows.length} corpus images (clean channel, B=${data.B}, delta=${data.delta})\n`);
const results = [];
for (const use of [[feats[0]], [feats[1]], [feats[0], feats[1]], [feats[0], feats[1], feats[2]], feats]) {
  const label = use.map(([n]) => n).join(' + ');
  const r = fitAndScore(use);
  results.push({ label, ...r });
  console.log(`  log10(BER) ~ ${label.padEnd(42)} R2=${r.r2.toFixed(3)}  within 0.5 decade=${(100 * r.within).toFixed(0)}%`);
}
results.sort((a, b) => b.r2 - a.r2);
const best = results[0];
console.log(`\n  -> best: ${best.label}  R2=${best.r2.toFixed(3)}, ${(100 * best.within).toFixed(0)}% of images predicted within half a decade`);

const use = best.label.split(' + ');
const b = best.b;
console.log('\n  coefficients (log10 BER = c0 + sum ci*fi):');
console.log(`    c0 = ${b[0].toFixed(6)}`);
use.forEach((n, i) => console.log(`    ${n}: ${b[i + 1].toFixed(6)}`));

console.log('\n  --- paste into js/app.js ---');
console.log('  // standardised features: z_k = (f_k - mean_k) / std_k');
console.log(`  var PREDICT = {`);
/*
 * Prefer the simplest model within ~0.08 R2 of the best: with only 60 samples a
 * 5-parameter fit is not meaningfully better than a 2-3 parameter one, and generalises
 * worse. The panel therefore uses the compact model.
 */
const bestR2 = results[0].r2;
const chosen = results.slice()
  .sort((a, b) => a.label.split(' + ').length - b.label.split(' + ').length)
  .find((r) => r.r2 >= bestR2 - 0.08 && r.label.split(' + ').length <= 2) || results[0];
console.log(`    // chosen: ${chosen.label}  (in-sample R2=${chosen.r2.toFixed(3)}, ` +
  `${(100 * chosen.within).toFixed(0)}% of images within half a decade)`);
console.log(`    intercept: ${chosen.b[0].toFixed(6)},`);
chosen.scale.forEach((n, i) => {
  console.log(`    '${n}': { coef: ${chosen.b[i + 1].toFixed(6)}, mean: ${chosen.mean[i].toFixed(9)}, std: ${chosen.std[i].toFixed(9)} },`);
});
console.log(`    r2: ${chosen.r2.toFixed(3)}, within: ${chosen.within.toFixed(3)}, nFeatures: ${chosen.scale.length}`);
console.log(`  };`);

// where the model says the payload stops being safe
const TARGET = data.pTarget;
console.log(`\n  RS-safe threshold in the model: BER <= ${TARGET.toExponential(2)} (byte budget with margin)`);
const predFrac = best.preds.filter((p) => Math.pow(10, p) <= TARGET).length / best.preds.length;
console.log(`  fraction of the corpus the model would clear: ${(100 * predFrac).toFixed(0)}%`);

fs.writeFileSync(path.join(__dirname, 'out', 'predictor-fit.json'), JSON.stringify({
  target: TARGET, chosen: best.label, coefficients: b, r2: best.r2, within: best.within,
  allModels: results.map((r) => ({ label: r.label, r2: r.r2, within: r.within }))
}, null, 2));
console.log(`\n-> ${path.relative(ROOT, path.join(__dirname, 'out', 'predictor-fit.json'))}`);
