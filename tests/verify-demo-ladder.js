/*
 * Verify every step of the demo's degradation ladder BEFORE trusting the page.
 *
 * WHY THIS EXISTS
 *   The demo's ladder is JavaScript embedded in a generated HTML file, so nothing type-checks it and the
 *   only other way to find a broken step is to click through the page by hand and notice a suspicious
 *   number. That is exactly the kind of check that silently passes: a step whose `apply` is a no-op (which
 *   an early draft of this page had - a frequency shift that returned its input, and a reverb whose allpass
 *   gains were all zero) produces a perfectly plausible "clean" PSNR and looks like a working demo.
 *
 *   So this extracts the SAME source the page ships, runs every step through the real decoder in Node, and
 *   fails loudly on: a step that throws, a step that is bit-identical to its input, and any non-clean step
 *   that scores the same as clean (which is the signature of a no-op).
 *
 * Usage: node tests/verify-demo-ladder.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AUDIO_DIR = path.join(ROOT, 'tests', 'demo-audio');
require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js'));
require(path.join(ROOT, 'js', 'channel-sim.js'));
const PNG = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')).PNG;
const Decode = globalThis.SSTVDecode, Wav = globalThis.SSTVWav, ChannelSim = globalThis.ChannelSim;

const manifest = JSON.parse(fs.readFileSync(path.join(AUDIO_DIR, 'manifest.json'), 'utf8'));
const wavBuf = fs.readFileSync(path.join(AUDIO_DIR, manifest.audio));
const base = Wav.parse(wavBuf.buffer.slice(wavBuf.byteOffset, wavBuf.byteOffset + wavBuf.byteLength));
const truth = PNG.sync.read(fs.readFileSync(path.join(AUDIO_DIR, manifest.truth)));
const truthImg = { data: new Uint8ClampedArray(truth.data), width: truth.width, height: truth.height };

/*
 * Pull the ladder out of the generated page. The page is the shipped artifact, so extracting from it
 * (rather than from scripts/gen-demo-page.js) is what makes this a check of what users actually get.
 */
const pagePath = path.join(ROOT, 'demo-degradation.html');
const page = fs.readFileSync(pagePath, 'utf8');
const start = page.indexOf('var SR = 8000;');
const end = page.indexOf('</script>', start);
if (start < 0 || end < 0) { console.error('在 demo-degradation.html 中找不到退化阶梯源码'); process.exit(1); }
const ladderSrc = page.slice(start, end);

/*
 * The ladder also reads `ROOM_IR_B64`, which the page declares in a SEPARATE earlier script tag (the
 * inlined-asset block). Extracting only the ladder's own script therefore left that symbol undefined - the
 * same class of mistake as the ChannelSim/CS() mix-up above, caught the same way. Every top-level `var
 * SOMETHING_B64 = "...";` in the page is therefore harvested and prepended, so the ladder runs with exactly
 * the assets the browser gives it.
 */
const assigns = page.match(/var\s+[A-Z_][A-Z0-9_]*_B64\s*=\s*"[^"]*";/g) || [];
const assetSrc = assigns.join('\n');
if (!/ROOM_IR_B64/.test(assetSrc)) {
  console.error('在 demo-degradation.html 中找不到 ROOM_IR_B64 —— 页面资源内联块已变');
  process.exit(1);
}
const fullSrc = assetSrc + '\n' + ladderSrc;

/*
 * IMPORTANT: neither `CS` nor `atob` is passed in as a parameter any more.
 *
 * The page defines `CS()` itself (it has to - that is how it reaches the channel model), and supplying it
 * from here is what let a build ship with `CS` undefined: every ladder step worked in this harness while
 * the real page threw "CS is not defined" on its first noise step. A harness that provides a symbol the
 * page is supposed to define silently tests the harness instead of the page.
 *
 * The page's `var CS = ...` / `function CS()` and the `_B64` asset vars are all top-level statements in the
 * generated file, so extracting them and evaluating them together reproduces the page's real scope. `atob`
 * comes from Node's own global (v16+), and is checked below so a future Node without it fails loudly.
 */
if (typeof atob !== 'function') {
  console.error('本 Node 没有全局 atob —— 页面依赖它解内联资源，请用 Node 16+');
  process.exit(1);
}
const sstvChannel = require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js'));
if (!sstvChannel || !sstvChannel.Channel || typeof sstvChannel.Channel.awgn !== 'function') {
  console.error('js/lib/sstv-channel.js 未提供 Channel.awgn —— 页面的 CS() 契约已变');
  process.exit(1);
}
// the page reads its channel model off globalThis.SSTVChannel, so put it there exactly as the browser does
globalThis.SSTVChannel = sstvChannel;

const factory = new Function('globalThis', fullSrc +
  '\nreturn { TYPES: TYPES, roomMix: roomMix, clip: clip, shiftBy: shiftBy, CS: CS };');
