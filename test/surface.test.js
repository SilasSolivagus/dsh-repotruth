// 界面表面（surface）的纪律测试。
//
// 守的不是「有没有字符串」，而是三个决定用户在哪儿操作的事实：
// 输入框右边一个 chip、右边缘一个配置面板、设置里只剩「代码源」。
// 一旦有人把 chip 挪回对话页签、或者让面板自己长出需求输入框，
// 界面上都会「一切正常，只是没人找得到」。这种坏法不报错，只能靠测试拦住。
//
// 做法：把浏览器半边丢进假的 module loader 里执行（它顶层只调
// window.__ModuleLoader__.load），用一份假的 React + 假的 ctx 收集注册结果，
// 断言的是真的 apply()，不是源码里的字符串。
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 够用的 React 假体：apply() 只注册组件，不会渲染，所以 hook 只需要撑住取值。 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
}

/** 执行浏览器半边，返回 { exports, registrations }（registrations 是 { definition, component }）。 */
function loadClient() {
  const text = readFileSync(join(root, 'lib/client.js'), 'utf8')
  let spec = null
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: { hidden: true },
    window: { __ModuleLoader__: { load: (value) => { spec = value } } },
  }
  sandbox.window.document = sandbox.document
  vm.runInNewContext(text, sandbox, { filename: 'client.js' })
  assert.ok(spec !== null, '浏览器半边没有调用 window.__ModuleLoader__.load')
  const moduleExports = spec.factory((id) => {
    if (id === 'react') return fakeReact()
    throw new Error(`unexpected require: ${id}`)
  })
  const registrations = []
  const ctx = {
    locale: {
      // bind 走真的词典：测试要断言的是「界面上会出现哪几个字」，不是 key 名。
      bind: () => (key) => moduleExports.zh?.[key] ?? key,
      register: () => () => {},
    },
    effect: (fn) => fn(),
    slots: {
      inject: (_name, callback) => callback(),
      register: (definition, component) => {
        registrations.push({ definition, component })
        return () => {}
      },
    },
  }
  moduleExports.apply(ctx)
  return { moduleExports, registrations }
}

function names(registrations) {
  return registrations.map((row) => row.definition.name)
}

test('输入框右侧有 repotruth 的 chip（conversation.input.right）', () => {
  const { registrations } = loadClient()
  const chip = registrations.find((row) => row.definition.name === 'conversation.input.right')
  assert.ok(chip !== undefined, '输入框右侧没有 chip：开关又丢了')
  assert.equal(chip.definition.id, 'repo-truth-chip')
  const tree = chip.component({})
  assert.equal(tree.type, 'button')
  assert.equal(tree.children[0], 'repotruth')
  assert.equal(tree.props['data-repotruth-chip'], '')
})

test('配置面板挂在 shell.overlay，且没有对话页签', () => {
  const { registrations } = loadClient()
  const panel = registrations.find((row) => row.definition.name === 'shell.overlay')
  assert.ok(panel !== undefined, '整页浮层里没有配置面板')
  assert.equal(panel.definition.id, 'repo-truth-panel')
  assert.equal(names(registrations).includes('conversation.view'), false, 'conversation.view 页签必须已经去掉')
})

test('设置里只剩「代码源」一个分区（一个面只留一个入口）', () => {
  const { registrations } = loadClient()
  const sections = registrations.filter((row) => row.definition.name === 'settings.section')
  const labels = sections.map((row) => row.definition.label())
  assert.deepEqual(labels, ['代码源'], `设置分区应该只剩代码源，实际 ${JSON.stringify(labels)}`)
})

test('表面一共三处，不多不少', () => {
  const { registrations } = loadClient()
  assert.deepEqual(names(registrations).sort(), ['conversation.input.right', 'settings.section', 'shell.overlay'])
})

test('面板里没有需求输入框：需求只从聊天框来', () => {
  const text = readFileSync(join(root, 'lib/client.js'), 'utf8')
  for (const gone of ['要问的需求', '生成走查材料', 'walkPlaceholder', 'askPlaceholder', 'conversation.view']) {
    assert.equal(text.includes(gone), false, `已经删掉的东西又回来了：${gone}`)
  }
})

// ── 宿主半边：材料生成后打开默认浏览器 ──────────────────────────────────────

function recordSpawn() {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { unref() {} }
  }
  return { calls, spawn }
}

