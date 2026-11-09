# 第三方代码（vendored）

本仓库只 vendor 一处第三方运行时代码。这里记清楚：来源、版本、许可、改了哪几行、
为什么只拿这一块——出问题时（合规审查、上游升级、界面坏了）都从这里查。

---

## 1. UEmaster · flow-walkthrough 模板

| 项 | 值 |
|---|---|
| 上游仓库 | <https://github.com/roxorlt/UEmaster> |
| 上游路径 | `skills/flow-walkthrough/templates/walkthrough.html` |
| 固定提交 | `f6de00fc525715f891c0a9a896154a0ffbcdc17f`（2026-09-24） |
| 版权 | Copyright (c) 2026 roxor |
| 许可 | MIT |
| 许可全文 | [`lib/vendor/uemaster/LICENSE`](../lib/vendor/uemaster/LICENSE)，条目见 [`NOTICE`](../NOTICE) |
| 本仓库副本 | [`lib/vendor/uemaster/flow-walkthrough.html`](../lib/vendor/uemaster/flow-walkthrough.html) |

### 拿了什么

只拿**运行时模板**：三栏布局的 HTML 骨架、`wt-*` 组件样式、以及那段把
「点节点 → 切中间页 → 换右栏标注与状态按钮」串起来的浏览器 JS。
它是单文件、零依赖、离线可用的，正好符合本插件「不引入构建步骤、不加运行时依赖」的约束。

### 没拿什么，以及为什么

| 没拿 | 原因 |
|---|---|
| `SKILL.md`、`references/page-guide.md`、`contract/*.md` | 那是给模型读的写页规范，不是运行时代码；抄进来只会变成两份会走样的说明书 |
| `scripts/build.py`、`scripts/selftest.py` | 构建器是 Python；本插件零构建、《README》承诺「装了 node+git 就能跑」，多一个 Python 依赖不划算。占位符替换用 20 行 JS 就能做完（`lib/material.js`） |
| `examples/`（宠物寄养那套原型页） | 示例页面属于上游的演示内容，与本产品的「页面结构卡」不是一回事；抄进来等于伪造原型 |
| `skills/flow-canvas/scripts/*.py`（流程 / 时序布局器） | 同上：Python。本仓库用 `lib/flow-svg.js`、`lib/seq-svg.js` 重写了两种图的 SVG，**只对齐输出契约**（`data-flowspec="1"`、`g[data-node]`、`#sel-ring`；`data-seqspec="1"`），没有复制布局算法 |

### 改了什么（逐条）

改动都标在副本文件头部的注释里，除此之外与上游逐字节一致：

1. **新增四个模板槽位**：`__HEAD_EXTRA__`（生成器 meta 与本产品覆盖样式，放在 `</head>` 前，
   保证覆盖样式排在模板样式之后）、`__INTRO__`（三栏之上的产品语言正文）、
   `__FOOT__`（限界框 + 研发参考 + 署名）、`__FLOW_TITLE__`（左栏短标题，避免整句需求把标题撑成两行）。
2. **深链扩展**：上游只认 `#node=<id>`；这里额外认 `#node=<id>&state=<组>/<状态>`，
   把状态映射到该状态的代表节点。原因很实际：演示 GIF 由 headless Chrome 截图，
   它不会点击，只能靠 URL 分别停在不同节点/状态上，再把几帧拼成「点过去」的过程。
3. **右栏「使用说明」第三块**换成 `__USAGE_NOTE__` 占位，由本产品写入深链说明——
   上游那句「支持 #node=节点id 直达」在扩展之后不再完整。

### 升级流程

```bash
git clone --depth 1 https://github.com/roxorlt/UEmaster.git /tmp/uemaster
diff -u /tmp/uemaster/skills/flow-walkthrough/templates/walkthrough.html \
        lib/vendor/uemaster/flow-walkthrough.html
# 手工把上游改动并回副本，保留上面四处修改；然后把新的提交号写回：
#   NOTICE、docs/vendor.md、副本文件头注释 三处必须同时改
node --test test/material.test.js     # 模板槽位少一个就会红
```

### 为什么必须留署名

这份模板决定了材料「好不好读」，不是随手抄的一段 CSS。上游把三栏联动、状态切换、
全屏缩放这些细节打磨过，本产品的价值在于「内容只写能核实的东西」，两者叠在一起才成立。
所以 README 的致谢、`NOTICE`、文件头注释三处都写明来源，且 `<head>` 里的生成器
meta 始终保留——出问题时要能从 HTML 本身认出「这是谁生成的」。
