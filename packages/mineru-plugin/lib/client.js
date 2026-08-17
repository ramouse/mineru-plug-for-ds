// MinerU document parsing plugin — Client half (permanent install).
// Real browser bundle: fetch / FileReader / clipboard / window listeners are
// all available.
//  - Global drag overlay: drop a file ANYWHERE on the page to parse it
//    (fixes drop priority/z-index issues; feels integrated into the chat).
//  - Sidebar entry styled exactly like the Settings trigger row.
//  - Panel in shell.overlay + composer input.left entry + "send to agent".
window.__ModuleLoader__.load({
  id: 'mineru-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')

    const DOC_ICON = '' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
      '<path d="M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M9.5 1v4.5H14" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M5.5 8.5h5M5.5 11h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

    const CSS = '' +
      // Sidebar trigger — mirrors the shipped Settings trigger row
      // (packages/client/ui-settings-general/src/client/SettingsRoot.module.css)
      '.mineru-trigger{flex:none;display:flex;align-items:center;gap:8px;width:calc(100% + 4px);height:42px;margin:4px -2px;padding:0 10px 0 8px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px}' +
      '.mineru-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.mineru-trigger.mineru-rail{width:36px;height:36px;margin:8px 0 10px;justify-content:center;gap:0;padding:0;border-radius:50%}' +
      '.mineru-trigger-icon{flex:none;display:inline-flex;align-items:center;justify-content:center}' +
      '.mineru-trigger-label{overflow:hidden;white-space:nowrap}' +
      // Panel — theme tokens only, follows light/dark automatically
      '.mineru-panel-wrap{position:fixed;right:16px;bottom:16px;z-index:1000;pointer-events:auto}' +
      '.mineru-panel{width:380px;max-height:72vh;overflow-y:auto;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:12px;padding:14px;font-size:13px;line-height:1.5;box-shadow:var(--dsw-shadow-lv3)}' +
      '.mineru-panel *{box-sizing:border-box}' +
      '.mineru-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;margin-bottom:8px}' +
      '.mineru-badge{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);font-weight:500}' +
      '.mineru-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:4px}' +
      '.mineru-input{flex:1;background:transparent;border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:6px;color:var(--dsw-alias-label-primary);padding:6px 8px;font-size:12px}' +
      '.mineru-btn{background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:6px;color:var(--dsw-alias-label-primary);padding:5px 10px;font-size:12px;cursor:pointer}' +
      '.mineru-btn:hover{filter:brightness(1.15)}' +
      '.mineru-btn:disabled{opacity:.45;cursor:not-allowed}' +
      '.mineru-mode-btn.active{border-color:var(--dsw-alias-brand-primary)!important;color:var(--dsw-alias-brand-primary)!important}' +
      '.mineru-row{display:flex;gap:6px;align-items:center;margin-bottom:6px}' +
      '.mineru-job{border-top:1px solid var(--dsw-alias-interactive-bg-hover);padding:6px 0;font-size:12px}' +
      '.mineru-drop{border:1px dashed var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:10px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;cursor:pointer;margin-bottom:8px}' +
      '.mineru-drop.drag{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
      // Global drag overlay — top of everything; the drop target that cannot
      // be shadowed by any other surface.
      '.mineru-dragmask{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,0.45));display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;pointer-events:auto}' +
      '.mineru-dragcard{padding:20px 32px;border:2px dashed var(--dsw-alias-brand-primary);border-radius:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600}'

    const CSS_TAG_ID = 'mineru-plugin/panel.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const el = react.createElement
    const OK = 'var(--dsw-alias-state-success-primary)'
    const ERR = 'var(--dsw-alias-state-error-primary)'
    const RUN = 'var(--dsw-alias-brand-primary)'

    function stateColor(s) {
      if (s === 'done') return OK
      if (s === 'failed') return ERR
      if (s === 'cancelled') return 'var(--dsw-alias-label-tertiary)'
      return RUN
    }

    const bus = {
      state: {
        open: false,
        dragging: false,
        hasKey: false,
        mode: 'quick',
        apiMode: 'auto',
        runningJobId: '',
        queued: 0,
        jobs: [],
        msg: '',
      },
      listeners: new Set(),
      set(patch) {
        Object.assign(this.state, patch)
        const snap = this.state
        this.listeners.forEach((fn) => fn(snap))
      },
      subscribe(fn) {
        this.listeners.add(fn)
        fn(this.state)
        return () => { this.listeners.delete(fn) }
      },
    }

    function useBus() {
      const [, force] = react.useState(0)
      react.useEffect(() => bus.subscribe(() => force((n) => n + 1)), [])
      return bus.state
    }

    async function refresh() {
      try {
        const res = await fetch('/mineru/state')
        if (res.ok) {
          const st = await res.json()
          bus.set({
            hasKey: !!st.hasKey,
            mode: String(st.mode || 'quick'),
            runningJobId: String(st.runningJobId || ''),
            queued: Number(st.queued) || 0,
            jobs: Array.isArray(st.jobs) ? st.jobs : [],
          })
        }
      } catch (e) {}
    }

    async function postJson(path, payload) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {}),
        })
        let data = null
        try { data = await res.json() } catch (e) {}
        return { ok: res.ok, status: res.status, data: data || {} }
      } catch (e) {
        return { ok: false, status: 0, data: { error: String((e && e.message) || e) } }
      }
    }

    async function uploadFile(file) {
      if (!file) return
      bus.set({ msg: '上传中：' + file.name, open: true })
      try {
        const res = await fetch('/mineru/upload?name=' + encodeURIComponent(file.name) + '&api=' + encodeURIComponent(bus.state.apiMode), { method: 'POST', body: file })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.ok) bus.set({ msg: '已入队解析：' + file.name })
        else bus.set({ msg: '上传失败：' + String(data.error || res.status) })
      } catch (e) {
        bus.set({ msg: '上传失败：' + String((e && e.message) || e) })
      }
      refresh()
    }

    function ModeBadge() {
      const state = useBus()
      let text
      if (!state.hasKey) text = '\u26A1 \u5FEB\u901F\u6A21\u5F0F'
      else if (state.apiMode === 'agent') text = '\u26A1 \u5FEB\u901F\u6A21\u5F0F'
      else if (state.apiMode === 'standard') text = '\u{1F3AF} \u7CBE\u51C6\u6A21\u5F0F'
      else text = '\u{1F3AF} \u81EA\u52A8\u8DEF\u7531'
      return el('span', { className: 'mineru-badge' }, text)
    }

    function ModeSelect() {
      const state = useBus()
      const modes = [
        { id: 'auto', label: '\u81EA\u52A8\u8DEF\u7531', title: '\u5C0F\u6587\u4EF6\u5FEB\u901F\uFF0C\u5927\u6587\u4EF6/\u5BFC\u51FA\u81EA\u52A8\u7CBE\u51C6' },
        { id: 'agent', label: '\u5FEB\u901F\u6A21\u5F0F', title: '\u5F3A\u5236 Agent API\uFF08\u514D\u8D39\uFF0C\u226410MB/\u226420\u9875\uFF09' },
        { id: 'standard', label: '\u7CBE\u51C6\u6A21\u5F0F', title: '\u5F3A\u5236 Standard API\uFF08\u2264200MB/\u2264200\u9875\uFF0C\u542B\u56FE\u7247\uFF0C\u9700 API Key\uFF09' },
      ]
      return el('div', { className: 'mineru-row' },
        el('span', { className: 'mineru-hint', style: { marginTop: 0, width: '56px', flex: 'none' } }, '\u6A21\u5F0F'),
        modes.map((m) => {
          const disabled = m.id === 'standard' && !state.hasKey
          const active = state.apiMode === m.id
          return el('button', {
            key: m.id,
            onClick: () => { if (!disabled) bus.set({ apiMode: m.id }) },
            className: 'mineru-btn mineru-mode-btn' + (active ? ' active' : ''),
            title: disabled ? '\u9700\u5148\u8BBE\u7F6E API Key' : m.title,
            disabled: disabled || undefined,
          }, m.label)
        }),
      )
    }

    function KeyForm() {
      const state = useBus()
      const [value, setValue] = react.useState('')
      const [msg, setMsg] = react.useState('')
      async function save() {
        const r = await postJson('/mineru/set-key', { token: value })
        if (r.ok) { setMsg('\u2713 ' + String(r.data.detail || 'Token 有效')); setValue('') }
        else setMsg('\u2717 ' + String(r.data.error || '校验失败'))
        refresh()
      }
      async function clear() {
        await postJson('/mineru/clear-key', {})
        setMsg(''); setValue('')
        refresh()
      }
      return el('div', null,
        el('div', { className: 'mineru-row' },
          el('input', { type: 'password', placeholder: 'API Key（可选，解锁精准模式）', value: value, onChange: (e) => setValue(e.target.value), className: 'mineru-input' }),
          el('button', { onClick: save, className: 'mineru-btn' }, '保存'),
          state.hasKey ? el('button', { onClick: clear, className: 'mineru-btn' }, '清除') : null,
        ),
        msg ? el('div', { style: { color: msg.charAt(0) === '\u2713' ? OK : ERR, fontSize: '11px' } }, msg) : null,
        el('div', { className: 'mineru-hint' }, state.hasKey ? '当前：自动路由（小文件走免费快速模式，大文件/导出格式自动升级精准模式；精准模式含图片提取）' : '当前：快速模式（免费免登录，\u226410MB / \u226420 页；仅提取文本——图片需设置 API Key 走精准模式）'),
      )
    }

    function UploadZone() {
      const [drag, setDrag] = react.useState(false)
      const inputRef = react.useRef(null)
      function onDrop(e) {
        e.preventDefault()
        setDrag(false)
        const files = e.dataTransfer && e.dataTransfer.files
        if (files && files.length) uploadFile(files[0])
      }
      return el('div', null,
        el('div', {
          className: 'mineru-drop' + (drag ? ' drag' : ''),
          onClick: () => { if (inputRef.current) inputRef.current.click() },
          onDragOver: (e) => { e.preventDefault(); setDrag(true) },
          onDragLeave: () => setDrag(false),
          onDrop: onDrop,
        }, '\uD83D\uDCC2 拖入文件，或点击选择（PDF / 图片 / Office）——页面任意位置拖入也有效'),
        el('input', { ref: inputRef, type: 'file', style: { display: 'none' }, accept: '.pdf,.png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.html', onChange: (e) => { if (e.target.files && e.target.files.length) uploadFile(e.target.files[0]); e.target.value = '' } }),
      )
    }

    function ConvertForm() {
      const state = useBus()
      const [value, setValue] = react.useState('')
      const [ocr, setOcr] = react.useState(false)
      const [pageRange, setPageRange] = react.useState('')
      async function convert() {
        const input = String(value || '').trim()
        if (!input) { bus.set({ msg: '请输入文件路径或 URL' }); return }
        bus.set({ msg: '' })
        const r = await postJson('/mineru/convert', { input: input, options: { api: state.apiMode, ocr: ocr, page_range: pageRange, language: 'ch' } })
        if (r.ok) setValue('')
        else bus.set({ msg: String(r.data.error || '提交失败') })
        refresh()
      }
      return el('div', { style: { marginBottom: '10px' } },
        el('div', { className: 'mineru-row' },
          el('input', { placeholder: '工作区文件路径或 http(s) URL', value: value, onChange: (e) => setValue(e.target.value), className: 'mineru-input' }),
          el('button', { onClick: convert, className: 'mineru-btn' }, '解析'),
        ),
        el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, rgba(255,255,255,0.7))' } },
          el('label', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, el('input', { type: 'checkbox', checked: ocr, onChange: (e) => setOcr(e.target.checked) }), 'OCR 扫描件'),
          el('input', { placeholder: '页码 如 1-10', value: pageRange, onChange: (e) => setPageRange(e.target.value), className: 'mineru-input', style: { width: '110px' } }),
        ),
        state.msg ? el('div', { style: { color: ERR, fontSize: '11px', marginTop: '4px' } }, state.msg) : null,
      )
    }

    function JobRow(props) {
      const job = props.job
      async function cancel() {
        await postJson('/mineru/cancel', { jobId: job.jobId })
        refresh()
      }
      async function removeJob() {
        const r = await postJson('/mineru/remove-job', { jobId: job.jobId })
        if (!r.ok) bus.set({ msg: '\u5220\u9664\u5931\u8D25\uFF1A' + String(r.data.error || r.status) })
        refresh()
      }
      async function copyPrompt() {
        const prompt = '请阅读并分析已解析的文档 Markdown：' + (job.markdownPath || '') + '\n（用 read 工具分页阅读后回答我的问题）'
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(prompt)
          bus.set({ msg: 'Prompt 已复制到剪贴板' })
        } catch (e) {
          bus.set({ msg: '复制失败：' + String((e && e.message) || e) })
        }
      }
      const short = String(job.source || '').split(/[\\/]/).pop()
      const finished = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled'
      return el('div', { className: 'mineru-job' },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          el('span', { style: { color: stateColor(job.state), fontWeight: 600 } }, job.state === 'done' ? '\u2713' : job.state === 'failed' ? '\u2717' : '\u25CB'),
          el('span', null, short),
          el('span', { className: 'mineru-hint' }, job.elapsedSec + 's'),
          el('span', { style: { flex: 1 } }),
          (job.state === 'running' || job.state === 'queued') ? el('button', { onClick: cancel, className: 'mineru-btn', style: { padding: '2px 8px' } }, '\u53D6\u6D88') : null,
          finished ? el('button', { onClick: removeJob, className: 'mineru-btn', style: { padding: '2px 8px' }, title: '\u5220\u9664\u8BE5\u8BB0\u5F55' }, '\u00D7') : null,
        ),
        job.phase && job.state === 'running' ? el('div', { className: 'mineru-hint' }, job.phase) : null,
        job.error ? el('div', { style: { color: ERR } }, job.error) : null,
        job.markdownPath ? el('div', null,
          el('span', { style: { color: OK, wordBreak: 'break-all' } }, job.markdownPath),
          el('button', { onClick: copyPrompt, className: 'mineru-btn', style: { marginLeft: '6px', padding: '2px 8px' } }, '复制 Prompt'),
        ) : null,
      )
    }

    function JobsList() {
      const state = useBus()
      if (!state.jobs || state.jobs.length === 0) return el('div', { className: 'mineru-hint' }, '暂无解析任务。拖入文件，或输入路径/URL。')
      return el('div', null, state.jobs.map((job) => el(JobRow, { key: job.jobId, job: job })))
    }

    function CacheRow() {
      async function clear(which, label) {
        const sure = typeof window !== 'undefined' && window.confirm ? window.confirm(label) : true
        if (!sure) return
        const r = await postJson('/mineru/clear-cache', { which: which })
        if (r.ok) bus.set({ msg: '\u5DF2\u6E05\u9664 ' + r.data.deletedFiles + ' \u4E2A\u6587\u4EF6\uFF08' + String(r.data.cleaned || []).replace(/,/g, ' / ') + '\uFF09' })
        else bus.set({ msg: '\u6E05\u9664\u5931\u8D25\uFF1A' + String(r.data.error || r.status) })
        refresh()
      }
      function openFolder(which) {
        fetch('/mineru/open-folder?which=' + which, { method: 'POST' }).catch(() => {})
      }
      return el('div', { style: { marginTop: '6px' } },
        el('div', { className: 'mineru-row' },
          el('span', { className: 'mineru-hint', style: { marginTop: 0, width: '56px', flex: 'none' } }, '\u6E05\u9664'),
          el('button', { onClick: () => clear('inputs', '\u6E05\u9664\u62D6\u62FD\u4E0A\u4F20\u7684\u6E90\u6587\u4EF6\uFF08.mineru\\inputs\uFF09\uFF1F'), className: 'mineru-btn' }, '\u4E0A\u4F20\u6E90\u6587\u4EF6'),
          el('button', { onClick: () => clear('out', '\u6E05\u9664\u5168\u90E8\u89E3\u6790\u4EA7\u7269\uFF08.mineru\\out\uFF09\uFF1F'), className: 'mineru-btn' }, '\u89E3\u6790\u4EA7\u7269'),
        ),
        el('div', { className: 'mineru-row', style: { marginBottom: 0 } },
          el('span', { className: 'mineru-hint', style: { marginTop: 0, width: '56px', flex: 'none' } }, '\u67E5\u770B'),
          el('button', { onClick: () => openFolder('inputs'), className: 'mineru-btn' }, '\u4E0A\u4F20\u76EE\u5F55'),
          el('button', { onClick: () => openFolder('out'), className: 'mineru-btn' }, '\u4EA7\u7269\u76EE\u5F55'),
        ),
      )
    }

    function Panel() {
      const state = useBus()
      if (!state.open) return null
      return el('div', { className: 'mineru-panel-wrap' },
        el('div', { className: 'mineru-panel' },
          el('div', { className: 'mineru-head' },
            el('span', null, 'MinerU \u6587\u6863\u89E3\u6790'),
            el(ModeBadge, null),
            el('span', { style: { flex: 1 } }),
            el('button', { onClick: () => bus.set({ open: false }), className: 'mineru-btn' }, '\u00D7'),
          ),
          el(KeyForm, null),
          el(ModeSelect, null),
          el(UploadZone, null),
          el(ConvertForm, null),
          el(JobsList, null),
          el(CacheRow, null),
          el('div', { className: 'mineru-hint' }, '\u9690\u79C1\u63D0\u793A\uFF1A\u89E3\u6790\u5728 MinerU \u4E91\u7AEF\u8FDB\u884C\uFF0C\u6587\u4EF6\u4F1A\u4E0A\u4F20\u5E76\u79BB\u5F00\u672C\u673A\u3002'),
        ),
      )
    }

    function DragOverlay() {
      const state = useBus()
      if (!state.dragging) return null
      return el('div', { className: 'mineru-dragmask' },
        el('div', { className: 'mineru-dragcard' }, '\uD83D\uDCC4 \u677E\u5F00\u6587\u4EF6\uFF0C\u7ACB\u5373\u89E3\u6790'),
        el('div', { style: { color: 'rgba(255,255,255,0.75)', fontSize: '12px' } }, '\u4E0A\u4F20\u540E\u81EA\u52A8\u5165\u961F\u5E76\u6253\u5F00\u9762\u677F'),
      )
    }

    // Settings-style sidebar entry (42px row; 36px circle in rail mode).
    function SidebarEntry(props) {
      const wide = !!(props && props.wide)
      return el('button', {
        type: 'button',
        className: 'mineru-trigger' + (wide ? '' : ' mineru-rail'),
        onClick: () => bus.set({ open: true }),
        title: 'MinerU \u6587\u6863\u89E3\u6790',
        'aria-haspopup': 'dialog',
      },
        el('span', { className: 'mineru-trigger-icon', dangerouslySetInnerHTML: { __html: DOC_ICON } }),
        wide ? el('span', { className: 'mineru-trigger-label' }, '\u6587\u6863\u89E3\u6790') : null,
      )
    }

    // Composer entry: open panel + inject the prompt for the latest done job.
    function InputLeftEntry(props) {
      const state = useBus()
      const jobs = state.jobs || []
      const doneJob = jobs.filter((j) => j.state === 'done').pop()
      const ia = props && props.inputActions ? props.inputActions : null
      function send() {
        if (!ia || !ia.setDraft || !doneJob) return
        const prompt = '\u8BF7\u9605\u8BFB\u5E76\u5206\u6790\u5DF2\u89E3\u6790\u7684\u6587\u6863 Markdown\uFF1A' + (doneJob.markdownPath || '') + '\n\uFF08\u7528 read \u5DE5\u5177\u5206\u9875\u9605\u8BFB\u540E\u56DE\u7B54\u6211\u7684\u95EE\u9898\uFF09'
        ia.setDraft(prompt)
      }
      return el('span', { style: { display: 'inline-flex', gap: '6px' } },
        el('button', { onClick: () => bus.set({ open: true }), className: 'mineru-btn', title: '\u6253\u5F00 MinerU \u6587\u6863\u89E3\u6790\u9762\u677F' }, '\uD83D\uDCC4'),
        doneJob && ia && ia.setDraft ? el('button', { onClick: send, className: 'mineru-btn', title: '\u53D1\u7ED9 Agent' }, '\u27A4 Agent') : null,
      )
    }

    const inject = ['slots', 'timer']

    function apply(ctx) {
      ctx.effect(() => {
        refresh()
        const stop = ctx.interval(refresh, 3000)
        return stop
      })

      // Global drag-drop: window-level, so no surface can shadow the drop.
      ctx.effect(() => {
        let counter = 0
        const hasFiles = (e) => !!(e && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1)
        const onEnter = (e) => { if (hasFiles(e)) { counter++; bus.set({ dragging: true }) } }
        const onOver = (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }
        const onLeave = (e) => { if (hasFiles(e)) { counter = Math.max(0, counter - 1); if (counter === 0) bus.set({ dragging: false }) } }
        const onDrop = (e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          counter = 0
          bus.set({ dragging: false })
          const files = e.dataTransfer.files
          if (files && files.length) uploadFile(files[0])
        }
        window.addEventListener('dragenter', onEnter)
        window.addEventListener('dragover', onOver)
        window.addEventListener('dragleave', onLeave)
        window.addEventListener('drop', onDrop)
        return () => {
          window.removeEventListener('dragenter', onEnter)
          window.removeEventListener('dragover', onOver)
          window.removeEventListener('dragleave', onLeave)
          window.removeEventListener('drop', onDrop)
        }
      })

      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'mineru-panel', order: 10, label: 'MinerU \u6587\u6863\u89E3\u6790' },
        () => el(react.Fragment, null, el(Panel, null), el(DragOverlay, null)),
      ))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'mineru-open', order: 100, label: () => 'MinerU \u6587\u6863\u89E3\u6790' },
        SidebarEntry,
      ))
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        { name: 'conversation.input.left', id: 'mineru-open-left', order: 100 },
        InputLeftEntry,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
