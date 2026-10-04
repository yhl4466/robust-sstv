/*
 * Build the degradation curve chart (inline SVG) plus the Robot36-position note.
 *
 * INPUT is tests/degradation-matrix-results.json, written by tests/degradation-matrix.js. Nothing here
 * invents a number: every plotted point is a PSNR the decoder actually produced, and a dimension whose
 * ladder has fewer than two usable points is reported as unavailable rather than drawn as a flat line.
 *
 * ============================ WHY THIS LAYOUT, AFTER TWO REJECTED ONES ============================
 *
 * The first version drew everything in one 900x500 box: curves, an 8-row legend laid over the top of the
 * plot, and x labels rotated -45 degrees under the axis. It was unreadable in exactly the two ways the
 * layouts below fix:
 *
 *   1. THE LEGEND SAT ON TOP OF THE CURVES. Eight rows of series text covered the top ~120 px of the plot -
 *      precisely where the clean and mildly-degraded points live - so the legend hid the data it described.
 *      FIX: the legend gets its own column to the RIGHT of the plot. Nothing overlaps, and no series colour
 *      is hidden behind its own label.
 *
 *   2. THE X LABELS WERE ROTATED AND CLIPPED. Rotating -45 degrees was a way to fit ~15 long parameter
 *      labels ("手机外放（RT60 0.3 + 削波 3× + +20 Hz）") under one axis. It does not fit: the leftmost and
 *      rightmost labels ran off the canvas edge, and neighbours crossed each other. FIX: horizontal labels
 *      arranged in a block BELOW the axis, laid out in columns with wrapping, in normal reading orientation.
 *      Horizontal text cannot be clipped at an angle and cannot cross its neighbour if it has its own row.
 *
 * The x axis is each dimension's position in its OWN ladder, normalised to [0,1]. That is deliberate and it
 * is a limitation, stated on the chart: "20 dB SNR", "RT60 0.30 s" and "+30 Hz" are not commensurable, so a
 * shared severity axis would be a fiction. What the chart can honestly show is how far into each dimension's
 * usable range a setting lies, with the real parameter values listed underneath.
 *
 * Robot36 is NOT plotted: this project has no per-dimension measurements for it, and an estimated series
 * drawn beside measured ones would put an invented curve into the same visual language as real data. One
 * genuine same-signal comparison exists (the real phone recording) and it is referenced on the chart.
 * ================================================================================================
 *
 * Usage: node scripts/gen-degradation-curve.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESULTS = path.join(ROOT, 'tests', 'degradation-matrix-results.json');
const OUTDIR = path.join(ROOT, 'tests', 'diag-quality');

if (!fs.existsSync(RESULTS)) {
  console.error('缺少 tests/degradation-matrix-results.json —— 先跑 node tests/degradation-matrix.js');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
const USABLE_DB = 25;

/*
 * Series definitions. `pick` selects the rows of one ladder; `order` is a severity comparator written
 * BENIGN-FIRST, so no separate reverse flag is needed and no series can be reversed by accident.
 *
 * Severity direction differs per dimension and is easy to get backwards:
 *   加性噪声   higher SNR is BETTER          -> descending SNR
 *   硬削波     higher multiple is WORSE      -> ascending multiple
 *   频率失谐   larger |shift| is WORSE       -> ascending |shift|
 *   采样率失配 larger mismatch is WORSE      -> ascending percent
 *   声学路径   longer RT60 is WORSE          -> ascending RT60
 *   JPEG      HIGHER quality is BETTER       -> descending quality
 *
 * THE PATTERNS ARE ANCHORED. A suffix test (/Hz$/, /%$/, /×$/, /RT60/) also matches the COMBINATION rows,
 * because those carry the same tokens inside a longer label - "SSB 失谐 + 噪声（+50 Hz + SNR 20）" contains
 * "+50 Hz", and "声学 RT60 0.30 s + 频偏 +10 Hz" contains "RT60". The first version therefore drew a
 * 采样率失配 threshold crossing between two rows from different dimensions.
 */
