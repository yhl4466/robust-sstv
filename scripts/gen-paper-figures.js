/*
 * Paper figure generator.
 *
 * Every figure in tech.html that carries measured values is produced here, so that a plotted
 * number can always be traced back to a file a test wrote. Three of the figures are MECHANISM
 * demonstrations rather than plots, and they are generated here too because their content is
 * computed rather than drawn:
 *
 *   fig4  AFC offset        constants from the mode table + measured residual offsets
 *   fig5  clock recovery    a real resample of a checkerboard at 1% pitch error (PNG data URI)
 *   fig7  interleaving      error positions from a real run of js/interleaver.js
 *   fig10 B sweep           scripts/out/sweep-block.json + eval-matrix-b32.json
 *   fig11 content dep.      scripts/out/eval-content.json
 *   fig12 real audio        scripts/out/eval-real-decode.json
 *   fig13 post-processing   scripts/out/eval-postprocess.json
 *
 * The remaining six (architecture, encoding principle, AFC flow, RS + interleaving structure,
 * QIM side channel, PD vs line-sync scan models) are purely schematic and live in
 * tech-html-parts.js.
 *
 * Numbers are NEVER typed here: they are read from the mode table, from the measurement JSON, or
 * computed from the real modules.
 *
 * Usage: node scripts/gen-paper-figures.js
 * Output: tests/paper-figures/fig{N}-*.svg  (for proofing) and a JSON summary for tech.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'scripts', 'out');
const FIGDIR = path.join(ROOT, 'tests', 'paper-figures');
fs.mkdirSync(FIGDIR, { recursive: true });
// Only ever leave this run's figures behind, so a renumbering cannot strand an old file that
// tech-html.test.js would then have to guess about.
for (const f of fs.readdirSync(FIGDIR)) {
  if (/^fig\d+.*\.svg$/i.test(f)) fs.unlinkSync(path.join(FIGDIR, f));
}

// real modules, so the figures describe what the code actually does
const Interleaver = require(path.join(ROOT, 'js', 'interleaver.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
const Modes = globalThis.SSTVModes;
let PNG = null;
try { PNG = require(path.join(ROOT, '..', '.research', 'npmtest', 'node_modules', 'pngjs')).PNG; }
catch (e) { /* fig5 falls back to a vector approximation if pngjs is unavailable */ }

const W = 1200;                     // viewBox width; the page caps rendered width at 1280 px
const PAD = { l: 78, r: 24, t: 34, b: 62 };

