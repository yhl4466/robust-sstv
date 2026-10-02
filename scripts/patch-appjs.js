/*
 * Phase-10 patch for js/app.js: two jobs, both auditable and idempotent.
 *
 * (1) Repair the string literals damaged by the phase-4 GBK round-trip.
 *     A byte-level scan for a "?" immediately followed by a letter or slash found 7 sites, and
 *     reading their context revealed 12 damaged literals. They are user-visible: the decode
 *     failure message rendered as "解码失败（阶段：vis?br>VIS 校验位失败…）" and the extension
 *     table rendered as "隐写嵌入?Codec.registerEmbedder". Each replacement below is asserted to
 *     occur exactly once, so a future edit cannot silently mis-apply it.
 *
 * (2) Implement the plain-language error mapping for the decode path.
 *     The stage names are the REAL ones produced by js/lib/sstv-decode.js and js/decoder.js.
 *     Two requested entries have no trigger path and are kept as defensive copy with a note:
 *       pd-not-supported - PD120/PD180 have been decodable since phase 7 (DECODABLE holds VIS 95
 *                          and 96), so this stage can never be produced today.
 *       timeout          - no timeout mechanism exists; cancellation is user-driven and arrives
 *                          as stage 'cancelled'.
 *     The technical stage/message is moved into the element's title attribute instead of being
 *     printed, so the interface shows only plain language while support can still see the detail.
 *
 * Usage: node scripts/patch-appjs.js [--apply]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'js', 'app.js');
const APPLY = process.argv.includes('--apply');

/** [damaged literal, repaired literal, why] */
const REPAIRS = [
  ['/* SSTV 图片隐藏 · 阶段一 ?UI wiring',
   '/* 抗干扰 SSTV 解码 · UI wiring',
   'comment separator lost; the old brand text is also stale after the rename'],
  ['保持界面响应?\');', '保持界面响应）\');', 'full-width close paren lost'],
  ["(res.cancelled ? '已取消?' : '解码失败（阶段：' + esc(res.stage) + '?br>' + esc(res.message)));",
   "(res.cancelled ? '已取消。' : decodeErrorText(res)));",
   "period lost, and '?br>' was '）<br>'; the whole branch is replaced by the plain-language map"],
  ["rows.push('<tr><td>隐写嵌入?Codec.registerEmbedder</td><td>' +",
   "rows.push('<tr><td>隐写嵌入：Codec.registerEmbedder</td><td>' +",
   'full-width colon lost'],
  ["(Channel.Codec.listFECs().length ? Channel.Codec.listFECs().map(esc).join('?') : '<span class=\"muted\">（阶段二注册?/span>') +",
   "(Channel.Codec.listFECs().length ? Channel.Codec.listFECs().map(esc).join('、') : '<span class=\"muted\">（阶段二注册）</span>') +",
   'list separator and close paren + tag bracket lost'],
  ["'</td><td><span class=\"muted\">?/span></td></tr>');",
   "'</td><td><span class=\"muted\">—</span></td></tr>');",
   'placeholder dash and tag bracket lost'],
  ["Object.keys(Channel.Channel).map(esc).join('?') + '</td><td><span class=\"muted\">?/span></td></tr>');",
   "Object.keys(Channel.Channel).map(esc).join('、') + '</td><td><span class=\"muted\">—</span></td></tr>');",
   'list separator, placeholder dash and tag bracket lost'],
  ['不是已实现的隐写信道测量值?\'', '不是已实现的隐写信道测量值。\'', 'period lost'],
  ["{ id: 'none', label: '?FEC', nsym: 0 },",
   "{ id: 'none', label: '无 FEC', nsym: 0 },",
   'leading character lost'],
  ["{ id: 'rs223', label: 'RS(255,223) ?6', nsym: 32 },",
   "{ id: 'rs223', label: 'RS(255,223) 纠16', nsym: 32 },",
   "correction-capability character lost; worded to match the image-hiding pages"],
  ["{ id: 'rs191', label: 'RS(255,191) ?2', nsym: 64 }",
   "{ id: 'rs191', label: 'RS(255,191) 纠32', nsym: 64 }",
   "correction-capability character lost; worded to match the image-hiding pages"]
];

