// 「需求走查」材料的纪律测试。
//
// 这组测试守的是「能不能拿这份材料在评审会上说话」，所以断言都落在会被误读的地方：
// 1. 没命中就不画流程——一张空的三栏页会让人以为「这件事就是这样」；
// 2. 没有页面的节点必须给时序图，且参与者只能从封闭词表里取（图上不许出现方法名）；
// 3. 节点必须带 data-node、页面与标注容器必须能被 JS 切换（联动断了，这页就退化成静态图）；
// 4. 材料只剩两样自我说明：<head> 的生成器 meta 与页底一行署名（限界框、研发参考已删）；
// 5. 产品语言里不许混进路径/后缀/驼峰标识符（机器检查，不靠感觉）。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { assertProductLanguage, buildMaterialHtml, readRepoIndex, runMaterial } from '../lib/material.js'
import { askQuestion } from '../lib/ask.js'
import { productBodyViolations } from '../lib/render.js'
import { SEQ_PARTICIPANTS, renderSequenceSvg } from '../lib/seq-svg.js'

/** 一份够用的索引：一个页面、一个带支付词的模块区、一个无关文件。 */
function fixtureIndex() {
  const pageBlob = 'sha-page'
  const apiBlob = 'sha-api'
  const payBlob = 'sha-pay'
  const miscBlob = 'sha-misc'
  return {
    version: 1,
    repo: 'fixture-shop',
    head: 'a'.repeat(40),
    headDate: '2026-01-05T10:00:00+08:00',
    indexedAt: '2026-11-08T02:00:00.000Z',
    parsedBlobs: 0,
    reusedBlobs: 4,
    counts: { total: 9, indexed: 4, generated: 0, test: 1, dir: 0, asset: 3, unsupported: 1, large: 0 },
    pages: { convention: 'views', label: 'src/views/**', items: ['src/views/checkout/index'] },
    blobs: {
      [pageBlob]: {
        lang: 'Vue',
        symbols: [],
        outline: ['OrderSummary'],
        pages: [{ convention: 'views', page: 'src/views/checkout/index' }],
        imports: ['src/components/OrderSummary.vue'],
      },
      [apiBlob]: { lang: 'JavaScript', symbols: ['createCheckout', 'payByCard'], outline: [], pages: [], imports: [] },
      [payBlob]: { lang: 'JavaScript', symbols: ['payWithChannel'], outline: [], pages: [], imports: [] },
      [miscBlob]: { lang: 'JavaScript', symbols: ['formatDate'], outline: [], pages: [], imports: [] },
    },
    files: {
      'src/views/checkout/index.vue': pageBlob,
      'src/api/checkout.js': apiBlob,
      'src/utils/pay.js': payBlob,
      'src/utils/format.js': miscBlob,
    },
    generated: {},
    sizes: {
      'src/views/checkout/index.vue': 4200,
      'src/api/checkout.js': 900,
      'src/utils/pay.js': 400,
      'src/utils/format.js': 300,
    },
    changes: {
      'src/views/checkout/index.vue': '2026-01-02T09:00:00+08:00',
      'src/api/checkout.js': '2025-12-20T09:00:00+08:00',
    },
    changesWindow: 200,
  }
}

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'repo-truth-material-'))
  const previous = process.env.REPO_TRUTH_HOME
  process.env.REPO_TRUTH_HOME = home
  try {
    await mkdir(join(home, 'index'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'index', 'fixture-shop.json'), `${JSON.stringify(fixtureIndex())}\n`, { mode: 0o600 })
    return await run(home)
  } finally {
    if (previous === undefined) delete process.env.REPO_TRUTH_HOME
    else process.env.REPO_TRUTH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  }
}

async function build(question) {
  return withHome(async () => {
    const index = await readRepoIndex('fixture-shop')
    const answer = await askQuestion({ question, repos: [{ name: 'fixture-shop' }], onlyRepo: 'fixture-shop' })
    const rendered = await buildMaterialHtml({
      repoName: 'fixture-shop',
      index,
      answer,
      config: { attribution: true },
      generatedAt: '2026-11-09',
    })
    return { index, answer, rendered }
  })
}