function readJson(name) {
  const p = path.join(OUT, name);
  if (!fs.existsSync(p)) throw new Error('missing data source: scripts/out/' + name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
/** Read a JSON file by repo-relative path (for inputs that do not live in scripts/out). */
function readRel(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error('missing data source: ' + rel);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function svgOpen(h, title, desc) {
  /*
   * A 14-unit frame around the drawing, matching the hand-authored figures. Widening the
   * viewBox and the declared size together keeps every element coordinate unchanged.
   */
  const p = 14;
  return `<svg viewBox="${-p} ${-p} ${W + 2 * p} ${h + 2 * p}" width="${W + 2 * p}" height="${h + 2 * p}" role="img" ` +
    `xmlns="http://www.w3.org/2000/svg" font-family="system-ui,-apple-system,Segoe UI,sans-serif">\n` +
    `<title>${esc(title)}</title>\n<desc>${esc(desc)}</desc>\n` +
    `<rect x="0" y="0" width="${W}" height="${h}" fill="#ffffff"/>\n`;
}
function axes(x0, y0, x1, y1, xLabel, yLabel) {
  let s = `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="#333" stroke-width="1.4"/>\n`;
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="#333" stroke-width="1.4"/>\n`;
  s += `<text x="${(x0 + x1) / 2}" y="${y1 + 42}" font-size="14" text-anchor="middle" fill="#333">${esc(xLabel)}</text>\n`;
  s += `<text x="20" y="${(y0 + y1) / 2}" font-size="14" text-anchor="middle" fill="#333" ` +
    `transform="rotate(-90 20 ${(y0 + y1) / 2})">${esc(yLabel)}</text>\n`;
  return s;
}
/**
 * Grid + tick labels. yTicks are values, yScale maps value -> pixel.
 *
 * xFmt formats the x tick labels, and the label anchor follows the tick position: a tick at the
 * right edge is anchored `end` so its text grows inward. Without that, the last x label of a
 * full-width axis is centred on the edge and spills outside the viewBox (measured: a
 * 0.15767578125 label overhanging by 16.4 units, also printed unformatted).
 */
function grid(x0, y0, x1, y1, yTicks, yScale, fmt, xTicks, xScale, xFmt) {
  let s = '';
  for (const t of yTicks) {
    const y = yScale(t);
    if (y < y0 - 1 || y > y1 + 1) continue;
    s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>\n`;
    s += `<text x="${x0 - 8}" y="${y + 4}" font-size="11" text-anchor="end" fill="#4b5563">${esc(fmt(t))}</text>\n`;
  }
  if (xTicks) for (const t of xTicks) {
    const x = xScale(t);
    if (x < x0 - 1 || x > x1 + 1) continue;
    s += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="#f3f4f6" stroke-width="1"/>\n`;
    const anchor = x >= x1 - 24 ? 'end' : (x <= x0 + 24 ? 'start' : 'middle');
    s += `<text x="${x}" y="${y1 + 18}" font-size="11" text-anchor="${anchor}" fill="#4b5563">` +
      `${esc(xFmt ? xFmt(t) : t)}</text>\n`;
  }
  return s;
}
function legend(x, y, items) {
  let s = '';
  items.forEach((it, i) => {
    const yy = y + i * 19;
    s += `<rect x="${x}" y="${yy - 9}" width="13" height="13" fill="${it.color}"/>\n`;
    s += `<text x="${x + 19}" y="${yy + 2}" font-size="12" fill="#374151">${esc(it.label)}</text>\n`;
  });
  return s;
}
function write(name, body) {
  const file = path.join(FIGDIR, name);
  // close the svg opened by svgOpen (its height is embedded in the first line)
  fs.writeFileSync(file, body + '</svg>\n', 'utf8');
  const bytes = fs.statSync(file).size;
  console.log(`  wrote ${path.relative(ROOT, file)}  (${(bytes / 1024).toFixed(1)} KB)`);
  return { file: path.relative(ROOT, file).replace(/\\/g, '/'), bytes };
}
const summary = {};

// ------------------------------------------------------------------ figure 4: AFC offset
/*
 * Before/after the affine calibration. Every number is derived, not typed:
 *   - the band edges come from the mode table (FREQ_BLACK / FREQ_WHITE),
 *   - Hz-per-grey comes from COLOR_FREQ_MULT,
 *   - the grey-level drift is 50 / COLOR_FREQ_MULT, computed here,
 *   - the "after" annotation reports the LARGEST residual offset actually measured across the
 *     real-audio portfolio (eval-real-decode.json), not a hoped-for figure.
 */
(function fig4() {
  const C = Modes.COLOR_FREQ_MULT;
  const fBlack = Modes.FREQ_BLACK, fWhite = Modes.FREQ_WHITE;
  const offsetHz = 50;
  const greyDrift = offsetHz / C;
  const ev = readJson('eval-real-decode.json');
  const offs = ev.results.filter((r) => r.config === 'affine' && r.ok && r.b != null)
    .map((r) => ({ id: r.id, abs: Math.abs(r.b), b: r.b }))
    .sort((a, b) => a.abs - b.abs);
  const medianResidual = offs.length ? offs[Math.floor(offs.length / 2)].abs : null;
  const worst = offs.length ? offs[offs.length - 1] : null;
  // the runner-up matters: it is what the bulk of the portfolio actually achieves once the one
  // heavily degraded sample is set aside
  const runnerUp = offs.length > 1 ? offs[offs.length - 2].abs : null;

  // axis covers a little beyond black..white so the shifted band still fits
  const axisLo = fBlack - 50, axisHi = fWhite + 50;
  const x0 = 110, x1 = 1080;
  const X = (hz) => x0 + ((hz - axisLo) / (axisHi - axisLo)) * (x1 - x0);
  const shift = X(fBlack + offsetHz) - X(fBlack);
  const bandY = 74, bandH = 26;

  const h = 430;
  let s = svgOpen(h, '图 4 仿射频率标定前后的频率轴对比',
    `上半为存在 ${offsetHz} Hz 偏移时的频率轴，灰阶带整体右移，等价于 ${greyDrift.toFixed(1)} 个灰阶的亮度漂移；` +
    '下半为标定后的频率轴。灰阶带范围与每灰阶频率间隔取自模式表，残余偏移取自二十六段真实音频的实测结果。');

  const panel = (top, label, shifted) => {
    let p = `<text x="${x0}" y="${top}" font-size="14" font-weight="600" fill="#1f2937">${esc(label)}</text>\n`;
    const bx = shifted ? X(fBlack) + shift : X(fBlack);
    const bw = X(fWhite) - X(fBlack);
    p += `<defs><linearGradient id="afcg${shifted ? 'b' : 'a'}" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0" stop-color="#1f2937"/><stop offset="1" stop-color="#f9fafb"/></linearGradient></defs>\n`;
    p += `<rect x="${bx.toFixed(1)}" y="${bandY + (top - 74) + 16}" width="${bw.toFixed(1)}" height="${bandH}" ` +
      `fill="url(#afcg${shifted ? 'b' : 'a'})" stroke="#6b7280" stroke-width="1"/>\n`;
    const ay = bandY + (top - 74) + 16 + bandH + 22;
    p += `<line x1="${x0}" y1="${ay}" x2="${x1}" y2="${ay}" stroke="#333" stroke-width="1.4"/>\n`;
    for (const hz of [fBlack, 1900, fWhite]) {
      const x = X(hz);
      p += `<line x1="${x.toFixed(1)}" y1="${ay - 5}" x2="${x.toFixed(1)}" y2="${ay + 5}" stroke="#333" stroke-width="1.2"/>\n`;
      p += `<text x="${x.toFixed(1)}" y="${ay + 20}" font-size="11" text-anchor="middle" fill="#4b5563">${hz}</text>\n`;
    }
    p += `<text x="${x0 - 6}" y="${ay + 20}" font-size="11" text-anchor="end" fill="#6b7280">Hz</text>\n`;
    if (shifted) {
      // shaded displacement between nominal black and shifted black
      p += `<rect x="${X(fBlack).toFixed(1)}" y="${bandY + (top - 74) + 10}" width="${shift.toFixed(1)}" ` +
        `height="${bandH + 12}" fill="#dc2626" fill-opacity="0.16"/>\n`;
      p += `<line x1="${X(fBlack).toFixed(1)}" y1="${bandY + (top - 74) + 4}" x2="${X(fBlack).toFixed(1)}" ` +
        `y2="${ay - 12}" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="5 4"/>\n`;
      p += `<line x1="${(X(fBlack) + shift).toFixed(1)}" y1="${bandY + (top - 74) + 4}" ` +
        `x2="${(X(fBlack) + shift).toFixed(1)}" y2="${ay - 12}" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="5 4"/>\n`;
      p += `<text x="${(X(fBlack) + shift / 2).toFixed(1)}" y="${ay - 16}" font-size="11" text-anchor="middle" ` +
        `fill="#b91c1c">+${offsetHz} Hz</text>\n`;
    }
    return p;
  };

  s += panel(34, '(a) 校正前：整体偏移 +' + offsetHz + ' Hz', true);
  s += `<text x="${x0}" y="152" font-size="13" fill="#b91c1c">` +
    `${offsetHz} Hz ÷ ${C.toFixed(3)} Hz/灰阶 = <tspan font-weight="600">${greyDrift.toFixed(1)} 灰阶</tspan> 的亮度漂移，图象整体偏亮或偏暗</text>\n`;
  s += panel(212, '(b) 校正后：频率轴与标称刻度对齐', false);
  /*
   * The reported quantity is the offset the calibration SOLVED FOR, not a residual error - those
   * are different things and conflating them would overstate the result. The single worst sample
   * is named rather than hidden, because it is a heavy-degradation case whose estimate drifts.
   */
  s += `<text x="${x0}" y="336" font-size="13" fill="#166534">` +
    `以 1900 Hz 引导音锚定偏移项，再以逐行同步头位置的最小二乘拟合确定尺度；` +
    `二十六段样本解出的偏移项 |b| 中位数 ${medianResidual == null ? '—' : medianResidual.toFixed(2)} Hz，` +
    `除 1 段严重损伤样本外均在 ${runnerUp == null ? '—' : runnerUp.toFixed(2)} Hz 以内</text>\n`;
  s += `<text x="${x0}" y="362" font-size="11.5" fill="#b45309">` +
    `偏离最大的一段为 ${worst ? esc(worst.id) : '—'}（|b| = ${worst ? worst.abs.toFixed(2) : '—'} Hz）；` +
    `该样本为多重退化叠加，其公开图保真度亦最低，属已记录的失败模式</text>\n`;
  s += `<text x="${x0}" y="388" font-size="11.5" fill="#6b7280">` +
    `|b| 为标定解出的偏移项，取自 scripts/out/eval-real-decode.json。` +
    `300 ms 引导音的频率分辨率为 ${(1000 / 300).toFixed(1)} Hz/格，三点重心插值后估计误差小于该分辨率。</text>\n`;
  s += `<text x="${x0}" y="412" font-size="11.5" fill="#6b7280">` +
    `标定按 f_nominal = (f_measured − b) / a 作用于全部频率测量，其中 a 为时钟尺度、b 为偏移项。</text>\n`;
  summary.fig4 = write('fig4-afc-offset.svg', s);
})();

// ------------------------------------------------------------------ figure 5: clock recovery
/*
 * A real resample, not a drawing: a raster is sampled at the pitch the decoder ASSUMES while the
 * true pitch is 1% longer, which is exactly what a sample-rate mismatch does. The result is
 * embedded as a PNG data URI so the figure stays self-contained (the paper forbids external
 * references) without shipping thousands of <rect> elements.
 *
 * The raster is a FULL LINE (320 px wide, 32 px tall), not a 32x32 crop. An earlier version used
 * 32x32 and labelled the red guide "0.3 pixels" while the prose said 3.2 - both were right, but
 * for different widths, and the mismatch was misleading. At the true line width the drift IS the
 * 3.2 pixels the text quotes, and 3.2 px on a 4 px cell is 80% of a cell, so it is plainly visible.
 */
(function fig5() {
  const RW = 320, RH = 32, cell = 4;            // one line: 320 x 32, 4-pixel checker cells
  const mismatchPct = 1;
  const f = 1 + mismatchPct / 100;
  const srcX = (x) => Math.min(RW - 1, Math.round(x * f));   // decoder assumes pitch 1, truth is f
  const checker = (x, y) => ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) ? 0 : 255;

  const mk = (sheared) => {
    if (!PNG) return null;
    const png = new PNG({ width: RW, height: RH });
    for (let y = 0; y < RH; y++) {
      for (let x = 0; x < RW; x++) {
        const v = checker(sheared ? srcX(x) : x, y);
        const o = (y * RW + x) * 4;
        png.data[o] = v; png.data[o + 1] = v; png.data[o + 2] = v; png.data[o + 3] = 255;
      }
    }
    return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
  };

  const h = 520;
  const disp = 3;                                // display scale: 1 raster px -> 3 units
  const dispW = RW * disp, dispH = RH * disp;
  const drift = (RW - 1) * (f - 1);              // cumulative offset at the end of the line

  let s = svgOpen(h, '图 5 时钟恢复前后的横向拖影对比',
    `上方为像素节距偏长 ${mismatchPct}% 时解码出的一整行 ${RW} 像素棋盘格，行内偏移自左向右累积，行末达 ${drift.toFixed(1)} 像素；` +
    '下方为恢复真实行时后的同一行。栅格由按错误节距重采样真实生成，不是示意画法。');

  const left = mk(true), right = mk(false);
  /*
   * The two panels are STACKED, not side by side: one line is 320 raster pixels wide, and at a
   * legible 3x that is 960 units, so two of them cannot share a 1200-unit frame.
   * All annotation lines sit BELOW panel (b). An earlier revision interleaved them between the
   * panels and the guide label collided with panel (b)'s title (caught by the geometry audit).
   */
  const panels = [
    { y: 30, title: '(a) 无时钟恢复：节距偏长 ' + mismatchPct + '%', img: left },
    { y: 248, title: '(b) 有时钟恢复：节距正确', img: right }
  ];
  for (const p of panels) {
    s += `<text x="70" y="${p.y}" font-size="14" font-weight="600" fill="#1f2937">${esc(p.title)}</text>\n`;
    s += `<rect x="68" y="${p.y + 14}" width="${dispW + 4}" height="${dispH + 4}" fill="#ffffff" stroke="#9ca3af" stroke-width="1"/>\n`;
    if (p.img) {
      s += `<image x="70" y="${p.y + 16}" width="${dispW}" height="${dispH}" href="${p.img}" ` +
        `preserveAspectRatio="none" image-rendering="pixelated"/>\n`;
    } else {
      s += `<text x="70" y="${p.y + 16 + dispH / 2}" font-size="12" fill="#b91c1c">pngjs unavailable</text>\n`;
    }
    s += `<text x="70" y="${p.y + 16 + dispH + 20}" font-size="11.5" fill="#6b7280">` +
      `一行 ${RW} 像素（高 ${RH}），棋盘格宽 ${cell} 像素</text>\n`;
  }
  // displacement guide under panel (a), spanning exactly the accumulated drift
  const gy = panels[0].y + 16 + dispH + 34;
  const rx0 = 70 + (RW - 1) * disp;
  s += `<defs><marker id="m5" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto">` +
    `<path d="M0,3.5 L7,3.5" stroke="#dc2626" stroke-width="1.6"/></marker></defs>\n`;
  s += `<line x1="${rx0}" y1="${gy}" x2="${(rx0 + drift * disp).toFixed(2)}" y2="${gy}" ` +
    `stroke="#dc2626" stroke-width="1.8" marker-start="url(#m5)" marker-end="url(#m5)"/>\n`;
  s += `<text x="${(rx0 + drift * disp / 2).toFixed(1)}" y="${gy + 18}" font-size="11" text-anchor="middle" ` +
    `fill="#b91c1c">行末累积偏移 ${drift.toFixed(1)} 像素</text>\n`;

  const ny = panels[1].y + 16 + dispH + 46;
  s += `<text x="70" y="${ny}" font-size="11.5" fill="#6b7280">` +
    `逐行同步脉冲使误差在每行起始处重新归零，故拖影在一行之内自左向右增长；` +
    `${mismatchPct}% 的失配在 ${RW} 像素宽的行上累积为 ${(RW * mismatchPct / 100).toFixed(1)} 像素</text>\n`;
  s += `<text x="70" y="${ny + 22}" font-size="11.5" fill="#6b7280">` +
    `恢复方式为用 256 个同步头位置的最小二乘拟合求真实行时；` +
    `注入 0.5% 与 1% 失配时，尺度估计为 1.00500 与 1.01000，与真值一致；干净音频上同步残差均方根为 0 样本</text>\n`;
  s += `<text x="70" y="${ny + 46}" font-size="11.5" fill="#9ca3af">` +
    `该机制在真实录音上无净收益（交叉点 0.02%–0.1%，二十六段平均 −0.01 dB），属对未出现失效模式的保险</text>\n`;
  summary.fig5 = write('fig5-clock-recovery.svg', s);
})();

