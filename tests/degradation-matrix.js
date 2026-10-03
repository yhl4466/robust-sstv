/*
 * Phase-49 task 1: the INTERFERENCE-ROBUSTNESS BASELINE.
 *
 * The project calls itself a robust SSTV decoding platform, but that claim has never been measured
 * across the impairment axes a real reception actually suffers. This harness builds the matrix:
 *
 *   frequency offset · sample-rate mismatch · AWGN · clipping · reverberant (acoustic) path ·
 *   combinations of those
 *
 * For every cell it synthesises S1 audio from a KNOWN image, applies exactly one impairment, decodes
 * with the production decoder, and measures five things against ground truth:
 *
 *   psnr        - decoder output vs the source image (dB)
 *   bias        - median per-line sync residual, in samples AND pixels: a CONSTANT lock offset,
 *                 which the demodulator absorbs because it re-locks on every line
 *   jitterMAD   - MAD of the residual after the constant bias is removed. This is the quantity that
 *                 actually blurs a row-independent scanner: it smears each line by a different amount
 *   jitterRun   - median |jitter[i] - jitter[i-1]|, the row-TO-ROW change, i.e. the visible rag
 *   chroma      - sigma(G-R)/sigma(L). A chroma ratio inflated above 1.0 against a reference of about
 *                 0.8 is the signature of row-coherent colour banding
 *   ms          - decode wall time
 *
 * The residuals are taken against the ENCODER's own sync segment times (sstv-timeline records the
 * 1200 Hz segments), so the "truth" here is exact rather than detected.
 *
 * Usage: node tests/degradation-matrix.js [--mode S1] [--quick] [--only <substring>]
 *        --quick narrows the parameter ladders to their endpoints + midpoint.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUTDIR = path.join(__dirname, 'diag-quality');
const SR = 48000;
const ARGV = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt;
};
const MODE_ID = opt('--mode', 'S1');
const QUICK = ARGV.includes('--quick');
const ONLY = ARGV.indexOf('--only') >= 0 ? ARGV[ARGV.indexOf('--only') + 1] : null;
const CONTROL = opt('--control', 'photo');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Channel = require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Decode = globalThis.SSTVDecode;

let PNG = null;
try { PNG = require(path.join(RESEARCH, 'pngjs')).PNG; } catch (e) { }

const MODE = Modes.get(MODE_ID);
const PIXEL = MODE.scanTime / MODE.width * SR;
const NOMINAL_LINE = Modes.lineTime(MODE) * SR;

// ---------------------------------------------------------------- control image

/*
 * Two control images, because they answer different questions and the choice changes what "clean"
 * means - which has to be declared, not buried:
 *
 *   photo (default) - the same real photograph roundtrip.js uses, which decodes at 30.50 dB clean.
 *                     Absolute PSNR thresholds ("below 25 dB is degraded") are only meaningful
 *                     against a control whose own clean score is in that range.
 *   pattern        - colour bars + grey ramp + fine checkerboard. The grey ramp gives chroma a known
 *                     zero, so an inflated sigma(G-R) can only be banding, but its fine detail is
 *                     beyond S1's chroma bandwidth and it only reaches ~21 dB even clean, so its
 *                     absolute PSNR numbers are not comparable with the published baselines.
 */
function makeControlImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
                [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
  const barH = Math.floor(h * 0.62);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r, g, b;
      if (y < barH) {
        const c = bars[Math.min(bars.length - 1, Math.floor(x / (w / bars.length)))];
        r = c[0]; g = c[1]; b = c[2];
      } else if (y < barH + (h - barH) / 2) {
        const v = Math.round(255 * x / (w - 1)); r = g = b = v;          // grey ramp
      } else {
        // coarse checkerboard: high-frequency but only ~2.6 cycles/pixel-pair, inside S1's luma band
        const v = (((x >> 3) + (y >> 3)) & 1) ? 235 : 20; r = g = b = v;
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data: data, width: w, height: h };
}

function loadControl(mode, which) {
  if (which === 'pattern') return { img: makeControlImage(mode.width, mode.height), label: '合成测试图（彩条+灰阶+棋盘）' };
  const p = path.join(RESEARCH, 'sstv', 'examples', 'sample.png');
  if (PNG && fs.existsSync(p)) {
    const ph = PNG.sync.read(fs.readFileSync(p));
    return { img: { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height },
             label: '真实照片 examples/sample.png' };
  }
  return { img: makeControlImage(mode.width, mode.height), label: '合成测试图（回退）' };
}

