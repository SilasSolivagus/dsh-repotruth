# 本地插件是怎么被加载的（实测报告）

这份文档没有引用任何公开规范——这个环境里没有插件开发文档。下面每条结论都对应一次真实操作和它的观察结果，
跑通的东西照抄即可，没跑通的也写清了卡在哪。

测试环境：DeepSeek Harness 桌面版 `0.2.1-rc.3`，profile = `desktop`，配置目录 `~/.dsh/profiles/desktop`，
宿主监听 `http://127.0.0.1:60425`，进程 `dsh-desktop-host`（Electron 管理）。

---

## 0. 一句话结论

**插件 = 一个 npm 包**：`main` 是宿主半边（Node 里跑），`exports["./client"]` 是浏览器半边（页面里跑），
`package.json` 的 `dsh.bundle.patch` 声明“我往插件树里插哪一行”，`dsh.client` 声明“我有浏览器半边”。
**装载动作 = 把包变成 profile 的依赖 + 写进 `dsh.profile.bundles`**；`desktop` 这个 profile 不允许 CLI 装，
所以要手改 profile 的两个文件。改完**不用重启**：`dsh-hmr` 会热重组，`dsh-client-hmr` 会把新的浏览器 bundle 换进已打开的页面。

---

## 1. 插件必须放在哪

**包可以放在任意绝对路径**（不要求放在 app 目录、不要求放进 `node_modules`）。
真正的要求是 profile 找得到它：profile 目录下的 `node_modules/<包名>` 必须能解析到它。

本次落地（已验证）：

```bash
# 1) 包本体：任意路径
/Users/silas/repo-truth-plugin

# 2) profile 声明依赖（等价于 pnpm 的 link: 依赖）
#    文件：~/.dsh/profiles/desktop/package.json
#    "dependencies": { "dsh-plugin-repotruth": "link:/Users/silas/repo-truth-plugin" }

# 3) 让解析真的通：profile 自己的 node_modules 里放软链
ln -sfn /Users/silas/repo-truth-plugin ~/.dsh/profiles/desktop/node_modules/dsh-plugin-repotruth

# 4) 选进 bundle 列表（顺序即配置优先级）
#    文件同上，"dsh": { "profile": { "bundles": [ ..., "dsh-plugin-repotruth" ] } }
```

第 3 步不能省。profile 的 `package.json` 只是声明，Node 解析走的是 profile 目录下的 `node_modules`；
`dsh-kanban` 在这台机器上也是这么装的（`dsh-kanban -> ../../../../Downloads/黑客/dsh-kanban`）。

> 注意：**不要**把包装进 `/Applications/DeepSeek Harness.app/.../node_modules`。
> 那是应用自带依赖，升级即丢，而且会把“第三方插件”和“内置插件”混成一类。

---

## 2. 有没有 dev 模式 / HMR

有，而且是我们这次唯一的装载手段。

### 2.1 配置层（profile 改了要不要重启）

`@deepseek-ai/dsh-hmr`（base bundle 里的 `hmr` 行）在**启动器提供了 profileContext 时默认启用**，配置是 `root: []`。
`root: []` 的意思是“不监听源码模块，但**监听 profile 配置**”。

桌面版启动命令里带着 profile 路径，所以它属于“提供了 profileContext”的情况：

```
/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness
  --expose-internals .../dsh-desktop-host/lib/index.js
  .../app/dsh  /Users/silas/.dsh/profiles/desktop  ...      ← 第 3 个参数就是 profile
```

实测：改完 profile 的 `package.json` + 建软链，**6 秒内**宿主就开始应答新插件的路由，没有重启、没有断开会话。

### 2.2 客户端层（bundle 改了要不要刷新页面）

`@deepseek-ai/dsh-client-hmr` 每 `pollIntervalMs`（默认 500ms）对每个客户端 bundle 做一次 `statSync`，
mtime/size 变了就通过 SSE（`/plugins/events`）通知页面，页面重放该插件并重挂组件。

实测：改完 `lib/client.js` 保存，**没有刷新页面**，设置页里那一行文案当场变了。
（bundle 的 `rev` 从 `07e9413dd14e` 变成 `d3ec92a3675a`，可用 `/plugins/events` 直接看到。）

### 2.3 `pnpm run dev:web` 是什么

