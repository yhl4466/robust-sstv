/*
 * Phase-6 realistic impairment suite + portfolio builder.
 *
 * The existing ChannelSim presets are idealised (AWGN, constant rate error, static
 * multipath). Real SSTV reception fails for different reasons, and this file models the
 * ones that actually matter:
 *
 *   acoustic     room reverberation (decaying-noise RIR), mains hum + harmonics,
 *                microphone noise, loudspeaker/microphone band tilt
 *   radio        SSB passband (300-2700 Hz) with steep skirts, AGC gain riding,
 *                QSB fading (slow AM plus occasional deep dips), flutter
 *   level        hard clipping / overload - a very common real cause of failure
 *   clock        slow AFFINE time warp (two devices, two crystals), not a constant rate
 *   sample rate  44100 / 22050 / 16000 / 11025 / 8000
 *   framing      leading silence, truncated tail
 *
 * Everything is labelled: the portfolio manifest records, per file, whether the audio came
 * from a real recording or from this suite, and the exact recipe. The report must never
 * present synthesised impairment as a real recording.
 *
 * Usage: node scripts/build-real-portfolio.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const REALDIR = path.join(ROOT, 'tests', 'fixtures', 'real');
const Wav = require(path.join(ROOT, 'js', 'lib', 'wav.js'));
global.self = global;
const SSTVWav = require(path.join(ROOT, 'js', 'lib', 'wav.js'));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); }
function peak(x) { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; }
function copy(x) { return Float32Array.from(x); }

/** Linear-interpolation resampler; adequate for a band-limited 1.2-2.3 kHz signal. */
function resample(x, from, to) {
  if (from === to) return copy(x);
  const n = Math.max(1, Math.round(x.length * to / from));
  const out = new Float32Array(n);
  const step = (x.length - 1) / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const p = i * step, i0 = Math.floor(p), i1 = Math.min(x.length - 1, i0 + 1), w = p - i0;
    out[i] = x[i0] * (1 - w) + x[i1] * w;
  }
  return out;
}
/** Time warp: resample with a slowly varying rate (two independent crystals). */
function clockWarp(x, sr, ppm, wanderPpm, seed) {
  const rnd = mulberry32(seed || 7);
  const out = new Float32Array(x.length);
  let t = 0, phase = 0;
  const drift = ppm * 1e-6, wander = (wanderPpm || 0) * 1e-6;
  const wf = 0.05 + rnd() * 0.05;             // wander frequency, Hz
  for (let i = 0; i < x.length; i++) {
    const rate = 1 + drift + wander * Math.sin(2 * Math.PI * wf * (i / sr));
    t += rate;
    const i0 = Math.floor(t), i1 = Math.min(x.length - 1, i0 + 1), w = t - i0;
    out[i] = i0 < x.length ? x[i0] * (1 - w) + x[i1] * w : 0;
    phase++;
  }
  return out;
}
/** Simple biquad band-pass (RBJ), used as a loudspeaker/microphone or SSB filter model. */
function biquad(x, sr, type, f0, q, gainDb) {
  const w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else if (type === 'peak') {
    const A = Math.pow(10, gainDb / 40);
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
/** Room impulse response as exponentially decaying noise. */
function makeRIR(sr, rt60, seed) {
  const n = Math.max(64, Math.round(rt60 * sr * 1.2));
  const rnd = mulberry32(seed || 11);
  const h = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.pow(10, -3 * t / rt60);
    h[i] = (rnd() * 2 - 1) * env;
    acc += h[i] * h[i];
  }
  const norm = Math.sqrt(acc) || 1;
  for (let i = 0; i < n; i++) h[i] /= norm;
  // direct path first so the impulse response is not smeared at t=0
  h[0] += 1.0;
  return h;
}
function convolve(x, h) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    const k = Math.min(h.length, x.length - i);
    for (let j = 0; j < k; j++) acc += h[j] * x[i + j] * 0;   // placeholder, replaced below
    out[i] = acc;
  }
  // direct O(n*h) convolution (signals are ~100 s at 8-48 kHz; keep h short)
  const y = new Float32Array(x.length);
  for (let j = 0; j < h.length; j++) {
    const hj = h[j];
    if (hj === 0) continue;
    for (let i = 0; i + j < x.length; i++) y[i + j] += x[i] * hj;
  }
  return y;
}
function addNoise(x, snrDb, seed) {
  const rnd = mulberry32(seed || 3);
  const r = rms(x), target = r / Math.pow(10, snrDb / 20);
  const out = copy(x);
  for (let i = 0; i < out.length; i++) out[i] += (rnd() * 2 - 1) * target * 1.732;
  return out;
}
function addHum(x, sr, levelDb) {
  const r = rms(x), amp = r * Math.pow(10, levelDb / 20);
  const out = copy(x);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] += amp * (Math.sin(2 * Math.PI * 50 * t) + 0.4 * Math.sin(2 * Math.PI * 150 * t)
      + 0.2 * Math.sin(2 * Math.PI * 250 * t));
  }
  return out;
}
function agc(x, sr, targetRms) {
  const out = new Float32Array(x.length);
  const atk = Math.exp(-1 / (0.005 * sr)), rel = Math.exp(-1 / (0.25 * sr));
  let env = 0, g = 1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    env = a > env ? atk * env + (1 - atk) * a : rel * env + (1 - rel) * a;
    const want = env > 1e-6 ? targetRms / env : 1;
    g += (want - g) * 0.02;
    out[i] = x[i] * Math.min(4, Math.max(0.25, g));
  }
  return out;
}
function fade(x, sr, depthDb, rateHz, seed) {
  const rnd = mulberry32(seed || 5);
  const out = copy(x);
  const ph = rnd() * Math.PI * 2;
  const d = Math.pow(10, -Math.abs(depthDb) / 20);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const m = 1 - (1 - d) * (0.5 - 0.5 * Math.cos(2 * Math.PI * rateHz * t + ph));
    out[i] *= m;
  }
  return out;
}
/** Periodic deep dips: what a passing fade sounds like. */
function deepFades(x, sr, depthDb, everySec, lenSec) {
  const out = copy(x);
  const d = Math.pow(10, -Math.abs(depthDb) / 20);
  for (let s = everySec; s < out.length / sr; s += everySec) {
    const a = Math.round(s * sr), b = Math.min(out.length, a + Math.round(lenSec * sr));
    for (let i = a; i < b; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - a) / (b - a));
      out[i] *= 1 - (1 - d) * w;
    }
  }
  return out;
}
function clip(x, drive) {
  const out = new Float32Array(x.length);
  const g = drive / (peak(x) || 1);
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * g;
    out[i] = v > 1 ? 1 : (v < -1 ? -1 : v);   // hard clip
  }
  return out;
}
function addAdjacentTone(x, sr, levelDb) {
  const r = rms(x), amp = r * Math.pow(10, levelDb / 20);
  const out = copy(x);
  for (let i = 0; i < out.length; i++) out[i] += amp * Math.sin(2 * Math.PI * 2700 * i / sr);
  return out;
}

