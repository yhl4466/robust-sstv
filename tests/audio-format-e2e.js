/*
 * Audio format compatibility end-to-end test (DevTools Protocol, file://).
 *
 * Proves the format layer against REAL container files, not synthetic buffers: ffmpeg transcodes a
 * known-good SSTV WAV into M4A / MP3 / OGG / WebM / MP4, and each one is uploaded through the real
 * <input type="file"> in index.html and decoded by the real UI.
 *
 *   [A] WAV still takes the strict native-rate path, and creates NO AudioContext
 *   [B] each transcoded container decodes to the same mode as the WAV
 *   [C] the error cases are distinguishable (unknown / decode failure / truncated / oversize)
 *   [D] exactly ONE AudioContext is created for all of them
 *   [E] a low-rate WAV warns about the PD family without disabling decoding
 *
 * ffmpeg is optional: without it the transcoded cases report as skipped rather than passing.
 * No npm dependencies - Node 22+ has global fetch and WebSocket.
 *
 * Usage: node tests/audio-format-e2e.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const SAMPLES = path.join(__dirname, 'audio-samples');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const FFMPEG_CANDIDATES = [
  'C:\\Users\\xuyang\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe',
  'ffmpeg'
];
const PORT = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures
function buildFixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  fs.mkdirSync(SAMPLES, { recursive: true });

  require(path.join(ROOT, 'js', 'lib', 'fft.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
  require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
  require(path.join(ROOT, 'js', 'lib', 'wav.js'));
  const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
        Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav;

  const mode = Modes.get('M1');
  const img = { data: new Uint8ClampedArray(mode.width * mode.height * 4),
    width: mode.width, height: mode.height };
  const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
    [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
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
  const full = path.join(FIX, 'fmt_m1.wav');
  fs.writeFileSync(full, Wav.encode(Synth.synthesize(tl, 48000).samples, 48000));

  // An 8 kHz copy: M1 tops out at 2300 Hz, so this is alias-free, and it is the only realistic way
  // to reach the low-rate warning - the transcode path resamples to the AudioContext rate instead.
  const low = path.join(FIX, 'fmt_m1_8k.wav');
  fs.writeFileSync(low, Wav.encode(Synth.synthesize(tl, 8000).samples, 8000));

  // error fixtures
  const f = (n) => path.join(FIX, n);
  fs.writeFileSync(f('fmt_garbage.bin'), Buffer.from('this is definitely not audio, not even close. '.repeat(64)));
  fs.writeFileSync(f('fmt_empty.wav'), Buffer.alloc(0));
  // a RIFF/WAVE header with no chunks: passes the magic test, fails the strict parser
  fs.writeFileSync(f('fmt_truncated.wav'),
    Buffer.concat([Buffer.from('RIFF'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('WAVE')]));
  // a plausible Ogg header with garbage payload: the browser decoder must reject it
  const junk = Buffer.alloc(32768);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff;
  fs.writeFileSync(f('fmt_bad.ogg'), Buffer.concat([Buffer.from('OggS'), junk]));
  // a sparse 101 MB file: logical size trips the guard, no real allocation
  const big = f('fmt_toobig.m4a');
  const fd = fs.openSync(big, 'w');
  fs.writeSync(fd, Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]));
  fs.ftruncateSync(fd, 101 * 1024 * 1024);
  fs.closeSync(fd);

  return { wav: full, wav8k: low };
}

function findFfmpeg() {
  for (const c of FFMPEG_CANDIDATES) {
    if (c === 'ffmpeg') {
      const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      if (!r.error && r.status === 0) return 'ffmpeg';
      continue;
    }
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Transcode the reference WAV into the containers a phone or a chat app would produce. */
function transcode(ffmpeg, wav) {
  const jobs = [
    ['m1.m4a', ['-c:a', 'aac', '-b:a', '192k']],
    ['m1.mp3', ['-c:a', 'libmp3lame', '-b:a', '192k']],
    ['m1.ogg', ['-c:a', 'libvorbis', '-q:a', '6']],
    ['m1.webm', ['-c:a', 'libopus', '-b:a', '128k']],
    ['m1.mp4', ['-c:a', 'aac', '-b:a', '192k', '-vn']]
  ];
  const out = [];
  for (const [name, args] of jobs) {
    const dest = path.join(SAMPLES, name);
    const r = spawnSync(ffmpeg, ['-y', '-i', wav, ...args, dest], { stdio: 'ignore' });
    if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 1024) out.push(dest);
    else console.log('  !! ffmpeg failed for ' + name);
  }
  return out;
}

