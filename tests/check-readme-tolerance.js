/*
 * Is the README's anti-interference table still true against the matrix?
 *
 * WHY THIS EXISTS
 *   The README's "抗干扰能力" table states, per dimension, the last rung that meets the 25 dB criterion. It was
 *   written by hand from the matrix and it was WRONG in a way that matters: it claimed background noise "还能
 *   读出来 20 dB", but 20 dB measures 24.84 dB - below the criterion. The author read the chart's bracketing
 *   label ("可用至 30 dB 与 20 dB 之间") as "20 dB still works". The values in the table are the single most
 *   user-facing numbers in the repository, so they get a machine check: every claim is recomputed from
 *   tests/degradation-matrix-results.json.
 *
 * HOW THE CLAIM IS ENCODED
 *   The table is parsed as rows of `| dimension | passing rung | failing rung | ... |`, and the rungs are
 *   mapped back to matrix parameter labels. The check then asserts, from the matrix, that:
 *     - the passing rung's PSNR is >= 25 and its SIGNED MARGIN matches the README's margin column;
 *     - the failing rung's PSNR is < 25, or the cell says there is no passing rung at all.
 *   So a tolerance claim cannot drift from the measurement without failing here.
 *
 * Usage: node tests/check-readme-tolerance.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const USABLE_DB = 25;

let failures = 0;
function check(ok, label, detail) {
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'degradation-matrix-results.json'), 'utf8'));
const rows = matrix.rows;
const psnr = (dim, param) => {
  const r = rows.find((x) => x.dim === dim && x.param === param);
  return r && r.psnr != null ? r.psnr : null;
};

/* README row label -> { dim, passing param, failing param }. null = "no passing rung". */
const CLAIMS = [
  { label: '背景噪声', dim: 'AWGN', pass: 'SNR 30 dB', fail: 'SNR 20 dB', passText: '30 dB' },
  { label: '音量过载（削波）', dim: '削波', pass: '1.5×', fail: '2×', passText: '1.5 倍' },
  { label: '频率失谐（偏高）', dim: '频率偏移', pass: '+50 Hz', fail: '+100 Hz', passText: '+50 Hz' },
  { label: '频率失谐（偏低）', dim: '频率偏移', pass: null, fail: '-5 Hz', passText: '—' },
  { label: '设备时钟快慢不一致', dim: '采样率失配', pass: '0 %', fail: '0.05 %', passText: '0 %' },
  { label: '房间混响（外放录音）', dim: '声学路径', pass: null, fail: 'RT60 0.20 s', passText: '—' },
  { label: '多种干扰叠加', dim: '组合退化', pass: null, fail: null, passText: '—' }
];

console.log('=== README 抗干扰表 vs 退化矩阵 ===\n');
check(rows.length >= 40, '矩阵结果完整', rows.length + ' 行');

/** Pull a markdown table row's cells by its first cell. */
function rowCells(prefix) {
  const line = readme.split('\n').find((l) => l.trim().startsWith('| ' + prefix));
  if (!line) return null;
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

for (const c of CLAIMS) {
  const cells = rowCells(c.label);
  check(!!cells, 'README 含「' + c.label + '」行');
  if (!cells) continue;
  // columns: 干扰类型 | 还能读出来 | 读不出来 | 达标档余量 | 说明
  const passCell = cells[1], failCell = cells[2], marginCell = cells[3];

  if (c.pass) {
    const p = psnr(c.dim, c.pass);
    check(p != null && p >= USABLE_DB,
      c.label + ' 的达标档确在判据之上', c.pass + ' = ' + (p == null ? '失败' : p.toFixed(2) + ' dB'));
    // the README's pass column must actually name that rung
    const wantText = c.passText.replace(/\*\*/g, '');
    check(passCell.replace(/\*\*/g, '').indexOf(wantText.replace(' 倍', ' 倍')) >= 0 ||
      passCell.indexOf(c.passText.replace('倍', '倍')) >= 0,
      c.label + ' 的达标档文字与实测一致', 'README「' + passCell + '」 vs ' + c.pass);
    /*
     * Compare the NUMBER, not the formatting. Every margin cell carries a " dB" suffix and some carry bold
     * markers, so an exact string comparison fails on presentation alone - which it did, reporting four
     * failures for four cells whose values were all correct.
     */
    if (p != null) {
      const want = (p - USABLE_DB >= 0 ? '+' : '') + (p - USABLE_DB).toFixed(2);
      const got = marginCell.replace(/\*\*/g, '').replace(/\s*dB\s*$/, '').trim();
      check(got === want, c.label + ' 的余量与实测一致',
        'README「' + got + '」 vs 应为 ' + want);
    }
  } else {
    check(/—|无/.test(passCell), c.label + ' 标为无达标档', '「' + passCell + '」');
  }

  if (c.fail) {
    const f = psnr(c.dim, c.fail);
    const failed = (f == null) || (f < USABLE_DB);
    check(failed, c.label + ' 的不达标档确在判据之下',
      c.fail + ' = ' + (f == null ? '解码失败' : f.toFixed(2) + ' dB'));
  }
}

/*
 * And the sentence that the wrong reading produced. The README must not claim a dimension is the most or
 * least tolerant, because the ladders are not commensurable (different step sizes per dimension) - a lesson
 * learned by writing exactly such a claim and then measuring the opposite.
 */
check(!/最抗得住|余量最薄的一类|最脆弱的一环/.test(readme),
  'README 未给出跨维度"最耐打/最脆弱"的排名');
check(/为什么不做/.test(readme), 'README 说明了为何不给这类排名');

console.log('\n' + (failures === 0 ? 'README TOLERANCE: ALL CHECKS PASSED' : 'README TOLERANCE: ' + failures + ' FAILED'));
process.exitCode = failures === 0 ? 0 : 1;