// ---------------------------------------------------------------- impairments

/**
 * Hard clipping whose factor MEANS what the label says: `k` is the ratio of the signal's peak to the
 * clipping threshold, so k = 1 is untouched and k = 8 clips at 0.0625 (a harsh, heavily distorted
 * signal).
 *
 * The first version clipped at a fixed +/-1 with the caller passing a limit, which for this signal
 * (peaking at 0.5) meant k = 8 clipped at 1.0 and therefore did NOTHING AT ALL - the 8x cell decoded at
 * exactly the clean 30.50 dB. A model that is a no-op must not be reportable as an impairment, so the
 * factor is now the defining quantity and the threshold is derived from it.
 */
function clip(samples, k) {
  const peak = 0.5;                       // the synthesiser's nominal peak
  const limit = peak / Math.max(k, 1e-6);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    out[i] = v > limit ? limit : (v < -limit ? -limit : v);
  }
  return out;
}

/**
 * A reverberant acoustic path - loudspeaker to microphone in a room.
 *
 * A sum of FEEDBACK combs was tried first and was wrong: with g = 10^(-3D/RT60) the gain is 0.79 for a
 * 7.5 ms delay at RT60 0.15 s, so a feedback comb puts a 20+ dB deep, fully developed notch comb over
 * the whole signal. Every reverb cell including RT60 0.15 s failed to decode. A real room's early
 * reflections are sparse and its late field is diffuse - neither produces a deep periodic comb.
 *
 * So: sparse EARLY reflections at low level, then a diffuse tail built from ALLPASS sections, whose
 * magnitude response is flat by construction. RT60 is still set by construction, from the same
 * g = 10^(-3D/RT60) law, and each section is normalised to unit DC gain so the cell is not flattered
 * or penalised by a level change.
 *
 * Note this models a *good* acoustic link. RT60 alone does not capture the real difficulty of
 * speaker-to-microphone SSTV, which is that the microphone's own AGC, the room's low-frequency
 * rumble and the speaker's bass response all move the signal around; those are separate impairments
 * and are not claimed to be covered here.
 */
const EARLY = [        // sparse early reflections, (delay ms, gain)
  { ms: 4.3, g: 0.22 }, { ms: 9.1, g: 0.16 }, { ms: 15.7, g: 0.11 }, { ms: 23.9, g: 0.07 }
];
const DIFFUSE = [      // allpass delays, mutually prime-ish so the tail does not repeat
  { ms: 29.7, g: 0.62 }, { ms: 37.1, g: 0.58 },
  { ms: 41.1, g: 0.55 }, { ms: 43.7, g: 0.52 }
];

function combCoef(delaySec, rt60) { return Math.pow(10, -3 * delaySec / rt60); }

/**
 * A GLOBAL gain scale per RT60, solved by measuring the IR rather than by trusting the formula.
 *
 * The textbook g = 10^(-3D/RT60) is exact for a single bare comb, but chaining allpass sections makes
 * the composite tail decay more slowly than any one section, so the label and the measurement drifted
 * apart - measured 0.60 s for a nominal 0.30 s, a factor of two, which would have made every
 * "RT60 0.3 s" row a lie.
 *
 * The scale multiplies EVERY section's gain together, so the value that `buildIR` measures during
 * calibration is exactly the value `reverb` applies at run time. (Scaling sections individually would
 * have measured a different configuration from the one used.) Solving it costs a few dozen IR builds
 * once per RT60, and is cached.
 */
const GCCAL = {};
function gainScaleFor(rt60) {
  const key = rt60.toFixed(4);
  if (GCCAL[key] == null) {
    let lo = 0.05, hi = 6.0;
    for (let it = 0; it < 26; it++) {
      const mid = (lo + hi) / 2;
      const measured = measureRT60(rt60, mid);
      if (measured < rt60) lo = mid; else hi = mid;   // more gain => longer tail
    }
    GCCAL[key] = (lo + hi) / 2;
  }
  return GCCAL[key];
}

function gForSection(delaySec, rt60) {
  return Math.min(0.97, combCoef(delaySec, rt60) * gainScaleFor(rt60));
}

