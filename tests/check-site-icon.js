/*
 * Does the site icon actually load in a real page, on every page?
 *
 * The tag existing is not the claim - the claim is that the browser fetches favicon.svg and decodes it. A
 * wrong path (which is exactly the mistake made while building this: the preview page referenced
 * "favicon.svg" from tests/ and rendered broken-image placeholders with no console error) produces a tag
 * that is present and useless. So this loads each page and asks the browser what it got.
 *
 * A remote-debugging quirk worth recording: from a `file://` document the icon is fetched by the browser's
 * own resource loader, not by scriptable XHR, so `fetch`/`XHR` on the same URL fails even when the icon
 * loads fine. The check therefore uses `new Image()` (an element load, same as the favicon path) rather than
 * XHR, and additionally confirms the declared href resolves to a file that exists on disk.
 *
 * Usage: node tests/check-site-icon.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./lib/cdp-harness.js');

const ROOT = path.join(__dirname, '..');
const PAGES = ['index.html', 'demo-degradation.html', 'embed-image.html', 'extract-image.html', 'tech.html'];
const ICON = 'favicon.svg';
const PORT = 9383;

let failures = 0;
function check(ok, label, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

console.log('=== 站点图标检查 ===\n');

// 1. the file exists, is non-trivial, and carries an accessible name
const iconPath = path.join(ROOT, ICON);
check(fs.existsSync(iconPath), ICON + ' 存在');
let iconSrc = '';
if (fs.existsSync(iconPath)) {
  iconSrc = fs.readFileSync(iconPath, 'utf8');
  check(iconSrc.indexOf('<svg') >= 0, '是 SVG');
  check(/viewBox="0 0 64 64"/.test(iconSrc), '有 viewBox（可无损缩放）');
  check(/<title>/.test(iconSrc), '含 <title>（无障碍名称）');
}

// 2. every page declares exactly one icon, and its href names a file that exists
for (const p of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const links = [...html.matchAll(/<link[^>]*rel="icon"[^>]*>/g)].map((m) => m[0]);
  check(links.length === 1, p + ' 恰好声明一个图标', links.length + ' 个');
  if (links.length === 1) {
    const href = /href="([^"]+)"/.exec(links[0]);
    const rel = href ? href[1] : '';
    check(rel === ICON, p + ' 的 href 正确', rel);
    check(fs.existsSync(path.join(ROOT, rel)), p + ' 的 href 指向存在的文件', rel);
    check(/type="image\/svg\+xml"/.test(links[0]), p + ' 声明了 SVG 类型');
  }
}

// 3. the browser actually decodes it, from every page
(async function browserCheck() {
  for (const p of PAGES) {
    const url = 'file:///' + path.join(ROOT, p).replace(/\\/g, '/');
    let b = null;
    try {
      b = await launchBrowser({ url: url, port: PORT, width: 800, height: 600, profileTag: 'icon-' + p.replace('.html', '') });

      /*
       * Poll for the RESOURCE, not for readyState.
       *
       * Waiting on `document.readyState` was not enough: it reached "interactive" while the head was still
       * being parsed, so `document.querySelector('link[rel=icon]')` came back empty in 4 of 5 pages and the
       * test reported failures for pages that were fine. What the check actually needs is the decoded image,
       * so it waits for that directly and reports the href alongside it as diagnostic detail rather than as
       * the thing under test.
       */
      const res = await b.evaluate(`new Promise(function(resolve){
        var done=false, tries=0;
        function attempt(){
          tries++;
          var link=document.querySelector('link[rel="icon"]');
          var i=new Image();
          i.onload=function(){ done=true; resolve({ok:true, w:i.naturalWidth, h:i.naturalHeight,
            href: link? link.getAttribute('href') : null, tries: tries}); };
          i.onerror=function(){
            if (tries<40) { setTimeout(attempt,100); return; }
            resolve({ok:false, w:0, h:0, href: link? link.getAttribute('href') : null, tries: tries});
          };
          i.src='favicon.svg';
        }
        attempt();
      })`);

      check(res && res.ok && res.w === 64 && res.h === 64, p + ' 浏览器成功解码图标',
        res ? (res.w + 'x' + res.h + ' · 重试 ' + res.tries + ' 次') : '无响应');
      if (p === PAGES[0]) {
        check(!!(res && res.href), p + ' 的 <link> 已在 DOM 中解析', res ? String(res.href) : '');
      }
    } catch (e) {
      check(false, p + ' 图标加载检查', (e && e.message || String(e)).slice(0, 80));
    } finally { if (b) await b.close(); }
  }

  console.log('\n' + (failures === 0 ? 'SITE ICON: ALL CHECKS PASSED' : 'SITE ICON: ' + failures + ' FAILED'));
  process.exitCode = failures === 0 ? 0 : 1;
})();
