/*
 * Bake the acoustic model's impulse response for the demo page.
 *
 * WHY AN IR AND NOT THE MATRIX'S ALLPASS RECIPE
 *   tests/degradation-matrix.js builds its room as a chain of four Schroeder allpass sections plus sparse
 *   early reflections. That is cheap and it is what the published matrix used, but it gives the DEMO no
 *   usable control:
 *
 *     - the allpass gains it derives (combCoef x gainScaleFor, clamped at 0.97) are 0.05 for every RT60 at
 *       or below 0.20 s, so the ladder is essentially clean up to 0.20 s and then falls off a cliff;
 *     - measured on the demo clip, RT60 0.30 s and above stop producing a readable VIS, so every step past
 *       the second reports "decode failed". A slider whose middle is already fatal teaches nothing.
 *
 *   The underlying reason is real: SSTV's header is four steady tones, and a diffuse allpass tail smears
 *   their phase hard enough to break the pattern match at quite modest reverb. So the honest way to show
 *   acoustic degradation with a usable range is not to weaken the room, but to make the WET LEVEL the
 *   controlled quantity - a real, smooth, physically meaningful knob ("how much room do you hear").
 *
 *   This script therefore renders the model's own IR once, normalises it to unit energy (so the wet
 *   fraction in the page means exactly what it says and the dry signal is never quietly attenuated), and
 *   writes it as raw Float32 for scripts/gen-demo-page.js to inline.
 *
 * Usage: node tests/bake-demo-ir.js      (after node tests/measure-demo-base.js)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'demo-audio');
const SR = 8000;
const RT60 = 0.30;
const TAPS = Math.round(0.60 * SR);     // 0.60 s of tail at 8 kHz

const src = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const e0 = src.indexOf('const EARLY');
const e1 = src.indexOf('function combCoef');
const i0 = src.indexOf('function combCoef');
const i1 = src.indexOf('function reverb(samples');
const r0 = src.indexOf('function gForSection');
const r1 = src.indexOf('\n}', r0) + 2;

/*
 * The IR is produced by the model's own `buildIR`, so it carries the calibrated gain the matrix solves for
 * (gainScaleFor is a measured quantity, solved by building IRs until the tail decays in the requested
 * time). Reproducing the formula by hand instead would give a different room from the published one.
 */
const code = 'var SR=' + SR + ';' + src.slice(e0, e1) + src.slice(i0, i1) + src.slice(r0, r1) +
  '\nreturn { buildIR: buildIR, gainScaleFor: gainScaleFor, EARLY: EARLY, DIFFUSE: DIFFUSE };';
const M = new Function(code)();

const scale = M.gainScaleFor(RT60);
const ir = M.buildIR(RT60, scale, TAPS);

function rms(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); }

console.log('房间模型 IR');
console.log('  RT60 请求 ' + RT60 + ' s · 校准增益 ' + scale.toFixed(4) + ' · ' + TAPS + ' taps @ ' + SR + ' Hz');
console.log('  EARLY   ' + JSON.stringify(M.EARLY));
console.log('  DIFFUSE ' + JSON.stringify(M.DIFFUSE.map((d) => d.ms + 'ms')));

/*
 * Normalise to UNIT ENERGY. Without this the wet level depends on the model's arbitrary output gain, and a
 * "30% wet" setting would mean something different at every RT60 - the page's slider would control an
 * unlabelled quantity. Unit energy also lets the truncation loss be reported below.
 */
let energy = 0;
for (let i = 0; i < ir.length; i++) energy += ir[i] * ir[i];
const norm = 1 / Math.sqrt(energy);
const taps = new Float32Array(ir.length);
for (let i = 0; i < ir.length; i++) taps[i] = ir[i] * norm;

// how much of the tail sits beyond the truncation point, so a too-short IR is visible rather than silent
let tailE = 0;
for (let i = Math.round(0.40 * SR); i < ir.length; i++) tailE += taps[i] * taps[i];
console.log('  归一化后 RMS ' + rms(taps).toFixed(6) + ' · 0.40 s 之后的残余能量占比 ' +
  (tailE * 100).toFixed(3) + '%');

const raw = Buffer.from(taps.buffer.slice(taps.byteOffset, taps.byteOffset + taps.byteLength));
fs.writeFileSync(path.join(OUT, 'room-ir-8k.f32'), raw);
fs.writeFileSync(path.join(OUT, 'room-ir.json'), JSON.stringify({
  sampleRate: SR, rt60S: RT60, taps: taps.length, calibrationGain: scale,
  tapsSeconds: taps.length / SR, tailEnergyAfter040sPct: Number((tailE * 100).toFixed(4)),
  early: M.EARLY, diffuseMs: M.DIFFUSE.map((d) => d.ms),
  note: '由 tests/bake-demo-ir.js 用 degradation-matrix.js 的 buildIR 生成并归一化到单位能量'
}, null, 2));
console.log('\n写入 tests/demo-audio/room-ir-8k.f32 (' + (raw.length / 1024).toFixed(1) + ' KB)');
console.log('写入 tests/demo-audio/room-ir.json');
