// 把「问一句」的结果渲染成材料。
//
// 用的是和 demo 完全同一套纪律（同一条 CSS、同一个署名模块、同一个正文禁词表）：
// 1. 正文只说产品语言，路径/符号/分数一律降到末尾折叠的研发参考；
// 2. 材料自己写清「读到哪、没读到哪」，并且写死「没找到 ≠ 不存在」；
// 3. 页脚署名 + <head> 里的生成器 meta，一个都不少。
import { brandingParts, PRODUCT } from './branding.js'
import { BASE_CSS, dayOf, daysBetween, esc, kb } from './render.js'

const PRODUCT_BODY_RE = /<!-- product-body:start -->([\s\S]*?)<!-- product-body:end -->/

/** 只取正文区文字（测试与自检用）：去掉标签后判断禁词。 */
export function answerBodyText(html) {
  const match = PRODUCT_BODY_RE.exec(html)
  if (match === null) return ''
  return match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function ageText(lastChange, generatedDay) {
  const day = dayOf(lastChange)
  if (day === null || generatedDay === null) return ''
  const age = daysBetween(day, generatedDay)
  if (age === null) return ''
  if (age > 180) return `（距今 ${age} 天，已经很久没人动过）`
  if (age > 14) return `（距今 ${age} 天）`
  return ''
}

/**
 * 正文段落。found / no-index 三种情况分开写——它们的结论强度差一个数量级，
 * 合并成一句就会出现「没查到」被读成「不存在」。
 */
export function answerParagraphs(answer, generatedDay) {
  const stats = answer.stats ?? {}
  const question = answer.question ?? ''

  if (answer.state === 'no-index') {
    return [
      `还没有任何一个仓建过索引，所以这一轮没有可查的东西。`,
      `这不代表你要找的东西不存在——只代表还没有材料可查。先在「仓库」里接入一个仓、跑完一轮索引，再问同一句话。`,
    ]
  }

  if (answer.found !== true) {
    const terms = (answer.terms ?? []).slice(0, 8).join('、') || '（问题里没有可用的词）'
    const skipped = answer.skipped ?? {}
    const paragraphs = [
      `没能在已索引的代码里找到与「${question}」相关的地方。`,
      `这是「查过、没命中」，不是「不存在」：这一轮查了 ${stats.repos ?? 0} 个仓、${stats.files ?? 0} 个文件，用的检索词是 ${terms}。`,
    ]
    const skippedTotal =
      (skipped.generated ?? 0) + (skipped.test ?? 0) + (skipped.dir ?? 0) + (skipped.asset ?? 0) + (skipped.unsupported ?? 0) + (skipped.large ?? 0)
    if (skippedTotal > 0) {
      paragraphs.push(
        `如果它确实存在，常见的原因有三个：名字用了另一套说法（比如英文缩写或拼音）、这件事在没接入的仓里、` +
          `或者承载它的文件被当作自动生成代码或测试跳过了（这一轮共跳过 ${skippedTotal} 个文件）。`,
      )
    } else {
      paragraphs.push(`如果它确实存在，最可能的原因是名字用了另一套说法，或者这件事不在已接入的仓里。`)
    }
    return paragraphs
  }

  const paragraphs = []
  paragraphs.push(
    `你问的是「${question}」。在已接入的 ${stats.repos ?? 0} 个仓里，有 ${stats.matchedFiles ?? 0} 处候选的名字与它相关；` +
      `这是按名字比对出来的线索，不是对实现的理解。`,
  )

  if ((stats.matchedPages ?? 0) > 0) {
    const names = (stats.pageNames ?? []).join('、')
    paragraphs.push(
      `其中有 ${stats.matchedPages} 处是用户能到达的页面或视图：${names}。` +
        `剩下 ${Math.max(0, (stats.matchedFiles ?? 0) - (stats.matchedPages ?? 0))} 处是支撑这些界面的模块与配置。`,
    )
  } else {
    paragraphs.push(`这些候选里没有页面或视图——它可能落在界面之外的模块里，也可能这个功能在没接入的仓里。`)
  }

  const areaBytes = (answer.matches ?? []).reduce((sum, row) => sum + (Number.isFinite(row.bytes) ? row.bytes : 0), 0)
  const imported = stats.importedFiles ?? 0
  const importText =
    imported === 0
      ? `这些文件暂时没有被别的模块引用过，说明它们更像是入口或末端，而不是被复用的基建。`
      : `其中 ${imported} 个被别的模块引用过，引用最多的一处被 ${stats.maxImportedBy} 个文件引用——改动它时要连带看这些地方。`
  paragraphs.push(`这片区域合计 ${stats.matchedFiles ?? 0} 个文件、约 ${kb(areaBytes)}。${importText}`)

  const repoText = (answer.repos ?? [])
    .map((row) => `${row.name} @ ${dayOf(row.headDate) ?? '（读不到提交日期）'}`)
    .join('；')
  const changed = ageText(stats.lastChange, generatedDay)
  if (typeof stats.lastChange === 'string') {
    paragraphs.push(`这片区域最近一次改动是 ${dayOf(stats.lastChange) ?? stats.lastChange}${changed}。代码快照：${repoText}。`)
  } else {
    paragraphs.push(`改动时间读不到（不在最近提交的窗口里），所以这里不写「多久没动过」。代码快照：${repoText}。`)
  }

  paragraphs.push(
    `名字相似不等于就是它：上面的每一条都需要研发确认，材料里没有一个字来自对实现逻辑的阅读。`,
  )
  return paragraphs
}

/** 限界框。这一节是全篇最重要的一段：缺了它，上面每句话都会被读成全知。 */
export function answerLimits(answer) {
  const stats = answer.stats ?? {}
  const skipped = answer.skipped ?? {}
  const items = []

  items.push({
    title: '读了什么',
    text:
      answer.state === 'no-index'
        ? '什么都没读：本机还没有任何索引。这份材料不含任何现状判断。'
        : `只读本机索引，全程没有联网。覆盖 ${stats.repos ?? 0} 个仓、${stats.files ?? 0} 个可读文件，合计约 ${kb(stats.bytes ?? 0)}。`,
  })

  items.push({
    title: '怎么读的',
    text:
      '按文件名、符号名与页面名做词面比对；没有读实现逻辑，也没有读提交说明的内容。' +
      '中文说法与英文命名的对应靠一张固定对照表，表里没有的说法就匹配不到。',
  })

  const skippedRows = [
    ['自动生成', skipped.generated ?? 0],
    ['测试文件', skipped.test ?? 0],
    ['第三方目录', skipped.dir ?? 0],
    ['图片字体等素材', skipped.asset ?? 0],
    ['认不得的扩展名', skipped.unsupported ?? 0],
    ['单个超过 512 KB', skipped.large ?? 0],
  ].filter(([, count]) => count > 0)

  items.push({
    title: '读不到',
    text:
      skippedRows.length === 0
        ? '本轮没有跳过任何文件；但这只说明文件都在处理范围内，不代表内容都被读懂了。'
        : `${skippedRows.map(([label, count]) => `${label} ${count} 个`).join('、')}。这些文件不参与检索：它们里面即使有答案，这份材料也看不见。`,
  })

  items.push({
    title: '没找到 ≠ 不存在',
    text:
      '名单里没有某个东西，只代表这一轮没命中，不代表它不存在。要确认「确实没有」，需要研发给一份页面入口或功能清单，再对一次。',
  })

  const repoNames = (answer.repos ?? []).map((row) => row.name)
  items.push({
    title: '查过的范围',
    text:
      repoNames.length === 0
        ? '没有可查的仓。'
        : `只在这几个仓里查过：${repoNames.join('、')}。不在这些仓里的东西，这份材料一个字都没有。`,
  })

  if (Array.isArray(answer.missing) && answer.missing.length > 0) {
    items.push({
      title: '这次没查成的仓',
      text: answer.missing.map((row) => `${row.repo}（${row.error}）`).join('；') + '。它们不在上面的判断里。',
    })
  }

  return items
}

function devRefHtml(answer) {
  const rows = answer.matches ?? []
  const parts = [`<details class="devref"><summary>研发参考（正文里的每个数字都能在这里找到坐标）</summary>`]
  parts.push(`<p class="muted">检索词：${esc((answer.terms ?? []).join('、') || '（无）')}</p>`)
  if (rows.length === 0) {
    parts.push(`<p class="muted">这一轮没有命中任何文件。</p>`)
  } else {
    parts.push(
      `<table><thead><tr><th>仓 / 路径</th><th>页面</th><th>符号</th><th>被引用</th><th>最近改动</th><th>分数</th></tr></thead><tbody>${rows
        .map(
          (row) =>
            `<tr><td><code>${esc(row.repo)}:${esc(row.path)}</code></td>` +
            `<td>${row.page === null ? '—' : `<code>${esc(row.page)}</code>`}</td>` +
            `<td>${(row.symbols ?? []).slice(0, 6).map((symbol) => `<code>${esc(symbol)}</code>`).join(' ') || '—'}</td>` +
            `<td>${row.importedBy} 处</td>` +
            `<td>${row.lastChange === null ? '读不到' : esc(dayOf(row.lastChange) ?? row.lastChange)}</td>` +
            `<td>${row.score}</td></tr>`,
        )
        .join('')}</tbody></table>`,
    )
    parts.push(
      `<h3>口径</h3><p class="muted">分数 = 名字命中的加权和；页面一列只按目录约定识别，` +
        `所以「这里没有页面」只代表没认出，不代表没有。</p>`,
    )
  }
  parts.push(`</details>`)
  return parts.join('\n')
}

/**
 * 渲染入口。
 * options: { config, generatedAt, answerId, repoUrl }
 */
export function renderAnswer(answer, options = {}) {
  const branding = brandingParts(options.config, { repoUrl: options.repoUrl, version: options.version })
  const generatedDay = options.generatedAt ?? new Date().toISOString().slice(0, 10)
  const paragraphs = answerParagraphs(answer, generatedDay)
  const limits = answerLimits(answer)
  const title = `问一句：${answer.question} · 系统现状`

  const footerHtml =
    branding.footer === null
      ? ''
      : `<footer>${esc(branding.footer.split(branding.repoUrl)[0])}<a href="${esc(branding.repoUrl)}">${esc(
          branding.repoUrl,
        )}</a>${esc(branding.footer.slice(branding.footer.indexOf(branding.repoUrl) + branding.repoUrl.length))}</footer>`

  const scope = answer.state === 'no-index' ? '还没有索引' : answer.found ? `${answer.matches.length} 处候选` : '没找到'

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${branding.meta}
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main>
<header>
<p class="kicker">${PRODUCT} · 系统现状</p>
<h1>${esc(answer.question)}</h1>
<p class="meta">${esc(scope)} · 只读本机索引 · 生成于 ${esc(generatedDay)}</p>
</header>

<section class="product">
<!-- product-body:start -->
${paragraphs.map((text) => `<p>${esc(text)}</p>`).join('\n')}
<!-- product-body:end -->
</section>

<section class="limits">
<h2>这份材料读到哪、没读到哪</h2>
<ul>
${limits.map((item) => `<li><b>${esc(item.title)}</b>：${esc(item.text)}</li>`).join('\n')}
</ul>
</section>

${devRefHtml(answer)}
</main>
${footerHtml}
</body>
</html>
`

  return { html, body: paragraphs, limits, generatedDay }
}
