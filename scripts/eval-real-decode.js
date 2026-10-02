/*
 * Phase-6: decode evaluation on real / realistic SSTV audio.
 *
 * For every sample in tests/fixtures/real/manifest.json this runs the decoder under several
 * calibration configurations and records both reference-based and NO-REFERENCE quality.
 *
 * Reference PSNR only exists when a sample ships with its source image; every real
 * off-air recording lacks one, so the study also reports metrics that need no reference:
 *
 *   sigmaHF        high-pass residual RMS of the decoded image (grey levels). For an
 *                  analogue scan this is the noise floor: lower is better.
 *   lag1           lag-1 horizontal correlation. Together with sigmaHF it separates
 *                  "blurred/structured" degradation from "noisy" degradation.
 *   inBandSnrDb    from the AUDIO: power inside 1050-2450 Hz (where SSTV puts all of its
 *                  information) versus outside it. A hum/noise-robust SNR proxy that needs
 *                  no clean reference.
 *   mislockedLines lines whose sync search snapped off the fitted line - the quantitative
 *                  evidence for the "sync mis-lock" failure mode.
 *
 * Usage: node scripts/eval-real-decode.js [--only id1,id2] [--quick]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'out');
const MANIFEST = path.join(ROOT, 'tests', 'fixtures', 'real', 'manifest.json');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Wav = globalThis.SSTVWav, Dec = globalThis.SSTVDecode, FFT = globalThis.FFT;
const { PNG } = require(path.join(RESEARCH, 'pngjs'));

fs.mkdirSync(OUT, { recursive: true });

/** The five calibration configurations that make the AFC/clock contribution measurable. */
const CONFIGS = [
  { key: 'raw', label: 'AFC off + clock off', opts: { afc: false, clockRecovery: false } },
  { key: 'offset', label: 'offset only', opts: { afc: 'offset', clockRecovery: false } },
  { key: 'twoPoint', label: 'two-point freq', opts: { afc: 'twoPoint', clockRecovery: false } },
  { key: 'twoPoint+clk', label: 'two-point + clock', opts: { afc: 'twoPoint', clockRecovery: true } },
  { key: 'affine-noClk', label: 'affine, no clock', opts: { afc: 'affine', clockRecovery: false } },
  { key: 'affine', label: 'affine + clock (default)', opts: { afc: 'affine', clockRecovery: true } }
];

// ------------------------------------------------------------------ no-reference metrics
function toGrayPlane(imageData) {
  const n = imageData.width * imageData.height, g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    g[i] = 0.299 * imageData.data[o] + 0.587 * imageData.data[o + 1] + 0.114 * imageData.data[o + 2];
  }
  return { g, w: imageData.width, h: imageData.height };
}
/**
 * High-pass residual RMS. For white noise of standard deviation s, the residual of
 * v - mean(4-neighbours) has variance 1.25 s^2, so the estimate is divided by sqrt(1.25).
 */
function sigmaHF(plane) {
  const { g, w, h } = plane;
  let acc = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const mean = (g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) / 4;
      const r = g[i] - mean;
      acc += r * r; n++;
    }
  }
  return Math.sqrt(acc / n / 1.25);
}
function lag1(plane) {
  const { g, w, h } = plane;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const a = g[y * w + x], b = g[y * w + x + 1];
      sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b; n++;
    }
  }
  const cov = sxy / n - (sx / n) * (sy / n);
  const sd = Math.sqrt((sxx / n - (sx / n) ** 2) * (syy / n - (sy / n) ** 2));
  return sd ? cov / sd : 0;
}
/**
 * In-band SNR proxy measured on the AUDIO, needs no reference image.
 *
 * Signal band = 1150-2350 Hz (SSTV puts everything between 1200 and 2300 Hz).
 * Noise band  = 300-1000 Hz and 2600-3400 Hz, where a clean SSTV signal has essentially
 * nothing. The ratio must be of POWER SPECTRAL DENSITY, not of total power: the two bands
 * have different widths, and an earlier version compared raw sums, which biased the number
 * by the bandwidth ratio.
 */
