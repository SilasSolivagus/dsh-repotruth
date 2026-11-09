// 「问一句」的检索层：只用本地索引回答，不联网、不猜。
//
// 这一层最重要的性质不是「查得准」，而是**查不到就明说查不到**。
// 所以它只有两种结局：命中（带候选与限定）或「没找到」（带查过的范围与检索词）。
// 没有第三种「大概吧」。名字相似 ≠ 就是它，这句话会印在每次命中的材料里。
import { readFile } from 'node:fs/promises'
import { indexPath } from './paths.js'
import { componentNameOf } from './scan.js'

/**
 * 中文需求词 → 代码里常见的英文命名。
 *
 * 为什么需要它：需求写「登录」，代码写 `login`；没有这张表，中文提问在英文命名的仓里
 * 永远命不中。它的作用只是**扩大候选**，绝不产生结果——表里的词在代码里不存在时，
 * 依然什么都匹配不到。这张表是固定的、可审查的，不是模型猜的。
 */
export const ZH_TERMS = {
  登录: ['login', 'signin', 'auth'],
  登出: ['logout', 'signout'],
  注册: ['register', 'signup'],
  用户: ['user', 'account', 'member'],
  账号: ['account', 'user'],
  个人: ['profile', 'account'],
  资料: ['profile'],
  设置: ['setting', 'settings', 'config'],
  配置: ['config', 'setting'],
  订单: ['order'],
  金额: ['money', 'amount', 'price'],
  时间: ['time', 'date'],
  日期: ['date', 'time'],
  状态: ['status'],
  错误: ['error'],
  支付: ['pay', 'payment', 'checkout', 'billing'],
  结算: ['checkout', 'billing'],
  发票: ['invoice'],
  购物车: ['cart'],
  商品: ['product', 'item', 'sku'],
  价格: ['price', 'pricing'],
  优惠: ['coupon', 'discount', 'promotion'],
  退款: ['refund'],
  搜索: ['search'],
  筛选: ['filter'],
  列表: ['list'],
  详情: ['detail'],
  首页: ['home', 'dashboard'],
  仪表盘: ['dashboard'],
  报表: ['report', 'analytics'],
  统计: ['stat', 'metric', 'analytics'],
  图表: ['chart'],
  消息: ['message', 'notification'],
  通知: ['notification', 'notice'],
  评论: ['comment'],
  权限: ['permission', 'role', 'acl'],
  角色: ['role'],
  后台: ['admin', 'console'],
  上传: ['upload'],
  下载: ['download'],
  导出: ['export'],
  审核: ['audit', 'review', 'approve'],
  分类: ['category', 'category', 'tag'],
  标签: ['tag', 'label'],
  日志: ['log', 'audit'],
  任务: ['task', 'job'],
  流程: ['flow', 'process', 'workflow'],
  文件: ['file', 'document'],
  图片: ['image', 'photo', 'picture'],
  表单: ['form'],
  表格: ['table', 'grid'],
  分页: ['page', 'pagination'],
  导航: ['nav', 'menu', 'router'],
  菜单: ['menu', 'nav'],
  帮助: ['help', 'faq'],
  反馈: ['feedback'],
  首页统计: ['dashboard'],
}

/** 提问里的虚词：留着只会把任何文件都算成候选。 */
const ZH_STOP_PHRASES = [
  '怎么样', '怎么做', '在哪里', '在哪', '这一个', '这个', '那个', '哪些', '哪里', '什么',
  '如何', '怎么', '现在', '实现', '是不是', '有没有', '请问', '帮我', '我们', '我想',
  '想看', '相关', '有关', '一下', '功能', '页面', '系统', '代码', '仓库', '目前', '一下',
  '的', '了', '吗', '呢', '是', '和', '与', '在', '有', '个', '里',
]

const CJK_RE = /[\u4e00-\u9fa5]+/g

