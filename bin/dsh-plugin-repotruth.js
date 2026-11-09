#!/usr/bin/env node
// 命令行入口。
//
// 为什么要有 bin：材料要在公司群里流通，得有人能在没装 GUI 的机器上一条命令跑出来。
// npx dsh-plugin-repotruth demo <公开仓地址> 就是这个入口。
// 这里不做参数框架、不引依赖：两个开关的事，手写解析最省事也最不容易被包管理器版本绊倒。
import { runDemo } from '../lib/demo.js'
import { runMaterial } from '../lib/material.js'
import { PRODUCT, version } from '../lib/branding.js'

const USAGE = `${PRODUCT} material <仓名> --question "一句中文需求" [--out <目录或 .html>]

  读本机已建好的索引，把一句需求落成「需求走查」三栏页：左流程、中页面结构或时序骨架、右标注。
  查不到就不画流程——这一轮会写一份只讲「没找到」的说明页，不生成空的三栏页。

选项
  --question <文字>    要问的那句中文需求（必填）
  --out <dir|file>     输出位置。给目录就写 <仓名>-walkthrough.html；默认写当前目录
  --no-attribution     关闭页脚署名（<head> 的生成器 meta 始终保留）
  --quiet              只打印输出路径
  -h, --help           显示这段说明

例子
  npx ${PRODUCT} material vue-admin-template --question "用户登录页面是怎么做的？" --out ./examples

${PRODUCT} demo <公开 git 地址> [--out <目录或 .html>] [--no-attribution]

  浅克隆一个公开仓库（--depth 1），量出它能读懂的规模、页面与复用情况，
  生成一张静态页；页脚带「由 ${PRODUCT} 生成 · <项目地址>」。
  默认署名可以用 --no-attribution 关掉；<head> 里的生成器 meta 标签始终保留。

选项
  --out <dir|file>     输出位置。给目录就写 <目录>/<仓名>-status.html；默认写当前目录
  --no-attribution     关闭页脚署名（企业内部分发需要时用）
  --keep-temp          保留浅克隆的临时目录（排查扫描问题用；用完自己删）
  --attribution        强制打开页脚署名（覆盖本机配置）
  --quiet              只打印输出路径
  -h, --help           显示这段说明
  -v, --version        显示版本

例子
  npx ${PRODUCT} demo https://github.com/PanJiaChen/vue-admin-template.git
  npx ${PRODUCT} demo https://github.com/vercel/nextjs-subscription-payments.git --out ./examples
`

/** 手写解析：只认这几个开关，未知参数直接报错，不猜用户意思。 */
export function parseArgs(argv) {
  const options = { command: null, url: null, question: null, out: null, attribution: undefined, keepTemp: false, quiet: false, help: false, version: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') {
      i += 1
      if (argv[i] === undefined) throw new Error('--out 后面要跟目录或 .html 路径')
      options.out = argv[i]
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else if (arg === '--question') {
      i += 1
      if (argv[i] === undefined) throw new Error('--question 后面要跟一句需求')
      options.question = argv[i]
    } else if (arg.startsWith('--question=')) {
      options.question = arg.slice('--question='.length)
    } else if (arg === '--no-attribution') {
      options.attribution = false
    } else if (arg === '--attribution') {
      options.attribution = true
    } else if (arg === '--keep-temp') {
      options.keepTemp = true
    } else if (arg === '--quiet') {
      options.quiet = true
    } else if (arg === '-h' || arg === '--help') {
      options.help = true
    } else if (arg === '-v' || arg === '--version') {
      options.version = true
    } else if (arg.startsWith('-')) {
      throw new Error(`不认识的选项：${arg}`)
    } else {
      rest.push(arg)
    }
  }
  options.command = rest[0] ?? null
  options.url = rest[1] ?? null
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }

  if (options.version) {
    process.stdout.write(`${PRODUCT} v${version() ?? '(version unknown)'}\n`)
    return
  }
  if (options.help || options.command === null) {
    process.stdout.write(USAGE)
    return
  }
  if (options.command === 'material') {
    if (options.url === null) {
      process.stderr.write(`material 需要一个仓名。\n\n${USAGE}`)
      process.exitCode = 1
      return
    }
    try {
      const result = await runMaterial({
        repo: options.url,
        question: options.question ?? '',
        out: options.out ?? undefined,
        attribution: options.attribution,
        quiet: options.quiet,
      })
      // --quiet 的约定和其它命令一致：最后一行只留路径，方便 $(...) 抓。
      if (options.quiet) process.stdout.write(`${result.outPath}\n`)
      if (!result.found) process.exitCode = 2
    } catch (error) {
      process.stderr.write(`material 失败：${error?.message ?? error}\n`)
      process.exitCode = 1
    }
    return
  }

  if (options.command !== 'demo') {
    process.stderr.write(`不认识的命令：${options.command}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  if (options.url === null) {
    process.stderr.write(`demo 需要一个公开 git 地址。\n\n${USAGE}`)
    process.exitCode = 1
    return
  }

  try {
    const result = await runDemo({
      url: options.url,
      out: options.out ?? undefined,
      attribution: options.attribution,
      keepTemp: options.keepTemp,
      quiet: options.quiet,
    })
    // 最后一行单独再打一次路径：脚本里用 $(...) 抓的就是这一行。
    if (options.quiet) process.stdout.write(`${result.outPath}\n`)
  } catch (error) {
    process.stderr.write(`demo 失败：${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}

await main(process.argv.slice(2))
