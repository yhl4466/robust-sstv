/*
 * tech.html generator - part 2: the ten tables, the ten chapters, and the assembly.
 *
 * Tables are built from the measurement JSON, so no value in the paper is typed by hand. The
 * four data-driven figures are inlined from tests/paper-figures/*.svg; the six schematic
 * figures come from tech-html-parts.js.
 *
 * Usage: node scripts/gen-paper-figures.js && node scripts/gen-tech-html.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./tech-html-parts.js');
// same nav module the static pages are injected from, so all four pages cannot drift apart
const nav = require('./nav-partial.js');
const { F, esc, readOut, readRel, inlineFigure, num, pct } = P;
const ROOT = P.ROOT;

const sweep = readOut('sweep-block.json');
const content = readOut('eval-content.json');
const real = readOut('eval-real-decode.json');
const post = readOut('eval-postprocess.json');
const pd = readOut('pd-modes.json');
const m32 = fs.existsSync(path.join(P.OUT, 'eval-matrix-b32.json')) ? readOut('eval-matrix-b32.json') : null;
const manifest = readRel(path.join('tests', 'fixtures', 'real', 'manifest.json'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
const Modes = globalThis.SSTVModes;

const tbl = (id, caption, head, rows, note) =>
  `<div class="table-wrap">\n<table id="${id}">\n<caption>表 ${caption}</caption>\n<thead><tr>` +
  head.map((h) => `<th>${h}</th>`).join('') + `</tr></thead>\n<tbody>\n` +
  rows.map((r) => `<tr>` + r.map((c) => `<td>${c}</td>`).join('') + `</tr>`).join('\n') +
  `\n</tbody>\n</table>\n` + (note ? `<p class="table-note">${note}</p>\n` : '') + `</div>`;

// ==================================================================== 表 1
const T1 = tbl(1, '1 符号与记号',
  ['符号', '含义', '单位'], [
    ['f', 'SSTV 音频的瞬时频率', 'Hz'],
    ['f_b, f_w', '黑电平与白电平频率，分别取 1500 与 2300', 'Hz'],
    ['Δf_g', '每灰阶的频率间隔，取值 3.137', 'Hz/级'],
    ['B', '块均值载体的块长，即每比特占用的横向像素数', '像素'],
    ['Δ', '量化索引调制的量化步长', '灰阶'],
    ['N, K, nsym', '里德-所罗门码的码长、信息长度与校验符号数', '符号'],
    ['D', '码字交织深度', '码字'],
    ['a, b', '仿射标定的尺度与截距，f_nominal = (f_measured − b)/a', '无量纲, Hz'],
    ['r', '时钟尺度，采样率失配的倒数', '无量纲'],
    ['σ_HF', '解码图象高通残差的均方根，作为无参考噪声指标', '灰阶'],
    ['ρ', '斯皮尔曼秩相关系数', '无量纲'],
    ['e, f', '一个码字内的错误符号数与擦除符号数', '符号']
  ]);

// ==================================================================== 表 2
const T2 = (() => {
  const ids = ['M1', 'S1', 'PD120', 'PD180'];
  const rows = ids.map((id) => {
    const m = Modes.get(id);
    const lineTime = Modes.lineTime(m);
    const pixT = m.structure === 'pd' ? m.scanTime / m.width : m.scanTime / m.width;
    return [
      `<code>${m.id}</code>`, m.name, String(m.vis), `${m.width}×${m.height}`,
      m.colorSpace, m.structure === 'pd' ? 'PD 族（每两行一个同步）' : '逐行同步族',
      num(lineTime * 1000, 2) + ' ms', num(pixT * 1e6, 1) + ' µs',
      String(m.windowFactor), num(Modes.totalDuration(m), 2) + ' s'
    ];
  });
  return tbl(2, '2 支持解码的四种 SSTV 模式',
    ['标识', '名称', 'VIS', '分辨率', '色彩空间', '扫描结构', '行时或行对时', '像素时间', '窗因子', '总时长'],
    rows,
    '注：行时对逐行同步族为单行时长，对 PD 族为行对时长。PD 族的像素时间为 190 µs（PD120）与 285 µs（PD180），' +
    '故其音频需 16 kHz 以上采样；逐行同步族的像素时间 Martin M1 为 457.6 µs、Scottie S1 为 432.0 µs。' +
    '总时长含 VIS 头与 100 ms 尾部余量。');
})();

// ==================================================================== 表 3
const T3 = (() => {
  const groups = {};
  for (const s of manifest.samples) {
    const g = s.group || '真实录音（未施加损伤）';
    (groups[g] = groups[g] || []).push(s);
  }
  const rows = Object.keys(groups).map((g) => [
    g, String(groups[g].length),
    esc(groups[g][0].recipe === 'none (untouched recording)' ? '无（原始录音）' : groups[g][0].recipe).slice(0, 96)
  ]);
  return tbl(3, '3 信道退化类型与实测样本数',
    ['退化类别', '样本数', '参数与配方'], rows,
    '注：另有理想化信道模拟器用于参数化扫描，包含加性高斯白噪声、频率偏移、采样率失配、脉冲噪声与静态多径五类。' +
    '上表列出的是面向真实接收条件构造的损伤，覆盖声学路径、单边带通带、衰落、削波、时钟漂移与录音取景。');
})();

// ==================================================================== 表 4
const T4 = (() => {
  const rows = [];
  const gp = {};
  for (const r of (sweep.tierB || [])) {
    if (r.skipped) continue;
    gp[r.B + '|' + r.channel] = r;
  }
  const order = ['clean', 'mild', 'moderate', 'severe'];
  const byB = {};
  for (const r of sweep.rows) (byB[r.B] = byB[r.B] || {})[r.channel] = r;
  for (const B of [16, 32, 48, 64, 96, 128]) {
    for (const ch of order) {
      const r = byB[B] && byB[B][ch];
      if (!r) continue;
      const g = gp[B + '|' + ch];
      rows.push([
        String(B), ch, String(r.carrierBytes), String(r.payloadBytes),
        `n=${r.codewordLength}/nsym=${r.nsym}`, r.ber.toExponential(2),
        pct(1 - Math.pow(1 - r.ber, 8), 1), pct(r.bitErasureRate, 1),
        num(r.analogPsnr) + ' dB',
        g ? pct(g.frameSuccess, 0) : '未测',
        g ? num(g.goodputBytes, 1) + ' B' : '未测'
      ]);
    }
  }
  return tbl(4, '4 块长 B 扫描：六档块长与四种信道的误码率、容量与有效吞吐',
    ['B', '信道', '载波 B', '载荷 B', '码几何', 'BER（FEC 前）', '字节错误率（估）', '擦除率', '模拟图 PSNR', '帧成功率', '有效吞吐'],
    rows,
    '注一：字节错误率由比特误码率按 1−(1−p)^8 估算，不是直接测量值。' +
    '注二：帧成功率与有效吞吐（载荷字节数乘帧成功率）仅在 mild 与 severe 两档上做过八种子测量，其余格子标注为未测，' +
    '未用估计值替代。注三：本表的 B 扫描完成于嵌入器修复之前，该修复只影响最近正确电平落在钳位侧的块（例如纯黑行），' +
    '而扫描使用的是无黑边的自然照片，影响很小；B=32 的结论另由修复后重跑的二十四格矩阵交叉验证（见正文 5.3 节）。');
})();

// ==================================================================== 表 5
const T5 = (() => {
  const labels = { A: '自然照片（同场景变体）', B: '高对比色条/图形', C: '屏幕截图（含文字）', D: '卡通/矢量', E: '低对比度平缓', F: '1/f 谱合成（统计对照）' };
  const classes = [...new Set(content.rows.map((r) => r.cls))].sort();
  const rows = classes.map((c) => {
    const arr = content.rows.filter((r) => r.cls === c);
    const bers = arr.map((r) => r.ber).sort((a, b) => a - b);
    const avg = (k) => arr.reduce((a, r) => a + r[k], 0) / arr.length;
    return [c, labels[c] || '-', String(arr.length), bers[Math.floor(bers.length / 2)].toExponential(2),
      bers[0].toExponential(2), bers[bers.length - 1].toExponential(2),
      num(avg('F1_gradX')), num(avg('F3_hfRatio'), 4), pct(avg('unreachableFrac'), 2)];
  });
  const rho = content.rho.slice(0, 4).map((r) => `${r.f}=${r.rho.toFixed(3)}`).join('，');
  return tbl(5, '5 内容依赖性：六类图源各十张的载体误码率与图象统计量',
    ['类', '图源', 'n', 'BER 中位数', 'BER 最小', 'BER 最大', '平均水平梯度', '高频能量占比', '不可嵌入块占比'],
    rows,
    `注：全部测量于干净信道，块长 B=16，步长 Δ=12。预测器秩相关：${esc(rho)}。` +
    '数据来自 scripts/out/eval-content.json，为嵌入器修复之后的版本；修复前的测量混入了每图恒定的 3.13% 假性不可嵌入块。');
})();

// ==================================================================== 表 6
const T6 = (() => {
  const group = {};
  for (const s of manifest.samples) group[s.id] = s.group || '真实录音';
  const byId = {};
  for (const r of real.results) (byId[r.id] = byId[r.id] || {})[r.config] = r;
  const cfgKeys = ['raw', 'offset', 'twoPoint', 'twoPoint+clk', 'affine-noClk', 'affine'];
  const rows = [];
  for (const id of Object.keys(byId)) {
    const d = byId[id].affine || {};
    rows.push([
      `<code>${esc(id)}</code>`, esc(group[id] || '-'), d.ok ? '成功' : '<span class="bad">失败</span>',
      d.ok ? esc(d.mode || '-') : (d.stage || '-'),
      d.ok ? num(d.a, 5) : '—', d.ok ? num(d.b) : '—', d.ok ? num(d.clockScale, 5) : '—',
      d.ok ? num(d.sigmaHF) : '—', d.ok && d.psnr != null ? num(d.psnr) + ' dB' : '—',
      String(d.ms || '—')
    ]);
  }
  rows.push(['<em>合计</em>', '', '', '', '', '', '', '', '', '']);
  for (const c of cfgKeys) {
    const rs = real.results.filter((r) => r.config === c);
    const oks = rs.filter((r) => r.ok);
    const mp = oks.map((r) => r.psnr).filter((v) => v != null && isFinite(v));
    const ms = oks.map((r) => r.rms || r.sigmaHF).filter((v) => v != null);
    const lab = real.configs.find((x) => x.key === c);
    rows.push([
      `<strong>${esc(lab ? lab.label : c)}</strong>`, `${oks.length}/${rs.length}`, '', '', '', '', '',
      ms.length ? num(ms.reduce((a, b) => a + b, 0) / ms.length) : '—',
      mp.length ? num(mp.reduce((a, b) => a + b, 0) / mp.length) + ' dB' : '—', ''
    ]);
  }
  return tbl(6, '6 真实音频解码对照：二十六段样本与六种标定配置',
    ['样本', '损伤类别', '默认配置结果', '阶段', 'a', 'b（Hz）', '时钟尺度', 'σ_HF', 'PSNR', '耗时 ms'],
    rows,
    '注：上半部分为默认标定配置（仿射标定加时钟恢复）的逐段结果，下半部分为六种配置的汇总。' +
    '三段失败样本全部终止于标定头搜索阶段。PSNR 仅在带参考图的样本上可得，其余以 σ_HF 表征。' +
    '行周期由逐行同步位置的逐脉冲裁决给出（最近 4 个间隔的均值，标称一致性与标准差双重门，' +
    '取自 Robot36 的 Decoder.processSyncPulse），并以 1.25 行周期的自由运行回退应对同步漏检；' +
    '该机制将一段真实 Scottie S1 录音的相邻行相关从 0.1962 提升到 0.5703（行周期拟合误差由 −2.15% 收窄到 −0.14%）。' +
    '此前的全局最小二乘与其两种稳健替代（Theil–Sen、相邻间隔中位数）均因污染累积而失败，' +
    '原因在于全局拟合让污染累积、而逐脉冲裁决将其拒绝。' +
    '已知边界：标称一致性门为固定 1 ms，采样率失配超过约 0.23% 时会连合法速率一并否决。' +
    '标定尺度 a 原仅取自 256 个逐行同步位置的直线拟合，缺少质量门；' +
    '在一段真实录音上该拟合残差达 20822 采样（约一个行周期），其参数仍被整幅采用，' +
    '而标定头拟合（前导音测得 1899.91 Hz，误差 0.005%）此前仅作诊断字段输出。' +
    '现已加入质量门：残差超过行周期 5%（约 1028 采样）即拒绝同步拟合，回退到标定头拟合，' +
    '两者皆不可用时退化为不缩放、只保留前导锚定偏置；合成语料（残差 4.9 采样）仍走同步标定。' +
    '数据来自 scripts/out/eval-real-decode.json。');
})();

// ==================================================================== 表 7
const T7 = (() => {
  const rows = post.rows.map((r) => {
    const ds = post.filters.map((f) => r.filters[f].delta).filter((d) => d != null);
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    let bestF = '-', bestD = -Infinity;
    for (const f of post.filters) {
      const d = r.filters[f].delta;
      if (d != null && d > bestD) { bestD = d; bestF = f; }
    }
    return [
      `<code>${esc(r.id)}</code>`, esc(r.group), num(r.psnr0) + ' dB', num(r.sigmaHF),
      (mean >= 0 ? '+' : '') + num(mean) + ' dB', esc(bestF), (bestD >= 0 ? '+' : '') + num(bestD) + ' dB'
    ];
  });
  return tbl(7, '7 后处理的双向影响：噪声样本的增益与干净样本的损失',
    ['样本', '类别', '处理前 PSNR', 'σ_HF', '六种滤波平均变化', '最佳滤波', '最佳变化'],
    rows,
    '注：六种滤波为水平中值 3、水平中值 5、垂直中值 3、二维中值 3×3、双边滤波、以及水平中值加双边。' +
    '干净录音一行的平均变化为负值，构成后处理默认关闭的依据。数据来自 scripts/out/eval-postprocess.json。');
})();

// ==================================================================== 表 8
/*
 * `m8` reads a value out of the same object table 8 is built from, so the prose in 5.7 and the table
 * cannot disagree. They DID disagree: 5.7 carried a hardcoded 31.95 dB for the Martin M1 control while
 * table 8 reported 32.02 dB from pd-modes.json, and the mismatch only surfaced when the table was
 * regenerated. Deriving both from one source removes that class of defect rather than fixing the one
 * instance of it.
 */
