/*
 * ChannelSim verification (AC1 + AC2).
 *
 * The frequency-offset test is the important one: it asserts the shifter performs a
 * true single-sideband TRANSLATION. The naive implementation (multiplying a real
 * signal by cos) would put a second, comparable tone in the band, which would make
 * the demodulator's peak picker ambiguous for reasons unrelated to robustness. The
 * test therefore checks BOTH the shift amount AND that no image tone appears.
 *
 * Usage: node tests/channel-sim.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'channel-sim.js'));
const ChannelSim = globalThis.ChannelSim;
const FFT = globalThis.FFT;

let failures = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const FS = 48000;

// ---------------------------------------------------------------- spectrum tools
/** High-resolution dominant frequency of a segment, plus image rejection in dB. */
function analyse(samples, from, len, fs) {
  const size = 1 << 17; // 131072 -> 0.37 Hz bins at 48 kHz
  const f = new FFT(size);
  const inp = new Float32Array(size);
  for (let i = 0; i < len; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
    inp[i] = samples[from + i] * w;
  }
  const out = new Float32Array(2 * size);
  f.realTransform(out, inp);
  const half = size / 2;
  const mag = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const re = out[2 * k], im = out[2 * k + 1];
    mag[k] = Math.sqrt(re * re + im * im);
  }
  let peak = 1, best = -1;
  for (let k = 2; k <= half; k++) if (mag[k] > best) { best = mag[k]; peak = k; }
  const y1 = mag[peak - 1], y2 = mag[peak], y3 = mag[peak + 1];
  const den = y3 + y2 + y1;
  const idx = den === 0 ? peak : (y3 - y1) / den + peak;
  // strongest bin at least 20 bins away = image / spurious tone
  let second = 1e-30;
  for (let k = 2; k <= half; k++) {
    if (Math.abs(k - peak) <= 20) continue;
    if (mag[k] > second) second = mag[k];
  }
  return {
    freq: idx * fs / size,
    imageRejectionDb: 20 * Math.log10((y2 + 1e-30) / (second + 1e-30))
  };
}

function tone(freq, seconds, amp) {
  const n = Math.round(seconds * FS);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = (amp == null ? 0.5 : amp) * Math.sin(2 * Math.PI * freq * i / FS);
  return s;
}

/** A signal resembling SSTV: a few tones in the 1200..2300 Hz band. */
function sstvLike(seconds) {
  const n = Math.round(seconds * FS);
  const s = new Float32Array(n);
  const seg = n / 6;
  const freqs = [1900, 1200, 1900, 1500, 2300, 1800];
  for (let i = 0; i < n; i++) {
    const f = freqs[Math.min(freqs.length - 1, Math.floor(i / seg))];
    s[i] = 0.5 * Math.sin(2 * Math.PI * f * i / FS);
  }
  return s;
}

// ================================================================ tests
console.log('ChannelSim verification\n');

// ---------------------------------------------------------------- AC2: SNR
console.log('=== AC2: snrDb actually takes effect (measured output SNR) ===');
console.log('  target   measured   error');
for (const snr of [30, 25, 20, 15, 10, 8, 5]) {
  const x = sstvLike(1.5);
  const y = ChannelSim.apply(x, { snrDb: snr, seed: 42 });
  const m = ChannelSim.measureSnr(x, y);
  const err = m.snrDb - snr;
  console.log(`  ${String(snr).padStart(5)} dB  ${m.snrDb.toFixed(2).padStart(7)} dB  ${err >= 0 ? '+' : ''}${err.toFixed(2)} dB`);
  check(Math.abs(err) < 0.5, `AWGN SNR ${snr} dB within 0.5 dB`, `${m.snrDb.toFixed(2)} dB (len ${y.length})`);
}