/** RT60 of the composite IR: time for the amplitude envelope to fall 60 dB below its peak. */
function measureRT60(rt60, gainScale) {
  const L = Math.round(rt60 * 3 * SR) + Math.round(0.05 * SR);
  const ir = buildIR(rt60, gainScale, L);
  let peak = 0;
  for (let i = 0; i < L; i++) if (Math.abs(ir[i]) > peak) peak = Math.abs(ir[i]);
  if (!(peak > 0)) return Infinity;
  const thr = peak * 1e-3;                       // -60 dB in amplitude
  for (let i = L - 1; i >= 0; i--) if (Math.abs(ir[i]) >= thr) return i / SR;
  return Infinity;
}

/** Build the IR with an explicit global gain scale, so calibration and reporting share one path. */
function buildIR(rt60, gainScale, lengthSamples) {
  const gs = gainScale == null ? 1 : gainScale;
  const ir = new Float32Array(lengthSamples);
  ir[0] = 1;
  for (const e of EARLY) {
    const d = Math.round(e.ms / 1000 * SR);
    if (d < lengthSamples) ir[d] += e.g;
  }
  for (const ap of DIFFUSE) {
    const d = Math.max(1, Math.round(ap.ms / 1000 * SR));
    const g = Math.min(0.97, combCoef(d / SR, rt60) * gs);
    const out = new Float32Array(lengthSamples);
    for (let i = 0; i < lengthSamples; i++) {
      const del = i - d >= 0 ? ir[i - d] : 0;
      out[i] = -g * ir[i] + del + g * (i - d >= 0 ? out[i - d] : 0);
    }
    ir.set(out);
  }
  let peak = 0;
  for (let i = 0; i < lengthSamples; i++) if (Math.abs(ir[i]) > peak) peak = Math.abs(ir[i]);
  if (peak > 0) for (let i = 0; i < lengthSamples; i++) ir[i] /= peak;
  return ir;
}

/** The IR this reverb realises, calibrated so it reaches -60 dB at RT60. */
function reverbIR(rt60, lengthSamples) { return buildIR(rt60, 1, lengthSamples); }

function reverb(samples, rt60) {
  const n = samples.length;
  let cur = new Float32Array(n);
  cur.set(samples);
  for (const e of EARLY) {
    const d = Math.round(e.ms / 1000 * SR);
    for (let i = d; i < n; i++) cur[i] += e.g * samples[i - d];
  }
  for (const ap of DIFFUSE) {
    const d = Math.max(1, Math.round(ap.ms / 1000 * SR));
    const g = gForSection(d / SR, rt60);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const del = i - d >= 0 ? cur[i - d] : 0;
      out[i] = -g * cur[i] + del + g * (i - d >= 0 ? out[i - d] : 0);
    }
    cur = out;
  }
  return cur;
}

/** Timing resample: the same operation models a clock error and a capture-tuning error. */
function resample(samples, ratio) { return Channel.Channel.freqOffset(samples, ratio); }

/**
 * HILBERT FIR design, for the true frequency shift below.
 *
 * Odd length so the group delay is a whole number of samples (exact alignment), Hamming-windowed so
 * the stopband is deep enough that the residual negative-frequency image is far below the SSTV noise
 * floor.
 */
function hilbertFIR(taps) {
  const M = taps - 1;
  const h = new Float32Array(taps);
  for (let n = 0; n < taps; n++) {
    const k = n - M / 2;
    let v = 0;
    if (k !== 0 && (k % 2) !== 0) v = 2 / (Math.PI * k);
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / M);
    h[n] = v * w;
  }
  return h;
}

/**
 * TRUE frequency offset: shift the whole spectrum by `hz`, leaving the time axis alone.
 *
 * This is what an SSB tuning error, or a receiver whose local oscillator is off, actually does. The
 * frequency-offset rows of the first matrix were built with a resample instead, which is the WRONG
 * model: resampling scales frequency PROPORTIONALLY, so 50 Hz at the 1900 Hz leader is a different
 * shift from 50 Hz at the 1200 Hz sync, and it also changes the line rate - it is a clock error, not a
 * tuning error. Conflating them made tuning error look like a 5 Hz catastrophe when 5 Hz of clock
 * error is 0.26%, which is already known to cost 3 dB on its own.
 *
 * Implemented as the standard analytic-signal shift: delay the signal to match the FIR's group delay,
 * build I + jQ with the Hilbert filter as Q, multiply by exp(j*2*pi*f*t), take the real part.
 */
