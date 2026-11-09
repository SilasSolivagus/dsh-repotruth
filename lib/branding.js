// 署名（attribution）的唯一出处。
//
// 为什么单独一个模块：
// 1. 版本号只能有一个来源。以前这类项目最常见的坏味道是「README 写 0.1.0、HTML 里写 0.2.0」，
//    所以这里从 package.json 现读，模块里不出现任何版本字面量（测试会扫这一点）。
// 2. 页脚和 meta 是一对孪生件：页脚可以被企业关掉（有人就是不能带外部品牌），
//    meta 不能（它是元数据，不是品牌）。两者都从这里出，才不会一处关了另一处忘关。
// 3. 仓库地址同理：营销动作靠它把看到材料的人带回项目，所以必须默认打开，
//    而且必须是真实可点的地址，不能写成一句口号。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgPath = join(here, '..', 'package.json')

/**
 * 没有配 repository 时的兜底地址。
 * 只在 package.json 缺字段时用；正常路径是读 package.json（见 repoUrl()）。
 */
export const FALLBACK_REPO_URL = 'https://github.com/SilasSolivagus/dsh-repotruth'

/** 产品名。页脚、meta、标题共用同一个字符串，避免出现 repo-truth / repoTruth 两种写法。 */
export const PRODUCT = 'repotruth'

let cachedPackage = null

/** 读 package.json（读一次就缓存：一次生成里会调用十几次，没必要反复打盘）。 */
export function packageInfo() {
  if (cachedPackage !== null) return cachedPackage
  let raw
  try {
    raw = readFileSync(pkgPath, 'utf8')
  } catch {
    // 包被以奇怪方式内联时读不到 package.json；此时宁可让版本号缺失，也不编一个版本出来。
    cachedPackage = { name: PRODUCT, version: null }
    return cachedPackage
  }
  const parsed = JSON.parse(raw)
  cachedPackage = {
    name: typeof parsed?.name === 'string' ? parsed.name : PRODUCT,
    version: typeof parsed?.version === 'string' ? parsed.version : null,
  }
  return cachedPackage
}

/** 版本号，唯一的读取口。 */
export function version() {
  return packageInfo().version
}

/**
 * 把各种写法归一成可点的 https 地址。
 * 为什么必须归一：页脚里的地址会被人复制到浏览器里，`git+https://x.git` 打不开，
 * 那就等于没有署名。三种来源（传参、环境变量、package.json）都走同一个函数。
 */
export function normalizeRepoUrl(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/')
    .replace(/\.git$/, '')
}

/**
 * 项目地址的优先级：显式传参 > 环境变量 > package.json 的 repository > 兜底常量。
 * 为什么留环境变量：有人 fork 之后想让页脚指向自己的仓，改一个变量比改代码省事。
 */
export function repoUrl(override) {
  if (typeof override === 'string' && normalizeRepoUrl(override) !== '') return normalizeRepoUrl(override)
  const fromEnv = process.env.REPO_TRUTH_REPO_URL
  if (typeof fromEnv === 'string' && normalizeRepoUrl(fromEnv) !== '') return normalizeRepoUrl(fromEnv)
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const repo = parsed?.repository
    const rawUrl = typeof repo === 'string' ? repo : typeof repo?.url === 'string' ? repo.url : ''
    if (normalizeRepoUrl(rawUrl) !== '') return normalizeRepoUrl(rawUrl)
  } catch {
    // 读不到就走兜底。
  }
  return FALLBACK_REPO_URL
}

/**
 * 归属开关：默认开。
 * 判定写成「只有显式 false 才关」，这样缺字段、null、写错类型都落回默认开——
 * 营销默认值必须偏向「有署名」，而不是偏向「解析失败就静默丢掉署名」。
 */
export function isAttributionEnabled(config) {
  return config?.attribution !== false
}

/**
 * `<head>` 里的机读标签。永远存在：即使页脚被关掉，HTML 仍然要能自证是用什么生成的。
 * 为什么带版本：出问题时有版本可对，比"某天生成的"强得多。
 */
export function metaTag(v) {
  const tagVersion = v ?? version()
  const content = tagVersion === null ? `${PRODUCT} (version unknown)` : `${PRODUCT} v${tagVersion}`
  return `<meta name="generator" content="${escapeAttr(content)}">`
}

/**
 * 页脚文案。中文，因为读者是公司群里的产品同学。
 * 形如：由 repotruth 生成 · https://github.com/… · v0.2.0
 */
export function footerLine(options = {}) {
  const v = options.version ?? version()
  const url = repoUrl(options.repoUrl)
  const versionPart = v === null ? '' : ` · v${v}`
  return `由 ${PRODUCT} 生成 · ${url}${versionPart}`
}

/**
 * 一次拿到整套署名件。
 * 调用方只需要看 footer 是否为 null，不需要自己判断 attribution 语义。
 */
export function brandingParts(config, options = {}) {
  const v = options.version ?? version()
  const enabled = isAttributionEnabled(config)
  return {
    version: v,
    repoUrl: repoUrl(options.repoUrl),
    meta: metaTag(v),
    footer: enabled ? footerLine({ version: v, repoUrl: options.repoUrl }) : null,
    attribution: enabled,
  }
}

/** 属性值转义：URL 里有 & 时会让 HTML 解析跑偏。 */
function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
