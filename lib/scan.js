// 扫描一个已经落到本地磁盘的仓库，产出「系统现状」能用到的最小事实集。
//
// 三条设计约束（都来自 repo-to-pm-truth 的纪律）：
// 1. 只写量得到的东西。量不到的（后端流程、权限、请求链路、跳转关系）一个字段都不编。
// 2. 三种状态分开：读到了 / 没找到 / 读不懂。它们在返回结构里是不同的键，不给调用方合并的机会。
// 3. 每一条都要带上「怎么得出的」，渲染层才有办法把口径写进页面（例如「只按目录约定认页面」）。
import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 这些目录进来只会污染数字：构建产物、依赖、第三方代码。跳过并且要写出来。 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.cache',
  'vendor',
  'coverage',
  '.idea',
  '.vscode',
])

/** 素材不是代码：单独计数，不算进「代码文件」，也不进「读不懂」那一栏。 */
const ASSET_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.webm', '.mp3', '.wav',
  '.pdf', '.zip', '.gz', '.tar',
  '.map',
])

/** 认识的扩展名 → 语言名。认识的才计入「读懂了哪些语言」。 */
const LANG_BY_EXT = {
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.css': 'CSS',
  '.scss': 'CSS',
  '.sass': 'CSS',
  '.less': 'CSS',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.mdx': 'Markdown',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.py': 'Python',
  '.go': 'Go',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.rs': 'Rust',
  '.c': 'C',
  '.h': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.sql': 'SQL',
  '.xml': 'XML',
  '.toml': 'TOML',
  '.ini': 'INI',
}

/** 认作「代码文件」的扩展名（语言表里有、且不是 JSON/Markdown 这类配置文件）。 */
const CODE_EXTS_RE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|vue|svelte|html?|py|go|java|kt|swift|rb|php|rs|c|h|cc|cpp|cs|css|scss|sass|less)$/

/** 页面/视图目录约定。顺序即优先级：越具体的约定越先认。 */
const PAGE_CONVENTIONS = [
  { id: 'uni-pages-json', label: 'pages.json 清单' },
  { id: 'next-app-router', label: 'app/**/page.*' },
  { id: 'src-pages', label: 'src/pages/**' },
  { id: 'next-pages-router', label: 'pages/**' },
  { id: 'views', label: 'src/views/**' },
]

/** 组件目录候选。只在这些目录里数「可复用界面模块」。 */
const COMPONENT_DIRS = ['src/components', 'components', 'src/widgets', 'app/components']

/** 数引用时最多读多少个代码文件；超过就写进 limits，不许悄悄截断。 */
const USAGE_FILE_CAP = 2000
/** 单文件读取上限：巨型压缩文件读进来只会拖慢扫描。 */
const MAX_READ_BYTES = 512 * 1024

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** git 调用统一走 execFile：不拼 shell 字符串，仓库名里有空格也不会炸。 */
async function git(root, args, timeout = 20_000) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, error: String(error?.stderr ?? error?.message ?? '') }
  }
}

/**
 * 递归列出文件。返回三类：
 * - code: 代码文件（含大小）
 * - asset: 素材
 * - unknown: 扩展名不在语言表里的其它文件（可能是读不懂的代码！要保守地报出来）
 */
async function walk(root) {
  const code = []
  const asset = []
  const unknown = []
  const skippedDirs = new Set()

  async function visit(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skippedDirs.add(entry.name)
          continue
        }
        await visit(full)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(root, full).split(sep).join('/')
      const ext = extname(entry.name).toLowerCase()
      let size = 0
      try {
        size = (await stat(full)).size
      } catch {
        size = 0
      }
      if (ASSET_EXTS.has(ext)) {
        asset.push({ path: rel, bytes: size })
        continue
      }
      if (LANG_BY_EXT[ext] !== undefined) {
        code.push({ path: rel, bytes: size, ext, language: LANG_BY_EXT[ext] })
        continue
      }
      // 没有扩展名（Makefile、Dockerfile）按「读不懂」处理，不假装读懂了。
      unknown.push({ path: rel, bytes: size, ext: ext === '' ? '(无扩展名)' : ext })
    }
  }

  await visit(root)
  return { code, asset, unknown, skippedDirs: [...skippedDirs].sort() }
}

