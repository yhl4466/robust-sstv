/*
 * Resolve "photo 30.50 dB vs synthetic r = 0.34".
 *
 * THE SUSPICION, STATED UP FRONT
 *   alignment() first-DIFFERENCES both planes before correlating. That was introduced in phase 40 to
 *   stop a linear trend from dragging the shift search to the search boundary, and it fixed that - but
 *   differencing is catastrophic for smooth content: a signal of period P loses amplitude in
 *   proportion to 2*sin(pi/P), which for P = 90..200 px is 0.03..0.07 of the original, while white
 *   noise only loses a factor sqrt(2). The signal-to-noise ratio falls by 20-40x, so a perfectly good
 *   decode can score r = 0.3 on a differenced correlation while round-tripping a photo at 30.50 dB.
 *
 *   If that is what happened, there is no contradiction at all: the photo PSNR is right and the 0.34
 *   was an artefact of my own metric.
 *
 * WHAT THIS MEASURES, on the same decode
 *   - plain zero-mean correlation at shift 0
 *   - per-row linear-trend-removed correlation at shift 0   (kills the trend without differencing)
 *   - the first-differenced correlation (the old metric)
 *   - PSNR against the truth, tied directly to roundtrip.js's 30.50 dB
 *   ...on three synthetic images: the phase-43 mid-frequency one, a very low frequency one whose
 *   periods far exceed the 320 px grid, and a pure grey ramp.
 *
 * Usage: node tests/diagnose-resolve-contradiction.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline, Synth = globalThis.SSTVSynth,
      Decode = globalThis.SSTVDecode;
const MODE = Modes.get('S1');

const cvPlain = (a, b) => {
  const n = Math.min(a.length, b.length);
  if (n < 16) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let nu = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; nu += u * v; da += u * u; db += v * v; }
  return (da > 0 && db > 0) ? nu / Math.sqrt(da * db) : 0;
};

/** Remove each series' best-fit straight line, then correlate - kills a trend without differencing. */
function cvDetrendLine(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 16) return 0;
  const fit = (y) => {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
    const d = n * sxx - sx * sx;
    const k = d ? (n * sxy - sx * sy) / d : 0;
    const c = (sy - k * sx) / n;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = y[i] - (k * i + c);
    return out;
  };
  return cvPlain(Array.from(fit(a)), Array.from(fit(b)));
}

/** First-difference then correlate - the phase-40/43 metric. */
function cvDiff(a, b) {
  const n = Math.min(a.length, b.length);
  const da = [], db = [];
  for (let i = 0; i < n - 1; i++) { da.push(a[i + 1] - a[i]); db.push(b[i + 1] - b[i]); }
  return cvPlain(da, db);
}

function psnr(a, b) {
  const n = Math.min(a.length, b.length);
  let se = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; se += d * d; }
  const mse = se / n;
  return mse <= 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}

function plane(img, ch) {
  const off = ch === 'R' ? 0 : (ch === 'G' ? 1 : 2);
  const rows = [];
  for (let y = 0; y < img.height; y++) {
    const row = new Float64Array(img.width);
    for (let x = 0; x < img.width; x++) row[x] = img.data[(y * img.width + x) * 4 + off];
    rows.push(row);
  }
  return rows;
}

/** Per-row statistics of three metrics, plus a PSNR over the whole plane. */
function compare(A, B) {
  const H = Math.min(A.length, B.length);
  const plain = [], detrend = [], diff = [];
  const flatA = [], flatB = [];
  for (let y = 0; y < H; y++) {
    const a = Array.from(A[y]), b = Array.from(B[y]);
    plain.push(cvPlain(a, b));
    detrend.push(cvDetrendLine(a, b));
    diff.push(cvDiff(a, b));
    for (let i = 0; i < a.length; i++) { flatA.push(a[i]); flatB.push(b[i]); }
  }
  const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return { plain: med(plain), detrend: med(detrend), diff: med(diff), psnr: psnr(flatA, flatB) };
}

