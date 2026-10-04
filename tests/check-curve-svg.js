/*
 * Structural checks on the generated degradation chart.
 *
 * These exist because the chart's first version LOOKED like a chart while being wrong in three ways that
 * only a numeric check catches: the threshold-crossing markers were drawn at x = 0..1 (hard against the left
 * edge, because a 0..1 normalised position was used as a pixel coordinate), the y range clipped every
 * series that collapsed, and the frequency series interlaced both signs into a sawtooth. None of those is a
 * rendering error - the SVG was valid, it just said the wrong thing.
 *
 * Usage: node tests/check-curve-svg.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'tests', 'diag-quality', 'degradation-curves.svg');
const JSONF = path.join(ROOT, 'tests', 'diag-quality', 'degradation-curves.json');

let failures = 0;
function check(ok, label, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const svg = fs.readFileSync(SVG, 'utf8');
const meta = JSON.parse(fs.readFileSync(JSONF, 'utf8'));

console.log('=== 退化曲线 SVG 结构检查 ===\n');

const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
check(!!vb, 'viewBox 存在');
const W = Number(vb[1]), H = Number(vb[2]);
console.log('  画布 ' + W + 'x' + H + '\n');

// --- geometry: every drawn element must sit inside the canvas
{
  let out = 0, minY = Infinity, maxY = -Infinity;
  const cyRe = /<circle cx="([\d.]+)" cy="([\d.]+)"/g;
  let m;
  while ((m = cyRe.exec(svg))) {
    const y = Number(m[2]);
    if (y < 0 || y > H) out++;
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const plRe = /<polyline[^>]*points="([^"]+)"/g;
  while ((m = plRe.exec(svg))) {
    for (const p of m[1].split(' ')) {
      const y = Number(p.split(',')[1]);
      if (!isFinite(y)) continue;
      if (y < 0 || y > H) out++;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  check(out === 0, '所有点都在画布内', '越界 ' + out + ' 个，y 范围 ' +
    minY.toFixed(1) + '..' + maxY.toFixed(1));
}

/*
 * Threshold markers must be inside the PLOT area, not merely inside the canvas. This is the check that the
 * x=0..1 bug would have failed: those markers were at x=0.0-0.3, inside the 900px canvas but outside the
 * 62..882 plot region.
 */
{
  const thrY = /可用阈值/.test(svg) ? (() => {
    const m = /<line x1="[\d.]+" y1="([\d.]+)"[^>]*stroke="#37b98a"/.exec(svg);
    return m ? Number(m[1]) : null;
  })() : null;
  const markers = [];
  const re = /<line x1="([\d.]+)" y1="([\d.]+)"[^>]*stroke-dasharray="3 3"/g;
  let m;
  while ((m = re.exec(svg))) {
    if (thrY != null && Math.abs(Number(m[2]) - thrY) < 0.5) markers.push(Number(m[1]));
  }
  const PADL = 62, PADL_R = 882;
  const bad = markers.filter((x) => x < PADL || x > PADL_R);
  check(markers.length > 0, '存在阈值穿越标记', String(markers.length) + ' 个');
  check(bad.length === 0, '穿越标记位于绘图区内', bad.length ? '越界 x=' + bad.join(',') : 'x=' +
    markers.map((v) => v.toFixed(0)).join(','));
}

// --- series count and drawn polylines
{
  const polys = (svg.match(/<polyline/g) || []).length;
  check(polys >= meta.series.length, '每条有数据的序列都画出了折线',
    polys + ' 条折线 / ' + meta.series.length + ' 条序列');
  check(meta.series.length >= 6, '至少 6 条曲线（含正负频偏拆分）', String(meta.series.length));
}

