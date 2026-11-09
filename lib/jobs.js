// 同步任务：起子进程干活、按行收进度、到点就杀。
//
// 三条硬约束（都来自一次真实的翻车：一个 clone 挂住把夜间任务拖死了）：
// 1. 宿主进程绝不能等克隆：startJob 立刻返回 jobId，其余靠轮询。
// 2. 每个仓一整套硬超时，到点必杀——先 SIGTERM 整个进程组，5 秒不退再 SIGKILL。
//    （杀进程组而不是杀子进程：git 是子进程的子进程，漏杀会让 git 继续占着网络。）
// 3. 失败要给中文原因。英文栈对看界面的人没有意义。
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir } from './paths.js'
import { scrubUrl } from './git.js'

const here = dirname(fileURLToPath(import.meta.url))
const workerPath = join(here, 'worker.js')

/** 活跃任务按仓唯一：同一个仓不允许两个 job 同时改索引。 */
const active = new Map()
/** jobId → 子进程：卸载时要能把还在跑的 git 一起收掉，否则宿主重启后成孤儿。 */
const children = new Map()
/** 历史任务（只留最近这些，避免宿主进程内存随运行次数增长）。 */
const history = []
const HISTORY_CAP = 40
const LOG_CAP = 40

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function pushLog(job, phase, text) {
  if (job.log.length >= LOG_CAP) job.log.shift()
  job.log.push({ at: new Date().toISOString(), phase, text })
  job.phase = phase
  job.message = text
}

/** 整体超时：克隆上限 + 索引上限 + 余量。到点不管在干什么，一律判失败。 */
export function totalTimeoutMs(cloneTimeoutMs = 180_000, indexTimeoutMs = 120_000) {
  return cloneTimeoutMs + indexTimeoutMs + 60_000
}

/** 杀整个进程组。子进程用 detached 起的，所以 -pid 能把 git 一起带走。 */
function killTree(child) {
  if (child === null || child.killed === true) return
  const pid = child.pid
  if (typeof pid !== 'number') return
  try {
    if (process.platform === 'win32') child.kill('SIGTERM')
    else process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已经退了
    }
  }
  const timer = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-pid, 'SIGKILL')
    } catch {
      // 已经退了
    }
  }, 5000)
  timer.unref?.()
}

export function getJob(id) {
  if (active.has(id)) return active.get(id)
  return history.find((job) => job.id === id) ?? null
}

/** 面板轮询用的列表：先活跃，后历史，同一仓只保留最新的几条。 */
export function listJobs(repo) {
  const rows = [...active.values(), ...history]
  const filtered = repo === undefined || repo === null || repo === '' ? rows : rows.filter((job) => job.repo === repo)
  return filtered
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 12)
}

/**
 * 起一个同步任务。
 * 返回 { ok: true, job } 或 { ok: false, error }（同一个仓已在同步中）。
 */
