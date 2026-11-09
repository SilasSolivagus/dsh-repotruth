// 已接入仓库的登记表 + 覆盖率表。
//
// 为什么这两个放一起：覆盖率不是独立事实，它只是「每个仓最近一次索引跑成什么样」的投影。
// 分开存会出现两份互相矛盾的真相（表里 412 行、索引进度却 0 行）。
// 所以规则是：索引跑完 → 宿主把结果并进 repos.json → 同时重算 coverage.json。
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { coveragePath, dataDir, reposPath } from './paths.js'
import { looksLikeGitUrl, repoSlug } from './demo.js'
import { scrubUrl } from './git.js'

/** 只读文件、写回时保留未知字段：这份文件将来会加字段，旧版本不该把它们抹掉。 */
function normalizeRepoRow(row) {
  const name = typeof row?.name === 'string' ? row.name.trim() : ''
  if (name === '') return null
  return {
    name,
    url: typeof row?.url === 'string' ? row.url : '',
    host: typeof row?.host === 'string' ? row.host : '',
    addedAt: typeof row?.addedAt === 'string' ? row.addedAt : null,
    head: typeof row?.head === 'string' ? row.head : null,
    headDate: typeof row?.headDate === 'string' ? row.headDate : null,
    indexedAt: typeof row?.indexedAt === 'string' ? row.indexedAt : null,
    lastSyncAt: typeof row?.lastSyncAt === 'string' ? row.lastSyncAt : null,
    // running 会被持久化：宿主重启后靠它认出「上次没跑完」，而不是把它当成排过队。
    status: ['ok', 'failed', 'pending', 'running'].includes(row?.status) ? row.status : 'pending',
    error: typeof row?.error === 'string' ? row.error : null,
    counts: row?.counts && typeof row.counts === 'object' ? row.counts : null,
    pages: Number.isFinite(row?.pages) ? row.pages : 0,
    parsedBlobs: Number.isFinite(row?.parsedBlobs) ? row.parsedBlobs : null,
    durationMs: Number.isFinite(row?.durationMs) ? row.durationMs : null,
  }
}

export async function readRepos() {
  let text
  try {
    text = await readFile(reposPath(), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, repos: [], warning: null }
    return { version: 1, repos: [], warning: `读取仓库登记表失败：${error.message}` }
  }
  try {
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed?.repos) ? parsed.repos : []
    return { version: 1, repos: rows.map(normalizeRepoRow).filter((row) => row !== null), warning: null }
  } catch {
    return { version: 1, repos: [], warning: '仓库登记表不是合法 JSON，已按空表显示；原文件保持不动。' }
  }
}

async function writeJson(filePath, document) {
  const dir = dataDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, filePath)
}

export async function writeRepos(document) {
  await writeJson(reposPath(), { version: 1, repos: document.repos.map(normalizeRepoRow).filter((row) => row !== null) })
}

/**
 * 把「地址」或「owner/name」解析成可克隆的完整地址。
 * 为什么要支持 owner/name：用户在 GitLab 上看到的就是 `group/sub/project`，
 * 让他去拼完整 URL 是最容易拼错的一步。规则按代码源类型来，不靠猜。
 */
export function resolveRepoInput(input, hosts) {
  const raw = String(input ?? '').trim()
  if (raw === '') return { ok: false, error: '仓库地址不能为空' }
  if (looksLikeGitUrl(raw)) return { ok: true, url: raw }

  const short = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(raw)
  if (!short) {
    return { ok: false, error: '看不懂这个地址：请填完整地址（https://…）或 owner/name 形式' }
  }
  const configured = Array.isArray(hosts) ? hosts : []
  const host = configured.find((row) => row.kind === 'github') ?? configured[0] ?? null
  if (host === null) {
    return { ok: false, error: '填的是一段短名，但还没有登记代码源：先登记一个代码源，或直接填完整地址' }
  }
  if (host.kind === 'generic') {
    return { ok: false, error: '通用类型的代码源不知道仓库地址怎么拼，请直接填完整地址' }
  }
  const base = String(host.baseUrl ?? '').replace(/\/+$/, '')
  return { ok: true, url: `${base}/${raw.replace(/^\/+/, '')}${raw.endsWith('.git') ? '' : '.git'}`, host: host.name }
}

/** 仓名去重：同名时加 -2/-3，不覆盖已有索引（覆盖等于悄悄丢数据）。 */
export function uniqueName(existing, wanted) {
  const taken = new Set(existing.map((row) => row.name))
  if (!taken.has(wanted)) return wanted
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${wanted}-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${wanted}-${Date.now().toString(36)}`
}

/**
 * 一次索引结果 → 登记表里的那一行。
 * 只抄索引真的产出过的数字：没跑成功的仓，counts 为 null，界面上不允许显示成 0。
 */
export function repoRowFromResult(previous, result) {
  return {
    ...previous,
    url: result.url ?? previous?.url ?? '',
    head: result.head ?? null,
    headDate: result.headDate ?? null,
    indexedAt: result.indexedAt ?? null,
    lastSyncAt: new Date().toISOString(),
    status: 'ok',
    error: null,
    counts: result.counts ?? null,
    pages: Number.isFinite(result.pages) ? result.pages : 0,
    parsedBlobs: Number.isFinite(result.parsedBlobs) ? result.parsedBlobs : null,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
  }
}

/** 失败也要落表：失败仓从表里消失，等于把「看不见」藏起来。 */
export function repoRowFromFailure(previous, error) {
  return {
    ...previous,
    lastSyncAt: new Date().toISOString(),
    status: 'failed',
    error: String(error ?? '未知错误'),
  }
}

/**
 * 覆盖率表：由登记表投影出来。
 * 字段名保持与旧契约一致（filesIndexed / filesSkippedGenerated / ok），
 * 新增的分项（测试/第三方/素材/认不得/超大）只做补充，不改旧键的含义。
 */
export function coverageFromRepos(repos) {
  const rows = repos.map((row) => {
    const counts = row.counts ?? {}
    return {
      repo: row.name,
      url: row.url,
      head: row.head,
      headShort: typeof row.head === 'string' ? row.head.slice(0, 8) : null,
      headDate: row.headDate,
      filesTotal: Number.isFinite(counts.total) ? counts.total : 0,
      filesIndexed: Number.isFinite(counts.indexed) ? counts.indexed : 0,
      filesSkippedGenerated: Number.isFinite(counts.generated) ? counts.generated : 0,
      filesSkippedTest: Number.isFinite(counts.test) ? counts.test : 0,
      filesSkippedDir: Number.isFinite(counts.dir) ? counts.dir : 0,
      filesSkippedAsset: Number.isFinite(counts.asset) ? counts.asset : 0,
      filesUnsupported: Number.isFinite(counts.unsupported) ? counts.unsupported : 0,
      filesLarge: Number.isFinite(counts.large) ? counts.large : 0,
      pages: row.pages ?? 0,
      // 「跑过但没有结果」和「跑失败了」是两件事，状态上必须分开。
      ok: row.status === 'ok',
      error: row.error,
      indexedAt: row.indexedAt,
    }
  })
  return { generatedAt: new Date().toISOString(), repos: rows }
}

export async function writeCoverage(repos) {
  const document = coverageFromRepos(repos)
  await writeJson(coveragePath(), document)
  return document
}

/** 对外安全：地址里若夹带凭据（`https://user:tok@…`），一律抹掉再返回。 */
export function publicUrl(url) {
  return scrubUrl(url)
}
