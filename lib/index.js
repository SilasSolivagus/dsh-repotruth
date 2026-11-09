// 宿主半边（跑在 dsh 的 Node 进程里）：配置持久化 + 连接测试 + 覆盖率只读接口。
//
// 为什么宿主做这些而不是浏览器直接做：
// 1. 令牌是凭据，只允许落在这台机器的 600 文件里，不进浏览器 localStorage；
// 2. 直连 GitLab/GitHub 会被跨域拦住，由宿主代发请求才稳定；
// 3. 覆盖率文件在磁盘上，浏览器读不到 file://，必须由宿主读出来。
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// 数据目录的唯一出处与 demo 命令共用（lib/paths.js）：两处各写一遍路径，
// 迟早在某个平台分支上不一致，而那种 bug 只在别人的机器上出现。
import { answersDir, configPath, coveragePath, dataDir, indexDir, indexPath, mirrorPath, mirrorsDir } from './paths.js'
import { isAttributionEnabled, version } from './branding.js'
import { repoSlug } from './demo.js'
import { getJob, startJob, listJobs, killAllJobs } from './jobs.js'
import {
  coverageFromRepos,
  publicUrl,
  readRepos,
  repoRowFromFailure,
  repoRowFromResult,
  resolveRepoInput,
  uniqueName,
  writeCoverage,
  writeRepos,
} from './repos.js'
import { askQuestion } from './ask.js'
import { renderAnswer } from './answer.js'

/** 插件对外名字。客户端 bundle 里的 id 必须和它一致，否则模块图对不上。 */
export const name = 'dsh-plugin-repotruth'

/** 需要 webServer 才能注册 HTTP 路由；缺了它整个宿主半边不会启动，而不是半死状态。 */
export const inject = ['webServer']

const ROUTE_PREFIX = '/api/repo-truth'
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * 令牌掩码：只露出类型前缀和末 4 位，例如 glpat-…a1b2。
 * 显式的掩码函数好过调用点各写一遍 slice，后者总有一次会忘了截断。
 */
function maskToken(token) {
  const value = typeof token === 'string' ? token : ''
  if (value === '') return ''
  if (value.length <= 8) return '…'
  const tail = value.slice(-4)
  const head = /^([A-Za-z]{2,8})[-_]/.exec(value)
  return head ? `${head[1]}-…${tail}` : `…${tail}`
}

