# mineru.py — MinerU 文档解析客户端（自研）

纯 Python 标准库（≥3.8），零第三方依赖。不是解析引擎，而是 MinerU 两个云端 API 的编排客户端。
接口契约来自 MinerU 官方公开文档 https://mineru.net/apiManage/docs 。

## 用法

```bash
python tools/mineru/mineru.py paper.pdf                     # 解析到 .mineru/out/<文档名>/
python tools/mineru/mineru.py paper.pdf --json              # 机器可读状态（供插件解析）
python tools/mineru/mineru.py paper.pdf --stdout            # Markdown 打到 stdout
python tools/mineru/mineru.py scan.pdf --ocr --lang ch      # 扫描件 OCR
python tools/mineru/mineru.py paper.pdf --pages 1-10 --formats docx --formats latex
python tools/mineru/mineru.py https://host/doc.pdf          # URL 输入
python tools/mineru/mineru.py --doctor --json               # 环境自检（网络/Token）
python tools/mineru/mineru.py --selftest                    # 离线单元自检（不联网）
python tools/mineru/mineru.py ./pdfs/ --timeout 7200        # 目录批处理（按序）
```

## 参数

| 参数 | 说明 |
| --- | --- |
| `input` | 文件路径、目录或 URL |
| `--json` | 机器状态 JSON 到 stdout（`{total,done,failed,results:[…]}`） |
| `--stdout` | 解析出的 Markdown 打到 stdout |
| `-o/--output` | 输出目录（默认 `.mineru/out`） |
| `--api auto\|agent\|standard` | 强制后端或自动路由（默认 auto） |
| `--model pipeline\|vlm` | 精准模式模型（默认 vlm） |
| `--lang` | 语言（默认 ch） |
| `--ocr` | 扫描件 OCR |
| `--pages` | 页码范围，如 `1-10` 或 `2,4-6` |
| `--formats docx html latex` | 额外导出格式（仅精准模式，可多个） |
| `--timeout N` | 单输入总预算秒（默认 3600；免费队列拥堵时任务可能排队很久） |
| `--doctor` | 环境自检并退出（JSON/文本） |
| `--selftest` | 离线单元自检并退出 |
| `--quiet` | 少打印过程日志 |

## 双模式与自动路由

- **快速模式（Agent API）** `https://mineru.net/api/v1/agent`：免 Token，≤10MB/≤20 页，单文件，输出 Markdown。
- **精准模式（Standard API）** `https://mineru.net/api/v4`：Bearer Token，≤200MB/≤200 页，zip（MD+images+JSON，可选 docx/html/latex），免费 1000 页/天。
- 路由：无 Key→agent；HTML→standard；Key+大文件/导出格式→standard；其余 agent；`-30001/-30003` 自动升级。

环境变量：`MINERU_TOKEN`（精准模式 Token）、`MINERU_API_AGENT` / `MINERU_API_STANDARD`（基地址覆盖，调试用，支持 http/https）。

## 离线验收精准模式（mock）

```bash
python .mineru/test-assets/mock_standard_api.py --port 8899   # 后台起本地 mock
# 另开终端：
$env:MINERU_TOKEN='dummy'; $env:MINERU_API_STANDARD='http://127.0.0.1:8899/api/v4'
python tools/mineru/mineru.py .mineru/test-assets/hello.pdf --api standard --json -o .mineru/mock-out
# 验证 .mineru/mock-out/hello/hello.md 与 images/ 生成
```

mock 覆盖 Standard 全部端点（file-urls/batch → PUT → extract/task/batch → 轮询 → zip 下载 → 安全解压），已实测通过。

## 状态输出（--json）

```json
{
  "total": 1, "done": 1, "failed": 0,
  "results": [{
    "name": "hello", "source": ".mineru/test-assets/hello.pdf",
    "api": "agent", "modality": "pdf", "state": "done",
    "output_dir": "…\\.mineru\\out\\hello", "markdown_path": "…\\.mineru\\out\\hello\\hello.md",
    "task_id": "…", "elapsed": 13.2, "error": null
  }]
}
```

阶段日志打到 stderr（`[mineru] …` 行），供调用方做进度展示；诊断与提示信息在 `error` 字段中已中文化。