function inBandSnr(samples, sampleRate) {
  const N = 4096;
  if (samples.length < N * 2) return null;
  const nyq = sampleRate * 0.48;
  const fft = new FFT(N);
  const out = fft.createComplexArray();
  const input = fft.createComplexArray();
  const power = new Float64Array(N / 2);
  const windows = Math.min(24, Math.floor(samples.length / N));
  let used = 0;
  for (let wi = 0; wi < windows; wi++) {
    const off = Math.floor(wi * (samples.length - N) / Math.max(1, windows - 1));
    for (let i = 0; i < N; i++) {
      const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));   // Hann
      input[2 * i] = samples[off + i] * win;
      input[2 * i + 1] = 0;
    }
    fft.transform(out, input);
    for (let k = 0; k < N / 2; k++) power[k] += out[2 * k] * out[2 * k] + out[2 * k + 1] * out[2 * k + 1];
    used++;
  }
  const binHz = sampleRate / N;
  let sigSum = 0, sigN = 0, noiseSum = 0, noiseN = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = k * binHz;
    if (f > nyq) break;
    if (f >= 1150 && f <= 2350) { sigSum += power[k]; sigN++; }
    else if ((f >= 300 && f <= 1000) || (f >= 2600 && f <= 3400)) { noiseSum += power[k]; noiseN++; }
  }
  if (!sigN || !noiseN || noiseSum <= 0) return null;
  const sigPsd = sigSum / sigN, noisePsd = noiseSum / noiseN;
  return {
    snrDb: 10 * Math.log10(sigPsd / noisePsd),
    signalPsd: sigPsd, noisePsd: noisePsd, windows: used,
    noiseBandHz: sampleRate > 7000 ? '300-1000 + 2600-3400' : '300-1000'
  };
}
function psnr(img, ref) {
  if (!img || !ref || img.width !== ref.width || img.height !== ref.height) return null;
  let se = 0, n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    for (const o of [0, 1, 2]) { const d = img.data[i * 4 + o] - ref.data[i * 4 + o]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
function savePng(file, imageData) {
  const p = new PNG({ width: imageData.width, height: imageData.height });
  p.data = Buffer.from(imageData.data);
  fs.writeFileSync(file, PNG.sync.write(p));
}

(async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg >= 0 ? process.argv[onlyArg + 1].split(',') : null;
  const samples = manifest.samples.filter((s) => !only || only.indexOf(s.id) >= 0);
  const t0 = Date.now();

  console.log('Phase-6 decode evaluation on real / realistic SSTV audio');
  console.log(`${samples.length} sample(s), ${CONFIGS.length} calibration configs each\n`);

  const results = [];
  for (const s of samples) {
    // manifest paths are repo-root relative, so they must be resolved against ROOT and not
    // against the process working directory
    const file = path.resolve(ROOT, s.file);
    if (!fs.existsSync(file)) { console.log(`SKIP ${s.id}: file not found (${file})`); continue; }
    const parsed = Wav.parse(fs.readFileSync(file).buffer.slice(0));
    const snr = inBandSnr(parsed.samples, parsed.sampleRate);

    let ref = null;
    if (s.reference && fs.existsSync(path.resolve(ROOT, s.reference))) {
      const rp = PNG.sync.read(fs.readFileSync(path.resolve(ROOT, s.reference)));
      ref = { data: new Uint8ClampedArray(rp.data), width: rp.width, height: rp.height };
    }

    console.log(`=== ${s.id}  [${s.kind}]  ${path.basename(file)}`);
    console.log(`    ${parsed.sampleRate} Hz · ${parsed.channels}ch · ${parsed.duration.toFixed(2)} s · ` +
      `in-band SNR proxy ${snr ? snr.snrDb.toFixed(1) + ' dB' : 'n/a'}` +
      (ref ? ` · reference ${ref.width}x${ref.height}` : ' · no reference image'));
    console.log(`    source: ${s.source}`);
    console.log('    | config | result | mode/VIS | a | b(Hz) | clock | syncs | mislock | sigmaHF | lag1 | PSNR | ms |');
    console.log('    |---|---|---|---|---|---|---|---|---|---|---|---|');

    for (const c of CONFIGS) {
      const st = Date.now();
      let res = null, err = null;
      try {
        res = await Dec.decode(parsed.samples, parsed.sampleRate,
          Object.assign({ quality: 'standard', yieldFn: () => Promise.resolve() }, c.opts));
      } catch (e) { err = e.message || String(e); }
      const ms = Date.now() - st;

      if (!res || !res.ok) {
        const stage = res ? res.stage : 'exception';
        const msg = (res && (res.message || res.reason)) || err || '';
        console.log(`    | ${c.label} | **FAIL** (${stage}) | - | - | - | - | - | - | - | - | - | ${ms} |`);
        results.push({ id: s.id, kind: s.kind, config: c.key, ok: false, stage, message: String(msg).slice(0, 120), ms });
        continue;
      }
      const cal = res.calibration || {};
      const plane = toGrayPlane(res.imageData);
      const shf = sigmaHF(plane), l1 = lag1(plane);
      const p = psnr(res.imageData, ref);
      console.log(`    | ${c.label} | OK | ${res.mode.id}/VIS${res.vis} | ${cal.scale.toFixed(5)} | ` +
        `${cal.offsetHz.toFixed(2)} | ${cal.clockScale != null ? cal.clockScale.toFixed(5) : '-'} | ` +
        `${cal.observations || '-'} | ${cal.mislockedLines != null ? cal.mislockedLines : '-'} | ` +
        `${shf.toFixed(2)} | ${l1.toFixed(3)} | ${p != null ? p.toFixed(2) + ' dB' : '-'} | ${ms} |`);
      savePng(path.join(OUT, `real-${s.id}-${c.key}.png`), res.imageData);
      results.push({
        id: s.id, kind: s.kind, config: c.key, ok: true, mode: res.mode.id, vis: res.vis,
        a: cal.scale, b: cal.offsetHz, clockScale: cal.clockScale, source: cal.source,
        syncs: cal.observations, residualRms: cal.syncResidualRms, residualMax: cal.syncResidualMax,
        mislockedLines: cal.mislockedLines, sigmaHF: shf, lag1: l1, psnr: p, ms,
        inBandSnrDb: snr ? snr.snrDb : null,
        truncated: (res.warnings || []).some((w) => /音频结束/.test(w)),
        warnings: (res.warnings || []).slice(0, 3)
      });
    }

    // ---------- AFC / clock contribution summary for this sample ----------
    const byKey = {};
    for (const r of results.filter((x) => x.id === s.id)) byKey[r.config] = r;
    const get = (k) => byKey[k];
    const okOf = (k) => (get(k) && get(k).ok);
    console.log('    AFC/clock contribution:');
    console.log(`      raw -> two-point      : ${okOf('raw') ? 'ok' : 'FAIL'} -> ${okOf('twoPoint') ? 'ok' : 'FAIL'}` +
      (okOf('raw') && okOf('twoPoint') ? `   sigmaHF ${get('raw').sigmaHF.toFixed(2)} -> ${get('twoPoint').sigmaHF.toFixed(2)}` : ''));
    console.log(`      two-point -> +clock   : ${okOf('twoPoint') ? 'ok' : 'FAIL'} -> ${okOf('twoPoint+clk') ? 'ok' : 'FAIL'}` +
      (okOf('twoPoint') && okOf('twoPoint+clk') ? `   sigmaHF ${get('twoPoint').sigmaHF.toFixed(2)} -> ${get('twoPoint+clk').sigmaHF.toFixed(2)}` : ''));
    console.log(`      affine no-clock -> affine+clock: ${okOf('affine-noClk') ? 'ok' : 'FAIL'} -> ${okOf('affine') ? 'ok' : 'FAIL'}` +
      (okOf('affine-noClk') && okOf('affine') ? `   sigmaHF ${get('affine-noClk').sigmaHF.toFixed(2)} -> ${get('affine').sigmaHF.toFixed(2)}` : ''));
    if (okOf('raw') && okOf('affine') && get('raw').psnr != null && get('affine').psnr != null) {
      console.log(`      PSNR raw ${get('raw').psnr.toFixed(2)} dB -> default ${get('affine').psnr.toFixed(2)} dB ` +
        `= ${(get('affine').psnr - get('raw').psnr >= 0 ? '+' : '')}${(get('affine').psnr - get('raw').psnr).toFixed(2)} dB`);
    }
    console.log('');
  }

  // ---------- cross-sample summary ----------
  console.log('=== summary by configuration (all samples) ===');
  console.log('| config | OK / total | mean sigmaHF | mean PSNR | mean ms |');
  console.log('|---|---|---|---|---|');
  for (const c of CONFIGS) {
    const rs = results.filter((r) => r.config === c.key);
    const oks = rs.filter((r) => r.ok);
    const m = (f) => {
      const v = oks.map(f).filter((x) => x != null && isFinite(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const shf = m((r) => r.sigmaHF), p = m((r) => r.psnr), ms = m((r) => r.ms);
    console.log(`| ${c.label} | ${oks.length}/${rs.length} | ${shf != null ? shf.toFixed(2) : '-'} | ` +
      `${p != null ? p.toFixed(2) + ' dB' : '-'} | ${ms != null ? ms.toFixed(0) : '-'} |`);
  }

  fs.writeFileSync(path.join(OUT, 'eval-real-decode.json'), JSON.stringify({
    sampleCount: samples.length, configs: CONFIGS.map((c) => ({ key: c.key, label: c.label })), results
  }, null, 2));
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(ROOT, path.join(OUT, 'eval-real-decode.json'))}`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