const SERIES = [
  { key: 'AWGN', label: '加性噪声', color: '#4c9aff',
    pick: (rows) => rows.filter((r) => /^SNR \d+ dB$/.test(r.param) || r.param === 'clean'),
    order: (a, b) => snrOf(b) - snrOf(a), axis: (r) => r.param === 'clean' ? 'clean' : r.param.replace('SNR ', '') },
  { key: '削波', label: '硬削波', color: '#f5a623',
    pick: (rows) => rows.filter((r) => /^[\d.]+×$/.test(r.param)),
    order: (a, b) => clipOf(a) - clipOf(b), axis: (r) => r.param },
  /*
   * Frequency offset is TWO series, not one: the measured response is strongly asymmetric (+50 Hz still
   * decodes, -5 Hz does not), so interleaving the signs into one line produced a sawtooth that crossed the
   * threshold repeatedly and implied erratic behaviour. Each sign is smooth on its own; it is the SIGNS that
   * differ, and that is the finding worth plotting.
   */
  { key: '频率偏移+', label: '频率失谐（正向）', color: '#e8574a',
    pick: (rows) => rows.filter((r) => /^\+[\d.]+ Hz$/.test(r.param) || r.param === '+0 Hz'),
    order: (a, b) => Math.abs(hzOf(a)) - Math.abs(hzOf(b)), axis: (r) => r.param.replace('+0 Hz', '0') },
  { key: '频率偏移-', label: '频率失谐（负向）', color: '#ff8f7a',
    pick: (rows) => rows.filter((r) => /^-\d+ Hz$/.test(r.param)),
    order: (a, b) => Math.abs(hzOf(a)) - Math.abs(hzOf(b)), axis: (r) => r.param },
  { key: '采样率失配', label: '采样率失配', color: '#9b7dea',
    pick: (rows) => rows.filter((r) => /^[\d.]+ %$/.test(r.param)),
    order: (a, b) => pctOf(a) - pctOf(b), axis: (r) => r.param },
  { key: '声学路径', label: '声学路径（混响）', color: '#37b98a',
    pick: (rows) => rows.filter((r) => /^RT60 [\d.]+ s$/.test(r.param)),
    order: (a, b) => rtOf(a) - rtOf(b), axis: (r) => r.param.replace('RT60 ', '').replace(' s', '') },
  /*
   * Combinations have no natural severity order (different situations, not points on one axis), so the JSON
   * order is kept. JPEG is separate: it is an image-domain re-encode rather than a channel impairment.
   */
  { key: '组合退化', label: '组合退化', color: '#c9a227',
    pick: (rows) => rows.filter((r) => /（/.test(r.param) && !/^JPEG/.test(r.param)),
    order: null, axis: (r) => r.param },
  { key: 'JPEG', label: 'JPEG 重编码', color: '#6f7b8a',
    pick: (rows) => rows.filter((r) => /^JPEG/.test(r.param)),
    order: (a, b) => qvOf(b) - qvOf(a), axis: (r) => 'q' + qvOf(r) }
];

/*
 * Sort keys must return FINITE numbers: `Infinity` looks like a reasonable sentinel for "clean", but a
 * comparator computing Infinity - Infinity returns NaN, and Array.sort treats a NaN result as "keep the
 * current order" - so the ladder came out reversed and the AWGN series reported its threshold crossing
 * against 6 dB as if that were the starting point. A large finite value orders the same way without NaN.
 */
