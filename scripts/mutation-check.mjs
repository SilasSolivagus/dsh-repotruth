#!/usr/bin/env node
// 变异验证：把每条规则对应的那一行「故意改坏」，确认测试真的会变红，再复原。
//
// 为什么要有这个脚本：repo-to-pm-truth 的第八条纪律是「每个测试都要能变红」。
// 一天里出现过六次「有测试但拦不住」——测试写了，断言却是恒真的。
// 手点一遍太容易忘，所以把「改坏 → 跑 → 复原」做成可重放的脚本；
// 任何一条改坏之后测试仍然全绿，脚本就以非零退出。
//
// 用法：node scripts/mutation-check.mjs [--only <编号>]
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 每条：编号、规则、文件、原文、改坏后的样子、应当变红的测试文件。 */
const MUTATIONS = [
  {
    id: 'M1',
    rule: '增量：同一个 HEAD 第二遍解析 0 个内容块',
    file: 'lib/indexer.js',
    from: '    if (previousBlobs[entry.sha] !== undefined) {',
    to: '    if (false) {',
    tests: ['test/index-incremental.test.js'],
  },
  {
    id: 'M2',
    rule: '自动生成的文件要识别出来（不能当成产品代码）',
    file: 'lib/indexer.js',
    from: '      if (GENERATED_RE.test(text.slice(0, 4000))) {',
    to: '      if (false) {',
    tests: ['test/index-incremental.test.js'],
  },
  {
    id: 'M3',
    rule: '测试文件要跳过',
    file: 'lib/indexer.js',
    from: '    if (isTestPath(entry.path)) {',
    to: '    if (false) {',
    tests: ['test/index-incremental.test.js'],
  },
  {
    id: 'M4',
    rule: '第三方目录（vendor/third_party/testdata）要跳过',
    file: 'lib/indexer.js',
    from: '    const skipDir = skipDirOf(entry.path)',
    to: '    const skipDir = null',
    tests: ['test/index-incremental.test.js'],
  },
  {
    id: 'M5',
    rule: '页面口径只有一份实现（索引与工作区扫描一致）',
    file: 'lib/scan.js',
    from: "  if (/^src\\/views\\/.+\\.vue$/.test(p)) {",
    to: '  if (false) {',
    tests: ['test/index-incremental.test.js'],
  },
  {
    id: 'M6',
    rule: 'git 失败要翻成中文原因',
    file: 'lib/git.js',
    from: '  const reason = timeoutReason(result, timeoutMs) ?? explainGitFailure(result.stderr)',
    to: '  const reason = timeoutReason(result, timeoutMs) ?? `克隆失败：${String(result.stderr).trim()}`',
    tests: ['test/repos-flow.test.js'],
  },
  {
    id: 'M7',
    rule: '每个仓的硬超时：到点必杀',
    file: 'lib/jobs.js',
    from: '  const hardTimer = setTimeout(() => {',
    to: '  const hardTimer = setTimeout(() => { return;',
    tests: ['test/repos-flow.test.js'],
  },
  {
    id: 'M8',
    rule: '宿主不等克隆：startJob 立刻返回',
    file: 'lib/jobs.js',
    from: "  return { ok: true, job }",
    to: '  await new Promise((resolve) => child.on(\'close\', resolve))\n  return { ok: true, job }',
    tests: ['test/repos-flow.test.js'],
  },
  {
    id: 'M9',
    rule: '没命中就说没找到（不许拿最像的顶上）',
    file: 'lib/ask.js',
    from: '      if (score < 4 || strong < 2) continue',
    to: '      if (score < 1) continue',
    tests: ['test/ask.test.js'],
  },
  {
    id: 'M10',
    rule: '被跳过/未索引的文件不能泄漏进检索',
    file: 'lib/indexer.js',
    from: "    if (isAssetPath(entry.path)) {\n      counts.asset += 1\n      continue\n    }",
    to: '',
    tests: ['test/index-incremental.test.js'],
  },
  {
    id: 'M11',
    rule: '没有索引 ≠ 没有这个东西（三态不许合并）',
    file: 'lib/ask.js',
    from: "      state: 'no-index',",
    to: "      state: 'ok',",
    tests: ['test/ask.test.js'],
  },
  {
    id: 'M12',
    rule: '正文只能是产品语言（禁词机器检查）',
    file: 'lib/answer.js',
    from: '  paragraphs.push(\n    `名字相似不等于就是它：',
    to: '  paragraphs.push(`${(answer.matches ?? [])[0]?.path ?? \'\'} 名字相似不等于就是它：',
    tests: ['test/ask.test.js'],
  },
  {
    id: 'M13',
    rule: '令牌只以掩码出现',
    file: 'lib/index.js',
    from: '  return head ? `${head[1]}-…${tail}` : `…${tail}`',
    to: '  return value',
    tests: ['test/discipline.test.js'],
  },
  {
    id: 'M14',
    rule: '配置文件权限必须是 600',
    file: 'lib/index.js',
    from: '  await chmod(configPath(), 0o600)',
    to: '  await chmod(configPath(), 0o644)',
    tests: ['test/discipline.test.js'],
  },
  {
    id: 'M15',
    rule: '署名里的仓库地址必须是真地址（不能是占位符）',
    file: 'package.json',
    from: '"url": "git+https://github.com/SilasSolivagus/dsh-repotruth.git"',
    to: '"url": "git+https://github.com/example/placeholder.git"',
    tests: ['test/branding.test.js', 'test/discipline.test.js'],
  },
  {
    id: 'M16',
    rule: '没命中就不画流程（不生成空的三栏页）',
    file: 'lib/material.js',
    from: '  if (answer.found !== true || plan.nodes.length === 0) {',
    to: '  if (false) {',
    tests: ['test/material.test.js'],
  },
  {
    id: 'M17',
    rule: '没有页面的节点必须给时序图',
    file: 'lib/material.js',
    from: '  const { svg } = renderSequenceSvg({ participants, messages: skeletonMessages(participants) })',
    to: "  const svg = ''",
    tests: ['test/material.test.js'],
  },
  {
    id: 'M18',
    rule: '时序参与者是封闭词表（词表外抛错）',
    file: 'lib/seq-svg.js',
    from: '    if (!SEQ_PARTICIPANTS.includes(name)) {',
    to: '    if (false) {',
    tests: ['test/material.test.js'],
  },
  {
    id: 'M19',
    rule: '走查页必须带生成器 meta',
    file: 'lib/branding.js',
    from: '  return `<meta name="generator" content="${escapeAttr(content)}">`',
    to: "  return ''",
    tests: ['test/material.test.js'],
  },
  {
    id: 'M20',
    rule: '走查正文只能是产品语言（禁词机器检查）',
    file: 'lib/material.js',
    from: "      '中间是每个节点能看到的东西（有页面就给页面结构，没有页面就给时序骨架），' +",
    to: "      '中间 src/views 是每个节点能看到的东西（有页面就给页面结构，没有页面就给时序骨架），' +",
    tests: ['test/material.test.js'],
  },
  {
    id: 'M21',
    rule: '深链 #node= 必须能停在指定节点',
    file: 'lib/vendor/uemaster/flow-walkthrough.html',
    from: 'var initNode = hashQuery.node ||',
    to: 'var initNode = undefined ||',
    tests: ['test/material.test.js'],
  },
  {
    id: 'M22',
    rule: '走查页必须带署名页脚（可关，但默认在）',
    file: 'lib/material.js',
    from: "  if (branding.footer === null) return ''",
    to: "  if (branding.footer !== null) return ''",
    tests: ['test/material.test.js'],
  },
]

