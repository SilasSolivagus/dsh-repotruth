// 索引子进程的入口：克隆/拉取镜像 → 建索引 → 把摘要打给宿主。
//
// 为什么必须是独立进程（这是本项目最硬的一条约束）：
// 克隆和解析都是「会卡住」的活。卡在 DNS、卡在凭据提示、卡在一个几十万文件的树里，
// 宿主进程就跟着一起卡——界面上所有请求都不再应答，连「停止」按钮都点不动。
// 放进子进程后，宿主只管超时与汇报；子进程被 kill 掉，宿主毫发无损。
//
// 为什么用「一行一个 JSON」而不是 websocket：
// 宿主进度条只要「现在在干什么、错了为什么」。stdout 按行传、宿主按行读，
// 一次请求一次响应就能实现，不需要维护长连接和重连逻辑。
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { mirrorFetch, mirrorClone, authEnv, headOf, scrubUrl } from './git.js'
import { buildIndex } from './indexer.js'
import { indexDir, indexPath, mirrorPath, mirrorsDir, safeName } from './paths.js'

/** 一行一个 JSON：宿主按 \n 切，不需要知道结构与顺序。 */
function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    out[key] = argv[i + 1]
    i += 1
  }
  return out
}

/** 读宿主通过 stdin 递进来的那一行（令牌走这里，不进 argv、不进环境变量、不进日志）。 */
function readHandshake() {
  return new Promise((resolve) => {
    let buffer = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(buffer || '{}'))
      } catch {
        resolve({})
      }
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('\n')) {
        buffer = buffer.slice(0, buffer.indexOf('\n'))
        finish()
      }
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    // 宿主如果没有立刻写（老版本），2 秒后按空凭据继续：公开仓不需要令牌。
    setTimeout(finish, 2000).unref?.()
  })
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo = String(args.repo ?? '').trim()
  const url = String(args.url ?? '').trim()
  if (repo === '' || url === '') {
    emit({ phase: 'failed', error: '内部错误：缺少仓名或地址' })
    process.exitCode = 2
    return
  }

  const handshake = await readHandshake()
  const gitEnv = authEnv(handshake.kind, handshake.token)
  const cloneTimeoutMs = Number(args['clone-timeout'] ?? 180_000)

  const dir = mirrorPath(repo)
  await ensureDir(mirrorsDir())
  await ensureDir(indexDir())

  const hasMirror = existsSync(dir)
  let mode = 'clone'
  if (hasMirror) {
    const probe = await headOf(dir)
    if (probe.ok) {
      mode = 'fetch'
      emit({ phase: 'clone', text: `已在本地，增量拉取 ${safeName(repo)}` })
      const fetched = await mirrorFetch(dir, { env: gitEnv, timeoutMs: Math.min(cloneTimeoutMs, 120_000) })
      if (!fetched.ok) {
        emit({ phase: 'failed', error: `拉取失败：${scrubUrl(fetched.error)}` })
        process.exitCode = 2
        return
      }
    } else {
      // 目录在，但不是能用的 git 仓库（上次灌坏了）。只清我们自己的 mirrors/<name>.git。
      emit({ phase: 'clone', text: '本地镜像不可用，重新克隆' })
      await rm(dir, { recursive: true, force: true })
    }
  }

  if (mode === 'clone') {
    emit({ phase: 'clone', text: `正在克隆 ${safeName(repo)}（bare 镜像）` })
    const cloned = await mirrorClone(url, dir, { env: gitEnv, timeoutMs: cloneTimeoutMs })
    if (!cloned.ok) {
      emit({ phase: 'failed', error: `克隆失败：${scrubUrl(cloned.error)}` })
      process.exitCode = 2
      return
    }
  }

  emit({ phase: 'index', text: '正在建索引' })
  const result = await buildIndex({
    repo,
    url,
    mirrorDir: dir,
    indexPath: indexPath(repo),
    onProgress: (text) => emit({ phase: 'index', text }),
    changesWindow: Number(args['changes-window'] ?? 200),
  })

  if (!result.ok) {
    emit({ phase: 'failed', error: scrubUrl(result.error) })
    process.exitCode = 2
    return
  }

  emit({
    phase: 'done',
    result: {
      repo,
      url,
      mode,
      head: result.head,
      headDate: result.headDate,
      indexedAt: result.indexedAt,
      counts: result.counts,
      pages: result.pages,
      pagesLabel: result.pagesLabel,
      pageItems: result.pageItems,
      parsedBlobs: result.parsedBlobs,
      reusedBlobs: result.reusedBlobs,
      durationMs: result.durationMs,
      warning: result.warning,
    },
  })
}

main().catch((error) => {
  emit({ phase: 'failed', error: `索引进程异常：${scrubUrl(error?.message ?? String(error))}` })
  process.exitCode = 2
})