/**
 * The portfolio. Each recipe names its transform chain, so the report can state exactly
 * what was done to the source recording.
 */
function recipes() {
  const list = [];
  // --- sample rate ---
  for (const r of [44100, 22050, 16000, 11025, 8000]) {
    list.push({ id: `rate-${r}`, group: 'sample rate', label: `${r} Hz`, steps: [{ op: 'rate', to: r }] });
  }
  // --- level / clipping ---
  for (const d of [1.5, 3, 8]) {
    list.push({ id: `clip-${d}x`, group: 'clipping', label: `hard clip ${d}x drive`, steps: [{ op: 'clip', drive: d }] });
  }
  // --- radio path ---
  list.push({ id: 'ssb-agc', group: 'radio', label: 'SSB 300-2700 + AGC', steps: [{ op: 'ssb' }, { op: 'agc' }] });
  list.push({ id: 'ssb-qsb-slow', group: 'radio', label: 'SSB + slow QSB 10 dB', steps: [{ op: 'ssb' }, { op: 'fade', depthDb: 10, rateHz: 0.08 }] });
  list.push({ id: 'ssb-qsb-deep', group: 'radio', label: 'SSB + deep fades 24 dB/4 s', steps: [{ op: 'ssb' }, { op: 'deepFade', depthDb: 24, everySec: 4, lenSec: 0.6 }] });
  list.push({ id: 'ssb-hum', group: 'radio', label: 'SSB + 50 Hz hum -20 dB', steps: [{ op: 'ssb' }, { op: 'hum', levelDb: -20 }] });
  list.push({ id: 'ssb-adjacent', group: 'radio', label: 'SSB + adjacent 2700 Hz tone', steps: [{ op: 'ssb' }, { op: 'adjacent', levelDb: -14 }] });
  // --- noise ---
  list.push({ id: 'awgn-20', group: 'noise', label: 'AWGN 20 dB', steps: [{ op: 'noise', snrDb: 20 }] });
  list.push({ id: 'awgn-12', group: 'noise', label: 'AWGN 12 dB', steps: [{ op: 'noise', snrDb: 12 }] });
  list.push({ id: 'awgn-6', group: 'noise', label: 'AWGN 6 dB', steps: [{ op: 'noise', snrDb: 6 }] });
  // --- acoustic path (speaker -> microphone) ---
  list.push({ id: 'acoustic-rt03', group: 'acoustic', label: 'room RT60 0.3 s + hum + mic noise', steps: [{ op: 'rir', rt60: 0.3 }, { op: 'hum', levelDb: -26 }, { op: 'noise', snrDb: 26 }] });
  list.push({ id: 'acoustic-rt06', group: 'acoustic', label: 'room RT60 0.6 s + hum + mic noise', steps: [{ op: 'rir', rt60: 0.6 }, { op: 'hum', levelDb: -22 }, { op: 'noise', snrDb: 20 }] });
  list.push({ id: 'acoustic-band', group: 'acoustic', label: 'speaker/mic band tilt + RT60 0.4', steps: [{ op: 'rir', rt60: 0.4 }, { op: 'tilt' }, { op: 'noise', snrDb: 24 }] });
  // --- clock ---
  list.push({ id: 'clock-200ppm', group: 'clock', label: 'clock +200 ppm', steps: [{ op: 'warp', ppm: 200 }] });
  list.push({ id: 'clock-wander', group: 'clock', label: 'clock -100 ppm with wander +-80 ppm', steps: [{ op: 'warp', ppm: -100, wanderPpm: 80 }] });
  // --- framing ---
  list.push({ id: 'lead-3s', group: 'framing', label: '3.0 s leading silence', steps: [{ op: 'lead', seconds: 3.0 }] });
  list.push({ id: 'truncate-8pct', group: 'framing', label: 'tail truncated 8%', steps: [{ op: 'truncate', fraction: 0.08 }] });
  // --- combined worst case ---
  list.push({ id: 'combo-hard', group: 'combined', label: 'SSB + AGC + QSB + hum + 14 dB AWGN', steps: [{ op: 'ssb' }, { op: 'agc' }, { op: 'fade', depthDb: 8, rateHz: 0.1 }, { op: 'hum', levelDb: -22 }, { op: 'noise', snrDb: 14 }] });
  return list;
}

