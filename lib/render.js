// 把扫描结果渲染成一张静态 HTML。
//
// 两条纪律在这里落地：
// 1. 两层语言——正文只写产品语言（读者是 PM），代码坐标全部降到末尾「研发参考」里；
//    正文里出现路径/后缀/裸标识符就算失败，测试会扫（见 productBodyViolations）。
// 2. 自我限界——页面必须自己说清「读懂了什么语言、什么读不懂、什么根本没量」，
//    并且写死「清单里没有 ≠ 不存在」。没有这一段，材料读起来会像全知。
import { brandingParts, PRODUCT } from './branding.js'

/**
 * 正文禁词（对应 copy-rules 的禁词表，正文零豁免）。
 * 命中的表现：正则匹配到路径段、裸文件后缀、裸驼峰标识符、宏式大写，
 * 以及实现名词（字段/接口/埋点/参数/路由/组件/入参/出参）。
 */
export const BODY_BANNED_PATTERNS = [
  { id: 'path', re: /(?:^|[\s（(：、，])(?:src|app|pages|components|views)\// },
  { id: 'suffix', re: /\.(vue|tsx|ts|jsx|js|json|go|py|java|kt|swift|rb|php|rs|scss|css|md)\b/ },
  { id: 'camel', re: /(^|[\s（(])[a-z]+[A-Z][A-Za-z]*\b/ },
  { id: 'macro', re: /(^|[\s（(])[A-Z][A-Z0-9_]{2,}\b/ },
  { id: 'noun', re: /字段|接口|埋点|参数|路由|组件|入参|出参/ },
]

const PRODUCT_BODY_RE = /<!-- product-body:start -->([\s\S]*?)<!-- product-body:end -->/

/** 只取正文区（不含页眉的代码坐标行、不含限界框、不含末尾研发参考），供测试与自检使用。 */
export function productBodyText(html) {
  const match = PRODUCT_BODY_RE.exec(html)
  if (match === null) return ''
  // 去掉标签，只留文字，避免把属性里的东西误判成正文。
  return match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 返回命中的禁词 id 列表；空数组表示正文干净。测试用它，出材料前也可以先跑一次。 */
export function productBodyViolations(html) {
  const text = productBodyText(html)
  return BODY_BANNED_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.id)
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function kb(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 2026-11-09T10:00:00+08:00 → 2026-11-09。读不到日期就一个字都不写（不写「未知」）。 */
function dayOf(iso) {
  if (typeof iso !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return match === null ? null : match[1]
}

function daysBetween(fromDay, toDay) {
  const a = Date.parse(`${fromDay}T00:00:00Z`)
  const b = Date.parse(`${toDay}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 86_400_000)
}

/** 正文段落。每段都只陈述量到的事实；量不到的用「没找到」的口径说出来。 */
function productParagraphs(facts, generatedDay) {
  const paragraphs = []
  const langs = facts.languages
  const topLangs = langs.slice(0, 4)
  const langText = topLangs.length === 0
    ? ''
    : `按语言分，${topLangs.map((row) => `${row.language} ${row.files} 个`).join('、')}${
        langs.length > topLangs.length ? `，其余 ${langs.length - topLangs.length} 种语言合计 ${langs.slice(topLangs.length).reduce((sum, row) => sum + row.files, 0)} 个` : ''
      }。`

  paragraphs.push(
    `这是一份自动生成的「系统现状」：只写能从代码里量出来的东西，不写设计意图，也不写应该做成什么样。` +
      `当前能读懂的代码文件 ${facts.files.code} 个，合计约 ${kb(facts.files.bytes)}。${langText}`,
  )

  if (facts.pages.items.length > 0) {
    paragraphs.push(
      // 正文里不写「src/views/**」这种目录口径：那是研发参考的语言。
      // 口径本身照样要说清，但放在文末的限界框里，正文只说「按目录约定」。
      `按目录约定能辨认出 ${facts.pages.items.length} 个用户能到达的页面或视图。` +
        `这份清单来自目录结构，不是从跳转声明里读出来的，所以它偏向「少算」：真实页面可能比这个数字多。`,
    )
  } else {
    paragraphs.push(
      `这一版没能辨认出页面清单——原因不是「没有页面」，而是这个仓库没有使用本工具认识的目录约定。` +
        `要回答「有哪些页面」，需要研发提供跳转声明或页面入口说明。`,
    )
  }

  const components = facts.components
  if (components.items.length > 0) {
    const used = components.items.filter((row) => row.usages > 0)
    const maxRow = components.items[0]
    // 三种情况分开写：全都被用、部分被用、一个都没被用。
    // 合成一句「其中 N 个被用到」时，N 等于总数会读起来像漏了话。
    const usageText =
      components.items.length === used.length
        ? `，每一个都在别处被引用过`
        : used.length === 0
          ? `，暂时没看到别处引用它们`
          : `，其中 ${used.length} 个在别处被引用过`
    paragraphs.push(
      `可复用的界面模块 ${components.items.length} 个${usageText}；` +
        `被复用最多的一处出现在 ${maxRow.usages} 个文件里（名字见文末研发参考）。` +
        `这个数字能回答「改动会波及几处」，不能回答「被谁依赖」。`,
    )
  } else {
    paragraphs.push(
      `没有找到可复用的界面模块目录（本工具只认少数几种约定）。` +
        `这不等于项目没有复用，只等于这个仓库没有按约定摆放。`,
    )
  }

  const largest = facts.churn.largest[0]
  const snapshotDay = dayOf(facts.snapshot?.date)
  const age = snapshotDay === null || generatedDay === null ? null : daysBetween(snapshotDay, generatedDay)
  const ageText =
    age === null ? '' : age > 180 ? `（距今天 ${age} 天，已经很久没人动过）` : age > 14 ? `（距今天 ${age} 天）` : ''
  const sizeText = largest === undefined ? '' : `规模最大的单个代码文件约 ${kb(largest.bytes)}。`
  const changedText =
    facts.churn.mode === 'history'
      ? `近 ${facts.churn.commits} 个提交里改动最频繁的文件见文末研发参考。`
      : `这份克隆只有一个提交，因此「改动频次」不可得，只能说清最近一次提交动过哪些文件（见文末研发参考）。`
  paragraphs.push(
    `代码快照${snapshotDay === null ? '' : `：${facts.repoName} @ ${snapshotDay}`}${ageText}。${sizeText}${changedText}`,
  )

  paragraphs.push(
    `这份材料适合回答「大概有什么、规模多大、改一处会波及几处」；不适合回答「某个功能具体怎么实现的」——` +
      `那需要看具体代码，或者问研发。`,
  )

  return paragraphs
}

/** 限界框：这一节是全篇最重要的一段，缺了它上面每句话都会被读成「全知」。 */
function limitsItems(facts) {
  const items = []

  const langs = facts.languages
  if (langs.length === 0) {
    items.push(`<li><b>读懂了</b>：没有解析到任何认识的代码语言，这一份不含任何现状判断。</li>`)
  } else {
    items.push(
      `<li><b>读懂了</b>：${langs.map((row) => `${esc(row.language)}（${row.files} 个文件）`).join('、')}。` +
        `这些文件只统计了数量和体积，没有逐行分析实现。</li>`,
    )
  }

  if (facts.unknownExtensions.length > 0) {
    const rows = facts.unknownExtensions
      .slice(0, 6)
      .map((row) => `${esc(row.ext)} × ${row.files}`)
      .join('、')
    items.push(
      `<li><b>读不懂</b>：${rows}${
        facts.unknownExtensions.length > 6 ? `，另有 ${facts.unknownExtensions.length - 6} 种扩展名` : ''
      }。这些文件不计入上面的任何数字，也不参与任何判断——它们既不算「读到了」，也不该被读成「不存在」。</li>`,
    )
  } else {
    items.push(`<li><b>读不懂</b>：没有发现超出认识范围的文件类型。这只说明文件类型都在范围内，不代表内容都被读懂了。</li>`)
  }

  if (facts.files.assets > 0) {
    items.push(`<li><b>没算</b>：图片、字体等素材 ${facts.files.assets} 个，不计入代码文件数。</li>`)
  }

  items.push(
    `<li><b>根本没量</b>：后端处理流程、数据结构、权限与角色、线上实际请求链路、页面之间的跳转关系。` +
      `这些都不在这份材料里，不要用这份材料去推断它们。</li>`,
  )

  items.push(
    `<li><b>页面口径</b>：只按目录约定识别${facts.pages.label === null ? '（本仓库没有命中任何约定）' : `，本次用的是「${esc(facts.pages.label)}」`}，` +
      `没有解析跳转声明文件。所以「清单里没有某个页面」只代表<b>没找到</b>，不代表<b>不存在</b>。</li>`,
  )

  if (facts.pages.others.length > 0) {
    items.push(
      `<li><b>另外命中的约定</b>：${facts.pages.others.map((row) => esc(row.label ?? row.convention)).join('、')}，` +
        `本次没有合并进上面的数字，避免把同一批页面数两遍。</li>`,
    )
  }

  if (facts.skippedDirs.length > 0) {
    items.push(
      `<li><b>已跳过</b>：${facts.skippedDirs.map((dir) => esc(dir)).join('、')}——构建产物、依赖与第三方代码不算产品能力。</li>`,
    )
  }

  if (facts.churn.note !== null) {
    items.push(`<li><b>改动记录</b>：${esc(facts.churn.note)}。</li>`)
  }

  if (facts.components.unread > 0) {
    items.push(
      `<li><b>引用计数只读了 ${facts.components.readFiles} 个文件</b>${
        facts.components.capped ? '（已撞到上限）' : ''
      }，另外 ${facts.components.unread} 个文件没读（非代码或体积过大）。复用次数可能偏低，不会偏高。</li>`,
    )
  }

  return items
}

function devRefSection(facts) {
  const parts = [`<details class="devref"><summary>研发参考（正文里的每个数字都能在这里找到坐标）</summary>`]

  parts.push(`<h3>页面 / 视图（${facts.pages.items.length}）</h3>`)
  if (facts.pages.items.length === 0) {
    parts.push(`<p class="muted">没有命中已知目录约定。</p>`)
  } else {
    parts.push(`<ul class="paths">${facts.pages.items.map((path) => `<li><code>${esc(path)}</code></li>`).join('')}</ul>`)
  }

  parts.push(`<h3>界面模块（${facts.components.items.length}${facts.components.dir === null ? '' : `，目录 <code>${esc(facts.components.dir)}</code>`}）</h3>`)
  if (facts.components.items.length === 0) {
    parts.push(`<p class="muted">没有找到组件目录。</p>`)
  } else {
    parts.push(
      `<table><thead><tr><th>名称</th><th>位置</th><th>被引用</th></tr></thead><tbody>${facts.components.items
        .slice(0, 40)
        .map(
          (row) =>
            `<tr><td><code>${esc(row.name)}</code></td><td><code>${esc(row.path)}</code></td><td>${row.usages} 处</td></tr>`,
        )
        .join('')}</tbody></table>`,
    )
  }

  parts.push(`<h3>最大的代码文件</h3>`)
  parts.push(
    `<table><thead><tr><th>路径</th><th>体积</th></tr></thead><tbody>${facts.churn.largest
      .map((row) => `<tr><td><code>${esc(row.path)}</code></td><td>${kb(row.bytes)}</td></tr>`)
      .join('')}</tbody></table>`,
  )

  if (facts.churn.items.length > 0) {
    const head = facts.churn.mode === 'history' ? '改动最多的文件' : '最近一次提交动过的文件'
    parts.push(`<h3>${head}</h3>`)
    parts.push(
      `<table><thead><tr><th>路径</th><th>${facts.churn.mode === 'history' ? '出现次数' : '本次改动'}</th></tr></thead><tbody>${facts.churn.items
        .map(
          (row) =>
            `<tr><td><code>${esc(row.path)}</code></td><td>${row.changes === undefined ? '—' : `${row.changes} 次`}</td></tr>`,
        )
        .join('')}</tbody></table>`,
    )
  }

  if (facts.snapshot?.subject) {
    parts.push(`<h3>最近一次提交</h3><p><code>${esc(facts.snapshot.date ?? '')}</code> ${esc(facts.snapshot.subject)}</p>`)
  }

  parts.push(`</details>`)
  return parts.join('\n')
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f7f9; color: #1c1f23;
  font: 16px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
main { max-width: 880px; margin: 0 auto; padding: 56px 24px 24px; }
.kicker { margin: 0 0 8px; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: #6b7280; }
h1 { margin: 0 0 6px; font-size: 34px; line-height: 1.25; letter-spacing: -0.01em; }
.meta { margin: 0 0 36px; font-size: 13px; color: #6b7280; }
section { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 28px 30px; margin: 0 0 20px; }
section p { margin: 0 0 16px; }
section p:last-child { margin-bottom: 0; }
.limits { background: #fffdf5; border-color: #f0e4bf; }
.limits h2 { margin: 0 0 14px; font-size: 17px; }
.limits ul { margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.75; }
.limits li { margin-bottom: 8px; }
.muted { color: #6b7280; font-size: 14px; }
details.devref { background: #fbfbfc; border: 1px dashed #d1d5db; border-radius: 12px; padding: 18px 22px; font-size: 14px; }
details.devref summary { cursor: pointer; color: #374151; font-weight: 600; }
details.devref h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; margin: 22px 0 8px; }
ul.paths { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.8; }
code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #eef0f3; padding: 1px 5px; border-radius: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eceef1; }
th { color: #6b7280; font-weight: 600; }
footer { max-width: 880px; margin: 0 auto; padding: 10px 24px 48px; font-size: 13px; color: #6b7280; }
footer a { color: #2563eb; }
@media (prefers-color-scheme: dark) {
  body { background: #0f1115; color: #e7e9ee; }
  section { background: #171a21; border-color: #262b35; }
  .limits { background: #1c1a12; border-color: #453c22; }
  details.devref { background: #14171d; border-color: #2b3038; }
  code { background: #232833; }
  th, td { border-color: #262b35; }
}
`

/**
 * 渲染入口。
 * options: { config, generatedAt, repoUrl, version }
 * config 里只有一件事会影响这里：attribution 是否关闭页脚。meta 不受影响。
 */
export function renderHtml(facts, options = {}) {
  const branding = brandingParts(options.config, { repoUrl: options.repoUrl, version: options.version })
  const generatedDay = options.generatedAt ?? new Date().toISOString().slice(0, 10)
  const paragraphs = productParagraphs(facts, generatedDay)
  const title = `${facts.repoName} · 系统现状`

  // 页脚里的地址要可点：先把整句转义，再把地址单独换成链接文本（不重复转义）。
  const footerHtml =
    branding.footer === null
      ? ''
      : `<footer>${esc(branding.footer.split(branding.repoUrl)[0])}<a href="${esc(branding.repoUrl)}">${esc(
          branding.repoUrl,
        )}</a>${esc(branding.footer.slice(branding.footer.indexOf(branding.repoUrl) + branding.repoUrl.length))}</footer>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${branding.meta}
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<p class="kicker">${PRODUCT} · 系统现状</p>
<h1>${esc(facts.repoName)}</h1>
<p class="meta">代码快照：${esc(facts.repoName)}${
    facts.snapshot?.date ? ` @ ${esc(dayOf(facts.snapshot.date) ?? facts.snapshot.date)}` : '（读不到提交日期）'
  } · 生成于 ${esc(generatedDay)}</p>
</header>

<section class="product">
<!-- product-body:start -->
${paragraphs.map((text) => `<p>${esc(text)}</p>`).join('\n')}
<!-- product-body:end -->
</section>

<section class="limits">
<h2>这份材料读到哪、没读到哪</h2>
<ul>
${limitsItems(facts).join('\n')}
</ul>
</section>

${devRefSection(facts)}
</main>
${footerHtml}
</body>
</html>
`
}
