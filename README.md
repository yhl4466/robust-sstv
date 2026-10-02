# 鲁棒 SSTV 解码平台

在浏览器里完成 **图片 ⇄ SSTV 音频** 的完整编解码：把一张图变成一段声音，通过微信、邮件，
或任何能传声音的渠道发送出去，对方用同一个网页还原成图片。纯前端、零依赖、可离线运行。

面向的场景是**真实退化信道**——调谐偏差、采样率失配、单边带通带畸变、衰落、工频与邻道干扰、
房间混响、硬削波，以及这些损伤的叠加。

---

## 状态说明

本 README 描述当前已实现的能力。各阶段的**过程记录**（设计取舍、实测数据、未达标项及其根因）
归档在 [`docs/reports/`](docs/reports/)，其中刻意保留了失败与被推翻的结论。四大块能力如下：

| 能力 | 状态 |
|---|---|
| SSTV 编解码（四模式） | 已实现 |
| 抗干扰解码（仿射标定 + 时钟恢复） | 已实现 |
| 数字边带纠错（里德-所罗门码 + 交织） | 已实现 |
| 图片隐藏（公开图 + 秘密图共存） | 已实现（页面产品化留待后续） |

---

## 功能

### 支持的模式

编码与解码均支持以下四种模式。总时长含 VIS 标定头与尾部余量。

| 模式 | VIS | 分辨率 | 色彩空间 | 总时长 | 像素时间 |
|---|---|---|---|---|---|
| Martin M1 | 44 | 320×256 | GBR | 115.30 s | 457.6 µs |
| Scottie S1 | 60 | 320×256 | GBR | 110.64 s | 457.6 µs |
| PD120 | 95 | 640×496 | YUV | 127.11 s | 190.0 µs |
| PD180 | 96 | 640×496 | YUV | 187.43 s | 285.0 µs |

两种扫描结构：**逐行同步族**（M1 / S1，每行一个同步脉冲，可逐行独立锁位）与 **PD 族**
（PD120 / PD180，每个行对一个 20 ms 同步脉冲，无逐行 porch，色度由两行共用）。二者由同一张
模式表驱动，共用一条解码路径。

> **采样率要求**：PD 族的像素时间较短，调制率约 5.3 k 像素每秒，因此其音频**需要 16 kHz 以上**
> 采样；8 kHz 录音对 PD120 低于奈奎斯特频率，属体制限制而非实现缺陷。

### 其它能力

| 环节 | 说明 |
|---|---|
| **编码** | 图片自动等比缩放居中到模式标准栅格；生成即试听 + 下载 WAV |
| **解码** | 三档精度（快速 ×8 / 标准 ×16 / 精细 ×32）；进度提示与取消；保存 PNG |
| **抗干扰** | 仿射频率标定（引导音锚定偏移项 + 同步头拟合时钟尺度）与逐行时钟恢复 |
| **纠错** | GF(2⁸) 系统里德-所罗门码（码长 255，校验 32 或 64）+ 码字交织 |
| **图片隐藏** | 以块均值的量化索引调制在图象域嵌入数字边带；公开图与秘密图共存于同一段音频 |
| **技术报告** | `tech.html`：学术论文体，含 13 张图与 10 张表，所有数字由脚本从实测数据生成 |

---

## 快速开始

### 本地运行

**直接双击 `index.html`** 即可（`file://` 协议），无需构建、无需服务器、无后端依赖。

> 之所以能双击运行，是因为本项目刻意规避了 `file://` 下被浏览器禁用的能力：
> 不使用 ES Module、Web Worker、AudioWorklet、`fetch()`、`decodeAudioData()`。
> 实测证据见「技术细节 · file:// 约束」。

### 页面一览

四个页面通过同一导航栏互链：

| 页面 | 用途 |
|---|---|
| `index.html` | 首页：介绍、三步说明、常见问题；完整工具在「高级设置」面板内 |
| `embed-image.html` | 图片隐藏 · 嵌入端 |
| `extract-image.html` | 图片隐藏 · 提取端 |
| `tech.html` | 技术报告（学术论文体） |

### 在线部署

本项目是纯静态页面，**没有构建步骤**：把仓库根目录设为任意静态托管的发布目录即可
（GitHub Pages / Netlify / 自有服务器）。

**当前没有已发布的在线实例**，请使用上方的本地运行方式。

---

## 使用方法