test('节点只来自命中的代码：页面一个节点、没有页面的模块一个节点', async () => {
  const { rendered } = await build('结算与支付页是怎么做的？')
  assert.equal(rendered.found, true)
  assert.equal(rendered.plan.nodes.length, 3, '一个页面 + 两个模块区（src/api、src/utils）')
  assert.deepEqual(
    rendered.plan.nodes.map((node) => node.kind),
    ['page', 'backend', 'backend'],
  )
  assert.equal(rendered.plan.nodes[0].id, 'page-checkout')
  assert.ok(rendered.plan.nodes[0].rows.every((row) => row.page === 'src/views/checkout/index'))
  assert.ok(rendered.plan.nodes.slice(1).every((node) => node.rows.every((row) => row.page === null)))
  assert.deepEqual(rendered.plan.nodes.slice(1).map((node) => node.area).sort(), ['src/api', 'src/utils'])
})

test('没命中就不生成三栏页：正文说没找到，且完全没有流程', async () => {
  const { rendered } = await build('优惠券核销与发票开具')
  assert.equal(rendered.found, false)
  assert.equal(rendered.plan.nodes.length, 0)
  assert.equal(rendered.html.includes('没能在已索引的代码里找到与「优惠券核销与发票开具」相关的地方'), true)
  for (const marker of ['class="layout"', 'data-node=', 'data-flowspec', 'data-seqspec', 'fp-title']) {
    assert.equal(rendered.html.includes(marker), false, `没命中时不该出现 ${marker}`)
  }
})

test('没有页面的节点必须出时序图，且中间栏不是伪造的页面', async () => {
  const { rendered } = await build('结算与支付页是怎么做的？')
  const html = rendered.html
  const backend = rendered.plan.nodes.find((node) => node.kind === 'backend')
  const page = rendered.plan.nodes.find((node) => node.kind === 'page')

  assert.ok(html.includes(`id="${backend.frameId}"`), '中间栏必须有这个节点的容器')
  assert.equal(html.includes('data-seqspec="1"'), true)
  assert.equal(html.includes('时序骨架'), true)
  assert.equal(html.includes('不是从代码里读出来的流程'), true)
  // 有编号的消息：1. 2. 3. …
  assert.equal(/1\. 发起/.test(html), true)
  assert.equal(/2\. /.test(html), true)

  const pageFragment = new RegExp(`id="${page.frameId}"`).test(html)
  assert.equal(pageFragment, true)
  assert.equal(html.includes('这个页面由这些模块组成'), true)
  assert.equal(html.includes('OrderSummary'), true, '页面里读到的组件要出现在结构卡里')
  // 页面节点里不许出现时序图：中间栏是哪一种内容，由节点类型决定
  const pageStart = html.indexOf(`id="${page.frameId}"`)
  const nextPage = html.indexOf('<div class="page"', pageStart)
  const pageBlock = html.slice(pageStart, nextPage === -1 ? undefined : nextPage)
  assert.equal(pageBlock.includes('data-seqspec'), false)
})

test('时序参与者是封闭词表：词表外的名字直接抛错，产物里也只有词表内的列', async () => {
  assert.throws(
    () => renderSequenceSvg({ participants: ['用户', '数据库'], messages: [{ from: '用户', to: '数据库', text: '查询' }] }),
    /不在封闭词表里/,
  )
  assert.throws(
    () => renderSequenceSvg({ participants: ['用户', 'getUserById'], messages: [] }),
    /不在封闭词表里/,
  )
  const { rendered } = await build('结算与支付页是怎么做的？')
  const names = [...rendered.html.matchAll(/class="seq-pname"[^>]*>([^<]+)</g)].map((match) => match[1])
  assert.ok(names.length >= 2)
  for (const name of names) assert.ok(SEQ_PARTICIPANTS.includes(name), `参与者 ${name} 不在词表内`)
  assert.equal(names.includes('支付渠道'), true, '名字里出现支付词时才该画出这一列')
  // 图上不许出现方法名：符号名一个都不许出现（研发参考已删，没有出口）
  assert.equal(/payByCard|createCheckout|payWithChannel/.test(rendered.html), false, '方法名不许出现在产物里')
})

