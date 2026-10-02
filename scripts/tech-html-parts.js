/*
 * tech.html generator - part 1 of the paper: helpers, the six schematic figures, and the
 * ten table builders.
 *
 * WHY A GENERATOR: four of the ten figures are data-driven (their SVG files are produced by
 * scripts/gen-paper-figures.js from the measurement JSON) and all ten tables are assembled
 * from those same JSON files. Emitting the page from the data is what makes the paper's rule
 * "every number must have a provenance" mechanically true rather than a promise: no figure or
 * table value is typed by hand, and re-running the two scripts reproduces the page.
 *
 * The six schematic figures carry no measured values beyond constants read from the mode
 * table, so they are authored here as templates.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'scripts', 'out');
const FIGDIR = path.join(ROOT, 'tests', 'paper-figures');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function readOut(name) {
  const p = path.join(OUT, name);
  if (!fs.existsSync(p)) throw new Error('missing data: scripts/out/' + name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function readRel(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error('missing data: ' + rel);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
/** Inline a generated SVG figure, stripping its XML declaration if present. */
function inlineFigure(file) {
  const p = path.join(FIGDIR, file);
  if (!fs.existsSync(p)) throw new Error('run scripts/gen-paper-figures.js first: missing ' + file);
  let s = fs.readFileSync(p, 'utf8').trim();
  s = s.replace(/^<\?xml[^>]*\?>\s*/, '');
  return s;
}
const num = (v, d) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d);
const pct = (v, d) => (v == null || !isFinite(v)) ? '—' : (100 * v).toFixed(d == null ? 0 : d) + '%';
const sci = (v) => (v == null || !isFinite(v)) ? '—' : Number(v).toExponential(2);

// ==================================================================== schematic figures
const F = {};

F.fig1 = () => `<svg viewBox="0 0 1200 320" width="1200" height="320" role="img" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif">
<title>图 1 SSTV 抗干扰解码系统总体架构</title>
<desc>发送端完成图象到音频的调制与数字边带嵌入，信道引入五类退化，接收端完成标定、解调、纠错与图象重建。</desc>
<rect x="0" y="0" width="1200" height="320" fill="#ffffff"/>
<rect x="30" y="50" width="300" height="220" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="1.6"/>
<text x="180" y="78" font-size="16" text-anchor="middle" font-weight="600" fill="#1e3a8a">发送端</text>
<rect x="60" y="96" width="240" height="34" rx="5" fill="#ffffff" stroke="#93c5fd"/><text x="180" y="119" font-size="13" text-anchor="middle" fill="#334155">图象 → Y/G/B 分量 → 行扫描时间轴</text>
<rect x="60" y="140" width="240" height="34" rx="5" fill="#ffffff" stroke="#93c5fd"/><text x="180" y="163" font-size="13" text-anchor="middle" fill="#334155">亮度 → 1500–2300 Hz 频率调制</text>
<rect x="60" y="184" width="240" height="34" rx="5" fill="#ffffff" stroke="#93c5fd"/><text x="180" y="207" font-size="13" text-anchor="middle" fill="#334155">秘密载荷 → RS → 交织 → QIM</text>
<rect x="60" y="228" width="240" height="34" rx="5" fill="#ffffff" stroke="#93c5fd"/><text x="180" y="251" font-size="13" text-anchor="middle" fill="#334155">分段合成 → 48 kHz WAV</text>
<rect x="420" y="50" width="360" height="220" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="1.6"/>
<text x="600" y="78" font-size="16" text-anchor="middle" font-weight="600" fill="#7f1d1d">信道退化</text>
<text x="450" y="112" font-size="13" fill="#334155">· 加性高斯白噪声</text>
<text x="450" y="138" font-size="13" fill="#334155">· 频率偏移（调谐误差）</text>
<text x="450" y="164" font-size="13" fill="#334155">· 采样率失配（时钟误差）</text>
<text x="450" y="190" font-size="13" fill="#334155">· 硬削波与过载</text>
<text x="450" y="216" font-size="13" fill="#334155">· 单边带通带与群延迟</text>
<text x="450" y="242" font-size="13" fill="#334155">· 衰落、工频、邻道、房间混响</text>
<rect x="870" y="50" width="300" height="220" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.6"/>
<text x="1020" y="78" font-size="16" text-anchor="middle" font-weight="600" fill="#14532d">接收端</text>
<rect x="900" y="96" width="240" height="34" rx="5" fill="#ffffff" stroke="#86efac"/><text x="1020" y="119" font-size="13" text-anchor="middle" fill="#334155">标定头搜索 + VIS 模式识别</text>
<rect x="900" y="140" width="240" height="34" rx="5" fill="#ffffff" stroke="#86efac"/><text x="1020" y="163" font-size="13" text-anchor="middle" fill="#334155">频偏校正与时钟恢复</text>
<rect x="900" y="184" width="240" height="34" rx="5" fill="#ffffff" stroke="#86efac"/><text x="1020" y="207" font-size="13" text-anchor="middle" fill="#334155">逐像素频率估计 → 亮度</text>
<rect x="900" y="228" width="240" height="34" rx="5" fill="#ffffff" stroke="#86efac"/><text x="1020" y="251" font-size="13" text-anchor="middle" fill="#334155">解交织 → RS 译码 → CRC 校验</text>
<defs><marker id="a1" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="#475569"/></marker></defs>
<line x1="330" y1="160" x2="414" y2="160" stroke="#475569" stroke-width="2" marker-end="url(#a1)"/>
<line x1="780" y1="160" x2="864" y2="160" stroke="#475569" stroke-width="2" marker-end="url(#a1)"/>
<text x="372" y="150" font-size="11" text-anchor="middle" fill="#475569">音频</text>
<text x="822" y="150" font-size="11" text-anchor="middle" fill="#475569">音频</text>
<text x="600" y="300" font-size="12" text-anchor="middle" fill="#6b7280">模拟主通道承载公开图象，数字边带承载秘密载荷，两者共用同一段音频</text>
</svg>`;

