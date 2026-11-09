# 这条链路是怎么工作的（实测记录）

从「接自己的仓」到「问一句出材料」，中间那一刀补上了什么、数据长什么样、边界在哪。
下面每个数字都对应一次真实运行，命令与输出都留着；没做到的部分单独列在最后，不当成已知。

测试环境：macOS，node `v22.23.4`，git `2.50.1`，插件 `dsh-plugin-repotruth@0.3.0`，
验证用的宿主是 `--profile repo-truth-gui --port 60555`（不动 `desktop` profile 的加载方式）。

---

## 1. 一句话

```
接入（bare mirror，增量 fetch） → 建索引（内容寻址 JSON，第二遍 0 解析） → 问一句（只读索引，查不到就说查不到） → 覆盖率表（真数据，不是 fixture）
```

宿主进程从不执行克隆与解析：它们跑在 `lib/worker.js` 这个子进程里，每个仓一套硬超时。
面板靠轮询 `/jobs` 显示进度——没有 websocket。

---

## 2. 数据布局

```
~/Library/Application Support/repo-truth/          # 目录 700，文件一律 600
├── config.json        代码源 + 署名开关（唯一存令牌的地方）
├── repos.json         已接入的仓：地址、HEAD、上次同步结果、分项计数
├── coverage.json      覆盖率表（由索引运行结果投影出来）
├── mirrors/<仓名>.git  bare 镜像：首次 clone --mirror，之后只 fetch --prune
├── index/<仓名>.json  内容寻址索引（可删，删了能重放）
└── answers/<id>.html  「问一句」的材料（只留最近 60 份）
```

`safeName()` 把仓名白名单化（`../../etc/passwd` → `etc-passwd`），因为仓名来自用户输入或远端地址，
文件名跟着仓名跑一次越界，就能把索引写到目录外面。

### 索引文件的形状

```json
{
  "version": 1,
  "repo": "vue-admin-template",
  "head": "4c18a3f47bdb417ad8a25f09910f848cb574dee2",
  "headDate": "2021-11-19T15:21:54+08:00",
  "indexedAt": "2026-11-09T08:49:22.515Z",
  "parsedBlobs": 0,
  "reusedBlobs": 68,
  "counts": { "total": 98, "indexed": 68, "generated": 0, "test": 8,
              "dir": 1, "asset": 14, "unsupported": 7, "large": 0 },
  "pages": { "convention": "views", "label": "src/views/**", "items": ["src/views/login", "…"] },
  "blobs": { "<blobSha>": { "lang": "Vue", "symbols": ["…"], "outline": ["LoginForm"],
                            "pages": [{ "convention": "views", "page": "src/views/login/index" }],
                            "imports": ["src/components/LoginForm.vue"] } },
  "generated": { "<blobSha>": true },
  "files": { "src/views/login/index.vue": "<blobSha>" },
  "sizes": { "src/views/login/index.vue": 312 },
  "changes": { "src/views/login/index.vue": "2020-06-26T11:15:32+08:00" },
  "changesWindow": 200
}
```

相对最初约定的形状，这里有三处**加法**（约定的键一个没改、含义没变），各自有理由：

| 增加的键 | 为什么非要它不可 |
|---|---|
| `blobs[*].imports` | 「改这处会波及几处」只能靠反向引用回答；不存引用就只能现读源码，那就违背了「查现状不回查 X」 |
| `sizes`（按路径） | 「这块区域多大」需要一个字节数；按路径存而不是按 blob 存，是因为同一内容在不同路径上都要算一次 |
| `changes`（按路径） | 「上次改动是哪天」只能按路径算（同一 blob 在两个路径上改动时间不同）；只覆盖最近 200 个提交，窗口外的文件**不写**，因为「读不到」不能写成「没改过」 |

`generated` 单独一张表：自动生成的文件被排除在索引之外，但**它被排除过**这件事必须记住，
否则第二轮又要读一遍内容才能再次判断——那样「第二遍 0 解析」就不成立了。

---

## 3. 接口清单

