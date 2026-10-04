/*
 * Screenshot the tech report's anti-interference chapter (§5.9) from a real browser.
 *
 * The chapter is generated from three artifacts and inlines a 469 KB raster plus a 14 KB SVG, so a
 * structurally valid document can still render as a blank box, a broken-image icon, or an SVG whose labels
 * fall outside the canvas. Only a screenshot and a DOM measurement show that.
 *
 * Uses tests/lib/cdp-harness.js, which fixes two defects these tests used to share: orphaned browser
 * processes (child.kill() does not kill renderers, and the leftovers then made the NEXT run attach to a stale
 * instance and render old content) and ports that were assumed free without checking.
 *
 * Usage: node tests/tech-section-cdp.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./lib/cdp-harness.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const PORT = 9373;

(async function main() {
  let failures = 0;
  const check = (ok, label, detail) => {
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
  };

  const url = 'file:///' + path.join(ROOT, 'tech.html').replace(/\\/g, '/');
  const b = await launchBrowser({ url: url, port: PORT, width: 1280, height: 1500, profileTag: 'tech' });
  try {
    /*
     * WAIT FOR THE DOM, do not sleep a fixed amount.
     *
     * A flat 4 s sleep made this test flaky: on one run the document had not finished parsing when the first
     * evaluate() ran and every figure check reported a failure, then the identical command passed immediately
     * afterwards. The file is 775 KB with a 469 KB inlined raster, so its parse time varies. Polling for the
     * figure count to reach the file's count is both faster in the common case and not time-dependent.
     */
    const fileFigCount = (fs.readFileSync(path.join(ROOT, 'tech.html'), 'utf8')
      .match(/<figure class="figure"/g) || []).length;

    let domCount = 0;
    for (let i = 0; i < 60; i++) {
      domCount = await b.evaluate('document.querySelectorAll("figure.figure").length').catch(() => 0);
      if (domCount >= fileFigCount) break;
      await b.sleep(250);
    }
    // one more frame for images/SVG layout to settle after the DOM is complete
    await b.sleep(400);
    console.log('=== tech.html §5.9 浏览器渲染 ===\n');

    const info = await b.evaluate(`(function(){
      var figs=[].slice.call(document.querySelectorAll('figure.figure'));
      return { total: figs.length, figures: figs.map(function(f){
        var img=f.querySelector('img'), svg=f.querySelector('svg'), cap=f.querySelector('figcaption');
        var r=f.getBoundingClientRect();
        return { id:f.id, w:Math.round(r.width), h:Math.round(r.height),
                 hasImg:!!img, imgComplete: img? img.complete : null,
                 imgW: img? img.naturalWidth : 0,
                 hasSvg:!!svg, svgH: svg? Math.round(svg.getBoundingClientRect().height):0,
                 cap: cap? cap.textContent.slice(0,26):'' };
      })};
    })()`);

    check(info.total === fileFigCount, 'DOM 图数量与文件一致（未加载到旧页面）',
      'DOM ' + info.total + ' / 文件 ' + fileFigCount);
    check(info.total === 15, '报告中 15 个图元素', String(info.total));

    const f14 = info.figures.find((f) => f.id === 'fig14');
    const f15 = info.figures.find((f) => f.id === 'fig15');
    check(!!f14, '存在图 14');
    check(!!f15, '存在图 15');
    if (f14) {
      check(f14.hasSvg && f14.svgH > 300, '图 14 曲线 SVG 已渲染', 'svg 高 ' + f14.svgH + 'px');
      console.log('      ' + f14.cap);
    }
    if (f15) {
      check(f15.hasImg && f15.imgComplete && f15.imgW > 0, '图 15 对比图已加载', 'naturalWidth ' + f15.imgW);
      console.log('      ' + f15.cap);
    }
    check(info.figures.every((f) => f.w > 0 && f.h > 0), '所有图元素尺寸非零');
    check(b.consoleErrors.length === 0, '无 JS 异常',
      b.consoleErrors.length ? b.consoleErrors[0].slice(0, 120) : '');

    // scroll the chapter into view and capture it
    await b.evaluate(`(function(){
      var h=[].slice.call(document.querySelectorAll('h3')).filter(function(x){return x.textContent.indexOf('5.9')===0;})[0];
      if(h) h.scrollIntoView();
      return true;
    })()`);
    await b.sleep(600);
    const clip = await b.evaluate(`(function(){
      var h=[].slice.call(document.querySelectorAll('h3')).filter(function(x){return x.textContent.indexOf('5.9')===0;})[0];
      var r=h.getBoundingClientRect();
      return { x:0, y:r.top+window.scrollY, width:1240, height:1700, scale:1 };
    })()`);
    await b.shoot(path.join(OUT, 'tech-section59.png'), clip);
    console.log('  -> tests/diag-quality/tech-section59.png');

    // the chart on its own, at full width, for close inspection
    const chartClip = await b.evaluate(`(function(){
      var f=document.getElementById('fig14');
      var r=f.getBoundingClientRect();
      return { x:r.x, y:r.top+window.scrollY, width:r.width, height:r.height, scale:1 };
    })()`);
    await b.shoot(path.join(OUT, 'degradation-curves.png'), chartClip);
    console.log('  -> tests/diag-quality/degradation-curves.png');

    console.log('\n' + (failures === 0 ? 'TECH §5.9 RENDER: ALL CHECKS PASSED' : 'TECH §5.9 RENDER: ' + failures + ' FAILED'));
  } catch (e) {
    console.error('tech cdp failed: ' + (e && e.stack || e));
    failures++;
  } finally {
    b.close();
  }
  process.exitCode = failures === 0 ? 0 : 1;
})();
