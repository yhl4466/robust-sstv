/*
 * Build the side-by-side comparison figure for the tech report's anti-interference chapter.
 *
 * Six panels, one per degradation dimension, at a level the matrix measured near the usable limit, plus the
 * ground truth. The figure exists so a reader can check that the numbers and the pictures agree - that
 * "24.6 dB" really does look like banding or noise - rather than taking the table on trust. Each panel
 * carries the PSNR read from degradation-matrix-results.json, never a hand-typed number.
 *
 * WHY ffmpeg AND NOT A JS IMAGE LIBRARY
 *   There is no canvas/sharp/jimp in the available module tree, but ffmpeg is present and its `drawtext`
 *   filter can render CJK from C:/Windows/Fonts/msyh.ttc. A first attempt hand-composited the grid in Node
 *   with a 5x7 bitmap font, which cannot draw the Chinese labels these panels need and would have meant
 *   either transcribing labels into ASCII or shipping a font renderer - both worse than calling the tool
 *   that already does it.
 *
 * Usage: node tests/gen-degradation-figure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'diag-quality');
const TMP = path.join(OUT, '.figure-tmp');

const FFMPEG = [
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  'ffmpeg'
].find((p) => p === 'ffmpeg' || fs.existsSync(p));
if (!FFMPEG) { console.error('未找到 ffmpeg'); process.exit(1); }

const FONTS = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/arial.ttf'
];
const FONT = FONTS.find((f) => fs.existsSync(f));
if (!FONT) { console.error('未找到可用字体'); process.exit(1); }

const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'degradation-matrix-results.json'), 'utf8'));
const psnrOf = (param) => {
  const r = results.rows.find((x) => x.param === param);
  return r && r.psnr != null ? r.psnr.toFixed(1) + ' dB' : '解码失败';
};

const PANELS = [
  { file: 'degradation-source.png', label: '真值（合成测试图）', note: '参照' },
  { file: 'degradation-频率偏移-+50_Hz.png', label: '+50 Hz 频偏', note: psnrOf('+50 Hz') },
  { file: 'degradation-频率偏移--30_Hz.png', label: '−30 Hz 频偏', note: psnrOf('-30 Hz') },
  { file: 'degradation-AWGN-SNR_10_dB.png', label: 'AWGN 10 dB', note: psnrOf('SNR 10 dB') },
  { file: 'degradation-削波-3_.png', label: '削波 3×', note: psnrOf('3×') },
  /*
   * 采样率失配's label writes "0.5 个千分点" rather than "0.5 %": a literal '%' in a drawtext value is an
   * expansion introducer and ffmpeg rejects it even when backslash-escaped through this call path
   * ("Stray % near ''"). Sidestepping the character is honest here - the axis label in the chart and the
   * table both still say "%", so nothing is hidden, and the figure is generated rather than hand-edited.
   */
  { file: 'degradation-采样率失配-0.5_.png', label: '采样率失配 0.5 个千分点', note: psnrOf('0.5 %') },
  /*
   * The acoustic panel uses RT60 0.20 s, which is what the room model actually DELIVERS for its shortest
   * setting - the matrix labels each rung with the MEASURED RT60, and a 0.15 s request comes out at 0.20 s
   * (the diffusion sections cannot be shorter than a few of their own lengths). Pointing at a
   * degradation-声学路径-RT60_0.15_s.png file would have used a stale PNG from an earlier run AND printed
   * "解码失败" for a row that is not in the current matrix at all.
   */
  { file: 'degradation-声学路径-RT60_0.20_s.png', label: '声学 RT60 0.20 s', note: psnrOf('RT60 0.20 s') },
  { file: 'degradation-组合退化-手机外放_RT60_0.3_+_削波_3_+_+20_Hz_.png',
    label: '组合：手机外放', note: psnrOf('手机外放（RT60 0.3 + 削波 3× + +20 Hz）') }
];

for (const p of PANELS) {
  if (!fs.existsSync(path.join(OUT, p.file))) { console.error('缺少源图 ' + p.file); process.exit(1); }
}

fs.mkdirSync(TMP, { recursive: true });

/*
 * The font path goes INSIDE a filter graph, where ':' separates option values - so the colon in "C:/..."
 * terminates the option and ffmpeg reports "No option name near '/Windows/Fonts/msyh.ttc'". Escaping it
 * with a backslash is what makes the path survive the graph parser.
 */
const FONT_ESC = FONT.replace(/:/g, '\\:');

/*
 * Label each panel into its own file first, then tile.
 *
 * Doing the labelling and the tiling in one filter graph is possible but the graph becomes very hard to read
 * and an error in one panel's coordinates silently mislabels another. Per-panel files make each step
 * checkable on its own.
 */
const labelled = PANELS.map((p, i) => {
  const dst = path.join(TMP, 'lbl' + i + '.png');
  /*
   * Escape for drawtext. The set matters: ':' and ',' are filter-graph separators, '\' is the escape itself,
   * "'" would close the quoted string, and '%' introduces a drawtext expansion ("Stray % near ''" is the
   * error when it is not escaped - which is how the 采样率失配 panel's "0.5 %" label exposed this).
   */
  const esc = (s) => s
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%');
  const vf = [
    'pad=iw:ih+54:0:0:color=0x0e1116',
    'drawtext=fontfile=\'' + FONT_ESC + '\':text=\'' + esc(p.label) + '\':x=8:y=h-46:fontsize=17:fontcolor=0xc8d0da',
    'drawtext=fontfile=\'' + FONT_ESC + '\':text=\'' + esc(p.note) + '\':x=8:y=h-24:fontsize=15:fontcolor=0x7ee2a8'
  ].join(',');
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(OUT, p.file), '-vf', vf, dst],
      { stdio: 'pipe', timeout: 120000 });
  } catch (e) {
    console.error('标注失败 ' + p.file + '：' + (e.stderr ? e.stderr.toString().slice(0, 400) : e.message));
    process.exit(1);
  }
  return dst;
});

// tile 4 x 2 with a small gutter
const COLS = 4;
const inputs = [];
for (const f of labelled) inputs.push('-i', f);
const layout = labelled.map((_, i) => {
  const c = i % COLS, r = Math.floor(i / COLS);
  return (c * 336) + '_' + (r * 340);
}).join('|');

const figure = path.join(OUT, 'degradation-comparison.png');
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...inputs,
  '-filter_complex', '[0:v]' + labelled.slice(1).map((_, i) => '[' + (i + 1) + ':v]').join('') +
    'xstack=inputs=' + labelled.length + ':layout=' + layout + ':fill=0x0e1116[v]',
  '-map', '[v]', figure], { stdio: 'pipe', timeout: 180000 });

const size = fs.statSync(figure).size;
console.log('wrote tests/diag-quality/degradation-comparison.png (' + (size / 1024).toFixed(0) + ' KB)');
for (const p of PANELS) console.log('  ' + p.label + '  →  ' + p.note);

fs.rmSync(TMP, { recursive: true, force: true });
