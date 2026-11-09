// 纪律测试：开源仓库里不许出现内部标识；令牌不许出现在任何响应里；文件名与权限收口。
//
// 这几条的共同点：它们坏了不会有任何报错，只会悄悄泄漏或悄悄失效。
// 所以必须由测试拦住，而不是靠 code review 时的记性。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { apply } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('仓库里没有内部标识（开源前置条件）', () => {
  const banned = [/123pan/i, /flowers/i, /\bcorp\.internal\b/i, /gitlab\.company/i]
  const files = []
  const dirs = ['lib', 'bin', 'test', 'docs'].map((name) => join(root, name))
  for (const dir of dirs) {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // 本文件自己写着这些模式串，扫描时要跳过它，否则永远是红的。
      if (entry.name === 'discipline.test.js') continue
      if (entry.isFile() && /\.(js|md|json|yml)$/.test(entry.name)) files.push(join(dir, entry.name))
    }
  }
  files.push(join(root, 'README.md'), join(root, 'package.json'))
  const offenders = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of banned) {
      if (pattern.test(text)) offenders.push(`${relative(root, file)} ← ${pattern}`)
    }
  }
  assert.deepEqual(offenders, [], `这些文件里出现了内部标识：${offenders.join(', ')}`)
})

test('包名、模块 id、bundle 行三处必须一致（否则浏览器半边静默消失）', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-plugin-repotruth')
  assert.equal(pkg.repository.url, 'git+https://github.com/SilasSolivagus/dsh-repotruth.git')
  assert.equal(pkg.homepage, 'https://github.com/SilasSolivagus/dsh-repotruth')
  assert.deepEqual(Object.keys(pkg.bin), ['dsh-plugin-repotruth'])

  const host = await import('../lib/index.js')
  assert.equal(host.name, pkg.name, '宿主导出的 name 必须等于包名')

  const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
  assert.ok(client.includes(`id: '${pkg.name}'`), '浏览器半边的模块 id 必须等于包名')

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(pkg.name), 'bundle patch 里必须引用同一个包名')
})

test('浏览器半边能编译，且设置里只剩一个分区', () => {
  const text = readFileSync(join(root, 'lib/client.js'), 'utf8')
  // 只编译不执行：它顶层会用到 window，但语法错误必须在测试里就暴露。
  assert.doesNotThrow(() => new vm.Script(text, { filename: 'client.js' }))
  assert.ok(text.includes(`id: 'repo-truth-sources'`), '缺少设置分区 repo-truth-sources')
  for (const gone of ['repo-truth-repos', 'repo-truth-ask', 'repo-truth-coverage', 'repo-truth-walkthrough']) {
    assert.equal(text.includes(`id: '${gone}'`), false, `设置/页签入口 ${gone} 应该已经去掉`)
  }
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
    return { code: res.code, text: res.body }
  }
}

test('令牌只以掩码出现：任何响应里都没有明文', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'repo-truth-token-'))
  const previous = process.env.REPO_TRUTH_HOME
  process.env.REPO_TRUTH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.REPO_TRUTH_HOME
    else process.env.REPO_TRUTH_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
  })
  const call = capture()
  const token = 'glpat-SECRET-abcdef123456'
  const saved = await call('POST', '/hosts', {
    name: '示例代码平台',
    baseUrl: 'https://git.example.com',
    kind: 'gitlab',
    token,
  })
  assert.equal(saved.code, 200, saved.text)

  const responses = []
  for (const sub of ['/health', '/config', '/repos', '/coverage', '/jobs']) {
    responses.push((await call('GET', sub)).text)
  }
  for (const body of responses) {
    assert.equal(body.includes(token), false, '明文令牌出现在响应里')
    assert.equal(body.includes('SECRET'), false, '令牌片段出现在响应里')
  }

  // 配置文件权限必须是 600（同机其它账号读不到）。
  const mode = statSync(join(home, 'config.json')).mode & 0o777
  assert.equal(mode, 0o600, `config.json 权限应为 600，实际 ${mode.toString(8)}`)
  const dirMode = statSync(home).mode & 0o777
  assert.equal(dirMode, 0o700, `数据目录权限应为 700，实际 ${dirMode.toString(8)}`)
})

test('仓名会被白名单化：不会因为仓名里带路径就写到目录外面', async () => {
  const { safeName } = await import('../lib/paths.js')
  assert.equal(safeName('../../etc/passwd'), 'etc-passwd')
  assert.equal(safeName('a/b'), 'a-b')
  assert.equal(safeName('订单服务'), 'repo')
  assert.equal(safeName(''), 'repo')
  assert.ok(!safeName('x y').includes(' '))
})

test('索引与答案文件都不含可执行内容（只写 JSON / HTML）', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'repo-truth-files-'))
  t.after(async () => rm(home, { recursive: true, force: true }))
  const { writeJsonAtomic } = await import('../lib/indexer.js')
  const target = join(home, 'index', 'x.json')
  await writeJsonAtomic(target, { ok: 1 })
  assert.equal(JSON.parse(await readFile(target, 'utf8')).ok, 1)
  const mode = statSync(target).mode & 0o777
  assert.equal(mode, 0o600)
})

test('demo 仍然只做浅克隆：仓里没有留下工作区', async (t) => {
  // 回归：索引这一刀没有把 demo 的「读完即删」改成「留下来」。
  const fixture = await mkdtemp(join(tmpdir(), 'repo-truth-demo-regress-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src/a.ts'), 'export const a = 1\n', 'utf8')
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: fixture })
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@e.com', 'add', '-A'], { cwd: fixture })
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@e.com', 'commit', '--quiet', '-m', 'init'], { cwd: fixture })
  t.after(async () => rm(fixture, { recursive: true, force: true }))

  const outDir = await mkdtemp(join(tmpdir(), 'repo-truth-demo-out-'))
  t.after(async () => rm(outDir, { recursive: true, force: true }))
  const { runDemo } = await import('../lib/demo.js')
  const result = await runDemo({ url: `file://${fixture}`, out: outDir, quiet: true, generatedAt: '2026-01-01' })
  assert.equal(existsSync(result.tempRoot), false, 'demo 的临时目录必须仍然被清干净')
})
