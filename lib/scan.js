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
export const SKIP_DIRS = new Set([
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
export const ASSET_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.webm', '.mp3', '.wav',
  '.pdf', '.zip', '.gz', '.tar',
  '.map',
])

/** 认识的扩展名 → 语言名。认识的才计入「读懂了哪些语言」。 */
export const LANG_BY_EXT = {
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
export const CODE_EXTS_RE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|vue|svelte|html?|py|go|java|kt|swift|rb|php|rs|c|h|cc|cpp|cs|css|scss|sass|less)$/

/** 页面/视图目录约定。顺序即优先级：越具体的约定越先认。 */
export const PAGE_CONVENTIONS = [
  { id: 'uni-pages-json', label: 'pages.json 清单' },
  { id: 'next-app-router', label: 'app/**/page.*' },
  { id: 'src-pages', label: 'src/pages/**' },
  { id: 'next-pages-router', label: 'pages/**' },
  { id: 'views', label: 'src/views/**' },
]

/** 组件目录候选。只在这些目录里数「可复用界面模块」。 */
export const COMPONENT_DIRS = ['src/components', 'components', 'src/widgets', 'app/components']

/** 数引用时最多读多少个代码文件；超过就写进 limits，不许悄悄截断。 */
const USAGE_FILE_CAP = 2000
/** 单文件读取上限：巨型压缩文件读进来只会拖慢扫描。 */
const MAX_READ_BYTES = 512 * 1024

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数层：语言 / 页面 / 组件 / 单文件解析。
//
// 这一层被两个调用方共用：`scanRepo`（有工作区目录，demo 走的这条）和索引器
// （只有 bare mirror，没有工作区，只能按 blob 读）。两边共用同一份判定，
// 才不会出现「demo 说 12 个页面、索引说 9 个」这种自相矛盾的材料。
// 所有函数都不碰磁盘：输入是路径和文本，输出是纯数据。
// ─────────────────────────────────────────────────────────────────────────────

