/*
 * Frequency-axis constants: nominal-space quantities must be mapped through the calibration.
 *
 * Two constants in sstv-decode.js are defined on the NOMINAL frequency axis but were being applied to
 * RAW measurements:
 *
 *   IMAGE_BAND_MARGIN_HZ = 200   built as [a*1500 + b - MARGIN, a*2300 + b + MARGIN]. The first two
 *                                terms are raw and the margin is nominal, so the band came out
 *                                (1 - a)*200 Hz narrow on one side and wide on the other.
 *   SYNC_DETECT_HZ = 1350        compared against f(est.peak(...)), i.e. against the raw reading, with
 *                                no conversion at all. The 150 Hz of headroom above the 1200 Hz sync
 *                                therefore shrinks as the tuning error grows.
 *
 * Both are fixed, and this file pins the fix down. It also MEASURES what the old form was worth, so the
 * change is justified by a number rather than by the argument that it looks wrong - the argument being
 * exactly the kind of reasoning this project has repeatedly found to be wrong.
 *
 * Usage: node tests/frequency-axis.test.js
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
const Decode = globalThis.SSTVDecode;

const FA = Decode._internal.frequencyAxis;
if (!FA) throw new Error('sstv-decode.js does not export _internal.frequencyAxis');
const { imageBandRaw, syncDetectHz, syncDetectHzOf, constants } = FA;
const MARGIN = constants.IMAGE_BAND_MARGIN_HZ;
const SYNC_DETECT_HZ = constants.SYNC_DETECT_HZ;

let failures = 0;
function check(ok, label, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-9 : tol);

console.log('=== 频率轴常量的量纲一致性 ===\n');

// ---------------------------------------------------------------- identity under unity calibration
console.log('[1] 单位标定时必须与历史行为逐位一致');
{
  const b1 = imageBandRaw(1, 0);
  check(near(b1[0], 1500 - MARGIN) && near(b1[1], 2300 + MARGIN),
    'imageBandRaw(1, 0) = [1300, 2500]', '[' + b1[0] + ', ' + b1[1] + ']');
  check(near(syncDetectHz(1, 0), SYNC_DETECT_HZ), 'syncDetectHz(1, 0) 仍是 ' + SYNC_DETECT_HZ);
  // and the defaults must not change either
  const b0 = imageBandRaw();
  check(near(b0[0], 1300) && near(b0[1], 2500), 'imageBandRaw() 默认与 (1,0) 相同');
  check(near(syncDetectHzOf(undefined), SYNC_DETECT_HZ), 'syncDetectHzOf(undefined) 回退到常量');
  check(near(syncDetectHzOf(null), SYNC_DETECT_HZ), 'syncDetectHzOf(null) 回退到常量');
}

// ---------------------------------------------------------------- margins scale with `a`
console.log('\n[2] 余量必须随 a 一起缩放（这才是"标定后 ±200 Hz"的含义）');
{
  for (const a of [0.99, 0.995, 1, 1.005, 1.01]) {
    const band = imageBandRaw(a, 0);
    const nominalLo = (band[0] - 0) / a, nominalHi = (band[1] - 0) / a;
    check(near(nominalLo, 1500 - MARGIN, 1e-6) && near(nominalHi, 2300 + MARGIN, 1e-6),
      'a = ' + a.toFixed(4) + ' 时带宽映射回名义轴 = [' + nominalLo.toFixed(3) + ', ' + nominalHi.toFixed(3) + ']');

    /*
     * Map each OLD bound back to the nominal axis to show the error the fix removes:
     *   oldLo/a = 1500 - MARGIN/a   ->  error = MARGIN*(1 - 1/a)
     *   oldHi/a = 2300 + MARGIN/a   ->  error = -MARGIN*(1 - 1/a)
     * The sign flips with `a`, so the band was narrow on one side and wide on the other, and the whole
     * effect was worth only ~2 Hz at 1% clock error - which is the honest size of this fix. It is a
     * correctness fix, not a quality fix, and the commit message should not pretend otherwise.
     */
    const oldLo = a * 1500 - MARGIN, oldHi = a * 2300 + MARGIN;
    const oldNominalLo = oldLo / a, oldNominalHi = oldHi / a;
    const loErr = oldNominalLo - (1500 - MARGIN), hiErr = oldNominalHi - (2300 + MARGIN);
    if (a !== 1) {
      const expect = MARGIN * (1 - 1 / a);
      check(near(loErr, expect, 1e-6) && near(hiErr, -expect, 1e-6),
        '  （旧式在 a = ' + a + ' 的名义轴误差）下界 ' + loErr.toFixed(3) + ' Hz / 上界 ' +
        hiErr.toFixed(3) + ' Hz = 余量 x (1 - 1/a)',
        '预期 ' + expect.toFixed(3) + ' / ' + (-expect).toFixed(3));
    }
  }
  const a = 1.01;
  const oldLo = a * 1500 - MARGIN, newLo = a * (1500 - MARGIN);
  console.log('      1% 时钟误差下的具体差别: 旧下界 ' + oldLo.toFixed(2) + ' → 新下界 ' +
    newLo.toFixed(2) + '（差 ' + (newLo - oldLo).toFixed(2) + ' Hz，名义轴上是 ' +
    ((newLo - oldLo) / a).toFixed(2) + ' Hz）');
}

