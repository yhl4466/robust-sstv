/*
 * What base clip and quality setting can the interactive demo afford?
 *
 * The demo has to re-decode inside a click, so this measures the two knobs that decide feasibility:
 * the sample rate of the base clip, and the decoder quality profile. Everything else is fixed by the
 * requirement that the clip contain a real Scottie/Martin scan (otherwise there is no image to score).
 *
 * Output: a table of decode wall-clock times, so the demo can pick a combination that lands in 3-5 s.
 *
 * Usage: node tests/measure-demo-timing.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Decode = globalThis.SSTVDecode;

/** The demo's fixed test image: colour bars + grey ramp + checkerboard detail. Same recipe as the matrix. */
function makeTestImage(w, h) {
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
        const v = Math.round(255 * x / (w - 1)); r = g = b = v;
      } else {
        const v = (((x >> 3) + (y >> 3)) & 1) ? 235 : 20; r = g = b = v;
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data: data, width: w, height: h };
}

/** Linear-interpolation resample, the same operation the demo uses to keep the clip small. */
function resampleTo(x, from, to) {
  if (from === to) return x;
  const n = Math.floor(x.length * to / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * from / to;
    const i0 = Math.floor(p), i1 = Math.min(x.length - 1, i0 + 1), f = p - i0;
    out[i] = x[i0] * (1 - f) + x[i1] * f;
  }
  return out;
}

(async function main() {
  const results = [];
  for (const modeId of ['M1', 'S1']) {
    const mode = Modes.get(modeId);
    const img = makeTestImage(mode.width, mode.height);
    const tl = Timeline.build(img, mode);
    // the demo clip = the first N seconds of the scan, captured as the waveform is produced
    const CLIP_S = 20;
    const full = Synth.synthesize(tl, 16000).samples;
    const clip = full.slice(0, Math.round(CLIP_S * 16000));
    console.log('\n' + mode.name + ' · 全长 ' + tl.duration.toFixed(1) + ' s · 试听片段 ' + CLIP_S + ' s' +
      ' · 16000 Hz ' + clip.length.toLocaleString() + ' 采样（' +
      (clip.length * 2 / 1024).toFixed(0) + ' KB 作为 16-bit WAV）');
    for (const sr of [16000, 12000, 8000]) {
      const x = resampleTo(clip, 16000, sr);
      for (const q of ['fast', 'standard']) {
        const t0 = Date.now();
        let r = null;
        try { r = await Decode.decode(x, sr, { quality: q, yieldEvery: 0, postprocess: 'off' }); }
        catch (e) { r = { ok: false, message: e.message }; }
        const ms = Date.now() - t0;
        results.push({ mode: modeId, sr: sr, quality: q, ms: ms, ok: r.ok,
          message: r.ok ? '' : r.message });
        console.log('  ' + String(sr).padStart(5) + ' Hz · ' + q.padEnd(8) + ' → ' +
          String(ms).padStart(6) + ' ms  ' + (r.ok ? 'ok' : '失败: ' + r.message));
      }
    }
  }
  const ok = results.filter((r) => r.ok);
  console.log('\n可用组合中位数 ' +
    (ok.map((r) => r.ms).sort((a, b) => a - b)[ok.length >> 1] || 0) + ' ms');
  console.log('提示：演示页取 3–5 s 目标区间内的组合。');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
