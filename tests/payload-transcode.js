/*
 * Does the HIDDEN payload survive an audio transcode?
 *
 * The public image is ordinary SSTV and is known to survive (phase 17). The payload is different:
 * it is read from QUANTISED BLOCK MEANS in the image domain, so it does not need noise to break -
 * it needs the pixel grid to shift by even a fraction of a block, which is exactly what resampling
 * does. This script measures whether that fear is real, and where it breaks.
 *
 * Two independent passes, because they answer different questions:
 *
 *   Part 1 (Node)  ffmpeg transcode -> ffmpeg decode back to 48 kHz -> ImageExtract.extractImage.
 *                  Gives the numbers: RS codeword failures, pre-FEC bit error rate against the
 *                  native decode as ground truth, and the block-mean drift that causes it.
 *                  ffmpeg is a MODEL of the browser here, not the browser.
 *   Part 2 (UI)    the real extract-image.html, real file input, real button - confirms the UI
 *                  path wired up in phase 17 actually works, and that its verdict matches.
 *
 * Usage: node tests/payload-transcode.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const NATIVE = path.join(__dirname, 'downloads', 'sstv_hidden_M1.wav');
const WORK = path.join(__dirname, 'payload-samples');     // gitignored, rebuilt every run

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
const PORT = 9345;
const RATE = 48000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
const Wav = globalThis.SSTVWav;
const ImageExtract = require(path.join(ROOT, 'js', 'image-extract.js'));

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

/** Decode any container to mono 16-bit PCM at a known rate, so Node can read it. */
function toWav(ffmpeg, src, dst) {
  const r = spawnSync(ffmpeg, ['-y', '-i', src, '-ac', '1', '-ar', String(RATE),
    '-c:a', 'pcm_s16le', dst], { stdio: 'ignore' });
  return r.status === 0 && fs.existsSync(dst);
}

/** The four containers a phone, a chat app or a screen recorder would actually produce. */
function transcodeAll(ffmpeg) {
  const jobs = [
    ['m4a (AAC)', 'hidden.m4a', ['-c:a', 'aac', '-b:a', '192k']],
    ['mp3 (LAME)', 'hidden.mp3', ['-c:a', 'libmp3lame', '-b:a', '192k']],
    ['webm (Opus)', 'hidden.webm', ['-c:a', 'libopus', '-b:a', '128k']],
    ['ogg (Vorbis)', 'hidden.ogg', ['-c:a', 'libvorbis', '-q:a', '6']]
  ];
  const out = [];
  for (const [label, name, args] of jobs) {
    const dest = path.join(WORK, name);
    const r = spawnSync(ffmpeg, ['-y', '-i', NATIVE, ...args, dest], { stdio: 'ignore' });
    if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      /*
       * The decoded WAV name MUST keep the container extension. Stripping it collapsed all four
       * containers onto one path, so each decode overwrote the last and Part 1 analysed the same
       * file four times - which showed up as four identical BER/drift/PSNR numbers, a result too
       * tidy to be true.
       */
      const wav = path.join(WORK, name + '.decoded.wav');
      const ok = toWav(ffmpeg, dest, wav);
      out.push({ label, file: dest, decoded: ok ? wav : null, sizeKB: Math.round(fs.statSync(dest).size / 1024) });
    } else {
      out.push({ label, file: null, decoded: null, error: 'ffmpeg transcode failed' });
    }
  }
  return out;
}

/*
 * Stress group. The four default settings above are high quality (192k/128k); a phone screen
 * recording or a messaging app's voice note is often far lower, and a file that has been forwarded
 * twice is re-encoded twice. The point is not to make the feature fail but to find where it WOULD:
 * "it survives" is only useful alongside how much margin is left.
 */
