/*
 * Timing diagnosis for a real-world recording (phigros.wav -> actually an MP3).
 *
 * WHY THIS EXISTS
 *   Our decoder reports Scottie S1 with the correct VIS and produces 320x256 - but the picture is
 *   noise, with horizontal structure only near the top. Robot36 decodes a recognisable character
 *   from the same audio, and its own output ALSO carries horizontal glitch bands, so the source is
 *   genuinely degraded.
 *
 *   Pure noise is not a geometry or rotation problem (a wrongly rotated picture is still a picture).
 *   The three candidates are: the audio is speed-changed, the file holds several transmissions and
 *   we lock onto the wrong one, or the sync/pixel timing is simply being mis-detected.
 *
 * WHAT IT MEASURES
 *   [1] every 1200 Hz sync pulse, and which stretches of the file carry a REGULAR pulse train
 *   [2] the line interval distribution against Scottie S1's nominal 428.22 ms
 *   [3] the implied pixel time against 432.0 us (Scottie S1; 457.6 us is Martin M1)
 *   [4] which frequency actually carries the sync pulses (a resample moves the tone; a
 *       pitch-preserving stretch does not) - this separates the speed hypotheses
 *   [5] the leader-to-first-sync gap
 *   [6] what the real decoder's own affine calibration says
 *   [7] a verdict from the R_time / R_freq combination
 *   [8] the decisive experiment: resample by candidate factors and re-decode, scoring how
 *       image-like the result is (adjacent-row correlation) and writing PNGs to look at
 *
 * It is DIAGNOSTIC ONLY: no decoder code is touched, and nothing here is wired into the product.
 *
 * Usage: node tests/diagnose-timing.js [audio-file]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-timing');
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'phigros.wav');

// Scottie S1 nominal timing, from the project's own mode table.
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
const Modes = globalThis.SSTVModes;
const M = Modes.get('S1');
/*
 * The line period is the SUM OF THE LINE'S OWN PARTS, not totalDuration/height.
 *
 * totalDuration includes the leader, the VIS header and the tail, so dividing it by the line count
 * charges that fixed ~1 s of overhead to every line and inflates the period to 432.20 ms. The parts
 * below sum to exactly 428.22 ms, which is Scottie S1's published line time and what the real
 * recording measures (428.000 ms).
 *
 * A second trap: a line carries THREE channel scans, so the pixel time is scanTime/width (432.0 us)
 * - not linePeriod/width. 457.6 us is Martin M1's pixel time; Scottie S1 is faster.
 */
const LINE_MS = 1000 * ((M.syncPulse || 0) + (M.syncPorch || 0) +
  M.channels * M.scanTime + (M.chanSync || 0) * (M.sepPulse || 0));
const SYNC_OVERHEAD_S = (M.syncPulse || 0) + (M.syncPorch || 0) + (M.chanSync || 0) * (M.sepPulse || 0);
const SYNC_MS = 1000 * (M.syncPulse || 0.009);
const PIXEL_US = 1e6 * M.scanTime / M.width;
const FRAME = Modes.totalDuration(M);

require(path.join(ROOT, 'js', 'lib', 'wav.js'));
const Wav = globalThis.SSTVWav;

// ---------------------------------------------------------------- DSP helpers
/**
 * Quadrature-detected amplitude envelope at one frequency, decimated to ~1 ms resolution.
 * A one-pole low pass after I/Q mixing: O(N) per frequency, which matters because the file is
 * 10.5 M samples and the frequency scan needs a dozen of them.
 */
function envelope(samples, sr, freq, decim, tauMs) {
  const w = 2 * Math.PI * freq / sr;
  const c = Math.cos(w), s = Math.sin(w);
  const a = Math.exp(-1 / (sr * (tauMs || 2) / 1000));
  const n = Math.floor(samples.length / decim);
  const out = new Float32Array(n);
  let ci = 1, si = 0, I = 0, Q = 0, o = 0;
  for (let i = 0; i < samples.length; i++) {
    const nci = ci * c - si * s, nsi = si * c + ci * s;
    ci = nci; si = nsi;
    const v = samples[i];
    I = a * I + (1 - a) * (v * ci);
    Q = a * Q + (1 - a) * (v * si);
    if (i % decim === 0 && o < n) out[o++] = Math.sqrt(I * I + Q * Q);
  }
  return out;
}

