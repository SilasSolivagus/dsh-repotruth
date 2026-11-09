// 浏览器半边：设置里的「代码源」与「覆盖率」两页。
//
// 这个文件是手写的模块图 bundle，不是打包产物——它只需要调用
// window.__ModuleLoader__.load()，由主机把 id 和 require 映射接进来。
// 手写的好处是零构建依赖：改完保存，dsh 的 HMR 会在 500ms 轮询里换掉它。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-repotruth',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    /** 词典命名空间。与宿主无关，只影响文案取用。 */
    const NS = 'repotruth'
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
      filesIndexed: '已索引',
      filesSkipped: '跳过生成',
      status: '状态',
      ok: '已索引',
      failed: '索引失败',
      zeroIndexed: '接进来了，但索引 0 行',
      summary: '接进来 {total} 个 · 看得见 {indexed} 个 · 看不见 {invisible} 个',
      snapshot: '快照日期：{date}',
      snapshotAt: '索引时间：{date}',
      notMeasured: '未测量',
      refresh: '刷新',
      errorPrefix: '出错了',
      retry: '重试',
      boundary: '边界：索引只读代码结构，不执行仓库里的脚本、不装依赖。',
      reposNav: '仓库',
      reposIntro: '这里接入要读的仓。插件把它克隆成本机的一份镜像，之后只做增量拉取；克隆与建索引都在子进程里跑，卡住不会把界面拖死。',
      reposEmpty: '还没有接入任何仓。贴一个仓库地址，或者从已登记的代码源里挑一个。',
      repoAdd: '接入仓库',
      repoPlaceholder: '仓库地址，或 owner/name',
      repoAdding: '正在接入…',
      repoSync: '同步',
      repoSyncing: '同步中…',
      repoRemove: '移除',
      repoRemoveConfirm: '确认移除',
      repoPick: '从代码源选择',
      repoPickLoading: '正在读取可见仓库…',
      repoPickEmpty: '这个代码源上没有可见的仓库。',
      repoPickAlready: '已接入',
      repoHead: 'HEAD',
      repoFiles: '文件总数',
      repoIndexed: '已索引',
      repoSkipped: '跳过生成',
      repoPages: '页面数',
      repoStatus: '状态',
      repoPending: '还没跑过索引',
      repoRunning: '正在同步',
      repoOk: '已索引',
      repoFailed: '同步失败',
      repoIndexZero: '接进来了，但索引 0 行',
      repoInterrupted: '上次同步没跑完（宿主重启或任务被中断），再点一次同步',
      repoMirror: '本机镜像',
      repoIndexPath: '索引文件',
      repoElapsed: '耗时 {seconds} 秒',
      jobPhaseClone: '克隆 / 拉取',
      jobPhaseIndex: '建索引',
      askNav: '问一句',
      askIntro: '用一句中文写你要找的功能或页面。插件只查本机索引：哪些页面看起来相关、这块有多大、哪些地方引用它、上次改动是哪天。不联网，查不到就说查不到。',
      askPlaceholder: '例如：用户登录页面是怎么做的？',
      askSubmit: '提问',
      askAsking: '正在查索引…',
      askNoRepo: '还没有仓跑过索引。先在上面接入一个仓，等它跑完再来问。',
      askScope: '查哪些仓',
      askAll: '全部已索引的仓',
      askFound: '找到 {count} 处候选',
      askNotFound: '没找到',
      askOpen: '打开完整材料',
      askTerms: '检索词',
      askLimits: '这份材料读到哪、没读到哪',
      askDevRef: '研发参考在完整材料末尾（默认折叠）',
      coverageBreakdown: '其中：测试 {test} · 第三方 {dir} · 素材 {asset} · 认不得的扩展名 {unsupported} · 超大文件 {large}',
      coverageTotals: '接进来 {total} 个 · 看得见 {indexed} 个 · 看不见 {invisible} 个',
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
        whiteSpace: 'nowrap',
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
        whiteSpace: 'nowrap',
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
        whiteSpace: 'nowrap',
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

    // ── 仓库页：接入 / 同步 / 移除，进度靠轮询 ────────────────────────────────
    //
    // 为什么轮询而不是 websocket：任务状态就是「一行字符串 + 一个状态」，
    // 1.2 秒问一次足够，且断了就断了，不会留一条永不重连的长连接。
    // 轮询只在「有仓正在跑」时开，跑完立刻停——空闲时不产生任何请求。

    function statusLabelOf(t, row) {
      if (row.status === 'running') return t('repoRunning')
      if (row.status === 'failed') return `${t('repoFailed')}：${row.error ?? '原因不明'}`
      if (row.status === 'pending') return t('repoPending')
      if (row.status === 'interrupted') return t('repoInterrupted')
      if ((row.counts?.indexed ?? 0) === 0) return t('repoIndexZero')
      return t('repoOk')
    }

    function progressText(t, job) {
      if (job === null || job === undefined) return null
      if (job.status === 'failed') return job.error
      const phase = job.phase === 'clone' ? t('jobPhaseClone') : job.phase === 'index' ? t('jobPhaseIndex') : ''
      return [phase, job.message].filter((part) => part !== '' && part !== undefined).join(' · ')
    }

    function ReposPage({ t }) {
      const [state, setState] = useState({ loading: true, repos: [], hosts: [], error: null, warning: null })
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const [confirming, setConfirming] = useState(null)
      const [source, setSource] = useState(null)

      const reload = useCallback(async () => {
        try {
          const [repos, config] = await Promise.all([call('/repos'), call('/config')])
          setState({
            loading: false,
            repos: repos.repos ?? [],
            hosts: config.hosts ?? [],
            error: null,
            warning: repos.warning ?? null,
          })
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, error: error.message }))
        }
      }, [])

      useEffect(() => {
        reload()
      }, [reload])

      // 只在有任务在跑时轮询；跑完下一次 reload 就会让这个定时器不再续。
      useEffect(() => {
        if (!state.repos.some((row) => row.status === 'running')) return undefined
        const timer = setTimeout(() => reload(), 1200)
        return () => clearTimeout(timer)
      }, [state.repos, reload])

      const addRepo = useCallback(async () => {
        const value = (draft?.url ?? '').trim()
        if (value === '') return setNote({ ok: false, text: '地址不能为空' })
        setBusy(true)
        setNote(null)
        try {
          const data = await call('/repos', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: value }),
          })
          setDraft(null)
          setNote({ ok: true, text: data.warning === null ? '已接入，正在克隆并建索引…' : `已接入，但没启动同步：${data.warning}` })
          await reload()
        } catch (error) {
          setNote({ ok: false, text: error.message })
        } finally {
          setBusy(false)
        }
      }, [draft, reload])

      const sync = useCallback(async (name) => {
        setBusy(true)
        setNote(null)
        try {
          await call('/repos/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          })
          await reload()
        } catch (error) {
          setNote({ ok: false, text: error.message })
        } finally {
          setBusy(false)
        }
      }, [reload])

      const remove = useCallback(async (name) => {
        setBusy(true)
        try {
          await call('/repos/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          })
          setConfirming(null)
          setNote({ ok: true, text: '已移除；本机镜像与索引文件一并删掉了' })
          await reload()
        } catch (error) {
          setNote({ ok: false, text: error.message })
        } finally {
          setBusy(false)
        }
      }, [reload])

      const pickFromSource = useCallback(async (hostName) => {
        setSource({ loading: true, host: hostName, repos: [], message: '' })
        try {
          const data = await call(`/source-repos?name=${encodeURIComponent(hostName)}`)
          const registered = new Set(data.registered ?? [])
          setSource({
            loading: false,
            host: hostName,
            repos: (data.repos ?? []).map((row) => ({ ...row, already: registered.has(row.url) })),
            message: data.message ?? '',
          })
        } catch (error) {
          setSource({ loading: false, host: hostName, repos: [], message: error.message })
        }
      }, [])

      const addFromSource = useCallback(async (url) => {
        setBusy(true)
        try {
          await call('/repos', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
          })
          setNote({ ok: true, text: '已接入，正在克隆并建索引…' })
          setSource(null)
          await reload()
        } catch (error) {
          setNote({ ok: false, text: error.message })
        } finally {
          setBusy(false)
        }
      }, [reload])

      const running = state.repos.some((row) => row.status === 'running')

      return h(
        'div',
        { style: S.page },
        h('p', { style: S.intro }, t('reposIntro')),
        state.error === null ? null : ErrorLine({ text: `${t('errorPrefix')}：${state.error}` }),
        state.warning === null ? null : ErrorLine({ text: state.warning }),
        note === null ? null : h('div', { style: note.ok ? S.ok : S.bad }, note.text),

        draft === null
          ? h(
              'div',
              { style: S.rowHead },
              h('button', { style: S.primary, onClick: () => { setDraft({ url: '' }); setNote(null) } }, t('repoAdd')),
              state.hosts.map((host) =>
                h(
                  'button',
                  { key: host.name, style: S.button, disabled: busy, onClick: () => pickFromSource(host.name) },
                  `${t('repoPick')}：${host.name}`,
                ),
              ),
            )
          : h(
              'div',
              { style: S.card },
              h('div', { style: S.strong }, t('repoAdd')),
              h('input', {
                style: S.input,
                value: draft.url,
                placeholder: t('repoPlaceholder'),
                onChange: (event) => setDraft({ url: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') addRepo()
                },
              }),
              h(
                'div',
                { style: S.rowHead },
                h('button', { style: S.primary, disabled: busy, onClick: addRepo }, busy ? t('repoAdding') : t('repoAdd')),
                h('button', { style: S.button, onClick: () => { setDraft(null); setNote(null) } }, t('cancel')),
              ),
            ),

        source === null
          ? null
          : h(
              'div',
              { style: S.card },
              h('div', { style: S.strong }, `${t('repoPick')}：${source.host}`),
              source.loading
                ? h('div', { style: S.meta }, t('repoPickLoading'))
                : source.repos.length === 0
                  ? h('div', { style: S.meta }, source.message === '' ? t('repoPickEmpty') : source.message)
                  : h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                      source.repos.map((row) =>
                        h(
                          'div',
                          { key: row.url, style: S.rowHead },
                          h('span', { style: S.meta }, row.name),
                          row.already
                            ? h('span', { style: S.meta }, t('repoPickAlready'))
                            : h('button', { style: S.button, disabled: busy, onClick: () => addFromSource(row.url) }, t('repoAdd')),
                        ),
                      ),
                    ),
              h('div', { style: S.rowHead }, h('button', { style: S.button, onClick: () => setSource(null) }, t('cancel'))),
            ),

        state.loading
          ? h('div', { style: S.meta }, '正在读取已接入的仓…')
          : state.repos.length === 0
            ? h('div', { style: S.card }, h('div', { style: S.meta }, t('reposEmpty')))
            : h(
                'div',
                { style: { ...S.card, overflowX: 'auto' } },
                h(
                  'table',
                  { style: S.table },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', { style: { ...S.th, whiteSpace: 'nowrap' } }, '仓名'),
                      h('th', { style: { ...S.th, whiteSpace: 'nowrap' } }, t('repoHead')),
                      h('th', { style: { ...S.th, whiteSpace: 'nowrap' } }, t('repoFiles')),
                      h('th', { style: { ...S.th, whiteSpace: 'nowrap' } }, t('repoIndexed')),
                      h('th', { style: { ...S.th, whiteSpace: 'nowrap' } }, t('repoPages')),
                      h('th', { style: { ...S.th, whiteSpace: 'nowrap' } }, t('repoStatus')),
                      h('th', { style: S.th }, ''),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    state.repos.map((row) =>
                      h(
                        'tr',
                        { key: row.name },
                        h(
                          'td',
                          { style: S.td },
                          h('div', { style: { whiteSpace: 'nowrap' } }, row.name),
                          // 地址必须能断行：一段不可断的长 URL 会把整张表挤出对话框。
                          // 地址去掉协议与 .git 后缀：短一半，表里读得下，信息不丢。
                          h(
                            'div',
                            { style: { ...S.code, wordBreak: 'break-all' } },
                            String(row.url ?? '').replace(/^https?:\/\//, '').replace(/\.git$/, ''),
                          ),
                        ),
                        h('td', { style: S.td }, row.headShort ?? '—'),
                        h('td', { style: S.td }, row.counts === null ? '—' : String(row.counts.total)),
                        h('td', { style: S.td }, row.counts === null ? '—' : String(row.counts.indexed)),
                        h('td', { style: S.td }, row.counts === null ? '—' : String(row.pages)),
                        h(
                          'td',
                          { style: { ...S.td, whiteSpace: 'nowrap', color: row.status === 'failed' ? 'var(--dsw-alias-state-error-primary)' : undefined } },
                          statusLabelOf(t, row),
                          row.job === null || row.job === undefined
                            ? null
                            : h('div', { style: S.code }, progressText(t, row.job) ?? ''),
                        ),
                        h(
                          'td',
                          { style: { ...S.td, whiteSpace: 'nowrap', minWidth: '92px' } },
                          h(
                            'div',
                            { style: { ...S.rowHead, flexWrap: 'nowrap', gap: '6px' } },
                            h(
                              'button',
                              { style: S.button, disabled: busy || row.status === 'running', onClick: () => sync(row.name) },
                              row.status === 'running' ? t('repoSyncing') : t('repoSync'),
                            ),
                            confirming === row.name
                              ? h(
                                  'span',
                                  { style: S.rowHead },
                                  h('button', { style: S.danger, disabled: busy, onClick: () => remove(row.name) }, t('repoRemoveConfirm')),
                                  h('button', { style: S.button, onClick: () => setConfirming(null) }, t('cancel')),
                                )
                              : h('button', { style: S.danger, onClick: () => setConfirming(row.name) }, t('repoRemove')),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                h(
                  'div',
                  { style: S.code },
                  state.repos
                    .map((row) => `${row.name} · ${t('repoMirror')}：${row.mirrorPath} · ${t('repoIndexPath')}：${row.indexPath}`)
                    .join('\n'),
                ),
                running ? h('div', { style: S.meta }, '任务在子进程里跑，这个页面可以关掉再回来；进度会自己更新。') : null,
              ),
        h('div', { style: S.code }, t('boundary')),
      )
    }

    // ── 问一句：只查本机索引 ────────────────────────────────────────────────
    //
    // 界面上的每一句话都来自后端返回的 answer 对象（正文段落 + 限界框），
    // 前端不拼任何「我觉得」的话：没有命中就照实显示「没找到」，
    // 而不是拿一个分数最高的文件顶上（那是最容易骗人的一种设计）。

    function AskPage({ t }) {
      const [repos, setRepos] = useState([])
      const [text, setText] = useState('')
      const [repo, setRepo] = useState('')
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        call('/repos')
          .then((data) => setRepos(data.repos ?? []))
          .catch(() => setRepos([]))
      }, [])

      const indexed = repos.filter((row) => row.status === 'ok' || row.status === 'failed' || row.status === 'interrupted')

      const ask = useCallback(async () => {
        const question = text.trim()
        if (question === '') return setError('先写一句要问的话')
        setBusy(true)
        setError(null)
        setResult(null)
        try {
          const data = await call('/ask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question, repo }),
          })
          setResult(data)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }, [text, repo])

      return h(
        'div',
        { style: S.page },
        h('p', { style: S.intro }, t('askIntro')),
        indexed.length === 0
          ? h('div', { style: S.card }, h('div', { style: S.meta }, t('askNoRepo')))
          : h(
              'div',
              { style: S.card },
              h(
                'div',
                { style: S.field },
                h('span', { style: S.label }, t('askScope')),
                h(
                  'select',
                  { style: S.input, value: repo, onChange: (event) => setRepo(event.target.value) },
                  h('option', { value: '' }, t('askAll')),
                  repos.map((row) => h('option', { key: row.name, value: row.name }, row.name)),
                ),
              ),
              h('textarea', {
                style: { ...S.input, minHeight: '64px', resize: 'vertical', fontFamily: 'inherit' },
                value: text,
                placeholder: t('askPlaceholder'),
                onChange: (event) => setText(event.target.value),
              }),
              h(
                'div',
                { style: S.rowHead },
                h('button', { style: S.primary, disabled: busy, onClick: ask }, busy ? t('askAsking') : t('askSubmit')),
                result === null
                  ? null
                  : h(
                      'a',
                      {
                        style: { ...S.button, textDecoration: 'none', display: 'inline-block' },
                        href: result.url,
                        target: '_blank',
                        rel: 'noreferrer',
                      },
                      t('askOpen'),
                    ),
              ),
            ),
        error === null ? null : ErrorLine({ text: `${t('errorPrefix')}：${error}` }),

        result === null
          ? null
          : h(
              'div',
              { style: S.card },
              h(
                'div',
                { style: S.rowHead },
                h('span', { style: S.strong }, result.found ? t('askFound').replace('{count}', String(result.matches?.length ?? 0)) : t('askNotFound')),
                h(
                  'span',
                  { style: S.meta },
                  `${t('askTerms')}：${(result.terms ?? []).slice(0, 10).join('、') || '（无）'}`,
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                (result.body ?? []).map((paragraph, index) =>
                  h('p', { key: `p${index}`, style: { margin: 0, lineHeight: '22px' } }, paragraph),
                ),
              ),
              h('div', { style: S.label }, t('askLimits')),
              h(
                'ul',
                { style: { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                (result.limits ?? []).map((item, index) =>
                  h('li', { key: `l${index}`, style: { fontSize: '12px', lineHeight: '18px' } }, h('b', null, `${item.title}：`), item.text),
                ),
              ),
              h('div', { style: S.code }, t('askDevRef')),
            ),
        h('div', { style: S.code }, '边界：只读本机索引，不发请求、不写仓库、不改任何代码。'),
      )
    }

    /** ISO 时间戳 → 本地「2026-11-09 16:49」。读的人不该在心算时区上花时间。 */
    function formatStamp(iso) {
      if (typeof iso !== 'string' || iso.length < 16) return String(iso ?? '')
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
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
                  data.generatedAt
                    ? h('div', { style: S.meta }, t('snapshotAt').replace('{date}', formatStamp(data.generatedAt)))
                    : null,
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
                        h('th', { style: S.th }, t('repoHead')),
                        h('th', { style: S.th }, t('repoFiles')),
                        h('th', { style: S.th }, t('filesIndexed')),
                        h('th', { style: S.th }, t('filesSkipped')),
                        h('th', { style: S.th }, t('repoPages')),
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
                          h('td', { style: S.td }, row.repo, h('div', { style: S.code }, row.headDate === null ? '' : formatStamp(row.headDate).slice(0, 10))),
                          h('td', { style: S.td }, row.headShort ?? '—'),
                          h('td', { style: S.td }, String(row.filesTotal)),
                          h('td', { style: S.td }, String(row.filesIndexed)),
                          h('td', { style: S.td }, String(row.filesSkippedGenerated)),
                          h('td', { style: S.td }, String(row.pages)),
                          h('td', { style: { ...S.td, color: row.ok ? undefined : 'var(--dsw-alias-state-error-primary)' } }, statusLabel(t, row)),
                        ),
                      ),
                    ),
                  ),
                  // 分项：一行汇总里塞不下的「没读到的部分」，单独摆出来。
                  // 少了这一行，读者会以为「没跳过生成代码」的仓就什么都读到了。
                  h(
                    'div',
                    { style: S.code },
                    repos
                      .map((row) =>
                        `${row.repo} · ` +
                        t('coverageBreakdown')
                          .replace('{test}', String(row.filesSkippedTest ?? 0))
                          .replace('{dir}', String(row.filesSkippedDir ?? 0))
                          .replace('{asset}', String(row.filesSkippedAsset ?? 0))
                          .replace('{unsupported}', String(row.filesUnsupported ?? 0))
                          .replace('{large}', String(row.filesLarge ?? 0)),
                      )
                      .join('\n'),
                  ),
                  h('div', { style: S.code }, `${t('snapshotAt').replace('{date}', data.generatedAt === null ? t('notMeasured') : formatStamp(data.generatedAt))} · ${data.path}`),
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
            id: 'repo-truth-repos',
            order: 41,
            label: () => t('reposNav'),
            locale: NS,
          },
          ReposPage,
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'repo-truth-ask',
            order: 42,
            label: () => t('askNav'),
            locale: NS,
          },
          AskPage,
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'repo-truth-coverage',
            order: 43,
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