const CLEAN_KEY = 9999;
function snrOf(r) { const m = /SNR (\d+)/.exec(r.param); return m ? Number(m[1]) : CLEAN_KEY; }
function clipOf(r) { const m = /([\d.]+)×/.exec(r.param); return m ? Number(m[1]) : 0; }
function hzOf(r) { const m = /([+-]?\d+) Hz/.exec(r.param); return m ? Number(m[1]) : 0; }
function pctOf(r) { const m = /([\d.]+) %/.exec(r.param); return m ? Number(m[1]) : 0; }
function rtOf(r) { const m = /RT60 ([\d.]+)/.exec(r.param); return m ? Number(m[1]) : 0; }
function qvOf(r) { const m = /质量 (\d+)/.exec(r.param); return m ? Number(m[1]) : 0; }

/** Series as ordered point lists, with single-point series dropped (they cannot define a trend). */
function buildSeries() {
  const out = [];
  for (const s of SERIES) {
    let rows = s.pick(data.rows);
    // comparators are benign-first by construction, so NO reverse here (see the SERIES header)
    if (s.order && rows.length > 1) rows = rows.slice().sort(s.order);
    const pts = rows.map((r) => ({ label: s.axis(r), psnr: r.psnr, status: r.status, raw: r.param }));
    const usable = pts.filter((p) => p.psnr != null);
    if (usable.length < 2) {
      console.log('跳过（可用点不足）: ' + s.label + ' → ' + usable.length + ' 个');
      continue;
    }
    out.push({ key: s.key, label: s.label, color: s.color, points: pts });
  }
  return out;
}

/**
 * First crossing of USABLE_DB, by linear interpolation on the normalised x axis.
 *
 * Returns an OBJECT describing which of three situations applies, because "the series never crosses 25 dB"
 * has two very different readings and an earlier version conflated them in the legend:
 *   { kind: 'cross', index, from, to }  starts usable, degrades past the threshold
 *   { kind: 'always' }                  every point at or above the threshold (never became unusable)
 *   { kind: 'below' }                   the FIRST point is already below (never was usable)
 * Reporting 'below' as "全程可用" is the exact failure this project keeps guarding against: a plausible
 * label that says the opposite of the data.
 */
function crossing(points) {
  const usable = points.filter((p) => p.psnr != null);
  if (!usable.length) return { kind: 'none' };
  if (usable[0].psnr < USABLE_DB) return { kind: 'below', first: usable[0] };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (a.psnr == null || b.psnr == null) continue;
    if (a.psnr >= USABLE_DB && b.psnr < USABLE_DB) {
      const f = (a.psnr - USABLE_DB) / (a.psnr - b.psnr);
      /*
       * Return the INDEX-SPACE position (i-1+f) and let the caller map it with the same xOf() used for the
       * data points. An earlier version divided by (n-1) and returned 0..1, which the marker then used
       * directly as an x coordinate - so every crossing was drawn at x=0..1, hard against the left edge.
       */
      return { kind: 'cross', index: (i - 1) + f, from: a, to: b };
    }
  }
  return { kind: 'always' };
}

/**
 * Legend text for a series.
 *
 * THE PRIMARY FIGURE IS THE LAST RUNG THAT ACTUALLY MET THE CRITERION, not the bracketing pair.
 *
 * An earlier wording read "可用至 30 dB 与 20 dB 之间", which is true as a bracket but reads as
 * "somewhere around 20-30 dB" - and on the noise ladder, 20 dB measures 24.84 dB, i.e. it FAILS. A reader
 * (and, in this project's own README, the author) took away "20 dB still works", which is wrong. Naming the
 * last passing rung with its measured value ("可用至信噪比 30 dB（25.27 dB）") cannot be misread that way, and
 * the failing neighbour is reported separately so the margin is visible.
 */
