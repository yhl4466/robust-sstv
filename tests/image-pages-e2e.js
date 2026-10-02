/*
 * Phase-5 UI verification (AC9): drive embed-image.html and extract-image.html for real.
 *
 * The two pages must work as INDEPENDENT pages on file://, and the WAV produced by the
 * embed page must be recoverable by the extract page. So this test:
 *   1. opens embed-image.html, sets the carrier + secret file inputs, runs the embed,
 *      downloads the WAV through the page's own download button
 *   2. opens extract-image.html, feeds it that exact WAV, runs the extraction
 *   3. asserts both images come back and that the secret matches byte-for-byte
 *
 * Usage: node tests/image-pages-e2e.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const FIX = path.join(__dirname, 'fixtures');
const DL = path.join(__dirname, 'downloads');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));
const PORT = 9361;
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 300000);
    });
  }
  async evaluate(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: awaitPromise !== false, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  }
}

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '   ' + detail : '')); }
}

/** Write a tiny greyscale PNG without any image library (zlib is built in). */
function writeGrayPng(file, w, h, fn) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;                       // filter: none
    for (let x = 0; x < w; x++) { const v = fn(x, y) & 255; raw[o++] = v; raw[o++] = v; raw[o++] = v; }
  }
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  chunks.push(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', zlib.deflateSync(raw)));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  fs.writeFileSync(file, Buffer.concat(chunks));
}
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC_T[n] = c; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