那是**源码检出**（checkout）里的循环：tsdown 监听 `src/`，重建出 `lib/client.js`，再由 2.2 的机制换进页面
（`--no-serve` 表示只起 watcher，挂到别处的宿主上）。
我们这个插件**手写 `lib/client.js`**，没有构建步骤，所以不需要它——`lib/client.js` 一改就等于“重建完成”。
这也是零依赖能做到的原因：浏览器半边只调用 `window.__ModuleLoader__.load({ id, factory })`。

---

## 3. manifest 必须声明什么

最小可用 `package.json`（本次实际使用）：

```json
{
  "name": "dsh-plugin-repotruth",
  "version": "0.1.0",
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"] }
  },
  "engines": { "node": ">=22" },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" }
}
```

字段逐一说明（都来自源码核对 + 实测）：

| 字段 | 作用 | 不写会怎样 |
|---|---|---|
| `main` | 宿主半边入口 | 插件树里的行 import 不到模块，该行 failed |
| `exports["./client"]` | 浏览器半边入口。`dsh-client-modules` 用它定位 bundle 文件 | 声明了 `dsh.client` 却没有 `./client` 会直接抛错：`declares dsh.client but exports no "./client" bundle` |
| `dsh.client.platform` | 必须是 `"web"`，否则这一行不算客户端包 | 浏览器侧静默没有这个插件（不报错，最难查） |
| `dsh.client.inject` | 只是**排序元数据**（谁先谁后）；真正的 `require` 依赖靠 `dsh.client.external` | 一般不致命；但顺序不对时 `require` 拿不到对端 |
| `dsh.client.immediately` | 是否在启动批次里立刻加载 | 默认按需 |
| `dsh.bundle.patch` | 指向本包的 cordis patch 文件，profile 启动时把它当一层叠加 | 包是装了，但插件树里没有这一行 → 什么都没发生 |
| `engines.dsh` / `peerDependencies["@deepseek-ai/dsh*"]` | 版本闸门。`engines.dsh` 单独决定；否则每个 `@deepseek-ai/dsh*` peer 都要满足 | 本次两者都没有声明 dsh 版本约束，所以不做闸门（本机 `0.2.1-rc.3` 能跑） |

`cordis.patch.yml`（本包自带，被 `dsh.bundle.patch` 引用）：

```yaml
- insert:
    - id: repo-truth
      name: dsh-plugin-repotruth
      inject: [webServer]
```

**只写宿主一行**。浏览器半边不需要单独一行：`dsh-client-modules` 是拿“插件树里的每一行”去反查该包
`package.json` 的 `dsh.client`，同一个 id 既指宿主行也指浏览器模块。

语言文件不是必须的。`dsh-client-ui-settings-plugin-inventory` 那种 `locale/zh.json` 是给“插件列表”这类
宿主侧元信息读的；我们这种插件在浏览器里用 `ctx.locale.register(NS, { zh, en })` 注册词典，不落到文件。
（如果想让“插件列表”页显示中文名，才需要 `locale/*.json` + `dsh.client` 同级声明。）

---

## 4. 设置页怎么注册、面板/整页怎么贡献

### 4.1 设置分区（本次采用）

`settings.section` 是一个 list 槽：排序项、导航项都由它派生（`ui-settings-general` 里有
`ctx.slots.entries("settings.section").map(...).sort((a,b)=>a.order-b.order)`）。

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'repo-truth-sources',      // 必填，同槽内唯一
  order: 40,                     // 决定左侧导航顺序
  label: () => t('nav'),         // 导航文案
  locale: NS,                    // 有了它，组件才会收到 t()
}, SourcesPage))
```

- `inject` 回调里注册，不是直接 `register`：槽可能晚于插件出现，`inject` 会等它就绪、并在重建/销毁时自动重放。
- 组件收到的 props：`{ t, renderSlot, ...inject() 的返回值 }`（`inject()` 是可选的，本次没用）。
- 分区内部还能再开子槽（`settings.plugins.tab` 就是 `ui-settings-plugins` 用
  `children: { "settings.plugins.tab": { kind: "list", scope: "root" } }` 开的），本次不需要。

### 4.2 主区域整页（如果要一个真正的“页面”）

参考 `dsh-kanban/lib/client.js`，两个槽配对使用：

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'repo-truth', order: 21, label: () => '系统现状' }, Icon))
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'repo-truth' }, PageComponent))
```

