// MinerU document parsing plugin — Host half (permanent install).
//
// Dual-mode: no API key -> free Agent API (quick); key set -> auto-routing
// (small files stay on Agent API, large/extra-format/HTML upgrade to the
// Standard API). Drives the self-contained Python client at
// <projectDir>/tools/mineru/mineru.py through the host subprocess service.
//
// Surface:
//   - model tools: parse_document / mineru_status / mineru_doctor
//   - panel HTTP endpoints: /mineru/state /jobs /convert /cancel /set-key
//     /clear-key /upload (octet-stream) /clear-cache — consumed by the
//     client bundle.
import { existsSync } from 'node:fs'
import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve, sep, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The plugin's own install root: <root>/packages/mineru-plugin/lib/entry.js
// -> <root>, which also carries tools/mineru/mineru.py.
const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export const name = 'mineru-host'

export const inject = ['subprocess', 'tools', 'webServer']

export function apply(ctx, config) {
  const state = {
    token: null,
    python: null,
    projectDir: '',
    dataDir: '',
    scriptPath: '',
    runningJobId: null,
    queue: [],
    jobs: {},
    seq: 0,
  }

  function scriptFor(projectDir) {
    const p = join(projectDir, 'tools', 'mineru', 'mineru.py')
    return existsSync(p) ? p : null
  }

  function locateProject(pluginConfig) {
    const candidates = []
    const configured = (pluginConfig && typeof pluginConfig.projectDir === 'string' && pluginConfig.projectDir)
      ? pluginConfig.projectDir
      : ''
    if (configured) candidates.push(configured)
    candidates.push(OWN_ROOT)
    candidates.push('E:\\workshop\\mineru-plug')
    // Session workspaces as fallback candidates (leaf read of live session headers).
    try {
      const sessions = ctx.get('sessions')
      if (sessions) {
        for (const s of sessions.list()) {
          const cwd = s && s.header && typeof s.header.cwd === 'string' ? s.header.cwd : null
          if (cwd && candidates.indexOf(cwd) === -1) candidates.push(cwd)
        }
      }
    } catch (e) {}
    for (const cwd of candidates) {
      const script = scriptFor(cwd)
      if (script) {
        // Data directory: explicit dataDir config wins; otherwise the plugin's
        // install location (projectDir), so uploads/outputs live beside it.
        const dataDir = (pluginConfig && typeof pluginConfig.dataDir === 'string' && pluginConfig.dataDir)
          ? pluginConfig.dataDir
          : (pluginConfig && typeof pluginConfig.projectDir === 'string' && pluginConfig.projectDir) || cwd
        return { projectDir: cwd, dataDir, scriptPath: script }
      }
    }
    const dataDir = (pluginConfig && typeof pluginConfig.dataDir === 'string' && pluginConfig.dataDir) || ''
    return { projectDir: candidates[0] || '', dataDir, scriptPath: null }
  }

  const located = locateProject(config || {})
  state.projectDir = located.projectDir
  state.dataDir = located.dataDir
  state.scriptPath = located.scriptPath

  async function getPython() {
    if (state.python) return state.python
    try {
      state.python = await ctx.subprocess.resolveExecutable('python')
      return state.python
    } catch (e1) {
      try {
        state.python = await ctx.subprocess.resolveExecutable('py')
        return state.python
      } catch (e2) {
        return null
      }
    }
  }

  function baseEnv() {
    const env = { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    env.MINERU_TOKEN = state.token || undefined
    return env
  }

  function spawnMineru(python, args) {
    return ctx.subprocess.spawn({
      argv: [python, state.scriptPath].concat(args),
      cwd: state.projectDir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 2097152, spill: { maxBytes: 67108864 } },
        stderr: { maxBytes: 262144, spill: { maxBytes: 67108864 } },
      },
      graceMs: 5000,
      env: baseEnv(),
    })
  }

  function readPhase(job) {
    if (!job.handle) return
    const reader = job.handle.collected && job.handle.collected.stderr
    if (!reader) return
    const read = reader.readFrom(job.stderrOffset)
    if (read && read.text) {
      job.stderrOffset = read.nextOffset
      const lines = read.text.split(/\r?\n/)
      for (const line of lines) {
        if (line.indexOf('[mineru]') !== -1) job.phase = line
      }
    }
  }

  function finishJob(job, jobState, error, status) {
    job.state = jobState
    job.finishedAt = Date.now()
    if (error) job.error = String(error)
    if (status) job.status = status
    if (job.progressTimer) { try { job.progressTimer() } catch (e) {} job.progressTimer = null }
    if (job.resolveWait) { job.resolveWait(); job.resolveWait = null }
    if (state.runningJobId === job.jobId) state.runningJobId = null
    pump()
  }

  async function startJob(job) {
    try {
      if (!state.scriptPath) {
        finishJob(job, 'failed', '未找到脚本 tools/mineru/mineru.py（项目目录 ' + state.projectDir + '）')
        return
      }
      const python = await getPython()
      if (!python) {
        finishJob(job, 'failed', '未找到 Python（python/py 均不可用）')
        return
      }
      const args = ['--json', '-o', join(state.dataDir, '.mineru', 'out')]
      const opts = job.opts || {}
      if (opts.api && opts.api !== 'auto') args.push('--api', opts.api)
      if (opts.pageRange) args.push('--pages', opts.pageRange)
      if (opts.ocr) args.push('--ocr')
      if (opts.language) args.push('--lang', opts.language)
      if (Array.isArray(opts.formats) && opts.formats.length) {
        for (const f of opts.formats) args.push('--formats', f)
      }
      args.push(job.source)
      const handle = spawnMineru(python, args)
      job.handle = handle
      job.phase = 'submitted'
      const timer = ctx.get('timer')
      const tick = () => {
        if (job.state !== 'running') return
        readPhase(job)
        if (timer) job.progressTimer = timer.timeout(tick, 1500)
      }
      tick()
      const outcome = await handle.done
      const exitCode = outcome.exitCode
      if (job.cancelRequested) {
        finishJob(job, 'cancelled', '已取消')
        return
      }
      let status = null
      const stdoutReader = handle.collected && handle.collected.stdout
      if (stdoutReader) {
        const read = stdoutReader.readFrom(0)
        const text = (read && read.text) || ''
        try { status = JSON.parse(text) } catch (e) {}
      }
      if (exitCode === 0 && status && status.failed === 0) {
        const first = ((status.results || [])[0]) || {}
        job.api = first.api || job.api
        finishJob(job, 'done', null, status)
      } else {
        let err = null
        if (status && Array.isArray(status.results)) {
          for (const r of status.results) {
            if (r.state !== 'done') { err = r.error || '解析失败'; break }
          }
        }
        if (!err) {
          const stderrReader = handle.collected && handle.collected.stderr
          const stderrRead = stderrReader ? stderrReader.readFrom(0) : null
          const tail = (stderrRead && stderrRead.text) || ''
          err = '解析失败（exit=' + exitCode + '）' + (tail ? '：' + tail.slice(-200) : '')
        }
        finishJob(job, 'failed', err, status)
      }
    } catch (err) {
      finishJob(job, 'failed', String((err && err.message) || err), null)
    }
  }

  function pump() {
    if (state.runningJobId) return
    const job = state.queue.shift()
    if (!job) return
    state.runningJobId = job.jobId
    job.state = 'running'
    job.startedAt = Date.now()
    startJob(job)
  }

  function enqueue(kind, source, opts) {
    const jobId = 'mj-' + (++state.seq)
    const job = {
      jobId,
      kind,
      source,
      opts: opts || {},
      state: 'queued',
      api: 'auto',
      mode: state.token ? 'auto' : 'quick',
      startedAt: null,
      finishedAt: null,
      phase: null,
      error: null,
      status: null,
      handle: null,
      stderrOffset: 0,
      progressTimer: null,
      cancelRequested: false,
      resolveWait: null,
      waitPromiseResolve: null,
    }
    job.waitPromise = new Promise((resolvePromise) => { job.waitPromiseResolve = resolvePromise })
    job.resolveWait = job.waitPromiseResolve
    state.jobs[jobId] = job
    state.queue.push(job)
    pump()
    return job
  }

  function jobSnapshot(job) {
    if (!job) return null
    const now = Date.now()
    const snap = {
      jobId: job.jobId,
      kind: job.kind,
      source: job.source,
      state: job.state,
      api: job.api,
      mode: job.mode,
      phase: job.phase,
      error: job.error || '',
      elapsedSec: job.startedAt ? Math.round(((job.finishedAt || now) - job.startedAt) / 1000) : 0,
    }
    if (job.status) {
      const results = Array.isArray(job.status.results) ? job.status.results : []
      const first = results[0]
      snap.total = job.status.total
      snap.done = job.status.done
      snap.failed = job.status.failed
      if (first) {
        snap.markdownPath = first.markdown_path || ''
        snap.outputDir = first.output_dir || ''
        snap.modality = first.modality || ''
      }
    }
    return snap
  }

  function allJobs() {
    const ids = Object.keys(state.jobs)
    ids.sort()
    return ids.map((id) => jobSnapshot(state.jobs[id]))
  }

  function validateLocalInput(source) {
    const base = state.dataDir || state.projectDir
    const path = resolve(base, source)
    if (!existsSync(path)) return '文件不存在：' + source
    try {
      if (!statSync(path).isFile()) return '不是文件：' + source
    } catch (e) {
      return '文件不可访问：' + source
    }
    return null
  }

  function normalizeApi(value) {
    const v = String(value || 'auto')
    return v === 'agent' || v === 'standard' || v === 'auto' ? v : 'auto'
  }

  function apiAllowed(api) {
    if (api === 'standard' && !state.token) return '精准模式需要先设置 API Key'
    return null
  }

  async function runDoctor(python) {
    const handle = spawnMineru(python, ['--doctor', '--json'])
    const outcome = await handle.done
    const stdoutReader = handle.collected && handle.collected.stdout
    const stdoutRead = stdoutReader ? stdoutReader.readFrom(0) : null
    const stdoutText = (stdoutRead && stdoutRead.text) || ''
    let report = null
    try { report = JSON.parse(stdoutText) } catch (e) {}
    return { outcome, report, stdoutText }
  }

  async function setKeyInternal(token) {
    const python = await getPython()
    if (!python) return { ok: false, error: '未找到 Python（python/py 均不可用）' }
    if (!state.scriptPath) return { ok: false, error: '未找到脚本 tools/mineru/mineru.py' }
    const prev = state.token
    state.token = token
    try {
      const { report } = await runDoctor(python)
      const tok = (report && report.token) || {}
      if (tok.ok) return { ok: true, mode: 'auto', detail: String(tok.detail || 'Token 有效') }
      state.token = prev
      return { ok: false, error: String(tok.detail || 'Token 校验失败'), hint: '请到 https://mineru.net/apiManage/token 检查/刷新 Token' }
    } catch (err) {
      state.token = prev
      return { ok: false, error: String((err && err.message) || err) }
    }
  }

  // ------------------------------------------------------------------ tools
  ctx.tools.register({
    name: 'parse_document',
    description: '用 MinerU 把 PDF/Word/PPT/Excel/图片/HTML 解析为 Markdown 并落盘工作区。无 API Key 走免费快速模式（<=10MB/<=20页）；有 Key 自动路由（小文件快速、大文件精准）。返回结构概要+预览，正文用 read 工具按需阅读。',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string' },
        page_range: { type: 'string' },
        ocr: { type: 'boolean' },
        language: { type: 'string' },
        api: { type: 'string', description: "auto（默认，有 Key 时小文件快速/大文件精准）| agent（强制快速模式）| standard（强制精准模式，需先设置 API Key）" },
        wait_seconds: { type: 'number' },
        preview_chars: { type: 'number' },
      },
      required: ['input', 'page_range', 'ocr', 'language', 'api', 'wait_seconds', 'preview_chars'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string' },
          jobId: { type: 'string' },
          api: { type: 'string' },
          mode: { type: 'string' },
          markdownPath: { type: 'string' },
          charCount: { type: 'number' },
          outline: { type: 'array', items: { type: 'string' } },
          preview: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render: (_args, v) => {
        const lines = []
        lines.push('[' + v.state + '] job=' + v.jobId + ' mode=' + v.mode + ' api=' + v.api)
        if (v.markdownPath) lines.push('markdown: ' + v.markdownPath + ' (' + v.charCount + ' chars)')
        if (v.error) lines.push('error: ' + v.error)
        if (v.hint) lines.push(v.hint)
        if (v.preview) lines.push('--- preview ---\n' + v.preview)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const fail = (error, hint) => ({
        state: 'failed', jobId: '', api: '', mode: state.token ? 'auto' : 'quick',
        markdownPath: '', charCount: 0, outline: [], preview: '', error, hint,
      })
      const source = String(args.input || '')
      if (!source) return fail('缺少 input 参数', '')
      const api = normalizeApi(args.api)
      const apiProblem = apiAllowed(api)
      if (apiProblem) return fail(apiProblem, '请先在面板设置 API Key，或将 api 改为 agent/auto。')
      const isUrl = /^https?:\/\//i.test(source)
      if (!isUrl) {
        const problem = validateLocalInput(source)
        if (problem) return fail(problem, '请确认输入是工作区内的文件路径或可访问的 URL。')
      }
      const job = enqueue(isUrl ? 'url' : 'path', source, {
        api,
        ocr: !!args.ocr,
        language: String(args.language || 'ch'),
        pageRange: String(args.page_range || ''),
        formats: [],
      })
      const waitMs = Math.min(Math.max(Number(args.wait_seconds) || 180, 5), 600) * 1000
      let waited = 0
      const timer = ctx.get('timer')
      while ((job.state === 'queued' || job.state === 'running') && waited < waitMs && timer) {
        await timer.timeout(2000)
        waited += 2000
      }
      const base = {
        state: job.state,
        jobId: job.jobId,
        api: job.api,
        mode: job.mode,
        error: job.error || '',
        markdownPath: '',
        charCount: 0,
        outline: [],
        preview: '',
        hint: '',
      }
      if (job.state === 'done' && job.status && Array.isArray(job.status.results)) {
        const first = job.status.results[0] || {}
        base.markdownPath = first.markdown_path || ''
        base.api = first.api || base.api
        base.mode = base.api === 'agent' ? 'quick' : 'standard'
        if (base.markdownPath) {
          try {
            const text = readFileSync(base.markdownPath, 'utf8')
            const cap = Math.max(200, Math.min(Number(args.preview_chars) || 4000, 12000))
            base.charCount = text.length
            base.preview = text.slice(0, cap)
            const heads = text.match(/^#{1,6} .+$/gm) || []
            base.outline = heads.slice(0, 40)
            base.hint = '完整 Markdown 已落盘：' + base.markdownPath + '。可用 read 工具按 offset/limit 分页阅读全文。'
          } catch (e) {
            base.hint = '结果已生成，但读取失败：' + String((e && e.message) || e)
          }
        }
      } else if (job.state === 'running' || job.state === 'queued') {
        base.hint = '任务进行中（' + (job.phase || '排队/解析') + '）。稍后用 mineru_status 查询 jobId=' + job.jobId + '。'
      } else if (job.state === 'cancelled') {
        base.hint = '任务已取消。'
      } else {
        base.hint = '解析失败：' + (job.error || '未知错误') + '。可用 mineru_status 查看详情。'
      }
      return base
    },
  })

  ctx.tools.register({
    name: 'mineru_doctor',
    description: 'MinerU 插件环境自检：Python 可用性、mineru.net 网络连通性、API Key 有效性（若已设置）。也用于排查解析失败。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          python: { type: 'string' },
          exitCode: { type: 'number' },
          hasKey: { type: 'boolean' },
          mode: { type: 'string' },
          networkOk: { type: 'boolean' },
          networkDetail: { type: 'string' },
          tokenOk: { type: 'boolean' },
          tokenDetail: { type: 'string' },
          healthy: { type: 'boolean' },
          scriptPath: { type: 'string' },
          projectDir: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, v) => {
        const lines = []
        lines.push('healthy=' + v.healthy + ' mode=' + v.mode + ' python=' + v.python)
        lines.push('network: ' + (v.networkOk ? 'OK' : 'FAIL') + ' - ' + v.networkDetail)
        lines.push('token: ' + (v.tokenOk ? 'OK' : 'FAIL') + ' - ' + v.tokenDetail)
        lines.push('script=' + v.scriptPath + ' project=' + v.projectDir)
        if (v.error) lines.push('error: ' + v.error)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const empty = {
        ok: false, python: '', exitCode: -1, hasKey: !!state.token,
        mode: state.token ? 'auto' : 'quick', networkOk: false, networkDetail: '',
        tokenOk: false, tokenDetail: '', healthy: false,
        scriptPath: state.scriptPath || '', projectDir: state.projectDir, error: '',
      }
      if (!state.scriptPath) { empty.error = '未找到脚本 tools/mineru/mineru.py（项目目录 ' + state.projectDir + '）'; return empty }
      const python = await getPython()
      if (!python) { empty.error = '未找到 Python（python/py 均不可用）'; return empty }
      try {
        const { outcome, report, stdoutText } = await runDoctor(python)
        if (!report) {
          empty.python = python
          empty.exitCode = outcome.exitCode
          empty.error = 'doctor 输出解析失败（exit=' + outcome.exitCode + '）stdout=' + String(stdoutText).slice(0, 200)
          return empty
        }
        const net = report.network || {}
        const tok = report.token || {}
        const py = report.python || {}
        return {
          ok: outcome.exitCode === 0,
          python: (py.detail || '') + ' (exe: ' + python + ')',
          exitCode: outcome.exitCode,
          hasKey: !!state.token,
          mode: state.token ? 'auto' : 'quick',
          networkOk: !!net.ok,
          networkDetail: String(net.detail || ''),
          tokenOk: !!tok.ok,
          tokenDetail: String(tok.detail || ''),
          healthy: !!report.healthy,
          scriptPath: state.scriptPath,
          projectDir: state.projectDir,
          error: '',
        }
      } catch (err) {
        empty.error = String((err && err.message) || err)
        empty.python = python
        return empty
      }
    },
  })

  ctx.tools.register({
    name: 'mineru_status',
    description: '查询 MinerU 插件的任务队列、进行中任务与历史结果（含已落盘 Markdown 路径）。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hasKey: { type: 'boolean' },
          mode: { type: 'string' },
          runningJobId: { type: 'string' },
          queued: { type: 'number' },
          jobs: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, v) => {
        const lines = []
        lines.push('mode=' + v.mode + ' running=' + (v.runningJobId || '-') + ' queued=' + v.queued)
        for (const j of v.jobs) {
          lines.push('- [' + j.state + '] ' + j.jobId + ' ' + j.source + (j.phase && j.state === 'running' ? ' [' + j.phase + ']' : '') + (j.markdownPath ? ' -> ' + j.markdownPath : '') + (j.error ? ' (' + j.error + ')' : ''))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      return {
        hasKey: !!state.token,
        mode: state.token ? 'auto' : 'quick',
        runningJobId: state.runningJobId || '',
        queued: state.queue.length,
        jobs: allJobs(),
      }
    },
  })

  // ----------------------------------------------------------- panel routes
  function sendJson(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length) })
    res.end(body)
  }

  function readBody(req, maxBytes) {
    return new Promise((resolvePromise, reject) => {
      const chunks = []
      let total = 0
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > maxBytes) {
          reject(new Error('请求体超过上限 ' + maxBytes + ' 字节'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolvePromise(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/state',
    handler: async (_req, res) => {
      sendJson(res, 200, {
        hasKey: !!state.token,
        mode: state.token ? 'auto' : 'quick',
        projectDir: state.projectDir,
        dataDir: state.dataDir,
        scriptPath: state.scriptPath,
        runningJobId: state.runningJobId || '',
        queued: state.queue.length,
        jobs: allJobs(),
      })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/jobs',
    handler: async (_req, res) => {
      sendJson(res, 200, { ok: true, jobs: allJobs() })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/set-key',
    handler: async (req, res) => {
      let body
      try { body = await readBody(req, 65536) } catch (e) { return sendJson(res, 413, { ok: false, error: e.message }) }
      let token = ''
      try { token = String(JSON.parse(body.toString('utf8')).token || '').trim() } catch (e) {}
      if (!token) return sendJson(res, 400, { ok: false, error: 'Token 为空' })
      const result = await setKeyInternal(token)
      sendJson(res, result.ok ? 200 : 400, result)
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/clear-key',
    handler: async (_req, res) => {
      state.token = null
      sendJson(res, 200, { ok: true, mode: 'quick' })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/convert',
    handler: async (req, res) => {
      let body
      try { body = await readBody(req, 262144) } catch (e) { return sendJson(res, 413, { ok: false, error: e.message }) }
      let parsed = {}
      try { parsed = JSON.parse(body.toString('utf8')) } catch (e) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
      const input = String(parsed.input || '')
      if (!input) return sendJson(res, 400, { ok: false, error: '缺少 input' })
      const isUrl = /^https?:\/\//i.test(input)
      if (!isUrl) {
        const problem = validateLocalInput(input)
        if (problem) return sendJson(res, 400, { ok: false, error: problem })
      }
      const opts = parsed.options || {}
      const api = normalizeApi(opts.api)
      const apiProblem = apiAllowed(api)
      if (apiProblem) return sendJson(res, 400, { ok: false, error: apiProblem })
      const job = enqueue(isUrl ? 'url' : 'path', input, {
        api,
        ocr: !!opts.ocr,
        language: String(opts.language || 'ch'),
        pageRange: String(opts.page_range || opts.pageRange || ''),
        formats: Array.isArray(opts.formats) ? opts.formats : [],
      })
      sendJson(res, 200, { ok: true, job: jobSnapshot(job) })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/cancel',
    handler: async (req, res) => {
      let body
      try { body = await readBody(req, 65536) } catch (e) { return sendJson(res, 413, { ok: false, error: e.message }) }
      let jobId = ''
      try { jobId = String(JSON.parse(body.toString('utf8')).jobId || '') } catch (e) {}
      const job = state.jobs[jobId]
      if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在：' + jobId })
      if (job.state === 'queued') {
        const idx = state.queue.indexOf(job)
        if (idx >= 0) state.queue.splice(idx, 1)
        finishJob(job, 'cancelled', '已取消')
        return sendJson(res, 200, { ok: true, job: jobSnapshot(job) })
      }
      if (job.state === 'running' && job.handle) {
        job.cancelRequested = true
        try { job.handle.terminate() } catch (e) {}
        return sendJson(res, 200, { ok: true, job: jobSnapshot(job) })
      }
      sendJson(res, 400, { ok: false, error: '任务已结束' })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/upload',
    handler: async (req, res) => {
      const rawName = String((req.url || '').split('?')[1] || '')
      const params = new URLSearchParams(rawName)
      const fileName = (params.get('name') || 'upload.pdf').replace(/[\\/:*?"<>|]/g, '_')
      const api = normalizeApi(params.get('api'))
      const apiProblem = apiAllowed(api)
      if (apiProblem) return sendJson(res, 400, { ok: false, error: apiProblem })
      const suffix = '.' + fileName.split('.').pop().toLowerCase()
      const allowed = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.html'])
      if (!allowed.has(suffix)) return sendJson(res, 400, { ok: false, error: '不支持的文件类型：' + suffix })
      let body
      try { body = await readBody(req, 200 * 1024 * 1024) } catch (e) { return sendJson(res, 413, { ok: false, error: e.message }) }
      if (body.length === 0) return sendJson(res, 400, { ok: false, error: '文件为空' })
      const inputsDir = join(state.dataDir, '.mineru', 'inputs')
      try { mkdirSync(inputsDir, { recursive: true }) } catch (e) {}
      const dest = join(inputsDir, fileName)
      try { writeFileSync(dest, body) } catch (e) {
        return sendJson(res, 500, { ok: false, error: '写入失败：' + String((e && e.message) || e) })
      }
      const job = enqueue('upload', dest, { api, ocr: false, language: 'ch', pageRange: '', formats: [] })
      sendJson(res, 200, { ok: true, job: jobSnapshot(job), savedPath: dest })
    },
  })

  function countFiles(dir) {
    let total = 0
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) total += countFiles(join(dir, entry.name))
        else total += 1
      }
    } catch (e) {}
    return total
  }

  function clearCacheDir(name) {
    const p = join(state.dataDir, '.mineru', name)
    let deletedFiles = 0
    try {
      if (existsSync(p)) {
        deletedFiles = countFiles(p)
        rmSync(p, { recursive: true, force: true })
      }
    } catch (e) {}
    return { name, deletedFiles }
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/remove-job',
    handler: async (req, res) => {
      // Drop a FINISHED job's record from the in-memory list. Running/queued
      // jobs must be cancelled first.
      let body
      try { body = await readBody(req, 65536) } catch (e) { return sendJson(res, 413, { ok: false, error: e.message }) }
      let jobId = ''
      try { jobId = String(JSON.parse(body.toString('utf8')).jobId || '') } catch (e) {}
      const job = state.jobs[jobId]
      if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在：' + jobId })
      if (job.state === 'running' || job.state === 'queued') {
        return sendJson(res, 400, { ok: false, error: '任务仍在进行中，请先取消' })
      }
      delete state.jobs[jobId]
      sendJson(res, 200, { ok: true })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/clear-cache',
    handler: async (req, res) => {
      // which: 'inputs' (uploaded sources) | 'out' (parsed results) | 'all'.
      // Running jobs are untouched: their bytes are already uploaded/read,
      // and late writes re-create directories as needed.
      let body
      try { body = await readBody(req, 65536) } catch (e) { return sendJson(res, 413, { ok: false, error: e.message }) }
      let which = 'all'
      try { which = String(JSON.parse(body.toString('utf8')).which || 'all') } catch (e) {}
      const targets = which === 'inputs' ? ['inputs'] : which === 'out' ? ['out'] : ['inputs', 'out']
      const cleaned = []
      let deletedFiles = 0
      for (const name of targets) {
        const r = clearCacheDir(name)
        cleaned.push(r.name)
        deletedFiles += r.deletedFiles
      }
      sendJson(res, 200, { ok: true, deletedFiles, cleaned })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/mineru/open-folder',
    handler: async (req, res) => {
      // Open the uploads or outputs directory in Windows Explorer for the
      // user to browse on their own machine.
      const params = new URLSearchParams(String((req.url || '').split('?')[1] || ''))
      const which = params.get('which') === 'out' ? 'out' : 'inputs'
      const dir = join(state.dataDir, '.mineru', which)
      try { mkdirSync(dir, { recursive: true }) } catch (e) {}
      try {
        ctx.subprocess.spawn({
          argv: ['explorer.exe', dir],
          cwd: state.projectDir,
          stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
          graceMs: 1000,
        })
        sendJson(res, 200, { ok: true, dir })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: '无法打开目录：' + String((e && e.message) || e) })
      }
    },
  })

  ctx.effect(() => () => {
    const ids = Object.keys(state.jobs)
    for (const id of ids) {
      const job = state.jobs[id]
      if (job.progressTimer) { try { job.progressTimer() } catch (e) {} }
      if (job.handle && job.state === 'running') {
        try { job.handle.terminate() } catch (e) {}
      }
    }
  })
}
