/*
 * Calibrate the diagnostic pipeline BEFORE using it to measure anything.
 *
 * Phase 30 reported a 405.7 Hz mean error on a synthetic ramp whose truth is known, and a colour
 * fringe of 44.4 on a GREY image (R=G=B), so every grid conclusion in that round was provisional.
 * The suspected cause was a mirrored frequency axis (1500..2300 read as 2300..1500), which would put
 * the mean error near 400 Hz - suspiciously close to the measurement - but that was never verified.
 *
 * This settles it three ways, cheapest first:
 *   [1] pure tones at known frequencies -> does the tracker report them or their mirror?
 *   [2] the SHAPE of the ramp error      -> mirror vs constant offset vs scale error
 *                                          (truth 1500..2300; mirror => measured = 3800 - truth,
 *                                           offset => measured = truth + c,
 *                                           scale  => measured = 1900 + k*(truth - 1900))
 *   [3] three channels on a grey ramp    -> fringe should be ~0; if not, which channel differs
 *
 * Usage: node tests/diagnose-track-calibration.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Decode = globalThis.SSTVDecode;
const MODE = Modes.get('S1');
const PIXEL_SAMPLES = MODE.scanTime / MODE.width * SR;

/**
 * The tracker under test, EXACTLY as tests/diagnose-s1-quality.js has it.
 *
 * A phase-difference discriminator on a complex baseband at 1900 Hz:
 *   z = boxcarLP(x * exp(-j*2*pi*1900*n/sr))
 *   f = 1900 + atan2(Im(z*conj(z_prev)), Re(z*conj(z_prev))) * sr / (2*pi)
 */
function frequencyTrack(x, sr, lpMs, taps) {
  const CENTER = 1900;
  const lpLen = Math.round((lpMs / 1000) * sr) | 1;
  /*
   * s is NEGATED so the mixing is a true down-conversion by 1900 Hz. The recurrence below rotates
   * FORWARD from (1,0), so with s = +sin(w) this mixes UP and the discriminator reports the mirror
   * about 1900 Hz - which is exactly what the pure-tone test below detects.
   */
  const w = 2 * Math.PI * CENTER / sr, c = Math.cos(w), s = -Math.sin(w);
  const ringI = new Float64Array(lpLen), ringQ = new Float64Array(lpLen);
  let sumI = 0, sumQ = 0, ri = 0, ci = 1, si = 0, pI = 0, pQ = 0, have = false;
  const raw = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const nc = ci * c - si * s, ns = si * c + ci * s; ci = nc; si = ns;
    const mI = x[i] * ci, mQ = x[i] * si;
    sumI += mI - ringI[ri]; ringI[ri] = mI;
    sumQ += mQ - ringQ[ri]; ringQ[ri] = mQ;
    ri = (ri + 1) % lpLen;
    const I = sumI / lpLen, Q = sumQ / lpLen;
    if (have) {
      const re = I * pI + Q * pQ, im = Q * pI - I * pQ;
      raw[i] = Math.atan2(im, re) * sr / (2 * Math.PI);
    } else raw[i] = 0;
    pI = I; pQ = Q; have = true;
  }
  // group-delay-compensated, optionally averaged over `taps`
  const out = new Float64Array(x.length);
  const d = (lpLen - 1) / 2;
  for (let i = 0; i < x.length; i++) {
    let acc = 0, n = 0;
    for (let k = -taps; k <= taps; k++) {
      const j = i - Math.round(d) + k;
      if (j >= 0 && j < x.length) { acc += raw[j]; n++; }
    }
    out[i] = CENTER + (n ? acc / n : 0);
  }
  return out;
}

function tone(f, n, sr, amp) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (amp || 0.5) * Math.sin(2 * Math.PI * f * i / sr);
  return x;
}

/** Mean of a track inside [a,b) samples, skipping the filter's warm-up. */
function trackMean(tr, a, b) {
  let s = 0, n = 0;
  for (let i = a; i < b; i++) { if (isFinite(tr[i])) { s += tr[i]; n++; } }
  return n ? s / n : NaN;
}

function stats(a) {
  const s = a.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of s) sum += v;
  return { median: med, mad: mad, mean: sum / s.length, min: s[0], max: s[s.length - 1] };
}