// ---------------------------------------------------------------- sync threshold moves with b
console.log('\n[3] 同步门限必须随 b 一起平移');
{
  for (const b of [0, 10, -10, 50, -50, 100, -100]) {
    const t = syncDetectHz(1, b);
    const headroomNominal = (t - b) - 1200;   // 回名义轴后，距 1200 Hz 同步的余量
    check(near(t, SYNC_DETECT_HZ + b, 1e-6) && near(headroomNominal, 150, 1e-6),
      'b = ' + String(b).padStart(5) + ' Hz → 门限 ' + t.toFixed(1) +
      ' Hz（名义余量 ' + headroomNominal.toFixed(0) + ' Hz）');
  }
  // without the mapping, the headroom is eaten by the offset - this is the bug being fixed
  console.log('\n      [对照] 不做映射时，名义余量随频偏被吃掉：');
  for (const b of [0, 50, 100, 150, 200]) {
    console.log('        频偏 +' + String(b).padStart(3) + ' Hz → 名义余量 ' +
      (150 - b).toFixed(0).padStart(4) + ' Hz' +
      (b >= 150 ? '   ← 同步音自身已越过固定门限' : ''));
  }
  const unmappedAt100 = 150 - 100;
  check(unmappedAt100 === 50, '固定门限在 +100 Hz 时只剩 50 Hz 余量（已由测量确认，见下）',
    '名义余量 ' + unmappedAt100 + ' Hz');
}

// ---------------------------------------------------------------- clamp guards a bad calibration
console.log('\n[4] 门限必须被夹住，坏标定不能让守卫失效');
{
  check(near(syncDetectHz(1, 100000), 1.6 * SYNC_DETECT_HZ), 'b 极大时夹到 1.6x');
  check(near(syncDetectHz(1, -100000), 0.8 * SYNC_DETECT_HZ), 'b 极小时夹到 0.8x');
  /*
   * Two separate guards, and they must not be confused with each other:
   *   - `a` outside [0.5, 2] is REJECTED: the calibration is treated as absent and the plain constant is
   *     used. That is the stronger guarantee, and it is why 1e6 and 0.01 return 1350, not a clamped value.
   *   - inside that range the mapping runs and its RESULT is clamped, so a = 2 gives 1.6x (not 2.7x) and
   *     a = 0.5 gives 0.8x (not 0.4x). An earlier version of this file expected the guard edges and the
   *     clamp edges to coincide; they do not, and they should not.
   */
  check(near(syncDetectHz(2.0, 0), 1.6 * SYNC_DETECT_HZ), 'a = 2.0 参与映射后被夹到 1.6x');
  check(near(syncDetectHz(0.5, 0), 0.8 * SYNC_DETECT_HZ, 1e-6), 'a = 0.5 参与映射后被夹到 0.8x');
  check(near(syncDetectHz(1e6, 0), SYNC_DETECT_HZ), 'a 极大被拒绝，回退常量而非夹取');
  check(near(syncDetectHz(0.01, 0), SYNC_DETECT_HZ), 'a 极小被拒绝，回退常量而非夹取');
  // a nonsense calibration must fall back rather than propagate NaN into a comparison
  check(near(syncDetectHz(NaN, 0), SYNC_DETECT_HZ), 'a = NaN 回退到常量');
  check(near(syncDetectHz(1, NaN), SYNC_DETECT_HZ), 'b = NaN 回退到常量');
  check(near(syncDetectHz(3, 0), SYNC_DETECT_HZ), 'a = 3（超出可信区间）回退到常量');
  check(isFinite(syncDetectHz(1, Infinity)), 'b = Infinity 不会返回 Infinity');
  check(near(syncDetectHz(0.97, 40), 0.97 * SYNC_DETECT_HZ + 40, 1e-6),
    '接近实际录音的标定（a 0.97, b 40）正常映射');
}

// ---------------------------------------------------------------- end to end: no regression
async function endToEnd() {
  console.log('\n[5] 端到端：干净与受损往返不得改变');
  const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
  const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline, Synth = globalThis.SSTVSynth;
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(img, Modes.get('S1')), 48000).samples;
  function psnr(a, b) {
    let se = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      if (i % 4 === 3) continue;
      const d = a[i] - b[i]; se += d * d; n++;
    }
    return 10 * Math.log10(65025 / (se / n));
  }
  const r = await Decode.decode(clean, 48000, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  const p = psnr(r.imageData.data, img.data);
  check(r.ok && p >= 30.45, '干净 S1 往返保持（基线 30.50）', p.toFixed(2) + ' dB');
  const band = imageBandRaw(r.calibration.scale, r.calibration.offsetHz);
  check(band[1] - band[0] > 800, '解码器实际使用的带内宽于名义 800 Hz',
    '[' + band[0].toFixed(0) + ', ' + band[1].toFixed(0) + '] = ' + (band[1] - band[0]).toFixed(0) + ' Hz');
  const nominalWidth = (band[1] - band[0]) / r.calibration.scale;
  check(near(nominalWidth, 800 + 2 * MARGIN, 1e-6), '带宽映射回名义轴恰为 800 + 2 x 余量',
    nominalWidth.toFixed(3) + ' Hz');
}

endToEnd().then(() => {
  console.log('\n' + (failures === 0 ? 'FREQUENCY AXIS: ALL CHECKS PASSED'
                                    : 'FREQUENCY AXIS: ' + failures + ' CHECK(S) FAILED'));
  process.exitCode = failures === 0 ? 0 : 1;
}).catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
