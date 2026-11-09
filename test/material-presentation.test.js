// 材料「呈现与判断」的纪律测试（第二轮评审的九条）。
//
// 这一组守的是同一件事：材料不许比证据说得更多。
//   · 词面撞车 → 必须自己说「这更像没命中」（第 1 条）
//   · 引用解析不了 → 「被引用 = 0」其实是没测量（第 2 条）
//   · 并列候选 → 不许画成流程链（第 3 条）
//   · 三栏要落在首屏、节点名只说一次、仓名要显眼、空态要给信息（第 4–9 条）
// 每条都对应一个「改坏就会变红」的断言，改法写在测试名里。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { askQuestion } from '../lib/ask.js'
import {
  buildMaterialHtml,
  importsUseAliases,
  importResolutionOf,
  importedByText,
  modulesText,
  stripUsageCard,
} from '../lib/material.js'
import { assessMatchStrength, negatedTermsIn, subjectHitsOf, GENERIC_TERMS, isGenericTerm } from '../lib/match-strength.js'
import { renderFlowSvg } from '../lib/flow-svg.js'

const REPO = 'fixture-shop'
const QUESTION = '分享页要支持未登录下载但只有会员能下'
const LOGIN_QUESTION = '登录页是怎么做的？'

/**
 * 一份「别名导入」的索引：页面在 `@/…` 里引用模块，被丢掉的 57 条 import 记在 counts 里。
 * 这就是 vue-admin-template 的真实形状（重新索引后 counts.aliasImports = 57）。
 */
function aliasedIndex() {
  return {
    version: 2,
    repo: REPO,
    head: 'a'.repeat(40),
    headDate: '2026-01-05T10:00:00+08:00',
    indexedAt: '2026-11-08T02:00:00.000Z',
    parsedBlobs: 4,
    reusedBlobs: 0,
    counts: { total: 9, indexed: 4, generated: 0, test: 1, dir: 0, asset: 3, unsupported: 1, large: 0, aliasImports: 57 },
    pages: { convention: 'views', label: 'src/views/**', items: ['src/views/login/index'] },
    blobs: {
      'sha-page': {
        lang: 'Vue',
        symbols: [],
        // 刻意留空：别名仓里这一页的模块一个都解析不到，正是「读不到」的那种空态。
        outline: [],
        pages: [{ convention: 'views', page: 'src/views/login/index' }],
        imports: [],
        aliasImports: 3,
      },
      'sha-user': { lang: 'JavaScript', symbols: ['login'], outline: [], pages: [], imports: [], aliasImports: 2 },
      'sha-auth': { lang: 'JavaScript', symbols: ['getToken'], outline: [], pages: [], imports: [], aliasImports: 0 },
      'sha-misc': { lang: 'JavaScript', symbols: ['formatDate'], outline: [], pages: [], imports: [], aliasImports: 0 },
    },
    files: {
      'src/views/login/index.vue': 'sha-page',
      'src/api/user.js': 'sha-user',
      'src/utils/auth.js': 'sha-auth',
      'src/utils/format.js': 'sha-misc',
    },
    generated: {},
    sizes: {
      'src/views/login/index.vue': 5000,
      'src/api/user.js': 900,
      'src/utils/auth.js': 400,
      'src/utils/format.js': 300,
    },
    changes: { 'src/views/login/index.vue': '2026-01-02T09:00:00+08:00' },
    changesWindow: 200,
  }
}

/** 同一份仓，但 import 全解析成功（相对引用），并且页面真的引用了 api 那一片。 */
function resolvedIndex() {
  const index = aliasedIndex()
  index.counts = { ...index.counts, aliasImports: 0 }
  index.blobs['sha-page'] = { ...index.blobs['sha-page'], imports: ['src/api/user.js'], aliasImports: 0 }
  return index
}

/** 检索层是从磁盘读索引的，所以这里把 fixture 落到临时数据目录再跑真流程。 */
async function build(index, question) {
  const home = await mkdtemp(join(tmpdir(), 'repo-truth-presentation-'))
  const previous = process.env.REPO_TRUTH_HOME
  process.env.REPO_TRUTH_HOME = home
  try {
    await mkdir(join(home, 'index'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'index', `${REPO}.json`), `${JSON.stringify(index)}\n`, { mode: 0o600 })
    const answer = await askQuestion({ question, repos: [{ name: REPO }], onlyRepo: REPO })
    assert.equal(answer.ok, true)
    assert.equal(answer.found, true, `fixture 应该命中：${question}`)
    return buildMaterialHtml({
      repoName: REPO,
      index,
      answer,
      config: { attribution: false },
      generatedAt: '2026-11-09',
    })
  } finally {
    if (previous === undefined) delete process.env.REPO_TRUTH_HOME
    else process.env.REPO_TRUTH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  }
}

