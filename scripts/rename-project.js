/*
 * Project rename: sstv-web-hide -> robust-sstv, plus the user-facing brand text.
 *
 * Scope (measured before the rename, and the reason this is safe):
 *   the old name appeared 34 times, and ZERO of them were in js/ or css/ source - all 34 sat
 *   in prose (README + the seven phase reports), in HTML titles/headings, and in 24 absolute
 *   sample paths inside tests/fixtures/real/manifest.json. No identifier, CSS class or
 *   technical term is touched. The manifest was fixed separately by making
 *   build-real-portfolio.js emit repo-root-relative paths.
 *
 * Run with --apply to write; without it, only report.
 * Usage: node scripts/rename-project.js [--apply]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
/** Documents outside the application directory that also carry the project name. */
const EXTRA = [path.join(ROOT, '..', '阶段一技术方案.md')];

/*
 * ORDER MATTERS. The longest phrase is replaced first so that
 * '抗干扰 SSTV 图片隐藏' does not degrade into '抗干扰 鲁棒 SSTV 解码'.
 */
const RULES = [
  ['sstv-web-hide', 'robust-sstv'],
  ['SSTV web hide', 'Robust SSTV'],
  ['SSTV Web Hide', 'Robust SSTV'],
  ['抗干扰 SSTV 图片隐藏', '鲁棒 SSTV 解码'],
  ['SSTV 图片隐藏', '鲁棒 SSTV 解码']
];

/** Prose and presentation files only - source code is deliberately excluded. */
function targets() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(node_modules|\.research|downloads|repo-probe|pd-probe|out)$/.test(e.name)) continue;
        if (/fixtures$/.test(e.name)) continue;      // manifests are handled by their generator
        walk(p);
      } else if (/\.(md|html)$/i.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(ROOT);
  /*
   * One document lives OUTSIDE the application directory: the workspace-root design note.
   * It is included explicitly so the sweep is complete rather than merely convenient.
   */
  for (const extra of EXTRA) if (fs.existsSync(extra)) out.push(extra);
  return out;
}

const log = [];
let totalHits = 0, filesChanged = 0;
for (const file of targets()) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  const perFile = [];
  for (const [from, to] of RULES) {
    const n = after.split(from).length - 1;
    if (!n) continue;
    after = after.split(from).join(to);
    perFile.push({ from, to, count: n });
    totalHits += n;
  }
  if (!perFile.length) continue;
  filesChanged++;
  log.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), changes: perFile });
  console.log(`${path.relative(ROOT, file)}`);
  for (const c of perFile) console.log(`    ${c.count} x  "${c.from}" -> "${c.to}"`);
  if (APPLY) fs.writeFileSync(file, after, 'utf8');
}

console.log(`\n${filesChanged} file(s), ${totalHits} replacement(s)` + (APPLY ? ' - written' : ' (dry run)'));
if (APPLY) {
  fs.mkdirSync(path.join(ROOT, 'scripts', 'out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'scripts', 'out', 'rename-log.json'),
    JSON.stringify({ appliedAt: new Date().toISOString(), rules: RULES, filesChanged, totalHits, log }, null, 2));
  console.log('-> scripts/out/rename-log.json');
}
