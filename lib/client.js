// 浏览器半边：设置里的「代码源」与「覆盖率」两页。
//
// 这个文件是手写的模块图 bundle，不是打包产物——它只需要调用
// window.__ModuleLoader__.load()，由主机把 id 和 require 映射接进来。
// 手写的好处是零构建依赖：改完保存，dsh 的 HMR 会在 500ms 轮询里换掉它。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-repo-truth',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    /** 词典命名空间。与宿主无关，只影响文案取用。 */
    const NS = 'repoTruth'
    const API = '/api/repo-truth'

    // 只出中文。英文键指向同一份中文：dsh 的语言回退链找不到 en 时会直接把 key
    // 打到界面上（repoTruth.nav 这种），那比“英文界面里出现中文”更糟。
    const zh = {
      nav: '代码源',
      coverageNav: '覆盖率',
      title: '代码源',
      intro: '这里登记公司自己的 Git 服务器。插件只读仓库，不会改代码，也不会把令牌发给第三方。',
      loading: '正在读取已保存的代码源…',
      empty: '还没有代码源。先添加一个 Git 服务器地址，插件才能开始读仓库。',
      add: '添加代码源',
      edit: '编辑',
      cancel: '取消',
      save: '保存',
      saving: '正在保存…',
      remove: '删除',
      removeConfirm: '确认删除',
      test: '测试连接',
      testing: '正在连接…',
      name: '名称',
      namePlaceholder: '例如：主代码平台',
      baseUrl: '地址',
      baseUrlPlaceholder: '例如：https://git.example.com',
      kind: '类型',
      kindGitlab: 'GitLab',
      kindGithub: 'GitHub',
      kindGeneric: '通用（只测连通）',
      token: '访问令牌',
      tokenPlaceholder: '粘贴只读令牌，保存后只显示末四位',
      tokenKeep: '留空表示不修改已保存的令牌',
      tokenMissing: '未设置令牌',
      nameRequired: '名称不能为空',
      baseUrlRequired: '地址要以 http:// 或 https:// 开头',
      saved: '已保存',
      deleted: '已删除',
      storage: '配置保存在',
      coverageTitle: '覆盖率',
      coverageIntro: '接进来不等于看得见：这张表说明每个仓索引了多少文件、跳过多少自动生成的代码。',
      coverageLoading: '正在读取覆盖率…',
      coverageEmpty: '还没有覆盖率数据。',
      coverageEmptyHint: '这一页只读：跑完一轮索引后，把结果写进 coverage.json 就会出现在这里。',
      coverageNoFile: '没找到覆盖率文件',
      coverageNoRepos: '文件里没有仓的记录。',
      repo: '仓名',
      filesIndexed: '索引文件数',
      filesSkipped: '跳过生成数',
      status: '状态',
      ok: '已索引',
      failed: '索引失败',
      zeroIndexed: '接进来了，但索引 0 行',
      summary: '接进来 {total} 个 · 看得见 {indexed} 个 · 看不见 {invisible} 个',
      snapshot: '快照日期：{date}',
      notMeasured: '未测量',
      refresh: '刷新',
      errorPrefix: '出错了',
      retry: '重试',
      boundary: '边界：这一版只做登记与只读展示，不克隆仓库、不生成材料。',
    }
    const en = zh

    // —— 视觉：全部走 dsh 自己的设计令牌，跟随深浅色主题，不写死颜色。——
    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        maxWidth: '860px',
        width: '100%',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '20px',
      },
      intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
      card: {
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-settings-card-fill)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      rowHead: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      strong: { fontSize: '14px', fontWeight: 500 },
      meta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
      button: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '8px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      primary: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 12px',
        borderRadius: '8px',
        border: '0.5px solid var(--dsw-alias-state-business-primary)',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        cursor: 'pointer',
      },
      danger: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '8px',
        border: '0.5px solid var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        cursor: 'pointer',
      },
      input: {
        font: 'inherit',
        fontSize: '13px',
        padding: '6px 10px',
        borderRadius: '8px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        width: '100%',
        boxSizing: 'border-box',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))' },
      bad: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-tertiary)',
        padding: '6px 8px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
      },
      td: {
        padding: '6px 8px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        verticalAlign: 'top',
      },
      code: { fontFamily: 'var(--ds-font-family-code)', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
    }

    /** 统一的取数：后端一律回 { ok, ... }，非 2xx 或 ok:false 都当失败并带中文原因。 */
    async function call(path, init) {
      let response
      try {
        response = await fetch(API + path, init)
      } catch {
        throw new Error('连不上插件后端（页面可能刚重载，稍后再试）')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok === false) {
        throw new Error(payload?.error ?? `后端返回 ${response.status}`)
      }
      return payload
    }

    function ErrorLine({ text }) {
      return text === null ? null : h('div', { style: S.bad }, `${text}`)
    }

    function Field({ label, children }) {
      return h('label', { style: S.field }, h('span', { style: S.label }, label), children)
    }

    const EMPTY_FORM = { originalName: '', name: '', baseUrl: '', kind: 'gitlab', token: '' }

    function SourcesPage({ t }) {
      const [state, setState] = useState({ loading: true, hosts: [], warning: null, path: '', error: null })
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState(false)
      const [formError, setFormError] = useState(null)
      const [tests, setTests] = useState({})
      const [confirming, setConfirming] = useState(null)
      const [flash, setFlash] = useState(null)
      const [draftTest, setDraftTest] = useState(null)

      const reload = useCallback(async () => {
        setState((prev) => ({ ...prev, loading: true, error: null }))
        try {
          const data = await call('/config')
          setState({ loading: false, hosts: data.hosts ?? [], warning: data.warning ?? null, path: data.path ?? '', error: null })
        } catch (error) {
          setState({ loading: false, hosts: [], warning: null, path: '', error: error.message })
        }
      }, [])

      useEffect(() => {
        reload()
      }, [reload])

      const submit = useCallback(async () => {
        const draft = form
        if (draft === null) return
        if (draft.name.trim() === '') return setFormError(t('nameRequired'))
        if (!/^https?:\/\//i.test(draft.baseUrl.trim())) return setFormError(t('baseUrlRequired'))
        setBusy(true)
        setFormError(null)
        try {
          const data = await call('/hosts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          })
          setState((prev) => ({ ...prev, hosts: data.hosts ?? [] }))
          setForm(null)
          setFlash(t('saved'))
        } catch (error) {
          setFormError(error.message)
        } finally {
          setBusy(false)
        }
      }, [form, t])

      const remove = useCallback(async (name) => {
        setBusy(true)
        try {
          const data = await call('/hosts/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          })
          setState((prev) => ({ ...prev, hosts: data.hosts ?? [] }))
          setConfirming(null)
          setFlash(t('deleted'))
        } catch (error) {
          setFormError(error.message)
        } finally {
          setBusy(false)
        }
      }, [t])

      const test = useCallback(async (row) => {
        setTests((prev) => ({ ...prev, [row.name]: { testing: true } }))
        try {
          const result = await call('/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: row.name, baseUrl: row.baseUrl, kind: row.kind, token: '' }),
          })
          setTests((prev) => ({
            ...prev,
            [row.name]: { testing: false, ok: true, message: result.message ?? '能连上' },
          }))
        } catch (error) {
          setTests((prev) => ({ ...prev, [row.name]: { testing: false, ok: false, message: error.message } }))
        }
      }, [])

      // 表单里的“测试连接”：用还没保存的这一份去测。这样贴令牌之前就能确认对不对，
      // 也避免为了测一次就把令牌先落盘。
      const testDraft = useCallback(async () => {
        const draftNow = form
        if (draftNow === null) return
        if (!/^https?:\/\//i.test(draftNow.baseUrl.trim())) return setFormError(t('baseUrlRequired'))
        setBusy(true)
        setFormError(null)
        setDraftTest({ testing: true })
        try {
          const result = await call('/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: draftNow.originalName, baseUrl: draftNow.baseUrl, kind: draftNow.kind, token: draftNow.token }),
          })
          setDraftTest({ testing: false, ok: true, message: result.message ?? '能连上' })
        } catch (error) {
          setDraftTest({ testing: false, ok: false, message: error.message })
        } finally {
          setBusy(false)
        }
      }, [form, t])

      const editing = form !== null
      const draft = form ?? EMPTY_FORM

      return h(
        'div',
        { style: S.page },
        h('p', { style: S.intro }, t('intro')),
        state.error === null ? null : ErrorLine({ text: `${t('errorPrefix')}：${state.error}` }),
        state.warning === null ? null : ErrorLine({ text: state.warning }),

        editing
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.strong }, t('add')),
              h(
                Field,
                { label: t('name') },
                h('input', {
                  style: S.input,
                  value: draft.name,
                  placeholder: t('namePlaceholder'),
                  onChange: (event) => setForm({ ...draft, name: event.target.value }),
                }),
              ),
              h(
                Field,
                { label: t('baseUrl') },
                h('input', {
                  style: S.input,
                  value: draft.baseUrl,
                  placeholder: t('baseUrlPlaceholder'),
                  onChange: (event) => setForm({ ...draft, baseUrl: event.target.value }),
                }),
              ),
              h(
                Field,
                { label: t('kind') },
                h(
                  'select',
                  { style: S.input, value: draft.kind, onChange: (event) => setForm({ ...draft, kind: event.target.value }) },
                  h('option', { value: 'gitlab' }, t('kindGitlab')),
                  h('option', { value: 'github' }, t('kindGithub')),
                  h('option', { value: 'generic' }, t('kindGeneric')),
                ),
              ),
              h(
                Field,
                { label: t('token') },
                h('input', {
                  style: S.input,
                  type: 'password',
                  value: draft.token,
                  placeholder: draft.originalName === '' ? t('tokenPlaceholder') : t('tokenKeep'),
                  onChange: (event) => setForm({ ...draft, token: event.target.value }),
                }),
              ),
              formError === null ? null : ErrorLine({ text: formError }),
              draftTest === null || draftTest.testing === true ? null : h('div', { style: draftTest.ok ? S.ok : S.bad }, draftTest.message),
              h(
                'div',
                { style: S.rowHead },
                h('button', { style: S.primary, disabled: busy, onClick: submit }, busy ? t('saving') : t('save')),
                h('button', { style: S.button, disabled: busy, onClick: testDraft }, draftTest?.testing === true ? t('testing') : t('test')),
                h('button', { style: S.button, onClick: () => { setForm(null); setFormError(null); setDraftTest(null) } }, t('cancel')),
              ),
            )
          : h(
              'div',
              { style: S.rowHead },
              h('button', { style: S.primary, onClick: () => { setForm({ ...EMPTY_FORM }); setFormError(null); setFlash(null); setDraftTest(null) } }, t('add')),
              flash === null ? null : h('span', { style: S.ok }, flash),
            ),

        state.loading
          ? h('div', { style: S.meta }, t('loading'))
          : state.hosts.length === 0
            ? h('div', { style: S.card }, h('div', { style: S.meta }, t('empty')))
            : state.hosts.map((row) =>
                h(
                  'div',
                  { key: row.name, style: S.card },
                  h(
                    'div',
                    { style: S.rowHead },
                    h('span', { style: S.strong }, row.name),
                    h('span', { style: S.meta }, row.kind === 'github' ? t('kindGithub') : row.kind === 'generic' ? t('kindGeneric') : t('kindGitlab')),
                    h('span', { style: S.meta }, row.baseUrl),
                    h('span', { style: S.code }, row.hasToken ? row.tokenMasked : t('tokenMissing')),
                  ),
                  h(
                    'div',
                    { style: S.rowHead },
                    h(
                      'button',
                      { style: S.button, disabled: tests[row.name]?.testing === true, onClick: () => test(row) },
                      tests[row.name]?.testing === true ? t('testing') : t('test'),
                    ),
                    h(
                      'button',
                      {
                        style: S.button,
                        onClick: () => {
                          setForm({ originalName: row.name, name: row.name, baseUrl: row.baseUrl, kind: row.kind, token: '' })
                          setFormError(null)
                          setFlash(null)
                          setDraftTest(null)
                        },
                      },
                      t('edit'),
                    ),
                    confirming === row.name
                      ? h(
                          'span',
                          { style: S.rowHead },
                          h('button', { style: S.danger, disabled: busy, onClick: () => remove(row.name) }, t('removeConfirm')),
                          h('button', { style: S.button, onClick: () => setConfirming(null) }, t('cancel')),
                        )
                      : h('button', { style: S.danger, onClick: () => setConfirming(row.name) }, t('remove')),
                  ),
                  tests[row.name] === undefined || tests[row.name].testing === true
                    ? null
                    : h('div', { style: tests[row.name].ok ? S.ok : S.bad }, tests[row.name].message),
                ),
              ),

        h('div', { style: S.code }, t('boundary')),
        state.path === '' ? null : h('div', { style: S.code }, `${t('storage')} ${state.path}`),
      )
    }

    function statusLabel(t, row) {
      if (!row.ok) return row.error === null ? t('failed') : `${t('failed')}：${row.error}`
      if (row.filesIndexed === 0) return t('zeroIndexed')
      return t('ok')
    }

    function CoveragePage({ t }) {
      const [state, setState] = useState({ loading: true, data: null, error: null })

      const reload = useCallback(async () => {
        setState({ loading: true, data: null, error: null })
        try {
          const data = await call('/coverage')
          setState({ loading: false, data, error: null })
        } catch (error) {
          setState({ loading: false, data: null, error: error.message })
        }
      }, [])

      useEffect(() => {
        reload()
      }, [reload])

      const summary = useMemo(() => {
        const repos = state.data?.repos ?? []
        const indexed = repos.filter((row) => row.ok && row.filesIndexed > 0).length
        const text = t('summary')
          .replace('{total}', String(repos.length))
          .replace('{indexed}', String(indexed))
          .replace('{invisible}', String(repos.length - indexed))
        return text
      }, [state.data, t])

      const data = state.data
      const repos = data?.repos ?? []

      return h(
        'div',
        { style: S.page },
        h('p', { style: S.intro }, t('coverageIntro')),
        h(
          'div',
          { style: S.rowHead },
          h('button', { style: S.button, onClick: reload }, t('refresh')),
          state.loading ? h('span', { style: S.meta }, t('coverageLoading')) : h('span', { style: S.meta }, summary),
        ),
        state.error === null ? null : ErrorLine({ text: `${t('errorPrefix')}：${state.error}` }),
        data?.warning ? ErrorLine({ text: data.warning }) : null,

        data !== null && data.present === false
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.strong }, t('coverageEmpty')),
              h('div', { style: S.meta }, t('coverageEmptyHint')),
              h('div', { style: S.code }, `${t('coverageNoFile')}：${data.path}`),
            )
          : data !== null && repos.length === 0
            ? h('div', { style: S.card }, h('div', { style: S.meta }, t('coverageNoRepos')))
            : data === null
              ? null
              : h(
                  'div',
                  { style: S.card },
                  data.generatedAt ? h('div', { style: S.meta }, t('snapshot').replace('{date}', data.generatedAt)) : null,
                  h(
                    'table',
                    { style: S.table },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', { style: S.th }, t('repo')),
                        h('th', { style: S.th }, t('filesIndexed')),
                        h('th', { style: S.th }, t('filesSkipped')),
                        h('th', { style: S.th }, t('status')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      repos.map((row, index) =>
                        h(
                          'tr',
                          { key: `${row.repo}-${index}` },
                          h('td', { style: S.td }, row.repo),
                          h('td', { style: S.td }, String(row.filesIndexed)),
                          h('td', { style: S.td }, String(row.filesSkippedGenerated)),
                          h('td', { style: { ...S.td, color: row.ok ? undefined : 'var(--dsw-alias-state-error-primary)' } }, statusLabel(t, row)),
                        ),
                      ),
                    ),
                  ),
                  h('div', { style: S.code }, `${t('snapshot').replace('{date}', data.generatedAt ?? t('notMeasured'))} · ${data.path}`),
                ),
        h('div', { style: S.code }, t('boundary')),
      )
    }

    /** 浏览器半边入口：注册词典 + 两个设置分区。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'repo-truth: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'repo-truth-sources',
            order: 40,
            label: () => t('nav'),
            locale: NS,
          },
          SourcesPage,
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'repo-truth-coverage',
            order: 41,
            label: () => t('coverageNav'),
            locale: NS,
          },
          CoveragePage,
        ),
      )
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
