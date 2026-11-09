// 需求走查材料：三栏可交互页（左：流程节点 / 中：页面结构或时序骨架 / 右：标注与待确认）。
//
// 这份材料回答的是「这件事现在是怎么实现的」，和「系统现状」（回答「这个仓里有什么」）是
// 两份不同的东西。分界很清楚：
//   现状页 = 全仓的一次体检，跟问题无关；走查页 = 一个问题落回到几条代码路径上。
//
// 内容的来源只有一处：本机索引 + 检索结果。所以这里有三种东西必须分开写：
//   1. 索引能证明的（这一片有几个文件、谁引用了它、哪天改的、页面在哪里）→ 直接写；
//   2. 索引能证明「存在」但证明不了「含义」的（页面长什么样、调用顺序）→ 明写读不到，
//      没有页面的节点给时序骨架，并在图上方写明「不是从代码读出来的」；
//   3. 索引完全不知道的（业务规则、状态机、权限）→ 只进「待研发确认」。
//
// 呈现层是 UEmaster 的三栏壳（lib/vendor/uemaster/flow-walkthrough.html，MIT），
// 我们不重写它：它的 JS 已经处理了点节点 → 切中间页 → 换右侧标注与状态按钮。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ZH_TERMS, humanizePage } from './ask.js'
import { brandingParts, version } from './branding.js'
import { renderFlowSvg } from './flow-svg.js'
import { indexPath } from './paths.js'
import { BASE_CSS, dayOf, esc, kb, productBodyViolations } from './render.js'
import { renderSequenceSvg } from './seq-svg.js'
import { assessMatchStrength, subjectHitsOf, negatedTermsIn } from './match-strength.js'

const here = dirname(fileURLToPath(import.meta.url))
/** 把第三方模板当成运行时资产读（不复制它的说明文字，只用它的壳）。 */
const TEMPLATE_PATH = join(here, 'vendor', 'uemaster', 'flow-walkthrough.html')

let cachedTemplate = null
async function templateHtml() {
  if (cachedTemplate === null) cachedTemplate = await readFile(TEMPLATE_PATH, 'utf8')
  return cachedTemplate
}

/** 词表反查：代码里的英文名 → 需求里常见的中文说法（同一张固定表，不另造一套）。 */
const EN_TO_ZH = (() => {
  const map = new Map()
  for (const [zh, words] of Object.entries(ZH_TERMS)) {
    for (const word of words) if (!map.has(word)) map.set(word, zh)
  }
  return map
})()

/** `login` → `登录（login）`；表里没有就只写代码里的名字，不硬翻。 */
export function displayName(name) {
  const zh = EN_TO_ZH.get(String(name ?? '').toLowerCase())
  return zh === undefined ? String(name ?? '') : `${zh}（${name}）`
}

/**
 * 这个仓的 import 能不能解析成「谁引用了谁」。
 *
 * `@/utils/request`、`~common/x`、包名——这些在索引里都只是一个字符串，落不到具体文件。
 * 于是「被别的模块引用 = 0」在这种仓里**不是事实，是没测量**。两种情况必须分开写。
 */
/**
 * 这个仓的 import 能不能解析成「谁引用了谁」。
 *
 * 两种情况，两种写法：
 *   1. 索引记了 `counts.aliasImports`（新索引）——那是「被丢掉的 import 条数」，
 *      `@/…`、`~…`、包名、指向仓外的相对路径都算。>0 就说明引用图是残缺的。
 *   2. 没记（老索引）——不知道，一律回「没测量」，不能因为「没看到别名」就说解析得了。
 *
 * 返回三态字符串：'resolved'（能解析）/ 'aliased'（有别名，测不全）/ 'unmeasured'（老索引）。
 */
export function importResolutionOf(index) {
  const recorded = index?.counts?.aliasImports
  if (Number.isFinite(recorded)) return recorded > 0 ? 'aliased' : 'resolved'
  // 兜底：老索引里只存着解析成功的 import，看起来都像相对路径，
  // 所以不能凭「看到的都是相对路径」判成 resolved——只能说「没测量」。
  return 'unmeasured'
}

/** 兼容旧调用点：能不能把「被引用」当数字读。 */
export function importsUseAliases(index) {
  return importResolutionOf(index) !== 'resolved'
}

function slugOf(value, fallback) {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return text === '' ? fallback : text
}

/**
 * 归节点：命中的文件按「页面」和「代码区域」两类归并。
 *
 * 为什么按区域而不是按文件：一个节点应当对应评审能讨论的一块东西。一个文件一个节点，
 * 评审会看二十个格子；一个仓一个节点，又什么都没说清。规则固定、可复算：
 *   · 命中里带页面归属的文件 → 一个页面一个节点；
 *   · 其余文件 → 按目录归并（`src/x/**` 取到 `src/x`，其余取第一段）。
 * 归并不出「跳转关系」「调用顺序」——索引没有这两样东西，所以节点之间只用
 * 「同批候选」或「谁引用了谁」连线，两种边在图上长得不一样。
 */
