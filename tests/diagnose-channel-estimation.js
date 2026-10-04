/*
 * Can the reverberant channel be ESTIMATED from the signal's own known structure?
 *
 * WHY THIS IS THE QUESTION THAT DECIDES THE NEXT STEP
 *   The acoustic path is the largest practical gap in the phase-49 matrix: RT60 0.20 s costs 7.1 dB
 *   (30.50 -> 23.39), 0.30 s costs 12.7 dB, and 0.60 s fails outright. tests/diagnose-reverb.js localised
 *   it: the per-line sync lock stays accurate (MAD 7-12 samples, under one pixel) while the dominant
 *   frequency read over a ~1.3 ms window has a standard deviation of 230 Hz, i.e. the multipath tail
 *   fills the pixel analysis window.
 *
 *   Every repair for that - deconvolution, a matched filter against the channel, an MMSE equaliser -
 *   needs the channel. Blind estimation is a research problem; estimation from KNOWN signal structure is
 *   not, and SSTV provides a lot of it:
 *
 *     - 256 sync pulses of exactly 9 ms at exactly 1200 Hz, each preceded and followed by known porches
 *     - the 300 ms 1900 Hz leader and the VIS header tones, of exactly known frequency and length
 *
 *   This script asks the cheap question first: does averaging the signal over the sync positions, which
 *   are known to within ~1 px, produce a recognisable impulse response? If it does, an equaliser is
 *   buildable. If it does not, the honest answer is that this needs a different approach and should not
 *   be started on a guess.
 *
 * Usage: node tests/diagnose-channel-estimation.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Decode = globalThis.SSTVDecode;

// lift the matrix's reverb, so the impairment is the same one the matrix measures
const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const MODELS = new Function('SR', 'Channel',
  SRC.slice(SRC.indexOf('function clip('), SRC.indexOf('// ---------------------------------------------------------------- measurement')) +
  '\nreturn { reverb: reverb, reverbIR: reverbIR, buildIR: buildIR, measureRT60: measureRT60, gainScaleFor: gainScaleFor };')(
    SR, require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js')));

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  return 10 * Math.log10(65025 / (se / n));
}

/**
 * Estimate the channel's impulse response by averaging the received signal over the sync positions.
 *
 * The reasoning: each sync pulse is preceded by a known porch and is itself a known tone, so after
 * removing the local mean the segment around a sync is (pulse shape) * h plus content noise. Averaging
 * 250 of them suppresses whatever is uncorrelated with the sync - which is the music and the image
 * content - and leaves h convolved with the sync's own shape. The result is not h itself but it is
 * enough to see whether a channel estimate is recoverable at all, and how long its tail is.
 */
function estimateFromSyncs(x, syncPositions, half, pre) {
  const acc = new Float64Array(half * 2);
  let used = 0;
  for (const p of syncPositions) {
    const start = p - pre;
    if (start < 0 || start + acc.length >= x.length) continue;
    for (let i = 0; i < acc.length; i++) acc[i] += x[start + i];
    used++;
  }
  if (!used) return { ir: acc, used: 0 };
  for (let i = 0; i < acc.length; i++) acc[i] /= used;
  return { ir: acc, used: used };
}

