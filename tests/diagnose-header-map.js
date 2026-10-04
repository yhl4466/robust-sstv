/*
 * Where IS the calibration header in each recording? A read-only map, before any diagnosis.
 *
 * The previous two scripts produced mutually inconsistent probe readings (acoustic-rt03 reporting -0 Hz
 * for a 1900 Hz probe while decoding successfully at 15.27 dB), which means the probe was landing in
 * silence or in the wrong place, not that the recordings are odd. Rather than reason from numbers I do
 * not trust, this prints the actual tone trajectory of the first two seconds of each file using exactly
 * the estimator the decoder uses. That is data, not inference: if the header is where the spec says, the
 * map shows four plateaus at 1900/1200 Hz in the documented order.
 *
 * Only after the map is trustworthy is anything concluded about acoustic-band.
 *
 * Usage: node tests/diagnose-header-map.js
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
const Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

function load(p) {
  const b = fs.readFileSync(p);
  return Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const FILES = [
  ['real-npm-8k', path.resolve(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.wav')],
  ['acoustic-rt03', path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-rt03.wav')],
  ['acoustic-band', path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-band.wav')]
];

/** RMS over a window, to tell silence from signal - the reading that was missing before. */
function windowRms(x, off, len) {
  let s = 0, n = 0;
  for (let i = 0; i < len; i++) { const v = x[off + i]; if (v === undefined) break; s += v * v; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const out = {};
  console.log('=== 标定头区域实测轨迹（解码器自己的估计器，10 ms 窗）===\n');
  console.log('  规格（sstv-decode.js 的常量）：0.000-0.300 break 1200 · 0.310-0.610 leader 1900 ·');
  console.log('                                0.610-0.640 VIS start 1200 · 0.920-1.220 leader2 1900');
  console.log('  第一列 "幅度" 是该 10 ms 窗的 RMS：判断探针是否落在静音里。\n');

  for (const [name, file] of FILES) {
    if (!fs.existsSync(file)) { console.log('  ' + name + ': 文件缺失'); continue; }
    const i = load(file);
    const sr = i.sampleRate;
    const est = new Decode._internal.Estimator(sr, 16);
    const win = Math.round(0.010 * sr);
    const trace = [];
    console.log('  ' + name + '  (' + sr + ' Hz, ' + i.duration.toFixed(2) + ' s)  全局 RMS ' +
      windowRms(i.samples, 0, i.samples.length).toFixed(4));
    console.log('      t(s)   幅度      主频(Hz)   期望');
    const marks = [
      [0.05, 'break'], [0.15, 'break'], [0.25, 'break'],
      [0.32, 'leader'], [0.40, 'leader'], [0.50, 'leader'], [0.58, 'leader'],
      [0.61, 'VIS start'], [0.63, 'VIS start'],
      [0.92, 'leader2'], [1.00, 'leader2'], [1.10, 'leader2'], [1.18, 'leader2']
    ];
    for (const [t, want] of marks) {
      const off = Math.round(t * sr);
      const f = est.peak(i.samples, off, win);
      const a = windowRms(i.samples, off, win);
      trace.push({ t: t, want: want, freq: f, rms: a });
      console.log('    ' + t.toFixed(2).padStart(6) + '  ' + a.toFixed(4).padStart(7) + '   ' +
        f.toFixed(0).padStart(8) + '   ' + want);
    }
    // and a dense sweep, so a displaced header cannot hide between the marks
    const dense = [];
    for (let t = 0.0; t < 1.4; t += 0.01) {
      const off = Math.round(t * sr);
      dense.push({ t: Number(t.toFixed(2)), f: est.peak(i.samples, off, win), a: windowRms(i.samples, off, win) });
    }
    const leaders = dense.filter((d) => Math.abs(d.f - 1900) < 80).map((d) => d.t);
    const breaks = dense.filter((d) => Math.abs(d.f - 1200) < 80).map((d) => d.t);
    console.log('      稠密扫描 0-1.4 s: 1900 Hz 命中 ' + leaders.length + ' 次' +
      (leaders.length ? ' [' + leaders[0] + '..' + leaders[leaders.length - 1] + ']' : '') +
      ' · 1200 Hz 命中 ' + breaks.length + ' 次' +
      (breaks.length ? ' [' + breaks[0] + '..' + breaks[breaks.length - 1] + ']' : ''));
    out[name] = { sampleRate: sr, duration: i.duration, marks: trace, dense: dense };
    console.log('');
  }

  /* ---- the same map for the un-degraded real recording is the control: if it also looks wrong, the
   *      probe is wrong, not the recording. That check is the whole point of printing RMS. ---- */
  console.log('  判读：若 real-npm-8k 的 map 也显示不出 1900/1200 平台，则问题在本脚本的探针；');
  console.log('        若只有 acoustic-band 显示不出，则标定头在该文件里确实已被破坏。');

  fs.writeFileSync(path.join(OUT, 'header-map.json'), JSON.stringify(out, null, 2));
  console.log('\n证据 -> tests/diag-quality/header-map.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