test('打开浏览器的命令按平台拼：darwin / linux / win32', async () => {
  const { browserOpenPlan } = await import('../lib/open-external.js')
  const url = 'http://127.0.0.1:60555/api/repo-truth/materials/abc123.html'
  assert.deepEqual(browserOpenPlan('darwin', url), { command: 'open', args: [url] })
  assert.deepEqual(browserOpenPlan('linux', url), { command: 'xdg-open', args: [url] })
  assert.deepEqual(browserOpenPlan('win32', url), { command: 'cmd', args: ['/c', 'start', '', url] })
})

test('openInBrowser：只放行本机 http(s)，并且真的按计划调用 spawn', async () => {
  const { openInBrowser } = await import('../lib/open-external.js')
  const ok = recordSpawn()
  const opened = await openInBrowser({ url: 'http://127.0.0.1:1/a.html', platform: 'darwin', spawn: ok.spawn })
  assert.equal(opened.ok, true)
  assert.deepEqual(ok.calls[0], { command: 'open', args: ['http://127.0.0.1:1/a.html'], options: { detached: true, stdio: 'ignore' } })

  // 外部地址、file://、命令拼接都不许交给系统命令。
  for (const bad of ['https://example.com/x', 'file:///etc/passwd', 'http://127.0.0.1:1/a.html; rm -rf ~', '']) {
    const calls = recordSpawn()
    const refused = await openInBrowser({ url: bad, platform: 'darwin', spawn: calls.spawn })
    assert.equal(refused.ok, false, `应当拒绝：${bad}`)
    assert.equal(calls.calls.length, 0, `被拒的地址不该 spawn：${bad}`)
  }
})

function fixtureIndex() {
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
      'sha-page': {
        lang: 'Vue',
        symbols: [],
        outline: ['OrderSummary'],
        pages: [{ convention: 'views', page: 'src/views/checkout/index' }],
        imports: ['src/components/OrderSummary.vue'],
      },
      'sha-api': { lang: 'JavaScript', symbols: ['createCheckout', 'payByCard'], outline: [], pages: [], imports: [] },
      'sha-pay': { lang: 'JavaScript', symbols: ['payWithChannel'], outline: [], pages: [], imports: [] },
      'sha-misc': { lang: 'JavaScript', symbols: ['formatDate'], outline: [], pages: [], imports: [] },
    },
    files: {
      'src/views/checkout/index.vue': 'sha-page',
      'src/api/checkout.js': 'sha-api',
      'src/utils/pay.js': 'sha-pay',
      'src/utils/format.js': 'sha-misc',
    },
    generated: {},
    sizes: {
      'src/views/checkout/index.vue': 4200,
      'src/api/checkout.js': 900,
      'src/utils/pay.js': 400,
      'src/utils/format.js': 300,
    },
    changes: { 'src/views/checkout/index.vue': '2026-01-02T09:00:00+08:00' },
    changesWindow: 200,
  }
}

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'repo-truth-surface-'))
  const previous = process.env.REPO_TRUTH_HOME
  process.env.REPO_TRUTH_HOME = home
  try {
    await mkdir(join(home, 'index'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'index', 'fixture-shop.json'), `${JSON.stringify(fixtureIndex())}\n`, { mode: 0o600 })
    await writeFile(
      join(home, 'repos.json'),
      JSON.stringify({
        version: 1,
        repos: [{ name: 'fixture-shop', url: 'https://git.example.com/shop.git', status: 'ok', head: 'a'.repeat(40), headDate: '2026-01-05T10:00:00+08:00', indexedAt: '2026-11-08T02:00:00.000Z', pages: 1 }],
      }),
      { mode: 0o600 },
    )
    return await run(home)
  } finally {
    if (previous === undefined) delete process.env.REPO_TRUTH_HOME
    else process.env.REPO_TRUTH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  }
}

