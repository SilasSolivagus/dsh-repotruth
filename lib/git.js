// 所有 git 调用的唯一出口（索引子进程 + 宿主共用）。
//
// 为什么必须收口：
// 1. 凭据只走环境变量，绝不出现在 argv 里——`ps` 能看到整条命令行，argv 带令牌等于把令牌贴在进程列表上。
// 2. 超时、maxBuffer、GIT_TERMINAL_PROMPT=0 这些开关只在一种写法里设对。散在各个调用点，
//    总有一次忘了 GIT_TERMINAL_PROMPT，于是私有仓在无人值守时挂在「Username:」上不返回。
// 3. 这里只用只读命令（clone/fetch/ls-tree/cat-file/log/rev-parse）。
//    绝不出现 clean / checkout / reset / rm —— 本项目永远不会在别人的工作区里删东西。
import { execFile, spawn } from 'node:child_process'

const BASE_ENV = {
  // 交互式凭据提示会让无头进程永久挂住：这一条是硬要求，不是优化。
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
}

/** 认证头：GitHub 用 Bearer，GitLab 用 PRIVATE-TOKEN。返回 git 的 GIT_CONFIG_* 环境变量对。 */
export function authEnv(kind, token) {
  const value = typeof token === 'string' ? token.trim() : ''
  if (value === '' || (kind !== 'github' && kind !== 'gitlab')) return {}
  const header = kind === 'gitlab' ? `PRIVATE-TOKEN: ${value}` : `AUTHORIZATION: Bearer ${value}`
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: header }
}

function envFor(extra) {
  return { ...process.env, ...BASE_ENV, ...(extra ?? {}) }
}

/** 失败的 git 调用返回 ok:false 而不是抛：调用方要的是「为什么失败」，不是栈。 */
export function git(args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        env: envFor(options.env),
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, stdout: stdout ?? '', stderr: String(stderr ?? ''), error })
          return
        }
        resolve({ ok: true, stdout: stdout ?? '', stderr: String(stderr ?? '') })
      },
    )
  })
}

/** 只保留最后几行 stderr：git 的报错前几行常常是噪音，真正的原因在末尾。 */
export function tailLines(text, count = 3) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-count)
    .join(' ')
}

/** 把 URL 里可能夹带的凭据抹掉：`https://user:tok@host/x` → `https://***@host/x`。 */
export function scrubUrl(value) {
  return String(value ?? '').replace(/\/\/[^/@\s]+@/g, '//***@')
}

const CLONE_TIMEOUT_MS = 180_000
const FETCH_TIMEOUT_MS = 120_000

/**
 * git 的英文报错 → 中文原因。
 * 为什么必须翻译：看界面的人要判断「下一步该改地址、还是找权限、还是重试」，
 * 「fatal: Could not read from remote repository」给不出这个判断。
 * 认不出的情况保留原文，但一定先说中文结论——绝不只丢一段英文栈。
 */
