/*
 * Browser-driven visual verification of the phigros decode.
 *
 * Two things happen here, both through the REAL index.html UI (no parallel code path):
 *   1. Upload tests/diag-timing/phigros-48k-mono.wav into #wavInput, click 解码为图片, and
 *      screenshot the actual #decCanvas the user sees. This is the AC8/AC9 evidence.
 *   2. Render a side-by-side plate - our browser raster next to the user's Robot36 screenshot
 *      (cropped to its raster region, located by tests/locate-robot36-raster.js) - and screenshot
 *      that. This is the AC10 evidence.
 *
 * Usage: node tests/browser-visual.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const AUDIO = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
const REF = path.join(ROOT, '测试结果', 'robot36.jpg');
const RASTER_JSON = path.join(OUT, 'robot36-raster.json');
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

function fileUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!EDGE) { console.log('no chromium browser found'); process.exitCode = 1; return; }
  if (!fs.existsSync(AUDIO)) { console.log('missing ' + AUDIO); process.exitCode = 1; return; }

  const profile = path.join(os.tmpdir(), 'sstv_visual_' + Date.now());
  const pageUrl = fileUrl(path.join(ROOT, 'index.html'));
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--allow-file-access-from-files',
    '--window-size=1200,1400', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, pageUrl], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.url.indexOf('index.html') >= 0)
              || list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { /* not up */ }
    }
    if (!target) throw new Error('no devtools endpoint');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    });
    const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 300000); });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    };
    const shoot = async (clip) => {
      const r = await send('Page.captureScreenshot', { format: 'png', clip: clip, captureBeyondViewport: true });
      return Buffer.from(r.data, 'base64');
    };

    await send('Runtime.enable');
    await send('Page.enable');
    // make sure the document is booted
    for (let i = 0; i < 40; i++) {
      const ready = await evaluate(`!!(document.getElementById('wavInput') && document.getElementById('decodeBtn'))`).catch(() => false);
      if (ready) break;
      await sleep(300);
    }

    // ---------------------------------------------------------------- 1. real UI decode
    const fileHandle = await send('Runtime.evaluate', { expression: `document.getElementById('wavInput')` });
    await send('DOM.setFileInputFiles', { files: [AUDIO], objectId: fileHandle.result.objectId });
    await evaluate(`document.getElementById('wavInput').dispatchEvent(new Event('change')); true`);
    const loaded = await (async () => {
      for (let i = 0; i < 80; i++) {
        const t = await evaluate(`document.getElementById('decStatus').textContent`);
        if (t && t.indexOf(path.basename(AUDIO)) >= 0) return t;
        await sleep(300);
      }
      return null;
    })();
    console.log('load status: ' + (loaded ? loaded.replace(/\s+/g, ' ').slice(0, 140) : 'TIMEOUT'));

    await evaluate(`(function(){
      var q = document.getElementById('qualitySelect');
      if (q) { q.value = 'standard'; }
      document.getElementById('decodeBtn').click();
    })()`);

    let dec = null;
    for (let i = 0; i < 400; i++) {
      await sleep(500);
      dec = await evaluate(`(function(){
        var s = document.getElementById('decStatus');
        var c = document.getElementById('decCanvas');
        var d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        var set = new Set();
        for (var i=0;i<d.length;i+=4*101) set.add(d[i]+','+d[i+1]+','+d[i+2]);
        return { text: s.textContent, cls: s.className,
                 meta: document.getElementById('decMeta').textContent,
                 w: c.width, h: c.height, colours: set.size,
                 saveEnabled: !document.getElementById('savePngBtn').disabled };
      })()`);
      if (dec.cls.indexOf('err') >= 0 || /解码成功/.test(dec.text)) break;
    }
    console.log('decode status: ' + dec.text.replace(/\s+/g, ' ').slice(0, 200));
    console.log('meta         : ' + dec.meta);
    console.log('raster       : ' + dec.w + 'x' + dec.h + '  distinct sampled colours ' + dec.colours +
                '  save enabled ' + dec.saveEnabled);

    // screenshot the decode card (the whole user-visible result, not just the canvas)
    const card = await evaluate(`(function(){
      var el = document.getElementById('decCanvas').closest('.card') || document.getElementById('decCanvas');
      var r = el.getBoundingClientRect();
      window.scrollTo(0, 0);
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    })()`);
    fs.writeFileSync(path.join(OUT, 'browser-decode-card.png'), await shoot({
      x: 0, y: Math.max(0, card.y - 8), width: 1200, height: Math.min(1300, card.height + 60), scale: 1
    }));
    console.log('-> tests/diag-quality/browser-decode-card.png');

    // ---------------------------------------------------------------- 2. side-by-side plate
    const rasterRun = fs.existsSync(RASTER_JSON)
      ? JSON.parse(fs.readFileSync(RASTER_JSON, 'utf8')).run : null;
    const browserRaster = await evaluate(`(function(){
      var c = document.getElementById('decCanvas');
      return c.toDataURL('image/png');
    })()`);

    await evaluate(`(function(){
      document.documentElement.innerHTML = '<head><meta charset="utf-8"></head><body style="margin:0;background:#111;color:#eee;font:14px system-ui">' +
      '<div style="padding:10px 14px">' +
      '<div style="font-size:17px;margin-bottom:8px">phigros 真实录音 · Scottie S1 · 同一段音频</div>' +
      '<div style="display:flex;gap:14px;align-items:flex-start">' +
      '<div><div style="margin-bottom:4px">本项目解码器（浏览器 index.html，320×256 原始栅格 3× 最近邻放大）</div>' +
      '<canvas id="a" width="960" height="768" style="image-rendering:pixelated;background:#000"></canvas></div>' +
      '<div><div style="margin-bottom:4px">Robot36 App 屏幕截图（栅格区域）</div>' +
      '<canvas id="b" style="background:#000"></canvas></div>' +
      '</div></div></body>';
      window.__ready = false;
      var ia = new Image();
      ia.onload = function(){
        var c = document.getElementById('a'), g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(ia, 0, 0, c.width, c.height);
        var ib = new Image();
        ib.onload = function(){
          var cb = document.getElementById('b');
          var run = ${JSON.stringify(rasterRun)};
          var sy = run ? run[0] : 0, sh = run ? (run[1] - run[0] + 1) : ib.naturalHeight;
          // The app shows the decoded 320x256 raster scaled to 864 wide, so the raster is 864 x 691.
          // Keep the region at its native 864 px width and its true height, no rescaling.
          cb.width = ib.naturalWidth; cb.height = sh;
          var gb = cb.getContext('2d');
          gb.drawImage(ib, 0, sy, ib.naturalWidth, sh, 0, 0, ib.naturalWidth, sh);
          window.__ready = true;
        };
        ib.src = ${JSON.stringify(fileUrl(REF))};
      };
      ia.src = ${JSON.stringify(browserRaster)};
      return true;
    })()`);

    let ready = false;
    for (let i = 0; i < 40; i++) {
      ready = await evaluate('window.__ready === true').catch(() => false);
      if (ready) break;
      await sleep(300);
    }
    if (!ready) throw new Error('plate did not finish loading images');
    const plate = await evaluate(`(function(){
      var a = document.getElementById('a'), b = document.getElementById('b');
      var wa = a.getBoundingClientRect(), wb = b.getBoundingClientRect();
      return { width: Math.ceil(Math.max(wa.right, wb.right)) + 16,
               height: Math.ceil(Math.max(wa.bottom, wb.bottom)) + 16 };
    })()`);
    fs.writeFileSync(path.join(OUT, 'phigros-vs-robot36.png'),
      await shoot({ x: 0, y: 0, width: plate.width, height: plate.height, scale: 1 }));
    console.log('-> tests/diag-quality/phigros-vs-robot36.png (' + plate.width + 'x' + plate.height + ')');

    // also dump the browser raster itself, so it can be compared byte-wise with the node render
    const b64 = String(browserRaster).split(',')[1];
    fs.writeFileSync(path.join(OUT, 'phigros-browser.png'), Buffer.from(b64, 'base64'));
    console.log('-> tests/diag-quality/phigros-browser.png');
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
  }
})();