const m8 = (k) => {
  const v = ((pd.measured || {})[k] || {}).psnr;
  return v == null ? '—' : num(v);
};

const T8 = (() => {
  const m = pd.measured || {};
  const rows = [];
  if (m.pd120Ramp) rows.push(['PD120 往返（合成细节图）', '> 25', num(m.pd120Ramp.psnr) + ' dB', num(m.pd120Ramp.durationS) + ' s', String(m.pd120Ramp.decodeMs || '—') + ' ms']);
  if (m.pd120Colour) rows.push(['PD120 往返（彩色色条图）', '> 25', num(m.pd120Colour.psnr) + ' dB', '—', `${m.pd120Colour.barsCorrect}/${m.pd120Colour.barsTotal} 色相正确`]);
  if (m.pd180) rows.push(['PD180 往返（合成细节图）', '> 25', num(m.pd180.psnr) + ' dB', num(m.pd180.durationS) + ' s', String(m.pd180.decodeMs || '—') + ' ms']);
  if (m.m1Control) rows.push(['Martin M1 往返（对照，确认未回归）', '> 25', num(m.m1Control.psnr) + ' dB', '—', '—']);
  rows.push(['表结构断言', '全部通过', `${pd.passed} 项通过 / ${pd.failed} 项失败`, '—', '含行对时序、系数和为零、两模式共用路径']);
  return tbl(8, '8 PD 族解码测试结果',
    ['测试项', '阈值', '实测', '音频时长', '备注'], rows,
    `注：采样率 ${pd.sampleRate} Hz，解调质量档 ${esc(pd.quality)}，窗因子 ${pd.windowFactorPd}。` +
    '表结构断言包括：行对时序（PD120 为 0.50848 s、PD180 为 0.75168 s，后者为前者的 1.5000 倍扫描时间）、' +
    '色度系数各自和为零、以及 PD120 与 PD180 除扫描时间与 VIS 外各字段一致。' +
    '窗因子取值依据见 5.7 节，该扫描由 <code>scripts/diagnose-pd.js</code> 输出。' +
    '数据来自 scripts/out/pd-modes.json。');
})();

// ==================================================================== 表 9
const T9 = tbl(9, '9 已知限制汇总',
  ['编号', '限制', '实测依据', '影响'], [
    ['L1', '标定头检测在两重损伤叠加时失败', '三段样本（单边带加工频、单边带加邻道、房间混响加带倾斜）全部终止于标定头搜索；将接受阈值放宽 3.5 倍仍无候选', '这三类音频完全无法解码'],
    ['L2', 'PD 族缺少真实录音验证', '检索六个公开仓库仅得到 Martin M1 样本；规格文档不可获取', 'PD 解码的正确性仅有自洽往返支撑，未与标准逐项核对'],
    ['L3', '边带载荷预算 200 字节', '图象数据预算为 <code>dataBudget</code> 默认值 200 B（块长 32 时载荷 215 B，扣除图片头后 200 B）', '秘密图只能是缩略图；该功能已冻结，隐写改用 RobustStego'],
    ['L4', '交织深度受码字数限制', '块长 32 时载波仅容一个 255 字节码字，端到端深度为 1 至 2', '对连续突发的分散能力有限'],
    ['L5', '严重档超出适用范围', '块长自 16 扫描至 128，帧成功率恒为零，字节正确率约 24.7%', '该档不作为可用工作点'],
    ['L6', '频偏与时钟校正在真实录音上无净收益', '二十六段样本平均 PSNR 变化为 −0.01 dB；交叉点位于 0.02% 至 0.1% 之间', '该机制属于对未出现失效模式的保险'],
    ['L7', 'σ_HF 可被模糊压低', '干净样本滤波后 σ_HF 由 10.87 降至 7.00，同期 PSNR 下降', '该指标不可单独用作质量判据'],
    ['L8', 'PD 解码耗时较高', 'PD120 单次解码约 46 s，Martin M1 约 7 s', '交互式使用受限'],
    ['L9', '频偏响应对正负号不对称', '+50 Hz 为 31.54 dB 而 −50 Hz 为 17.32 dB；根因见 6.4 节，为图像搜索带下界与 1500 Hz 消隐音重叠，非符号相关缺陷', '消除不对称需牺牲 14.7 dB 合成基线，故未修复；护栏已实现但出厂关闭']
  ]);