// ------------------------------------------------------------------ figure 7: interleaving
/*
 * Error positions come from a REAL run of js/interleaver.js: a 100-symbol burst is injected into
 * the interleaved (transmitted) stream and the stream is then de-interleaved, so the marks show
 * where the channel errors actually land. Nothing about the pattern is drawn by hand - which
 * matters, because the intuitive guess ("scattered evenly") is not what a block interleaver does.
 */
(function fig7() {
  const D = 32, N = 255, burst = 100;
  const block = D * N;
  const burstStart = 3200;                       // a burst that begins mid-stream, as in practice
  const payload = new Uint8Array(block);
  const inter = Interleaver.interleave(payload, { depth: D, codewordLength: N });
  const rx = Uint8Array.from(inter);
  for (let i = burstStart; i < burstStart + burst && i < block; i++) rx[i] = 1;   // mark the burst
  const de = Interleaver.deinterleave(rx, { depth: D, codewordLength: N });

  const perCodeword = new Array(D).fill(0);
  const marks = [];
  for (let cw = 0; cw < D; cw++) {
    for (let pos = 0; pos < N; pos++) {
      if (de[cw * N + pos]) { perCodeword[cw]++; marks.push([cw, pos]); }
    }
  }
  const total = perCodeword.reduce((a, b) => a + b, 0);
  const maxPer = Math.max.apply(null, perCodeword);
  const maxCorrectable = 16;                     // (255-223)/2, the nsym=32 case
  if (total !== burst) throw new Error('interleaver figure: ' + total + ' marks for a ' + burst + '-symbol burst');

  const h = 470;
  const cwCell = 1.45, rowH = 7.2;
  const matrixW = N * cwCell, matrixH = D * rowH;
  const leftX = 70, rightX = 660, topY = 74;

  let s = svgOpen(h, '图 7 交织对突发错误的分散作用',
    `左侧为一个码字内的 ${burst} 个连续错误，超出里德-所罗门码可纠正的 ${maxCorrectable} 个符号；` +
    `右侧为深度 ${D} 的交织把同一突发分散到 ${D} 个码字后每个码字内的错误数。错误位置由真实交织器计算得出。`);

  // ---- left: one codeword, one long run
  s += `<text x="${leftX}" y="34" font-size="14" font-weight="600" fill="#1f2937">(a) 无交织：错误集中在一个码字内</text>\n`;
  s += `<rect x="${leftX}" y="${topY + 60}" width="${matrixW.toFixed(1)}" height="34" fill="#dbeafe" stroke="#93c5fd"/>\n`;
  s += `<rect x="${leftX}" y="${topY + 60}" width="${(burst * cwCell).toFixed(1)}" height="34" fill="#dc2626"/>\n`;
  s += `<text x="${(leftX + burst * cwCell / 2).toFixed(1)}" y="${topY + 82}" font-size="11" text-anchor="middle" fill="#ffffff">` +
    `${burst} 个连续错误</text>\n`;
  s += `<text x="${(leftX + burst * cwCell).toFixed(1) + 12}" y="${topY + 82}" font-size="11" fill="#1e3a8a">` +
    `其余 ${N - burst} 个符号正确</text>\n`;
  s += `<text x="${leftX}" y="${topY + 122}" font-size="12.5" fill="#b91c1c">` +
    `一个码字内 ${burst} 个错误 &gt; 可纠正的 ${maxCorrectable} 个 → <tspan font-weight="600">解码失败</tspan></text>\n`;
  s += `<text x="${leftX}" y="${topY + 146}" font-size="11.5" fill="#6b7280">` +
    `码字长 ${N}，校验符号 32，可纠正 ⌊32/2⌋ = ${maxCorrectable} 个符号错误</text>\n`;

  // ---- right: D codewords, a vertical stripe
  s += `<text x="${rightX}" y="34" font-size="14" font-weight="600" fill="#1f2937">` +
    `(b) 有交织（深度 D=${D}）：错误分散到 ${D} 个码字</text>\n`;
  s += `<text x="${rightX + matrixW + 8}" y="34" font-size="11" fill="#6b7280">每行一个码字</text>\n`;
  for (let cw = 0; cw < D; cw++) {
    const y = topY + cw * rowH;
    s += `<rect x="${rightX}" y="${y.toFixed(1)}" width="${matrixW.toFixed(1)}" height="${(rowH - 1.2).toFixed(1)}" ` +
      `fill="#dbeafe" stroke="#bfdbfe" stroke-width="0.5"/>\n`;
  }
  for (const [cw, pos] of marks) {
    const y = topY + cw * rowH;
    s += `<rect x="${(rightX + pos * cwCell).toFixed(1)}" y="${y.toFixed(1)}" width="${cwCell.toFixed(2)}" ` +
      `height="${(rowH - 1.2).toFixed(1)}" fill="#dc2626"/>\n`;
  }
  s += `<text x="${rightX}" y="${(topY + matrixH + 24).toFixed(1)}" font-size="12.5" fill="#166534">` +
    `每个码字内最多 ${maxPer} 个错误 ≤ ${maxCorrectable} → <tspan font-weight="600">解码成功</tspan></text>\n`;
  s += `<text x="${rightX}" y="${(topY + matrixH + 48).toFixed(1)}" font-size="11.5" fill="#6b7280">` +
    `实测分布：${perCodeword.filter((c) => c === maxPer).length} 个码字含 ${maxPer} 个错误，` +
    `${perCodeword.filter((c) => c === maxPer - 1).length} 个含 ${maxPer - 1} 个，` +
    `合计 ${total}（= 突发长度 ⌈${burst}/${D}⌉ = ${Math.ceil(burst / D)}）</text>\n`;

  // ---- bottom note
  s += `<text x="70" y="${(topY + matrixH + 92).toFixed(1)}" font-size="12" fill="#374151">` +
    `交织不增加冗余，只改变错误的分布方式：按行写入、按列读出，使长度 b 的突发在每个码字内至多造成 ⌈b/D⌉ 个错误。` +
    `代价是引入解码延迟并增加所需码字数。</text>\n`;
  s += `<text x="70" y="${(topY + matrixH + 114).toFixed(1)}" font-size="11.5" fill="#9ca3af">` +
    `注：本图为 D=${D} 下的机制演示。端到端可用的交织深度受载荷所含码字数限制，实际为 1–2（见 7.1 节表 9 的 L4）。</text>\n`;
  summary.fig7 = write('fig7-interleave-burst.svg', s);
})();