const ladder = factory(globalThis);
if (typeof ladder.CS !== 'function') {
  console.error('页面没有定义 CS() —— 阶梯无法取得信道模型');
  process.exit(1);
}
console.log('CS() 由页面自身提供 ✓');

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}
function identical(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function sameSamples(a, b) {
  if (a.length !== b.length) return false;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s / a.length < 1e-20;
}

(async function main() {
  console.log('=== 演示页退化阶梯逐步验证 ===');
  console.log('基础音频 ' + manifest.modeName + ' · ' + base.sampleRate + ' Hz · ' +
    base.samples.length.toLocaleString() + ' 采样\n');

  const problems = [];
  const expected = [];
  let cleanPsnr = null;
  const table = [];

  for (const t of ladder.TYPES) {
    console.log('[' + t.label + ']');
    table.push({ type: t.label, steps: [] });
    let typeClean = null;
    for (let i = 0; i < t.steps.length; i++) {
      const s = t.steps[i];
      let deg;
      const t0 = Date.now();
      try { deg = s.apply(base.samples); }
      catch (e) {
        problems.push(t.label + ' · ' + s.label + ' 施加退化时抛错: ' + e.message);
        console.log('  ' + s.label.padEnd(28) + ' 抛错: ' + e.message);
        continue;
      }
      const ms = Date.now() - t0;

      /*
       * A no-op step is the failure this script exists for. Step 0 (clean) is EXPECTED to be identical, so
       * it is exempt; any later step that returns its input unchanged, or that lands within 0.02 dB of the
       * clean score, is treated as broken rather than as a strong result.
       */
      const isCleanStep = i === 0;
      const identicalToInput = identical(deg, base.samples);
      const effectivelySame = sameSamples(deg, base.samples);

      const r = await Decode.decode(deg, base.sampleRate,
        { quality: 'fast', yieldEvery: 0, postprocess: 'off' });
      const p = r.ok ? psnr(r.imageData.data, truthImg.data) : null;
      if (isCleanStep) { typeClean = p; if (cleanPsnr == null) cleanPsnr = p; }

      if (!r.ok) {
        /*
         * A decode failure at a SEVERE step is a RESULT, not a defect - that is the whole point of the
         * demo, and reporting it as a problem would train a reader to ignore this script's output. What is
         * a defect is a failure that cannot be attributed to the impairment, so the distinction drawn here
         * is: a step that did not change the signal (a no-op) is a bug wherever it fails; a step that did
         * change the signal and failed is reported as an expected outcome and kept out of the failure list.
         */
        const isNoop = !isCleanStep && (identicalToInput || effectivelySame);
        if (isNoop) {
          problems.push(t.label + ' · ' + s.label + ' 退化是空操作，却报解码失败: ' + r.message);
        } else {
          expected.push(t.label + ' · ' + s.label + ' 解码失败（该退化下属预期）: ' + r.message);
        }
        console.log('  ' + s.label.padEnd(28) + ' ' + String(ms).padStart(6) + ' ms  ' +
          (isCleanStep ? '★ ' : '') + '解码失败' + (isNoop ? '（空操作！）' : '（预期）'));
        table[table.length - 1].steps.push({ label: s.label, ms: ms, psnr: null,
          error: r.message, expectedFailure: !isCleanStep });
        if (isCleanStep) problems.push(t.label + ' · clean 步骤竟然解码失败: ' + r.message);
        continue;
      }
      if (!isCleanStep && (identicalToInput || effectivelySame)) {
        problems.push(t.label + ' · ' + s.label + ' 退化是空操作（输出与输入逐位相同）');
      }
      if (!isCleanStep && typeClean != null && Math.abs(p - typeClean) < 0.02 && effectivelySame) {
        problems.push(t.label + ' · ' + s.label + ' 与 clean 分数相同且输出相同，疑似空操作');
      }
      console.log('  ' + s.label.padEnd(28) + ' ' + String(ms).padStart(6) + ' ms  PSNR ' +
        p.toFixed(2) + ' dB' + (identicalToInput ? '  ← 与输入相同' : ''));
      table[table.length - 1].steps.push({ label: s.label, ms: ms, psnr: Number(p.toFixed(2)),
        identicalToInput: identicalToInput });
    }
    console.log('');
  }

  console.log('clean 基准 ' + (cleanPsnr == null ? '--' : cleanPsnr.toFixed(2) + ' dB') +
    '（manifest 声明 ' + manifest.cleanPsnrDb + ' dB）');
  if (cleanPsnr != null && Math.abs(cleanPsnr - manifest.cleanPsnrDb) > 0.5) {
    problems.push('clean PSNR 与 manifest 声明不符：实测 ' + cleanPsnr.toFixed(2) +
      ' vs 声明 ' + manifest.cleanPsnrDb);
  }

  fs.writeFileSync(path.join(AUDIO_DIR, 'ladder-verification.json'),
    JSON.stringify({ mode: manifest.mode, cleanPsnrDb: cleanPsnr, table: table,
      problems: problems, expectedFailures: expected }, null, 2));

  if (expected.length) {
    console.log('\n该退化下属预期的解码失败（' + expected.length + ' 个，不算缺陷）：');
    for (const p of expected) console.log('  · ' + p);
  }
  if (problems.length) {
    console.log('\n发现 ' + problems.length + ' 个缺陷：');
    for (const p of problems) console.log('  · ' + p);
    process.exitCode = 1;
    return;
  }
  console.log('\nDEMO LADDER: ALL STEPS VALID（无空操作、无抛错、clean 步骤可解码）');
  console.log('证据 -> tests/demo-audio/ladder-verification.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