function textOf(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

// ── 1. 低质量命中必须先说「这更像没命中」 ────────────────────────────────────

test('弱命中：命中的词全被否定（未登录）→ 整份材料判为弱，正文先说不像命中', async () => {
  const strength = assessMatchStrength({
    question: QUESTION,
    matches: [{ path: 'a', matched: ['login'] }, { path: 'b', matched: ['auth'] }],
  })
  assert.equal(strength.weak, true, '「未登录」里的登录被否掉了，不能算交集')
  assert.deepEqual(strength.weakPaths.sort(), ['a', 'b'])

  // 同一个词没被否定时，就不是弱命中：这是反过来的一条守门（防止为了让它变红而一刀切）。
  const normal = assessMatchStrength({ question: LOGIN_QUESTION, matches: [{ path: 'a', matched: ['login'] }] })
  assert.equal(normal.weak, false, '「登录页是怎么做的」是正常命中')

  const rendered = await build(aliasedIndex(), QUESTION)
  assert.equal(rendered.plan.strength.weak, true)
  assert.ok(rendered.html.includes('rt-weak-block'), '弱命中块必须在正文里、在栏目之前')
  assert.ok(textOf(rendered.html).includes('更像是没命中'), '必须直说「更像是没命中」')
  assert.equal(rendered.html.includes('rt-weak"'), true, '节点上要有「弱命中」标签')
  // 三栏必须在弱命中块之后：先给判断，再给数据。
  assert.ok(rendered.html.indexOf('rt-weak-block') < rendered.html.indexOf('class="layout"'))
})

test('弱命中：判据只看「非结构、非否定」的词，通用词一律不算证据', () => {
  for (const word of ['页面', '模块', 'utils', 'api', 'store', 'common', 'index']) {
    assert.equal(isGenericTerm(word), true, `${word} 是结构性词`)
  }
  assert.equal(isGenericTerm('结算'), false)
  assert.ok(GENERIC_TERMS.includes('utils'))
  const negated = negatedTermsIn('分享页要支持未登录下载', ['login', 'download'])
  assert.ok(negated.has('login'), 'login 的否定要看中文字面「未登录」')
  assert.equal(negated.has('download'), false, '下载没被否定')
  assert.deepEqual(subjectHitsOf({ matched: ['api', 'download'] }, new Set()), ['download'])
})

// ── 2. 解析不了就别写 0 ──────────────────────────────────────────────────────

test('别名导入：引用与页面内模块写「读不到」，不写 0', async () => {
  assert.equal(importResolutionOf(aliasedIndex()), 'aliased')
  assert.equal(importResolutionOf(resolvedIndex()), 'resolved')
  assert.equal(importResolutionOf({}), 'unmeasured', '老索引没有这项测量')
  assert.equal(importsUseAliases({}), true)

  const facts = { importedFiles: 0, maxImportedBy: 0 }
  assert.equal(importedByText(facts, 'aliased'), '读不到（本仓用别名导入）')
  assert.equal(importedByText(facts, 'resolved'), '0 个文件引用过')
  assert.match(importedByText(facts, 'unmeasured'), /读不到（这一版索引没记录/)
  assert.match(importedByText({ importedFiles: 3, maxImportedBy: 2 }, 'aliased'), /只算相对引用/)

  const rendered = await build(aliasedIndex(), LOGIN_QUESTION)
  const text = textOf(rendered.html)
  assert.ok(text.includes('读不到（本仓用别名导入）'), '被引用这一行要写读不到')
  assert.ok(text.includes('读不到（这一页用别名或跨包导入）'), '页面内模块这一行要写读不到')
  assert.equal(/被别的模块引用 0 个文件引用过/.test(text), false, '别名仓里绝不许出现「0 个」')

  // 解析成功的仓仍然要出数字：不能因为怕错就一律说读不到。
  const resolved = await build(resolvedIndex(), LOGIN_QUESTION)
  assert.ok(textOf(resolved.html).includes('0 个文件引用过'), '能解析的仓要照实写 0')
})

// ── 3. 并列候选不许画成流程链 ────────────────────────────────────────────────

test('图：没有代码依据的候选并排摆放，不连线、不说「两种连线」', async () => {
  const rendered = await build(aliasedIndex(), LOGIN_QUESTION)
  const svg = rendered.html.slice(rendered.html.indexOf('<svg id="flowsvg"'), rendered.html.indexOf('</svg>') + 6)
  // 分组框自己是虚线（那是「一组」的记号），但**边**一条都不许有，更不许有虚线边。
  assert.equal(/<line[^>]*stroke-dasharray/.test(svg), false, '候选之间不许画虚线连线')
  assert.equal((svg.match(/<line /g) ?? []).length, 0, '没有 proven 边就一条线都不画')
  assert.ok(svg.includes('data-sibling-group="1"'), '候选要装进「同批候选」分组框')
  assert.ok(svg.includes('同批候选 · 顺序无代码依据'))
  assert.equal(rendered.html.includes('两种连线在图上长得不一样'), false, '图里没有两种线，就不许这么说')
  assert.ok(textOf(rendered.html).includes('所以图上不连线'))
})

test('图：真的引用过才画箭头，并且正文换成「实线」的说法', async () => {
  const rendered = await build(resolvedIndex(), LOGIN_QUESTION)
  const flow = rendered.flow
  assert.equal(flow.edgeKinds, 1, '有一条 proven 边：只有一种线')
  assert.ok((flow.svg.match(/<line /g) ?? []).length >= 1, 'proven 边要画出来')
  assert.equal(flow.svg.includes('marker-end'), true, '引用边要有箭头')
  assert.equal(flow.svg.includes('data-sibling-group'), false, '全都连上了就不需要分组框')
  assert.ok(textOf(rendered.html).includes('实线箭头'), '图上有实线，正文要说实线')
  assert.equal(rendered.html.includes('两种连线在图上长得不一样'), false)
})

test('图：两种线同时存在时才说「长得不一样」（这条守卫措辞与图形一致）', () => {
  // 直接喂两种边：proven 一条 + 另一条 proven=false（未来的画法若恢复虚线，这里会把它算进去）。
  const flow = renderFlowSvg({
    nodes: [
      { id: 'a', label: 'A', type: 'page' },
      { id: 'b', label: 'B', type: 'backend' },
    ],
    edges: [{ from: 'a', to: 'b', proven: true, label: '引用' }, { from: 'a', to: 'b', proven: false, label: '同批候选' }],
  })
  // 现在只画 proven，所以图上只有一种线——edgeKinds 必须是 1，措辞就不能说两种。
  assert.equal(flow.edgeKinds, 1)
  assert.equal(flow.svg.includes('stroke-dasharray="5 4"'), false, '候选虚线不再出现在图里')
})

// ── 4. 顶部四段解释折叠 ──────────────────────────────────────────────────────

test('首屏：解释折叠成一行，三栏在折叠之上', async () => {
  const rendered = await build(aliasedIndex(), LOGIN_QUESTION)
  const html = rendered.html
  assert.ok(html.includes('<details class="rt-how">'), '解释块要折叠')
  assert.equal(/<details class="rt-how" open/.test(html), false, '默认收起')
  assert.ok(html.includes('这份材料怎么来的 ↓'), '折叠标题就是这一行')
  // 三段解释必须在折叠里面，不能漏到首屏。
  const detailsStart = html.indexOf('<details class="rt-how">')
  const detailsEnd = html.indexOf('</details>', detailsStart)
  const bodyStart = html.indexOf('<!-- product-body:start -->')
  assert.ok(bodyStart > detailsStart && bodyStart < detailsEnd, '正文段落要在折叠块内部')
  assert.ok(detailsEnd < html.indexOf('class="layout"'), '折叠块要在三栏之前')
})

// ── 5. 删掉材料里的「使用说明」 ───────────────────────────────────────────────

test('使用说明块与联动提示都不进产物（只留在插件面板里）', async () => {
  const rendered = await build(aliasedIndex(), LOGIN_QUESTION)
  assert.equal(rendered.html.includes('<div class="anno-card-title">使用说明</div>'), false)
  assert.equal(rendered.html.includes('点击节点联动右侧页面'), false)
  // 右栏的两个卡片还在（当前节点 + 空的状态卡），只是少了说明书。
  assert.ok(rendered.html.includes('当前节点'))
  // 摘卡函数本身是幂等的：摘过的 HTML 再摘一次不变。
  const once = stripUsageCard(rendered.html)
  assert.equal(stripUsageCard(once), once)
})

// ── 6. 标题去重 ──────────────────────────────────────────────────────────────

test('标题只说一次：H1=需求，左栏=候选，节点名只在中间栏出现', async () => {
  const rendered = await build(aliasedIndex(), LOGIN_QUESTION)
  const html = rendered.html
  const h1 = /<h1 class="rt-h1">([^<]*)<\/h1>/.exec(html)
  assert.equal(h1[1], LOGIN_QUESTION, 'H1 只放需求原文')
  const fp = /<div class="fp-title">([^<]*)<\/div>/.exec(html)
  assert.equal(fp[1], '候选', '左栏标题只说「候选」')
  // 右栏标题只写「页面 / 模块区」，不再重复节点名。
  assert.ok(html.includes('"title":"页面"'))
  assert.equal(html.includes('"title":"页面：'), false, '右栏标题不许带节点名')
  // 节点名在页面上最多两处：流程图标签 + 中间栏头部。
  const short = '登录（login）'
  assert.equal((textOf(html).match(new RegExp(short, 'g')) ?? []).length <= 2, true)
})

// ── 7. 三栏要有视觉重量 ──────────────────────────────────────────────────────

test('三栏有投影与边框，头部说明被压低', async () => {
  const rendered = await build(aliasedIndex(), LOGIN_QUESTION)
  const html = rendered.html
  assert.ok(/\.flow-panel, \.frame-wide, \.anno-panel \{ box-shadow/.test(html), '三栏要有投影')
  assert.ok(/\.flow-panel \{ width: clamp\(300px, 27vw, 420px\); border: 1px solid/.test(html), '左栏要有边框')
  assert.ok(/\.anno-card \{ border: 1px solid #d6dae0; border-radius: 12px; box-shadow/.test(html), '右栏卡片要有重量')
  // 说明文字比正文更淡更小。
  assert.ok(/\.rt-body \{ font-size: 13px;.*color: #4b5563;/.test(html), '说明文字要压低')
})

// ── 8. 仓名与快照是一条显眼的带子 ────────────────────────────────────────────

test('仓名与快照做成带背景的一行，不再是副标题小字', async () => {
  const rendered = await build(aliasedIndex(), LOGIN_QUESTION)
  const html = rendered.html
  const bar = /<div class="rt-repo-bar">([\s\S]*?)<\/div>/.exec(html)
  assert.ok(bar !== null, '缺少仓名带')
  const text = textOf(bar[1])
  assert.ok(text.includes('仓'))
  assert.ok(text.includes(REPO))
  assert.ok(text.includes('索引文件'))
  assert.ok(text.includes('代码快照'))
  assert.ok(/\.rt-repo-bar \{[^}]*background: #eef2f7/.test(html), '这条带子要有自己的底色')
  assert.equal(/class="rt-meta"/.test(html), false, '旧的副标题小字要让位')
})

// ── 9. 中间栏空态要给信息 ────────────────────────────────────────────────────

test('页面模块读不到时：给已知事实、原因、补什么，不给空虚线框', async () => {
  const rendered = await build(aliasedIndex(), LOGIN_QUESTION)
  const text = textOf(rendered.html)
  assert.ok(text.includes('rt-empty-title') || rendered.html.includes('class="rt-empty-title"'))
  assert.ok(text.includes('已知：这一页有 1 个文件'), '空态要先说已知')
  assert.ok(text.includes('原因：这一页用别名或跨包导入'), '空态要说原因')
  assert.ok(text.includes('补什么才读得到：'), '空态要说补什么')
  assert.equal(text.includes('索引没读到这一页引用的模块。'), false, '旧的一句话空框不许回来')
  // 空态不是把表格也一起抽掉：索引读到的事实仍然在。
  assert.ok(text.includes('被别的模块引用'))

  // 解析成功的仓、且页面没有模块时，说的是「索引没记到」而不是别名——两种空态不能混。
  const resolved = await build(resolvedIndex(), LOGIN_QUESTION)
  assert.ok(textOf(resolved.html).includes('索引没记到这一页引用的模块') || resolved.html.includes('这个页面由这些模块组成'))
  assert.equal(modulesText({ modules: [] }, 'resolved'), '读不到（索引没记到这一页引用的模块）')
  assert.equal(modulesText({ modules: [{ name: 'X' }] }, 'aliased'), '1 个')
})
