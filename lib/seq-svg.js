// 时序图（SVG，确定性地画）。
//
// 契约对齐 UEmaster flow-canvas 的 seqspec/1 输出形状（根元素 data-seqspec="1"、
// 参与者 g.participant、消息 g.message），因为走查页里最终要看的是同一套视觉语言。
// 但我们**不**复用它的 Python 布局器：本插件不加构建步骤、不加运行时依赖，
// 而且这里的图只有一种形态（参与者 ≤ 6、消息线性分层），自己排更好控制。
//
// 最重要的一条约束：参与者是一个**封闭词表**（用户 / 页面 / 服务端 / 支付渠道 /
// 第三方 / 通知渠道）。图上永远不出现方法名、类名、表名——那些是研发参考里的坐标，
// 不是评审该在图里读的东西。词表外的东西直接抛错，宁可生成失败也不画一张半懂的图。
import { esc } from './render.js'
import { textWidth, wrapText } from './svg-text.js'

/** 参与者词表。顺序即默认列序，新增成员必须同时改测试。 */
export const SEQ_PARTICIPANTS = Object.freeze(['用户', '页面', '服务端', '支付渠道', '第三方', '通知渠道'])

/** 最多几列。超过就排不下，也说明这张图已经不该画了。 */
export const SEQ_MAX_PARTICIPANTS = 6

const STYLE = {
  padX: 20,
  padTop: 16,
  headH: 32,
  headPadX: 14,
  headMinW: 88,
  headGap: 18,
  colMinDist: 104,
  labelPad: 26,
  rowH: 26,
  msgTopPad: 26,
  labelDy: 7,
  tailPad: 16,
  selfW: 38,
  selfH: 16,
  fontHead: 12.5,
  fontLabel: 11,
}

/** 词表校验：抛错而不降级。降级会让图上出现「数据库」这种没人能核实的列。 */
export function assertParticipantVocabulary(participants) {
  const list = Array.isArray(participants) ? participants : []
  if (list.length === 0) throw new Error('时序图至少要有一个参与者')
  if (list.length > SEQ_MAX_PARTICIPANTS) {
    throw new Error(`时序图参与者最多 ${SEQ_MAX_PARTICIPANTS} 个，实际 ${list.length} 个`)
  }
  const seen = new Set()
  for (const name of list) {
    if (!SEQ_PARTICIPANTS.includes(name)) {
      throw new Error(`参与者「${name}」不在封闭词表里（只允许：${SEQ_PARTICIPANTS.join(' / ')}）`)
    }
    if (seen.has(name)) throw new Error(`参与者「${name}」重复出现`)
    seen.add(name)
  }
  return list
}

/** 消息两端必须是已声明的参与者；自消息两端同名。 */
export function assertMessages(participants, messages) {
  const list = Array.isArray(messages) ? messages : []
  const known = new Set(participants)
  for (const message of list) {
    if (!known.has(message?.from) || !known.has(message?.to)) {
      throw new Error(`消息「${message?.text ?? ''}」指向了未声明的参与者`)
    }
    if (typeof message?.text !== 'string' || message.text.trim() === '') {
      throw new Error('每条消息都要有文字')
    }
  }
  return list
}

function headWidth(name) {
  return Math.max(STYLE.headMinW, Math.round(textWidth(name, STYLE.fontHead) + STYLE.headPadX * 2))
}

function labelOf(message, index) {
  return `${index + 1}. ${message.text}`
}

/**
 * 渲染时序图。
 * input: { participants: string[], messages: [{ from, to, text, kind?: 'sync'|'return' }], title? }
 * 返回 { svg, width, height }。
 */