// ---------------------------------------------------------------- determinism / purity
console.log('\n=== purity, determinism ===');
{
  const x = sstvLike(0.3);
  const before = Float32Array.from(x);
  const y = ChannelSim.apply(x, { snrDb: 20, seed: 5 });
  let same = true;
  for (let i = 0; i < x.length; i++) if (x[i] !== before[i]) { same = false; break; }
  check(same, 'input array is not mutated');
  check(y !== x, 'a new array is returned');
  const y2 = ChannelSim.apply(x, { snrDb: 20, seed: 5 });
  let ident = true;
  for (let i = 0; i < y.length; i++) if (y[i] !== y2[i]) { ident = false; break; }
  check(ident, 'same seed reproduces identical output');
  const y3 = ChannelSim.apply(x, { snrDb: 20, seed: 6 });
  let differs = false;
  for (let i = 0; i < y.length; i++) if (y[i] !== y3[i]) { differs = true; break; }
  check(differs, 'different seed changes the noise');

  const clean = ChannelSim.apply(x, {});
  let exact = clean.length === x.length;
  for (let i = 0; i < x.length && exact; i++) if (clean[i] !== x[i]) exact = false;
  check(exact, 'empty options is an exact no-op');
}

// ---------------------------------------------------------------- frequency offset
console.log('\n=== frequency offset: true single-sideband translation ===');
console.log('   df     f_in    f_measured   error    image rejection');
for (const df of [0, 5, -5, 20, -20, 50, -50, 100]) {
  const x = tone(1500, 0.4);
  const y = ChannelSim.apply(x, { freqOffset: df, seed: 1 });
  const a = analyse(y, 4000, 12000, FS);
  const expect = 1500 + df;
  const err = a.freq - expect;
  const rejOk = df === 0 ? true : a.imageRejectionDb > 25;
  console.log(`  ${String(df).padStart(4)}  ${String(1500).padStart(6)}  ${a.freq.toFixed(3).padStart(11)}  ${(err >= 0 ? '+' : '') + err.toFixed(3).padStart(6)}    ${a.imageRejectionDb.toFixed(1).padStart(6)} dB`);
  check(Math.abs(err) < 0.5, `freqOffset ${df} Hz shifts by exactly that`, `measured ${a.freq.toFixed(3)} Hz`);
  check(rejOk, `freqOffset ${df} Hz produces no image tone`, `${a.imageRejectionDb.toFixed(1)} dB rejection`);
}

// also check on a multi-tone SSTV-like signal (each component must move together)
{
  const x = sstvLike(0.3);
  for (const df of [30, -30]) {
    const y = ChannelSim.apply(x, { freqOffset: df });
    // first 1/6 of the signal is a 1900 Hz leader
    const a = analyse(y, 500, 8000, FS);
    const err = a.freq - (1900 + df);
    check(Math.abs(err) < 0.6, `SSTV-like leader moves with df=${df}`, `${a.freq.toFixed(2)} Hz (want ${1900 + df})`);
  }
}

// ---------------------------------------------------------------- rate mismatch
console.log('\n=== sample-rate mismatch (receiver clock) ===');
/*
 * A clock error is a TIME SCALING, so it scales the FREQUENCY AXIS too: a 1% error
 * moves 1200 Hz to 1212 and 1900 Hz to 1919 - i.e. it is NOT a constant offset.
 * That is exactly why it is harder to correct than a tuning error, and why the
 * receiver needs a two-point (affine) frequency calibration rather than a plain
 * AFC offset. The assertions below verify the scale property and demonstrate that
 * no single offset fits both tones.
 */