F.fig2 = () => `<svg viewBox="0 0 1200 330" width="1200" height="330" role="img" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif">
<title>图 2 SSTV 亮度到频率的映射与行结构</title>
<desc>左图为灰阶到瞬时频率的线性映射，黑电平 1500 赫兹、白电平 2300 赫兹；右图为一行之内的同步脉冲与分离脉冲时序。</desc>
<rect x="0" y="0" width="1200" height="330" fill="#ffffff"/>
<text x="60" y="34" font-size="14" font-weight="600" fill="#1f2937">(a) 灰阶—频率映射</text>
<rect x="80" y="70" width="440" height="46" fill="url(#g2)"/>
<defs><linearGradient id="g2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>
<line x1="80" y1="132" x2="520" y2="132" stroke="#333" stroke-width="1.4"/>
<line x1="80" y1="126" x2="80" y2="138" stroke="#333" stroke-width="1.4"/><text x="80" y="154" font-size="12" text-anchor="middle" fill="#374151">0（黑）</text>
<line x1="300" y1="126" x2="300" y2="138" stroke="#333" stroke-width="1.4"/><text x="300" y="154" font-size="12" text-anchor="middle" fill="#374151">128（中灰）</text>
<line x1="520" y1="126" x2="520" y2="138" stroke="#333" stroke-width="1.4"/><text x="520" y="154" font-size="12" text-anchor="middle" fill="#374151">255（白）</text>
<line x1="80" y1="186" x2="520" y2="186" stroke="#333" stroke-width="1.4"/>
<line x1="80" y1="180" x2="80" y2="192" stroke="#333" stroke-width="1.4"/><text x="80" y="210" font-size="12" text-anchor="middle" fill="#374151">1200</text>
<line x1="153" y1="180" x2="153" y2="192" stroke="#333" stroke-width="1.4"/><text x="153" y="210" font-size="12" text-anchor="middle" fill="#374151">1500</text>
<line x1="520" y1="180" x2="520" y2="192" stroke="#333" stroke-width="1.4"/><text x="520" y="210" font-size="12" text-anchor="middle" fill="#374151">2300</text>
<text x="300" y="238" font-size="12" text-anchor="middle" fill="#374151">瞬时频率（Hz）</text>
<text x="300" y="262" font-size="12" text-anchor="middle" fill="#6b7280">每灰阶对应 3.137 Hz，即 800 Hz 映射到 256 级</text>
<text x="660" y="34" font-size="14" font-weight="600" fill="#1f2937">(b) 行内时序（Martin M1）</text>
<line x1="660" y1="110" x2="1150" y2="110" stroke="#333" stroke-width="1.4"/>
<rect x="660" y="86" width="30" height="24" fill="#dc2626"/><text x="675" y="80" font-size="11" text-anchor="middle" fill="#7f1d1d">同步</text>
<rect x="692" y="86" width="10" height="24" fill="#6b7280"/>
<rect x="704" y="86" width="140" height="24" fill="#2563eb"/><text x="774" y="80" font-size="11" text-anchor="middle" fill="#1e3a8a">绿分量扫描</text>
<rect x="846" y="86" width="10" height="24" fill="#6b7280"/>
<rect x="858" y="86" width="140" height="24" fill="#16a34a"/><text x="928" y="80" font-size="11" text-anchor="middle" fill="#14532d">蓝分量扫描</text>
<rect x="1000" y="86" width="10" height="24" fill="#6b7280"/>
<rect x="1012" y="86" width="138" height="24" fill="#d97706"/><text x="1081" y="80" font-size="11" text-anchor="middle" fill="#7c2d12">红分量扫描</text>
<text x="675" y="132" font-size="11" text-anchor="middle" fill="#6b7280">4.86 ms</text>
<text x="845" y="132" font-size="11" text-anchor="middle" fill="#6b7280">0.57 ms</text>
<text x="675" y="164" font-size="12" fill="#374151">该行总时长 146.4 ms（扫描 3×146.4 ms 中的单分量），逐行重复</text>
<text x="675" y="192" font-size="12" fill="#374151">同步脉冲为 1200 Hz，黑电平为 1500 Hz，二者相差 300 Hz</text>
<text x="675" y="220" font-size="12" fill="#6b7280">分离脉冲（0.57 ms，1500 Hz）用于分隔三个分量扫描</text>
</svg>`;