| 方法 | 路径 | 作用 | 谁在调 |
|---|---|---|---|
| GET | `/api/repo-truth/health` | 自检：版本、署名开关、数据/镜像/索引目录 | 安装后自检、排查 |
| GET | `/api/repo-truth/config` | 代码源（令牌只有掩码）+ 署名开关 | 代码源页、仓库页 |
| POST | `/api/repo-truth/hosts` | 新增/修改代码源（`originalName` 即修改；空令牌=沿用） | 代码源页 |
| POST | `/api/repo-truth/hosts/delete` | 删除代码源 | 代码源页 |
| POST | `/api/repo-truth/test` | 测试连接（一次只读 GET） | 代码源页、表单直测 |
| GET | `/api/repo-truth/source-repos?name=<源>` | 列出该源上可见仓库（与「测试连接」同一份请求拼装） | 仓库页「从代码源选择」 |
| GET | `/api/repo-truth/repos` | 已接入的仓 + 当前任务 | 仓库页、问一句页 |
| POST | `/api/repo-truth/repos` | 接入一个仓（`url` 或 `owner/name`），**立即起任务** | 仓库页 |
| POST | `/api/repo-truth/repos/sync` | 手动同步；同仓并发 → 409 + 中文原因 | 仓库页 |
| POST | `/api/repo-truth/repos/delete` | 移除仓，并删本机镜像与索引文件 | 仓库页 |
| GET | `/api/repo-truth/jobs?id=&repo=` | 任务列表 / 单任务（进度轮询） | 仓库页（1.2s 一次，只在有任务时） |
| POST | `/api/repo-truth/ask` | 问一句；返回正文段落、限界框、候选、材料 URL | 问一句页 |
| GET | `/api/repo-truth/answers/<id>.html` | 打开完整材料（含折叠的研发参考） | 面板里的链接 |
| GET | `/api/repo-truth/coverage` | 覆盖率表（真数据） | 覆盖率页 |

写盘只有一处：**索引文件由子进程写，登记表与覆盖率只由宿主写**。
两处都写同一份文件，迟早出现「表里 412 行、索引 0 行」。宿主的写入串行化（`persistChain`）。

### 宿主不被拖住

```js
spawn(process.execPath, [workerPath, ...], { detached: true })   // 自成进程组
setTimeout(() => killTree(job), totalTimeoutMs(...))              // 到点杀整个进程组
```

- 超时 = 克隆上限 180s + 索引上限 120s + 60s 余量；`startJob` 立刻返回 jobId。
- 杀进程组而不是杀子进程：git 是「子进程的子进程」，只杀一层会留下一个继续占网络的 git。
- 令牌经 **stdin** 递进去（不进 argv，`ps` 看得见 argv），子进程只把它塞进
  `GIT_CONFIG_VALUE_0 = http.extraHeader`；错误文案统一过 `scrubUrl` + 掩码。

---

## 4. 增量契约

```
输入  (仓, 已有索引)
步骤  1 rev-parse HEAD          2 ls-tree -r -l HEAD（一次拿全树：路径 + blob sha + 字节数）
      3 路径分类（不看内容）      4 只对 blobs 里没有的 sha 调 cat-file --batch
      5 生成代码识别（只看这 4 KB）→ 记进 generated，不存解析结果
      6 写 JSON（临时文件 + rename）
输出  { parsedBlobs, reusedBlobs, counts, pages, … }
```

**必须满足的三条，都有测试守着：**

1. **幂等**：同一个 HEAD 跑两次，第二次 `parsedBlobs = 0`。
   实测（本机，vue-admin-template）：首次 `parsedBlobs=68 / 4526ms`，第二次 `parsedBlobs=0 / reused=68 / 401ms`。
2. **可重放**：删掉索引能全量重建，重建后的 files/blobs 集合与第一次逐项相同。
3. **只解析新内容**：改一个文件再跑 → `parsedBlobs = 1`。

### 跳过规则与记账