function colourImage(mid) {
  const w = MODE.width, h = MODE.height, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (mid) {
        d[i] = Math.round(127 + 120 * Math.sin(x * 0.03 + y * 0.05));
        d[i + 1] = Math.round(127 + 120 * Math.sin(x * 0.07 - y * 0.02));
        d[i + 2] = Math.round(127 + 120 * Math.sin(x * 0.05 + y * 0.09));
      } else {
        d[i] = Math.round(127 + 120 * Math.sin(x * 0.005 + y * 0.003));
        d[i + 1] = Math.round(127 + 120 * Math.sin(x * 0.004 - y * 0.006));
        d[i + 2] = Math.round(127 + 120 * Math.sin(x * 0.007 + y * 0.002));
      }
      d[i + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

function greyRamp() {
  const w = MODE.width, h = MODE.height, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, v = Math.round(255 * x / (w - 1));
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  return { data: d, width: w, height: h };
}

function periods(label) {
  console.log('  ' + label + ': 周期 R ' + (2 * Math.PI / 0.03).toFixed(0) + ' px · G ' +
    (2 * Math.PI / 0.07).toFixed(0) + ' px · B ' + (2 * Math.PI / 0.05).toFixed(0) + ' px');
}

(async function main() {
  console.log('=== 解矛盾：30.50 dB vs 合成 r 0.34 ===\n');
  console.log('三种度量: plain(shift 0 直算) · detrendLine(去每行线性趋势) · diff(一阶差分, 旧指标)');
  console.log('附 PSNR（与 roundtrip.js 同口径，用于对齐 30.50 dB）\n');

  const cases = [['中频彩色(阶段43)', colourImage(true)], ['极低频彩色', colourImage(false)],
    ['纯灰度斜坡', greyRamp()]];
  periods('阶段43 的中频图');

  const results = {};
  for (const [name, img] of cases) {
    console.log('\n--- ' + name + ' ---');
    const tl = Timeline.build(img, MODE);
    console.log('  Timeline: ' + (tl.segments ? tl.segments.length : '?') + ' 段 · 时长 ' +
      (tl.duration != null ? tl.duration.toFixed(3) + ' s' : '?'));
    const syn = Synth.synthesize(tl, SR).samples;
    const dec = await Decode.decode(syn, SR, { quality: 'standard', yieldEvery: 0 });
    if (!dec.ok) { console.log('  解码失败: ' + dec.message); continue; }
    const O = { R: plane(img, 'R'), G: plane(img, 'G'), B: plane(img, 'B') };
    const D = { R: plane(dec.imageData, 'R'), G: plane(dec.imageData, 'G'), B: plane(dec.imageData, 'B') };
    console.log('  通道(解码 vs 真值同名)   plain    detrendLine   diff(旧)   PSNR(dB)');
    const per = {};
    for (const ch of ['R', 'G', 'B']) {
      const r = compare(D[ch], O[ch]);
      per[ch] = r;
      console.log('  ' + ch + '                       ' + r.plain.toFixed(3).padStart(6) +
        '   ' + r.detrend.toFixed(3).padStart(10) + '   ' + r.diff.toFixed(3).padStart(7) +
        '   ' + (isFinite(r.psnr) ? r.psnr.toFixed(2) : '∞').padStart(8));
    }
    // cross matrix on G to test whether the channels are distinguishable
    console.log('  交叉（解码 G vs 真值 X）: ' +
      ['R', 'G', 'B'].map((ch) => 'vs ' + ch + ' ' + compare(D.G, O[ch]).plain.toFixed(3)).join(' · '));
    console.log('  全图 PSNR（三通道合计）: ' + (function () {
      const a = [], b = [];
      for (const ch of ['R', 'G', 'B']) for (let y = 0; y < O[ch].length; y++) for (let x = 0; x < O[ch][y].length; x++) { a.push(D[ch][y][x]); b.push(O[ch][y][x]); }
      return psnr(a, b).toFixed(2);
    })() + ' dB');
    results[name] = per;
  }

  // ---------------------------------------------------------------- verdict
  console.log('\n===== 判定 =====');
  const mid = results['中频彩色(阶段43)'];
  const low = results['极低频彩色'];
  const grey = results['纯灰度斜坡'];
  if (mid) {
    console.log('  阶段43 中频图: plain ' + mid.G.plain.toFixed(3) + ' / detrendLine ' +
      mid.G.detrend.toFixed(3) + ' / diff ' + mid.G.diff.toFixed(3) + '（G 通道）· PSNR ' +
      mid.G.psnr.toFixed(2) + ' dB');
    const explains = mid.G.plain > mid.G.diff + 0.15;
    console.log('  => ' + (explains
      ? '★ plain 显著高于 diff → 旧指标（一阶差分）确实低估了相关 ✓✓ 矛盾由【指标】造成，而非解码误差'
      : 'plain 与 diff 接近 → 差分不是原因，矛盾另有来源 ✗'));
  }
  if (low) console.log('  极低频图: plain ' + low.G.plain.toFixed(3) + ' · diff ' + low.G.diff.toFixed(3) +
    ' · PSNR ' + low.G.psnr.toFixed(2) + ' dB');
  if (grey) console.log('  灰度斜坡: plain ' + grey.G.plain.toFixed(3) + ' · diff ' + grey.G.diff.toFixed(3) +
    ' · PSNR ' + grey.G.psnr.toFixed(2) + ' dB');
  if (mid && grey) {
    console.log('  ★ 与照片 30.50 dB 对照: 灰度斜坡（同一类平滑内容）PSNR ' + grey.G.psnr.toFixed(2) +
      ' dB → ' + (grey.G.psnr > 28 ? '与 30.50 dB 同量级 ✓ 说明解码是准确的 ✓' : '偏低 ✗'));
  }

  fs.writeFileSync(path.join(OUT, 'resolve-contradiction.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), results: results
  }, null, 2));
  console.log('\n  证据 -> tests/diag-quality/resolve-contradiction.json');
})().catch((e) => { console.error('error: ' + (e && e.stack || e)); process.exitCode = 1; });