export function explainGitFailure(stderr) {
  const text = String(stderr ?? '').toLowerCase()
  const rules = [
    [/could not read from remote repository|repository not found|does not appear to be a git repository|not found/, '找不到这个仓库：地址不对，或者当前凭据没有读权限'],
    [/authentication failed|could not read username|invalid username or password|401/, '认证失败：需要令牌，或者令牌没有读权限'],
    [/could not resolve host|name or service not known|nodename nor servname/, '域名解析失败：检查地址是否写错，或这台机器能否访问该域名'],
    [/connection timed out|operation timed out|timed out/, '连接超时：网络到不了对方'],
    [/connection refused/, '对方拒绝连接：端口或地址不对'],
    [/permission denied \(publickey\)/, 'SSH 公钥没有被接受：换成 https 地址，或先把公钥加到这个代码平台'],
    [/ssl|tls|certificate/, '证书校验失败：自建服务器常见，需要让系统信任该证书'],
    [/empty repository|no commits yet/, '远端是空仓：还没有任何提交，没有可索引的内容'],
    [/couldn't find remote ref|remote branch .* not found/, '远端分支找不到：默认分支可能被删了'],
  ]
  for (const [pattern, reason] of rules) {
    if (pattern.test(text)) return reason
  }
  const tail = tailLines(stderr, 1)
  return tail === '' ? 'git 没有给出原因' : `git 报错：${tail.replace(/^fatal:\s*/i, '')}`
}

/**
 * 克隆成 bare mirror。
 * 为什么是 mirror：后续每次只要 `fetch`，不重新克隆；而且没有工作区，
 * 天然不会碰到用户的文件，也不会被仓库里的 .gitignore/.gitattributes 影响。
 */
export async function mirrorClone(url, dir, options = {}) {
  const timeoutMs = options.timeoutMs ?? CLONE_TIMEOUT_MS
  const result = await git(['clone', '--mirror', '--quiet', scrubUrl(url), dir], {
    timeoutMs,
    env: options.env,
  })
  if (result.ok) return { ok: true }
  const reason = timeoutReason(result, timeoutMs) ?? explainGitFailure(result.stderr)
  return { ok: false, error: reason }
}

/** 已有 mirror 时只做 fetch：这就是「第二次不再重克隆」的实现。 */
export async function mirrorFetch(dir, options = {}) {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const result = await git(['-C', dir, 'fetch', '--prune', '--prune-tags', '--quiet', 'origin'], {
    timeoutMs,
    env: options.env,
  })
  if (result.ok) return { ok: true }
  return { ok: false, error: timeoutReason(result, timeoutMs) ?? explainGitFailure(result.stderr) }
}

function timeoutReason(result, timeoutMs) {
  const timedOut = result?.error?.killed === true || result?.error?.signal === 'SIGTERM'
  if (!timedOut) return null
  return `超时：${Math.round(timeoutMs / 1000)} 秒内没有完成（网络太慢或仓库太大），已终止`
}

/** 当前 HEAD。mirror 的 HEAD 指默认分支，取不到再退回各分支里最新的一支。 */
export async function headOf(dir) {
  const direct = await git(['-C', dir, 'rev-parse', '--verify', 'HEAD'])
  if (direct.ok) return { ok: true, sha: direct.stdout.trim() }
  const fallback = await git([
    '-C', dir, 'for-each-ref', '--sort=-committerdate', '--count=1', '--format=%(objectname)', 'refs/heads',
  ])
  const sha = fallback.ok ? fallback.stdout.trim() : ''
  if (sha !== '') return { ok: true, sha }
  return { ok: false, error: '镜像里没有任何分支：远端可能是空仓，或默认分支还没有提交' }
}

/** HEAD 的提交日期与标题。材料必须带快照日期，这是唯一出处。 */
export async function headInfo(dir) {
  const log = await git(['-C', dir, 'log', '-1', '--format=%cI%n%s'])
  if (!log.ok) return { date: null, subject: null }
  const [dateLine, ...rest] = log.stdout.split('\n')
  return { date: dateLine?.trim() || null, subject: rest.join('\n').trim() || null }
}

/**
 * 列出 HEAD 的整棵树：路径 + blob id + 字节数。
 * 一次调用拿全，不逐个文件 stat —— 这是增量能不能跑得快的前提。
 */
export async function listTree(dir) {
  const result = await git(['-C', dir, 'ls-tree', '-r', '-l', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 })
  if (!result.ok) return { ok: false, error: `读取文件清单失败：${tailLines(result.stderr) || 'git 没有给出原因'}` }
  const entries = []
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue
    // 形如：100644 blob <sha>    <size>\t<path>
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const meta = line.slice(0, tab).split(/\s+/)
    const path = line.slice(tab + 1)
    if (meta.length < 4 || meta[1] !== 'blob') continue
    const size = Number(meta[3])
    entries.push({ path, sha: meta[2], size: Number.isFinite(size) ? size : 0 })
  }
  return { ok: true, entries }
}

