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
      coverageBreakdown: '其中：测试 {test} · 第三方 {dir} · 素材 {asset} · 认不得的扩展名 {unsupported} · 超大文件 {large}',
      // —— 输入框右侧的 chip + 右侧配置面板 ——
      dockName: 'repotruth',
      dockCollapse: '收起',
      dockChipTitle: '打开 repotruth 配置：代码源 / 仓库 / 覆盖率。需求直接打在聊天框里，材料会在浏览器里打开。',
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

      // 卡片而不是表格：这块地方只有 520–620px，七列表格会把「同步 / 移除」挤出屏幕——
      // 而那两个按钮正是这一页唯一要动手的地方。
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
                          h('span', { style: { ...S.meta, flex: '1 1 auto', wordBreak: 'break-all' } }, row.name),
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
            : state.repos.map((row) =>
                h(
                  'div',
                  { key: row.name, style: S.card },
                  h(
                    'div',
                    { style: { ...S.rowHead, justifyContent: 'space-between' } },
                    h('span', { style: S.strong }, row.name),
                    h(
                      'span',
                      { style: { ...S.meta, color: row.status === 'failed' ? 'var(--dsw-alias-state-error-primary)' : undefined } },
                      statusLabelOf(t, row),
                    ),
                  ),
                  // 地址去掉协议与 .git 后缀：短一半，卡片里读得下，信息不丢。
                  h(
                    'div',
                    { style: { ...S.code, wordBreak: 'break-all' } },
                    String(row.url ?? '').replace(/^https?:\/\//, '').replace(/\.git$/, ''),
                  ),
                  h(
                    'div',
                    { style: S.meta },
                    [
                      row.headShort ?? '—',
                      `${t('repoIndexed')} ${row.counts === null ? '—' : row.counts.indexed}/${row.counts === null ? '—' : row.counts.total}`,
                      `${t('repoPages')} ${row.counts === null ? '—' : row.pages}`,
                    ].join(' · '),
                  ),
                  row.job === null || row.job === undefined ? null : h('div', { style: S.code }, progressText(t, row.job) ?? ''),
                  h(
                    'div',
                    { style: S.rowHead },
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

        running ? h('div', { style: S.meta }, '任务在子进程里跑，这个面板可以关掉再回来；进度会自己更新。') : null,
        h('div', { style: S.code }, t('boundary')),
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

      // 同「仓库」页签：狭窄面板里表格会被挤出屏幕，改成卡片。
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
                  { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                  data.generatedAt
                    ? h('div', { style: S.meta }, t('snapshotAt').replace('{date}', formatStamp(data.generatedAt)))
                    : null,
                  repos.map((row, index) =>
                    h(
                      'div',
                      { key: `${row.repo}-${index}`, style: S.card },
                      h(
                        'div',
                        { style: { ...S.rowHead, justifyContent: 'space-between' } },
                        h('span', { style: S.strong }, row.repo),
                        h(
                          'span',
                          { style: { ...S.meta, color: row.ok ? undefined : 'var(--dsw-alias-state-error-primary)' } },
                          statusLabel(t, row),
                        ),
                      ),
                      h(
                        'div',
                        { style: S.meta },
                        [
                          row.headShort ?? '—',
                          row.headDate === null ? '—' : formatStamp(row.headDate).slice(0, 10),
                          `${t('repoFiles')} ${row.filesTotal}`,
                          `${t('filesIndexed')} ${row.filesIndexed}`,
                          `${t('filesSkipped')} ${row.filesSkippedGenerated}`,
                          `${t('repoPages')} ${row.pages}`,
                        ].join(' · '),
                      ),
                      h(
                        'div',
                        { style: S.code },
                        t('coverageBreakdown')
                          .replace('{test}', String(row.filesSkippedTest ?? 0))
                          .replace('{dir}', String(row.filesSkippedDir ?? 0))
                          .replace('{asset}', String(row.filesSkippedAsset ?? 0))
                          .replace('{unsupported}', String(row.filesUnsupported ?? 0))
                          .replace('{large}', String(row.filesLarge ?? 0)),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { style: S.code },
                    `${t('snapshotAt').replace('{date}', data.generatedAt === null ? t('notMeasured') : formatStamp(data.generatedAt))} · ${data.path}`,
                  ),
                ),
        h('div', { style: S.code }, t('boundary')),
      )
    }

    // ── 输入框右侧的 chip + 右侧配置面板 ─────────────────────────────────────
    //
    // 需求不在这里写：需求打在 DSH 自己的聊天输入框里，agent 调 repotruth_material
    // 生成三栏材料，然后由宿主在默认浏览器里打开。这个面板只干一件事——配置：
    // 代码源、仓库、覆盖率。和 dsh-purge 的「清洗 / 演练台」是同一个形态。
    //
    // 为什么要有模块级的 store：chip 挂在输入框那一排（conversation.input.right），
    // 面板挂在整页浮层（shell.overlay），两个槽位各渲染一棵树，之间没有 props 通道。
    // 能让它们共用一个开关的，只有模块作用域里的这一份状态。

    const panelState = { open: false, tab: 'sources' }
    const panelListeners = new Set()

    function setPanel(patch) {
      Object.assign(panelState, patch)
      for (const listener of panelListeners) listener({ ...panelState })
    }

    function usePanel() {
      const [snapshot, setSnapshot] = useState({ ...panelState })
      useEffect(() => {
        panelListeners.add(setSnapshot)
        setSnapshot({ ...panelState })
        return () => panelListeners.delete(setSnapshot)
      }, [])
      return snapshot
    }

    /** 槽位不给 t（只有设置分区才给），词典已经在 apply 里注册过，这里直接读同一份。 */
    const tt = (key) => zh[key] ?? key

    function RepotruthChip() {
      const state = usePanel()
      return h(
        'button',
        {
          type: 'button',
          'data-repotruth-chip': '',
          title: tt('dockChipTitle'),
          'aria-pressed': state.open ? 'true' : 'false',
          onClick: () => setPanel({ open: !state.open }),
          style: {
            ...S.button,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            borderRadius: '999px',
            fontSize: '12px',
            lineHeight: '18px',
            border: '0.5px solid ' + (state.open ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)'),
            color: state.open ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)',
            background: state.open ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)' : 'transparent',
          },
        },
        tt('dockName'),
      )
    }

    /**
     * 右侧配置面板：贴在右边缘、整屏高、520–620px，自己的标题栏 + 三个页签。
     *
     * 为什么是浮层而不是原生右栏：这台机器上的客户端没有「右侧栏」槽位
     * （对话页签、整页浮层、输入框左右两侧、左侧标题位、会话顶栏就这些），
     * 整页浮层是唯一能自己定位到右边缘的位置。
     */
    function RepotruthPanel() {
      const state = usePanel()
      const [width, setWidth] = useState(560)

      useEffect(() => {
        const fit = () => setWidth(Math.max(520, Math.min(620, Math.round(window.innerWidth * 0.42))))
        fit()
        window.addEventListener('resize', fit)
        return () => window.removeEventListener('resize', fit)
      }, [])

      // 面板打开时把整页内容让开一条：浮层盖不住别人的布局，
      // 但盖住发送按钮等于把聊天框废掉——需求就是在那个框里打的。
      useEffect(() => {
        if (typeof document === 'undefined' || !state.open) return undefined
        const layer = document.querySelector('[data-shell-overlay]')
        const frame = layer?.parentElement ?? null
        if (frame === null) return undefined
        const previous = frame.style.paddingRight
        const previousTransition = frame.style.transition
        frame.style.transition = `${previousTransition === '' ? '' : `${previousTransition}, `}padding-right 160ms ease`
        frame.style.paddingRight = `${width}px`
        return () => {
          frame.style.paddingRight = previous
          frame.style.transition = previousTransition
        }
      }, [state.open, width])

      if (!state.open) return null

      const tabs = [
        { id: 'sources', label: tt('nav') },
        { id: 'repos', label: tt('reposNav') },
        { id: 'coverage', label: tt('coverageNav') },
      ]

      return h(
        'aside',
        {
          'data-repotruth-panel': '',
          'aria-label': tt('dockName'),
          style: {
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: `${width}px`,
            maxWidth: '96vw',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: 'var(--dsw-alias-bg-base, #fff)',
            borderLeft: '0.5px solid var(--dsw-alias-border-l3)',
            boxShadow: '-16px 0 40px rgba(0, 0, 0, 0.10)',
            zIndex: 30,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '10px 14px',
              borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
            },
          },
          h('span', { style: { ...S.strong, letterSpacing: '0.2px' } }, tt('dockName')),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { type: 'button', style: S.button, onClick: () => setPanel({ open: false }) }, tt('dockCollapse')),
        ),
        h(
          'div',
          { role: 'tablist', style: { display: 'flex', gap: '4px', padding: '8px 12px 0' } },
          tabs.map((tab) =>
            h(
              'button',
              {
                key: tab.id,
                type: 'button',
                role: 'tab',
                'data-repotruth-tab': tab.id,
                'aria-selected': state.tab === tab.id ? 'true' : 'false',
                onClick: () => setPanel({ tab: tab.id }),
                style: {
                  ...S.button,
                  border: 'none',
                  borderBottom: '2px solid ' + (state.tab === tab.id ? 'var(--dsw-alias-state-business-primary)' : 'transparent'),
                  borderRadius: '6px 6px 0 0',
                  color: state.tab === tab.id ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
                  padding: '4px 10px 6px',
                },
              },
              tab.label,
            ),
          ),
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 14px 16px' } },
          state.tab === 'sources' ? h(SourcesPage, { t: tt }) : null,
          state.tab === 'repos' ? h(ReposPage, { t: tt }) : null,
          state.tab === 'coverage' ? h(CoveragePage, { t: tt }) : null,
        ),
      )
    }

    /**
     * 浏览器半边入口：一个面对应一个入口，总共三处。
     *
     * 1. 设置 → 代码源：填地址、类型、令牌（唯一还需要填东西的地方）。
     * 2. 输入框右侧的 chip「repotruth」：开关右侧配置面板。
     * 3. 右侧配置面板（整页浮层）：代码源 / 仓库 / 覆盖率三个页签。
     *
     * 「问一句」「需求走查」原先各占一个入口，现在都不在了：
     * 需求写进 DSH 的聊天框，agent 调 repotruth_material 生成材料，
     * 材料由宿主在默认浏览器里打开——面板里不留任何需求输入框。
     */
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

      // 输入框那一排的开关。label 就是产品名：这一个按钮不再解释自己。
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'repo-truth-chip',
            order: 40,
          },
          RepotruthChip,
        ),
      )

      // 右侧配置面板。没有原生右栏槽位，所以用整页浮层自己定位到右边缘。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'repo-truth-panel',
            order: 40,
          },
          RepotruthPanel,
        ),
      )
    }

    exports.NS = NS
    // 词典也导出：表面测试要断言「界面上出现的字」，不能只断言 key 名。
    exports.zh = zh
    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
