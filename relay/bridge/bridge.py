#!/usr/bin/env python3
"""Muse Relay — Mac bridge (stdlib only).

Chay tren Mac cua nguoi dung, phoi dung API OpenAI cua muse2api
(/v1/models, /v1/chat/completions, /v1/responses, /v1/images/generations,
/v1/images/edits, /v1/videos, /v1/videos/{id}) cho Canvas goi nhu cu —
Canvas KHONG sua mot dong nao. Bridge tu chuyen moi request thanh task
relay, poll relay toi khi xong, roi tra response dung dinh dang OpenAI.

    python3 relay/bridge/bridge.py [--env relay/bridge/.env]
                                   [--host 127.0.0.1] [--port 5522]

Chi dung thu vien chuan (urllib, http.server, json, base64, threading,
uuid, os, mimetypes, tempfile, http.client). Khong can pip install.

Cau hinh (file .env cung thu muc voi script, hoac bien moi truong —
bien moi truong thang .env):
    RELAY_URL         https://<relay>.onrender.com  (bat buoc)
    RELAY_CANVAS_KEY  khoa Canvas doc tu Render Dashboard (bat buoc)
    BRIDGE_HOST       mac dinh 127.0.0.1
    BRIDGE_PORT       mac dinh 5522

Bao mat:
  - Khoa cua Canvas gui len chi de bridge tu kiem tra (bat ky Bearer
    token nao khac rong cung duoc) — KHONG chuyen no len relay.
  - Bridge chi dung RELAY_CANVAS_KEY de goi relay. Khoa API noi bo cua
    muse2api va cookie Muse khong bao gio roi khoi may ao.
  - Khong bao gio in khoa ra log.
"""

from __future__ import annotations

import argparse
import base64
import http.client
import http.server
import json
import mimetypes
import os
import re
import signal
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Hang so
# ---------------------------------------------------------------------------

MODELS = [
    {"id": "muse-spark", "object": "model", "owned_by": "muse"},
    {"id": "muse-image", "object": "model", "owned_by": "muse"},
    {"id": "muse-video", "object": "model", "owned_by": "muse"},
]

# Timeout cho moi loai task (giay) — khop hop dong relay muc 3.4.
KIND_TIMEOUTS = {
    "chat": 300,
    "responses": 300,
    "image": 240,
    "image_edit": 240,
    "video": 600,
}

POLL_INTERVAL = 3.0        # giay giua cac lan hoi relay
MAX_RECREATES = 3          # so lan tao lai task khi relay tra 404 (mat task)
RELAY_HTTP_TIMEOUT = 30    # timeout moi lan goi HTTP len relay (giay)
MEDIA_HTTP_TIMEOUT = 300   # timeout khi tai media (file lon, mang cham)
RELAY_WAKE_DEADLINE = 120  # so giay toi da retry khi relay dang ngu (Render Free
                           # mat 30-60s de danh thuc); tao task co
                           # idempotency_key nen retry POST la an toan
JOURNAL_MAX_TASKS = 200    # so task toi da giu trong journal local
MAX_JSON_BODY = 32 * 1024 * 1024       # 32 MB cho body JSON
MAX_MULTIPART_TOTAL = 512 * 1024 * 1024  # 512 MB cho body multipart
MAX_TEXT_FIELD = 4 * 1024 * 1024       # 4 MB cho mot field text trong form
CHUNK = 65536


class BridgeError(Exception):
    """Loi tra ve cho Canvas (HTTP status + message)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class RelayError(Exception):
    """Loi khi goi relay (da co HTTP status cua relay neu co)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status
        self.message = message