// ---------------------------------------------------------------- CDP client
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
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
  errors() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        out.push('exception: ' + (d.exception ? d.exception.description : d.text));
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.push('console.error: ' + e.params.args.map((a) => a.value || a.description || '').join(' '));
      }
    }
    return out;
  }
}

async function waitFor(cdp, expr, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  for (;;) {
    try { if (await cdp.evaluate('!!(' + expr + ')')) return true; } catch (e) { /* navigating */ }
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

async function upload(cdp, file) {
  const base = path.basename(file);
  await cdp.evaluate(`document.getElementById('decStatus').textContent = ''; true`);
  const r = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#wavInput')` });
  await cdp.send('DOM.setFileInputFiles', { files: [file], objectId: r.result.objectId });
  await cdp.evaluate(`document.getElementById('wavInput').dispatchEvent(new Event('change'))`);
  // wait until the status names THIS file, or reports an error for it
  const ok = await waitFor(cdp,
    `document.getElementById('decStatus').textContent.indexOf(${JSON.stringify(base)}) >= 0 ||` +
    `document.getElementById('decStatus').className.indexOf('err') >= 0`, 30000);
  return { ok, base };
}

async function statusText(cdp) {
  return cdp.evaluate(`document.getElementById('decStatus').textContent`);
}

async function decodeNow(cdp) {
  await cdp.evaluate(`(function(){
    var q = document.getElementById('qualitySelect'); if (q) q.value = 'fast';
    document.getElementById('decodeBtn').click();
  })()`);
  let st = { text: '', busy: true };
  for (let i = 0; i < 300; i++) {
    await sleep(400);
    st = await cdp.evaluate(`(function(){
      var s = document.getElementById('decStatus');
      return { text: s.textContent, busy: !document.getElementById('cancelBtn').disabled,
               meta: document.getElementById('decMeta').textContent };
    })()`);
    if (!st.busy) break;
  }
  return st;
}

// ---------------------------------------------------------------- runner
let failures = 0, skipped = 0;
function check(ok, label, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
}
function skip(label, why) { skipped++; console.log(`  SKIP ${label}  ${why}`); }

function fileUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('No Chromium browser found; skipping.'); return; }

  console.log('fixtures');
  const fx = buildFixtures();
  console.log('  ' + path.relative(ROOT, fx.wav) + '  ' + Math.round(fs.statSync(fx.wav).size / 1024) + ' KB');
  console.log('  ' + path.relative(ROOT, fx.wav8k) + '  ' + Math.round(fs.statSync(fx.wav8k).size / 1024) + ' KB');

  const ffmpeg = findFfmpeg();
  let transcoded = [];
  if (ffmpeg) {
    console.log('\ntranscoding with ffmpeg');
    transcoded = transcode(ffmpeg, fx.wav);
    for (const t of transcoded) {
      console.log('  ' + path.basename(t).padEnd(10) + Math.round(fs.statSync(t).size / 1024) + ' KB');
    }
  } else {
    console.log('\nffmpeg not found - transcode cases will be skipped');
  }

  const profile = path.join(os.tmpdir(), 'sstv_fmt_' + Date.now());
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

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
    if (!target) throw new Error('no DevTools endpoint');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('ws error')));
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /*
     * Count AudioContext constructions from before the page's own scripts run. Injected now and
     * then navigated to, because addScriptToEvaluateOnNewDocument only applies to later loads.
     */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        window.__ctxCreations = 0;
        var Orig = window.AudioContext || window.webkitAudioContext;
        if (!Orig) return;
        function Counted(){ window.__ctxCreations++; return new Orig(); }
        Counted.prototype = Orig.prototype;
        window.AudioContext = Counted;
      })();`
    });

    await cdp.send('Page.navigate', { url: fileUrl(path.join(ROOT, 'index.html')) });
    const ready = await waitFor(cdp, 'window.SSTVDecoder && window.SSTVAudioInput');
    check(ready, 'page loaded with the format layer present');
    if (!ready) throw new Error('page never became ready');

    // ------------------------------------------------------------ [A] WAV path
    console.log('\n[A] WAV keeps the strict native-rate path');
    const acc = await cdp.evaluate(`document.getElementById('wavInput').getAttribute('accept')`);
    check(/video\/\*/.test(acc) && /\.mp4/.test(acc) && /\.mov/.test(acc) && /\.webm/.test(acc) && /audio\/\*/.test(acc),
      'the file picker accepts video containers too (phone screen recordings)');
    const accRes = await upload(cdp, fx.wav);
    let st = await statusText(cdp);
    check(accRes.ok && /WAV/.test(st) && /原生采样率/.test(st), 'WAV is reported as native, not transcoded',
      st.replace(/\s+/g, ' ').slice(0, 68));
    check(/48000 Hz/.test(st), 'WAV sample rate is the file\'s own 48000 Hz');
    let cre = await cdp.evaluate('window.__ctxCreations');
    check(cre === 0, 'WAV path creates NO AudioContext', 'creations=' + cre);
    let dec = await decodeNow(cdp);
    check(/解码成功/.test(dec.text) && /Martin M1/.test(dec.text),
      'WAV decodes to Martin M1', (dec.meta || '').slice(0, 40));

    // ------------------------------------------------------------ [B] transcodes
    console.log('\n[B] transcoded containers decode to the same mode');
    if (!transcoded.length) {
      skip('M4A / MP3 / OGG / WebM / MP4', ffmpeg ? 'no outputs' : 'ffmpeg unavailable');
    }
    for (const file of transcoded) {
      const name = path.basename(file);
      const up = await upload(cdp, file);
      const s = await statusText(cdp);
      if (!up.ok) { check(false, name + ' parsed', s.replace(/\s+/g, ' ').slice(0, 70)); continue; }
      check(/已转码/.test(s), name + ' reported as transcoded', s.replace(/\s+/g, ' ').slice(0, 60));
      const d = await decodeNow(cdp);
      check(/解码成功/.test(d.text) && /Martin M1/.test(d.text),
        name + ' decodes to Martin M1', (d.meta || '').slice(0, 40));
    }
    cre = await cdp.evaluate('window.__ctxCreations');
    check(cre === 1, 'all transcodes together created exactly ONE AudioContext', 'creations=' + cre);

    // ------------------------------------------------------------ [C] errors
    console.log('\n[C] the error cases are distinguishable');
    await upload(cdp, path.join(FIX, 'fmt_garbage.bin'));
    st = await statusText(cdp);
    check(/无法识别/.test(st), 'unknown magic -> "无法识别的音频格式"', st.replace(/\s+/g, ' ').slice(0, 60));
    await upload(cdp, path.join(FIX, 'fmt_bad.ogg'));
    st = await statusText(cdp);
    check(/解码失败/.test(st), 'undecodable payload -> "音频解码失败"', st.replace(/\s+/g, ' ').slice(0, 60));
    await upload(cdp, path.join(FIX, 'fmt_empty.wav'));
    st = await statusText(cdp);
    check(/截断|损坏/.test(st), 'zero-byte file -> "音频被截断或损坏"', st.replace(/\s+/g, ' ').slice(0, 60));
    await upload(cdp, path.join(FIX, 'fmt_truncated.wav'));
    st = await statusText(cdp);
    check(/截断|损坏/.test(st), 'headerless RIFF/WAVE -> "音频被截断或损坏"', st.replace(/\s+/g, ' ').slice(0, 60));
    const btnAfterErr = await cdp.evaluate(`document.getElementById('decodeBtn').disabled`);
    check(btnAfterErr === true, 'a failed load leaves the decode button disabled');
    await upload(cdp, path.join(FIX, 'fmt_toobig.m4a'));
    st = await statusText(cdp);
    check(/文件过大/.test(st), 'oversize file -> size guard message', st.replace(/\s+/g, ' ').slice(0, 60));

    // ------------------------------------------------------------ [E] low rate warning
    console.log('\n[E] low sample rate warns about the PD family without blocking');
    await upload(cdp, fx.wav8k);
    st = await statusText(cdp);
    check(/8000 Hz/.test(st), 'the 8 kHz file reports its own rate');
    check(/PD120/.test(st) && /PD180/.test(st) && /16 kHz/.test(st),
      'the warning names PD120 / PD180 and the 16 kHz threshold', st.replace(/\s+/g, ' ').slice(-70));
    const btn8k = await cdp.evaluate(`document.getElementById('decodeBtn').disabled`);
    check(btn8k === false, 'decoding is NOT blocked by the warning');

    // ------------------------------------------------------------ [F] clean console
    console.log('\n[F] page health');
    const errs = cdp.errors();
    check(errs.length === 0, 'no uncaught page exceptions', errs.slice(0, 2).join(' | ') || 'clean');

  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    child.kill();
  }

  console.log(`\n${failures === 0 ? 'AUDIO FORMAT E2E: ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}` +
    (skipped ? `  (${skipped} skipped)` : ''));
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('harness error: ' + (e && e.stack || e)); process.exitCode = 1; });