### 生成音频

1. 打开 `index.html`，展开下方的「高级设置」面板
2. 在「① 生成音频」中选择图片（PNG / JPG）
3. 选择音质档位（对应四种模式之一）
4. 点击「生成音频」，试听后点「下载 WAV」

### 解码音频

1. 在「② 解码音频」中选择 WAV 文件
2. 选择解码精度档位（快速 / 标准 / 精细）
3. 点击「解码音频」，完成后保存 PNG

若还原失败，界面会给出**可操作的提示**而不是内部错误码，例如「没检测到信号。请确认上传的是
声音传图的音频，或让对方重新发送。」——内部状态到用户提示的映射见 `js/app.js` 的 `decodeErrorText()`。

### 图片隐藏

1. 在 `embed-image.html` 中先后选择**公开图**（载体）与**秘密图**
2. 设置模式、载体块长与纠错档位，生成含隐藏内容的音频
3. 对方在 `extract-image.html` 中上传该音频，**同时还原公开图与秘密图**

> 受边带容量限制，秘密图只能是缩略图（见已知限制 L3）。

---

## 已知限制

以下八条与 `tech.html` 的**表 9** 编号与表述一致。这些限制经实测确认，不是推测。

| 编号 | 限制 | 实测依据 | 影响 |
|---|---|---|---|
| **L1** | 标定头检测在两重损伤叠加时失败 | 三段样本（单边带加工频、单边带加邻道、房间混响加带倾斜）全部终止于标定头搜索；将接受阈值放宽 3.5 倍仍无候选 | 这三类音频完全无法解码 |
| **L2** | PD 族缺少真实录音验证 | 检索六个公开仓库仅得到 Martin M1 样本；规格文档不可获取 | PD 解码的正确性仅有自洽往返支撑，未与标准逐项核对 |
| **L3** | 边带载荷容量仅数百字节 | 块长 32 时载荷 215 B，扣除图片头后图象数据 200 B | 秘密图只能是 20×20、4 位每像素的灰度缩略图 |
| **L4** | 交织深度受码字数限制 | 块长 32 时载波仅容一个 255 字节码字，端到端深度为 1 至 2 | 对连续突发的分散能力有限 |
| **L5** | 严重档超出适用范围 | 块长自 16 扫描至 128，帧成功率恒为零，字节正确率约 24.7% | 该档不作为可用工作点 |
| **L6** | 频偏与时钟校正在真实录音上无净收益 | 二十六段样本平均 PSNR 变化为 −0.01 dB；交叉点位于 0.02% 至 0.1% 之间 | 该机制属于对未出现失效模式的保险 |
| **L7** | σ_HF 可被模糊压低 | 干净样本滤波后 σ_HF 由 10.87 降至 7.00，同期 PSNR 下降 | 该指标不可单独用作质量判据 |
| **L8** | PD 解码耗时较高 | PD120 单次解码约 46 s，Martin M1 约 7 s | 交互式使用受限 |

另外两条实现层面的说明：**解码在主线程分块让出**（`file://` 下 Worker 不可用），单张 M1/S1
约 4~8 秒；**精细档（×32）并不提高保真度**，受像素窗的物理分辨率上限约束，保留仅供对比。

---

## 实测结果

每一个数字都标注了来源，便于复核。**「来源」列中的 `tech.html` 表示该数字可在技术报告中
逐字查到，`tests/roundtrip.js` 表示它来自回归测试。**

| 指标 | 值 | 来源 |
|---|---|---|
| M1 往返 PSNR（**真实照片**） | 31.23 dB | `tests/roundtrip.js` |
| S1 往返 PSNR（**真实照片**） | 30.50 dB | `tests/roundtrip.js` |
| PD120 往返 PSNR（合成细节图） | 32.46 dB | `tech.html` 表 8 |
| PD180 往返 PSNR（合成细节图） | 32.62 dB | `tech.html` 表 8 |
| PD120 往返 PSNR（彩色色条图） | 28.49 dB | `tech.html` 表 8 |
| M1 往返 PSNR（合成细节图，对照） | 31.95 dB | `tech.html` 表 8 |
| 支持采样率 | 8 kHz – 44.1 kHz | `tech.html` 摘要 |
| 硬削波容忍 | 3× 无损（8× 起劣化） | `tech.html` 摘要与 5.5 节 |
| 真实音频组合 | 26 段中 23 段成功解码 | `tech.html` 图 12 |