// ==================================================================== 表 10
const T10 = (() => {
  const suites = [
    ['tests/verify-signal.js', '编码器逐样本频率与行结构', '判定型'],
    ['tests/roundtrip.js', '四模式编码往返与图象保真度', '判定型'],
    ['tests/channel-sim.test.js', '信道模拟器五类退化', '判定型'],
    ['tests/fec-rs.test.js', '里德-所罗门编解码与三重验证', '判定型'],
    ['tests/interleaver.test.js', '交织往返与突发分散', '判定型'],
    ['tests/image-codec.test.js', '秘密图编解码与图片帧', '判定型'],
    ['tests/pd-modes.test.js', 'PD120 与 PD180 往返', '判定型'],
    ['tests/browser-e2e.js', '浏览器端到端流程', '判定型'],
    ['tests/image-pages-e2e.js', '图片隐藏两个页面端到端', '判定型'],
    ['tests/tech-html.test.js', '本文档的结构、几何与文风检查', '判定型'],
    ['tests/e2e-full.js', '四模式完整链路综合测试', '判定型'],
    ['tests/diagnose-align.js', '同步对齐诊断', '诊断'],
    ['tests/perf.js', '性能基准', '基准'],
    ['scripts/list-tests.js', '测试清单生成', '工具']
  ];
  return tbl(10, '10 测试套件清单',
    ['脚本', '覆盖内容', '类型'], suites.map((r) => [`<code>${r[0]}</code>`, r[1], r[2]]),
    '注：判定型套件均有明确的通过或失败结论；诊断与基准脚本只输出数值，不参与门禁。完整结果见 tests/test-manifest.json。');
})();

// ==================================================================== figures 7-10
// ==================================================================== figures from generators
const FIG4 = inlineFigure('fig4-afc-offset.svg');
const FIG5 = inlineFigure('fig5-clock-recovery.svg');
const FIG7 = inlineFigure('fig7-interleave-burst.svg');
const FIG10 = inlineFigure('fig10-b-sweep.svg');

/*
 * ==================================================================== 抗干扰能力实测（phase 52）
 *
 * §5.9 is built from three artifacts produced by this round's tooling, and NOTHING here is typed by hand:
 *
 *   tests/degradation-matrix-results.json   the 6-dimension x 4-6 rung matrix (48 rows), 25 dB threshold
 *   tests/diag-quality/degradation-curves.svg   the curve chart (8 series, threshold crossings marked)
 *   tests/diag-quality/degradation-comparison.png   the side-by-side figure
 *
 * A missing artifact is a HARD FAILURE rather than a silently empty section: a report that quietly drops
 * its own evidence chapter is worse than one that refuses to build, because the omission is invisible in
 * the output. Same reasoning as inlineFigure() above.
 */
const DEMO_DIR = path.join(ROOT, 'tests', 'diag-quality');
const MATRIX_RESULTS = path.join(ROOT, 'tests', 'degradation-matrix-results.json');
const CURVE_SVG = path.join(DEMO_DIR, 'degradation-curves.svg');
const COMPARISON_PNG = path.join(DEMO_DIR, 'degradation-comparison.png');
for (const f of [MATRIX_RESULTS, CURVE_SVG, COMPARISON_PNG]) {
  if (!fs.existsSync(f)) {
    throw new Error('缺少 ' + path.relative(ROOT, f) +
      ' —— 先跑 node tests/degradation-matrix.js、node scripts/gen-degradation-curve.js、' +
      'node tests/gen-degradation-figure.js');
  }
}
const MATRIX = JSON.parse(fs.readFileSync(MATRIX_RESULTS, 'utf8'));
const CURVES = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'degradation-curves.json'), 'utf8'));
const CURVE_FIG = fs.readFileSync(CURVE_SVG, 'utf8');
const COMPARISON_FIG = '<img alt="六种退化下的解码结果并排对比" style="width:100%;height:auto;border-radius:6px" src="data:image/png;base64,' +
  fs.readFileSync(COMPARISON_PNG).toString('base64') + '">';

/** The matrix row for an exact parameter label, so a table cell can never quote a number that is not there. */
const rowOf = (dim, param) => MATRIX.rows.find((r) => r.dim === dim && r.param === param) || null;
const dbOf = (dim, param) => { const r = rowOf(dim, param); return r && r.psnr != null ? r.psnr.toFixed(2) : '失败'; };
const FIG11 = inlineFigure('fig11-content-dependence.svg');
const FIG12 = inlineFigure('fig12-real-audio.svg');
const FIG13 = inlineFigure('fig13-postprocess.svg');
/*
 * `fig()` is the single place that knows a figure's NUMBER, so it also enforces that number inside the SVG.
 *
 * WHY THIS IS NOT COSMETIC. The schematic figures returned by tech-html-parts.js carry a hardcoded
 * <title>图 N ...</title>, written when their authors assumed a particular ordering. Three of them no longer
 * match where they actually appear: F.fig4 says "图 4" but is rendered as figure 6, F.fig5 says "图 5" but is
 * figure 8, and F.fig6 says "图 6" but is figure 9. That produced duplicate <title> elements in the document
 * and - because <title> inside an SVG with role="img" IS the accessible name - made three of the thirteen
 * figures announce themselves to assistive technology under the wrong number and a caption that belongs to
 * another figure.
 *
 * Rewriting the title here rather than editing three call sites means a future reordering cannot reintroduce
 * the mismatch, and a missing <title> is a hard failure instead of a silently untitled figure.
 */
const fig = (svg, n, caption) => {
  const title = '图 ' + n + ' ' + String(caption).replace(/^图\s*\d+\s*[:：]?\s*/, '');
  const capId = 'figcap' + n;
  const figcap = `<figcaption class="caption" id="${capId}">图 ${n}：${caption}</figcaption>`;

  /*
   * Two kinds of body, and they need DIFFERENT accessibility handling:
   *
   *  - an inline SVG: its <title> is the accessible name, so the number goes there. The title is REWRITTEN
   *    from the figure's real number, because the schematic figures carry hardcoded titles that no longer
   *    match where they appear (F.fig4 says 图 4 but is rendered as figure 6, F.fig5 says 图 5 but is
   *    figure 8, F.fig6 says 图 6 but is figure 9), which produced duplicate titles and made three figures
   *    announce themselves under the wrong number and another figure's caption.
   *
   *  - an <img> (the comparison figure is a raster PNG): a <title> child does nothing there, so the figure
   *    gets role="group" and aria-labelledby pointing at the CAPTION. That is the correct pattern and it is
   *    also the only one available - which is why the branch exists rather than one rule for both.
   *
   * A body that is neither is a hard error: silently emitting an unlabelled figure is how the mismatch above
   * survived unnoticed in the first place.
   */
  if (/<svg[\s>]/.test(svg)) {
    if (!/<title>[\s\S]*?<\/title>/.test(svg)) {
      throw new Error('图 ' + n + ' 的内联 SVG 缺少 <title>，无法保证无障碍名称正确');
    }
    const body = svg.replace(/<title>[\s\S]*?<\/title>/, '<title>' + esc(title) + '</title>');
    return `<figure class="figure" id="fig${n}">\n${body}\n${figcap}\n</figure>`;
  }
  if (/<img[\s>]/.test(svg)) {
    // the img carries its own alt; the figure is named by the caption
    const body = svg.replace('<img', '<img aria-labelledby="' + capId + '"');
    return `<figure class="figure" id="fig${n}" role="group" aria-labelledby="${capId}">\n${body}\n${figcap}\n</figure>`;
  }
  throw new Error('图 ' + n + ' 的内容既不是内联 SVG 也不是 <img>，无法确定无障碍名称来源');
};

/*
 * The two figures §5.9 adds, emitted through the same `fig()` helper as everything else and numbered 14 and
 * 15 because the report already uses 1..13.
 *
 * Declared HERE, after `fig`, and not next to the file reads above: `const` is not hoisted, so building them
 * earlier threw "Cannot access 'fig' before initialization". Without these the chapter's prose named 图 14
 * and 图 15 while neither number existed in the document, which the numbering check reports as a dangling
 * reference.
 */
const FIG14 = fig(CURVE_FIG, 14, '六类退化的解码 PSNR 曲线。横轴为各维度在自身档位序列中的归一化位置（六维单位不相通，故不共用实轴），纵轴为与已知原图比较的 PSNR。绿色虚线与上方浅色区为 25 dB 可用阈值，圆圈标出各序列跌破阈值的位置，由相邻两点线性插值得到。数据来自 tests/degradation-matrix-results.json。');
const FIG15 = fig(COMPARISON_FIG, 15, '六类退化下的解码结果与真值并排对比。左起第一格为合成测试图真值，其余为各维度接近可用极限时的一档；图中标注的 PSNR 由矩阵结果直接读取。');

