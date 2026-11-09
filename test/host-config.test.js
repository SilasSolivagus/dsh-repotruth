// 宿主侧回归：attribution 必须能穿过「界面保存代码源」这一趟。
//
// 为什么值得一个测试：读配置时若把 attribution 丢掉，写回时就会把用户关掉的署名
// 悄悄打开，而这种 bug 只在企业现场出现，界面上看不出来。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../lib/index.js'
import { version } from '../lib/branding.js'

/** 起一个够用的假请求：能 emit data/end 就够了。 */
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

function mockRes() {
  return {
    code: null,
    body: '',
    writeHead(code) {
      this.code = code
    },
    end(chunk) {
      this.body = chunk ?? ''
    },
  }
}

/** 拿到插件注册的 handler，不启动真的 webServer。 */
function captureHandler() {
  let route = null
  const ctx = {
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
  }
  apply(ctx)
  assert.equal(route.path, '/api/repo-truth')
  return route.handler
}

async function call(handler, method, sub, body) {
  const res = mockRes()
  await handler(mockReq(method, `/api/repo-truth${sub}`, body), res)
  return { code: res.code, json: JSON.parse(res.body) }
}

test('自检接口暴露版本与署名状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'repo-truth-home-'))
  const previous = process.env.REPO_TRUTH_HOME
  process.env.REPO_TRUTH_HOME = dir
  t.after(async () => {
    if (previous === undefined) delete process.env.REPO_TRUTH_HOME
    else process.env.REPO_TRUTH_HOME = previous
    await rm(dir, { recursive: true, force: true })
  })

  const handler = captureHandler()
  const health = await call(handler, 'GET', '/health')
  assert.equal(health.code, 200)
  assert.equal(health.json.version, version())
  assert.equal(health.json.attribution, true, '没有配置文件时默认开')

  // 关掉署名后保存一条代码源，attribution 必须还在文件里。
  await writeFile(join(dir, 'config.json'), JSON.stringify({ version: 1, attribution: false, hosts: [] }), 'utf8')
  const saved = await call(handler, 'POST', '/hosts', {
    name: '示例代码平台',
    baseUrl: 'https://git.example.com',
    kind: 'gitlab',
    token: 'glpat-1234567890',
  })
  assert.equal(saved.code, 200)
  assert.equal(saved.json.attribution, false, '保存代码源不能把署名开关打开')
  const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
  assert.equal(onDisk.attribution, false, '写回的文件里必须保留 attribution:false')

  const afterEdit = await call(handler, 'GET', '/health')
  assert.equal(afterEdit.json.attribution, false)
})
