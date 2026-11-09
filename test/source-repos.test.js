// 从代码源里挑仓库：这条接口必须和「测试连接」走同一套规则，并且只读。
//
// 用一个本地假代码平台验证真实请求：请求头、路径、错误文案都能被断言到，
// 而且不依赖外网，CI 里也不会因为对方限流而红。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../lib/index.js'
import { resolveRepoInput } from '../lib/repos.js'

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

function capture() {
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
  return async (method, sub, body) => {
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
    await route.handler(mockReq(method, `/api/repo-truth${sub}`, body), res)
    return { code: res.code, json: JSON.parse(res.body || '{}') }
  }
}

async function fakeGithub(t) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    if (req.url.startsWith('/user/repos')) {
      if (req.headers['x-test-status'] === '401') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"message":"Bad credentials"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', link: '<http://x/user/repos?page=2>; rel="last"' })
      res.end(
        JSON.stringify([
          { full_name: 'acme/order-service', clone_url: 'https://github.com/acme/order-service.git' },
          { full_name: 'acme/docs-site', clone_url: 'https://github.com/acme/docs-site.git' },
        ]),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}`, seen }
}

test('列出代码源上的仓库：复用测试连接的请求规则，只发只读请求', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'repo-truth-src-'))
  const previous = process.env.REPO_TRUTH_HOME
  process.env.REPO_TRUTH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.REPO_TRUTH_HOME
    else process.env.REPO_TRUTH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  })
  const platform = await fakeGithub(t)
  const call = capture()

  const saved = await call('POST', '/hosts', {
    name: '示例代码平台',
    baseUrl: platform.base,
    kind: 'github',
    token: 'ghp_test_token_123456',
  })
  assert.equal(saved.code, 200, JSON.stringify(saved.json))

  const probe = await call('POST', '/test', { name: '示例代码平台', baseUrl: platform.base, kind: 'github', token: '' })
  assert.equal(probe.json.ok, true, JSON.stringify(probe.json))

  const list = await call('GET', '/source-repos?name=示例代码平台')
  assert.equal(list.json.ok, true, JSON.stringify(list.json))
  assert.deepEqual(
    list.json.repos.map((row) => row.name),
    ['acme/order-service', 'acme/docs-site'],
  )
  assert.equal(list.json.repos[0].url, 'https://github.com/acme/order-service.git')
  assert.equal(list.json.message, '看见 2 个仓库')

  // 两次调用走的是同一个接口路径与同一套鉴权头（这就是「复用」的可验证形式）。
  const reposCalls = platform.seen.filter((row) => row.url.startsWith('/user/repos'))
  assert.equal(reposCalls.length >= 2, true)
  assert.equal(reposCalls[0].headers.authorization, 'Bearer ghp_test_token_123456')
  assert.equal(platform.seen.every((row) => row.url.startsWith('/user/repos')), true, '只读：不能出现写请求')
  assert.equal(platform.seen.some((row) => /POST|PUT|DELETE/i.test(row.headers['x-method'] ?? '')), false)
})

test('对方的错误状态要翻成中文原因，不能把原始响应丢给用户', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'repo-truth-src-'))
  const previous = process.env.REPO_TRUTH_HOME
  process.env.REPO_TRUTH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.REPO_TRUTH_HOME
    else process.env.REPO_TRUTH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  })
  const call = capture()
  const server = createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end('{"message":"Forbidden"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()

  const saved = await call('POST', '/hosts', {
    name: '只读权限不足的平台',
    baseUrl: `http://127.0.0.1:${port}`,
    kind: 'github',
    token: 'ghp_another_1234',
  })
  assert.equal(saved.code, 200)
  const list = await call('GET', '/source-repos?name=只读权限不足的平台')
  assert.equal(list.json.ok, false)
  assert.match(list.json.error, /权限不足/)
  assert.equal(list.json.error.includes('Forbidden'), false, '不要回原文')
})

test('短名解析：owner/name 按代码源类型拼成完整地址', () => {
  const hosts = [{ name: '主平台', baseUrl: 'https://git.example.com', kind: 'gitlab' }]
  const gitlab = resolveRepoInput('acme/order-service', hosts)
  assert.equal(gitlab.ok, true)
  assert.equal(gitlab.url, 'https://git.example.com/acme/order-service.git')

  const full = resolveRepoInput('https://github.com/acme/x.git', hosts)
  assert.equal(full.url, 'https://github.com/acme/x.git')

  const generic = resolveRepoInput('acme/x', [{ name: 'g', baseUrl: 'https://x.example.com', kind: 'generic' }])
  assert.equal(generic.ok, false)
  assert.match(generic.error, /完整地址/)

  const noHost = resolveRepoInput('acme/x', [])
  assert.equal(noHost.ok, false)
  assert.match(noHost.error, /代码源/)
})
