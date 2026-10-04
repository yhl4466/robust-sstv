/*
 * Why does SSTVDecode.decode return an empty object in demo-degradation.html?
 *
 * THE SYMPTOM: the page's own clean decode fails and the result object has NO own enumerable keys at all
 * (`keys=[]`, `JSON.stringify` gives `{}`), with no stage and no message - so the decoder is not returning
 * its usual failure shape. That is not a decode failure, it is the call not doing what it looks like.
 *
 * This asks the page directly, rather than guessing: what is SSTVDecode, is it the same object the page
 * loaded, what does decode look like, and what does a direct call return on hand-made input.
 *
 * Usage: node tests/diagnose-demo-decoder.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 9362;
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  if (!EDGE) { console.log('no chromium'); process.exitCode = 1; return; }
  const pageUrl = 'file:///' + path.join(ROOT, 'demo-degradation.html').replace(/\\/g, '/');
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--allow-file-access-from-files',
    '--window-size=1280,900', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'sstv_diag_' + Date.now()), pageUrl], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { /* not up */ }
    }
    if (!target) throw new Error('no devtools endpoint');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('ws')));
    });
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
    const send = (method, params) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout')); } }, 120000);
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
      return r.result.value;
    };
    await send('Runtime.enable');
    await sleep(6000);   // let the page run its init

    console.log('=== 页面内省 ===\n');
    console.log('SSTVDecode 存在        : ' + await ev('typeof globalThis.SSTVDecode'));
    console.log('SSTVDecode 键          : ' + JSON.stringify(await ev('Object.keys(globalThis.SSTVDecode||{})')));
    console.log('SSTVDecode.decode 类型 : ' + await ev('typeof (globalThis.SSTVDecode&&globalThis.SSTVDecode.decode)'));
    console.log('SSTVWav 存在           : ' + await ev('typeof globalThis.SSTVWav'));
    console.log('SSTVChannel 存在       : ' + await ev('typeof globalThis.SSTVChannel'));
    console.log('FFT 存在               : ' + await ev('typeof globalThis.FFT'));
    console.log('BASE_WAV_B64 长度      : ' + await ev('(typeof BASE_WAV_B64==="string")?BASE_WAV_B64.length:"(非字符串)"'));
    console.log('ROOM_IR_B64 长度       : ' + await ev('(typeof ROOM_IR_B64==="string")?ROOM_IR_B64.length:"(非字符串)"'));

    console.log('\n--- 用页面自己的样本直接调用 decode ---');
    const probe = await ev(`(function(){
      try {
        var bin = atob(BASE_WAV_B64);
        var bytes = new Uint8Array(bin.length);
        for (var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        var parsed = globalThis.SSTVWav.parse(bytes.buffer);
        var r = globalThis.SSTVDecode.decode(parsed.samples, parsed.sampleRate,
          { quality:'fast', yieldEvery:0, postprocess:'off' });
        var ks=[]; for (var k in r) ks.push(k);
        return { samples: parsed.samples.length, rate: parsed.sampleRate,
                 isNull: r===null, isUndef: r===undefined, typeofR: typeof r,
                 keys: ks, ok: (r&&r.ok), stage: (r&&r.stage), message: (r&&r.message),
                 ctor: (r&&r.constructor)?r.constructor.name:'?' };
      } catch(e) { return { threw: String(e && e.message || e), stack: String(e && e.stack || '').slice(0,400) }; }
    })()`);
    console.log(JSON.stringify(probe, null, 2));

    console.log('\n--- 短输入（应当给出明确的 stage）---');
    const short = await ev(`(function(){
      try {
        var x=new Float32Array(8000);
        var r=globalThis.SSTVDecode.decode(x,8000,{quality:'fast',yieldEvery:0});
        var ks=[]; for (var k in r) ks.push(k);
        return { keys: ks, ok:(r&&r.ok), stage:(r&&r.stage), message:(r&&r.message) };
      } catch(e){ return { threw: String(e && e.message || e) }; }
    })()`);
    console.log(JSON.stringify(short, null, 2));
  } catch (e) {
    console.error('diag failed: ' + (e && e.stack || e));
  } finally {
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    try { child.kill(); } catch (e) { /* ignore */ }
  }
})();