/** 配置读盘：坏文件按“空配置”处理并带上中文原因，绝不让一行坏数据把整个页面打死。 */
async function readConfig() {
  let text
  try {
    text = await readFile(configPath(), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, hosts: [], attribution: true, warning: null }
    return { version: 1, hosts: [], attribution: true, warning: `读取配置文件失败：${error.message}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { version: 1, hosts: [], attribution: true, warning: '配置文件不是合法 JSON，已按空配置显示；原文件保持不动。' }
  }
  const hosts = Array.isArray(parsed?.hosts) ? parsed.hosts : []
  const normalized = hosts
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      name: typeof row.name === 'string' ? row.name : '',
      baseUrl: typeof row.baseUrl === 'string' ? row.baseUrl : '',
      kind: row.kind === 'github' || row.kind === 'generic' ? row.kind : 'gitlab',
      token: typeof row.token === 'string' ? row.token : '',
    }))
    .filter((row) => row.name !== '' && row.baseUrl !== '')
  // attribution 是企业场景的开关：缺字段/写错类型都落回「开」，只有显式 false 才关。
  // 之所以在这里就读出来：界面保存代码源时走的是同一个 config 对象，
  // 如果读的时候丢掉这个键，写回时就会把用户关掉的署名悄悄打开。
  return { version: 1, hosts: normalized, attribution: isAttributionEnabled(parsed), warning: null }
}

/**
 * 配置写盘：先写临时文件再 rename（原子替换），并强制 600。
 * 为什么先 chmod 目录：600 的文件放在 755 目录里，同机其它账号仍能遍历名字，
 * 顺手把目录收成 700 才是完整的收口。
 */
async function writeConfig(document) {
  const dir = dataDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await chmod(dir, 0o700)
  } catch {
    // 目录不属于当前用户时 chmod 会失败；此时文件级 600 仍然是有效防线。
  }
  // attribution 为 false 时才写盘：默认值不落字段，配置文件保持干净可读。
  const payload = { version: 1, hosts: document.hosts }
  if (document.attribution === false) payload.attribution = false
  const body = `${JSON.stringify(payload, null, 2)}\n`
  const tmp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, body, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, configPath())
  await chmod(configPath(), 0o600)
}

/** 对外只输出掩码，令牌明文在任何响应里都不出现。 */
function publicHost(row) {
  return {
    name: row.name,
    baseUrl: row.baseUrl,
    kind: row.kind,
    tokenMasked: maskToken(row.token),
    hasToken: row.token !== '',
  }
}

/**
 * 收集底层错误码。undici 的 fetch 失败会把真实原因埋在 cause 里，
 * 有时还会套一层 AggregateError（多地址并发连接），所以要把两层都翻出来，
 * 否则用户只会看到一句没用的 “fetch failed”。
 */
function errorCodes(error) {
  const codes = []
  const visit = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 4) return
    if (typeof node.code === 'string') codes.push(node.code)
    if (Array.isArray(node.errors)) for (const inner of node.errors) visit(inner, depth + 1)
    visit(node.cause, depth + 1)
  }
  visit(error, 0)
  return codes.filter((code) => code !== 'ERR_')
}

/** 中文错误：把底层网络错误翻译成“下一步该查什么”，不抛英文栈。 */
function explainError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '连接超时（10 秒内没有响应）'
  const code = errorCodes(error)[0]
  // fetch 规范里有一批“被禁止的端口”（25、9 等），底层只回一句 bad port，没有错误码。
  if (code === undefined && /bad port/i.test(String(error?.cause?.message ?? ''))) {
    return '端口不被允许：这个端口在客户端的禁用名单里，换一个 Git 服务端口再试'
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析失败：检查地址是否写错，或这台机器能否访问该域名'
    case 'ECONNREFUSED':
      return '对方拒绝连接：端口或地址不对，或者服务没有在跑'
    case 'ECONNRESET':
      return '连接被对方重置：常见于代理或网关拦截'
    case 'ETIMEDOUT':
      return '连接超时：网络到不了这台机器'
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return '证书校验失败：自建服务器常见，需要让系统信任该证书后再试'
    default:
      return `连接失败：${error?.message ?? '未知错误'}`
  }
}

/** 统一清理基础地址：去掉尾部斜杠，避免拼出 //api/v4。 */
function normalizeBaseUrl(raw) {
  return String(raw ?? '').trim().replace(/\/+$/, '')
}

/**
 * 拼「代码源的只读接口」请求：测试连接与列仓库共用同一份规则。
 * 为什么必须共用：两处各拼一次 URL，某天 GitLab 升级成 /api/v4 之外的路径，
 * 就会出现「测试连接是通的、列仓库是 404」这种自相矛盾的现场。
 * mode: 'probe'（只要一行的探针）| 'list'（一页仓库清单）。
 */
function hostApiRequest(row, mode) {
  const baseUrl = normalizeBaseUrl(row.baseUrl)
  const token = typeof row.token === 'string' ? row.token : ''
  const headers = { accept: 'application/json', 'user-agent': 'dsh-plugin-repotruth' }
  const perPage = mode === 'list' ? 50 : 1
  let url
  if (row.kind === 'gitlab') {
    url = `${baseUrl}/api/v4/projects?per_page=${perPage}&simple=true&membership=true`
    if (token !== '') headers['private-token'] = token
  } else if (row.kind === 'github') {
    url = `${baseUrl}/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`
    if (token !== '') headers.authorization = `Bearer ${token}`
    headers['x-github-api-version'] = '2022-11-28'
  } else {
    url = baseUrl
    if (token !== '') headers.authorization = `Bearer ${token}`
  }
  return { url, headers, token }
}

/** 状态码 → 中文原因。令牌在这里也必须先掩码，兜住「底层回显请求头」的情况。 */
function statusReason(status, token) {
  const byStatus = {
    401: '令牌无效或已过期',
    403: '令牌权限不足（GitLab 需要 read_api，GitHub 需要 repo 读权限）',
    404: '地址或路径不对：找不到接口，检查基础地址是否包含多余子路径',
    429: '请求太频繁，被限流了，稍后再试',
  }
  const reason = byStatus[status] ?? `对方返回状态码 ${status}`
  return reason.replace(token === '' ? '' : token, maskToken(token))
}

/**
 * 测试连接：只做一次只读请求，回答两件事——通不通、看得见几个仓库。
 * 只读是硬约束：这里绝不创建/修改远端任何东西。
 */
async function probeHost(row) {
  const { url, headers, token } = hostApiRequest(row, 'probe')
  const kind = row.kind

  let response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) })
  } catch (error) {
    return { ok: false, error: explainError(error) }
  }

  if (!response.ok) return { ok: false, error: statusReason(response.status, token) }

  if (kind === 'generic') {
    return { ok: true, count: null, message: '能连上（通用类型不统计仓库数）' }
  }

  let count = null
  if (kind === 'gitlab') {
    const total = response.headers.get('x-total')
    if (total !== null && /^\d+$/.test(total)) count = Number(total)
  }
  if (kind === 'github') {
    const link = response.headers.get('link')
    const last = link === null ? null : /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link)
    if (last !== null) count = Number(last[1])
  }
  if (count === null) {
    try {
      const rows = await response.json()
      count = Array.isArray(rows) ? rows.length : null
    } catch {
      count = null
    }
  }

  return {
    ok: true,
    count,
    message:
      count === null
        ? '能连上，但对方没给总数'
        : count === 1
          ? '能连上，至少有 1 个可见仓库'
          : `能连上，至少有 ${count} 个可见仓库`,
  }
}

/**
 * 列出一个已登记代码源上的仓库（只读）。
 * 这就是「从来源里挑一个接进来」那一步的数据源：它复用测试连接拼出来的同一个请求，
 * 所以「测试连接说通、列仓库却 404」这种事不会发生。
 */
async function listSourceRepos(row) {
  if (row.kind === 'generic') {
    return { ok: true, repos: [], message: '通用类型不提供仓库清单，请直接填完整地址' }
  }
  const { url, headers, token } = hostApiRequest(row, 'list')
  let response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) })
  } catch (error) {
    return { ok: false, error: explainError(error) }
  }
  if (!response.ok) return { ok: false, error: statusReason(response.status, token) }
  let rows
  try {
    rows = await response.json()
  } catch {
    return { ok: false, error: '对方返回的不是仓库清单（不是合法 JSON）' }
  }
  if (!Array.isArray(rows)) return { ok: false, error: '对方返回的不是仓库清单' }
  const repos = rows
    .map((item) =>
      row.kind === 'gitlab'
        ? { name: item?.path_with_namespace ?? item?.name, url: item?.http_url_to_repo ?? null }
        : { name: item?.full_name ?? item?.name, url: item?.clone_url ?? null },
    )
    .filter((item) => typeof item.name === 'string' && typeof item.url === 'string' && item.url !== '')
  return {
    ok: true,
    repos,
    message: repos.length === 0 ? '这个令牌看得见的仓库里没有可接入的' : `看见 ${repos.length} 个仓库`,
  }
}

/** 覆盖率文件：只读。没有文件就说“没有”，不说“没有仓库”——这是两件事。 */
async function readCoverage() {
  let text
  try {
    text = await readFile(coveragePath(), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, path: coveragePath(), repos: [], warning: null }
    return { present: false, path: coveragePath(), repos: [], warning: `读取覆盖率文件失败：${error.message}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { present: false, path: coveragePath(), repos: [], warning: '覆盖率文件不是合法 JSON。' }
  }
  const repos = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.repos) ? parsed.repos : []
  // 旧字段保持原样（filesIndexed / filesSkippedGenerated / ok），新分项只做补充：
  // 「读不进去的那部分」必须能分项看到，否则一张覆盖率表会让人以为没跳过的都没问题。
  return {
    present: true,
    path: coveragePath(),
    generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : null,
    repos: repos.map((row) => ({
      repo: String(row?.repo ?? row?.name ?? '（未命名）'),
      url: typeof row?.url === 'string' ? publicUrl(row.url) : null,
      head: typeof row?.head === 'string' ? row.head : null,
      headShort: typeof row?.headShort === 'string' ? row.headShort : null,
      headDate: typeof row?.headDate === 'string' ? row.headDate : null,
      filesTotal: Number.isFinite(row?.filesTotal) ? row.filesTotal : 0,
      filesIndexed: Number.isFinite(row?.filesIndexed) ? row.filesIndexed : 0,
      filesSkippedGenerated: Number.isFinite(row?.filesSkippedGenerated) ? row.filesSkippedGenerated : 0,
      filesSkippedTest: Number.isFinite(row?.filesSkippedTest) ? row.filesSkippedTest : 0,
      filesSkippedDir: Number.isFinite(row?.filesSkippedDir) ? row.filesSkippedDir : 0,
      filesSkippedAsset: Number.isFinite(row?.filesSkippedAsset) ? row.filesSkippedAsset : 0,
      filesUnsupported: Number.isFinite(row?.filesUnsupported) ? row.filesUnsupported : 0,
      filesLarge: Number.isFinite(row?.filesLarge) ? row.filesLarge : 0,
      pages: Number.isFinite(row?.pages) ? row.pages : 0,
      ok: row?.ok === true,
      error: typeof row?.error === 'string' ? row.error : null,
      indexedAt: typeof row?.indexedAt === 'string' ? row.indexedAt : null,
    })),
    warning: null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 仓库 / 任务 / 问一句：宿主侧的实现。
//
// 一条贯穿所有接口的规矩：**写盘只有一处**。索引由子进程写自己的索引文件，
// 登记表与覆盖率只由宿主写。两处都写同一份文件，迟早出现「表里 412 行、索引 0 行」。
// ─────────────────────────────────────────────────────────────────────────────

/** 写盘串行化：两个仓同时跑完时，不能各自读-改-写一遍登记表（后写的会吃掉先写的）。 */
let persistChain = Promise.resolve()
function serialize(task) {
  persistChain = persistChain.then(task, task)
  return persistChain
}

/**
 * 等所有挂起的落表写完。
 * 测试用它保证「任务结束」真的意味着「登记表已更新」；生产代码不需要等，
 * 因为面板是轮询的，晚一拍看到也没关系。
 */
export async function flushPersistence() {
  await persistChain
}

/** 任务 → 面板可读的形状（令牌从不进任务，这里也就不可能漏）。 */
function publicJob(job) {
  if (job === null || job === undefined) return null
  return {
    id: job.id,
    repo: job.repo,
    status: job.status,
    phase: job.phase,
    message: job.message,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    elapsedMs: job.elapsedMs,
    error: job.error,
    log: (job.log ?? []).slice(-8),
    result:
      job.result === null || job.result === undefined
        ? null
        : {
            head: job.result.head,
            headDate: job.result.headDate,
            counts: job.result.counts,
            pages: job.result.pages,
            parsedBlobs: job.result.parsedBlobs,
            reusedBlobs: job.result.reusedBlobs,
            durationMs: job.result.durationMs,
            mode: job.result.mode,
          },
  }
}

/** 登记表一行 + 当前任务 → 面板那一行。状态优先取「正在跑」，否则取上次结果。 */
function publicRepo(row) {
  const current = listJobs(row.name).find((job) => job.status === 'running') ?? null
  // 登记表里写着 running、但内存里没有对应任务 —— 说明宿主重启过或任务被杀。
  // 这种情况必须单独说成「没跑完」，不能让界面一直转圈。
  const interrupted = current === null && row.status === 'running'
  return {
    name: row.name,
    url: publicUrl(row.url),
    host: row.host,
    addedAt: row.addedAt,
    head: row.head,
    headShort: typeof row.head === 'string' ? row.head.slice(0, 8) : null,
    headDate: row.headDate,
    indexedAt: row.indexedAt,
    lastSyncAt: row.lastSyncAt,
    status: current !== null ? 'running' : interrupted ? 'interrupted' : row.status,
    error: current === null ? row.error : null,
    counts: row.counts,
    pages: row.pages,
    parsedBlobs: row.parsedBlobs,
    durationMs: row.durationMs,
    mirrorPath: mirrorPath(row.name),
    indexPath: indexPath(row.name),
    job: publicJob(current),
  }
}

/** 任务结束后把结果并进登记表，再重算覆盖率表。失败也要落表。 */
async function persistJob(job) {
  await serialize(async () => {
    const registry = await readRepos()
    const index = registry.repos.findIndex((row) => row.name === job.repo)
    if (index === -1) return // 仓在同步过程中被删了：不复活它
    const previous = registry.repos[index]
    registry.repos[index] =
      job.status === 'done' ? repoRowFromResult(previous, job.result) : repoRowFromFailure(previous, job.error)
    await writeRepos(registry)
    await writeCoverage(registry.repos)
  })
}

/** 起一轮同步。宿主只在「登记状态」上花几毫秒，真正的活在子进程里。 */
async function beginSync(row, config) {
  const host = config.hosts.find((item) => item.name === row.host) ?? null
  const started = startJob({
    repo: row.name,
    url: row.url,
    token: host?.token ?? '',
    kind: host?.kind ?? '',
    onFinish: (job) => {
      persistJob(job).catch(() => {})
    },
  })
  if (started.ok !== true) return started
  await serialize(async () => {
    const registry = await readRepos()
    const index = registry.repos.findIndex((item) => item.name === row.name)
    if (index === -1) return
    registry.repos[index] = { ...registry.repos[index], status: 'running', error: null }
    await writeRepos(registry)
  })
  return started
}

function newAnswerId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 答案文件只留最近若干份：这是可再生成的派生物，不是档案。 */
async function pruneAnswers(keep = 60) {
  try {
    const dir = answersDir()
    const names = (await readdir(dir)).filter((name) => name.endsWith('.html'))
    if (names.length <= keep) return
    const rows = []
    for (const name of names) {
      try {
        rows.push({ name, at: (await stat(join(dir, name))).mtimeMs })
      } catch {
        // 刚被删掉：忽略
      }
    }
    rows.sort((a, b) => b.at - a.at)
    for (const row of rows.slice(keep)) await rm(join(dir, row.name), { force: true })
  } catch {
    // 清理失败不影响回答本身
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 请求体：限长 64KB。超了直接拒，不让一个畸形请求把进程内存吃掉。 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function normalizeHostInput(body) {
  return {
    name: String(body?.name ?? '').trim(),
    baseUrl: normalizeBaseUrl(body?.baseUrl),
    kind: body?.kind === 'github' || body?.kind === 'generic' ? body.kind : 'gitlab',
    token: typeof body?.token === 'string' ? body.token.trim() : '',
  }
}

/**
 * 宿主插件入口：注册一条前缀路由，内部再分派。
 * 为什么只注册一条前缀路由：dsh 的 webServer 对 (kind, path) 判重，
 * 前缀路由自己会匹配 path 与 path/*，多注册几条只会互相覆盖。
 */
export function apply(ctx) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && sub === '/health') {
        const config = await readConfig()
        return sendJson(res, 200, {
          ok: true,
          plugin: name,
          version: version(),
          // 署名状态放在自检里：企业现场排查「为什么页脚没了」时，第一个该看的就是这一行。
          attribution: config.attribution,
          dataDir: dataDir(),
          configPath: configPath(),
          coveragePath: coveragePath(),
          mirrorDir: mirrorsDir(),
          indexDir: indexDir(),
        })
      }

      if (method === 'GET' && sub === '/config') {
        const config = await readConfig()
        return sendJson(res, 200, {
          ok: true,
          hosts: config.hosts.map(publicHost),
          attribution: config.attribution,
          warning: config.warning,
          path: configPath(),
        })
      }

      if (method === 'GET' && sub === '/coverage') {
        return sendJson(res, 200, { ok: true, ...(await readCoverage()) })
      }

      if (method === 'POST' && sub === '/hosts') {
        const body = await readJsonBody(req)
        const input = normalizeHostInput(body)
        if (input.name === '') return sendJson(res, 400, { ok: false, error: '名称不能为空' })
        if (input.baseUrl === '') return sendJson(res, 400, { ok: false, error: '地址不能为空' })
        if (!/^https?:\/\//i.test(input.baseUrl)) {
          return sendJson(res, 400, { ok: false, error: '地址要以 http:// 或 https:// 开头' })
        }
        const config = await readConfig()
        const originalName = typeof body?.originalName === 'string' ? body.originalName.trim() : ''
        const index = originalName === ''
          ? config.hosts.findIndex((row) => row.name === input.name)
          : config.hosts.findIndex((row) => row.name === originalName)
        if (originalName === '' && index !== -1) {
          return sendJson(res, 409, { ok: false, error: `已经有一个叫「${input.name}」的代码源` })
        }
        if (originalName !== '' && index === -1) {
          return sendJson(res, 404, { ok: false, error: '要修改的代码源不存在（可能已被其它窗口删掉）' })
        }
        // 编辑时令牌留空 = 沿用旧令牌。否则每次改地址都要重新贴一遍凭据。
        const previous = index === -1 ? null : config.hosts[index]
        const merged = { ...input, token: input.token === '' && previous !== null ? previous.token : input.token }
        if (index === -1) config.hosts.push(merged)
        else config.hosts[index] = merged
        await writeConfig(config)
        // 回包也带上 attribution：界面拿到新列表时可以顺手刷新「页脚署名」这一行，
        // 而不用再打一次 /config。
        return sendJson(res, 200, { ok: true, hosts: config.hosts.map(publicHost), attribution: config.attribution })
      }

      if (method === 'POST' && sub === '/hosts/delete') {
        const body = await readJsonBody(req)
        const target = String(body?.name ?? '').trim()
        const config = await readConfig()
        const before = config.hosts.length
        config.hosts = config.hosts.filter((row) => row.name !== target)
        if (config.hosts.length === before) {
          return sendJson(res, 404, { ok: false, error: '要删除的代码源不存在' })
        }
        await writeConfig(config)
        return sendJson(res, 200, { ok: true, hosts: config.hosts.map(publicHost), attribution: config.attribution })
      }

      if (method === 'POST' && sub === '/test') {
        const body = await readJsonBody(req)
        const input = normalizeHostInput(body)
        if (input.baseUrl === '') return sendJson(res, 400, { ok: false, error: '地址不能为空' })
        // 表单里令牌留空时，用已保存的那一条，避免“测试时必须重新贴令牌”。
        if (input.token === '' && typeof body?.name === 'string' && body.name !== '') {
          const config = await readConfig()
          const found = config.hosts.find((row) => row.name === body.name)
          if (found) input.token = found.token
        }
        const result = await probeHost(input)
        return sendJson(res, 200, result)
      }

      if (method === 'GET' && sub === '/repos') {
        const registry = await readRepos()
        return sendJson(res, 200, {
          ok: true,
          repos: registry.repos.map(publicRepo),
          warning: registry.warning,
          dataDir: dataDir(),
        })
      }

      if (method === 'POST' && sub === '/repos') {
        const body = await readJsonBody(req)
        const config = await readConfig()
        const resolved = resolveRepoInput(body?.url ?? body?.ownerName, config.hosts)
        if (resolved.ok !== true) return sendJson(res, 400, { ok: false, error: resolved.error })
        const registry = await readRepos()
        const duplicate = registry.repos.find((row) => row.url === resolved.url)
        if (duplicate !== undefined) {
          return sendJson(res, 409, { ok: false, error: `这个仓已经接入了（叫「${duplicate.name}」），不用重复添加` })
        }
        const name = uniqueName(registry.repos, repoSlug(resolved.url))
        const row = {
          name,
          url: resolved.url,
          host: resolved.host ?? '',
          addedAt: new Date().toISOString(),
          status: 'pending',
          error: null,
          counts: null,
          pages: 0,
        }
        registry.repos.push(row)
        await writeRepos(registry)
        await writeCoverage(registry.repos)
        // 添加即开跑：用户点完「接入」应该看到进度，而不是再去点一次同步。
        const started = await beginSync(row, config)
        return sendJson(res, 200, {
          ok: true,
          repo: publicRepo(row),
          jobId: started.ok === true ? started.job.id : null,
          warning: started.ok === true ? null : started.error,
        })
      }

      if (method === 'POST' && sub === '/repos/delete') {
        const body = await readJsonBody(req)
        const target = String(body?.name ?? '').trim()
        const registry = await readRepos()
        const found = registry.repos.find((row) => row.name === target)
        if (found === undefined) return sendJson(res, 404, { ok: false, error: '要移除的仓库不存在' })
        registry.repos = registry.repos.filter((row) => row.name !== target)
        await writeRepos(registry)
        await writeCoverage(registry.repos)
        // 只删我们自己生成的两样东西：索引文件与 bare 镜像。绝不动用户的任何目录。
        await rm(indexPath(found.name), { force: true })
        await rm(mirrorPath(found.name), { recursive: true, force: true })
        return sendJson(res, 200, { ok: true, repos: registry.repos.map(publicRepo) })
      }

      if (method === 'POST' && sub === '/repos/sync') {
        const body = await readJsonBody(req)
        const target = String(body?.name ?? '').trim()
        const config = await readConfig()
        const registry = await readRepos()
        const found = registry.repos.find((row) => row.name === target)
        if (found === undefined) return sendJson(res, 404, { ok: false, error: '这个仓库还没接入' })
        const started = await beginSync(found, config)
        if (started.ok !== true) return sendJson(res, 409, { ok: false, error: started.error })
        return sendJson(res, 200, { ok: true, jobId: started.job.id, job: publicJob(started.job) })
      }

      if (method === 'GET' && sub === '/jobs') {
        const id = url.searchParams.get('id')
        if (id !== null && id !== '') {
          const job = getJob(id)
          if (job === null) return sendJson(res, 404, { ok: false, error: '没有这个任务（可能已被清理）' })
          return sendJson(res, 200, { ok: true, job: publicJob(job) })
        }
        const repo = url.searchParams.get('repo') ?? ''
        return sendJson(res, 200, { ok: true, jobs: listJobs(repo).map(publicJob) })
      }

      if (method === 'GET' && sub === '/source-repos') {
        const name = url.searchParams.get('name') ?? ''
        const config = await readConfig()
        const host = config.hosts.find((row) => row.name === name)
        if (host === undefined) return sendJson(res, 404, { ok: false, error: '这个代码源还没登记' })
        const result = await listSourceRepos(host)
        return sendJson(res, 200, { ...result, host: name, registered: (await readRepos()).repos.map((row) => row.url).map(publicUrl) })
      }

      if (method === 'POST' && sub === '/ask') {
        const body = await readJsonBody(req)
        const question = String(body?.question ?? '').trim()
        if (question === '') return sendJson(res, 400, { ok: false, error: '问题不能为空' })
        const config = await readConfig()
        const registry = await readRepos()
        const onlyRepo = typeof body?.repo === 'string' ? body.repo.trim() : ''
        const answer = await askQuestion({ question, repos: registry.repos, onlyRepo })
        if (answer.ok !== true) return sendJson(res, 400, { ok: false, error: answer.error ?? '检索失败' })
        const rendered = renderAnswer(answer, { config, generatedAt: new Date().toISOString().slice(0, 10) })
        const id = newAnswerId()
        await mkdir(answersDir(), { recursive: true, mode: 0o700 })
        await writeFile(join(answersDir(), `${id}.html`), rendered.html, { mode: 0o600 })
        pruneAnswers().catch(() => {})
        return sendJson(res, 200, {
          ok: true,
          id,
          url: `${ROUTE_PREFIX}/answers/${id}.html`,
          question,
          found: answer.found,
          state: answer.state,
          body: rendered.body,
          limits: rendered.limits,
          terms: answer.terms ?? [],
          stats: answer.stats ?? null,
          matches: (answer.matches ?? []).map((row) => ({
            repo: row.repo,
            path: row.path,
            page: row.page,
            symbols: (row.symbols ?? []).slice(0, 8),
            importedBy: row.importedBy,
            lastChange: row.lastChange,
            score: row.score,
          })),
          html: rendered.html,
        })
      }

      if (method === 'GET' && sub.startsWith('/answers/')) {
        const id = sub.slice('/answers/'.length).replace(/\.html$/, '')
        if (!/^[a-z0-9-]{6,40}$/.test(id)) return sendJson(res, 400, { ok: false, error: '答案编号不合法' })
        let html
        try {
          html = await readFile(join(answersDir(), `${id}.html`), 'utf8')
        } catch {
          return sendJson(res, 404, { ok: false, error: '这份材料已经不在了（会自动清理旧材料），重新问一次即可' })
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(html),
        })
        return res.end(html)
      }

      return sendJson(res, 404, { ok: false, error: '没有这个接口' })
    } catch (error) {
      ctx.logger?.warn?.(`repo-truth: ${error?.message ?? error}`)
      return sendJson(res, 500, { ok: false, error: `服务端出错：${error?.message ?? '未知错误'}` })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'repo-truth: routes')
  // 卸载时把还在跑的子进程收掉：宿主重启后留下孤儿 git，会继续占着网络和磁盘。
  ctx.effect(() => () => killAllJobs(), 'repo-truth: jobs')
}