function freqShift(samples, hz, taps) {
  if (!hz) return samples;
  const nt = taps || 401;
  const h = hilbertFIR(nt);
  const M = (nt - 1) / 2;
  const n = samples.length;
  const out = new Float32Array(n);
  const w = 2 * Math.PI * hz / SR;
  // circular history buffer, so no per-sample array shift
  const buf = new Float32Array(nt);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    buf[pos] = samples[i];
    let q = 0;
    // h[nt-1-k] pairs with the k-th most recent sample (buf index pos - k)
    let idx = pos;
    for (let k = 0; k < nt; k++) {
      q += h[nt - 1 - k] * buf[idx];
      idx = idx === 0 ? nt - 1 : idx - 1;
    }
    pos = pos === nt - 1 ? 0 : pos + 1;
    const ii = i - M >= 0 ? samples[i - M] : 0;   // align I with the filter's group delay
    out[i] = ii * Math.cos(w * i) + q * Math.sin(w * i);
  }
  return out;
}

// ---------------------------------------------------------------- measurement

/** Decoder lock residuals against the encoder's own 1200 Hz segment starts. */
function trueSyncs(timeline) {
  const t = [];
  let acc = 0;
  for (let i = 0; i < timeline.segments.length; i++) {
    const s = timeline.segments[i];
    if (i >= timeline.headerSegments && s.kind === 'tone' && Math.abs(s.freq - Modes.FREQ_SYNC) < 1) {
      t.push(acc);
    }
    acc += s.dur;
  }
  return t.map((v) => v * SR);
}

/**
 * Per-line lock residuals.
 *
 * THREE approaches were tried and two discarded, because the metric is easy to get wrong in ways that
 * look plausible:
 *
 *   (a) "nearest true sync per line" - the pairing is re-decided for every row, and when the residual
 *       sits near +/- half a line it flips between neighbouring syncs. Reported a 2600-sample jitter
 *       under a 0.2% clock error that does not exist. REJECTED.
 *   (b) "index the truth grid from the first lock" (the structural pairing) - correct while the
 *       residual stays inside one line period, but a clock error slides it out, after which the index
 *       refers to the wrong sync and the whole drift shows up as bias. REJECTED.
 *   (c) what is done here: take the line period FROM THE DECODER'S OWN LOCKS. A clock error is a
 *       smooth change of rate, so a least-squares fit of lock position against row index recovers it
 *       exactly, whatever its cause (sample-rate mismatch, tuning error, resampling). Residuals are
 *       then measured against that self-consistent grid, so drift does NOT leak into the scatter and
 *       no search or unwrapping is needed at all.
 *
 * What is reported:
 *   bias       - median residual: a constant lock offset. Harmless, because the demodulator re-locks
 *                on every line and a constant shift moves the whole raster.
 *   slope      - the per-row rate difference from nominal. This IS the clock error, in samples/line.
 *                Also harmless on its own: it is the correction the clock-recovery stage exists to make.
 *   jitterMAD  - MAD of the residual after the linear part is removed. This is the quantity that
 *                blurs: it displaces different rows by irregular amounts that no smooth correction
 *                can absorb.
 *   jitterRun  - median row-to-row CHANGE of that residual, i.e. the visible rag / rope effect.
 */
function residualStats(refs, syncs, timeScale) {
  const locked = refs.filter((r) => !r.freeRun);
  const freeRun = refs.length - locked.length;
  if (locked.length < 8) return null;

  const N = locked.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += i; sy += locked[i].ref; sxx += i * i; sxy += i * locked[i].ref; }
  const den = N * sxx - sx * sx;
  if (!den) return null;
  const slope = (N * sxy - sx * sy) / den;
  const inter = (sy - slope * sx) / N;

  const resid = locked.map((r, i) => r.ref - (inter + slope * i));
  const sorted = resid.slice().sort((a, b) => a - b);
  const bias = sorted[Math.floor(sorted.length / 2)];
  const fin = resid.map((v) => v - bias);
  const mad = medianAbs(fin);
  const run = [];
  for (let i = 1; i < N; i++) {
    if (locked[i].line === locked[i - 1].line + 1) run.push(Math.abs(fin[i] - fin[i - 1]));
  }

  // clock error the decoder saw, against the rate the impairment asked for
  const nominalP = NOMINAL_LINE * (timeScale || 1);
  return {
    n: N, freeRun: freeRun,
    bias: bias, biasPx: bias / PIXEL,
    periodSamples: slope, clockErrorPct: 100 * (slope / NOMINAL_LINE - 1),
    slopeDevFromNominal: slope - nominalP,
    jitterMAD: mad, jitterMADPx: mad / PIXEL,
    jitterRun: run.length ? medianAbs(run) : null,
    jitterRunPx: run.length ? medianAbs(run) / PIXEL : null,
    span: fin.length ? Math.max.apply(null, fin) - Math.min.apply(null, fin) : 0
  };
}