/** 扩展名（小写，带点）。自己写而不是 extname，是为了让索引层不依赖 path 模块的边界行为。 */
function extOf(path) {
  const name = String(path ?? '')
  const slash = name.lastIndexOf('/')
  const base = slash === -1 ? name : name.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** 路径 → 语言名；不在语言表里就是 null（不假装读懂）。 */
export function languageOf(path) {
  const ext = extOf(path)
  return LANG_BY_EXT[ext] ?? null
}

/** 是否算「代码文件」：认扩展名，且排除 JSON/Markdown 这类配置与文档。 */
export function isCodePath(path) {
  return CODE_EXTS_RE.test(String(path ?? ''))
}

/** 是否素材：素材单独计数，既不算读懂也不算读不懂。 */
export function isAssetPath(path) {
  return ASSET_EXTS.has(extOf(path))
}

/** 路径落在某个被排除的目录里（比目录名比对更严格：`src/vendor/x` 也算）。 */
export function skippedDirOf(path) {
  const parts = String(path ?? '').split('/')
  for (const part of parts.slice(0, -1)) {
    if (SKIP_DIRS.has(part)) return part
  }
  return null
}

/**
 * 组件名：只认 COMPONENT_DIRS 里的文件，`index.*` 取上一级目录名。
 * 名字短于 3 个字符的不认——数引用时会到处误命中（scanRepo 的老规矩）。
 */
export function componentNameOf(path) {
  const text = String(path ?? '')
  const dir = COMPONENT_DIRS.find((candidate) => text.startsWith(`${candidate}/`))
  if (dir === undefined) return null
  const base = text.slice(dir.length + 1)
  const name = base.replace(/\.[^./]+$/, '')
  const leaf = name === 'index' ? name.split('/').slice(-2, -1)[0] ?? '' : name.split('/').pop() ?? ''
  return leaf.length < 3 ? null : leaf
}

/**
 * 单个文件是否构成一个页面，命中哪条约定，页面叫什么。
 * 这是页面口径的唯一实现：demo 与索引都从这里出，所以两边数字不会打架。
 * 注意：`pages.json` 这种「清单式」约定不在这里——它要看文件内容，见 parsePagesJson。
 */
export function pageOfPath(path) {
  const p = String(path ?? '')
  if (p === '') return null
  if (/^app\//.test(p) && /\/page\.(tsx|jsx|ts|js)$/.test(p)) {
    const page = p
      .replace(/\/page\.(tsx|jsx|ts|js)$/, '')
      .replace(/^app\/?/, '')
      .replace(/\(([^)]+)\)\//g, '')
    return { convention: 'next-app-router', page: page === '' ? '/' : `/${page}` }
  }
  if (/^src\/pages\/.+\.(vue|tsx|jsx|ts|js)$/.test(p)) {
    return { convention: 'src-pages', page: p.replace(/\.(vue|tsx|jsx|ts|js)$/, '') }
  }
  if (/^pages\/.+\.(tsx|jsx|ts|js)$/.test(p) && !/^pages\/api\//.test(p)) {
    const page = p
      .replace(/^pages/, '')
      .replace(/\/index\.(tsx|jsx|ts|js)$/, '/')
      .replace(/\.(tsx|jsx|ts|js)$/, '')
    return { convention: 'next-pages-router', page: page === '' ? '/' : page }
  }
  if (/^src\/views\/.+\.vue$/.test(p)) {
    return { convention: 'views', page: p.replace(/\.vue$/, '') }
  }
  return null
}

/**
 * 解析 pages.json 清单（uni-app / Taro 的约定）。
 * 坏 JSON 返回 `[{ convention, page: null }]`——「有约定但读不动」必须能表达出来，
 * 不能悄悄变成「没有页面」。
 */
export function parsePagesJson(text) {
  try {
    const parsed = JSON.parse(text)
    const rows = []
    if (Array.isArray(parsed?.pages)) {
      for (const page of parsed.pages) {
        if (typeof page?.path === 'string') rows.push({ convention: 'uni-pages-json', page: page.path })
      }
    }
    if (Array.isArray(parsed?.subPackages)) {
      for (const pack of parsed.subPackages) {
        const rootDir = typeof pack?.root === 'string' ? pack.root : ''
        for (const page of Array.isArray(pack?.pages) ? pack.pages : []) {
          if (typeof page?.path === 'string') {
            rows.push({ convention: 'uni-pages-json', page: rootDir === '' ? page.path : `${rootDir}/${page.path}` })
          }
        }
      }
    }
    return rows.length === 0 ? [{ convention: 'uni-pages-json', page: null }] : rows
  } catch {
    return [{ convention: 'uni-pages-json', page: null }]
  }
}

/**
 * 把「每个文件命中的页面」汇总成本仓的页面清单。
 * 优先级与 PAGE_CONVENTIONS 一致：避免同一批页面被两条约定数两遍。
 */
export function pagesFromEntries(entries) {
  const buckets = new Map()
  const broken = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const rows = Array.isArray(entry?.pages) ? entry.pages : []
    for (const row of rows) {
      const convention = row?.convention
      if (!PAGE_CONVENTIONS.some((candidate) => candidate.id === convention)) continue
      if (!buckets.has(convention)) buckets.set(convention, new Set())
      if (row.page === null || row.page === undefined || row.page === '') {
        broken.add(convention)
        continue
      }
      buckets.get(convention).add(String(row.page))
    }
  }
  const found = [...buckets.entries()]
    .map(([convention, set]) => ({ convention, items: [...set].sort(), broken: broken.has(convention) }))
    .filter((row) => row.items.length > 0 || row.broken)
  if (found.length === 0) return { convention: null, label: null, items: [], others: [] }
  found.sort(
    (a, b) =>
      PAGE_CONVENTIONS.findIndex((c) => c.id === a.convention) -
      PAGE_CONVENTIONS.findIndex((c) => c.id === b.convention),
  )
  const primary = found[0]
  const label = PAGE_CONVENTIONS.find((c) => c.id === primary.convention)?.label ?? primary.convention
  return { convention: primary.convention, label, items: primary.items, others: found.slice(1) }
}

/** UTF-16 的源码在真实仓里存在（自动生成的类型文件常见）。解码错了就等于读不懂。 */
export function decodeText(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return bytes.toString('utf8')
}

/** 「自动生成」的机器标记。只认明确的句子，宁可漏判也不能把正常代码判成生成代码。 */
export const GENERATED_RE = /Code generated .{0,80}DO NOT EDIT|@generated|This file was generated|DO NOT EDIT THIS FILE/i

/** 单文件解析上限：数组都截断，索引体积才不会随仓变大而失控。 */
const MAX_SYMBOLS = 60
const MAX_OUTLINE = 20
const MAX_IMPORTS = 60

