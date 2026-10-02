/*
 * Full-chain end-to-end test: image -> SSTV audio -> channel -> decode -> image.
 *
 * This is the only suite that runs the WHOLE chain for all four supported modes. The existing
 * suites each cover one half of it: roundtrip.js encodes and decodes but inserts no channel,
 * and channel-sim.test.js exercises the channel but not against a real decode. Here an actual
 * impaired waveform must survive demodulation, affine calibration, clock recovery and image
 * reconstruction for Martin M1, Scottie S1, PD120 and PD180.
 *
 * PD120 and PD180 require a sample rate above 16 kHz (their pixel time is 190 us and 285 us),
 * which is why the suite runs at 48 kHz throughout.
 *
 * Usage: node tests/e2e-full.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
// channel-sim.js exports itself as module.exports and as the global `ChannelSim`
const ChannelSim = require(path.join(ROOT, 'js', 'channel-sim.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Dec = globalThis.SSTVDecode;

const SR = 48000;
let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  OK   ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '   ' + detail : '')); }
};
function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    for (const o of [0, 1, 2]) { const d = a.data[i * 4 + o] - b.data[i * 4 + o]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
/** A source image with both smooth gradients and hard edges, so blur and shift both show. */
function testImage(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const band = Math.floor(x / (w / 8)) % 2;
      d[o] = band ? 235 : Math.round(30 + 200 * (x / w));
      d[o + 1] = band ? Math.round(30 + 200 * (y / h)) : 90;
      d[o + 2] = Math.round(255 * (1 - y / h) * (band ? 1 : 0.55) + 20);
      d[o + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

/*
 * Per-mode channel and acceptance bound.
 *
 * Bounds are deliberately loose regression guards (a real regression drops 5-20 dB, so a
 * 20 dB floor still catches it) while the measured value is printed for the record. The
 * channels are chosen mild because the point of this suite is chain integration, not the
 * robustness envelope, which eval-real-decode.js measures.
 */
const PLAN = [
  { id: 'M1',    channel: { snrDb: 30, freqOffset: 2 },  floor: 20, label: 'AWGN 30 dB + 2 Hz 频偏' },
  { id: 'S1',    channel: { snrDb: 26, rateMismatch: 1.0002 }, floor: 20, label: 'AWGN 26 dB + 0.02% 采样率失配' },
  { id: 'PD120', channel: { snrDb: 32 },                  floor: 22, label: 'AWGN 32 dB' },
  { id: 'PD180', channel: { snrDb: 30, freqOffset: -2 },  floor: 22, label: 'AWGN 30 dB + −2 Hz 频偏' }
];

(async function main() {
  console.log('=== full-chain end-to-end (image -> SSTV -> channel -> decode -> image) ===');
  console.log(`sample rate ${SR} Hz, channel: ${ChannelSim.VERSION}\n`);

  for (const plan of PLAN) {
    const mode = Modes.get(plan.id);
    console.log(`[${mode.id}] ${mode.name}  ${mode.width}x${mode.height}  VIS ${mode.vis}  (${plan.label})`);
    const src = testImage(mode.width, mode.height);
    const t0 = Date.now();
    const tl = Timeline.build(src, mode);
    const audio = Synth.synthesize(tl, SR).samples;
    const encMs = Date.now() - t0;

    const expected = Modes.totalDuration(mode);
    const actual = audio.length / SR;
    ok(Math.abs(actual - expected) < 0.05, `${mode.id}: encoded duration matches the mode table`,
      actual.toFixed(2) + ' s vs ' + expected.toFixed(2) + ' s');

    const impaired = ChannelSim.apply(audio, Object.assign({ sampleRate: SR }, plan.channel));
    /*
     * A rate-mismatch stage RESAMPLES, so the sample count is expected to change by the
     * mismatch factor; every other stage preserves it. The assertion therefore has to depend
     * on the configured channel rather than assume a constant length.
     */
    const resamples = plan.channel.rateMismatch != null;
    ok(impaired !== audio && impaired.length > 0, `${mode.id}: channel returned a fresh buffer`, plan.label);
    if (resamples) {
      const ratio = impaired.length / audio.length;
      ok(Math.abs(ratio - 1 / plan.channel.rateMismatch) < 0.01,
        `${mode.id}: rate mismatch resamples by the expected factor`,
        ratio.toFixed(6) + ' vs ' + (1 / plan.channel.rateMismatch).toFixed(6));
    } else {
      ok(impaired.length === audio.length, `${mode.id}: channel preserves the sample count`,
        impaired.length + ' samples');
    }

    const t1 = Date.now();
    const res = await Dec.decode(impaired, SR, { quality: 'standard', yieldFn: () => Promise.resolve() });
    const decMs = Date.now() - t1;

    ok(res.ok, `${mode.id}: decodes through the channel`, res.ok ? '' : (res.stage + ': ' + res.message));
    if (!res.ok) { console.log(''); continue; }

    ok(res.mode && res.mode.id === mode.id, `${mode.id}: VIS identifies the right mode`,
      'VIS ' + res.vis + ' -> ' + (res.mode ? res.mode.id : '?'));
    ok(res.imageData.width === mode.width && res.imageData.height === mode.height,
      `${mode.id}: decoded raster has the mode geometry`,
      res.imageData.width + 'x' + res.imageData.height);

    const p = psnr(res.imageData, src);
    ok(p >= plan.floor, `${mode.id}: PSNR above the regression floor of ${plan.floor} dB`,
      p.toFixed(2) + ' dB');

    // the header search must have used the untouched primary path on these mild channels
    const src2 = res.timings && res.timings.headerSource;
    ok(src2 === 'primary', `${mode.id}: header found by the primary path (no fallback needed)`, String(src2));

    console.log(`       encode ${encMs} ms, decode ${decMs} ms, PSNR ${p.toFixed(2)} dB`);
    if (res.calibration) {
      console.log(`       calibration a=${res.calibration.scale.toFixed(5)} b=${res.calibration.offsetHz.toFixed(2)} Hz ` +
        `clock=${res.calibration.clockScale.toFixed(5)}`);
    }
    console.log('');
  }

  console.log('================================');
  console.log(`${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? 'E2E FULL VERIFIED' : 'E2E FULL FAILED');
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
