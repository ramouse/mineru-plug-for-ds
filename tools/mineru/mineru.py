#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MinerU 文档解析客户端（自研，纯 Python 标准库，Python 3.8+）。

把 PDF / Office / 图片 / HTML 解析为干净的 Markdown。不是解析引擎本身，
而是 MinerU 两个云端 API 的编排客户端：

  快速模式（Agent API）  https://mineru.net/api/v1/agent
     免费、免 Token、单文件、<=10MB、<=20 页、轻量 pipeline、输出 Markdown。
  精准模式（Standard API）https://mineru.net/api/v4
     Bearer Token、<=200MB、<=200 页、vlm/pipeline 模型、zip 输出
     （Markdown + images + JSON，可选 docx/html/latex），免费 1000 页/天。

路由（--api auto 默认）：
  - 无 Token                  -> Agent API（快速模式）
  - 有 Token + 小文件单文件   -> Agent API（省额度；命中 -30001/-30003 自动升级）
  - 有 Token + 大文件/批量/导出格式/HTML -> Standard API（精准模式）

接口契约来自 MinerU 官方公开文档 https://mineru.net/apiManage/docs ，
本文件为实现层独立编写，不依赖任何第三方库。

用法：
  python mineru.py paper.pdf                    # 解析到默认输出目录
  python mineru.py paper.pdf --json             # 机器可读状态
  python mineru.py paper.pdf --stdout           # Markdown 打到 stdout
  python mineru.py scan.pdf --ocr --lang ch     # 扫描件 OCR
  python mineru.py paper.pdf --pages 1-10 --formats docx --formats latex
  python mineru.py https://host/doc.pdf         # 解析 URL
  python mineru.py --doctor --json              # 环境自检（网络/Token）
  python mineru.py --selftest                   # 离线单元自检

环境变量：
  MINERU_TOKEN           精准模式 Token（可选，不设则走快速模式）
  MINERU_API_AGENT       Agent API 基地址覆盖（调试用）
  MINERU_API_STANDARD    Standard API 基地址覆盖（调试用）
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.parse
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

__version__ = "0.1.0"

# --------------------------------------------------------------------------- #
# 常量
# --------------------------------------------------------------------------- #
DEFAULT_AGENT_API = "https://mineru.net/api/v1/agent"
DEFAULT_STANDARD_API = "https://mineru.net/api/v4"

AGENT_MAX_BYTES = 10 * 1024 * 1024       # 10 MB
AGENT_MAX_PAGES = 20
STANDARD_MAX_BYTES = 200 * 1024 * 1024   # 200 MB
STANDARD_MAX_PAGES = 200
FREE_DAILY_PAGES = 1000                  # Standard 免费高优先级额度（页/天）

USER_AGENT = "mineru-client/%s" % __version__

# 瞬时可重试的 HTTP 状态（业务错误码 != 0 不在此列）
RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504}
RETRY_MAX_ATTEMPTS = 4                   # 1 次 + 3 次重试
RETRY_BASE_DELAY = 0.5
RETRY_MAX_DELAY = 20.0
MAX_REDIRECTS = 5

REQUEST_TIMEOUT = 30.0                   # 普通请求 socket 超时
DOWNLOAD_TIMEOUT = 300.0                 # 下载 zip/markdown 超时
DEFAULT_POLL_INTERVAL = 2.0
POLL_INTERVAL_CAP = 15.0                 # 轮询自适应退避上限
PARSE_BUDGET = 3600                      # 单个输入的总时间预算（秒）；免费队列拥堵时可能排队很久
PARSE_BUDGET_MIN = 30
ZIP_MAX_TOTAL = 1024 * 1024 * 1024       # 解压总大小上限 1GB

# 支持的输入模态
MODALITY_SUFFIXES = {
    "pdf": {".pdf"},
    "image": {".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp"},
    "word": {".doc", ".docx"},
    "slides": {".ppt", ".pptx"},
    "sheet": {".xls", ".xlsx"},
    "html": {".html"},
}
SUPPORTED_SUFFIXES = {suf for group in MODALITY_SUFFIXES.values() for suf in group}