/**
 * Find sync pulses in a 1200 Hz envelope.
 * A pulse must RISE clearly above the local content level and last like a Scottie sync (9 ms).
 */
function findPulses(env1200, envRef, msPerBin, opts) {
  const o = opts || {};
  const minMs = o.minMs == null ? 4 : o.minMs;
  const maxMs = o.maxMs == null ? 18 : o.maxMs;
  const k = o.k == null ? 1.55 : o.k;
  const pulses = [];
  let run = -1;
  for (let i = 0; i < env1200.length; i++) {
    const ref = envRef ? Math.max(envRef[i], o.floor || 1e-4) : (o.floor || 1e-4);
    const on = env1200[i] > k * ref;
    if (on && run < 0) run = i;
    else if (!on && run >= 0) {
      const ms = (i - run) * msPerBin;
      if (ms >= minMs && ms <= maxMs) pulses.push({ i: run, ms: ms, t: run * msPerBin / 1000 });
      run = -1;
    }
  }
  return pulses;
}

function stats(diffs) {
  if (!diffs.length) return null;
  const s = diffs.slice().sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const mad = s.map((v) => Math.abs(v - median)).sort((a, b) => a - b)[Math.floor(s.length / 2)];
  const sd = Math.sqrt(s.reduce((a, v) => a + (v - mean) * (v - mean), 0) / s.length);
  return { n: s.length, median, mean, sd, mad, min: s[0], max: s[s.length - 1] };
}

/** Adjacent-row correlation of the green channel: an image scores high, noise near zero. */
function rowCorrelation(img) {
  const w = img.width, h = img.height, d = img.data;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const r = new Float64Array(w);
    for (let x = 0; x < w; x++) r[x] = d[(y * w + x) * 4 + 1];
    rows.push(r);
  }
  let sum = 0, count = 0;
  for (let y = 0; y + 1 < h; y++) {
    const a = rows[y], b = rows[y + 1];
    let ma = 0, mb = 0;
    for (let x = 0; x < w; x++) { ma += a[x]; mb += b[x]; }
    ma /= w; mb /= w;
    let num = 0, da = 0, db = 0;
    for (let x = 0; x < w; x++) {
      const u = a[x] - ma, v = b[x] - mb;
      num += u * v; da += u * u; db += v * v;
    }
    if (da > 0 && db > 0) { sum += num / Math.sqrt(da * db); count++; }
  }
  return count ? sum / count : 0;
}

function resampleLinear(x, factor) {
  const outLen = Math.floor(x.length * factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const t = i / factor;
    const i0 = Math.floor(t), f = t - i0;
    const a = x[i0] || 0, b = x[i0 + 1] || 0;
    out[i] = a * (1 - f) + b * f;
  }
  return out;
}

