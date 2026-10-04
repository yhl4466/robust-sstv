# scripts/archive — 已退休的一次性脚本

这里存放的是**已经完成使命、不再参与任何流程**的脚本，保留下来只为存档。
它们记录的是项目早期若干轮"事后修补"的具体做法，删掉会让对应的历史报告失去可核对的对象。

## 为什么放在这里，而不是删掉

每一份阶段报告（`docs/reports/阶段N报告.md`）都会写明"本轮改了哪些文件、用什么脚本改的"。
把这些脚本删掉，报告里的引用就变成悬空引用——而本项目的一条原则是：
**报告里的每一项都应能追到实物**。归档保留了这条链，同时把它们移出了 `scripts/` 的工作面。

## 重要：这批脚本**不能直接运行**

它们全都用 `__dirname` 拼仓库根路径（例如 `path.join(__dirname, '..')`）。
移入 `scripts/archive/` 后，`..` 指向 `scripts/` 而不是仓库根，**路径会错**。
如果要重新执行其中任何一个，先把它移回 `scripts/`，或在文件里把相对层级改深一层。

它们的 `require()` 只用到 Node 内置模块（`fs` / `path` / `vm`），所以移入后至少不会因为
模块解析而报错——但会因路径不对而写错位置。**不要在没有核对路径的情况下直接跑。**

## 清单

| 脚本 | 当初的用途 | 相关阶段 |
|---|---|---|
| `repair-appjs.js` | 从 `js/app.js.corrupt` 备份恢复 `js/app.js` 并做文本修补 | 阶段四 / 八 / 十 |
| `repair-appjs-final.js` | 同上，最后一轮的收尾修补 | 阶段十六 |
| `patch-appjs.js` | 按断言"恰好命中一处"的方式批量改 `js/app.js` 文案 | 阶段十 / 十四 |
| `apply-terminology.js` | 术语统一批处理，调用 `check-readme` / `patch-appjs` / `rename-project` / `move-reports` | 阶段十四 |
| `rename-project.js` | 项目改名（旧名 → 现名）的批量替换 | 阶段八 / 十四 |
| `move-reports.js` | 把阶段报告移入 `docs/reports/` | 阶段十二 |
| `check-readme.js` | 校验 README 中若干关键数字与措辞是否还在 | 阶段十四 |
| `check-ui-wording.js` | 校验界面文案的人话化程度 | 阶段十五 / 十六 |
| `diagnose-unreachable.js` | 一次性诊断：找出不可达代码路径 | 阶段四 |
| `probe-pd-edge.js` | 一次性探针：PD 族边界行为 | 阶段七 |
| `diagnose-pd-lock.js` | 一次性诊断：PD 族逐行锁定 | 阶段七 |

## 连带删除的物证

`js/app.js.corrupt`（31 KB，乱码旧版 `app.js`）连同这批脚本一起删除：
它是 `repair-appjs.js` 的输入，而 `repair-appjs.js` 已归档且被明确标注"不可直接运行"。
`.gitignore` 里有 `*.corrupt` 规则、文件也未被 git 跟踪，所以它从来不是项目产物的一部分。

## 什么留在了工作面上

`scripts/apply-nav.js` **没有**归档。它在 `README.md` 的贡献者约定里被文档化
（`node scripts/apply-nav.js --apply`），且被 `tests/nav-check.js` 的导航一致性检查间接依赖，
属于活的工具链。