`sidebar.panellist` 出侧栏图标，`main` 出主区域内容，`id`/`key` 对齐才能互相找到。
本次第一刀没有做整页：设置里两个分区已经能读，先不引入侧栏图标的布局复杂度。

### 4.3 宿主侧接口

`ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })`，返回 disposer；
`(kind, path)` 重复注册**直接抛错**。匹配顺序：exact 全表 → 最长 prefix → fallback。

我们只注册一条前缀 `/api/repo-truth`，内部再分派，原因就是上面的判重规则。

**一个必须知道的细节**：`/api` 被 `dsh-client-connection` 用前缀路由做了鉴权闸门（无凭证 → 401 unauthorized）。
`/api/repo-truth` 比 `/api` 长，按“最长前缀优先”命中我们自己的路由，**不经过那道闸门**。
这就是为什么 `curl` 能直接打到插件接口、而 `/` 和 `/api/xxx`（不存在的子路径）都回 401。
副作用是：**插件路由的权限要自己负责**。这版只在 loopback 上监听（webserver 的 `host` 是 `127.0.0.1`），
并且插件接口只碰本机配置，不做跨用户能力；如果将来有人把 `host` 改成对外地址，这条路由就会跟着暴露。

---

## 5. 做过的操作与观察（按时间顺序）

### 5.1 装之前：确认路由不存在

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:60425/api/repo-truth/health
# 401        ← 不是 404：说明没有插件路由，请求落进了 /api 的鉴权闸门
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:60425/
# 401        ← 同一道闸门：索引页要 launch token 换来的 cookie
```

### 5.2 官方 CLI 能不能装

```bash
node .../dsh/lib/bin.js --help
# dsh plugin --profile <name> <pnpm-args...>
# 示例：dsh plugin --profile tui add <package>

node .../dsh/lib/bin.js --profile desktop --dump-config
# error: profile "desktop" is managed exclusively by the Electron application
```

结论：`desktop` 这个 profile 被 Electron 独占，CLI 拒绝；CLI 的 `plugin` 子命令只是把参数转给 profile 目录里的 pnpm
（会走 corepack 下载 pnpm），对**非 Electron 管理的 profile**（`web`/`headless`/自建 profile）是正路。

### 5.3 手装（desktop profile）

```bash
cd ~/.dsh/profiles/desktop
cp package.json      package.json.bak-repo-truth-20261109-144334
cp cordis.patch.yml  cordis.patch.yml.bak-repo-truth-20261109-144334

node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.dependencies['dsh-plugin-repotruth']='link:/Users/silas/repo-truth-plugin';
p.dsh.profile.bundles.push('dsh-plugin-repotruth');
fs.writeFileSync('package.json',JSON.stringify(p,null,2))"