function legendText(s, c) {
  if (c.kind === 'cross') {
    return {
      main: s.label + '：可用至 ' + c.from.label + '（' + c.from.psnr.toFixed(2) + ' dB）',
      detail: '再降到 ' + c.to.label + ' 即不达标（' + c.to.psnr.toFixed(2) + ' dB，判据 ' + USABLE_DB + '）'
    };
  }
  if (c.kind === 'always') {
    const worst = s.points.filter((p) => p.psnr != null).reduce((m, p) => (p.psnr < m.psnr ? p : m));
    return { main: s.label + '：本阶梯全程达标',
      detail: '最低 ' + worst.psnr.toFixed(2) + ' dB（' + worst.label + '）' };
  }
  if (c.kind === 'below') {
    return { main: s.label + '：起点即不达标',
      detail: c.first.label + ' ' + c.first.psnr.toFixed(2) + ' dB（判据 ' + USABLE_DB + '）' };
  }
  return { main: s.label + '：无有效点', detail: '' };
}

const series = buildSeries();

/* ------------------------------------------------------------------ layout */

/*
 * Geometry. Two things must never overlap the plot: the legend column and the parameter block.
 *
 *   PLOT_W/PLOT_H  the curve area, drawn from (PAD.l, PAD.t).
 *   LEG_X          the legend column, PLOT_W + PAD.l + 30 to the right. Its widest entry
 *                  ("频率失谐（负向）：起点即低于阈值") needs about 300 px at 11.5 px, so the column is 330.
 *   PAD.b          a parameter block with ONE ROW PER SERIES, at 16 px per row.
 *
 * THE PARAMETER BLOCK IS ONE ROW PER SERIES, NOT A COLUMN GRID. The previous attempt packed four series into
 * each of four columns, giving every label about 270 px for text that is 400-500 px long - so the labels
 * overwrote each other and the block was less readable than the rotated labels it replaced. A full-width row
 * per series cannot collide with anything: each row starts at the left margin and the longest label
 * ("组合退化：灯下干净（RT60 0.3 + +10 Hz 失谐） · 手机外放（RT60 0.3 + 削波 3× + +20 Hz） · ...") is wrapped
 * across indented continuation lines instead of being clipped.
 */
const PAD = { l: 58, t: 30, b: 26 };
const PLOT_W = 560, PLOT_H = 430;
const LEG_W = 330, LEG_GAP = 30;
const ROW_H = 16, MAX_LABEL_CHARS = 96;
const H = PAD.t + PLOT_H + PAD.b;
const plotRight = PAD.l + PLOT_W;
const plotBottom = PAD.t + PLOT_H;
const legX = plotRight + LEG_GAP;

const Y_MIN = 4, Y_MAX = 34;
const xOf = (i, n) => PAD.l + (n <= 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W);
const yOf = (db) => PAD.t + PLOT_H - ((db - Y_MIN) / (Y_MAX - Y_MIN)) * PLOT_H;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Wrap a label into lines, breaking on the separators the label already contains (" · ", "：", "，").
 * Breaking on existing separators keeps each line a meaningful unit rather than cutting mid-token.
 *
 * LOSSLESS: whatever does not fit within `maxLines` is APPENDED to the last line, never dropped.
 *
 * An earlier version capped the output and appended "…" to indicate truncation, which the figure check
 * caught: two 组合退化 labels came out incomplete ("最坏（SNR 10 + RT60 0.6 + 削波 3× + +50 Hz + 0.5%）" lost
 * its tail), so the chart would have listed a subset of the measured settings while appearing complete. An
 * over-long final line is the lesser evil - and at 9.5 px it still fits, because the block is full width.
 */
function wrapLabel(text, maxChars, maxLines) {
  const parts = String(text).split(/(?<= · )/);
  const lines = [];
  let cur = '';
  for (const part of parts) {
    if (cur === '' || (cur + part).length <= maxChars) {
      cur += part;
    } else {
      lines.push(cur.replace(/ · $/, ''));
      cur = part;
    }
  }
  if (cur) lines.push(cur.replace(/ · $/, ''));
  if (lines.length <= maxLines) return lines;
  // merge the overflow into the last permitted line instead of discarding it
  const keep = lines.slice(0, maxLines - 1);
  keep.push(lines.slice(maxLines - 1).join(' '));
  return keep;
}