for (const r of [1.0005, 1.001, 1.005, 1.01]) {
  const x = tone(1500, 1.0);
  const y = ChannelSim.apply(x, { rateMismatch: r });
  const expectLen = Math.floor(x.length / r);
  check(y.length === expectLen, `rate ${r}: length scaled by 1/${r}`,
    `${x.length} -> ${y.length} (expected ${expectLen})`);
  const a = analyse(y, 4000, Math.min(12000, y.length - 4001), FS);
  const errPct = 100 * (a.freq / 1500 - r) / r;
  check(Math.abs(errPct) < 0.05, `rate ${r}: tone frequency scales by exactly r`,
    `${a.freq.toFixed(3)} Hz (expected ${(1500 * r).toFixed(3)}, ${errPct.toFixed(3)}% off)`);
}
{
  const r = 1.005;
  const implied = [];
  for (const f0 of [1200, 1900]) {
    const x = tone(f0, 0.6);
    const y = ChannelSim.apply(x, { rateMismatch: r });
    const meas = analyse(y, 4000, 20000, FS).freq;
    implied.push({ f0, meas, offset: meas - f0 });
  }
  const offsetSpread = Math.abs(implied[0].offset - implied[1].offset);
  console.log(`  two-tone check @1.005: 1200 -> ${implied[0].meas.toFixed(2)} (offset ${implied[0].offset.toFixed(2)} Hz),` +
              ` 1900 -> ${implied[1].meas.toFixed(2)} (offset ${implied[1].offset.toFixed(2)} Hz)`);
  check(offsetSpread > 3, 'rate mismatch is NOT a constant offset (offset-only AFC cannot fix it)',
    `implied offsets differ by ${offsetSpread.toFixed(2)} Hz`);
}

// ---------------------------------------------------------------- impulse
console.log('\n=== impulse noise ===');
{
  const x = sstvLike(2.0);
  const y = ChannelSim.apply(x, { impulse: { rate: 50, amp: 10, widthMs: 0.5 }, seed: 9 });
  // count excursions well above anything the clean signal reaches
  const thresh = 0.5 * 3; // signal peak is 0.5; bursts are 10x RMS which is much larger
  let count = 0, inBurst = false;
  for (let i = 0; i < y.length; i++) {
    if (Math.abs(y[i]) > thresh) { if (!inBurst) { count++; inBurst = true; } }
    else inBurst = false;
  }
  const expected = Math.round(50 * 2.0);
  console.log(`  bursts detected = ${count} (configured ~${expected})`);
  check(count >= expected * 0.5 && count <= expected * 1.5, 'impulse burst count roughly as configured',
    `${count} vs ~${expected}`);
  check(ChannelSim.apply(x, { impulse: false }).every((v, i) => v === x[i]), 'impulse:false disables the stage');
}

// ---------------------------------------------------------------- multipath
console.log('\n=== multipath ===');
{
  const n = 2000;
  const x = new Float32Array(n);
  x[0] = 1;
  const y = ChannelSim.apply(x, { multipath: { delayMs: 1, attenuation: 0.4 } });
  const d = Math.round(0.001 * FS);
  check(Math.abs(y[0] - 1) < 1e-6, 'multipath keeps the direct path at unit gain', `y[0]=${y[0]}`);
  check(Math.abs(y[d] - 0.4) < 1e-6, 'multipath adds the delayed copy at the right delay/gain',
    `y[${d}]=${y[d]} (want 0.4)`);
  let other = 0;
  for (let i = 0; i < n; i++) if (i !== 0 && i !== d) other = Math.max(other, Math.abs(y[i]));
  check(other === 0, 'multipath introduces nothing else', `max other = ${other}`);
}