# 业务错误码 -> 提示（措辞自研，含义来自官方公开文档错误码表）
ERROR_HINTS = {
    "A0202": "Token 无效 —— 请检查或到 https://mineru.net/apiManage/token 重新创建",
    "A0211": "Token 已过期 —— 请到 https://mineru.net/apiManage/token 刷新",
    -500: "参数错误 —— 请检查请求参数与 Content-Type",
    -10001: "服务错误 —— 请稍后重试",
    -10002: "请求参数无效",
    -60001: "上传地址生成失败 —— 请稍后重试",
    -60002: "不支持的文件格式 —— 请使用正确的扩展名",
    -60003: "文件读取失败 —— 文件可能已损坏",
    -60004: "空文件 —— 请上传有效文件",
    -60005: "文件过大 —— 精准模式上限 200MB",
    -60006: "页数过多 —— 精准模式上限 200 页，请拆分文件",
    -60007: "模型服务暂不可用 —— 请稍后重试",
    -60008: "文件读取超时 —— 请确认 URL 可访问",
    -60009: "任务队列已满 —— 请稍后重试",
    -60010: "解析失败 —— 请稍后重试",
    -60011: "未取得有效文件 —— 请确认上传成功",
    -60012: "任务不存在 —— 请检查 task_id",
    -60013: "无权访问该任务",
    -60015: "文件转换失败 —— 可尝试先转成 PDF",
    -60016: "格式转换失败 —— 请换一种导出格式",
    -60017: "重试次数已用尽 —— 请稍后再试",
    -60018: "今日解析额度已用尽 —— 请明天再试",
    -60019: "HTML 解析额度不足 —— 请明天再试",
    -60022: "网页读取失败 —— 可能被限流，请稍后重试",
    # Agent（快速模式）专属
    -30001: "文件超过快速模式 10MB 上限 —— 设置 API Key 可解锁精准模式（200MB）",
    -30002: "快速模式不支持该文件类型 —— 请用 PDF/图片/Word/PPT/Excel",
    -30003: "页数超过快速模式 20 页上限 —— 设置 API Key 可解锁精准模式（200 页）",
    -30004: "请求参数无效 —— 请检查必填字段",
}

# Agent API 业务码中可通过升级到 Standard 恢复的集合
AGENT_ESCALATABLE = {-30001, -30003}

# 任务终态
STATE_DONE = "done"
STATE_FAILED = "failed"

# 任务中间态（用于轮询判定）
PENDING_STATES = {"pending", "running", "converting", "uploading", "waiting-file"}


class MinerUError(Exception):
    """API 返回非零业务码或不可恢复错误。"""

    def __init__(self, message: str, code=None):
        super().__init__(message)
        self.code = code


def trace(message: str) -> None:
    """阶段日志：打到 stderr（供调用方重定向到 log 文件做进度展示）。"""
    print("[mineru] " + message, file=sys.stderr, flush=True)


def _hint_for(code) -> str:
    return ERROR_HINTS.get(code, "未知错误码 %r" % (code,))


# --------------------------------------------------------------------------- #
# 结果与选项
# --------------------------------------------------------------------------- #
@dataclass
class ParseOptions:
    model: str = "vlm"
    language: str = "ch"
    is_ocr: bool = False
    enable_formula: bool = True
    enable_table: bool = True
    page_ranges: Optional[str] = None
    extra_formats: Tuple[str, ...] = ()


@dataclass
class ParseResult:
    name: str
    source: str
    api: str = "agent"
    modality: str = "unknown"
    state: str = STATE_FAILED
    output_dir: Optional[str] = None
    markdown_path: Optional[str] = None
    task_id: Optional[str] = None
    elapsed: Optional[float] = None
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "source": self.source,
            "api": self.api,
            "modality": self.modality,
            "state": self.state,
            "output_dir": self.output_dir,
            "markdown_path": self.markdown_path,
            "task_id": self.task_id,
            "elapsed": self.elapsed,
            "error": self.error,
        }


# --------------------------------------------------------------------------- #
# 纯函数助手
# --------------------------------------------------------------------------- #
def is_url(value: str) -> bool:
    return value.startswith("http://") or value.startswith("https://")


def safe_stem(source: str) -> str:
    """从文件路径或 URL 推导干净输出目录名。"""
    tail = source.split("?", 1)[0].rstrip("/")
    name = tail.rsplit("/", 1)[-1] if is_url(source) else Path(source).name
    stem = Path(name).stem or "document"
    return stem


def safe_data_id(stem: str) -> str:
    """官方要求 data_id 为 [A-Za-z0-9_.-]（ASCII），<=128 字符。"""
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", stem)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_.")
    if not cleaned:
        cleaned = "document"
    if not cleaned[0].isalnum():
        cleaned = "doc_" + cleaned
    return cleaned[:128]


def suffix_of(source: str) -> str:
    path = source.split("?", 1)[0]
    return Path(path).suffix.lower()


def modality_of(source: str) -> str:
    suf = suffix_of(source)
    for group, suffixes in MODALITY_SUFFIXES.items():
        if suf in suffixes:
            return group
    return "unknown"


