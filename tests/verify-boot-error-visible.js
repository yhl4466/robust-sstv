/*
 * Verify that a boot() failure is VISIBLE to the user.
 *
 * Why this test exists: the reported symptom (解码精度 empty, 本版本支持的模式 showing "—") is what an unwrapped
 * boot() produces when any init step throws, and it is indistinguishable from "the feature was deleted". The
 * fix is a catch that reports into #decStatus. A fix like that is worthless unless it actually fires, so this
 * INJECTS a fault into a copy of app.js, loads the page, and asserts that the error surfaces on screen.
 *
 * It restores app.js from an in-memory copy in a finally block, and re-checks the file's syntax afterwards, so
 * a crash mid-test cannot leave a broken source file behind.
 *
 * Usage: node tests/verify-boot-error-visible.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchBrowser } = require('./lib/cdp-harness.js');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'js', 'app.js');
const PORT = 9391;

const original = fs.readFileSync(APP, 'utf8');
let failures = 0;
function check(ok, label, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

(async function main() {
  console.log('=== boot() 失败是否对用户可见 ===\n');
  let b = null;
  try {
    // inject a fault immediately BEFORE initQuality, i.e. the step that fills the empty-looking controls
    const marker = '      initModes();';
    if (original.indexOf(marker) < 0) throw new Error('找不到注入点（boot() 内的 initModes 调用）');
    const broken = original.replace(marker, marker + '\n      throw new Error("注入的测试故障");');
    fs.writeFileSync(APP, broken, 'utf8');

    const url = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
    b = await launchBrowser({ url: url, port: PORT, width: 1280, height: 900, profileTag: 'bootfail' });
    await b.sleep(600);

    const r = await b.evaluate(`(function(){
      var s=document.getElementById('decStatus');
      var q=document.getElementById('qualitySelect');
      return { status: s? s.textContent.trim() : '(无 decStatus)',
               statusClass: s? s.className : '',
               qualityOptions: q? q.options.length : -1 };
    })()`);

    console.log('  decStatus: 「' + r.status.slice(0, 110) + '」');
    check(r.qualityOptions === 0, '故障下「解码精度」确实为空（复现了用户所见）',
      r.qualityOptions + ' 个选项');
    check(/初始化失败/.test(r.status), '错误已显示在可见状态区', '');
    check(/注入的测试故障/.test(r.status), '错误信息含具体原因', '');
    check(/\berr\b/.test(r.statusClass), '状态区使用错误样式', r.statusClass);
    check(b.consoleErrors.length > 0 || /boot\(\) 失败/.test(r.status),
      '控制台或页面至少有一处记录', '');
  } catch (e) {
    console.error('测试失败: ' + (e && e.stack || e));
    failures++;
  } finally {
    if (b) await b.close();
    fs.writeFileSync(APP, original, 'utf8');
    try {
      execFileSync('node', ['--check', APP], { stdio: 'pipe' });
      console.log('\n  app.js 已恢复且语法正确 ✓');
    } catch (e) {
      console.error('\n  !! app.js 恢复后语法检查失败，请手动修复');
      failures++;
    }
  }
  console.log('\n' + (failures === 0 ? 'BOOT ERROR VISIBILITY: ALL CHECKS PASSED'
    : 'BOOT ERROR VISIBILITY: ' + failures + ' FAILED'));
  process.exitCode = failures === 0 ? 0 : 1;
})();
