/*
 * tech.html verdict suite: structure, geometry and writing style.
 *
 * The geometry pass is a static equivalent of the browser measurement: every geometric
 * primitive inside every inline SVG is checked against that SVG's own viewBox, so an element
 * that would be clipped or pushed outside the frame is caught without rendering. A companion
 * browser pass (in browser-e2e.js) measures the same page at 1280 px for horizontal overflow,
 * which covers the layout-level case that static parsing cannot see.
 *
 * Usage: node tests/tech-html.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'tech.html');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '   ' + detail : '')); }
}

if (!fs.existsSync(FILE)) {
  console.log('FAIL tech.html does not exist - run scripts/gen-tech-html.js');
  process.exitCode = 1;
} else {
  const html = fs.readFileSync(FILE, 'utf8');
  console.log('=== tech.html static checks ===\n');

  // ------------------------------------------------------------------ structure
  console.log('[A] structure');
  const h2 = (html.match(/<h2>/g) || []).length;
  const svgs = (html.match(/<svg\b/g) || []).length;
  const tables = (html.match(/<table\b/g) || []).length;
  ok(h2 >= 10, 'at least 10 chapters (h2)', h2 + ' h2');
  /*
   * The floor was raised from 10 to 13 when the three mechanism demonstrations were added
   * (AFC offset, clock recovery, interleaving). Keeping it a floor rather than an equality lets
   * a figure be added without editing this line, while the continuity check below still catches
   * a figure that was inserted but never numbered.
   */
  ok(svgs >= 13, 'at least 13 inline SVG figures', svgs + ' svg');
  ok(tables >= 10, 'at least 10 tables', tables + ' table');
  const refs = (html.match(/<li>\[\d+\]/g) || []).length;
  ok(refs >= 5, 'at least 5 references', refs + ' entries');
  ok(/<section class="abstract"/.test(html) || /<section[^>]*id="abstract"/.test(html), 'abstract section present');
  const tocNav = /<title>/.test(html) && /<meta name="description"/.test(html);
  ok(tocNav, 'title and meta description present');

  // ------------------------------------------------------------------ figure / table numbering
  console.log('\n[B] numbering continuity');
  const figNums = [...html.matchAll(/图\s*(\d+)：/g)].map((m) => +m[1]);
  const uniqFig = [...new Set(figNums)].sort((a, b) => a - b);
  const figSeq = uniqFig.length >= 10 && uniqFig.every((v, i) => v === i + 1);
  ok(figSeq, 'figure numbers are continuous from 1', uniqFig.join(','));

  /*
   * Every in-text "图 N" must name a figure that exists. This is the check that catches a
   * renumbering that updated the captions but missed a cross-reference (or vice versa), which is
   * the failure mode the numbering work is actually exposed to.
   */
  const figText = html.replace(/<figcaption[\s\S]*?<\/figcaption>/g, ' ');
  const refNums = [...new Set([...figText.matchAll(/图\s*(\d+)/g)].map((m) => +m[1]))].sort((a, b) => a - b);
  const dangling = refNums.filter((n) => !uniqFig.includes(n));
  ok(dangling.length === 0, 'every in-text figure reference names an existing figure',
    dangling.length ? 'dangling: 图 ' + dangling.join(', ') : refNums.length + ' distinct reference(s), all valid');

  /*
   * Figures are inlined, so their FILE NAMES never appear in tech.html - comparing against the
   * HTML cannot work. The generator declares what it produced in scripts/out/paper-figures.json,
   * so the directory is compared against that declaration instead. This catches a rename that
   * left the old file behind (which the generator now also cleans up, and this asserts it did).
   */
  const figDir = path.join(ROOT, 'tests', 'paper-figures');
  const manifestPath = path.join(ROOT, 'scripts', 'out', 'paper-figures.json');
  if (!fs.existsSync(figDir) || !fs.existsSync(manifestPath)) {
    ok(false, 'figure directory and generation manifest are both present',
      fs.existsSync(figDir) ? 'manifest missing' : 'directory missing');
  } else {
    const declared = Object.values(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).figures || {})
      .map((f) => path.basename(f.file));
    const onDisk = fs.readdirSync(figDir).filter((f) => /^fig\d+.*\.svg$/i.test(f));
    const stray = onDisk.filter((f) => !declared.includes(f));
    const missing = declared.filter((f) => !onDisk.includes(f));
    ok(stray.length === 0 && missing.length === 0,
      'the figure directory matches exactly what the generator declared',
      (stray.length ? 'stray: ' + stray.join(', ') + '  ' : '') +
      (missing.length ? 'missing: ' + missing.join(', ') : '') ||
      declared.length + ' file(s), no strays');
  }
  const tblNums = [...html.matchAll(/<caption>表\s*(\d+)/g)].map((m) => +m[1]);
  const uniqTbl = [...new Set(tblNums)].sort((a, b) => a - b);
  const tblSeq = uniqTbl.length >= 10 && uniqTbl.every((v, i) => v === i + 1);
  ok(tblSeq, 'table numbers are continuous from 1', uniqTbl.join(','));

  // ------------------------------------------------------------------ svg accessibility + geometry
  console.log('\n[C] SVG title/desc/font-size/geometry');
  const svgBlocks = [...html.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map((m) => m[0]);
  ok(svgBlocks.length === svgs, 'every <svg> was parsed as a complete block', svgBlocks.length + '/' + svgs);

  let missingTitle = 0, missingDesc = 0, smallFont = 0, oversize = 0, outOfBox = 0;
  const fontSizes = [];
  const badDetail = [];

  for (const [si, svg] of svgBlocks.entries()) {
    const idm = svg.match(/<title>([\s\S]*?)<\/title>/);
    const ddm = svg.match(/<desc>([\s\S]*?)<\/desc>/);
    if (!idm || !idm[1].trim()) missingTitle++;
    if (!ddm || !ddm[1].trim()) missingDesc++;

    const vb = svg.match(/viewBox="([\d.\-\s]+)"/);
    if (!vb) { outOfBox++; badDetail.push('svg#' + (si + 1) + ' has no viewBox'); continue; }
    const [vx, vy, vw, vh] = vb[1].trim().split(/\s+/).map(Number);
    const wAttr = svg.match(/\bwidth="(\d+)"/);
    if (wAttr && Number(wAttr[1]) > 1280) { oversize++; badDetail.push('svg#' + (si + 1) + ' width ' + wAttr[1]); }

    const eps = 0.75;                       // allow sub-pixel rounding in generated figures
    const bad = (msg) => { outOfBox++; if (badDetail.length < 14) badDetail.push('svg#' + (si + 1) + ': ' + msg); };

    for (const m of svg.matchAll(/<rect\b[^>]*>/g)) {
      const g = (k) => { const x = m[0].match(new RegExp(k + '="([\\d.eE+-]+)"')); return x ? Number(x[1]) : null; };
      const x = g('x'), y = g('y'), w = g('width'), h = g('height');
      if (x == null || y == null || w == null || h == null) continue;
      if (x < vx - eps || y < vy - eps || x + w > vx + vw + eps || y + h > vy + vh + eps) {
        bad(`rect (${x},${y},${w}x${h}) outside viewBox ${vw}x${vh}`);
      }
    }
    for (const m of svg.matchAll(/<(circle|ellipse)\b[^>]*>/g)) {
      const g = (k) => { const x = m[0].match(new RegExp(k + '="([\\d.eE+-]+)"')); return x ? Number(x[1]) : null; };
      const cx = g('cx'), cy = g('cy'), r = g('r');
      if (cx == null || cy == null || r == null) continue;
      if (cx - r < vx - eps || cx + r > vx + vw + eps || cy - r < vy - eps || cy + r > vy + vh + eps) {
        bad(`${m[1]} centre (${cx},${cy}) r=${r} outside viewBox`);
      }
    }
    for (const m of svg.matchAll(/<line\b[^>]*>/g)) {
      const g = (k) => { const x = m[0].match(new RegExp(k + '="([\\d.eE+-]+)"')); return x ? Number(x[1]) : null; };
      const pts = [[g('x1'), g('y1')], [g('x2'), g('y2')]];
      for (const [px, py] of pts) {
        if (px == null || py == null) continue;
        if (px < vx - eps || px > vx + vw + eps || py < vy - eps || py > vy + vh + eps) {
          bad(`line endpoint (${px},${py}) outside viewBox`);
        }
      }
    }
    for (const m of svg.matchAll(/<polyline\b[^>]*points="([^"]+)"/g)) {
      for (const pair of m[1].trim().split(/\s+/)) {
        const [px, py] = pair.split(',').map(Number);
        if (!isFinite(px) || !isFinite(py)) continue;
        if (px < vx - eps || px > vx + vw + eps || py < vy - eps || py > vy + vh + eps) {
          bad(`polyline point (${px},${py}) outside viewBox`);
        }
      }
    }
    for (const m of svg.matchAll(/<text\b[^>]*>/g)) {
      const g = (k) => { const x = m[0].match(new RegExp(k + '="([\\d.eE+-]+)"')); return x ? Number(x[1]) : null; };
      const x = g('x'), y = g('y');
      if (x == null || y == null) continue;
      if (x < vx - eps || x > vx + vw + eps || y < vy - eps || y > vy + vh + eps) {
        bad(`text anchor (${x},${y}) outside viewBox`);
      }
    }
    for (const m of svg.matchAll(/font-size="([\d.]+)"/g)) {
      const v = Number(m[1]);
      fontSizes.push(v);
      if (v < 10) smallFont++;
    }
  }
  ok(missingTitle === 0, 'every SVG has a non-empty <title>', missingTitle ? missingTitle + ' missing' : svgBlocks.length + '/' + svgBlocks.length);
  ok(missingDesc === 0, 'every SVG has a non-empty <desc>', missingDesc ? missingDesc + ' missing' : svgBlocks.length + '/' + svgBlocks.length);
  ok(oversize === 0, 'no SVG declares a width above 1280 px', oversize ? oversize + ' oversized' : 'max ' + Math.max(...svgBlocks.map((s) => Number((s.match(/\bwidth="(\d+)"/) || [0, 0])[1]))) + ' px');
  ok(smallFont === 0, 'no font-size below 10', 'min ' + Math.min(...fontSizes) + ', ' + fontSizes.length + ' declarations');
  ok(outOfBox === 0, 'every geometric primitive lies inside its viewBox (1280 px safety)',
    outOfBox ? outOfBox + ' violations' : svgBlocks.length + ' SVGs clean');
  if (badDetail.length) for (const d of badDetail) console.log('       ' + d);

  // ------------------------------------------------------------------ external resources + style
  console.log('\n[D] no external resources, writing style');
  // no capture group in this pattern, so the match itself is m[0] (m[1] is undefined)
  const urls = [...html.matchAll(/https?:\/\/[^"'\s)<>]+/g)].map((m) => m[0]);
  /*
   * The SVG namespace URI (http://www.w3.org/2000/svg) is an XML identifier, not a resource:
   * it is required for inline SVG and is never dereferenced. Excluding it is not a loophole,
   * because the separate check below rejects any element that would actually FETCH something
   * (script/img/link/iframe with a remote src or href).
   */
  const namespaceOnly = (u) => /^https?:\/\/www\.w3\.org\//.test(u);
  const nonGithub = urls.filter((u) => !/^https?:\/\/(www\.)?github\.com\//.test(u) && !namespaceOnly(u));
  ok(nonGithub.length === 0, 'no external URLs other than GitHub references',
    urls.length ? urls.length + ' URL(s): ' + urls.filter(namespaceOnly).length + ' SVG namespace, ' +
      nonGithub.length + ' other' : 'no URLs at all');
  if (nonGithub.length) console.log('       ' + nonGithub.slice(0, 6).join('\n       '));
  const remote = [...html.matchAll(/<(script|img|link|iframe)\b[^>]*\b(src|href)="(https?:)?\/\//g)];
  ok(remote.length === 0, 'no remote script/img/stylesheet/iframe includes', remote.length + ' found');

  // strip tags and code so the prose checks see prose only
  const prose = html.replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const personHits = [...prose.matchAll(/你|我们|咱们/g)].map((m) => m[0]);
  ok(personHits.length === 0, 'no first/second person pronouns (你 / 我们)', personHits.length + ' hit(s)');
  const banned = ['一句话总结', '值得注意的是', '本质上', '换言之', '核心在于', '非常', '极其', '完美的'];
  const bannedHits = banned.map((w) => [w, (prose.split(w).length - 1)]).filter((x) => x[1] > 0);
  ok(bannedHits.length === 0, 'none of the 8 banned phrases appear',
    bannedHits.length ? bannedHits.map((x) => x[0] + '×' + x[1]).join(', ') : 'all clear');
  const refUnverified = /待核实/.test(html);
  ok(refUnverified || refs >= 5, 'unverifiable reference is marked rather than invented',
    refUnverified ? '"待核实" present in [1]' : 'no unverified entry');

  // ------------------------------------------------------------------ navigation
  /*
   * The four product pages must carry the same navigation, and every link must resolve.
   * tests/*.html are test fixtures and are deliberately outside the product nav, so they are
   * not part of this graph.
   */
  console.log('\n[E] navigation graph');
  const NAV = require(path.join(ROOT, 'scripts', 'nav-partial.js'));
  const PAGES = ['index.html', 'embed-image.html', 'extract-image.html', 'tech.html'];
  const blocks = {};
  let missingNav = [];
  for (const p of PAGES) {
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f)) { missingNav.push(p); continue; }
    blocks[p] = NAV.extractNav(fs.readFileSync(f, 'utf8'));
    if (!blocks[p]) missingNav.push(p);
  }
  ok(missingNav.length === 0, 'all four product pages carry the shared navigation block',
    missingNav.length ? missingNav.join(', ') : PAGES.length + '/' + PAGES.length);

  // Each page's nav must equal the canonical nav generated FOR THAT PAGE (the badges differ),
  // which is a stricter statement than "they look the same".
  const expectedNav = (p) => NAV.navHtml(p, { badge: p === 'index.html' });
  const drifted = PAGES.filter((p) => blocks[p] && blocks[p] !== expectedNav(p));
  ok(drifted.length === 0, 'every page carries exactly the canonical navigation block',
    drifted.length ? drifted.join(', ') : 'all four match scripts/nav-partial.js');

  // every page must expose a visible <h1> (replacing the old header must not have dropped it)
  const noTitle = [];
  for (const p of PAGES) {
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f)) continue;
    if (!/<h1[\s>]/.test(fs.readFileSync(f, 'utf8'))) noTitle.push(p);
  }
  ok(noTitle.length === 0, 'every page has an <h1> heading',
    noTitle.length ? noTitle.join(', ') : PAGES.length + '/' + PAGES.length);

  let deadLinks = [], orphanFlag = [];
  const inbound = {};
  for (const p of PAGES) {
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/href="([^"#:]+\.html)(#[^"]*)?"/g)) {
      const target = m[1];
      if (!fs.existsSync(path.join(ROOT, target))) deadLinks.push(p + ' -> ' + target);
      inbound[target] = (inbound[target] || 0) + 1;
    }
    // every page must link out to at least one other page (no dead ends)
    const outs = new Set([...src.matchAll(/href="([^"#:]+\.html)/g)].map((x) => x[1]).filter((t) => t !== p));
    if (outs.size === 0) orphanFlag.push(p + ' has no outbound link');
  }
  ok(deadLinks.length === 0, 'no dead links among the product pages',
    deadLinks.length ? deadLinks.slice(0, 5).join('; ') : 'all hrefs resolve');
  ok(orphanFlag.length === 0, 'no page is a dead end (every page links onward)',
    orphanFlag.length ? orphanFlag.join('; ') : PAGES.length + ' pages link out');
  const noInbound = PAGES.filter((p) => p !== 'index.html' && !inbound[p]);
  ok(noInbound.length === 0, 'no orphan page (every page except the home page has an inbound link)',
    noInbound.length ? noInbound.join(', ') : 'all reachable');
  const planned = NAV.MISSING_PAGES.filter((m) => fs.existsSync(path.join(ROOT, m.href)));
  ok(planned.length === 0, 'nav items recorded as missing really are missing (no silent link)',
    NAV.MISSING_PAGES.map((m) => m.href).join(', ') + ' absent');

  // ------------------------------------------------------------------ plain-language scan
  /*
   * Task 4: the three beginner-facing pages must not contain engineering jargon in their visible
   * text. Two regions are excluded, both deliberately and narrowly:
   *   - the shared nav and <title>, because the brand the spec itself defines is "Robust SSTV"
   *     and would otherwise trip the word "SSTV";
   *   - <details class="expert"> panels, which the spec explicitly exempts.
   * <script>/<style>/comments are stripped, which also means this scan sees STATIC text only -
   * strings assembled by JavaScript are checked separately by the rendered-DOM pass in
   * tests/mobile-a11y.node.js.
   */
  console.log('\n[F] plain-language blacklist (beginner pages)');
  const BLACKLIST = ['SSTV', 'M1', 'S1', 'PD120', 'PD180', 'B=', 'Δ', 'QIM', 'RS(', 'AFC',
    '交织', '傅里叶', '频谱', '标定头', '码字', '里德-所罗门'];
  // embed.html / extract.html do not exist yet, so only index.html is gated this round
  const PLAIN_PAGES = ['index.html', 'embed.html', 'extract.html'];
  const checkedNow = [], notYet = [];
  let totalHits = 0;
  const hitDetail = [];
  for (const p of PLAIN_PAGES) {
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f)) { notYet.push(p); continue; }
    checkedNow.push(p);
    let s = fs.readFileSync(f, 'utf8');
    s = NAV.stripBrandRegions(s);
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      /*
       * Order matters: the EXPERT:END marker is an HTML comment, so stripping comments first
       * would delete the marker and silently disable the exemption (measured: jargon leaked back
       * and the hit count went 1 -> 12).
       */
      .replace(/<details[^>]*class="[^"]*expert[^"]*"[\s\S]*?<!--\s*EXPERT:END\s*-->/gi, ' ')
      // The footer is licensing attribution: it names third-party projects (one of which contains
      // the word SSTV in its own name and cannot be renamed) and is not instructional copy.
      .replace(/<footer[^>]*class="[^"]*site-footer[^"]*"[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ');
    for (const term of BLACKLIST) {
      const n = s.split(term).length - 1;
      if (n > 0) { totalHits += n; hitDetail.push(p + ': "' + term + '" x' + n); }
    }
  }
  if (hitDetail.length) for (const d of hitDetail.slice(0, 10)) console.log('       ' + d);
  ok(totalHits === 0, 'no engineering jargon in the visible text of the beginner pages',
    totalHits + ' hit(s) across ' + checkedNow.join(', '));
  ok(checkedNow.length > 0, 'at least one beginner page was actually scanned',
    checkedNow.join(', ') + (notYet.length ? '  (not yet created: ' + notYet.join(', ') + ')' : ''));

  console.log('\n================================');
  console.log(`${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? 'TECH HTML VERIFIED' : 'TECH HTML FAILED');
  process.exitCode = fail === 0 ? 0 : 1;
}
