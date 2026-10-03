/*
 * Line-start reconciliation: where does the demodulator ACTUALLY lock, against the truth?
 *
 * WHY
 *   Phase 23 exonerated the channel offsets with a black-box probe. The remaining unverified
 *   hypothesis is the line-start correction: slowrx's Scottie branch turns a mid-line sync detection
 *   into a line start with `s - chan_len/2 + 2*porch`, while ours rewinds by
 *   `chanOffsets[chanSync] + scanTime`. On our own audio the net result is provably correct, but on a
 *   real recording the sync DETECTION itself may lock somewhere else - and that is what this measures.
 *
 * HOW
 *   1. Independently detect the true 1200 Hz sync pulses in the audio (no decoder involved).
 *   2. Independently detect the true 1500 Hz separator pulses, which also settles whether the real
 *      recording carries separators at all (the encoder does emit them; phase 22 wrongly said it
 *      did not).
 *   3. Ask the decoder for the per-line reference it locked onto, via the opt-in `auditLineRefs`
 *      sink (null by default, so the normal path is untouched).
 *   4. Line-by-line difference, plus a regression for drift.
 *
 * Usage: node tests/audit-line-start.js [audio]      default: the phigros mono cache
 *        node tests/audit-line-start.js --self       control: our own S1 encoder output
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-intraline');
const SELF = process.argv.indexOf('--self') >= 0;
const AUDIO = SELF
  ? path.join(OUT, 'audit-self-s1.wav')
  : (process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav'));

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

const MODE = Modes.get('S1');
const SR = 48000;
const LINE_MS = 1000 * ((MODE.syncPulse || 0) + (MODE.syncPorch || 0) +
  MODE.channels * MODE.scanTime + (MODE.chanSync || 0) * (MODE.sepPulse || 0));
const PIXEL_SAMPLES = MODE.scanTime / MODE.width * SR;          // 20.74 samples
const PORCH_SAMPLES = MODE.syncPorch * SR;                      // 72
const HALF_CHAN_SAMPLES = (MODE.sepPulse + MODE.scanTime) * SR / 2;  // 3354
const LINE_START_TO_SYNC = (2 * MODE.sepPulse + 2 * MODE.scanTime) * SR; // from line start to sync

/** Quadrature envelope at one frequency, decimated to 1 ms bins. */
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

/**
 * Short tone bursts of a TARGET tone that is also the locally STRONGEST tone.
 *
 * The first version compared the target against (1900+2300)/2. On the control image - a grey ramp,
 * so its content sweeps down to 1500 Hz at the left edge - 1900/2300 are quiet there and the 1200 Hz
 * envelope cleared the threshold on content alone: it reported 588 "syncs" with a 152 ms median
 * interval instead of 428.22 ms. Requiring the target to beat every competing tone is specific to a
 * real sync/separator pulse and cannot be satisfied by image content.
 */
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

/**
 * RANSAC-style grid fit over the detected pulses.
 *
 * The detector fires on image content as well as on syncs (music is broadband), so the raw stream on
 * the real recording carries ~43 spurious pulses. Independent nearest-neighbour pairing then flips to
 * the wrong pulse on some rows and the delta distribution goes bimodal. Fitting a fixed-period grid
 * and keeping only inliers removes that. The candidate phase is CHOSEN, not assumed: each of the
 * first N pulses is tried as the grid origin and the one with the most inliers wins.
 */
function gridFilter(pulses, periodMs, tolMs, candidates) {
  const n = Math.min(candidates || 60, pulses.length);
  let best = null;
  for (let i = 0; i < n; i++) {
    const t0 = pulses[i].start;
    const inliers = [];
    for (const p of pulses) {
      const k = Math.round((p.start - t0) * 1000 / periodMs);
      const pred = t0 + k * periodMs / 1000;
      if (Math.abs(p.start - pred) * 1000 <= tolMs) inliers.push(p);
    }
    if (!best || inliers.length > best.inliers.length) best = { t0: t0, inliers: inliers };
  }
  best.outliers = pulses.filter((p) => best.inliers.indexOf(p) < 0);
  return best;
}

