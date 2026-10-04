/*
 * The decoder successfully calibrates the real phone recording (a = 1.000108, b = -0.29 Hz, 256 lines
 * locked), so the calibration header IS present in that file. But the analyser's own locator cannot find
 * it, and tests/diagnose-real-levels.js shows why: the strongest 1900 Hz content in the first 30 s sits at
 * 1.55 s, 5.1 dB below the file RMS, while the preamble region (t ~ 2.5 s) carries 1900 Hz at about
 * -15 dB. The recording is music plus room noise, and the music contains 1900 Hz energy stronger than the
 * preamble's own leader tone.
 *
 * That raises a concrete question with a concrete answer available: WHERE does the decoder's header search
 * actually lock? If it locks in the first few seconds, the preamble is simply weaker than the music and no
 * tone-dominance locator can be trusted on this material. If it locks much later, then something else is
 * going on. This reads the decoder's own reported numbers rather than re-deriving them.
 *
 * Usage: node tests/diagnose-header-anchor.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, Modes = globalThis.SSTVModes;

function load(p) {
  const b = fs.readFileSync(p);
  return Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

(async function main() {
  const p = path.join(OUT, 'acoustic-real-48k-mono.wav');
  const i = load(p);
  const sr = i.sampleRate;

  console.log('=== 解码器在真机录音上把标定头锁在哪里 ===\n');
  const r = await Decode.decode(i.samples, sr, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  if (!r.ok) { console.log('解码失败: ' + r.message); return; }
  const c = r.calibration;
  const startS = c.imageStart / sr;
  console.log('  imageStart = ' + c.imageStart + ' 采样 = ' + startS.toFixed(3) + ' s');
  console.log('  由规格反推：标定头起点 = imageStart − HDR_SIZE(0.640 s) − 图象数据 = ' +
    '此处 imageStart 即标定结束后图象数据开始处');
  console.log('  a = ' + c.scale.toFixed(6) + '  b = ' + c.offsetHz.toFixed(2) + ' Hz');
  console.log('  leader 实测频率 = ' + (c.leaderFreqHz == null ? '—' : c.leaderFreqHz.toFixed(2) + ' Hz'));
  console.log('  headerScale = ' + (c.headerScale == null ? '—' : c.headerScale.toFixed(6)) +
    '  headerOffset = ' + (c.headerOffsetHz == null ? '—' : c.headerOffsetHz.toFixed(2)) + ' Hz');
  console.log('  逐行观测 ' + c.observations + ' · 丢锁 ' + c.freeRunTotal +
    ' · 同步残差 RMS ' + (c.syncResidualRms == null ? '—' : c.syncResidualRms.toFixed(1)));

  /*
   * The decisive derived number: the calibration header sits HDR_SIZE (0.640 s) before the image data, and
   * for Scottie S1 the single leading sync follows the header. So the preamble should occupy roughly
   * [imageStart/sr - 0.640 - lineTime, imageStart/sr - 0.640].
   */
  const lineS = Modes.lineTime(Modes.get('S1'));
  console.log('\n  由此推算标定头应在 t ≈ ' + (startS - 0.640 - lineS).toFixed(3) + ' .. ' +
    (startS - 0.640).toFixed(3) + ' s 之间');
  console.log('  该文件前 3 s 的 level 结构见 tests/diagnose-real-levels.js');

  fs.writeFileSync(path.join(OUT, 'header-anchor.json'),
    JSON.stringify({ imageStart: c.imageStart, imageStartSeconds: startS, scale: c.scale,
      offsetHz: c.offsetHz, leaderFreqHz: c.leaderFreqHz, headerScale: c.headerScale,
      headerOffsetHz: c.headerOffsetHz, observations: c.observations, freeRunTotal: c.freeRunTotal,
      expectedHeaderWindow: [startS - 0.640 - lineS, startS - 0.640] }, null, 2));
  console.log('\n证据 -> tests/diag-quality/header-anchor.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