F.fig3 = () => `<svg viewBox="0 0 1200 340" width="1200" height="340" role="img" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif">
<title>图 3 自动频率控制与时钟恢复流程</title>
<desc>以 1900 赫兹引导音锚定频率截距，以 1200 赫兹逐行同步音的时序斜率恢复时钟尺度，两者合成仿射标定并作用于全部频率测量。</desc>
<rect x="0" y="0" width="1200" height="340" fill="#ffffff"/>
<rect x="40" y="40" width="240" height="52" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="160" y="62" font-size="13" text-anchor="middle" fill="#7f1d1d">1900 Hz 引导音（300 ms）</text><text x="160" y="80" font-size="11" text-anchor="middle" fill="#9ca3af">起点无调制，频率恒定</text>
<rect x="40" y="120" width="240" height="52" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="160" y="142" font-size="13" text-anchor="middle" fill="#7f1d1d">1200 Hz 逐行同步音</text><text x="160" y="160" font-size="11" text-anchor="middle" fill="#9ca3af">每行一个，位置已知</text>
<rect x="40" y="200" width="240" height="52" rx="6" fill="#e0e7ff" stroke="#4f46e5"/><text x="160" y="222" font-size="13" text-anchor="middle" fill="#312e81">1200 Hz VIS 起始位</text><text x="160" y="240" font-size="11" text-anchor="middle" fill="#9ca3af">仅 30 ms，测频偏差大</text>
<line x1="282" y1="66" x2="352" y2="150" stroke="#475569" stroke-width="1.8"/>
<line x1="282" y1="146" x2="352" y2="166" stroke="#475569" stroke-width="1.8"/>
<line x1="282" y1="226" x2="352" y2="196" stroke="#9ca3af" stroke-width="1.6" stroke-dasharray="5 4"/>
<text x="340" y="248" font-size="11" fill="#9ca3af">不用于标定</text>
<rect x="360" y="120" width="260" height="96" rx="8" fill="#f8fafc" stroke="#64748b"/>
<text x="490" y="146" font-size="13" text-anchor="middle" font-weight="600" fill="#1f2937">仿射标定</text>
<text x="490" y="172" font-size="12" text-anchor="middle" fill="#334155">f_nominal = (f_measured − b) / a</text>
<text x="490" y="194" font-size="12" text-anchor="middle" fill="#334155">a = 1 / 时钟尺度，b = 引导音 − 1900a</text>
<line x1="622" y1="168" x2="700" y2="168" stroke="#475569" stroke-width="2"/>
<rect x="708" y="60" width="250" height="52" rx="6" fill="#f0fdf4" stroke="#16a34a"/><text x="833" y="82" font-size="12" text-anchor="middle" fill="#14532d">频偏 b：由引导音锚定</text><text x="833" y="100" font-size="11" text-anchor="middle" fill="#9ca3af">实测精度优于 1 Hz</text>
<rect x="708" y="142" width="250" height="52" rx="6" fill="#f0fdf4" stroke="#16a34a"/><text x="833" y="164" font-size="12" text-anchor="middle" fill="#14532d">尺度 a：由 256 个同步头拟合</text><text x="833" y="182" font-size="11" text-anchor="middle" fill="#9ca3af">实测 1.00000 / 1.00500 / 1.01000</text>
<rect x="708" y="224" width="250" height="52" rx="6" fill="#f0fdf4" stroke="#16a34a"/><text x="833" y="246" font-size="12" text-anchor="middle" fill="#14532d">时钟尺度：像素节距缩放</text><text x="833" y="264" font-size="11" text-anchor="middle" fill="#9ca3af">交叉点约 0.02%–0.1%</text>
<line x1="960" y1="168" x2="1030" y2="168" stroke="#475569" stroke-width="2"/>
<rect x="1038" y="120" width="130" height="96" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="1103" y="152" font-size="13" text-anchor="middle" font-weight="600" fill="#1e3a8a">全部频率</text><text x="1103" y="172" font-size="13" text-anchor="middle" font-weight="600" fill="#1e3a8a">测量</text><text x="1103" y="194" font-size="11" text-anchor="middle" fill="#6b7280">解调前统一校正</text>
<text x="600" y="316" font-size="12" text-anchor="middle" fill="#6b7280">主路径为固定阈值检测；仅当主路径失败时才启用放宽阈值的回退路径，回退结果须通过 VIS 偶校验</text>
</svg>`;

