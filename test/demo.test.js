// demo 命令的端到端测试。
//
// 为什么用本地 git 仓当「公开仓」：测试不能依赖外网。file:// 地址走的是同一条
// git clone --depth 1 路径，所以这里验证的是真实链路，不是 mock。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { looksLikeGitUrl, repoSlug, runDemo } from '../lib/demo.js'
import { parseArgs } from '../bin/dsh-plugin-repo-truth.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 造一个最小的「前端仓」：有 app 路由、有复用模块、有一个读不懂的扩展名。 */
async function makeFixtureRepo() {
  const base = await mkdtemp(join(tmpdir(), 'repo-truth-fixture-'))
  // 目录名就是仓库名：demo 的文件名从地址末段推，这样测试能断言到具体文件名。
  const dir = join(base, 'fixture-app')
  await mkdir(dir, { recursive: true })
  const write = async (rel, body) => {
    const full = join(dir, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body, 'utf8')
  }
  await write('package.json', JSON.stringify({ name: 'fixture-app', version: '1.0.0' }, null, 2))
  await write('app/page.tsx', "import NameTag from '../src/components/NameTag'\nexport default () => <NameTag />\n")
  await write('app/dashboard/page.tsx', "import NameTag from '../../src/components/NameTag'\nexport default () => <NameTag />\n")
  await write('app/(auth)/login/page.tsx', 'export default () => null\n')
  await write('src/components/NameTag.tsx', 'export default function NameTag() { return null }\n')
  await write('src/components/Button.tsx', 'export default function Button() { return null }\n')
  await write('src/components/index.ts', "export * from './NameTag'\n")
  await write('src/styles/app.css', 'body { margin: 0 }\n')
  await write('native/Widget.swift', 'import Foundation\n')
  await write('tools/opaque.weirdthing', 'not a language we know\n')
  await write('README.md', '# fixture\n')

  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: dir, stdio: 'ignore' })
  git('init', '--quiet', '-b', 'main')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'fixture: 初始提交')
  return dir
}

test('地址识别与文件名推导', () => {
  assert.equal(looksLikeGitUrl('https://github.com/a/b.git'), true)
  assert.equal(looksLikeGitUrl('git@github.com:a/b.git'), true)
  assert.equal(looksLikeGitUrl('/tmp/whatever'), true)
  assert.equal(looksLikeGitUrl('随便一句话'), false)
  assert.equal(looksLikeGitUrl(''), false)
  assert.equal(repoSlug('https://github.com/PanJiaChen/vue-admin-template.git'), 'vue-admin-template')
  assert.equal(repoSlug('git@github.com:a/b.git'), 'b')
})

test('CLI 参数解析：只认 demo 和两个开关', () => {
  assert.deepEqual(parseArgs(['demo', 'https://x/y.git']), {
    command: 'demo',
    url: 'https://x/y.git',
    out: null,
    attribution: undefined,
    keepTemp: false,
    quiet: false,
    help: false,
    version: false,
  })
  assert.equal(parseArgs(['demo', 'u', '--out', 'dir']).out, 'dir')
  assert.equal(parseArgs(['demo', 'u', '--out=dir']).out, 'dir')
  assert.equal(parseArgs(['demo', 'u', '--no-attribution']).attribution, false)
  assert.equal(parseArgs(['demo', 'u', '--keep-temp']).keepTemp, true)
  assert.throws(() => parseArgs(['demo', 'u', '--wat']), /不认识的选项/)
})

test('demo 跑通本地仓：输出页有正文、限界、meta 与页脚', async (t) => {
  const fixture = await makeFixtureRepo()
  const outDir = await mkdtemp(join(tmpdir(), 'repo-truth-out-'))
  t.after(async () => {
    await rm(fixture, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  })

  const result = await runDemo({ url: `file://${fixture}`, out: outDir, quiet: true, generatedAt: '2026-01-01' })
  assert.ok(existsSync(result.outPath), '必须真的写出文件')
  assert.match(result.outPath, /fixture-app-status\.html$/, '文件名来自仓库名')

  const html = await readFile(result.outPath, 'utf8')
  assert.ok(html.includes(`<meta name="generator" content="repo-truth v${pkg.version}">`))
  assert.ok(html.includes('<footer>由 repo-truth 生成 · '), '默认带页脚')
  assert.ok(html.includes('这份材料读到哪、没读到哪'), '页面上必须写清自己的限界')
  assert.ok(html.includes('native/Widget.swift') || html.includes('Swift'), '读不懂的语言要报出来')
  assert.ok(result.facts.pages.items.includes('/dashboard'), 'app/**/page.* 要认出页面')
  assert.ok(result.facts.pages.items.includes('/login'), '路由分组目录要剥掉')
  assert.ok(result.seconds > 0)
})

test('attribution:false：页脚消失，meta 保留', async (t) => {
  const fixture = await makeFixtureRepo()
  const outDir = await mkdtemp(join(tmpdir(), 'repo-truth-out-'))
  t.after(async () => {
    await rm(fixture, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  })

  const off = await runDemo({ url: `file://${fixture}`, out: outDir, quiet: true, attribution: false, generatedAt: '2026-01-01' })
  const html = await readFile(off.outPath, 'utf8')
  assert.ok(!html.includes('<footer>'))
  assert.ok(!html.includes('由 repo-truth 生成'))
  assert.ok(html.includes(`<meta name="generator" content="repo-truth v${pkg.version}">`))
})

test('克隆到临时目录并在结束后删掉（不在用户目录留垃圾）', async (t) => {
  const fixture = await makeFixtureRepo()
  const before = execFileSync('sh', ['-c', 'ls -d "$TMPDIR"repo-truth-demo-* 2>/dev/null | wc -l'], { encoding: 'utf8' }).trim()
  t.after(async () => {
    await rm(fixture, { recursive: true, force: true })
  })
  const outDir = await mkdtemp(join(tmpdir(), 'repo-truth-out-'))
  t.after(async () => rm(outDir, { recursive: true, force: true }))

  await runDemo({ url: `file://${fixture}`, out: outDir, quiet: true, generatedAt: '2026-01-01' })
  const after = execFileSync('sh', ['-c', 'ls -d "$TMPDIR"repo-truth-demo-* 2>/dev/null | wc -l'], { encoding: 'utf8' }).trim()
  assert.equal(after, before, '临时目录必须清干净')
})

test('CLI 真跑一遍：打印输出路径', () => {
  // 这条走真正的 bin，证明 npx dsh-plugin-repo-truth demo … 那条路是通的。
  const fixture = execFileSync('sh', ['-c', 'mktemp -d'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: fixture })
  execFileSync('sh', ['-c', 'echo "# hi" > README.md && mkdir -p app/x && echo "export default 1" > app/x/page.ts'], { cwd: fixture })
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@e.com', 'add', '-A'], { cwd: fixture })
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@e.com', 'commit', '--quiet', '-m', 'init'], { cwd: fixture })
  const out = execFileSync('node', [join(root, 'bin/dsh-plugin-repo-truth.js'), 'demo', `file://${fixture}`, '--quiet', '--out', join(fixture, 'out')], { encoding: 'utf8' })
  const printed = out.trim().split('\n').pop()
  assert.match(printed, /-status\.html$/)
  assert.ok(existsSync(printed), `打印出来的路径必须存在：${printed}`)
  execFileSync('rm', ['-rf', fixture])
})
