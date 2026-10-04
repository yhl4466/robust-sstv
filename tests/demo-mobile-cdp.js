/*
 * Does demo-degradation.html still WORK at a narrow viewport?
 *
 * The demo is the one page in this project whose primary control is a slider, and it was only ever checked at
 * 1280 px. A 5-step slider plus a 6-tab bar plus a metric table is exactly the layout that degrades badly on a
 * phone, and unlike index.html this page has never been through the mobile screenshot suite.
 *
 * "Works" is checked structurally rather than visually: the tab bar and every tick must be present and
 * non-overlapping, the slider must be reachable, and a real degradation run must still complete and produce a
 * verdict. A layout that silently collapses (zero-height tabs, ticks stacked on each other) would still pass a
 * screenshot glance, so the geometry is measured.
 *
 * Usage: node tests/demo-mobile-cdp.js
 */
'use strict';
const path = require('path');
const { launchBrowser } = require('./lib/cdp-harness.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const PORT = 9375;

(async function main() {
  let failures = 0;
  const check = (ok, label, detail) => {
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
  };

  const url = 'file:///' + path.join(ROOT, 'demo-degradation.html').replace(/\\/g, '/');
  const b = await launchBrowser({ url: url, port: PORT, width: 390, height: 1100, profileTag: 'mobile' });
  try {
    // wait for the page's own clean decode to finish instead of sleeping
    let status = null;
    for (let i = 0; i < 120; i++) {
      status = await b.evaluate('document.getElementById("status").textContent').catch(() => null);
      if (status && (status.indexOf('就绪') >= 0 || status.indexOf('失败') >= 0)) break;
      await b.sleep(300);
    }
    console.log('=== demo-degradation.html @ 390 px ===\n');
    check(/就绪/.test(status || ''), '窄视口下页面仍能完成初始解码', (status || '').slice(0, 60));

    const geo = await b.evaluate(`(function(){
      var tabs=[].slice.call(document.querySelectorAll('.demo-tab'));
      var ticks=[].slice.call(document.querySelectorAll('.demo-tick'));
      var r=function(e){var b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};};
      var slider=document.getElementById('strength');
      var overlaps=0;
      for(var i=0;i<ticks.length;i++){
        for(var j=i+1;j<ticks.length;j++){
          var a=r(ticks[i]), c=r(ticks[j]);
          if(a.w>0&&c.w>0&&a.x<c.x+c.w&&c.x<a.x+a.w&&a.y<c.y+c.h&&c.y<a.y+a.h) overlaps++;
        }
      }
      return { tabs:tabs.length, ticks:ticks.length,
               tickOverlaps:overlaps,
               zeroTicks: ticks.filter(function(t){var q=r(t);return q.w<4||q.h<4;}).length,
               docW: document.documentElement.scrollWidth,
               winW: window.innerWidth,
               sliderW: r(slider).w, sliderVisible: r(slider).h>0,
               tabsRects: tabs.map(r) };
    })()`);

    check(geo.tabs === 6, '六个类型按钮都在', String(geo.tabs));
    check(geo.ticks === 6, '六个强度刻度都在', String(geo.ticks));
    check(geo.zeroTicks === 0, '没有塌缩成零尺寸的刻度', String(geo.zeroTicks) + ' 个');
    check(geo.tickOverlaps === 0, '刻度之间不重叠', String(geo.tickOverlaps) + ' 处重叠');
    check(geo.sliderVisible && geo.sliderW > 100, '强度滑块可见且够宽',
      geo.sliderW.toFixed(0) + ' px');
    /*
     * Horizontal overflow is the classic narrow-viewport failure: the page scrolls sideways and the slider's
     * right end lands off-screen. A few px of slack absorbs sub-pixel rounding.
     */
    check(geo.docW <= geo.winW + 4, '无横向溢出',
      '文档宽 ' + geo.docW + ' vs 视口 ' + geo.winW);

    // a real run must still complete at this width
    await b.evaluate(`(function(){
      document.querySelectorAll('.demo-tab')[0].click();
      var s=document.getElementById('strength'); s.value='3';
      s.dispatchEvent(new Event('input'));
      return true;
    })()`);
    await b.sleep(200);
    await b.evaluate('document.getElementById("runBtn").click(); true');
    let st = null;
    for (let i = 0; i < 160; i++) {
      await b.sleep(400);
      st = await b.evaluate('document.getElementById("status").textContent').catch(() => null);
      if (st && (st.indexOf('完成') >= 0 || st.indexOf('出错') >= 0)) break;
    }
    const m = await b.evaluate(`(function(){
      var g=function(i){var e=document.getElementById(i);return e?e.textContent:null;};
      return { verdict:g('verdict'), psnr:g('mPsnr'), deg:g('mDegMs'), dec:g('mDecMs') };
    })()`);
    check(/完成/.test(st || ''), '窄视口下退化演示可完成', (st || '').slice(0, 60));
    check(/可用|不可用/.test(m.verdict || ''), '给出判定与指标',
      (m.verdict || '').slice(0, 30) + ' · ' + m.psnr);
    console.log('      ' + m.psnr + ' · 退化 ' + m.deg + ' · 解码 ' + m.dec);
    check(b.consoleErrors.length === 0, '无 JS 异常',
      b.consoleErrors.length ? b.consoleErrors[0].slice(0, 100) : '');

    await b.shoot(path.join(OUT, 'demo-mobile.png'),
      { x: 0, y: 0, width: 390, height: 1100, scale: 1 });
    console.log('  -> tests/diag-quality/demo-mobile.png');

    console.log('\n' + (failures === 0 ? 'DEMO MOBILE: ALL CHECKS PASSED' : 'DEMO MOBILE: ' + failures + ' FAILED'));
  } catch (e) {
    console.error('demo mobile cdp failed: ' + (e && e.stack || e));
    failures++;
  } finally {
    b.close();
  }
  process.exitCode = failures === 0 ? 0 : 1;
})();