export function startJob(options) {
  const onFinish = typeof options.onFinish === 'function' ? options.onFinish : null
  const repo = String(options.repo ?? '').trim()
  const url = String(options.url ?? '').trim()
  if (repo === '' || url === '') return { ok: false, error: '内部错误：缺少仓名或地址' }

  for (const job of active.values()) {
    if (job.repo === repo) return { ok: false, error: `「${repo}」正在同步中，等这一轮跑完再点` }
  }

  const cloneTimeoutMs = options.cloneTimeoutMs ?? 180_000
  const indexTimeoutMs = options.indexTimeoutMs ?? 120_000
  const job = {
    id: newId(),
    repo,
    url,
    status: 'running',
    phase: 'queued',
    message: '排进队列',
    startedAt: Date.now(),
    endedAt: null,
    elapsedMs: null,
    error: null,
    log: [],
    result: null,
  }
  active.set(job.id, job)
  pushLog(job, 'queued', '任务已排队')

  let child
  try {
    child = spawn(process.execPath, [workerPath, '--repo', repo, '--url', url, '--clone-timeout', String(cloneTimeoutMs)], {
      // detached：让子进程自成进程组，超时时能连 git 一起杀干净。
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, REPO_TRUTH_HOME: dataDir() },
    })
  } catch (error) {
    return finish(job, { status: 'failed', error: `启动索引进程失败：${error?.message ?? error}` }, onFinish)
  }

  children.set(job.id, child)

  // 令牌只走 stdin 一次性递进去：不进 argv（ps 可见），不进环境变量（ppid 可读），不进日志。
  child.stdin.write(`${JSON.stringify({ token: options.token ?? '', kind: options.kind ?? '' })}\n`)
  child.stdin.end()

  let buffer = ''
  let stderr = ''
  let result = null
  let failure = null

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.phase === 'done') result = event.result
      else if (event.phase === 'failed') failure = event.error ?? '未知失败'
      else if (typeof event.text === 'string') pushLog(job, event.phase ?? 'working', event.text)
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    // 只留末尾：前面通常是噪音，真正的原因在最后。
    stderr = `${stderr}${chunk}`.slice(-4000)
  })

  // 超时值可以被显式覆盖（测试要能在 1 秒内验证「到点必杀」，不能靠等 6 分钟）。
  const hardMs = Number.isFinite(options.hardTimeoutMs) ? options.hardTimeoutMs : totalTimeoutMs(cloneTimeoutMs, indexTimeoutMs)
  job.hardTimeoutMs = hardMs
  const hardTimer = setTimeout(() => {
    killTree(child)
    pushLog(job, 'timeout', '超时，已终止子进程')
    job.timedOut = true
  }, hardMs)
  hardTimer.unref?.()

  child.on('error', (error) => {
    clearTimeout(hardTimer)
    if (job.status === 'running') finish(job, { status: 'failed', error: `索引进程启动失败：${error?.message ?? error}` }, onFinish)
  })

  child.on('close', (code) => {
    clearTimeout(hardTimer)
    children.delete(job.id)
    if (job.status !== 'running') return
    if (result !== null) {
      finish(job, { status: 'done', result }, onFinish)
      return
    }
    if (failure !== null) {
      finish(job, { status: 'failed', error: scrubUrl(failure) }, onFinish)
      return
    }
    if (job.timedOut === true) {
      finish(job, { status: 'failed', error: `超时：这个仓在 ${Math.round(job.hardTimeoutMs / 1000)} 秒内没有跑完，已终止` }, onFinish)
      return
    }
    const detail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)
    finish(
      job,
      {
        status: 'failed',
        error: `索引进程异常退出（退出码 ${code}）${detail === '' ? '' : `：${scrubUrl(detail)}`}`,
      },
      onFinish,
    )
  })

  return { ok: true, job }
}

function finish(job, outcome, onFinish = null) {
  job.status = outcome.status
  job.endedAt = Date.now()
  job.elapsedMs = job.endedAt - job.startedAt
  if (outcome.status === 'done') {
    job.result = outcome.result
    job.error = null
    job.phase = 'done'
    job.message = `完成：解析 ${outcome.result?.parsedBlobs ?? 0} 个新内容块，复用 ${outcome.result?.reusedBlobs ?? 0} 个`
    pushLog(job, 'done', job.message)
  } else {
    job.error = outcome.error
    job.phase = 'failed'
    job.message = outcome.error
    pushLog(job, 'failed', outcome.error)
  }
  active.delete(job.id)
  history.unshift(job)
  if (history.length > HISTORY_CAP) history.length = HISTORY_CAP
  // 落表由宿主做（登记表与覆盖率只有一个写者）。这里只保证「一定会被通知」。
  if (onFinish !== null) {
    try {
      onFinish(job)
    } catch {
      // 落表失败不能让任务本身变成失败：索引已经写好了。
    }
  }
  return { ok: outcome.status === 'done', job, error: outcome.error ?? null }
}

/** 宿主卸载时调用：不留孤儿进程。 */
export function killAllJobs() {
  for (const [id, child] of children) {
    killTree(child)
    children.delete(id)
  }
  for (const job of [...active.values()]) {
    job.status = 'failed'
    job.error = '宿主关闭，任务中断'
    job.endedAt = Date.now()
    job.elapsedMs = job.endedAt - job.startedAt
    active.delete(job.id)
    history.unshift(job)
  }
}
