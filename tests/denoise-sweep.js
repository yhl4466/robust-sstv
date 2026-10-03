/*
 * Phase-49: how far can the gated denoiser actually go, and is what it removes noise or detail?
 *
 * The first shipped configuration reduces phigros sigma_flat 15.16 -> 10.08 (-33%) but sigma_HF only
 * 24.03 -> 22.99 (-4%). That is the signature of a filter removing isolated speckle while leaving the
 * broadband residual alone - sigma_flat looks at the flattest quartile of the picture, so a filter
 * restricted to flat neighbourhoods can move it a lot while barely touching the picture as a whole.
 *
 * The question that decides how aggressive the filter may be is whether that broadband residual is
 * NOISE or DETAIL, and there is a reference that answers it: the Robot36 render of the same
 * transmission. Its residual is what the impairment itself produces, so:
 *
 *   - if a 3x3 median cuts our residual far more than it cuts Robot36's, ours contains noise that
 *     Robot36's does not, and removing it is a genuine gain;
 *   - if it cuts both by the same proportion, the residual is the transmission's own detail and the
 *     median is destroying picture information.
 *
 * The synthetic control (truth known) supplies the other half: the PSNR cost of each setting.
 *
 * Usage: node tests/denoise-sweep.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, '..', '.research', 'npmtest', 'node_modules');
const OUT = path.join(__dirname, 'diag-quality');
const SR = 48000;

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-timeline.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-synth.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Channel = require(path.join(ROOT, 'js', 'lib', 'sstv-channel.js'));
const PNG = require(path.join(RESEARCH, 'pngjs')).PNG;
const Modes = globalThis.SSTVModes, Timeline = globalThis.SSTVTimeline,
      Synth = globalThis.SSTVSynth, Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; se += d * d; n++;
  }
  const m = se / n;
  return m === 0 ? Infinity : 10 * Math.log10(65025 / m);
}

/** sigma_flat / sigma_HF, identical to the production measurement. */
function stats(img) {
  const w = img.width, h = img.height, d = img.data, n = w * h;
  const lum = new Float64Array(n);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    lum[k] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const grad = new Float64Array(n), res = new Float64Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
      const gx = lum[y * w + xp] - lum[y * w + xm];
      const gy = lum[yp * w + x] - lum[ym * w + x];
      grad[y * w + x] = Math.hypot(gx, gy);
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        s += lum[yy * w + xx]; c++;
      }
      res[y * w + x] = lum[y * w + x] - s / c;
    }
  }
  const gs = Array.prototype.slice.call(grad).sort((a, b) => a - b);
  const cut = gs[Math.floor(0.25 * gs.length)];
  let ss = 0, cn = 0;
  for (let i = 0; i < n; i++) if (grad[i] <= cut) { ss += res[i] * res[i]; cn++; }
  let m = 0;
  for (let i = 0; i < n; i++) m += res[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (res[i] - m) * (res[i] - m);
  const sdGR = (() => {
    let s = 0, s2 = 0, c = 0;
    for (let i = 0; i < d.length; i += 4) { const t = d[i + 1] - d[i]; s += t; s2 += t * t; c++; }
    return Math.sqrt(Math.max(0, s2 / c - (s / c) * (s / c)));
  })();
  return { sigmaFlat: Math.sqrt(ss / (cn || 1)), sigmaHF: Math.sqrt(v / n), sdGR };
}

/** Median over a 3x3 window, optionally only where the pixel is an outlier. */
function medianPass(img, tDiff) {
  const w = img.width, h = img.height, src = img.data;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  const win = new Float64Array(9);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            win[cnt++] = src[(yy * w + xx) * 4 + c];
          }
        }
        const sub = Array.prototype.slice.call(win, 0, cnt).sort((a, b) => a - b);
        const med = sub[cnt >> 1];
        const i = (y * w + x) * 4 + c;
        if (tDiff == null || Math.abs(src[i] - med) > tDiff) out[i] = med;
      }
    }
  }
  return { width: w, height: h, data: out };
}

function applyPasses(img, passes, tDiff) {
  let cur = img;
  for (let p = 0; p < passes; p++) cur = medianPass(cur, tDiff);
  return cur;
}