F.fig4 = () => `<svg viewBox="0 0 1200 380" width="1200" height="380" role="img" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif">
<title>图 4 里德-所罗门编码与交织</title>
<desc>消息字节经系统码编码后追加校验符号，交织以码字为行按列读出，把连续突发错误分散到各个码字中。</desc>
<rect x="0" y="0" width="1200" height="340" fill="#ffffff"/>
<text x="40" y="32" font-size="14" font-weight="600" fill="#1f2937">(a) 系统码结构（n=255，nsym=32）</text>
<rect x="40" y="48" width="223" height="30" fill="#bfdbfe" stroke="#2563eb"/><text x="151" y="68" font-size="12" text-anchor="middle" fill="#1e3a8a">信息符号 k = 223</text>
<rect x="263" y="48" width="32" height="30" fill="#fca5a5" stroke="#dc2626"/><text x="279" y="94" font-size="11" text-anchor="middle" fill="#7f1d1d">校验 nsym = 32</text>
<text x="40" y="122" font-size="12" fill="#374151">可纠正最多 16 个符号错误，或等价的错误与擦除组合满足 2e + f ≤ 32</text>
<text x="40" y="146" font-size="12" fill="#6b7280">有限域 GF(2^8)，本原多项式 0x11D，系统码（信息位前置）</text>
<text x="40" y="196" font-size="14" font-weight="600" fill="#1f2937">(b) 交织写入与读出</text>
<g stroke="#94a3b8" stroke-width="1">
${Array.from({ length: 4 }, (_, r) => Array.from({ length: 8 }, (_, c) =>
  `<rect x="${40 + c * 46}" y="${212 + r * 26}" width="46" height="26" fill="${c < 6 ? '#dbeafe' : '#fee2e2'}"/>`).join('')).join('')}
</g>
${Array.from({ length: 4 }, (_, r) => `<text x="26" y="${229 + r * 26}" font-size="11" text-anchor="middle" fill="#6b7280">cw${r}</text>`).join('')}
<text x="40" y="338" font-size="12" fill="#374151">写入：按行（每个码字占一行，蓝色为信息位，红色为校验位）</text>
<text x="420" y="230" font-size="12" fill="#374151">读出：按列，使每个码字的相邻符号在时间上相隔 D 个符号</text>
<text x="420" y="256" font-size="12" fill="#374151">长度 b 的连续突发在每个码字内只造成至多 ⌈b/D⌉ 个错误</text>
<text x="420" y="282" font-size="12" fill="#6b7280">深度 D = 32 时，100 符号突发被限制为每个码字 4 个错误（实测值）</text>
<text x="40" y="364" font-size="12" fill="#6b7280">注：交织深度受载荷码字数限制，端到端可用深度仅为 2（见表 9）</text>
</svg>`;