// ---------------------------------------------------------------- AC1: presets
console.log('\n=== AC1: the four presets degrade the signal as described ===');
const presets = ChannelSim.presets();
check(presets.length === 4, 'exactly four presets', presets.map((p) => p.name).join(', '));
for (const want of ['clean', 'mild', 'moderate', 'severe']) {
  check(presets.some((p) => p.name === want), `preset "${want}" exists`);
}
console.log('  preset     len change   measured SNR   leader shift   description');
for (const p of presets) {
  const x = sstvLike(1.2);
  const y = ChannelSim.apply(x, p.options);
  // SNR must be measured against the same configuration WITHOUT the noise; the
  // frequency offset and resampling make a sample-wise comparison to the original
  // signal meaningless.
  const m = ChannelSim.measureAwgnSnr(x, p.options);
  const shift = analyse(y, 2000, 9000, FS).freq - analyse(x, 2000, 9000, FS).freq;
  const lenPct = (100 * (y.length / x.length - 1));
  // expected leader shift combines the translation and the frequency-axis scaling
  const r = ChannelSim.normalize(p.options).rateMismatch;
  const expectedShift = (1900 + (p.options.freqOffset || 0)) * r - 1900;
  console.log(`  ${p.name.padEnd(9)}  ${(lenPct >= 0 ? '+' : '') + lenPct.toFixed(2)}%   ` +
    `${(isFinite(m.snrDb) ? m.snrDb.toFixed(2) : 'inf').padStart(8)} dB   ` +
    `${(shift >= 0 ? '+' : '') + shift.toFixed(2).padStart(6)} Hz (want ${expectedShift >= 0 ? '+' : ''}${expectedShift.toFixed(2)})   ${ChannelSim.describe(p.options).join('; ')}`);
  if (p.name === 'clean') {
    let exact = y.length === x.length;
    for (let i = 0; i < x.length && exact; i++) if (y[i] !== x[i]) exact = false;
    check(exact, 'clean preset is a bit-exact passthrough');
  }
  if (p.name === 'mild') {
    check(Math.abs(m.snrDb - 25) < 0.5, 'mild preset SNR = 25 dB', `${m.snrDb.toFixed(2)} dB`);
    check(Math.abs(shift - expectedShift) < 0.6, 'mild preset shifts the leader as predicted', `${shift.toFixed(2)} Hz`);
  }
  if (p.name === 'moderate') {
    check(Math.abs(m.snrDb - 15) < 0.5, 'moderate preset SNR = 15 dB', `${m.snrDb.toFixed(2)} dB`);
    check(Math.abs(shift - expectedShift) < 0.8, 'moderate preset shifts the leader as predicted (offset x rate)',
      `${shift.toFixed(2)} Hz vs ${expectedShift.toFixed(2)}`);
    check(Math.abs(y.length / x.length - 1 / 1.005) < 0.002, 'moderate preset applies 0.5% rate mismatch',
      `${(100 * (y.length / x.length - 1)).toFixed(3)}%`);
  }
  if (p.name === 'severe') {
    check(Math.abs(m.snrDb - 8) < 0.5, 'severe preset SNR = 8 dB', `${m.snrDb.toFixed(2)} dB`);
    check(Math.abs(y.length / x.length - 1 / 1.010) < 0.002, 'severe preset applies 1% rate mismatch',
      `${(100 * (y.length / x.length - 1)).toFixed(3)}%`);
    let spikes = 0, inB = false;
    for (let i = 0; i < y.length; i++) {
      if (Math.abs(y[i]) > 1.5) { if (!inB) { spikes++; inB = true; } } else inB = false;
    }
    check(spikes > 5, 'severe preset injects impulse bursts', `${spikes} bursts`);
  }
}

// ---------------------------------------------------------------- spec aliases
console.log('\n=== option aliases from the spec are accepted ===');
{
  const x = sstvLike(0.5);
  const a = ChannelSim.apply(x, { sampleRateMismatch: 1.005 });
  check(a.length === Math.floor(x.length / 1.005), 'sampleRateMismatch (1.005 form) works', `${a.length}`);
  const b = ChannelSim.apply(x, { sampleRateMismatch: 0.005 });
  check(b.length === Math.floor(x.length / 1.005), 'sampleRateMismatch (0.005 form) works', `${b.length}`);
  const c = ChannelSim.apply(x, { awgn: true, snrDb: 20 });
  check(Math.abs(ChannelSim.measureSnr(x, c).snrDb - 20) < 0.5, 'awgn:true + snrDb works');
  const d = ChannelSim.apply(x, { impulseRate: 40, impulseAmp: 8 });
  let sp = 0, inB = false;
  for (let i = 0; i < d.length; i++) { if (Math.abs(d[i]) > 1.2) { if (!inB) { sp++; inB = true; } } else inB = false; }
  check(sp > 5, 'flat impulseRate/impulseAmp aliases work', `${sp} bursts`);
}

console.log('\n================================');
console.log(failures === 0 ? 'CHANNELSIM VERIFIED' : failures + ' CHECK(S) FAILED');
process.exitCode = failures === 0 ? 0 : 1;