def choose_api(
    token: Optional[str],
    source: str,
    size_bytes: Optional[int],
    extra_formats: Tuple[str, ...],
    explicit: str = "auto",
) -> str:
    """决定后端。explicit 为 'agent'/'standard' 时强制。"""
    if explicit in ("agent", "standard"):
        return explicit
    if suffix_of(source) == ".html":  # HTML 仅 Standard 支持（MinerU-HTML 模型）
        return "standard"
    if not token:
        return "agent"
    if extra_formats:
        return "standard"
    if size_bytes is not None and size_bytes > AGENT_MAX_BYTES:
        return "standard"
    return "agent"


def file_size(path: str) -> Optional[int]:
    try:
        return Path(path).stat().st_size
    except OSError:
        return None


# --------------------------------------------------------------------------- #
# HTTP 层（http.client，自带重试与重定向；http/https 双协议）
# --------------------------------------------------------------------------- #
def _url_parts(url: str) -> Tuple[str, str, int, str]:
    parts = urllib.parse.urlsplit(url)
    scheme = (parts.scheme or "https").lower()
    host = parts.netloc
    if ":" in host and not host.startswith("["):
        hostname, _, port_str = host.rpartition(":")
        if port_str.isdigit():
            host, port = hostname, int(port_str)
        else:
            port = 443 if scheme == "https" else 80
    else:
        port = 443 if scheme == "https" else 80
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return scheme, host, port, path


def _request_once(
    method: str,
    url: str,
    data: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = REQUEST_TIMEOUT,
) -> Tuple[int, Dict[str, str], bytes]:
    scheme, host, port, path = _url_parts(url)
    if scheme == "http":
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
    else:
        conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ssl.create_default_context())
    try:
        conn.request(method, path, body=data, headers=headers or {})
        resp = conn.getresponse()
        status = resp.status
        resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        body = resp.read()
        return status, resp_headers, body
    finally:
        conn.close()


def _request(
    method: str,
    url: str,
    data: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = REQUEST_TIMEOUT,
) -> Tuple[int, Dict[str, str], bytes]:
    """带瞬时状态重试（指数退避）与重定向跟随的请求。"""
    attempt = 0
    current_url = url
    while True:
        attempt += 1
        status, resp_headers, body = _request_once(method, current_url, data, headers, timeout)
        if status in (301, 302, 303, 307, 308) and attempt <= MAX_REDIRECTS:
            location = resp_headers.get("location")
            if location:
                current_url = urllib.parse.urljoin(current_url, location)
                continue
        if status in RETRY_STATUSES and attempt < RETRY_MAX_ATTEMPTS:
            delay = min(RETRY_BASE_DELAY * (2 ** (attempt - 1)), RETRY_MAX_DELAY)
            time.sleep(delay)
            continue
        return status, resp_headers, body


def _download(url: str, timeout: float = DOWNLOAD_TIMEOUT) -> bytes:
    """下载字节并做瞬时错误重试。"""
    host = urllib.parse.urlsplit(url).netloc
    trace("download: GET from %s" % host)
    attempt = 0
    while True:
        attempt += 1
        try:
            status, _, body = _request("GET", url, timeout=timeout)
            if status == 200:
                return body
            if status in RETRY_STATUSES and attempt < RETRY_MAX_ATTEMPTS:
                time.sleep(min(RETRY_BASE_DELAY * (2 ** (attempt - 1)), RETRY_MAX_DELAY))
                continue
            raise MinerUError("下载失败：HTTP %s (%s)" % (status, url))
        except (http.client.HTTPException, OSError) as exc:
            if attempt < RETRY_MAX_ATTEMPTS:
                time.sleep(min(RETRY_BASE_DELAY * (2 ** (attempt - 1)), RETRY_MAX_DELAY))
                continue
            raise MinerUError("下载失败：%s" % (exc,))


def _api_json(
    method: str,
    url: str,
    payload: Optional[dict] = None,
    token: Optional[str] = None,
    timeout: float = REQUEST_TIMEOUT,
) -> dict:
    """调用 JSON 接口，解析两类响应信封：
    业务层  {"code":0,"data":{...},"msg":"ok"}
    网关层  {"success":false,"msgCode":"A0202","msg":"user authenticate failed"}
    """
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    status, _, body = _request(method, url, data=data, headers=headers, timeout=timeout)
    try:
        parsed = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, UnicodeDecodeError):
        raise MinerUError("接口返回非 JSON（HTTP %s）" % status)
    if not isinstance(parsed, dict):
        raise MinerUError("接口返回结构异常（HTTP %s）" % status)
    if parsed.get("success") is False:
        code = parsed.get("msgCode")
        raise MinerUError(_hint_for(code), code=code)
    code = parsed.get("code")
    if code not in (None, 0):
        msg = parsed.get("msg") or _hint_for(code)
        raise MinerUError(str(msg), code=code)
    return parsed


