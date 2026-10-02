# 第三方组件与许可证 / Third-party components and licenses

本项目为 MIT 许可的第三方开源作品的衍生作品。以下组件被复用、移植或原样内置（vendored）。
本文件及其中的版权声明随本项目一同分发。

Web-SSTV 的许可证明确要求：自行托管/分发时必须提供其仓库链接与包含原始版权声明的 MIT 许可证副本。
本文件即用于满足该要求。

---

## 1. CKegel/Web-SSTV — 编码器来源

- 仓库: https://github.com/CKegel/Web-SSTV
- 许可证: MIT
- 本项目中的使用方式:
  - `js/lib/sstv-modes.js` — 各 SSTV 模式的时序参数（行数、像素数、消隐间隔、行长、同步脉冲长度）与
    标定头/VIS 常量，取自其 `encode.js` 的 `Format` 子类，并与其独立核对。
  - `js/lib/sstv-timeline.js` — 行结构与通道顺序（Martin: sync/porch 后 G、B、R 顺序；Scottie: 行内 sync
    位于 R 之前）取自其 `encode.js`。
  - **未原样复制**其前端代码：其实现为全局作用域 + DOM 耦合，且采用
    `AudioParam.setValueCurveAtTime()` 排程，无法进行阶段二所需的样本级写入。
    本项目将其模式定义重构为纯数据表 + 自研样本域合成器。
- **重要更正**: 其 Scottie S1 的 VIS 码 `[0,0,1,1,1,1,0]` 求值为 30，但标准 Scottie S1 为 **60**
  （其 Martin M1/M2、Scottie S2/SDX、PD50/90/120/180/240/290 均正确，仅 S1 与 PD160 有误）。
  本项目使用标准值，详见 `../阶段一技术方案.md` 第 6 节。
- 其解码器（`sstv-decoder.js`）为**未实现的空壳**，本项目未使用。

```MIT License

Copyright (c) 2023 Christian Kegel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.```

---

## 2. samccone/sstv (npm `sstv` 1.0.0) — 解调核心来源

- 仓库: https://github.com/samccone/sstv
- 许可证: MIT
- 本项目中的使用方式:
  - `js/lib/sstv-decode.js` — 解调算法移植自其 `src/decode.ts` 与 `src/spec.ts`：标定头搜索、VIS 解码与
    偶校验、逐行同步对齐、Hann 窗 + 重心法峰值插值、`calc_lum` 亮度映射、GBR 色彩还原、
    `WINDOW_FACTOR` 等常量。
  - 已做的修改（均为有意为之，并在源码注释中标注）：
    1. 去除 Node 依赖（`fs`（实际未使用）、`pngjs`），改为输出 `ImageData`；改用内置 fft.js。
    2. 性能：按窗口长度选取 `nextPow2(len*mult)` 的 FFT（而非固定 4096 点）、缓存 Hann 窗、
       复用暂存数组、以 `(offset,len)` 取代逐像素 `slice()`。同一 115 秒 Martin M1 文件：
       112.4 s → 4.4~7.3 s。
    3. 输出改为扁平 `Float32Array` / `Uint8ClampedArray`，替代三维 `number[][][]`。
    4. 增加协作式让出、进度回调、取消能力。
    5. 返回结构化错误（header / VIS / image 阶段）而非抛出异常。
    6. 新增每像素置信度输出（阶段二 LDPC 软判决所需）。
    7. 同步对齐增加 1200 Hz 匹配相关细化（原启发式存在数十采样点抖动）。
    8. 修正分析窗居中：原实现将窗口中心对齐到像素**前沿**而非像素中心。
    9. 修正 `px_end >= length` 的边界判断（信号末尾恰好在最后一个像素处时被误判为截断）。
  - 其编码器（仅支持 Martin 1）与 CLI 未被使用。

```MIT License

Copyright (c) 2025 The SSTV Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. fft.js 4.0.4 — FFT 实现（原样内置）

- 仓库: https://github.com/indutny/fft.js
- 作者: Fedor Indutny <fedor@indutny.com>
- 许可证: MIT（其 `package.json` 声明 `"license": "MIT"`；该 npm 包未随附 LICENSE 文件，
  上游仓库亦未提供被 GitHub 识别的许可证文件，故此处无法逐字复制其许可证文本）
- 本项目中的使用方式: `js/lib/fft.js` 为 `lib/fft.js` 的**逐字**复制，仅外层增加了一个
  浏览器/Node 双用的包装器（原文件在浏览器中会因 `module.exports` 未定义而报错）。
  包装器之外未作任何算法改动。

---

## 未被采用的候选（仅调研，未使用代码）

- MadjikDotPng/Better-WSSTV、RussPalms/Web-SSTV_dev、MTkhai/Web-SSTV — CKegel/Web-SSTV 的 fork，
  解码器为同一个空壳（git blob sha `99f0b707`）。
- vignedev/node-sstv (MIT) — 纯 TS 编码器，按模式输出 PCM，作为"样本域架构"的参考阅读，未复制代码。
- boybook/rasterwave-node (MIT) — Node 原生 N-API 模块，浏览器不可用。
- HerrZatacke/sstv (npm `sstv@0.0.1`, MIT) — 仓库已 404，包停更于 2017 年。