| 类别 | 判定方式 | 记账字段 |
|---|---|---|
| 第三方目录 | `vendor/` `third_party/` `testdata/`（以及构建产物目录），按**整段目录名** | `counts.dir` |
| 测试文件 | 目录段 `__tests__/test/tests/spec/e2e/__mocks__`；文件名 `*.test.*` `*.spec.*` `*_test.go` `test_*.py` `conftest.py` `*Test.java` | `counts.test` |
| 自动生成 | 内容前 4 KB 命中 `Code generated … DO NOT EDIT` / `@generated` / `This file was generated` | `counts.generated` |
| 素材 | 图片/字体/音视频/压缩包扩展名 | `counts.asset` |
| 认不得 | 扩展名不在语言表里 | `counts.unsupported` |
| 超大 | 单文件 > 512 KB（不读内容，避免解析卡住） | `counts.large` |

**不变式（测试断言）**：`total = indexed + generated + test + dir + asset + unsupported + large`。
少记一项就等于悄悄丢了文件，而丢文件在界面上是看不出来的。

### 页面口径只有一份实现

`lib/scan.js` 的纯函数层（`pageOfPath` / `parsePagesJson` / `pagesFromEntries`）同时服务：
`scanRepo`（demo，有工作区）和索引器（只有 bare mirror，没有工作区）。
一个测试直接把两边结果 `deepEqual`：**索引说 13 个页面，demo 就必须也说 13 个**。

---

## 5. 检索规则（以及它为什么编不出来）

```
提问 → 分词 → 候选打分 → 双门槛 → 命中 / 没找到
```

1. **分词**：英文词原样；中文先去掉虚词（怎么/如何/页面/一下…），再切**二元组**——
   没有词典就不假装会分词。另有一张固定的中文→英文对照表（`ZH_TERMS`，约 50 条），
   把「登录」接到 `login/signin/auth`。这张表只能**扩大候选**，表里的词在代码里不存在时依然什么都匹配不到。
2. **打分**（每个候选文件）：路径词精确命中 4、路径子串 2、符号精确 4、页面名 4、文档标题 1、
   中文二元组命中路径/页面 3。
3. **双门槛**：`总分 ≥ 4` **且** 至少一处「名字层面的强命中（≥2）」。
   两个门槛缺一不可——只看总分的话，一堆弱命中的通用词会把无关文件顶上来，那就是在编。
   实测：只在文档标题里出现一次的词（权重 1）、只在文件名里含这几个字母的词（权重 2）都不出结果。
4. **不命中就明说**：返回 `found: false`，正文写「没能在已索引的代码里找到…这是查过、没命中，不是不存在」，
   并列出**查了哪些仓、多少文件、用了哪些检索词**。没有「最像的那个」这种兜底。
5. **没索引 ≠ 没找到**：一个仓都没索引过时返回 `state: 'no-index'`，
   正文写「还没有任何一个仓建过索引，所以这一轮没有可查的东西」——这是「我没看」，不是「没有」。
6. **只读索引**：检索只读 JSON，不发请求、不碰镜像，所以答案的可复现性等于索引的可复现性。

材料渲染与 demo 共用同一套纪律：同一份 CSS、同一个署名模块、同一个正文禁词表
（`productBodyViolations` 在测试里跑，命中数必须是 0）、限界框固定写「没找到 ≠ 不存在」、
代码坐标只出现在末尾折叠的「研发参考」里。

### 「波及几处」的数字从哪来

`blobs[*].imports` 在索引时解析（只解析相对引用，`@/` 与 `~/` 按 `src/` 处理），
指向的文件必须在同一棵树里才记录。问一句时反向数一遍「谁 import 了我」。
这是刻意保守的：别名解析不了、动态 require、跨包引用都不算——所以这个数字**只会偏低，不会偏高**，
限界框里也这么写。

---

## 6. 没做的东西（故意的，不是漏了）

