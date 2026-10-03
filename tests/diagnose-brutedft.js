/*
 * Brute-force DFT probe, and a head-to-head against the FFT probe, to fix the ruler at last.
 *
 * WHY
 *   Phase 36 established that the FFT-based probe is not merely inaccurate but IMPOSSIBLE: on our own
 *   synthetic S1, whose spectrum holds nothing below 1200 Hz, it reported ~730 Hz - about half the
 *   true value - with all three slots off by the same 0.4 Hz. A shared, factor-of-two-ish error in a
 *   common code path points at the FFT call itself, so this replaces the transform with a direct
 *   inner product over candidate frequencies and puts the two side by side on the same samples.
 *
 *   The candidate scan uses an incremental phasor rather than calling cos/sin inside the sample loop,
 *   which keeps a 1 Hz scan over 1000-2400 Hz cheap enough to run on all 256 lines x 3 slots.
 *
 * ORDER
 *   [1] synthetic S1, truth known: brute-force DFT must read 1500..2300 Hz, then the same samples
 *       through the FFT probe so the discrepancy is visible on identical input
 *   [2] only if [1] passes: the three slots inside transmission B on the real recording
 *
 * COMMAND LINE: --fft-only runs just the comparison.
 *
 * Usage: node tests/diagnose-brutedft.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline, Synth = globalThis.SSTVSynth,
      Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode, FFT = globalThis.FFT;
const MODE = Modes.get('S1');
const SCAN = MODE.scanTime, SEP = MODE.sepPulse;
const PIXEL = SCAN / MODE.width * SR;
const WINLEN = Math.round(PIXEL * 2.48);
const STARTS = { G: -(2 * SEP + 2 * SCAN) + SEP, B: -SCAN, R: (MODE.syncPulse + MODE.syncPorch) };

/** Hann window of length len, centred on `at`, zero outside the buffer. */
function windowAt(x, at, len) {
  const w = new Float64Array(len), half = len >> 1;
  for (let i = 0; i < len; i++) {
    const j = at - half + i;
    const h = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
    w[i] = (j >= 0 && j < x.length) ? x[j] * h : 0;
  }
  return w;
}

/**
 * Brute-force DFT: the magnitude of the inner product against exp(-j*2*pi*f*n/sr) for every candidate
 * frequency, taking the largest. The phasor is advanced by a fixed complex multiply instead of
 * recomputing cos/sin per sample, which is what makes a 1 Hz scan affordable.
 */
function bruteDFT(w, lo, hi, step) {
  let best = -1, bf = NaN;
  const dw = 2 * Math.PI * step / SR;
  const cStep = Math.cos(dw), sStep = Math.sin(dw);
  for (let f = lo; f <= hi; f += step) {
    let re = 0, im = 0;
    const w0 = 2 * Math.PI * f / SR;
    let c = Math.cos(w0), s = Math.sin(w0), ci = 1, si = 0;
    for (let i = 0; i < w.length; i++) {
      re += w[i] * ci;
      im -= w[i] * si;
      const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
    }
    const m = Math.sqrt(re * re + im * im);
    if (m > best) { best = m; bf = f; }
  }
  return { hz: bf, mag: best };
}

/** Two-stage scan: 4 Hz coarse then 0.25 Hz fine around the winner. */
function bruteDFT2(w, lo, hi) {
  const c = bruteDFT(w, lo, hi, 4);
  const f = bruteDFT(w, Math.max(lo, c.hz - 4), Math.min(hi, c.hz + 4), 0.25);
  return f;
}

const fftCache = {};
/** The phase-36 FFT probe, kept verbatim for the head-to-head. */
function fftProbe(x, at, len, lo, hi) {
  len = Math.max(8, Math.round(len));
  let n = 256; while (n < len) n <<= 1;
  let e = fftCache[n];
  if (!e) { e = { fft: new FFT(n), out: new Float32Array(2 * n) }; fftCache[n] = e; }
  const data = new Float32Array(2 * n);
  const H = new Float64Array(len);
  for (let i = 0; i < len; i++) H[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
  for (let i = 0; i < len; i++) {
    const j = at - (len >> 1) + i;
    if (j >= 0 && j < x.length) data[2 * i] = x[j] * H[i];
  }
  e.fft.realTransform(e.out, data);
  e.fft.completeSpectrum(e.out);
  const m = e.out, bins = n / 2 + 1;
  const kLo = Math.max(1, Math.ceil(lo * n / SR)), kHi = Math.min(bins - 2, Math.floor(hi * n / SR));
  const mag = (k) => Math.sqrt(m[2 * k] * m[2 * k] + m[2 * k + 1] * m[2 * k + 1]);
  let bk = kLo, bv = -1;
  for (let k = kLo; k <= kHi; k++) { const v = mag(k); if (v > bv) { bv = v; bk = k; } }
  const m0 = mag(bk - 1), m1 = bv, m2 = mag(bk + 1);
  const d = m0 - 2 * m1 + m2, sh = d === 0 ? 0 : 0.5 * (m0 - m2) / d;
  return { hz: (bk + sh) * SR / n, bin: bk, n: n, kLo: kLo, kHi: kHi };
}

function stats(a) {
  const f = a.filter((v) => isFinite(v));
  if (!f.length) return null;
  const s = f.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of s) sum += v;
  return { n: s.length, median: med, mad: mad, mean: sum / s.length, min: s[0], max: s[s.length - 1] };
}