/** 按语言汇总。顺序固定（数量降序 + 名字升序），保证同一份输入两次渲染逐字节相同。 */
function byLanguage(code) {
  const map = new Map()
  for (const file of code) {
    const row = map.get(file.language) ?? { language: file.language, files: 0, bytes: 0 }
    row.files += 1
    row.bytes += file.bytes
    map.set(file.language, row)
  }
  return [...map.values()].sort((a, b) => b.files - a.files || a.language.localeCompare(b.language))
}

/**
 * 页面清单。只按目录约定认，不解析路由声明文件——
 * 这是刻意的：解析路由声明要真懂各框架的语法，半懂比不懂更危险，
 * 半懂会产出「清单里没有 = 不存在」的假话。所以口径写死为「没找到 ≠ 不存在」。
 */
async function detectPages(root, codePaths) {
  const found = []

  // 约定一：uni-app / Taro 的 pages.json
  const pagesJson = join(root, 'pages.json')
  if (await exists(pagesJson)) {
    try {
      const parsed = JSON.parse(await readFile(pagesJson, 'utf8'))
      const rows = []
      if (Array.isArray(parsed?.pages)) {
        for (const page of parsed.pages) {
          if (typeof page?.path === 'string') rows.push(page.path)
        }
      }
      if (Array.isArray(parsed?.subPackages)) {
        for (const pack of parsed.subPackages) {
          const rootDir = typeof pack?.root === 'string' ? pack.root : ''
          for (const page of Array.isArray(pack?.pages) ? pack.pages : []) {
            if (typeof page?.path === 'string') rows.push(rootDir === '' ? page.path : `${rootDir}/${page.path}`)
          }
        }
      }
      if (rows.length > 0) found.push({ convention: 'uni-pages-json', items: [...new Set(rows)].sort() })
    } catch {
      // pages.json 不是合法 JSON：记一笔「有约定但读不动」，不猜。
      found.push({ convention: 'uni-pages-json', items: [], broken: true })
    }
  }

  // 约定二：Next.js App Router —— app/**/page.{ts,tsx,js,jsx}
  const appRouter = codePaths
    .filter((p) => /^app\//.test(p) && /\/page\.(tsx|jsx|ts|js)$/.test(p))
    .map((p) => p.replace(/\/page\.(tsx|jsx|ts|js)$/, '').replace(/^app\/?/, '').replace(/\(([^)]+)\)\//g, ''))
    .map((p) => (p === '' ? '/' : `/${p}`))
  if (appRouter.length > 0) found.push({ convention: 'next-app-router', items: [...new Set(appRouter)].sort() })

  // 约定三：uni-app / Taro 的 src/pages/**
  const srcPages = codePaths
    .filter((p) => /^src\/pages\/.+\.(vue|tsx|jsx|ts|js)$/.test(p))
    .map((p) => p.replace(/\.(vue|tsx|jsx|ts|js)$/, ''))
  if (srcPages.length > 0) found.push({ convention: 'src-pages', items: [...new Set(srcPages)].sort() })

  // 约定四：Next.js Pages Router
  const nextPages = codePaths
    .filter((p) => /^pages\/.+\.(tsx|jsx|ts|js)$/.test(p) && !/^pages\/api\//.test(p))
    .map((p) => p.replace(/^pages/, '').replace(/\/index\.(tsx|jsx|ts|js)$/, '/').replace(/\.(tsx|jsx|ts|js)$/, ''))
    .map((p) => (p === '' ? '/' : p))
  if (nextPages.length > 0) found.push({ convention: 'next-pages-router', items: [...new Set(nextPages)].sort() })

  // 约定五：Vue 生态最常见的 src/views/**
  // 保留完整路径（含 src/）：研发参考里给的是坐标，坐标少一段就没法直接打开。
  const views = codePaths
    .filter((p) => /^src\/views\/.+\.vue$/.test(p))
    .map((p) => p.replace(/\.vue$/, ''))
  if (views.length > 0) found.push({ convention: 'views', items: [...new Set(views)].sort() })

  if (found.length === 0) return { convention: null, label: null, items: [], others: [] }
  // 优先级排序后取第一个作为「本仓库的页面口径」，其余的也带上（交给渲染层如实说明）。
  found.sort((a, b) => PAGE_CONVENTIONS.findIndex((c) => c.id === a.convention) - PAGE_CONVENTIONS.findIndex((c) => c.id === b.convention))
  const primary = found[0]
  const label = PAGE_CONVENTIONS.find((c) => c.id === primary.convention)?.label ?? primary.convention
  return { convention: primary.convention, label, items: primary.items, others: found.slice(1) }
}

/**
 * 可复用界面模块 + 被引用的次数。
 * 为什么只数「名字出现次数」而不做 AST：这一版刻意零依赖，正则数引用足够回答
 * 「哪些模块被反复用」，而且错了也只是排序抖动，不会产出「不存在」这类假话。
 */
async function detectComponents(root, codePaths, walkResult) {
  let dir = null
  for (const candidate of COMPONENT_DIRS) {
    if (await exists(join(root, candidate))) {
      dir = candidate
      break
    }
  }
  if (dir === null) return { dir: null, items: [], readFiles: 0, capped: false, unread: 0 }

  const entries = walkResult.code.filter((file) => file.path.startsWith(`${dir}/`))
  const names = new Map()
  for (const file of entries) {
    const base = basename(file.path, extname(file.path))
    const name = base === 'index' ? basename(file.path.slice(0, file.path.lastIndexOf('/'))) : base
    // 名字太短（如 `ui`、`x`）数引用会误命中，直接跳过并在口径里说明。
    if (name.length < 3) continue
    const row = names.get(name) ?? { name, path: file.path, usages: 0, bytes: file.bytes }
    if (file.bytes > row.bytes) {
      row.path = file.path
      row.bytes = file.bytes
    }
    names.set(name, row)
  }
  if (names.size === 0) return { dir, items: [], readFiles: 0, capped: false, unread: 0 }

  const contents = []
  for (const file of walkResult.code) {
    if (contents.length >= USAGE_FILE_CAP) break
    if (!CODE_EXTS_RE.test(file.path)) continue
    if (file.bytes > MAX_READ_BYTES) continue
    try {
      contents.push({ path: file.path, text: await readFile(join(root, file.path), 'utf8') })
    } catch {
      // 读不到就少算一处引用；不影响「有这个东西」的判断。
    }
  }

  const patterns = [...names.keys()].map((name) => ({
    name,
    re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
  }))
  for (const file of contents) {
    for (const { name, re } of patterns) {
      const row = names.get(name)
      if (row.path === file.path) continue
      if (re.test(file.text)) row.usages += 1
    }
  }

  const items = [...names.values()].sort((a, b) => b.usages - a.usages || a.name.localeCompare(b.name))
  return {
    dir,
    items,
    readFiles: contents.length,
    // capped 只表示「真的撞到上限」；unread 表示「有文件没读」。两者不能混成一句话，
    // 否则页面上会出现「只读了 70 个（上限）」这种把两种情况说成一件事的假话。
    capped: contents.length >= USAGE_FILE_CAP,
    unread: walkResult.code.length - contents.length,
  }
}

/**
 * 最大文件 + 改动痕迹。
 * 浅克隆（--depth 1）只有 1 个提交，改动频次在数学上不可得。
 * 这时不写「无人改动」，改成给「最近一次提交动过哪些文件」，并在口径里说清为什么。
 */
async function detectChurn(root, walkResult) {
  const largest = [...walkResult.code]
    .filter((file) => CODE_EXTS_RE.test(file.path))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, 8)
    .map((file) => ({ path: file.path, bytes: file.bytes }))

  const countResult = await git(root, ['rev-list', '--count', 'HEAD'])
  const commits = countResult.ok && /^\d+$/.test(countResult.stdout.trim()) ? Number(countResult.stdout.trim()) : null

  if (commits !== null && commits > 1) {
    const log = await git(root, ['log', '--pretty=format:', '--name-only', '--no-merges', '-n', '300'])
    if (log.ok) {
      const tally = new Map()
      for (const line of log.stdout.split('\n')) {
        const path = line.trim()
        if (path === '' || path.startsWith('(')) continue
        tally.set(path, (tally.get(path) ?? 0) + 1)
      }
      const items = [...tally.entries()]
        .filter(([path]) => CODE_EXTS_RE.test(path))
        .map(([path, changes]) => ({ path, changes }))
        .sort((a, b) => b.changes - a.changes || a.path.localeCompare(b.path))
        .slice(0, 8)
      return { largest, commits, mode: 'history', items, note: null }
    }
  }

  // 单提交（浅克隆）：只报这次提交动过的文件，并且明说这是「一次提交」而不是「改动频次」。
  const show = await git(root, ['show', '--pretty=format:', '--name-only', 'HEAD'])
  const items = show.ok
    ? [...new Set(show.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== ''))]
        .filter((path) => CODE_EXTS_RE.test(path))
        .slice(0, 12)
        .map((path) => ({ path }))
    : []
  return {
    largest,
    commits,
    mode: 'single-commit',
    items,
    note:
      commits === null
        ? '读不到提交历史（浅克隆或不是 git 仓库），改动频次不可得'
        : '浅克隆只有 1 个提交，改动频次不可得；下面是这次提交动过的文件',
  }
}

/** 快照信息：材料必须带日期，读的人才知道看的是哪天的代码。 */
async function snapshot(root) {
  const log = await git(root, ['log', '-1', '--format=%cI%n%s'])
  if (!log.ok) return { date: null, subject: null }
  const [dateLine, ...rest] = log.stdout.split('\n')
  return { date: dateLine?.trim() || null, subject: rest.join('\n').trim() || null }
}

/**
 * 扫描入口。repoName 由调用方给（demo 从 URL 推），root 是本地目录。
 * 返回结构里「读到了 / 没找到 / 读不懂」各占各的键——渲染层没法把它们合成一句话。
 */
export async function scanRepo(root, options = {}) {
  const walkResult = await walk(root)
  const codePaths = walkResult.code.map((file) => file.path)
  const [pages, components, churn, snap] = await Promise.all([
    detectPages(root, codePaths),
    detectComponents(root, codePaths, walkResult),
    detectChurn(root, walkResult),
    snapshot(root),
  ])

  const unknownByExt = new Map()
  for (const file of walkResult.unknown) {
    unknownByExt.set(file.ext, (unknownByExt.get(file.ext) ?? 0) + 1)
  }
  const unknown = [...unknownByExt.entries()]
    .map(([ext, files]) => ({ ext, files }))
    .sort((a, b) => b.files - a.files || a.ext.localeCompare(b.ext))

  return {
    repoName: options.repoName ?? basename(root),
    repoUrl: options.repoUrl ?? null,
    root,
    snapshot: snap,
    files: {
      code: walkResult.code.length,
      assets: walkResult.asset.length,
      unknown: walkResult.unknown.length,
      bytes: walkResult.code.reduce((sum, file) => sum + file.bytes, 0),
    },
    languages: byLanguage(walkResult.code),
    unknownExtensions: unknown,
    skippedDirs: walkResult.skippedDirs,
    pages,
    components,
    churn,
  }
}