test('三栏是能点的：节点带 data-node，页面与标注容器由同一段 JS 切换', async () => {
  const { rendered } = await build('结算与支付页是怎么做的？')
  const html = rendered.html
  for (const node of rendered.plan.nodes) {
    assert.ok(html.includes(`data-node="${node.id}"`), `节点 ${node.id} 缺少 data-node`)
    assert.ok(html.includes(`id="${node.frameId}"`), `节点 ${node.id} 缺少中间栏容器`)
  }
  assert.ok(html.includes('id="anno-body"'), '右栏标注容器必须有 id=anno-body')
  assert.ok(html.includes('class="page"'), '中间栏每个节点一个 .page')
  assert.ok(html.includes('function setViewByNode'), '切换函数必须存在')
  assert.ok(html.includes('.flow-svg g[data-node]') && html.includes('addEventListener("click"'), '节点必须绑定点击')
  const nodesJson = JSON.parse(/var NODES = (\{[\s\S]*?\});\n/.exec(html)[1])
  assert.deepEqual(Object.keys(nodesJson).sort(), rendered.plan.nodes.map((node) => node.id).sort())
  for (const node of rendered.plan.nodes) {
    const entry = nodesJson[node.id]
    assert.equal(entry.page, node.frameId)
    assert.equal(Array.isArray(entry.anno) && entry.anno.length > 0, true)
    assert.equal(entry.anno.at(-1)[0], '待研发确认（未证实）')
  }
})

test('深链 #node= 与 #node=…&state= 都在产物里（headless 截图靠它停在不同节点）', async () => {
  const { rendered } = await build('结算与支付页是怎么做的？')
  const html = rendered.html
  assert.ok(html.includes('location.hash'))
  assert.ok(html.includes('hashQuery.node'))
  assert.ok(html.includes('hashQuery.state'))
  assert.ok(html.includes('NODES[id].state === wanted'))
  assert.ok(html.includes('setViewByNode(NODES[initNode] ? initNode : "page-checkout")'))
})

test('署名与生成器 meta：页脚可关、meta 永远在，页面上只有这一行署名', async () => {
  const { rendered } = await build('结算与支付页是怎么做的？')
  assert.equal(/<meta name="generator" content="repotruth v[^"]+">/.test(rendered.html), true)
  assert.ok(rendered.html.includes('<footer>由 repotruth 生成'))
  // 署名是唯一的「关于这份材料」的可见文字：限界框与研发参考都不再渲染。
  for (const gone of ['这份材料读到哪、没读到哪', '没找到 ≠ 不存在', '研发参考', 'fixture-shop:src/views/checkout/index.vue']) {
    assert.equal(rendered.html.includes(gone), false, `${gone} 应该已经删掉`)
  }
  // 页脚在最后：三栏之后，页面最底部。
  assert.ok(rendered.html.indexOf('<footer>') > rendered.html.indexOf('class="layout"'))

  await withHome(async () => {
    const index = await readRepoIndex('fixture-shop')
    const answer = await askQuestion({ question: '结算与支付页是怎么做的？', repos: [{ name: 'fixture-shop' }], onlyRepo: 'fixture-shop' })
    const quiet = await buildMaterialHtml({ repoName: 'fixture-shop', index, answer, config: { attribution: false }, generatedAt: '2026-11-09' })
    assert.equal(quiet.html.includes('<footer>'), false, '关掉署名就不该有页脚')
    assert.equal(/<meta name="generator"/.test(quiet.html), true, 'meta 不跟着关')
  })
})

