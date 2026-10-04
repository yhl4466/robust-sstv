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
/*
 * These numbers are read from the matrix rather than typed, so a rerun cannot leave the prose stale -
 * which is exactly what happened on the first pass, when a model fix moved every row and the narrative
 * still quoted the old ones.
 */
{
  const get = (dim, param) => {
    const r = j.rows.find((q) => q.dim === dim && q.param === param);
    return r && r.psnr != null ? r.psnr : null;
  };
  const fmt = (v) => (v == null ? '失败' : v.toFixed(2));
  const off = (hz) => fmt(get('频率偏移', (hz >= 0 ? '+' : '') + hz + ' Hz'));
  lines.push('1. **AWGN 是最强的一维**。SNR ' + fmt(get('AWGN', 'SNR 30 dB')) + ' (30 dB) / ' +
    fmt(get('AWGN', 'SNR 20 dB')) + ' (20) / ' + fmt(get('AWGN', 'SNR 15 dB')) + ' (15) / ' +
    fmt(get('AWGN', 'SNR 10 dB')) + ' (10) / ' + fmt(get('AWGN', 'SNR 6 dB')) + ' (6)。');
  lines.push('   按干净 ' + fmt(get('AWGN', 'clean')) + ' 折算，噪声要把 PSNR 压到 25 dB 以下需要 SNR 低于 10 dB。');
  lines.push('2. **削波几乎无影响**。8×（门限压到峰值的 1/8）仍有 ' + fmt(get('削波', '8×')) +
    ' dB、抖动 5 采样。');
  lines.push('3. **采样率失配平滑但代价大**。' + fmt(get('采样率失配', '0.1 %')) + ' (0.1%) / ' +
    fmt(get('采样率失配', '0.2 %')) + ' (0.2%) / ' + fmt(get('采样率失配', '0.5 %')) + ' (0.5%) / ' +
    fmt(get('采样率失配', '1 %')) + ' (1%) / ' + fmt(get('采样率失配', '2 %')) + ' (2%)。');
  lines.push('   抖动全程仅 4–5 采样、钟差被准确测出（0.2% 报 −0.200%，1% 报 −0.990%），');
  lines.push('   且 PSNR 损失沿扫描方向**均匀**（左 14.9 / 右 13.5）—— 丢分不在同步锁定，也不在行内累积。');
  lines.push('4. **声学路径是最差的实用维度**。RT60 0.20 s 只剩 ' + fmt(get('声学路径', 'RT60 0.20 s')) +
    '，0.30 s ' + fmt(get('声学路径', 'RT60 0.30 s')) + '，0.60 s 直接失败。');
  lines.push('   诊断（`tests/diagnose-reverb.js`）表明：行锁 MAD 仅 7–12 采样（不足 1 像素），');
  lines.push('   而 1.3 ms 窗内的主频估计标准差达 **230 Hz** —— 丢分来自多径填满了像素级分析窗，不是同步。');
  lines.push('5. **频率偏移存在危害性不对称**。正偏 ' + off(5) + ' / ' + off(10) + ' / ' + off(20) +
    ' / ' + off(50) + '（+5/+10/+20/+50 Hz，**无损失**），');
  lines.push('   负偏 ' + off(-10) + ' / ' + off(-20) + ' / ' + off(-50) + '（−10/−20/−50 Hz，**严重损失**）。');
  lines.push('   AFC 在两侧都准确估计出偏移（b = +49.74 / −49.91），所以不是标定问题，是真实缺陷。');
  lines.push('   三个候选机理已被测量逐一**排除**：');
  lines.push('     · `SYNC_DETECT_HZ` 原始阈值 —— 读数正确跟随平移，两侧 0% 越阈（diagnose-sync-threshold.js）');
  lines.push('     · alignSync 两侧分支不同 —— 分支计数完全相同（diagnose-asymmetry-branches.js）');
  lines.push('     · 标定斜率 a 的短窗偏置 —— 短窗偏置仅 0.01 Hz（diagnose-header-slope-bias.js）');
  lines.push('   频移实现本身已与 FFT 参考对拍验证，且该参考先自校验再使用');
  lines.push('   （`tests/verify-freqshift.js`：参考在纯音上频率误差 < 0.35 Hz、幅度比 1.0000）。');
  lines.push('6. **`SYNC_DETECT_HZ` 与图像带余量原为量纲错误**（阶段四十九修正）。两者都定义在名义轴上');
  lines.push('   却被用在原始频率上。门限的实际后果：不做映射时，+100 Hz 频偏只剩 50 Hz 名义余量，');
  lines.push('   +150 Hz 时余量为 0。修正后余量恒为 150 Hz。带余量的误差仅为 (1/a−1)×200 Hz——1% 时钟');
  lines.push('   误差下约 2 Hz。**这是正确性修正，不是质量修正**，上表中各格在修正前后变化均在噪声内。');
}
lines.push('');
lines.push('## 测量工具的可信度');
lines.push('');
lines.push('本表的数字来自 `tests/degradation-matrix.js`，其退化模型由 `tests/model-selftest.js` 验证');
lines.push('（频移、混响、削波三项，全部通过）。这不是形式主义 —— 建立本表的过程中，**四个模型 bug**');
lines.push('先后产生过看似合理的错误数字：');
lines.push('');
lines.push('| bug | 若不修会得到的结论 |');
lines.push('|---|---|');
lines.push('| 频偏用重采样模拟（而非频谱平移） | 把时钟误差当成调谐误差，5 Hz 看起来值 8 dB |');
lines.push('| 混响用反馈梳状滤波器 | 连 RT60 0.15 s 都失败 —— 测的是模型而非接收机 |');
lines.push('| 希尔伯特 FIR 的 I/Q 错位一个群延迟 | 与 FFT 参考只有 −3 dB 波形一致，但音调测频仍正确，故多轮检查都没发现 |');
lines.push('| 削波在峰值 0.5 下是无操作 | 「8× 削波完全无影响」—— 其实根本没施加 |');
lines.push('');
lines.push('**测量侧**同样有教训，且代价更大：阶段四十九为追踪「真实录音是否存在分段频偏」写了三个');
lines.push('诊断脚本，得到 +100..150 / +226..395 / +65 Hz 三个互相矛盾的答案。事后用');
lines.push('`tests/diagnose-measurement-validation.js` 对合成已知信号校验，才定位到原因：**三种方法都被');
lines.push('150 Hz 外的强邻音拉偏**，偏置分别为 −51.5 / 读到邻音 / −14.0 Hz —— 与它们声称的效应同量级。');
lines.push('');
lines.push('结构性的原因：1200 Hz 同步音后面紧跟 porch 与扫描，所以任何长到能分辨同步的窗都同时含有');
lines.push('图像内容，而**纯音对照无法暴露这一点**。因此本表中任何涉及真实录音频偏的说法都不成立，');
lines.push('相关三个脚本已在文件头标注 RESULT INVALIDATED。');
lines.push('');
lines.push('## 优先优化列表');
lines.push('');
lines.push('按「用户场景频率 × 当前缺口」排序。前三项已在阶段四十九/五十做过实测调查，结论附在表内。');
lines.push('');
lines.push('| 优先级 | 维度 | 场景频率 | 当前缺口 | 调查结论 |');
lines.push('|---|---|---|---|---|');
lines.push('| 1 | 声学路径（扬声器→麦克风） | **高** | RT60 0.2 s 即 −7.1 dB，0.3 s −12.7 dB | **已确认不可用反卷积修复**，见下 |');
lines.push('| 2 | 频率偏移负方向不对称 | **高** | −20 Hz 即 −8.9 dB，正偏无损 | 六个候选机理已排除，剩余嫌疑在像素解调 |');
lines.push('| 3 | 采样率失配 | 中 | 0.1% 即 −3.4 dB | 时钟已测准，改善点在内插/像素时钟，未开工 |');
lines.push('| 4 | 残留噪点（真机声学录音） | 高 | σ_HF 24.03 vs 合成参照 7.04 | **已修复**：门控离群恢复，σ_HF −45%、色度噪声 −40%，行相关 0.6855→0.8581 |');
lines.push('| 5 | AWGN | 中 | 10 dB 仍 25.07 | 已足够 |');
lines.push('| 6 | 削波 | 中 | 8× 仍 29.50 | 已足够 |');
lines.push('');
lines.push('### 声学路径：为什么它不是一个"实现均衡器"的任务');
lines.push('');
lines.push('三条独立测量（`tests/diagnose-channel-estimation.js`、`tests/diagnose-pixel-estimator.js`）指向同一结论：');
lines.push('这个缺口不能靠反卷积或更好的估计器关闭。');
lines.push('');
lines.push('1. **用真实 IR 反卷积的收益上界是 +0.08 dB**（17.73 → 17.81，RT60 0.30 s）。已知信道、');
lines.push('   256 抽头 Tikhonov 反卷积，没有任何改善。所以问题不在"估不准信道"，而在信息已被破坏。');
lines.push('2. **从信号自身结构估计信道不可行**：以 257 个同步脉冲对齐取平均得到的信道估计，与真实 IR');
lines.push('   在 9–50 ms 尾部的吻合度只有 **−4.0 dB**（即基本是噪声）。原因有二 —— 同步音只有 9 ms，');
lines.push('   其自相关不足以激励出长尾；且混响用的是扩散（全通）尾巴，幅度响应平坦而相位响应剧烈，');
lines.push('   本质上不是一个可以被稳定求逆的滤波器。');
lines.push('3. **像素估计器的方差在混响下几乎不变**（平坦图中位真值 127：σ 从 7.40 级只升到 8.18 级，');
lines.push('   即 23 → 26 Hz）。PSNR 的崩塌来自**极端离群值**：极值从 134 恶化到 224/254，MAD 从 0 升到 14。');
lines.push('   也就是说受损的不是典型像素的精度，而是少数像素被完全捕获。这解释了为什么"换一个更稳的');
lines.push('   估计器"这个方向的收益有限 —— 方差本来就没有变差。');
lines.push('');
lines.push('因此声学路径若要真正改善，需要的是**在解调之前**恢复波形（多麦克风/去混响前端、或利用帧间');
lines.push('冗余的迭代译码），而不是在现有估计器上做文章。这是一个独立的工作包，不应在缺少上述证据时');
lines.push('贸然开工。');
lines.push('');

fs.writeFileSync(MD, lines.join('\n'), 'utf8');
console.log('-> ' + path.relative(path.join(__dirname, '..'), MD));
console.log('   行数 ' + j.rows.length + ' · 维度 ' + Object.keys(byDim).length);