/**
 * 一次取多个 blob 的内容（`cat-file --batch`）。
 * 逐个 `git show` 会让每次索引变成上千次进程启动；批量是唯一能跑完的写法。
 * 返回 Map<sha, Buffer>，缺的 sha 不会出现在返回里（调用方据此记账）。
 */
export async function catFileBatch(dir, shas, options = {}) {
  const wanted = [...new Set(shas)].filter((sha) => /^[0-9a-f]{40,64}$/.test(sha))
  const out = new Map()
  if (wanted.length === 0) return { ok: true, blobs: out }
  // 分块：一次喂太多 sha 会让子进程的 stdout 缓冲区膨胀到不可控的量。
  const chunkSize = options.chunkSize ?? 200
  for (let start = 0; start < wanted.length; start += chunkSize) {
    const chunk = wanted.slice(start, start + chunkSize)
    const batch = await batchOnce(dir, chunk, options)
    if (!batch.ok) return batch
    for (const [sha, buffer] of batch.blobs) out.set(sha, buffer)
  }
  return { ok: true, blobs: out }
}

/** 真正喂 stdin 的那一次：写清单 → 读回 `<sha> blob <size>\n<内容>\n`。 */
function batchOnce(dir, shas, options = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', dir, 'cat-file', '--batch'], {
      env: envFor(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks = []
    let size = 0
    const cap = options.maxBuffer ?? 64 * 1024 * 1024
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, options.timeoutMs ?? 60_000)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size <= cap) chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `读取文件内容失败：${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && chunks.length === 0) {
        resolve({ ok: false, error: `读取文件内容失败：${tailLines(stderr) || `退出码 ${code}`}` })
        return
      }
      resolve(parseBatch(Buffer.concat(chunks), shas))
    })
    child.stdin.end(`${shas.join('\n')}\n`)
  })
}

/** 解析 --batch 的输出流。格式固定，但要容忍 `missing` 行（blob 被删过）。 */
function parseBatch(buffer, shas) {
  const blobs = new Map()
  let offset = 0
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf(0x0a, offset)
    if (lineEnd === -1) break
    const header = buffer.subarray(offset, lineEnd).toString('utf8')
    offset = lineEnd + 1
    const parts = header.split(' ')
    if (parts.length < 3) continue // `<sha> missing`
    const size = Number(parts[2])
    if (!Number.isFinite(size)) continue
    const body = buffer.subarray(offset, offset + size)
    offset += size + 1 // 内容后面跟一个换行
    blobs.set(parts[0], Buffer.from(body))
  }
  // 只在真的缺少内容时留下证据，不猜。
  void shas
  return { ok: true, blobs }
}

/**
 * 每个文件最近一次改动时间。
 * 为什么只取最近 cap 个提交：全量历史在大仓上要跑几十秒，而「多旧」只需要一个上界。
 * 不在窗口内的文件不会有条目——调用方必须把它读成「读不到」而不是「没改过」。
 */
export async function lastChanges(dir, options = {}) {
  const cap = options.cap ?? 200
  const result = await git(
    ['-C', dir, 'log', `-n`, String(cap), '--format=%cI', '--name-only', '--no-merges'],
    { maxBuffer: 32 * 1024 * 1024, timeoutMs: 60_000 },
  )
  const changes = new Map()
  if (!result.ok) return { ok: false, changes, error: tailLines(result.stderr) }
  let current = null
  for (const raw of result.stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (/^\d{4}-\d{2}-\d{2}T/.test(line)) {
      current = line
      continue
    }
    if (current === null) continue
    if (!changes.has(line)) changes.set(line, current) // 日志是新的在前，第一次出现即最近一次
  }
  return { ok: true, changes, window: cap }
}