/** 把提问切成「英文词 + 中文二元组」。中文不做分词（没有词典就别假装会分词）。 */
export function tokenizeQuestion(question) {
  const text = String(question ?? '')
  const en = []
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}/g)) {
    const word = match[0].toLowerCase()
    if (!en.includes(word)) en.push(word)
  }

  let cjk = text
  for (const phrase of ZH_STOP_PHRASES) cjk = cjk.split(phrase).join(' ')
  const zh = []
  const expanded = []
  for (const run of cjk.match(CJK_RE) ?? []) {
    if (run.length === 1) {
      if (!zh.includes(run)) zh.push(run)
      for (const word of ZH_TERMS[run] ?? []) if (!en.includes(word)) en.push(word)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!zh.includes(bigram)) zh.push(bigram)
    }
    // 整段也查一次词典：`购物车` 这种三字词按二元组切完就丢了原意。
    for (const [term, words] of Object.entries(ZH_TERMS)) {
      if (!run.includes(term)) continue
      if (!expanded.includes(term)) expanded.push(term)
      for (const word of words) if (!en.includes(word)) en.push(word)
    }
  }
  return { zh, en: en.filter((word) => word.length >= 2), terms: expanded }
}

/** 路径 → 词表：`src/views/userProfile/index.vue` → [src, views, user, profile, index, vue]。 */
export function pathWords(path) {
  const pieces = []
  for (const segment of String(path ?? '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (segment === '') continue
    pieces.push(segment)
    // 驼峰在 toLowerCase 之后已经黏在一起，补一次大小写切分。
  }
  for (const match of String(path ?? '').matchAll(/[A-Z][a-z0-9]+/g)) {
    pieces.push(match[0].toLowerCase())
  }
  return pieces
}

/** 页面/文件 → 人能读的名字（正文里只能出现这种形式，路径进研发参考）。 */
export function humanizePage(pageId) {
  const text = String(pageId ?? '').replace(/^\/+/, '')
  if (text === '') return '首页'
  const segments = text
    .split('/')
    .filter((part) => part !== '' && part !== 'index' && part !== 'src' && part !== 'views' && part !== 'pages')
  const last = segments[segments.length - 1] ?? text
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .trim()
}

/** 读一份索引。坏索引不参与检索，但要留下「这个仓没查成」的证据。 */
async function loadIndex(repo) {
  try {
    const parsed = JSON.parse(await readFile(indexPath(repo.name), 'utf8'))
    return {
      repo,
      index: parsed,
      files: parsed?.files ?? {},
      blobs: parsed?.blobs ?? {},
      counts: parsed?.counts ?? {},
      changes: parsed?.changes ?? {},
      sizes: parsed?.sizes ?? {},
      pages: parsed?.pages ?? { items: [] },
    }
  } catch (error) {
    return { repo, error: error.code === 'ENOENT' ? '没有索引文件' : `索引读不了：${error.message}` }
  }
}

/** 一次命中记一行，字段全部来自索引，不带任何推断。 */
function buildRow(repoName, path, sha, blob, index, extra) {
  const importedBy = new Set()
  for (const [otherPath, otherSha] of Object.entries(index.files)) {
    if (otherPath === path) continue
    const other = index.blobs[otherSha]
    if (!other || !Array.isArray(other.imports)) continue
    if (other.imports.includes(path)) importedBy.add(otherPath)
  }
  return {
    repo: repoName,
    path,
    sha,
    lang: blob?.lang ?? null,
    symbols: Array.isArray(blob?.symbols) ? blob.symbols : [],
    outline: Array.isArray(blob?.outline) ? blob.outline : [],
    page: Array.isArray(blob?.pages) && blob.pages.length > 0 ? blob.pages[0].page : null,
    component: componentNameOf(path),
    bytes: Number.isFinite(extra?.size) ? extra.size : 0,
    lastChange: extra?.change ?? null,
    importedBy: importedBy.size,
    score: extra?.score ?? 0,
    matched: extra?.matched ?? [],
  }
}

/**
 * 检索入口。
 * options: { question, repos（登记表里的行）, onlyRepo, limit }
 * 返回结构里 found=false 与「有命中」是互斥的，中间没有模糊态。
 */
export async function askQuestion(options) {
  const question = String(options.question ?? '').trim()
  if (question === '') return { ok: false, error: '问题不能为空' }

  const rows = Array.isArray(options.repos) ? options.repos : []
  const targets = rows.filter((row) => (options.onlyRepo === undefined || options.onlyRepo === null || options.onlyRepo === '' ? true : row.name === options.onlyRepo))
  const loaded = []
  const missing = []
  for (const row of targets) {
    const result = await loadIndex(row)
    if (result.error) missing.push({ repo: row.name, error: result.error })
    else loaded.push(result)
  }

  const tokens = tokenizeQuestion(question)
  const searchedTerms = [...tokens.zh, ...tokens.en]

  // 一个仓都没索引成功：这是「我没看」，不是「没有」。
  if (loaded.length === 0) {
    return {
      ok: true,
      found: false,
      state: 'no-index',
      question,
      terms: searchedTerms,
      matches: [],
      repos: [],
      missing,
      stats: { repos: 0, files: 0, bytes: 0, pages: 0 },
      skipped: { generated: 0, test: 0, dir: 0, asset: 0, unsupported: 0, large: 0 },
    }
  }

  const matches = []
  let files = 0
  let bytes = 0
  let pages = 0
  const skipped = { generated: 0, test: 0, dir: 0, asset: 0, unsupported: 0, large: 0 }

  for (const entry of loaded) {
    files += Object.keys(entry.files).length
    pages += Array.isArray(entry.pages?.items) ? entry.pages.items.length : 0
    for (const key of Object.keys(skipped)) skipped[key] += Number.isFinite(entry.counts[key]) ? entry.counts[key] : 0

    for (const [path, sha] of Object.entries(entry.files)) {
      const blob = entry.blobs[sha]
      if (!blob) continue
      const size = Number.isFinite(entry.sizes[path]) ? entry.sizes[path] : 0
      bytes += size
      const words = pathWords(path)
      const lowerPath = path.toLowerCase()
      const symbolText = (blob.symbols ?? []).map((symbol) => String(symbol).toLowerCase())
      const outlineText = (blob.outline ?? []).map((line) => String(line).toLowerCase())
      const pageText = (blob.pages ?? []).map((row) => String(row.page ?? '').toLowerCase()).join(' ')

      let score = 0
      let strong = 0
      const matched = []
      for (const token of tokens.en) {
        let hit = 0
        if (words.includes(token)) hit = Math.max(hit, 4)
        else if (lowerPath.includes(token)) hit = Math.max(hit, 2)
        if (symbolText.some((symbol) => symbol === token)) hit = Math.max(hit, 4)
        if (pageText.includes(token)) hit = Math.max(hit, 4)
        if (hit === 0 && outlineText.some((line) => line.includes(token))) hit = 1
        if (hit > 0) {
          matched.push(token)
          score += hit
          if (hit >= 2) strong += hit
        }
      }
      for (const bigram of tokens.zh) {
        if (lowerPath.includes(bigram) || pageText.includes(bigram)) {
          matched.push(bigram)
          score += 3
          strong += 3
        } else if (outlineText.some((line) => line.includes(bigram))) {
          matched.push(bigram)
          score += 1
        }
      }
      // 两个门槛：总分够 + 至少一处「名字层面的强命中」。
      // 只看总分的话，一堆弱命中的通用词会把无关文件顶上来，那就是在编。
      if (score < 4 || strong < 2) continue
      matches.push(
        buildRow(entry.repo.name, path, sha, blob, entry, {
          size,
          change: entry.changes[path] ?? null,
          score,
          matched: [...new Set(matched)],
        }),
      )
    }
  }

  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const limit = options.limit ?? 20
  const top = matches.slice(0, limit)

  const importedRows = top.filter((row) => row.importedBy > 0)
  const maxImported = top.reduce((best, row) => (row.importedBy > (best?.importedBy ?? 0) ? row : best), null)
  const pageRows = top.filter((row) => row.page !== null)
  const lastChange = top
    .map((row) => row.lastChange)
    .filter((value) => typeof value === 'string')
    .sort()
    .pop() ?? null

  return {
    ok: true,
    state: 'ok',
    found: top.length > 0,
    question,
    terms: searchedTerms,
    matches: top,
    repos: loaded.map((entry) => ({
      name: entry.repo.name,
      head: entry.repo.head,
      headDate: entry.repo.headDate,
      indexedAt: entry.repo.indexedAt,
      pages: Array.isArray(entry.pages?.items) ? entry.pages.items.length : 0,
    })),
    missing,
    stats: {
      repos: loaded.length,
      files,
      bytes,
      pages,
      matchedFiles: top.length,
      matchedPages: pageRows.length,
      importedFiles: importedRows.length,
      maxImportedBy: maxImported?.importedBy ?? 0,
      maxImportedPath: maxImported?.path ?? null,
      pageNames: [...new Set(pageRows.map((row) => humanizePage(row.page)))].slice(0, 8),
      lastChange,
    },
    skipped,
    termsUsed: searchedTerms,
  }
}
