/*
 * ============================ RESULT INVALIDATED - DO NOT USE ============================
 *
 * Two of this script's own control measurements are wrong, and it reports them:
 *
 *   - the 250 ms header-leader measurement reads 1863.25 Hz where the truth is 1900 Hz, a 37 Hz error;
 *   - the derived a = 1.274935 against the decoder's 1.000108.
 *
 * So its phigros header numbers are unusable. The internal-consistency IDEA is still worth having, but it
 * needs a probe that has passed tests/lib/measure-validate.js first, which this one has not.
 *
 * See the header of tests/diagnose-real-drift.js for the full account. The phase-49 statement that the
 * real recording's per-segment frequency offset is UNKNOWN still stands.
 * ========================================================================================
 *
 * Is the phigros recording's frequency calibration internally CONSISTENT?
 *
 * Three attempts to measure a per-segment frequency offset all failed to validate: each had a bias of
 * the same order as the effect it was claiming (the most recent read +94 Hz on a synthetic signal whose
 * true offset is 0.000 Hz, because a 10 ms window starting at the lock also contains the porch and the
 * start of the scan). So instead of trying to measure a number, this tests the assumption the
 * calibration RESTS on, which needs only two well-separated measurements and is therefore far easier to
 * validate.
 *
 * The decoder derives its affine calibration from the HEADER:
 *     a = (f_leader - f_break) / 700        b = f_leader - a * 1900
 * and then anchors the offset on the 300 ms 1900 Hz leader, deliberately, because the 1200 Hz sync is
 * under 3 cycles long and biased it by ~+18.6 Hz. That is sound for a recording whose frequency error is
 * constant. It breaks if the error is NOT constant, because the header is only the first 0.64 s of a
 * 110 s signal: the fit then describes the header and is applied to the body.
 *
 * The internal-consistency test: a clock/tuning error scales the WHOLE frequency axis, so the ratio
 * between two tones is invariant under it, while a constant OFFSET changes the ratio. Measuring the
 * 1900 Hz leader early and a 1200 Hz sync late and comparing their sum/difference against nominal says
 * whether one affine map can describe both ends of the recording - no absolute calibration needed, and
 * no dependence on any window that contains scan content, because both probes sit on long, isolated
 * header tones.
 *
 * Usage: node tests/diagnose-calibration-consistency.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Wav = globalThis.SSTVWav, Modes = globalThis.SSTVModes, Decode = globalThis.SSTVDecode;

/**
 * Frequency of the strongest tone in a band, by FFT peak with quadratic interpolation.
 *
 * Bins are ~0.73 Hz at 65536 samples, and the interpolation is accurate to a fraction of a bin for a
 * clean tone, which is the case for the header's 300 ms leaders.
 */
function peakIn(x, off, len, lo, hi) {
  const N = 65536;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) {
    const v = x[off + i] || 0;
    re[i] = v * 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
  }
  new globalThis.FFT(N).realTransform(o, re);
  const k0 = Math.max(1, Math.ceil(lo * N / SR)), k1 = Math.min(N / 2 - 1, Math.floor(hi * N / SR));
  let best = -1, bk = k0;
  for (let k = k0; k <= k1; k++) {
    const m = o[2 * k] * o[2 * k] + o[2 * k + 1] * o[2 * k + 1];
    if (m > best) { best = m; bk = k; }
  }
  const y0 = Math.hypot(o[2 * (bk - 1)], o[2 * (bk - 1) + 1]);
  const y1 = Math.hypot(o[2 * bk], o[2 * bk + 1]);
  const y2 = Math.hypot(o[2 * (bk + 1)], o[2 * (bk + 1) + 1]);
  const den = y0 - 2 * y1 + y2;
  const d = den === 0 ? 0 : 0.5 * (y0 - y2) / den;
  return (bk + d) * SR / N;
}

/**
 * The 1900 Hz leader tone inside the header.
 *
 * HDR geometry (same constants the decoder uses): break at 0.300 s, leader at 0.310 s, VIS start at
 * 0.610 s. The first leader runs 0.310-0.610 s = 300 ms and is pure 1900 Hz.
 */
function headerLeader(x, sr) {
  const LEADER_OFFSET = 0.010 + 0.300;          // 0.310
  const at = Math.round(LEADER_OFFSET * sr) + Math.round(0.020 * sr);
  const len = Math.round(0.25 * sr);
  return peakIn(x, at, len, 1700, 2100);
}

/** The 1200 Hz tone in the 30 ms VIS start bit, at 0.610 s: isolated, and still inside the header. */
function headerSync(x, sr) {
  const VIS_START = 0.300 + 0.310;              // 0.610
  const at = Math.round(VIS_START * sr) + Math.round(0.004 * sr);
  const len = Math.round(0.020 * sr);
  return peakIn(x, at, len, 1100, 1300);
}