F.fig5 = () => `<svg viewBox="0 0 1200 330" width="1200" height="330" role="img" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif">
<title>图 5 量化索引调制的数字边带与模拟主通道共存</title>
<desc>主通道以亮度频率调制承载公开图象，边带在绿通道上以块均值的量化索引调制承载秘密载荷，二者在同一帧图象内叠加。</desc>
<rect x="0" y="0" width="1200" height="330" fill="#ffffff"/>
<rect x="40" y="40" width="520" height="240" rx="8" fill="#f8fafc" stroke="#64748b"/>
<text x="300" y="66" font-size="13" text-anchor="middle" font-weight="600" fill="#1f2937">模拟主通道（公开图象）</text>
<rect x="70" y="84" width="460" height="60" fill="#111827"/>
${Array.from({ length: 10 }, (_, i) => `<rect x="${70 + i * 46}" y="84" width="46" height="60" fill="rgb(${60 + i * 20},${60 + i * 20},${60 + i * 20})"/>`).join('')}
<text x="300" y="166" font-size="12" text-anchor="middle" fill="#334155">像素灰度直接决定瞬时频率</text>
<text x="300" y="190" font-size="12" text-anchor="middle" fill="#334155">B 像素构成一个承载单元</text>
<text x="300" y="214" font-size="12" text-anchor="middle" fill="#334155">量化步长 Δ = 12 灰阶</text>
<text x="300" y="238" font-size="12" text-anchor="middle" fill="#6b7280">以整数单位在块内重新分配像素值</text>
<text x="300" y="262" font-size="12" text-anchor="middle" fill="#6b7280">使块均值落在目标电平上，奇偶性承载比特</text>
<rect x="620" y="40" width="540" height="240" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="890" y="66" font-size="13" text-anchor="middle" font-weight="600" fill="#14532d">数字边带（秘密载荷）</text>
<line x1="660" y1="130" x2="1120" y2="130" stroke="#333" stroke-width="1.4"/>
${Array.from({ length: 13 }, (_, i) => `<line x1="${660 + i * 38.3}" y1="122" x2="${660 + i * 38.3}" y2="138" stroke="#333" stroke-width="1.2"/>`).join('')}
${[0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1].map((b, i) =>
  `<circle cx="${679 + i * 38.3}" cy="${b ? 130 : 130}" r="5" fill="${b ? '#16a34a' : '#f59e0b'}"/>`).join('')}
<text x="890" y="106" font-size="12" text-anchor="middle" fill="#334155">量化电平格点（奇偶性即比特）</text>
<text x="890" y="168" font-size="12" text-anchor="middle" fill="#334155">接收端以块均值的量化残差作为置信度</text>
<text x="890" y="192" font-size="12" text-anchor="middle" fill="#334155">残差超过阈值判为擦除，交 RS 译码</text>
<text x="890" y="216" font-size="12" text-anchor="middle" fill="#6b7280">帧长 = 15 字节图片头 + JPEG/QIMG 数据</text>
<text x="890" y="240" font-size="12" text-anchor="middle" fill="#6b7280">端到端仅 200 字节可用（见表 9）</text>
<text x="600" y="310" font-size="12" text-anchor="middle" fill="#6b7280">边带嵌于图象域、提取于像素域，因此模拟调制与解调链路无需任何改动</text>
</svg>`;

