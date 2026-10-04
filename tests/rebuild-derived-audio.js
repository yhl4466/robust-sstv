/*
 * Rebuild the derived 48 kHz mono WAVs that the diagnostic scripts read.
 *
 * WHY THIS EXISTS
 *   tests/diag-quality/acoustic-real-48k-mono.wav and obs-mp4-48k-mono.wav are ffmpeg derivations of files
 *   already in the repository (tests/fixtures/phigros.wav and the screen recording in 测试结果/). They are
 *   ~15-21 MB each, so they are gitignored rather than committed, and several diagnostic scripts read them
 *   directly. Without a rebuild step those scripts just report "file missing" after a fresh clone, which is
 *   the correct behaviour but not a helpful one - this turns the .gitignore comment into a command.
 *
 * Sources, in preference order, verified by byte size so a wrong file is not silently accepted:
 *   tests/fixtures/phigros.wav              the real phone recording (an MP3 despite the extension)
 *   tests/fixtures/acoustic-real-m1.m4a.mp3 the same bytes
 *   测试结果/2026-10-03 15-34-34.mp4          the OBS screen recording
 *
 * Usage: node tests/rebuild-derived-audio.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'diag-quality');

const FFMPEG = [
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  'ffmpeg'
].find((p) => p === 'ffmpeg' || fs.existsSync(p));
if (!FFMPEG) { console.error('未找到 ffmpeg'); process.exit(1); }

/** The real phone recording's canonical size; both fixture copies are exactly this. */
const PHIGROS_BYTES = 8821922;

const JOBS = [
  {
    out: path.join(OUT, 'acoustic-real-48k-mono.wav'),
    candidates: [path.join(ROOT, 'tests', 'fixtures', 'phigros.wav'),
      path.join(ROOT, 'tests', 'fixtures', 'acoustic-real-m1.m4a.mp3')],
    expectBytes: PHIGROS_BYTES,
    label: '真机手机录音 → 48 kHz 单声道'
  },
  {
    out: path.join(OUT, 'obs-mp4-48k-mono.wav'),
    candidates: [path.join(ROOT, '测试结果', '2026-10-03 15-34-34.mp4')],
    expectBytes: null,
    label: 'OBS 录屏音频 → 48 kHz 单声道'
  }
];

let built = 0, skipped = 0, failed = 0;

for (const job of JOBS) {
  if (fs.existsSync(job.out)) {
    console.log('已存在，跳过: ' + path.relative(ROOT, job.out) + ' (' +
      (fs.statSync(job.out).size / 1024 / 1024).toFixed(1) + ' MB)');
    skipped++;
    continue;
  }
  let src = job.candidates.find((c) => fs.existsSync(c));
  if (src && job.expectBytes) {
    const sz = fs.statSync(src).size;
    if (sz !== job.expectBytes) {
      console.error('源文件大小不符（期望 ' + job.expectBytes + '，实际 ' + sz + '）: ' + src);
      const alt = job.candidates.find((c) => fs.existsSync(c) && fs.statSync(c).size === job.expectBytes);
      if (!alt) { failed++; continue; }
      src = alt;
    }
  }
  if (!src) {
    console.error('缺少源文件，无法重建: ' + path.relative(ROOT, job.out));
    console.error('  候选: ' + job.candidates.map((c) => path.relative(ROOT, c)).join(' 或 '));
    failed++;
    continue;
  }
  console.log(job.label);
  console.log('  ' + path.relative(ROOT, src) + ' → ' + path.relative(ROOT, job.out));
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '48000',
      '-acodec', 'pcm_s16le', job.out], { stdio: 'pipe', timeout: 300000 });
    console.log('  完成 (' + (fs.statSync(job.out).size / 1024 / 1024).toFixed(1) + ' MB)');
    built++;
  } catch (e) {
    console.error('  ffmpeg 失败: ' + (e.stderr ? e.stderr.toString().slice(0, 300) : e.message));
    failed++;
  }
}

console.log('\n重建 ' + built + ' 个，跳过 ' + skipped + ' 个，失败 ' + failed + ' 个');
if (failed) {
  console.log('提示：这些派生件已被 .gitignore 排除（体积大且可重建）。' +
    '缺失时依赖它们的诊断脚本会报"文件缺失"。');
  process.exitCode = 1;
}