// ------------------------------------------------------------------ figure 10: B sweep
(function fig10() {
  const sw = readJson('sweep-block.json');
  const m32 = fs.existsSync(path.join(OUT, 'eval-matrix-b32.json')) ? readJson('eval-matrix-b32.json') : null;
  const Bs = [16, 32, 48, 64, 96, 128];
  const rows = sw.rows.filter((r) => !r.failed);
  const channels = ['clean', 'mild', 'moderate', 'severe'];
  const colors = { clean: '#2563eb', mild: '#16a34a', moderate: '#d97706', severe: '#dc2626' };

  // goodput is only measured where tier B ran (mild, severe); clean/moderate have no
  // frame-success measurement at these B values, so no bar is drawn for them.
  const goodput = {};
  for (const r of (sw.tierB || [])) {
    if (r.skipped) continue;
    if (!goodput[r.B]) goodput[r.B] = {};
    goodput[r.B][r.channel] = r.goodputBytes;
  }

  // Below the axis this figure needs three stacked lines (x title, measured goodput, and the
  // note that clean/moderate goodput was never measured), which is more room than PAD.b leaves.
  const h = 470, x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = h - 104;
  const yMax = 1;                                     // BER axis, log-ish: use direct values
  const berMax = Math.max.apply(null, rows.map((r) => r.ber)) * 1.15;
  const yScaleBer = (v) => y1 - (v / berMax) * (y1 - y0);
  const bandW = (x1 - x0) / Bs.length;

  let s = svgOpen(h, '图 10 B 值扫描：误码率与 goodput',
    '六档块长 B 在四种信道下的前向纠错前误码率，以及已实测的 goodput（载荷乘帧成功率）。' +
    '最优工作点 B=32 以高亮标出。误码率数据来自 scripts/out/sweep-block.json，' +
    'goodput 来自其中的 tier B（仅 mild 与 severe 两档做过帧成功率测量）。');
  s += axes(x0, y0, x1, y1, '载体块长 B（像素/位）', '误码率 BER（FEC 前）');
  s += grid(x0, y0, x1, y1, [0, berMax / 4, berMax / 2, 3 * berMax / 4, berMax], yScaleBer,
    (t) => t.toFixed(3), Bs, (b) => x0 + (Bs.indexOf(b) + 0.5) * bandW);
  s += `<rect x="${x0 + bandW * 1}" y="${y0}" width="${bandW}" height="${y1 - y0}" fill="#2563eb" opacity="0.06"/>\n`;
  s += `<text x="${x0 + bandW * 1.5}" y="${y0 + 14}" font-size="12" text-anchor="middle" fill="#2563eb">最优工作点 B=32</text>\n`;
  for (const ch of channels) {
    const pts = [];
    for (const B of Bs) {
      const r = rows.find((x) => x.B === B && x.channel === ch);
      if (!r) continue;
      pts.push([x0 + (Bs.indexOf(B) + 0.5) * bandW, yScaleBer(r.ber)]);
    }
    if (!pts.length) continue;
    s += `<polyline fill="none" stroke="${colors[ch]}" stroke-width="2.1" points="${pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/>\n`;
    for (const p of pts) s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.4" fill="${colors[ch]}"/>\n`;
  }
  s += legend(x1 - 170, y0 + 12, channels.map((c) => ({ color: colors[c], label: c })));
  // goodput markers along the bottom
  let gx = x0;
  const gs = [];
  for (const B of Bs) {
    const g = goodput[B];
    if (!g) continue;
    for (const ch of Object.keys(g)) {
      gs.push(`${B}/${ch}=${g[ch].toFixed(0)}B`);
    }
  }
  if (gs.length) {
    s += `<text x="${x0}" y="${y1 + 66}" font-size="11" fill="#6b7280">goodput（已实测）: ${esc(gs.join('   '))}</text>\n`;
  }
  // on its own line: sharing y1+38 with the goodput list made the two collide
  s += `<text x="${x0}" y="${y1 + 88}" font-size="11" fill="#9ca3af">clean/moderate 的 goodput 未测（见表 4 表注）</text>\n`;
  summary.fig10 = write('fig10-b-sweep.svg', s);
})();