def _put_file(upload_url: str, path: str) -> None:
    """把本地文件 PUT 到预签名上传地址（不带 Content-Type）。"""
    host = urllib.parse.urlsplit(upload_url).netloc
    trace("upload: PUT to %s" % host)
    with open(path, "rb") as fh:
        data = fh.read()
    headers = {"User-Agent": USER_AGENT, "Content-Length": str(len(data))}
    attempt = 0
    while True:
        attempt += 1
        try:
            status, _, _ = _request("PUT", upload_url, data=data, headers=headers, timeout=DOWNLOAD_TIMEOUT)
            if status in (200, 201, 204):
                return
            if status in RETRY_STATUSES and attempt < RETRY_MAX_ATTEMPTS:
                time.sleep(min(RETRY_BASE_DELAY * (2 ** (attempt - 1)), RETRY_MAX_DELAY))
                continue
            raise MinerUError("上传失败：HTTP %s" % status)
        except (http.client.HTTPException, OSError) as exc:
            if attempt < RETRY_MAX_ATTEMPTS:
                time.sleep(min(RETRY_BASE_DELAY * (2 ** (attempt - 1)), RETRY_MAX_DELAY))
                continue
            raise MinerUError("上传失败：%s" % (exc,))


# --------------------------------------------------------------------------- #
# 快速模式：Agent API
# --------------------------------------------------------------------------- #
def _agent_payload(opts: ParseOptions) -> dict:
    payload = {
        "language": opts.language,
        "enable_formula": opts.enable_formula,
        "enable_table": opts.enable_table,
        "is_ocr": opts.is_ocr,
    }
    if opts.page_ranges:
        # Agent API 仅接受 from-to 或单页，不接受逗号列表
        payload["page_range"] = opts.page_ranges
    return payload


def _agent_submit(source: str, opts: ParseOptions, base: str) -> Tuple[str, Optional[str]]:
    """提交任务；返回 (task_id, file_url)。file_url 仅在本地文件时返回。"""
    if is_url(source):
        payload = _agent_payload(opts)
        payload["url"] = source
        resp = _api_json("POST", base + "/parse/url", payload=payload)
        task_id = resp["data"]["task_id"]
        return task_id, None
    payload = {"file_name": Path(source).name, "language": opts.language}
    resp = _api_json("POST", base + "/parse/file", payload=payload)
    data = resp["data"]
    return data["task_id"], data.get("file_url")


def _agent_poll(base: str, task_id: str, deadline: float) -> str:
    """轮询直到终态；返回 markdown_url。"""
    interval = DEFAULT_POLL_INTERVAL
    last_state = None
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise MinerUError("解析超时（排队/解析耗时超过预算，可用 --timeout 加大预算后重试）")
        resp = _api_json("GET", base + "/parse/" + urllib.parse.quote(task_id))
        data = resp["data"]
        state = data.get("state")
        if state != last_state:
            trace("agent: poll state=%s" % state)
            last_state = state
        if state == STATE_DONE:
            url = data.get("markdown_url")
            if not url:
                raise MinerUError("任务完成但缺少 markdown_url")
            return url
        if state == STATE_FAILED:
            raise MinerUError("解析失败：%s" % (data.get("err_msg") or "未知原因"))
        time.sleep(min(interval, remaining))
        interval = min(interval * 1.5, POLL_INTERVAL_CAP)


def agent_parse(
    source: str, opts: ParseOptions, out_dir: Path, base: str, deadline: float
) -> dict:
    """快速模式完整流程：提交 -> 上传（如需）-> 轮询 -> 下载 Markdown。"""
    stem = safe_stem(source)
    task_id, file_url = _agent_submit(source, opts, base)
    trace("agent: submitted task=%s" % task_id)
    if file_url:
        _put_file(file_url, source)
        trace("agent: file uploaded")
    markdown_url = _agent_poll(base, task_id, deadline)
    trace("agent: parsing done, downloading markdown")
    md_text = _download(markdown_url).decode("utf-8", errors="replace")
    target_dir = out_dir / stem
    target_dir.mkdir(parents=True, exist_ok=True)
    md_path = target_dir / (stem + ".md")
    md_path.write_text(md_text, encoding="utf-8")
    trace("agent: markdown written to %s" % md_path)
    return {
        "state": STATE_DONE,
        "markdown_path": str(md_path),
        "output_dir": str(target_dir),
        "task_id": task_id,
    }


