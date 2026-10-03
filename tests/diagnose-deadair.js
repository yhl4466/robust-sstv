/*
 * Is line 128's dead-air reading a LOCALISED dropout or SYSTEMATIC?
 *
 * The colour-loss dump showed all three slots of line 128 reading values that cannot be image content
 * (B and R pinned near 1050-1120 Hz, i.e. BELOW the 1200 Hz sync; G in a 25 Hz-wide band with 9000 Hz
 * spikes). Before concluding anything, two things must be separated:
 *   - is the recording locally devoid of signal around that time (a gap), or
 *   - are the slots systematically misplaced?
 *
 * It also corrects a bug in that dump: the standard layout is [sep][G][sep][B][SYNC][porch][R], so
 * relative to the sync, B spans [sync - scan, sync] and starts at -138.24 ms. The dumped script used
 * -(sep + scan) = -139.74 ms, one separator (1.5 ms) late - G and R were right, B was not.
 *
 * Usage: node tests/diagnose-deadair.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, FFT = globalThis.FFT;
const MODE = Modes.get('S1');
const SCAN = MODE.scanTime, SEP = MODE.sepPulse;
const PIXEL = SCAN / MODE.width * SR;
const WIN = Math.round(PIXEL * 2.48), PAD = 512;
const HANN = new Float64Array(WIN);
for (let i = 0; i < WIN; i++) HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (WIN - 1)));
const cache = {};
function freqAt(x, at) {
  let e = cache[PAD];
  if (!e) { e = { fft: new FFT(PAD), out: new Float32Array(2 * PAD), mags: new Float32Array(PAD / 2 + 1) }; cache[PAD] = e; }
  const data = new Float32Array(2 * PAD), half = WIN >> 1;
  for (let i = 0; i < WIN; i++) { const j = at - half + i; if (j >= 0 && j < x.length) data[2 * i] = x[j] * HANN[i]; }
  e.fft.realTransform(e.out, data);
  e.fft.completeSpectrum(e.out);
  const bins = PAD / 2 + 1, m = e.out, mags = e.mags;
  let tot = 0;
  for (let k = 0; k < bins; k++) { mags[k] = Math.sqrt(m[2 * k] * m[2 * k] + m[2 * k + 1] * m[2 * k + 1]); tot += mags[k]; }
  const lo = Math.max(1, Math.floor(1300 * PAD / SR)), hi = Math.min(bins - 2, Math.ceil(2500 * PAD / SR));
  let bk = lo, bv = -1;
  for (let k = lo; k <= hi; k++) if (mags[k] > bv) { bv = mags[k]; bk = k; }
  const y0 = mags[bk - 1], y1 = mags[bk], y2 = mags[bk + 1], d = y0 - 2 * y1 + y2;
  const sh = d === 0 ? 0 : 0.5 * (y0 - y2) / d;
  // prominence: peak vs the median bin, a crude "is there a tone here at all" indicator
  const srt = Array.prototype.slice.call(mags, lo, hi + 1).sort((a, b) => a - b);
  const med = srt[Math.floor(srt.length / 2)];
  return { hz: (bk + sh) * SR / PAD, prom: med > 0 ? bv / med : 0 };
}

(function main() {
  const b = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
  const info = Wav.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const x = info.samples;
  console.log('=== 死区 vs 系统性错位 ===\n');
  console.log('音频 ' + info.duration.toFixed(2) + ' s');

  // 1. broadband RMS profile -- where is there signal at all?
  console.log('\n[1] 逐秒 RMS（判断录音哪里有信号）');
  const secs = Math.floor(info.duration);
  const rms = [];
  for (let s = 0; s < secs; s++) {
    let acc = 0;
    for (let i = s * SR; i < (s + 1) * SR && i < x.length; i++) acc += x[i] * x[i];
    rms.push(Math.sqrt(acc / SR));
  }
  const mx = Math.max.apply(null, rms);
  let bar = '';
  for (let s = 0; s < secs; s++) {
    const q = rms[s] / mx;
    bar += q < 0.02 ? '.' : (q < 0.1 ? ':' : (q < 0.3 ? 'o' : '#'));
  }
  console.log('    ' + bar);
  console.log('    (. = <2% 峰值 · : = <10% · o = <30% · # = 更高; 共 ' + secs + ' 秒)');
  const dead = [];
  for (let s = 0; s < secs; s++) if (rms[s] / mx < 0.05) dead.push(s);
  console.log('    RMS < 5% 峰值的秒数: ' + dead.length + (dead.length
    ? '  区间: ' + compress(dead) : ''));

  // 2. decoder line refs over time
  const refs = [];
  Decode.decode(x, SR, { quality: 'fast', yieldEvery: 0, auditLineRefs: refs }).then((dec) => {
    const cal = dec.calibration || {};
    console.log('\n[2] 解码器逐行参考的时间分布');
    console.log('    clockScale=' + (cal.clockScale == null ? '-' : cal.clockScale.toFixed(6)) +
      ' · 行周期=' + (cal.clockScale * Modes.lineTime(MODE) * SR).toFixed(1));
    const t0 = refs[0].ref / SR, t1 = refs[refs.length - 1].ref / SR;
    console.log('    行 0 参考 ' + t0.toFixed(3) + ' s · 行 ' + (refs.length - 1) + ' 参考 ' + t1.toFixed(3) + ' s');
    const perRow = (t1 - t0) / (refs.length - 1);
    console.log('    平均行间隔 ' + (perRow * 1000).toFixed(3) + ' ms（标准 ' +
      (Modes.lineTime(MODE) * 1000).toFixed(2) + ' ms）');
    // 3. per-line "is there signal" -- RMS in each line's R slot region
    console.log('\n[3] 每行在 R 槽区域的 RMS（判断该行是否有信号）');
    const starts = { G: -(2 * SEP + 2 * SCAN) + SEP, B: -SCAN, R: (MODE.syncPulse + MODE.syncPorch) };
    const rows = []; 
    for (let i = 0; i < refs.length; i += 16) {
      const s0 = Math.round(refs[i].ref + starts.R * SR);
      let acc = 0, n = 0;
      for (let k = s0; k < s0 + Math.round(SCAN * SR) && k < x.length; k++) { acc += x[k] * x[k]; n++; }
      rows.push({ line: i, sec: refs[i].ref / SR, rms: n ? Math.sqrt(acc / n) : 0 });
    }
    const rmax = Math.max.apply(null, rows.map((r) => r.rms));
    console.log('    行号  时刻(s)   RMS    相对');
    for (const r of rows) {
      console.log('    ' + String(r.line).padStart(4) + ' ' + r.sec.toFixed(2).padStart(8) + ' ' +
        r.rms.toFixed(4).padStart(8) + ' ' + (r.rms / rmax).toFixed(2).padStart(5) +
        (r.rms / rmax < 0.15 ? '   ← 该行基本无信号' : ''));
    }

    // 4. corrected line dump on several lines
    console.log('\n[4] 修正 B 偏移后的 dump（若干行，前 8 像素）');
    for (const L of [32, 64, 96, 128, 160, 224]) {
      if (L >= refs.length) continue;
      console.log('  行 ' + L + ' (t=' + (refs[L].ref / SR).toFixed(2) + ' s):');
      for (const role of ['G', 'B', 'R']) {
        const s0 = Math.round(refs[L].ref + starts[role] * SR);
        let line = '';
        for (let px = 0; px < 8; px++) {
          const f = freqAt(x, Math.round(s0 + (px + 0.5) * PIXEL));
          line += f.hz.toFixed(0).padStart(6) + '(p' + f.prom.toFixed(1) + ')';
        }
        console.log('    ' + role + ' @' + s0 + ': ' + line);
      }
    }
    fs.writeFileSync(path.join(OUT, 'deadair.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), durationS: info.duration,
      rmsPerSecond: rms, deadSeconds: dead, correctedStarts: starts,
      decoderRefs: { first: t0, last: t1, meanIntervalMs: perRow * 1000 },
      perRowRms: rows
    }, null, 2));
    console.log('\n证据 -> tests/diag-quality/deadair.json');
  }).catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
})();

function compress(a) {
  const out = [];
  let s = a[0], p = a[0];
  for (let i = 1; i < a.length; i++) {
    if (a[i] === p + 1) { p = a[i]; continue; }
    out.push(s === p ? String(s) : s + '-' + p);
    s = p = a[i];
  }
  out.push(s === p ? String(s) : s + '-' + p);
  return out.join(', ');
}
