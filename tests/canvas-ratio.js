/*
 * Rendered-geometry probe: does every canvas display at its raster's aspect ratio?
 *
 * Written because reading the CSS said "no bug" while the user reported a squashed image, and
 * reading code is not evidence. This measures the ATTRIBUTES (raster size), the RENDERED box
 * (getBoundingClientRect) and the computed style, then compares the rendered ratio against the
 * raster ratio - at desktop and mobile widths, because that is where a layout rule could bite.
 *
 * Usage: node tests/canvas-ratio.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const PORT = 9346;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 300000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlobs: true
    });
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

async function waitFor(cdp, expr, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 60000);
  for (;;) {
    try { if (await cdp.evaluate('!!(' + expr + ')')) return true; } catch (e) { /* navigating */ }
    if (Date.now() > deadline) return false;
    await sleep(300);
  }
}

/** Measure every canvas on the page: raster ratio vs rendered ratio. */
const MEASURE = `(function(){
  var out = [];
  var list = document.querySelectorAll('canvas');
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var r = c.getBoundingClientRect();
    var cs = getComputedStyle(c);
    out.push({
      id: c.id || '(anon)', cls: c.className || '',
      attrW: c.width, attrH: c.height,
      boxW: +r.width.toFixed(2), boxH: +r.height.toFixed(2),
      cssW: cs.width, cssH: cs.height, maxW: cs.maxWidth, height: cs.height,
      rasterRatio: c.height ? +(c.width / c.height).toFixed(4) : null,
      boxRatio: r.height ? +(r.width / r.height).toFixed(4) : null
    });
  }
  var de = document.documentElement;
  return { canvases: out, scrollW: de.scrollWidth, clientW: de.clientWidth,
           innerW: window.innerWidth, overflowX: de.scrollWidth > de.clientWidth };
})()`;