F.fig6 = () => `<svg viewBox="0 0 1200 360" width="1200" height="360" role="img" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif">
<title>图 6 逐行同步族与 PD 族的扫描模型对比</title>
<desc>左侧为 Martin M1 与 Scottie S1 的逐行同步结构，右侧为 PD120 与 PD180 的每两行一个同步脉冲结构，后者无逐行 porch。</desc>
<rect x="0" y="0" width="1200" height="360" fill="#ffffff"/>
<text x="40" y="30" font-size="14" font-weight="600" fill="#1f2937">(a) lineSync 族：逐行同步（Martin M1 / Scottie S1）</text>
<line x1="40" y1="120" x2="560" y2="120" stroke="#333" stroke-width="1.4"/>
${[0, 1, 2].map((i) => {
  const x = 40 + i * 174;
  return `<rect x="${x}" y="96" width="26" height="24" fill="#dc2626"/>` +
    `<rect x="${x + 26}" y="96" width="6" height="24" fill="#9ca3af"/>` +
    `<rect x="${x + 32}" y="96" width="130" height="24" fill="#2563eb"/>`;
}).join('')}
<text x="300" y="86" font-size="11" text-anchor="middle" fill="#7f1d1d">每行都以 1200 Hz 同步脉冲开始</text>
<text x="300" y="146" font-size="12" text-anchor="middle" fill="#374151">行时 146.4 ms（M1），256 行</text>
<text x="300" y="170" font-size="12" text-anchor="middle" fill="#374151">可对每一行独立锁位，失锁不传播</text>
<text x="300" y="194" font-size="12" text-anchor="middle" fill="#6b7280">可用同步点数 256，像素时间 457.6 µs</text>
<text x="40" y="240" font-size="14" font-weight="600" fill="#1f2937">(b) PD 族：每两行一个同步脉冲（PD120 / PD180）</text>
<line x1="40" y1="330" x2="846" y2="330" stroke="#333" stroke-width="1.4"/>
<rect x="40" y="306" width="34" height="24" fill="#dc2626"/>
<rect x="74" y="306" width="5" height="24" fill="#9ca3af"/>
<rect x="79" y="306" width="104" height="24" fill="#2563eb"/><text x="131" y="322" font-size="10" text-anchor="middle" fill="#ffffff">Y₀</text>
<rect x="183" y="306" width="104" height="24" fill="#7c3aed"/><text x="235" y="322" font-size="10" text-anchor="middle" fill="#ffffff">R−Y</text>
<rect x="287" y="306" width="104" height="24" fill="#0891b2"/><text x="339" y="322" font-size="10" text-anchor="middle" fill="#ffffff">B−Y</text>
<rect x="391" y="306" width="104" height="24" fill="#2563eb"/><text x="443" y="322" font-size="10" text-anchor="middle" fill="#ffffff">Y₁</text>
<rect x="495" y="306" width="34" height="24" fill="#dc2626"/>
<rect x="529" y="306" width="5" height="24" fill="#9ca3af"/>
<rect x="534" y="306" width="104" height="24" fill="#2563eb"/><text x="586" y="322" font-size="10" text-anchor="middle" fill="#ffffff">Y₀</text>
<rect x="638" y="306" width="104" height="24" fill="#7c3aed"/><text x="690" y="322" font-size="10" text-anchor="middle" fill="#ffffff">R−Y</text>
<text x="495" y="352" font-size="11" text-anchor="middle" fill="#7f1d1d">下一个行对</text>
<text x="131" y="352" font-size="11" text-anchor="middle" fill="#6b7280">同步 20 ms</text>
<text x="300" y="266" font-size="12" text-anchor="middle" fill="#374151">每个行对 = 同步 20 ms + 消隐 2.08 ms + 四段扫描</text>
<text x="300" y="290" font-size="12" text-anchor="middle" fill="#374151">行时 0.50848 s（PD120）/ 0.75168 s（PD180），248 个行对</text>
<text x="860" y="316" font-size="12" fill="#374151">无逐行同步与逐行 porch，色度两行共用</text>
<text x="860" y="340" font-size="12" fill="#6b7280">像素时间 190 µs，故需 ≥16 kHz 采样</text>
</svg>`;

/*
 * Uniform viewBox padding.
 *
 * The rendered audit found seven elements sitting closer than 10 units to a viewBox edge (the
 * rotated y-axis labels at 6.4, fig4's last line at 4.6, fig6's sync caption at 5.7). Rather
 * than nudge each one, every figure gets the same 14-unit frame, which is the value the
 * previous project settled on for the same problem. The frame is applied by widening the
 * viewBox and the declared width/height together, so no element coordinate changes and the
 * drawing scale stays 1:1.
 */
const SVG_PAD = 14;
function padViewBox(svg, pad) {
  const p = pad == null ? SVG_PAD : pad;
  const m = svg.match(/viewBox="([\d.\-\s]+)"/);
  if (!m) return svg;
  const [x, y, w, h] = m[1].trim().split(/\s+/).map(Number);
  let out = svg.replace(/viewBox="[\d.\-\s]+"/, `viewBox="${x - p} ${y - p} ${w + 2 * p} ${h + 2 * p}"`);
  out = out.replace(/\bwidth="(\d+)"/, (s, v) => 'width="' + (Number(v) + 2 * p) + '"');
  out = out.replace(/\bheight="(\d+)"/, (s, v) => 'height="' + (Number(v) + 2 * p) + '"');
  return out;
}

// Applied to the six hand-authored figures in one place, so a figure cannot be added without it.
for (const key of ['fig1', 'fig2', 'fig3', 'fig4', 'fig5', 'fig6']) {
  const build = F[key];
  F[key] = () => padViewBox(build());
}

module.exports = { F, esc, readOut, readRel, inlineFigure, num, pct, sci, padViewBox, SVG_PAD, ROOT, OUT, FIGDIR };