ln -sfn /Users/silas/repo-truth-plugin node_modules/dsh-plugin-repotruth
```

6 秒后：

```bash
curl -s http://127.0.0.1:60425/api/repo-truth/health
# {"ok":true,"plugin":"dsh-plugin-repotruth",
#  "dataDir":"/Users/silas/Library/Application Support/repo-truth", ...}
```

**没有重启应用、没有断会话**。宿主半边就这么挂上了。

### 5.4 浏览器半边进没进模块图

```bash
timeout 4 curl -s -N http://127.0.0.1:60425/plugins/events > /tmp/graph.jsonl
python3 -c "
import json;raw=open('/tmp/graph.jsonl').read()
line=[l for l in raw.splitlines() if l.startswith('data: ')][0][6:]
g=json.loads(line)['graph']
print([(e['id'],e['rev']) for e in g['entries'] if 'repo-truth' in e['id']])
print([[e for e in b['entries'] if 'repo-truth' in e] for b in g['batches']])"
# [('dsh-plugin-repotruth', '07e9413dd14e')]
# [[], [], ['dsh-plugin-repotruth']]        ← 在“应用批次”里，随启动加载
```

改一行 `lib/client.js` 再看，`rev` 变成 `d3ec92a3675a`，并且**已经打开的页面文字跟着变了**（不刷新）。

### 5.5 GUI 里看到了什么

在同一个 profile 机制起的第二个宿主上（见 §6），设置面板左侧导航变成：

```
通用设置 / 模型 / 内置插件 / Agent 预设 / 代码源 / 覆盖率
```

`代码源`：标题、说明、“添加代码源”按钮、空状态文案“还没有代码源。先添加一个 Git 服务器地址，插件才能开始读仓库。”、
底部“边界：这一版只做登记与只读展示，不克隆仓库、不生成材料。”与配置文件绝对路径。
`覆盖率`：空状态明确写“没找到覆盖率文件：/Users/silas/Library/Application Support/repo-truth/coverage.json”。

写进一条代码源后：行首是名称，后面跟 `GitLab` 类型、基础地址、掩码令牌 `glpat-…1234`，
按钮 `测试连接 / 编辑 / 删除`；点删除会先变成 `确认删除 / 取消`（不弹原生 confirm）。

### 5.6 失败与边界（都实际踩过）

| 现象 | 原因 | 处理 |
|---|---|---|
| 一切请求都 401 | `/`、`/api/*` 在 `dsh-client-connection` 的鉴权闸门后面 | 用宿主启动日志里打印的 `?token=...` URL 打开；或者只打自己的 `/<prefix>` 路由 |
| 新浏览器打开 `127.0.0.1:60425/?token=...` 仍 401 | token 是**进程内**随机值，只打印一次；旧 URL 的 token 与当前进程不匹配 | 用当前进程日志里的 URL；本次为了看 GUI，另起了一个宿主拿它自己的 token |
| 想 `--dump-config` 看 desktop profile | Electron 独占 | 只能看 `~/.dsh/profiles/desktop/cordis.patch.yml` 与 `package.json` 原文 |
| `dsh plugin ... list` 卡住 | 它在 profile 目录里拉 pnpm（corepack 下载） | 桌面 profile 用不上；其它 profile 首次要有网络 |

---

## 6. 这个插件怎么手动装/拆（可逆步骤）

完整步骤见仓库根目录 `README.md` 的「怎么装」。这里只给**卸载**，因为卸载必须一条不漏：

```bash
cd ~/.dsh/profiles/desktop
cp package.json.bak-repo-truth-20261109-144334      package.json
cp cordis.patch.yml.bak-repo-truth-20261109-144334  cordis.patch.yml
rm node_modules/dsh-plugin-repotruth
```

`cordis.patch.yml` 这次**没动**（我们走的是 bundle patch，不是手写行）；备份留着是为了万一。
配置数据另外躺在 `~/Library/Application Support/repo-truth/`，删不删由你决定（`config.json` 里有令牌，`600`）。

想看 GUI 又不想动桌面 app，用自建 profile 起第二个宿主（本次就是这么看界面的）：

```bash
P=~/.dsh/profiles/repo-truth-gui
mkdir -p "$P/node_modules"
cp ~/.dsh/profiles/web/{cordis.yml,cordis.patch.yml,pnpm-workspace.yaml} "$P/"
cat > "$P/package.json" <<'JSON'
{ "name": "dsh-profile-repo-truth-gui", "private": true,
  "dependencies": { "dsh-plugin-repotruth": "link:/Users/silas/repo-truth-plugin" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-repotruth" ] } } }
JSON
ln -sfn /Users/silas/repo-truth-plugin "$P/node_modules/dsh-plugin-repotruth"

node "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile repo-truth-gui --no-open --port 60555
# stdout: dsh web: http://127.0.0.1:60555/?token=...
```

---

## 7. 还没验证的（别当成已知）

- **`desktop` profile 里浏览器半边的实际渲染**：模块图里有它（§5.4），宿主路由通（§5.3），
  但桌面窗口的 DOM 我抓不到（token 是进程内的，第二个浏览器进不去）。页面渲染是在 §6 的第二个宿主上看到的，
  两者共用同一套 profile → 加载 → 图 → 渲染 机制。
- **`dsh client` 侧的 `external` 依赖边**：本次没有跨包 `require`，所以没走到。
- **`settings.general.item` / `settings.plugins.tab` 这类子槽**：读源码确认了形状，没有实践。
- **pnpm 安装路径（`dsh plugin add`）在本机**：只跑到 CLI 开始拉 pnpm 就停了，没让它在 `desktop` 上真的写一遍。
