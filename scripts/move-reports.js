/*
 * Move the eleven stage reports into docs/reports/ and repair the references the move breaks.
 *
 * Two classes of reference exist and they need different treatment:
 *
 *   1. REFERENCES TO THE REPORTS ("阶段X报告.md"). A full-project scan found only two, and neither
 *      is a path used for navigation: 阶段四报告.md mentions 阶段三报告 in prose, and
 *      阶段八报告.md lists file names in backticks while describing an earlier rename. They are
 *      updated to be correct rather than merely left alone.
 *
 *   2. RELATIVE LINKS INSIDE THE REPORTS. These are the real hazard: 21 markdown links across
 *      three reports point at the project root (js/, scripts/, css/, index.html). Moving a file
 *      down one level silently breaks every one of them, so each gains a ../../ prefix.
 *
 * Idempotent: a link that already starts with ../ is left alone, and a report already in place is
 * not moved twice.
 *
 * Usage: node scripts/move-reports.js [--apply]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'docs', 'reports');
const APPLY = process.argv.includes('--apply');

const NAMES = fs.readdirSync(ROOT).filter((f) => /^阶段.+报告\.md$/.test(f)).sort();
const ALREADY = fs.existsSync(DEST)
  ? fs.readdirSync(DEST).filter((f) => /^阶段.+报告\.md$/.test(f)).sort()
  : [];

console.log(`reports at the project root : ${NAMES.length}`);
console.log(`reports already in docs/     : ${ALREADY.length}`);
if (NAMES.length && ALREADY.length) {
  console.log('  (both present - a previous partial run? the root copies win and overwrite)');
}

/** Rewrite relative markdown links so they still resolve from docs/reports/. */
function rewriteLinks(text) {
  const changed = [];
  const out = text.replace(/\]\(<([^>]+)>\)|\]\(([^)\s]+)\)/g, (whole, angled, plain) => {
    const target = angled || plain;
    if (/^(https?:|mailto:|data:|#)/.test(target)) return whole;
    if (target.startsWith('../')) return whole;                 // already relative to a parent
    const fixed = '../../' + target.replace(/^\.\//, '');
    changed.push(target + '  ->  ' + fixed);
    return angled ? `](<${fixed}>)` : `](${fixed})`;
  });
  return { out, changed };
}

/** Prose mentions of other reports, which are not paths but should still be accurate. */
function rewriteProse(text, file) {
  const notes = [];
  let out = text;
  if (file === '阶段四报告.md') {
    const from = '仅保留报告 §6 推导（阶段三报告）';
    const to = '仅保留报告 §6 推导（[阶段三报告](阶段三报告.md)）';
    if (out.includes(from)) { out = out.replace(from, to); notes.push('阶段三报告 prose mention -> sibling link'); }
  }
  if (file === '阶段八报告.md') {
    const from = '**应用目录内（11 个文件、18 处）**';
    const to = '**应用目录内（11 个文件、18 处；这些报告在阶段十二已迁至 `docs/reports/`）**';
    if (out.includes(from)) { out = out.replace(from, to); notes.push('rename-counts note points at the new location'); }
  }
  return { out, notes };
}

let moved = 0, links = 0, prose = 0;
if (APPLY) fs.mkdirSync(DEST, { recursive: true });

for (const name of NAMES) {
  const src = path.join(ROOT, name);
  const dst = path.join(DEST, name);
  let text = fs.readFileSync(src, 'utf8');
  const l = rewriteLinks(text);
  const p = rewriteProse(l.out, name);
  const final = p.out;

  console.log(`\n${name}`);
  console.log(`  links rewritten: ${l.changed.length}${l.changed.length ? '' : ' (none)'}`);
  for (const c of l.changed) console.log('    ' + c);
  for (const n of p.notes) console.log('  prose: ' + n);

  if (APPLY) {
    fs.writeFileSync(dst, final, 'utf8');
    // only remove the original once the copy is verifiably on disk and complete
    const written = fs.statSync(dst).size;
    if (written < final.length) throw new Error('short write for ' + name);
    if (dst !== src && fs.existsSync(src)) fs.unlinkSync(src);
  }
  moved++; links += l.changed.length; prose += p.notes.length;
}

console.log(`\n${moved} report(s) processed, ${links} link(s) rewritten, ${prose} prose note(s)`);
console.log(APPLY ? `-> ${path.relative(ROOT, DEST)}/` : 'dry run - pass --apply to write');

// ---------------------------------------------------------------- link integrity (always runs)
/*
 * The durable half of this task: every relative markdown link in README.md and in every archived
 * report must resolve to a file that exists. A move is a one-off, but this check keeps working,
 * and it is what actually proves the reference repair rather than assuming it.
 */
function checkLinks() {
  const targets = [path.join(ROOT, 'README.md')];
  if (fs.existsSync(DEST)) {
    for (const f of fs.readdirSync(DEST)) {
      if (/\.md$/i.test(f)) targets.push(path.join(DEST, f));
    }
  }
  let checked = 0, broken = 0;
  for (const file of targets) {
    const dir = path.dirname(file);
    const s = fs.readFileSync(file, 'utf8');
    for (const m of s.matchAll(/\]\(<([^>]+)>\)|\]\(([^)\s]+)\)/g)) {
      const t = m[1] || m[2];
      if (/^(https?:|mailto:|data:|#)/.test(t)) continue;
      checked++;
      const resolved = path.resolve(dir, decodeURI(t));
      if (!fs.existsSync(resolved)) {
        broken++;
        console.log(`  BROKEN  ${path.relative(ROOT, file)} -> ${t}`);
      }
    }
  }
  console.log(`\nlink integrity: ${checked} relative link(s) checked across ${targets.length} file(s), ${broken} broken`);
  return broken;
}
const brokenLinks = checkLinks();
if (brokenLinks) process.exitCode = 1;

// ---------------------------------------------------------------- post-move verification
if (APPLY) {
  console.log('\n=== verification ===');
  const leftovers = fs.readdirSync(ROOT).filter((f) => /^阶段.+报告\.md$/.test(f));
  console.log(`reports still at the root : ${leftovers.length}${leftovers.length ? '  ' + leftovers.join(', ') : ' (clean)'}`);
  const inDest = fs.readdirSync(DEST).filter((f) => /^阶段.+报告\.md$/.test(f));
  console.log(`reports in docs/reports/  : ${inDest.length}`);
  // no relative link inside the moved reports may still point at the project root.
  // A target containing "/" and not starting with "../" is root-relative and therefore broken;
  // a bare file name is a SIBLING of the report and resolves fine (that is how the 阶段三报告
  // link added by this script works).
  let bad = 0;
  for (const f of inDest) {
    const s = fs.readFileSync(path.join(DEST, f), 'utf8');
    for (const m of s.matchAll(/\]\(<([^>]+)>\)|\]\(([^)\s]+)\)/g)) {
      const t = m[1] || m[2];
      if (/^(https?:|mailto:|data:|#|\.\.\/)/.test(t)) continue;
      if (!t.includes('/')) continue;              // sibling file in docs/reports/
      bad++;
      console.log(`  !! ${f}: link still root-relative -> ${t}`);
    }
  }
  console.log(`root-relative links left : ${bad}`);
}
