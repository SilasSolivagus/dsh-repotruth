// 流程画布（SVG，确定性地画）。
//
// 输出对齐 UEmaster flow-canvas 的 flowspec/1 输出契约的三件东西：
//   <svg id="flowsvg" data-flowspec="1" viewBox="0 0 W H">
//   <g class="node" id="flowchart-{id}-{n}" data-node="{id}">
//   <rect id="sel-ring" visibility="hidden"/>
// 走查页的 JS 靠 data-node 找节点、靠 getBBox() 挪选中框，所以这三样少一样联动就断。
//
// 形状这件事本身在说话：一串用线连起来的盒子看起来就是「先 A 后 B」。可索引能证明的
// 只有「同批候选」和「谁引用了谁」，证不出先后。所以：
//   · 有线：只有代码里真的引用过（proven=true）才画箭头，实线；
//   · 没有线：并排的候选装进一个虚线框里，框上写「同批候选 · 顺序无代码依据」，
//     节点之间**不连线**——不连线就是「它们只是同时被查到」最准确的画法。
import { esc } from './render.js'
import { wrapText } from './svg-text.js'

const STYLE = {
  width: 380,
  boxWidth: 332,
  lineH: 18,
  padY: 12,
  gapY: 46,
  siblingGapY: 12,
  groupPad: 10,
  groupCaptionH: 20,
  fontLabel: 13,
  fontEdge: 10.5,
  fontCaption: 10.5,
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
 * nodes: [{ id, label, type, weak? }]
 * edges: [{ from, to, label?, proven? }]（只有 proven=true 才会画线）
 */
export function renderFlowSvg(input) {
  const nodes = Array.isArray(input?.nodes) ? input.nodes : []
  const edges = Array.isArray(input?.edges) ? input.edges : []
  if (nodes.length === 0) throw new Error('流程图为空：没有节点就不画图')

  const centerX = STYLE.width / 2
  const provenEdges = edges.filter((edge) => edge?.proven === true)

  // 有线可画的节点按数组顺序排成一列（线的方向由 proven 定），其余的进「同批候选」组。
  const linked = new Set()
  for (const edge of provenEdges) {
    linked.add(edge.from)
    linked.add(edge.to)
  }
  const chainNodes = nodes.filter((node) => linked.has(node.id))
  const siblingNodes = nodes.filter((node) => !linked.has(node.id))
  const ordered = [...chainNodes, ...siblingNodes]

  let y = STYLE.padY
  const layout = []
  for (const node of ordered) {
    const look = LOOK[node.type] ?? LOOK.page
    const lines = wrapText(node.label, STYLE.fontLabel, STYLE.boxWidth - 24, 2)
    const height = nodeHeight(lines)
    layout.push({ node, look, lines, height, x: centerX - STYLE.boxWidth / 2, y })
    y += height + STYLE.gapY
  }

  // 同批候选组：把它们的盒子装进一个虚线框，框的标题写明「顺序无代码依据」。
  let group = null
  if (siblingNodes.length >= 2) {
    const members = layout.filter((row) => siblingNodes.includes(row.node))
    const top = members[0].y - STYLE.groupPad - STYLE.groupCaptionH
    const lastRow = members[members.length - 1]
    const bottom = lastRow.y + lastRow.height + STYLE.groupPad
    group = {
      x: 10,
      y: top,
      width: STYLE.width - 20,
      height: bottom - top,
      caption: '同批候选 · 顺序无代码依据',
    }
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

  if (group !== null) {
    parts.push(
      `<g class="sibling-group" data-sibling-group="1">` +
        `<rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="8" fill="#f7f8fa" stroke="#c8cdd4" stroke-width="1" stroke-dasharray="6 5"/>` +
        `<text x="${group.x + 10}" y="${group.y + 14}" font-size="${STYLE.fontCaption}" fill="#6b7280">${esc(group.caption)}</text>` +
        `</g>`,
    )
  }

  const byId = new Map(layout.map((row) => [row.node.id, row]))
  for (const edge of provenEdges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) continue
    const y1 = from.y + from.height
    const y2 = to.y
    if (y2 <= y1) continue
    parts.push(
      `<line x1="${centerX}" y1="${y1}" x2="${centerX}" y2="${y2 - 2}" stroke="#4b5563" stroke-width="1.4" marker-end="url(#arw)"/>`,
    )
    if (edge.label) {
      parts.push(
        `<text x="${centerX + 10}" y="${(y1 + y2) / 2 + 3}" font-size="${STYLE.fontEdge}" fill="#4b5563">${esc(edge.label)}</text>`,
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
    // 弱命中：名字旁边挂一个小标签，看图的人不必先读正文才知道这件事。
    if (node.weak === true) {
      const badge = '弱命中'
      const badgeW = 44
      shape.push(
        `<g class="weak-badge"><rect x="${row.x + STYLE.boxWidth - badgeW - 6}" y="${row.y + 6}" width="${badgeW}" height="16" rx="3" fill="#fff4e5" stroke="#e0b070" stroke-width="1"/>` +
          `<text x="${row.x + STYLE.boxWidth - badgeW / 2 - 6}" y="${row.y + 18}" font-size="10" fill="#8a5a00" text-anchor="middle">${badge}</text></g>`,
      )
    }
    parts.push(`<g class="node" id="flowchart-${esc(node.id)}-${index}" data-node="${esc(node.id)}">${shape.join('')}</g>`)
  })

  // 选中框：走查页的 JS 用目标节点 getBBox() 把它挪过去并显示。
  parts.push('<rect id="sel-ring" visibility="hidden" fill="none" stroke="#2563eb" stroke-width="2" rx="8"/>')
  parts.push('</svg>')
  return {
    svg: parts.join(''),
    width: STYLE.width,
    height,
    // 图上到底有几种线：0 种（只有候选）、1 种（引用）。正文据此决定说什么。
    edgeKinds: provenEdges.length > 0 ? 1 : 0,
    provenEdges: provenEdges.length,
    siblingGroups: group === null ? 0 : 1,
  }
}
