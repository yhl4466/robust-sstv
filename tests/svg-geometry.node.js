/*
 * Inline-SVG geometry audit for tech.html.
 *
 * Why a rendered measurement instead of parsing the markup: the six hand-authored figures
 * place <text> by hand, and the width of mixed Chinese/Latin text, of arrows and of full-width
 * punctuation cannot be predicted from the source. The static check in tech-html.test.js only
 * proves that coordinates are inside the viewBox; it cannot see that a label is wider than the
 * box drawn around it, or that two labels collide. Both problems only exist after layout.
 *
 * Five issue classes are detected, in VIEWBOX UNITS so the verdict does not depend on the
 * display scale:
 *   1 text-overflow  a <text> wider than the <rect> it sits in
 *   2 text-overlap   two <text> boxes intersect
 *   3 out-of-bounds  an element leaves the viewBox
 *   4 tight-margin   an element is closer than 10 units to a viewBox edge
 *   5 small-font     the rendered font size is below 10 px
 *
 * The CDP client is duplicated from tests/browser-e2e.js on purpose: that suite must not be
 * modified for this task. The debug port differs (9341 vs 9333) so both can run at once.
 *
 * Usage: node tests/svg-geometry.node.js [--no-shots]
 * Output: tests/svg-fixes/geometry-report.json, tests/svg-fixes/fig{1..10}.png
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUTDIR = path.join(__dirname, 'svg-fixes');
const PAGE = path.join(ROOT, 'tech.html');
const PORT = 9341;
const VIEWPORT_W = 1280;
const PAD = 14;                 // the padding the fix policy applies around every viewBox
const TIGHT = 10;               // a margin below this many units is flagged

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
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
        if (msg.error) reject(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
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
      }, 120000);
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

/*
 * The in-page measuring routine. Runs inside the browser, returns plain JSON.
 *
 * Every box is reported in two coordinate systems: `vb` (viewBox user units, obtained by
 * mapping the rendered client rect through the SVG root) and `local` (the element's own
 * getBBox, i.e. its local user space). The viewBox space is the primary basis because it
 * survives the rotate() transforms used by the generated figures' axis labels; the local space
 * is used to compare a <text> against the <rect> drawn around it, since those two share a
 * coordinate system whenever no transform sits between them.
 */
const MEASURE_FN = `(function () {
  var out = [];
  var svgs = Array.prototype.slice.call(document.querySelectorAll('svg'));
  for (var si = 0; si < svgs.length; si++) {
    var svg = svgs[si];
    var vb = svg.viewBox.baseVal;
    var root = svg.getBoundingClientRect();
    var scale = root.width / vb.width;
    var toVB = function (cx, cy) {
      return { x: vb.x + (cx - root.left) / scale, y: vb.y + (cy - root.top) / scale };
    };
    var els = [];
    var nodes = svg.querySelectorAll('*');
    for (var ni = 0; ni < nodes.length; ni++) {
      var el = nodes[ni];
      var tag = el.tagName.toLowerCase();
      if (tag === 'defs' || tag === 'title' || tag === 'desc' || tag === 'marker' ||
          tag === 'lineargradient' || tag === 'stop') continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      var tl = toVB(r.left, r.top), br = toVB(r.right, r.bottom);
      var box = { x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y),
                  w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) };
      var lb = null;
      try { var g = el.getBBox(); lb = { x: g.x, y: g.y, w: g.width, h: g.height }; } catch (e) {}
      var rec = { tag: tag, vb: box, local: lb, text: null, fontSize: null,
                  textAnchor: null, anchor: null, rotated: false };
      var tr = el.getAttribute('transform') || '';
      if (/rotate/.test(tr)) rec.rotated = true;
      if (tag === 'text') {
        rec.text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        var cs = getComputedStyle(el);
        rec.fontSize = parseFloat(cs.fontSize);
        rec.textAnchor = el.getAttribute('text-anchor') || 'start';
        var ax = parseFloat(el.getAttribute('x'));
        var ay = parseFloat(el.getAttribute('y'));
        if (isFinite(ax) && isFinite(ay)) rec.anchor = { x: ax, y: ay };
      }
      els.push(rec);
    }
    out.push({ viewBox: { x: vb.x, y: vb.y, w: vb.width, h: vb.height },
               groupId: svg.parentNode && svg.parentNode.id ? svg.parentNode.id : null,
               scale: scale, elements: els });
  }
  return { figures: out, clientWidth: document.documentElement.clientWidth,
           innerWidth: window.innerWidth };
})()`;