function transcodeStress(ffmpeg) {
  const jobs = [
    ['m4a 32k', 'stress-aac32.m4a', ['-c:a', 'aac', '-b:a', '32k'], null],
    ['mp3 64k', 'stress-mp3-64.mp3', ['-c:a', 'libmp3lame', '-b:a', '64k'], null],
    ['webm 16k', 'stress-opus16.webm', ['-c:a', 'libopus', '-b:a', '16k'], null],
    ['ogg q0', 'stress-vorbis-q0.ogg', ['-c:a', 'libvorbis', '-q:a', '0'], null],
    ['m4a x2', 'stress-aac-x2.m4a', ['-c:a', 'aac', '-b:a', '192k'], 'double']
  ];
  const out = [];
  for (const [label, name, args, kind] of jobs) {
    const dest = path.join(WORK, name);
    let src = NATIVE, first = null;
    if (kind === 'double') {
      // forward once, decode back to PCM, then encode again - what a re-share actually does
      first = path.join(WORK, 'stress-pass1.m4a');
      spawnSync(ffmpeg, ['-y', '-i', NATIVE, '-c:a', 'aac', '-b:a', '192k', first], { stdio: 'ignore' });
      const pcm = path.join(WORK, 'stress-pass1.wav');
      if (toWav(ffmpeg, first, pcm)) src = pcm; else { out.push({ label, file: null, error: 'pass 1 failed' }); continue; }
    }
    const r = spawnSync(ffmpeg, ['-y', '-i', src, ...args, dest], { stdio: 'ignore' });
    if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 512) {
      const wav = path.join(WORK, name + '.decoded.wav');
      const ok = toWav(ffmpeg, dest, wav);
      out.push({ label, file: dest, decoded: ok ? wav : null, sizeKB: Math.round(fs.statSync(dest).size / 1024) });
    } else out.push({ label, file: null, error: 'transcode failed' });
  }
  return out;
}

// ---------------------------------------------------------------- measurements
function channel(img, c) { return c === 1 ? img.data : null; }

/** RGB PSNR between two decoded public images (alpha is constant, so it is skipped). */
function psnr(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let se = 0, count = 0;
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 3; c++) { const d = a.data[i + c] - b.data[i + c]; se += d * d; count++; }
  }
  const mse = se / count;
  return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}

/**
 * Mean absolute difference of block means. This is THE number that matters: the payload is
 * decided by which quantisation cell each block mean falls into, so a drift approaching half the
 * quantisation step (delta/2) is enough to flip bits.
 */
function blockMeanDrift(a, b, blockSize) {
  const w = a.width, h = a.height, bs = blockSize;
  let sum = 0, count = 0;
  for (let by = 0; by + bs <= h; by += bs) {
    for (let bx = 0; bx + bs <= w; bx += bs) {
      let ma = 0, mb = 0;
      for (let y = by; y < by + bs; y++) {
        for (let x = bx; x < bx + bs; x++) {
          const i = (y * w + x) * 4;
          ma += a.data[i + 1];          // green channel is the payload carrier
          mb += b.data[i + 1];
        }
      }
      const n = bs * bs;
      ma /= n; mb /= n;
      sum += Math.abs(ma - mb); count++;
    }
  }
  return { drift: sum / count, blocks: count };
}

function hamming(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return { diff: d, n };
}

/**
 * Map the pipeline's own stage/reason onto the four failure modes in the task description.
 */
function classify(res, stats) {
  if (res.ok && res.secretImage && !res.partial) return { code: 'OK', why: '公开图与秘密图均恢复' };
  if (!res.publicImage) {
    const m = /（([a-zA-Z]+)）/.exec(res.reason || '');
    const stage = m ? m[1] : (res.stage || '?');
    if (stage === 'findHeader') return { code: 'A', why: '标定头检测失败（解调前置，整张图解不出）' };
    if (stage === 'vis') return { code: 'B', why: 'VIS 识别失败' };
    return { code: 'A/B?', why: '解调失败，stage=' + stage };
  }
  if (res.partial) {
    return { code: 'C', why: '公开图正常，但数字边带帧校验（CRC）失败' };
  }
  if (res.secretImage) {
    return { code: 'D', why: '秘密图恢复但码字有失败' };
  }
  return { code: 'C/D?', why: 'stage=' + res.stage + ' reason=' + (res.reason || '') };
}