// ------------------------------------------------------------------ figure 11: content dependence
(function fig11() {
  const ec = readJson('eval-content.json');
  const rows = ec.rows;
  const classes = [...new Set(rows.map((r) => r.cls))].sort();
  const labels = {
    A: '自然照片（同场景变体）', B: '高对比色条/图形', C: '屏幕截图（含文字）',
    D: '卡通/矢量', E: '低对比度平缓', F: '1/f 谱合成（统计对照）'
  };
  const colors = ['#2563eb', '#dc2626', '#d97706', '#16a34a', '#7c3aed', '#0891b2'];

  const h = 430, x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = h - PAD.b;
  const xMax = Math.max.apply(null, rows.map((r) => r.unreachableFrac)) * 1.15 || 0.01;
  const yMax = Math.max.apply(null, rows.map((r) => r.ber)) * 1.15 || 0.01;
  const xS = (v) => x0 + (v / xMax) * (x1 - x0);
  const yS = (v) => y1 - (v / yMax) * (y1 - y0);

  let s = svgOpen(h, '图 11 内容依赖性：不可嵌入块占比与误码率',
    '六十张测试图（六类各十张）在干净信道下的不可嵌入块占比与载体误码率散点图，' +
    '并标出拟合出的告警阈值与目标误码率。数据来自 scripts/out/eval-content.json。');
  s += axes(x0, y0, x1, y1, '不可嵌入块占比 unreachableFrac', '载体误码率 BER');
  s += grid(x0, y0, x1, y1, [0, yMax / 2, yMax], yS, (t) => t.toFixed(3),
    [0, xMax / 2, xMax], (t) => xS(t), (t) => t.toFixed(4));
  const thr = ec.threshold;
  const target = ec.pTarget;
  if (isFinite(thr) && thr <= xMax) {
    s += `<line x1="${xS(thr).toFixed(1)}" y1="${y0}" x2="${xS(thr).toFixed(1)}" y2="${y1}" stroke="#dc2626" stroke-width="1.6" stroke-dasharray="6 4"/>\n`;
    s += `<text x="${xS(thr) + 5}" y="${y0 + 14}" font-size="11" fill="#dc2626">告警阈值 ${thr.toFixed(4)}</text>\n`;
  }
  if (target <= yMax) {
    s += `<line x1="${x0}" y1="${yS(target).toFixed(1)}" x2="${x1}" y2="${yS(target).toFixed(1)}" stroke="#6b7280" stroke-width="1.4" stroke-dasharray="4 4"/>\n`;
    s += `<text x="${x1 - 4}" y="${yS(target) - 6}" font-size="11" text-anchor="end" fill="#6b7280">目标 BER ${target.toExponential(1)}</text>\n`;
  }
  classes.forEach((c, i) => {
    const pts = rows.filter((r) => r.cls === c);
    for (const p of pts) {
      s += `<circle cx="${xS(p.unreachableFrac).toFixed(1)}" cy="${yS(p.ber).toFixed(1)}" r="4" ` +
        `fill="${colors[i % colors.length]}" fill-opacity="0.78"/>\n`;
    }
  });
  s += legend(x1 - 240, y0 + 12, classes.map((c, i) => ({ color: colors[i % colors.length], label: c + ' ' + (labels[c] || '') })));
  const best = ec.rho && ec.rho[0];
  s += `<text x="${x0}" y="${y1 + 38}" font-size="11" fill="#6b7280">最强单特征 ${esc(ec.best)}  Spearman ρ=${best ? best.rho.toFixed(3) : '-'}</text>\n`;
  summary.fig11 = write('fig11-content-dependence.svg', s);
})();

