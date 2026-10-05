/*
 * Why are 解码精度 / 本版本支持的模式 empty on index.html?
 *
 * The two controls are filled by initQuality(), called from boot(). boot() runs its steps in sequence, so a
 * throw anywhere earlier leaves later controls unpopulated - and the visible symptom is "the dropdown is
 * gone" rather than an error. This reports the page's own console errors and the state of every control
 * boot() touches, in the order boot() touches them, so the first broken step is identifiable.
 *
 * It also reproduces the user's exact path: open the page faced with an .m4a.mp3 and let it load.
 *
 * Usage: node tests/diagnose-index-controls.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./lib/cdp-harness.js');

const ROOT = path.join(__dirname, '..');
const PORT = 9385;
const AUDIO = path.join(ROOT, 'tests', 'fixtures', 'acoustic-real-m1.m4a.mp3');

/* Populated by boot(), in the order boot() calls them. */
const PROBES = [
  ['initModes', 'modeSelect', 'options'],
  ['initQuality', 'qualitySelect', 'options'],
  ['自检面板 renderExtensions', 'extPanel', 'exists'],
  ['载荷面板 initPayloadPanel', 'blockSelect', 'options'],
  ['decodeStatus 容器', 'decStatus', 'exists']
];

(async function main() {
  const url = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
  const b = await launchBrowser({ url: url, port: PORT, width: 1280, height: 1000, profileTag: 'idxctl' });
  try {
    console.log('=== index.html 控制项自检 ===\n');

    const state = await b.evaluate(`(function(){
      var out={};
      [['modeSelect'],['qualitySelect'],['supportedReadout'],['blockSelect'],['deltaSelect'],
       ['fecSelect'],['ilSelect'],['extPanel'],['decStatus'],['backendBadge']].forEach(function(p){
        var e=document.getElementById(p[0]);
        if(!e){ out[p[0]]={missing:true}; return; }
        out[p[0]]={ missing:false,
          tag:e.tagName,
          optionCount: e.tagName==='SELECT' ? e.options.length : null,
          text: (e.textContent||'').trim().slice(0,70) };
      });
      out.__qualityHTML = (document.getElementById('qualitySelect')||{}).outerHTML || '(无该元素)';
      return out;
    })()`);

    for (const [step, id, kind] of PROBES) {
      const s = state[id];
      if (!s || s.missing) { console.log('  FAIL  ' + step.padEnd(24) + ' 元素 #' + id + ' 不存在'); continue; }
      const ok = kind === 'options' ? s.optionCount > 0 : true;
      console.log('  ' + (ok ? 'OK  ' : 'FAIL') + '  ' + step.padEnd(24) + '#' + id +
        (s.optionCount != null ? ' 选项 ' + s.optionCount : '') +
        (s.text ? '  「' + s.text + '」' : ''));
    }

    console.log('\n  qualitySelect 的实际 HTML:');
    console.log('    ' + state.__qualityHTML.replace(/\s+/g, ' ').slice(0, 200));

    console.log('\n页面控制台错误: ' + (b.consoleErrors.length ? '' : '（无）'));
    for (const e of b.consoleErrors.slice(0, 5)) console.log('  · ' + String(e).split('\n')[0].slice(0, 180));

    // now reproduce the user's path: load the mp3
    if (fs.existsSync(AUDIO)) {
      console.log('\n--- 载入 ' + path.basename(AUDIO) + ' ---');
      const fh = await b.send('Runtime.evaluate', { expression: 'document.getElementById("wavInput")' });
      await b.send('DOM.setFileInputFiles', { files: [AUDIO], objectId: fh.result.objectId });
      await b.evaluate('document.getElementById("wavInput").dispatchEvent(new Event("change")); true');
      let st = null;
      for (let i = 0; i < 120; i++) {
        await b.sleep(400);
        st = await b.evaluate('document.getElementById("decStatus").textContent').catch(() => null);
        if (st && st.length > 10) break;
      }
      console.log('  decStatus: ' + String(st || '').replace(/\s+/g, ' ').slice(0, 200));
      const after = await b.evaluate(`(function(){
        var q=document.getElementById('qualitySelect'), m=document.getElementById('supportedReadout');
        return { qOpts:q?q.options.length:-1, qVal:q?q.value:null, mText:m?m.textContent.slice(0,60):null,
                 decBtnDisabled: document.getElementById('decodeBtn').disabled };
      })()`);
      console.log('  载入后: 精度选项 ' + after.qOpts + ' · 选中 ' + after.qVal +
        ' · 模式栏「' + after.mText + '」 · 解码按钮 disabled=' + after.decBtnDisabled);
      console.log('  新增控制台错误: ' + (b.consoleErrors.length ? '' : '（无）'));
      for (const e of b.consoleErrors.slice(0, 5)) console.log('    · ' + String(e).split('\n')[0].slice(0, 180));
      await b.shoot(path.join(__dirname, 'diag-quality', 'index-controls.png'),
        { x: 0, y: 0, width: 1280, height: 1000, scale: 1 });
      console.log('  -> tests/diag-quality/index-controls.png');
    } else {
      console.log('\n（缺少测试音频 ' + AUDIO + '）');
    }
  } catch (e) {
    console.error('诊断失败: ' + (e && e.stack || e));
  } finally { await b.close(); }
  process.exitCode = 0;
})();