# --------------------------------------------------------------------------- #
# 精准模式：Standard API
# --------------------------------------------------------------------------- #
def _standard_options_payload(opts: ParseOptions) -> dict:
    payload = {
        "is_ocr": opts.is_ocr,
        "enable_formula": opts.enable_formula,
        "enable_table": opts.enable_table,
        "language": opts.language,
    }
    if opts.page_ranges:
        payload["page_ranges"] = opts.page_ranges
    if opts.extra_formats:
        payload["extra_formats"] = list(opts.extra_formats)
    return payload


def _standard_submit_and_poll(
    source: str, opts: ParseOptions, token: str, base: str, deadline: float
) -> bytes:
    """提交任务并轮询到 done，返回 zip 字节。"""
    model_version = opts.model
    if is_url(source):
        payload = _standard_options_payload(opts)
        payload["url"] = source
        payload["model_version"] = model_version
        resp = _api_json("POST", base + "/extract/task", payload=payload, token=token)
        task_id = resp["data"]["task_id"]
        trace("standard: submitted url task=%s" % task_id)
        return _standard_poll_task(base, task_id, token, deadline)
    # 本地文件：预签名上传 + 批量任务
    stem = safe_stem(source)
    data_id = safe_data_id(stem)
    resp = _api_json(
        "POST",
        base + "/file-urls/batch",
        payload={"files": [{"name": Path(source).name, "data_id": data_id}], "model_version": model_version},
        token=token,
    )
    data = resp["data"]
    batch_id = data["batch_id"]
    file_urls = data["file_urls"]
    if not file_urls:
        raise MinerUError("未取得上传地址")
    trace("standard: batch=%s, uploading file" % batch_id)
    _put_file(file_urls[0], source)
    trace("standard: file uploaded, submitting extract task")
    task_payload = _standard_options_payload(opts)
    task_payload["files"] = [{"url": file_urls[0], "data_id": data_id}]
    task_payload["model_version"] = model_version
    _api_json("POST", base + "/extract/task/batch", payload=task_payload, token=token)
    trace("standard: extract task submitted, polling")
    return _standard_poll_batch(base, batch_id, token, deadline)


def _standard_poll_task(base: str, task_id: str, token: str, deadline: float) -> bytes:
    interval = DEFAULT_POLL_INTERVAL
    last_state = None
    while True:
        if time.time() > deadline:
            raise MinerUError("解析超时（排队/解析耗时超过预算，可用 --timeout 加大预算后重试）")
        resp = _api_json("GET", base + "/extract/task/" + urllib.parse.quote(task_id), token=token)
        data = resp["data"]
        state = data.get("state")
        if state != last_state:
            trace("standard: poll state=%s" % state)
            last_state = state
        if state == STATE_DONE:
            url = data.get("full_zip_url")
            if not url:
                raise MinerUError("任务完成但缺少 full_zip_url")
            return _download(url)
        if state == STATE_FAILED:
            raise MinerUError("解析失败：%s" % (data.get("err_msg") or "未知原因"))
        time.sleep(interval)
        interval = min(interval * 1.5, POLL_INTERVAL_CAP)


def _standard_poll_batch(base: str, batch_id: str, token: str, deadline: float) -> bytes:
    interval = DEFAULT_POLL_INTERVAL
    last_state = None
    while True:
        if time.time() > deadline:
            raise MinerUError("解析超时（排队/解析耗时超过预算，可用 --timeout 加大预算后重试）")
        resp = _api_json("GET", base + "/extract-results/batch/" + urllib.parse.quote(batch_id), token=token)
        results = resp["data"].get("extract_result") or []
        if not results:
            raise MinerUError("批量任务缺少结果条目")
        item = results[0]
        state = item.get("state")
        if state != last_state:
            trace("standard: poll state=%s" % state)
            last_state = state
        if state == STATE_DONE:
            url = item.get("full_zip_url")
            if not url:
                raise MinerUError("任务完成但缺少 full_zip_url")
            return _download(url)
        if state == STATE_FAILED:
            raise MinerUError("解析失败：%s" % (item.get("err_msg") or "未知原因"))
        time.sleep(interval)
        interval = min(interval * 1.5, POLL_INTERVAL_CAP)


