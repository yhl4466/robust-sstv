/*
 * AC4: how far is each of the decoder's per-line sync locks from the TRUE sync pulse?
 *
 * WHY A SECOND SCRIPT
 *   tests/audit-line-start.js already reports this, but its headline number ("Δ 相对【前一个】真值
 *   同步", median 20419) is dominated by the gap BETWEEN the recording's two transmissions: every
 *   decoder reference after the gap has a "previous truth sync" from before the gap, so a pairing
 *   artefact of one whole transmission (20419 samples) swamps the quantity we care about. The
 *   nearest-sync distance it prints is the robust one, so this script recomputes exactly that and
 *   reports its distribution properly, plus the residual after removing each recording segment's small
 *   constant offset - because a constant offset is harmless (the demodulator re-locks every line)
 *   while a varying one blurs.
 *
 * Usage: node tests/probe-sync-miss.js [audio]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AUDIO = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

const MODE = Modes.get('S1');
/* One pixel of the S1 scan, in SAMPLES at the recording's rate: the whole point of reporting
 * deviations in pixels is that this is the scale a blur is visible on. */
const PIXEL = MODE.scanTime / MODE.width * 48000;

/** Quadrature envelope at one frequency, decimated to 1 ms bins (same detector as audit-line-start). */
function envelope(x, sr, freq, decim, tauMs) {
  const w = 2 * Math.PI * freq / sr, c = Math.cos(w), s = Math.sin(w);
  const a = Math.exp(-1 / (sr * (tauMs || 2) / 1000));
  const n = Math.floor(x.length / decim), o = new Float32Array(n);
  let ci = 1, si = 0, I = 0, Q = 0, oi = 0;
  for (let i = 0; i < x.length; i++) {
    const nci = ci * c - si * s, nsi = si * c + ci * s; ci = nci; si = nsi;
    const v = x[i];
    I = a * I + (1 - a) * (v * ci); Q = a * Q + (1 - a) * (v * si);
    if (i % decim === 0 && oi < n) o[oi++] = Math.sqrt(I * I + Q * Q);
  }
  return o;
}

function findBursts(target, others, msPerBin, minMs, maxMs, k) {
  const out = [];
  let run = -1;
  for (let i = 0; i < target.length; i++) {
    let rival = 0;
    for (const o of others) if (o[i] > rival) rival = o[i];
    const on = target[i] > k * Math.max(rival, 1e-4);
    if (on && run < 0) run = i;
    else if (!on && run >= 0) {
      const ms = (i - run) * msPerBin;
      if (ms >= minMs && ms <= maxMs) out.push({ start: run * msPerBin / 1000, ms: ms });
      run = -1;
    }
  }
  return out;
}

function gridFilter(pulses, periodMs, tolMs, candidates) {
  const n = Math.min(candidates || 60, pulses.length);
  let best = null;
  for (let i = 0; i < n; i++) {
    const t0 = pulses[i].start, inliers = [];
    for (const p of pulses) {
      const k = Math.round((p.start - t0) * 1000 / periodMs);
      if (Math.abs(p.start - (t0 + k * periodMs / 1000)) * 1000 <= tolMs) inliers.push(p);
    }
    if (!best || inliers.length > best.inliers.length) best = { t0: t0, inliers: inliers };
  }
  return best;
}

function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  const med = q(0.5);
  const mad = a.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(a.length / 2)];
  let sum = 0; for (const v of a) sum += v;
  const mean = sum / a.length;
  let v2 = 0; for (const v of a) v2 += (v - mean) * (v - mean);
  return { n: a.length, median: med, mad: mad, mean: mean, sd: Math.sqrt(v2 / a.length),
    p05: q(0.05), p95: q(0.95), min: s[0], max: s[s.length - 1] };
}

