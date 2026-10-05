/*
 * Does boot() reference any element that index.html no longer contains?
 *
 * THE FAILURE MODE: both 解码精度 and 本版本支持的模式 are written ONLY by initQuality(), which boot() calls
 * second. If anything in boot() throws, the controls stay at their HTML defaults - the select renders as an
 * empty box and the readout keeps its placeholder "—". That is exactly the reported screenshot, and it
 * produces NO console error visible to the user because boot() is not wrapped.
 *
 * initModes() runs first and itself calls $(...) on several elements, so a single missing id would explain
 * everything. This checks every id the boot path resolves, by reading the ids out of the source (so the list
 * cannot go stale) and testing each against the served HTML.
 *
 * Usage: node tests/diagnose-boot-ids.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ids present in the document: getElementById targets and id="" attributes */
const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

/* every $( '...' ) / getElementById('...') literal in app.js */
const usedIds = new Map();
for (const m of appSrc.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)) {
  const id = m[1] || m[2];
  if (!usedIds.has(id)) usedIds.set(id, []);
  usedIds.get(id).push(appSrc.slice(0, m.index).split('\n').length);
}

/*
 * A missing id is only a defect if the lookup is UNGUARDED.
 *
 * The first version of this check reported #extPanel and #extRefresh as boot-breaking, because it only asked
 * "does the id exist". Both are looked up and then tested before use (`if (panel) panel.innerHTML = ...`), so
 * they are deliberately-absent elements, not bugs - and a checker that flags them trains the reader to ignore
 * its output. The guard is detected by looking at the same line and the next one for a truthiness test on the
 * variable the lookup was assigned to, or for the lookup being used inside an `if`.
 */
function isGuarded(id, lineNos) {
  const lines = appSrc.split('\n');
  for (const ln of lineNos) {
    const here = lines[ln - 1] || '';
    const next = lines[ln] || '';
    // pattern A: var x = $('id'); if (x) ...
    const assign = /(?:var\s+)?([A-Za-z_$][\w$]*)\s*=\s*\$\(/.exec(here);
    if (assign) {
      const v = assign[1];
      const re = new RegExp('if\\s*\\(\\s*!' + v + '\\s*\\)|if\\s*\\(\\s*' + v + '\\s*\\)|' + v + '\\s*&&|' + v + '\\s*\\?');
      if (re.test(next) || re.test(here) || re.test(lines[ln] || '') || re.test(lines[ln + 1] || '')) return true;
    }
    // pattern B: if ($('id')) ...
    if (/if\s*\([^)]*\$\('([^']+)'\)/.test(here) || /if\s*\([^)]*\$\('([^']+)'\)/.test(next)) return true;
  }
  return false;
}

console.log('=== index.html 元素 id 覆盖检查 ===');
console.log('文档中的 id: ' + htmlIds.size + ' 个 · app.js 引用的 id: ' + usedIds.size + ' 个\n');

const missing = [];
const guardedMissing = [];
for (const [id, lines] of usedIds) {
  if (htmlIds.has(id)) continue;
  (isGuarded(id, lines) ? guardedMissing : missing).push({ id: id, lines: lines });
}

if (!missing.length) {
  console.log('  OK   app.js 引用的每个 id 都已存在，或在使用前有判空');
} else {
  for (const m of missing) {
    console.log('  FAIL  #' + m.id + '  不存在且未判空（app.js 第 ' + m.lines.join(', ') + ' 行）');
  }
}
if (guardedMissing.length) {
  console.log('\n  以下 id 不存在，但查找处有判空，属于有意为之（不计为缺陷）:');
  for (const m of guardedMissing) console.log('    #' + m.id + '  （app.js 第 ' + m.lines.join(', ') + ' 行）');
}

/*
 * And the reverse: ids the page defines that nothing scripts against. Those are the dead controls left behind
 * by edits - the extPanel family was removed this session, and a stale reference to it is precisely the kind
 * of thing that makes boot() throw.
 */
const orphans = [...htmlIds].filter((id) => !usedIds.has(id) && !/^(nav|svg|fig|tab)/i.test(id));
if (orphans.length) {
  console.log('\n  页面定义但脚本从不引用的 id（' + orphans.length + ' 个，仅供人工核对）:');
  console.log('    ' + orphans.join(', '));
}

/* the boot sequence itself, in order */
console.log('\n=== boot() 调用顺序 ===');
{
  const start = appSrc.indexOf('function boot()');
  // up to the catch/finally that ends the guarded body, so the reported order is the real one
  const body = appSrc.slice(start, appSrc.indexOf('} catch (e)', start));
  // indent-agnostic: the body is inside a try{}, so the leading whitespace is not a fixed width
  const calls = [...body.matchAll(/^\s{2,}([A-Za-z_$][\w$]*\(\))/gm)].map((m) => m[1]);
  console.log('  ' + (calls.length ? calls.join(' → ') : '（未解析出调用）'));
}

console.log('\n' + (missing.length ? '结果：发现 ' + missing.length + ' 个缺失 id（会导致 boot 中断）'
  : '结果：boot 路径无缺失 id'));
process.exitCode = missing.length ? 1 : 0;
