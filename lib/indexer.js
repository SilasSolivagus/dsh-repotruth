// 建索引：读 bare mirror 的树 → 只解析「没见过的内容」→ 写一份 JSON。
//
// 为什么是 JSON 文件而不是数据库：
// 1. 这个插件要能在任何一台装了 node 和 git 的机器上跑，装驱动/起服务都是额外负担；
// 2. 索引是派生物，删掉可以重放（裸镜像还在），所以不值得为它引入运维面；
// 3. 一份索引就是一个文件，出问题时能整份发给别人看——这比「连上数据库查一下」有用。
//
// 内容寻址（blob sha）而不是按提交存快照：同一个文件在 100 个提交里只解析一次。
// 第二遍跑同一个 HEAD 必须解析 0 个 blob —— 这是这份索引的增量契约，测试会拦住它。
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { catFileBatch, headInfo, headOf, lastChanges, listTree } from './git.js'
import {
  decodeText,
  GENERATED_RE,
  isAssetPath,
  languageOf,
  parseBlobContent,
  pagesFromEntries,
  skippedDirOf,
} from './scan.js'

/** 单文件解析上限。超过就整只跳过并记账——「没读」必须能被看见，不能悄悄少算。 */
export const MAX_BLOB_BYTES = 512 * 1024

/** 第三方与夹具目录：它们不是产品能力，算进去就是假话。 */
const THIRD_PARTY_DIRS = new Set(['vendor', 'third_party', 'testdata'])

/** 测试目录按「整段目录名」匹配，避免把 `src/test-utils/` 这种产品代码误伤。 */
const TEST_DIR_SEGMENTS = new Set(['__tests__', 'test', 'tests', 'spec', 'e2e', '__mocks__'])

/** 测试文件名约定。只认这几种，宁漏不算错。 */
const TEST_FILE_RES = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.go$/i,
  /^test_.+\.py$/i,
  /_test\.py$/i,
  /^conftest\.py$/i,
  /Tests?\.(java|kt|swift)$/,
]

/** 路径是不是测试。目录段与文件名两条规则分开写，理由不同（一个管目录、一个管命名）。 */
export function isTestPath(path) {
  const parts = String(path ?? '').split('/')
  for (const part of parts.slice(0, -1)) {
    if (TEST_DIR_SEGMENTS.has(part)) return true
  }
  const base = parts[parts.length - 1] ?? ''
  return TEST_FILE_RES.some((re) => re.test(base))
}

/** 目录级跳过：第三方目录优先，其次才是构建产物目录。返回命中的目录名（用于记账）。 */
export function skipDirOf(path) {
  const parts = String(path ?? '').split('/')
  for (const part of parts.slice(0, -1)) {
    if (THIRD_PARTY_DIRS.has(part)) return part
  }
  return skippedDirOf(path)
}

function emptyCounts() {
  return { total: 0, indexed: 0, generated: 0, test: 0, dir: 0, asset: 0, unsupported: 0, large: 0 }
}

