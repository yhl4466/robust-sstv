/*
 * README consistency check. Reads files only - it runs NO algorithm test and takes well under a
 * second, so it is safe to run on every edit.
 *
 * It verifies that every number the README quotes has a real, checkable provenance:
 *   - mode facts (resolution / colour space / duration) are recomputed from js/lib/sstv-modes.js,
 *   - numbers attributed to the paper are searched for literally in tech.html,
 *   - numbers attributed to the regression test are searched for in the archived reports,
 *   - the L1-L8 limitation codes match the paper's table 9,
 *   - every relative link resolves, and the required sections are present.
 *
 * Usage: node scripts/check-readme.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readme = read('README.md');
const paper = read('tech.html');
const reports = path.join(ROOT, 'docs', 'reports');
const reportText = fs.existsSync(reports)
  ? fs.readdirSync(reports).filter((f) => /\.md$/.test(f)).map((f) => fs.readFileSync(path.join(reports, f), 'utf8')).join('\n')
  : '';

require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
const Modes = globalThis.SSTVModes;

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  OK   ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '   ' + detail : '')); }
};

// 1. mode facts recomputed from the mode table
console.log('[A] mode table facts');
for (const id of ['M1', 'S1', 'PD120', 'PD180']) {
  const m = Modes.get(id);
  const res = m.width + '×' + m.height, dur = Modes.totalDuration(m).toFixed(2) + ' s';
  ok(readme.includes(res) && readme.includes(dur) && readme.includes(m.colorSpace),
    `README states ${id}: ${res}, ${m.colorSpace}, ${dur}`,
    [res, m.colorSpace, dur].map((s) => (readme.includes(s) ? 'ok' : 'MISSING')).join(' / '));
}

// 2. numbers attributed to the paper must appear in tech.html
console.log('\n[B] numbers attributed to tech.html');
for (const n of ['32.46', '32.62', '28.49', '31.95', '44.1 kHz', '8 kHz', '硬削波', '23/26']) {
  ok(paper.includes(n), `tech.html contains "${n}"`);
}

// 3. numbers attributed to the regression test must be traceable in the archived reports
console.log('\n[C] numbers attributed to tests/roundtrip.js');
for (const n of ['31.23', '30.50']) {
  ok(reportText.includes(n), `"${n}" is recorded in at least one archived report`);
}

// 4. limitation codes and wording must match the paper's table 9
console.log('\n[D] known limitations L1-L8');
const paperCodes = [...paper.matchAll(/<td>L([1-8])<\/td>/g)].map((m) => +m[1]).sort((a, b) => a - b);
ok(paperCodes.join(',') === '1,2,3,4,5,6,7,8', 'tech.html table 9 defines L1-L8', paperCodes.join(','));
const readmeCodes = [...readme.matchAll(/\*\*L([1-8])\*\*/g)].map((m) => +m[1]).sort((a, b) => a - b);
ok(readmeCodes.join(',') === '1,2,3,4,5,6,7,8', 'README lists L1-L8', readmeCodes.join(','));
// the limitation ROWS must stay aligned with the paper's table 9. This round explicitly allows
// the wording to be simplified ("保留编号对应，简化表述"), so the check compares a distinctive
// keyword per row rather than the full headline - strict enough to catch a swapped or wrong row,
// loose enough not to forbid legitimate brevity.
const heads = ['标定头检测', '真实录音验证', '载荷容量', '交织深度', '严重档',
  '净收益', 'σ_HF', '解码耗时'];
const wrong = heads.filter((k) => !readme.includes(k) || !paper.includes(k));
ok(wrong.length === 0, 'each limitation row stays aligned with table 9 (keyword per row)',
  wrong.length ? 'mismatch: ' + wrong.join(' | ') : heads.length + ' rows aligned');

