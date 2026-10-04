/*
 * Final pass over the few remaining '?' placeholders that the GBK byte-loss left inside
 * string literals (they are syntactically valid, so the earlier repair left them alone).
 * Only the user-visible ones are restored; each mapping is explicit and auditable.
 *
 * Usage: node scripts/repair-appjs-final.js --apply
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'js', 'app.js');
const APPLY = process.argv.includes('--apply');
let src = fs.readFileSync(FILE, 'utf8');

const TABLE = [
  ["return (m > 0 ? m + ' ?' : '') + s.toFixed(1) + ' ?';", "return (m > 0 ? m + ' 分 ' : '') + s.toFixed(1) + ' 秒';"],
  ["'</b>（VIS ' + mode.vis + '?br>' +", "'</b>（VIS ' + mode.vis + '）<br>' +"],
  ["'</b>（VIS ' + res.vis + '?br>' +", "'</b>（VIS ' + res.vis + '）<br>' +"],
  ["'音频时长 <b>' + fmtDuration(res.duration) + '</b> · 采样?' + res.sampleRate + ' Hz · 单声?16-bit<br>' +",
   "'音频时长 <b>' + fmtDuration(res.duration) + '</b> · 采样率 ' + res.sampleRate + ' Hz · 单声道 16-bit<br>' +"],
  ["q.label + '（FFT ×' + q.mult + '?'", "q.label + '（FFT ×' + q.mult + '）'"],
  [".map(function (s) { return s.name + ' (VIS ' + s.vis + ')'; }).join('?');",
   ".map(function (s) { return s.name + ' (VIS ' + s.vis + ')'; }).join('、');"],
  ["'已适配?' + mode.width", "'已适配 ' + mode.width"],
  ["'（源?' + (enc.sourceImg.naturalWidth", "'（源图 ' + (enc.sourceImg.naturalWidth"],
  ["+ '×' + (enc.sourceImg.naturalHeight || '?') + '?';", "+ '×' + (enc.sourceImg.naturalHeight || '?') + '）';"],
  ["'耗时 ' + ((t.total || 0) / 1000).toFixed(2) + ' ?' +", "'耗时 ' + ((t.total || 0) / 1000).toFixed(2) + ' 秒<br>' +"],
  ["'（标定头 ' + (t.header || 0) + ' ms · 图像 ' + (t.image || 0) + ' ms?' + warn);",
   "'（标定头 ' + (t.header || 0) + ' ms · 图像 ' + (t.image || 0) + ' ms）' + warn);"],
  ["(res.cancelled ? '已取消?' : '解码失败（阶段：' + esc(res.stage) + '?br>' + esc(res.message));",
   "(res.cancelled ? '已取消。' : '解码失败（阶段：' + esc(res.stage) + '）：<br>' + esc(res.message));"],
  ["? '<br><span class=\"warn\">提示?' + esc(res.warnings.join(' ')) + '</span>' : '';",
   "? '<br><span class=\"warn\">提示：' + esc(res.warnings.join(' ')) + '</span>' : '';"],
  ["rows.push('<p class=\"muted\">接口层版?<code>'", "rows.push('<p class=\"muted\">接口层版本 <code>'"],
  ["Channel.Backend.mode + '</code>?code>remote</code> 为阶段二预留?/p>');",
   "Channel.Backend.mode + '</code>（<code>remote</code> 为后续阶段预留）</p>');"],
  ["'<table><thead><tr><th>扩展?/th><th>已注?/th><th>当前生效</th></tr></thead><tbody>'",
   "'<table><thead><tr><th>扩展点</th><th>已注册</th><th>当前生效</th></tr></thead><tbody>'"],
  ["'<tr><td>隐写嵌入?</td>", "'<tr><td>隐写嵌入</td>"],
  ["Codec.listEmbedders().map(esc).join('?')", "Codec.listEmbedders().map(esc).join('、')"],
  ["Codec.registerFEC（LDPC?/td>", "Codec.registerFEC（LDPC 预留）</td>"],
  ["'信道模拟器?</td>", "'信道模拟器</td>"],
  ["'交织器?</td>", "'交织器</td>"],
  ["'解码标定（AFC + 时钟?</td>", "'解码标定（AFC + 时钟恢复）</td>"],
  ["'后端模式?</td>", "'后端模式</td>"],
  ["'图片隐藏（秘密图嵌入?</td>", "'图片隐藏（秘密图嵌入）</td>"],
  ["'非纯前端后端?</td>", "'非纯前端后端</td>"],
  ["'阶段二预留?</td>", "'阶段二预留</td>"],
  ["'尚未实现?</td>", "'尚未实现</td>"],
  ["'可切换?</td>", "'可切换</td>"],
  ["'已启用?</td>", "'已启用</td>"],
  ["'插件式?</td>", "'插件式</td>"],
  ["'未注册?</td>", "'未注册</td>"],
  ["'本地?</td>", "'本地</td>"]
];

let applied = 0;
const missed = [];
for (const [from, to] of TABLE) {
  if (src.indexOf(from) >= 0) { applied += src.split(from).length - 1; src = src.split(from).join(to); }
  else missed.push(from.slice(0, 52));
}
console.log(`final-pass replacements: ${applied}`);
if (missed.length) { console.log(`not found (${missed.length}):`); for (const m of missed) console.log('   ' + m); }

try {
  new vm.Script(src);
  console.log('\napp.js parses cleanly');
  if (APPLY) { fs.writeFileSync(FILE, src, 'utf8'); console.log('written'); }
} catch (e) {
  console.log('\nBROKEN: ' + e.message);
  process.exitCode = 1;
}