(async function main() {
  if (!EDGE) { console.log('no Chromium found'); process.exitCode = 1; return; }
  fs.mkdirSync(FIX, { recursive: true });
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });

  // carrier: a photo-like 320x256; secret: a 256x256 blob pattern
  const carrierPath = path.join(FIX, 'page-carrier.png');
  const secretPath = path.join(FIX, 'page-secret.png');
  writeGrayPng(carrierPath, 320, 256, (x, y) =>
    Math.round(120 + 80 * Math.sin(x / 23) * Math.cos(y / 17) + 20 * Math.sin((x + y) / 7)));
  writeGrayPng(secretPath, 256, 256, (x, y) => {
    const d = Math.hypot(x - 128, y - 128);
    return d < 70 ? 240 : (d < 110 ? 90 : 30);
  });

  const profile = path.join(os.tmpdir(), 'imgpages_' + Date.now());
  const embedUrl = fileUrl(path.join(ROOT, 'embed-image.html'));
  const extractUrl = fileUrl(path.join(ROOT, 'extract-image.html'));
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, embedUrl], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.url.indexOf('embed-image') >= 0) || list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { }
    }
    if (!target) throw new Error('no devtools target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => { });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => { });
    const errors = [];
    await cdp.send('Runtime.consoleAPICalled', {}).catch(() => { });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      }
    });

    const setFile = async (sel, file) => {
      const r = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('${sel}')` });
      await cdp.send('DOM.setFileInputFiles', { files: [file], objectId: r.result.objectId });
    };
    const waitFor = async (expr, ms, label) => {
      for (let i = 0; i < ms / 300; i++) {
        await sleep(300);
        try { if (await cdp.evaluate(expr, false)) return true; } catch (e) { }
      }
      if (label) console.log('       (timed out waiting for ' + label + ')');
      return false;
    };

    // ---------------- embed page (AC9a) ----------------
    console.log('=== embed-image.html ===');
    await cdp.send('Page.navigate', { url: embedUrl });
    check(await waitFor("location.href.indexOf('embed-image') >= 0 && !!window.__embedPageReady", 30000, 'embed page ready'),
      'AC9 embed page loads and boots on file://');
    check(await cdp.evaluate("location.protocol === 'file:'", false), 'AC9 embed page protocol is file:');

    await setFile('#carrierInput', carrierPath);
    await sleep(800);
    console.log('       after carrier upload: files=' +
      await cdp.evaluate("document.getElementById('carrierInput').files.length", false) +
      ' status=' + JSON.stringify((await cdp.evaluate("document.getElementById('status').textContent", false) || '').slice(0, 90)));
    await setFile('#secretInput', secretPath);
    await sleep(800);
    console.log('       after secret upload: files=' +
      await cdp.evaluate("document.getElementById('secretInput').files.length", false) +
      ' status=' + JSON.stringify((await cdp.evaluate("document.getElementById('status').textContent", false) || '').slice(0, 90)));
    const pre = await waitFor("!document.getElementById('preprocessBox').hidden", 20000, 'preprocess box');
    check(pre, 'AC9 embed page runs the preprocessing preview');
    const preText = await cdp.evaluate("document.getElementById('preprocessBox').textContent");
    check(/可嵌入/.test(preText), 'AC9 preprocessing reports embeddability', preText.replace(/\s+/g, ' ').slice(0, 80));
    check(/帧总长/.test(preText), 'AC9 preprocessing reports the frame size');
    const btnEnabled = await cdp.evaluate("!document.getElementById('embedBtn').disabled");
    check(btnEnabled, 'AC9 embed button enabled once both images are chosen');

    await cdp.evaluate("document.getElementById('embedBtn').click()");
    const embedded = await waitFor("!document.getElementById('metrics').hidden && !!document.getElementById('player').src", 60000, 'embed result');
    check(embedded, 'AC9 embedding completes and produces audio');
    const metrics = await cdp.evaluate("document.getElementById('metrics').textContent");
    check(/秘密图最终/.test(metrics), 'AC9 embed metrics show the final secret size', metrics.replace(/\s+/g, ' ').slice(0, 70));
    check(/重建 PSNR/.test(metrics), 'AC9 embed metrics show the reconstruction PSNR');

    await cdp.evaluate("document.getElementById('downloadBtn').click()");
    let wavFiles = [];
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      wavFiles = fs.readdirSync(DL).filter((f) => f.toLowerCase().endsWith('.wav'));
      if (wavFiles.length) {
        const p = path.join(DL, wavFiles[0]);
        const a = fs.statSync(p).size;
        await sleep(500);
        if (fs.existsSync(p) && fs.statSync(p).size === a && a > 0) break;
      }
    }
    check(wavFiles.length > 0, 'AC9 embed page downloads a WAV', wavFiles.join(','));
    const wavPath = wavFiles.length ? path.join(DL, wavFiles[0]) : null;
    if (wavPath) check(fs.statSync(wavPath).size > 1000000, 'AC9 downloaded WAV is a plausible size', (fs.statSync(wavPath).size / 1048576).toFixed(2) + ' MB');

    // ---------------- extract page (AC9b) ----------------
    console.log('\n=== extract-image.html ===');
    await cdp.send('Page.navigate', { url: extractUrl });
    check(await waitFor("location.href.indexOf('extract-image') >= 0 && !!window.__extractPageReady", 30000, 'extract page ready'),
      'AC9 extract page loads and boots on file://');
    if (!wavPath) throw new Error('no WAV to feed the extract page');
    await setFile('#wavInput', wavPath);
    check(await waitFor('!!window.__extractWavLoaded', 20000, 'wav loaded'), 'AC9 extract page parses the app-produced WAV');

    await cdp.evaluate("document.getElementById('extractBtn').click()");
    const done = await waitFor('!!window.__extractDone', 180000, 'extraction done');
    check(done, 'AC9 extraction completes');
    const exStat = await cdp.evaluate("document.getElementById('status').textContent");
    console.log('       status: ' + exStat.replace(/\s+/g, ' ').slice(0, 110));
    const secretOk = await cdp.evaluate('!!window.__extractSecretOk');
    check(secretOk, 'AC9 extract page recovers the secret image', exStat.replace(/\s+/g, ' ').slice(0, 90));
    const exMetrics = await cdp.evaluate("document.getElementById('metrics').textContent");
    for (const f of ['模式', '接收端标定', '擦除率', 'RS 块正确率', '数字边带帧', '秘密图']) {
      check(exMetrics.indexOf(f) >= 0, 'AC9 extract metrics report: ' + f);
    }
    const pubOk = await cdp.evaluate("!document.getElementById('savePublic').disabled");
    const secOk = await cdp.evaluate("!document.getElementById('saveSecret').disabled");
    check(pubOk, 'AC9 public image PNG download is enabled');
    check(secOk, 'AC9 secret image PNG download is enabled');
    const canvases = await cdp.evaluate(`(function(){
      var p = document.getElementById('publicCanvas'), s = document.getElementById('secretCanvas');
      return { pub: p.width + 'x' + p.height, sec: s.width + 'x' + s.height };
    })()`);
    check(/^\d+x\d+$/.test(canvases.pub) && canvases.pub !== '0x0', 'AC9 public canvas has a raster', canvases.pub);
    check(/^\d+x\d+$/.test(canvases.sec) && canvases.sec !== '0x0', 'AC9 secret canvas has a raster', canvases.sec);

    check(errors.length === 0, 'no uncaught page exceptions across both pages', errors.slice(0, 2).join(' | ') || 'clean');

    // ---------------- UI screenshots for the report ----------------
    // The extract page's state is the interesting one (both images recovered), so it is
    // captured now; the embed page is revisited and captured in its post-embed state.
    const shot = async (file) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(ROOT, 'scripts', 'out', file), Buffer.from(r.data, 'base64'));
      return fs.statSync(path.join(ROOT, 'scripts', 'out', file)).size;
    };
    const shotSize = await shot('ui-extract-page.png');
    check(shotSize > 5000, 'AC9 extract page screenshot captured', (shotSize / 1024).toFixed(0) + ' KB');

    await cdp.send('Page.navigate', { url: embedUrl });
    await waitFor("location.href.indexOf('embed-image') >= 0 && !!window.__embedPageReady", 30000, 'embed page reload');
    await setFile('#carrierInput', carrierPath);
    await setFile('#secretInput', secretPath);
    await waitFor("!document.getElementById('preprocessBox').hidden", 20000, 'preprocess box');
    const shot2 = await shot('ui-embed-page.png');
    check(shot2 > 5000, 'AC9 embed page screenshot captured', (shot2 / 1024).toFixed(0) + ' KB');
  } catch (e) {
    fail++;
    console.log('  FAIL harness error: ' + (e.message || e));
  } finally {
    try { if (ws) ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }

  console.log('\n================================');
  console.log(`${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? 'IMAGE PAGES E2E: ALL CHECKS PASSED' : 'IMAGE PAGES E2E: FAILED');
  process.exitCode = fail === 0 ? 0 : 1;
})();
