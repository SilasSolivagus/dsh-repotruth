// 宿主侧端到端：接入 → 子进程克隆 → 建索引 → 登记表 / 覆盖率表。
//
// 这里必须用真的子进程，不能 mock：要验证的正是「克隆与索引没跑在宿主进程里」。
// 用 file:// 的本地合成仓，所以这条链路不依赖外网，跑在 CI 里也成立。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { apply, flushPersistence } from '../lib/index.js'
import { startJob } from '../lib/jobs.js'

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

function capture() {
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
  const call = async (method, sub, body) => {
    const res = mockRes()
    await route.handler(mockReq(method, `/api/repo-truth${sub}`, body), res)
    let json = null
    try {
      json = JSON.parse(res.body)
    } catch {
      json = null
    }
    return { code: res.code, json, text: res.body }
  }
  return call
}

async function makeRepo(name) {
  const base = await mkdtemp(join(tmpdir(), 'repo-truth-flow-'))
  const dir = join(base, name)
  await mkdir(join(dir, 'src/views/login'), { recursive: true })
  await mkdir(join(dir, 'src/components'), { recursive: true })
  await writeFile(join(dir, 'src/views/login/index.vue'), '<template><LoginForm /></template>\n', 'utf8')
  await writeFile(join(dir, 'src/components/LoginForm.vue'), '<template><form /></template>\n', 'utf8')
  await writeFile(join(dir, 'src/utils.ts'), 'export function tip() { return 1 }\n', 'utf8')
  await writeFile(join(dir, 'README.md'), '# fixture\n', 'utf8')
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@e.com', ...args], { cwd: dir, stdio: 'ignore' })
  git('init', '--quiet', '-b', 'main')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'init')
  return { base, dir }
}

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'repo-truth-home-'))
  const previous = process.env.REPO_TRUTH_HOME
  process.env.REPO_TRUTH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.REPO_TRUTH_HOME
    else process.env.REPO_TRUTH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  })
  return home
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询 /jobs 直到这个仓没有在跑的任务，并且登记表已经落盘。
 *
 * 为什么连落表一起等：落表是任务结束时异步做的（宿主不做同步写）。
 * 测试如果只等任务状态，就会在「还没写盘」的空档里清理临时目录，
 * 结果后面的写入落到默认数据目录里 —— 这正是它第一次运行时发生的事。
 */
async function waitJob(call, repo, timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    const jobs = await call('GET', `/jobs?repo=${encodeURIComponent(repo)}`)
    const job = jobs.json.jobs?.[0] ?? null
    if (job !== null && job.status !== 'running') {
      await waitPersisted(call, repo, job.status)
      return job
    }
    if (Date.now() - started > timeoutMs) throw new Error(`等待 ${repo} 的任务超时`)
    await sleep(120)
  }
}

async function waitPersisted(call, repo, status) {
  const wanted = status === 'done' ? 'ok' : 'failed'
  const deadline = Date.now() + 10_000
  for (;;) {
    const repos = await call('GET', '/repos')
    const row = repos.json.repos?.find((item) => item.name === repo)
    if (row !== undefined && row.status === wanted) return row
    if (Date.now() > deadline) throw new Error(`等待 ${repo} 落表超时（当前状态 ${row?.status}）`)
    await sleep(80)
  }
}

test('接入一个仓：克隆、建索引、登记表与覆盖率表都落到真数据', async (t) => {
  await withHome(t)
  const fixture = await makeRepo('fixture-shop')
  t.after(async () => rm(fixture.base, { recursive: true, force: true }))
  const call = capture()

  const added = await call('POST', '/repos', { url: `file://${fixture.dir}` })
  assert.equal(added.code, 200, added.text)
  assert.equal(added.json.ok, true)
  const name = added.json.repo.name
  assert.equal(name, 'fixture-shop', '仓名从地址末段推导')

  const job = await waitJob(call, name)
  assert.equal(job.status, 'done', job.error ?? '')
  assert.equal(job.result.counts.indexed, 4)
  assert.equal(job.result.pages, 1)

  const repos = await call('GET', '/repos')
  const row = repos.json.repos.find((item) => item.name === name)
  assert.equal(row.status, 'ok')
  assert.equal(row.head.length, 40)
  assert.equal(row.counts.total, 4)
  assert.ok(existsSync(row.mirrorPath), '本机镜像必须真的在')
  assert.ok(existsSync(row.indexPath), '索引文件必须真的在')
  assert.match(row.mirrorPath, /mirrors\/fixture-shop\.git$/)

  // 覆盖率表来自这次真实索引，不是 fixture 文件。
  const coverage = await call('GET', '/coverage')
  assert.equal(coverage.json.present, true)
  assert.equal(coverage.json.repos.length, 1)
  const coverRow = coverage.json.repos[0]
  assert.equal(coverRow.repo, name)
  assert.equal(coverRow.filesTotal, 4)
  assert.equal(coverRow.filesIndexed, 4)
  assert.equal(coverRow.pages, 1)
  assert.equal(coverRow.ok, true)

  // 索引文件结构就是契约里那份形状。
  const document = JSON.parse(await readFile(row.indexPath, 'utf8'))
  assert.equal(typeof document.head, 'string')
  assert.equal(typeof document.indexedAt, 'string')
  assert.ok(Object.keys(document.blobs).length > 0)
  assert.ok(Object.keys(document.files).length > 0)
  const firstBlob = document.blobs[Object.keys(document.blobs)[0]]
  for (const key of ['lang', 'symbols', 'outline', 'pages']) {
    assert.ok(Object.prototype.hasOwnProperty.call(firstBlob, key), `内容块里必须有 ${key}`)
  }
})

