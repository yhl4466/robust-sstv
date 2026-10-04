/*
 * ============================ THE BLOCKED TASK ============================
 *
 * Phase 50 task 1 asks for a phone recording of speaker playback so the acoustic path can be measured on
 * real hardware. NO SUCH RECORDING EXISTS in this repository, and this round did not obtain one. Nothing
 * below should be read as a real-device acoustic measurement.
 *
 * This script is the thing that was missing: a ready-made analyser for the moment such a recording
 * arrives. Its critical property is that it VALIDATES ITS OWN PROBES FIRST, because that is what went
 * wrong repeatedly in this round.
 *
 * WHAT WENT WRONG (recorded so the next attempt does not repeat it)
 *   Five successive header probes disagreed with each other on files that all decode successfully:
 *   - probing fixed offsets t = 0.31..1.22 s measured SILENCE, because the `sstv` package's real
 *     recording (and therefore every fixture derived from it) has ~2.5 s of leading silence, so its
 *     calibration header sits at t ~ 2.6 s, not t = 0;
 *   - a later probe reported tone SNRs of -87 dB and other impossible negatives;
 *   - the same probe reported a header SNR of -21 dB identically for every attenuation level in a sweep,
 *     i.e. it was measuring something that did not change when the input did.
 *   Each number was internally plausible and each was wrong. The lesson is the same one
 *   tests/lib/measure-validate.js already encodes for impairment models: a probe must be shown to work on
 *   an input whose answer is known BEFORE its readings on an unknown input are reported.
 *
 * HOW THIS SCRIPT AVOIDS THAT
 *   Step 0 runs the probe on a SYNTHETIC preamble with known tone order and measured SNR, and refuses to
 *   report anything if the probe does not recover it. Only then does it touch a user recording.
 *
 * Usage:
 *   node tests/analyze-recording.js <audio-file>        analyse a recording (any format Node can read
 *                                                       as PCM WAV; other containers need conversion)
 *   node tests/analyze-recording.js --selftest          run only step 0
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
let PNG = null;
try { PNG = require(path.resolve(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')).PNG; } catch (e) {}

// ---------------------------------------------------------------- probe, with self-validation

/**
 * Locate the transmission onset to SAMPLE precision.
 *
 * A 10 ms RMS scan is not good enough and the self-test proved it: it returned 0.245 s for a true onset
 * of 0.250 s, and a 5 ms error is 17% of the 0.030 s short segment (the VIS start bit), which dragged
 * that segment's amplitude reading down to 0.2354 from 0.2828. The fix is not to loosen the amplitude
 * tolerance - it is to find the onset properly.
 *
 * The onset is a step from near-silence to full amplitude, so the first sample whose magnitude clears a
 * fraction of the signal's own peak locates it exactly, whatever the noise floor. That is robust because
 * it uses the PEAK, not the RMS, and the SSTV preamble starts at full amplitude.
 */
/** Legacy broadband onset probe, retained only for the self-test's contrast column. */
function findOnset(x, sr) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak) peak = Math.abs(x[i]);
  if (!(peak > 0)) return null;
  const thr = 0.25 * peak;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > thr) return { sample: i, seconds: i / sr };
  }
  return null;
}

/**
 * Locate the SSTV calibration header by its FIRST 1900 Hz leader tone, to sample precision.
 *
 * WHY NOT THE BROADBAND ONSET (which is what this used to do, and why it was wrong)
 *   The previous version returned the first sample above 25% of the file PEAK. On the real phigros / phone
 *   recording the amplitude RAMPS UP (0.44 -> 0.50 over about 100 ms) and the file also carries room noise,
 *   so that test tripped on a transient well before the preamble. The table measured from the wrong origin
 *   then reported 0/4 probes carrying their tone while the decoder locked all 256 lines on the same file -
 *   a self-contradictory output, which is how the defect was caught. The script now says so explicitly
 *   rather than printing plausible numbers.
 *
 *   The robust anchor is the thing the header search itself depends on: the 1900 Hz leader. It is a
 *   300 ms steady tone, so sliding a matched filter over the first seconds and taking the first position
 *   where 1900 Hz clearly dominates finds the preamble regardless of how the broadband envelope behaves -
 *   ramping, noisy, or preceded by silence of unknown length.
 *
 * The synthetic self-test in `selfTest()` is what makes this trustworthy: it runs this very function on a
 * preamble whose position is known exactly and refuses to report anything if the answer is wrong.
 *
 * @returns {{sample:number, seconds:number, strength:number}|null}
 */
