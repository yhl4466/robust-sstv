/*
 * Phase-49 diagnostics: (1) which stage loses the clock-error case, (2) what the phigros residual
 * actually is, spectrally.
 *
 * Part 1 - the degradation matrix found PSNR collapsing under sample-rate mismatch (30.50 -> 23.94 at
 * 0.2%, -> 17.26 at 1%) while the per-line sync lock stayed perfect (jitter 4-5 samples, detected clock
 * error exactly equal to the applied error) and the PSNR loss was UNIFORM across the scan. Neither a
 * lock problem nor an intra-line shear problem, so the loss is somewhere else in the pipeline. This
 * toggles the two stages that could be responsible - clock recovery and frequency calibration - to say
 * which.
 *
 * Part 2 - the residual on the real phigros recording. Before designing any denoiser, measure what the
 * noise is: is it row-coherent or column-coherent, high-frequency or low? Candidates are compared
 * against the reference Robot36 render of the same transmission, so "our noise" and "the impairment's
 * own noise" can be told apart.
 *
 * Usage: node tests/diagnose-phase49.js [--skip-matrix-diag] [--skip-phigros]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;
const ARGV = process.argv.slice(2);

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Channel = require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js'));
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;
let PNG = null;
try { PNG = require(path.join(RESEARCH, 'pngjs')).PNG; } catch (e) {}

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}

// ---- lifted from tests/degradation-matrix.js so both use one implementation ----
const MATRIX_SRC = fs.readFileSync(path.join(__dirname, 'degradation-matrix.js'), 'utf8');
const MODELS = (function () {
  const from = MATRIX_SRC.indexOf('function hilbertFIR');
  const to = MATRIX_SRC.indexOf('/** Decoder lock residuals');
  if (from < 0 || to <= from) throw new Error('could not locate the frequency-shift model');
  const code = MATRIX_SRC.slice(from, to);
  // eslint-disable-next-line no-new-func
  return new Function('SR', code + '\nreturn { hilbertFIR: hilbertFIR, freqShift: freqShift };')(SR);
})();
const freqShift = MODELS.freqShift;

// ---------------------------------------------------------------- part 1

async function part1() {
  console.log('=== 1. 时钟误差丢分在哪一级 ===\n');
  const mode = Modes.get('S1');
  const p = path.join(RESEARCH, 'sstv', 'examples', 'sample.png');
  if (!PNG || !fs.existsSync(p)) { console.log('缺少 pngjs 或 sample.png'); return; }
  const ph = PNG.sync.read(fs.readFileSync(p));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const tl = Timeline.build(img, mode);
  const clean = Synth.synthesize(tl, SR);

  const cases = [
    { label: 'clean（对照）', fn: (s) => s },
    { label: '0.2% 重采样', fn: (s) => Channel.Channel.freqOffset(s, 1.002) },
    { label: '1% 重采样', fn: (s) => Channel.Channel.freqOffset(s, 1.01) },
    { label: '+50 Hz 频偏', fn: (s) => Channel.Channel.freqOffset(s, 1 + 50 / 1900) }
  ];
  const settings = [
    { label: '默认（AFC + 时钟恢复）', opts: {} },
    { label: '关时钟恢复', opts: { clockRecovery: false } },
    { label: '关 AFC（原始轴）', opts: { afc: false } },
    { label: '两者都关', opts: { clockRecovery: false, afc: false } }
  ];

  console.log('  ' + '退化'.padEnd(16) + settings.map((s) => s.label.padStart(22)).join(''));
  const out = [];
  for (const c of cases) {
    const sig = c.fn(clean.samples);
    let line = '  ' + c.label.padEnd(16);
    const rec = { case: c.label, results: {} };
    for (const st of settings) {
      const r = await Decode.decode(sig, SR, Object.assign({ quality: 'standard', yieldEvery: 0 }, st.opts));
      const v = r.ok ? psnr(r.imageData.data, img.data) : null;
      rec.results[st.label] = v == null ? null : {
        psnr: v, clockScale: r.calibration.clockScale, a: r.calibration.scale, b: r.calibration.offsetHz
      };
      line += (v == null ? '  失败' : v.toFixed(2) + ' dB').padStart(22);
    }
    console.log(line);
    out.push(rec);
  }
  console.log('\n  （若"关时钟恢复"明显更好，说明时钟恢复在时钟误差下帮了倒忙；');
  console.log('   若四列都差，说明损失发生在重采样之后的解调，与这两个开关无关）\n');
  fs.writeFileSync(path.join(OUT, 'clock-error-diagnosis.json'), JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------- part 2

/**
 * Spectral and directional structure of an image's residual against a smooth local mean.
 *
 * The residual is the difference from a 3x3 box mean, which removes the low-frequency picture and
 * leaves what a denoiser would be asked to remove. Three directions are then measured by lag-1
 * autocorrelation of that residual: along x, along y, and along the main diagonal. A row-coherent
 * impairment (unstable sync per line) shows up along y; a pixel-clock/estimator impairment shows up
 * along x; white noise shows up in none.
 */
