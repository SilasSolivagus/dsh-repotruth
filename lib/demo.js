// demo 命令的实现：浅克隆 → 扫描 → 渲染 → 打印路径 → 删临时目录。
//
// 为什么要有这条路：营销不能靠截图。产品同学拿到的是一个命令，
// 在任意公开仓上重新跑一遍，得到同一口径的一张页——这才叫可复现。
// 所以这里的每一步都只依赖 git 和本包，不依赖宿主、不需要启动 GUI。
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { brandingParts } from './branding.js'
import { configPath, dataDir } from './paths.js'
import { renderHtml } from './render.js'
import { scanRepo } from './scan.js'

const execFileAsync = promisify(execFile)

/** 认 git 地址：https/http、ssh、git@、file://、以及本地绝对路径（测试用）。 */
export function looksLikeGitUrl(value) {
  const text = String(value ?? '').trim()
  if (text === '') return false
  // file:// 也要认：测试与内网镜像都走这条路径，它同样是 git 能克隆的地址。
  if (/^(https?|ssh|git|file):\/\//i.test(text)) return true
  if (/^git@[^\s:]+:[^\s]+$/.test(text)) return true
  if (isAbsolute(text)) return true
  return false
}

/** 从地址推一个名字与文件名。名字只做展示，不做权限判断，所以宽容处理。 */
export function repoSlug(url) {
  const text = String(url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  const last = text.split(/[/:]/).filter((part) => part !== '').pop() ?? 'repo'
  return last.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'repo'
}

/**
 * 读本机配置里的 attribution 开关。
 * demo 也要遵守企业设置：宿主里关了署名，命令行不该偷偷带上。
 * 读不到配置（没装过插件）就是默认开。
 */
export async function readAttributionConfig() {
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8'))
    return { attribution: parsed?.attribution !== false }
  } catch {
    return { attribution: true }
  }
}

function now() {
  return process.hrtime.bigint()
}

function seconds(from, to) {
  return Number(to - from) / 1e9
}

/**
 * 跑一次 demo。
 * options: { url, out, attribution, log, quiet, keepTemp, generatedAt }
 * 返回 { outPath, seconds, facts }，方便测试与脚本二次使用。
 */
export async function runDemo(options) {
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`))
  const url = String(options.url ?? '').trim()
  if (!looksLikeGitUrl(url)) {
    throw new Error(`这不是一个能克隆的地址：${url || '（空）'}`)
  }

  const slug = repoSlug(url)
  const started = now()
  // 克隆到系统临时目录：不污染当前目录，也不会撞上用户自己的目录。用完必删（见 finally）。
  const tempRoot = await mkdtemp(join(tmpdir(), 'repo-truth-demo-'))
  const cloneDir = join(tempRoot, slug)

  log(`→ 正在浅克隆 ${url}（--depth 1）`)

  try {
    try {
      await execFileAsync('git', ['clone', '--depth', '1', '--no-tags', '--quiet', url, cloneDir], {
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      })
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? '').trim().split('\n').slice(-3).join(' ')
      throw new Error(`克隆失败：${detail || 'git 没有给出原因'}`)
    }
    const clonedAt = now()

    const facts = await scanRepo(cloneDir, { repoName: slug, repoUrl: url })
    const scannedAt = now()

    const config = options.attribution === undefined ? await readAttributionConfig() : { attribution: options.attribution !== false }
    const html = renderHtml(facts, {
      config,
      repoUrl: options.repoUrl,
      generatedAt: options.generatedAt,
    })
    const renderedAt = now()

    const outPath = await writeOutput(html, options.out, slug)
    const finishedAt = now()

    if (!options.quiet) {
      const pageText =
        facts.pages.items.length === 0
          ? '没辨认出页面清单（没有命中已知目录约定）'
          : `${facts.pages.items.length} 个（口径：${facts.pages.label}）`
      log(`✓ 克隆完成（${seconds(started, clonedAt).toFixed(1)}s）`)
      log(
        `✓ 扫描完成（${seconds(clonedAt, scannedAt).toFixed(1)}s）：代码文件 ${facts.files.code} 个 / ` +
          `认识的语言 ${facts.languages.length} 种 / 页面 ${pageText} / 界面模块 ${facts.components.items.length} 个`,
      )
      log(`✓ 渲染完成（${seconds(scannedAt, renderedAt).toFixed(1)}s，署名${config.attribution ? '开启' : '关闭，meta 保留'}）`)
      log(`✓ 已写入：${outPath}`)
      log(`  总耗时 ${seconds(started, finishedAt).toFixed(1)}s；临时目录已删除。`)
      log(`  提示：页脚默认带「由 repotruth 生成 · <项目地址>」，企业场景可用 --no-attribution 关掉（meta 标签保留）。`)
    }

    return {
      outPath,
      slug,
      seconds: seconds(started, finishedAt),
      attribution: config.attribution,
      facts,
      // 临时目录的真实路径：测试用它断言「读完真的删干净了」，
      // 而不是靠数 $TMPDIR 里的目录个数（并行跑测试时那个数字会被别人干扰）。
      tempRoot,
      keptTemp: options.keepTemp === true,
    }
  } finally {
    // 只删自己 mkdtemp 出来的目录。这里不碰任何用户的仓库——
    // 尤其不能用 git clean / git checkout 之类会在用户工作区里删东西的命令。
    if (options.keepTemp) {
      if (!options.quiet) log(`· 临时目录已保留：${tempRoot}`)
    } else {
      await rm(tempRoot, { recursive: true, force: true })
      if (!options.quiet) log(`· 已清理临时目录 ${tempRoot}`)
    }
  }
}

/** 决定写哪：--out 是目录就放进去，以 .html 结尾就当文件路径。 */
async function writeOutput(html, out, slug) {
  const target = out === undefined || out === null || String(out).trim() === '' ? resolve(`${slug}-status.html`) : resolve(String(out))
  const isFileTarget = /\.html?$/i.test(target)
  const filePath = isFileTarget ? target : join(target, `${slug}-status.html`)
  await mkdir(isFileTarget ? resolve(fileTargetDir(target)) : target, { recursive: true })
  await writeFile(filePath, html, 'utf8')
  return filePath
}

function fileTargetDir(filePath) {
  const index = filePath.lastIndexOf('/')
  return index <= 0 ? '.' : filePath.slice(0, index)
}

/** 供 README / 使用说明复用的一句边界说明。 */
export const DEMO_HINT = `demo 只读取代码结构：不执行仓库里的脚本，不安装依赖，不联网（除了 git 克隆本身）。数据目录：${dataDir()}`