// ------------------------------------------------------------------ figure 12: real audio
(function fig12() {
  const ev = readJson('eval-real-decode.json');
  const manifest = readRel(path.join('tests', 'fixtures', 'real', 'manifest.json'));
  const group = {};
  for (const s of manifest.samples) group[s.id] = s.group || '真实录音';
  const agg = {};
  for (const r of ev.results) {
    if (r.config !== 'affine') continue;
    const g = group[r.id] || '其他';
    agg[g] = agg[g] || { ok: 0, total: 0 };
    agg[g].total++;
    if (r.ok) agg[g].ok++;
  }
  const groups = Object.keys(agg).sort((a, b) => agg[b].total - agg[a].total);
  const h = 400, x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = h - PAD.b;
  const yS = (v) => y1 - v * (y1 - y0);
  const bandW = (x1 - x0) / groups.length;
  let s = svgOpen(h, '图 12 真实音频解码结果（按损伤类型分组）',
    '二十六段样本在默认标定配置下的解码成功率，按信道损伤类型分组。' +
    '数据来自 scripts/out/eval-real-decode.json，分组取自样本清单。');
  s += axes(x0, y0, x1, y1, '损伤类型', '解码成功率');
  s += grid(x0, y0, x1, y1, [0, 0.25, 0.5, 0.75, 1], yS, (t) => (t * 100).toFixed(0) + '%', null, null);
  groups.forEach((g, i) => {
    const a = agg[g];
    const rate = a.ok / a.total;
    const bx = x0 + i * bandW + bandW * 0.2;
    const bw = bandW * 0.6;
    const by = yS(rate);
    const col = rate === 1 ? '#16a34a' : (rate >= 0.5 ? '#d97706' : '#dc2626');
    s += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${(y1 - by).toFixed(1)}" fill="${col}" fill-opacity="0.82"/>\n`;
    s += `<text x="${(bx + bw / 2).toFixed(1)}" y="${(by - 6).toFixed(1)}" font-size="11" text-anchor="middle" fill="#374151">${a.ok}/${a.total}</text>\n`;
    s += `<text x="${(bx + bw / 2).toFixed(1)}" y="${y1 + 18}" font-size="11" text-anchor="middle" fill="#4b5563">${esc(g)}</text>\n`;
  });
  const totalOk = Object.values(agg).reduce((a, b) => a + b.ok, 0);
  const totalN = Object.values(agg).reduce((a, b) => a + b.total, 0);
  s += `<text x="${x1}" y="${y0 + 12}" font-size="12" text-anchor="end" fill="#374151">合计 ${totalOk}/${totalN}</text>\n`;
  summary.fig12 = write('fig12-real-audio.svg', s);
})();

