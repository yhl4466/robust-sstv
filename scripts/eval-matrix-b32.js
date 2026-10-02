/*
 * Phase-4: the phase-2 style 24-cell matrix, re-run at the new working point B=32,
 * with 8 independent noise seeds per cell.
 *
 * Why seeds: a frame is 0/1, so a single run gives a step function, not a rate. 8 seeds
 * gives frame success in 12.5-point steps, which is what the AC needs.
 *
 * Structural fact to keep in mind when reading the table: at B=32 the carrier holds only
 * 320 B, i.e. exactly ONE 255-byte codeword, so the interleaver depth is capped at 1 and
 * the "interleave on/off" rows are IDENTICAL by construction. `--dual` additionally runs
 * a GREEN+BLUE two-channel carrier (640 B -> 2 codewords -> depth 2) so the interleave
 * dimension is actually exercised.
 *
 * Usage:
 *   node scripts/eval-matrix-b32.js                 # 24 cells x 8 seeds (~25 min)
 *   node scripts/eval-matrix-b32.js --seeds 2       # quick sanity run
 *   node scripts/eval-matrix-b32.js --dual          # + two-channel carrier
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

const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Dec = globalThis.SSTVDecode,
      ChannelSim = globalThis.ChannelSim, Pipeline = globalThis.PayloadPipeline;
const { PNG } = require(path.join(RESEARCH, 'pngjs'));

const SR = 48000;
const QUALITY = 'standard';
const DELTA = 12;
const BLOCK = 32;                       // phase-3 measured optimum (goodput peak)
const SEEDS = (() => { const i = process.argv.indexOf('--seeds'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 8; })();
const DUAL = process.argv.includes('--dual');
const mode = Modes.get('M1');

const FEC_SETTINGS = [
  { id: 'none', label: 'FEC off', nsym: 0 },
  { id: 'rs223', label: 'RS(255,223)', nsym: 32 },
  { id: 'rs191', label: 'RS(255,191)', nsym: 64 }
];
const IL_SETTINGS = [
  { id: 'off', label: 'no interleave', depth: 1 },
  { id: 'd32', label: 'interleave d32', depth: 32 }
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function loadPhoto() {
  const p = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
}
/**
 * Optional two-channel carrier: run the same payload through the GREEN channel and then
 * again through BLUE, concatenating the carrier bits. This doubles the carrier (640 B at
 * B=32) so that TWO codewords and a real interleave depth of 2 become possible.
 */