export function renderSequenceSvg(input) {
  const participants = assertParticipantVocabulary(input?.participants)
  const messages = assertMessages(participants, input?.messages)

  const heads = participants.map(headWidth)
  const xs = []
  for (let i = 0; i < participants.length; i += 1) {
    if (i === 0) {
      xs.push(STYLE.padX + heads[0] / 2)
      continue
    }
    // 列距 = 三种约束里最宽的那个：最小列距、两个头不重叠、两列之间的标签放得下。
    let widest = 0
    messages.forEach((message, index) => {
      const a = participants.indexOf(message.from)
      const b = participants.indexOf(message.to)
      if (Math.min(a, b) !== i - 1 || Math.max(a, b) !== i) return
      widest = Math.max(widest, textWidth(labelOf(message, index), STYLE.fontLabel) + STYLE.labelPad)
    })
    const headKeep = (heads[i - 1] + heads[i]) / 2 + STYLE.headGap
    const dist = Math.max(STYLE.colMinDist, headKeep, widest)
    xs.push(xs[i - 1] + dist)
  }

  const topY = STYLE.padTop
  const headBottom = topY + STYLE.headH
  const firstY = headBottom + STYLE.msgTopPad
  const lastY = messages.length === 0 ? firstY : firstY + (messages.length - 1) * STYLE.rowH
  const lifeBottom = lastY + STYLE.tailPad

  // 右边界：普通列看头的右沿，自消息还要给回环和标签留位置（标签画在回环右侧）。
  let rightEdge = 0
  participants.forEach((_, i) => {
    rightEdge = Math.max(rightEdge, xs[i] + heads[i] / 2)
  })
  messages.forEach((message, index) => {
    if (message.from !== message.to) return
    const i = participants.indexOf(message.from)
    const labelW = textWidth(labelOf(message, index), STYLE.fontLabel)
    rightEdge = Math.max(rightEdge, xs[i] + STYLE.selfW + 8 + labelW)
  })
  const width = Math.ceil(rightEdge + STYLE.padX)
  const height = Math.ceil(lifeBottom + STYLE.padTop)

  const parts = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" data-seqspec="1" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
      `font-family="-apple-system, BlinkMacSystemFont, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif" role="img">`,
  )
  parts.push(
    '<defs><marker id="seq-arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker>' +
      '<marker id="seq-arw-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#fff" stroke="#777" stroke-width="1"/></marker></defs>',
  )

  // 生命线先画：它要在所有图形下面。
  participants.forEach((name, i) => {
    parts.push(
      `<line x1="${xs[i]}" y1="${headBottom}" x2="${xs[i]}" y2="${lifeBottom}" stroke="#b6bcc4" stroke-width="1" stroke-dasharray="5 4"/>`,
    )
  })

  messages.forEach((message, index) => {
    const label = labelOf(message, index)
    const y = firstY + index * STYLE.rowH
    const isReturn = message.kind === 'return'
    const stroke = isReturn ? '#8a9199' : '#4b5563'
    const dash = isReturn ? ' stroke-dasharray="5 4"' : ''
    const marker = isReturn ? 'seq-arw-open' : 'seq-arw'
    if (message.from === message.to) {
      const i = participants.indexOf(message.from)
      const x = xs[i]
      const loop = [
        `${x},${y - STYLE.selfH / 2}`,
        `${x + STYLE.selfW},${y - STYLE.selfH / 2}`,
        `${x + STYLE.selfW},${y + STYLE.selfH / 2}`,
        `${x},${y + STYLE.selfH / 2}`,
      ].join(' ')
      parts.push(
        `<g class="message" id="seq-msg-${index}"><polyline points="${loop}" fill="none" stroke="${stroke}" stroke-width="1.4"${dash} ` +
          `marker-end="url(#${marker})"/>` +
          `<text x="${x + STYLE.selfW + 8}" y="${y + 4}" font-size="${STYLE.fontLabel}" fill="#6b7280">${esc(label)}</text></g>`,
      )
      return
    }
    const fromIndex = participants.indexOf(message.from)
    const toIndex = participants.indexOf(message.to)
    const forward = toIndex > fromIndex
    const x1 = xs[fromIndex] + (forward ? 1 : -1) * 1
    const x2 = xs[toIndex] + (forward ? -1 : 1) * 1
    const labelX = (xs[fromIndex] + xs[toIndex]) / 2
    parts.push(
      `<g class="message" id="seq-msg-${index}"><line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${stroke}" stroke-width="1.4"${dash} ` +
        `marker-end="url(#${marker})"/>` +
        `<text x="${labelX}" y="${y - STYLE.labelDy}" font-size="${STYLE.fontLabel}" fill="#6b7280" text-anchor="middle">${esc(label)}</text></g>`,
    )
  })

  participants.forEach((name, i) => {
    const lines = wrapText(name, STYLE.fontHead, heads[i] - STYLE.headPadX * 2, 1)
    const x = xs[i]
    parts.push(
      `<g class="participant" id="seq-p${i}">` +
        `<rect x="${x - heads[i] / 2}" y="${topY}" width="${heads[i]}" height="${STYLE.headH}" rx="4" fill="#f4f5f7" stroke="#9aa1ab" stroke-width="1"/>` +
        `<text class="seq-pname" x="${x}" y="${topY + STYLE.headH / 2 + 4}" font-size="${STYLE.fontHead}" fill="#333" text-anchor="middle">${esc(lines[0])}</text>` +
        '</g>',
    )
  })

  parts.push('</svg>')
  return { svg: parts.join(''), width, height, participants }
}