test('同一个 HEAD 再同步一次：任务结果里解析 0 个内容块', async (t) => {
  await withHome(t)
  const fixture = await makeRepo('fixture-shop')
  t.after(async () => rm(fixture.base, { recursive: true, force: true }))
  const call = capture()

  const added = await call('POST', '/repos', { url: `file://${fixture.dir}` })
  const name = added.json.repo.name
  const first = await waitJob(call, name)
  assert.equal(first.status, 'done')
  assert.ok(first.result.parsedBlobs > 0)

  const synced = await call('POST', '/repos/sync', { name })
  assert.equal(synced.code, 200, synced.text)
  const second = await waitJob(call, name)
  assert.equal(second.status, 'done')
  assert.equal(second.result.parsedBlobs, 0, '第二遍必须 0 解析')
  assert.equal(second.result.reusedBlobs, first.result.counts.indexed)
})

test('克隆失败要给中文原因，且失败也要出现在覆盖率表里', async (t) => {
  await withHome(t)
  const call = capture()
  const added = await call('POST', '/repos', { url: 'file:///definitely/not/here/fixture-broken' })
  assert.equal(added.code, 200, added.text)
  const job = await waitJob(call, added.json.repo.name)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /克隆失败/)
  assert.match(job.error, /找不到这个仓库|认证失败|域名解析失败|连接超时/, '必须给出中文原因，而不是一段英文栈')
  assert.doesNotMatch(job.error, /fatal:|Could not read from remote/)

  const coverage = await call('GET', '/coverage')
  const row = coverage.json.repos.find((item) => item.repo === added.json.repo.name)
  assert.ok(row, '失败仓不能从表里消失')
  assert.equal(row.ok, false)
  assert.ok(typeof row.error === 'string' && row.error.length > 0)
})

test('同一个仓不能并发同步：第二个请求要给出中文拒绝', async (t) => {
  await withHome(t)
  const fixture = await makeRepo('fixture-shop')
  t.after(async () => rm(fixture.base, { recursive: true, force: true }))
  const call = capture()
  const added = await call('POST', '/repos', { url: `file://${fixture.dir}` })
  const name = added.json.repo.name
  const again = await call('POST', '/repos/sync', { name })
  assert.equal(again.code, 409, again.text)
  assert.match(again.json.error, /正在同步中/)
  await waitJob(call, name)
})

test('任务超时会杀掉子进程并给出中文原因（宿主不被拖住）', async (t) => {
  // 用一个「永远不返回」的 git 垫片：模拟网络卡死、凭据提示挂住这类真实故障。
  const shimDir = await mkdtemp(join(tmpdir(), 'repo-truth-shim-'))
  const shim = join(shimDir, 'git')
  await writeFile(shim, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${shimDir}:${previousPath}`
  const previousHome = process.env.REPO_TRUTH_HOME
  const home = await mkdtemp(join(tmpdir(), 'repo-truth-home-'))
  process.env.REPO_TRUTH_HOME = home
  t.after(async () => {
    process.env.PATH = previousPath
    if (previousHome === undefined) delete process.env.REPO_TRUTH_HOME
    else process.env.REPO_TRUTH_HOME = previousHome
    await rm(shimDir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  })

  const startedAt = Date.now()
  const started = startJob({
    repo: 'hang-demo',
    url: 'file:///tmp/nothing',
    hardTimeoutMs: 1200,
  })
  assert.equal(started.ok, true)
  // 关键断言：startJob 立刻返回，宿主没有等克隆。
  assert.ok(Date.now() - startedAt < 500, 'startJob 必须立刻返回')

  const deadline = Date.now() + 15_000
  let job = started.job
  while (job.status === 'running' && Date.now() < deadline) {
    await sleep(100)
  }
  assert.equal(job.status, 'failed')
  assert.match(job.error, /超时/)
  assert.ok(job.elapsedMs < 10_000, '到点就该被杀，不能等到 git 自己退')
  // 等落表链清空，避免测试结束后还有写入落到默认数据目录。
  await flushPersistence()
})