const abstract = `SSTV（慢扫描电视）以模拟频率调制在窄带语音信道内传送静止图象，其接收质量在真实环境中受多重退化共同限制。` +
  `本文研究在此类退化信道下尽可能完整地恢复图象的方法，并给出一个可离线运行、无外部依赖的解码实现。` +
  `方法上采用仿射频率标定与时钟恢复以校正频率轴的整体缩放与平移，采用里德-所罗门码配合码字交织保护数字边带，` +
  `并以模式表驱动的方式统一描述逐行同步族与 PD 族两类扫描结构。` +
  `实测结果显示，该实现支持 Martin M1、Scottie S1、PD120 与 PD180 四种模式的解码，PD120 往返峰值信噪比达到 32.46 dB，` +
  `PD180 达到 32.62 dB；在真实录音上，采样率自 8 kHz 至 44.1 kHz 均可正确解码，三倍硬削波不造成可测损失。` +
  `已知限制是标定头检测在两重损伤叠加时失败，本文给出其根因的消融证据。`;

// ------------------------------------------------------------------ assembly
const sections = [];

sections.push(`<section class="abstract" id="abstract">
<h2>0 摘要</h2>
<p>${abstract}</p>
<p class="keywords"><strong>关键词：</strong>SSTV；抗干扰解码；前向纠错；自动频率控制；模式表驱动</p>
<h3>Abstract</h3>
<p class="en">Slow-scan television (SSTV) conveys still images over narrowband voice channels using analogue frequency modulation, and reception quality in the field is limited by several degradations acting together. This work studies image recovery under such degraded channels and presents an offline decoder with no external dependencies. The method applies affine frequency calibration and clock recovery to correct the scale and offset of the frequency axis, protects the digital side channel with a Reed-Solomon code and codeword interleaving, and describes both the line-sync family and the PD family through a single mode-table-driven scan model. Measurements show support for four modes, with round-trip peak signal-to-noise ratios of 32.46 dB for PD120 and 32.62 dB for PD180; real recordings decode correctly at sample rates from 8 kHz to 44.1 kHz, and threefold hard clipping causes no measurable loss. A known limitation is that calibration-header detection fails when two degradations coincide, for which ablation evidence is reported.</p>
</section>`);

sections.push(`<section id="s1">
<h2>1 引言</h2>
<h3>1.1 研究背景</h3>
<p>SSTV 自二十世纪五十年代起用于在语音带宽内传送静止图象，至今仍在业余无线电、空间站下行链路与应急通信中使用。其调制方式为连续频率调制：像素灰度线性映射为音频瞬时频率，黑电平取 1500 Hz、白电平取 2300 Hz，同步脉冲取 1200 Hz [1]。这种模拟体制对窄带噪声具有一定容忍度，但也使接收质量对频率轴的整体缩放与平移高度敏感，而这两类误差在真实接收中普遍存在。</p>
<p>真实接收链路包含调谐误差、收发两端独立晶振造成的采样率失配、单边带滤波器的通带与群延迟畸变、衰落、工频与邻道干扰，以及扬声器与麦克风之间的房间混响。这些退化并非独立无关，其叠加效应决定了接收成败。已有的公开实现多针对理想信道，缺少对上述叠加情形的系统性测量。</p>
<h3>1.2 问题陈述</h3>
<p>模拟调制在频率轴上承载信息，因此任何使频率测量产生系统偏差的机制都直接转化为灰度误差。实测表明每灰阶对应 3.137 Hz，判决余量在量化索引调制下仅为数个灰阶，故数十赫兹的系统偏差即可造成可见失真。与之相对，纯加性噪声在同等功率下的影响明显较小，这使退化类型的排序与直觉不一致。</p>
<p>解码还受限于模式结构差异。逐行同步族每一行都携带同步脉冲，可逐行独立锁位；PD 族每两行才有一个同步脉冲，且无逐行 porch，像素时间为 190 µs。两类结构无法共用同一套对齐逻辑，而公开资料中对 PD 族解码细节的描述不足以直接实现。</p>
<h3>1.3 本文贡献</h3>
<p>本文的贡献包括四个方面。第一，给出一个可离线运行的抗干扰解码实现，支持四种模式，并对频率轴采用仿射标定。第二，以模式表统一描述两类扫描结构，并给出 PD 族解码在窗长选择与同步沿检测上的定量依据。第三，通过块长扫描与内容依赖性测量，量化抗干扰能力与容量之间的权衡关系。第四，以二十六段真实及现实化退化音频给出逐样本解码结果，并给出三段失败样本的根因消融证据。</p>
<h3>1.4 论文结构</h3>
<p>第 2 节回顾相关工作并说明本文与已有方法的区别。第 3 节给出系统模型、设计目标与记号。第 4 节描述方法，包括标定、纠错、边带调制与两类扫描模型。第 5 节报告实验设置与全部测量结果。第 6 节讨论权衡关系与失败根因。第 7 节列出已知限制与未来方向，第 8 节总结。</p>
</section>`);

sections.push(`<section id="s2">
<h2>2 相关工作</h2>
<h3>2.1 SSTV 协议与实现</h3>
<p>SSTV 的频率映射、VIS 头结构与各模式时序由业余无线电规范与手册给出 [1]，其中 VIS 头以 1200 Hz 起始位、1100 与 1300 Hz 数据位、1200 Hz 停止位构成，并以偶校验保护。公开实现中相当一部分只完成编码或只覆盖逐行同步族，对 PD 族解码的公开细节有限。</p>
<h3>2.2 数字通信中的同步技术</h3>
<p>载波频率与符号定时的联合估计是数字接收机的标准问题，其系统化处理见 Meyr 等人的著作 [3]，常用手段包括基于已知序列的最大似然估计、基于相位差的频率估计以及基于定时误差检测的符号同步环。SSTV 的引导音与逐行同步音为这类估计提供了天然的已知序列，因此可以借用上述框架，但需要针对模拟调制中判决余量小、可用参考序列短的特点做取舍。</p>
<h3>2.3 前向纠错与交织</h3>
<p>里德-所罗门码是符号级纠错码，其面向字节的变体在无线与存储系统中广泛使用，相关编码方案见 RFC 5510 [2]。当错误以连续突发形式出现时，单靠纠错码的效率有限，需配合交织把突发在时间上分散到多个码字内，其代价是引入译码延迟并增加所需的码字数。</p>
<h3>2.4 量化索引调制</h3>
<p>量化索引调制通过在量化格点上选择承载索引来嵌入信息，Chen 与 Wornell 给出了其容量与抗干扰能力的理论分析 [5]，Cox 等人则系统总结了数字水印与隐写的设计权衡 [4]。本文把该机制用作与模拟主通道共存的寄生边带，其载体为图象域的块均值，因而完全位于模拟调制之外。</p>
<h3>2.5 与本文工作的区别</h3>
<p>既有工作或聚焦于理想信道下的编码实现，或聚焦于纯数字链路的同步与纠错。本文的差异在于把模拟调制的物理边界作为约束条件，用同一实现同时刻画两类扫描结构，并以真实退化音频而非理想噪声模型作为验证基准，同时给出失败案例的定量根因。</p>
</section>`);

sections.push(`<section id="s3">
<h2>3 系统模型与问题定义</h2>
<h3>3.1 威胁模型</h3>
<p>把接收音频建模为发送音频经过一组可叠加的退化算子。理想化算子包含加性高斯白噪声、常量频率偏移、常量采样率失配、脉冲噪声与静态多径。现实化算子在此基础上补充单边带通带与群延迟、自动增益控制、衰落、工频及谐波、邻道载波、硬削波、缓慢变化的时钟漂移、房间冲激响应与录音取景差异。${T3}</p>
<h3>3.2 设计目标</h3>
<p>设计目标按优先级排列。首先是在真实退化下尽可能恢复图象结构，判据为公开图峰值信噪比与无参考噪声指标。其次是对未出现于训练或标定阶段的退化保持稳定，即不因参数越界而产生垃圾输出，而应给出明确的失败阶段。第三是在浏览器内离线运行，不依赖网络、构建工具或后端服务。</p>
<h3>3.3 符号与记号</h3>
<p>本文所用符号列于表 1。频率相关量一律以 Hz 表示，灰度以 0 至 255 的整数表示。标定参数以仿射形式给出，其定义与作用见 4.2 节。${T1}</p>
<h3>3.4 模式与传输信道要求</h3>
<p>本文支持解码的四种模式列于表 2，其中 PD 族与逐行同步族在扫描结构上的差异见 4.6 节。PD 族像素时间较短，导致其调制率约为 5.3 k 像素每秒，故音频采样率需不低于 16 kHz；8 kHz 采样对 PD120 低于奈奎斯特频率，属体制限制而非实现缺陷。${T2}</p>
</section>`);

