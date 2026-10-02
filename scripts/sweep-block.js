/*
 * Phase-3 block-size sweep.
 *
 * Answers: can the "block size B" lever alone rescue mild and severe, and what is the
 * smallest reliable B? Also reports goodput (payload x frame success), which - not
 * "smallest reliable B" - is the right objective, because capacity falls linearly in B.
 *
 * Two tiers, deliberately, because BER and frame success need very different amounts of
 * repetition:
 *
 *   Tier A  BER(pre-FEC) is a RATE over ~5120 carrier bits, so ONE run per cell already
 *           gives a precise estimate. 6 B x 4 channels = 24 runs.
 *   Tier B  a frame is 0/1, so frame success MUST be repeated. 8 independent noise seeds
 *           per cell -> resolution 12.5 percentage points.
 *
 * The carrier BER is measured over a FULL-carrier pseudo-random bit stream, so it is
 * independent of framing, RS and payload size and therefore comparable across B.
 *
 * Usage:
 *   node scripts/sweep-block.js                 # Tier A only (~4 min, standard demod)
 *   node scripts/sweep-block.js --tierB         # + Tier B  (~12 min)
 *   node scripts/sweep-block.js --tierB --tierBChannels mild,severe
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
      ChannelSim = globalThis.ChannelSim, PayloadQIM = globalThis.PayloadQIM,
      Pipeline = globalThis.PayloadPipeline;
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;

const SR = 48000;
const MODE_ID = 'M1';
const QUALITY = 'standard';   // never 'fast': measured 26x worse carrier BER
const DELTA = 12;             // phase-2 measured optimum
const PARITY_FRACTION = 0.125;
const B_LIST = [16, 32, 48, 64, 96, 128];
const TIER_B = process.argv.includes('--tierB');
const TIER_B_SEEDS = 8;
const TIER_B_CHANNELS = (() => {
  const i = process.argv.indexOf('--tierBChannels');
  return i >= 0 ? process.argv[i + 1].split(',') : ['mild', 'severe'];
})();

const mode = Modes.get(MODE_ID);
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
function loadPhoto() {
  const p = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
}
function imgPsnr(a, b, channels) {
  let se = 0, n = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    for (const off of (channels || [0, 1, 2])) { const d = a.data[p * 4 + off] - b.data[p * 4 + off]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
function ber(a, b) {
  let e = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) e++;
  return n ? e / n : 1;
}
function byteErr(a, b) {
  let e = 0;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) e++;
  return b.length ? e / b.length : 1;
}

/** One full audio-chain pass: embed -> SSTV encode -> channel -> demodulate. */
async function passThrough(embImage, channelOpts) {
  const tl = Timeline.build(embImage, mode);
  const clean = Synth.synthesize(tl, SR).samples;
  const degraded = ChannelSim.apply(clean, channelOpts);
  const parsed = Wav.parse(Wav.encode(degraded, SR).buffer.slice(0));
  return Dec.decode(parsed.samples, parsed.sampleRate, { quality: QUALITY, yieldFn: () => Promise.resolve() });
}