async function extractFrom(wavPath, quality) {
  const buf = fs.readFileSync(wavPath);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const t0 = Date.now();
  const res = await ImageExtract.extractImage(info.samples, info.sampleRate, {
    quality: quality || 'standard', yieldEvery: 0
  });
  const ms = Date.now() - t0;
  return { res, sampleRate: info.sampleRate, seconds: info.duration, ms, stats: res.stats || null };
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
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
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
  errors() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        out.push('exception: ' + (d.exception ? d.exception.description : d.text));
      }
    }
    return out;
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

function fileUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

/** Part 2: drive the real page for one file and report what the UI says. */
async function uiExtract(cdp, file) {
  const base = path.basename(file);
  await cdp.evaluate(`document.getElementById('status').textContent = ''; true`);
  const r = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('#wavInput')` });
  await cdp.send('DOM.setFileInputFiles', { files: [file], objectId: r.result.objectId });
  await cdp.evaluate(`document.getElementById('wavInput').dispatchEvent(new Event('change'))`);
  const loaded = await waitFor(cdp,
    `document.getElementById('status').textContent.indexOf(${JSON.stringify(base)}) >= 0 ||` +
    `document.getElementById('status').className.indexOf('err') >= 0`, 60000);
  if (!loaded) return { base, verdict: 'load-timeout', text: 'never loaded' };
  const afterLoad = await cdp.evaluate(`document.getElementById('status').textContent`);
  if (/已载入/.test(afterLoad) === false) {
    return { base, verdict: 'load-error', text: afterLoad.replace(/\s+/g, ' ').slice(0, 120) };
  }
  await cdp.evaluate(`document.getElementById('extractBtn').click()`);
  const done = await waitFor(cdp, `(function(){
    var t = document.getElementById('status').textContent;
    return /提取成功/.test(t) || /秘密图未能恢复/.test(t) || /提取失败/.test(t) || /提取异常/.test(t);
  })()`, 300000);
  const text = await cdp.evaluate(`document.getElementById('status').textContent`);
  const dims = await cdp.evaluate(`(function(){
    var p = document.getElementById('publicCanvas'), s = document.getElementById('secretCanvas');
    return { pub: p.width + 'x' + p.height, sec: s.width + 'x' + s.height };
  })()`);
  let verdict = 'unknown';
  if (/提取成功/.test(text)) verdict = 'OK';
  else if (/秘密图未能恢复/.test(text)) verdict = 'C';
  else if (/提取失败/.test(text)) verdict = 'A/B';
  return { base, verdict, text: text.replace(/\s+/g, ' ').slice(0, 150), dims, done };
}

// ---------------------------------------------------------------- main
async function main() {
  if (!fs.existsSync(NATIVE)) {
    console.log('missing ' + path.relative(ROOT, NATIVE) + ' - run node tests/image-pages-e2e.js first');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(WORK, { recursive: true });

  console.log('=== Part 1: Node quantitative analysis ===\n');
  console.log('reference (native WAV)');
  const native = await extractFrom(NATIVE);
  const nres = native.res, nstats = native.stats;
  console.log('  ' + Math.round(fs.statSync(NATIVE).size / 1024) + ' KB · ' + native.sampleRate + ' Hz · ' +
    native.seconds.toFixed(2) + ' s · ' + (native.ms / 1000).toFixed(1) + ' s to decode');
  console.log('  stage=' + nres.stage + ' ok=' + nres.ok + ' partial=' + !!nres.partial);
  if (nstats) {
    console.log('  codewords ' + nstats.codewordsOk + '/' + nstats.codewords + ' ok, ' +
      nstats.codewordsFailed + ' failed; bitErasureRate ' + nstats.bitErasureRate.toFixed(4));
  }
  console.log('  public image ' + (nres.publicImage ? nres.publicImage.width + 'x' + nres.publicImage.height : 'NONE'));
  console.log('  secret image ' + (nres.secretImage ? nres.secretImage.width + 'x' + nres.secretImage.height : 'NONE') +
    '  meta=' + JSON.stringify(nres.secretMeta && { success: nres.secretMeta.success, reason: nres.secretMeta.reason }));
  if (!nres.secretImage) {
    console.log('\n  !! the NATIVE file does not yield the payload, so it cannot serve as ground truth.');
    console.log('     reason: ' + nres.reason);
  }

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) { console.log('\nffmpeg not found; cannot transcode.'); process.exitCode = 1; return; }
  console.log('\ntranscoding + decoding back to WAV@48k');
  const jobs = transcodeAll(ffmpeg).concat(transcodeStress(ffmpeg));
  for (const j of jobs) {
    console.log('  ' + j.label.padEnd(14) + (j.file ? j.sizeKB + ' KB' : 'FAILED') +
      (j.decoded ? '  -> ' + path.basename(j.decoded) : ''));
  }

  const rows = [];
  for (const j of jobs) {
    if (!j.decoded) { rows.push({ label: j.label, error: 'no decoded wav' }); continue; }
    const got = await extractFrom(j.decoded);
    const res = got.res, stats = got.stats;
    const row = {
      label: j.label, base: path.basename(j.file), sizeKB: j.sizeKB, stage: res.stage, ok: res.ok,
      partial: !!res.partial, reason: res.reason, ms: got.ms, decodedWav: path.basename(j.decoded),
      publicImage: !!res.publicImage, secretImage: !!res.secretImage,
      secretReason: (res.secretMeta && res.secretMeta.reason) || '',
      stats: stats, mode: classify(res, stats)
    };
    if (stats && nstats && nstats.rawBits && stats.rawBits) {
      const h = hamming(nstats.rawBits, stats.rawBits);
      row.preFecBer = h.diff / h.n;
      row.bitDiffs = h.diff;
      row.bitTotal = h.n;
      /*
       * WHERE the flips are matters more than how many. The carrier is 255 B (2040 bits) but the
       * payload is only ~215 B, so the tail is unused padding: damage confined there is harmless
       * and means the payload itself arrived untouched, which is a very different finding from
       * damage the RS decoder had to repair.
       */
      row.diffIndices = [];
      for (let i = 0; i < h.n; i++) if (nstats.rawBits[i] !== stats.rawBits[i]) row.diffIndices.push(i);
    }
    if (res.publicImage && nres.publicImage) {
      row.psnr = psnr(nres.publicImage, res.publicImage);
      row.drift = blockMeanDrift(nres.publicImage, res.publicImage, 32);
    }
    // is the recovered secret image EXACTLY the one the native WAV yields?
    if (res.secretImage && nres.secretImage) {
      const a = nres.secretImage.data, b = res.secretImage.data;
      let same = a.length === b.length, diffs = 0;
      if (same) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
      row.secretIdentical = same && diffs === 0;
      row.secretDiffBytes = same ? diffs : -1;
    }
    rows.push(row);
  }

  console.log('\n--- per-format results ---');
  const hdr = ['format', 'stage', 'public', 'secret', 'cwFail/cw', 'preFEC BER', 'drift(Δ/2=6)', 'PSNR'];
  console.log('  ' + hdr[0].padEnd(14) + hdr[1].padEnd(12) + hdr[2].padEnd(8) + hdr[3].padEnd(8) +
    hdr[4].padEnd(11) + hdr[5].padEnd(12) + hdr[6].padEnd(15) + hdr[7]);
  for (const r of rows) {
    if (r.error) { console.log('  ' + r.label.padEnd(14) + r.error); continue; }
    const cw = r.stats ? (r.stats.codewordsFailed + '/' + r.stats.codewords) : '-';
    console.log('  ' + r.label.padEnd(14) + String(r.stage).padEnd(12) +
      (r.publicImage ? 'yes' : 'NO').padEnd(8) + (r.secretImage ? 'yes' : 'NO').padEnd(8) +
      cw.padEnd(11) +
      (r.preFecBer == null ? '-' : (r.preFecBer * 100).toFixed(3) + '%').padEnd(12) +
      (r.drift ? r.drift.drift.toFixed(2) : '-').padEnd(15) +
      (r.psnr == null ? '-' : (r.psnr === Infinity ? 'inf' : r.psnr.toFixed(2) + ' dB')));
  }
  console.log('\n--- carrier geometry (decides whether FEC even ran) ---');
  if (nstats) {
    console.log('  native: carrierBits ' + nstats.carrierBits + ' · bitsUsed ' + nstats.bitsUsed +
      ' · codewords ' + nstats.codewords + ' · depth ' + nstats.depth +
      ' · nsym ' + (nstats.config && nstats.config.nsym) +
      ' · erasureBudget ' + nstats.erasureBudget);
  }

  console.log('\n--- failure modes ---');
  for (const r of rows) {
    if (r.error) continue;
    console.log('  ' + r.label.padEnd(14) + '[' + r.mode.code + '] ' + r.mode.why);
    if (r.reason) console.log('        reason: ' + String(r.reason).slice(0, 110));
    if (r.stats) {
      console.log('        codewords ' + r.stats.codewordsOk + '/' + r.stats.codewords +
        ' ok · nsym ' + (r.stats.config && r.stats.config.nsym) +
        ' · erasuresUsed ' + r.stats.erasuresUsed + '/budget ' + r.stats.erasureBudget +
        ' · bitErasureRate ' + r.stats.bitErasureRate.toFixed(4) +
        ' · byteErasureRate ' + r.stats.byteErasureRate.toFixed(4));
      if (r.bitDiffs != null) {
        console.log('        pre-FEC hard-decision diffs vs native: ' + r.bitDiffs + '/' + r.bitTotal +
          ' bits  (' + (r.preFecBer * 100).toFixed(3) + '%)');
        console.log('        flip positions: [' + r.diffIndices.join(', ') + ']' +
          '   (carrier ends at bit ' + (r.bitTotal - 1) + ')');
      }
    }
    if (r.drift) console.log('        block-mean drift ' + r.drift.drift.toFixed(3) +
      ' grey levels over ' + r.drift.blocks + ' blocks   (decision margin Δ/2 = 6)');
    if (r.secretIdentical !== undefined) {
      console.log('        secret image vs native: ' +
        (r.secretIdentical ? 'BYTE-IDENTICAL' : r.secretDiffBytes + ' differing bytes'));
    }
  }

  // ------------------------------------------------------------ evidence artifact
  /*
   * Written because the numbers, not the console scrollback, are the deliverable. rawBits/softBits
   * (2040 entries each) are dropped: they are working data, not findings.
   */
  const slim = (r) => {
    if (r.error) return { label: r.label, error: r.error };
    const s = r.stats ? {
      carrierBits: r.stats.carrierBits, bitsUsed: r.stats.bitsUsed, codewords: r.stats.codewords,
      codewordsOk: r.stats.codewordsOk, codewordsFailed: r.stats.codewordsFailed,
      depth: r.stats.depth, nsym: r.stats.config && r.stats.config.nsym,
      erasureBudget: r.stats.erasureBudget, erasuresUsed: r.stats.erasuresUsed,
      bitErasureRate: r.stats.bitErasureRate, byteErasureRate: r.stats.byteErasureRate
    } : null;
    return {
      label: r.label, file: r.base, sizeKB: r.sizeKB, stage: r.stage, ok: r.ok, partial: !!r.partial,
      failureMode: r.mode.code, failureWhy: r.mode.why, reason: r.reason || '',
      publicImage: r.publicImage, secretImage: r.secretImage, secretReason: r.secretReason,
      secretIdenticalToNative: r.secretIdentical, secretDiffBytes: r.secretDiffBytes,
      preFecBitErrors: r.bitDiffs, preFecBitTotal: r.bitTotal,
      preFecBer: r.preFecBer == null ? null : +r.preFecBer.toFixed(6),
      flipPositions: r.diffIndices || null,
      blockMeanDrift: r.drift ? +r.drift.drift.toFixed(4) : null,
      driftVsMarginRatio: r.drift ? +(r.drift.drift / 6).toFixed(4) : null,
      publicPsnrDb: r.psnr == null ? null : (r.psnr === Infinity ? null : +r.psnr.toFixed(2)),
      decodeSeconds: +(r.ms / 1000).toFixed(2), stats: s
    };
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    source: path.relative(ROOT, NATIVE).replace(/\\/g, '/'),
    quantizationDelta: 32 && 12,          // image-extract DEFAULTS.delta
    decisionMarginHalfDelta: 6,
    native: {
      sampleRate: native.sampleRate, seconds: +native.seconds.toFixed(4),
      stage: nres.stage, codewords: nstats && nstats.codewords,
      codewordsOk: nstats && nstats.codewordsOk, nsym: nstats && nstats.config && nstats.config.nsym,
      secretImage: !!nres.secretImage
    },
    results: rows.map(slim)
  };
  fs.writeFileSync(path.join(WORK, 'payload-transcode.json'), JSON.stringify(artifact, null, 2));
  console.log('\nevidence -> ' + path.relative(ROOT, path.join(WORK, 'payload-transcode.json')));

  // ------------------------------------------------------------ Part 2: real UI
  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('\nno Chromium found; Part 2 skipped'); return; }
  console.log('\n=== Part 2: real extract-image.html, real upload ===\n');

  const profile = path.join(os.tmpdir(), 'sstv_payload_' + Date.now());
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    fileUrl(path.join(ROOT, 'extract-image.html'))
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && /extract-image/.test(t.url)) || list.find((t) => t.type === 'page');
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
    const ready = await waitFor(cdp, 'window.SSTVDecoder && window.ImageExtract');
    console.log('  page ready: ' + ready);

    const uiRows = [];
    for (const r of rows) {
      if (r.error) continue;
      const j = jobs.find((x) => x.label === r.label);
      if (!j || !j.file) continue;
      const u = await uiExtract(cdp, j.file);
      uiRows.push(u);
      console.log('  ' + u.base.padEnd(14) + 'verdict ' + u.verdict.padEnd(12) +
        'dims pub=' + (u.dims ? u.dims.pub : '?') + ' sec=' + (u.dims ? u.dims.sec : '?'));
      console.log('        ' + u.text);
    }
    console.log('\n--- Part 1 vs Part 2 agreement ---');
    let agree = 0, total = 0;
    for (const u of uiRows) {
      const r = rows.find((x) => x.base === u.base);
      if (!r) continue;
      total++;
      const match = r.mode.code === u.verdict || (r.mode.code === 'C/D?' && u.verdict === 'C');
      if (match) agree++;
      console.log('  ' + u.base.padEnd(14) + 'node=' + r.mode.code.padEnd(6) + 'ui=' + u.verdict.padEnd(6) +
        (match ? 'agree' : 'DISAGREE'));
    }
    console.log('  ' + agree + '/' + total + ' agree');
    const errs = cdp.errors();
    console.log('  page exceptions: ' + (errs.length ? errs.slice(0, 2).join(' | ') : 'none'));
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    child.kill();
  }
}

main().catch((e) => { console.error('harness error: ' + (e && e.stack || e)); process.exitCode = 1; });