(async function main() {
  console.log('=== 诊断管线标定（先修尺子）===\n');
  const HOP = 1;
  console.log('滤波器: 复基带 1900 Hz + 盒式低通; 报告已做群延迟补偿(减去 (len-1)/2)\n');

  // ---------------------------------------------------------------- [1] pure tones
  console.log('[1] 纯音响应（判决性：报告值还是镜像值 3800−f）');
  console.log('    输入 Hz    报告 Hz     与输入之差   与镜像之差   结论');
  const pure = [1200, 1500, 1700, 1900, 2100, 2300, 2500];
  let mirrored = 0, straight = 0;
  for (const f of pure) {
    const x = tone(f, SR, SR);
    for (const lp of [1.0]) {
      const tr = frequencyTrack(x, SR, lp, 2);
      const m = trackMean(tr, SR * 0.2, SR * 0.9);
      const dIn = m - f, dMir = m - (2 * 1900 - f);
      const verdict = Math.abs(dIn) < Math.abs(dMir) ? '正常 ✓' : '镜像 ✗';
      if (verdict === '正常 ✓') straight++; else mirrored++;
      console.log('    ' + String(f).padStart(6) + ' ' + m.toFixed(2).padStart(11) + ' ' +
        dIn.toFixed(2).padStart(12) + ' ' + dMir.toFixed(2).padStart(12) + '   ' + verdict);
    }
  }
  console.log('    => ' + (mirrored === 0
    ? '全部正常：【符号反向假设被排除】✓ 405.7 Hz 误差另有原因'
    : mirrored + ' 个呈镜像：【符号反向确认】✗'));

  // ---------------------------------------------------------------- [2] ramp error shape
  console.log('\n[2] 合成斜坡的误差形状（决定性：镜像/偏移/标度）');
  const w = MODE.width, h = MODE.height, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = Math.round(255 * x / (w - 1));
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const tl = Timeline.build({ data: data, width: w, height: h }, MODE);
  const samples = Synth.synthesize(tl, SR).samples;
  const refs = [];
  await Decode.decode(samples, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  const trk = frequencyTrack(samples, SR, 1.0, 2);
  const STD = { G: -(2 * MODE.sepPulse + 2 * MODE.scanTime) * 1000 + MODE.sepPulse * 1000,
    B: -(MODE.sepPulse + MODE.scanTime) * 1000, R: (MODE.syncPulse + MODE.syncPorch) * 1000 };
  const L = 128, ref = refs[L].ref;
  console.log('    行 ' + L + ' 同步 ' + ref + ' · G 起点偏移 ' + STD.G.toFixed(2) + ' ms');
  console.log('     px     真值 Hz    测量 Hz     误差 Hz');
  const errs = [], pairs = [];
  for (let x = 0; x < w; x += 29) {
    const want = 1500 + Math.round(255 * x / (w - 1)) * 800 / 255;
    const at = Math.round(ref + STD.G / 1000 * SR + (x + 0.5) * PIXEL_SAMPLES);
    const got = trk[at];
    errs.push(got - want); pairs.push({ x: x, truth: want, measured: got });
    console.log('    ' + String(x).padStart(4) + ' ' + want.toFixed(1).padStart(11) + ' ' +
      got.toFixed(1).padStart(11) + ' ' + (got - want).toFixed(1).padStart(11));
  }
  const es = stats(errs);
  // mirror / offset / scale fits
  let best = null;
  for (const model of ['offset', 'mirror', 'scale']) {
    let sa = 0, sb = 0;
    if (model === 'offset') { sb = es.mean; }
    else if (model === 'mirror') { sa = -1; sb = 2 * 1900; }
    else {
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of pairs) { const u = p.truth - 1900; n++; sx += u; sy += p.measured; sxx += u * u; sxy += u * p.measured; }
      sa = (n * sxy - sx * sy) / (n * sxx - sx * sx); sb = (sy - sa * sx) / n;
    }
    let ss = 0;
    for (const p of pairs) { const pred = model === 'mirror' ? 2 * 1900 - p.truth : (sa * p.truth + sb); ss += (p.measured - pred) * (p.measured - pred); }
    const rms = Math.sqrt(ss / pairs.length);
    console.log('    模型 ' + model.padEnd(7) + ' 残差 RMS ' + rms.toFixed(2) + ' Hz');
    if (!best || rms < best.rms) best = { model: model, rms: rms, a: sa, b: sb };
  }
  console.log('    误差统计: 均值 ' + es.mean.toFixed(1) + ' · 中位 ' + es.median.toFixed(1) +
    ' · MAD ' + es.mad.toFixed(1) + ' · 极值 ' + es.min.toFixed(0) + '..' + es.max.toFixed(0) + ' Hz');
  console.log('    => 最佳拟合模型: 【' + best.model + '】 残差 RMS ' + best.rms.toFixed(2) +
    ' Hz' + (best.model === 'scale' ? '  a=' + best.a.toFixed(4) + ' b=' + best.b.toFixed(1) : ''));

  // ---------------------------------------------------------------- [3] three channels on grey
  console.log('\n[3] 三通道在灰度斜坡上的一致性（色边应 ≈0）');
  const plane = {};
  for (const role of ['G', 'B', 'R']) {
    plane[role] = [];
    for (const r of refs) {
      const row = new Float64Array(w);
      const start = r.ref + STD[role] / 1000 * SR;
      for (let px = 0; px < w; px++) row[px] = trk[Math.round(start + (px + 0.5) * PIXEL_SAMPLES)];
      plane[role].push(row);
    }
  }
  const grey = (v) => Math.max(0, Math.min(255, Math.round(255 * (v - 1500) / 800)));
  let fringe = 0, n = 0, maxF = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = grey(plane.G[y][x]), b = grey(plane.B[y][x]), r = grey(plane.R[y][x]);
      const f = Math.max(g, b, r) - Math.min(g, b, r);
      fringe += f; if (f > maxF) maxF = f; n++;
    }
  }
  console.log('    色边均值 ' + (fringe / n).toFixed(2) + ' · 最大 ' + maxF + ' 灰阶');
  for (const role of ['G', 'B', 'R']) {
    let mn = 1e9, mx = -1e9, s = 0, c = 0;
    for (const row of plane[role]) for (const v of row) { if (v < mn) mn = v; if (v > mx) mx = v; s += v; c++; }
    console.log('    ' + role + ' 平面: 均值 ' + (s / c).toFixed(1) + ' Hz · 极值 ' + mn.toFixed(0) + '..' + mx.toFixed(0));
  }
  console.log('    => 三通道若均值相近则颜色本身一致；色边>5 说明存在逐像素差异');

  fs.writeFileSync(path.join(__dirname, 'diag-quality', 'track-calibration.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    pureTones: { verdict: mirrored === 0 ? 'no-inversion' : 'inverted', mirroredCount: mirrored },
    rampError: { stats: es, bestModel: best, samples: pairs },
    greyFringe: { meanFringe: fringe / n, maxFringe: maxF }
  }, null, 2));
  console.log('\n证据 -> tests/diag-quality/track-calibration.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