# --------------------------------------------------------------------------- #
# zip 安全解压
# --------------------------------------------------------------------------- #
def _extract_zip_safe(zip_bytes: bytes, target_dir: Path, stem: str) -> Path:
    """安全解压：拒绝绝对路径/路径穿越/超大合计；返回 Markdown 路径。"""
    target_dir.mkdir(parents=True, exist_ok=True)
    target_abs = target_dir.resolve()
    total = 0
    md_candidates = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            name = info.filename
            if name.startswith("/") or name.startswith("\\") or ".." in Path(name).parts:
                raise MinerUError("zip 包含非法路径，已拒绝解压")
            total += info.file_size
            if total > ZIP_MAX_TOTAL:
                raise MinerUError("zip 解压总大小超过 1GB 上限")
            dest = (target_abs / name).resolve()
            if not str(dest).startswith(str(target_abs) + os.sep) and dest != target_abs:
                raise MinerUError("zip 路径越界，已拒绝解压")
            if info.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(info))
            if name.endswith(".md"):
                md_candidates.append(dest)
    if not md_candidates:
        raise MinerUError("zip 中未找到 Markdown 文件")
    # 优先 stem 同名，其次路径最短者
    best = None
    for cand in md_candidates:
        if cand.stem == stem:
            best = cand
            break
    if best is None:
        best = sorted(md_candidates, key=lambda p: len(p.parts))[0]
    return best


def standard_parse(
    source: str, opts: ParseOptions, out_dir: Path, token: str, base: str, deadline: float
) -> dict:
    """精准模式完整流程：提交 -> 上传（如需）-> 轮询 -> 下载 zip -> 安全解压。"""
    stem = safe_stem(source)
    zip_bytes = _standard_submit_and_poll(source, opts, token, base, deadline)
    md_path = _extract_zip_safe(zip_bytes, out_dir / stem, stem)
    return {
        "state": STATE_DONE,
        "markdown_path": str(md_path),
        "output_dir": str(out_dir / stem),
        "task_id": None,
    }


# --------------------------------------------------------------------------- #
# 单个输入的处理（路由 + 升级）
# --------------------------------------------------------------------------- #
def process_one(
    source: str,
    opts: ParseOptions,
    out_dir: Path,
    token: Optional[str],
    api: str,
    budget: int = PARSE_BUDGET,
) -> ParseResult:
    result = ParseResult(name=safe_stem(source), source=source, modality=modality_of(source))
    started = time.time()
    deadline = started + max(int(budget), PARSE_BUDGET_MIN)
    size = file_size(source) if not is_url(source) else None
    chosen = choose_api(token, source, size, opts.extra_formats, explicit=api)
    try:
        if modality_of(source) == "unknown":
            raise MinerUError("不支持的文件格式：%s" % source)
        if chosen == "agent":
            result.api = "agent"
            agent_base = os.environ.get("MINERU_API_AGENT", DEFAULT_AGENT_API)
            try:
                info = agent_parse(source, opts, out_dir, agent_base, deadline)
                result.state = info["state"]
                result.markdown_path = info["markdown_path"]
                result.output_dir = info["output_dir"]
                result.task_id = info["task_id"]
            except MinerUError as exc:
                # 快速模式超限且持有 Token -> 自动升级精准模式
                if token and exc.code in AGENT_ESCALATABLE:
                    trace("agent: limit hit (code=%s), upgrading to standard" % exc.code)
                    result.api = "standard"
                    std_base = os.environ.get("MINERU_API_STANDARD", DEFAULT_STANDARD_API)
                    info = standard_parse(source, opts, out_dir, token, std_base, deadline)
                    result.state = info["state"]
                    result.markdown_path = info["markdown_path"]
                    result.output_dir = info["output_dir"]
                else:
                    raise
        else:
            result.api = "standard"
            std_base = os.environ.get("MINERU_API_STANDARD", DEFAULT_STANDARD_API)
            info = standard_parse(source, opts, out_dir, token or "", std_base, deadline)
            result.state = info["state"]
            result.markdown_path = info["markdown_path"]
            result.output_dir = info["output_dir"]
    except MinerUError as exc:
        result.state = STATE_FAILED
        result.error = str(exc)
    except (OSError, ValueError) as exc:
        result.state = STATE_FAILED
        result.error = "%s: %s" % (type(exc).__name__, exc)
    except Exception as exc:  # noqa: BLE001 —— 意外响应结构等兜底，绝不让单个输入崩掉整批
        result.state = STATE_FAILED
        result.error = "意外错误 %s: %s" % (type(exc).__name__, exc)
    result.elapsed = round(time.time() - started, 2)
    return result