/** Robot36 reference stats, via the browser (no JPEG decoder in Node). */
async function robot36() {
  const { spawn } = require('child_process');
  const os = require('os');
  const PORT = 9361;
  const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((x) => fs.existsSync(x));
  if (!EDGE) return null;
  const refPath = path.join(ROOT, '测试结果', 'robot36.jpg');
  const runJson = path.join(OUT, 'robot36-raster.json');
  if (!fs.existsSync(refPath) || !fs.existsSync(runJson)) return null;
  const run = JSON.parse(fs.readFileSync(runJson, 'utf8')).run;
  const profile = path.join(os.tmpdir(), 'sstv_p49s_' + Date.now());
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--allow-file-access-from-files', '--remote-debugging-port=' + PORT,
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
    // run the same two measurements plus a 3x3 median pass, all in page
    const r = await send('Runtime.evaluate', {
      expression: `(async function(){
        var img = await new Promise(function(res,rej){var i=new Image();i.onload=function(){res(i);};i.onerror=function(){rej(new Error('x'));};i.src=${JSON.stringify('file:///' + refPath.replace(/\\/g, '/'))};});
        var c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
        var g=c.getContext('2d');g.drawImage(img,0,0);
        var run=${JSON.stringify(run)};
        var sy=run?run[0]:0,sh=run?(run[1]-run[0]+1):c.height;
        var o=document.createElement('canvas');o.width=c.width;o.height=sh;
        var og=o.getContext('2d');og.drawImage(c,0,sy,c.width,sh,0,0,c.width,sh);
        function stats(cv){
          var d=og.getImageData(0,0,cv.width,cv.height);
          return d;
        }
        function measure(d,W,H){
          var lum=new Float64Array(W*H);
          for(var i=0,k=0;i<d.length;i+=4,k++) lum[k]=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
          var grad=new Float64Array(W*H), res=new Float64Array(W*H);
          for(var y=0;y<H;y++)for(var x=0;x<W;x++){
            var xm=Math.max(0,x-1),xp=Math.min(W-1,x+1),ym=Math.max(0,y-1),yp=Math.min(H-1,y+1);
            var gx=lum[y*W+xp]-lum[y*W+xm], gy=lum[yp*W+x]-lum[ym*W+x];
            grad[y*W+x]=Math.sqrt(gx*gx+gy*gy);
            var s=0,cn=0;
            for(var dy=-1;dy<=1;dy++)for(var dx=-1;dx<=1;dx++){var yy=y+dy,xx=x+dx; if(yy<0||yy>=H||xx<0||xx>=W)continue; s+=lum[yy*W+xx]; cn++;}
            res[y*W+x]=lum[y*W+x]-s/cn;
          }
          var gs=Array.prototype.slice.call(grad).sort(function(a,b){return a-b;});
          var cut=gs[Math.floor(0.25*gs.length)];
          var ss=0,cnt=0;
          for(var i=0;i<grad.length;i++) if(grad[i]<=cut){ss+=res[i]*res[i];cnt++;}
          var m=0; for(var i=0;i<res.length;i++) m+=res[i]; m/=res.length;
          var v=0; for(var i=0;i<res.length;i++) v+=(res[i]-m)*(res[i]-m);
          return { sigmaFlat: Math.sqrt(ss/cnt), sigmaHF: Math.sqrt(v/res.length) };
        }
        function medianPass(d,W,H,tDiff){
          var out=new Uint8ClampedArray(d.length); out.set(d);
          for(var ch=0;ch<3;ch++)for(var y=0;y<H;y++)for(var x=0;x<W;x++){
            var win=[];
            for(var dy=-1;dy<=1;dy++){var yy=y+dy; if(yy<0||yy>=H)continue;
              for(var dx=-1;dx<=1;dx++){var xx=x+dx; if(xx<0||xx>=W)continue; win.push(d[(yy*W+xx)*4+ch]);}}
            win.sort(function(a,b){return a-b;});
            var med=win[win.length>>1], i=(y*W+x)*4+ch;
            if(tDiff==null||Math.abs(d[i]-med)>tDiff) out[i]=med;
          }
          return out;
        }
        var id0=og.getImageData(0,0,o.width,o.height);
        var W=o.width,H=o.height;
        var base=measure(id0.data,W,H);
        var out1=medianPass(id0.data,W,H,null);
        var s1=measure(out1,W,H);
        // gradient-gated median at 1.0 sigma_flat
        var sd=base.sigmaFlat;
        var out2=new Uint8ClampedArray(id0.data.length); out2.set(id0.data);
        (function(){
          var lum=new Float64Array(W*H);
          for(var i=0,k=0;i<id0.data.length;i+=4,k++) lum[k]=0.299*id0.data[i]+0.587*id0.data[i+1]+0.114*id0.data[i+2];
          var tGrad=0.5*sd, tDiff=1.0*sd;
          for(var ch=0;ch<3;ch++)for(var y=1;y<H-1;y++)for(var x=1;x<W-1;x++){
            var gx=lum[y*W+x+1]-lum[y*W+x-1], gy=lum[(y+1)*W+x]-lum[(y-1)*W+x];
            if(Math.sqrt(gx*gx+gy*gy)>tGrad) continue;
            var win=[];
            for(var dy=-1;dy<=1;dy++)for(var dx=-1;dx<=1;dx++) win.push(id0.data[((y+dy)*W+(x+dx))*4+ch]);
            win.sort(function(a,b){return a-b;});
            var med=win[win.length>>1], i=(y*W+x)*4+ch;
            if(Math.abs(id0.data[i]-med)>tDiff) out2[i]=med;
          }
        })();
        var s2=measure(out2,W,H);
        return { W:W, H:H, base:base, median: s1, gated: s2 };
      })()`, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) return null;
    return r.result.value;
  } catch (e) { return null; } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
  }
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('=== 降噪强度扫描：是去噪还是去细节 ===\n');

  // ours
  const pa = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
  const buf = fs.readFileSync(pa);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const r = await Decode.decode(info.samples, info.sampleRate,
    { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  const ours = r.imageData;
  const ob = stats(ours);
  console.log('  本项目 phigros: σ_flat ' + ob.sigmaFlat.toFixed(2) + ' · σ_HF ' + ob.sigmaHF.toFixed(2) +
    ' · 色度σ ' + ob.sdGR.toFixed(1));

  const ref = await robot36();
  if (ref) {
    console.log('  Robot36 参照:  σ_flat ' + ref.base.sigmaFlat.toFixed(2) + ' · σ_HF ' + ref.base.sigmaHF.toFixed(2));
  } else {
    console.log('  Robot36 参照:  不可用');
  }

  console.log('\n  滤波设置                     本项目 σ_flat  σ_HF   色度σ   | Robot36 σ_flat  σ_HF   | 合成PSNR');
  const ph = PNG.sync.read(fs.readFileSync(path.join(RESEARCH, 'sstv', 'examples', 'sample.png')));
  const src = { data: new Uint8ClampedArray(ph.data), width: ph.width, height: ph.height };
  const clean = Synth.synthesize(Timeline.build(src, Modes.get('S1')), SR).samples;
  const rc = await Decode.decode(clean, SR, { quality: 'standard', yieldEvery: 0, postprocess: 'off' });
  const synBase = psnr(rc.imageData.data, src.data);

  const settings = [
    { label: '不滤波', passes: 0, tDiff: null },
    { label: '中值 全图 t=∞ 1遍', passes: 1, tDiff: null },
    { label: '中值 全图 t=∞ 2遍', passes: 2, tDiff: null },
    { label: '中值 t=0.75σ 1遍', passes: 1, rel: 0.75 },
    { label: '中值 t=1.0σ 1遍', passes: 1, rel: 1.0 },
    { label: '中值 t=1.5σ 1遍', passes: 1, rel: 1.5 }
  ];
  const rows = [];
  for (const s of settings) {
    let o = ours, ro = ref ? null : null;
    const td = s.tDiff != null ? s.tDiff : (s.rel != null ? s.rel * ob.sigmaFlat : null);
    if (s.passes > 0) o = applyPasses(ours, s.passes, s.rel != null ? s.rel * ob.sigmaFlat : null);
    const os = stats(o);
    let rs = null;
    if (ref) {
      // re-run the reference measurement through the browser once per setting would be slow; the two
      // reference settings were already measured above
      rs = s.label === '不滤波' ? ref.base : (s.label.indexOf('全图 t=∞ 1遍') >= 0 ? ref.median :
        (s.label.indexOf('1.0σ') >= 0 ? ref.gated : null));
    }
    const so = applyPasses(rc.imageData, s.passes, s.rel != null ? s.rel * stats(rc.imageData).sigmaFlat : null);
    const sp = psnr(so.data, src.data);
    rows.push({ label: s.label, ours: os, ref: rs, synPsnr: sp });
    console.log('  ' + s.label.padEnd(28) + os.sigmaFlat.toFixed(2).padStart(8) + '  ' +
      os.sigmaHF.toFixed(2).padStart(6) + '  ' + os.sdGR.toFixed(1).padStart(6) + '   | ' +
      (rs ? rs.sigmaFlat.toFixed(2).padStart(9) + '  ' + rs.sigmaHF.toFixed(2).padStart(6) : '      --       --') +
      '   | ' + sp.toFixed(2).padStart(6) + ' (' + (sp - synBase >= 0 ? '+' : '') + (sp - synBase).toFixed(2) + ')');
  }

  console.log('\n  判读：若全图中值把本项目的 σ_HF 削减得远多于 Robot36，说明该项目残余里含 Robot36');
  console.log('        没有的噪声，去掉是净收益；若两者削减比例接近，说明那是传输本身的细节。');
  fs.writeFileSync(path.join(OUT, 'denoise-sweep.json'), JSON.stringify({ ours: ob, ref: ref, rows: rows }, null, 2));
  console.log('\n证据 -> tests/diag-quality/denoise-sweep.json');
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