(async function main() {
  console.log('=== 频率标定的内部一致性 ===\n');

  // ---- validation on synthetic audio, where the truth is known exactly ----
  require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
  const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
  const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = globalThis.SSTVSynth.synthesize(globalThis.SSTVTimeline.build(img, Modes.get('S1')), SR).samples;
  const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
  const freqShift = new Function('SR',
    SRC.slice(SRC.indexOf('function hilbertFIR'), SRC.indexOf('/** Decoder lock residuals')) +
    '\nreturn freqShift;')(SR);

  /*
   * The consistency statistic. For a pure TUNING error both tones shift by the same absolute amount, so
   * (f_leader - 1900) - (f_sync - 1200) = 0. For a pure CLOCK error both scale, so
   * f_leader/1900 = f_sync/1200. Reporting both residuals says which kind of error is present and how
   * large, without needing an absolute reference.
   */
  console.log('  [控制] 合成 S1，施加已知退化，检验统计量的响应：');
  console.log('    退化               f_leader    f_sync    绝对差残差  比例残差');
  const controls = [
    { label: '干净', fn: (s) => s },
    { label: '+100 Hz 平移', fn: (s) => freqShift(s, 100) },
    { label: '-100 Hz 平移', fn: (s) => freqShift(s, -100) },
    { label: '0.5% 重采样', fn: (s) => require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js')).Channel.freqOffset(s, 1.005) },
    { label: '+100 Hz 且 0.5%', fn: (s) => freqShift(require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js')).Channel.freqOffset(s, 1.005), 100) }
  ];
  for (const c of controls) {
    const sig = c.fn(clean);
    const fl = headerLeader(sig, SR), fs2 = headerSync(sig, SR);
    const absRes = (fl - 1900) - (fs2 - 1200);
    const ratRes = (fl / 1900 - fs2 / 1200) * 1900;
    console.log('    ' + c.label.padEnd(16) + ' ' + fl.toFixed(2).padStart(8) + '  ' +
      fs2.toFixed(2).padStart(8) + '  ' + absRes.toFixed(2).padStart(10) + '  ' + ratRes.toFixed(2).padStart(9));
  }
  console.log('\n    判读：纯调谐误差 → 绝对差残差 ≈ 0、比例残差 ≈ 偏移量；');
  console.log('          纯时钟误差 → 绝对差残差 ≈ 偏移量、比例残差 ≈ 0。两者都为 0 表示干净。');

  // ---- the real recording ----
  const pa = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  const buf = fs.readFileSync(pa);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const x = info.samples;
  console.log('\n  [实录音] phigros 头部两个长音的实测');
  const fl = headerLeader(x, info.sampleRate), fs2 = headerSync(x, info.sampleRate);
  console.log('    f_leader = ' + fl.toFixed(2) + ' Hz（标称 1900）· f_sync = ' + fs2.toFixed(2) +
    ' Hz（标称 1200）');
  console.log('    绝对差残差 = ' + ((fl - 1900) - (fs2 - 1200)).toFixed(2) +
    ' Hz · 比例残差 = ' + ((fl / 1900 - fs2 / 1200) * 1900).toFixed(2) + ' Hz');
  console.log('    头部单独推出的 a = ' + ((fl - 1200) / 700).toFixed(6) +
    ' · b = ' + (fl - (fl - 1200) / 700 * 1900).toFixed(2) + ' Hz');

  const d = await Decode.decode(x, info.sampleRate, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  if (d.ok) {
    console.log('    解码器采用的 a = ' + d.calibration.scale.toFixed(6) +
      ' · b = ' + d.calibration.offsetHz.toFixed(2) + ' Hz');
  }

  /* ---- what the decoder's own sync-frequency average says, per segment ---- */
  console.log('\n  [关键] 解码器标定预扫描测得的同步频率（全程 257 个脉冲），按段统计：');
  console.log('    该量由 alignSync 锁定位置 + est.peak 直接测得，不经过 10 ms 窗的污染。');
  const est = new Decode._internal.Estimator(info.sampleRate, 16);
  const refs = [];
  await Decode.decode(x, info.sampleRate, { quality: 'standard', yieldEvery: 0, postprocess: 'off', auditLineRefs: refs });
  const MODE = Modes.get('S1');
  const span = Math.max(8, Math.round(MODE.syncPulse * 0.5 * info.sampleRate));
  const half = Math.round(MODE.syncPulse * 0.25 * info.sampleRate);
  const perSeg = {};
  for (const r of refs) {
    if (r.freeRun) continue;
    const at = r.ref + half;
    if (at + span >= x.length) continue;
    const f = est.peak(x, at, span, null, 32768, 1100, 1350);
    const k = Math.floor(r.ref / info.sampleRate / 20) * 20;
    (perSeg[k] = perSeg[k] || []).push(f);
  }
  const keys = Object.keys(perSeg).map(Number).sort((a, b) => a - b);
  console.log('    时间窗(s)   行数   同步频率中位(Hz)   相对标称(Hz)   MAD(Hz)');
  const rows = [];
  for (const k of keys) {
    const v = perSeg[k].slice().sort((a, b) => a - b);
    const m = v[Math.floor(v.length / 2)];
    const mad = v.map((q) => Math.abs(q - m)).sort((a, b) => a - b)[Math.floor(v.length / 2)];
    rows.push({ t0: k, n: v.length, median: m, rel: m - 1200, mad: mad });
    console.log('    ' + (k + '-' + (k + 20)).padStart(10) + '   ' + String(v.length).padStart(4) +
      '   ' + m.toFixed(2).padStart(15) + '   ' + (m - 1200).toFixed(1).padStart(13) + '   ' +
      mad.toFixed(1).padStart(7));
  }
  const all = [].concat.apply([], keys.map((k) => perSeg[k])).sort((a, b) => a - b);
  console.log('\n    全程中位 ' + all[Math.floor(all.length / 2)].toFixed(2) + ' Hz · 相对标称 ' +
    (all[Math.floor(all.length / 2)] - 1200).toFixed(1) + ' Hz');
  console.log('    注意：该量在合成信号上有已知的 +18.6 Hz 偏置（源码注释记录），所以只有它的');
  console.log('          分段变化是有意义的，绝对值需减去该偏置。');

  fs.writeFileSync(path.join(__dirname, 'diag-quality', 'calibration-consistency.json'),
    JSON.stringify({ header: { leader: fl, sync: fs2 }, segments: rows,
      overallMedian: all[Math.floor(all.length / 2)] }, null, 2));
  console.log('\n证据 -> tests/diag-quality/calibration-consistency.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
