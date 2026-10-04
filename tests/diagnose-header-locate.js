/*
 * Find the calibration header's actual position, instead of assuming it starts at t=0.
 *
 * The previous map exposed an assumption of mine: tests/fixtures/real/real-npm-8k has SILENT (RMS 0.0000)
 * audio for at least the first 1.4 s, so probing fixed offsets from 0 measured silence and reported
 * meaningless frequencies. The `sstv` package's example recording evidently carries leading silence, and
 * scripts/build-real-portfolio.js derives every realistic-synthetic fixture from it - which is why
 * acoustic-rt03 also read -0 at those offsets and yet decoded fine.
 *
 * This locates the header by scanning for where the signal actually starts, then measures the tone
 * sequence from there. It also reports the SAME numbers for the decoder's own view, so the manual scan
 * can be checked against something that is independently known to work.
 *
 * Usage: node tests/diagnose-header-locate.js
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
function windowRms(x, off, len) {
  let s = 0, n = 0;
  for (let i = 0; i < len; i++) { const v = x[off + i]; if (v === undefined) break; s += v * v; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

const FILES = [
  ['real-npm-8k', path.resolve(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.wav')],
  ['real-colaclanth-8k', path.resolve(ROOT, '..', '.research', 'real-sstv', 'colaclanth-m1-8k.wav')],
  ['acoustic-rt03', path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-rt03.wav')],
  ['acoustic-rt06', path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-rt06.wav')],
  ['acoustic-band', path.join(ROOT, 'tests', 'fixtures', 'real', 'acoustic-band.wav')]
];

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== 标定头实际位置定位 ===\n');
  const out = {};

  for (const [name, file] of FILES) {
    if (!fs.existsSync(file)) { console.log('  ' + name + ': 缺失'); continue; }
    const i = load(file);
    const sr = i.sampleRate, x = i.samples;
    const win = Math.round(0.010 * sr);

    // 1. where does the signal start? first 10 ms window whose RMS clears 10% of the file's own RMS
    let fileRms = windowRms(x, 0, x.length);
    let start = null;
    for (let t = 0; t < 5; t += 0.005) {
      if (windowRms(x, Math.round(t * sr), win) > 0.10 * fileRms) { start = t; break; }
    }

    // 2. tone trajectory from there
    const est = new Decode._internal.Estimator(sr, 16);
    const seq = [];
    for (let k = 0; k < 30; k++) {
      const t = (start == null ? 0 : start) + k * 0.025;
      const off = Math.round(t * sr);
      seq.push({ t: Number(t.toFixed(3)), f: est.peak(x, off, win), a: windowRms(x, off, win) });
    }

    // 3. the decoder's own view, for cross-checking
    const r = await Decode.decode(x, sr, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });

    console.log('  ' + name + '  (' + sr + ' Hz, ' + i.duration.toFixed(2) + ' s, 全局RMS ' +
      fileRms.toFixed(4) + ')');
    console.log('    信号起始 t ≈ ' + (start == null ? '未找到（全静音？）' : start.toFixed(3) + ' s'));
    console.log('    解码: ' + (r.ok ? 'ok ' + (r.mode ? r.mode.name : '') : '失败 ' + r.message.slice(0, 40)));
    if (start != null) {
      const line = seq.map((s) => s.f.toFixed(0)).join(' ');
      console.log('    从起点起的 25 ms 步进主频: ' + line);
      const aLine = seq.map((s) => s.a.toFixed(3)).join(' ');
      console.log('    同步幅度:               ' + aLine);
      // how many of the first 26 windows sit on 1900 and on 1200
      const near = (f, want) => Math.abs(f - want) < 80;
      console.log('    前 26 窗: 近1900 ' + seq.filter((s) => near(s.f, 1900)).length +
        ' 窗 · 近1200 ' + seq.filter((s) => near(s.f, 1200)).length + ' 窗');
    }
    out[name] = { sampleRate: sr, duration: i.duration, fileRms: fileRms, signalStart: start,
      sequence: seq, decodeOk: r.ok, mode: r.ok && r.mode ? r.mode.name : null };
    console.log('');
  }

  console.log('  判读：规格要求起点后依次出现 break(1200, 0.30s) → leader(1900, 0.30s) →');
  console.log('        VIS start(1200) → leader2(1900, 0.30s)。前 26 窗覆盖 ~0.65 s，应见 1200 段与 1900 段。');

  fs.writeFileSync(path.join(OUT, 'header-locate.json'), JSON.stringify(out, null, 2));
  console.log('\n证据 -> tests/diag-quality/header-locate.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