function runTests(files) {
  try {
    execFileSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'pipe', timeout: 180_000 })
    return { failed: false, output: '' }
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const only = process.argv.includes('--only')
  ? new Set(process.argv.slice(process.argv.indexOf('--only') + 1).filter((arg) => !arg.startsWith('--')))
  : null

const rows = []
for (const mutation of MUTATIONS) {
  if (only !== null && !only.has(mutation.id)) continue
  const target = join(root, mutation.file)
  const original = readFileSync(target, 'utf8')
  if (!original.includes(mutation.from)) {
    rows.push({ ...mutation, status: 'SKIP（找不到锚点）', detail: '' })
    continue
  }
  writeFileSync(target, original.replace(mutation.from, mutation.to))
  try {
    const result = runTests(mutation.tests)
    rows.push({
      ...mutation,
      status: result.failed ? '变红 ✓' : '没变红 ✗',
      detail: result.failed ? '' : '这条规则没有测试拦得住',
    })
  } finally {
    writeFileSync(target, original) // 无论结果如何都要复原
  }
}

const width = 46
process.stdout.write(`变异验证（${rows.length} 条）\n`)
for (const row of rows) {
  process.stdout.write(`  ${row.id.padEnd(4)} ${row.rule.slice(0, width).padEnd(width + 2)} ${row.status}\n`)
  if (row.detail !== '') process.stdout.write(`       ↳ ${row.detail}\n`)
}
const caught = rows.filter((row) => row.status === '变红 ✓').length
process.stdout.write(`\n拦得住：${caught}/${rows.length}\n`)
if (caught !== rows.length) process.exitCode = 1
