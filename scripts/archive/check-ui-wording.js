/*
 * UI wording check: no development-stage labels left in the user-facing layer, and the valid
 * document references are still intact. Reads files only - no algorithm test is run.
 *
 * "阶段" also occurs as an ordinary Chinese word (标定阶段 / 失败阶段 / 两阶段检测) and inside the
 * filenames of real documents, so a bare scan would be useless: lines carrying a reference to
 * 阶段一技术方案.md are exempted, and the scanned set is limited to the UI layer.
 *
 * Usage: node scripts/check-ui-wording.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['index.html', 'js/app.js', 'js/lib/sstv-channel.js', 'js/channel-sim.js'];
const EXEMPT = /阶段一技术方案\.md/;      // a real file at the workspace root
let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  OK   ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '   ' + detail : '')); }
};

console.log('[A] no development-stage labels in the UI layer');
let hits = 0;
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.log(`  !! missing ${rel}`); fail++; continue; }
  fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
    if (!line.includes('阶段') || EXEMPT.test(line)) return;
    hits++;
    console.log(`  HIT  ${rel}:${i + 1}  ${line.trim().slice(0, 74)}`);
  });
}
ok(hits === 0, `${FILES.length} UI files are free of 阶段 labels`, hits + ' remaining');

console.log('\n[B] the false statement is gone');
const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
ok(!app.includes('阶段一未实现任何嵌入'), 'the "no embedding implemented" claim is gone');
ok(app.includes('embed-image.html'), 'the panel now points at the implemented feature');
ok(app.includes('identity</code> 嵌入器为直通'), 'the analytic-estimate caveat is preserved');

console.log('\n[C] valid document references are untouched');
const still = ['js/lib/sstv-modes.js', 'js/lib/sstv-decode.js']
  .filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('阶段一技术方案.md'));
ok(still.length === 2, '阶段一技术方案.md references survive in sstv-modes.js and sstv-decode.js',
  still.join(', '));
ok(fs.existsSync(path.join(ROOT, '..', '阶段一技术方案.md')), 'the referenced document actually exists');

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'UI WORDING CLEAN' : 'UI WORDING FAILED');
process.exitCode = fail === 0 ? 0 : 1;
