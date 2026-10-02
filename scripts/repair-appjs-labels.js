/*
 * Restore the specific UI strings that the GBK round-trip damaged, using explicit
 * known-correct replacements. The leftover '?' holes elsewhere are honest losses and are
 * left as-is (documented in the phase-4 report) rather than invented.
 *
 * Usage: node scripts/repair-appjs-labels.js --apply
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'js', 'app.js');
const APPLY = process.argv.includes('--apply');
let src = fs.readFileSync(FILE, 'utf8');

// [exact damaged text, correct text] - anchored long enough to be unambiguous
const TABLE = [
  // --- panel labels the automated checks depend on ---
  ["cfg.blockSize + ' 像素/?'", "cfg.blockSize + ' 像素/位'"],
  ["['不可嵌入?'", "['不可嵌入块'"],
  ["['码几?'", "['码几何'"],
  ["metricRow('实际码字?/ 深度'", "metricRow('实际码字数 / 深度'"],
  ["metricRow('?CRC'", "metricRow('帧 CRC'"],
  ["metricRow('擦除率（比特/字节?'", "metricRow('擦除率（比特/字节）'"],
  ["metricRow('载荷?PSNR'", "metricRow('载荷图 PSNR'"],
  ["metricRow('模拟?PSNR vs 原图'", "metricRow('模拟图 PSNR vs 原图'"],
  ["metricRow('嵌入代价（vs 发送前?'", "metricRow('嵌入代价（vs 发送前）'"],
  ["metricRow('接收端标?'", "metricRow('接收端标定'"],
  ["(cal.observations ? '?' + cal.observations", "(cal.observations ? '（' + cal.observations"],
  ["metricRow('信道', preset.name + ' ?'", "metricRow('信道', preset.name + ' — '"],
  ["'块长 ' + cfg.blockSize + ' px，?'", "'块长 ' + cfg.blockSize + ' px，Δ='"],
  ["'，载?' + cap.carrierBytes", "'，载波 ' + cap.carrierBytes"],

  // --- panel verdict / notes ---
  ["'预计可靠（该图可直接承载?'", "'预计可靠（该图可直接承载）'"],
  ["verdict = '当前图像?'", "verdict = '当前图像有 '"],
  ["建议换?'", "建议换图'"],
  ["比特写不进去?'", "比特写不进去。'"],
  ["高于 RS 的纠错预?'", "高于 RS 的纠错预算'"],
  ["'容量不足：可用载?'", "'容量不足：可用载荷 '"],
  ["+ ' B，需?' + THUMB_BYTES", "+ ' B，需 ' + THUMB_BYTES"],
  ["' B。请减小 B 或降?FEC 强度?'", "' B。请减小 B 或降低 FEC 强度。'"],
  ["notes.push('?B 下载波只?'", "notes.push('该 B 下载波只有 '"],
  ["交织深度上限?1（交织开关将不起作用）?'", "交织深度上限为 1（交织开关将不起作用）。'"],
  ["'（RS 预算 ' + BER_SAFE.toExponential(1) + '?'", "'（RS 预算 ' + BER_SAFE.toExponential(1) + '）'"],
  ["'单特?unreachableFrac", "'单特征 unreachableFrac"],
  ["PREDICT.r2 + '?' + Math.round", "PREDICT.r2 + '，' + Math.round"],
  ["'请先在上方选择图片（载荷内容是该图?16×16 缩略图）'", "'请先在上方选择图片（载荷内容是该图的 16×16 缩略图）'"],
  ["'  ⚠ 超阈?'", "'  ⚠ 超阈值 '"],

  // --- run status / metrics wording ---
  ["'请先在上方选择图片?'); return; }", "'请先在上方选择图片。'); return; }"],
  ["'该配置容量不足：可用载荷 ' + cap.payloadBytes + ' B，需?' + THUMB_BYTES + ' B?'",
   "'该配置容量不足：可用载荷 ' + cap.payloadBytes + ' B，需 ' + THUMB_BYTES + ' B。'"],
  ["'请减小块长或降低 FEC 强度?'", "'请减小块长或降低 FEC 强度。'"],
  ["'正在运行载荷链路…（?Worker，解码分块让出以保持界面响应?'", "'正在运行载荷链路…（无 Worker，解码分块让出以保持界面响应）'"],
  ["throw new Error('解调失败?' + dec.stage", "throw new Error('解调失败（' + dec.stage"],
  ["? '载荷解出?<b>CRC 校验通过</b>，载荷逐字节与发送一致?'",
   "? '载荷解出且 <b>CRC 校验通过</b>，载荷逐字节与发送一致。'"],
  ["'载荷未能完整恢复?b>' + esc(ex.reason) + '</b>（下方为尽力恢复的结果与质量指标?'",
   "'载荷未能完整恢复：<b>' + esc(ex.reason) + '</b>（下方为尽力恢复的结果与质量指标）'"],
  ["'运行失败?' + esc(e.message)", "'运行失败：' + esc(e.message)"],

  // --- generic status lines damaged the same way (cosmetic, but cheap to fix) ---
  ["'图片处理失败?' + esc(e.message)", "'图片处理失败：' + esc(e.message)"],
  ["'编码失败?' + esc(e.message)", "'编码失败：' + esc(e.message)"],
  ["'WAV 解析失败?' + esc(parsed.message)", "'WAV 解析失败：' + esc(parsed.message)"],
  ["'读取图片失败?'", "'读取图片失败。'"],
  ["'图片解码失败?'", "'图片解码失败。'"],
  ["'请先选择图片?'", "'请先选择图片。'"],
  ["'正在编码?'", "'正在编码…'"],
  ["'读取文件失败?' + esc(err.message)", "'读取文件失败：' + esc(err.message)"],
  ["showProgress(0, '搜索标定?')", "showProgress(0, '搜索标定头')"],
  ["'正在解码…（?Worker 可用", "'正在解码…（无 Worker 可用"]
];

let applied = 0;
const missed = [];
for (const [from, to] of TABLE) {
  if (src.indexOf(from) >= 0) {
    const n = src.split(from).length - 1;
    src = src.split(from).join(to);
    applied += n;
  } else {
    missed.push(from.slice(0, 46));
  }
}
console.log(`replacements applied: ${applied}`);
if (missed.length) {
  console.log(`patterns not found (${missed.length}):`);
  for (const m of missed) console.log('   ' + m);
}

try {
  new vm.Script(src);
  console.log('\napp.js parses cleanly');
  if (APPLY) { fs.writeFileSync(FILE, src, 'utf8'); console.log('written'); }
  else console.log('(dry run - pass --apply)');
} catch (e) {
  console.log('\nBROKEN: ' + e.message);
  process.exitCode = 1;
}

const left = (src.match(/\uFFFD/g) || []).length;
console.log(`\nremaining unrecoverable '?' holes in the file: ${left}`);
