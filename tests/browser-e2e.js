/*
 * Browser end-to-end test over file:// using the DevTools Protocol.
 *
 * Drives the REAL UI in index.html - not a parallel code path:
 *   - sets real files into the <input type="file"> elements
 *   - clicks the real buttons
 *   - reads the real status elements and canvases
 *   - performs a real WAV download and checks the bytes on disk
 *
 * No npm dependencies: Node 22+ has global fetch and WebSocket.
 *
 * Usage: node tests/browser-e2e.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const FIX = path.join(__dirname, 'fixtures');
const DL = path.join(__dirname, 'downloads');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll an in-page boolean expression until it is true (or time out). */
async function waitFor(cdp, expression, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  for (;;) {
    try {
      if (await cdp.evaluate('!!(' + expression + ')')) return true;
    } catch (e) { /* context may be swapping mid-navigation */ }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

/** Set files on a file input via its element handle (robust across navigations). */
async function setFiles(cdp, selector, files) {
  const r = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('${selector}')` });
  if (!r.result || !r.result.objectId) throw new Error('element not found: ' + selector);
  await cdp.send('DOM.setFileInputFiles', { files: files, objectId: r.result.objectId });
}

/**
 * Upload a WAV into the decoder and wait until THAT file has been read.
 *
 * Waiting on "decode button enabled" is not sufficient: after a previous decode
 * the button is already enabled, so the wait returns immediately and the next
 * click would decode the PREVIOUS file. Instead the status element is cleared
 * first and we wait for it to name the new file.
 */
async function loadWav(cdp, file) {
  const base = path.basename(file);
  await cdp.evaluate(`document.getElementById('decStatus').textContent = ''; true`);
  await setFiles(cdp, '#wavInput', [file]);
  await cdp.evaluate(`document.getElementById('wavInput').dispatchEvent(new Event('change'))`);
  return waitFor(cdp,
    `document.getElementById('decStatus').textContent.indexOf(${JSON.stringify(base)}) >= 0`,
    20000);
}

/** Click decode and wait until it is no longer running. */
async function runDecode(cdp) {
  await cdp.evaluate(`(function(){
    document.getElementById('qualitySelect').value = 'fast';
    document.getElementById('decodeBtn').click();
  })()`);
  let st = { text: '', busy: true };
  for (let i = 0; i < 250; i++) {
    await sleep(400);
    st = await cdp.evaluate(`(function(){
      var s = document.getElementById('decStatus');
      return { text: s.textContent, busy: !document.getElementById('cancelBtn').disabled };
    })()`);
    if (!st.busy) break;
  }
  return st;
}

function fileUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

// ---------------------------------------------------------------- CDP client
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
      }, 180000);
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlobs: true
    });
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }
  /** Console errors / uncaught exceptions seen so far. */
  errors() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        out.push('exception: ' + (d.exception ? d.exception.description : d.text));
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.push('console.error: ' + e.params.args.map((a) => a.value || a.description || '').join(' '));
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        out.push('log: ' + e.params.entry.text);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- test runner
let failures = 0;
const results = [];
function check(ok, label, detail) {
  results.push(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function makeFixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  fs.mkdirSync(DL, { recursive: true });
  for (const f of fs.readdirSync(DL)) fs.unlinkSync(path.join(DL, f));

  // A source image the app has to rescale (deliberately not the raster size).
  const { PNG } = require(path.join(RESEARCH, 'pngjs'));
  const W = 400, H = 300;
  const png = new PNG({ width: W, height: H });
  const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
                [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (W * y + x) << 2;
      let c;
      if (y < H * 0.75) c = bars[Math.min(7, Math.floor(x / (W / 8)))];
      else { const v = Math.round((x / (W - 1)) * 255); c = [v, v, v]; }
      png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255;
    }
  }
  const pngPath = path.join(FIX, 'source.png');
  fs.writeFileSync(pngPath, PNG.sync.write(png));

  // A known-good SSTV WAV to decode, built with the project's own encoder libs.
  require(path.join(ROOT, 'js', 'lib', 'fft.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
  require(path.join(ROOT, 'js', 'lib', 'wav.js'));
  const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
        Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav;

  const mode = Modes.get('M1');
  const img = { data: new Uint8ClampedArray(mode.width * mode.height * 4), width: mode.width, height: mode.height };
  // fill from the same bars so the round trip is predictable
  for (let y = 0; y < mode.height; y++) {
    for (let x = 0; x < mode.width; x++) {
      const i = (y * mode.width + x) * 4;
      let c;
      if (y < mode.height * 0.75) c = bars[Math.min(7, Math.floor(x / (mode.width / 8)))];
      else { const v = Math.round((x / (mode.width - 1)) * 255); c = [v, v, v]; }
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }
  }
  const tl = Timeline.build(img, mode);
  const s = Synth.synthesize(tl, 48000);
  const wavPath = path.join(FIX, 'sstv_m1.wav');
  fs.writeFileSync(wavPath, Wav.encode(s.samples, 48000));

  return { pngPath, wavPath };
}

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('No Chromium browser found; skipping browser E2E.'); return; }
  const fixtures = makeFixtures();

  const profile = path.join(os.tmpdir(), 'sstv_e2e_' + Date.now());
  const pageUrl = fileUrl(path.join(ROOT, 'index.html'));

  const child = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',   // so AC2 playback can be verified
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    pageUrl
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    // wait for the debugging endpoint
    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.url.indexOf('index.html') >= 0)
              || list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('could not reach DevTools endpoint');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('ws error')));
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    try {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    } catch (e) {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    }

    // make sure the page is the app and fully booted. Poll rather than sleep:
    // evaluating before the navigation commits would inspect the OLD document
    // (and invalidate any node ids fetched from it).
    await cdp.send('Page.navigate', { url: pageUrl });
    const booted = await waitFor(cdp,
      `document.readyState === 'complete' && document.querySelectorAll('#modeSelect option').length >= 3 && !!window.SSTVEncoder`,
      40000);
    check(booted, 'AC1 app booted after navigation');

    console.log('Browser end-to-end test over file://');
    console.log('  browser: ' + path.basename(edge) + '\n');

    // ---------- AC1: loads and runs from file:// ----------
    const boot = await cdp.evaluate(`(function(){
      return {
        protocol: location.protocol,
        isSecureContext: window.isSecureContext,
        modes: document.querySelectorAll('#modeSelect option').length,
        qualities: document.querySelectorAll('#qualitySelect option').length,
        extRendered: document.getElementById('extPanel').innerHTML.length > 200,
        backend: document.getElementById('backendBadge').textContent,
        globals: ['SSTVEncoder','SSTVDecoder','SSTVChannel','SSTVTimeline','SSTVWav','SSTVDecode'].filter(function(n){return !window[n];}).length
      };
    })()`);
    check(boot.protocol === 'file:', 'AC1 protocol is file:', boot.protocol);
    // phase 7 added PD180 to the mode table, so the selector now offers 4 modes; the
    // assertion is on the minimum set the decoder must support rather than an exact count.
    check(boot.modes >= 3, 'AC1 mode selector populated', boot.modes + ' options');
    check(boot.qualities === 3, 'AC1 quality selector populated', boot.qualities + ' options');
    check(boot.globals === 0, 'AC1 all library globals present');
    check(boot.extRendered, 'AC1 extension panel rendered');
    check(boot.backend === 'local', 'AC1 backend badge', boot.backend);

    // ---------- AC2/AC3: real file input -> encode -> play -> download ----------
    await setFiles(cdp, '#imgInput', [fixtures.pngPath]);
    await cdp.evaluate(`document.getElementById('imgInput').dispatchEvent(new Event('change'))`);
    await waitFor(cdp, `!document.getElementById('encodeBtn').disabled`, 15000);

    const afterUpload = await cdp.evaluate(`(function(){
      var c = document.getElementById('imgCanvas');
      return {
        meta: document.getElementById('imgMeta').textContent,
        w: c.width, h: c.height,
        encodeEnabled: !document.getElementById('encodeBtn').disabled,
        previewNonBlank: (function(){
          var d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          var s = new Set();
          for (var i=0;i<d.length;i+=4*211) s.add(d[i]+','+d[i+1]+','+d[i+2]);
          return s.size;
        })()
      };
    })()`);
    check(afterUpload.encodeEnabled, 'AC2 encode button enabled after upload');
    check(afterUpload.w === 320 && afterUpload.h === 256, 'AC2 preview raster is mode geometry',
      afterUpload.w + 'x' + afterUpload.h);
    check(afterUpload.previewNonBlank > 5, 'AC2 preview canvas rendered', afterUpload.previewNonBlank + ' colours');
    results.push('       ' + afterUpload.meta);

    // click the real 生成音频 button
    await cdp.evaluate(`document.getElementById('encodeBtn').click()`);
    await waitFor(cdp, `/编码完成/.test(document.getElementById('encStatus').textContent)`, 20000);

    const encState = await cdp.evaluate(`(function(){
      var a = document.getElementById('encAudio');
      return {
        status: document.getElementById('encStatus').textContent,
        audioSrc: a.src.slice(0,5),
        paused: a.paused,
        duration: a.duration,
        downloadEnabled: !document.getElementById('downloadBtn').disabled
      };
    })()`);
    // audio metadata may still be loading; poll for it before asserting
    const durOk = await waitFor(cdp, `document.getElementById('encAudio').duration > 100`, 15000);
    if (durOk) encState.duration = await cdp.evaluate(`document.getElementById('encAudio').duration`);
    check(/编码完成/.test(encState.status), 'AC2 encode reports success');
    check(encState.audioSrc === 'blob:', 'AC2 audio element has a blob source', encState.audioSrc);
    check(encState.downloadEnabled, 'AC3 download button enabled');
    check(encState.paused === false, 'AC2 audio actually playing (autoplay permitted)',
      'paused=' + encState.paused);
    check(encState.duration > 100 && encState.duration < 130,
      'AC2 audio duration plausible for Martin M1', (encState.duration || 0).toFixed(2) + 's');

    // real download to disk
    await cdp.evaluate(`document.getElementById('downloadBtn').click()`);
    let dlFiles = [];
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      dlFiles = fs.readdirSync(DL).filter((f) => f.endsWith('.wav'));
      if (dlFiles.length) break;
    }
    // wait for the write to settle: handing a still-growing file to a file input makes
    // Chromium report ERR_UPLOAD_FILE_CHANGED and the upload silently never happens
    if (dlFiles.length) {
      const p = path.join(DL, dlFiles[0]);
      let last = -1;
      for (let i = 0; i < 40; i++) {
        const size = fs.existsSync(p) ? fs.statSync(p).size : -1;
        if (size > 0 && size === last) break;
        last = size;
        await sleep(250);
      }
    }
    check(dlFiles.length > 0, 'AC3 WAV file actually downloaded', dlFiles.join(','));
    if (dlFiles.length) {
      const buf = fs.readFileSync(path.join(DL, dlFiles[0]));
      const magic = buf.slice(0, 4).toString('ascii') + '/' + buf.slice(8, 12).toString('ascii');
      const sampleRate = buf.readUInt32LE(24);
      const bits = buf.readUInt16LE(34);
      const channels = buf.readUInt16LE(22);
      check(magic === 'RIFF/WAVE', 'AC3 downloaded file is a valid WAV', magic);
      check(sampleRate === 48000 && bits === 16 && channels === 1, 'AC3 WAV format',
        sampleRate + ' Hz / ' + bits + '-bit / ' + channels + 'ch');
      const dataBytes = buf.readUInt32LE(40);
      check(dataBytes === buf.length - 44, 'AC3 data chunk size consistent with file size',
        dataBytes + ' vs ' + (buf.length - 44));
    }

    // ---------- AC4: real WAV upload -> decode -> image ----------
    // Decode the WAV the app ITSELF just produced. That makes the round trip fully
    // self-consistent, so the decoded raster can be compared against #imgCanvas -
    // the exact raster the app encoded - with no reference to reproduce.
    const ownWav = dlFiles.length ? path.join(DL, dlFiles[0]) : fixtures.wavPath;
    const loadedOwn = await loadWav(cdp, ownWav);
    check(loadedOwn, 'AC4 upload of the app-produced WAV reported');

    const wavLoaded = await cdp.evaluate(`(function(){
      return {
        status: document.getElementById('decStatus').textContent,
        enabled: !document.getElementById('decodeBtn').disabled,
        audioSrc: document.getElementById('decAudio').src.slice(0,5)
      };
    })()`);
    check(wavLoaded.enabled, 'AC4 decode button enabled after WAV upload');
    check(/已载入/.test(wavLoaded.status), 'AC4 WAV parsed and reported');
    check(wavLoaded.audioSrc === 'blob:', 'AC4 uploaded audio playable via blob URL');
    results.push('       ' + wavLoaded.status.replace(/\s+/g, ' ').slice(0, 150));

    // decode, polling for completion.
    // A rAF counter is installed first: if decoding blocked the main thread the
    // frame count would stay ~0. This is the AC5 "no freeze" evidence.
    await cdp.evaluate(`(function(){
      window.__frames = 0;
      window.__counting = true;
      (function tick(){ if(!window.__counting) return; window.__frames++; requestAnimationFrame(tick); })();
      document.getElementById('qualitySelect').value = 'fast';
      document.getElementById('decodeBtn').click();
    })()`);

    let dec = null;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      dec = await cdp.evaluate(`(function(){
        var s = document.getElementById('decStatus');
        var c = document.getElementById('decCanvas');
        var d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        var set = new Set();
        for (var i=0;i<d.length;i+=4*211) set.add(d[i]+','+d[i+1]+','+d[i+2]);
        return {
          text: s.textContent,
          cls: s.className,
          meta: document.getElementById('decMeta').textContent,
          w: c.width, h: c.height,
          colours: set.size,
          progressHidden: document.getElementById('progressWrap').hidden,
          saveEnabled: !document.getElementById('savePngBtn').disabled
        };
      })()`);
      if (dec.cls.indexOf('err') >= 0 || /解码成功/.test(dec.text)) break;
    }
    check(/解码成功/.test(dec.text), 'AC4 decode reported success', dec.text.replace(/\s+/g, ' ').slice(0, 120));
    check(/Martin M1/.test(dec.meta), 'AC4 decoded mode identified', dec.meta);
    check(dec.w === 320 && dec.h === 256, 'AC4 decoded raster', dec.w + 'x' + dec.h);
    check(dec.colours > 10, 'AC4 decoded image is non-blank', dec.colours + ' sampled colours');
    check(dec.saveEnabled, 'AC4 save-PNG enabled');
    check(dec.progressHidden, 'AC4 progress hidden after completion');

    // AC5: the main thread kept painting while decoding.
    const frames = await cdp.evaluate(`(function(){ window.__counting = false; return window.__frames; })()`);
    check(frames > 20, 'AC5 main thread stayed responsive during decode',
      frames + ' animation frames rendered while decoding');

    // Fidelity of the REAL UI round trip: decoded raster vs the raster the app
    // encoded. Both canvases are the same size at this point.
    const ui = await cdp.evaluate(`(function(){
      function psnr(a, b) {
        var se = 0, n = 0;
        for (var i = 0; i < a.length; i++) { if (i % 4 === 3) continue; var x = a[i]-b[i]; se += x*x; n++; }
        var mse = se/n;
        return mse === 0 ? 999 : 10*Math.log10(65025/mse);
      }
      var dc = document.getElementById('decCanvas');
      var pc = document.getElementById('imgCanvas');
      var dec = dc.getContext('2d').getImageData(0,0,dc.width,dc.height);
      var enc = pc.getContext('2d').getImageData(0,0,pc.width,pc.height);
      return {
        sizes: dc.width + 'x' + dc.height + ' vs ' + pc.width + 'x' + pc.height,
        psnr: psnr(dec.data, enc.data),
        sampleDec: [dec.data[0], dec.data[(100*320+100)*4], dec.data[(100*320+200)*4]],
        sampleEnc: [enc.data[0], enc.data[(100*320+100)*4], enc.data[(100*320+200)*4]]
      };
    })()`);
    results.push('       UI round-trip fidelity ' + ui.psnr.toFixed(2) + ' dB (' + ui.sizes + ')');
    results.push('       samples dec=' + JSON.stringify(ui.sampleDec) + ' enc=' + JSON.stringify(ui.sampleEnc));
    check(ui.psnr > 20, 'AC2/AC4 UI round-trip fidelity (PSNR vs encoded raster)',
      ui.psnr.toFixed(2) + ' dB');

    // ---------- PD 120 encode through the UI (AC2/AC3 for the third mode) ----------
    await cdp.evaluate(`(function(){
      var s = document.getElementById('modeSelect');
      s.value = 'PD120';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(900);
    const pdPreview = await cdp.evaluate(`(function(){
      var c = document.getElementById('imgCanvas');
      return { w: c.width, h: c.height, dur: document.getElementById('durationReadout').textContent };
    })()`);
    check(pdPreview.w === 640 && pdPreview.h === 496, 'AC2 PD 120 preview raster', pdPreview.w + 'x' + pdPreview.h);

    await cdp.evaluate(`document.getElementById('encodeBtn').click()`);
    await waitFor(cdp, `/编码完成/.test(document.getElementById('encStatus').textContent)`, 25000);
    await waitFor(cdp, `document.getElementById('encAudio').duration > 0`, 15000);
    const pdState = await cdp.evaluate(`(function(){
      var a = document.getElementById('encAudio');
      return { status: document.getElementById('encStatus').textContent, duration: a.duration, src: a.src.slice(0,5) };
    })()`);
    check(/编码完成/.test(pdState.status) && /PD 120/.test(pdState.status), 'AC2 PD 120 encode succeeds');
    check(pdState.duration > 125 && pdState.duration < 129,
      'AC2 PD 120 duration correct (not doubled by the upstream length bug)',
      (pdState.duration || 0).toFixed(2) + 's');

    // ---------- AC10: the phase-2 diagnostics panel really drives the signal path ----------
    /*
     * The point is not that the panel renders - it is that toggling a switch changes
     * the RESULT. So the same payload is run twice, once over the clean channel and
     * once over the severe channel, and the outcomes must differ.
     */
    const runPanel = async (channel) => {
      // the mode must be one the decoder supports (the PD 120 block runs before this)
      await cdp.evaluate(`(function(){
        var m = document.getElementById('modeSelect');
        m.value = 'M1';
        m.dispatchEvent(new Event('change'));
      })()`);
      await waitFor(cdp, `document.getElementById('imgCanvas').width === 320`, 8000);
      await sleep(400);
      await cdp.evaluate(`(function(){
        document.getElementById('chanSelect').value = ${JSON.stringify(channel)};
        document.getElementById('fecSelect').value = 'rs223';
        document.getElementById('ilSelect').value = 'd32';
        document.getElementById('blockSelect').value = '16';
        document.getElementById('deltaSelect').value = '12';
        document.getElementById('payloadStatus').textContent = '';
        document.getElementById('payloadMetrics').hidden = true;
        document.getElementById('runPayloadBtn').click();
      })()`);
      let st = { text: '', cls: '', metricsVisible: false };
      for (let i = 0; i < 140; i++) {
        await sleep(500);
        st = await cdp.evaluate(`(function(){
          var s = document.getElementById('payloadStatus');
          return { text: s.textContent, cls: s.className,
                   metricsVisible: !document.getElementById('payloadMetrics').hidden,
                   metrics: document.getElementById('payloadMetrics').textContent };
        })()`);
        if (st.text && (st.metricsVisible || st.cls.indexOf('err') >= 0)) break;
      }
      const m = /BER（FEC 前）([0-9.e+-]+)/.exec(st.metrics || '');
      st.berPre = m ? parseFloat(m[1]) : null;
      return st;
    };

    const cleanRun = await runPanel('clean');
    check(cleanRun.metricsVisible, 'AC10 panel produced metrics over the clean channel');

    const severeRun = await runPanel('severe');
    check(severeRun.metricsVisible, 'AC10 panel produced metrics over the severe channel');
    check(cleanRun.berPre != null && severeRun.berPre != null && cleanRun.berPre < severeRun.berPre,
      'AC10 switching the channel changes the measured result (clean better than severe)',
      `clean BER ${cleanRun.berPre} vs severe BER ${severeRun.berPre}`);
    results.push('       clean panel: ' + (cleanRun.metrics || '').replace(/\s+/g, ' ').slice(0, 260));
    results.push('       severe panel: ' + (severeRun.metrics || '').replace(/\s+/g, ' ').slice(0, 260));

    const metricsText = severeRun.metrics || '';
    for (const field of ['BER（FEC 前）', 'BER（FEC 后）', 'RS 块正确率', '帧 CRC', '擦除率', '载荷图 PSNR', '接收端标定']) {
      check(metricsText.indexOf(field) >= 0, 'AC10 metric reported: ' + field);
    }
    check(/a=1\.0/.test(metricsText), 'AC10 receiver calibration estimate is displayed');

    // ---------- phase-4: pre-flight reliability prediction (AC6) ----------
    /*
     * The prediction box runs PayloadQIM.probe() on the raster the app is about to send and
     * must report the current B, the capacity, an estimated BER, and - when the image has
     * too many un-embeddable blocks - an explicit warning. The fixture is a high-contrast
     * bar pattern, exactly the class the content study found unsafe, so a warn/bad verdict
     * is the expected outcome here.
     */
    const pred = await cdp.evaluate(`(function(){
      var b = document.getElementById('predictBox');
      return { hidden: b.hidden, cls: b.className, text: b.textContent };
    })()`);
    check(!pred.hidden, 'AC6 prediction box is shown once an image is loaded');
    for (const field of ['载体块长 B', '载波容量', '可用载荷', '不可嵌入块', '预计 BER']) {
      check(pred.text.indexOf(field) >= 0, 'AC6 prediction reports: ' + field);
    }

    // select the phase-3 optimum explicitly (the AC10 block above left it at 16) and verify
    // the readout follows the selector rather than being hard-coded
    await cdp.evaluate(`(function(){
      var s = document.getElementById('blockSelect');
      s.value = '32'; s.dispatchEvent(new Event('change'));
    })()`);
    await sleep(500);
    const pred32 = await cdp.evaluate(`document.getElementById('predictBox').textContent`);
    check(/载体块长B32像素\/位/.test(pred32.replace(/\s+/g, '')), 'AC6 readout follows the block-size selector (B=32)',
      pred32.replace(/\s+/g, ' ').slice(0, 70));
    check(/可用载荷215B/.test(pred32.replace(/\s+/g, '')), 'AC6 capacity for B=32 is 215 B',
      pred32.replace(/\s+/g, ' ').slice(0, 90));

    const unreach = /不可嵌入块([0-9.]+)%/.exec(pred32);
    check(!!unreach, 'AC6 un-embeddable fraction is quantified', unreach ? unreach[0] : pred32.slice(0, 80));
    const predCls = await cdp.evaluate(`document.getElementById('predictBox').className`);
    check(predCls.indexOf('bad') >= 0 || predCls.indexOf('warn') >= 0,
      'AC6 high-contrast fixture is flagged as risky', 'class=' + predCls + ' ' + (unreach ? unreach[0] : ''));

    // and it must react to a parameter change
    await cdp.evaluate(`(function(){
      var s = document.getElementById('blockSelect');
      s.value = '16'; s.dispatchEvent(new Event('change'));
    })()`);
    await sleep(500);
    const pred16 = await cdp.evaluate(`document.getElementById('predictBox').textContent`);
    check(/载体块长B16像素\/位/.test(pred16.replace(/\s+/g, '')), 'AC6 prediction recomputed after the change');

    // ---------- robustness: other inputs through the same UI ----------
    const extra = [
      { file: fixtures.wavPath, label: 'externally produced Martin M1', expect: /解码成功/, mode: 'Martin M1' },
      // PD120 used to be encode-only; phase 7 added the PD scan model, so the UI must now
      // DECODE it rather than refuse it. The expectation is inverted deliberately.
      { file: path.join(ROOT, 'tests', 'out', 'enc_PD120.wav'), label: 'PD 120 audio (now decodable)',
        expect: /解码成功/, mode: 'PD 120' },
      // Phase 10 replaced the internal failure text with the plain-language map in js/app.js
      // (decodeErrorText), so the assertion follows the user-facing copy rather than the old
      // engineering message "未找到 SSTV 标定头".
      { file: path.join(FIX, 'noise.wav'), label: 'non-SSTV noise', expect: /没检测到信号/, mode: null }
    ];
    for (const t of extra) {
      if (!fs.existsSync(t.file)) { results.push('  SKIP ' + t.label + ' (fixture missing)'); continue; }
      const loaded = await loadWav(cdp, t.file);
      if (!loaded) { check(false, 'robustness: ' + t.label, 'file was not loaded into the decoder'); continue; }
      const st = await runDecode(cdp);
      check(t.expect.test(st.text), 'robustness: ' + t.label,
        st.text.replace(/\s+/g, ' ').slice(0, 110));
      if (t.mode) check(st.text.indexOf(t.mode) >= 0, 'robustness: detected ' + t.mode);
    }

    // ---------- console cleanliness ----------
    const errs = cdp.errors().filter((e) => !/favicon/i.test(e));
    check(errs.length === 0, 'no console/runtime errors during the whole flow',
      errs.length ? errs.join(' | ').slice(0, 400) : 'clean');

    console.log(results.join('\n'));
    console.log('\n=============================');
    console.log(failures === 0 ? 'BROWSER E2E: ALL CHECKS PASSED' : 'BROWSER E2E: ' + failures + ' CHECK(S) FAILED');
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.log(results.join('\n'));
    console.log('\nBROWSER E2E ERROR: ' + e.message);
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
}

main();