(async function main() {
  const src = loadPhoto();
  const presets = ChannelSim.presets();
  const t0 = Date.now();

  // ---------------------------------------------------------------- Tier A
  console.log(`Phase-3 block-size sweep  (${mode.name}, demod=${QUALITY}, delta=${DELTA})`);
  console.log('Tier A: BER over the FULL carrier (framing-independent), plus capacity and image PSNR\n');

  const rows = [];
  for (const B of B_LIST) {
    const cfg = { blockSize: B, delta: DELTA, parityFraction: PARITY_FRACTION, codewordLength: 'auto', interleaveDepth: 32 };
    const cap = Pipeline.capacity(src, cfg);

    // carrier BER: one pseudo-random bit per carrier block, no framing at all
    const qimCap = PayloadQIM.capacity(src, { blockSize: B });
    const rnd = mulberry32(4242 + B);
    const carrierBits = new Uint8Array(qimCap.bits);
    for (let i = 0; i < carrierBits.length; i++) carrierBits[i] = rnd() < 0.5 ? 0 : 1;
    const carEmb = PayloadQIM.embed(src, carrierBits, { blockSize: B, delta: DELTA });
    const embedPenaltyAll = imgPsnr(carEmb.imageData, src);
    const embedPenaltyG = imgPsnr(carEmb.imageData, src, [1]);

    // a real framed payload for the capacity/PSNR rows (max size that fits)
    const payloadBytes = Math.max(0, Math.min(cap.payloadBytes, 256));
    const payload = new Uint8Array(payloadBytes);
    for (let i = 0; i < payloadBytes; i++) payload[i] = (i * 29 + B) & 255;
    const framed = payloadBytes > 0 ? Pipeline.embedPayload(src, payload, cfg) : { ok: false };
    const framedPenalty = framed.ok ? imgPsnr(framed.imageData, src) : null;

    for (const preset of presets) {
      const res = await passThrough(carEmb.imageData, preset.options);
      if (!res.ok) {
        console.log(`  B=${String(B).padStart(3)} ${preset.name.padEnd(9)} demod FAILED (${res.stage})`);
        rows.push({ B, channel: preset.name, failed: res.stage, carrierBytes: cap.carrierBytes, payloadBytes: cap.payloadBytes });
        continue;
      }
      const ex = PayloadQIM.extract(res.imageData, carrierBits.length, { blockSize: B, delta: DELTA });
      const b = ber(carrierBits, ex.bits);
      const erased = ex.erasures.reduce((a, v) => a + v, 0) / carrierBits.length;
      const analogPsnr = imgPsnr(res.imageData, src);
      const row = {
        B, channel: preset.name, ber: b, bitErasureRate: erased,
        carrierBytes: cap.carrierBytes, payloadBytes: cap.payloadBytes,
        codewordLength: cap.codewordLength, nsym: cap.rs ? cap.rs.nsym : 0, codewords: cap.codewords,
        analogPsnr, embedPenaltyAll, embedPenaltyG,
        framedPayloadBytes: framed.ok ? payloadBytes : 0, framedPenalty
      };
      rows.push(row);
      const byteErrEst = 1 - Math.pow(1 - b, 8);
      const margin = cap.rs ? (2 * FECRS.maxErrors(cap.rs.nsym)) / 255 : 0;
      console.log(`  B=${String(B).padStart(3)} ${preset.name.padEnd(9)} carrier=${String(cap.carrierBytes).padStart(3)}B ` +
        `payload=${String(cap.payloadBytes).padStart(3)}B (n=${String(cap.codewordLength).padStart(3)},nsym=${String(cap.rs ? cap.rs.nsym : 0).padStart(2)}) ` +
        `BER=${b.toExponential(2)} byteErr~${(100 * byteErrEst).toFixed(1)}% eras=${(100 * erased).toFixed(1)}% ` +
        `analog=${analogPsnr.toFixed(2)}dB embedPenalty=${embedPenaltyAll.toFixed(2)}dB`);
    }
    console.log('');
  }

  // ---------------------------------------------------------------- Tier B
  const tierB = [];
  if (TIER_B) {
    console.log(`Tier B: frame success over ${TIER_B_SEEDS} independent noise seeds` +
      ` (channels: ${TIER_B_CHANNELS.join(', ')})\n`);
    for (const B of B_LIST) {
      for (const chName of TIER_B_CHANNELS) {
        const preset = presets.filter((p) => p.name === chName)[0];
        for (const withFec of [false, true]) {
          const cfg = {
            blockSize: B, delta: DELTA,
            parityFraction: withFec ? PARITY_FRACTION : 0,
            nsym: withFec ? undefined : 0,
            codewordLength: withFec ? 'auto' : (B >= 48 ? 'auto' : 255),
            interleaveDepth: 32
          };
          const cap = Pipeline.capacity(src, cfg);
          if (cap.payloadBytes < 8) {
            console.log(`  B=${B} ${chName} FEC=${withFec ? 'on' : 'off'}: no capacity, skipped`);
            tierB.push({ B, channel: chName, fec: withFec, payloadBytes: cap.payloadBytes, skipped: true });
            continue;
          }
          const payload = new Uint8Array(Math.min(cap.payloadBytes, 48));
          const seedRnd = mulberry32(777 + B);
          for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(seedRnd() * 256);

          let okFrames = 0, okCodewords = 0, totalCodewords = 0, byteOkSum = 0;
          for (let s = 0; s < TIER_B_SEEDS; s++) {
            const opts = Object.assign({}, preset.options, { seed: 1000 + s * 37 });
            const emb = Pipeline.embedPayload(src, payload, cfg);
            if (!emb.ok) break;
            const res = await passThrough(emb.imageData, opts);
            if (!res.ok) continue;
            const ex = Pipeline.extractPayload(res.imageData, cfg, emb.meta.codedBytes);
            if (ex.ok && byteErr(ex.payload, payload) === 0) okFrames++;
            if (ex.stats) {
              okCodewords += ex.stats.codewordsOk;
              totalCodewords += ex.stats.codewords;
            }
            let be = 0;
            const be32 = ex.bestEffort;
            if (be32 && be32.length > Pipeline.HEADER_BYTES) {
              for (let i = 0; i < payload.length && Pipeline.HEADER_BYTES + i < be32.length; i++) {
                if (be32[Pipeline.HEADER_BYTES + i] !== payload[i]) be++;
              }
            } else be = payload.length;
            byteOkSum += 1 - be / payload.length;
          }
          const fsr = okFrames / TIER_B_SEEDS;
          const rec = {
            B, channel: chName, fec: withFec, seeds: TIER_B_SEEDS,
            frameSuccess: fsr, payloadBytes: cap.payloadBytes,
            goodputBytes: fsr * cap.payloadBytes,
            meanByteAccuracy: byteOkSum / TIER_B_SEEDS,
            codewordSuccess: totalCodewords ? okCodewords / totalCodewords : 0,
            codewordLength: cap.codewordLength, nsym: cap.rs ? cap.rs.nsym : 0,
            analogPsnr: null
          };
          tierB.push(rec);
          console.log(`  B=${String(B).padStart(3)} ${chName.padEnd(9)} FEC=${(withFec ? 'on ' : 'off').padEnd(3)} ` +
            `frameSuccess=${(100 * fsr).toFixed(0)}% (${okFrames}/${TIER_B_SEEDS}) ` +
            `payload=${String(cap.payloadBytes).padStart(3)}B goodput=${rec.goodputBytes.toFixed(1)}B ` +
            `cwOk=${(100 * rec.codewordSuccess).toFixed(0)}% byteAcc=${(100 * rec.meanByteAccuracy).toFixed(1)}%`);
        }
      }
      console.log('');
    }
  }

  // ---------------------------------------------------------------- tables
  console.log('=== Tier A table: 6 block sizes x 4 channels ===');
  console.log('| B | 信道 | 载波(B) | 载荷(B) | 码长/校验 | BER(前FEC) | 估算字节错 | 擦除率 | 模拟图PSNR | 嵌入代价 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    if (r.failed) { console.log(`| ${r.B} | ${r.channel} | ${r.carrierBytes} | ${r.payloadBytes} | - | 解调失败 | - | - | - | - |`); continue; }
    const byteErrEst = 1 - Math.pow(1 - r.ber, 8);
    console.log(`| ${r.B} | ${r.channel} | ${r.carrierBytes} | ${r.payloadBytes} | n=${r.codewordLength}/nsym=${r.nsym} | ` +
      `${r.ber.toExponential(2)} | ${(100 * byteErrEst).toFixed(1)}% | ${(100 * r.bitErasureRate).toFixed(1)}% | ` +
      `${r.analogPsnr.toFixed(2)} dB | ${r.embedPenaltyAll.toFixed(2)} dB |`);
  }

  if (tierB.length) {
    console.log('\n=== Tier B table: frame success (8 seeds) ===');
    console.log('| B | 信道 | FEC | 帧成功率 | 载荷(B) | goodput(B) | 码字成功率 | 字节正确率 |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const r of tierB) {
      if (r.skipped) { console.log(`| ${r.B} | ${r.channel} | ${r.fec ? 'on' : 'off'} | 容量不足 | ${r.payloadBytes} | - | - | - |`); continue; }
      console.log(`| ${r.B} | ${r.channel} | ${r.fec ? '开' : '关'} | ${(100 * r.frameSuccess).toFixed(0)}% | ${r.payloadBytes} | ` +
        `${r.goodputBytes.toFixed(1)} | ${(100 * r.codewordSuccess).toFixed(0)}% | ${(100 * r.meanByteAccuracy).toFixed(1)}% |`);
    }
  }

  fs.writeFileSync(path.join(OUT, 'sweep-block.json'), JSON.stringify({ quality: QUALITY, delta: DELTA, rows, tierB }, null, 2));
  console.log(`\n${rows.length} Tier A runs${tierB.length ? ' + ' + tierB.length + ' Tier B cells' : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`-> ${path.relative(ROOT, path.join(OUT, 'sweep-block.json'))}`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
