// 数据目录的唯一出处。
//
// 为什么单独抽一个文件：demo 命令行、宿主接口、测试三处都要知道「配置在哪」。
// 三处各写一遍路径拼接，迟早有一处漏改平台分支——这类 bug 只在别人机器上出现。
import { homedir } from 'node:os'
import { join } from 'node:path'

/** macOS 用 Application Support，其它平台退到 ~/.repo-truth；REPO_TRUTH_HOME 覆盖（测试用）。 */
export function dataDir() {
  const override = process.env.REPO_TRUTH_HOME
  if (override && override.trim() !== '') return override
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'repo-truth')
  return join(homedir(), '.repo-truth')
}

export const configPath = () => join(dataDir(), 'config.json')
export const coveragePath = () => join(dataDir(), 'coverage.json')
