/*
 * Task 1 driver: measure the secret-image compression matrix in a real browser.
 *
 * The JPEG numbers MUST come from the browser: canvas.toDataURL('image/jpeg') is the
 * encoder the app actually uses, and Node has no JPEG encoder available offline. PNG is
 * measured the same way. QIMG is analytic (ceil(W*H*bpp/8)) and is cross-checked here.
 *
 * The source photo is injected as a data URL AFTER load, so there is no dependency on
 * external script paths or navigation timing - the two things that broke the earlier
 * browser-based generator.
 *
 * Usage: node scripts/measure-secret-matrix.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'out');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 180000);
    });
  }
  async evaluate(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: awaitPromise !== false, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  }
}

const FRAME_HEADER = 15;      // image frame header (task 2)
const PAYLOAD = 215;          // payload capacity at B=32 with RS(255,223)
const DATA_BUDGET = PAYLOAD - FRAME_HEADER;   // 200 B

(async function main() {
  if (!EDGE) { console.log('no Chromium found'); process.exitCode = 1; return; }
  fs.mkdirSync(OUT, { recursive: true });
  const page = fileUrl(path.join(ROOT, 'tests', 'secret-matrix.html'));
  const profile = path.join(os.tmpdir(), 'matrix_' + Date.now());
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, page], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.url.indexOf('secret-matrix') >= 0)
              || list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { }
    }
    if (!target) throw new Error('no devtools target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: page });

    // wait for THIS page (not the previous document) to expose runMatrix
    let ready = false;
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      try {
        ready = await cdp.evaluate("location.href.indexOf('secret-matrix') >= 0 && typeof window.runMatrix === 'function'", false);
        if (ready) break;
      } catch (e) { }
    }
    if (!ready) throw new Error('runMatrix never appeared');

    const photoPath = path.join(RESEARCH, 'sstv', 'examples', 'sample.png');
    const photoUrl = fs.existsSync(photoPath)
      ? 'data:image/png;base64,' + fs.readFileSync(photoPath).toString('base64') : '';
    const matrix = await cdp.evaluate(`window.runMatrix(${JSON.stringify(photoUrl)})`);
    if (!matrix || !matrix.ok) throw new Error('matrix did not complete');

    const { rows, jpegQualities, qimBpp, minJpeg, source, sourceSize } = matrix;
    console.log(`Secret-image compression matrix  (source: ${source} ${sourceSize.w}x${sourceSize.h})`);
    console.log(`image-frame header = ${FRAME_HEADER} B, payload capacity = ${PAYLOAD} B, data budget = ${DATA_BUDGET} B\n`);

    console.log('=== main table: JPEG bytes, 6 sizes x 5 qualities ===');
    console.log('| 长边 | 实际 WxH | ' + jpegQualities.map((q) => 'q=' + q).join(' | ') + ' | 能装下 |');
    console.log('|---|---|' + jpegQualities.map(() => '---').join('|') + '|---|');
    const jpegFits = [];
    for (const r of rows) {
      const cs = jpegQualities.map((q) => r.jpeg[q]);
      const fit = jpegQualities.filter((q) => r.jpeg[q] <= DATA_BUDGET);
      if (fit.length) jpegFits.push({ side: r.side, wh: r.w + 'x' + r.h, q: fit[0], bytes: r.jpeg[fit[0]] });
      console.log(`| ${r.side} | ${r.w}x${r.h} | ${cs.join(' | ')} | ${fit.length ? 'q=' + fit[0] : '**否**'} |`);
    }

    console.log('\n=== table A: PNG (grayscale, canvas) vs the same data budget ===');
    console.log('| 长边 | WxH | PNG 字节 | 能装下 | QIMG 1bpp | QIMG 4bpp | QIMG 6bpp | QIMG 8bpp |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      console.log(`| ${r.side} | ${r.w}x${r.h} | ${r.png} | ${r.png <= DATA_BUDGET ? '是' : '否'} | ` +
        `${r.qimg[1]}${r.qimg[1] <= DATA_BUDGET ? ' ✓' : ''} | ${r.qimg[4]}${r.qimg[4] <= DATA_BUDGET ? ' ✓' : ''} | ` +
        `${r.qimg[6]}${r.qimg[6] <= DATA_BUDGET ? ' ✓' : ''} | ${r.qimg[8]}${r.qimg[8] <= DATA_BUDGET ? ' ✓' : ''} |`);
    }

    console.log('\n=== minimum-JPEG probe (fixed overhead, content-independent) ===');
    console.log(`  1x1 JPEG q=0.85 -> ${minJpeg.bytes_q085} B`);
    console.log(`  1x1 JPEG q=0.45 -> ${minJpeg.bytes_q045} B`);
    console.log(`  data budget      -> ${DATA_BUDGET} B`);

    console.log('\n=== conclusions ===');
    if (!jpegFits.length) {
      console.log(`  JPEG: NO combination of ${rows.length} sizes x ${jpegQualities.length} qualities fits in ${DATA_BUDGET} B.`);
      console.log(`  The smallest measured JPEG (1x1 px) is ${minJpeg.bytes_q045} B, i.e. the fixed header alone`);
      console.log(`  exceeds the budget by ${(minJpeg.bytes_q045 - DATA_BUDGET).toFixed(0)} B. JPEG is unusable at this capacity.`);
    } else {
      console.log('  JPEG fits at: ' + jpegFits.map((f) => `${f.wh} q=${f.q} (${f.bytes} B)`).join(', '));
    }
    const qimgCands = [];
    for (const r of rows) {
      for (const bpp of qimBpp) {
        if (r.qimg[bpp] <= DATA_BUDGET && r.side >= 8) qimgCands.push({ side: r.side, w: r.w, h: r.h, bpp, bytes: r.qimg[bpp], px: r.w * r.h });
      }
    }
    qimgCands.sort((a, b) => (b.px - a.px) || (b.bpp - a.bpp));
    console.log('  QIMG largest-with-most-pixels that fits:');
    for (const c of qimgCands.slice(0, 6)) console.log(`    ${c.w}x${c.h} @ ${c.bpp}bpp (${c.bytes} B, ${c.px} px)`);
    const pngFits = rows.filter((r) => r.png <= DATA_BUDGET);
    console.log(`  PNG fits at: ${pngFits.length ? pngFits.map((r) => r.w + 'x' + r.h + ' (' + r.png + ' B)').join(', ') : 'no size'}`);

    fs.writeFileSync(path.join(OUT, 'secret-matrix.json'), JSON.stringify({
      dataBudget: DATA_BUDGET, frameHeader: FRAME_HEADER, payload: PAYLOAD, matrix
    }, null, 2));
    console.log(`\n-> ${path.relative(ROOT, path.join(OUT, 'secret-matrix.json'))}`);
  } catch (e) {
    console.log('MATRIX FAILED: ' + (e.stack || e.message));
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
})();
