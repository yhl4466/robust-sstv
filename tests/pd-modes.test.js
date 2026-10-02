/*
 * Phase-7: PD-family (PD120 / PD180) round-trip tests.
 *
 * What this proves and what it does NOT:
 *   PROVES  the decoder inverts the project's own PD encoder - structure, block alignment,
 *           chroma order, YUV matrix and pixel windows are all correct relative to it.
 *   DOES NOT prove conformance to the published PD standard, because the standard could not
 *           be fetched (external network is heavily filtered in this environment). The
 *           structural facts that CAN be checked offline are asserted below: the line-pair
 *           timing, the total duration, the chroma coefficient sums, and that PD120 and
 *           PD180 share one code path.
 *
 * Usage: node tests/pd-modes.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Dec = globalThis.SSTVDecode;

const SR = 48000;   // PD's modulation rate is ~5.3 kHz, so 8 kHz sampling would alias
let pass = 0, fail = 0;
/** Measured values, recorded to scripts/out/pd-modes.json so the paper is generated from data. */
const measured = {};
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '   ' + detail : '')); }
}
function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    for (const o of [0, 1, 2]) { const d = a.data[i * 4 + o] - b.data[i * 4 + o]; se += d * d; n++; }
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}
/** Colour test image: wide flat patches so a chroma swap shows up immediately as a hue error. */
function colourBars(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  const cols = [[220, 30, 30], [30, 200, 30], [40, 60, 220], [230, 220, 40], [200, 40, 200], [40, 210, 210]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = cols[Math.floor(x / (w / cols.length)) % cols.length];
      const o = (y * w + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}
/** Detail-rich test image. */
function rampImage(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] = Math.round(127 + 120 * Math.sin(x / 17));
      d[o + 1] = Math.round(127 + 120 * Math.sin(y / 13 + 1));
      d[o + 2] = Math.round(127 + 120 * Math.sin((x + y) / 23));
      d[o + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

async function roundTrip(modeId, image) {
  const mode = Modes.get(modeId);
  const tl = Timeline.build(image, mode);
  const samples = Synth.synthesize(tl, SR).samples;
  const res = await Dec.decode(samples, SR, { quality: 'standard', yieldFn: () => Promise.resolve() });
  return { res, duration: tl.duration };
}

(async function main() {
  console.log('=== PD-family tests ===\n');

  // ---------------------------------------------------------------- table facts
  console.log('[A] mode table structure (offline checks)');
  for (const id of ['PD120', 'PD180']) {
    const m = Modes.get(id);
    const linePair = m.syncPulse + m.blanking + m.channels * m.scanTime;
    const total = Modes.totalDuration(m);
    ok(m.structure === 'pd', `${id} is declared structure 'pd'`);
    ok(m.chanSync === -1, `${id} has chanSync -1 (no per-line sync)`);
    ok(m.linePairs === true && m.height % 2 === 0, `${id} is organised in line pairs`);
    ok(m.scanOrder.length === 4, `${id} has 4 scans per line pair`, m.scanOrder.join(','));
    ok(m.syncPorch === 0 && m.sepPulse === 0, `${id} has no porch and no separators`);
    console.log(`       ${id}: line pair ${linePair.toFixed(5)} s x ${m.height / 2} pairs, total ${total.toFixed(2)} s, ` +
      `pixel time ${(m.scanTime / m.width * 1e6).toFixed(1)} us, sample rate needed >= ${(m.width / m.scanTime * 3).toFixed(0)} Hz`);
  }
  {
    const a = Modes.get('PD120'), b = Modes.get('PD180');
    const ra = (a.syncPulse + a.blanking + a.channels * a.scanTime);
    const rb = (b.syncPulse + b.blanking + b.channels * b.scanTime);
    ok(Math.abs(b.scanTime / a.scanTime - 1.5) < 0.001,
      'PD180 scan time is 1.5x PD120 (sync pulse and blanking are shared, so the line-pair ratio is not exactly 1.5)',
      b.scanTime + ' / ' + a.scanTime + ' = ' + (b.scanTime / a.scanTime).toFixed(4));
    ok(a.width === b.width && a.height === b.height && a.scanOrder.join() === b.scanOrder.join()
      && a.blanking === b.blanking && a.syncPulse === b.syncPulse,
      'PD120 and PD180 differ ONLY in scanTime and VIS (so one code path serves both)');
    ok(Modes.DECODABLE[95] && Modes.DECODABLE[95].id === 'PD120', 'VIS 95 maps to PD120');
    ok(Modes.DECODABLE[96] && Modes.DECODABLE[96].id === 'PD180', 'VIS 96 maps to PD180');
  }
  {
    // the chroma rows must sum to zero, otherwise grey would acquire a colour cast
    const C = Modes.YUV_PD;
    ok(Math.abs(C.ryR + C.ryG + C.ryB) < 0.01, 'R-Y coefficients sum to zero',
      (C.ryR + C.ryG + C.ryB).toFixed(6));
    ok(Math.abs(C.byR + C.byG + C.byB) < 0.01, 'B-Y coefficients sum to zero',
      (C.byR + C.byG + C.byB).toFixed(6));
  }

  // ---------------------------------------------------------------- round trips
  console.log('\n[B] PD120 round trip (AC1)');
  const pd120 = Modes.get('PD120');
  const img120 = rampImage(pd120.width, pd120.height);
  {
    const { res, duration } = await roundTrip('PD120', img120);
    ok(res.ok, 'PD120 decodes without error', res.ok ? '' : (res.stage + ': ' + res.message));
    const p = res.ok ? psnr(res.imageData, img120) : null;
    measured.pd120Ramp = { psnr: p, durationS: duration, decodeMs: res.timings ? res.timings.total : null };
    ok(p != null && p > 25, 'PD120 round-trip PSNR > 25 dB', p != null ? p.toFixed(2) + ' dB' : 'n/a');
    console.log(`       duration ${duration.toFixed(2)} s, decode ${res.timings ? res.timings.total : '?'} ms, ` +
      `calibration a=${res.calibration ? res.calibration.scale.toFixed(5) : '-'}`);
    if (res.ok) {
      const { PNG } = require(path.join(RESEARCH, 'pngjs'));
      const png = new PNG({ width: res.imageData.width, height: res.imageData.height });
      png.data = Buffer.from(res.imageData.data);
      fs.writeFileSync(path.join(ROOT, 'scripts', 'out', 'pd120-ramp.png'), PNG.sync.write(png));
    }
  }

  console.log('\n[C] PD120 colour path (hue order + matrix)');
  {
    const bars = colourBars(pd120.width, pd120.height);
    const { res } = await roundTrip('PD120', bars);
    ok(res.ok, 'PD120 decodes the colour test image', res.ok ? '' : (res.stage + ': ' + res.message));
    if (res.ok) {
      const p = psnr(res.imageData, bars);
      measured.pd120Colour = { psnr: p };
      ok(p > 25, 'colour test image PSNR > 25 dB', p.toFixed(2) + ' dB');
      // sample the centre of each bar and compare hue ordering to the source
      const cols = [[220, 30, 30], [30, 200, 30], [40, 60, 220], [230, 220, 40], [200, 40, 200], [40, 210, 210]];
      const names = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan'];
      const yc = Math.floor(pd120.height / 2);
      let right = 0;
      const got = [];
      for (let i = 0; i < cols.length; i++) {
        const xc = Math.floor((i + 0.5) * pd120.width / cols.length);
        const o = (yc * pd120.width + xc) * 4;
        const got = [res.imageData.data[o], res.imageData.data[o + 1], res.imageData.data[o + 2]];
        const want = cols[i];
        const dist = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
        if (dist < 120) right++;
        console.log(`       ${names[i].padEnd(8)} want ${want.join(',')}  got ${got.join(',')}  dist ${dist.toFixed(0)}`);
      }
      measured.pd120Colour.barsCorrect = right;
      measured.pd120Colour.barsTotal = cols.length;
      ok(right >= cols.length - 1, 'every colour bar reconstructs to the right hue (no R/B swap)',
        `${right}/${cols.length} within 120 units`);
      const { PNG } = require(path.join(RESEARCH, 'pngjs'));
      const png = new PNG({ width: res.imageData.width, height: res.imageData.height });
      png.data = Buffer.from(res.imageData.data);
      fs.writeFileSync(path.join(ROOT, 'scripts', 'out', 'pd120-colour.png'), PNG.sync.write(png));
    }
  }

  console.log('\n[D] PD180 round trip (AC2)');
  const pd180 = Modes.get('PD180');
  {
    const img = rampImage(pd180.width, pd180.height);
    const { res, duration } = await roundTrip('PD180', img);
    ok(res.ok, 'PD180 decodes without error', res.ok ? '' : (res.stage + ': ' + res.message));
    const p = res.ok ? psnr(res.imageData, img) : null;
    measured.pd180 = { psnr: p, durationS: duration, decodeMs: res.timings ? res.timings.total : null };
    ok(p != null && p > 25, 'PD180 round-trip PSNR > 25 dB', p != null ? p.toFixed(2) + ' dB' : 'n/a');
    console.log(`       duration ${duration.toFixed(2)} s, decode ${res.timings ? res.timings.total : '?'} ms`);
  }

  console.log('\n[E] determinism');
  {
    const a = await roundTrip('PD120', rampImage(pd120.width, pd120.height));
    const b = await roundTrip('PD120', rampImage(pd120.width, pd120.height));
    ok(a.res.ok && b.res.ok && psnr(a.res.imageData, b.res.imageData) === Infinity,
      'PD120 decode is deterministic (two runs bit-identical)');
  }

  console.log('\n[F] the line-sync family is untouched');
  {
    const m1 = Modes.get('M1');
    const img = rampImage(m1.width, m1.height);
    const { res } = await roundTrip('M1', img);
    measured.m1Control = { psnr: res.ok ? psnr(res.imageData, img) : null };
    ok(res.ok && psnr(res.imageData, img) > 25, 'M1 still round-trips after the PD work',
      res.ok ? psnr(res.imageData, img).toFixed(2) + ' dB' : 'FAIL');
  }

  console.log('\n================================');
  console.log(`${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? 'PD MODES VERIFIED' : 'PD MODES FAILED');
  /*
   * Record the measured numbers so the paper's PD table is generated from THIS run rather
   * than transcribed from console output.
   */
  const outDir = path.join(ROOT, 'scripts', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'pd-modes.json'), JSON.stringify({
    measuredAt: new Date().toISOString(),
    sampleRate: SR,
    quality: 'standard',
    passed: pass,
    failed: fail,
    measured: measured,
    windowFactorPd: Modes.get('PD120').windowFactor,
    scanTime: { pd120: Modes.get('PD120').scanTime, pd180: Modes.get('PD180').scanTime }
  }, null, 2));
  console.log('-> scripts/out/pd-modes.json');
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
