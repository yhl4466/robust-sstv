/*
 * Screenshot tests/favicon-preview.html so the site icon can be judged at 16-128 px.
 *
 * WHY THIS IS A KEPT TOOL AND NOT A ONE-OFF
 *   An icon is only correct if it survives being drawn at 16 px, and that cannot be judged from the SVG source
 *   or from a single large rendering. Iterating on this icon took three attempts, and in both failed ones the
 *   icon looked fine at 128 px:
 *     v1 - waveform on the left, picture frame on the right, joined by a diagonal: they collide below 32 px.
 *     v2 - wave moved inside the frame but with three cycles: it turns into a scribble at 16 px.
 *   Rendering the same file at five sizes in one shot is the cheap way to see that.
 *
 * Output: tests/diag-quality/favicon-preview.png (2x device scale).
 *
 * Usage: node tests/favicon-shot.js
 */
'use strict';
const path = require('path');
const { launchBrowser } = require('./lib/cdp-harness.js');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');

(async function main() {
  const url = 'file:///' + path.join(ROOT, 'tests', 'favicon-preview.html').replace(/\\/g, '/');
  const b = await launchBrowser({ url: url, port: 9377, width: 760, height: 460, profileTag: 'favicon' });
  try {
    const h = await b.evaluate('document.body.scrollHeight');
    await b.shoot(path.join(OUT, 'favicon-preview.png'),
      { x: 0, y: 0, width: 720, height: Math.min(h + 20, 460), scale: 2 });
    console.log('-> tests/diag-quality/favicon-preview.png (2x)');
    console.log('   同一文件渲染于 128 / 64 / 48 / 32 / 16 px，外加两枚标签页样机');
  } finally { await b.close(); }
  process.exitCode = 0;
})();
