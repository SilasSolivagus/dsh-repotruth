// 宿主半边（跑在 dsh 的 Node 进程里）：配置持久化 + 连接测试 + 覆盖率只读接口。
//
// 为什么宿主做这些而不是浏览器直接做：
// 1. 令牌是凭据，只允许落在这台机器的 600 文件里，不进浏览器 localStorage；
// 2. 直连 GitLab/GitHub 会被跨域拦住，由宿主代发请求才稳定；
// 3. 覆盖率文件在磁盘上，浏览器读不到 file://，必须由宿主读出来。
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// 数据目录的唯一出处与 demo 命令共用（lib/paths.js）：两处各写一遍路径，
// 迟早在某个平台分支上不一致，而那种 bug 只在别人的机器上出现。
import { configPath, coveragePath, dataDir } from './paths.js'
import { isAttributionEnabled, version } from './branding.js'

/** 插件对外名字。客户端 bundle 里的 id 必须和它一致，否则模块图对不上。 */
export const name = 'dsh-plugin-repo-truth'

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
 * 测试连接：只做一次只读请求，回答两件事——通不通、看得见几个仓库。
 * 只读是硬约束：这里绝不创建/修改远端任何东西。
 */
async function probeHost(row) {
  const baseUrl = normalizeBaseUrl(row.baseUrl)
  const token = typeof row.token === 'string' ? row.token : ''
  const kind = row.kind
  const headers = { accept: 'application/json', 'user-agent': 'dsh-plugin-repo-truth' }

  let url
  if (kind === 'gitlab') {
    url = `${baseUrl}/api/v4/projects?per_page=1&simple=true&membership=true`
    if (token !== '') headers['private-token'] = token
  } else if (kind === 'github') {
    url = `${baseUrl}/user/repos?per_page=1&sort=updated&affiliation=owner,collaborator,organization_member`
    if (token !== '') headers.authorization = `Bearer ${token}`
    headers['x-github-api-version'] = '2022-11-28'
  } else {
    url = baseUrl
    if (token !== '') headers.authorization = `Bearer ${token}`
  }

  let response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) })
  } catch (error) {
    return { ok: false, error: explainError(error) }
  }

  if (!response.ok) {
    const byStatus = {
      401: '令牌无效或已过期',
      403: '令牌权限不足（GitLab 需要 read_api，GitHub 需要 repo 读权限）',
      404: '地址或路径不对：找不到接口，检查基础地址是否包含多余子路径',
      429: '请求太频繁，被限流了，稍后再试',
    }
    const reason = byStatus[response.status] ?? `对方返回状态码 ${response.status}`
    // 令牌绝不进错误文案：万一底层把请求头回显出来，这里再兜一层。
    return { ok: false, error: reason.replace(token === '' ? '' : token, maskToken(token)) }
  }

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
  return {
    present: true,
    path: coveragePath(),
    generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : null,
    repos: repos.map((row) => ({
      repo: String(row?.repo ?? row?.name ?? '（未命名）'),
      filesIndexed: Number.isFinite(row?.filesIndexed) ? row.filesIndexed : 0,
      filesSkippedGenerated: Number.isFinite(row?.filesSkippedGenerated) ? row.filesSkippedGenerated : 0,
      ok: row?.ok !== false,
      error: typeof row?.error === 'string' ? row.error : null,
      headDate: typeof row?.headDate === 'string' ? row.headDate : null,
    })),
    warning: null,
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

      return sendJson(res, 404, { ok: false, error: '没有这个接口' })
    } catch (error) {
      ctx.logger?.warn?.(`repo-truth: ${error?.message ?? error}`)
      return sendJson(res, 500, { ok: false, error: `服务端出错：${error?.message ?? '未知错误'}` })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'repo-truth: routes')
}
