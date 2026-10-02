/*
 * Phase-5 end-to-end: hide a secret image in an SSTV carrier, push it through a channel,
 * and recover BOTH images (AC3/AC4/AC5/AC6).
 *
 * Uses the REAL image frame (~180-200 B payload), not a toy 48-byte load: the B=32 working
 * point had only ever been measured with 48-byte payloads, and a longer payload gives the RS
 * codeword more chances to exceed its budget. Whatever comes out is reported as measured.
 *
 * Usage:
 *   node scripts/e2e-image-hide.js                 # clean + mild, 8 seeds for mild
 *   node scripts/e2e-image-hide.js --seeds 4
 *   node scripts/e2e-image-hide.js --channels clean,mild,moderate,severe
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
require(path.join(ROOT, 'js', 'channel-sim.js'));
require(path.join(ROOT, 'js', 'payload-qim.js'));
require(path.join(ROOT, 'js', 'fec-rs.js'));
require(path.join(ROOT, 'js', 'interleaver.js'));
require(path.join(ROOT, 'js', 'payload-pipeline.js'));
require(path.join(ROOT, 'js', 'image-codec.js'));

const Codec = require(path.join(ROOT, 'js', 'image-codec.js'));
const Embed = require(path.join(ROOT, 'js', 'image-embed.js'));
const Extract = require(path.join(ROOT, 'js', 'image-extract.js'));
const Wav = globalThis.SSTVWav, ChannelSim = globalThis.ChannelSim, Modes = globalThis.SSTVModes;
const { PNG } = require(path.join(RESEARCH, 'pngjs'));

const SR = 48000;
const SEEDS = (() => { const i = process.argv.indexOf('--seeds'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 8; })();
const CHANNELS = (() => {
  const i = process.argv.indexOf('--channels');
  return i >= 0 ? process.argv[i + 1].split(',') : ['clean', 'mild'];
})();
const mode = Modes.get('M1');
fs.mkdirSync(OUT, { recursive: true });

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function imgPsnr(a, b, ch) {
  let se = 0, n = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    for (const off of (ch || [0, 1, 2])) { const d = a.data[p * 4 + off] - b.data[p * 4 + off]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
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
      const s = (sy * png.width + sx) << 2, d = ((y + dy) * width + (x + dx)) << 2;
      out[d] = png.data[s]; out[d + 1] = png.data[s + 1]; out[d + 2] = png.data[s + 2]; out[d + 3] = 255;
    }
  }
  return { data: out, width, height };
}
/** Synthetic photo-like secret (independent of the carrier so the test is not self-referential). */
function makeSecret(w, h, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  const d = new Uint8ClampedArray(w * h * 4);
  const f = new Float64Array(w * h);
  for (let k = 0; k < 22; k++) {
    const cx = rnd() * w, cy = rnd() * h, rad = Math.max(3, (0.12 + rnd() * 0.4) * Math.max(w, h)), amp = (rnd() - 0.5) * 200;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dd = Math.hypot(x - cx, y - cy);
      if (dd < rad) f[y * w + x] += amp * (1 - dd / rad);
    }
  }
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(128 + f[i] + (rnd() - 0.5) * 8)));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  return { data: d, width: w, height: h };
}
function grayExact(a, b) {
  if (!a || !b || a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}
/**
 * Compare the recovered secret image against the transmitted grey plane.
 *
 * The recoverer returns RGBA (so it can be drawn straight onto a canvas) while the preview
 * is a single-channel grey plane, so the two cannot be compared byte-for-byte - the first
 * version of this script did exactly that and reported 0% even though the frame decoded
 * perfectly. Compare the red channel of the RGBA against the grey plane instead.
 */
function secretMatches(rgba, grayPlane) {
  if (!rgba || !grayPlane) return false;
  const n = grayPlane.data.length;
  if (rgba.data.length !== n * 4) return false;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    if (rgba.data[o] !== grayPlane.data[i]) return false;
    if (rgba.data[o + 1] !== grayPlane.data[i]) return false;
    if (rgba.data[o + 2] !== grayPlane.data[i]) return false;
  }
  return true;
}
function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** Write an RGBA raster as a greyscale PNG for visual inspection. */
function saveGray(file, img) {
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.width * img.height; i++) {
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = img.data[i * 4];
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

(async function main() {
  const photo = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const carrier = fitToMode(photo, mode.width, mode.height);
  const secret = makeSecret(256, 256, 20250501);
  const presets = ChannelSim.presets();
  const t0 = Date.now();

  console.log('Phase-5 end-to-end: secret image hiding');
  console.log(`  carrier ${mode.name} ${mode.width}x${mode.height} | secret ${secret.width}x${secret.height}`);
  console.log(`  channels: ${CHANNELS.join(', ')} | mild seeds: ${SEEDS}\n`);

  // ---------- AC3: encoder integration ----------
  const emb = Embed.embedImage(carrier, secret, { mode: 'M1' });
  if (!emb.ok) { console.log('ENCODER FAILED: ' + emb.reason); process.exitCode = 1; return; }
  const info = emb.embeddedInfo;
  console.log('=== AC3 transmitter ===');
  console.log(`  secret ${info.secretSourceSize.W}x${info.secretSourceSize.H} -> ${info.secretFinalSize.W}x${info.secretFinalSize.H}` +
    ` | ${info.bpp}bpp ${info.levels} levels | dither ${info.dither}`);
  console.log(`  data ${info.secretDataBytes} B + header ${Codec.HEADER_BYTES} B = frame ${info.frameBytes} B / payload ${info.capacity} B` +
    ` | autoScaled ${info.autoResized}`);
  console.log(`  reconstruction PSNR ${info.reconstructionPsnr.toFixed(2)} dB | codewords ${info.codewords} (n=${info.codewordLength}, nsym=${info.nsym}, depth=${info.depth})`);
  console.log(`  timeline ${info.duration.toFixed(2)} s | preprocess ${info.preprocessMs} ms, payload ${info.encodeMs} ms, synth ${info.synthMs} ms`);
  const wav = Wav.encode(emb.audioSamples, SR);
  console.log(`  WAV ${(wav.length / 1048576).toFixed(2)} MB, ${emb.audioSamples.length} samples`);

  // save artefacts for the report
  saveGray(path.join(OUT, 'e2e-secret-source.png'), secret);
  saveGray(path.join(OUT, 'e2e-secret-preview.png'), info.secretPreview);
  fs.writeFileSync(path.join(OUT, 'e2e-carrier-clean.png'), PNG.sync.write(
    (function () { const p = new PNG({ width: carrier.width, height: carrier.height }); p.data = Buffer.from(carrier.data); return p; })()));

  // ---------- AC4/AC5/AC6: per-channel recovery ----------
  const rows = [];
  for (const chName of CHANNELS) {
    const preset = presets.filter((p) => p.name === chName)[0];
    const seeds = chName === 'clean' ? 1 : SEEDS;
    let okSeeds = 0, publicSum = 0, secretExact = 0;
    let lastSecret = null, lastPublic = null, lastMeta = null;
    for (let s = 0; s < seeds; s++) {
      const chOpts = Object.assign({}, preset.options, seeds > 1 ? { seed: 4000 + s * 97 } : {});
      const degraded = ChannelSim.apply(emb.audioSamples, chOpts);
      const parsed = Wav.parse(Wav.encode(degraded, SR).buffer.slice(0));
      const res = await Extract.extractImage(parsed.samples, parsed.sampleRate, {
        yieldFn: () => Promise.resolve()
      });
      if (!res.publicImage) continue;
      publicSum += imgPsnr(res.publicImage, carrier);
      if (res.secretImageNative) { lastSecret = res.secretImageNative; lastMeta = res.secretMeta; }
      lastPublic = res.publicImage;
      const exact = res.secretImageNative && secretMatches(res.secretImageNative, info.secretPreview);
      if (exact) { okSeeds++; secretExact++; }
    }
    const row = {
      channel: chName, seeds,
      secretExactRate: okSeeds / seeds,
      publicPsnr: publicSum / seeds,
      secretMeta: lastMeta
    };
    rows.push(row);
    console.log(`\n=== ${chName} (${seeds} seed${seeds > 1 ? 's' : ''}) ===`);
    console.log(`  public image PSNR      : ${row.publicPsnr.toFixed(2)} dB`);
    console.log(`  secret image exact     : ${okSeeds}/${seeds} (${(100 * row.secretExactRate).toFixed(0)}%)`);
    if (lastMeta) {
      console.log(`  secret meta            : ${lastMeta.success ? lastMeta.W + 'x' + lastMeta.H + ' ' + lastMeta.bpp + 'bpp ' + lastMeta.dataBytes + ' B' : 'FAILED - ' + lastMeta.reason}`);
    }
    if (lastSecret) saveGray(path.join(OUT, `e2e-secret-recovered-${chName}.png`), lastSecret);
    if (lastPublic) {
      const p = new PNG({ width: lastPublic.width, height: lastPublic.height });
      p.data = Buffer.from(lastPublic.data);
      fs.writeFileSync(path.join(OUT, `e2e-public-recovered-${chName}.png`), PNG.sync.write(p));
    }
  }

  // ---------- degradation comparison (AC6 requirement) ----------
  console.log('\n=== degradation options if a channel fails ===');
  const degradations = [
    { label: 'baseline B=32 RS(255,223)', opts: {} },
    { label: 'B=48 RS(255,223)', opts: { blockSize: 48 } },
    { label: 'B=64 RS(255,223)', opts: { blockSize: 64 } },
    { label: 'B=32 no FEC (245 B payload)', opts: { nsym: 0 } }
  ];
  for (const d of degradations) {
    const e2 = Embed.embedImage(carrier, secret, Object.assign({ mode: 'M1' }, d.opts));
    if (!e2.ok) { console.log(`  ${d.label.padEnd(30)} -> encoder refused: ${e2.reason.slice(0, 60)}`); continue; }
    /*
     * The receiver MUST be told the same carrier geometry the transmitter used. Omitting
     * this made B=48 and B=64 look like total failures even on a clean channel, because the
     * extractor silently assumed the B=32 defaults - a test bug, not a codec result.
     */
    const rxGeometry = {
      blockSize: e2.embeddedInfo.blockSize,
      delta: e2.embeddedInfo.delta,
      nsym: e2.embeddedInfo.nsym,
      interleaveDepth: 32
    };
    const line = [];
    for (const chName of CHANNELS) {
      const preset = presets.filter((p) => p.name === chName)[0];
      const seeds = chName === 'clean' ? 1 : Math.min(4, SEEDS);
      let okN = 0, psnrSum = 0;
      for (let s = 0; s < seeds; s++) {
        const chOpts = Object.assign({}, preset.options, seeds > 1 ? { seed: 4000 + s * 97 } : {});
        const deg = ChannelSim.apply(e2.audioSamples, chOpts);
        const pr = Wav.parse(Wav.encode(deg, SR).buffer.slice(0));
        const res = await Extract.extractImage(pr.samples, pr.sampleRate,
          Object.assign({ yieldFn: () => Promise.resolve() }, rxGeometry));
        if (res.publicImage) psnrSum += imgPsnr(res.publicImage, carrier);
        if (res.secretImageNative && secretMatches(res.secretImageNative, e2.embeddedInfo.secretPreview)) okN++;
      }
      line.push(`${chName} ${(100 * okN / seeds).toFixed(0)}% (${okN}/${seeds}) pub ${(psnrSum / seeds).toFixed(1)}dB`);
    }
    const e2i = e2.embeddedInfo;
    console.log(`  ${d.label.padEnd(30)} frame=${String(e2i.frameBytes).padStart(3)}B data=${String(e2i.secretDataBytes).padStart(3)}B ` +
      `size=${e2i.secretFinalSize.W}x${e2i.secretFinalSize.H}@${e2i.bpp}bpp | ` + line.join(' | '));
  }

  const summary = {
    mode: 'M1', blockSize: 32, delta: 12, nsym: 32, seeds: SEEDS,
    secret: { source: '256x256 synthetic', final: info.secretFinalSize, bpp: info.bpp, dataBytes: info.secretDataBytes, frameBytes: info.frameBytes, reconPsnr: info.reconstructionPsnr },
    rows
  };
  fs.writeFileSync(path.join(OUT, 'e2e-image-hide.json'), JSON.stringify(summary, null, 2));
  console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(ROOT, path.join(OUT, 'e2e-image-hide.json'))}`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
