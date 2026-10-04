/*
 * Are the report's table and figure numbers unique and gapless?
 *
 * The chapter added in phase 52 (5.9) inserted a table, and the phase-51 tables in 6.4/6.5 already occupied
 * 11 and 12 - so a naive insert produced two tables numbered 11 and another pair numbered 13, while the
 * narrative referred to "表 13" for a caption that said "11". Nothing about that is invalid HTML; it is only
 * visible by counting, which is what this does.
 *
 * Usage: node tests/check-report-numbering.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'tech.html'), 'utf8');

let failures = 0;
function check(ok, label, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

console.log('=== tech.html 图表编号检查 ===\n');

/*
 * Captions are matched from the markup the generator actually emits, not from an assumed shape:
 *   tables   <table id="3"><caption>表 3 信道退化类型与实测样本数</caption>
 *   figures  <figure ...><figcaption class="caption" id="figcap14">图 14：...</figcaption>
 *
 * Figures are counted by their CAPTION, not by their <title>. Two earlier versions got this wrong in
 * opposite directions: the first looked for <figcaption> (the element exists, but the report puts the class
 * "caption" on it and the regex demanded it immediately after the tag), and the second looked for
 * <title>图 N, which exists only for the inline-SVG figures. The raster comparison figure is an <img>, so
 * counting titles reported a dangling reference to a figure that was present all along.
 */
const tableCaps = [...html.matchAll(/<caption>表\s*(\d+)/g)].map((m) => Number(m[1]));
const figs = [...new Set([...html.matchAll(/<figcaption[^>]*>图\s*(\d+)/g)].map((m) => Number(m[1])))];

console.log('  表标题编号: ' + tableCaps.join(', '));
console.log('  图标题编号: ' + figs.join(', '));

function uniqGapfree(nums, what) {
  const u = [...new Set(nums)].sort((a, b) => a - b);
  const dup = nums.filter((v, i) => nums.indexOf(v) !== i);
  check(dup.length === 0, what + '编号无重复', dup.length ? '重复: ' + [...new Set(dup)].join(',') : '');
  if (u.length) {
    const missing = [];
    for (let i = u[0]; i <= u[u.length - 1]; i++) if (u.indexOf(i) < 0) missing.push(i);
    check(missing.length === 0, what + '编号连续', missing.length ? '缺: ' + missing.join(',') : u[0] + '..' + u[u.length - 1]);
  }
}

uniqGapfree(tableCaps, '表');
uniqGapfree(figs, '图');

/*
 * Narrative references must point at numbers that exist. This catches the specific failure of inserting a
 * table without updating the prose that names it.
 */
{
  const refs = [...new Set([...html.matchAll(/表\s*(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const have = new Set(tableCaps);
  const dangling = refs.filter((n) => !have.has(n));
  check(dangling.length === 0, '正文引用的表号都存在',
    dangling.length ? '悬空引用: ' + dangling.join(',') : refs.length + ' 个引用');
}
{
  const refs = [...new Set([...html.matchAll(/图\s*(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const have = new Set(figs);
  const dangling = refs.filter((n) => !have.has(n));
  check(dangling.length === 0, '正文引用的图号都存在',
    dangling.length ? '悬空引用: ' + dangling.join(',') : refs.length + ' 个引用');
}

console.log('\n' + (failures === 0 ? 'REPORT NUMBERING: ALL CHECKS PASSED' : 'REPORT NUMBERING: ' + failures + ' FAILED'));
process.exitCode = failures === 0 ? 0 : 1;
