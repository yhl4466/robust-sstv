# 抗干扰 SSTV 解码平台

把一张图变成一段声音，通过微信、邮件、或任何能传声音的渠道发送；对方用同一个网页就能还原。
纯前端、零依赖，双击 `index.html` 即可离线运行。

## 它能做什么

- **四种模式编解码**：Martin M1 / Scottie S1 / PD120 / PD180，编码和解码都支持
- **抗干扰解码**：抗频率偏移、抗采样率失配、抗硬削波（3 倍削波完全无损）
- **图片隐藏**：一张公开图 + 一张秘密图共存于同一段音频，对方上传音频即可同时拿回两者
- **纯前端、零依赖**：不用构建、不用服务器、不联网也能用

### 支持的模式

| 模式 | VIS | 分辨率 | 色彩空间 | 总时长 |
|---|---|---|---|---|
| Martin M1 | 44 | 320×256 | GBR | 115.30 s |
| Scottie S1 | 60 | 320×256 | GBR | 110.64 s |
| PD120 | 95 | 640×496 | YUV | 127.11 s |
| PD180 | 96 | 640×496 | YUV | 187.43 s |

> PD 两种模式的像素更小，音频需要 **16 kHz 以上**采样率；8 kHz 录音解不了它们。

## 快速开始

### 本地运行

**直接双击 [`index.html`](index.html)** 即可（`file://` 协议），不需要构建、服务器或后端。

### 页面一览

四个页面共用同一导航栏，互相都能到达：

| 页面 | 用途 |
|---|---|
| [`index.html`](index.html) | 首页：介绍、三步说明、常见问题；完整工具在「高级设置」面板里 |
| [`embed-image.html`](embed-image.html) | 图片隐藏 · 把秘密图藏进去 |
| [`extract-image.html`](extract-image.html) | 图片隐藏 · 把秘密图取出来 |
| [`tech.html`](tech.html) | 技术报告（学术论文体，13 图 10 表） |

### 在线部署

本项目是纯静态页面，**没有构建步骤**：把仓库目录交给任意静态托管（GitHub Pages / Netlify /
自己的服务器）就能发布。

在线访问：https://yhl4466.github.io/robust-sstv/

## 使用方法

### 生成音频

1. 打开 `index.html`，展开下方的「高级设置」面板
2. 选一张图片（PNG / JPG）
3. 点「生成音频」，试听后点「下载 WAV」

### 解码音频

1. 在「解码音频」里选一个 WAV 文件
2. 选解码精度（快速 / 标准 / 精细）
3. 点「解码音频」，完成后保存 PNG

解不出来时给的是人话提示，而不是内部错误码，例如「没检测到信号。请确认上传的是声音传图的音频，
或让对方重新发送。」

### 图片隐藏

1. 在 `embed-image.html` 里先后选**公开图**和**秘密图**
2. 生成音频并发送
3. 对方在 `extract-image.html` 上传这段音频，会**同时**拿回公开图和秘密图

> 秘密图受容量限制只能是缩略图，原因见下面的 L3。

## 已知限制

编号与 [`tech.html`](tech.html) 的表 9 一一对应。这些都是实测确认的，不是猜测。

| 编号 | 限制 |
|---|---|
| **L1** | 标定头检测在两重损伤叠加时失败——这三类音频完全无法解码 |
| **L2** | PD 族缺少真实录音验证，正确性目前只有自洽往返支撑 |
| **L3** | 边带载荷容量仅数百字节，秘密图只能是缩略图 |
| **L4** | 交织深度受码字数限制，端到端实际只能到 1–2 |
| **L5** | 严重档超出适用范围，不作为可用工作点 |
| **L6** | 频偏与时钟校正在真实录音上没有净收益 |
| **L7** | σ_HF 可被模糊压低，不能单独当作质量判据 |
| **L8** | PD 解码耗时较高（PD120 约 46 秒，Martin M1 约 7 秒） |

## 实测结果

| 指标 | 值 | 来源 |
|---|---|---|
| Martin M1 往返 PSNR（真实照片） | 31.23 dB | [`tests/roundtrip.js`](tests/roundtrip.js) |
| Scottie S1 往返 PSNR（真实照片） | 30.50 dB | [`tests/roundtrip.js`](tests/roundtrip.js) |
| PD120 往返 PSNR（合成细节图） | 32.46 dB | [`tech.html`](tech.html) 表 8 |
| PD180 往返 PSNR（合成细节图） | 32.62 dB | [`tech.html`](tech.html) 表 8 |
| 支持采样率 | 8 kHz – 44.1 kHz | [`tech.html`](tech.html) 摘要 |
| 硬削波容忍 | 3 倍无损（8 倍起劣化） | [`tech.html`](tech.html) 摘要 |