test('一句中文需求 → 材料落盘 → 默认浏览器打开那一条绝对地址', async () => {
  await withHome(async (home) => {
    const { generateMaterialAndOpen } = await import('../lib/index.js')
    const calls = recordSpawn()
    const value = await generateMaterialAndOpen({
      question: '结算与支付页是怎么做的？',
      origin: 'http://127.0.0.1:60555',
      platform: 'darwin',
      spawn: calls.spawn,
    })
    assert.equal(value.ok, true)
    assert.equal(value.found, true)
    assert.equal(value.nodes, 3)
    assert.equal(value.opened, true)
    assert.match(value.url, /^http:\/\/127\.0\.0\.1:60555\/api\/repo-truth\/materials\/[a-z0-9-]+\.html$/)

    // 命令就是 `open <url>`，url 是最后一个参数（不拼 shell 字符串）。
    assert.equal(calls.calls.length, 1)
    assert.equal(calls.calls[0].command, 'open')
    assert.deepEqual(calls.calls[0].args, [value.url])

    // 材料真的在盘上，而且是 600：里面写着需求原文。
    const file = join(home, 'materials', `${value.materialId}.html`)
    assert.equal(statSync(file).size > 4000, true, '材料文件太小，可能没渲染出三栏')
    assert.equal(statSync(file).mode & 0o777, 0o600)

    // 回包里带地址：用户能重开、能转发。
    assert.equal(value.message.includes(value.url), true)
  })
})

test('没命中就不打开浏览器，也不回地址', async () => {
  await withHome(async () => {
    const { generateMaterialAndOpen } = await import('../lib/index.js')
    const calls = recordSpawn()
    const value = await generateMaterialAndOpen({
      question: '优惠券核销与发票开具',
      origin: 'http://127.0.0.1:60555',
      platform: 'darwin',
      spawn: calls.spawn,
    })
    assert.equal(value.found, false)
    assert.equal(value.opened, false)
    assert.equal(value.url, '')
    assert.equal(calls.calls.length, 0, '没命中就不该打开空页')
  })
})

function bootHost() {
  let route = null
  const tools = []
  let injected = null
  const origin = 'http://127.0.0.1:60555'
  const hostModule = {
    logger: { warn() {} },
    effect(fn) {
      return fn()
    },
    webServer: {
      getOrigin: () => origin,
      register(spec) {
        route = spec
        return () => {}
      },
    },
    inject(deps, callback) {
      injected = deps
      callback({
        tools: {
          register: (definition) => {
            tools.push(definition)
            return () => {}
          },
          // agent 面向的工具表（注册成功不等于模型看得到，预设还会再裁一次）。
          schemas: () => tools.map((definition) => ({ name: definition.name })),
        },
        webServer: { getOrigin: () => origin },
        effect: (fn) => fn(),
      })
    },
  }
  return { hostModule, tools: () => tools, injected: () => injected, route: () => route }
}

test('agent 工具 repotruth_material 挂上了，并且出现在 agent 面向的工具表里', async () => {
  // 这条走的是真 spawn：不关掉就会在跑测试时弹出浏览器窗口。
  process.env.REPO_TRUTH_NO_OPEN = '1'
  await withHome(async () => {
    const { apply } = await import('../lib/index.js')
    const host = bootHost()
    apply(host.hostModule)
    assert.deepEqual(host.injected(), ['tools'], '工具必须挂在 tools 服务上，且是可选注入')
    const tool = host.tools()[0]
    assert.equal(tool.name, 'repotruth_material')
    assert.deepEqual(tool.parameters.required, ['question'])
    assert.equal(tool.output.schema.required.includes('opened'), true)

    const value = await tool.execute({ question: '结算与支付页是怎么做的？' })
    assert.equal(value.found, true)
    assert.equal(typeof value.url, 'string')
    assert.equal(value.url.startsWith('http://127.0.0.1:60555/api/repo-truth/materials/'), true)
    assert.equal(value.opened, false, '测试环境不该真的去打开浏览器')
    assert.equal(value.message.includes('材料已生成'), true)
  }).finally(() => {
    delete process.env.REPO_TRUTH_NO_OPEN
  })
})

function mockReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

test('自检里能看到工具状态；POST /materials 仍然只出文件、不弹窗', async () => {
  await withHome(async () => {
    const { apply } = await import('../lib/index.js')
    const host = bootHost()
    apply(host.hostModule)
    const call = async (method, sub, body) => {
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
      await host.route().handler(mockReq(method, `/api/repo-truth${sub}`, body), res)
      return { code: res.code, json: JSON.parse(res.body) }
    }
    const health = await call('GET', '/health')
    assert.equal(health.json.tool, 'repotruth_material')
    assert.equal(health.json.toolInAgentList, true)

    const made = await call('POST', '/materials', { repo: 'fixture-shop', question: '结算与支付页是怎么做的？' })
    assert.equal(made.code, 200)
    assert.equal(made.json.found, true)

    // 路由侧不留任何「最新一份」指针：材料由工具的回包交给用户。
    const latest = await call('GET', '/latest')
    assert.equal(latest.code, 404)
  })
})