/** Energy decay of the estimate, as a crude RT60 proxy. Only used for comparison, not as a measurement. */
function tailDecay(ir, pre, sr) {
  const w = Math.round(0.002 * sr);
  const wins = [];
  let acc = 0;
  for (let i = 0; i < ir.length; i++) {
    acc += ir[i] * ir[i];
    if ((i + 1) % w === 0) { wins.push(acc); acc = 0; }
  }
  const ref = Math.max.apply(null, wins);
  const out = [];
  for (let i = 0; i < wins.length; i += 5) {
    out.push((10 * Math.log10(Math.max(wins[i], 1e-20) / ref)).toFixed(1));
  }
  return out.join(' ');
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const tl = Timeline.build(img, Modes.get('S1'));
  const clean = Synth.synthesize(tl, SR).samples;

  // the encoder's own sync positions: exact truth, so the estimate is not limited by detection error
  const syncs = [];
  {
    let acc = 0;
    for (let i = 0; i < tl.segments.length; i++) {
      const s = tl.segments[i];
      if (i >= tl.headerSegments && s.kind === 'tone' && Math.abs(s.freq - Modes.FREQ_SYNC) < 1) {
        syncs.push(Math.round(acc * SR));
      }
      acc += s.dur;
    }
  }
  console.log('=== 混响信道能否从信号自身结构估计出来 ===\n');
  console.log('  真值同步脉冲 ' + syncs.length + ' 个 · 每个 9 ms @ 1200 Hz');
  console.log('  估计方式：以同步位置对齐、跨全部脉冲取平均（对不与同步相关的音乐/图象内容取平均抵消）\n');

  const HALF = Math.round(0.060 * SR);    // +/-60 ms around the sync
  const PRE = Math.round(0.020 * SR);
  const rt = 0.3;
  const measured = MODELS.measureRT60(rt, MODELS.gainScaleFor(rt));
  const reverbed = MODELS.reverb(clean, rt);
  console.log('  混响 RT60 请求 ' + rt + ' s → 实测 ' + measured.toFixed(2) + ' s\n');

  console.log('  信道估计（同步后 2 ms 窗能量相对峰值的衰减，dB，每 10 ms 一格）');
  console.log('    干净信号 : ' + tailDecay(estimateFromSyncs(clean, syncs, HALF, PRE).ir, PRE, SR));
  console.log('    混响信号 : ' + tailDecay(estimateFromSyncs(reverbed, syncs, HALF, PRE).ir, PRE, SR));
  console.log('    （干净信号的尾巴应很快降到很低；混响信号的尾巴应呈现明显长尾）\n');

  /*
   * Does the estimate actually resemble the applied reverb? Compare the averaged segment of the REVERBED
   * signal against the convolution of the averaged segment of the CLEAN signal with the reverb's own IR.
   * If the estimate is meaningful the two should agree well; that is a quantitative check rather than an
   * eyeball one.
   */
  const irClean = estimateFromSyncs(clean, syncs, HALF, PRE).ir;
  const irRev = estimateFromSyncs(reverbed, syncs, HALF, PRE).ir;
  const appliedIR = (function () {
    const L = Math.round(0.0015 * SR);
    const h = new Float32Array(L);
    const ir = MODELS.reverbIR(rt, L);
    for (let i = 0; i < L; i++) h[i] = ir[i];
    return h;
  })();
  // convolve irClean with the applied IR, then compare in the tail region (after the sync itself)
  const conv = new Float64Array(irClean.length);
  for (let i = 0; i < irClean.length; i++) {
    let s = 0;
    for (let k = 0; k < appliedIR.length; k++) {
      const j = i - k;
      if (j >= 0 && j < irClean.length) s += appliedIR[k] * irClean[j];
    }
    conv[i] = s;
  }
  // normalise both to their peak and compare over the region after the sync (PRE..PRE+9ms)
  const peak = (a) => { let p = 0; for (const v of a) if (Math.abs(v) > p) p = Math.abs(v); return p; };
  const pa = peak(irRev), pc = peak(conv);
  let se = 0, sc = 0;
  const from = PRE + Math.round(0.009 * SR), to = PRE + Math.round(0.050 * SR);
  for (let i = from; i < to; i++) {
    const a = irRev[i] / pa, c = conv[i] / pc;
    se += (a - c) * (a - c); sc += c * c;
  }
  const agreeDb = 10 * Math.log10(sc / Math.max(se, 1e-20));
  console.log('  估计与"干净段卷积真实混响 IR"的一致性（同步后 9-50 ms 区间）: ' + agreeDb.toFixed(1) + ' dB');
  console.log('  （> 10 dB 表示尾巴形状确实被估出来了；接近 0 dB 表示估计只是噪声）\n');

  /*
   * The practical question: is a simple deconvolution from this estimate worth anything? Apply a
   * regularised inverse (truncated, Tikhonov-damped) to the whole signal and measure the decode.
   * A crude equaliser that recovers several dB means the approach is sound; one that recovers nothing
   * means the estimate is too poor and the next step should be a different one.
   */
  const NH = 256;
  const h = new Float64Array(NH);
  {
    const ir = MODELS.reverbIR(rt, NH);
    for (let i = 0; i < NH; i++) h[i] = ir[i];
  }
  // frequency-domain inverse with Tikhonov damping, computed once
  const NFFT = 1024;
  const Hre = new Float64Array(NFFT), Him = new Float64Array(NFFT);
  {
    for (let k = 0; k < NFFT; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < NH; i++) {
        const a = -2 * Math.PI * k * i / NFFT;
        re += h[i] * Math.cos(a); im += h[i] * Math.sin(a);
      }
      Hre[k] = re; Him[k] = im;
    }
  }
  const lambda = 1e-3;
  function equalise(x) {
    const n = x.length;
    const out = new Float32Array(n);
    const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
    const ci = new Float32Array(2 * NFFT), co = new Float32Array(2 * NFFT);
    const fft = new globalThis.FFT(NFFT);
    for (let off = 0; off + NFFT <= n; off += NFFT) {
      for (let i = 0; i < NFFT; i++) re[i] = x[off + i];
      fft.realTransform(co, re);
      for (let k = 0; k < NFFT; k++) {
        const a = co[2 * k], b = co[2 * k + 1];
        const mr = Hre[k], mi = -Him[k];
        const den = mr * mr + mi * mi + lambda;
        ci[2 * k] = (a * mr - b * mi) / den;
        ci[2 * k + 1] = (a * mi + b * mr) / den;
      }
      fft.inverseTransform(co, ci);
      for (let i = 0; i < NFFT; i++) out[off + i] = co[2 * i];
    }
    return out;
  }

  console.log('  简易 Tikhonov 反卷积（用真实 IR，256 抽头）对解码的影响：');
  console.log('    输入            PSNR');
  const base = await Decode.decode(reverbed, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  if (!base.ok) { console.log('    混响基线: 解码失败'); }
  else console.log('    混响基线        ' + psnr(base.imageData.data, img.data).toFixed(2));
  const eq = equalise(reverbed);
  const rEq = await Decode.decode(eq, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  if (!rEq.ok) console.log('    反卷积后        解码失败（' + rEq.message + '）');
  else console.log('    反卷积后        ' + psnr(rEq.imageData.data, img.data).toFixed(2));

  /*
   * And the ESTIMATED estimate, which is the realistic case: the sync-averaged tail rather than the
   * analytic IR. This is the number that decides whether the approach is viable without knowing h.
   */
  console.log('\n  说明：上面的反卷积用的是"真实 IR"，属于上界。用同步平均估计出的 IR 才是可实现的，');
  console.log('        其质量由前面那个一致性数字界定 —— 若它只有几 dB，则这一步的真实收益远小于上界。');

  fs.writeFileSync(path.join(OUT, 'channel-estimation.json'), JSON.stringify({
    rt60Requested: rt, rt60Measured: measured, syncs: syncs.length,
    agreementDb: agreeDb,
    decayClean: tailDecay(irClean, PRE, SR), decayReverb: tailDecay(irRev, PRE, SR),
    psnrBaseline: base.ok ? psnr(base.imageData.data, img.data) : null,
    psnrEqualised: rEq.ok ? psnr(rEq.imageData.data, img.data) : null
  }, null, 2));
  console.log('\n证据 -> tests/diag-quality/channel-estimation.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