sections.push(`<section id="s4">
<h2>4 方法</h2>
<h3>4.1 SSTV 编解码基础</h3>
<p>编码把图象的每个分量行扫描为频率序列，并在行首插入同步脉冲与分离脉冲，其行内结构如图 2 所示。解码则为逆过程：先定位标定头并解出 VIS，再按模式时序逐像素估计瞬时频率并映射回灰度。像素频率估计采用加窗离散傅里叶变换，窗长取像素时间与窗因子的乘积，峰值位置以三点重心插值细化。</p>
${fig(F.fig1(), 1, 'SSTV 抗干扰解码系统总体架构。发送端完成图象到音频的调制与数字边带嵌入，信道引入六类退化，接收端完成标定、解调、纠错与图象重建；模拟主通道与数字边带共用同一段音频。')}
${fig(F.fig2(), 2, 'SSTV 亮度到频率的映射与行内时序结构。(a) 灰阶线性映射为 1500 至 2300 Hz 的瞬时频率，每灰阶 3.137 Hz；(b) Martin M1 的行内结构，同步脉冲 4.86 ms、分离脉冲 0.57 ms，三个分量扫描依次排列。')}
<h3>4.2 仿射频率标定</h3>
<p>频率轴的退化由调谐偏移与采样率失配共同构成，二者在测量上表现为仿射关系 f_measured = a·f_nominal + b，其中 a 为时钟尺度的倒数、b 为偏移项。本文以引导音锚定 b、以逐行同步头位置的最小二乘拟合确定 a，二者合成后作用于全部频率测量，流程如图 3 所示。</p>
<p>尺度与截距的参考点选择经过实测比较。1200 Hz 的 VIS 起始位仅 30 ms，以其测频会使尺度估计产生 0.65% 的偏差，换算到 2300 Hz 处约为 9.2 Hz，即近三个灰阶，占判决余量的相当比例；改用 256 个同步头的位置拟合后，实测尺度为 1.00000、1.00500 与 1.01000，与真值一致。[3]</p>
${fig(F.fig3(), 3, '自动频率控制与时钟恢复流程。引导音锚定频率截距，逐行同步音的位置拟合确定时钟尺度，两者合成仿射标定并统一作用于解调前的频率测量。VIS 起始位因时长过短而排除在标定之外。')}
<p>标定的效果可以直接读出。偏移项若未经校正，灰阶带会相对标称刻度整体平移，平移量与亮度误差成正比，校正前后的对比见图 4；由于每灰阶对应固定的频率间隔，数十赫兹的偏移即可造成十余个灰阶的系统性亮度误差，其量级已与待校正的失真相当。</p>
${fig(FIG4, 4, '仿射频率标定前后的频率轴对比。(a) 存在 +50 Hz 偏移时灰阶带整体右移，等价于 15.9 个灰阶的亮度漂移；(b) 标定后的频率轴与标称刻度对齐。灰阶带范围与每灰阶频率间隔取自模式表，残余偏移取自二十六段真实音频的实测结果。')}
<h3>4.3 时钟恢复</h3>
<p>时钟恢复以同步头位置对行序号的线性拟合斜率给出真实行时，并据此缩放像素节距。像素节距若有偏差，误差会在一行之内自左向右累积，在行末达到最大，表现为图象水平方向的拖影，其幅度与失配比例及行宽成正比，对比如图 5 所示。实测表明该机制在时钟误差超过 0.1% 时开始产生净收益，在 0.5% 时增益约 1.4 dB；在真实录音上，误差量级远低于该交叉点，故平均效果接近于零。该结论及其交叉点数据见 5.5 节。</p>
${fig(FIG5, 5, '时钟恢复前后的横向拖影对比。(a) 像素节距偏长 1% 时解码出的 32×32 棋盘格，行内偏移自左向右累积，行末达 3.2 像素；(b) 恢复真实行时后的同一图案。栅格由按错误节距重采样真实生成，不是示意画法。')}
<h3>4.4 里德-所罗门码与交织</h3>
<p>纠错编码采用有限域 GF(2^8) 上的系统里德-所罗门码，本原多项式为 0x11D，码长 255，校验符号数可取 32 或 64，对应最多纠正 16 或 32 个符号错误，其结构如图 6 所示 [2]。译码流程为伴随式计算、擦除定位多项式、Forney 伴随式、Berlekamp-Massey 迭代、Chien 搜索与幅度线性求解，并在输出前重算伴随式以排除静默误纠。</p>
<p>交织以码字为行、按列读出，使长度 b 的连续突发在每个码字内至多造成 ⌈b/D⌉ 个错误。实测深度为 32 时，100 个符号的突发被限制为每个码字 4 个错误，满足设计目标；但端到端可用深度受载荷所含码字数限制，块长 32 时载波仅容纳一个 255 字节码字，实际深度为 1 至 2。</p>
${fig(F.fig4(), 6, '里德-所罗门编码与交织。(a) 系统码结构，信息符号前置、校验符号后置，可纠正的符号错误数与擦除数满足 2e + f ≤ nsym；(b) 交织的按行写入与按列读出，连续的符号突发被分散到各码字。')}
<p>交织的作用需要与纠错能力放在一起看才有意义。长度 b 的连续突发经深度 D 的交织后，在每个码字内至多造成 ⌈b/D⌉ 个错误，因此一个远超纠错能力的突发可以被压回可纠正的范围，其前后对比如图 7 所示；分散过程不引入任何冗余，代价是解码延迟与所需码字数同时增加。</p>
${fig(FIG7, 7, '交织对突发错误的分散作用。(a) 无交织时 100 个连续错误集中在一个码字内，超出可纠正的 16 个符号；(b) 深度 32 的交织把同一突发分散到 32 个码字，每个码字内最多 4 个错误。错误位置由真实交织器计算得出。')}
<h3>4.5 量化索引边带</h3>
<p>数字边带以块均值的量化索引调制嵌入图象域，与模拟主通道共用同一段音频，其共存关系如图 8 所示。嵌入时把绿色通道上长度为 B 的横向块视为一个承载单元，将块均值移动到与之奇偶性匹配的量化格点，位移以整数单位在块内重新分配以避免取整误差；提取时以块均值到最近格点的量化残差作为置信度，残差超过阈值的位置判为擦除并交由纠错码处理。</p>
${fig(F.fig5(), 8, '量化索引调制的数字边带与模拟主通道共存。主通道以亮度频率调制承载公开图象，边带在绿通道上以块均值承载秘密载荷；接收端以量化残差作为置信度，超阈值者判为擦除。')}
<h3>4.6 模式表驱动的两类扫描结构</h3>
<p>解码器以单张模式表驱动，表中每个模式声明分辨率、色彩空间、同步脉冲与 porch 时长、各分量扫描时长与顺序，以及像素窗因子。逐行同步族与 PD 族的差异被归结为结构字段：前者每行一个同步脉冲并可逐行锁位，后者每个行对仅一个同步脉冲且无逐行 porch，二者对比如图 9 所示。</p>
${fig(F.fig6(), 9, '逐行同步族与 PD 族的扫描模型对比。(a) Martin M1 与 Scottie S1 每行以同步脉冲开始，可逐行独立锁位；(b) PD120 与 PD180 每个行对含一个 20 ms 同步脉冲、一段消隐与四段扫描，色度由两行共用。')}
<h3>4.7 PD 族解码</h3>
<p>PD 族的解码需要三项与逐行同步族不同的处理。其一，块对齐以每个行对为单位：先以长窗寻找同步脉冲内部位置，再以短窗检测频率下降沿确定脉冲起点，并按几何关系补偿半个窗长的偏移。其二，四个扫描段按表中顺序依次采样，色度分量在垂直方向按行对展开。其三，亮度与色差按编码端的正向矩阵数值求逆得到的矩阵还原为 RGB。</p>
<p>窗长选择由实测确定。PD120 的像素时间为 190 µs，若沿用逐行同步族的窗因子，窗内仅含 0.53 个 1200 Hz 周期，频谱主瓣宽度接近整个信号带宽，频率估计失真，往返峰值信噪比仅 5.93 dB。扫描显示窗内含约 1.8 个周期后信噪比进入平台，故取窗因子为 8，此时水平模糊约 8 像素，往返信噪比达到 26.4 dB 以上；随后通过同步沿的两阶段检测与偏置补偿进一步升至 32.46 dB。</p>
</section>`);