async function upload(cdp, file, inputSel, statusSel) {
  const base = path.basename(file);
  await cdp.evaluate(`document.getElementById(${JSON.stringify(statusSel)}).textContent = ''; true`);
  const r = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(inputSel)})` });
  await cdp.send('DOM.setFileInputFiles', { files: [file], objectId: r.result.objectId });
  await cdp.evaluate(`document.querySelector(${JSON.stringify(inputSel)}).dispatchEvent(new Event('change'))`);
  return waitFor(cdp,
    `document.getElementById(${JSON.stringify(statusSel)}).textContent.indexOf(${JSON.stringify(base)}) >= 0 ||` +
    `document.getElementById(${JSON.stringify(statusSel)}).className.indexOf('err') >= 0`, 60000);
}

async function decodeCurrent(cdp) {
  await cdp.evaluate(`(function(){
    var q = document.getElementById('qualitySelect'); if (q) q.value = 'fast';
    document.getElementById('decodeBtn').click();
  })()`);
  for (let i = 0; i < 300; i++) {
    await sleep(400);
    const busy = await cdp.evaluate(`!document.getElementById('cancelBtn').disabled`);
    if (!busy) break;
  }
  return cdp.evaluate(`document.getElementById('decStatus').textContent`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const wavs = [
    ['Martin M1', 'enc_M1.wav', 320, 256],
    ['Scottie S1', 'enc_S1.wav', 320, 256],
    ['PD120', 'enc_PD120.wav', 640, 496]
  ].map(([label, name, w, h]) => ({ label, file: path.join(OUT, name), w, h }))
    .filter((x) => fs.existsSync(x.file));
  if (!wavs.length) {
    console.log('no encoded WAVs in tests/out - run node tests/roundtrip.js first');
    process.exitCode = 1; return;
  }

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('no Chromium found'); process.exitCode = 1; return; }

  const profile = path.join(os.tmpdir(), 'sstv_ratio_' + Date.now());
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    fileUrl(path.join(ROOT, 'index.html'))
  ], { stdio: 'ignore' });

  let ws = null, failures = 0;
  const check = (ok, label, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  };

  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { /* not up */ }
    }
    if (!target) throw new Error('no DevTools endpoint');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('ws error')));
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    check(await waitFor(cdp, 'window.SSTVDecoder && window.appReady !== false'), 'index.html loaded');

    for (const w of wavs) {
      console.log(`\n[decode] ${w.label} (raster ${w.w}x${w.h}, ratio ${(w.w / w.h).toFixed(4)})`);
      await upload(cdp, w.file, '#wavInput', 'decStatus');
      const st = await decodeCurrent(cdp);
      check(/解码成功/.test(st), `${w.label} decoded`, st.replace(/\s+/g, ' ').slice(0, 50));
      const m = await cdp.evaluate(MEASURE);
      const c = m.canvases.find((x) => x.id === 'decCanvas');
      if (!c) { check(false, 'decCanvas present'); continue; }
      check(c.attrW === w.w && c.attrH === w.h, `decCanvas raster is ${w.w}x${w.h}`,
        `attr ${c.attrW}x${c.attrH}`);
      const ratioErr = Math.abs(c.boxRatio - (w.w / w.h)) / (w.w / w.h);
      check(ratioErr < 0.005, `decCanvas RENDERED ratio matches raster (${(w.w / w.h).toFixed(4)})`,
        `box ${c.boxW}x${c.boxH} = ${c.boxRatio}  (err ${(ratioErr * 100).toFixed(2)}%)`);
      check(m.canvases.find((x) => x.id === 'imgCanvas').boxRatio > 0, 'imgCanvas measured');
      check(!m.overflowX, `no horizontal overflow at 1280`, `scrollW ${m.scrollW} / clientW ${m.clientW}`);

      /*
       * A screenshot, because the complaint was visual: numbers can say 1.25 and a reader still
       * wants to see the shape.
       *
       * The clip must be in PAGE coordinates, not viewport ones. getBoundingClientRect is
       * viewport-relative, and the canvas sits below the fold, so using it directly captured an
       * empty stretch of page background - a solid-black PNG that looked like a decode failure.
       */
      await cdp.evaluate(`document.getElementById('decCanvas').scrollIntoView({block:'center'}); true`);
      await sleep(400);
      const box = await cdp.evaluate(`(function(){
        var r = document.getElementById('decCanvas').getBoundingClientRect();
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
      })()`);
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
      });
      const shotPath = path.join(OUT, 'ratio-' + w.label.replace(/\s+/g, '') + '.png');
      const bytes = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(shotPath, bytes);
      // a solid-colour capture means the clip missed, not that the decode was blank
      const distinct = new Set(bytes.subarray(0, Math.min(bytes.length, 20000))).size;
      console.log('  screenshot -> ' + path.relative(ROOT, shotPath) +
        '  (' + Math.round(box.width) + 'x' + Math.round(box.height) + ', ' + bytes.length + ' B)');
      if (bytes.length < 2000) console.log('  !! tiny PNG - the clip probably missed the canvas');
    }

    // mobile width: the layout is most likely to distort or overflow here
    console.log('\n[mobile 390x844]');
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    let m = await cdp.evaluate(MEASURE);
    let c = m.canvases.find((x) => x.id === 'decCanvas');
    const w = wavs[wavs.length - 1];
    check(Math.abs(c.boxRatio - (w.w / w.h)) / (w.w / w.h) < 0.005,
      `decCanvas still undistorted on mobile (${c.boxW}x${c.boxH} = ${c.boxRatio})`);
    check(!m.overflowX, 'no horizontal page overflow on mobile',
      `scrollW ${m.scrollW} / clientW ${m.clientW}`);
    console.log('  all canvases on mobile:');
    for (const x of m.canvases) {
      const bad = x.rasterRatio && Math.abs(x.boxRatio - x.rasterRatio) / x.rasterRatio > 0.005;
      console.log(`    ${bad ? 'DISTORTED ' : 'ok         '} #${x.id.padEnd(18)} ` +
        `raster ${x.attrW}x${x.attrH} (${x.rasterRatio})  box ${x.boxW}x${x.boxH} (${x.boxRatio})` +
        (x.cls ? '  .' + x.cls : ''));
      if (bad) failures++;
    }

    // extract-image.html: public + secret canvases
    console.log('\n[extract-image.html]');
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: fileUrl(path.join(ROOT, 'extract-image.html')) });
    check(await waitFor(cdp, 'window.ImageExtract'), 'extract-image.html loaded');
    const hidden = path.join(__dirname, 'downloads', 'sstv_hidden_M1.wav');
    if (fs.existsSync(hidden)) {
      await upload(cdp, hidden, '#wavInput', 'status');
      await cdp.evaluate(`document.getElementById('extractBtn').click()`);
      await waitFor(cdp, `/提取成功|秘密图未能恢复|提取失败/.test(document.getElementById('status').textContent)`, 300000);
      const me = await cdp.evaluate(MEASURE);
      for (const x of me.canvases) {
        const bad = x.rasterRatio && Math.abs(x.boxRatio - x.rasterRatio) / x.rasterRatio > 0.005;
        console.log(`    ${bad ? 'DISTORTED ' : 'ok         '} #${x.id.padEnd(16)} ` +
          `raster ${x.attrW}x${x.attrH} (${x.rasterRatio})  box ${x.boxW}x${x.boxH} (${x.boxRatio})`);
        if (bad) failures++;
      }
    } else {
      console.log('    (no hidden-sample WAV; skipped)');
    }

    console.log(`\n${failures === 0 ? 'CANVAS RATIOS OK' : failures + ' CHECK(S) FAILED'}`);
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    child.kill();
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('harness error: ' + (e && e.stack || e)); process.exitCode = 1; });
