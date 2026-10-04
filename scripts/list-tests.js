/*
 * Test manifest generator.
 *
 * Runs every suite in tests/ and records, for each one, the exit code, the verdict line and
 * the wall-clock duration, then writes tests/test-manifest.json. The exit code is treated as
 * the primary verdict because every verdict suite in this project sets process.exitCode
 * explicitly; the printed line is captured only so the manifest is readable.
 *
 * Usage:
 *   node scripts/list-tests.js            run everything and write the manifest
 *   node scripts/list-tests.js --no-run   enumerate only (fast; no results recorded)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const SELF = path.basename(__filename);
const RUN = !process.argv.includes('--no-run');

/*
 * kind: 'verdict' suites gate the project; 'diagnostic' and 'benchmark' scripts print numbers
 * and have no pass/fail semantics, so their exit code is recorded but not treated as a gate.
 */
const SUITES = [
  { file: 'verify-signal.js', kind: 'verdict', covers: '编码器逐样本频率与行结构' },
  { file: 'roundtrip.js', kind: 'verdict', covers: '四模式编码往返与图象保真度' },
  { file: 'channel-sim.test.js', kind: 'verdict', covers: '信道模拟器五类退化' },
  { file: 'fec-rs.test.js', kind: 'verdict', covers: '里德-所罗门编解码与三重验证' },
  { file: 'interleaver.test.js', kind: 'verdict', covers: '交织往返与突发分散' },
  { file: 'image-codec.test.js', kind: 'verdict', covers: '秘密图编解码与图片帧' },
  { file: 'pd-modes.test.js', kind: 'verdict', covers: 'PD120 与 PD180 往返' },
  { file: 'tech-html.test.js', kind: 'verdict', covers: '技术报告结构、几何与文风' },
  { file: 'e2e-full.js', kind: 'verdict', covers: '四模式完整链路（图→音频→信道→图）' },
  { file: 'browser-e2e.js', kind: 'verdict', covers: '浏览器端到端流程' },
  { file: 'image-pages-e2e.js', kind: 'verdict', covers: '图片隐藏两个页面端到端' },
  { file: 'diagnose-align.js', kind: 'diagnostic', covers: '同步对齐诊断' },
  /*
   * Phase-49 additions.
   *
   * model-selftest and frequency-axis are VERDICT suites: they gate the correctness of the impairment
   * models and of the frequency-axis constants, and a failure there invalidates any measurement built on
   * them, so they must be able to fail the gate rather than merely print numbers.
   */
  { file: 'model-selftest.js', kind: 'verdict', covers: '退化模型自检（频移/混响/削波）' },
  { file: 'frequency-axis.test.js', kind: 'verdict', covers: '频率轴常量的量纲一致性' },
  { file: 'nav-check.js', kind: 'verdict', covers: '导航一致性 + 图片隐藏冻结（入口移除、代码保留）' },
  { file: 'real-s1.test.js', kind: 'verdict', covers: '真实 Scottie S1 录音（phigros）' },
  { file: 'channel-alignment.test.js', kind: 'verdict', covers: '三通道分离度与对齐' },
  { file: 'degradation-matrix.js', kind: 'diagnostic', covers: '抗干扰退化矩阵（6 维度 · 39 单元）' },
  { file: 'gen-baseline-report.js', kind: 'diagnostic', covers: '由矩阵生成基线表' },
  { file: 'diagnose-measurement-validation.js', kind: 'diagnostic', covers: '测量方法已知真值校验（含邻音污染层）' },
  { file: 'diagnose-channel-estimation.js', kind: 'diagnostic', covers: '混响信道可估性（结论：反卷积上界 +0.08 dB）' },
  { file: 'diagnose-pixel-estimator.js', kind: 'diagnostic', covers: '平坦图测像素估计器误差（结论：方差几乎不变，损失在离群值）' },
  { file: 'diagnose-freq-offset-channel.js', kind: 'diagnostic', covers: '频偏失分在通道还是扫描段（结论：都不是）' },
  /*
   * Phase 51: localising the frequency-offset asymmetry. The chain is deliberate and each step corrected
   * the previous one's conclusion, so they are kept together:
   *   pixel-audit    -> the per-pixel raw/calibrated frequency audit that was missing; the defect shows in
   *                     the raw readings, and it depends on the BAND EDGE, not the sign of the offset
   *   sweep-margin   -> refuted the "1200 Hz sync leaking in" theory (shrinking the margin made it worse)
   *   sweep-guard    -> confirmed the cause is the 1500 Hz porch tone and measured the cost of fixing it
   *   leader-lag     -> explains the analyser probe's position bias (window centre vs window start)
   *   real-levels    -> level structure of the real recording; shows its header is at t~106 s, not t~0
   *   header-anchor  -> where the decoder itself locks the header, used to check the locator
   */
  { file: 'diagnose-pixel-audit.js', kind: 'diagnostic', covers: '逐像素频率审计：定位频偏不对称根因' },
  { file: 'sweep-band-margin.js', kind: 'diagnostic', covers: '图像带余量扫描（否决了同步音泄漏假说）' },
  { file: 'sweep-band-guard.js', kind: 'diagnostic', covers: '图像带下界护栏扫描（根因确认 + 代价实测）' },
  { file: 'diagnose-leader-lag.js', kind: 'diagnostic', covers: '引导音定位的窗心 vs 窗首偏置来源' },
  { file: 'diagnose-real-levels.js', kind: 'diagnostic', covers: '真机录音电平结构（标定头在 t≈106 s）' },
  { file: 'diagnose-header-anchor.js', kind: 'diagnostic', covers: '解码器自报的标定头锁定位置' },
  /*
   * Phase 52: the anti-interference matrix, its chart, and the interactive demo page.
   * `verdict` entries here are the ones that can FAIL a build; the diagnose-* ones answer questions.
   */
  { file: 'measure-demo-base.js', kind: 'diagnostic', covers: '选定演示页基础音频（模式/采样率/时长）' },
  { file: 'rebuild-derived-audio.js', kind: 'diagnostic', covers: '重建被 gitignore 的 48k 派生音频（ffmpeg）' },
  { file: 'measure-demo-timing.js', kind: 'diagnostic', covers: '演示页解码耗时预算测量' },
  { file: 'bake-demo-ir.js', kind: 'diagnostic', covers: '烘焙演示页房间冲激响应' },
  { file: 'verify-demo-ladder.js', kind: 'verdict', covers: '演示页退化阶梯逐步验证（无空操作/无抛错）' },
  { file: 'check-curve-svg.js', kind: 'verdict', covers: '退化曲线 SVG 结构与结论一致性' },
  { file: 'check-tech-section59.js', kind: 'verdict', covers: 'tech.html §5.9 图表与数值可追溯性' },
  { file: 'demo-page-cdp.js', kind: 'verdict', covers: '演示页真机浏览器（file://）交互与截图' },
  { file: 'check-report-numbering.js', kind: 'verdict', covers: 'tech.html 图表编号唯一连续且引用不悬空' },
  { file: 'tech-section-cdp.js', kind: 'verdict', covers: 'tech.html §5.9 浏览器渲染与截图' },
  { file: 'demo-mobile-cdp.js', kind: 'verdict', covers: '演示页窄视口（390px）布局与运行' },
  { file: 'check-readme-tolerance.js', kind: 'verdict', covers: 'README 抗干扰表逐项对照退化矩阵' },
  { file: 'gen-degradation-figure.js', kind: 'diagnostic', covers: '生成六维退化并排对比图' },
  { file: 'diagnose-demo-convolve.js', kind: 'diagnostic', covers: '演示页卷积正确性（delta 响应对照 IR）' },
  { file: 'diagnose-convolve-fft.js', kind: 'diagnostic', covers: '复数 FFT 往返与逐抽头误差' },
  { file: 'diagnose-demo-decoder.js', kind: 'diagnostic', covers: '演示页内省（decode 是否 async 等）' },
  /*
   * Phase 50. NOTE on provenance, recorded because it was wrong for several rounds: the "real recording"
   * this project has been measuring is tests/fixtures/phigros.wav, which is an MP3 despite the extension
   * and IS a phone recording of speaker playback - real acoustic data. It was previously described as an
   * off-air/electrical capture, which made the acoustic work look unstarted when it was not.
   */
  { file: 'recover-outliers.js', kind: 'diagnostic', covers: '离群像素恢复阈值扫描（決定 k 与第二道门）' },
  { file: 'recover-routing.js', kind: 'diagnostic', covers: '离群恢复与温和降噪的组合顺序' },
  { file: 'diagnose-is-acoustic.js', kind: 'diagnostic', covers: '声学指纹检测（区分真机录音与数字副本）' },
  /*
   * Phase-50 acoustic work. analyze-recording.js carries its own probe self-test and REFUSES to report on
   * an unknown file if that self-test fails - it is listed as a verdict suite because that refusal is a
   * pass/fail property worth gating, not a diagnostic nicety.
   */
  { file: 'analyze-recording.js', kind: 'verdict', covers: '录音分析（步骤 0 探针自校验，失败即拒绝报告）' },
  { file: 'diagnose-acoustic.js', kind: 'diagnostic', covers: '声学组合诊断（真机 vs 合成，kind 严格区分）' },
  { file: 'diagnose-acoustic-ablation.js', kind: 'diagnostic', covers: 'acoustic-band 单因素消融' },
  { file: 'diagnose-acoustic-band-fixture.js', kind: 'diagnostic', covers: '[工具不可用] acoustic-band 夹具探针' },
  { file: 'diagnose-header-map.js', kind: 'diagnostic', covers: '[工具不可用] 标定头区域轨迹（起始定位错误）' },
  { file: 'diagnose-header-locate.js', kind: 'diagnostic', covers: '[工具不可用] 标定头定位（起始定位错误）' },
  { file: 'diagnose-header-position.js', kind: 'diagnostic', covers: '[工具不可用] 标定头位置与 SNR（起始定位错误）' },
  { file: 'diagnose-sync-threshold.js', kind: 'diagnostic', covers: '同步检测门限的原始频率读数' },
  { file: 'diagnose-asymmetry-branches.js', kind: 'diagnostic', covers: '频偏不对称：alignSync 分支计数' },
  { file: 'diagnose-header-slope-bias.js', kind: 'diagnostic', covers: '标定斜率 a 的短窗偏置' },
  { file: 'diagnose-reverb.js', kind: 'diagnostic', covers: '混响破坏的是哪一级' },
  { file: 'diagnose-phase49.js', kind: 'diagnostic', covers: '阶段四十九分项诊断' },
  { file: 'denoise-calibrate.js', kind: 'diagnostic', covers: '自适应降噪门控与强度标定' },
  { file: 'denoise-sweep.js', kind: 'diagnostic', covers: '降噪强度扫描与 Robot36 参照对比' },
  { file: 'render-phigros.js', kind: 'diagnostic', covers: '以生产路径渲染 phigros 为 PNG' },
  { file: 'browser-visual.js', kind: 'diagnostic', covers: '浏览器解码 phigros 并截图' },
  { file: 'diff-rasters.js', kind: 'diagnostic', covers: '两份栅格逐像素对比' },
  { file: 'locate-robot36-raster.js', kind: 'diagnostic', covers: '定位 Robot36 截图的栅格区域' },
  { file: 'verify-freqshift.js', kind: 'diagnostic', covers: '频移实现与 FFT 参考对拍（含参考自校验）' },
  /*
   * RESULT INVALIDATED (phase 49). These three produced the contradictory per-segment frequency-offset
   * numbers, and tests/diagnose-measurement-validation.js now measures why: all three are pulled by a
   * strong neighbour 150 Hz away by an amount comparable to the effect they claimed. They are listed as
   * diagnostics only so their existence is visible; their findings must not be cited. The headers of the
   * files say so too.
   */
  { file: 'diagnose-real-drift.js', kind: 'diagnostic', covers: '[结论作废] 分段频偏（邻音污染 bias -51.5 Hz）' },
  { file: 'diagnose-real-drift-confirm.js', kind: 'diagnostic', covers: '[结论作废] 分段频偏确认（自身对照偏 22.5 Hz）' },
  { file: 'diagnose-real-drift-final.js', kind: 'diagnostic', covers: '[结论作废] 以锁定位置测频（自身对照偏 94 Hz）' },
  { file: 'diagnose-calibration-consistency.js', kind: 'diagnostic', covers: '[结论作废] 标定内部一致性（头部探针偏 37 Hz）' },
  { file: 'perf.js', kind: 'benchmark', covers: '性能基准' }
];