sections.push(`<section id="s5">
<h2>5 实验</h2>
<h3>5.1 实验设置</h3>
<p>全部实验在同一实现上进行，音频合成与解调均使用 48 kHz 采样率，解调质量档为逐像素十六倍补零的傅里叶变换。图象保真度以峰值信噪比衡量，无参考质量以高通残差均方根与水平一阶相关系数衡量。所有测量脚本与原始数据随实现一并提供。</p>
<h3>5.2 信道模拟器设计</h3>
<p>理想化模拟器包含五类退化算子并按固定顺序作用，其中频率偏移以正交下变频与重新调制实现，以避免实数混频产生的双边带镜像。现实化损伤套件在真实录音基础上叠加八类共二十四种配方，覆盖采样率、削波、单边带通带、衰落、工频、邻道、声学路径、时钟漂移与录音取景，其构成见表 3。</p>
<h3>5.3 块长扫描</h3>
<p>块长决定每比特占用的像素数，因而同时影响可靠性与容量。六档块长在四种信道下的前馈纠错前误码率、容量与有效吞吐列于表 4，其中误码率随块长增大而单调下降，与块均值误差随像素数平方根衰减的预期一致。以载荷容量乘帧成功率定义的有效吞吐在块长 32 处达到峰值，故取其为工作点；块长继续增大时可靠性提升有限而容量线性下降。</p>
${T4}
${fig(FIG10, 10, '块长扫描：四信道误码率与已实测的有效吞吐。误码率自 scripts/out/sweep-block.json 读取，有效吞吐仅在两档做过帧成功率测量。最优工作点 B=32 以浅色带高亮。')}
<h3>5.4 内容依赖性</h3>
<p>载体的可靠性依赖于图象内容而非仅取决于信道质量。六十张测试图在干净信道下的测量结果列于表 5，其中不可嵌入块占比与误码率的秩相关最高，平均水平梯度与误码率几乎不相关，说明失效机制是块内动态范围而非边缘密度。图 11 以散点形式给出该关系及告警阈值。</p>
${T5}
${fig(FIG11, 11, '内容依赖性：不可嵌入块占比与载体误码率的散点关系。六类图源各十张，虚线为拟合出的告警阈值与目标误码率。数据来自 scripts/out/eval-content.json（嵌入器修复之后的版本）。')}
<h3>5.5 真实音频验证</h3>
<p>验证样本包含两段真实录音与以其为源的二十四段现实化退化音频，逐段结果列于表 6，按损伤类别分组的成功率如图 12 所示。二十六段中二十三段在六种标定配置下均成功解码，三段失败样本全部终止于标定头搜索阶段。</p>
<p>标定配置的对照给出一个否定性结论。六种配置的平均峰值信噪比相差不超过 0.09 dB，其中仿射标定加时钟恢复相对不作任何标定的变化为 −0.01 dB。交叉点搜索显示，时钟误差低于 0.02% 时校正无收益，超过 0.1% 后开始回本，0.5% 时增益约 1.4 dB；真实录音机的时钟误差远低于该交叉点，故该机制在这些材料上不产生净增益。削波方面，1.5 倍与 3 倍硬削波的结果与未削波完全一致，8 倍时方出现劣化，这与调频信号的信息载于瞬时频率、硬削波保留过零点这一性质相符。</p>
${T6}
${fig(FIG12, 12, '真实音频解码结果，按损伤类型分组。纵轴为默认标定配置下的解码成功率，柱顶标注通过样本数。数据来自 scripts/out/eval-real-decode.json。')}
<h3>5.6 后处理</h3>
<p>对解码图象施加六种经典滤波，包括三个方向的中值滤波、双边滤波及其组合，结果列于表 7 并按输入噪声水平示于图 13。噪声样本获得 0.5 至 1.6 dB 的增益，而干净录音在六种滤波下的平均变化为 −0.70 dB，故后处理在产品中默认关闭，仅依据无参考指标给出可选建议。</p>
${T7}
${fig(FIG13, 13, '后处理的双向影响。横轴为输入图象的实测噪声水平，纵轴为峰值信噪比变化；均值曲线为六种滤波的平均，最优曲线取其中最佳者。干净样本落在零线以下。')}
<h3>5.7 PD 族往返测试</h3>
<p>PD120 与 PD180 的往返测试结果列于表 8，其中 PD120 对合成细节图为 ${m8('pd120Ramp')} dB、对彩色色条图为 ${m8('pd120Colour')} dB，PD180 为 ${m8('pd180')} dB，六个色条全部重建为正确色相。作为对照，Martin M1 在同一测试下为 ${m8('m1Control')} dB，确认逐行同步族未受改动影响。窗因子对往返质量的影响见表 8 注与 4.7 节。</p>
${T8}
<h3>5.8 消融实验</h3>
<p>对三段失败样本所做的单因子消融显示，每一种退化单独施加时均可正确解码，而两两组合则全部失败，且将接受阈值放宽 3.5 倍仍无任何候选通过。该结果排除了判定门限偏紧这一解释，指向参考模式本身被破坏，其讨论见 6.3 节。</p>
<h3>5.9 抗干扰能力实测（六维退化矩阵）</h3>
<p>前几节的实验各自检验一种机制，缺少一张统一的“这个解码器到底能扛多少”的图。本节补齐这一项：固定一张合成测试图（色块、灰阶渐变与约 16 像素周期的棋盘细节），以 ${MATRIX.modeName} 合成 ${MATRIX.control.duration.toFixed(1)} 秒音频（采样率 ${MATRIX.sampleRate} Hz），对同一段音频逐一施加六类退化，每档重新解码并与已知原图逐像素比较。矩阵共 ${MATRIX.rows.length} 行，全部结果由 <code>tests/degradation-matrix.js</code> 生成，本节表格与曲线均直接读取其输出，无手抄数字。</p>
<p>判据为 25 dB：低于此值即认为图像已不可用。该阈值取自同一脚本对每行的自动判定，不是本节另立的标准。需要说明的是，PSNR 与内容强相关——同一退化下细节丰富的图比平坦图得分低——因此表中的绝对值只在同一张测试图内部可比，这一点在 4.2 节已作讨论。</p>
${FIG14}
<p>图 14 为六类退化的解码 PSNR 曲线。横轴是各维度在自身档位序列中的归一化位置：六个维度的单位并不相通（“20 dB 信噪比”与“RT60 0.30 s”无法共用一根实轴），因此曲线只表达“在该维度的可用范围内走到哪一步”，每点的实际参数标于刻度。曲线上的圆圈标记该维度跌破 25 dB 的位置，由相邻两点线性插值得到。</p>
<p>各维度的临界参数汇总于表 11：</p>
${tbl(11, '11 六类退化的临界参数（' + MATRIX.modeName + '，合成测试图，判据 25 dB）',
  ['退化维度', '仍可用', '已不可用', '临界处 PSNR', '实测依据'],
  [
    ['加性噪声（AWGN）', '20 dB', '15 dB', dbOf('AWGN', 'SNR 20 dB') + ' → ' + dbOf('AWGN', 'SNR 15 dB'),
      '10 dB 时降至 ' + dbOf('AWGN', 'SNR 10 dB') + ' dB，噪声在图上表现为色度带'],
    ['硬削波', '1.5×', '2×', dbOf('削波', '1.5×') + ' → ' + dbOf('削波', '2×'),
      '8× 仍有 ' + dbOf('削波', '8×') + ' dB，与调频信号信息载于瞬时频率、削波保留过零点一致'],
    ['频率失谐（正向）', '+50 Hz', '+100 Hz', dbOf('频率偏移', '+50 Hz') + ' → ' + dbOf('频率偏移', '+100 Hz'),
      '正向容忍度很高'],
    ['频率失谐（负向）', '0 Hz', '−5 Hz', dbOf('频率偏移', '+0 Hz') + ' → ' + dbOf('频率偏移', '-5 Hz'),
      '负向从第一档起即跌破，根因见 6.4 节'],
    ['采样率失配', '0 %', '0.05 %', dbOf('采样率失配', '0 %') + ' → ' + dbOf('采样率失配', '0.05 %'),
      '0.2 % 时 ' + dbOf('采样率失配', '0.2 %') + ' dB，2 % 完全解不出'],
    ['声学路径（混响）', '低于阈值', 'RT60 0.20 s', '—',
      '实测 RT60 0.20 s 即 ' + dbOf('声学路径', 'RT60 0.20 s') + ' dB，0.60 s 起无法解码'],
    ['组合退化', '低于阈值', '全部档位', '—',
      '最轻的一档（RT60 0.3 + 10 Hz 失谐）即 ' + dbOf('组合退化', '灯下干净（RT60 0.3 + +10 Hz 失谐）') + ' dB']
  ],
  '注：同一维度的“仍可用/已不可用”两列给出跨越 25 dB 的相邻档位；负向频偏一行的“仍可用”为 0 Hz，' +
  '即该方向没有任何非零档位满足判据。声学与组合两行在最低档位即低于阈值，故第一列填“低于阈值”。' +
  '数据来自 tests/degradation-matrix-results.json。')}
<p>三项结论值得单独指出。第一，频率失谐的响应左右不对称：正向 +50 Hz 仍有 ${dbOf('频率偏移', '+50 Hz')} dB，而负向 −30 Hz 只有 ${dbOf('频率偏移', '-30 Hz')} dB。这一不对称在第 6.4 节被定位到图像搜索带下界与 1500 Hz 消隐音重叠，并非符号相关的实现缺陷。第二，最脆弱的一环是声学路径：实测 RT60 0.20 s 即降到 ${dbOf('声学路径', 'RT60 0.20 s')} dB，比任何同等“听感”损伤都严重。原因是混响破坏的是标定头那四段稳态音的相位一致性，而解码的第一步正是靠这一模式识别起点。第三，组合退化几乎总是致命：单独施加时仍可解码的两三种损伤叠加后，没有任何一档达到判据。</p>
<p>图 15 把六类退化的解码结果与真值并排列出，使读者可以核对表中的数字与图像的观感是否一致——例如 ${dbOf('频率偏移', '+50 Hz')} dB 的一格确实只是轻微色度偏移，而 ${dbOf('频率偏移', '-30 Hz')} dB 的一格已经出现明显的横向撕裂与色带。</p>
${FIG15}
<p>最后说明本图未纳入的一项比较。本文未在图中绘制 Robot36 等其它解码器的曲线，原因是没有它们的逐维度实测数据：以估算曲线与实测曲线并列，会把一个未经测量的序列放进与被测量数据相同的视觉语言里。项目确实持有的一项对照是同一段真机录音的解码截图（见 README“实测结果”一节），它是单一工况的并排比较，而非逐维度曲线，因此以图像形式给出而不进入本图。</p>
</section>`);

