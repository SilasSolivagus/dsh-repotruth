// 数据目录的唯一出处。
//
// 为什么单独抽一个文件：demo 命令行、宿主接口、索引子进程、测试四处都要知道
// 「配置在哪、镜像在哪、索引在哪」。四处各写一遍路径拼接，迟早有一处漏改平台分支——
// 这类 bug 只在别人机器上出现。
import { homedir } from 'node:os'
import { join } from 'node:path'

/** macOS 用 Application Support，其它平台退到 ~/.repo-truth；REPO_TRUTH_HOME 覆盖（测试用）。 */
export function dataDir() {
  const override = process.env.REPO_TRUTH_HOME
  if (override && override.trim() !== '') return override
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'repo-truth')
  return join(homedir(), '.repo-truth')
}

/**
 * 仓名 → 文件名。
 * 仓名来自用户输入或远端地址，里面可能有 `/`、空格、中文。文件名要是被仓名带着跑，
 * 一次拼接就能把索引写到目录外面去（`../../x`），所以这里白名单化。
 * 中文会被替换成 `-`：可读性让位给「不可能越界」。
 */
export function safeName(name) {
  const text = String(name ?? '').trim()
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned === '' ? 'repo' : cleaned.slice(0, 80)
}

export const configPath = () => join(dataDir(), 'config.json')
export const coveragePath = () => join(dataDir(), 'coverage.json')
/** 已接入仓库登记表（不是索引：这里只有「接了谁、上次跑成什么样」）。 */
export const reposPath = () => join(dataDir(), 'repos.json')
/** bare mirror 放这里：`<name>.git`，后续只 fetch 不重克隆。 */
export const mirrorsDir = () => join(dataDir(), 'mirrors')
/** 每个仓一个 JSON 索引。 */
export const indexDir = () => join(dataDir(), 'index')
/** 「问一句」生成的静态材料，按 id 存，供面板里的链接直接打开。 */
export const answersDir = () => join(dataDir(), 'answers')
/** 「需求走查」的三栏材料，同样按 id 存：面板里内嵌或新窗口打开同一份文件。 */
export const materialsDir = () => join(dataDir(), 'materials')

export const mirrorPath = (name) => join(mirrorsDir(), `${safeName(name)}.git`)
export const indexPath = (name) => join(indexDir(), `${safeName(name)}.json`)
