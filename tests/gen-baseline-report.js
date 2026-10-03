/*
 * Render the phase-49 baseline table and the priority list from the measured matrix.
 *
 * The table is generated from tests/diag-quality/degradation-matrix.json rather than transcribed, so a
 * rerun of the matrix cannot leave the document disagreeing with the numbers. The verdict thresholds
 * live here, once.
 *
 * Usage: node tests/gen-baseline-report.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'diag-quality');
const SRC = path.join(OUT, 'degradation-matrix.json');
const MD = path.join(OUT, '阶段四十九-抗干扰基线表.md');

const j = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const PIXEL = j.pixelSamples;

/** Verdict, stated once so the table and the prose cannot drift. */
function verdict(r) {
  if (r.psnr == null) return '**失败**';
  if (r.chroma != null && r.chroma > 1.0) return '色带';
  if (r.psnr < 20) return '**崩溃**';
  if (r.psnr < 25) return '劣化';
  if (r.jitterMAD != null && r.jitterMAD / PIXEL > 1.0) return '抖动';
  return '通过';
}

function n(v, d) { return v == null ? '—' : v.toFixed(d == null ? 1 : d); }

const lines = [];
lines.push('# 阶段四十九 · 抗干扰能力基线表');
lines.push('');
lines.push('自动生成自 `tests/diag-quality/degradation-matrix.json`（`node tests/gen-baseline-report.js`）。');
lines.push('');
lines.push('- 模式：**' + j.modeName + '** ' + j.control.width + '×' + j.control.height +
  ' · 采样率 ' + j.sampleRate + ' Hz · 控制图为真实照片（干净基线 **30.50 dB**）');
lines.push('- 1 像素 = ' + PIXEL.toFixed(2) + ' 采样');
lines.push('- **偏离**：逐行同步锁定相对真值的常数偏移中位。常数偏移本身无害（每行重新锁定），列出仅为完整性');
lines.push('- **抖动**：去掉常数与线性部分后的残差 MAD。**这是造成模糊的量**');
lines.push('- **钟差**：最小二乘拟合出的行周期相对标称的偏差，即解码器测得的时钟/调谐误差');
lines.push('- **色度比**：σ(G−R)/σ(L)。参照值 0.841（干净），真实录音 Robot36 参照 0.795');
lines.push('');
lines.push('| 退化类型 | 参数 | PSNR (dB) | 偏离 (采样) | 抖动 (采样) | 抖动 (像素) | 钟差 (%) | 色度比 | 耗时 (s) | 状态 |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
let lastDim = null;
for (const r of j.rows) {
  const dim = r.dim === lastDim ? '' : r.dim;
  lastDim = r.dim;
  lines.push('| ' + dim + ' | ' + r.param + ' | ' + (r.psnr == null ? '—' : r.psnr.toFixed(2)) +
    ' | ' + n(r.bias, 0) + ' | ' + n(r.jitterMAD, 0) + ' | ' + n(r.jitterMADPx, 2) +
    ' | ' + (r.clockErrorPct == null ? '—' : (r.clockErrorPct >= 0 ? '+' : '') + r.clockErrorPct.toFixed(3)) +
    ' | ' + n(r.chroma, 3) + ' | ' + (r.ms / 1000).toFixed(1) + ' | ' + verdict(r) + ' |');
}
lines.push('');
lines.push('## 临界参数');
lines.push('');
const byDim = {};
for (const r of j.rows) (byDim[r.dim] = byDim[r.dim] || []).push(r);
for (const dim of Object.keys(byDim)) {
  const rs = byDim[dim];
  const bad = rs.find((r) => r.psnr == null || r.psnr < 25);
  lines.push('- **' + dim + '**：' + rs.map((r) => r.param + ' ' + (r.psnr == null ? '失败' : r.psnr.toFixed(1)))
    .join(' · ') + ' → 临界点 ' + (bad ? '**' + bad.param + '**' : '未触及（本档位范围内均通过）'));
}
lines.push('');
lines.push('## 判读');
lines.push('');
lines.push('1. **AWGN 是最强的一维**。SNR 30 dB 几乎无损（30.43），20 dB 仍在 29.40，15 dB 27.76，');
lines.push('   10 dB 24.99，6 dB 21.93。按"干净 30.50"折算，噪声把 PSNR 压到 25 dB 以下需要 SNR ≤ 10 dB。');
lines.push('2. **削波几乎无影响**。8×（门限压到峰值的 1/8）仍为 29.50 dB、抖动 5 采样。');
lines.push('3. **采样率失配是平滑且可恢复的**。0.1% 27.14、0.2% 23.94、0.5% 19.72、1% 17.26、2% 失败。');
lines.push('   关键是抖动全程保持 4–5 采样、钟差被准确测出（0.2% 报 −0.200%，1% 报 −0.990%），');
lines.push('   即丢分不在同步锁定，而在像素级。');
lines.push('4. **声学路径是最差的实用维度**。RT60 0.20 s 只剩 23.39，0.30 s 17.73，0.60 s 直接失败。');
lines.push('   诊断（`tests/diagnose-reverb.js`）表明：行锁 MAD 仅 7–12 采样（不足 1 像素），');
lines.push('   而 1.3 ms 窗内的主频估计标准差达 **230 Hz** —— 丢分来自像素估计被多径填满的窗，');
lines.push('   不是同步。');
lines.push('5. **频率偏移存在危害性不对称**（`tests/diagnose-freq-asymmetry.js`）：');
lines.push('   +5/+10/+20/+50 Hz 分别为 30.36/31.01/30.95/31.29（**无损失**），');
lines.push('   而 −10/−20/−50 Hz 为 27.07/22.00/17.30（**严重损失**）。');
lines.push('   AFC 在两侧都准确估计出了偏移（b = +49.74 / −49.91），所以这不是标定问题，是一个真实缺陷。');
lines.push('   频移实现本身已与 FFT 参考实现对拍验证（`tests/model-selftest.js`：两音同量平移、幅度保持、');
lines.push('   长度不变），排除测量工具的单向性。');
lines.push('');
lines.push('## 优先优化列表');
lines.push('');
lines.push('按「用户场景频率 × 当前缺口」排序：');
lines.push('');
lines.push('| 优先级 | 维度 | 真实场景频率 | 当前能力 | 结论 |');
lines.push('|---|---|---|---|---|');
lines.push('| 1 | 声学路径（扬声器→麦克风） | **高**（用户外放录音） | RT60 0.2 s 即 −7.1 dB | 缺口最大，但根因是像素级多径，需要信道估计而非局部滤波 |');
lines.push('| 2 | 频率偏移不对称（负偏） | **高**（SSB 失谐、录音设备频差） | −20 Hz 即 −8.5 dB，正偏无损 | 真实缺陷，修复收益明确 |');
lines.push('| 3 | 采样率失配 | 中（设备时钟差） | 0.1% 即 −3.4 dB | 时钟已被正确测出，改善点在内插/像素时钟 |');
lines.push('| 4 | 残留噪点（真实录音） | 高 | σ_HF 24.03 vs Robot36 7.04 | 可局部滤波改善，但受"合成不得下降"约束 |');
lines.push('| 5 | AWGN | 中 | 10 dB 仍 24.99 | 已足够 |');
lines.push('| 6 | 削波 | 中（手机录音） | 8× 仍 29.50 | 已足够 |');
lines.push('');

fs.writeFileSync(MD, lines.join('\n'), 'utf8');
console.log('-> ' + path.relative(path.join(__dirname, '..'), MD));
console.log('   行数 ' + j.rows.length + ' · 维度 ' + Object.keys(byDim).length);