> **两处 M1 的 PSNR 不是同一个数，因为测的不是同一张图**：31.23 dB 来自回归测试使用的
> **真实照片**，31.95 dB 来自技术报告表 8 的**合成细节图**（该表的对照行，用于确认逐行同步族
> 未受 PD 改动影响）。两者都正确，比较时请注意对应关系。

**关于旧版 README 的数字**：本表此前的 M1 / S1 记为 31.21 / 30.48 dB（阶段一测量）。此后对解调器
的改动使其变为 **31.23 / 30.50 dB**，已按当前基线更新。

---

## 技术细节

### 编码原理

像素灰度线性映射为音频瞬时频率：黑电平 1500 Hz、白电平 2300 Hz，每灰阶 3.137 Hz；
同步脉冲为 1200 Hz。编码时按模式时序把每个分量行扫描为频率序列并在行首插入同步脉冲与
分离脉冲，合成时保持相位连续。

### 模式表驱动

所有模式参数集中在 `js/lib/sstv-modes.js`：分辨率、色彩空间、同步脉冲与 porch 时长、各分量
扫描时长与顺序、像素窗因子。逐行同步族与 PD 族的差异被归结为结构字段，因此两种扫描结构
共用一条解码路径。

### 纠错与交织

里德-所罗门码为 GF(2⁸) 上的系统码，本原多项式 0x11D，码长 255，校验符号 32 或 64，对应最多
纠正 16 或 32 个符号错误。译码为伴随式计算 → 擦除定位多项式 → Forney 伴随式 →
Berlekamp-Massey 迭代 → Chien 搜索 → 幅度求解，并在输出前重算伴随式以排除静默误纠。
交织按行写入、按列读出，把长度 b 的连续突发限制为每个码字内至多 ⌈b/D⌉ 个错误。

### 数字边带

以块均值的量化索引调制嵌入图象域：把绿色通道上长度为 B 的横向块视为一个承载单元，将块均值
移动到与之奇偶性匹配的量化格点，位移以整数单位在块内重新分配以避免取整误差。提取时以块均值
到最近格点的量化残差作为置信度，超阈值者判为擦除并交由纠错码处理。

### 数据流

```
编码:  <input file> → dataURL → <img> → Canvas(模式栅格) → getImageData
       → sstv-timeline → [载荷嵌入接缝] → sstv-synth → Float32 样本
       → ① 播放(AudioBuffer)  ② wav.encode → Blob 下载

解码:  <input file> → File.arrayBuffer() → wav.parse（文件原生采样率）
       → ① <audio> Blob URL 播放
       → ② sstv-decode：标定头 → VIS → 仿射标定 → 逐行同步对齐 → 逐像素频率估计
            → [载荷提取接缝] → 解交织 → RS 译码 → CRC 校验 → ImageData
```

### file:// 约束（headless Edge 实测）

| 能力 | 结果 |
|---|---|
| `<script type="module">` / 动态 `import()` | ❌ 被拦截（CORS / 不透明源） |
| `new Worker()` | ❌ `SecurityError: ... cannot be accessed from origin 'null'` |
| `audioWorklet.addModule()` | ❌ `AbortError: cross-origin script failed to load` |
| `fetch()` 本地文件 | ❌ `TypeError: Failed to fetch` |
| `canvas.getImageData()` 画 `file://` 图片后 | ❌ 画布被污染 |
| `canvas.getImageData()` 画 **data URL** 图片后 | ✅ 可读 |
| `OfflineAudioContext` 渲染 / `AudioContext` | ✅ 可用（后者初始 `suspended`，需用户手势 `resume()`） |

因此：**仅用传统脚本**、图像入口**只走 data URL**、**不 fetch / 不用 Worker**、
**不用 `decodeAudioData`**（它会重采样到设备采样率，而 SSTV 解调必须使用文件原生采样率，
常见录音为 8 kHz / 11025 Hz）。

### 扩展接口

`js/lib/sstv-channel.js` 中的接口已接入实际编解码管线，可在页面底部「扩展接口自检」面板中查看
实时状态与各模式容量估算。

```js
SSTVChannel.Codec.registerEmbedder(id, { capacity(meta), embed(samples, bits, meta), extract(samples, meta) })
SSTVChannel.Codec.registerFEC(id, { encode(bits), decode(llr) })
SSTVChannel.Channel = { awgn, gain, freqOffset, ... }
SSTVChannel.Backend = { mode: 'local' | 'remote', encode(), decode() }
```