function medianAbs(a) {
  if (!a.length) return null;
  const s = a.map((v) => Math.abs(v)).sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Image statistics on the decoder's RGBA output. */
function imageStats(img) {
  const d = img.data, n = img.width * img.height;
  let sL = 0, sL2 = 0, sGR = 0, sGR2 = 0, sGB = 0, sGB2 = 0;
  for (let i = 0; i < d.length; i += 4) {
    const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const gr = d[i + 1] - d[i], gb = d[i + 1] - d[i + 2];
    sL += L; sL2 += L * L; sGR += gr; sGR2 += gr * gr; sGB += gb; sGB2 += gb * gb;
  }
  const sdL = Math.sqrt(Math.max(0, sL2 / n - (sL / n) * (sL / n)));
  const sdGR = Math.sqrt(Math.max(0, sGR2 / n - (sGR / n) * (sGR / n)));
  const sdGB = Math.sqrt(Math.max(0, sGB2 / n - (sGB / n) * (sGB / n)));
  return {
    sdL, sdGR, sdGB, ratioGR: sdL > 1e-9 ? sdGR / sdL : null,
    rowCorr: rowCorrelation(img),
    shear1: lagRowCorrelation(img, 1),
    shear2: lagRowCorrelation(img, 2)
  };
}

/**
 * Mean adjacent-row correlation of the green channel. A picture scores high, noise near zero.
 * This is the project's established image-likeness measure (tests/real-s1.test.js uses the same one).
 */
function rowCorrelation(img) {
  const w = img.width, h = img.height, d = img.data;
  let sum = 0, count = 0;
  for (let y = 0; y + 1 < h; y++) {
    let ma = 0, mb = 0;
    for (let x = 0; x < w; x++) { ma += d[(y * w + x) * 4 + 1]; mb += d[((y + 1) * w + x) * 4 + 1]; }
    ma /= w; mb /= w;
    let num = 0, da = 0, db = 0;
    for (let x = 0; x < w; x++) {
      const u = d[(y * w + x) * 4 + 1] - ma, v = d[((y + 1) * w + x) * 4 + 1] - mb;
      num += u * v; da += u * u; db += v * v;
    }
    if (da > 0 && db > 0) { sum += num / Math.sqrt(da * db); count++; }
  }
  return count ? sum / count : 0;
}

/**
 * Horizontal shear between rows: the correlation of each row with the row `lag` lines below it SHIFTED
 * by +1 and -1 pixels, reported as (r(+1) - r(-1)) / 2.
 *
 * Why this exists: under a clock error the per-line sync lock stays perfect (the measured jitter does
 * NOT move) while PSNR falls hard. The loss is therefore INSIDE the line - the pixel clock is scaled
 * against the scan, so each row's content slides sideways - and no sync statistic can see it. A row
 * that has slid right correlates better with its neighbour shifted left, and vice versa, so the
 * antisymmetric difference is a signed, zero-centred detector for that slide. Compare the clean cell's
 * value against the impaired one rather than reading it as an absolute.
 */
function lagRowCorrelation(img, lag) {
  const w = img.width, h = img.height, d = img.data;
  const at = (x, y) => d[(y * w + x) * 4 + 1];
  let sum = 0, count = 0;
  for (let y = 0; y + lag < h; y++) {
    let ma = 0, mb = 0, n = 0;
    for (let x = 1; x < w - 1; x++) { ma += at(x, y); mb += at(x, y + lag); n++; }
    ma /= n; mb /= n;
    let rp = 0, da = 0, dbp = 0, rm = 0, dbm = 0;
    for (let x = 1; x < w - 1; x++) {
      const u = at(x, y) - ma;
      const vp = at(x - 1, y + lag) - mb, vm = at(x + 1, y + lag) - mb;
      rp += u * vp; da += u * u; dbp += vp * vp;
      rm += u * vm; dbm += vm * vm;
    }
    if (da > 0 && dbp > 0 && dbm > 0) {
      sum += (rp / Math.sqrt(da * dbp) - rm / Math.sqrt(da * dbm)) / 2;
      count++;
    }
  }
  return count ? sum / count : 0;
}

function psnr(a, b) {
  let se = 0, n = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i];
    se += d * d; n++;
    if (Math.abs(d) > max) max = Math.abs(d);
  }
  const mse = se / n;
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10(65025 / mse), maxDiff: max };
}