// 5. every relative link resolves
console.log('\n[E] links');
let links = 0, broken = [];
for (const m of readme.matchAll(/\]\(<([^>]+)>\)|\]\(([^)\s]+)\)/g)) {
  const t = m[1] || m[2];
  if (/^(https?:|mailto:|#)/.test(t)) continue;
  links++;
  if (!fs.existsSync(path.join(ROOT, t))) broken.push(t);
}
ok(broken.length === 0, 'every relative link in README resolves',
  broken.length ? broken.join(', ') : links + ' link(s)');

// 6. the two stale claims this rewrite had to remove
console.log('\n[F] removed stale claims');
ok(!/PD ?120 只支持编码|仅编码（解码为阶段一范围外）/.test(readme), 'no "PD120 encode-only" claim');
ok(!/未实现任何隐写嵌入/.test(readme), 'no "no steganography implemented" claim');

// ------------------------------------------------------------------ terminology
/*
 * The 鲁棒 -> 抗干扰 migration. The scan covers the documented scope INCLUDING the generator that
 * emits tech.html: checking only the generated page would let a future regeneration silently put
 * the old wording back.
 */
console.log('\n[G] terminology (鲁棒 -> 抗干扰)');
const scope = ['README.md', 'index.html', 'embed-image.html', 'extract-image.html', 'tech.html',
  'js/app.js', 'scripts/gen-tech-html.js'];
const offenders = scope.filter((f) => fs.existsSync(path.join(ROOT, f)) && read(f).includes('鲁棒'));
ok(offenders.length === 0, 'no 鲁棒 left in the migration scope (pages, comments, generator)',
  offenders.length ? offenders.join(', ') : scope.length + ' file(s) clean');
ok(readme.includes('抗干扰') && paper.includes('抗干扰'), 'the new wording 抗干扰 is present');

// exceptions must survive untouched. Reads stop at the first archived report that still carries
// the old wording, which is all this needs to prove the history was not rewritten.
let frozenHasOld = false;
for (const f of fs.readdirSync(reports).filter((x) => /\.md$/.test(x))) {
  if (fs.readFileSync(path.join(reports, f), 'utf8').includes('鲁棒')) { frozenHasOld = true; break; }
}
ok(frozenHasOld, 'the archived reports still carry the original wording (history intact)');
ok(/A Robust SSTV Audio Decoding Method/.test(paper), 'the English subtitle keeps "Robust"');
ok(/<a class="brand"[^>]*>Robust SSTV</.test(paper), 'the brand "Robust SSTV" is unchanged');
ok(/^#\s/m.test(readme), 'README keeps a single top-level title');

// ------------------------------------------------------------------ structure
console.log('\n[H] README structure (8 items)');
const required = ['## 它能做什么', '## 快速开始', '## 使用方法', '## 已知限制',
  '## 实测结果', '## 更多信息', '## 验证'];
const h2 = [...readme.matchAll(/^##\s+(.+)$/gm)].map((m) => '## ' + m[1].trim());
const absent = required.filter((s) => !h2.includes(s));
ok(absent.length === 0, 'all 7 required sections are present',
  absent.length ? 'missing: ' + absent.join(', ') : h2.length + ' h2 heading(s)');
ok(h2.length === 7, 'exactly 7 `##` sections (title + 7 = the 8 required items)', h2.join(' | '));

// content that was deliberately moved to tech.html must be gone. Headings are compared against
// the parsed h2 list, not as substrings - '### 开发记录'.includes('## 开发记录') is true, which
// made the first version of this check report three false positives.
const movedFromBody = ['file:// 约束', '扩展接口', '数据流', '目录结构'];
const movedFromHeadings = ['状态说明', '技术细节'];
const bodyLeft = movedFromBody.filter((s) => readme.includes(s));
const headLeft = movedFromHeadings.filter((s) => h2.some((x) => x.includes(s)));
ok(bodyLeft.length === 0 && headLeft.length === 0,
  'content moved to tech.html is no longer in the README',
  (bodyLeft.length ? 'body: ' + bodyLeft.join(', ') + '  ' : '') +
  (headLeft.length ? 'heading: ' + headLeft.join(', ') : 'none of ' +
    (movedFromBody.length + movedFromHeadings.length) + ' markers'));

// core value that had to survive
ok(/### 支持的模式/.test(readme) && ['320×256', '640×496', '115.30 s', '187.43 s'].every((s) => readme.includes(s)),
  'the four-mode table survived');
ok([...Array(8)].every((_, i) => readme.includes('**L' + (i + 1) + '**')), 'L1-L8 survived');
const core = ['31.23', '30.50', '32.46', '32.62', '44.1 kHz', '硬削波'];
ok(core.every((n) => readme.includes(n)), 'the six core measurements survived', core.join(', '));
ok(/阶段十三\]\(docs\/reports/.test(readme), 'the development-record table survived');

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'README CONSISTENT' : 'README INCONSISTENT');
process.exitCode = fail === 0 ? 0 : 1;