function residualStructure(img) {
  const w = img.width, h = img.height, d = img.data;
  const lum = new Float64Array(w * h);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    lum[k] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const res = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          s += lum[yy * w + xx]; n++;
        }
      }
      res[y * w + x] = lum[y * w + x] - s / n;
    }
  }
  let mean = 0;
  for (let i = 0; i < res.length; i++) mean += res[i];
  mean /= res.length;
  let v = 0;
  for (let i = 0; i < res.length; i++) v += (res[i] - mean) * (res[i] - mean);
  const sd = Math.sqrt(v / res.length);

  function lagCorr(dx, dy) {
    const a = [], b = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        a.push(res[y * w + x]); b.push(res[yy * w + xx]);
      }
    }
    const ma = a.reduce((s, t) => s + t, 0) / a.length;
    const mb = b.reduce((s, t) => s + t, 0) / b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const u = a[i] - ma, vv = b[i] - mb;
      num += u * vv; da += u * u; db += vv * vv;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  }

  /** Row-mean of the residual: a row-coherent impairment raises this far above sd/sqrt(w). */
  const rowMeans = [];
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += res[y * w + x];
    rowMeans.push(s / w);
  }
  const rm = rowMeans.reduce((s, t) => s + t, 0) / h;
  const sdRowMean = Math.sqrt(rowMeans.reduce((s, t) => s + (t - rm) * (t - rm), 0) / h);

  return {
    sd, lagX1: lagCorr(1, 0), lagX2: lagCorr(2, 0), lagX4: lagCorr(4, 0),
    lagY1: lagCorr(0, 1), lagY2: lagCorr(0, 2), lagY4: lagCorr(0, 4),
    lagD1: lagCorr(1, 1),
    rowMeanSd: sdRowMean, rowMeanSdVsNoise: sdRowMean / (sd / Math.sqrt(w)),
    greenSd: (() => {
      const g = [];
      for (let i = 1; i < d.length; i += 4) g.push(d[i]);
      const m = g.reduce((s, t) => s + t, 0) / g.length;
      return Math.sqrt(g.reduce((s, t) => s + (t - m) * (t - m), 0) / g.length);
    })()
  };
}

function chromaStruct(img) {
  const w = img.width, h = img.height, d = img.data;
  const gr = new Float64Array(w * h);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) gr[k] = d[i + 1] - d[i];
  let mean = 0;
  for (let i = 0; i < gr.length; i++) mean += gr[i];
  mean /= gr.length;
  function lag(dx, dy) {
    const a = [], b = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
      a.push(gr[y * w + x] - mean); b.push(gr[yy * w + xx] - mean);
    }
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += a[i] * b[i]; da += a[i] * a[i]; db += b[i] * b[i]; }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  }
  const sd = Math.sqrt(gr.reduce((s, t) => s + (t - mean) * (t - mean), 0) / gr.length);
  return { sd, lagX1: lag(1, 0), lagY1: lag(0, 1), lagY2: lag(0, 2), lagD1: lag(1, 1) };
}