/**
 * PSNR per horizontal tenth of the raster, i.e. as a function of the number of PIXELS SINCE THE SYNC.
 *
 * Separates the two ways a timing error destroys a row: a per-line lock error moves the WHOLE row (so
 * every column is equally wrong), while a pixel-clock error accumulates ALONG the scan and is worst at
 * the far edge, furthest from the sync that anchors it. Reporting the profile attributes the loss
 * rather than leaving it to inference - it is how the 1% clock-error PSNR loss was identified.
 */
function psnrProfile(img, ref, width, height) {
  const bands = 10;
  const out = [];
  const bw = Math.floor(width / bands);
  for (let b = 0; b < bands; b++) {
    let se = 0, n = 0;
    const x0 = b * bw, x1 = (b === bands - 1) ? width : (b + 1) * bw;
    for (let y = 0; y < height; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) { const d = img[i + c] - ref[i + c]; se += d * d; n++; }
      }
    }
    const mse = se / n;
    out.push(mse === 0 ? Infinity : 10 * Math.log10(65025 / mse));
  }
  return { bands: out, left: out[0], right: out[bands - 1], drop: out[0] - out[bands - 1] };
}

// ---------------------------------------------------------------- the matrix

function buildMatrix() {
  const cells = [];
  const add = (dim, param, fn, timeScale) =>
    cells.push({ dim, param, fn, timeScale: timeScale == null ? 1 : timeScale });

  /*
   * Frequency offset is a TUNING error, and is modelled as a true spectral shift (see freqShift).
   * Sample-rate mismatch is a CLOCK error, and is modelled as a resample. They are different
   * impairments and must not share an implementation: the first matrix conflated them, which is why
   * its 5 Hz cell - only 0.26% of a clock error - appeared to cost 8 dB.
   */
  const freqs = QUICK ? [0, 20, 50] : [0, 5, -5, 10, -10, 20, -20, 50, -50, 100, -100];
  for (const hz of freqs) {
    add('频率偏移', (hz >= 0 ? '+' : '') + hz + ' Hz',
      (s, sr) => hz === 0 ? s : freqShift(s, hz), 1);
  }

  const rates = QUICK ? [0, 0.2, 1] : [0, 0.05, 0.1, 0.2, 0.5, 1, 2];
  for (const pct of rates) {
    const ratio = 1 + pct / 100;
    add('采样率失配', pct + ' %',
      (s, sr) => pct === 0 ? s : Channel.Channel.freqOffset(s, ratio),
      pct === 0 ? 1 : ratio);
  }

  const snrs = QUICK ? [30, 15, 6] : [null, 30, 20, 15, 10, 6];
  for (const snr of snrs) {
    add('AWGN', snr == null ? 'clean' : 'SNR ' + snr + ' dB',
      (s, sr) => snr == null ? s : Channel.Channel.awgn(s, snr, 12345));
  }

  const clips = QUICK ? [1, 2, 4] : [1, 1.5, 2, 3, 4, 8];
  for (const k of clips) {
    add('削波', k + '×', (s, sr) => clip(s, k));
  }

  const rts = QUICK ? [0.15, 0.6, 1.0] : [0.15, 0.3, 0.6, 1.0];
  for (const rt of rts) {
    const measured = measureRT60(rt, gainScaleFor(rt));
    // the label carries the MEASURED value, so a row can never overstate the impairment
    add('声学路径', 'RT60 ' + (isFinite(measured) ? measured.toFixed(2) : rt.toFixed(2)) + ' s',
      (s, sr) => reverb(s, rt));
  }

  // combinations: the four situations a real off-air or speaker-to-mic capture actually is
  add('组合退化', '灯下干净（RT60 0.3 + +10 Hz 失谐）',
    (s, sr) => freqShift(reverb(s, 0.3), 10));
  add('组合退化', '手机外放（RT60 0.3 + 削波 3× + +20 Hz）',
    (s, sr) => clip(freqShift(reverb(s, 0.3), 20), 3));
  add('组合退化', '弱信号（SNR 15 + RT60 0.3 + +20 Hz）',
    (s, sr) => Channel.Channel.awgn(freqShift(reverb(s, 0.3), 20), 15, 7));
  add('组合退化', '最坏（SNR 10 + RT60 0.6 + 削波 3× + +50 Hz + 0.5%）',
    (s, sr) => clip(Channel.Channel.freqOffset(
      Channel.Channel.awgn(freqShift(reverb(s, 0.6), 50), 10, 99), 1.005), 3), 1.005);
  add('组合退化', 'SSB 失谐 + 噪声（+50 Hz + SNR 20）',
    (s, sr) => Channel.Channel.awgn(freqShift(s, 50), 20, 5));

  return cells;
}