/** Turn one measured figure into a list of issues. */
function analyse(fig, idx) {
  const issues = [];
  const vb = fig.viewBox;
  const name = 'fig' + (idx + 1);
  const inVB = (b) => b.x >= vb.x - 0.5 && b.y >= vb.y - 0.5 &&
    b.x + b.w <= vb.x + vb.w + 0.5 && b.y + b.h <= vb.y + vb.h + 0.5;

  // (3) out of bounds -- the full-bleed background rect is by definition exactly the viewBox
  for (const e of fig.elements) {
    if (!inVB(e.vb)) {
      const over = [
        (vb.x - e.vb.x) > 0.5 ? 'left ' + (vb.x - e.vb.x).toFixed(1) : null,
        (e.vb.x + e.vb.w - (vb.x + vb.w)) > 0.5 ? 'right ' + (e.vb.x + e.vb.w - vb.x - vb.w).toFixed(1) : null,
        (vb.y - e.vb.y) > 0.5 ? 'top ' + (vb.y - e.vb.y).toFixed(1) : null,
        (e.vb.y + e.vb.h - (vb.y + vb.h)) > 0.5 ? 'bottom ' + (e.vb.y + e.vb.h - vb.y - vb.h).toFixed(1) : null
      ].filter(Boolean).join(', ');
      issues.push({ type: 'out-of-bounds', element: describe(e), detail: 'exceeds viewBox by ' + over + ' units' });
    }
  }

  // (4) tight margins -- exclude rects that cover most of the viewBox (the white background)
  const vbArea = vb.w * vb.h;
  let content = null;
  for (const e of fig.elements) {
    const isBackdrop = e.tag === 'rect' && (e.vb.w * e.vb.h) >= 0.9 * vbArea;
    if (isBackdrop) continue;
    content = content ? {
      x: Math.min(content.x, e.vb.x), y: Math.min(content.y, e.vb.y),
      r: Math.max(content.r, e.vb.x + e.vb.w), b: Math.max(content.b, e.vb.y + e.vb.h)
    } : { x: e.vb.x, y: e.vb.y, r: e.vb.x + e.vb.w, b: e.vb.y + e.vb.h };
    const d = {
      left: e.vb.x - vb.x, right: (vb.x + vb.w) - (e.vb.x + e.vb.w),
      top: e.vb.y - vb.y, bottom: (vb.y + vb.h) - (e.vb.y + e.vb.h)
    };
    const worst = Math.min(d.left, d.right, d.top, d.bottom);
    if (worst < TIGHT) {
      const edge = worst === d.left ? 'left' : worst === d.right ? 'right' : worst === d.top ? 'top' : 'bottom';
      issues.push({
        type: 'tight-margin', element: describe(e),
        detail: edge + ' margin ' + worst.toFixed(1) + ' units (< ' + TIGHT + ')',
        marginUnits: Number(worst.toFixed(1)), edge: edge
      });
    }
  }
  const margins = content ? {
    left: +(content.x - vb.x).toFixed(1), right: +((vb.x + vb.w) - content.r).toFixed(1),
    top: +(content.y - vb.y).toFixed(1), bottom: +((vb.y + vb.h) - content.b).toFixed(1)
  } : null;

  // (5) small fonts -- raw computed size, and the effective on-screen size
  for (const e of fig.elements) {
    if (e.tag !== 'text' || e.fontSize == null) continue;
    const effective = e.fontSize * fig.scale;
    if (effective < 10 - 1e-6) {
      issues.push({
        type: 'small-font', element: describe(e),
        detail: 'font ' + e.fontSize.toFixed(1) + ' px units -> ' + effective.toFixed(2) +
          ' px on screen (scale ' + fig.scale.toFixed(3) + ')',
        fontSize: e.fontSize, effectivePx: +effective.toFixed(2)
      });
    }
  }

  // (1) text overflowing the rect it sits in
  const rects = fig.elements
    .map((e, i) => ({ e: e, i: i }))
    .filter((o) => o.e.tag === 'rect' && (o.e.vb.w * o.e.vb.h) < 0.9 * vbArea && o.e.vb.h > 0);
  for (const e of fig.elements) {
    if (e.tag !== 'text' || !e.anchor) continue;
    // candidate containers: rects whose box contains the anchor point, smallest area wins
    let cand = null;
    for (const o of rects) {
      const r = o.e.vb;
      if (e.anchor.x < r.x || e.anchor.x > r.x + r.w || e.anchor.y < r.y || e.anchor.y > r.y + r.h) continue;
      if (r.h < e.vb.h * 1.2) continue;                 // ignore thin separator bars
      const area = r.w * r.h;
      if (!cand || area < cand.area) cand = { rect: r, area: area };
    }
    if (!cand) continue;
    const r = cand.rect;
    const overL = r.x - e.vb.x, overR = (e.vb.x + e.vb.w) - (r.x + r.w);
    const limit = 0.5;
    const bad = (e.textAnchor === 'middle' && (overL > limit || overR > limit)) ||
                (e.textAnchor === 'start' && overR > limit) ||
                (e.textAnchor === 'end' && overL > limit);
    if (bad) {
      issues.push({
        type: 'text-overflow', element: describe(e),
        detail: 'text is ' + e.vb.w.toFixed(1) + ' units wide in a ' + r.w.toFixed(1) +
          '-unit rect' + (overL > limit ? ' (left +' + overL.toFixed(1) + ')' : '') +
          (overR > limit ? ' (right +' + overR.toFixed(1) + ')' : ''),
        textWidth: +e.vb.w.toFixed(1), rectWidth: +r.w.toFixed(1),
        overflowLeft: +Math.max(0, overL).toFixed(1), overflowRight: +Math.max(0, overR).toFixed(1)
      });
    }
  }

  // (2) pairwise text overlap
  const texts = fig.elements.filter((e) => e.tag === 'text' && !e.rotated);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].vb, b = texts[j].vb;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0 && ox * oy > 4) {
        issues.push({
          type: 'text-overlap', element: describe(texts[i]) + '  <->  ' + describe(texts[j]),
          detail: 'boxes intersect over ' + (ox * oy).toFixed(0) + ' square units (' +
            ox.toFixed(1) + ' x ' + oy.toFixed(1) + ')',
          overlapArea: +(ox * oy).toFixed(0)
        });
      }
    }
  }

  const counts = { textOverflow: 0, textOverlap: 0, outOfBounds: 0, tightMargin: 0, smallFont: 0 };
  const key = { 'text-overflow': 'textOverflow', 'text-overlap': 'textOverlap',
    'out-of-bounds': 'outOfBounds', 'tight-margin': 'tightMargin', 'small-font': 'smallFont' };
  for (const it of issues) counts[key[it.type]]++;
  return { figureId: name, svgIndex: idx, viewBox: vb, scale: +fig.scale.toFixed(4),
    margins: margins, elementCount: fig.elements.length, issues: issues, counts: counts };
}
function describe(e) {
  const t = e.text ? ' "' + e.text.slice(0, 28) + (e.text.length > 28 ? '…' : '') + '"' : '';
  return '<' + e.tag + t + '> at (' + e.vb.x.toFixed(0) + ',' + e.vb.y.toFixed(0) + ')';
}

