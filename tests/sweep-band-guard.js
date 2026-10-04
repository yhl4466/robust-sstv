/*
 * Sweep the LOWER BAND GUARD: how far above the 1500 Hz porch tone the image band's lower edge must stay.
 *
 * WHY THIS AND NOT THE MARGIN
 *   A first sweep moved the band's lower MARGIN (200 Hz down to 0) with the theory that a lower edge near
 *   1300 Hz was letting the 1200 Hz sync leak in. That theory is REFUTED by its own results: shrinking the
 *   margin moved the edge DOWN, which made the asymmetry slightly worse, not better (raw SD at -50 Hz went
 *   50.2 -> 43.3 while +50 Hz stayed at 24), and it made the real recording worse (sigma_HF 24.03 ->
 *   25.74). So the contaminant is not below the band, it is the 1500 Hz PORCH TONE sitting just above the
 *   dark end of the scan.
 *
 *   The scan's darkest legitimate level is 1500 Hz and the porch is also 1500 Hz, so "search down to the
 *   dark end" and "search onto the porch" are the same instruction. The guard resolves it by pushing the
 *   lower edge up to 1500 + G nominal, trading a little of the darkest range for immunity to a tone that
 *   is about 20 dB stronger than scan content.
 *
 * This measures, for each G: the flat-field raw scatter at both signs of a -/+50 Hz error (the asymmetry
 * itself), the PSNR on the truth-known synthetic control (the cost), and the real acoustic recording.
 *
 * Usage: node tests/sweep-band-guard.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const freqShift = new Function('SR',
  SRC.slice(SRC.indexOf('function hilbertFIR'), SRC.indexOf('/** Decoder lock residuals')) +
  '\nreturn freqShift;')(SR);

const MODE = Modes.get('S1');
const FA = Decode._internal.frequencyAxis;

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}
function sd(a) {
  let s = 0, s2 = 0;
  for (const v of a) { s += v; s2 += v * v; }
  const n = a.length, m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}
function flat(level) {
  const w = MODE.width, h = MODE.height;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = level; d[i + 3] = 255; }
  return { data: d, width: w, height: h };
}

/* Async-safe: the guard must stay set until the awaited decode finishes (a synchronous finally restores
 * it the moment the callback returns its promise, which silently makes every row identical). */
