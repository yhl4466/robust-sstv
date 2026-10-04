/*
 * Design question before wiring in: does the existing gentle denoiser ADD anything on top of outlier
 * recovery, or is it redundant?
 *
 * The decoder already has a gated selective-median stage (phase 49) whose job is the same family of work.
 * Both were measured separately:
 *
 *   gentle (existing, tDiff 1.0 sigma / tGrad 0.5 sigma, gate 9.72):
 *     real recording  sigma_flat 15.16 -> 10.08 (-33%) but sigma_HF 24.03 -> 22.99 (-4%)
 *   outlier recovery (k = 3.0, would need a stricter gate):
 *     real recording  sigma_HF 24.03 -> 13.31 (-45%) and chroma 57.2 -> 34.6 (-40%)
 *
 * The gentle stage barely moves sigma_HF, which is the quantity that describes the speckle actually
 * visible in the picture, so the new one is clearly the stronger tool. The question is only whether
 * stacking them helps or whether the gentle pass should be skipped when the strong one runs.
 *
 * Measured here for four orders on the real recording and on the truth-known controls, because the
 * synthetic PSNR cost is what decides the routing and it cannot be reasoned about.
 *
 * Usage: node tests/recover-routing.js
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
const Channel = require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

const PPROC = Decode._internal.postprocess;
const measureFlatNoise = PPROC.measureFlatNoise;

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}

/**
 * Outlier recovery, written here for the routing experiment; the production copy lands in sstv-decode.js.
 * A pixel is replaced by its 3x3 median when it departs from that median by more than k * sigma, with
 * sigma being the image's own flat-region noise measurement.
 */
function recoverOutliers(img, sigma, k) {
  const w = img.width, h = img.height, src = img.data;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  const thr = k * sigma;
  const win = new Float64Array(9);
  let touched = 0;
  for (let c = 0; c < 3; c++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          win[n++] = src[((y + dy) * w + (x + dx)) * 4 + c];
        }
        for (let a = 1; a < n; a++) {
          const key = win[a]; let b = a - 1;
          while (b >= 0 && win[b] > key) { win[b + 1] = win[b]; b--; }
          win[b + 1] = key;
        }
        const med = win[n >> 1];
        const i = (y * w + x) * 4 + c;
        if (Math.abs(src[i] - med) > thr) { out[i] = med; touched++; }
      }
    }
  }
  return { width: w, height: h, data: out, touched: touched, total: w * h * 3 };
}

function sdGRof(img) {
  const d = img.data;
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { const t = d[i + 1] - d[i]; s += t; s2 += t * t; n++; }
  return Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cases = [];
  const buf = fs.readFileSync(path.join(OUT, 'acoustic-real-48k-mono.wav'));
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const rr = await Decode.decode(info.samples, info.sampleRate,
    { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  cases.push({ label: '真机录音', img: rr.imageData, truth: null });

  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const src = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(src, Modes.get('S1')), SR).samples;
  for (const [label, sig] of [['合成 clean', clean],
                              ['合成 AWGN 20', Channel.Channel.awgn(clean, 20, 12345)],
                              ['合成 AWGN 10', Channel.Channel.awgn(clean, 10, 12345)]]) {
    const r = await Decode.decode(sig, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
    cases.push({ label: label, img: r.imageData, truth: src, base: psnr(r.imageData.data, src.data) });
  }
  for (const c of cases) c.noise = measureFlatNoise(c.img);

  const orders = [
    { label: '都不做', steps: [] },
    { label: '只温和', steps: ['gentle'] },
    { label: '只离群 k=3', steps: ['strong3'] },
    { label: '只离群 k=2', steps: ['strong2'] },
    { label: '温和→离群 k=3', steps: ['gentle', 'strong3'] },
    { label: '离群 k=3→温和', steps: ['strong3', 'gentle'] },
    { label: '离群 k=2→温和', steps: ['strong2', 'gentle'] }
  ];

  console.log('=== 离群恢复与温和降噪的组合顺序 ===\n');
  console.log('  顺序                  用例        σ_flat→        σ_HF→        色度σ→        PSNR(损)');
  const table = [];
  for (const o of orders) {
    const row = { label: o.label, cells: [] };
    for (const c of cases) {
      let img = c.img, sigma = c.noise.sigmaFlat;
      for (const st of o.steps) {
        if (st === 'gentle') img = PPROC.selectiveDenoise(img, sigma, 1.0, 0.5);
        if (st === 'strong3') img = recoverOutliers(img, sigma, 3.0);
        if (st === 'strong2') img = recoverOutliers(img, sigma, 2.0);
      }
      const n2 = measureFlatNoise(img);
      const p = c.truth ? psnr(img.data, c.truth.data) : null;
      row.cells.push({ label: c.label, sigmaFlat: n2.sigmaFlat, sigmaHF: n2.sigmaHF,
        sdGR: sdGRof(img), psnr: p, dPsnr: p == null ? null : p - c.base });
      console.log('  ' + o.label.padEnd(20) + ' ' + c.label.padEnd(12) +
        c.noise.sigmaFlat.toFixed(2).padStart(6) + '→' + n2.sigmaFlat.toFixed(2).padStart(6) + '  ' +
        c.noise.sigmaHF.toFixed(2).padStart(6) + '→' + n2.sigmaHF.toFixed(2).padStart(6) + '  ' +
        sdGRof(c.img).toFixed(1).padStart(5) + '→' + sdGRof(img).toFixed(1).padStart(5) + '  ' +
        (p == null ? '   --' : p.toFixed(2).padStart(7) + ' (' + (p - c.base >= 0 ? '+' : '') + (p - c.base).toFixed(2) + ')'));
    }
    table.push(row);
  }

  fs.writeFileSync(path.join(OUT, 'recover-routing.json'), JSON.stringify(table, null, 2));
  console.log('\n证据 -> tests/diag-quality/recover-routing.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