| 没做 | 为什么 | 代价 |
|---|---|---|
| 跨仓内容复用 | 每个仓一份索引文件最简单、最不容易坏；共享一张全局 blob 表需要并发写与 GC | 同样的内容在两个仓里各解析一次；多接一个仓会线性增加体积 |
| 数据库 | 索引是派生物，删掉能重放；引入数据库就把「随便一台装了 node+git 的机器都能跑」变成运维问题 | 大仓的 JSON 会到几十 MB，读整份才能提问 |
| AST / 语义分析 | 半懂的解析比不懂更危险（会产出「清单里没有 = 不存在」的假话） | 只能回答「名字与规模」，不能回答「具体怎么实现的」 |
| 解析路由声明文件 | 同上；页面口径固定为目录约定 | 页面数只会少算 |
| 后端流程 / 数据结构 / 权限 | 这些不是从文件树量得出来的 | 材料里一个字段都没有，限界框写死「根本没量」 |
| websocket 进度 | 一次请求一次响应就够，长连接要处理重连 | 进度最多晚 1.2 秒 |
| 鉴权 | 插件路由在 `/api` 的闸门外（dsh 路由规则），只在 loopback 上安全 | host 改成对外地址前必须先加鉴权（README 里写死了这条） |
| 多用户/多机同步 | 这就是一台机器上的几个文件 | 换机器要重新接一遍 |
| 历史趋势（提交次数/作者） | 只取最近 200 个提交算「上次改动」，够回答「多久没动」 | 古老文件的改动时间可能是「读不到」——不写成「没改过」 |

---

## 7. 验证记录

### 7.1 接一个真仓 → 克隆 → 索引（面板里点的）

```
POST /api/repo-truth/repos {"url":"https://github.com/PanJiaChen/vue-admin-template.git"}
  → 4.5 s：clone --mirror（本机镜像）→ ls-tree 98 个文件 → 解析 68 个内容块
  → repos.json 里：head 4c18a3f4 / counts.total 98 / indexed 68 / pages 13
第二个仓：https://github.com/grpc/grpc-go.git
  → 1424 个文件 / 索引 701 / 跳过生成 49 / 测试 453 / 第三方 162 / 认不得 59
```

### 7.2 同一个 HEAD 再跑一次 → 0 个内容块

```
POST /api/repo-truth/repos/sync {"name":"vue-admin-template"}
GET  /api/repo-truth/jobs?repo=vue-admin-template
  → done | parsedBlobs=0 | reusedBlobs=68 | 401 ms | 完成：解析 0 个新内容块，复用 68 个
```

### 7.3 问一句（正文与限界框原文见 `docs/verify/ask-found.png`）

问题：「用户登录页面是怎么做的？」

```
你问的是「用户登录页面是怎么做的？」。在已接入的 2 个仓里，有 7 处候选的名字与它相关；这是按名字比对出来的线索，不是对实现的理解。
其中有 1 处是用户能到达的页面或视图：login。剩下 6 处是支撑这些界面的模块与配置。
这片区域合计 7 个文件、约 22 KB。其中 2 个被别的模块引用过，引用最多的一处被 1 个文件引用——改动它时要连带看这些地方。
这片区域最近一次改动是 2026-09-25（距今 45 天）。代码快照：vue-admin-template @ 2021-11-19；grpc-go @ 2026-11-04。
名字相似不等于就是它：上面的每一条都需要研发确认，材料里没有一个字来自对实现逻辑的阅读。
```

### 7.4 问一句（应当查不到）→ 「没找到」

问题：「优惠券核销与发票开具」

```
没能在已索引的代码里找到与「优惠券核销与发票开具」相关的地方。
这是「查过、没命中」，不是「不存在」：这一轮查了 2 个仓、769 个文件，用的检索词是 优惠、惠券、券核、核销、发票、票开、开具、coupon。
```

### 7.5 覆盖率（面板里读出来的）

```
接进来 2 个 · 看得见 2 个 · 看不见 0 个
仓名                HEAD      文件总数  已索引  跳过生成  页面数  状态
vue-admin-template  4c18a3f4      98      68       0      13   已索引
grpc-go             cbf30c41    1424     701      49       0   已索引
vue-admin-template · 其中：测试 8 · 第三方 1 · 素材 14 · 认不得的扩展名 7 · 超大文件 0
grpc-go ·            其中：测试 453 · 第三方 162 · 素材 0 · 认不得的扩展名 59 · 超大文件 0
```

### 7.6 测试与变异验证

```
npm test → 46 个用例全绿
node scripts/mutation-check.mjs → 拦得住 15/15
```

