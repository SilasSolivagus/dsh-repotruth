// 用系统默认浏览器打开一份材料。
//
// 为什么单独一个文件：这条路径要在三种平台上给出三条命令，而「打开浏览器」
// 一旦拼错，症状是「什么都没发生」——没有报错、没有日志，最容易被当成生成失败。
// 所以把「哪条命令、哪些参数」抽成纯函数，测试里对三平台各断言一次，
// 真正 spawn 的那一层再注入一个假的 spawn，验证参数原样传下去。
import { spawn as nodeSpawn } from 'node:child_process'

/**
 * 平台 → 打开命令。url 永远只作为最后一个参数传，不拼进 shell 字符串：
 * 拼字符串就等于把 url 当命令执行（`;`、`&`、空格都会改变语义）。
 *
 * @param {string} platform process.platform 的值
 * @param {string} url 已经校验过的本机 http(s) 地址
 * @returns {{ command: string, args: string[] }}
 */
export function browserOpenPlan(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') {
    // `start` 是 cmd 内建命令，必须过 cmd /c；第一个参数是窗口标题，
    // 留空串可以避免 url 被当成标题（否则会弹一个空窗口什么也不打开）。
    return { command: 'cmd', args: ['/c', 'start', '', url] }
  }
  return { command: 'xdg-open', args: [url] }
}

/**
 * 只接受本机 http(s) 地址。
 * 材料永远由本插件的路由提供（127.0.0.1 / ::1 / localhost），
 * 别的东西不该被交给 `open`：那等于让外部输入决定系统命令去打开什么。
 */
export function isLocalMaterialUrl(url) {
  if (typeof url !== 'string' || url === '') return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  // 字符串必须能原样往返：带空格、引号、分号的串会被 URL 规范化成另一种写法，
  // 那种串不该被交给系统命令去解释。
  if (parsed.href !== url) return false
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * 打开默认浏览器。失败不抛：材料已经生成好了，打不开只该少一步动作。
 *
 * @param {{ url: string, platform?: string, spawn?: Function }} options
 * @returns {Promise<{ ok: boolean, command: string|null, args: string[], error: string|null }>}
 */
export async function openInBrowser(options) {
  const url = options?.url
  const platform = options?.platform ?? process.platform
  const spawn = options?.spawn ?? nodeSpawn
  if (!isLocalMaterialUrl(url)) {
    return { ok: false, command: null, args: [], error: `拒绝打开非本机地址：${String(url)}` }
  }
  const plan = browserOpenPlan(platform, url)
  try {
    const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore' })
    // unref：别让浏览器的生命周期挂住宿主进程（否则退出宿主时会等它）。
    if (child && typeof child.unref === 'function') child.unref()
    return { ok: true, command: plan.command, args: plan.args, error: null }
  } catch (error) {
    return { ok: false, command: plan.command, args: plan.args, error: error?.message ?? String(error) }
  }
}