async function part2() {
  console.log('=== 2. phigros 残留噪声的结构 ===\n');
  const audio = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  if (!fs.existsSync(audio)) { console.log('缺少 phigros 音频'); return; }
  const buf = fs.readFileSync(audio);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const dec = await Decode.decode(info.samples, info.sampleRate, { quality: 'standard', yieldEvery: 0 });
  if (!dec.ok) { console.log('phigros 解码失败: ' + dec.message); return; }
  const st = residualStructure(dec.imageData);
  const cs = chromaStruct(dec.imageData);

  console.log('  解码输出 320x256 · 亮度标准差 ' + st.greenSd.toFixed(1));
  console.log('  高通残差 σ_HF = ' + st.sd.toFixed(3) + ' 灰度级');
  console.log('');
  console.log('  残差的自相关（>0 表示结构化，噪声型退化趋 0）');
  console.log('    沿 x:  lag1 ' + st.lagX1.toFixed(4) + '  lag2 ' + st.lagX2.toFixed(4) +
              '  lag4 ' + st.lagX4.toFixed(4));
  console.log('    沿 y:  lag1 ' + st.lagY1.toFixed(4) + '  lag2 ' + st.lagY2.toFixed(4) +
              '  lag4 ' + st.lagY4.toFixed(4));
  console.log('    对角:  lag1 ' + st.lagD1.toFixed(4));
  console.log('    行均值 σ = ' + st.rowMeanSd.toFixed(3) + '（白噪声应约为 σ_HF/√320 = ' +
              (st.sd / Math.sqrt(320)).toFixed(3) + '，实测为其 ' + st.rowMeanSdVsNoise.toFixed(2) + ' 倍）');
  console.log('');
  console.log('  色度 G−R 结构: σ ' + cs.sd.toFixed(1) +
              ' · 沿x(lag1) ' + cs.lagX1.toFixed(3) + ' · 沿y(lag1) ' + cs.lagY1.toFixed(3) +
              ' · 沿y(lag2) ' + cs.lagY2.toFixed(3) + ' · 对角 ' + cs.lagD1.toFixed(3));

  // Robot36 reference, for the same measurements
  const refPath = path.join(ROOT, '测试结果', 'robot36.jpg');
  const refStats = await robot36Stats(refPath);
  if (refStats) {
    console.log('\n  Robot36 参照（同一段录音，App 输出）');
    console.log('    σ_HF ' + refStats.hf.sd.toFixed(3) +
                ' · 行均值 σ ' + refStats.hf.rowMeanSd.toFixed(3) +
                ' · 沿x(lag1) ' + refStats.hf.lagX1.toFixed(4) + ' · 沿y(lag1) ' + refStats.hf.lagY1.toFixed(4) +
                ' · 色度 σ ' + refStats.chroma.sd.toFixed(1) + ' 沿y(lag1) ' + refStats.chroma.lagY1.toFixed(3));
  }

  fs.writeFileSync(path.join(OUT, 'phigros-noise-structure.json'),
    JSON.stringify({ ours: { hf: st, chroma: cs }, robot36: refStats }, null, 2));
  console.log('\n证据 -> tests/diag-quality/phigros-noise-structure.json');
}