解调器还可输出**每像素置信度**（`wantConfidence: true`），供软判决纠错使用。

### 目录结构

```
robust-sstv/
├── index.html                  首页（介绍 + 高级设置内的完整工具）
├── embed-image.html            图片隐藏 · 嵌入端
├── extract-image.html          图片隐藏 · 提取端
├── tech.html                   技术报告（由脚本生成）
├── css/style.css
├── js/
│   ├── app.js                  UI 装配与用户提示映射
│   ├── encoder.js / decoder.js 编解码门面
│   ├── channel-sim.js          信道退化模拟
│   ├── fec-rs.js               里德-所罗门码
│   ├── interleaver.js          码字交织
│   ├── image-codec.js          秘密图编解码
│   ├── payload-qim.js          量化索引调制载体
│   ├── payload-pipeline.js     载荷链路
│   ├── image-embed.js / image-extract.js   图片隐藏两端
│   └── lib/                    SSTV 时序、合成、解调、WAV、FFT
├── scripts/                    生成器（论文图表）与迁移/检查工具
├── tests/                      判定型测试、诊断与基准
└── docs/reports/               各阶段开发记录
```

---

## 开发记录

各阶段的过程记录（设计取舍、实测数据、**未达标项及其根因**）归档在
[`docs/reports/`](docs/reports/)。这些记录刻意保留了失败与推翻的结论，例如阈值放宽被证伪的
消融实验、相位差估计器在窄带下的失效、以及若干未达标的验收项。

| 阶段 | 主题 |
|---|---|
| [阶段一](docs/reports/阶段一报告.md) | 鲁棒 SSTV 解码网页应用 |
| [阶段二](docs/reports/阶段二报告.md) | 抗干扰框架（信道模拟 + RS 纠错 + 交织） |
| [阶段三](docs/reports/阶段三报告.md) | 块长扫描 + 内容依赖性量化 |
| [阶段四](docs/reports/阶段四报告.md) | 硬门禁补跑 + 黑边/不可嵌入块修复 + B=32 定标 |
| [阶段五](docs/reports/阶段五报告.md) | 图片隐藏层（秘密图嵌入） |
| [阶段六](docs/reports/阶段六报告.md) | 鲁棒解码的真实场景验证 |
| [阶段七](docs/reports/阶段七报告.md) | PD120/PD180 解码 + findHeader 自适应回退 |
| [阶段八](docs/reports/阶段八报告.md) | 项目收尾（改名 + 技术报告 + 测试套件完善） |
| [阶段九](docs/reports/阶段九报告.md) | 内联 SVG 文字错位修复 |
| [阶段十](docs/reports/阶段十报告.md) | 产品化（统一导航 + 首页重设计 + 术语人话化） |
| [阶段十一](docs/reports/阶段十一报告.md) | 补三张机制演示图 |
| [阶段十二](docs/reports/阶段十二报告.md) | 项目目录整理（报告归档 + 引用修复） |
| [阶段十三](docs/reports/阶段十三报告.md) | 重写 README（过期信息修正 + 数字来源可复核） |

---

## 验证

所有结论均可复现。测试脚本需要 **Node 18+**；浏览器类测试使用本机已安装的 Chromium 内核浏览器
（Edge / Chrome），无需任何 npm 依赖。

### 判定型套件（有明确通过/失败结论）

