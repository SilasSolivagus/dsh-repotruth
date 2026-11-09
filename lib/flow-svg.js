// 流程画布（SVG，确定性地画）。
//
// 输出对齐 UEmaster flow-canvas 的 flowspec/1 输出契约的三件东西：
//   <svg id="flowsvg" data-flowspec="1" viewBox="0 0 W H">
//   <g class="node" id="flowchart-{id}-{n}" data-node="{id}">
//   <rect id="sel-ring" visibility="hidden"/>
// 走查页的 JS 靠 data-node 找节点、靠 getBBox() 挪选中框，所以这三样少一样联动就断。
//
// 排版只做一种形态：纵向单列。因为节点是从索引里「按名字相关」归出来的，
// 索引能证明的只有「同批候选」和「谁引用了谁」，没有分支、没有判断、没有回边——
// 那就不要画成有分支的样子。虚线边就是「顺序是我们排的，不是代码里的跳转」。
import { esc } from './render.js'
import { textWidth, wrapText } from './svg-text.js'

const STYLE = {
  width: 380,
  boxWidth: 332,
  lineH: 18,
  padY: 12,
  gapY: 34,
  fontLabel: 13,
  fontEdge: 10.5,
}

/** 节点类型 → 外观。page=本产品页面；backend=没有页面的模块区；external=外部。 */
const LOOK = {
  page: { fill: '#ffffff', stroke: '#333333', width: 1.5, double: false },
  backend: { fill: '#eceef1', stroke: '#5b6470', width: 1.2, double: true },
  external: { fill: '#ffffff', stroke: '#777777', width: 1.4, dash: '6 4', double: false },
}

function nodeHeight(lines) {
  return STYLE.padY * 2 + lines.length * STYLE.lineH
}

/**
 * 渲染流程 SVG。
 * nodes: [{ id, label, type, note? }]
 * edges: [{ from, to, label?, proven? }]（proven=false 画虚线：只表示「同批候选」）
 */
export function renderFlowSvg(input) {
  const nodes = Array.isArray(input?.nodes) ? input.nodes : []
  const edges = Array.isArray(input?.edges) ? input.edges : []
  if (nodes.length === 0) throw new Error('流程图为空：没有节点就不画图')

  const centerX = STYLE.width / 2
  const layout = []
  let y = STYLE.padY
  for (const node of nodes) {
    const look = LOOK[node.type] ?? LOOK.page
    const lines = wrapText(node.label, STYLE.fontLabel, STYLE.boxWidth - 24, 2)
    const height = nodeHeight(lines)
    layout.push({ node, look, lines, height, x: centerX - STYLE.boxWidth / 2, y })
    y += height + STYLE.gapY
  }
  const height = y - STYLE.gapY + STYLE.padY

  const parts = []
  parts.push(
    `<svg id="flowsvg" xmlns="http://www.w3.org/2000/svg" data-flowspec="1" viewBox="0 0 ${STYLE.width} ${height}" ` +
      `width="${STYLE.width}" height="${height}" font-family="-apple-system, BlinkMacSystemFont, PingFang SC, Segoe UI, Microsoft YaHei, sans-serif">`,
  )
  parts.push(
    '<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#4b5563"/></marker></defs>',
  )

  const byId = new Map(layout.map((row) => [row.node.id, row]))

  for (const edge of edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) continue
    const y1 = from.y + from.height
    const y2 = to.y
    const dashed = edge.proven !== true
    const attributes = dashed
      ? 'stroke="#9aa1ab" stroke-width="1.2" stroke-dasharray="5 4"'
      : 'stroke="#4b5563" stroke-width="1.4" marker-end="url(#arw)"'
    parts.push(`<line x1="${centerX}" y1="${y1}" x2="${centerX}" y2="${y2 - 2}" ${attributes}/>`)
    if (edge.label) {
      parts.push(
        `<text x="${centerX + 10}" y="${(y1 + y2) / 2 + 3}" font-size="${STYLE.fontEdge}" fill="#8a9199">${esc(edge.label)}</text>`,
      )
    }
  }

  layout.forEach((row, index) => {
    const { node, look, lines } = row
    const inner = look.double ? 4 : 0
    const shape = [`<rect x="${row.x}" y="${row.y}" width="${STYLE.boxWidth}" height="${row.height}" rx="4" fill="${look.fill}" stroke="${look.stroke}" stroke-width="${look.width}"${look.dash ? ` stroke-dasharray="${look.dash}"` : ''}/>`]
    if (look.double) {
      shape.push(
        `<rect x="${row.x + inner}" y="${row.y + inner}" width="${STYLE.boxWidth - inner * 2}" height="${row.height - inner * 2}" rx="3" fill="none" stroke="${look.stroke}" stroke-width="0.8"/>`,
      )
    }
    const textTop = row.y + row.height / 2 - ((lines.length - 1) * STYLE.lineH) / 2 + 4
    lines.forEach((line, lineIndex) => {
      shape.push(
        `<text x="${centerX}" y="${textTop + lineIndex * STYLE.lineH}" font-size="${STYLE.fontLabel}" fill="#1f2937" text-anchor="middle">${esc(line)}</text>`,
      )
    })
    parts.push(`<g class="node" id="flowchart-${esc(node.id)}-${index}" data-node="${esc(node.id)}">${shape.join('')}</g>`)
  })

  // 选中框：走查页的 JS 用目标节点 getBBox() 把它挪过去并显示。
  parts.push('<rect id="sel-ring" visibility="hidden" fill="none" stroke="#2563eb" stroke-width="2" rx="8"/>')
  parts.push('</svg>')
  return { svg: parts.join(''), width: STYLE.width, height }
}
