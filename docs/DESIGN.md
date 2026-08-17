# MinerU 文档解析插件 · 设计文档

> 状态：已实施（Phase 0–2）。本文档为设计定稿的存档，记录目标、架构、关键决策与已探明的环境约束。

## 1. 目标

让 DSH（本 GUI 中的 Agent）能够"阅读" PDF / Word / PPT / Excel / 图片 / HTML 文档：

- 用 MinerU 云端 API 把文档解析为干净 Markdown，落盘到会话工作区；
- Agent 通过动态工具 `parse_document` 解析，用 `read` 工具按需阅读全文（上下文预算安全）；
- 用户在 GUI 面板中管理 API Key、提交解析、查看进度与结果、一键"发给 Agent"。

**双模式（用户定义的规则）：**

```
面板中是否有 API Key？
 ├─ 无 Key → ⚡快速模式（Agent API）：免费免登录，≤10MB / ≤20 页，轻量 pipeline，仅 Markdown
 └─ 有 Key → 🎯自动路由（与上游 MinerU-Skill 语义一致）：
      ├─ 小文件单文件            → 仍走快速模式（省额度）
      ├─ >10MB / >20页 / 批量 / docx·html·latex 导出 / HTML → 精准模式（Standard API，vlm）
      └─ 快速模式超限（-30001/-30003）→ 自动升级精准模式
```

## 2. 架构

```
浏览器（Client 半区，pkg 同包共享私有 RPC）
 ├─ shell.overlay          悬浮面板：Key 管理 / 路径·URL 输入 / OCR·页码选项 / 任务列表·取消
 ├─ sidebar.footer.action  侧边栏底部入口按钮
 ├─ conversation.input.left 输入框工具行常驻按钮
 └─ tool.view.cordis       会话流进度卡：状态/阶段/结果路径 +「发给 Agent」(inputActions.setDraft)
        │ host.call('mineru.*') 每 3s 轮询
        ▼
Host（Node.js，DSH 进程）
 ├─ mineru 服务（apply 闭包状态）：Key 内存态、单并发任务队列、子进程句柄
 ├─ 动态工具：parse_document / mineru_doctor / mineru_status
 ├─ 私有 RPC：mineru.state / setKey / clearKey / convert / cancel / job / jobs
 └─ subprocess.spawn → python tools/mineru/mineru.py（collect 模式：内存上限+spill 文件）
        │
        ▼
自研 Python 客户端（纯标准库，Python 3.8+）
 ├─ 路由 choose_api：无 Key→agent；HTML→standard；Key+大文件/导出→standard；其余 agent
 ├─ Agent 流程：POST /parse/file(url) → PUT 预签名 OSS → 轮询 GET /parse/{task_id} → 下载 markdown_url
 ├─ Standard 流程：POST /file-urls/batch → PUT → POST /extract/task/batch → 轮询 → 下载 zip → 安全解压
 ├─ 可靠性：瞬时状态退避重试、自适应轮询退避、zip 路径穿越防护、错误码→中文提示
 └─ 输出：--json 机器状态 / --doctor 自检 / --selftest 离线单测 / trace 阶段日志(stderr)
```

## 3. 目录布局

```
E:\workshop\mineru-plug\
 ├─ tools\mineru\mineru.py    自研客户端（唯一运行时引擎，零第三方依赖）
 ├─ tools\mineru\README.md    用法与 API 契约说明
 ├─ docs\DESIGN.md            本文档
 └─ .mineru\
     ├─ out\<文档名>\<文档名>.md + images\    解析结果
     └─ test-assets\          测试素材与调试脚本（make_pdf.py / debug_*.py）
```

## 4. 关键实现决策（均经实测验证）

| 决策 | 依据 |
| --- | --- |
| 引擎=自研 Python 客户端而非第三方仓库 | 用户要求自研避免引用纠纷；接口契约取自 MinerU 官方公开文档（mineru.net/apiManage/docs） |
| spawn 用 subprocess 服务 collect 模式（maxBytes + spill） | 规避沙箱"禁止捕获管道 stdio"（EPERM）限制；spill 文件兼作日志；增量 readFrom 驱动进度阶段 |
| 子进程网络链路 | 探针实测：插件平面派生的 Python 子进程可访问 mineru.net、OSS 上传、CDN 下载（HTTP 200） |
| 会话工作区定位：exec.agent.session.header.cwd | sandboxPolicy.workspaceRoot 指向用户主目录（C:\Users\mouse）而非会话工作区，不可用；多候选回退 + fs.resolve 探针 |
| 脚本/输出路径相对化 | spawn cwd=项目目录，输出 `.mineru/out` 相对路径，避免硬编码 |
| Key 传递 | 仅经子进程 env 注入（MINERU_TOKEN），不回显、不落盘；setKey 时以空 payload 探测校验有效性 |
| 进度粒度 | 阶段级（submitted/upload/poll state/…）来自 stderr trace 行，1.5s 轮询增量读取 |
| 超时预算 | 默认 3600s（--timeout 可调）；免费队列实测拥堵（一个任务约 40 分钟才 done） |
| 上下文预算 | 工具只回概要+预览（≤12k 字符）+hint 指引 read 分页阅读全文 |

## 5. 环境约束与偏离项

1. **Host 无 HTTP 能力**：`web` 服务未注册 fetch provider，Host 代码也无 `fetch` 内建 → 云端调用只能经派生的 Python 子进程（主路径，已验证可行）。
2. **Client 无 fetch/FileReader**：动态 Client 内建符号仅 ctx/React/host/styles/console → **浏览器拖拽上传在动态插件中不可行**。面板输入暂为"工作区路径 / URL"两通道；拖拽上传需 Web 壳提供文件能力，列入后续观察项（原设计的 /mineru-upload 上传路由随之取消）。
3. **沙箱网络为域级策略**：pwsh 平面 GitHub 被重置、mineru.net/OSS/CDN 可达；.NET 栈连 CDN 失败而 Python TLS 栈成功 → 一律走 Python 链路。
4. **免费 Agent API 队列拥堵**（外部条件）：实测任务 pending 约 40 分钟才 done；插件如实显示排队状态，任务在后台持续轮询。设置 Key（精准模式）通常更快。

## 6. 工具与 RPC 契约

### parse_document（Agent 工具）

- 入参（全部 required）：`input`（路径/URL）、`page_range`、`ocr`、`language`、`wait_seconds`（≤600）、`preview_chars`
- 返回：`{ state, jobId, api, mode, markdownPath, charCount, outline[], preview, error, hint }`
- 语义：提交任务后等待至多 wait_seconds；未完成返回 `running` + 指引用 `mineru_status` 复查（任务在后台继续）

### mineru_doctor / mineru_status（Agent 工具）

doctor：Python 可用性、网络连通、Key 有效性、脚本定位；status：队列/任务/结果快照。

### 私有 RPC（Client→Host）

`mineru.state`、`mineru.setKey{token}`（即时校验）、`mineru.clearKey`、`mineru.convert{input,options}`、`mineru.cancel{jobId}`、`mineru.job{jobId}`、`mineru.jobs`。

## 7. 分期与后续

- **Phase 0+1（已完成）**：探针 + Host 核心 + 三工具 + Key RPC。
- **Phase 2（已完成，pkg-10 待审批）**：Client 面板四挂载点 + "发给 Agent"。
- **Phase 3（候选）**：目录批量/`--workers`、`--chunk` 章节切块、设置页镜像、credentials 持久化、拖拽上传（依赖壳能力）、本地离线引擎（pymupdf4llm）。