| 套件 | 覆盖范围 |
|---|---|
| [`tests/verify-signal.js`](tests/verify-signal.js) | 编码器逐样本频率映射、行结构、音调、VIS 比特 |
| [`tests/roundtrip.js`](tests/roundtrip.js) | 四模式编码往返与图象保真度（**阶段一回归硬门禁**） |
| [`tests/channel-sim.test.js`](tests/channel-sim.test.js) | 信道模拟器五类退化 |
| [`tests/fec-rs.test.js`](tests/fec-rs.test.js) | 里德-所罗门编解码与三重验证（19 项） |
| [`tests/interleaver.test.js`](tests/interleaver.test.js) | 交织往返与突发分散（14 项） |
| [`tests/image-codec.test.js`](tests/image-codec.test.js) | 秘密图编解码与图片帧（33 项） |
| [`tests/pd-modes.test.js`](tests/pd-modes.test.js) | PD120 / PD180 往返与表结构（25 项） |
| [`tests/tech-html.test.js`](tests/tech-html.test.js) | 技术报告结构、编号、引用、几何、文风、导航、术语（30 项） |
| [`tests/e2e-full.js`](tests/e2e-full.js) | 四模式完整链路：图 → 音频 → 信道 → 解码 → 图（32 项） |
| [`tests/browser-e2e.js`](tests/browser-e2e.js) | 浏览器 `file://` 端到端：真实文件输入、按钮与下载 |
| [`tests/image-pages-e2e.js`](tests/image-pages-e2e.js) | 图片隐藏两页面端到端（28 项） |
| [`tests/mobile-a11y.node.js`](tests/mobile-a11y.node.js) | 移动端视口适配、折叠导航、渲染后术语扫描（51 项） |
| [`tests/svg-geometry.node.js`](tests/svg-geometry.node.js) | 内联 SVG 渲染级几何体检（13 张图） |

**共 13 套判定型套件。**

> 其中 `mobile-a11y.node.js` 与 `svg-geometry.node.js` **尚未登记进
> [`scripts/list-tests.js`](scripts/list-tests.js)**，因此不在 `tests/test-manifest.json` 里。
> 该清单文件目前停留在阶段八，重新生成需要运行全部套件，属后续工作。

### 诊断与基准（输出数值，不参与门禁）

| 脚本 | 用途 |
|---|---|
| [`tests/diagnose-align.js`](tests/diagnose-align.js) | 同步对齐精度（对照编码端真实同步脉冲位置） |
| [`tests/perf.js`](tests/perf.js) | 三档精度的时间/保真度权衡 |

### 运行方式

```bash
# 全部判定型套件（逐套单独运行，约 20 分钟）
for f in tests/verify-signal.js tests/roundtrip.js tests/channel-sim.test.js \
         tests/fec-rs.test.js tests/interleaver.test.js tests/image-codec.test.js \
         tests/pd-modes.test.js tests/tech-html.test.js tests/e2e-full.js \
         tests/browser-e2e.js tests/image-pages-e2e.js \
         tests/mobile-a11y.node.js tests/svg-geometry.node.js; do node "$f"; done

# 生成完整测试清单
node scripts/list-tests.js
```

`tests/roundtrip.js` 与 `tests/browser-e2e.js` 依赖 `.research/` 中的上游实现与 `pngjs`
（用于交叉验证和图像比对）；缺失时会自动跳过对应检查。

---

## 开源协议

本项目为 MIT 许可第三方作品的衍生作品；编码逻辑与模式时序来自
[CKegel/Web-SSTV](https://github.com/CKegel/Web-SSTV)，解调核心移植自
[samccone/sstv](https://github.com/samccone/sstv)，FFT 为
[fft.js](https://github.com/indutny/fft.js)。
完整版权声明与被修改内容清单见 [`js/lib/LICENSE-THIRD-PARTY.md`](js/lib/LICENSE-THIRD-PARTY.md)。

---

## 贡献

**提交前请先跑验证**，尤其是 [`tests/roundtrip.js`](tests/roundtrip.js)——它是阶段一回归的硬门禁，
其 PSNR 不应下降（当前基线 M1 **31.23 dB** / S1 **30.50 dB**）。

**改动约定**

- **不要手工编辑 `tech.html`**：它由 `scripts/gen-paper-figures.js` 与 `scripts/gen-tech-html.js`
  生成，手改会在下次生成时被覆盖。论文中的数字全部由脚本从实测 JSON 计算得出，请勿手写数字。
- **不要跳过 `tests/tech-html.test.js`**：它同时校验论文的结构、图表编号与交叉引用、内联 SVG 的
  几何、以及面向初学者的页面是否混入工程术语。
- **新增页面请使用共享导航**：由 [`scripts/nav-partial.js`](scripts/nav-partial.js) 单点生成，
  并用 `node scripts/apply-nav.js --apply` 注入；测试会断言各页导航与生成器逐字节一致。
- **已知限制请如实记录**（见上文 L1–L8）：本项目的过程记录刻意保留未达标项与已被推翻的假设，
  请勿为了让报告好看而删除失败结论。

**报告问题**时若能附上音频样本与 `node tests/...` 的输出，定位会快得多；与解码失败相关的样本，
请注明采样率与来源（录音设备 / 信道类型）。
