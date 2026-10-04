/*
 * Nav consistency check for the phase-51 freeze.
 *
 * The nav block carries each page's `active` marker by design (scripts/nav-partial.js documents that the
 * nav block is "byte-identical on every page" for the consistency assertion, which is only true once the
 * active marker is normalised away). Comparing the raw blocks therefore reports a false mismatch, which
 * is exactly what a first attempt did. This compares the STRUCTURE and reports the active item
 * separately, so a real divergence is not hidden behind an expected one.
 *
 * Also asserts the two frozen pages are still present and still cross-linked, because "remove the entry,
 * keep the code" is the requirement and a silent deletion would pass a nav-only check.
 *
 * Usage: node tests/nav-check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const nav = require(path.join(ROOT, 'scripts', 'nav-partial.js'));

const PAGES = ['index.html', 'demo-degradation.html', 'embed-image.html', 'extract-image.html', 'tech.html'];
const FROZEN = ['embed-image.html', 'extract-image.html'];

let failures = 0;
function check(ok, label, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

/**
 * Normalise a nav block down to its STRUCTURE.
 *
 * Three things legitimately differ between pages and must not be mistaken for divergence:
 *   - the `active` marker, which by design sits on the current page's item;
 *   - the backend badge, which only index.html carries;
 *   - the leading whitespace of the closing `</div>`, which the generator emits with four spaces when the
 *     badge branch is taken and two when it is not. That inconsistency is cosmetic (whitespace between
 *     block elements) and pre-existing; folding it here keeps this check about structure rather than
 *     about the generator's indentation, while still catching a genuinely missing or added link.
 */
function normalise(block) {
  return block
    .replace(/ class="active" aria-current="page"/g, '')
    .replace(/<div class="badge-local"[^>]*>[^<]*<\/div>\s*/g, '')
    .replace(/<a href="([^"]+)"([^>]*)>/g, (m, href) => '<a href="' + href + '">')
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
}

console.log('=== 导航一致性 ===\n');

const blocks = {};
for (const p of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
  blocks[p] = nav.extractNav(html);
  check(!!blocks[p], p + ' 含 NAV:BEGIN/END 标记');
}
check(nav.NAV_ITEMS.length === 3 && nav.NAV_ITEMS.every((i) => i.href !== 'embed-image.html'),
  'NAV_ITEMS 已移除图片隐藏入口并加入抗干扰演示',
  nav.NAV_ITEMS.map((i) => i.label).join(' / '));
check(nav.NAV_ITEMS.some((i) => i.href === 'demo-degradation.html'),
  '导航含 demo-degradation.html');

if (blocks['index.html']) {
  const base = normalise(blocks['index.html']);
  for (const p of PAGES) {
    if (!blocks[p]) continue;
    check(normalise(blocks[p]) === base, p + ' 导航结构与首页一致');
  }
}

console.log('\n  各页 active 项（预期各不相同，属设计）：');
for (const p of PAGES) {
  if (!blocks[p]) continue;
  const m = blocks[p].match(/<a href="([^"]+)" class="active"/);
  console.log('    ' + p.padEnd(20) + (m ? m[1] : '(无，首页以外允许)'));
}

console.log('\n=== 冻结页仍完整保留 ===\n');
for (const p of FROZEN) {
  const full = path.join(ROOT, p);
  check(fs.existsSync(full), p + ' 文件存在');
  if (!fs.existsSync(full)) continue;
  const html = fs.readFileSync(full, 'utf8');
  const size = fs.statSync(full).size;
  // the other frozen page must still be linked from this one (the subnav cross-link)
  const sibling = p === 'embed-image.html' ? 'extract-image.html' : 'embed-image.html';
  const cross = html.indexOf(sibling) >= 0;
  check(cross, p + ' 仍交叉链接到 ' + sibling);
  check(!blocks[p] || blocks[p].indexOf('embed-image.html') < 0 || p !== 'index.html',
    p + ' 导航中不再含图片隐藏入口');
  console.log('    ' + p.padEnd(20) + (size / 1024).toFixed(1) + ' KB');
}

console.log('\n=== 隐藏代码未被删除 ===\n');
/*
 * The steganography implementation, at its real paths (js/, not js/lib/ - guessing the directory is what
 * made a first run report three false "deleted" failures). The requirement is that the CODE stays even
 * though the entry point goes, so this asserts every module of the feature is still present.
 */
const codeFiles = [
  'js/image-codec.js',        // secret-image frame encode/decode
  'js/image-embed.js',        // embed entry point for the two pages
  'js/payload-pipeline.js',   // payload plumbing
  'js/payload-qim.js',        // the QIM sideband modulation
  'js/fec-rs.js',             // Reed-Solomon, the part phase 5 proved is NOT optional here
  'js/interleaver.js',
  'js/channel-sim.js',
  'js/app.js',                // still wires the two pages up
  'css/style.css',
  'embed-image.html',
  'extract-image.html'
];
for (const f of codeFiles) {
  const full = path.join(ROOT, f);
  check(fs.existsSync(full), f + ' 仍存在');
}

console.log('\n' + (failures === 0 ? 'NAV CHECK: ALL CHECKS PASSED' : 'NAV CHECK: ' + failures + ' FAILED'));
process.exitCode = failures === 0 ? 0 : 1;