| 编号 | 规则 | 改坏哪里 | 结果 |
|---|---|---|---|
| M1 | 第二遍解析 0 个内容块 | `indexer.js` 去掉复用分支 | 变红 ✓ |
| M2 | 自动生成代码要识别 | 关掉 `GENERATED_RE` | 变红 ✓ |
| M3 | 测试文件要跳过 | 关掉 `isTestPath` | 变红 ✓ |
| M4 | 第三方目录要跳过 | `skipDirOf` 恒 null | 变红 ✓ |
| M5 | 页面口径只有一份实现 | 关掉 `views` 约定 | 变红 ✓ |
| M6 | git 失败翻成中文 | 直接抛原始 stderr | 变红 ✓ |
| M7 | 硬超时到点必杀 | 超时回调里提前 return | 变红 ✓ |
| M8 | 宿主不等克隆 | 让 startJob 等子进程退出 | 变红 ✓ |
| M9 | 没命中就说没找到 | 把双门槛降成单门槛 | 变红 ✓ |
| M10 | 跳过的文件不能泄漏进检索 | 去掉素材跳过 | 变红 ✓ |
| M11 | 没索引 ≠ 没找到 | `state:'no-index'` 改成 `'ok'` | 变红 ✓ |
| M12 | 正文只能是产品语言 | 往正文塞一个路径 | 变红 ✓ |
| M13 | 令牌只以掩码出现 | `maskToken` 返回明文 | 变红 ✓ |
| M14 | 配置文件 600 | chmod 改 644 | 变红 ✓ |
| M15 | 署名地址必须是真地址 | package.json 换成占位符 | 变红 ✓ |

第一次跑只拦住 13/15：M9（检索阈值）和 M15（署名地址）当时**没有测试拦得住**。
补了两条测试（弱命中不出结果；钉死真地址）之后才 15/15。这就是为什么这个脚本必须存在。

### 7.7 命名（终版）

| 位置 | 现在的值 |
|---|---|
| `package.json.name` | `dsh-plugin-repotruth` |
| `package.json.repository.url` | `git+https://github.com/SilasSolivagus/dsh-repotruth.git` |
| `package.json.homepage` / `bugs.url` | `https://github.com/SilasSolivagus/dsh-repotruth` / `…/issues` |
| `package.json.bin` | `{ "dsh-plugin-repotruth": "./bin/dsh-plugin-repotruth.js" }` |
| 页脚 | `由 repotruth 生成 · https://github.com/SilasSolivagus/dsh-repotruth · v0.3.0` |
| `<head>` meta | `<meta name="generator" content="repotruth v0.3.0">` |
| 宿主导出名 / 客户端模块 id / bundle patch 行 | 三处都是 `dsh-plugin-repotruth`（有测试钉住） |

刻意**没改**的三处（它们不是品牌，改了会断契约）：
HTTP 路由前缀 `/api/repo-truth`、数据目录名 `repo-truth`、bundle 行 id `repo-truth`、设置分区 id `repo-truth-*`。
bundle 行 id 保持原样是刻意的：改了它，已有 profile 会多出一条新行（等于重复加载），换名字的收益为零。

`desktop` profile 的软链已从旧名改成 `dsh-plugin-repotruth → /Users/silas/repo-truth-plugin`，
`package.json` 的依赖键与 bundles 也同步改成新名；改完 `curl /api/repo-truth/health` 仍 200，
`plugin` 字段变成 `dsh-plugin-repotruth`，模块图里新 id 出现在启动批次里。

---

## 8. 还没做、但下一步该做的

1. **问一句的召回**：现在只认「名字里有的词」。同义词表是手写的 50 条，覆盖不到业务黑话。
   下一步该做的是「用户点一次『不是这个』就记一笔」，而不是再堆词表。
2. **索引体积**：`blobs` 里存了 symbols/outline，大仓的 JSON 会到几十 MB。按需拆成「元数据 + 分片」可以省内存。
3. **跨仓复用**：同一份内容在多个仓重复解析，是当前唯一明显浪费。
4. **变更增量**：现在按「文件内容」增量，但每次仍然 `ls-tree` 全树。仓到了十万文件级，这一步也要增量化。
5. **历史窗口**：`changes` 只覆盖最近 200 个提交，更老的文件会显示「改动时间读不到」。
