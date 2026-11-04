#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""无限画布静态站点服务器（零第三方依赖，Python 3.8+）。

- 托管 canvas/dist，所有前端路由回退到 index.html（React Router）。
- 动态生成 /config.js：把 .env 里的 Muse 地址/Key 和
  agent/.infinite-canvas/canvas-agent.json 里的 Agent 地址/Token 注入浏览器配置。
  Agent 的地址和 Token 只认这个 JSON 文件，不读环境变量。
"""
from __future__ import annotations

import json
import mimetypes
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

BASE_DIR = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("CANVAS_ROOT") or BASE_DIR / "canvas" / "dist").resolve()
AGENT_CONFIG = Path(os.environ.get("AGENT_CONFIG_FILE") or BASE_DIR / "agent" / ".infinite-canvas" / "canvas-agent.json")
HOST = os.environ.get("CANVAS_HOST", "0.0.0.0")
PORT = int(os.environ.get("CANVAS_PORT", "521"))

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("application/manifest+json", ".webmanifest")


def _agent_runtime() -> dict[str, str]:
    """Agent 地址/Token 的唯一来源：agent/.infinite-canvas/canvas-agent.json。"""
    try:
        data = json.loads(AGENT_CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    url = str(data.get("publicUrl") or data.get("public_url") or data.get("url") or "").strip().rstrip("/")
    token = str(data.get("token") or "").strip()
    payload: dict[str, str] = {}
    if url:
        payload["AGENT_URL"] = url
    if token:
        payload["AGENT_TOKEN"] = token
    return payload


def _runtime_config() -> str:
    payload: dict[str, str] = {}
    for key in ("ANALYTICS_GA4_ID", "ANALYTICS_BAIDU_ID", "MUSE_CHANNEL_NAME"):
        value = os.environ.get(key, "").strip()
        if value:
            payload[key] = value
    payload.update(_agent_runtime())
    base = os.environ.get("MUSE_API_BASE", "").strip().rstrip("/")
    if base:
        payload["MUSE_API_BASE"] = base
    key = os.environ.get("MUSE_API_KEY", "").strip()
    if key:
        payload["MUSE_API_KEY"] = key
    return (
        "window.__RUNTIME_CONFIG__ = Object.assign({}, window.__RUNTIME_CONFIG__, "
        + json.dumps(payload, ensure_ascii=False)
        + ");\n"
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "MuseCanvas/1.0"
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        self._serve(head_only=False)

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve(head_only=True)

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()

    def _send(self, status: int, body: bytes, content_type: str, cache: str, head_only: bool) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _serve(self, head_only: bool) -> None:
        path = unquote(urlsplit(self.path).path)
        try:
            if path == "/healthz":
                self._send(200, b"ok\n", "text/plain; charset=utf-8", "no-store", head_only)
                return
            if path == "/config.js":
                body = _runtime_config().encode("utf-8")
                self._send(200, body, "application/javascript; charset=utf-8", "no-store", head_only)
                return

            candidate = (ROOT / path.lstrip("/")).resolve()
            if candidate != ROOT and ROOT not in candidate.parents:
                self._send(403, b"forbidden\n", "text/plain; charset=utf-8", "no-store", head_only)
                return
            if candidate.is_dir():
                candidate = candidate / "index.html"
            if not candidate.is_file():
                # SPA 回退：/canvas/xxx、/image 等前端路由都交给 index.html
                candidate = ROOT / "index.html"
            if not candidate.is_file():
                self._send(503, "前端未构建：缺少 canvas/dist/index.html\n".encode("utf-8"),
                           "text/plain; charset=utf-8", "no-store", head_only)
                return

            body = candidate.read_bytes()
            content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in (
                "application/javascript", "application/json", "application/manifest+json",
            ):
                content_type += "; charset=utf-8"
            immutable = path.startswith("/assets/")
            cache = "public, max-age=31536000, immutable" if immutable else "no-cache"
            self._send(200, body, content_type, cache, head_only)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as exc:
            self._send(500, f"读取文件失败：{exc}\n".encode("utf-8"),
                       "text/plain; charset=utf-8", "no-store", head_only)


def main() -> None:
    if not (ROOT / "index.html").is_file():
        sys.stderr.write(f"[warn] {ROOT / 'index.html'} 不存在，请先构建前端或设置 CANVAS_ROOT\n")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True

    def stop(_signum, _frame) -> None:
        # shutdown() 会等待 serve_forever 退出，必须放到别的线程里调用。
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"[canvas] serving {ROOT} on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