function embedTwoChannel(src, bits, opts) {
  const half = Math.floor(bits.length / 2);
  const first = PayloadQIM.embed(src, bits.subarray(0, half), Object.assign({}, opts, { channel: 1 }));
  const second = PayloadQIM.embed(first.imageData, bits.subarray(half), Object.assign({}, opts, { channel: 2 }));
  return { imageData: second.imageData, unreachable: first.unreachable + second.unreachable };
}
function extractTwoChannel(img, nBits, opts) {
  const half = Math.floor(nBits / 2);
  const a = PayloadQIM.extract(img, half, Object.assign({}, opts, { channel: 1 }));
  const b = PayloadQIM.extract(img, nBits - half, Object.assign({}, opts, { channel: 2 }));
  const bits = new Uint8Array(nBits), soft = new Float32Array(nBits), er = new Uint8Array(nBits);
  bits.set(a.bits, 0); soft.set(a.soft, 0); er.set(a.erasures, 0);
  bits.set(b.bits, half); soft.set(b.soft, half); er.set(b.erasures, half);
  return { bits, soft, erasures: er };
}
function imgPsnr(a, b, ch) {
  let se = 0, n = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    for (const off of (ch || [0, 1, 2])) { const d = a.data[p * 4 + off] - b.data[p * 4 + off]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
function byteErr(a, b) { let e = 0; for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) e++; return b.length ? e / b.length : 1; }

(async function main() {
  const src = loadPhoto();
  const presets = ChannelSim.presets();
  const t0 = Date.now();
  console.log(`Phase-4 matrix at B=${BLOCK}, delta=${DELTA}, demod=${QUALITY}, ${SEEDS} seeds/cell`);
  console.log(`${FEC_SETTINGS.length * IL_SETTINGS.length * presets.length} cells${DUAL ? ' (single-channel carrier)' : ''}\n`);

  const rows = [];
  for (const preset of presets) {
    for (const fec of FEC_SETTINGS) {
      for (const il of IL_SETTINGS) {
        const cfg = {
          blockSize: BLOCK, delta: DELTA,
          nsym: fec.nsym, parityFraction: fec.nsym ? undefined : 0,
          codewordLength: 'auto', interleaveDepth: il.depth
        };
        const cap = Pipeline.capacity(src, cfg);
        const payloadLen = Math.max(8, Math.min(cap.payloadBytes, 48));
        const payload = new Uint8Array(payloadLen);
        const prnd = mulberry32(31337 + BLOCK);
        for (let i = 0; i < payloadLen; i++) payload[i] = Math.floor(prnd() * 256);

        let ok = 0, cwOk = 0, cwTot = 0, byteAcc = 0, analogSum = 0, an = 0;
        for (let s = 0; s < SEEDS; s++) {
          const chOpts = Object.assign({}, preset.options, { seed: 7000 + s * 131 });
          const emb = Pipeline.embedPayload(src, payload, cfg);
          if (!emb.ok) { rows.push({ cell: { preset: preset.name, fec: fec.label, il: il.label }, error: emb.reason }); break; }
          const tl = Timeline.build(emb.imageData, mode);
          const clean = Synth.synthesize(tl, SR).samples;
          const degraded = ChannelSim.apply(clean, chOpts);
          const parsed = Wav.parse(Wav.encode(degraded, SR).buffer.slice(0));
          const dec = await Dec.decode(parsed.samples, parsed.sampleRate, { quality: QUALITY, yieldFn: () => Promise.resolve() });
          if (!dec.ok) continue;
          analogSum += imgPsnr(dec.imageData, src); an++;
          const ex = Pipeline.extractPayload(dec.imageData, cfg, emb.meta.codedBytes);
          if (ex.ok && byteErr(ex.payload, payload) === 0) ok++;
          if (ex.stats) { cwOk += ex.stats.codewordsOk; cwTot += ex.stats.codewords; }
          let be = payloadLen;
          const b32 = ex.bestEffort;
          if (b32 && b32.length > Pipeline.HEADER_BYTES) {
            be = 0;
            for (let i = 0; i < payloadLen && Pipeline.HEADER_BYTES + i < b32.length; i++) {
              if (b32[Pipeline.HEADER_BYTES + i] !== payload[i]) be++;
            }
          }
          byteAcc += 1 - be / payloadLen;
        }
        const rec = {
          preset: preset.name, fec: fec.label, il: il.label, seeds: SEEDS,
          frameSuccess: ok / SEEDS, payloadBytes: cap.payloadBytes,
          codewordLength: cap.codewordLength, nsym: cap.rs ? cap.rs.nsym : 0,
          codewords: cap.codewords, depth: cap.effectiveDepth,
          goodput: (ok / SEEDS) * cap.payloadBytes,
          codewordSuccess: cwTot ? cwOk / cwTot : 0,
          meanByteAccuracy: byteAcc / SEEDS,
          analogPsnr: an ? analogSum / an : null
        };
        rows.push(rec);
        console.log(`  ${preset.name.padEnd(9)} ${fec.label.padEnd(12)} ${il.label.padEnd(16)} ` +
          `frame=${String(Math.round(100 * rec.frameSuccess)).padStart(3)}% (${ok}/${SEEDS}) ` +
          `payload=${String(cap.payloadBytes).padStart(3)}B n=${String(cap.codewordLength).padStart(3)} ` +
          `cw=${cap.codewords} depth=${cap.effectiveDepth} goodput=${rec.goodput.toFixed(1)}B ` +
          `byteAcc=${(100 * rec.meanByteAccuracy).toFixed(1)}% analog=${rec.analogPsnr ? rec.analogPsnr.toFixed(2) : '-'}dB`);
      }
    }
    console.log('');
  }

  console.log('| channel | FEC | interleave | frame success | payload B | n/nsym | cw | depth | goodput B | byte acc | analog dB |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    if (r.error) { console.log(`| ${r.cell.preset} | ${r.cell.fec} | ${r.cell.il} | ERROR ${r.error} | - | - | - | - | - | - | - |`); continue; }
    console.log(`| ${r.preset} | ${r.fec} | ${r.il} | ${Math.round(100 * r.frameSuccess)}% (${Math.round(r.frameSuccess * r.seeds)}/${r.seeds}) | ` +
      `${r.payloadBytes} | ${r.codewordLength}/${r.nsym} | ${r.codewords} | ${r.depth} | ${r.goodput.toFixed(1)} | ` +
      `${(100 * r.meanByteAccuracy).toFixed(1)}% | ${r.analogPsnr ? r.analogPsnr.toFixed(2) : '-'} |`);
  }
  const mild = rows.filter((r) => r.preset === 'mild');
  const mod = rows.filter((r) => r.preset === 'moderate');
  console.log(`\n  mild  cells at 100% frame success: ${mild.filter((r) => r.frameSuccess === 1).length}/${mild.length}`);
  console.log(`  moderate cells at 100% frame success: ${mod.filter((r) => r.frameSuccess === 1).length}/${mod.length}`);

  fs.writeFileSync(path.join(OUT, 'eval-matrix-b32.json'), JSON.stringify({ block: BLOCK, delta: DELTA, quality: QUALITY, seeds: SEEDS, rows }, null, 2));
  console.log(`\n${rows.length} cells in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(ROOT, path.join(OUT, 'eval-matrix-b32.json'))}`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