// ---------------------------------------------------------------- runner

(async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log('=== 抗干扰能力基线（退化矩阵）===');
  console.log('模式 ' + MODE.name + ' · ' + MODE.width + 'x' + MODE.height +
              ' · 像素 ' + PIXEL.toFixed(2) + ' 采样' + (QUICK ? ' · --quick' : ''));
  if (QUICK) console.log('（--quick：各维度只取端点+中点）');

  /*
   * Report the MEASURED RT60, not the requested one.
   *
   * The diffusion chain's sections are 30-44 ms long, so a tail cannot be shorter than a few of them;
   * asking for 0.15 s produced 0.20 s. Rather than leave the label lying, the achieved value is
   * measured and printed, and the ladder is labelled with it.
   */
  const rtRequested = QUICK ? [0.15, 0.6, 1.0] : [0.15, 0.3, 0.6, 1.0];
  const rtMeasured = {};
  for (const rt of rtRequested) {
    const m = measureRT60(rt, gainScaleFor(rt));
    rtMeasured[rt] = m;
    rtMeasured[rt.toFixed(4)] = m;
    console.log('  IR 校验 请求 RT60 ' + rt.toFixed(2) + ' s -> 实测 ' +
      (isFinite(m) ? m.toFixed(2) : '>') + ' s · 增益缩放 ' + gainScaleFor(rt).toFixed(3));
  }

  /*
   * sanity 2: the response must NOT have deep periodic notches.
   *
   * This is the check that caught the first reverb model. Feedback combs gave a magnitude response with
   * 20+ dB nulls every 1/D Hz; every reverb cell failed to decode, including RT60 0.15 s, which is a
   * dead giveaway that the MODEL was destroying the signal rather than the reverberation. A diffuse
   * (allpass) tail has a flat magnitude by construction, so the ripple here must stay small.
   */
  {
    const N = 32768;
    const full = reverbIR(0.3, N);
    const re = new Float32Array(N), out = new Float32Array(2 * N);
    for (let i = 0; i < N; i++) re[i] = full[i];
    const fft = new globalThis.FFT(N);
    fft.realTransform(out, re);
    const k0 = Math.ceil(300 * N / SR), k1 = Math.floor(3000 * N / SR);
    let peak = 0, min = Infinity;
    for (let k = k0; k <= k1; k++) {
      const m = Math.hypot(out[2 * k], out[2 * k + 1]);
      if (m > peak) peak = m;
      if (m < min) min = m;
    }
    console.log('  频响校验 RT60 0.30 s -> 300-3000 Hz 带内起伏 ' +
      (20 * Math.log10(peak / Math.max(min, 1e-12))).toFixed(1) +
      ' dB（梳状模型会是 20 dB 以上，扩散尾巴应远小于此）');
  }

  const ctrl = loadControl(MODE, CONTROL);
  const img = ctrl.img;
  const timeline = Timeline.build(img, MODE);
  const clean = Synth.synthesize(timeline, SR);
  const syncs = trueSyncs(timeline);
  console.log('\n控制图: ' + ctrl.label + ' · ' + MODE.width + 'x' + MODE.height +
              ' · 时长 ' + timeline.duration.toFixed(2) +
              ' s · ' + clean.samples.length.toLocaleString() + ' 采样 · 真值同步 ' + syncs.length + ' 个');
  if (PNG) fs.writeFileSync(path.join(OUTDIR, 'degradation-source.png'),
    PNG.sync.write(toPNG(img)));

  const cells = buildMatrix().filter((c) => !ONLY || (c.dim + ' ' + c.param).indexOf(ONLY) >= 0);
  console.log('矩阵单元: ' + cells.length + '\n');

  const rows = [];
  const t00 = Date.now();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const label = c.dim + ' · ' + c.param;
    const degraded = c.fn(clean.samples, SR);
    const refs = [];
    const t0 = Date.now();
    let dec = null, err = null;
    try {
      dec = await Decode.decode(degraded, SR,
        { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
    } catch (e) { err = e.message; }
    const ms = Date.now() - t0;

    const row = { dim: c.dim, param: c.param, index: i };
    if (err || !dec || !dec.ok) {
      row.psnr = null; row.status = '解码失败';
      row.error = err || (dec && dec.message) || 'no result';
    } else {
      const m = psnr(dec.imageData.data, img.data);
      const rs = residualStats(refs, syncs, c.timeScale);
      const st = imageStats(dec.imageData);
      row.psnr = m.psnr; row.maxDiff = m.maxDiff;
      row.bias = rs ? rs.bias : null; row.biasPx = rs ? rs.biasPx : null;
      row.periodSamples = rs ? rs.periodSamples : null;
      row.clockErrorPct = rs ? rs.clockErrorPct : null;
      row.jitterMAD = rs ? rs.jitterMAD : null;
      row.jitterMADPx = rs ? rs.jitterMADPx : null;
      row.jitterRun = rs ? rs.jitterRun : null;
      row.jitterRunPx = rs ? rs.jitterRunPx : null;
      row.freeRun = rs ? rs.freeRun : null;
      row.sdGR = st.sdGR; row.sdL = st.sdL; row.chroma = st.ratioGR;
      row.rowCorr = st.rowCorr; row.shear1 = st.shear1; row.shear2 = st.shear2;
      const prof = psnrProfile(dec.imageData.data, img.data, MODE.width, MODE.height);
      row.profileLeft = prof.left; row.profileRight = prof.right; row.profileDrop = prof.drop;
      row.profile = prof.bands.map((v) => Math.round(v * 10) / 10);
      row.clockScale = dec.calibration ? dec.calibration.clockScale : null;
      row.mode = dec.mode ? dec.mode.name : null;
      row.status = classify(row);
    }
    row.ms = ms;
    rows.push(row);
    if (PNG && row.psnr != null) {
      const safe = (c.dim + '-' + c.param).replace(/[^\w\u4e00-\u9fa5.+-]+/g, '_');
      fs.writeFileSync(path.join(OUTDIR, 'degradation-' + safe + '.png'),
        PNG.sync.write(toPNG(dec.imageData)));
    }
    console.log('[' + String(i + 1).padStart(2) + '/' + cells.length + '] ' + label.padEnd(42) +
      ' PSNR ' + (row.psnr == null ? '  --  ' : row.psnr.toFixed(2).padStart(6)) +
      ' · 偏 ' + fmt(row.bias) + ' · 钟 ' + fmtPct(row.clockErrorPct) + ' · 抖 ' + fmt(row.jitterMAD) +
      ' · 色 ' + (row.chroma == null ? ' -- ' : row.chroma.toFixed(3)) +
      ' · ' + String(ms).padStart(5) + ' ms  ' + row.status);
  }

  console.log('\n总耗时 ' + ((Date.now() - t00) / 1000).toFixed(0) + ' s');
  fs.writeFileSync(path.join(OUTDIR, 'degradation-matrix.json'),
    JSON.stringify({ mode: MODE.id, modeName: MODE.name, sampleRate: SR, quick: QUICK,
      pixelSamples: PIXEL, control: { width: MODE.width, height: MODE.height,
        duration: timeline.duration, syncs: syncs.length }, rows: rows }, null, 2));
  console.log('证据 -> tests/diag-quality/degradation-matrix.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });

function fmt(v) { return v == null ? '  --  ' : v.toFixed(0).padStart(5); }
function fmtPct(v) { return v == null ? '  --  ' : (v >= 0 ? '+' : '') + v.toFixed(3).padStart(6) + '%'; }

/** Pass/fail thresholds, stated once so the table cannot drift from the verdicts. */
function classify(row) {
  if (row.psnr == null) return '失败';
  if (row.psnr < 20) return '崩溃';
  if (row.psnr < 25) return '劣化';
  if (row.chroma != null && row.chroma > 1.0) return '色带';
  if (row.jitterMAD != null && row.jitterMAD / PIXEL > 1.0) return '抖动';
  return '通过';
}

function toPNG(image) {
  const p = new PNG({ width: image.width, height: image.height });
  p.data = Buffer.from(image.data.buffer.slice(0));
  return p;
}