/**
 * Hann-windowed FFT amplitude at one tone, for the header locator.
 *
 * A rectangular matched filter leaks: at a 2 ms window a tone 700 Hz away still contributes tens of
 * percent, so the boundary between the 1200 Hz break and the 1900 Hz leader is measured as moving later
 * than it does. That produced a consistent ~10-12 ms position lag that no window length removed. A Hann
 * window takes the sidelobes down far enough that the two tones separate cleanly at the boundary.
 */
function toneAmpFft(x, off, len, freq) {
  const N = 1024;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  const use = Math.min(len, N);
  for (let i = 0; i < N; i++) {
    const v = i < use ? (x[off + i] || 0) : 0;
    re[i] = v * 0.5 * (1 - Math.cos(2 * Math.PI * i / (use - 1)));
  }
  new globalThis.FFT(N).realTransform(o, re);
  const kc = Math.max(1, Math.round(freq * N / SR_ANALYZE));
  let best = 0;
  // take the largest bin within +/-2 bins of the nominal tone, so a small tuning error still registers
  for (let k = Math.max(1, kc - 2); k <= Math.min(N / 2 - 1, kc + 2); k++) {
    const m = Math.hypot(o[2 * k], o[2 * k + 1]);
    if (m > best) best = m;
  }
  return best;
}

/** Sample rate used by the locator's FFT helper; the analyser only ever sees 8k/44.1k/48k. */
let SR_ANALYZE = 48000;
/** Strength floor for the leader, as a fraction of the file RMS. Set by main() from the CLI. */
let minRelToRms = 0.20;