(async function main() {
  if (!fs.existsSync(AUDIO)) { console.log('missing ' + AUDIO); process.exitCode = 1; return; }
  const buf = fs.readFileSync(AUDIO);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const x = info.samples, sr = info.sampleRate;
  const decim = Math.round(sr / 1000), msPerBin = 1000 * decim / sr;

  console.log('=== 同步锁定偏离（AC4）===');
  console.log('音频: ' + path.relative(ROOT, AUDIO) + '  ' + sr + ' Hz, ' + info.duration.toFixed(2) + ' s');
  console.log('S1 像素 = ' + PIXEL.toFixed(2) + ' 采样\n');

  // ---- truth syncs
  const e12 = envelope(x, sr, 1200, decim, 2);
  const e15 = envelope(x, sr, 1500, decim, 2);
  const e19 = envelope(x, sr, 1900, decim, 2);
  const e23 = envelope(x, sr, 2300, decim, 2);
  const syncs = findBursts(e12, [e15, e19, e23], msPerBin, 4, 18, 1.4);
  const grids = [428.220, 428.000].map((p) => {
    const segs = []; let cur = [syncs[0]];
    for (let i = 1; i < syncs.length; i++) {
      if ((syncs[i].start - syncs[i - 1].start) * 1000 > 2 * p) { segs.push(cur); cur = []; }
      cur.push(syncs[i]);
    }
    if (cur.length) segs.push(cur);
    const kept = [];
    for (const s of segs.filter((s) => s.length >= 8)) kept.push.apply(kept, gridFilter(s, p, 2.0, Math.min(40, s.length)).inliers);
    kept.sort((a, b) => a.start - b.start);
    return { period: p, inliers: kept };
  });
  const chosen = grids.slice().sort((a, b) => b.inliers.length - a.inliers.length)[0];
  const truth = chosen.inliers.map((s) => Math.round(s.start * sr));
  console.log('真值同步: ' + syncs.length + ' 检出 → 栅格 ' + chosen.period + ' ms 保留 ' + truth.length + ' 个');

  // ---- decoder refs
  const refs = [];
  const t0 = Date.now();
  const dec = await Decode.decode(x, sr, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  console.log('解码: ok=' + dec.ok + ' ' + (dec.mode && dec.mode.name) + ' · ' + refs.length +
              ' 行 · imageStart=' + dec.calibration.imageStart + ' · ' +
              ((Date.now() - t0) / 1000).toFixed(1) + ' s\n');
  if (!dec.ok || !refs.length) { process.exitCode = 1; return; }

  // ---- nearest-truth distance. A constant offset is harmless; the SPREAD is what blurs.
  const miss = [], missAbs = [], exact = [];
  let beyond = 0;
  for (const r of refs) {
    if (r.freeRun) continue;                       // no lock was taken on that line
    let bestD = null, bestT = null;
    for (const t of truth) {
      const d = r.ref - t;
      if (bestD === null || Math.abs(d) < Math.abs(bestD)) { bestD = d; bestT = t; }
    }
    // only trust a pairing that is inside half a line, otherwise it is a pairing artefact
    if (bestD !== null && Math.abs(bestD) < 0.5 * MODE.scanTime * sr * 3) {
      miss.push(bestD); missAbs.push(Math.abs(bestD)); exact.push({ line: r.line, ref: r.ref, truth: bestT, d: bestD });
    } else beyond++;
  }
  for (const d of missAbs) if (d > 300) beyond++;

  const st = stats(missAbs);
  const sd = stats(miss);
  console.log('锁定行数           ' + miss.length + ' / ' + refs.length + '  (配对超出半行而剔除 ' + beyond + ')');
  console.log('|偏离| 中位        ' + st.median.toFixed(1) + ' 采样 = ' + (st.median / PIXEL).toFixed(2) + ' 像素');
  console.log('|偏离| 均值        ' + st.mean.toFixed(1) + ' 采样 · 标准差 ' + st.sd.toFixed(1));
  console.log('|偏离| p05..p95    ' + st.p05.toFixed(0) + ' .. ' + st.p95.toFixed(0) + ' 采样');
  console.log('|偏离| MAD         ' + st.mad.toFixed(1) + ' 采样 = ' + (st.mad / PIXEL).toFixed(2) + ' 像素');
  console.log('带符号偏离 中位    ' + sd.median.toFixed(1) + ' 采样 · 标准差 ' + sd.sd.toFixed(1));
  console.log('');
  const over = missAbs.filter((v) => v > 300).length;
  console.log('AC4 判据: |偏离| 中位 ' + st.median.toFixed(1) + ' < 300  → ' +
              (st.median < 300 ? '通过 ✓' : '未通过 ✗'));
  console.log('          超出 300 采样的行数 ' + over + ' / ' + missAbs.length +
              ' (' + (100 * over / missAbs.length).toFixed(1) + '%)');
  const sortedOver = missAbs.slice().sort((a, b) => b - a).slice(0, 8);
  console.log('          最大的 8 个 |偏离|: ' + sortedOver.map((v) => v.toFixed(0)).join(', '));

  // per-line delta to the PREVIOUS decoder reference: isolates the row-to-row jitter that blurs.
  const jit = [];
  for (let i = 1; i < exact.length; i++) {
    if (exact[i].line === exact[i - 1].line + 1) jit.push(Math.abs(exact[i].d - exact[i - 1].d));
  }
  const js = stats(jit);
  console.log('          相邻行偏离变化 中位 ' + js.median.toFixed(1) + ' 采样 (' +
              (js.median / PIXEL).toFixed(2) + ' 像素) · 均值 ' + js.mean.toFixed(1));

  fs.writeFileSync(path.join(__dirname, 'diag-quality', 'sync-miss.json'),
    JSON.stringify({ audio: path.relative(ROOT, AUDIO).replace(/\\/g, '/'), sampleRate: sr,
      pixelSamples: PIXEL, truthPulses: truth.length, decoderRows: refs.length,
      lockedRows: miss.length, missAbsStats: st, missSignedStats: sd,
      over300: over, over300Pct: 100 * over / missAbs.length,
      maxAbs: sortedOver, rowToRowJitter: js,
      sample: exact.slice(0, 20) }, null, 2));
  console.log('\n证据 -> tests/diag-quality/sync-miss.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