const MAP_ANCHOR = "  var FEC_OPTS = [";
const MAP_BLOCK = `  /*
   * Internal decode stage -> plain-language message.
   *
   * Stage names are the real ones from js/lib/sstv-decode.js and js/decoder.js. Two entries have
   * no trigger path and are kept as defensive copy: 'pd-not-supported' (PD120/PD180 have been
   * decodable since phase 7) and 'timeout' (there is no timeout mechanism; cancellation arrives
   * as 'cancelled').
   */
  var DECODE_ERROR_TEXT = {
    wav: '这个音频文件读不出来，请换一个 WAV 文件。',
    input: '音频内容为空或格式异常，请换一个文件。',
    findHeader: '没检测到信号。请确认上传的是声音传图的音频，或让对方重新发送。',
    'calibrate-fail': '信号同步失败，音频可能被裁剪或损坏。',
    unexpected: '还原过程中出错，请重试或换一段音频。',
    cancelled: '已取消。',
    'pd-not-supported': '检测到高清格式，请让发送方改用其他音质。',
    timeout: '处理超时，请换一段更短的音频。'
  };

  /** Map a decode result to a sentence a non-specialist can act on. */
  function decodeErrorText(res) {
    if (res && res.cancelled) return DECODE_ERROR_TEXT.cancelled;
    if (res && res.stage === 'vis') {
      // vis is set only when the header decoded but the format is unsupported; a bare 'vis'
      // failure with no vis value means the parity bit did not check out.
      return res.vis != null ? '检测到未知格式，本工具可能不支持。'
                             : '信号不完整，可能被裁剪或干扰了，请让对方重新发送。';
    }
    if (res && DECODE_ERROR_TEXT[res.stage]) return DECODE_ERROR_TEXT[res.stage];
    return DECODE_ERROR_TEXT.unexpected;
  }

`;

let src = fs.readFileSync(FILE, 'utf8');
const before = src;
let applied = 0, skipped = 0;

for (const [from, to, why] of REPAIRS) {
  const n = src.split(from).length - 1;
  if (n === 0) { console.log(`  -- already applied or not found: ${why}`); skipped++; continue; }
  if (n !== 1) { console.log(`  !! ${n} occurrences, refusing to apply: ${why}`); skipped++; continue; }
  src = src.split(from).join(to);
  console.log(`  OK ${why}`);
  applied++;
}

if (!src.includes('function decodeErrorText')) {
  if (!src.includes(MAP_ANCHOR)) {
    console.log('  !! error-map anchor not found; not injecting');
  } else {
    src = src.replace(MAP_ANCHOR, MAP_BLOCK + MAP_ANCHOR);
    // keep the technical detail reachable without printing it
    src = src.replace(
      "      setStatus($('decStatus'), kind,",
      "      $('decStatus').title = res.cancelled ? '' : ('stage=' + (res.stage || '') + (res.message ? ' | ' + res.message : ''));\n      setStatus($('decStatus'), kind,");
    console.log('  OK injected DECODE_ERROR_TEXT + decodeErrorText(), detail moved to title=');
    applied += 2;
  }
} else {
  console.log('  -- error map already present');
  skipped++;
}

console.log(`\n${applied} change(s) applied, ${skipped} skipped`);
if (APPLY) {
  fs.writeFileSync(FILE, src, 'utf8');
  console.log('written js/app.js');
  // re-scan for residual damage on the "?letter" pattern
  const residual = src.split('\n')
    .map((l, i) => [i + 1, [...l.matchAll(/\?[A-Za-z\/]/g)].map((m) => m[0])])
    .filter((x) => x[1].length);
  console.log(residual.length
    ? 'residual suspicious sites: ' + residual.map((x) => 'L' + x[0] + '[' + x[1].join('') + ']').join(' ')
    : 'no residual "?letter" damage found');
} else if (src !== before) {
  console.log('dry run - pass --apply to write');
}