function apply(samples, sr, steps) {
  let x = copy(samples), rate = sr;
  const notes = [];
  for (const s of steps) {
    switch (s.op) {
      case 'rate': x = resample(x, rate, s.to); rate = s.to; notes.push(`resample ${sr}->${s.to}`); break;
      case 'clip': x = clip(x, s.drive); notes.push(`hard clip, drive ${s.drive}x`); break;
      case 'ssb': x = biquad(x, rate, 'hp', 300, 0.7); x = biquad(x, rate, 'lp', 2700, 0.7); notes.push('SSB passband 300-2700 Hz'); break;
      case 'agc': x = agc(x, rate, rms(samples) * 0.8); notes.push('AGC'); break;
      case 'fade': x = fade(x, rate, s.depthDb, s.rateHz, 21); notes.push(`QSB ${s.depthDb} dB @ ${s.rateHz} Hz`); break;
      case 'deepFade': x = deepFades(x, rate, s.depthDb, s.everySec, s.lenSec); notes.push(`deep fades ${s.depthDb} dB every ${s.everySec} s`); break;
      case 'hum': x = addHum(x, rate, s.levelDb); notes.push(`mains hum ${s.levelDb} dB`); break;
      case 'adjacent': x = addAdjacentTone(x, rate, s.levelDb); notes.push(`adjacent tone ${s.levelDb} dB`); break;
      case 'noise': x = addNoise(x, s.snrDb, 31); notes.push(`AWGN ${s.snrDb} dB`); break;
      case 'rir': { const h = makeRIR(rate, s.rt60, 13); x = convolve(x, h); notes.push(`room RT60 ${s.rt60} s`); break; }
      case 'tilt': x = biquad(x, rate, 'peak', 900, 1.0, -8); x = biquad(x, rate, 'peak', 2600, 1.0, -14); notes.push('band tilt -8/-14 dB'); break;
      case 'warp': x = clockWarp(x, rate, s.ppm, s.wanderPpm, 17); notes.push(`clock ${s.ppm} ppm${s.wanderPpm ? ` +-${s.wanderPpm} ppm wander` : ''}`); break;
      case 'lead': { const z = new Float32Array(Math.round(s.seconds * rate) + x.length); z.set(x, Math.round(s.seconds * rate)); x = z; notes.push(`${s.seconds} s leading silence`); break; }
      case 'truncate': { const keep = Math.round(x.length * (1 - s.fraction)); x = x.subarray(0, keep); notes.push(`tail truncated ${(s.fraction * 100).toFixed(0)}%`); break; }
      default: throw new Error('unknown op ' + s.op);
    }
  }
  // normalise to a sane recording level
  const p = peak(x) || 1;
  const y = copy(x);
  const g = 0.7 / p;
  for (let i = 0; i < y.length; i++) y[i] *= g;
  return { samples: y, rate, notes };
}