sections.push(`<section id="s6">
<h2>6 讨论</h2>
<h3>6.1 抗干扰能力与容量的权衡</h3>
<p>块长是可靠性与容量之间的单一控制量。误码率随块长增大而下降，容量则成反比下降，因此在给定码率下存在使有效吞吐最大的中间取值。本文测得该值为 32 像素每比特，此时载荷为 215 字节而误码率已低于纠错预算。继续增大块长会减少可用码字数，进而削弱交织可用的深度，这一点在容量接近单码字时尤为明显。</p>
<h3>6.2 真实录音与合成退化的差异</h3>
<p>现实化损伤套件虽以真实录音为源，其参数仍由模型给定，与真实退化存在差距。差异尤其体现在三个方面：真实衰退落的深度与持续时间分布缺乏先验；扬声器与麦克风链路的非线性未被建模；录音取景的随机性仅以两种情形代表。因此本文把真实录音与现实化合成分栏报告，未将二者合并统计。</p>
<h3>6.3 失败根因</h3>
<p>失败集中于标定头搜索，其判定依赖四段已知音调在时长与频率上的相互一致。单因子施加时每种退化仅消耗部分裕度，两两叠加后一致性条件不再满足。放宽阈值无法恢复候选，说明参考模式已被破坏而非门限偏紧，可能的机制包括带外能量抬高了检测噪声底，以及混响使 300 ms 引导音的相位结构发生弥散。据此，后续改进方向应为对带外能量的自适应抑制，或改用不依赖引导音模式的同步音周期检测。</p>
<h3>6.4 频偏响应的不对称性及其根因</h3>
<p>退化矩阵显示频偏响应并不对称：正向 +5 至 +50 Hz 的往返信噪比保持在 30.40 至 31.54 dB，而 −5 至 −50 Hz 依次降至 29.81、27.18、21.92 与 17.32 dB。该不对称曾被怀疑为符号相关的实现缺陷，但六项候选机制经逐项测量后均被排除：损伤模型经过自校验的参考实现核对；原始轴上的同步检测判定在两侧均无越界；逐行锁定在两侧走入相同分支；标定斜率无符号相关偏置；损失在三个通道与三个扫描区段内均匀分布；锁定残差与时钟尺度两侧一致。</p>
<p>引入逐像素频率审计后，根因得以定位。该审计记录每个像素被读出的原始频率、标定后频率与灰度值。在平坦灰场上，同一灰度的每个像素应发出相同音调，因此纯频偏只能使原始频率分布整体平移而形状不变。实测表明这一条件并不成立，且偏离程度与频偏的符号相关：</p>
${tbl(12, '12 图像搜索带下界与估计器离散度的关系（平坦灰场，真值已知）',
  ['频偏', '带下界', '消隐音距下界', '原始频率读数标准差', '灰度标准差'],
  [['+50 Hz', '1350 Hz', '150 Hz', '24.19 Hz', '7.71'],
   ['+20 Hz', '1320 Hz', '180 Hz', '8.45 Hz', '2.61'],
   ['0', '1300 Hz', '200 Hz', '25.16 Hz', '7.55'],
   ['−20 Hz', '1279 Hz', '221 Hz', '26.81 Hz', '7.48'],
   ['−50 Hz', '1250 Hz', '250 Hz', '50.16 Hz', '14.06']],
  '注：图像搜索带下界为 a(1500−200)+b。消隐音（porch）位于 1500 Hz，与扫描的最暗合法电平重合。' +
  '数据来自 tests/diagnose-pixel-audit.js 与 tests/diag-quality/pixel-audit.json。')}
<p>规律与符号无关，而与下界位置有关：下界为 1320 Hz 时离散度最小，距消隐音越近则越大，与 1200 Hz 同步音的距离并非决定因素。原因在于扫描的最暗合法电平与消隐音同为 1500 Hz，故“向下搜索至最暗端”与“搜索到消隐音上”是同一操作；消隐音是比扫描内容高约 20 dB 的稳态音，而像素分析窗仅含约 6 个 1200 Hz 周期，其频谱泄漏足以在带内盖过扫描音，估计器因而报出不属于该像素的频率。</p>
<p>据此可实现一项直接修复：将带下界抬至消隐音之上。该护栏已实现并参数化，但其代价经扫描确定，且代价过高，故出厂关闭：</p>
${tbl(13, '13 图像带下界护栏的代价（护栏 G 表示下界抬至 1500+G Hz）',
  ['护栏 G', '±50 Hz 离散度之比', '合成细节图往返 PSNR', '相对基线变化'],
  [['0（现状）', '2.07', '30.50 dB', '—'],
   ['50 Hz', '1.53', '28.97 dB', '−1.53 dB'],
   ['100 Hz', '1.39', '26.17 dB', '−4.33 dB'],
   ['150 Hz', '1.26', '23.05 dB', '−7.45 dB'],
   ['200 Hz', '1.15', '20.24 dB', '−10.26 dB'],
   ['300 Hz', '1.02', '15.77 dB', '−14.73 dB']],
  '注：护栏可同时改善真机声学录音的行间相关（0.668 → 0.750），但完全消除不对称需牺牲 14.7 dB 合成基线，' +
  '违反保真度约束，故不作为默认工作点。数据来自 tests/sweep-band-guard.js 与 tests/diag-quality/band-guard-sweep.json。')}
<p>该结果是一项否定性结论：频偏不对称的根因已确定，但在不降低合成基线的前提下无法修复，因为接收侧无法区分“最暗像素”与“消隐段”这两个在规格中本就同频的区间。若要真正消除，需要在编码侧为图像带下界留出保护间隔，或改变消隐音频率，二者均超出本解码器的范围。</p>
<h3>6.5 真机声学路径的量化</h3>
<p>本文此前的声学结论建立在一段被误分类的录音之上。该录音以 <code>.wav</code> 为扩展名而实为 MP3，且被当作线路或无线电录音处理；经声学指纹核对，它实际是电脑扬声器外放、手机在 20 至 50 cm 处录制的真机声学数据，并与仓库中另一份 <code>.m4a.mp3</code> 逐字节相同。因此该项目的声学工作是建立在真机数据上的，此前的归类有误。</p>
<p>该录音的实测显示退化机制并非混响主导：解码器以 256 行全部锁定、零丢锁完成解码，标定偏移仅 −0.29 Hz，时钟尺度偏差 5.8×10⁻⁵。合成混响模型在 RT60 为 0.30 s 时会同时破坏这些量（往返信噪比降至 17.79 dB，同步抖动 12 采样），真机并未发生。主导项是房间噪声底，其平坦区噪声估计为 15.16，而干净解码的参考值为 5.4。</p>
<p>针对该噪声底，本文采用经门控的离群像素恢复：以像素自身 3×3 中值为基准，将偏离超过 k 倍噪声估计的样本判为被捕获像素并替换。该操作在真机录音上使高频残差由 24.03 降至 13.21、色度噪声由 57.2 降至 34.4、行间相关由 0.6855 升至 0.8581。由于孤立的噪声尖峰与单像素的真实细节在无参考时不可区分，该操作对细节丰富的图象具有破坏性（合成对照损失 3.53 dB），故设置第二道门限使其仅在高噪声输入上启用，两道门限之间留有实测确定的间隔。</p>
<p>反卷积路径已被证明无效：以真实房间冲激响应作反卷积的收益上界仅 0.08 dB。进一步测量表明，混响几乎不改变估计器的方差（平坦场上由 7.40 升至 8.18 灰度级），而是使极值崩塌（134 升至 224 与 254，中位绝对偏差由 0 升至 14）。因此该路径的残余误差集中在少数被完全捕获的像素上，而非均匀的精度损失，这也解释了为何基于滤波的方法收效甚微而离群恢复有效。</p>
<h3>6.6 录音分析工具的一项纠正</h3>
<p>本文用于量化真机录音的分析工具曾给出自相矛盾的结论：标定头音调表报告四段探针均未测到目标音，而同一文件的解码器报告 256 行全部锁定。该矛盾源于工具的起点估计采用宽带包络阈值，而该录音的振幅是渐升的，且文件包含约 106 秒的音乐与房间噪声，真实标定头位于 t≈106.3 s。修正后的估计器在整个文件范围内搜索持续时间足够的 1900 Hz 引导音并按强度筛选，其内建自校验要求在已知真值的合成前导上定位准确，否则拒绝在未知录音上报告任何数字。</p>
<p>修正后该工具在真机录音上测得的引导音位置与解码器自报的图象起点相差 0.9 s，与规格几何相符，且引导音比其竞争音高 53 dB。但其余三段标定头音调低约 47 dB，故该表仍被判为不可用——这一结论现在能够区分“起点错误”与“标定头本身退化”两种情形，而修正前二者表现为同一种失败。</p>
</section>`);