function buildSvg() {
  const p = [];
  const W = PAD.l + PLOT_W + LEG_GAP + LEG_W + 12;
  p.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" ' +
    'width="100%" role="img" aria-label="六种退化下的解码 PSNR 曲线" ' +
    'font-family="system-ui, -apple-system, Segoe UI, sans-serif">');
  p.push('<title>图 14 六类退化的解码 PSNR 曲线</title>');
  p.push('<rect width="' + W + '" height="' + H + '" fill="#0e1116"/>');

  // ---- y grid and labels
  for (let db = Y_MIN; db <= Y_MAX; db += 2) {
    const y = yOf(db);
    p.push('<line x1="' + PAD.l + '" y1="' + y.toFixed(1) + '" x2="' + plotRight + '" y2="' + y.toFixed(1) +
      '" stroke="#20262f" stroke-width="1"/>');
    p.push('<text x="' + (PAD.l - 8) + '" y="' + (y + 4).toFixed(1) +
      '" fill="#7d8794" font-size="10.5" text-anchor="end">' + db + '</text>');
  }
  p.push('<text x="' + (PAD.l - 8) + '" y="' + (PAD.t - 12) +
    '" fill="#7d8794" font-size="10.5" text-anchor="end">dB</text>');

  // ---- usable band and threshold line
  const yT = yOf(USABLE_DB);
  p.push('<rect x="' + PAD.l + '" y="' + PAD.t + '" width="' + PLOT_W + '" height="' +
    (yT - PAD.t).toFixed(1) + '" fill="#37b98a" opacity="0.05"/>');
  p.push('<line x1="' + PAD.l + '" y1="' + yT.toFixed(1) + '" x2="' + plotRight + '" y2="' + yT.toFixed(1) +
    '" stroke="#37b98a" stroke-width="1.4" stroke-dasharray="6 4" opacity="0.8"/>');
  p.push('<text x="' + (PAD.l + 6) + '" y="' + (yT - 6).toFixed(1) +
    '" fill="#37b98a" font-size="10.5">可用阈值 ' + USABLE_DB + ' dB</text>');

  // ---- series
  series.forEach((s) => {
    const n = s.points.length;
    const pts = s.points.map((pt, i) => ({ x: xOf(i, n), y: pt.psnr == null ? null : yOf(pt.psnr), pt: pt }));
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        p.push('<polyline fill="none" stroke="' + s.color + '" stroke-width="2.2" stroke-linejoin="round" ' +
          'points="' + seg.map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' ') + '"/>');
      }
      seg = [];
    };
    // a failed decode leaves a visible GAP rather than a fabricated bridge across it
    for (const q of pts) { if (q.y == null) flush(); else seg.push(q); }
    flush();
    for (const q of pts) {
      if (q.y == null) {
        p.push('<text x="' + q.x.toFixed(1) + '" y="' + (plotBottom - 4) + '" fill="' + s.color +
          '" font-size="13" text-anchor="middle" opacity="0.85">×</text>');
      } else {
        p.push('<circle cx="' + q.x.toFixed(1) + '" cy="' + q.y.toFixed(1) + '" r="3.2" fill="' + s.color + '"/>');
      }
    }
    const c = crossing(s.points);
    if (c.kind === 'cross') {
      const cx = xOf(c.index, n).toFixed(1);
      p.push('<line x1="' + cx + '" y1="' + yT.toFixed(1) + '" x2="' + cx + '" y2="' + plotBottom +
        '" stroke="' + s.color + '" stroke-width="1" stroke-dasharray="3 3" opacity="0.45"/>');
      p.push('<circle cx="' + cx + '" cy="' + yT.toFixed(1) + '" r="3.8" fill="none" stroke="' + s.color +
        '" stroke-width="1.5"/>');
    }
  });

  // ---- legend column, to the RIGHT of the plot so it cannot cover a curve
  p.push('<text x="' + legX + '" y="' + (PAD.t - 12) + '" fill="#7d8794" font-size="10.5">' +
    '曲线 · 可用范围</text>');
  const rowH = 42;
  series.forEach((s, i) => {
    const y = PAD.t + 6 + i * rowH;
    const t = legendText(s, crossing(s.points));
    p.push('<line x1="' + legX + '" y1="' + (y + 5) + '" x2="' + (legX + 20) + '" y2="' + (y + 5) +
      '" stroke="' + s.color + '" stroke-width="2.6"/>');
    p.push('<circle cx="' + (legX + 10) + '" cy="' + (y + 5) + '" r="3" fill="' + s.color + '"/>');
    p.push('<text x="' + (legX + 28) + '" y="' + (y + 2) + '" fill="#c8d0da" font-size="11.5">' +
      esc(t.main) + '</text>');
    if (t.detail) {
      p.push('<text x="' + (legX + 28) + '" y="' + (y + 17) + '" fill="#8d97a3" font-size="10.5">' +
        esc(t.detail) + '</text>');
    }
  });

  // ---- parameter block: ONE ROW PER SERIES, full width, so nothing can collide
  const blockTop = plotBottom + 26;
  let cursor = blockTop;
  for (const s of series) {
    p.push('<rect x="' + PAD.l + '" y="' + (cursor - 8) + '" width="9" height="9" fill="' + s.color +
      '" rx="1.5"/>');
    const names = s.points.map((q) => q.label).join(' · ');
    const lines = wrapLabel(s.label + '：' + names, MAX_LABEL_CHARS, 2);
    lines.forEach((ln, i) => {
      p.push('<text x="' + (PAD.l + 14) + '" y="' + (cursor + i * 13) + '" fill="#8d97a3" font-size="10">' +
        esc(ln) + '</text>');
    });
    cursor += lines.length * 13 + 4;
  }
  const noteY = cursor + 8;
  p.push('<text x="' + PAD.l + '" y="' + noteY + '" fill="#69737f" font-size="10.5">' +
    '横轴：各维度在自身档位序列中的位置（六维单位不相通，不共用实轴）· × 表示该档解码失败 · ' +
    '未画 Robot36 —— 无其逐维度实测数据</text>');

  p.push('</svg>');
  return { svg: p.join('\n'), width: W, height: noteY + 14 };
}