function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mad = s.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(s.length / 2)];
  let sum = 0; for (const v of s) sum += v;
  const mean = sum / s.length;
  let v2 = 0; for (const v of s) v2 += (v - mean) * (v - mean);
  return { n: s.length, median: med, mad: mad, mean: mean, sd: Math.sqrt(v2 / s.length),
    min: s[0], max: s[s.length - 1] };
}

function linreg(ys) {
  const n = ys.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const d = n * sxx - sx * sx;
  const slope = d === 0 ? 0 : (n * sxy - sx * sy) / d;
  const inter = (sy - slope * sx) / n;
  let ss = 0, st = 0; const my = sy / n;
  for (let i = 0; i < n; i++) {
    const p = inter + slope * i; ss += (ys[i] - p) * (ys[i] - p); st += (ys[i] - my) * (ys[i] - my);
  }
  return { slope: slope, inter: inter, r2: st === 0 ? 0 : 1 - ss / st };
}

/** Build the control audio (our own S1 encoder output) if asked for. */
function buildSelfAudio() {
  const w = MODE.width, h = MODE.height;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = Math.round(255 * x / (w - 1));
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const tl = Timeline.build({ data: data, width: w, height: h }, MODE);
  const syn = Synth.synthesize(tl, SR);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(AUDIO, Wav.encode(syn.samples, SR));
  return tl;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (SELF && !fs.existsSync(AUDIO)) buildSelfAudio();
  if (!fs.existsSync(AUDIO)) {
    console.log('missing ' + AUDIO + ' - run node tests/diagnose-timing.js first, or pass --self');
    process.exitCode = 1; return;
  }

  const buf = fs.readFileSync(AUDIO);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const x = info.samples, sr = info.sampleRate;
  const decim = Math.round(sr / 1000), msPerBin = 1000 * decim / sr;

  console.log('=== 行首定位对账 ===\n');
  console.log('音频   : ' + path.relative(ROOT, AUDIO) + (SELF ? '   (对照组：我们自己的 S1 编码输出)' : '   (真实录音)'));
  console.log('        ' + sr + ' Hz, ' + info.duration.toFixed(3) + ' s');
  console.log('S1 几何: 行 ' + LINE_MS.toFixed(2) + ' ms · 像素 ' + PIXEL_SAMPLES.toFixed(2) + ' 采样 · ' +
    'porch ' + PORCH_SAMPLES.toFixed(0) + ' 采样 · 行首→同步 ' + LINE_START_TO_SYNC.toFixed(0) + ' 采样');

  // ------------------------------------------------------------ 1. true syncs
  const e12 = envelope(x, sr, 1200, decim, 2);
  const e15 = envelope(x, sr, 1500, decim, 2);
  const e19 = envelope(x, sr, 1900, decim, 2);
  const e23 = envelope(x, sr, 2300, decim, 2);
  const others = [e15, e19, e23];
  const syncs = findBursts(e12, others, msPerBin, 4, 18, 1.4);
  console.log('\n[1] 真值同步脉冲（独立检测，1200 Hz）: ' + syncs.length + ' 个');
  const syncDiff = [];
  for (let i = 1; i < syncs.length; i++) {
    const d = (syncs[i].start - syncs[i - 1].start) * 1000;
    if (d > 4 && d < 2000) syncDiff.push(d);
  }
  const ss = stats(syncDiff);
  if (ss) {
    console.log('    间隔中位 ' + ss.median.toFixed(3) + ' ms · MAD ' + ss.mad.toFixed(3) +
      ' ms · 标准 ' + LINE_MS.toFixed(2) + ' ms · 偏差 ' + (((ss.median / LINE_MS) - 1) * 100).toFixed(3) + '%');
  }

  // ------------------------------------------------------------ 2. true separators
  /*
   * Separators are 1.5 ms of 1500 Hz sitting immediately before each scan. Detecting them answers
   * two things: whether the real recording carries them, and where the scans truly begin.
   */
  const seps = findBursts(e15, [e12, e19, e23], msPerBin, 0.6, 4, 1.3);
  console.log('\n[2] 真值分隔脉冲（独立检测，1500 Hz 短脉冲 1–3 ms）: ' + seps.length + ' 个');
  /* Hit rate: fraction of separators predicted adjacent to a detected sync (within one line). */
  if (syncs.length && seps.length) {
    let near = 0;
    for (const s of seps) {
      const best = syncs.reduce((m, y) => Math.min(m, Math.abs(y.start - s.start)), 1e9);
      if (best < LINE_MS / 1000 * 1.2) near++;
    }
    console.log('    与某个同步脉冲同线（< 1.2 行）的比例: ' + (100 * near / seps.length).toFixed(1) + '%');
  }
  const sepMs = seps.length ? stats(seps.map((s) => s.ms)) : null;
  if (sepMs) {
    console.log('    实测宽度 中位 ' + sepMs.median.toFixed(2) + ' ms（标准 ' +
      (MODE.sepPulse * 1000).toFixed(2) + ' ms）');
    console.log('    => ' + (Math.abs(sepMs.median - MODE.sepPulse * 1000) < 0.8
      ? '宽度与标准相符，真实录音【有】分隔脉冲 ✓（故情况 C 不成立）'
      : '宽度与标准不符，需谨慎解读'));
  } else {
    console.log('    => 未检出分隔脉冲 —— 真实录音可能【没有】分隔（情况 C 的线索）');
  }

  // ------------------------------------------------------------ 3. decoder per-line refs
  const refs = [];
  const t0 = Date.now();
  const dec = await Decode.decode(x, sr, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
  const cal = dec.calibration || {};
  console.log('\n[3] 解码器逐行参考位置（opt-in 钩子）');
  console.log('    ok=' + dec.ok + ' 模式=' + (dec.mode && dec.mode.name) + ' 记录到 ' + refs.length + ' 行' +
    '  imageStart=' + (cal.imageStart == null ? '-' : cal.imageStart) +
    '  clockScale=' + (cal.clockScale == null ? '-' : cal.clockScale.toFixed(5)) +
    '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  if (!dec.ok || !refs.length) { console.log('    无逐行数据，无法对账'); process.exitCode = 1; return; }

  // ------------------------------------------------------------ 4. reconcile
  /*
   * The decoder's reference is the position it locked the SYNC onto, so it should line up with a
   * true sync pulse. The true sync stream may sit at a different line index than the decoder's row
   * numbering, so the first pairing is found by nearest neighbour and the rest follow consecutively.
   */
  /*
   * Pair EACH decoder reference with its own nearest true sync. The first version searched only the
   * first 40 syncs for a match to reference #0 and then advanced both streams together: on phigros
   * the decoder locks at 107 s (true sync index ~250), so the pairing started 94 s off and every
   * delta inherited that constant. Independent nearest-neighbour pairing also answers the more
   * useful question directly - is the decoder locking onto a real sync pulse at all?
   */
  const refSamples = refs.map((r) => r.ref);

  // ---- grid cleaning (RANSAC), both candidate periods, before any reconciliation ----------------
  console.log('\n[4] 真值脉冲流清理（栅格 RANSAC）');
  const rawDiffs = [];
  for (let i = 1; i < syncs.length; i++) {
    const d = (syncs[i].start - syncs[i - 1].start) * 1000;
    if (d > 4 && d < 2000) rawDiffs.push(d);
  }
  const rawSt = stats(rawDiffs);
  console.log('    清理前: ' + syncs.length + ' 个脉冲 · 间隔中位 ' +
    (rawSt ? rawSt.median.toFixed(3) : '-') + ' ms · MAD ' + (rawSt ? rawSt.mad.toFixed(3) : '-') + ' ms');
  /*
   * Two candidate periods. Both phase-twenty and phase-twenty-four measured the real recording's
   * line period as 428.000 ms, i.e. 0.05% shorter than the nominal 428.22; building the grid on the
   * nominal value accumulates 0.13 lines of phase error over 256 rows and would reject good tail
   * pulses. Both are run and reported rather than assumed.
   */
  const expectedCount = info.duration / 0.428;
  /*
   * Per-segment grid fit.
   *
   * A single grid cannot span a recording that holds TWO transmissions separated by a gap: the phase
   * that fits the first segment rejects most of the second (phigros: only 137 of 557 pulses kept, and
   * the surviving set was one segment, which then made every "previous sync" the same pulse and
   * produced a bogus R^2 = 1.0 drift). The stream is therefore split wherever the gap exceeds two
   * periods, and each segment is fitted on its own.
   */
  function segmentPulses(pulses, periodMs) {
    const segs = [];
    let cur = [pulses[0]];
    for (let i = 1; i < pulses.length; i++) {
      if ((pulses[i].start - pulses[i - 1].start) * 1000 > 2 * periodMs) { segs.push(cur); cur = []; }
      cur.push(pulses[i]);
    }
    if (cur.length) segs.push(cur);
    return segs.filter((s) => s.length >= 8);
  }

  const grids = [428.220, 428.000].map((p) => {
    const segs = segmentPulses(syncs, p);
    const kept = [];
    const perSeg = [];
    for (const s of segs) {
      const g = gridFilter(s, p, 2.0, Math.min(40, s.length));
      kept.push.apply(kept, g.inliers);
      perSeg.push({ n: s.length, kept: g.inliers.length });
    }
    kept.sort((a, b) => a.start - b.start);
    const dif = [];
    for (let i = 1; i < kept.length; i++) {
      const d = (kept[i].start - kept[i - 1].start) * 1000;
      if (d > 4 && d < 2 * p) dif.push(d);
    }
    return { period: p, inliers: kept, outliers: syncs.filter((x) => kept.indexOf(x) < 0),
      st: stats(dif), segs: segs.length, perSeg: perSeg };
  });
  console.log('    分段: 按间隔 > 2×周期 切分');
  for (const x of grids) {
    console.log('    栅格 ' + x.period.toFixed(3) + ' ms: ' + x.segs + ' 段 (' +
      x.perSeg.map((s) => s.kept + '/' + s.n).join(', ') + ') → 保留 ' + x.inliers.length +
      ' (inlier ' + (100 * x.inliers.length / syncs.length).toFixed(1) + '%)  剔除 ' +
      x.outliers.length + '  · 清理后间隔中位 ' + (x.st ? x.st.median.toFixed(3) : '-') +
      ' ms · MAD ' + (x.st ? x.st.mad.toFixed(3) : '-') + ' ms   (期望约 ' + expectedCount.toFixed(0) + ' 个)');
  }
  const chosen = grids.slice().sort((a, b) => b.inliers.length - a.inliers.length)[0];
  const cleaned = chosen.inliers.slice();
  console.log('    采用: 栅格 ' + chosen.period.toFixed(3) + ' ms（inlier 更多）· 保留 ' + cleaned.length +
    ' 个 · 剔除 ' + chosen.outliers.length + ' 个');
  const MAD_OK = chosen.st ? chosen.st.mad <= 2.0 : false;
  console.log('    AC1 验收: 脉冲数 ' + cleaned.length + '（≈' + expectedCount.toFixed(0) + '）· MAD ' +
    (chosen.st ? chosen.st.mad.toFixed(3) : '-') + ' ms（≤2.0）→ ' +
    (MAD_OK ? '通过 ✓' : '未通过 ✗（清理不可靠，结论需谨慎）'));

  const truthSorted = cleaned.map((s) => Math.round(s.start * sr));
  const pairs = [];
  for (let k = 0; k < refs.length; k++) {
    /*
     * Nearest AND second-nearest truth sync, with the side each lies on. The previous round paired a
     * decoder reference with a single "nearest" and the distribution came out bimodal, which made the
     * median meaningless; showing both sides makes "consistently biased" and "jumping between sides"
     * distinguishable.
     */
    let lo = null, hi = null;
    for (const t of truthSorted) {
      if (t <= refSamples[k]) { if (lo == null || t > lo) lo = t; }
      else { if (hi == null || t < hi) hi = t; }
    }
    const dLo = lo == null ? null : refSamples[k] - lo;
    const dHi = hi == null ? null : refSamples[k] - hi;
    const useLo = dLo != null && (dHi == null || Math.abs(dLo) <= Math.abs(dHi));
    const delta = useLo ? dLo : dHi;
    pairs.push({ line: refs[k].line, dec: refSamples[k],
      prev: lo, deltaPrev: dLo, next: hi, deltaNext: dHi,
      truth: useLo ? lo : hi, delta: delta, side: useLo ? '后' : '前',
      distToNearest: Math.abs(delta) });
  }
  const nearestDist = stats(pairs.map((p) => p.distToNearest));
  console.log('    到最近真值同步的距离: 中位 ' + nearestDist.median.toFixed(0) + ' 采样 (' +
    (nearestDist.median / PIXEL_SAMPLES).toFixed(2) + ' 像素) · 最大 ' + nearestDist.max);
  const paired = pairs.filter((p) => p.distToNearest < LINE_MS / 1000 * sr / 2);
  console.log('    其中落在一行之内（配对可信）的行数: ' + paired.length + ' / ' + pairs.length);

  // ---- the delta to the PREVIOUS sync is the one that carries the bias ------------------------
  const onlyPrev = pairs.filter((p) => p.deltaPrev != null).map((p) => p.deltaPrev);
  const prevSt = stats(onlyPrev);
  const prevReg = linreg(onlyPrev);
  console.log('\n    相对【前一个】真值同步的 Δ（不受配对选择影响）: 中位 ' + prevSt.median.toFixed(1) +
    ' 采样 (' + (prevSt.median / PIXEL_SAMPLES).toFixed(2) + ' 像素) · MAD ' + prevSt.mad.toFixed(1) +
    ' · 标准差 ' + prevSt.sd.toFixed(1) + ' · 极值 ' + prevSt.min + ' .. ' + prevSt.max);
  console.log('    回归: 斜率 ' + prevReg.slope.toFixed(3) + ' 采样/行 · R² ' + prevReg.r2.toFixed(4));

  console.log('\n[5] 逐行对账（前 14 行）');
  console.log('    行号   解码器参考(采样)   前一个真值    Δ前(采样)   Δ前(像素)   后一个真值   Δ后(采样)');
  for (const p of pairs.slice(0, 14)) {
    console.log('    ' + String(p.line).padStart(4) + '   ' + String(p.dec).padStart(14) +
      '   ' + String(p.prev == null ? '-' : p.prev).padStart(11) +
      '   ' + String(p.deltaPrev == null ? '-' : p.deltaPrev).padStart(9) +
      '   ' + (p.deltaPrev == null ? '-' : (p.deltaPrev / PIXEL_SAMPLES).toFixed(2)).padStart(9) +
      '   ' + String(p.next == null ? '-' : p.next).padStart(11) +
      '   ' + String(p.deltaNext == null ? '-' : p.deltaNext).padStart(9));
  }
  const ds = stats(pairs.map((p) => p.delta));
  const reg = linreg(pairs.map((p) => p.delta));
  console.log('\n    Δ 统计: n=' + ds.n + ' 中位 ' + ds.median.toFixed(1) + ' 采样 (' +
    (ds.median / PIXEL_SAMPLES).toFixed(2) + ' 像素) · MAD ' + ds.mad.toFixed(1) +
    ' · 标准差 ' + ds.sd.toFixed(1) + ' · 极值 ' + ds.min + ' .. ' + ds.max);
  console.log('    Δ 回归: 斜率 ' + reg.slope.toFixed(3) + ' 采样/行, R² ' + reg.r2.toFixed(4) +
    '  ' + (reg.r2 > 0.5 ? '-> 偏差随行号线性增长（时序/时钟尺度）' : '-> 无线性趋势'));

  // ------------------------------------------------------------ verdict
  console.log('\n===== 判定 =====');
  const candidates = [
    ['无系统性偏移', 0],
    ['2·porch', 2 * PORCH_SAMPLES],
    ['chan_len/2', HALF_CHAN_SAMPLES],
    ['行首→同步距离', LINE_START_TO_SYNC],
    ['一个通道', (MODE.sepPulse + MODE.scanTime) * SR]
  ];
  const med = ds.median;
  let match = null, bestErr = Infinity;
  for (const [name, val] of candidates) {
    const e = Math.abs(Math.abs(med) - Math.abs(val));
    if (e < bestErr) { bestErr = e; match = name; }
  }
  console.log('  中位偏差 ' + med.toFixed(1) + ' 采样 = ' + (med / PIXEL_SAMPLES).toFixed(2) + ' 像素');
  console.log('  最接近的候选: 【' + match + '】 (误差 ' + bestErr.toFixed(0) + ' 采样)');
  console.log('  MAD ' + ds.mad.toFixed(1) + ' 采样 = ' + (ds.mad / PIXEL_SAMPLES).toFixed(2) + ' 像素');
  let verdict;
  /*
   * The control (our own audio, which decodes at 30.50 dB) shows a CONSTANT -99 samples (-4.8 px)
   * with MAD 12 samples and no drift. A decoder that re-locks on every line does not care about a
   * small constant offset, so "aligned" must be judged on the SCATTER and the DRIFT - the first
   * version demanded |median| <= 2 px and therefore failed the control wrongly.
   */
  const drift = Math.abs(reg.slope) * pairs.length;
  if (Math.abs(med) <= 6 * PIXEL_SAMPLES && ds.mad <= 2 * PIXEL_SAMPLES && drift <= 2 * PIXEL_SAMPLES) {
    verdict = '【情况 A】仅小恒定偏移 ' + (med / PIXEL_SAMPLES).toFixed(2) + ' 像素、抖动 ' +
      (ds.mad / PIXEL_SAMPLES).toFixed(2) + ' 像素、无漂移 —— 行首定位不是根因（与对照组同型）';
  } else if (ds.mad > Math.abs(med) * 2 && ds.mad > 4 * PIXEL_SAMPLES) {
    verdict = '【随机偏差】中位小但 MAD 达 ' + (ds.mad / PIXEL_SAMPLES).toFixed(2) +
      ' 像素 —— 同步检测在该音频上不稳定，而不是公式错';
  } else if (drift > 8 * PIXEL_SAMPLES) {
    verdict = '【线性漂移】全程 ' + (drift / PIXEL_SAMPLES).toFixed(1) +
      ' 像素 —— 时序/时钟尺度问题，不是行首定位';
  } else if (bestErr <= 3 * PIXEL_SAMPLES) {
    verdict = '【情况 B】系统性偏移 ≈ ' + match + ' —— 行首定位公式需要修';
  } else {
    verdict = '【未对应候选】中位偏差 ' + med.toFixed(0) + ' 采样不与任何几何量对应，需进一步分析';
  }
  console.log('  判定: ' + verdict);

  fs.writeFileSync(path.join(OUT, 'audit-line-start' + (SELF ? '-self' : '') + '.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(), audio: path.relative(ROOT, AUDIO).replace(/\\/g, '/'),
      selfControl: SELF, sampleRate: sr, lineMs: LINE_MS, pixelSamples: PIXEL_SAMPLES,
      geometry: { porchSamples: PORCH_SAMPLES, halfChanSamples: HALF_CHAN_SAMPLES,
        lineStartToSync: LINE_START_TO_SYNC },
      syncCount: syncs.length, syncInterval: ss, separatorCount: seps.length,
      separatorMsMedian: sepMs ? sepMs.median : null,
      decoderRows: refs.length, imageStart: cal.imageStart, clockScale: cal.clockScale,
      deltaStats: ds, deltaRegression: reg,
      nearestCandidate: { name: match, errorSamples: bestErr },
      samplePairs: pairs.slice(0, 30), verdict: verdict
    }, null, 2));
  console.log('\n证据 -> ' + path.relative(ROOT, path.join(OUT,
    'audit-line-start' + (SELF ? '-self' : '') + '.json')));
})().catch((e) => { console.error('audit error: ' + (e && e.stack || e)); process.exitCode = 1; });