function findHeaderByLeader(x, sr, searchSeconds) {
  SR_ANALYZE = sr;
  const win = Math.round(0.008 * sr);              // 8 ms: ~15 cycles of 1900 Hz
  const hop = Math.max(1, Math.round(0.001 * sr)); // 1 ms resolution
  /*
   * THE SEARCH MUST COVER THE WHOLE FILE.
   *
   * Every early version searched only a fixed early window, and that could never work: measured, the real
   * phone recording's header is at t ~ 106 s. The decoder reports imageStart = 106.950 s with
   * leaderFreqHz = 1899.91 Hz, and the specification puts the header 0.640 s before the image data, so the
   * preamble sits near 106.3 s. The file holds about 106 s of music and room noise BEFORE the
   * transmission, and its strongest 1900 Hz content in the first 30 s (at 1.55 s, 5.1 dB below the file
   * RMS) belongs to that music. An early-window search can only find music.
   *
   * `minRelToRms` is the guard that makes a whole-file search safe: a real leader must be comparable to the
   * recording's own level, whereas the sustained-dominance test alone fires on quiet noise.
   */
  const fileRms = windowRms(x, 0, x.length);
  const floor = (minRelToRms == null ? 0.20 : minRelToRms) * fileRms;
  const limit = x.length - win;
  if (limit <= 0) return null;
  void searchSeconds;

  /** Is 1900 Hz dominant here AND strong enough to be a leader rather than a quiet fluctuation? */
  const dominates = (off) => {
    const lead = toneAmpFft(x, off, win, 1900);
    if (lead < floor) return false;
    const rival = Math.max(toneAmpFft(x, off, win, 1200), toneAmpFft(x, off, win, 1500), 1e-9);
    return lead / rival > 1.5;
  };

  /*
   * PASS 1 - collect EVERY sustained 1900 Hz region, then take the earliest one that is strong.
   *
   * Two earlier selection rules were both wrong, in opposite directions:
   *   - "first position above a floor" locked onto music at 0.53 s and 1.55 s on the phone recording, while
   *     its real preamble sits at ~106.3 s;
   *   - "global peak" locked onto the SECOND leader on the synthetic preamble, because the preamble has two
   *     1900 Hz runs of equal amplitude (leader 1 at 0.56 s and leader 2 at 1.17 s) and the later one won a
   *     strict `>` comparison, reporting 0.881 s instead of 0.56 s.
   *
   * The property that is actually true of a preamble is "the EARLIEST sustained 1900 Hz run that is
   * comparable in strength to the strongest such run in the file". That is robust to a loud music bed (it
   * is strength-gated) and specific to leader 1 (it is earliest-first, not peak-first).
   */
  const coarse = Math.max(1, Math.round(0.005 * sr));
  const step = Math.max(1, Math.round(0.001 * sr));
  const regions = [];
  let i = 0;
  while (i + win < limit) {
    const a = toneAmpFft(x, i, win, 1900);
    if (a >= floor && dominates(i)) {
      // walk forward while the tone persists, tracking the region's peak
      let j = i, peak = a;
      while (j + win < limit) {
        const b = toneAmpFft(x, j, win, 1900);
        if (b < peak * 0.707 || !dominates(j)) break;
        if (b > peak) peak = b;
        j += step;
      }
      const lenS = (j - i) / sr;
      if (lenS >= 0.150) regions.push({ start: i, end: j, peak: peak });   // a real leader holds ~300 ms
      i = j + coarse;
    } else {
      i += coarse;
    }
  }
  if (!regions.length) return null;

  const strongest = regions.reduce((m, r) => (r.peak > m ? r.peak : m), 0);
  const chosen = regions.find((r) => r.peak >= 0.7 * strongest);
  if (!chosen) return null;

  /* Report the window CENTRE: a windowed amplitude describes the interval the window covers. */
  const centre = chosen.start + win / 2;
  return { sample: centre, seconds: centre / sr, strength: chosen.peak,
    relToRms: chosen.peak / fileRms, regions: regions.length };
}

/**
 * Complex-correlation amplitude of one tone in a window. Amplitude is returned as an RMS-equivalent so
 * that two different frequencies can be compared and so a synthetic tone of known RMS is recovered.
 */
function toneRms(x, sr, off, len, freq) {
  const w = 2 * Math.PI * freq / sr;
  let re = 0, im = 0, n = 0;
  for (let i = 0; i < len; i++) {
    const v = x[off + i];
    if (v === undefined) break;
    re += v * Math.cos(w * i); im -= v * Math.sin(w * i); n++;
  }
  if (!n) return 0;
  // |X|/n is the amplitude of a sinusoid at exactly `freq`; /sqrt(2) converts to RMS
  return (2 * Math.hypot(re, im) / n) / Math.SQRT2;
}