# --------------------------------------------------------------------------- #
# doctor：环境自检
# --------------------------------------------------------------------------- #
def _check_network() -> Tuple[bool, str]:
    try:
        status, _, _ = _request("GET", "https://mineru.net/", timeout=8)
        return True, "reachable (HTTP %s)" % status
    except Exception as exc:  # noqa: BLE001
        return False, "unreachable (%s)" % type(exc).__name__


def _check_token(token: str, base: str) -> Tuple[bool, str]:
    try:
        _api_json("POST", base + "/extract/task", payload={}, token=token, timeout=20)
        return True, "accepted"
    except MinerUError as exc:
        if exc.code in ("A0202", "A0211"):
            return False, "invalid/expired (%s)" % (exc.code,)
        return True, "accepted (空 payload 的参数报错属预期，说明鉴权通过)"
    except Exception as exc:  # noqa: BLE001
        return False, "check failed (%s)" % type(exc).__name__


def doctor(as_json: bool = False) -> int:
    import platform

    py_ok = sys.version_info >= (3, 8)
    net_ok, net_detail = _check_network()
    token = os.environ.get("MINERU_TOKEN")
    std_base = os.environ.get("MINERU_API_STANDARD", DEFAULT_STANDARD_API)
    if not token:
        tok_ok, tok_detail = True, "not set (Agent 快速模式免 Token)"
    else:
        tok_ok, tok_detail = _check_token(token, std_base)

    report = {
        "version": __version__,
        "python": {"ok": py_ok, "detail": platform.python_version()},
        "network": {"ok": net_ok, "detail": net_detail},
        "token": {"ok": tok_ok, "detail": tok_detail},
        "healthy": bool(py_ok and net_ok and tok_ok),
    }
    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        mark = lambda ok: "[OK]  " if ok else "[FAIL]"
        print("MinerU client doctor (v%s)" % __version__)
        print("  %s Python      %s" % (mark(py_ok), report["python"]["detail"]))
        print("  %s MinerU API  %s" % (mark(net_ok), net_detail))
        print("  %s Token       %s" % (mark(tok_ok), tok_detail))
        print("  healthy: %s" % ("yes" if report["healthy"] else "no"))
    return 0 if report["healthy"] else 1


# --------------------------------------------------------------------------- #
# selftest：离线单元自检（不联网）
# --------------------------------------------------------------------------- #
def selftest() -> int:
    failures = []

    def check(name: str, cond: bool) -> None:
        if not cond:
            failures.append(name)

    # safe_stem
    check("stem: file", safe_stem(r"C:\a\paper.pdf") == "paper")
    check("stem: url", safe_stem("https://h/x/y/doc.pdf?t=1") == "doc")
    check("stem: empty", safe_stem("") == "document")
    # safe_data_id
    check("data_id: clean", safe_data_id("论文 2024") == "2024")
    check("data_id: alnum", safe_data_id("abc-1.2_x") == "abc-1.2_x")
    # modality
    check("modality: pdf", modality_of("a.PDF") == "pdf")
    check("modality: image", modality_of("a.png") == "image")
    check("modality: unknown", modality_of("a.exe") == "unknown")
    # choose_api
    check("route: no token -> agent", choose_api(None, "a.pdf", 1000, ()) == "agent")
    check("route: token small -> agent", choose_api("t", "a.pdf", 1000, ()) == "agent")
    check("route: token big -> standard", choose_api("t", "a.pdf", 11 * 1024 * 1024, ()) == "standard")
    check("route: token formats -> standard", choose_api("t", "a.pdf", 1000, ("docx",)) == "standard")
    check("route: html -> standard", choose_api(None, "a.html", 100, ()) == "standard")
    check("route: explicit standard", choose_api(None, "a.pdf", 1000, (), "standard") == "standard")
    check("route: explicit agent", choose_api("t", "a.pdf", 10 ** 9, (), "agent") == "agent")
    # zip 安全
    evil = io.BytesIO()
    with zipfile.ZipFile(evil, "w") as zf:
        zf.writestr("../evil.md", "x")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            _extract_zip_safe(evil.getvalue(), Path(tmp) / "out", "doc")
        failures.append("zip: path traversal not rejected")
    except MinerUError:
        pass

    good = io.BytesIO()
    with zipfile.ZipFile(good, "w") as zf:
        zf.writestr("doc.md", "# hi")
        zf.writestr("images/a.png", b"png")
    with tempfile.TemporaryDirectory() as tmp:
        md = _extract_zip_safe(good.getvalue(), Path(tmp) / "out", "doc")
        check("zip: md found", md.name == "doc.md")
        check("zip: images kept", (Path(tmp) / "out" / "images" / "a.png").exists())

    if failures:
        print("[FAIL] %d 项自检失败：" % len(failures))
        for name in failures:
            print("  - " + name)
        return 1
    print("[OK] selftest passed")
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mineru",
        description="MinerU 文档解析客户端（自研，双模式 + 自动路由）",
    )
    parser.add_argument("input", nargs="?", help="文件路径或 URL（可给目录，按序处理）")
    parser.add_argument("--version", action="store_true", help="打印版本并退出")
    parser.add_argument("--doctor", action="store_true", help="环境自检（网络/Token）并退出")
    parser.add_argument("--selftest", action="store_true", help="离线单元自检并退出")
    parser.add_argument("--json", dest="as_json", action="store_true", help="机器可读状态打到 stdout")
    parser.add_argument("--stdout", dest="to_stdout", action="store_true", help="Markdown 打到 stdout")
    parser.add_argument("-o", "--output", default=".mineru/out", help="输出目录（默认 .mineru/out）")
    parser.add_argument("--api", choices=["auto", "agent", "standard"], default="auto",
                        help="auto=自动路由；agent=强制快速模式；standard=强制精准模式")
    parser.add_argument("--model", choices=["pipeline", "vlm"], default="vlm",
                        help="精准模式模型（默认 vlm）")
    parser.add_argument("--lang", default="ch", help="语言（默认 ch）")
    parser.add_argument("--ocr", action="store_true", help="扫描件 OCR")
    parser.add_argument("--pages", help="页码范围，如 1-10 或 2,4-6")
    parser.add_argument("--formats", nargs="*", choices=["docx", "html", "latex"], default=[],
                        help="额外导出格式（仅精准模式，可多个）")
    parser.add_argument("--timeout", type=int, default=PARSE_BUDGET,
                        help="单个输入的总时间预算（秒，默认 %d；免费队列拥堵时任务可能排队很久）" % PARSE_BUDGET)
    parser.add_argument("--quiet", action="store_true", help="少打印过程日志")
    return parser