// ---------------------------------------------------------------- main
(async function main() {
  console.log('=== 时序诊断 ===\n');
  if (!fs.existsSync(SRC)) { console.log('missing ' + SRC); process.exitCode = 1; return; }

  /*
   * The file is named .wav but is an MP3, so it must be transcoded before Node can read it.
   * do this once and reuse, so repeated diagnostic runs are instant.
   */
  const monoWav = path.join(OUT, 'phigros-48k-mono.wav');
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(monoWav)) {
    const { spawnSync } = require('child_process');
    const ff = ['C:\\Users\\xuyang\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe', 'ffmpeg']
      .find((p) => p === 'ffmpeg' || fs.existsSync(p));
    console.log('transcoding ' + path.basename(SRC) + ' -> 48 kHz mono WAV ...');
    const r = spawnSync(ff, ['-y', '-i', SRC, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', monoWav],
      { stdio: 'ignore' });
    if (r.status !== 0) { console.log('ffmpeg failed'); process.exitCode = 1; return; }
  }
  const buf = fs.readFileSync(monoWav);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const sr = info.sampleRate, x = info.samples;
  console.log('source      : ' + path.relative(ROOT, SRC));
  console.log('decoded as  : 48 kHz mono, ' + info.duration.toFixed(3) + ' s, ' + x.length + ' samples');
  console.log('S1 nominal  : line ' + LINE_MS.toFixed(2) + ' ms (逐行结构求和), sync ' + SYNC_MS + ' ms/line, ' +
    'pixel ' + PIXEL_US.toFixed(1) + ' us (' + M.channels + ' 通道/行), ' + M.width + 'x' + M.height);
  console.log('duration/S1 : ' + (info.duration / FRAME).toFixed(3) + ' frames  (单帧 ' + FRAME.toFixed(3) + ' s)');

  const decim = Math.round(sr / 1000);           // ~1 ms per bin
  const msPerBin = 1000 * decim / sr;

  // ------------------------------------------------------------ [1] pulses
  const e1200 = envelope(x, sr, 1200, decim, 2);
  const e1500 = envelope(x, sr, 1500, decim, 2);
  const e1900 = envelope(x, sr, 1900, decim, 2);
  const e2300 = envelope(x, sr, 2300, decim, 2);
  const eRef = new Float32Array(e1200.length);
  for (let i = 0; i < eRef.length; i++) eRef[i] = (e1500[i] + e1900[i] + e2300[i]) / 3;

  const pulses = findPulses(e1200, eRef, msPerBin, {});
  console.log('\n[1] 同步脉冲检测');
  console.log('  1200 Hz 脉冲数            : ' + pulses.length);
  if (!pulses.length) { console.log('  未检出任何脉冲 —— 需放宽阈值或换频率'); }

  // per-second pulse count -> which stretches carry a regular train
  const perSec = new Float32Array(Math.ceil(info.duration) + 1);
  for (const p of pulses) perSec[Math.floor(p.t)]++;
  const expected = 1000 / LINE_MS;                       // ~2.33 pulses/s for S1
  const segs = [];
  let seg = null;
  for (let s = 0; s < perSec.length; s++) {
    const dense = perSec[s] >= expected * 0.55;
    if (dense && !seg) seg = { from: s, to: s, count: 0 };
    if (dense && seg) { seg.to = s; seg.count += perSec[s]; }
    if (!dense && seg) { segs.push(seg); seg = null; }
  }
  if (seg) segs.push(seg);
  const real = segs.filter((s) => s.to - s.from >= 20);
  console.log('  期望脉冲率 (S1)           : ' + expected.toFixed(2) + ' 个/秒');
  console.log('  规律脉冲区段 (>=20 s)     : ' + (real.length ? real.map((s) => s.from + '-' + s.to + 's(' + s.count + ')').join(', ') : '无'));

  // ------------------------------------------------------------ [2][3] intervals
  const inSeg = (t) => real.some((s) => t >= s.from && t <= s.to + 1);
  const usePulses = real.length ? pulses.filter((p) => inSeg(p.t)) : pulses;
  const diffs = [];
  for (let i = 1; i < usePulses.length; i++) {
    const d = (usePulses[i].t - usePulses[i - 1].t) * 1000;
    if (d > 4 && d < 2000) diffs.push(d);
  }
  const st = stats(diffs);
  console.log('\n[2] 行同步间隔');
  if (st) {
    console.log('  样本数                    : ' + st.n);
    console.log('  中位数                    : ' + st.median.toFixed(3) + ' ms   (标准 ' + LINE_MS.toFixed(2) + ' ms)');
    console.log('  均值 / 标准差             : ' + st.mean.toFixed(3) + ' / ' + st.sd.toFixed(3) + ' ms');
    console.log('  MAD                       : ' + st.mad.toFixed(3) + ' ms');
    console.log('  极值                      : ' + st.min.toFixed(2) + ' .. ' + st.max.toFixed(2) + ' ms');
    // histogram on 20 ms bins around the median
    const hist = {};
    for (const d of diffs) {
      const b = Math.round(d / 20) * 20;
      hist[b] = (hist[b] || 0) + 1;
    }
    const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
    console.log('  直方图 (20 ms 分箱)       :');
    const top = keys.slice(0, 12);
    for (const k of top) {
      console.log('    ' + String(k).padStart(5) + ' ms  ' + '#'.repeat(Math.min(50, Math.round(50 * hist[k] / Math.max(...Object.values(hist))))) + ' ' + hist[k]);
    }
  } else console.log('  无可用间隔');

  const R_time = st ? st.median / LINE_MS : null;
  console.log('\n[3] 实际像素时间');
  if (st) {
    /*
     * A line is 3 channel scans PLUS the sync, porch and two separators. Dividing the whole line by
     * the pixel count (which an earlier version of this script did) yields a meaningless ~1338 us
     * and a fake -1% error; the overhead and the channel count have to come out first.
     */
    const pixUs = 1e6 * ((st.median / 1000) - SYNC_OVERHEAD_S) / M.channels / M.width;
    console.log('  行内非扫描开销            : ' + (1000 * SYNC_OVERHEAD_S).toFixed(2) + ' ms (sync + porch + ' +
      M.chanSync + ' x sep)');
    console.log('  由行间隔推算              : ' + pixUs.toFixed(2) + ' us  (标准 ' + PIXEL_US.toFixed(2) + ' us, ' +
      '偏差 ' + (((pixUs / PIXEL_US) - 1) * 100).toFixed(3) + '%)');
  }

  // ------------------------------------------------------------ [4] which frequency?
  /*
   * The decisive split between the speed hypotheses. A resample scales the sync TONE with the
   * durations; a pitch-preserving stretch does not. So scan for the tone that yields the most
   * pulses landing on a regular grid, and compare it with 1200 Hz.
   */
  console.log('\n[4] 同步音频率扫描（哪个频率上的脉冲最规律）');
  const probeFrom = real.length ? real[0].from : 0;
  const probeLen = Math.min(30 * sr, x.length - Math.floor(probeFrom * sr));
  const probe = x.subarray(Math.floor(probeFrom * sr), Math.floor(probeFrom * sr) + probeLen);
  const best = [];
  for (let f = 900; f <= 2000; f += 50) {
    const e = envelope(probe, sr, f, decim, 2);
    const eR = envelope(probe, sr, 1500, decim, 2);
    const ps = findPulses(e, eR, msPerBin, {});
    if (ps.length < 5) { best.push({ f: f, n: ps.length, score: 0 }); continue; }
    const ds = [];
    for (let i = 1; i < ps.length; i++) ds.push((ps[i].t - ps[i - 1].t) * 1000);
    ds.sort((a, b) => a - b);
    const med = ds[Math.floor(ds.length / 2)];
    const spread = ds[Math.floor(ds.length * 0.8)] - ds[Math.floor(ds.length * 0.2)];
    const score = med > 30 ? ps.length / (1 + spread) : 0;
    best.push({ f: f, n: ps.length, med: med, spread: spread, score: score });
  }
  best.sort((a, b) => b.score - a.score);
  for (const b of best.slice(0, 6)) {
    console.log('  ' + String(b.f).padStart(4) + ' Hz   脉冲 ' + String(b.n).padStart(4) +
      (b.med ? '   间隔中位数 ' + b.med.toFixed(1) + ' ms   80%跨度 ' + b.spread.toFixed(1) + ' ms' : ''));
  }
  const fBest = best[0] && best[0].score > 0 ? best[0].f : null;
  const R_freq = fBest ? fBest / 1200 : null;
  const at1200 = best.find((b) => b.f === 1200);
  console.log('  最佳频率                  : ' + (fBest ? fBest + ' Hz' : '无') +
    '   ->  R_freq = ' + (R_freq ? R_freq.toFixed(4) : '-') +
    (at1200 ? '   (1200 Hz 上脉冲 ' + at1200.n + ' 个)' : ''));

  // ------------------------------------------------------------ [5] leader -> first sync
  console.log('\n[5] 前导 (1900 Hz) 与首个同步脉冲');
  const leadThr = 0.5 * Math.max(...Array.from(e1900.subarray(0, Math.min(e1900.length, 120000))));
  let leadAt = -1;
  for (let i = 0; i < e1900.length; i++) if (e1900[i] > leadThr) { leadAt = i * msPerBin / 1000; break; }
  const firstSync = usePulses.length ? usePulses[0].t : null;
  console.log('  首段 1900 Hz 出现于        : ' + (leadAt >= 0 ? leadAt.toFixed(3) + ' s' : '未检出'));
  console.log('  该区段首个同步脉冲         : ' + (firstSync != null ? firstSync.toFixed(3) + ' s' : '未检出'));
  if (leadAt >= 0 && firstSync != null) {
    const gapMs = (firstSync - leadAt) * 1000;
    console.log('  间隔                      : ' + gapMs.toFixed(1) + ' ms');
    console.log('  标准 S1 前导+VIS 期望约    : 300+300+8 bit 时段 ~= ' + (300 + 300 + 8 * 30) + ' ms  (量级参考)');
  }

  // ------------------------------------------------------------ [6] decoder cross-check
  console.log('\n[6] 现有解码器自身的标定（不经任何预处理）');
  require(path.join(ROOT, 'js', 'lib', 'fft.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
  const Decode = globalThis.SSTVDecode;
  const t0 = Date.now();
  const dec = await Decode.decode(x, sr, { quality: 'fast', yieldEvery: 0 });
  console.log('  stage=' + dec.stage + '  ok=' + dec.ok + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  if (dec.ok) {
    console.log('  mode=' + dec.mode.name + '  vis=' + dec.vis);
    const cal = dec.calibration || {};
    console.log('  calibration: ' + JSON.stringify(cal));
    console.log('  行间垂直相关              : ' + rowCorrelation(dec.imageData).toFixed(4) +
      '   (真实图像应接近 0.8~0.99，噪声接近 0)');

    /*
     * The comparison that decides "did we lock onto a real transmission?": take the stretch the
     * decoder actually used and ask whether the sync pulses inside it are regular. A real Scottie
     * line train gives a tight interval around 428 ms; a region of music does not.
     */
    const startS = (cal.imageStart || 0) / sr;
    const endS = startS + FRAME;
    const inside = pulses.filter((p) => p.t >= startS && p.t <= endS);
    const insideDiffs = [];
    for (let i = 1; i < inside.length; i++) {
      const d = (inside[i].t - inside[i - 1].t) * 1000;
      if (d > 4 && d < 2000) insideDiffs.push(d);
    }
    const inSt = stats(insideDiffs);
    console.log('  解码器使用的区段          : ' + startS.toFixed(3) + ' .. ' + endS.toFixed(3) + ' s');
    console.log('    该区段内 1200 Hz 脉冲数  : ' + inside.length + '  (期望约 ' +
      Math.round(FRAME * 1000 / LINE_MS) + ' 个)');
    if (inSt) {
      console.log('    该区段间隔中位数 / MAD   : ' + inSt.median.toFixed(3) + ' / ' + inSt.mad.toFixed(3) + ' ms' +
        (Math.abs(inSt.median - LINE_MS) < 5 && inSt.mad < 15
          ? '  -> 规整，是真实的行同步序列' : '  -> 不规整，该区段可能不是真正的传输'));
    }
  } else {
    console.log('  message=' + dec.message);
  }

  // ------------------------------------------------------------ [7] verdict
  console.log('\n[7] 判据');
  if (R_time == null || R_freq == null) {
    console.log('  数据不足：R_time=' + R_time + ' R_freq=' + R_freq);
  } else {
    const near = (v, t, tol) => Math.abs(v - t) <= tol;
    console.log('  R_time = ' + R_time.toFixed(4) + '   R_freq = ' + R_freq.toFixed(4));
    if (near(R_time, 1, 0.02) && near(R_freq, 1, 0.05)) {
      console.log('  => 未变速：时长与音高都在标准位置。病因不在速度，指向锁位/同步脉冲误检。');
    } else if (near(R_time, R_freq, 0.03) && !near(R_time, 1, 0.02)) {
      console.log('  => 重采样变速：时长与音高同向缩放，倍率约 ' + R_time.toFixed(3) + '。');
    } else if (!near(R_time, 1, 0.02) && near(R_freq, 1, 0.05)) {
      console.log('  => 保持音高的时间缩放：时长变了但同步音仍在 1200 Hz。');
    } else {
      console.log('  => 两者都不接近 1 且互不一致：更像模式/结构不符或脉冲误检，需看 [1] 的分区。');
    }
  }

  // ------------------------------------------------------------ [8] the experiment
  console.log('\n[8] 重采样验证实验（按候选倍率还原后重解，用行间相关判断"像不像一张图"）');
  console.log('    说明：这是诊断预处理，不改解码器；线性插值本身会引入少量失真。');
  const pngjs = (() => { try { return require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')); } catch (e) { return null; } })();
  const candidates = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5];
  const results = [];
  for (const S of candidates) {
    /*
     * S is the speed-up we are hypothesising was applied. Restoring it means making the audio
     * longer by S (and moving tones back down by S), so factor = S.
     */
    const y = Math.abs(S - 1) < 1e-9 ? x : resampleLinear(x, S);
    const tt = Date.now();
    const d = await Decode.decode(y, sr, { quality: 'fast', yieldEvery: 0 });
    const rc = d.ok ? rowCorrelation(d.imageData) : null;
    results.push({ S: S, ok: d.ok, stage: d.stage, corr: rc, sec: (Date.now() - tt) / 1000, img: d.imageData });
    console.log('    x' + S.toFixed(2) + '  ' + (d.ok ? 'ok  ' : 'FAIL') +
      '  行间相关 ' + (rc == null ? '  -  ' : rc.toFixed(4)) +
      '  (' + ((Date.now() - tt) / 1000).toFixed(1) + ' s)');
    if (d.ok && pngjs) {
      const png = new pngjs.PNG({ width: d.imageData.width, height: d.imageData.height });
      png.data = Buffer.from(d.imageData.data.buffer, d.imageData.data.byteOffset, d.imageData.data.length);
      fs.writeFileSync(path.join(OUT, 'resample-x' + S.toFixed(2) + '.png'), pngjs.PNG.sync.write(png));
    }
  }
  const okRes = results.filter((r) => r.ok && r.corr != null).sort((a, b) => b.corr - a.corr);
  console.log('\n  按"行间相关"排序：');
  for (const r of okRes.slice(0, 5)) console.log('    x' + r.S.toFixed(2) + '  ' + r.corr.toFixed(4));
  if (okRes.length) {
    const bestR = okRes[0];
    console.log('\n  最佳候选 x' + bestR.S.toFixed(2) + '（行间相关 ' + bestR.corr.toFixed(4) + '）');
    console.log('  -> PNG 已写入 ' + path.relative(ROOT, OUT) + '/resample-x' + bestR.S.toFixed(2) + '.png');
    if (bestR.corr > 0.5) console.log('  => 该倍率下解出了"像图"的结果，速度假设得到支持。');
    else console.log('  => 所有倍率都不像图（最高仅 ' + bestR.corr.toFixed(3) + '），速度不是主因。');
  }
  console.log('\n诊断结束。');
})().catch((e) => { console.error('diagnosis error: ' + (e && e.stack || e)); process.exitCode = 1; });
