// 命中强度：这个节点到底是「实现位置」还是「词面撞车」。
//
// 为什么需要单独一层判断：检索只能证明「名字里有这个词」，它证明不了「这就是你要找的东西」。
// 需求写「分享页要支持未登录下载但只有会员能下」，索引里有 `login`、`auth`，
// 于是三个节点被摆成答案——可那句需求里的「登录」是「未登录」，是被否掉的东西。
// 一份材料在这种时候最危险的不是漏，而是**看起来有答案**。
//
// 所以这里只做一件有据可查的事：把每个节点命中的词分成两类——
//   1. 通用词（structural）：页面、模块、文件、区域、api、utils、store…… 这类词写在哪都成立；
//   2. 主题词（subject）：需求里真正在说的事，而且**没有被否定**（未登录 / 不支持 / 没有 都不算）。
// 一个节点的命中全部落在第 1 类（或者全部落在被否定的词上）→ 判为弱命中。
// 全部节点都弱 → 整份材料要先说「这更像没命中」。
//
// 这张表是固定词表，可审查、可测试；它不是模型判断，也不读实现逻辑。
import { ZH_TERMS } from './ask.js'

/** 结构性词：出现在哪都不构成「找到了」的证据。一律小写比较。 */
export const GENERIC_TERMS = [
  // 中文
  '页面', '页', '模块', '文件', '区域', '目录', '组件', '配置', '工具', '接口', '方法',
  '函数', '类型', '样式', '资源', '入口', '主', '通用', '公共', '首页',
  // 英文（路径与符号里高频出现，且与业务无关）
  'page', 'pages', 'view', 'views', 'component', 'components', 'module', 'modules',
  'file', 'files', 'area', 'utils', 'util', 'common', 'shared', 'core', 'lib', 'src',
  'api', 'apis', 'store', 'stores', 'index', 'main', 'app', 'apps', 'config', 'configs',
  'setting', 'settings', 'asset', 'assets', 'public', 'static', 'layout', 'layouts',
  'hook', 'hooks', 'type', 'types', 'model', 'models', 'service', 'services', 'helper',
  'helpers', 'constant', 'constants', 'style', 'styles', 'css', 'js', 'ts', 'vue',
]

const GENERIC_SET = new Set(GENERIC_TERMS)

/** 这个词是不是结构性词（写在哪都成立，不构成证据）。 */
export function isGenericTerm(term) {
  return GENERIC_SET.has(String(term ?? '').toLowerCase())
}

/**
 * 否定词：需求里出现「未登录」「不支持下载」「没有会员」，被否掉的那个词不能当交集。
 * 只看紧挨着的那一两个字，不做句法分析——误判的代价是「多判一次弱命中」，
 * 比「把否掉的词当成答案」便宜得多。
 */
const NEGATIONS = ['未', '不', '没', '无', '非', '别', '勿', '禁止']
const NEGATION_WINDOW = 2

/**
 * 英文词 → 需求里可能出现的中文说法（反查 ask.js 那张固定表）。
 * 为什么需要：命中的是 `login`，而被否定的是「未**登录**」——不反查就看不到「否掉」这件事。
 */
function zhFormsOf(term) {
  const lower = String(term ?? '').toLowerCase()
  const forms = []
  for (const [zh, words] of Object.entries(ZH_TERMS)) {
    if (words.some((word) => word.toLowerCase() === lower)) forms.push(zh)
  }
  return forms
}

/** 需求里被否定的词（返回小写词表）。 */
export function negatedTermsIn(question, terms) {
  const text = String(question ?? '')
  const negated = new Set()
  for (const term of terms) {
    const needle = String(term ?? '')
    if (needle === '') continue
    const lower = needle.toLowerCase()
    // 命中的词本身（多为英文）与它的中文说法（login → 登录）都要查一遍否定：
    // 需求里写的是「未登录」，命中的是 `login`，不反查就看不出它已经被否掉了。
    for (const form of [lower, ...zhFormsOf(lower)]) {
      let from = 0
      let hit = false
      for (;;) {
        const at = text.toLowerCase().indexOf(form, from)
        if (at === -1) break
        from = at + form.length
        const before = text.slice(Math.max(0, at - NEGATION_WINDOW), at)
        if (NEGATIONS.some((word) => before.includes(word))) {
          negated.add(lower)
          hit = true
          break
        }
      }
      if (hit) break
    }
  }
  return negated
}

/**
 * 一个节点命中的词里，有几个是「主题词」（非结构、非否定）。
 * @param {{ matched?: string[] }} row 检索结果里的一行（字段来自 ask.js 的 buildRow）
 * @param {Set<string>} negated
 * @returns {string[]} 真正构成证据的词
 */
export function subjectHitsOf(row, negated) {
  const matched = Array.isArray(row?.matched) ? row.matched : []
  return matched.filter((term) => {
    const lower = String(term ?? '').toLowerCase()
    if (lower === '') return false
    if (isGenericTerm(lower)) return false
    if (negated.has(lower)) return false
    return true
  })
}

/**
 * 全量判断：整份材料弱不弱，每个节点弱不弱，共享的是哪几个词。
 *
 * @param {{ question?: string, matches?: Array<{ path?: string, matched?: string[] }> }} options
 * @returns {{ weak: boolean, sharedTerms: string[], weakPaths: string[], total: number }}
 */
export function assessMatchStrength(options) {
  const matches = Array.isArray(options?.matches) ? options.matches : []
  const matchedTerms = []
  for (const row of matches) {
    for (const term of Array.isArray(row?.matched) ? row.matched : []) {
      const lower = String(term ?? '').toLowerCase()
      if (lower !== '' && !matchedTerms.includes(lower)) matchedTerms.push(lower)
    }
  }
  const negated = negatedTermsIn(options?.question, matchedTerms)

  const weakPaths = []
  const sharedTerms = []
  for (const row of matches) {
    const hits = subjectHitsOf(row, negated)
    if (hits.length === 0) weakPaths.push(String(row?.path ?? ''))
    for (const term of Array.isArray(row?.matched) ? row.matched : []) {
      const lower = String(term ?? '').toLowerCase()
      if (lower !== '' && !sharedTerms.includes(lower)) sharedTerms.push(lower)
    }
  }

  // 「全部节点都弱」才算整份材料弱：部分弱就在各自节点上标出来，不推翻整份材料。
  const weak = matches.length > 0 && weakPaths.length === matches.length
  return {
    weak,
    // 只报非结构性、非否定的词更诚实？不：这里报的是「实际撞上的词」，
    // 让读者自己看见「只共享这几个词」这件事，比替他过滤更有用。
    sharedTerms: sharedTerms.slice(0, 6),
    weakPaths,
    total: matches.length,
  }
}

/** 弱命中那句话（正文与节点标签共用同一份措辞，避免两处说的不是一回事）。 */
export function weakMatchSentence(strength) {
  const words = strength.sharedTerms.length === 0 ? '（没有共同词）' : `「${strength.sharedTerms.join('、')}」`
  return `这 ${strength.total} 个节点与需求的词面重合度很低（只共享${words}）。这更像是没命中，而不是实现位置。`
}