def _log(message: str, quiet: bool) -> None:
    if not quiet:
        print(message, file=sys.stderr, flush=True)


def _expand_inputs(raw_input: str) -> List[str]:
    path = Path(raw_input)
    if is_url(raw_input) or path.is_file():
        return [raw_input]
    if path.is_dir():
        items = sorted(
            str(p) for p in path.iterdir()
            if p.is_file() and p.suffix.lower() in SUPPORTED_SUFFIXES
        )
        if not items:
            raise MinerUError("目录中没有支持的文件：%s" % raw_input)
        return items
    raise MinerUError("输入不存在：%s" % raw_input)


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.version:
        print(__version__)
        return 0
    if args.doctor:
        return doctor(as_json=args.as_json)
    if args.selftest:
        return selftest()
    if not args.input:
        print("缺少输入。用 --help 查看用法。", file=sys.stderr)
        return 2

    token = os.environ.get("MINERU_TOKEN")
    out_dir = Path(args.output)
    opts = ParseOptions(
        model=args.model,
        language=args.lang,
        is_ocr=args.ocr,
        page_ranges=args.pages,
        extra_formats=tuple(args.formats or []),
    )
    try:
        sources = _expand_inputs(args.input)
    except MinerUError as exc:
        print("输入错误：%s" % exc, file=sys.stderr)
        return 2

    results = []
    for source in sources:
        _log("== 解析 %s（api=%s，timeout=%ds）==" % (source, args.api, max(args.timeout, PARSE_BUDGET_MIN)), args.quiet)
        result = process_one(source, opts, out_dir, token, args.api, budget=args.timeout)
        results.append(result)
        if result.state == STATE_DONE:
            _log("[OK]   %s -> %s（%.1fs，api=%s）" % (result.name, result.markdown_path, result.elapsed, result.api), args.quiet)
        else:
            _log("[FAIL] %s：%s" % (result.name, result.error), args.quiet)

    if args.as_json:
        print(json.dumps({
            "total": len(results),
            "done": sum(1 for r in results if r.state == STATE_DONE),
            "failed": sum(1 for r in results if r.state != STATE_DONE),
            "results": [r.to_dict() for r in results],
        }, ensure_ascii=False, indent=2))
    elif args.to_stdout:
        for r in results:
            if r.state == STATE_DONE and r.markdown_path:
                try:
                    print(Path(r.markdown_path).read_text(encoding="utf-8"))
                except OSError as exc:
                    print("读取 Markdown 失败：%s" % exc, file=sys.stderr)
    return 0 if all(r.state == STATE_DONE for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
