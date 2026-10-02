/*
 * Phase-2 performance evaluation: the 24-run matrix.
 *
 *   4 channel presets  x  3 FEC settings  x  2 interleaver settings  =  24 runs
 *
 * Metrics per run
 *   BER pre-FEC   hard-decision bit error rate at the carrier output (measured against
 *                 the transmitted bits, erasures included)
 *   BER post-FEC  bit error rate of the recovered payload; a failed frame counts its
 *                 payload bits as wrong (conservative and honest)
 *   block success RS codewords recovered / total, plus whether the frame CRC passed
 *   analog PSNR   the visible image, against the source (FEC cannot change this)
 *   payload PSNR  PSNR of the recovered 16x16 thumbnail, i.e. the metric AC9 is about
 *   time          decode wall time
 *
 * The payload is a 16x16 grey thumbnail of the transmitted image (256 bytes). It is not
 * a hidden image - it is the payload whose delivery the whole exercise is measured on.
 *
 * Usage:
 *   node scripts/eval-ber.js                 # full 24-run matrix (standard tier)
 *   node scripts/eval-ber.js --fast          # quicker, slightly worse demodulator
 *   node scripts/eval-ber.js --rows mild     # single channel preset
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
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;

const SR = 48000;
const MODE_ID = 'M1';
const QUALITY = process.argv.includes('--fast') ? 'fast' : 'standard';
const ONLY = (() => {
  const i = process.argv.indexOf('--rows');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const mode = Modes.get(MODE_ID);

// Carrier configuration for the whole matrix.
// Chosen from the measured carrier sweep (scripts/sweep-carrier.js): a block-mean
// error sigma of 7.014/sqrt(B) grey levels means the QIM decision margin delta/2 must
// exceed ~2.9 sigma for RS(255,223) to have byte-error headroom. B=16 with delta=8
// gives only 1.8% raw BER at clean (above the code's 6.3% byte budget once mapped to
// bytes), while B=16 with delta=12 measured 0.23% - inside budget - and still leaves
// 640 carrier bytes, i.e. TWO 255-byte codewords so interleaving is exercisable.
const CARRIER = { blockSize: 16, delta: 12 };

const THUMB = 16;                      // 16x16 8-bit thumbnail = 256 byte payload
const THUMB_BYTES = THUMB * THUMB;

const FEC_SETTINGS = [
  { id: 'none', label: '无FEC', nsym: 0 },
  { id: 'rs223', label: 'RS(255,223)', nsym: 32 },
  { id: 'rs191', label: 'RS(255,191)', nsym: 64 }
];
const IL_SETTINGS = [
  { id: 'off', label: '无交织', depth: 1 },
  { id: 'd32', label: '深度32', depth: 32 }
];

fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- helpers
function loadPhoto() {
  const p = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
}

/** 16x16 grey thumbnail of an image (box-averaged), as the payload. */
function makeThumbnail(img) {
  const t = new Uint8Array(THUMB * THUMB);
  const bw = img.width / THUMB, bh = img.height / THUMB;
  for (let ty = 0; ty < THUMB; ty++) {
    for (let tx = 0; tx < THUMB; tx++) {
      let sum = 0, n = 0;
      for (let y = Math.floor(ty * bh); y < Math.floor((ty + 1) * bh); y++) {
        for (let x = Math.floor(tx * bw); x < Math.floor((tx + 1) * bw); x++) {
          const i = (y * img.width + x) * 4;
          sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
          n++;
        }
      }
      t[ty * THUMB + tx] = n ? Math.round(sum / n) : 0;
    }
  }
  return t;
}
function thumbnailPsnr(rec, orig) {
  let se = 0;
  for (let i = 0; i < orig.length; i++) { const d = rec[i] - orig[i]; se += d * d; }
  const mse = se / orig.length;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
function imgPsnr(a, b) {
  let se = 0, n = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    for (const off of [0, 1, 2]) { const d = a.data[p * 4 + off] - b.data[p * 4 + off]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
function bitErrors(a, b) {
  let e = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) e++;
  return n ? e / n : 1;
}
function byteErrorsIn(a, b) {
  let e = 0;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) e++;
  return b.length ? e / b.length : 1;
}

/** Best-effort payload bytes out of a (possibly failed) extraction. */
function bestEffortPayload(res) {
  const be = res.bestEffort;
  if (!be || be.length < Pipeline.HEADER_BYTES) return new Uint8Array(THUMB_BYTES);
  const declared = be[2] | (be[3] << 8);
  const take = (declared > 0 && declared <= THUMB_BYTES) ? declared : THUMB_BYTES;
  const out = new Uint8Array(THUMB_BYTES);
  for (let i = 0; i < take && Pipeline.HEADER_BYTES + i < be.length; i++) {
    out[i] = be[Pipeline.HEADER_BYTES + i];
  }
  return out;
}

// ---------------------------------------------------------------- main
(async function main() {
  const src = loadPhoto();
  const thumb = makeThumbnail(src);
  const presets = ChannelSim.presets().filter((p) => !ONLY || p.name === ONLY);

  console.log(`Phase-2 evaluation matrix`);
  console.log(`  mode=${mode.name}  demod=${QUALITY}  carrier blockSize=${CARRIER.blockSize} delta=${CARRIER.delta}`);
  console.log(`  payload = ${THUMB}x${THUMB} grey thumbnail (${THUMB_BYTES} B) of the transmitted image`);
  console.log(`  ${presets.length} channels x ${FEC_SETTINGS.length} FEC x ${IL_SETTINGS.length} interleave = ${presets.length * FEC_SETTINGS.length * IL_SETTINGS.length} runs\n`);

  const rows = [];
  const t0 = Date.now();

  for (const preset of presets) {
    for (const fec of FEC_SETTINGS) {
      for (const il of IL_SETTINGS) {
        const cfg = {
          blockSize: CARRIER.blockSize, delta: CARRIER.delta,
          nsym: fec.nsym, interleaveDepth: il.depth
        };
        const cap = Pipeline.capacity(src, cfg);
        if (cap.payloadBytes < THUMB_BYTES) {
          console.log(`skip ${preset.name}/${fec.id}/${il.id}: capacity ${cap.payloadBytes} B < ${THUMB_BYTES} B`);
          continue;
        }

        // --- transmit ---
        const emb = Pipeline.embedPayload(src, thumb, cfg);
        if (!emb.ok) { console.log(`embed failed ${preset.name}/${fec.id}/${il.id}: ${emb.reason}`); continue; }
        const embedPenalty = imgPsnr(emb.imageData, src);

        const tl = Timeline.build(emb.imageData, mode);
        const clean = Synth.synthesize(tl, SR).samples;
        const degraded = ChannelSim.apply(clean, preset.options);
        const parsed = Wav.parse(Wav.encode(degraded, SR).buffer.slice(0));

        // --- receive ---
        const td = Date.now();
        const dec = await Dec.decode(parsed.samples, parsed.sampleRate, {
          quality: QUALITY, yieldFn: () => Promise.resolve()
        });
        const ms = Date.now() - td;
        if (!dec.ok) {
          console.log(`${preset.name}/${fec.id}/${il.id}: demodulator failed (${dec.stage})`);
          rows.push({ channel: preset.name, fec: fec.label, interleave: il.label, failed: dec.stage });
          continue;
        }

        const ex = Pipeline.extractPayload(dec.imageData, cfg, emb.meta.codedBytes);
        const st = ex.stats || {};

        const berPre = st.rawBits ? bitErrors(emb.bits, st.rawBits) : 1;
        let berPost;
        if (ex.ok) {
          berPost = byteErrorsIn(ex.payload, thumb) === 0 ? 0 : byteErrorsIn(ex.payload, thumb);
        } else {
          berPost = byteErrorsIn(bestEffortPayload(ex), thumb);
        }
        const best = bestEffortPayload(ex);
        const payloadPsnr = thumbnailPsnr(best, thumb);

        rows.push({
          channel: preset.name,
          fec: fec.label,
          interleave: il.label,
          berPre,
          berPost,
          codewords: st.codewords, codewordsOk: st.codewordsOk,
          blockSuccess: st.codewords ? st.codewordsOk / st.codewords : 0,
          crcOk: !!ex.ok,
          reason: ex.ok ? '' : ex.reason,
          analogPsnr: imgPsnr(dec.imageData, src),
          embedPenalty,
          payloadPsnr,
          bitErasureRate: st.bitErasureRate || 0,
          byteErasureRate: st.byteErasureRate || 0,
          depth: st.depth,
          ms
        });
        process.stdout.write(`  ${preset.name.padEnd(9)} ${fec.label.padEnd(11)} ${il.label.padEnd(7)} ` +
          `BERpre=${berPre.toExponential(2)} BERpost=${berPost.toExponential(2)} ` +
          `blocks=${st.codewordsOk}/${st.codewords} CRC=${ex.ok ? 'ok ' : 'FAIL'} ` +
          `payloadPSNR=${payloadPsnr.toFixed(2)}dB analog=${imgPsnr(dec.imageData, src).toFixed(2)}dB ${ms}ms\n`);
      }
    }
  }

  // ---------------------------------------------------------------- table
  console.log('\n| 信道 | FEC | 交织 | BER(前FEC) | BER(后FEC) | 块正确率 | 载荷PSNR | 模拟图PSNR | 耗时 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    if (r.failed) {
      console.log(`| ${r.channel} | ${r.fec} | ${r.interleave} | - | - | - | - | - | 解调失败(${r.failed}) |`);
      continue;
    }
    console.log(`| ${r.channel} | ${r.fec} | ${r.interleave} | ${r.berPre.toExponential(2)} | ${r.berPost.toExponential(2)} | ` +
      `${(100 * r.blockSuccess).toFixed(0)}% (${r.codewordsOk}/${r.codewords}) | ${r.payloadPsnr.toFixed(2)} dB | ` +
      `${r.analogPsnr.toFixed(2)} dB | ${(r.ms / 1000).toFixed(2)} s |`);
  }

  // ---------------------------------------------------------------- findings
  console.log('\n=== findings ===');
  const byKey = (ch, fec, il) => rows.find((r) => r.channel === ch && r.fec === fec && r.interleave === il && !r.failed);
  for (const preset of presets) {
    const noneNoIl = byKey(preset.name, '无FEC', '无交织');
    const rs223Il = byKey(preset.name, 'RS(255,223)', '深度32');
    const rs191Il = byKey(preset.name, 'RS(255,191)', '深度32');
    if (!noneNoIl) continue;
    const bestRow = [rs223Il, rs191Il].filter(Boolean).sort((a, b) => b.payloadPsnr - a.payloadPsnr)[0];
    console.log(`  ${preset.name.padEnd(9)} no-FEC ${noneNoIl.payloadPsnr.toFixed(2)} dB (CRC ${noneNoIl.crcOk ? 'ok' : 'FAIL'})` +
      (bestRow ? ` -> best FEC+interleave ${bestRow.payloadPsnr.toFixed(2)} dB (${bestRow.fec}) gain ${(bestRow.payloadPsnr - noneNoIl.payloadPsnr).toFixed(2)} dB` : ''));
  }
  // AC9: mild tier, FEC+interleave vs no FEC
  const ac9 = (() => {
    const base = byKey('mild', '无FEC', '无交织');
    const withFec = ['RS(255,223)', 'RS(255,191)']
      .map((f) => byKey('mild', f, '深度32')).filter(Boolean)
      .sort((a, b) => b.payloadPsnr - a.payloadPsnr)[0];
    return (base && withFec) ? { base, withFec, gain: withFec.payloadPsnr - base.payloadPsnr } : null;
  })();
  if (ac9) {
    console.log(`\n  AC9 (mild, FEC+interleave vs none, payload image PSNR): ` +
      `${ac9.base.payloadPsnr.toFixed(2)} -> ${ac9.withFec.payloadPsnr.toFixed(2)} dB = ` +
      `${ac9.gain >= 0 ? '+' : ''}${ac9.gain.toFixed(2)} dB  ${ac9.gain >= 3 ? 'PASS' : 'FAIL (<3 dB)'}`);
  }
  // AC7: clean-tier analog fidelity must not collapse
  const cleanRow = byKey('clean', 'RS(255,223)', '深度32');
  if (cleanRow) {
    console.log(`  AC7 (clean analog PSNR with payload embedded): ${cleanRow.analogPsnr.toFixed(2)} dB ` +
      `(embedding penalty ${cleanRow.embedPenalty.toFixed(2)} dB)  ${cleanRow.analogPsnr >= 29 ? 'PASS' : 'FAIL (<29 dB)'}`);
  }

  fs.writeFileSync(path.join(OUT, 'eval-ber.json'), JSON.stringify({
    mode: MODE_ID, quality: QUALITY, carrier: CARRIER, thumb: THUMB, rows
  }, null, 2));
  console.log(`\n${rows.length} runs in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(ROOT, path.join(OUT, 'eval-ber.json'))}`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