/** Broadband RMS over the same window, so a tone can be expressed relative to the local floor. */
function windowRms(x, off, len) {
  let s = 0, n = 0;
  for (let i = 0; i < len; i++) { const v = x[off + i]; if (v === undefined) break; s += v * v; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

/**
 * STEP 0 - validate the probe on a synthetic SSTV preamble whose answer is known exactly.
 *
 * The synthetic signal contains the real preamble geometry: 0.30 s of 1200 Hz, 0.30 s of 1900 Hz,
 * 0.03 s of 1200 Hz, then 0.30 s of 1900 Hz, all at a known RMS, with a known amount of white noise
 * added so the probe's ability to report a TONE-TO-FLOOR ratio can be checked too.
 */
function selfTest() {
  const sr = 8000;
  const seg = [ [1200, 0.300], [1900, 0.300], [1200, 0.030], [1900, 0.300] ];
  const lead = 0.25;                       // leading silence, like the real package sample
  const total = lead + seg.reduce((s, q) => s + q[1], 0) + 0.20;
  const n = Math.round(total * sr);
  const x = new Float32Array(n);
  let t = lead;
  const truth = [];
  for (const [f, d] of seg) {
    const off = Math.round(t * sr), len = Math.round(d * sr);
    for (let i = 0; i < len; i++) x[off + i] = 0.4 * Math.sin(2 * Math.PI * f * i / sr);
    truth.push({ freq: f, dur: d, start: t, rms: 0.4 / Math.SQRT2 });
    t += d;
  }
  // a known noise floor, so the probe's tone-to-floor figure has a right answer too
  const floorRms = 0.01;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) x[i] += floorRms * rnd();

  /*
   * AMPLITUDE RAMP, applied to the preamble exactly as the real phone recording does it (0.44 -> 0.50
   * over the first ~100 ms). This is the condition that broke the previous broadband-onset probe, so the
   * self-test now includes it: a probe that cannot survive the real recording's own envelope has no
   * business reporting on it. `findOnset` is measured alongside as the contrast case.
   */
  const rampLen = Math.round(0.100 * sr);
  for (let i = 0; i < rampLen && i < n; i++) {
    const frac = i / rampLen;
    const scale = 0.88 + 0.12 * frac;   // 0.44/0.50 = 0.88
    x[i] *= scale;
  }

  /* locate the preamble the way any analyser must: by the header tone, not by an assumed offset */
  const loc = locatePreamble(x, sr, 8);
  const start = loc == null ? null : Number(loc.origin.toFixed(4));
  const leaderAt = loc == null ? null : Number(loc.leader.toFixed(4));
  const legacy = findOnset(x, sr);
  const legacyStart = legacy == null ? null : Number(legacy.seconds.toFixed(4));

  const problems = [];
  /*
   * Accuracy: +/-15 ms, and it is stated rather than tuned to make the test pass.
   *
   * The residual bias is ~8 ms early after the window-centre correction above. It was chased through
   * rectangular and Hann windows at 2, 6, 8 and 20 ms without disappearing, and a direct envelope print
   * (tests/diagnose-leader-lag.js) shows the detection firing 2-4 ms before the true boundary because the
   * short window lets the 1200 Hz tone decay faster than the boundary. 8 ms is fine for the purpose -
   * anchoring a frame-level table whose probes are tens of milliseconds long - and pretending to 5 ms
   * would just be a tolerance chosen to avoid the truth.
   */
  const TOL_S = 0.015;
  if (start == null || Math.abs(start - lead) > TOL_S) {
    problems.push('标定头原点定位错误：得到 ' + start + '，真值 ' + lead + ' s（容差 ' + (TOL_S * 1000) + ' ms）');
  }
  if (leaderAt != null && Math.abs(leaderAt - (lead + LEADER1_OFFSET_S)) > TOL_S) {
    problems.push('引导音位置错误：得到 ' + leaderAt + '，真值 ' + (lead + LEADER1_OFFSET_S) + ' s');
  }
  // the point of the new probe: it must NOT be defeated by the ramp that defeats the legacy one
  const legacyOk = legacyStart != null && Math.abs(legacyStart - lead) <= 0.005;
  /*
   * Probe the segments from the position of the LEADER (which is what was actually located), not from the
   * derived origin. The origin is `leader - 0.310` by construction, so probing from it would test the
   * arithmetic and not the measurement - and with a ~9 ms locator bias the derived origin is 9 ms off,
   * which on the 30 ms VIS segment knocks the measurement window onto the neighbouring 1900 Hz tone and
   * produced two spurious failures in an earlier run of this self-test.
   *
   * The consequence for the real table is documented where the table is built: it is anchored on the
   * leader, so its accuracy is the locator's accuracy (~+/-15 ms), and the VIS segment is the one probe
   * whose 30 ms length makes that marginal.
   */
  const rows = [];
  if (!problems.length) {
    // segment 0 (break) precedes the leader, so derive its offset backwards from the leader
    const LEADER_IDX = 1;
    for (let si = 0; si < truth.length; si++) {
      const s = truth[si];
      const dt = s.start - truth[LEADER_IDX].start;      // relative to leader 1
      const off = Math.round(leaderAt * sr) + Math.round(dt * sr);
      if (off < 0) continue;
      // for the short VIS segment use the LONGEST window that stays inside it, so the amplitude is not
      // diluted by the neighbouring tone
      const len = Math.round(Math.min(s.dur, 0.25) * sr);
      const use = Math.min(len, Math.round(s.dur * sr * 0.8));
      const got = toneRms(x, sr, off, use, s.freq);
      const wrong = toneRms(x, sr, off, use, s.freq === 1900 ? 1200 : 1900);
      const tot = windowRms(x, off, use);
      rows.push({ freq: s.freq, wantRms: s.rms, gotRms: got, wrongRms: wrong, windowRms: tot,
        ratioDb: 20 * Math.log10(got / Math.max(wrong, 1e-12)), winMs: use / sr * 1000,
        short: s.dur < 0.05 });
      if (Math.abs(got - s.rms) / s.rms > 0.15) {
        problems.push('音 ' + s.freq + ' Hz 幅度错误：得到 ' + got.toFixed(4) + '，真值 ' + s.rms.toFixed(4) +
          '（窗长 ' + (use / sr * 1000).toFixed(0) + ' ms）');
      }
      if (got < 5 * wrong) {
        problems.push('音 ' + s.freq + ' Hz 不能与邻音区分：比 ' + (got / wrong).toFixed(2) +
          '（窗长 ' + (use / sr * 1000).toFixed(0) + ' ms）');
      }
    }
  }
  return { ok: problems.length === 0, problems: problems, start: start, truthLead: lead, rows: rows,
    legacyStart: legacyStart, legacyOk: legacyOk, ramped: true };
}

/*
 * The first 1900 Hz leader starts 0.310 s after the preamble origin (break 0-0.300, then the leader from
 * 0.310). Both the analyser and the self-test need this conversion, so it lives in one place: doing the
 * arithmetic twice is how the self-test ended up comparing a leader position against an origin.
 */
const LEADER1_OFFSET_S = 0.310;

/** @returns {{origin:number, leader:number, strength:number}|null} all in seconds, in file time */
function locatePreamble(x, sr, searchSeconds) {
  const l = findHeaderByLeader(x, sr, searchSeconds);
  if (!l) return null;
  const origin = l.seconds - LEADER1_OFFSET_S;
  if (origin < 0) return null;
  return { origin: origin, leader: l.seconds, strength: l.strength };
}

// ---------------------------------------------------------------- analysis of a real recording

const HEADER = [
  { label: 'break 1', freq: 1200, at: 0.000, len: 0.250 },
  { label: 'leader 1', freq: 1900, at: 0.310, len: 0.250 },
  { label: 'VIS start', freq: 1200, at: 0.610, len: 0.025 },
  { label: 'leader 2', freq: 1900, at: 0.920, len: 0.250 }
];

function analyse(file) {
  const buf = fs.readFileSync(file);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const sr = info.sampleRate, x = info.samples;
  const report = { file: path.relative(ROOT, file), sampleRate: sr, duration: info.duration };

  /*
   * Locate the transmission by its FIRST 1900 Hz leader, then step back to the preamble origin.
   *
   * The reason the old broadband onset is not used: it trips on the amplitude ramp the real recording has.
   * The leader is 300 ms of steady 1900 Hz preceded by 300 ms of 1200 Hz, so the leader's own start is a
   * far more specific feature than "the envelope got loud" - and it cannot be faked by room noise.
   */
  report.fileRms = windowRms(x, 0, x.length);
  const loc = locatePreamble(x, sr, 12);
  if (!loc) { report.error = '未找到 1900 Hz 引导音，或反推出的标定头起点为负'; return report; }
  report.leaderStart = Number(loc.leader.toFixed(4));
  report.signalStart = Number(loc.origin.toFixed(4));
  report.leaderStrength = loc.strength;

  /*
   * REFINE the origin by matching the whole header, not just the leader.
   *
   * Subtracting the nominal 0.310 s from the leader's position assumes the recording's header timing is
   * exactly to spec, and on the real phone recording it is not: that put the origin at 105.739 s while the
   * 1200 Hz break probe measured 0.0000 (window RMS -64.9 dB) and leader 2 measured 0.0002 - i.e. the
   * geometry was off by enough to miss two of the four tones even though leader 1 read +54 dB over its
   * rival, which proved the anchor was essentially right.
   *
   * So the final position is chosen by MAXIMISING the total energy the four header probes actually capture,
   * over a +/-25 ms window. That uses all four tones as evidence instead of trusting one offset constant,
   * and the winning offset is reported so a reader can see how far from spec the file is.
   */
  const probeEnergy = (originS) => {
    let sum = 0;
    for (const h of HEADER) {
      const off = Math.round((originS + h.at) * sr);
      if (off < 0 || off + Math.round(h.len * sr) > x.length) return -Infinity;
      // normalise each tone by its own length so the 25 ms VIS probe cannot dominate
      sum += toneRms(x, sr, off, Math.round(h.len * sr), h.freq);
    }
    return sum;
  };
  let bestOrigin = report.signalStart, bestE = probeEnergy(bestOrigin);
  for (let d = -0.025; d <= 0.025; d += 0.001) {
    const e = probeEnergy(report.signalStart + d);
    if (e > bestE) { bestE = e; bestOrigin = report.signalStart + d; }
  }
  report.originShiftFromSpec = Number((bestOrigin - report.signalStart).toFixed(4));
  report.signalStart = Number(bestOrigin.toFixed(4));

  /* tone-level table at the (now located) header offsets */
  report.header = [];
  for (const h of HEADER) {
    const off = Math.round((report.signalStart + h.at) * sr);
    const len = Math.round(h.len * sr);
    const got = toneRms(x, sr, off, len, h.freq);
    const other = toneRms(x, sr, off, len, h.freq === 1900 ? 1200 : 1900);
    const tot = windowRms(x, off, len);
    report.header.push({ label: h.label, wantHz: h.freq, toneRms: got, otherToneRms: other,
      windowRms: tot, toneToWindowDb: 20 * Math.log10(got / Math.max(tot, 1e-12)),
      toneToOtherDb: 20 * Math.log10(got / Math.max(other, 1e-12)) });
  }

  return report;
}

function decodeAndStats(file) {
  const buf = fs.readFileSync(file);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return Decode.decode(info.samples, info.sampleRate,
    { quality: 'standard', yieldEvery: 0, auditLineRefs: [] }).then((r) => ({ r: r, info: info }));
}

// ---------------------------------------------------------------- main

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== 录音分析（内建探针自校验）===\n');

  const st = selfTest();
  console.log('[步骤 0] 探针自校验（合成前导，真值已知）');
  console.log('  起始定位：得到 ' + st.start + ' s · 真值 ' + st.truthLead + ' s');
  for (const r of st.rows) {
    console.log('  ' + String(r.freq).padStart(4) + ' Hz: 幅度 ' + r.gotRms.toFixed(4) +
      '（真值 ' + r.wantRms.toFixed(4) + '） · 与另一音之比 ' + r.ratioDb.toFixed(1) + ' dB · ' +
      '窗内总 RMS ' + r.windowRms.toFixed(4));
  }
  /*
   * Report the legacy probe alongside, because the whole reason this self-test exists is that the legacy
   * one passed its own checks while being wrong on the real material. Making the contrast visible is the
   * point: if the legacy probe happens to succeed here too, that is informative rather than a problem.
   */
  console.log('  旧宽带起点探针（仅作对照）：' + (st.legacyStart == null ? '未定位' : st.legacyStart + ' s') +
    (st.legacyOk ? ' · 在带斜坡的自校验上恰好也对' : ' · 在带斜坡的自校验上失败（正是它当初在真机录音上失败的原因）'));
  console.log('  新引导音定位探针：' + st.start + ' s（真值 ' + st.truthLead + ' s）');
  if (!st.ok) {
    console.log('\n  自校验失败，拒绝在未知录音上报告任何数字：');
    for (const p of st.problems) console.log('    · ' + p);
    process.exitCode = 1;
    return;
  }
  console.log('  自校验通过 ✓\n');

  const file = process.argv[2];
  if (!file || file === '--selftest') {
    if (!file) console.log('未提供录音文件。用法: node tests/analyze-recording.js <file.wav>');
    return;
  }
  if (!fs.existsSync(file)) { console.log('文件不存在: ' + file); process.exitCode = 1; return; }

  console.log('[1] 录音概况');
  const rep = analyse(file);
  console.log('  文件 ' + rep.file);
  console.log('  ' + rep.sampleRate + ' Hz · ' + rep.duration.toFixed(2) + ' s · 全文件 RMS ' + rep.fileRms.toFixed(4));
  if (rep.error) { console.log('  ' + rep.error); return; }
  console.log('  1900 Hz 引导音起点 t = ' + rep.leaderStart + ' s' +
    (rep.leaderStrength == null ? '' : '（相对文件 RMS ' +
      (20 * Math.log10(rep.leaderStrength / rep.fileRms)).toFixed(1) + ' dB）'));
  console.log('  标定头起点 t = ' + rep.signalStart + ' s' +
    (rep.originShiftFromSpec ? '（相对规格几何修正 ' + (rep.originShiftFromSpec * 1000).toFixed(0) + ' ms）' : ''));

  console.log('\n[2] 标定头各音（相对已定位的信号起点）');
  console.log('    探针        目标Hz   该音RMS    另一音RMS   占窗比(dB)   与另一音比(dB)');
  for (const h of rep.header) {
    console.log('    ' + h.label.padEnd(10) + String(h.wantHz).padStart(6) + '  ' +
      h.toneRms.toFixed(4).padStart(9) + '  ' + h.otherToneRms.toFixed(4).padStart(10) + '  ' +
      h.toneToWindowDb.toFixed(1).padStart(11) + '  ' + h.toneToOtherDb.toFixed(1).padStart(14));
  }

  /*
   * VALIDATE THE TABLE BEFORE IT IS BELIEVED.
   *
   * On the genuine `real-npm-8k` recording this table reports break 1 and leader 2 as SILENT while
   * leader 1 shows a tone - and the decoder locks 256 lines on that same file with zero mislocks. Both
   * cannot be true, so the table's absolute offsets do not describe that recording's preamble.
   *
   * The cause on THAT file was a wrong origin: `findOnset` located the first sample above 25% of the file
   * PEAK, and a recording whose amplitude ramps up can trip that on a transient before the true preamble.
   * A table measured from a wrong origin is worse than no table: it is plausible, it is quotable, and it is
   * wrong.
   *
   * PHASE 51 found a SECOND, different cause on the phone recording: the origin is now correct (the
   * locator returns a 1900 Hz leader at +54 dB over its rival, and the anchor is refined by maximising the
   * four probes), yet only leader 1 is present. A direct tone map over [105.8, 107.4] s
   * (tests/diagnose-real-levels.js with an explicit window) shows a strong 1900 Hz run, but the 1200 Hz
   * segments sit ~40 dB lower and the interval carries periodic ~0.214 s 1200 Hz bursts that do not match
   * the 428.4 ms Scottie line period. So on this file the tones genuinely are not all present at usable
   * level - the recording is an MP3 with reported corrupt frames, room noise, and a music bed.
   *
   * The requirement is therefore applied as: at least the LEADER must be present and clearly dominant,
   * with the other probes reported as measured, and the table marked unusable unless all four are present
   * at comparable amplitude. Requiring all four rather than a majority is deliberate - a correct preamble
   * is four tone segments in a known order - but "fewer than four" now distinguishes two situations that
   * used to look identical: a wrong origin, and a genuinely degraded header. The `originShiftFromSpec` and
   * `regions` fields are what tell them apart.
   */
  const present = rep.header.filter((h) => h.toneToOtherDb > 20 && h.toneRms > 0);
  const maxRms = Math.max.apply(null, rep.header.map((h) => h.toneRms));
  const comparable = rep.header.filter((h) => h.toneRms > 0.20 * maxRms).length;
  const selfConsistent = present.length === rep.header.length && comparable === rep.header.length && maxRms > 0;
  if (!selfConsistent) {
    /*
     * Distinguish the two causes rather than blaming the origin for both. `originShiftFromSpec` is the
     * correction the four-probe energy search applied: a large value means the origin was wrong (the
     * original failure mode); a small value with a present, dominant leader means the origin is right and
     * the header tones themselves are degraded (the phone recording's actual situation).
     */
    const originSuspect = Math.abs(rep.originShiftFromSpec || 0) > 0.010;
    console.log('\n    ⚠ 上表【不可用】：只有 ' + present.length + '/4 个探针测到明显的目标音。');
    if (originSuspect) {
      console.log('      起点疑似仍不对：四探针能量搜索修正了 ' +
        ((rep.originShiftFromSpec || 0) * 1000).toFixed(0) + ' ms，已接近搜索窗边界。');
      console.log('      因此上表的时间基准不可信，不要引用其中任何数字。');
    } else {
      console.log('      但起点是可信的：引导音清晰且占优，四探针能量搜索仅修正 ' +
        ((rep.originShiftFromSpec || 0) * 1000).toFixed(0) + ' ms。');
      console.log('      所以这是【录音本身标定头退化】——其余三个音的幅度低了 ' +
        (20 * Math.log10(maxRms / Math.max(Math.min.apply(null, rep.header.map((h) => h.toneRms)), 1e-12))).toFixed(0) +
        ' dB，不是定位错误。');
      console.log('      用法：本表的引导音一行可用（用于确认标定头位置），其余三行不可用作结论。');
    }
    rep.headerReliable = false;
    rep.headerOriginSuspect = originSuspect;
    rep.headerNote = (originSuspect ? '起点仍不可靠' : '起点可信，但标定头其余音退化') +
      '（signalStart=' + rep.signalStart + '，修正 ' +
      ((rep.originShiftFromSpec || 0) * 1000).toFixed(0) + ' ms）；' + present.length + '/4 探针有效';
  } else {
    console.log('\n    上表通过结构自检（4 个探针均测到目标音且幅度一致）');
    rep.headerReliable = true;
  }

  console.log('\n[3] 解码');
  const d = await decodeAndStats(file);
  console.log('  ' + (d.r.ok ? 'ok · ' + (d.r.mode ? d.r.mode.name : '') : '失败 · ' + d.r.message));
  if (d.r.ok) {
    console.log('  标定: a=' + d.r.calibration.scale.toFixed(6) + ' b=' + d.r.calibration.offsetHz.toFixed(2) +
      ' Hz · clockScale=' + (d.r.calibration.clockScale == null ? '--' : d.r.calibration.clockScale.toFixed(6)));
    console.log('  逐行锁定 ' + d.r.calibration.observations + ' 次 · 误锁 ' + d.r.calibration.mislockedLines);
    const pp = d.r.calibration.postprocess;
    if (pp) console.log('  降噪门控: σ_flat ' + pp.sigmaFlat.toFixed(2) + ' (门限 ' + pp.gate.toFixed(2) + ') → ' +
      (pp.applied ? '启用，σ_flat → ' + pp.sigmaFlatAfter.toFixed(2) : '旁路'));
    if (PNG) {
      fs.writeFileSync(path.join(OUT, 'recording-decoded.png'),
        PNG.sync.write({ width: d.r.imageData.width, height: d.r.imageData.height,
          data: Buffer.from(d.r.imageData.data.buffer.slice(0)) }));
      console.log('  -> tests/diag-quality/recording-decoded.png');
    }
  }
  console.log('\n  注意：这些数字只是【测量】。它们是否代表真机声学、以及该如何修复，');
  console.log('        取决于这段录音是怎么录的 —— 请连同录音条件（距离/环境/设备）一起说明。');

  fs.writeFileSync(path.join(OUT, 'recording-analysis.json'), JSON.stringify({ selftest: st, report: rep }, null, 2));
  console.log('\n证据 -> tests/diag-quality/recording-analysis.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
