/*
 * Locate the SSTV raster inside the user's Robot36 phone screenshot (测试结果/robot36.jpg).
 *
 * A screenshot is not a raster: above and below the picture there is app chrome (near-uniform dark
 * grey) and, at the top, noise from the tape/leader. The raster is the one region that is both
 * non-uniform AND active over nearly the full frame width, so scanning for the first and last row
 * whose per-row luma standard deviation clears a threshold brackets it - measured, not assumed.
 *
 * The JPEG is decoded by the browser (CDP), because Node here has no JPEG decoder and adding a
 * dependency for one measurement is not worth it. Usage: node tests/locate-robot36-raster.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const REF = path.join(ROOT, '测试结果', 'robot36.jpg');
const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

function fileUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

(async function main() {
  if (!EDGE) { console.log('no chromium'); process.exitCode = 1; return; }
  if (!fs.existsSync(REF)) { console.log('missing ' + REF); process.exitCode = 1; return; }

  const profile = path.join(os.tmpdir(), 'sstv_locate_' + Date.now());
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--allow-file-access-from-files',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
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
    const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 120000); });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: fileUrl(path.join(ROOT, 'index.html')) });
    await sleep(2500);

    const res = await evaluate(`(async function(){
      var img = await new Promise(function(res, rej){
        var i = new Image();
        i.onload = function(){ res(i); };
        i.onerror = function(){ rej(new Error('load failed')); };
        i.src = ${JSON.stringify(fileUrl(REF))};
      });
      var c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      var g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      var W = c.width, H = c.height;
      var d = g.getImageData(0, 0, W, H).data;
      // per-row luma sd and per-column luma sd
      var rowSd = new Float64Array(H), colSd = new Float64Array(W);
      var rowMean = new Float64Array(H), colMean = new Float64Array(W);
      for (var y = 0; y < H; y++) {
        var s = 0, s2 = 0;
        for (var x = 0; x < W; x++) { var i4 = (y*W+x)*4; var L = 0.299*d[i4]+0.587*d[i4+1]+0.114*d[i4+2]; s += L; s2 += L*L; }
        var m = s/W; rowMean[y] = m; rowSd[y] = Math.sqrt(Math.max(0, s2/W - m*m));
      }
      for (var x2 = 0; x2 < W; x2++) {
        var t = 0, t2 = 0;
        for (var y2 = 0; y2 < H; y2++) { var j = (y2*W+x2)*4; var L2 = 0.299*d[j]+0.587*d[j+1]+0.114*d[j+2]; t += L2; t2 += L2*L2; }
        var mm = t/H; colMean[x2] = mm; colSd[x2] = Math.sqrt(Math.max(0, t2/H - mm*mm));
      }
      // raster = rows whose sd is high, bracketed by the first/last run of >= 40 such rows
      var hi = [];
      for (var y3 = 0; y3 < H; y3++) hi.push(rowSd[y3] > 25 ? 1 : 0);
      // find longest run allowing small gaps
      var best = null, start = -1, gap = 0;
      for (var y4 = 0; y4 < H; y4++) {
        if (hi[y4]) { if (start < 0) start = y4; gap = 0; }
        else if (start >= 0) { gap++; if (gap > 8) { if (!best || (y4-gap-start) > (best[1]-best[0])) best = [start, y4-gap]; start = -1; } }
      }
      if (start >= 0 && (!best || (H-1-start) > (best[1]-best[0]))) best = [start, H-1];
      return { W: W, H: H, run: best, rowSd: Array.prototype.slice.call(rowSd, 0, H),
               topRows: Array.prototype.slice.call(hi, 0, 60) };
    })()`);

    console.log('reference ' + res.W + 'x' + res.H);
    console.log('raster row run: ' + (res.run ? res.run[0] + ' .. ' + res.run[1] + '  (height ' + (res.run[1]-res.run[0]+1) + ')' : 'not found'));
    // print row sd profile coarsely
    let line = '';
    for (let y = 0; y < res.H; y += 20) line += y + ':' + res.rowSd[y].toFixed(0) + '  ';
    console.log('rowSd every 20 px: ' + line);
    fs.writeFileSync(path.join(__dirname, 'diag-quality', 'robot36-raster.json'),
      JSON.stringify({ width: res.W, height: res.H, run: res.run }, null, 2));
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
  }
})();
