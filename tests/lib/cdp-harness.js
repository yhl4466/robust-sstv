/*
 * Shared Chromium-over-CDP harness for the browser tests in this directory.
 *
 * WHY THIS MODULE EXISTS
 *   Three separate tests had each grown their own copy of "spawn Edge headless, poll /json/list, open a
 *   WebSocket, evaluate, screenshot, kill". Beyond the duplication, all three shared two real defects that
 *   only showed up in combination:
 *
 *   1. ORPHANED BROWSERS. `child.kill()` terminates the launched process, not the renderer/GPU children it
 *      spawned. After a few runs there were a dozen live msedge processes holding the debug ports, and the
 *      next run's browser silently ATTACHED TO A STALE INSTANCE instead of starting fresh - which showed up
 *      as a page rendering old content while the file on disk was correct. That is a nasty failure to debug,
 *      so cleanup now kills the whole process tree.
 *
 *   2. A HARD-CODED PORT PER TEST. With one port per test and no check that the port is free, a leftover
 *      browser from an earlier run owned the port and the new launch could not bind it.
 *
 * The harness therefore: picks a port, refuses to run if something already answers on it, launches with a
 * fresh user-data-dir, and kills the process tree (taskkill /T on Windows) in a finally block.
 *
 * Usage:
 *   const { launchBrowser } = require('./lib/cdp-harness.js');
 *   const b = await launchBrowser({ url: 'file:///...', port: 9361 });
 *   await b.evaluate('1+1'); await b.shoot('name.png'); b.close();
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function findBrowser() {
  return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is anything already listening on this port? */
function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

/** Kill a process AND its children. child.kill() alone leaves the renderer processes alive. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (e) { /* already gone */ }
}

/**
 * Launch a browser, open a page, and return a small CDP client.
 *
 * @param {{url:string, port:number, width?:number, height?:number, profileTag?:string}} opts
 * @returns {Promise<{evaluate, send, shoot, close, consoleErrors, target}>}
 */
async function launchBrowser(opts) {
  const exe = findBrowser();
  if (!exe) throw new Error('未找到 Chromium 浏览器（Edge/Chrome）');
  const port = opts.port;
  if (await portBusy(port)) {
    throw new Error('端口 ' + port + ' 已被占用（可能是上一次运行遗留的浏览器）。' +
      '请先结束残留进程，或换一个端口。');
  }
  const profile = path.join(os.tmpdir(), 'sstv_' + (opts.profileTag || 'cdp') + '_' + Date.now());
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--window-size=' + (opts.width || 1200) + ',' + (opts.height || 1400),
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    opts.url
  ], { stdio: 'ignore' });

  const consoleErrors = [];
  let ws = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    killTree(child.pid);
    // give the OS a moment so the next run's port check does not race the teardown
    try { execFileSync(process.platform === 'win32' ? 'cmd' : 'true',
      process.platform === 'win32' ? ['/c', 'exit'] : [], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  };

  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        // prefer a page whose URL matches what we asked for, so a stray blank tab is not picked
        target = list.find((t) => t.type === 'page' && t.url === opts.url)
              || list.find((t) => t.type === 'page' && t.url.indexOf(opts.matchHint || '\u0000') >= 0)
              || list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('调试端点未就绪');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
    });

    let id = 0;
    const pending = new Map();
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
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(i)) { pending.delete(i); rej(new Error('CDP 超时: ' + method)); }
      }, opts.timeoutMs || 300000);
    });

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      }
      return r.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');

    const shoot = async (outPath, clip) => {
      const r = await send('Page.captureScreenshot',
        { format: 'png', clip: clip, captureBeyondViewport: true });
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(r.data, 'base64'));
      return outPath;
    };

    return { send, evaluate, shoot, close, consoleErrors, target, sleep };
  } catch (e) {
    close();
    throw e;
  }
}

module.exports = { launchBrowser, findBrowser, sleep, portBusy, killTree };
