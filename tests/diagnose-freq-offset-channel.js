/*
 * Narrowing the frequency-offset asymmetry: is the loss in a CHANNEL, or in a REGION of the scan?
 *
 * tests/diagnose-asymmetry-branches.js established that at +/-20 and +/-50 Hz the two signs take
 * IDENTICAL alignSync paths (514 calls, 512 start inside a pulse, 2 do not, 2 searches elected on both
 * sides), so the difference is downstream of the lock. Three sync-side mechanisms have already been
 * measured and rejected (SYNC_DETECT_HZ, branch selection, header slope bias).
 *
 * What is left is the pixel path, and the pixel path has two things that a sign of the offset could
 * interact with asymmetrically:
 *
 *   1. THE CHANNEL ORDER. Scottie interleaves sync/pixels as G,B,R per line with chanSync = 2 (R is the
 *      channel adjacent to the sync). Each channel's samples sit at a fixed offset from the sync - R
 *      closest, G furthest - so a systematic sample-position error shows up as one channel being worse,
 *      and the SIGN of the offset decides which direction the positions move.
 *
 *   2. THE SCAN DIRECTION WITHIN A ROW. A pixel-clock error accumulates along the scan, so it is worst at
 *      the far end of the row; measuring PSNR per column separates that from a whole-row shift.
 *
 * This reports both, per sign, plus the sync-lock statistics, so the comparison is between like
 * quantities rather than between two PSNR totals.
 *
 * Usage: node tests/diagnose-freq-offset-channel.js
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

const SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const freqShift = new Function('SR',
  SRC.slice(SRC.indexOf('function hilbertFIR'), SRC.indexOf('/** Decoder lock residuals')) +
  '\nreturn freqShift;')(SR);

const MODE = Modes.get('S1');

/** PSNR over a caller-supplied index filter, so one routine serves every slice. */
function psnrWhere(a, b, width, height, keep) {
  let se = 0, n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!keep(x, y)) continue;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; se += d * d; n++; }
    }
  }
  const mse = n ? se / n : 0;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}

/** Which RGBA channel index carries which colour depends on composeImageData; RGBA is r=0,g=1,b=2. */
function psnrChannel(a, b, width, height, ch) {
  let se = 0, n = 0;
  for (let i = ch; i < a.length; i += 4) { const d = a[i] - b[i]; se += d * d; n++; }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}

/** Per-line sync residual spread, as a function of which channel's scan follows the sync. */
function lockStats(refs) {
  const locked = refs.filter((r) => !r.freeRun);
  if (locked.length < 8) return null;
  const N = locked.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += i; sy += locked[i].ref; sxx += i * i; sxy += i * locked[i].ref; }
  const den = N * sxx - sx * sx;
  const slope = den ? (N * sxy - sx * sy) / den : 0, inter = (sy - slope * sx) / N;
  const res = locked.map((r, i) => r.ref - (inter + slope * i));
  const s = res.slice().sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  const mad = res.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(res.length / 2)];
  return { n: N, freeRun: refs.length - N, bias: med, mad: mad, period: slope };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const truth = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(truth, MODE), SR).samples;
  const W = MODE.width, H = MODE.height;

  console.log('=== 频偏不对称：失分在通道还是在扫描区段 ===\n');
  console.log('  Scottie S1: 每行依次为 G, B, R，chanSync = 2（R 紧邻同步，G 距同步最远）');
  console.log('  因此若存在固定的采样位置误差，R 与 G 的损失应不同。\n');
  console.log('  频偏   PSNR   R通道   G通道   B通道  |  左1/4  中1/2  右1/4  (沿扫描)  |  锁MAD  丢锁  行周期');
  const rows = [];
  for (const hz of [0, 20, -20, 50, -50]) {
    const sig = hz === 0 ? clean : freqShift(clean, hz);
    const refs = [];
    const r = await Decode.decode(sig, SR,
      { quality: 'standard', yieldEvery: 0, postprocess: 'off', auditLineRefs: refs });
    if (!r.ok) { console.log('  ' + String(hz).padStart(4) + '   解码失败: ' + r.message); continue; }
    const d = r.imageData.data, t = truth.data;
    const total = psnrWhere(d, t, W, H, () => true);
    const chR = psnrChannel(d, t, W, H, 0);   // RGBA index 0 = red
    const chG = psnrChannel(d, t, W, H, 1);
    const chB = psnrChannel(d, t, W, H, 2);
    const q = W / 4;
    const left = psnrWhere(d, t, W, H, (x) => x < q);
    const mid = psnrWhere(d, t, W, H, (x) => x >= q && x < 3 * q);
    const right = psnrWhere(d, t, W, H, (x) => x >= 3 * q);
    const ls = lockStats(refs);
    rows.push({ hz, total, chR, chG, chB, left, mid, right, lock: ls,
      clockScale: r.calibration.clockScale, a: r.calibration.scale, b: r.calibration.offsetHz });
    console.log('  ' + String(hz).padStart(4) + ' ' + total.toFixed(2).padStart(6) + '  ' +
      chR.toFixed(1).padStart(6) + '  ' + chG.toFixed(1).padStart(6) + '  ' + chB.toFixed(1).padStart(6) +
      '  |  ' + left.toFixed(1).padStart(5) + '  ' + mid.toFixed(1).padStart(5) + '  ' +
      right.toFixed(1).padStart(5) + '          |  ' +
      (ls ? ls.mad.toFixed(1).padStart(5) : '  -- ') + '  ' + (ls ? String(ls.freeRun).padStart(4) : '  --') +
      '  ' + (ls ? ls.period.toFixed(1).padStart(7) : '     --'));
  }

  /* ---- the decisive comparison: same magnitude, opposite sign ---- */
  console.log('\n  同幅反号对照（若解码器对称，两列应基本相同）：');
  for (const mag of [20, 50]) {
    const p = rows.find((r) => r.hz === mag), m = rows.find((r) => r.hz === -mag);
    if (!p || !m) continue;
    const gap = (k) => (p[k] - m[k]);
    console.log('    ' + String(mag).padStart(3) + ' Hz: 总 ' + gap('total').toFixed(2) +
      ' · R ' + gap('chR').toFixed(2) + ' · G ' + gap('chG').toFixed(2) + ' · B ' + gap('chB').toFixed(2) +
      '  |  左 ' + gap('left').toFixed(2) + ' · 中 ' + gap('mid').toFixed(2) + ' · 右 ' + gap('right').toFixed(2));
  }
  console.log('\n  判读：若某一通道的差远大于其他两通道，问题在通道相关的采样位置；');
  console.log('        若三段扫描的差相近，则是整行统一的位置/标定误差；');
  console.log('        若右段差明显更大，则是行内累积（像素时钟）误差。');

  fs.writeFileSync(path.join(OUT, 'freq-offset-channel.json'), JSON.stringify(rows, null, 2));
  console.log('\n证据 -> tests/diag-quality/freq-offset-channel.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