/** 读旧索引。坏文件当「没有索引」处理，但要带出警告——悄悄重建会让人以为增量生效了。 */
async function readExisting(indexPath) {
  let text
  try {
    text = await readFile(indexPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { index: null, warning: null }
    return { index: null, warning: `读取旧索引失败（将重建）：${error.message}` }
  }
  try {
    const parsed = JSON.parse(text)
    return {
      index: {
        head: typeof parsed?.head === 'string' ? parsed.head : null,
        blobs: parsed?.blobs && typeof parsed.blobs === 'object' ? parsed.blobs : {},
        generated: parsed?.generated && typeof parsed.generated === 'object' ? parsed.generated : {},
        files: parsed?.files && typeof parsed.files === 'object' ? parsed.files : {},
      },
      warning: null,
    }
  } catch {
    return { index: null, warning: '旧索引不是合法 JSON（将重建）。' }
  }
}

/**
 * 从「文件 → 内容块」推导页面清单。
 * 判定用的是 scan.js 里那套纯函数，所以和 demo 的页面数字必然一致。
 */
export function pagesOf(files, blobs) {
  const entries = Object.entries(files).map(([path, sha]) => ({ path, pages: blobs[sha]?.pages ?? [] }))
  return pagesFromEntries(entries)
}

/**
 * 建索引主流程。
 * options: { repo, url, mirrorDir, indexPath, onProgress, changesWindow }
 * 返回摘要（给宿主写覆盖率表用），不返回整份索引（可能有几 MB）。
 */
export async function buildIndex(options) {
  const started = Date.now()
  const report = options.onProgress ?? (() => {})
  const { repo, mirrorDir, indexPath } = options

  const head = await headOf(mirrorDir)
  if (!head.ok) return { ok: false, error: head.error }

  report('列出文件清单')
  const tree = await listTree(mirrorDir)
  if (!tree.ok) return { ok: false, error: tree.error }

  const existing = await readExisting(indexPath)
  const previousBlobs = existing.index?.blobs ?? {}
  const previousGenerated = existing.index?.generated ?? {}

  const counts = emptyCounts()
  const files = {}
  const sizes = {}
  const blobs = {}
  const generated = {}
  const parsedShas = []
  let reusedBlobs = 0

  // 第一遍：只靠路径分类。不读内容就能判的，一律不读内容 —— 这是「第二遍 0 解析」的基础。
  for (const entry of tree.entries) {
    counts.total += 1
    const skipDir = skipDirOf(entry.path)
    if (skipDir !== null) {
      counts.dir += 1
      continue
    }
    if (isTestPath(entry.path)) {
      counts.test += 1
      continue
    }
    if (isAssetPath(entry.path)) {
      counts.asset += 1
      continue
    }
    if (languageOf(entry.path) === null) {
      counts.unsupported += 1
      continue
    }
    if (entry.size > MAX_BLOB_BYTES) {
      counts.large += 1
      continue
    }
    // 上次判定为「自动生成」的内容块：不再读第二遍。
    if (previousGenerated[entry.sha] === true) {
      generated[entry.sha] = true
      counts.generated += 1
      continue
    }
    if (previousBlobs[entry.sha] !== undefined) {
      blobs[entry.sha] = previousBlobs[entry.sha]
      files[entry.path] = entry.sha
      sizes[entry.path] = entry.size
      counts.indexed += 1
      reusedBlobs += 1
      continue
    }
    files[entry.path] = entry.sha
    sizes[entry.path] = entry.size
    parsedShas.push({ path: entry.path, sha: entry.sha })
  }

  const pathSet = new Set(tree.entries.map((entry) => entry.path))

  // 第二遍：只为「真没见过」的内容块取一次内容。
  if (parsedShas.length > 0) {
    report(`解析 ${parsedShas.length} 个新内容块`)
    const batch = await catFileBatch(mirrorDir, parsedShas.map((row) => row.sha), {
      timeoutMs: options.blobTimeoutMs ?? 60_000,
    })
    if (!batch.ok) return { ok: false, error: batch.error }
    for (const row of parsedShas) {
      const buffer = batch.blobs.get(row.sha)
      if (buffer === undefined) {
        // 内容取不到（并发删除/损坏）：不写假数据，整只跳过并记账。
        counts.unsupported += 1
        delete files[row.path]
        delete sizes[row.path]
        continue
      }
      const text = decodeText(buffer)
      if (GENERATED_RE.test(text.slice(0, 4000))) {
        generated[row.sha] = true
        counts.generated += 1
        delete files[row.path]
        delete sizes[row.path]
        continue
      }
      blobs[row.sha] = parseBlobContent(row.path, text, pathSet)
      counts.indexed += 1
    }
  }

  report('读取改动时间')
  const changesResult = await lastChanges(mirrorDir, { cap: options.changesWindow ?? 200 })
  const changes = {}
  for (const [path, iso] of changesResult.changes) {
    if (files[path] !== undefined) changes[path] = iso
  }

  // 只保留还被引用着的内容块：索引体积要随「当前代码量」而不是「历史代码量」增长。
  const referenced = new Set(Object.values(files))
  const keptBlobs = {}
  for (const sha of referenced) {
    if (blobs[sha] !== undefined) keptBlobs[sha] = blobs[sha]
  }
  const keptGenerated = {}
  for (const sha of Object.keys(generated)) if (generated[sha] === true) keptGenerated[sha] = true

  const info = await headInfo(mirrorDir)
  const pages = pagesOf(files, keptBlobs)
  const indexedAt = new Date().toISOString()

  const document = {
    version: 1,
    repo,
    url: options.url ?? null,
    head: head.sha,
    headDate: info.date,
    headSubject: info.subject,
    indexedAt,
    // 这两行是给「增量到底生效了没有」用的：第二次跑同一个 HEAD 必须是 0。
    parsedBlobs: parsedShas.length,
    reusedBlobs,
    counts,
    pages: { convention: pages.convention, label: pages.label, items: pages.items },
    blobs: keptBlobs,
    generated: keptGenerated,
    files,
    sizes,
    changes,
    changesWindow: changesResult.ok ? changesResult.window ?? null : null,
  }

  await writeJsonAtomic(indexPath, document)

  return {
    ok: true,
    repo,
    head: head.sha,
    headDate: info.date,
    indexedAt,
    counts,
    pages: pages.items.length,
    pagesLabel: pages.label,
    pageItems: pages.items,
    parsedBlobs: document.parsedBlobs,
    reusedBlobs,
    warning: existing.warning,
    indexPath,
    durationMs: Date.now() - started,
  }
}

/** 索引写盘：临时文件 + rename，避免读到写了一半的 JSON。 */
export async function writeJsonAtomic(filePath, document) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(document)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, filePath)
}