test('正文只有产品语言：路径、后缀、驼峰标识符命中数必须是 0', async () => {
  const { rendered } = await build('结算与支付页是怎么做的？')
  assert.deepEqual(productBodyViolations(rendered.html), [])
  assert.doesNotThrow(() => assertProductLanguage(rendered.html))
})

test('命令行入口写盘：命中写三栏页，没命中只写说明页且退出可判', async () => {
  await withHome(async (home) => {
    const outDir = join(home, 'out')
    const hit = await runMaterial({ repo: 'fixture-shop', question: '结算与支付页是怎么做的？', out: outDir, quiet: true })
    assert.equal(hit.found, true)
    assert.equal(hit.nodes.length, 3)
    const written = await readFile(hit.outPath, 'utf8')
    assert.equal(written.includes('class="layout"'), true)
    assert.ok(hit.outPath.endsWith('fixture-shop-walkthrough.html'))

    const miss = await runMaterial({ repo: 'fixture-shop', question: '优惠券核销与发票开具', out: outDir, quiet: true })
    assert.equal(miss.found, false)
    const missHtml = await readFile(miss.outPath, 'utf8')
    assert.equal(missHtml.includes('class="layout"'), false)
    assert.equal(missHtml.includes('没能在已索引的代码里找到'), true)
  })
})

test('面板入口的后端：POST /materials 生成并可 GET 打开同一份文件', async () => {
  await withHome(async (home) => {
    // 登记表要让宿主认为这个仓已接入；索引已在 withHome 里写好。
    await writeFile(
      join(home, 'repos.json'),
      JSON.stringify({ version: 1, repos: [{ name: 'fixture-shop', url: 'https://git.example.com/shop.git', status: 'ok', head: 'a'.repeat(40), headDate: '2026-01-05T10:00:00+08:00', pages: 1 }] }),
      { mode: 0o600 },
    )
    const { apply } = await import('../lib/index.js')
    let route = null
    apply({
      logger: { warn() {} },
      effect(fn) {
        return fn()
      },
      webServer: {
        register(spec) {
          route = spec
          return () => {}
        },
      },
    })
    const call = async (method, sub, body) => {
      const { EventEmitter } = await import('node:events')
      const req = new EventEmitter()
      req.method = method
      req.url = `/api/repo-truth${sub}`
      req.destroy = () => {}
      process.nextTick(() => {
        if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
        req.emit('end')
      })
      const res = {
        code: null,
        body: '',
        writeHead(code) {
          this.code = code
        },
        end(chunk) {
          this.body = chunk ?? ''
        },
      }
      await route.handler(req, res)
      return { code: res.code, text: res.body }
    }

    const made = await call('POST', '/materials', { repo: 'fixture-shop', question: '结算与支付页是怎么做的？' })
    assert.equal(made.code, 200, made.text)
    const payload = JSON.parse(made.text)
    assert.equal(payload.found, true)
    assert.equal(payload.nodes.length, 3)
    assert.equal(payload.url.includes('/materials/'), true)
    for (const node of payload.nodes) assert.equal(node.deepLink, `${payload.url}#node=${node.id}`)
    assert.equal(payload.stats.files, 4)
    assert.equal(payload.stats.snapshotDay, '2026-01-05')

    const opened = await call('GET', payload.url.replace('/api/repo-truth', ''))
    assert.equal(opened.code, 200)
    assert.equal(opened.text.includes('class="layout"'), true)

    // 没命中：明确说没找到，且不给任何 URL（面板不会打开空的三栏页）
    const missed = await call('POST', '/materials', { repo: 'fixture-shop', question: '优惠券核销与发票开具' })
    const missedPayload = JSON.parse(missed.text)
    assert.equal(missedPayload.found, false)
    assert.equal(missedPayload.url, null)
    assert.equal(missedPayload.message.includes('没能在已索引的代码里找到'), true)
  })
})

test('没有索引 ≠ 没找到：仓没索引时直接报「还没有索引」', async () => {
  await assert.rejects(() => runMaterial({ repo: 'not-indexed', question: '结算页', quiet: true }), /还没有「not-indexed」的索引/)
})