export function planFromAnswer(options) {
  const answer = options?.answer ?? {}
  const index = options?.index ?? {}
  const matches = Array.isArray(answer.matches) ? answer.matches : []
  const blobOf = (path) => {
    const sha = index?.files?.[path]
    return sha === undefined ? null : index?.blobs?.[sha] ?? null
  }
  const importsOf = (path) => {
    const blob = blobOf(path)
    return Array.isArray(blob?.imports) ? blob.imports : []
  }

  const pageBuckets = new Map()
  const areaBuckets = new Map()
  for (const row of matches) {
    if (typeof row.page === 'string' && row.page !== '') {
      if (!pageBuckets.has(row.page)) pageBuckets.set(row.page, [])
      pageBuckets.get(row.page).push(row)
      continue
    }
    const parts = String(row.path ?? '').split('/')
    const area = parts[0] === 'src' && parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0]
    if (!areaBuckets.has(area)) areaBuckets.set(area, [])
    areaBuckets.get(area).push(row)
  }

  const factsOf = (rows, extra = {}) => {
    const bytes = rows.reduce((sum, row) => sum + (Number.isFinite(row.bytes) ? row.bytes : 0), 0)
    const importedRows = rows.filter((row) => row.importedBy > 0)
    const langs = [...new Set(rows.map((row) => row.lang).filter((lang) => typeof lang === 'string'))]
    const lastChange =
      rows
        .map((row) => row.lastChange)
        .filter((value) => typeof value === 'string')
        .sort()
        .pop() ?? null
    return {
      files: rows.length,
      bytes,
      langs,
      importedFiles: importedRows.length,
      maxImportedBy: rows.reduce((best, row) => Math.max(best, row.importedBy ?? 0), 0),
      maxImportedPath: rows.find((row) => (row.importedBy ?? 0) === rows.reduce((best, item) => Math.max(best, item.importedBy ?? 0), 0))?.path ?? null,
      lastChange,
      ...extra,
    }
  }

  /** 页面里能读到的模块：页面内组件标签 + 相对引用；别名引用解析不了，读不到就是读不到。 */
  const modulesOf = (rows) => {
    const found = []
    for (const row of rows) {
      const blob = blobOf(row.path)
      for (const tag of Array.isArray(blob?.outline) ? blob.outline : []) found.push({ name: tag, from: '页面内' })
      for (const target of Array.isArray(blob?.imports) ? blob.imports : []) found.push({ name: target, from: '引用' })
    }
    const seen = new Set()
    return found.filter((item) => {
      if (seen.has(item.name)) return false
      seen.add(item.name)
      return true
    })
  }

  const used = new Set()
  const uniqueId = (base) => {
    let candidate = base
    let round = 2
    while (used.has(candidate)) {
      candidate = `${base}-${round}`
      round += 1
    }
    used.add(candidate)
    return candidate
  }

  const pages = [...pageBuckets.entries()]
    .map(([page, rows]) => ({ page, rows, score: Math.max(...rows.map((row) => row.score ?? 0)) }))
    .sort((a, b) => b.score - a.score || a.page.localeCompare(b.page))
  const areas = [...areaBuckets.entries()]
    .map(([area, rows]) => ({ area, rows, score: Math.max(...rows.map((row) => row.score ?? 0)) }))
    .sort((a, b) => b.score - a.score || a.area.localeCompare(b.area))

  const nodes = []
  for (const item of pages) {
    const name = humanizePage(item.page)
    // 用产品名做 id：页面路径末段常常是 index，拿它当 id 会得到 page-index 这种没信息量的名字。
    const id = uniqueId(`page-${slugOf(name, 'page')}`)
    const facts = factsOf(item.rows, { page: item.page, name })
    nodes.push({
      id,
      kind: 'page',
      title: `页面：${displayName(name)}`,
      short: displayName(name),
      page: item.page,
      area: null,
      rows: item.rows,
      facts,
      modules: modulesOf(item.rows),
      frameId: `pg-${id}`,
      score: item.score,
    })
  }
  for (const item of areas) {
    const id = uniqueId(`area-${slugOf(item.area, 'area')}`)
    const label = item.area.split('/').pop() ?? item.area
    const facts = factsOf(item.rows)
    nodes.push({
      id,
      kind: 'backend',
      title: `没有页面：${label} 这一片`,
      short: `模块区：${label}`,
      page: null,
      area: item.area,
      rows: item.rows,
      facts,
      modules: [],
      frameId: `sq-${id}`,
      score: item.score,
    })
  }

  /** 边：只有「A 的文件引用了 B 的文件」才是代码里的事实，其余一律画虚线并写明是排队顺序。 */
  const edges = []
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const from = nodes[i]
    const to = nodes[i + 1]
    const fromPaths = new Set(from.rows.map((row) => row.path))
    const toPaths = new Set(to.rows.map((row) => row.path))
    let proven = false
    let direction = 'forward'
    for (const row of from.rows) {
      if (importsOf(row.path).some((target) => toPaths.has(target))) {
        proven = true
        break
      }
    }
    if (!proven) {
      for (const row of to.rows) {
        if (importsOf(row.path).some((target) => fromPaths.has(target))) {
          proven = true
          direction = 'backward'
          break
        }
      }
    }
    edges.push({
      from: from.id,
      to: to.id,
      proven,
      label: proven ? (direction === 'forward' ? '引用' : '被引用') : '同批候选',
    })
  }

  // 命中强度：整份材料弱不弱、每个节点弱不弱。判断只依赖「命中的词」与「需求原文」，
  // 不读实现逻辑，所以它可以被一条测试完整钉住。
  const strength = assessMatchStrength({ question: answer.question, matches })
  const negated = negatedTermsIn(answer.question, strength.sharedTerms)
  for (const node of nodes) {
    const hits = node.rows.flatMap((row) => subjectHitsOf(row, negated))
    node.weak = strength.weak || hits.length === 0
    node.weakReasons = hits.length === 0 ? strength.sharedTerms.slice(0, 4) : []
  }

  const pageCount = nodes.filter((node) => node.kind === 'page').length
  return {
    strength,
    aliased: importResolutionOf(index) !== 'resolved',
    importResolution: importResolutionOf(index),
    question: answer.question ?? '',
    repoName: options?.repoName ?? '',
    nodes,
    edges,
    pageCount,
    backendCount: nodes.length - pageCount,
    stats: {
      matchedFiles: matches.length,
      matchedPages: pageCount,
      bytes: matches.reduce((sum, row) => sum + (Number.isFinite(row.bytes) ? row.bytes : 0), 0),
      searchTerms: Array.isArray(answer.terms) ? answer.terms : [],
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 中间栏：页面结构卡 / 时序骨架
// ─────────────────────────────────────────────────────────────────────────────

/** 中间栏片段的 data-frag：模板的 JS 靠它区分页面与模块区。 */
function fragmentKind(node) {
  return node.kind === 'page' ? 'page' : 'backend'
}

/** 证据驱动的参与者：只有名字里出现对应词，才把那一列画出来。 */
export function participantsForNode(node, hasAnyPage) {
  const names = ['用户']
  if (hasAnyPage) names.push('页面')
  names.push('服务端')
  const text = node.rows
    .map((row) => `${row.path ?? ''} ${(row.symbols ?? []).join(' ')}`)
    .join(' ')
    .toLowerCase()
  if (/(pay|payment|billing|checkout|refund)/.test(text)) names.push('支付渠道')
  if (/(oauth|sso|wechat|alipay|thirdparty|third_party|external)/.test(text)) names.push('第三方')
  if (/(notify|notification|message|sms|mailer)/.test(text)) names.push('通知渠道')
  // 保持词表里的固定列序，否则同一份输入换个匹配顺序就会画出两张不同的图。
  const order = ['用户', '页面', '服务端', '支付渠道', '第三方', '通知渠道']
  return order.filter((name) => names.includes(name))
}

/** 骨架消息：只用产品动作词，不出现任何方法名 / 表名。 */
export function skeletonMessages(participants) {
  const hasPage = participants.includes('页面')
  const messages = []
  if (hasPage) {
    messages.push({ from: '用户', to: '页面', text: '发起操作' })
    messages.push({ from: '页面', to: '服务端', text: '发起请求' })
  } else {
    messages.push({ from: '用户', to: '服务端', text: '发起请求' })
  }
  messages.push({ from: '服务端', to: '服务端', text: '处理' })
  for (const extra of ['支付渠道', '第三方', '通知渠道']) {
    if (!participants.includes(extra)) continue
    messages.push({ from: '服务端', to: extra, text: '调用' })
    messages.push({ from: extra, to: '服务端', text: '返回', kind: 'return' })
  }
  messages.push(
    hasPage
      ? { from: '服务端', to: '页面', text: '返回结果', kind: 'return' }
      : { from: '服务端', to: '用户', text: '返回结果', kind: 'return' },
  )
  return messages
}

/**
 * 「被引用」这一行怎么写，取决于这个仓的 import 解析到哪一步。
 * 解析不了时写 0 就是在编：那个 0 是「没测量」，不是「没人用」。
 *
 * @param {{ importedFiles: number, maxImportedBy: number }} facts
 * @param {'resolved'|'aliased'|'unmeasured'} resolution
 */
export function importedByText(facts, resolution) {
  const count = `${facts.importedFiles} 个文件引用过`
  if (resolution === 'resolved') {
    return facts.importedFiles === 0 ? '0 个文件引用过' : `${count}（最多 ${facts.maxImportedBy} 处）`
  }
  if (resolution === 'unmeasured') {
    return facts.importedFiles === 0
      ? '读不到（这一版索引没记录 import 的解析情况，重新索引一次即可）'
      : `${count}（只算索引解析到的 import）`
  }
  return facts.importedFiles === 0
    ? '读不到（本仓用别名导入）'
    : `${count}（只算相对引用，最多 ${facts.maxImportedBy} 处）`
}

/** 中间栏「页面内模块」这一行：空态也要说清是「没有」还是「没读到」。 */
export function modulesText(node, resolution) {
  if (node.modules.length > 0) return `${node.modules.length} 个`
  if (resolution === 'aliased') return '读不到（这一页用别名或跨包导入）'
  if (resolution === 'unmeasured') return '读不到（这一版索引没记录 import 的解析情况）'
  return '读不到（索引没记到这一页引用的模块）'
}

/** 中间栏里的模块名：只给读者看名字，不带目录与后缀（路径是研发参考的语言）。 */
function moduleLabel(name) {
  const text = String(name ?? '')
  const last = text.split('/').pop() ?? text
  return last.replace(/\.(vue|tsx|ts|jsx|js|json|go|py|java|kt|swift|rb|php|rs|md)$/i, '')
}

/** 同一页里「页面内标签」与「引用」常常指向同一个模块：按显示名去重，免得一屏两个一样的胶囊。 */
function chipItems(modules) {
  const seen = new Set()
  const items = []
  for (const item of modules) {
    const label = moduleLabel(item.name)
    if (label === '' || seen.has(label)) continue
    seen.add(label)
    items.push({ label, from: item.from })
  }
  return items
}

/** 中间栏「页面结构」卡：只写这一页由哪些模块组成；读不到就给已知信息与一句原因。 */
function pageFragment(node, resolution) {
  // 空态不是空框：读者要知道「这一页有 3 个文件 / 12 KB / Vue」，以及为什么模块读不到。
  // 这是关于这一页的内容，不是关于这份材料的说明，所以留着。
  const modules =
    node.modules.length === 0
      ? `<div class="rt-empty">
<div class="rt-empty-title">这一页由哪些模块组成：读不到</div>
<p>已知：这一页有 ${node.facts.files} 个文件、约 ${kb(node.facts.bytes)}${
          node.facts.langs.length === 0 ? '' : `、${node.facts.langs.map((lang) => esc(lang)).join(' / ')}`
        }。</p>
<p>原因：${
          resolution === 'aliased'
            ? '这一页用别名或跨包导入（`@/…`、包名），这一版只解析相对引用，所以读不到它引用了谁。'
            : resolution === 'unmeasured'
              ? '这一版索引没有记录 import 的解析情况，所以读不到它引用了谁（重新索引一次即可）。'
              : '索引里没有记到这一页引用的模块，可能是模板里的动态引用，也可能是运行期才拼出来的名字。'
        }</p>
</div>`
      : `<ul class="rt-chips">${chipItems(node.modules)
          .map((item) => `<li class="rt-chip">${esc(item.label)}<span>${esc(item.from)}</span></li>`)
          .join('')}</ul>`
  return `<div class="rt-frag" data-frag="page">
  <div class="rt-frag-head">
    <span class="rt-frag-kind">页面</span>
    <span class="rt-frag-name">${esc(node.short)}</span>
  </div>
  <div class="rt-block">
    <div class="rt-block-title">这个页面由这些模块组成</div>
    ${modules}
  </div>
</div>`
}

/** 中间栏「时序骨架」：没有页面就画时序，并写明参与者与步骤要研发确认。 */
function backendFragment(node, hasAnyPage) {
  const participants = participantsForNode(node, hasAnyPage)
  const { svg } = renderSequenceSvg({ participants, messages: skeletonMessages(participants) })
  return `<div class="rt-frag" data-frag="backend">
  <div class="rt-frag-head">
    <span class="rt-frag-kind rt-kind-backend">没有页面</span>
    <span class="rt-frag-name">${esc(node.short)}</span>
  </div>
  <div class="rt-banner">时序骨架 · <b>不是从代码里读出来的流程</b>：参与者与步骤需要研发确认。</div>
  <div class="rt-seq">${svg}</div>
</div>`
}
// ─────────────────────────────────────────────────────────────────────────────
// 右栏：标注（能证明的）+ 待研发确认（不能证明的）
// ─────────────────────────────────────────────────────────────────────────────

function annotationsFor(node, resolution) {
  const facts = node.facts
  const pairs = []
  if (node.kind === 'page') {
    pairs.push(['这一节是什么', '索引按目录约定认出的一个页面；下面是它的结构，不是它的业务规则。'])
    pairs.push(['规模', `${facts.files} 个文件、约 ${kb(facts.bytes)}${facts.langs.length === 0 ? '' : `、${facts.langs.join(' / ')}`}。`])
    pairs.push([
      '谁能改到它',
      resolution !== 'resolved' && facts.importedFiles === 0
        ? '读不到：本仓用别名导入，这一版只解析相对引用，所以「有没有人引用它」在这一仓里量不出来。'
        : facts.importedFiles === 0
          ? '没有别的模块引用它——页面通常是入口，这个数字为 0 不代表它不重要。'
          : `${facts.importedFiles} 个文件引用过它，最多一处被 ${facts.maxImportedBy} 个文件引用。`,
    ])
  } else {
    pairs.push(['为什么没有页面', '这一片命中的是模块与配置，索引里没有任何页面约定命中它们，所以不给页面示意。'])
    pairs.push(['规模', `${facts.files} 个文件、约 ${kb(facts.bytes)}。`])
    pairs.push([
      '谁在用它',
      resolution !== 'resolved' && facts.importedFiles === 0
        ? '读不到：本仓用别名导入，这一版只解析相对引用；「没人引用」这件事在这一仓里没有被测量过。'
        : facts.importedFiles === 0
          ? '没有被别的模块引用过：它可能是入口，也可能是这一版解析不到的引用写法。'
          : `${facts.importedFiles} 个文件引用过它，最多一处被 ${facts.maxImportedBy} 个文件引用。`,
    ])
  }
  pairs.push([
    '待研发确认（未证实）',
    node.kind === 'page'
      ? '这一页有哪些状态、按钮点了去哪里、提交给谁、失败怎么提示——索引读不到，不要从这份材料推断。'
      : '真实调用顺序、失败与重试、这一片由谁触发——上面的时序是骨架，不是证据，需要研发确认。',
  ])
  return pairs
}

// ─────────────────────────────────────────────────────────────────────────────
// 页头正文 / 限界 / 研发参考
// ─────────────────────────────────────────────────────────────────────────────

function bodyParagraphs(plan, answer, indexFacts, graph) {
  const paragraphs = []
  if (answer.found !== true) {
    if (answer.state === 'no-index') {
      return [
        '还没有任何一个仓建过索引，所以这一轮没有可查的东西。',
        '这不代表你要找的东西不存在——只代表还没有材料可查。先在「仓库」里接入一个仓、跑完一轮索引，再来问同一句话。',
      ]
    }
    const terms = (answer.terms ?? []).slice(0, 8).join('、') || '（问题里没有可用的词）'
    return [
      `没能在已索引的代码里找到与「${answer.question ?? plan.question}」相关的地方。`,
      `这是「查过、没命中」，不是「不存在」：这一轮查了 ${answer.stats?.repos ?? 0} 个仓、${answer.stats?.files ?? 0} 个文件，用的检索词是 ${terms}。`,
      '所以这一轮没有画流程，也没有生成三栏走查页——一张空的三栏页会让人误以为「这件事就是这样」。',
    ]
  }

  paragraphs.push(
    `你问的是「${answer.question ?? plan.question}」。在 ${plan.repoName} 的索引里，有 ${plan.stats.matchedFiles} 处代码的名字与它相关，` +
      `归成了 ${plan.nodes.length} 个节点：${plan.pageCount} 个页面、${plan.backendCount} 个没有页面的模块区域。`,
  )
  // 只有在图上确实存在两种线（引用实线 + 候选虚线）时，才谈「两种连线长得不一样」。
  // 现在图里只画「代码里真的引用过」这一种线，其余候选并排摆着不连线，
  // 所以这句话默认不出现——说了就是描述一张不存在的图。
  const kinds = graph?.edgeKinds ?? 0
  const shapeSentence =
    kinds >= 2
      ? '左边是这些节点的顺序；两种连线在图上长得不一样：实线是代码里真的有引用，虚线只表示同一批候选。'
      : kinds === 1
        ? '左边是这些节点的关系：实线箭头表示一个节点的文件真的引用了另一个节点的文件；其余候选并排摆放，顺序没有代码依据。'
        : '左边是同一批候选：它们只是同时被检索到，互相之间没有代码依据的先后，所以图上不连线。'
  paragraphs.push(
    shapeSentence +
      '中间是每个节点能看到的东西（有页面就给页面结构，没有页面就给时序骨架），' +
      '右边是这个节点上能从索引证明的事。',
  )
  paragraphs.push(
    `这一轮读的是 ${plan.repoName} 的本机索引：${indexFacts.files} 个可读文件，代码快照 ${indexFacts.snapshotDay ?? '（读不到提交日期）'}。` +
      '材料里没有一个字来自对实现逻辑的阅读，需要研发确认的地方单独标在右栏。',
  )
  return paragraphs
}

function footerHtml(branding) {
  if (branding.footer === null) return ''
  const text = branding.footer
  const index = text.indexOf(branding.repoUrl)
  if (index === -1) return `<footer>${esc(text)}</footer>`
  return `<footer>${esc(text.slice(0, index))}<a href="${esc(branding.repoUrl)}">${esc(branding.repoUrl)}</a>${esc(
    text.slice(index + branding.repoUrl.length),
  )}</footer>`
}

const EXTRA_CSS = `
/* 三栏宽度：模板写死 520/690/300，1280 宽会溢出到屏幕外（左右两栏看不见）。
   这里改成按视口收缩，窄屏时才允许横向滚动。 */
.layout { gap: 16px; padding: 14px 16px 24px; justify-content: center; align-items: flex-start; overflow-x: auto; }

/* 三栏要有视觉重量：读的人第一眼该落在柱子上。 */
.flow-panel, .frame-wide, .anno-panel { box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); }
.flow-panel { width: clamp(300px, 27vw, 420px); border: 1px solid #d6dae0; border-radius: 12px; overflow: hidden; }
.frame-wide { width: clamp(430px, 45vw, 660px); border: 1px solid #d6dae0; border-radius: 12px; }
.anno-panel { width: clamp(238px, 21.5vw, 320px); }
.anno-card { border: 1px solid #d6dae0; border-radius: 12px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06); }
.fp-title { font-size: 13px; font-weight: 700; letter-spacing: .02em; color: #111827; }

/* 署名一行，只在页底出现一次。 */
.rt-foot { max-width: 1120px; margin: 0 auto; padding: 0 24px 32px; font-size: 12px; color: #8a9199; }
.rt-foot footer { padding: 0; }

.rt-frag { padding: 20px 20px 26px; }
.rt-frag-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.rt-frag-kind { font-size: 11px; padding: 2px 8px; border: 1px solid #9aa1ab; border-radius: 3px; color: #4b5563; background: #f4f5f7; }
.rt-kind-backend { background: #eceef1; }
.rt-frag-name { font-size: 16px; font-weight: 700; }
.rt-block { margin-bottom: 16px; }
.rt-block-title { font-size: 12px; font-weight: 600; color: #4b5563; margin-bottom: 8px; }
.rt-chips { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; }
.rt-chip { font-size: 12px; padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 12px; background: #fff; }
.rt-chip span { margin-left: 6px; color: #8a9199; font-size: 11px; }
.rt-empty { font-size: 12px; line-height: 1.8; color: #4b5563; border: 1px solid #e2e5ea; border-radius: 8px; padding: 14px 16px; background: #f8f9fb; }
.rt-empty-title { font-weight: 700; color: #111827; margin-bottom: 6px; }
.rt-empty p { margin: 0 0 6px; }
.rt-empty p:last-child { margin-bottom: 0; color: #6b7280; }
.rt-banner { margin: 0 0 12px; padding: 8px 12px; font-size: 12px; line-height: 1.7; color: #7c4a03; background: #fff8e6; border: 1px solid #f0dca8; border-radius: 8px; }
.rt-seq { overflow-x: auto; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; padding: 8px; margin-bottom: 16px; }
.rt-seq svg { display: block; max-width: 100%; height: auto; }
`

/**
 * 把模板里的「使用说明」卡片摘掉。
 *
 * 为什么在渲染时摘、不改模板文件：模板是第三方资产（带 license 与署名），
 * 我们的取舍属于我们的产物。交互说明只该出现在插件面板里一次，
 * 不该出现在每一份要发给评审的 HTML 里——那是把说明书装进产品里。
 */
export function stripUsageCard(html) {
  // 摘掉整张「使用说明」卡：从它的标题 div 起，到 aside 结束前的那一个闭合为止。
  const withoutCard = html.replace(
    /<div class="anno-card">\s*<div class="anno-card-title">使用说明<\/div>[\s\S]*?<\/div>\s*(?=<\/aside>)/,
    '',
  )
  // 左栏工具条上的那句「点击节点联动右侧页面」也是交互说明，一并摘掉。
  return withoutCard.replace(/\s*<span style="margin-left:auto;">点击节点联动右侧页面<\/span>/, '')
}

/**
 * 摘掉模板顶部那段「改造说明」注释。
 *
 * 它是给我们自己看的变更记录（第几行加了哪个占位），不是产物的一部分：
 * 产物里出现「研发参考」「占位」这类字眼，等于把工具的自述贴进成品。
 * 溯源信息留在 lib/vendor/uemaster/ 的原文件与 NOTICE、docs/vendor.md 里。
 */
export function stripVendorComment(html) {
  return html.replace(/^\s*<!--[\s\S]*?-->\s*(?=<!doctype html>)/i, '')
}

/**
 * 生成走查材料的 HTML。
 * options: { repoName, index, answer, config, generatedAt }
 * 返回 { html, plan, found, paragraphs }。
 */
export async function buildMaterialHtml(options) {
  const { repoName, index, answer, config } = options
  const branding = brandingParts(config, { version: version() })
  const plan = planFromAnswer({ answer, index, repoName })
  const indexFacts = {
    files: Object.keys(index?.files ?? {}).length,
    snapshotDay: dayOf(index?.headDate),
    indexedDay: dayOf(index?.indexedAt),
    pages: Array.isArray(index?.pages?.items) ? index.pages.items.length : 0,
  }
  // 没命中的那一页用不到图形，所以图上的「几种线」对它没有意义（kinds=0）。
  const noMatchParagraphs = bodyParagraphs(plan, answer, indexFacts)

  // 一份材料只有一个结局：要么有节点，要么明确说没找到。没有「半个三栏页」。
  if (answer.found !== true || plan.nodes.length === 0) {
    return {
      html: renderNoMatchHtml({ answer, plan, paragraphs: noMatchParagraphs, branding, repoName }),
      plan,
      found: false,
      paragraphs: noMatchParagraphs,
    }
  }

  const hasAnyPage = plan.pageCount > 0
  const resolution = plan.importResolution ?? 'unmeasured'
  const frames = plan.nodes
    .map((node) =>
      node.kind === 'page'
        ? `<div class="page" id="${esc(node.frameId)}">\n${pageFragment(node, resolution)}\n</div>`
        : `<div class="page" id="${esc(node.frameId)}">\n${backendFragment(node, hasAnyPage)}\n</div>`,
    )
    .join('\n')

  // 图的画法不变：节点与边只描述代码里的关系，不再往节点上挂「弱命中」标记——
  // 那个判断是关于这份材料的，不是关于这一页的。
  const flow = renderFlowSvg({
    nodes: plan.nodes.map((node) => ({
      id: node.id,
      type: node.kind === 'page' ? 'page' : 'backend',
      label: node.short,
    })),
    edges: plan.edges,
  })
  const paragraphs = bodyParagraphs(plan, answer, indexFacts, flow)

  const nodesJson = {}
  for (const node of plan.nodes) {
    nodesJson[node.id] = {
      page: node.frameId,
      // 右栏标题只写「页面 / 模块区」：节点名在中间栏出现一次就够了，
      // 同一个名字在一屏里出现三遍，读的人会以为这是三个不同的东西。
      title: node.kind === 'page' ? '页面' : '模块区',
      anno: annotationsFor(node, resolution),
    }
  }
  const pageFrameJson = {}
  for (const node of plan.nodes) pageFrameJson[node.frameId] = 'wide'

  const title = `${repoName} · 需求走查：${answer.question ?? plan.question}`
  const footer = footerHtml(branding)
  const foot = footer === '' ? '' : `<div class="rt-foot">${footer}</div>`

  const template = await templateHtml()
  const html = stripVendorComment(stripUsageCard(
    template
      .replace('__HEAD_EXTRA__', `${branding.meta}\n<style>${EXTRA_CSS}</style>`)
      // 三栏从页面顶端开始：页头、说明、判断块全部不渲染，页面第一个元素就是布局本身。
      .replace('__INTRO__', '')
      .replace('__FOOT__', foot)
      .replace('__USAGE_NOTE__', '')
      .replace(/__TITLE__/g, () => esc(title))
      // 左栏标题只写「候选」：这一栏放的是同一批候选，不是某个页面，
      // 把节点名写在这里，中间栏与右栏再各写一次，就是一屏三个同名标题。
      .replace('__FLOW_TITLE__', esc('候选'))
      .replace('__CSS_VARS__', '')
      .replace('__SVG__', flow.svg)
      .replace('__PAGES_PHONE__', '')
      // 正文禁词自检只扫读者真正读到的那一块：中间栏的结构卡与时序骨架。
      .replace('__PAGES_WIDE__', `<!-- product-body:start -->\n${frames}\n<!-- product-body:end -->`)
      .replace('__NODES_JSON__', JSON.stringify(nodesJson))
      .replace('__STATE_GROUPS_JSON__', '{}')
      .replace('__PAGE_FRAME_JSON__', JSON.stringify(pageFrameJson))
      .replace(/__DEFAULT__/g, esc(plan.nodes[0].id)),
  ))

  return { html, plan, found: true, paragraphs, flow, indexFacts }
}

/** 没命中时的那一页：只有一句结论与署名，没有任何流程、没有任何自我说明。 */
function renderNoMatchHtml(options) {
  const { answer, plan, paragraphs, branding, repoName } = options
  const title = `${repoName} · 需求走查：${answer.question ?? plan.question}`
  const footer = footerHtml(branding)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${branding.meta}
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main>
<section class="product">
<!-- product-body:start -->
${paragraphs.map((text) => `<p>${esc(text)}</p>`).join('\n')}
<!-- product-body:end -->
</section>
</main>
${footer}
</body>
</html>
`
}

/** 正文禁词自检：出材料前先跑一次，命中就说明产品语言里混进了研发语言。 */
export function assertProductLanguage(html) {
  const violations = productBodyViolations(html)
  if (violations.length > 0) throw new Error(`走查材料正文出现研发语言：${violations.join('、')}`)
  return violations
}

function looksLikeIndexDocument(parsed) {
  return parsed !== null && typeof parsed === 'object' && typeof parsed.files === 'object' && typeof parsed.blobs === 'object'
}

/**
 * 读一个仓的索引。
 * 索引文件不存在时抛错（「还没索引」和「没命中」是两件事，不能合并成一句）。
 */
export async function readRepoIndex(repoName) {
  let text
  try {
    text = await readFile(indexPath(repoName), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`还没有「${repoName}」的索引：先在界面里接入这个仓，等索引跑完再生成走查材料。`)
    throw new Error(`索引读不了：${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('索引文件不是合法 JSON（删掉重新索引即可）。')
  }
  if (!looksLikeIndexDocument(parsed)) throw new Error('索引文件结构不对（缺少 files / blobs）。')
  return parsed
}

/**
 * 命令行入口的实现：读索引 → 检索 → 生成 → 写盘。
 * options: { repo, question, out, attribution, generatedAt, quiet, log }
 */
export async function runMaterial(options) {
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`))
  const repoName = String(options.repo ?? '').trim()
  const question = String(options.question ?? '').trim()
  if (repoName === '') throw new Error('material 需要一个仓名（接入时显示的那个名字）')
  if (question === '') throw new Error('material 需要一句需求：--question "…"')

  const index = await readRepoIndex(repoName)
  // 检索只走 ask.js 这一份实现：材料与「问一句」必须给出同一批候选，否则两份产物会互相打脸。
  const { askQuestion } = await import('./ask.js')
  const answer = await askQuestion({ question, repos: [{ name: repoName }], onlyRepo: repoName })
  if (answer.ok !== true) throw new Error(answer.error ?? '检索失败')

  const config = options.attribution === undefined ? { attribution: true } : { attribution: options.attribution !== false }
  const rendered = await buildMaterialHtml({
    repoName,
    index,
    answer,
    config,
    generatedAt: options.generatedAt,
  })
  assertProductLanguage(rendered.html)

  const outPath = await writeMaterialFile(rendered.html, options.out, repoName)
  if (!options.quiet) {
    const files = Object.keys(index.files).length
    log(`✓ 仓：${repoName} · 索引 ${files} 个文件 · 快照 ${dayOf(index.headDate) ?? '（读不到提交日期）'}`)
    if (rendered.found) {
      log(`✓ 节点 ${rendered.plan.nodes.length} 个（页面 ${rendered.plan.pageCount} 个、没有页面的 ${rendered.plan.backendCount} 个）`)
    } else {
      // 与正文一句话一字不差：命令行里看到的结论和文件里读到的结论必须一样。
      log(`✗ ${rendered.paragraphs[0] ?? ''}`)
      log(`  ${rendered.paragraphs[1] ?? ''}`)
      log('  没有生成三栏走查页：空的三栏页会让人以为「这件事就是这样」；说明页仍然写了限界与研发参考。')
    }
    log(`✓ 已写入：${outPath}`)
  }
  return {
    outPath,
    found: rendered.found,
    nodes: rendered.plan.nodes.map((node) => ({ id: node.id, kind: node.kind, title: node.title })),
    plan: rendered.plan,
    paragraphs: rendered.paragraphs,
    answer,
  }
}

/** 输出位置：--out 是目录就写 <目录>/<仓名>-walkthrough.html。 */
async function writeMaterialFile(html, out, repoName) {
  const slug = String(repoName).replace(/[^A-Za-z0-9._-]/g, '-')
  const target = out === undefined || out === null || String(out).trim() === '' ? resolve(`${slug}-walkthrough.html`) : resolve(String(out))
  const isFileTarget = /\.html?$/i.test(target)
  const filePath = isFileTarget ? target : join(target, `${slug}-walkthrough.html`)
  await mkdir(isFileTarget ? dirname(target) : target, { recursive: true })
  await writeFile(filePath, html, 'utf8')
  return filePath
}
