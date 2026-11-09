// 画 SVG 时的「字有多宽」。
//
// 为什么需要：布局是确定性的——同一份输入必须画出同一个 viewBox、同一个断行。
// 浏览器量文字要在渲染之后才知道，而我们是在生成 HTML 之前排版，所以只能估。
// 估错的代价只是留白多一点或标签换行，不会让文字压到线上；不估就得靠浏览器，
// 那就等于把「产物可复现」这件事交给渲染环境。
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 单字符宽度（以字号为 1）。中文与全角标点按 1 个字号宽，其余按 0.56。 */
export function charWidth(ch) {
  return CJK_RE.test(ch) ? 1 : 0.56
}

/** 一段文字的估算宽度（px）。 */
export function textWidth(text, fontSize = 13) {
  let units = 0
  for (const ch of String(text ?? '')) units += charWidth(ch)
  return units * fontSize
}

/**
 * 按宽度断行，最多 maxLines 行；超出部分用省略号收尾。
 * 返回数组（至少一行），调用方按行数分配高度。
 */
export function wrapText(text, fontSize, maxWidth, maxLines = 2) {
  const source = String(text ?? '')
  if (source === '') return ['']
  const lines = []
  let current = ''
  let width = 0
  for (const ch of source) {
    const next = charWidth(ch) * fontSize
    if (width + next > maxWidth && current !== '') {
      lines.push(current)
      current = ''
      width = 0
      if (lines.length === maxLines) {
        // 已经排满：把这一行改成省略号结尾，后面的字直接丢掉。
        lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(1, lines[maxLines - 1].length - 1))}…`
        return lines
      }
    }
    current += ch
    width += next
  }
  if (current !== '') lines.push(current)
  return lines.slice(0, maxLines)
}