const SYMBOL_PATTERNS = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*def\s+([A-Za-z_]\w*)/gm,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
  /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/gm,
]

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s[\s\S]{0,200}?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*from\s+(\.[\w.]*)\s+import\b/gm,
]

/** 相对引用能落到的候选文件名。顺序即优先级，命中的第一个就是这次引用指向的文件。 */
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json', '.css', '.scss']

function uniquePush(list, value, cap) {
  if (list.length >= cap) return
  if (!list.includes(value)) list.push(value)
}

/**
 * 把一段 blob 文本解析成索引里存的那几件东西。
 * pathSet 是本仓所有文件路径：没有它就没法把 `./foo` 解析成具体文件，
 * 而「波及几处」这个问题问的正是具体文件。
 */
export function parseBlobContent(path, text, pathSet) {
  const lang = languageOf(path)
  const symbols = []
  const outline = []
  const imports = []
  const pages = []
  // 被丢掉的 import：别名（`@/…`、`~…`）、包名、以及相对但解析不到文件的。
  // 这个数字是「这份索引的引用图测到哪」的证据：>0 就说明「被引用 = 0」不可信。
  let aliasImports = 0

  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (match[1]) uniquePush(symbols, match[1], MAX_SYMBOLS)
    }
  }

  if (lang === 'Markdown') {
    for (const match of text.matchAll(/^#{1,3}\s+(.+)$/gm)) {
      if (outline.length >= MAX_OUTLINE) break
      outline.push(match[1].trim().slice(0, 80))
    }
  } else if (isCodePath(path)) {
    for (const match of text.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) {
      if (outline.length >= MAX_OUTLINE) break
      uniquePush(outline, match[1], MAX_OUTLINE)
    }
  }

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const spec = match[1]
      if (!spec) continue
      if (!spec.startsWith('.')) {
        // 别名与包名：不是「没有引用」，是「这一版解析不了」。
        aliasImports += 1
        continue
      }
      const resolved = resolveRelative(path, spec, pathSet)
      if (resolved === null) aliasImports += 1
      else uniquePush(imports, resolved, MAX_IMPORTS)
    }
  }

  const page = pageOfPath(path)
  if (page !== null) pages.push(page)
  if (path === 'pages.json') pages.push(...parsePagesJson(text))

  return { lang, symbols, outline, pages, imports, aliasImports }
}

/** `src/a/b.js` + `../c` → `src/c.ts`（在 pathSet 里存在的那一个）。 */
export function resolveRelative(fromPath, spec, pathSet) {
  const baseParts = String(fromPath ?? '').split('/').slice(0, -1)
  const parts = [...baseParts]
  for (const piece of spec.split('/')) {
    if (piece === '' || piece === '.') continue
    if (piece === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(piece)
  }
  const base = parts.join('/')
  if (base === '') return null
  const candidates = [base]
  for (const ext of RESOLVE_EXTS) candidates.push(`${base}${ext}`)
  for (const ext of RESOLVE_EXTS) candidates.push(`${base}/index${ext}`)
  for (const candidate of candidates) {
    if (pathSet.has(candidate)) return candidate
  }
  return null
}

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
 * 页面清单（工作区版）。只按目录约定认，不解析路由声明文件——
 * 这是刻意的：解析路由声明要真懂各框架的语法，半懂比不懂更危险，
 * 半懂会产出「清单里没有 = 不存在」的假话。所以口径写死为「没找到 ≠ 不存在」。
 *
 * 判定本身不在这里：pageOfPath / parsePagesJson / pagesFromEntries 是纯函数，
 * 索引器（只有 bare mirror、没有工作区）用的是同一份判定，两边数字才对得上。
 */
async function detectPages(root, codePaths) {
  const entries = []
  for (const path of codePaths) {
    const hit = pageOfPath(path)
    if (hit !== null) entries.push({ path, pages: [hit] })
  }
  const pagesJson = join(root, 'pages.json')
  if (await exists(pagesJson)) {
    try {
      entries.push({ path: 'pages.json', pages: parsePagesJson(await readFile(pagesJson, 'utf8')) })
    } catch {
      // 读不动也要留一笔「有约定但读不动」，不能悄悄变成「没有页面」。
      entries.push({ path: 'pages.json', pages: [{ convention: 'uni-pages-json', page: null }] })
    }
  }
  return pagesFromEntries(entries)
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
