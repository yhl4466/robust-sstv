/*
 * Content checks for the tech report's anti-interference chapter (§5.9).
 *
 * WHY: the chapter is generated, so a regeneration can drop a figure, a table or the whole section without
 * any error - the file would still be valid HTML and simply be missing its evidence. These assertions pin
 * the chapter's structure so that cannot happen silently.
 *
 * Usage: node tests/check-tech-section59.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'tech.html'), 'utf8');
const buf = fs.readFileSync(path.join(ROOT, 'tech.html'));

let failures = 0;
function check(ok, label, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

console.log('=== tech.html §5.9 检查 ===\n');

check(html.indexOf('5.9 抗干扰能力实测（六维退化矩阵）') >= 0, '存在 §5.9 标题');
check(html.indexOf('5.9 抗干扰能力实测') >= 0 &&
  html.indexOf('5.8 消融实验') < html.indexOf('5.9 抗干扰能力实测'), '§5.9 位于 §5.8 之后');

// the curve chart must be inlined as SVG, not referenced
check(/aria-label="六种退化下的解码 PSNR 曲线"/.test(html), '曲线图以 SVG 内联');
check((html.match(/<polyline/g) || []).length >= 6, '曲线图含至少 6 条折线',
  String((html.match(/<polyline/g) || []).length) + ' 条');

// the comparison figure must be inlined as a data URI (the report is self-contained)
const dataUri = /src="data:image\/png;base64,([A-Za-z0-9+/=]{5000,})"/.exec(html);
check(!!dataUri, '对比图以 base64 内联', dataUri ? ('约 ' + Math.round(dataUri[1].length * 3 / 4 / 1024) + ' KB') : '');

check(html.indexOf('11 六类退化的临界参数') >= 0, '存在表 11（本章新增，后续表格顺延）');
check(html.indexOf('图 14 为六类退化的解码 PSNR 曲线') >= 0, '正文引用图 14');
check(html.indexOf('图 15 把六类退化的解码结果') >= 0, '正文引用图 15');
/*
 * The exact phrase is "本文未在图中绘制 Robot36 ...", so the search term must be the one that is actually
 * present. An earlier check looked for "未绘制" (no space) and reported a failure for a paragraph that was
 * there all along - a reminder that a failing check is a claim about the artifact AND about the check.
 */
check(html.indexOf('Robot36') >= 0 && html.indexOf('原因是没有它们的逐维度实测数据') >= 0,
  '说明了为何不画 Robot36');

/*
 * The number check is scoped to §5.9 ONLY.
 *
 * Slicing from the §5.9 heading to the END of the document pulled in §6.4 and §6.5, whose numbers come from
 * other artifacts (the band-guard sweep, the acoustic measurements), so the check reported 20 "unknown"
 * values that were all legitimately sourced elsewhere. Scoping to the chapter is what makes this assertion
 * mean "this chapter does not quote a number the matrix lacks".
 *
 * VALUES ARE CLASSIFIED BY SIGN, not matched by a bare pattern. A signed value ("+0.27 dB") is a MARGIN
 * relative to the 25 dB criterion, not a PSNR, so it is checked against 25 + value instead of against the
 * matrix. Without that distinction the margin column added to table 11 made this check report four
 * unsourced PSNRs (0.27, 0.13, 1.80, 0.44) that were all correctly derived - a false failure caused by the
 * checker not knowing about the new column.
 *
 * IT ALSO DEPENDS ON THE MATRIX BEING COMPLETE. A partial run (`--only`) used to write its one row over the
 * canonical results file, and this check would then report the chapter's numbers as unsourced - true about a
 * broken input, but ambiguous. The row count is asserted first so the failure names the real cause.
 */
{
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'degradation-matrix-results.json'), 'utf8'));
  const rows = results.rows || [];
  check(rows.length >= 40, '矩阵结果文件完整（≥40 行，非部分运行覆盖）',
    rows.length + ' 行' + (rows.length < 40 ? ' —— 请重跑 node tests/degradation-matrix.js --control pattern' : ''));

  const knownPsnr = new Set();
  const knownMargin = new Set();
  for (const r of rows) {
    if (r.psnr == null) continue;
    knownPsnr.add(r.psnr.toFixed(2));
    // a margin is what a two-decimal PSNR can be said to clear 25 dB by
    knownMargin.add(((r.psnr - 25 >= 0 ? '+' : '') + (r.psnr - 25).toFixed(2)));
  }

  const start = html.indexOf('5.9 抗干扰能力实测');
  const end = html.indexOf('<h2>6 讨论</h2>');
  check(start >= 0 && end > start, '能定位 §5.9 的起止');
  const section = html.slice(start, end);

  const plain = [...section.matchAll(/(?<![+\-−])(\d+\.\d\d) dB/g)].map((m) => m[1]);
  const signed = [...section.matchAll(/([+\-−]\d+\.\d\d) dB/g)]
    .map((m) => m[1].replace('−', '-'));

  check(plain.length > 0, '§5.9 中含 PSNR 数值', String(plain.length) + ' 处');
  const badPlain = plain.filter((v) => !knownPsnr.has(v));
  check(badPlain.length === 0, '§5.9 引用的 PSNR 都能在矩阵结果中查到',
    badPlain.length ? '查不到: ' + [...new Set(badPlain)].join(', ') : plain.length + ' 处');

  if (signed.length) {
    const badMargin = signed.filter((v) => !knownMargin.has(v));
    check(badMargin.length === 0, '§5.9 引用的余量都等于某个实测 PSNR 减 25 dB',
      badMargin.length ? '不符: ' + [...new Set(badMargin)].join(', ') : signed.length + ' 处');
  }
}

check((html.match(/\uFFFD/g) || []).length === 0, '无编码损坏字符');
check(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), '无 BOM');

console.log('\n' + (failures === 0 ? 'TECH §5.9: ALL CHECKS PASSED' : 'TECH §5.9: ' + failures + ' FAILED'));
process.exitCode = failures === 0 ? 0 : 1;
