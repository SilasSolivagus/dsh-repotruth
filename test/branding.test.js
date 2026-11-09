// 署名模块的测试。重点不是「有没有字符串」，而是三条会真的坏掉的行为：
// 默认开、显式关、meta 永远在，以及版本号只有一个来源。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  FALLBACK_REPO_URL,
  footerLine,
  isAttributionEnabled,
  metaTag,
  repoUrl,
  version,
} from '../lib/branding.js'
import { renderHtml } from '../lib/render.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 最小事实集：渲染层需要的键都齐，数字不重要。 */
function sampleFacts() {
  return {
    repoName: 'sample-repo',
    repoUrl: 'https://example.com/sample.git',
    snapshot: { date: '2025-01-01T00:00:00Z', subject: 'init' },
    files: { code: 3, assets: 1, unknown: 1, bytes: 4096 },
    languages: [
      { language: 'TypeScript', files: 3, bytes: 4096 },
      { language: 'CSS', files: 1, bytes: 512 },
    ],
    unknownExtensions: [{ ext: '.weird', files: 1 }],
    skippedDirs: ['node_modules'],
    pages: { convention: 'next-app-router', label: 'app/**/page.*', items: ['/home', '/detail'], others: [] },
    components: { dir: 'src/components', items: [{ name: 'NameTag', path: 'src/components/NameTag.tsx', usages: 2, bytes: 200 }], readFiles: 3, capped: false, unread: 0 },
    churn: { largest: [{ path: 'src/big.ts', bytes: 2048 }], commits: 1, mode: 'single-commit', items: [{ path: 'src/big.ts' }], note: '浅克隆只有 1 个提交' },
  }
}

test('默认带页脚：页脚一行包含项目地址与版本', () => {
  const html = renderHtml(sampleFacts(), { config: {}, generatedAt: '2026-01-01' })
  assert.match(html, /<footer>由 repo-truth 生成 · /)
  assert.ok(html.includes(`v${pkg.version}`), '页脚里应有版本号')
  assert.ok(html.includes(repoUrl()), '页脚里应有项目地址')
})

test('缺省配置（undefined）也带页脚：默认值不能依赖调用方记得传', () => {
  const html = renderHtml(sampleFacts(), { generatedAt: '2026-01-01' })
  assert.ok(html.includes('<footer>'), '没有配置时页脚必须还在')
})

test('attribution:false 时页脚消失，但 meta 标签保留', () => {
  const html = renderHtml(sampleFacts(), { config: { attribution: false }, generatedAt: '2026-01-01' })
  assert.ok(!html.includes('<footer>'), '关掉署名后不应有页脚')
  assert.ok(!html.includes('由 repo-truth 生成'), '关掉署名后不应出现署名句')
  assert.ok(html.includes(`<meta name="generator" content="repo-truth v${pkg.version}">`), 'meta 是元数据，必须保留')
})

test('meta 标签在两种情况下都存在，且内容来自 package.json', () => {
  const on = renderHtml(sampleFacts(), { config: { attribution: true }, generatedAt: '2026-01-01' })
  const off = renderHtml(sampleFacts(), { config: { attribution: false }, generatedAt: '2026-01-01' })
  const expected = `<meta name="generator" content="repo-truth v${pkg.version}">`
  assert.ok(on.includes(expected))
  assert.ok(off.includes(expected))
  assert.ok(on.indexOf(expected) < on.indexOf('<body>'), 'meta 必须在 head 里')
})

test('版本号只有一个来源：lib 里不出现写死的语义化版本', () => {
  const libDir = join(root, 'lib')
  const offenders = []
  for (const file of readdirSync(libDir).filter((name) => name.endsWith('.js'))) {
    const text = readFileSync(join(libDir, file), 'utf8')
    // 只抓形如 v0.2.0 / "0.2.0" 的字面量；注释里的日期、端口不算。
    if (/['"`]v?\d+\.\d+\.\d+['"`]/.test(text)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `这些文件里写死了版本：${offenders.join(', ')}`)
  assert.equal(version(), pkg.version)
})

test('attribution 开关只认显式 false', () => {
  assert.equal(isAttributionEnabled(undefined), true)
  assert.equal(isAttributionEnabled({}), true)
  assert.equal(isAttributionEnabled({ attribution: 'false' }), true, '类型写错时回到默认开')
  assert.equal(isAttributionEnabled({ attribution: null }), true)
  assert.equal(isAttributionEnabled({ attribution: false }), false)
})

test('地址归一：git+https 与 git@ 都变成可点的 https', () => {
  assert.equal(repoUrl('git+https://github.com/a/b.git'), 'https://github.com/a/b')
  assert.equal(repoUrl('git@github.com:a/b.git'), 'https://github.com/a/b')
  assert.equal(repoUrl(''), repoUrl())
  assert.ok(repoUrl().length > 0)
  assert.match(footerLine({ version: '9.9.9', repoUrl: 'https://example.com/x' }), /由 repo-truth 生成 · https:\/\/example\.com\/x · v9\.9\.9$/)
  assert.match(metaTag('9.9.9'), /content="repo-truth v9\.9\.9"/)
  assert.ok(FALLBACK_REPO_URL.startsWith('https://'))
})

test('正文必须是产品语言：禁词命中为 0', async () => {
  const { productBodyViolations } = await import('../lib/render.js')
  const html = renderHtml(sampleFacts(), { config: {}, generatedAt: '2026-01-01' })
  assert.deepEqual(productBodyViolations(html), [])
})

test('页面上写清了口径：没找到 ≠ 不存在', () => {
  const html = renderHtml(sampleFacts(), { config: {}, generatedAt: '2026-01-01' })
  assert.ok(html.includes('不代表<b>不存在</b>'), '限界框必须写出「没找到 ≠ 不存在」')
  assert.ok(html.includes('读不懂'), '必须说明读不懂的部分')
})