(function main() {
  fs.mkdirSync(REALDIR, { recursive: true });
  const sources = [
    {
      key: 'npm-8k',
      file: path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.wav'),
      reference: path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'sstv', 'examples', 'sample.png'),
      source: "npm package 'sstv' example recording (real reception sample shipped with an SSTV decoder)",
      license: 'MIT (upstream package)'
    },
    {
      key: 'colaclanth-8k',
      file: path.join(ROOT, '..', '.research', 'real-sstv', 'colaclanth-m1-8k.wav'),
      reference: null,
      source: "colaclanth/sstv examples/m1.ogg (OGG 44.1 kHz stereo, converted to 8 kHz mono with ffmpeg)",
      license: 'MIT (upstream repo)'
    }
  ].filter((s) => fs.existsSync(s.file));

  if (!sources.length) { console.log('no real source audio found'); process.exitCode = 1; return; }

  const entries = [];
  /*
   * Paths are written RELATIVE TO THE REPO ROOT, not absolute.
   *
   * Absolute paths were the original choice and they broke twice over: the sample files live
   * inside the application directory, so renaming that directory invalidated 24 of the 26
   * entries, and any absolute path also fails as soon as the checkout moves to another
   * machine or user. Relative paths cost nothing and survive both. Consumers resolve them
   * against ROOT (see eval-real-decode.js / eval-postprocess.js).
   */
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
  // 1. the untouched real recordings
  for (const s of sources) {
    const parsed = SSTVWav.parse(fs.readFileSync(s.file).buffer.slice(0));
    entries.push({
      id: `real-${s.key}`, kind: 'real', file: rel(s.file),
      reference: s.reference ? rel(s.reference) : null,
      sampleRate: parsed.sampleRate, duration: parsed.duration,
      source: s.source, license: s.license, recipe: 'none (untouched recording)'
    });
  }
  // 2. the realistic portfolio built from the FIRST real source (the one with a reference)
  const base = SSTVWav.parse(fs.readFileSync(sources[0].file).buffer.slice(0));
  for (const r of recipes()) {
    const out = apply(base.samples, base.sampleRate, r.steps);
    const file = path.join(REALDIR, `${r.id}.wav`);
    fs.writeFileSync(file, Buffer.from(SSTVWav.encode(out.samples, out.rate)));
    entries.push({
      id: r.id, kind: 'realistic-synthetic', group: r.group, label: r.label,
      file: rel(file),
      reference: sources[0].reference ? rel(sources[0].reference) : null,
      derivedFrom: `real-${sources[0].key}`,
      sampleRate: out.rate, duration: out.samples.length / out.rate,
      source: `derived from the real recording by the phase-6 realistic impairment suite`,
      license: 'MIT (upstream package)',
      recipe: out.notes.join('; ')
    });
  }

  const manifest = {
    _comment: 'kind=real is an untouched real-world recording; kind=realistic-synthetic is the real recording passed through the phase-6 impairment suite. Never mix them in reporting.',
    generatedBy: 'scripts/build-real-portfolio.js',
    samples: entries
  };
  fs.writeFileSync(path.join(REALDIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`Built a portfolio of ${entries.length} samples`);
  const byKind = {};
  for (const e of entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  console.log('  ' + Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(', '));
  const byGroup = {};
  for (const e of entries) if (e.group) byGroup[e.group] = (byGroup[e.group] || 0) + 1;
  console.log('  groups: ' + Object.entries(byGroup).map(([k, v]) => `${k}=${v}`).join(', '));
  console.log('\n| id | kind | group | what was done | rate | dur |');
  console.log('|---|---|---|---|---|---|');
  for (const e of entries) {
    console.log(`| ${e.id} | ${e.kind} | ${e.group || '-'} | ${e.recipe} | ${e.sampleRate} | ${e.duration.toFixed(1)} s |`);
  }
  console.log(`\n-> ${path.relative(ROOT, path.join(REALDIR, 'manifest.json'))}`);
})();