/** Robot36 stats, via the browser because Node here has no JPEG decoder. */
async function robot36Stats(refPath) {
  if (!fs.existsSync(refPath)) return null;
  const { spawn } = require('child_process');
  const os = require('os');
  const PORT = 9351;
  const EDGE = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ].find((x) => fs.existsSync(x));
  if (!EDGE) return null;
  const profile = path.join(os.tmpdir(), 'sstv_p49_' + Date.now());
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch (e) {}
      if (target) break;
    }
    if (!target) return null;
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    });
    const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout')); } }, 120000); });
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') });
    await sleep(2500);
    const r = await send('Runtime.evaluate', {
      expression: `(async function(){
        var img = await new Promise(function(res, rej){ var i=new Image(); i.onload=function(){res(i);}; i.onerror=function(){rej(new Error('x'));}; i.src=${JSON.stringify('file:///' + refPath.replace(/\\/g, '/'))}; });
        var c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
        var g=c.getContext('2d'); g.drawImage(img,0,0);
        var run=${JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, 'diag-quality', 'robot36-raster.json'), 'utf8')).run)};
        var sy=run?run[0]:0, sh=run?(run[1]-run[0]+1):c.height;
        var o=document.createElement('canvas'); o.width=c.width; o.height=sh;
        var og=o.getContext('2d'); og.drawImage(c,0,sy,c.width,sh,0,0,c.width,sh);
        var d=og.getImageData(0,0,o.width,o.height).data;
        var W=o.width,H=o.height;
        var lum=new Float64Array(W*H); for(var i=0,k=0;i<d.length;i+=4,k++) lum[k]=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
        var res=new Float64Array(W*H);
        for(var y=0;y<H;y++)for(var x=0;x<W;x++){var s=0,n=0;
          for(var dy=-1;dy<=1;dy++)for(var dx=-1;dx<=1;dx++){var yy=y+dy,xx=x+dx; if(yy<0||yy>=H||xx<0||xx>=W)continue; s+=lum[yy*W+xx]; n++;}
          res[y*W+x]=lum[y*W+x]-s/n;}
        var mean=0; for(var i=0;i<res.length;i++) mean+=res[i]; mean/=res.length;
        var v=0; for(var i=0;i<res.length;i++) v+=(res[i]-mean)*(res[i]-mean);
        var sd=Math.sqrt(v/res.length);
        function lag(dx,dy){var a=[],b=[];for(var y=0;y<H;y++)for(var x=0;x<W;x++){var xx=x+dx,yy=y+dy; if(xx<0||xx>=W||yy<0||yy>=H)continue; a.push(res[y*W+x]); b.push(res[yy*W+xx]);}
          var ma=0,mb=0; for(var i=0;i<a.length;i++){ma+=a[i];mb+=b[i];} ma/=a.length; mb/=b.length;
          var num=0,da=0,db=0; for(var i=0;i<a.length;i++){var u=a[i]-ma,vv=b[i]-mb; num+=u*vv; da+=u*u; db+=vv*vv;}
          return da>0&&db>0?num/Math.sqrt(da*db):0;}
        var rowMeans=[]; for(var y=0;y<H;y++){var s2=0; for(var x=0;x<W;x++) s2+=res[y*W+x]; rowMeans.push(s2/W);}
        var rm=0; for(var i=0;i<rowMeans.length;i++) rm+=rowMeans[i]; rm/=rowMeans.length;
        var srm=Math.sqrt(rowMeans.reduce(function(s,t){return s+(t-rm)*(t-rm);},0)/rowMeans.length);
        // chroma
        var gr=new Float64Array(W*H); for(var i=0,k=0;i<d.length;i+=4,k++) gr[k]=d[i+1]-d[i];
        var gm=0; for(var i=0;i<gr.length;i++) gm+=gr[i]; gm/=gr.length;
        var gv=0; for(var i=0;i<gr.length;i++) gv+=(gr[i]-gm)*(gr[i]-gm);
        var gsd=Math.sqrt(gv/gr.length);
        function clag(dx,dy){var a=[],b=[];for(var y=0;y<H;y++)for(var x=0;x<W;x++){var xx=x+dx,yy=y+dy; if(xx<0||xx>=W||yy<0||yy>=H)continue; a.push(gr[y*W+x]-gm); b.push(gr[yy*W+xx]-gm);}
          var num=0,da=0,db=0; for(var i=0;i<a.length;i++){num+=a[i]*b[i]; da+=a[i]*a[i]; db+=b[i]*b[i];}
          return da>0&&db>0?num/Math.sqrt(da*db):0;}
        return { W:W, H:H, hf:{ sd:sd, lagX1:lag(1,0), lagY1:lag(0,1), lagY2:lag(0,2), lagD1:lag(1,1), rowMeanSd:srm },
                 chroma:{ sd:gsd, lagX1:clag(1,0), lagY1:clag(0,1) } };
      })()`, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) return null;
    return r.result.value;
  } catch (e) { return null; } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
  }
}

