/*
 * Test manifest generator.
 *
 * Runs every suite in tests/ and records, for each one, the exit code, the verdict line and
 * the wall-clock duration, then writes tests/test-manifest.json. The exit code is treated as
 * the primary verdict because every verdict suite in this project sets process.exitCode
 * explicitly; the printed line is captured only so the manifest is readable.
 *
 * Usage:
 *   node scripts/list-tests.js            run everything and write the manifest
 *   node scripts/list-tests.js --no-run   enumerate only (fast; no results recorded)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const SELF = path.basename(__filename);
const RUN = !process.argv.includes('--no-run');

/*
 * kind: 'verdict' suites gate the project; 'diagnostic' and 'benchmark' scripts print numbers
 * and have no pass/fail semantics, so their exit code is recorded but not treated as a gate.
 */
const SUITES = [
  { file: 'verify-signal.js', kind: 'verdict', covers: '编码器逐样本频率与行结构' },
  { file: 'roundtrip.js', kind: 'verdict', covers: '四模式编码往返与图象保真度' },
  { file: 'channel-sim.test.js', kind: 'verdict', covers: '信道模拟器五类退化' },
  { file: 'fec-rs.test.js', kind: 'verdict', covers: '里德-所罗门编解码与三重验证' },
  { file: 'interleaver.test.js', kind: 'verdict', covers: '交织往返与突发分散' },
  { file: 'image-codec.test.js', kind: 'verdict', covers: '秘密图编解码与图片帧' },
  { file: 'pd-modes.test.js', kind: 'verdict', covers: 'PD120 与 PD180 往返' },
  { file: 'tech-html.test.js', kind: 'verdict', covers: '技术报告结构、几何与文风' },
  { file: 'e2e-full.js', kind: 'verdict', covers: '四模式完整链路（图→音频→信道→图）' },
  { file: 'browser-e2e.js', kind: 'verdict', covers: '浏览器端到端流程' },
  { file: 'image-pages-e2e.js', kind: 'verdict', covers: '图片隐藏两个页面端到端' },
  { file: 'diagnose-align.js', kind: 'diagnostic', covers: '同步对齐诊断' },
  { file: 'perf.js', kind: 'benchmark', covers: '性能基准' }
];

const VERDICT_RE = /(VERIFIED|ALL CHECKS PASSED|PASSED|FAILED|\d+ passed, \d+ failed)/;
const results = [];
let gateFail = 0;

console.log(`test manifest: ${SUITES.length} entries, run=${RUN}\n`);
for (const s of SUITES) {
  const full = path.join(TESTS, s.file);
  const entry = { file: 'tests/' + s.file, kind: s.kind, covers: s.covers, exists: fs.existsSync(full) };
  if (!entry.exists) {
    entry.status = 'missing';
    entry.exitCode = null;
    if (s.kind === 'verdict') gateFail++;
    console.log(`  MISSING  ${s.file}`);
    results.push(entry);
    continue;
  }
  if (!RUN) {
    entry.status = 'not-run';
    results.push(entry);
    console.log(`  listed   ${s.file.padEnd(26)} ${s.kind.padEnd(10)} ${s.covers}`);
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [full], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  entry.ms = Date.now() - t0;
  entry.exitCode = r.status;
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split(/\r?\n/).filter((l) => VERDICT_RE.test(l));
  entry.verdict = lines.length ? lines[lines.length - 1].trim() : null;
  /*
   * Store the individual failing checks, not just the summary line. Without this a failure is
   * undiagnosable from the manifest alone, which matters because one suite (browser-e2e.js) is
   * load-sensitive and has been observed to fail inside a long sequential run while passing
   * standalone.
   */
  entry.failures = out.split(/\r?\n/).filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim()).slice(0, 20);
  if (!entry.failures.length) delete entry.failures;
  entry.status = r.status === 0 ? 'pass' : 'fail';
  if (r.error) { entry.status = 'error'; entry.error = String(r.error.message || r.error); }
  if (entry.status !== 'pass' && s.kind === 'verdict') gateFail++;
  const mark = entry.status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`  ${mark.padEnd(5)} ${s.file.padEnd(26)} ${String(entry.ms).padStart(6)} ms  ${entry.verdict || ''}`);
  results.push(entry);
}

const verdicts = results.filter((r) => r.kind === 'verdict');
const manifest = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  ran: RUN,
  totals: {
    entries: results.length,
    verdictSuites: verdicts.length,
    verdictPass: verdicts.filter((r) => r.status === 'pass').length,
    verdictFail: verdicts.filter((r) => r.status === 'fail' || r.status === 'missing' || r.status === 'error').length,
    diagnostic: results.filter((r) => r.kind !== 'verdict').length
  },
  results
};
fs.writeFileSync(path.join(TESTS, 'test-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.totals.verdictPass}/${manifest.totals.verdictSuites} verdict suites pass`);
console.log('-> tests/test-manifest.json');
process.exitCode = gateFail === 0 ? 0 : 1;
