/*
 * Drive demo-degradation.html in a real browser over CDP and screenshot the result.
 *
 * WHY A BROWSER TEST AND NOT JUST THE NODE LADDER CHECK
 *   tests/verify-demo-ladder.js proves the degradation MATH is right, in Node, by extracting the page's own
 *   source. It cannot prove the PAGE works: the inlined base64 has to decode, the canvas has to draw, the
 *   tabs and slider have to be wired, and the metrics have to render. Those are exactly the parts a
 *   generator can get wrong while every number in the ladder stays correct.
 *
 * So this opens the page from file:// (the origin the project promises to support), waits for the clean
 * decode the page does on load, then clicks a real degradation step and waits for the re-decode, reading
 * the on-page metrics back out. It fails if the page reports a failure the ladder does not, or if the
 * verdict text and the numbers disagree.
 *
 * Screenshots are written to tests/diag-quality/demo-*.png.
 *
 * Usage: node tests/demo-page-cdp.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const PORT = 9361;
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!EDGE) { console.log('no chromium browser found'); process.exitCode = 1; return; }

  const pageUrl = fileUrl(path.join(ROOT, 'demo-degradation.html'));
  const profile = path.join(os.tmpdir(), 'sstv_demo_' + Date.now());
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--allow-file-access-from-files',
    '--window-size=1280,2000', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, pageUrl], { stdio: 'ignore' });

  let ws = null;
  let failures = 0;
  const check = (ok, label, detail) => {
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
  };

  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = list.find((t) => t.type === 'page' && t.url.indexOf('demo-degradation') >= 0)
              || list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('no devtools endpoint');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('websocket failed')));
    });
    let id = 0; const pending = new Map();
    const consoleErrors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        consoleErrors.push((d.exception && d.exception.description) || d.text || 'exception');
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      if (m.id != null && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
    const send = (method, params) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 300000);
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    };
    const shoot = async (name, clip) => {
      const r = await send('Page.captureScreenshot', { format: 'png', clip: clip, captureBeyondViewport: true });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
      console.log('  -> tests/diag-quality/' + name);
    };

    await send('Runtime.enable');
    await send('Page.enable');

    console.log('=== demo-degradation.html（file://）===\n');

    // ---- 1. page boots and finishes its own clean decode on load
    let status = null;
    for (let i = 0; i < 120; i++) {
      status = await evaluate('document.getElementById("status").textContent').catch(() => null);
      if (status && (status.indexOf('就绪') >= 0 || status.indexOf('失败') >= 0)) break;
      await sleep(500);
    }
    check(!!status && status.indexOf('就绪') >= 0, '页面加载后自行完成 clean 解码', status);
    check(consoleErrors.length === 0, '无 JS 异常', consoleErrors.length ? consoleErrors[0].slice(0, 120) : '');

    const cleanInfo = await evaluate(`(function(){
      var c=document.getElementById('cvClean');
      var px=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      var nonBlack=0; for(var i=0;i<px.length;i+=4){ if(px[i]||px[i+1]||px[i+2]) nonBlack++; }
      return { w:c.width, h:c.height, nonBlack:nonBlack, total:c.width*c.height };
    })()`);
    check(cleanInfo.nonBlack > cleanInfo.total * 0.5, '原始图画布已绘制',
      cleanInfo.w + 'x' + cleanInfo.h + ' · 非黑像素 ' + cleanInfo.nonBlack + '/' + cleanInfo.total);

    const tabs = await evaluate('document.querySelectorAll(".demo-tab").length');
    check(tabs === 6, '六种退化类型按钮', String(tabs));
    const ticks = await evaluate('document.querySelectorAll(".demo-tick").length');
    check(ticks === 6, '强度档位刻度', String(ticks));

    await shoot('demo-01-loaded.png');

    // ---- 2. run a mid-severity step of a type with a clear slope
    const run = async (typeIdx, stepIdx, what) => {
      await evaluate(`(function(){
        document.querySelectorAll('.demo-tab')[${typeIdx}].click();
        var s=document.getElementById('strength');
        s.value='${stepIdx}';
        s.dispatchEvent(new Event('input'));
        return true;
      })()`);
      await sleep(200);
      await evaluate('document.getElementById("runBtn").click(); true');
      let st = null;
      for (let i = 0; i < 160; i++) {
        await sleep(500);
        st = await evaluate('document.getElementById("status").textContent').catch(() => null);
        if (st && st.indexOf('完成') >= 0) break;
        if (st && st.indexOf('出错') >= 0) break;
      }
      const m = await evaluate(`(function(){
        var g=function(i){var e=document.getElementById(i);return e?e.textContent:null;};
        return { status:g('status'), verdict:g('verdict'), psnr:g('mPsnr'), lines:g('mLines'),
                 period:g('mPeriod'), jitter:g('mJitter'), chroma:g('mChroma'),
                 degMs:g('mDegMs'), decMs:g('mDecMs'), cap:g('degCaption') };
      })()`);
      console.log('  [' + what + '] ' + (m.status || '').replace(/\s+/g, ' ').slice(0, 100));
      console.log('      PSNR ' + m.psnr + ' · 行 ' + m.lines + ' · 周期 ' + m.period +
        ' · 抖动 ' + m.jitter + ' · 色度 ' + m.chroma);
      console.log('      退化 ' + m.degMs + ' · 解码 ' + m.decMs);
      return m;
    };

    const r1 = await run(0, 4, '加性噪声 · 10 dB');
    check(/完成/.test(r1.status || ''), 'AWGN 10 dB 运行完成', r1.status);
    check(/可用|不可用/.test(r1.verdict || ''), '给出可用性判定', r1.verdict);
    const p1 = parseFloat(r1.psnr);
    check(isFinite(p1), 'PSNR 已显示', r1.psnr);
    check(/^\d+(\.\d+)? ms$/.test(r1.degMs || ''), '退化耗时已显示（毫秒级）', r1.degMs);
    check(/^\d+(\.\d+)? ms$/.test(r1.decMs || ''), '解码耗时已显示', r1.decMs);

    // verdict must agree with the 25 dB rule the page states
    const expectUsable = p1 >= 25;
    check((r1.verdict || '').indexOf(expectUsable ? '可用' : '不可用') >= 0,
      '判定与 25 dB 判据一致', 'PSNR ' + p1 + ' → 期望' + (expectUsable ? '可用' : '不可用'));
    await shoot('demo-02-awgn.png');

    // ---- 3. a second type, to prove the type switch actually changes the channel
    const r2 = await run(2, 5, '频率失谐 · −50 Hz');
    const p2 = parseFloat(r2.psnr);
    check(/完成/.test(r2.status || ''), '频偏 −50 Hz 运行完成', r2.status);
    check(p2 !== p1, '换类型后结果确实变化', 'AWGN 10 dB ' + p1 + ' dB vs −50 Hz ' + p2 + ' dB');
    await shoot('demo-03-freq.png');

    // ---- 4. reset clears the result panel
    await evaluate('document.getElementById("resetBtn").click(); true');
    await sleep(300);
    const resetVisible = await evaluate('!document.getElementById("metrics").hidden');
    check(resetVisible === false, '重置隐藏指标面板');
    await shoot('demo-04-reset.png');

    // ---- 5. close-ups for the report
    await shoot('demo-05-controls.png', await evaluate(`(function(){
      var r=document.querySelector('.demo-card').getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};
    })()`));

    check(consoleErrors.length === 0, '全程无 JS 异常',
      consoleErrors.length ? consoleErrors.slice(0, 2).join(' | ').slice(0, 200) : '');

    console.log('\n' + (failures === 0
      ? 'DEMO PAGE CDP: ALL CHECKS PASSED'
      : 'DEMO PAGE CDP: ' + failures + ' FAILED'));
  } catch (e) {
    console.error('demo cdp failed: ' + (e && e.stack || e));
    failures++;
  } finally {
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    try { child.kill(); } catch (e) { /* ignore */ }
  }
  process.exitCode = failures === 0 ? 0 : 1;
})();
