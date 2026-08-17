# MinerU DSH 插件

让 DSH（DeepSeek Harness）中的 Agent"读懂" PDF / Word / PPT / Excel / 图片 / HTML：通过 MinerU 云端 API 解析为干净 Markdown 并落盘工作区，Agent 用 `read` 按需阅读；GUI 提供可视化面板——**拖拽上传、API Key 管理、任务进度、一键发给 Agent**。

> MinerU DSH plugin: dual-mode cloud document parsing (free Agent API / Standard API with token and auto-routing), agent tools + browser panel with drag-drop upload. [English overview](#english-overview)

## 一键安装（推荐：npm）

```bash
npm install -g mineru-dsh-plugin   # 全局安装（含 CLI）
mineru-dsh-plugin                  # 一键安装：镜像 + junction + 补丁注入
# 重启 DSH → 任何预设、任何会话自动生效（工具 + 面板 + 拖拽上传）
```

CLI 做的事（跨平台，纯 Node 零依赖）：

1. **镜像**：把插件包复制到 `%DSH_HOME%\plugins\mineru-dsh-plugin`（稳定目录，npm 升级不影响已安装实例）；
2. **junction/符号链接**：链入本机所有 DSH 包解析根（`DSH_HOME\profiles\node_modules`、`E:\ds harness\deepseek-harness\node_modules`，可用 `--install-dir` 指定）；
3. **用户补丁层**：向 `DSH_HOME\profiles\*\cordis.patch.yml`（DSH 官方用户扩展点）写入 `insert` 补丁——插件**进程级全局挂载**，无需预设。

```bash
mineru-dsh-plugin status             # 查看安装状态
mineru-dsh-plugin uninstall          # 卸载（补丁 + 链接）
mineru-dsh-plugin uninstall --purge  # 连镜像一起删
mineru-dsh-plugin --data-dir D:\data # 自定义数据目录（上传文件 + 解析产物）
```

**数据目录默认值**：从仓库（`git clone`）安装 → 仓库目录本身；`npm -g` 安装 → 插件镜像目录。上传源文件与解析产物分别落在 `<数据目录>\.mineru\inputs` 与 `.mineru\out`，可用 `--data-dir` 指定任意位置。

## 备选安装（git clone + PowerShell）

```powershell
git clone https://github.com/ramouse/mineru-plug-for-ds.git
cd mineru-dsh-plugin
pwsh -File tools\install.ps1         # 全局插件（写补丁层 + junction）
pwsh -File tools\install.ps1 -Uninstall
```

详细安装/卸载/更新/排障见 [docs/INSTALL.md](docs/INSTALL.md)。

## 双模式

| | ⚡ 快速模式 | 🎯 精准模式 |
| --- | --- | --- |
| 触发 | 面板未设置 API Key | 设置 Key 后自动路由（大文件/导出格式/HTML 自动升级；小文件仍走快速省额度） |
| 后端 | MinerU Agent API（免费免登录） | MinerU Standard API（Bearer Token） |
| 限制 | ≤10MB / ≤20 页，仅 Markdown | ≤200MB / ≤200 页，zip（MD+images+JSON，可选 docx/html/latex） |
| 额度 | IP 限流 | 免费 1000 页/天高优先级 |

Key 获取：<https://mineru.net/apiManage/token>（面板保存时即时校验有效性）。

## 使用

- **Agent 工具**：`parse_document`（解析，返回概要+预览+落盘路径，正文用 `read` 分页阅读）、`mineru_status`（队列/结果）、`mineru_doctor`（环境自检）。
- **GUI 面板**：侧边栏底部或输入框旁的「📄 文档解析」打开右下角面板——拖入/选择文件、路径或 URL 输入、OCR/页码选项、任务列表与取消、复制 Prompt；解析完成后输入框旁出现「➤ Agent」一键注入提示。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `packages/mineru-plugin/` | DSH 插件包（Host：工具+HTTP 端点+任务队列；Client：面板 bundle） |
| `tools/mineru/mineru.py` | 自研纯标准库 Python 客户端（Python ≥3.8，零依赖；路由/重试/轮询/安全解压/`--json`/`--doctor`/`--selftest`） |
| `tools/install.ps1` | 一键安装/卸载器 |
| `docs/DESIGN.md` | 设计定稿（架构、实测决策、环境约束） |
| `docs/INSTALL.md` | 安装/卸载/更新/排障手册 |

## 已知边界

1. **免费 Agent API 队列可能拥堵**（实测最长约 40 分钟/任务）——任务后台持续轮询并如实显示排队状态；设置 Key 走精准模式通常更快。
2. **图片提取**：快速模式（无 Key）仅返回文本，Markdown 中的图片是 `<!-- image-->` 占位符；**设置 API Key 后走精准模式**，图片随 zip 解压保存到 `<输出目录>\images\`。
3. **解析在 MinerU 云端进行**（文件离开本机，面板有隐私提示）；机密/内网文档请勿使用。
4. 依赖本机 Python ≥3.8（`python` 或 `py` 在 PATH 中），无需 pip 安装、无需 GPU。
5. 插件随 DSH 进程运行：解析期间避免更新插件版本（会终止在跑任务）。
6. 安装器当前面向 Windows（junction 免管理员权限）；macOS/Linux 可用等价的符号链接（见 docs/INSTALL.md）。

## 开发自检

```bash
python tools/mineru/mineru.py --selftest      # 离线单测（路由/命名/zip 安全）
python tools/mineru/mineru.py --doctor --json # 环境自检（Python/网络/Token）
python tools/mineru/mineru.py docs.pdf --json # 真实解析
```

---

## English Overview

A plugin for DSH (DeepSeek Harness) that lets the agent "read" PDF / Word / PPT / Excel / image / HTML documents: MinerU cloud APIs parse them into clean Markdown saved into the workspace; the agent reads them on demand with the `read` tool. The GUI panel supports **drag-drop upload**, API-key management, job progress, and one-click "send to agent".

- **Dual mode**: no key → free Agent API (quick, ≤10MB/≤20 pages); key set → auto-routing (small files stay quick, large/extra-format/HTML upgrade to the Standard API, ≤200MB/≤200 pages).
- **Install (Windows)**: `git clone` this repo, then `pwsh -File tools\install.ps1` — writes one `insert` entry into the DSH user patch layer (`cordis.patch.yml`), the official user extension point; the plugin loads **process-wide (global)**: every session and every preset gets it. Restart DSH once for the panel.
- **Uninstall**: `pwsh -File tools\install.ps1 -Uninstall -RemovePreset`.
- See [docs/INSTALL.md](docs/INSTALL.md) for details, troubleshooting, and manual install steps.

License: MIT.