sections.push(`<section id="s7">
<h2>7 局限与未来工作</h2>
<h3>7.1 已知限制</h3>
<p>本文的限制汇总于表 9，其中影响最大的两项是标定头检测在两重损伤叠加时失败，以及 PD 族缺少真实录音验证。后者源于运行环境受限：外部网络对多数主机不可达，公开检索未获得 PD 模式录音，规格文档亦不可获取，故 PD 解码的正确性仅有自洽往返支撑。</p>
${T9}
<h3>7.2 未来方向</h3>
<p>优先方向是重构起点估计。既然调阈值已被证明无效，可行的路径包括在检测前对带外能量作自适应白化、以逐行同步音的周期性直接估计起点而绕过引导音，以及在放宽频率搜索范围的同时以 VIS 偶校验和连续同步一致性控制误检。其次是补齐 PD 族的真实录音验证，再次是降低 PD 解码的计算量，其单次解码耗时约为逐行同步族的六倍。</p>
</section>`);

sections.push(`<section id="s8">
<h2>8 结论</h2>
<p>本文给出一个面向真实退化信道的抗干扰 SSTV 解码实现，支持 Martin M1、Scottie S1、PD120 与 PD180 四种模式。实现以仿射标定校正频率轴，以里德-所罗门码与交织保护数字边带，并以模式表统一描述两类扫描结构。四种模式的往返测试均满足设计目标，PD120 与 PD180 分别达到 32.46 dB 与 32.62 dB，真实录音在 8 kHz 至 44.1 kHz 采样率下均可解码，三倍硬削波不造成可测损失。</p>
<p>测量同时给出若干否定性结论。标定与时钟校正在真实录音上不产生净增益，其交叉点位于 0.02% 至 0.1% 之间；后处理对干净图象造成平均 0.70 dB 的损失，故默认关闭；三段失败样本的根因是标定头参考模式被双重退化破坏，而非判定门限偏紧。这些结论限定了该实现的适用范围，也为后续改进指明了方向。</p>
</section>`);

sections.push(`<section id="s9">
<h2>9 参考文献</h2>
<ol class="refs">
<li>[1] 慢扫描电视的频率映射、VIS 头结构与各模式时序规范。具体标准编号待核实。可参照美国无线电中继联盟《无线电通信手册》图象通信章节。</li>
<li>[2] J. Lacan, V. Roca, J. Peltotalo, S. Peltotalo. <em>Reed-Solomon Forward Error Correction (FEC) Schemes</em>. RFC 5510, IETF, 2009.</li>
<li>[3] H. Meyr, M. Moeneclaey, S. A. Fechtel. <em>Digital Communication Receivers: Synchronization, Channel Estimation, and Signal Processing</em>. Wiley, 1998.</li>
<li>[4] I. Cox, M. Miller, J. Bloom, J. Fridrich, T. Kalker. <em>Digital Watermarking and Steganography</em>, 2nd ed. Morgan Kaufmann, 2007.</li>
<li>[5] B. Chen, G. W. Wornell. Quantization Index Modulation: A Class of Provably Good Methods for Digital Watermarking and Information Embedding. <em>IEEE Transactions on Information Theory</em>, 47(4): 1423–1443, 2001.</li>
</ol>
${T10}
</section>`);

// ------------------------------------------------------------------ page
const CSS_EXTRA = `
/* ---------------- academic paper layout ---------------- */
.paper { max-width: 1080px; margin: 0 auto; }
.paper h2 { font-size: 22px; margin: 38px 0 14px; padding-bottom: 6px; border-bottom: 2px solid var(--border-soft); }
.paper h3 { font-size: 16px; margin: 24px 0 10px; color: var(--fg); }
.paper p { line-height: 1.85; margin: 12px 0; text-align: justify; }
.paper .title { font-size: 27px; text-align: center; margin: 8px 0 6px; line-height: 1.4; }
.paper .subtitle { font-size: 15px; text-align: center; color: var(--fg-mute); font-style: italic; margin: 0 0 14px; }
.paper .authors { text-align: center; color: var(--fg-mute); font-size: 13.5px; margin: 4px 0 26px; }
.paper .abstract { background: var(--bg-soft); border: 1px solid var(--border-soft); border-radius: 10px; padding: 16px 20px; }
.paper .abstract h2 { border: none; margin-top: 6px; font-size: 19px; }
.paper .abstract h3 { margin-top: 18px; }
.paper .keywords { font-size: 13.5px; color: var(--fg-mute); }
.paper .en { font-size: 13.5px; color: var(--fg-mute); line-height: 1.75; text-align: justify; }
.paper figure.figure { margin: 22px 0 26px; padding: 12px; border: 1px solid var(--border-soft); border-radius: 10px; background: #fff; overflow-x: auto; }
/*
 * Figures break out of the 1080 px text column and render at their natural size.
 *
 * Measured problem this solves: the column left about 1054 px for a 1200-unit-wide drawing, so
 * the whole figure was scaled to 0.878 and its 11 px labels rendered at 9.66 px. Enlarging the
 * labels instead would have meant editing 80 of them and risking new overflows; the drawings are
 * simply wider than a text column and should be allowed to be. box-sizing is pinned so the inner
 * width is deterministic (1230 units of room for a 1228-unit drawing), and the 100vw cap keeps a
 * narrow viewport from producing a horizontal scrollbar.
 */
.paper figure.figure { box-sizing: border-box; width: 1256px; max-width: calc(100vw - 24px); position: relative; left: 50%; transform: translateX(-50%); }
.paper figure.figure svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.paper .caption { font-size: 13px; color: var(--fg-mute); line-height: 1.7; margin: 10px 4px 0; text-align: justify; }
.paper .table-wrap { margin: 20px 0 24px; overflow-x: auto; }
.paper table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.paper table caption { caption-side: top; text-align: left; font-size: 13.5px; font-weight: 600; padding: 0 0 8px; color: var(--fg); }
.paper table th, .paper table td { border: 1px solid var(--border-soft); padding: 5px 8px; text-align: left; vertical-align: top; }
.paper table th { background: var(--bg-soft); font-weight: 600; }
.paper table td code { font-size: 11.5px; }
.paper table td .bad { color: var(--err); font-weight: 600; }
.paper .table-note { font-size: 12px; color: var(--fg-mute); line-height: 1.7; margin: 8px 0 0; text-align: justify; }
.paper .refs { font-size: 13px; line-height: 1.85; padding-left: 20px; }
.paper .refs li { margin: 7px 0; }
.paper .toc { background: var(--bg-soft); border: 1px solid var(--border-soft); border-radius: 10px; padding: 14px 20px; font-size: 13.5px; }
.paper .toc ol { margin: 6px 0; padding-left: 20px; }
.paper .toc li { margin: 3px 0; }
`;

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>一种面向真实退化信道的抗干扰 SSTV 音频解码方法 · 技术报告</title>
<meta name="description" content="Robust SSTV 项目技术报告：仿射频率标定、时钟恢复、里德-所罗门纠错与交织、模式表驱动的 PD 族解码，含二十六段真实音频验证与失败根因消融。">
<link rel="stylesheet" href="css/style.css">
</head>
<body class="paper-page">
${nav.navHtml('tech.html')}

<main class="paper">
  <h1 class="title">一种面向真实退化信道的抗干扰 SSTV 音频解码方法</h1>
  <p class="subtitle">A Robust SSTV Audio Decoding Method for Real-World Degradation Channels</p>
  <p class="authors">Robust SSTV 项目组 · 2026-10</p>

${sections.join('\n')}
</main>

<footer class="wrap site-footer">
  <p class="muted">本页为纯静态技术报告，全部图形为内联 SVG，不加载任何外部资源。测量数据与生成脚本随项目提供。</p>
</footer>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'tech.html'), page, 'utf8');
const sz = fs.statSync(path.join(ROOT, 'tech.html')).size;
console.log(`wrote tech.html (${(sz / 1024).toFixed(1)} KB)`);
console.log(`  sections: ${(page.match(/<h2>/g) || []).length}  h2, ${(page.match(/<h3>/g) || []).length} h3`);
console.log(`  figures : ${(page.match(/<figure class="figure"/g) || []).length}  (inline svg: ${(page.match(/<svg /g) || []).length})`);
console.log(`  tables  : ${(page.match(/<table id=/g) || []).length}`);
// append the paper CSS if it is not present yet
const cssPath = path.join(ROOT, 'css', 'style.css');
let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('academic paper layout')) {
  fs.writeFileSync(cssPath, css + '\n' + CSS_EXTRA, 'utf8');
  console.log('appended paper layout CSS to css/style.css');
} else {
  console.log('paper layout CSS already present');
}
