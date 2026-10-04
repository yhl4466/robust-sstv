/*
 * Choose the demo's base clip: does a FULL scan at 8 kHz decode correctly and quickly enough?
 *
 * tests/measure-demo-timing.js showed that a 20 s clip decodes in ~0.6 s, so the earlier assumption that
 * the decode would cost 3-5 s was wrong - the decoder is fast. That changes the design: the demo does not
 * need a truncated clip, and a truncated clip is actively harmful because a partial scan only fills part
 * of the frame, so there would be no full image to compare against.
 *
 * So the demo should use a WHOLE scan, downsampled to 8 kHz to keep the file small, and this checks the
 * two things that decides: that the full-scan 8 kHz decode reaches the known clean PSNR, and that it stays
 * fast. Both are measured, not assumed.
 *
 * Usage: node tests/measure-demo-base.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'demo-audio');
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const PNG = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

/**
 * The demo's fixed test image.
 *
 * The matrix's `--control pattern` (8 saturated colour bars + grey ramp + 8x8 checkerboard) is a good
 * STRESS pattern and a bad DEMO base: measured, every mode decodes it at only ~25 dB even clean
 * (S1 24.81, M1 25.35), which sits exactly on the "usable / degraded" boundary. A demo whose clean
 * reference already reads as marginal has no room to show a ladder descending, and every slider position
 * looks broken.
 *
 * So the demo uses a pattern designed to be REPRESENTABLE by SSTV, while still containing the three
 * things the task asks for - a grey gradient, colour patches, and fine detail:
 *   - grey ramp across the full width (large, smooth, low frequency)
 *   - six colour patches at moderate chroma rather than full saturation, because SSTV's chroma path is
 *     narrowband and full-saturation primaries are the hardest possible content for it
 *   - a checkerboard whose period is ~16 px, i.e. well inside the luma band, rather than 8 px which sits
 *     near the edge
 *
 * The result is validated by decoding, not assumed: the caller prints the clean PSNR and refuses a base
 * that does not clear a usable threshold.
 */
function makeDemoImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  // moderate-chroma patches: (R,G,B) chosen away from the gamut corners
  const patches = [[210, 90, 80], [90, 190, 100], [80, 110, 210],
                   [215, 190, 90], [170, 100, 190], [100, 195, 200]];
  const bandH = Math.round(h * 0.34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r, g, b;
      if (y < bandH) {
        const c = patches[Math.min(patches.length - 1, Math.floor(x / (w / patches.length)))];
        r = c[0]; g = c[1]; b = c[2];
      } else if (y < bandH + (h - bandH) * 0.5) {
        const v = Math.round(255 * x / (w - 1)); r = g = b = v;      // grey ramp
      } else {
        // ~16 px checkerboard: high detail but comfortably inside S1/M1's luma bandwidth
        const v = (((x >> 4) + (y >> 4)) & 1) ? 200 : 60; r = g = b = v;
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data: data, width: w, height: h };
}

function makeTestImage(w, h) { return makeDemoImage(w, h); }

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}

function resampleTo(x, from, to) {
  if (from === to) return x;
  const n = Math.floor(x.length * to / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * from / to;
    const i0 = Math.floor(p), i1 = Math.min(x.length - 1, i0 + 1), f = p - i0;
    out[i] = x[i0] * (1 - f) + x[i1] * f;
  }
  return out;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  /*
   * Pick the mode by MEASUREMENT, not by assumption.
   *
   * The same pattern control decodes at 28.3 dB under Scottie S1 but only 25.35 dB under Martin M1 -
   * measured, and the reason matters for a demo: 25.35 dB sits right on the "usable" boundary, so the
   * clean reference panel would already look marginal and every slider position would read as broken. The
   * demo needs a base whose CLEAN decode is unambiguously good, so the ladder has room to descend.
   */
  const trials = [];
  for (const id of ['S1', 'M1']) {
    const mode = Modes.get(id);
    const img = makeTestImage(mode.width, mode.height);
    const tl = Timeline.build(img, mode);
    const full = Synth.synthesize(tl, 16000).samples;
    const x = resampleTo(full, 16000, 8000);
    const t0 = Date.now();
    const r = await Decode.decode(x, 8000, { quality: 'fast', yieldEvery: 0, postprocess: 'off' });
    const ms = Date.now() - t0;
    const p = r.ok ? psnr(r.imageData.data, img.data) : null;
    trials.push({ id: id, mode: mode, img: img, full: full, x: x, ms: ms, psnr: p, duration: tl.duration });
    console.log(mode.name.padEnd(12) + ' 8000 Hz · fast → ' + String(ms).padStart(5) + ' ms · ' +
      (p == null ? '失败: ' + r.message : 'clean PSNR ' + p.toFixed(2) + ' dB') +
      ' · 时长 ' + tl.duration.toFixed(1) + ' s');
  }

  const ok = trials.filter((t) => t.psnr != null);
  if (!ok.length) throw new Error('两种模式在全长 8 kHz 快速档下都无法解码');
  /*
   * Gate the base on CLEAN USABILITY, not merely on "it decoded". A base that decodes at 24 dB would make
   * every slider position read as broken; the demo needs a reference that is unambiguously good.
   */
  const USE_MIN_DB = 27;
  const usable = ok.filter((t) => t.psnr >= USE_MIN_DB);
  if (!usable.length) {
    console.log('\n没有模式达到 clean ' + USE_MIN_DB + ' dB（最佳 ' +
      Math.max.apply(null, ok.map((t) => t.psnr)).toFixed(2) + ' dB）—— 测试图对 SSTV 太难，需重设计。');
    process.exitCode = 1;
    return;
  }
  // best clean PSNR wins; runtime is secondary because all of these are well inside the budget
  const best = usable.reduce((a, b) => (b.psnr > a.psnr ? b : a));
  console.log('\n选定：' + best.mode.name + '（clean PSNR ' + best.psnr.toFixed(2) + ' dB，' +
    best.ms + ' ms）');

  /*
   * Write the base clip plus the ground-truth raster the demo compares against.
   * 8 kHz 16-bit mono: S1's scan is 110.6 s, i.e. about 1.7 MB - fetchable locally, and it decodes at the
   * full published quality rather than a degraded stand-in.
   */
  const wav = Wav.encode(best.x, 8000);
  const wavPath = path.join(OUT, 'base-' + best.id.toLowerCase() + '-8k.wav');
  fs.writeFileSync(wavPath, Buffer.from(wav));
  console.log('写入 ' + path.relative(ROOT, wavPath).replace(/\\/g, '/') + ' · ' +
    (fs.statSync(wavPath).size / 1024 / 1024).toFixed(2) + ' MB');

  const p = new PNG({ width: best.mode.width, height: best.mode.height });
  p.data = Buffer.from(best.img.data.buffer.slice(0));
  fs.writeFileSync(path.join(OUT, 'truth.png'), PNG.sync.write(p));
  console.log('写入 tests/demo-audio/truth.png');

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    mode: best.id, modeName: best.mode.name, sampleRate: 8000, quality: 'fast',
    audio: 'base-' + best.id.toLowerCase() + '-8k.wav', truth: 'truth.png',
    durationS: best.duration, cleanPsnrDb: Number(best.psnr.toFixed(2)), decodeMs: best.ms,
    trials: trials.map((t) => ({ mode: t.id, sr: 8000, ms: t.ms, psnr: t.psnr == null ? null : Number(t.psnr.toFixed(2)) }))
  }, null, 2));
  console.log('写入 tests/demo-audio/manifest.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