> Martin M1 在技术报告表 8 里还有一个 **31.95 dB**，那是**合成细节图**的对照行；
> 上表的 31.23 dB 是回归测试用的**真实照片**。两者不是同一张图，都正确。

## 更多信息

### 技术报告

[`tech.html`](tech.html) 是完整的学术论文体报告：方法、实验设置、全部图表（13 图 10 表），
以及每个数字的生成脚本。上面的已知限制、实测结果与模式表都以它为准。

### 开发记录

每个阶段的过程记录归档在 [`docs/reports/`](docs/reports/)，包含**未达标项及其根因**，
也保留了被推翻的假设（例如阈值放宽被证伪的消融实验）。

| 阶段 | 主题 |
|---|---|
| [阶段一](docs/reports/阶段一报告.md) | 抗干扰 SSTV 解码网页应用 |
| [阶段二](docs/reports/阶段二报告.md) | 抗干扰框架（信道模拟 + RS 纠错 + 交织） |
| [阶段三](docs/reports/阶段三报告.md) | 块长扫描 + 内容依赖性量化 |
| [阶段四](docs/reports/阶段四报告.md) | 硬门禁补跑 + 黑边/不可嵌入块修复 + B=32 定标 |
| [阶段五](docs/reports/阶段五报告.md) | 图片隐藏层（秘密图嵌入） |
| [阶段六](docs/reports/阶段六报告.md) | 抗干扰解码的真实场景验证 |
| [阶段七](docs/reports/阶段七报告.md) | PD120/PD180 解码 + findHeader 自适应回退 |
| [阶段八](docs/reports/阶段八报告.md) | 项目收尾（改名 + 技术报告 + 测试套件完善） |
| [阶段九](docs/reports/阶段九报告.md) | 内联 SVG 文字错位修复 |
| [阶段十](docs/reports/阶段十报告.md) | 产品化（统一导航 + 首页重设计 + 术语人话化） |
| [阶段十一](docs/reports/阶段十一报告.md) | 补三张机制演示图 |
| [阶段十二](docs/reports/阶段十二报告.md) | 项目目录整理（报告归档 + 引用修复） |
| [阶段十三](docs/reports/阶段十三报告.md) | 重写 README（过期信息修正 + 数字来源可复核） |
| [阶段十四](docs/reports/阶段十四报告.md) | 术语统一（改用「抗干扰」表述）+ README 精简重写 |
| [阶段十五](docs/reports/阶段十五报告.md) | 清理过期标题 + 统一四页标题风格 |
| [阶段十六](docs/reports/阶段十六报告.md) | 清理 UI 层过期文案（面板自检 + 阶段标签） |
| [阶段十七](docs/reports/阶段十七报告.md) | 音频格式兼容层（WAV 之外的 M4A/MP4/WebM/MP3/OGG） |
| [阶段十八](docs/reports/阶段十八报告.md) | 验证转码后隐藏载荷能否提取 + 修复路线评估 |

### 开源协议

本项目是 MIT 许可第三方作品的衍生作品。编码逻辑与模式时序来自
[CKegel/Web-SSTV](https://github.com/CKegel/Web-SSTV)，解调核心移植自
[samccone/sstv](https://github.com/samccone/sstv)，FFT 为
[fft.js](https://github.com/indutny/fft.js)。完整版权声明见
[`js/lib/LICENSE-THIRD-PARTY.md`](js/lib/LICENSE-THIRD-PARTY.md)。

### 贡献

三条约定：

- **提交前跑一遍 [`tests/roundtrip.js`](tests/roundtrip.js)**——它是阶段一回归的硬门禁，
  PSNR 不应低于 M1 **31.23 dB** / S1 **30.50 dB**。
- **不要手改 [`tech.html`](tech.html)**：它由 `scripts/gen-paper-figures.js` 与
  `scripts/gen-tech-html.js` 生成，手改会在下次生成时被覆盖。论文里的数字全部由脚本从实测数据
  算出，请不要手写数字。
- **新增页面请用共享导航**（由 `scripts/nav-partial.js` 生成，`node scripts/apply-nav.js --apply`
  注入），测试会断言各页导航与生成器逐字节一致。

## 验证

13 套判定型测试，每一套都有明确的通过/失败结论：

`verify-signal.js` · `roundtrip.js` · `channel-sim.test.js` · `fec-rs.test.js` ·
`interleaver.test.js` · `image-codec.test.js` · `pd-modes.test.js` · `tech-html.test.js` ·
`e2e-full.js` · `browser-e2e.js` · `image-pages-e2e.js` · `mobile-a11y.node.js` ·
`svg-geometry.node.js`（均在 `tests/` 下）

需要 Node 18+；浏览器类测试使用本机已安装的 Edge / Chrome，不需要任何 npm 依赖。

```bash
node tests/roundtrip.js        # 阶段一回归硬门禁
node scripts/list-tests.js     # 生成完整测试清单
```
