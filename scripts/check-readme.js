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
// the limitation headlines must be the paper's wording, not a paraphrase
const heads = ['标定头检测在两重损伤叠加时失败', 'PD 族缺少真实录音验证', '边带载荷容量仅数百字节',
  '交织深度受码字数限制', '严重档超出适用范围', '频偏与时钟校正在真实录音上无净收益',
  'σ_HF 可被模糊压低', 'PD 解码耗时较高'];
const wrong = heads.filter((h) => !readme.includes(h) || !paper.includes(h));
ok(wrong.length === 0, 'each limitation headline appears verbatim in both files',
  wrong.length ? 'mismatch: ' + wrong.join(' | ') : heads.length + ' headlines match');

// 5. every relative link resolves
console.log('\n[E] links and structure');
let links = 0, broken = [];
for (const m of readme.matchAll(/\]\(<([^>]+)>\)|\]\(([^)\s]+)\)/g)) {
  const t = m[1] || m[2];
  if (/^(https?:|mailto:|#)/.test(t)) continue;
  links++;
  if (!fs.existsSync(path.join(ROOT, t))) broken.push(t);
}
ok(broken.length === 0, 'every relative link in README resolves',
  broken.length ? broken.join(', ') : links + ' link(s)');

const sections = ['## 状态说明', '## 功能', '## 快速开始', '## 使用方法', '## 已知限制',
  '## 实测结果', '## 技术细节', '## 开发记录', '## 验证', '## 开源协议', '## 贡献'];
const missing = sections.filter((s) => !readme.includes(s));
ok(missing.length === 0, `all ${sections.length + 1} required sections are present`,
  missing.length ? 'missing: ' + missing.join(', ') : 'title + ' + sections.length + ' sections');

// 6. the two stale claims this rewrite had to remove
console.log('\n[F] removed stale claims');
ok(!/PD ?120 只支持编码|仅编码（解码为阶段一范围外）/.test(readme), 'no "PD120 encode-only" claim');
ok(!/未实现任何隐写嵌入/.test(readme), 'no "no steganography implemented" claim');

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'README CONSISTENT' : 'README INCONSISTENT');
process.exitCode = fail === 0 ? 0 : 1;