async function withGuard(g, fn) {
  const prev = FA.getLowerGuard();
  FA.setLowerGuard(g);
  try { return await fn(); } finally { FA.setLowerGuard(prev); }
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const flatClean = Synth.synthesize(Timeline.build(flat(127), MODE), SR).samples;
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const photo = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const photoClean = Synth.synthesize(Timeline.build(photo, MODE), SR).samples;

  const realPath = path.join(OUT, 'acoustic-real-48k-mono.wav');
  let real = null;
  if (fs.existsSync(realPath)) {
    const b = fs.readFileSync(realPath);
    real = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }

  console.log('=== 图像带下界护栏（相对 1500 Hz porch 音的余量 G）扫描 ===\n');
  console.log('  G=0 为阶段四十九行为（护栏关闭）。带下界 = max(a*1300+b, a*(1500+G)+b)。\n');
  console.log('  G(Hz) |  Δ=−50: 带下界 rawSD 灰度SD 低尾 |  Δ=+50: 带下界 rawSD 灰度SD | 照片PSNR | 真机 σ_HF σ_flat 行相关');
  const guards = [0, 50, 100, 150, 200, 250, 300];
  const rows = [];

  for (const G of guards) {
    const out = await withGuard(G, async () => {
      const o = { flat: {} };
      for (const hz of [-50, 50]) {
        const audit = [];
        const r = await Decode.decode(freqShift(flatClean, hz), SR,
          { quality: 'standard', yieldEvery: 0, postprocess: 'off', auditPixels: audit });
        o.flat[hz] = r.ok ? {
          lo: audit[0].bandLo, rawSd: sd(audit.map((p) => p.raw)), lumSd: sd(audit.map((p) => p.lum)),
          // loop rather than Math.min.apply: 245k arguments blows the JS stack
          rawMin: audit.reduce((m, p) => (p.raw < m ? p.raw : m), Infinity)
        } : null;
      }
      const pr = await Decode.decode(photoClean, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
      o.photo = pr.ok ? psnr(pr.imageData.data, photo.data) : null;
      if (real) {
        const rr = await Decode.decode(real.samples, real.sampleRate,
          { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
        o.real = rr.ok ? rr.calibration.postprocess : null;
        if (rr.ok) {
          // row correlation, the real recording's headline image-likeness number
          const d = rr.imageData.data, W = rr.imageData.width, H = rr.imageData.height;
          let sum = 0, cnt = 0;
          for (let y = 0; y + 1 < H; y++) {
            let ma = 0, mb = 0;
            for (let x = 0; x < W; x++) { ma += d[(y * W + x) * 4 + 1]; mb += d[((y + 1) * W + x) * 4 + 1]; }
            ma /= W; mb /= W;
            let num = 0, da = 0, db = 0;
            for (let x = 0; x < W; x++) {
              const u = d[(y * W + x) * 4 + 1] - ma, v = d[((y + 1) * W + x) * 4 + 1] - mb;
              num += u * v; da += u * u; db += v * v;
            }
            if (da > 0 && db > 0) { sum += num / Math.sqrt(da * db); cnt++; }
          }
          o.rowCorr = cnt ? sum / cnt : null;
        }
      }
      return o;
    });
    const m = out.flat[-50], p = out.flat[50];
    rows.push({ guard: G, m50: m, p50: p, photo: out.photo, real: out.real, rowCorr: out.rowCorr });
    const f = (v, d) => (v == null ? '--' : v.toFixed(d == null ? 1 : d));
    console.log('  ' + String(G).padStart(5) + '  |  ' +
      f(m && m.lo, 0).padStart(6) + ' ' + f(m && m.rawSd, 2).padStart(6) + ' ' +
      f(m && m.lumSd, 2).padStart(6) + ' ' + f(m && m.rawMin, 0).padStart(5) + '  |  ' +
      f(p && p.lo, 0).padStart(6) + ' ' + f(p && p.rawSd, 2).padStart(6) + ' ' +
      f(p && p.lumSd, 2).padStart(6) + '  | ' + f(out.photo, 3).padStart(8) + '  | ' +
      f(out.real && out.real.sigmaHF, 2).padStart(7) + ' ' + f(out.real && out.real.sigmaFlat, 2).padStart(6) + ' ' +
      f(out.rowCorr, 4).padStart(7));
  }

  console.log('\n  --- 判断 ---');
  const base = rows.find((r) => r.guard === 0);
  for (const r of rows) {
    if (!r.m50 || !r.p50) continue;
    const ratio = Math.max(r.m50.rawSd, r.p50.rawSd) / Math.min(r.m50.rawSd, r.p50.rawSd);
    const dPhoto = r.photo == null || base.photo == null ? null : r.photo - base.photo;
    const dCorr = r.rowCorr == null || base.rowCorr == null ? null : r.rowCorr - base.rowCorr;
    const dSd = r.m50.rawSd - base.m50.rawSd;
    console.log('    G=' + String(r.guard).padStart(4) +
      '  ±50 rawSD 比 ' + ratio.toFixed(2) + '（−50 ' + r.m50.rawSd.toFixed(1) + '，较基线 ' +
      (dSd >= 0 ? '+' : '') + dSd.toFixed(1) + '）' +
      '  照片PSNR ' + (dPhoto == null ? '--' : (dPhoto >= 0 ? '+' : '') + dPhoto.toFixed(3)) +
      '  真机行相关 ' + (dCorr == null ? '--' : (dCorr >= 0 ? '+' : '') + dCorr.toFixed(4)));
  }

  fs.writeFileSync(path.join(OUT, 'band-guard-sweep.json'), JSON.stringify(rows, null, 2));
  console.log('\n证据 -> tests/diag-quality/band-guard-sweep.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