async function part3() {
  console.log('\n=== 3. 频率误差到底破坏了哪一级 ===\n');
  const mode = Modes.get('S1');
  const p = path.join(RESEARCH, 'sstv', 'examples', 'sample.png');
  if (!PNG || !fs.existsSync(p)) { console.log('缺少 pngjs 或 sample.png'); return; }
  const ph = PNG.sync.read(fs.readFileSync(p));
  const img = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const tl = Timeline.build(img, mode);
  const clean = Synth.synthesize(tl, SR);
  const syncs = trueSyncsOf(tl);

  /*
   * Stage-by-stage readout under frequency shift. Four candidate stages, four measurements:
   *   - the header/VIS search (does it even find the picture? -> ok/decode failure)
   *   - the AFC calibration it derives (a, b): if `a` is wrong the whole nominal->raw mapping is wrong
   *   - the per-line sync lock: if the sync tracker is fine, the loss is NOT in timing
   *   - the pixel estimator's own frequency readout on known image content: this is the stage that a
   *     wrong frequency axis should damage directly, because the estimator searches a band placed by
   *     the calibration and its ~1 ms window cannot resolve a small offset on its own.
   */
  console.log('  频偏   ok    标定 a      b(Hz)   行锁抖动  像素频率误差中位   PSNR');
  const out = [];
  for (const hz of [0, 5, 10, 20, 30, 50, 80, 100]) {
    const sig = hz === 0 ? clean.samples : freqShift(clean.samples, hz);
    const refs = [];
    const r = await Decode.decode(sig, SR, { quality: 'standard', yieldEvery: 0, auditLineRefs: refs });
    if (!r.ok) {
      console.log('  ' + String(hz).padStart(4) + '   失败  ' + (r.message || '').slice(0, 40));
      out.push({ hz: hz, ok: false, message: r.message });
      continue;
    }
    const rs = residualStats(refs, syncs);
    const pe = pixelFreqError(clean.samples, sig);
    const ps = psnr(r.imageData.data, img.data);
    console.log('  ' + String(hz).padStart(4) + '   ok   ' +
      r.calibration.scale.toFixed(5).padStart(8) + '  ' +
      r.calibration.offsetHz.toFixed(1).padStart(7) + '   ' +
      (rs ? rs.jitterMAD.toFixed(1).padStart(6) : '   -- ') + '     ' +
      (pe == null ? '  --  ' : pe.toFixed(1).padStart(8)) + '       ' + ps.toFixed(2));
    out.push({ hz: hz, ok: true, a: r.calibration.scale, b: r.calibration.offsetHz,
      jitter: rs ? rs.jitterMAD : null, pixelFreqErr: pe, psnr: ps, clockScale: r.calibration.clockScale });
  }
  fs.writeFileSync(path.join(OUT, 'freq-error-stages.json'), JSON.stringify(out, null, 2));
  console.log('\n  证据 -> tests/diag-quality/freq-error-stages.json');
}

/**
 * How far a KNOWN tone's measured frequency moves when the signal is shifted.
 *
 * This is a direct readout of whether the estimator's frequency axis is right, using the same 2.5 ms
 * window discipline the pixel estimator uses (~1 ms is too short to show detail, but 2.5 ms keeps the
 * comparison honest about the bandwidth involved). It separates "the calibration is wrong" from "the
 * estimator cannot resolve the tone in its short window", which are different repairs.
 */
function pixelFreqError(clean, degraded) {
  const from = Math.round(0.7 * SR);           // well inside the image body of a 110 s signal
  const len = Math.round(0.0025 * SR);
  return dominant(degraded, from, len) - dominant(clean, from, len);
}

function dominant(x, off, len) {
  const N = 2048;
  const re = new Float32Array(N), o = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) re[i] = (x[off + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  new globalThis.FFT(N).realTransform(o, re);
  let best = -1, bk = 0;
  const k0 = Math.ceil(1000 * N / SR), k1 = Math.floor(2600 * N / SR);
  for (let k = k0; k <= k1; k++) {
    const m = Math.hypot(o[2 * k], o[2 * k + 1]);
    if (m > best) { best = m; bk = k; }
  }
  return bk * SR / N;
}

function trueSyncsOf(timeline) {
  const t = [];
  let acc = 0;
  for (let i = 0; i < timeline.segments.length; i++) {
    const s = timeline.segments[i];
    if (i >= timeline.headerSegments && s.kind === 'tone' && Math.abs(s.freq - Modes.FREQ_SYNC) < 1) t.push(acc);
    acc += s.dur;
  }
  return t.map((v) => v * SR);
}

function medianAbs(a) {
  if (!a.length) return null;
  const s = a.map((v) => Math.abs(v)).sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function residualStats(refs, syncs) {
  const locked = refs.filter((r) => !r.freeRun);
  if (locked.length < 8) return null;
  const N = locked.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += i; sy += locked[i].ref; sxx += i * i; sxy += i * locked[i].ref; }
  const den = N * sxx - sx * sx;
  if (!den) return null;
  const slope = (N * sxy - sx * sy) / den, inter = (sy - slope * sx) / N;
  const resid = locked.map((r, i) => r.ref - (inter + slope * i));
  const sorted = resid.slice().sort((a, b) => a - b);
  const bias = sorted[Math.floor(sorted.length / 2)];
  return { jitterMAD: medianAbs(resid.map((v) => v - bias)) };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!ARGV.includes('--skip-matrix-diag')) await part1();
  if (!ARGV.includes('--skip-phigros')) await part2();
  if (!ARGV.includes('--skip-stages')) await part3();
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