const built = buildSvg();
const svg = built.svg.replace(/viewBox="0 0 (\d+) \d+"/, 'viewBox="0 0 $1 ' + Math.round(built.height) + '"');
fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(path.join(OUTDIR, 'degradation-curves.svg'), svg);
fs.writeFileSync(path.join(OUTDIR, 'degradation-curves.json'), JSON.stringify({
  usableThresholdDb: USABLE_DB,
  control: data.control,
  series: series.map((s) => {
    const c = crossing(s.points);
    return {
      key: s.key, label: s.label, color: s.color, points: s.points,
      crossing: c.kind === 'cross'
        ? { kind: 'cross', from: c.from.label, to: c.to.label, index: Number(c.index.toFixed(4)) }
        : { kind: c.kind, first: c.first ? { label: c.first.label, psnr: c.first.psnr } : undefined }
    };
  })
}, null, 2));

console.log('写入 tests/diag-quality/degradation-curves.svg (' + (svg.length / 1024).toFixed(1) + ' KB)' +
  ' · 画布 ' + built.width + 'x' + Math.round(built.height));
console.log('写入 tests/diag-quality/degradation-curves.json');
console.log('\n各维度可用范围（' + USABLE_DB + ' dB 阈值）：');
for (const s of series) {
  const t = legendText(s, crossing(s.points));
  console.log('  ' + t.main + (t.detail ? '  （' + t.detail + '）' : ''));
}
console.log('\n布局：绘图区 ' + PLOT_W + 'x' + PLOT_H + ' · 图例独占右侧 ' + LEG_W + 'px 列 · ' +
  '刻度标签水平排列于下方');