(async function main() {
  if (!fs.existsSync(PAGE)) { console.error('tech.html missing - run scripts/gen-tech-html.js'); process.exitCode = 1; return; }
  fs.mkdirSync(OUTDIR, { recursive: true });
  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.error('no Chromium browser found'); process.exitCode = 1; return; }

  // harness: the ten SVGs copied verbatim out of tech.html, laid out at natural width
  const html = fs.readFileSync(PAGE, 'utf8');
  const svgs = [...html.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map((m) => m[0]);
  /*
   * The expected count is DERIVED, not hardcoded. It used to be the literal 10, which made this
   * audit fail on itself the moment a figure was added - a tool that has to be edited whenever
   * the thing it measures changes is a tool that will silently stop being run.
   */
  const EXPECTED = svgs.length;
  const harness = path.join(OUTDIR, '_harness.html');
  fs.writeFileSync(harness, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>SVG geometry harness</title><style>
html,body{margin:0;padding:0;background:#fff}
div.fig{padding:16px}
svg{max-width:none!important;display:block}
</style></head><body>
${svgs.map((s, i) => `<div class="fig" id="fig${i + 1}">${s}</div>`).join('\n')}
</body></html>`, 'utf8');
  console.log(`harness: ${svgs.length} SVGs -> ${path.relative(ROOT, harness)}`);

  const profile = path.join(os.tmpdir(), 'sstv_svggeo_' + Date.now());
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    fileUrl(harness)
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.url.indexOf('_harness') >= 0)
              || list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('could not reach the DevTools endpoint');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('websocket error')));
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // A true 1280 px layout width is a precondition of the audit, so assert it.
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: VIEWPORT_W, height: 1400, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const width = await cdp.evaluate('document.documentElement.clientWidth');
    if (width !== VIEWPORT_W) throw new Error('layout width is ' + width + ', expected ' + VIEWPORT_W);

    /*
     * Wait for the document to actually carry the ten figures.
     *
     * A fixed sleep is not enough: Page.navigate resolves before the new document is parsed, and
     * an evaluate that lands in the transitional blank document returns zero SVGs - which then
     * makes every issue count zero and looks like a clean pass. That false green happened once,
     * so the count is now polled AND asserted.
     */
    const waitForSvgs = async (expected, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let n = 0;
      for (;;) {
        try { n = await cdp.evaluate('document.querySelectorAll("svg").length'); } catch (e) { n = -1; }
        if (n === expected) return n;
        if (Date.now() > deadline) return n;
        await sleep(200);
      }
    };

    // measure tech.html itself: that is the shipped artefact. Checks 1-4 are scale invariant
    // because they are evaluated in viewBox units; check 5 reports both units and real pixels.
    await cdp.send('Page.navigate', { url: fileUrl(PAGE) });
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: VIEWPORT_W, height: 1600, deviceScaleFactor: 1, mobile: false });
    const pageWidth = await cdp.evaluate('document.documentElement.clientWidth');
    if (pageWidth !== VIEWPORT_W) throw new Error('tech.html layout width is ' + pageWidth);
    const nSvg = await waitForSvgs(EXPECTED, 15000);
    if (nSvg !== EXPECTED) throw new Error('tech.html exposed ' + nSvg + ' SVGs, expected ' + EXPECTED);
    const measured = await cdp.evaluate(MEASURE_FN);
    if (!measured.figures || measured.figures.length !== EXPECTED) {
      throw new Error('measurement returned ' + ((measured.figures || []).length) + ' figures, expected ' + EXPECTED);
    }
    console.log(`tech.html measured: ${measured.figures.length} SVGs at ${pageWidth} px layout width, ` +
      `figure scale ${measured.figures[0].scale.toFixed(3)}\n`);

    const figures = measured.figures.map((f, i) => analyse(f, i));
    const totals = { textOverflow: 0, textOverlap: 0, outOfBounds: 0, tightMargin: 0, smallFont: 0 };
    for (const f of figures) for (const k of Object.keys(totals)) totals[k] += f.counts[k];
    const issueTotal = Object.values(totals).reduce((a, b) => a + b, 0);

    console.log('figure  scale   overflow overlap out-of-bounds tight small-font   margins L/R/T/B');
    for (const f of figures) {
      const m = f.margins || {};
      console.log(`  ${f.figureId.padEnd(6)} ${f.scale.toFixed(3)}  ${String(f.counts.textOverflow).padStart(7)} ` +
        `${String(f.counts.textOverlap).padStart(7)} ${String(f.counts.outOfBounds).padStart(12)} ` +
        `${String(f.counts.tightMargin).padStart(5)} ${String(f.counts.smallFont).padStart(10)}   ` +
        `${m.left}/${m.right}/${m.top}/${m.bottom}`);
    }
    console.log(`\ntotals: ${JSON.stringify(totals)}  ->  ${issueTotal} issue(s)`);

    // ---- screenshots from the harness, at natural size so text is legible when inspected
    if (!process.argv.includes('--no-shots')) {
      await cdp.send('Page.navigate', { url: fileUrl(harness) });
      const nHarness = await waitForSvgs(EXPECTED, 15000);
      if (nHarness !== EXPECTED) throw new Error('harness exposed ' + nHarness + ' SVGs, expected ' + EXPECTED);
      const pageH = await cdp.evaluate('document.documentElement.scrollHeight');
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: VIEWPORT_W, height: Math.min(pageH + 40, 12000), deviceScaleFactor: 1, mobile: false });
      await sleep(500);
      const rects = await cdp.evaluate(`(function(){
        return Array.prototype.map.call(document.querySelectorAll('div.fig'), function(d){
          var r = d.querySelector('svg').getBoundingClientRect();
          return { id: d.id, x: r.left, y: r.top, w: r.width, h: r.height,
                   scrollY: window.scrollY, viewBox: d.querySelector('svg').getAttribute('viewBox') };
        });
      })()`);
      for (const r of rects) {
        const shot = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.w + 16, height: r.h + 16, scale: 1 },
          captureBeyondViewport: true
        });
        const file = path.join(OUTDIR, r.id + '.png');
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(`  shot ${r.id}.png  ${Math.round(r.w)}x${Math.round(r.h)}  viewBox="${r.viewBox}"`);
      }
    }

    fs.writeFileSync(path.join(OUTDIR, 'geometry-report.json'), JSON.stringify({
      auditedAt: new Date().toISOString(),
      page: 'tech.html', viewportWidth: VIEWPORT_W, tightThreshold: TIGHT,
      plannedPadding: PAD, pageScaleAt1280: +(measured.figures[0].scale).toFixed(4),
      svgCount: figures.length, totals: totals, issueTotal: issueTotal, figures: figures
    }, null, 2));
    console.log('-> tests/svg-fixes/geometry-report.json');
    process.exitCode = issueTotal === 0 ? 0 : 1;
  } catch (e) {
    console.error('FAILED:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
  }
})();