// --- every series that HAS a clean baseline must be ordered benign -> severe
{
  const problems = [];
  for (const s of meta.series) {
    const pts = s.points.filter((p) => p.psnr != null);
    if (pts.length < 2) continue;
    /*
     * The rule is deliberately conditional. A ladder that begins at "clean" (or at its least impaired rung)
     * must have its first point within 3 dB of the series' best score - otherwise the ordering is probably
     * reversed. A ladder with NO clean rung is exempt: 组合退化 is a set of different real-world situations
     * rather than points on one axis, and its least-severe member (a reverberant room plus +10 Hz) legitimately
     * scores only 10.2 dB. Applying the rule unconditionally flagged that as a defect, which is how this
     * exemption came to be written down instead of assumed.
     */
    const startsClean = /clean|^0 %$|^1×$|^\+0 Hz$|^q85$/.test(pts[0].label);
    if (!startsClean) continue;
    const best = Math.max.apply(null, pts.map((p) => p.psnr));
    if (pts[0].psnr < best - 3) {
      problems.push(s.label + ' 起点 ' + pts[0].label + ' ' + pts[0].psnr.toFixed(1) +
        ' dB 远低于该序列最好值 ' + best.toFixed(1) + ' dB（顺序可能反了）');
    }
  }
  check(problems.length === 0, '有 clean 起点的序列按"由好到坏"排序', problems.join(' / '));
}

/*
 * --- the asymmetry finding must be visible in the DATA, not just in the prose
 *
 * The comparison is at MATCHED shift magnitudes, which is the whole point: at +100 Hz the positive side has
 * ALSO collapsed (6.5 dB), so "the worst of each series" does not separate them and an earlier version of
 * this check failed while the asymmetry was plainly there.
 *
 * AND THE CLAIM IS RANGE-LIMITED, because the measurement says so. The negative direction is worse at every
 * shared magnitude from 5 to 50 Hz, and the ordering REVERSES at 100 Hz (positive 6.5 dB vs negative
 * 7.9 dB). That reversal is reported rather than smoothed over: an assertion of the form "negative is always
 * worse" is false at this ladder's extreme, and writing it that way would put a claim in the test suite that
 * the data contradicts - which is exactly the failure mode this project keeps having to correct.
 */
{
  const pos = meta.series.find((s) => s.key === '频率偏移+');
  const neg = meta.series.find((s) => s.key === '频率偏移-');
  check(!!pos && !!neg, '正负频偏被拆成两条独立序列');
  if (pos && neg) {
    const mag = (label) => { const m = /([+-]?[\d.]+)\s*Hz/.exec(label); return m ? Math.abs(Number(m[1])) : null; };
    const posBy = {}, negBy = {};
    for (const p of pos.points) { const k = mag(p.label); if (k != null && k > 0) posBy[k] = p; }
    for (const p of neg.points) { const k = mag(p.label); if (k != null && k > 0) negBy[k] = p; }
    const shared = Object.keys(posBy).filter((k) => negBy[k] && posBy[k].psnr != null && negBy[k].psnr != null)
      .map(Number).sort((a, b) => a - b);
    check(shared.length > 0, '正负序列存在可比的同幅档位', shared.map((k) => k + 'Hz').join(', '));

    const REVERSAL_AT_HZ = 100;   // measured crossover; see the note above
    const bad = [], reversed = [];
    for (const k of shared) {
      const p = posBy[k].psnr, n = negBy[k].psnr;
      if (k >= REVERSAL_AT_HZ) { if (n < p) reversed.push(k + 'Hz'); }
      else if (n >= p) { bad.push(k + 'Hz: 正 ' + p.toFixed(1) + ' vs 负 ' + n.toFixed(1)); }
    }
    const inRange = shared.filter((k) => k < REVERSAL_AT_HZ);
    check(bad.length === 0, '±5–50 Hz 内同幅下负向始终不优于正向',
      bad.length ? bad.join(' / ') : inRange.map((k) =>
        k + 'Hz 正' + posBy[k].psnr.toFixed(1) + '/负' + negBy[k].psnr.toFixed(1)).join(' · '));
    if (shared.some((k) => k >= REVERSAL_AT_HZ)) {
      console.log('  注：≥' + REVERSAL_AT_HZ + ' Hz 处对称性反转（' + reversed.join(',') +
        '）—— 两侧都已崩溃，负向最差档反而不低于正向最差档，已在检查中按实测处理');
    }
  }
}