const VERDICT_RE = /(VERIFIED|ALL CHECKS PASSED|PASSED|FAILED|\d+ passed, \d+ failed)/;
const results = [];
let gateFail = 0;

console.log(`test manifest: ${SUITES.length} entries, run=${RUN}\n`);
for (const s of SUITES) {
  const full = path.join(TESTS, s.file);
  const entry = { file: 'tests/' + s.file, kind: s.kind, covers: s.covers, exists: fs.existsSync(full) };
  if (!entry.exists) {
    entry.status = 'missing';
    entry.exitCode = null;
    if (s.kind === 'verdict') gateFail++;
    console.log(`  MISSING  ${s.file}`);
    results.push(entry);
    continue;
  }
  if (!RUN) {
    entry.status = 'not-run';
    results.push(entry);
    console.log(`  listed   ${s.file.padEnd(26)} ${s.kind.padEnd(10)} ${s.covers}`);
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [full], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  entry.ms = Date.now() - t0;
  entry.exitCode = r.status;
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split(/\r?\n/).filter((l) => VERDICT_RE.test(l));
  entry.verdict = lines.length ? lines[lines.length - 1].trim() : null;
  /*
   * Store the individual failing checks, not just the summary line. Without this a failure is
   * undiagnosable from the manifest alone, which matters because one suite (browser-e2e.js) is
   * load-sensitive and has been observed to fail inside a long sequential run while passing
   * standalone.
   */
  entry.failures = out.split(/\r?\n/).filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim()).slice(0, 20);
  if (!entry.failures.length) delete entry.failures;
  entry.status = r.status === 0 ? 'pass' : 'fail';
  if (r.error) { entry.status = 'error'; entry.error = String(r.error.message || r.error); }
  if (entry.status !== 'pass' && s.kind === 'verdict') gateFail++;
  const mark = entry.status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`  ${mark.padEnd(5)} ${s.file.padEnd(26)} ${String(entry.ms).padStart(6)} ms  ${entry.verdict || ''}`);
  results.push(entry);
}

const verdicts = results.filter((r) => r.kind === 'verdict');
const manifest = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  ran: RUN,
  totals: {
    entries: results.length,
    verdictSuites: verdicts.length,
    verdictPass: verdicts.filter((r) => r.status === 'pass').length,
    verdictFail: verdicts.filter((r) => r.status === 'fail' || r.status === 'missing' || r.status === 'error').length,
    diagnostic: results.filter((r) => r.kind !== 'verdict').length
  },
  results
};
fs.writeFileSync(path.join(TESTS, 'test-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.totals.verdictPass}/${manifest.totals.verdictSuites} verdict suites pass`);
console.log('-> tests/test-manifest.json');
process.exitCode = gateFail === 0 ? 0 : 1;