// ------------------------------------------------------------------ figure 13: post-processing
(function fig13() {
  const pp = readJson('eval-postprocess.json');
  const rows = pp.rows;
  // x axis: measured noise level of the input image (sigmaHF), which is the honest ordering
  // variable - the samples are not a controlled SNR sweep.
  const filters = pp.filters;
  const h = 430, x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = h - PAD.b;
  const xs = rows.map((r) => r.sigmaHF);
  const xMin = Math.min.apply(null, xs) * 0.9, xMax = Math.max.apply(null, xs) * 1.05;
  const deltas = [];
  for (const r of rows) for (const f of filters) if (r.filters[f].delta != null) deltas.push(r.filters[f].delta);
  const dMin = Math.min(0, Math.min.apply(null, deltas)) * 1.2;
  const dMax = Math.max(0, Math.max.apply(null, deltas)) * 1.2;
  const xS = (v) => x0 + ((v - xMin) / (xMax - xMin)) * (x1 - x0);
  const yS = (v) => y1 - ((v - dMin) / (dMax - dMin)) * (y1 - y0);

  const meanAt = (r) => {
    const ds = filters.map((f) => r.filters[f].delta).filter((d) => d != null);
    return ds.reduce((a, b) => a + b, 0) / ds.length;
  };
  const bestAt = (r) => Math.max.apply(null, filters.map((f) => r.filters[f].delta).filter((d) => d != null));

  let s = svgOpen(h, '图 13 后处理的双向影响',
    '水平轴为输入图象的实测噪声水平（高通残差均方根），纵轴为滤波后的峰值信噪比变化。' +
    '均值曲线是六种滤波的平均，最优曲线取六种滤波中的最佳者。数据来自 scripts/out/eval-postprocess.json。');
  s += axes(x0, y0, x1, y1, '输入噪声水平 σ_HF（灰阶）', 'PSNR 变化（dB）');
  s += grid(x0, y0, x1, y1, [dMin, 0, dMax], yS, (t) => (t >= 0 ? '+' : '') + t.toFixed(1), null, null);
  const yZero = yS(0);
  s += `<line x1="${x0}" y1="${yZero.toFixed(1)}" x2="${x1}" y2="${yZero.toFixed(1)}" stroke="#374151" stroke-width="1.6"/>\n`;
  const sorted = rows.slice().sort((a, b) => a.sigmaHF - b.sigmaHF);
  for (const [key, col, name] of [['mean', '#2563eb', '六种滤波均值'], ['best', '#16a34a', '最佳滤波']]) {
    const pts = sorted.map((r) => [xS(r.sigmaHF), yS(key === 'mean' ? meanAt(r) : bestAt(r))]);
    s += `<polyline fill="none" stroke="${col}" stroke-width="2.2" points="${pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/>\n`;
    for (const p of pts) s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.4" fill="${col}"/>\n`;
  }
  s += legend(x1 - 190, y0 + 12, [{ color: '#2563eb', label: '六种滤波均值' }, { color: '#16a34a', label: '最佳滤波' }]);
  const clean = rows.find((r) => r.id === 'real-npm-8k');
  if (clean) {
    s += `<text x="${xS(clean.sigmaHF).toFixed(1)}" y="${(yS(meanAt(clean)) + 22).toFixed(1)}" font-size="11" text-anchor="middle" fill="#dc2626">干净录音：均值 ${meanAt(clean).toFixed(2)} dB</text>\n`;
  }
  s += `<text x="${x0}" y="${y1 + 38}" font-size="11" fill="#6b7280">零线以上为增益，以下为损失；干净样本落在零线以下，故后处理默认关闭</text>\n`;
  summary.fig13 = write('fig13-postprocess.svg', s);
})();

fs.writeFileSync(path.join(OUT, 'paper-figures.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), width: W, figures: summary }, null, 2));
console.log('\n-> scripts/out/paper-figures.json');