def log(msg: str) -> None:
    """Ghi log ra stdout: timestamp, noi dung. Khong bao gio in secret."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Cau hinh
# ---------------------------------------------------------------------------

def _parse_env_file(path: str) -> dict:
    values: dict = {}
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            values[key] = val
    return values


class Config:
    def __init__(self, env_path: str | None, host: str | None,
                 port: int | None, data_dir: str | None = None,
                 parent_pid: int | None = None,
                 ready_file: str | None = None):
        values: dict = {}
        if env_path and os.path.exists(env_path):
            values.update(_parse_env_file(env_path))
        # Bien moi truong thang file .env.
        for key in ("RELAY_URL", "RELAY_CANVAS_KEY", "BRIDGE_HOST",
                    "BRIDGE_PORT", "BRIDGE_DATA_DIR", "BRIDGE_PARENT_PID",
                    "BRIDGE_READY_FILE"):
            if os.environ.get(key):
                values[key] = os.environ[key]
        # Co tham so dong lenh thang ca hai.
        if host:
            values["BRIDGE_HOST"] = host
        if port is not None:
            values["BRIDGE_PORT"] = str(port)
        if data_dir:
            values["BRIDGE_DATA_DIR"] = data_dir
        if parent_pid is not None:
            values["BRIDGE_PARENT_PID"] = str(parent_pid)
        if ready_file:
            values["BRIDGE_READY_FILE"] = ready_file

        relay_url = (values.get("RELAY_URL") or "").strip().rstrip("/")
        if not relay_url or not relay_url.startswith(("http://", "https://")):
            raise SystemExit("Thieu RELAY_URL hop le (vd: https://<relay>.onrender.com). "
                             "Dat trong relay/bridge/.env hoac bien moi truong.")
        canvas_key = (values.get("RELAY_CANVAS_KEY") or "").strip()
        if not canvas_key:
            raise SystemExit("Thieu RELAY_CANVAS_KEY (doc tu Render Dashboard → "
                             "Environment). Dat trong relay/bridge/.env hoac bien moi truong.")
        self.relay_url = relay_url
        self.canvas_key = canvas_key
        self.host = (values.get("BRIDGE_HOST") or "127.0.0.1").strip()
        try:
            self.port = int(values.get("BRIDGE_PORT") or 5522)
        except ValueError:
            raise SystemExit("BRIDGE_PORT phai la so cong.")
        if not 0 <= self.port <= 65535:
            raise SystemExit("BRIDGE_PORT phai trong khoang 0-65535 "
                             "(0 = he dieu hanh chon cong trong).")
        # Thu muc du lieu: mac dinh la thu muc chua script (khi dong goi
        # thanh app, truyen --data-dir toi Application Support cua app).
        # Khong dung duong dan tuyet doi cung, khong dung CWD.
        script_dir = os.path.dirname(os.path.abspath(__file__))
        self.data_dir = (values.get("BRIDGE_DATA_DIR") or script_dir).strip()
        try:
            self.parent_pid = int(values.get("BRIDGE_PARENT_PID") or 0) or None
        except ValueError:
            raise SystemExit("BRIDGE_PARENT_PID phai la so PID.")
        self.ready_file = (values.get("BRIDGE_READY_FILE") or "").strip() or None


# ---------------------------------------------------------------------------
# Journal task local — de app mo lai co the truy van / khoi phuc task
# ---------------------------------------------------------------------------

class TaskJournal:
    """Ghi lai task bridge da gui len relay (chi id/kind/trang thai —
    khong luu prompt, khong luu secret). File nam trong data_dir de app
    dong goi co the chi toi Application Support cua no."""

    def __init__(self, data_dir: str):
        self.path = os.path.join(data_dir, "bridge-tasks.json")
        self._lock = threading.Lock()
        self._tasks: dict[str, dict] = {}
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and item.get("task_id"):
                        self._tasks[item["task_id"]] = item
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            items = sorted(self._tasks.values(),
                           key=lambda t: t.get("created_at", 0),
                           reverse=True)[:JOURNAL_MAX_TASKS]
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(items, f, ensure_ascii=False)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def record(self, task_id: str, kind: str, model: str) -> None:
        with self._lock:
            now = int(time.time())
            self._tasks[task_id] = {
                "task_id": task_id, "kind": kind, "model": model,
                "status": "submitted",
                "created_at": now, "updated_at": now,
            }
            self._save()

    def update(self, task_id: str, status: str) -> None:
        with self._lock:
            entry = self._tasks.get(task_id)
            if entry is None:
                return
            entry["status"] = status
            entry["updated_at"] = int(time.time())
            self._save()

    def all(self) -> list:
        with self._lock:
            return sorted(self._tasks.values(),
                          key=lambda t: t.get("created_at", 0), reverse=True)

    def get(self, task_id: str) -> dict | None:
        with self._lock:
            return self._tasks.get(task_id)


def _is_transient_relay_error(exc: Exception) -> bool:
    """Loi tam thoi dang retry: mang hong, relay dang ngu/dang khoi dong."""
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in (502, 503, 504)
    return isinstance(exc, (urllib.error.URLError, http.client.HTTPException,
                            OSError, TimeoutError, ConnectionError))


def _call_with_relay_retry(fn, what: str):
    """Chay fn(), retry khi gap loi tam thoi cho toi het RELAY_WAKE_DEADLINE
    (relay Free mat 30-60s de danh thuc sau khi ngu). Het han thi doi
    loi ket noi thanh RelayError de handler tra 502 sach se."""
    deadline = time.monotonic() + RELAY_WAKE_DEADLINE
    delay = 2.0
    attempt = 0
    while True:
        attempt += 1
        try:
            return fn()
        except Exception as exc:
            if not _is_transient_relay_error(exc) \
                    or time.monotonic() >= deadline:
                if _is_transient_relay_error(exc):
                    raise RelayError(f"Khong noi duoc relay ({what}): {exc}")
                raise
            log(f"relay {what} loi tam thoi ({exc}), thu lai sau {delay:.0f}s "
                f"(lan {attempt})")
            time.sleep(delay)
            delay = min(delay * 1.5 + 1, 30.0)


# ---------------------------------------------------------------------------
# Relay client (goi HTTPS len Render)
# ---------------------------------------------------------------------------

class RelayClient:
    def __init__(self, base_url: str, canvas_key: str,
                 journal: TaskJournal | None = None):
        self.base_url = base_url
        self.key = canvas_key
        self.journal = journal

    def health_check(self, timeout: float = 5.0) -> bool:
        """Kiem tra relay co song khong (chi de log luc khoi dong —
        relay ngu thi van khoi dong bridge binh thuong)."""
        try:
            req = urllib.request.Request(self.base_url + "/healthz",
                                         method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status == 200
        except Exception:
            return False

    def _headers(self, content_type: str | None = None) -> dict:
        headers = {"Authorization": "Bearer " + self.key}
        if content_type:
            headers["Content-Type"] = content_type
        return headers

    def _read_error(self, err: urllib.error.HTTPError) -> str:
        try:
            raw = err.read().decode("utf-8", "replace")
            data = json.loads(raw)
            if isinstance(data, dict):
                if isinstance(data.get("error"), dict):
                    return str(data["error"].get("message") or raw)[:300]
                if data.get("detail"):
                    return str(data["detail"])[:300]
            return raw[:300] or f"HTTP {err.code}"
        except Exception:
            return f"HTTP {err.code}"

    def create_task_json(self, kind: str, model: str,
                         task_input: dict, idempotency_key: str) -> dict:
        """POST /v1/tasks (JSON). Tra ve dict task (co task_id)."""
        body = json.dumps({
            "kind": kind,
            "model": model,
            "input": task_input,
            "idempotency_key": idempotency_key,
        }).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + "/v1/tasks", data=body, method="POST",
            headers=self._headers("application/json"))

        def _do():
            try:
                with urllib.request.urlopen(req, timeout=RELAY_HTTP_TIMEOUT) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                raise RelayError(f"Relay tu choi tao task: {self._read_error(e)}",
                                 status=e.code)
        result = _call_with_relay_retry(_do, "tao task")
        if self.journal and result.get("task_id"):
            self.journal.record(result["task_id"], kind, model)
        return result

    def create_task_multipart(self, kind: str, model: str,
                              task_input: dict, idempotency_key: str,
                              files: list) -> dict:
        """POST /v1/tasks (multipart): field `request` = JSON, file o `images`.

        `files`: list _SpoolFile. Stream tu dia, khong load file vao RAM.
        """
        request_json = json.dumps({
            "kind": kind,
            "model": model,
            "input": task_input,
            "idempotency_key": idempotency_key,
        }).encode("utf-8")
        boundary = "----bridge" + uuid.uuid4().hex
        parts: list = [(
            b'Content-Disposition: form-data; name="request"\r\n'
            b'Content-Type: application/json\r\n',
            request_json,
        )]
        for f in files:
            safe_name = re.sub(r'["\r\n\x00-\x1f]', "_", f.filename or "file")
            ctype = f.content_type or mimetypes.guess_type(safe_name)[0] \
                or "application/octet-stream"
            headers = (
                f'Content-Disposition: form-data; name="images"; '
                f'filename="{safe_name}"\r\n'
                f"Content-Type: {ctype}\r\n"
            ).encode("utf-8")
            parts.append((headers, f))
        body = _MultipartBody(boundary.encode("ascii"), parts)

        def _do():
            body.rewind()
            parsed = urllib.parse.urlparse(self.base_url)
            use_https = parsed.scheme == "https"
            port = parsed.port or (443 if use_https else 80)
            conn_cls = http.client.HTTPSConnection if use_https \
                else http.client.HTTPConnection
            conn = conn_cls(parsed.hostname, port, timeout=RELAY_HTTP_TIMEOUT)
            try:
                conn.putrequest("POST", (parsed.path or "") + "/v1/tasks")
                conn.putheader("Content-Type",
                               f"multipart/form-data; boundary={boundary}")
                conn.putheader("Content-Length", str(body.total))
                conn.putheader("Authorization", "Bearer " + self.key)
                conn.endheaders()
                while True:
                    chunk = body.read(CHUNK)
                    if not chunk:
                        break
                    conn.send(chunk)
                resp = conn.getresponse()
                raw = resp.read()
                if resp.status not in (200, 201, 202):
                    raise RelayError(
                        f"Relay tu choi tao task (HTTP {resp.status}): "
                        f"{raw.decode('utf-8', 'replace')[:300]}",
                        status=resp.status)
                return json.loads(raw.decode("utf-8"))
            finally:
                conn.close()

        result = _call_with_relay_retry(_do, "tao task (multipart)")
        if self.journal and result.get("task_id"):
            self.journal.record(result["task_id"], kind, model)
        return result

    def get_task(self, task_id: str) -> tuple[int, dict | None]:
        """GET /v1/tasks/{id}. Tra (status, dict|None). 404 = task da mat."""
        req = urllib.request.Request(
            self.base_url + "/v1/tasks/" + urllib.parse.quote(task_id),
            method="GET", headers=self._headers())

        def _do():
            try:
                with urllib.request.urlopen(req, timeout=RELAY_HTTP_TIMEOUT) as resp:
                    return resp.status, json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return 404, None
                raise RelayError(f"Relay loi khi hoi task: {self._read_error(e)}",
                                 status=e.code)
        status, data = _call_with_relay_retry(_do, "hoi task")
        if self.journal and data and data.get("status") in (
                "completed", "failed", "timeout"):
            self.journal.update(task_id, data["status"])
        return status, data

    def ack_task(self, task_id: str) -> None:
        """POST /v1/tasks/{id}/ack (best effort — loi thi bo qua)."""
        req = urllib.request.Request(
            self.base_url + "/v1/tasks/" + urllib.parse.quote(task_id) + "/ack",
            data=b"{}", method="POST",
            headers=self._headers("application/json"))
        try:
            with urllib.request.urlopen(req, timeout=RELAY_HTTP_TIMEOUT):
                pass
        except Exception:
            pass

    def download_media(self, name: str, sink) -> tuple[str, int]:
        """GET /v1/media/{name}, stream theo chunk qua sink(bytes).

        Tra (content_type, so byte da tai). Khong can auth (theo hop dong).
        """
        url = self.base_url + "/v1/media/" + urllib.parse.quote(name)
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=MEDIA_HTTP_TIMEOUT) as resp:
                if resp.status != 200:
                    raise RelayError(f"Tai media that bai (HTTP {resp.status})",
                                     status=resp.status)
                total = 0
                while True:
                    chunk = resp.read(CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    sink(chunk)
                return resp.headers.get_content_type(), total
        except urllib.error.HTTPError as e:
            raise RelayError(f"Tai media that bai: {self._read_error(e)}",
                             status=e.code)
        except urllib.error.URLError as e:
            raise RelayError(f"Khong noi duoc relay khi tai media: {e.reason}")


# ---------------------------------------------------------------------------
# Base64 theo chunk (khong can giu ca file trong RAM khi ma hoa)
# ---------------------------------------------------------------------------

class ChunkedBase64Encoder:
    """Ma hoa base64 tang dan: chi ma hoa so byte la boi cua 3, giu lai
    0-2 byte du o cuoi chunk de noi voi chunk sau."""

    def __init__(self):
        self._leftover = b""
        self._parts: list[str] = []

    def feed(self, chunk: bytes) -> None:
        data = self._leftover + chunk
        whole = (len(data) // 3) * 3
        self._leftover = data[whole:]
        if whole:
            self._parts.append(base64.b64encode(data[:whole]).decode("ascii"))

    def finish(self) -> str:
        if self._leftover:
            self._parts.append(base64.b64encode(self._leftover).decode("ascii"))
            self._leftover = b""
        return "".join(self._parts)


# ---------------------------------------------------------------------------
# Multipart: doc stream tu client (khong load file vao RAM) + goi stream
# ---------------------------------------------------------------------------

class _SpoolFile:
    """Mot file trong multipart: noi dung spool ra dia tam khi > 1 MB."""

    def __init__(self, field: str, filename: str, content_type: str):
        self.field = field
        self.filename = filename
        self.content_type = content_type
        self._tmp = tempfile.SpooledTemporaryFile(max_size=1024 * 1024)
        self.size = 0

    def write(self, data: bytes) -> None:
        self._tmp.write(data)
        self.size += len(data)

    def seek(self, pos: int) -> None:
        self._tmp.seek(pos)

    def read(self, n: int = -1) -> bytes:
        return self._tmp.read(n)

    def close(self) -> None:
        try:
            self._tmp.close()
        except Exception:
            pass


class _BufferedStream:
    """Doc co dem tren rfile, ho tro unread (day lai byte da doc)."""

    def __init__(self, raw, chunk_size: int = CHUNK):
        self._raw = raw
        self._buf = bytearray()
        self._chunk = chunk_size
        self._eof = False

    def _fill(self, need: int = 1) -> bool:
        while len(self._buf) < need and not self._eof:
            data = self._raw.read(self._chunk)
            if not data:
                self._eof = True
                break
            self._buf += data
        return len(self._buf) > 0

    def read(self, n: int) -> bytes:
        if n <= 0:
            return b""
        self._fill(min(n, self._chunk))
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def read_line(self, limit: int = 65536) -> bytes:
        while True:
            idx = self._buf.find(b"\n")
            if idx != -1:
                line = bytes(self._buf[:idx + 1])
                del self._buf[:idx + 1]
                return line
            if len(self._buf) >= limit:
                line = bytes(self._buf[:limit])
                del self._buf[:limit]
                return line
            if not self._fill(len(self._buf) + 1):
                line = bytes(self._buf)
                self._buf.clear()
                return line

    def read_until_delim(self, delim: bytes, sink, max_bytes: int) -> bool:
        """Stream toi khi gap delim; sink nhan body (khong gom delim).
        Tra True neu tim thay delim, False neu het stream truoc."""
        keep = len(delim) - 1
        total = 0
        while True:
            idx = self._buf.find(delim)
            if idx != -1:
                if total + idx > max_bytes:
                    raise BridgeError(413, "Phan form vuot qua gioi han")
                sink(bytes(self._buf[:idx]))
                del self._buf[:idx + len(delim)]
                return True
            if len(self._buf) > keep:
                chunk = bytes(self._buf[:-keep])
                if total + len(chunk) > max_bytes:
                    raise BridgeError(413, "Phan form vuot qua gioi han")
                sink(chunk)
                total += len(chunk)
                del self._buf[:-keep]
            if not self._fill(len(self._buf) + 1):
                if self._buf:
                    sink(bytes(self._buf))
                    self._buf.clear()
                return False


def _parse_content_disposition(value: str) -> dict:
    out: dict = {}
    for part in value.split(";"):
        part = part.strip()
        if "=" in part:
            key, val = part.split("=", 1)
            out[key.strip().lower()] = val.strip().strip('"')
        elif part:
            out["type"] = part
    return out


def parse_multipart(stream: _BufferedStream, boundary: bytes,
                    total_limit: int = MAX_MULTIPART_TOTAL):
    """Doc multipart/form-data dang stream.

    Tra (fields: dict[str, str], files: list[_SpoolFile]).
    File duoc spool ra dia tam, khong giu trong RAM.
    """
    first = stream.read_line()
    if first.strip() != b"--" + boundary:
        raise BridgeError(400, "Multipart khong hop le (thieu boundary mo dau)")
    fields: dict = {}
    files: list = []
    seen = 0
    while True:
        # --- headers cua part ---
        headers: dict = {}
        while True:
            line = stream.read_line()
            if line in (b"\r\n", b"\n", b""):
                break
            if b":" in line:
                name, val = line.decode("iso-8859-1").split(":", 1)
                headers[name.strip().lower()] = val.strip()
        disp = _parse_content_disposition(
            headers.get("content-disposition", ""))
        name = disp.get("name", "")
        filename = disp.get("filename")
        ctype = headers.get("content-type", "application/octet-stream")
        if filename is None:
            buf: list = []
            sink = buf.append

            def _text_sink(data, _buf=buf):
                _buf.append(data)
            stream.read_until_delim(b"\r\n--" + boundary, _text_sink,
                                    MAX_TEXT_FIELD)
            fields[name] = b"".join(buf).decode("utf-8", "replace")
        else:
            f = _SpoolFile(name, filename, ctype)
            files.append(f)
            stream.read_until_delim(b"\r\n--" + boundary, f.write,
                                    total_limit)
            seen += f.size
            if seen > total_limit:
                raise BridgeError(413, "Tong dung luong upload vuot qua gioi han")
        # --- sau delim: "--" = het, "\r\n" = part tiep theo ---
        nxt = stream.read(2)
        if nxt == b"--":
            stream.read_line()  # bo phan con lai cua dong ket thuc
            break
        if nxt != b"\r\n":
            raise BridgeError(400, "Multipart khong hop le (ket thuc part)")
    return fields, files


class _MultipartBody:
    """Body multipart de gui di, doc duoc tung chunk (read(n)).

    parts: list[(headers_bytes, source)] — source la bytes hoac _SpoolFile.
    Tong do dai duoc tinh truoc de dat Content-Length chinh xac.
    """

    def __init__(self, boundary: bytes, parts: list):
        self._segments: list = []
        total = 0
        for headers, source in parts:
            head = b"--" + boundary + b"\r\n" + headers + b"\r\n"
            self._segments.append(("bytes", head))
            total += len(head)
            self._segments.append(("file" if isinstance(source, _SpoolFile)
                                   else "bytes", source))
            total += source.size if isinstance(source, _SpoolFile) \
                else len(source)
            self._segments.append(("bytes", b"\r\n"))
            total += 2
        tail = b"--" + boundary + b"--\r\n"
        self._segments.append(("bytes", tail))
        total += len(tail)
        self.total = total
        self._idx = 0
        self._buf = b""
        self._file: _SpoolFile | None = None
        self._file_remaining = 0

    def rewind(self) -> None:
        """Dua body ve dau de gui lai (khi retry tao task multipart)."""
        self._idx = 0
        self._buf = b""
        self._file = None
        self._file_remaining = 0

    def read(self, n: int = CHUNK) -> bytes:
        out = bytearray()
        while len(out) < n:
            if self._buf:
                take = min(n - len(out), len(self._buf))
                out += self._buf[:take]
                self._buf = self._buf[take:]
                continue
            if self._file is not None:
                chunk = self._file.read(min(n - len(out), CHUNK))
                if chunk:
                    out += chunk
                    self._file_remaining -= len(chunk)
                    if self._file_remaining <= 0:
                        self._file = None
                    continue
                self._file = None
                continue
            if self._idx >= len(self._segments):
                break
            kind, data = self._segments[self._idx]
            self._idx += 1
            if kind == "bytes":
                self._buf = data
            else:
                data.seek(0)
                self._file = data
                self._file_remaining = data.size
        return bytes(out)


# ---------------------------------------------------------------------------
# HTTP handler — API OpenAI cho Canvas
# ---------------------------------------------------------------------------

def _extract_response_text(result: dict) -> str:
    """Lay text tu payload OpenAI Responses (output_text hoac output[]."""
    if not isinstance(result, dict):
        return ""
    if isinstance(result.get("output_text"), str) and result["output_text"]:
        return result["output_text"]
    parts: list[str] = []
    for item in result.get("output") or []:
        if isinstance(item, dict) and item.get("type") == "message":
            for c in item.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    parts.append(str(c.get("text") or ""))
    return "".join(parts)


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MuseRelayBridge/1.0"

    # -- tien ich -----------------------------------------------------------
    @property
    def relay(self) -> RelayClient:
        return self.server.relay  # type: ignore[attr-defined]

    @property
    def cfg(self) -> Config:
        return self.server.config  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):  # tat log mac dinh cua http.server
        pass

    def _log(self, msg: str) -> None:
        log(f"{self.command} {self.path} {msg}")

    def _cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send_bytes(self, status: int, body: bytes,
                    content_type: str = "application/json") -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self._cors_headers()
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, status: int, payload) -> None:
        self._send_bytes(status, json.dumps(payload).encode("utf-8"))

    def _send_error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": {"message": message}})

    def _require_auth(self) -> None:
        """Canvas phai gui Bearer token (bat ky token nao khac rong).
        Khoa nay KHONG duoc chuyen len relay."""
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Bearer ") or not auth[7:].strip():
            raise BridgeError(401, "Missing or invalid API key")

    def _read_json_body(self) -> dict:
        length = self.headers.get("Content-Length")
        if length is None:
            raise BridgeError(400, "Thieu Content-Length")
        try:
            n = int(length)
        except ValueError:
            raise BridgeError(400, "Content-Length khong hop le")
        if n < 0 or n > MAX_JSON_BODY:
            raise BridgeError(413, "Body vuot qua gioi han")
        raw = self.rfile.read(n) if n else b""
        if not raw:
            raise BridgeError(400, "Body JSON trong")
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise BridgeError(400, "Body JSON khong hop le")
        if not isinstance(data, dict):
            raise BridgeError(400, "Body JSON phai la object")
        return data

    def _read_multipart(self):
        ctype = self.headers.get("Content-Type") or ""
        m = re.search(r"multipart/form-data;\s*boundary=(.+)", ctype)
        if not m:
            raise BridgeError(400, "Can multipart/form-data")
        boundary = m.group(1).strip().strip('"').encode("ascii")
        length = self.headers.get("Content-Length")
        if length is not None and int(length) > MAX_MULTIPART_TOTAL:
            raise BridgeError(413, "Tong dung luong upload vuot qua gioi han")
        stream = _BufferedStream(self.rfile)
        return parse_multipart(stream, boundary)

    # -- dieu phoi relay ----------------------------------------------------
    def _create_and_wait(self, kind: str, model: str, task_input: dict,
                         files: list | None = None) -> dict:
        """Tao task relay roi poll toi khi xong. Tra task dict completed.
        Neu relay tra 404 (task mat khi relay restart) thi tao lai task
        voi cung idempotency_key (toi da MAX_RECREATES lan)."""
        idem = str(uuid.uuid4())
        deadline = time.monotonic() + KIND_TIMEOUTS[kind]

        def create() -> str:
            if files is not None:
                task = self.relay.create_task_multipart(
                    kind, model, task_input, idem, files)
            else:
                task = self.relay.create_task_json(
                    kind, model, task_input, idem)
            task_id = task.get("task_id")
            if not task_id:
                raise RelayError("Relay tra ve task khong co task_id")
            return task_id

        task_id = create()
        self._log(f"task={task_id} kind={kind} created")
        recreates = 0
        while True:
            if time.monotonic() > deadline:
                raise BridgeError(
                    502, f"Relay task timed out ({KIND_TIMEOUTS[kind]}s): {task_id}")
            status, task = self.relay.get_task(task_id)
            if status == 404:
                # Hop dong muc 5.3: task mat theo relay -> tao lai cung key.
                if recreates >= MAX_RECREATES:
                    raise BridgeError(
                        502, f"Task lost on relay, khong tao lai duoc: {task_id}")
                recreates += 1
                self._log(f"task={task_id} lost on relay, tao lai lan {recreates}")
                task_id = create()
                continue
            state = (task or {}).get("status")
            if state == "completed":
                self._log(f"task={task_id} kind={kind} completed")
                return task or {}
            if state == "failed":
                raise BridgeError(
                    502, f"Task failed: {(task or {}).get('error') or 'unknown error'}")
            if state == "timeout":
                raise BridgeError(502, f"Task timed out on relay: {task_id}")
            time.sleep(POLL_INTERVAL)

    def _resolve_image_result(self, task: dict) -> dict:
        """Dich ket qua anh cua relay sang dang parseImagePayload hieu.

        Uu tien: b64_json co san -> tra nguyen; neu khong, tai file media
        tu relay, ma hoa base64 theo chunk roi tra data[].b64_json.
        """
        result = task.get("result") or {}
        if not isinstance(result, dict):
            result = {}
        data = result.get("data")
        items = data if isinstance(data, list) else []
        media_names = task.get("result_media") or []
        if not isinstance(media_names, list):
            media_names = []

        def media_name_for(item: dict, idx: int) -> str | None:
            url = item.get("url")
            if isinstance(url, str) and url.startswith("/v1/media/"):
                return url.rsplit("/", 1)[-1]
            if idx < len(media_names):
                return str(media_names[idx])
            return None

        # Neu tat ca item da co b64_json (hoac URL tuyet doi) thi tra nguyen.
        needs_download = False
        for i, item in enumerate(items):
            if isinstance(item, dict) and item.get("b64_json"):
                continue
            if isinstance(item, dict) and isinstance(item.get("url"), str) \
                    and item["url"].startswith("http"):
                continue
            needs_download = True
        if not needs_download:
            return result

        out_items: list = []
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            if item.get("b64_json"):
                out_items.append(item)
                continue
            if isinstance(item.get("url"), str) \
                    and item["url"].startswith("http"):
                out_items.append(item)
                continue
            name = media_name_for(item, i)
            if not name:
                raise BridgeError(
                    502, "Ket qua anh thieu file media va b64_json")
            enc = ChunkedBase64Encoder()
            self.relay.download_media(name, enc.feed)
            b64 = enc.finish()
            self._log(f"task media {name} -> b64_json ({len(b64)} chars)")
            out_items.append({
                "b64_json": b64,
                "revised_prompt": item.get("revised_prompt", ""),
            })
        return {
            "created": result.get("created", int(time.time())),
            "data": out_items,
        }

    def _video_task_shape(self, task_id: str, status: str, progress: int,
                          url: str | None = None,
                          error: str | None = None) -> dict:
        shape: dict = {
            "id": task_id,
            "task_id": task_id,
            "object": "video.task",
            "status": status,
            "progress": progress,
            "created_at": int(time.time()),
        }
        if url:
            shape["url"] = url
            shape["video_url"] = url
            shape["result_url"] = url
        if error:
            shape["error"] = {"message": error}
        return shape

    # -- routes --------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        try:
            self._route_get()
        except BridgeError as e:
            self._send_error(e.status, e.message)
            self._log(f"error {e.status}: {e.message}")
        except RelayError as e:
            self._send_error(502, e.message)
            self._log(f"relay error: {e.message}")
        except Exception as e:  # noqa: BLE001 - tra 500 chung, khong lo secret
            self._send_error(500, f"Bridge error: {e}")
            self._log(f"internal error: {type(e).__name__}: {e}")

    def do_POST(self):
        try:
            self._route_post()
        except BridgeError as e:
            self._send_error(e.status, e.message)
            self._log(f"error {e.status}: {e.message}")
        except RelayError as e:
            self._send_error(502, e.message)
            self._log(f"relay error: {e.message}")
        except Exception as e:  # noqa: BLE001
            self._send_error(500, f"Bridge error: {e}")
            self._log(f"internal error: {type(e).__name__}: {e}")

    def _route_get(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/healthz":
            self._send_json(200, {"status": "ok"})
            return
        # Endpoint noi bo cho app (chi nghe tren localhost): liet ke va
        # truy van task tu journal local — app mo lai dung de khoi phuc.
        # Khong nam trong giao thuc Canvas, khong can Bearer key cua Canvas.
        if path == "/bridge/tasks":
            self._send_json(200, {"tasks": self.server.journal.all()})
            return
        m = re.fullmatch(r"/bridge/tasks/([^/]+)", path)
        if m:
            task_id = m.group(1)
            status, task = self.relay.get_task(task_id)
            if status == 404:
                entry = self.server.journal.get(task_id)
                if entry is None:
                    raise BridgeError(404, "Task not found")
                self._send_json(200, {"task_id": task_id,
                                      "status": entry["status"],
                                      "journal_only": True,
                                      "entry": entry})
                return
            self._send_json(200, task)
            return
        self._require_auth()
        if path == "/v1/models":
            self._send_json(200, {"object": "list", "data": MODELS})
            self._log("models ok")
            return
        m = re.fullmatch(r"/v1/videos/([^/]+)", path)
        if m:
            self._handle_video_poll(m.group(1))
            return
        m = re.fullmatch(r"/v1/videos/([^/]+)/content", path)
        if m:
            self._handle_video_content(m.group(1))
            return
        raise BridgeError(404, "Not found")

    def _route_post(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/v1/audio/speech":
            self._require_auth()
            self._send_error(501, "TTS is not supported by the relay "
                                  "(muse2api has no /audio/speech endpoint)")
            self._log("audio/speech -> 501 (khong ho tro TTS)")
            return
        self._require_auth()
        if path == "/v1/chat/completions":
            self._handle_sync_task("chat")
        elif path == "/v1/responses":
            self._handle_responses()
        elif path == "/v1/images/generations":
            self._handle_image()
        elif path == "/v1/images/edits":
            self._handle_image_edit()
        elif path == "/v1/videos":
            self._handle_video_create()
        else:
            raise BridgeError(404, "Not found")

    # -- handlers ------------------------------------------------------------
    def _handle_sync_task(self, kind: str) -> None:
        """chat/completions: tao task, doi xong, tra result JSON nguyen ven.
        Khong gia lap SSE — neu client gui stream:true thi van tra ve
        response day du dang JSON (Canvas khong dung endpoint nay)."""
        body = self._read_json_body()
        task_input = dict(body)
        task_input["stream"] = False  # bridge luon doi ket qua day du
        model = str(body.get("model") or "muse-spark")
        task = self._create_and_wait(kind, model, task_input)
        result = task.get("result") or {}
        self._send_json(200, result)
        self.relay.ack_task(task["task_id"])

    def _handle_responses(self) -> None:
        """POST /v1/responses: Canvas (image question) goi voi stream:true
        va doc SSE. Bridge doi task xong roi phat lai ket qua duoi dang
        SSE toi thieu (1 delta + completed) — khong stream token thuc,
        chi dong khung ket qua da xong cho parser SSE cua Canvas hieu."""
        body = self._read_json_body()
        task_input = dict(body)
        task_input["stream"] = False
        model = str(body.get("model") or "muse-spark")
        task = self._create_and_wait("responses", model, task_input)
        result = task.get("result") or {}
        if not isinstance(result, dict):
            result = {}
        text = _extract_response_text(result)
        events = []
        if text:
            events.append("data: " + json.dumps(
                {"type": "response.output_text.delta", "delta": text},
                ensure_ascii=False))
        events.append("data: " + json.dumps(
            {"type": "response.completed", "response": result},
            ensure_ascii=False))
        events.append("data: [DONE]")
        payload = ("\n\n".join(events) + "\n\n").encode("utf-8")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(payload)))
            self._cors_headers()
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            return
        self._log(f"task={task['task_id']} responses SSE sent "
                  f"({len(text)} chars)")
        self.relay.ack_task(task["task_id"])

    def _handle_image(self) -> None:
        body = self._read_json_body()
        model = str(body.get("model") or "muse-image")
        task = self._create_and_wait("image", model, body)
        result = self._resolve_image_result(task)
        self._send_json(200, result)
        self.relay.ack_task(task["task_id"])

    def _handle_image_edit(self) -> None:
        fields, files = self._read_multipart()
        try:
            task_input = {
                "model": fields.get("model", "muse-image"),
                "prompt": fields.get("prompt", ""),
                "n": fields.get("n", "1"),
                "response_format": fields.get("response_format", "b64_json"),
                "size": fields.get("size", ""),
                "quality": fields.get("quality", ""),
                "background": fields.get("background", ""),
                "output_format": fields.get("output_format", ""),
            }
            task_input = {k: v for k, v in task_input.items() if v != ""}
            model = str(fields.get("model") or "muse-image")
            task = self._create_and_wait("image_edit", model, task_input,
                                         files=files)
            result = self._resolve_image_result(task)
            self._send_json(200, result)
            self.relay.ack_task(task["task_id"])
        finally:
            for f in files:
                f.close()

    def _handle_video_create(self) -> None:
        """Canvas POST multipart (model, prompt, seconds, size, ...) len
        /v1/videos. Bridge tao task relay roi tra NGAY dang task cua
        muse2api — Canvas se tu poll GET /v1/videos/{id}."""
        fields, files = self._read_multipart()
        try:
            model = str(fields.get("model") or "muse-video")
            task_input = dict(fields)  # giu nguyen cac field text goc
            image_files = [f for f in files
                           if f.field in ("first_frame", "last_frame",
                                          "images", "image", "image[]")]
            # File video/audio tham chieu (video[], audio[]) hien chua co
            # trong hop dong relay -> bo qua, ghi log de sau bo sung.
            skipped = [f for f in files if f not in image_files]
            if skipped:
                self._log(f"video create: bo qua {len(skipped)} file "
                          f"video/audio tham chieu (chua co trong hop dong)")
            idem = str(uuid.uuid4())
            if image_files:
                task = self.relay.create_task_multipart(
                    "video", model, task_input, idem, image_files)
            else:
                task = self.relay.create_task_json(
                    "video", model, task_input, idem)
            task_id = task.get("task_id")
            if not task_id:
                raise RelayError("Relay tra ve task khong co task_id")
            created_at = task.get("created_at") or int(time.time())
            self._send_json(200, {
                "id": task_id,
                "task_id": task_id,
                "object": "video.task",
                "status": "queued",
                "progress": 10,
                "created_at": created_at,
            })
            self._log(f"task={task_id} video created (tra ngay cho Canvas)")
        finally:
            for f in files:
                f.close()

    def _handle_video_poll(self, task_id: str) -> None:
        """GET /v1/videos/{id}: dich trang thai relay sang dang task
        video cua muse2api. Canvas poll moi 2.5s, toi da 240 lan."""
        status, task = self.relay.get_task(task_id)
        if status == 404 or task is None:
            self._send_json(200, self._video_task_shape(
                task_id, "failed", 0,
                error="Task not found on relay (relay co the da restart)"))
            self._log(f"task={task_id} video poll -> 404, tra failed")
            return
        state = task.get("status")
        progress = task.get("progress")
        progress = int(progress) if isinstance(progress, (int, float)) else 10
        if state == "completed":
            result = task.get("result") or {}
            media = task.get("result_media") or []
            url = None
            # result_media la danh sach ten file chinh xac tu relay — uu tien.
            if media:
                name = str(media[0])
                url = self.cfg.relay_url + "/v1/media/" + \
                    urllib.parse.quote(name)
            elif isinstance(result, dict):
                for key in ("video_url", "result_url", "url"):
                    val = result.get(key)
                    if isinstance(val, str) and val:
                        url = val
                        break
                if url and not url.startswith("http"):
                    if url.startswith("/"):
                        url = self.cfg.relay_url + url
                    else:
                        # Ten file tran: worker rut gon local /v1/media URL
                        # ve ten file khi upload ket qua.
                        url = (self.cfg.relay_url + "/v1/media/" +
                               urllib.parse.quote(url))
            self._send_json(200, self._video_task_shape(
                task_id, "completed", 100, url=url))
            self._log(f"task={task_id} video completed url={url}")
            # Khong ack video: Canvas se tu tai file truc tiep tu relay.
            return
        if state in ("failed", "timeout"):
            err = str(task.get("error") or
                      ("Task timed out on relay" if state == "timeout"
                       else "Video generation failed"))
            self._send_json(200, self._video_task_shape(
                task_id, "failed", progress, error=err))
            self._log(f"task={task_id} video {state}: {err}")
            return
        # queued / processing
        self._send_json(200, self._video_task_shape(
            task_id, "processing", max(10, min(99, progress))))

    def _handle_video_content(self, task_id: str) -> None:
        """GET /v1/videos/{id}/content: du phong khi Canvas thay status
        completed nhung khong co URL — bridge tai media tu relay roi
        stream thang ve cho Canvas."""
        status, task = self.relay.get_task(task_id)
        if status == 404 or task is None:
            raise BridgeError(404, "Unknown video task")
        if task.get("status") == "failed":
            raise BridgeError(502, str(task.get("error") or
                                       "Video generation failed"))
        if task.get("status") != "completed":
            raise BridgeError(409, "Video task not completed yet")
        media = task.get("result_media") or []
        result = task.get("result") or {}
        name = None
        if media:
            name = str(media[0])
        elif isinstance(result, dict):
            for key in ("video_url", "result_url", "url"):
                val = result.get(key)
                if isinstance(val, str) and "/v1/media/" in val:
                    name = val.rsplit("/", 1)[-1]
                    break
        if not name:
            raise BridgeError(502, "Video hoan thanh nhung thieu file media")
        url = self.cfg.relay_url + "/v1/media/" + urllib.parse.quote(name)
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=MEDIA_HTTP_TIMEOUT) as resp:
                length = resp.headers.get("Content-Length")
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                if length:
                    self.send_header("Content-Length", length)
                self._cors_headers()
                self.end_headers()
                if length:
                    while True:
                        chunk = resp.read(CHUNK)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                else:
                    # Khong co Content-Length: dem toi da 512 MB roi gui.
                    buf = bytearray()
                    while len(buf) < 512 * 1024 * 1024:
                        chunk = resp.read(CHUNK)
                        if not chunk:
                            break
                        buf += chunk
                    self.wfile.write(bytes(buf))
        except urllib.error.HTTPError as e:
            raise BridgeError(502, f"Tai video that bai (HTTP {e.code})")
        except urllib.error.URLError as e:
            raise BridgeError(502, f"Khong noi duoc relay: {e.reason}")
        self._log(f"task={task_id} video content streamed ({name})")


class BridgeServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, config: Config):
        super().__init__(address, handler)
        self.config = config
        self.journal = TaskJournal(config.data_dir)
        self.relay = RelayClient(config.relay_url, config.canvas_key,
                                 journal=self.journal)


# ---------------------------------------------------------------------------
# main()
# ---------------------------------------------------------------------------

def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Muse Relay bridge — chay tren Mac, phoi API OpenAI "
                    "cho Canvas (stdlib only, khong can pip).")
    parser.add_argument("--env", default=None,
                        help="Duong dan file .env (mac dinh: "
                             "relay/bridge/.env cung thu muc voi script)")
    parser.add_argument("--host", default=None,
                        help="Host de lang nghe (mac dinh 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None,
                        help="Cong de lang nghe (mac dinh 5522; 0 = he dieu "
                             "hanh chon cong trong, dung cho app dong goi)")
    parser.add_argument("--data-dir", default=None,
                        help="Thu muc du lieu (journal task). Mac dinh: thu "
                             "muc chua script. App dong goi nen truyen "
                             "Application Support cua no.")
    parser.add_argument("--parent-pid", type=int, default=None,
                        help="PID cua tien trinh cha (app). Bridge tu tat "
                             "khi cha chet. App dong goi phai truyen co nay; "
                             "chay standalone thi khong can.")
    parser.add_argument("--ready-file", default=None,
                        help="Ghi file JSON {host, port, url} khi bridge "
                             "da lang nghe xong, de app doc cong thuc te.")
    args = parser.parse_args(argv)

    env_path = args.env
    if env_path is None:
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".env")
    try:
        cfg = Config(env_path, args.host, args.port,
                     data_dir=args.data_dir, parent_pid=args.parent_pid,
                     ready_file=args.ready_file)
    except SystemExit as e:
        print(f"bridge: {e}", file=sys.stderr)
        return 2

    server = BridgeServer((cfg.host, cfg.port), BridgeHandler, cfg)
    actual_port = server.server_address[1]
    ready = {"event": "bridge_ready", "host": cfg.host,
             "port": actual_port,
             "url": f"http://{cfg.host}:{actual_port}"}
    # Dong ready cho app doc: 1 dong JSON ra stdout + file neu co cau hinh.
    print(json.dumps(ready), flush=True)
    if cfg.ready_file:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(cfg.ready_file))
                        or ".", exist_ok=True)
            tmp = cfg.ready_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(ready, f)
            os.replace(tmp, cfg.ready_file)
        except OSError as e:
            log(f"khong ghi duoc ready-file {cfg.ready_file}: {e}")
    log(f"bridge listening on http://{cfg.host}:{actual_port} "
        f"-> relay {cfg.relay_url}")
    log("Canvas: dat MUSE_API_BASE=http://"
        f"{cfg.host}:{actual_port} (giu nguyen MUSE_API_KEY cu)")

    # Kiem tra relay luc khoi dong (chi de log — relay ngu thi bridge van
    # chay, request dau tien se danh thuc relay va retry theo
    # RELAY_WAKE_DEADLINE).
    if server.relay.health_check():
        log("relay: ket noi OK")
    else:
        log("relay: chua toi duoc (co the dang ngu) — se tu ket noi lai "
            "khi co task")

    def _shutdown(signum, _frame):
        log(f"nhan signal {signum}, dang tat bridge...")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    def _parent_watchdog():
        """Tu tat khi app (tien trinh cha) thoat. Chi chay khi app truyen
        --parent-pid (ban dong goi). Khong dung getppid()==1 de tranh
        tat nham khi bridge duoc chay standalone bang nohup."""
        if not cfg.parent_pid:
            return
        while True:
            time.sleep(2)
            try:
                os.kill(cfg.parent_pid, 0)
            except OSError:
                log(f"tien trinh cha (pid {cfg.parent_pid}) da thoat, "
                    "tat bridge")
                break
            except Exception:
                continue
        threading.Thread(target=server.shutdown, daemon=True).start()

    threading.Thread(target=_parent_watchdog, daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    log("bridge da dung")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