function synthS1() {
  const w = MODE.width, h = MODE.height, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, v = Math.round(255 * x / (w - 1));
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return Synth.synthesize(Timeline.build({ data: data, width: w, height: h }, MODE), SR).samples;
}

(async function main() {
  console.log('=== 暴力 DFT 探针 ===\n');
  console.log('窗长 ' + WINLEN + ' 采样（像素 × 2.48）· 候选 1000–2400 Hz（两级扫描：4 Hz 粗 + 0.25 Hz 细）');

  // pure tone sanity, with the units written correctly this time
  console.log('\n[纯音自检]');
  console.log('  输入Hz  暴力DFT读出  误差    FFT探针读出  误差');
  let toneOk = true;
  for (const f of [1200, 1500, 1900, 2300]) {
    const x = new Float32Array(SR);
    for (let i = 0; i < SR; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR);
    const w = windowAt(x, SR >> 1, WINLEN);
    const d = bruteDFT2(w, 1000, 2400);
    const fp = fftProbe(x, SR >> 1, WINLEN, 1000, 2400);
    if (Math.abs(d.hz - f) > 5) toneOk = false;
    console.log('  ' + String(f).padStart(6) + ' ' + d.hz.toFixed(2).padStart(12) + ' ' +
      (d.hz - f).toFixed(2).padStart(7) + ' ' + fp.hz.toFixed(2).padStart(13) + ' ' +
      (fp.hz - f).toFixed(2).padStart(7) + '   (bin ' + fp.bin + '/' + fp.kLo + '..' + fp.kHi + ', n=' + fp.n + ')');
  }
  console.log('  => ' + (toneOk ? '暴力 DFT 通过 ✓' : '暴力 DFT 也错 ✗'));

  // ---------------------------------------------------------------- synthetic S1
  console.log('\n[任务 1/AC2] 合成 S1（真值 = 灰度斜坡，1500→2300 Hz）');
  const syn = synthS1();
  const synRefs = [];
  await Decode.decode(syn, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: synRefs });
  const L = 128;
  console.log('  第 ' + L + ' 行 px 0–7：');
  console.log('   px   真值Hz   暴力DFT   误差    FFT探针   误差');
  for (let px = 0; px < 8; px++) {
    const truth = 1500 + 800 * px / (MODE.width - 1);
    const at = Math.round(synRefs[L].ref + STARTS.G * SR + (px + 0.5) * PIXEL);
    const d = bruteDFT2(windowAt(syn, at, WINLEN), 1000, 2400);
    const fp = fftProbe(syn, at, WINLEN, 1000, 2400);
    console.log('  ' + String(px).padStart(3) + ' ' + truth.toFixed(1).padStart(8) + ' ' +
      d.hz.toFixed(1).padStart(9) + ' ' + (d.hz - truth).toFixed(1).padStart(7) + ' ' +
      fp.hz.toFixed(1).padStart(9) + ' ' + (fp.hz - truth).toFixed(1).padStart(7));
  }
  console.log('\n  全帧 320 px × 3 槽 的误差统计:');
  const errs = { dft: { G: [], B: [], R: [] }, fft: { G: [], B: [], R: [] } };
  for (let i = 0; i < synRefs.length; i++) {
    for (const role of ['G', 'B', 'R']) {
      const s0 = synRefs[i].ref + STARTS[role] * SR;
      for (let px = 0; px < MODE.width; px += 7) {
        const truth = 1500 + 800 * px / (MODE.width - 1);
        const at = Math.round(s0 + (px + 0.5) * PIXEL);
        errs.dft[role].push(Math.abs(bruteDFT2(windowAt(syn, at, WINLEN), 1000, 2400).hz - truth));
        errs.fft[role].push(Math.abs(fftProbe(syn, at, WINLEN, 1000, 2400).hz - truth));
      }
    }
  }
  for (const k of ['dft', 'fft']) {
    let all = [];
    for (const role of ['G', 'B', 'R']) {
      const st = stats(errs[k][role]);
      all = all.concat(errs[k][role]);
      console.log('    ' + k.toUpperCase() + ' ' + role + ' 槽: 平均误差 ' + st.mean.toFixed(1) +
        ' · 中位 ' + st.median.toFixed(1) + ' · 最大 ' + st.max.toFixed(1) + ' Hz');
    }
    const st = stats(all);
    console.log('    ' + k.toUpperCase() + ' 合计: 平均 ' + st.mean.toFixed(1) + ' · 最大 ' + st.max.toFixed(1) + ' Hz');
  }
  const dftStat = stats([].concat(errs.dft.G, errs.dft.B, errs.dft.R));
  const probeOk = dftStat.max < 30;
  console.log('  => 暴力 DFT ' + (probeOk ? '可读出真值 ✓ 探针已修好' : '仍偏离 ✗'));

  // ---------------------------------------------------------------- phigros (only if the probe is good)
  if (!probeOk) {
    console.log('\n[任务 2] 跳过：探针未通过合成校准，phigros 读数无意义');
  } else {
    console.log('\n[任务 2/AC4] phigros 传输 B 内部三槽（暴力 DFT，原始频率）');
    const pb = fs.readFileSync(path.join(OUT, 'new-rec-48k-mono.wav'));
    const pinfo = Wav.parse(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
    const px_ = pinfo.samples;
    const phRefs = [];
    const pdec = await Decode.decode(px_, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: phRefs });
    const cal = pdec.calibration || {};
    const calSync = (f) => (f - cal.offsetHz) / cal.scale;
    const rows = [];
    for (let i = 0; i < phRefs.length; i++) {
      const rec = {};
      for (const role of ['G', 'B', 'R']) {
        const s0 = phRefs[i].ref + STARTS[role] * SR, hs = [];
        for (let k = 0; k < 16; k++) {
          const px = Math.floor((k + 0.5) * MODE.width / 16);
          hs.push(bruteDFT2(windowAt(px_, Math.round(s0 + (px + 0.5) * PIXEL), WINLEN), 1000, 2400).hz);
        }
        const st = stats(hs);
        rec[role] = st ? st.median : NaN;
      }
      rows.push(rec);
    }
    console.log('  槽   原始中位Hz  MAD    极值            在1500–2300?  同步标定后中位');
    const slot = { G: rows.map((r) => r.G), B: rows.map((r) => r.B), R: rows.map((r) => r.R) };
    for (const role of ['G', 'B', 'R']) {
      const st = stats(slot[role]);
      const inb = slot[role].filter((f) => f >= 1500 && f <= 2300).length;
      const c = stats(slot[role].map(calSync));
      console.log('  ' + role + '  ' + st.median.toFixed(1).padStart(10) + ' ' + st.mad.toFixed(1).padStart(7) +
        '   ' + (st.min.toFixed(0) + '..' + st.max.toFixed(0)).padEnd(14) + ' ' +
        (inb + '/' + slot[role].length).padEnd(13) + ' ' + c.median.toFixed(1).padStart(13));
    }
    const gm = stats(slot.G).median, bm = stats(slot.B).median, rm = stats(slot.R).median;
    console.log('\n  三槽中位: G ' + gm.toFixed(1) + ' · B ' + bm.toFixed(1) + ' · R ' + rm.toFixed(1));
    console.log('  槽间差:  G-B ' + (gm - bm).toFixed(1) + ' · G-R ' + (gm - rm).toFixed(1) +
      ' · B-R ' + (bm - rm).toFixed(1) + ' Hz');
    const inBand = [gm, bm, rm].every((v) => v >= 1500 && v <= 2300);
    const nearSync = [gm, bm, rm].every((v) => Math.abs(v - 1200) < 300);
    const distinct = Math.max(Math.abs(gm - rm), Math.abs(gm - bm), Math.abs(bm - rm)) > 80;
    console.log('  => ' + (inBand ? '三槽都在图象带 1500–2300 内 ✓ → "没色"另有原因'
      : (nearSync ? '三槽都在【同步音 1200 附近】✗ → 槽位置错'
        : '三槽都在图象带之外（中位 ' + ((gm + bm + rm) / 3).toFixed(0) + ' Hz）✗')));
    console.log('  => 三槽是否互不相同: ' + (distinct ? '有区分 ✓' : '几乎相同 ✗'));
    fs.writeFileSync(path.join(OUT, 'brutedft.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), probeOk: probeOk,
      syntheticErrors: { dft: { G: stats(errs.dft.G), B: stats(errs.dft.B), R: stats(errs.dft.R) },
        fft: { G: stats(errs.fft.G), B: stats(errs.fft.B), R: stats(errs.fft.R) } },
      phigrosSlots: { G: stats(slot.G), B: stats(slot.B), R: stats(slot.R) },
      phigrosRows: rows, distinct: distinct, inBand: inBand, nearSync: nearSync
    }, null, 2));
    console.log('  证据 -> tests/diag-quality/brutedft.json');
  }
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