// --- the LEGEND must not sit on top of the plot
{
  /*
   * The first layout drew an 8-row legend inside the plot area, covering the top ~120 px - exactly where the
   * clean and mildly-degraded points live - so the legend hid the curves it described. The fix is a dedicated
   * column to the RIGHT of the plot, and this check enforces the geometric separation rather than trusting
   * that nobody moves it back.
   *
   * Legend swatches are the short <line> elements with stroke-width 2.6 (the series polylines are 2.2 and the
   * grid is 1).
   */
  const swatches = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="[\d.]+" stroke="(#[0-9a-f]{6})" stroke-width="2\.6"/g)]
    .map((m) => ({ x: Number(m[1]), x2: Number(m[3]), color: m[4] }));
  check(swatches.length === meta.series.length, '图例色块数与序列数一致',
    swatches.length + ' / ' + meta.series.length);

  // the plot area is the region the grid spans; infer its right edge from the horizontal grid lines
  const gridXs = [...svg.matchAll(/<line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)" y2="[\d.]+" stroke="#20262f"/g)];
  const plotRight = gridXs.length ? Math.max.apply(null, gridXs.map((m) => Number(m[2]))) : null;
  const plotLeft = gridXs.length ? Math.min.apply(null, gridXs.map((m) => Number(m[1]))) : null;
  check(plotRight != null, '能识别绘图区边界', plotLeft + '..' + plotRight);

  if (plotRight != null && swatches.length) {
    const minSwatchX = Math.min.apply(null, swatches.map((s) => s.x));
    check(minSwatchX > plotRight, '图例整体位于绘图区右侧（不遮挡曲线）',
      '图例最左 x=' + minSwatchX + '，绘图区右边界 x=' + plotRight);

    // every series polyline vertex must stay inside the plot area
    const outside = [];
    for (const m of svg.matchAll(/<polyline[^>]*points="([^"]+)"/g)) {
      for (const q of m[1].split(' ')) {
        const [x, y] = q.split(',').map(Number);
        if (x < plotLeft - 0.5 || x > plotRight + 0.5) outside.push(x);
      }
    }
    check(outside.length === 0, '所有曲线点都在绘图区内',
      outside.length ? '越界 x: ' + outside.slice(0, 4).join(',') : '');
  }
}

// --- the x labels must be HORIZONTAL (no rotated text at all)
{
  /*
   * The first layout rotated the x labels -45 degrees to fit ~15 long parameter strings under one axis. That
   * does not fit: the outermost labels ran off the canvas and neighbours crossed. Horizontal labels in a
   * column block cannot be clipped at an angle or overlap a neighbour, so any surviving rotate() is a
   * regression - EXCEPT the y-axis label, which is upright and has none.
   */
  const rotated = [...svg.matchAll(/transform="rotate\(([-\d.]+)/g)].map((m) => Number(m[1]));
  check(rotated.length === 0, '无旋转文字（刻度标签为水平排列）',
    rotated.length ? '仍有 ' + rotated.length + ' 处 rotate(' + rotated[0] + '°)' : '');
}

// --- every series' parameter values must actually be printed somewhere
{
  const missing = [];
  for (const s of meta.series) {
    for (const pt of s.points) {
      // the label list is emitted as "维度：值 · 值 · ..."; check the series name and one value survive
      if (svg.indexOf(escXml(pt.label)) < 0) missing.push(s.label + '/' + pt.label);
    }
  }
  check(missing.length === 0, '每个档位的参数值都标在图上',
    missing.length ? '缺: ' + missing.slice(0, 4).join(', ') : '全部 ' +
      meta.series.reduce((n, s) => n + s.points.length, 0) + ' 个档位');
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/*
 * --- Robot36 must not be PLOTTED
 *
 * The chart MENTIONS Robot36 in its footnote ("未画 Robot36 —— 无其逐维度实测数据"), so a plain text search
 * for the name now matches and reports a false failure. What must not exist is a Robot36 SERIES: a colour, a
 * polyline, a legend swatch. Grepping the caption text was the wrong test - it fails on a chart that says the
 * right thing.
 */
{
  const legendRows = [...svg.matchAll(/stroke="(#[0-9a-f]{6})" stroke-width="2\.6"/g)].map((m) => m[1]);
  const palette = new Set(legendRows);
  check(!/robot36/i.test(JSON.stringify(meta.series.map((s) => s.label))),
    'meta 中无 Robot36 序列');
  check(palette.size === meta.series.length, '每个序列有唯一颜色，无额外序列',
    palette.size + ' 种颜色 / ' + meta.series.length + ' 条序列');
  check(/未画 Robot36/.test(svg), '图上说明了为何不画 Robot36');
}

console.log('\n' + (failures === 0 ? 'CURVE SVG: ALL CHECKS PASSED' : 'CURVE SVG: ' + failures + ' FAILED'));
process.exitCode = failures === 0 ? 0 : 1;
