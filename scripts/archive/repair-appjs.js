/*
 * One-off repair for js/app.js (ASCII-only source on purpose).
 *
 * WHAT HAPPENED: a PowerShell Get-Content/Set-Content round trip decoded this UTF-8 file as
 * GBK and re-encoded it. That (a) turned every Chinese string into mojibake and (b) LOST
 * one byte wherever a multi-byte sequence did not fit GBK. The lost byte frequently
 * swallowed the closing quote of a string literal, so the file no longer parsed.
 *
 * The mojibake itself was already reversed by an encoding round trip (GBK bytes -> UTF-8,
 * done from the js/app.js.corrupt backup). This script repairs the remaining byte-loss
 * holes.
 *
 * TWO FAILED HEURISTICS, recorded so they are not repeated:
 *   1. "always insert a full stop": the lost characters are many different ones
 *      (shu, zhen, lv, tu, comma), so most replacements were wrong and produced text like
 *      'actual codeword count。/ depth'.
 *   2. "decide by line-local quote parity": the parity count is corrupted by quotes inside
 *      call arguments - $('encStatus') contributes two quotes before the hole - so the
 *      decision was wrong on almost every line.
 *
 * WHAT WORKS: look at the character immediately after the hole.
 *   - a quote          -> the closing quote SURVIVED, so the hole was the string's last
 *                         character: emit '?' and let the existing quote close it.
 *   - after skipping spaces, a terminator/operator ( ) ] } , ; + : or end of line
 *                      -> the lost byte swallowed the closing quote: emit "?'".
 *   - anything else    -> the hole is mid-string: emit '?'.
 *
 * Usage: node scripts/repair-appjs.js --apply
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'js', 'app.js');
const APPLY = process.argv.includes('--apply');
let src = fs.readFileSync(FILE, 'utf8');

const HOLE = '\uFFFD?';
let total = 0;
for (let i = 0; i < src.length; i++) if (src.startsWith(HOLE, i)) total++;
console.log(`byte-loss holes present: ${total}`);

let fixed = 0, quotesRestored = 0, midString = 0;
for (;;) {
  const idx = src.indexOf('\uFFFD');
  if (idx < 0) break;
  const after = src.slice(idx + 2);            // skip U+FFFD and its trailing '?'
  const next = after[0] || '';
  const rest = after.replace(/^[ \t]+/, '');
  const terminates = rest === '' || rest[0] === '\n' || /^[)\]}.,;+:]/.test(rest);

  let repl;
  if (next === "'" || next === '"') { repl = '?'; midString++; }
  else if (terminates) { repl = "?'"; quotesRestored++; }
  else { repl = '?'; midString++; }

  src = src.slice(0, idx) + repl + after;
  fixed++;
}
console.log(`holes replaced: ${fixed}  (mid-string: ${midString}, closing quote restored: ${quotesRestored})`);

try {
  new vm.Script(src);
  console.log('\napp.js parses cleanly after repair');
  if (APPLY) { fs.writeFileSync(FILE, src, 'utf8'); console.log('written to js/app.js'); }
  else console.log('(dry run - pass --apply to write)');
} catch (e) {
  console.log('\nSTILL BROKEN: ' + e.message);
  const lines = src.split('\n');
  const m = /<anonymous>:(\d+)/.exec(e.stack || '');
  if (m) {
    const n = parseInt(m[1], 10);
    for (let i = Math.max(0, n - 3); i < n + 2; i++) console.log(`  L${i + 1}: ${(lines[i] || '').slice(0, 150)}`);
  }
  process.exitCode = 1;
}
