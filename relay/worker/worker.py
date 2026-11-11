#!/usr/bin/env python3
"""Muse Relay worker — chạy trên máy ảo Muse AI.

Kéo task từ relay trên Render (long-poll HTTPS đi ra), chạy bằng muse2api
nội bộ (http://127.0.0.1:1314), rồi đẩy kết quả về relay.

- Mọi kết nối đều do worker khởi xướng đi ra. Không có kết nối nào đi
  vào máy ảo. Không SSH tunnel, reverse tunnel, port forwarding.
- Worker giữ khóa muse2api của máy ảo (đọc từ lan1/.env local) và chỉ
  gọi 127.0.0.1:1314. Khóa này không bao giờ rời khỏi máy ảo.
- Kết quả đã tạo được giữ trên máy ảo (journal + file) cho tới khi relay
  xác nhận đã nhận; relay restart cũng không làm mất kết quả.

Chạy bằng venv của lan1:
    ~/workspace/lan1/.venv/bin/python relay/worker/worker.py

Cấu hình: relay/worker/.env (xem .env.example). Không commit file .env.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import signal
import sys
import threading
import time
import uuid
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Hằng số
# ---------------------------------------------------------------------------

# Timeout local (giây) theo từng loại task — khớp timeout của muse2api.
DEFAULT_TIMEOUTS = {
    "chat": 300,
    "responses": 300,
    "image": 240,
    "image_edit": 240,
    "video": 600,
}
LONG_POLL_WAIT = 25          # giây, khớp ?wait=25 của relay
HEARTBEAT_INTERVAL = 30      # giây; relay coi worker mất sau 90s không heartbeat
POLL_BACKOFF_MIN = 2         # giây
POLL_BACKOFF_MAX = 30        # giây
JOURNAL_TTL_SECONDS = 24 * 3600   # dọn journal entry quá 24h chưa được ack
CHUNK = 1024 * 1024          # 1 MB — stream file theo chunk, không load hết RAM
MAX_ERROR_LEN = 300

SCRIPT_DIR = Path(__file__).resolve().parent
JOURNAL_PATH = SCRIPT_DIR / "worker-journal.json"
RESULTS_DIR = SCRIPT_DIR / "results"
LAN1_ENV_CANDIDATES = [
    SCRIPT_DIR.parent.parent / ".env",          # ~/workspace/lan1/.env
    Path.home() / "workspace" / "lan1" / ".env",
]


# ---------------------------------------------------------------------------
# Log + tiện ích
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    """Một dòng log có timestamp, ra stdout. Không bao giờ log secret."""
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [worker] {msg}", flush=True)


def load_dotenv(path: Path) -> dict:
    """Đọc file .env kiểu KEY=VALUE (không cần python-dotenv)."""
    values: dict = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


class Config:
    """Cấu hình worker: .env của worker, env process, rồi lan1/.env."""

    def __init__(self, env_path: Path):
        file_values = load_dotenv(env_path)
        # Biến môi trường process được ưu tiên hơn file (tiện cho test).
        merged = {**file_values, **os.environ}
        self.relay_url = (merged.get("RELAY_URL") or "").strip().rstrip("/")
        self.relay_worker_key = (merged.get("RELAY_WORKER_KEY") or "").strip()
        self.muse2api_base = (
            merged.get("MUSE2API_BASE") or "http://127.0.0.1:1314"
        ).strip().rstrip("/")
        self.muse2api_key = (merged.get("MUSE2API_KEY") or "").strip()
        if not self.muse2api_key:
            # lan1/.env chỉ có MUSE_API_KEY; start-api.sh bridge nó thành
            # MUSE2API_KEY khi chạy server, nên worker làm tương tự.
            for candidate in LAN1_ENV_CANDIDATES:
                lan1 = load_dotenv(candidate)
                found = (lan1.get("MUSE2API_KEY") or lan1.get("MUSE_API_KEY") or "").strip()
                if found:
                    self.muse2api_key = found
                    break
        self._secrets = [s for s in (self.relay_worker_key, self.muse2api_key) if s]

    def validate(self) -> None:
        missing = []
        if not self.relay_url:
            missing.append("RELAY_URL")
        if not self.relay_worker_key:
            missing.append("RELAY_WORKER_KEY")
        if not self.muse2api_key:
            missing.append("MUSE2API_KEY (trong worker .env hoặc lan1/.env)")
        if missing:
            raise SystemExit(
                "Thiếu cấu hình worker: " + ", ".join(missing)
                + ". Xem relay/worker/.env.example."
            )

    def redact(self, text: str) -> str:
        """Che secret nếu vô tình lọt vào chuỗi log/lỗi."""
        out = text or ""
        for secret in self._secrets:
            if secret and secret in out:
                out = out.replace(secret, "***")
        return out


# ---------------------------------------------------------------------------
# Lỗi
# ---------------------------------------------------------------------------

class TaskLost(Exception):
    """Relay trả 404: task không còn tồn tại (relay restart/mất task)."""


class TaskStale(Exception):
    """Relay trả 409: task không còn thuộc worker này."""


class LocalError(Exception):
    """Lỗi phía muse2api nội bộ hoặc timeout."""


class RelayAuthError(Exception):
    """Relay trả 401/403: sai key hoặc sai vai trò."""


# ---------------------------------------------------------------------------
# Journal — kết quả đã xong nhưng relay chưa xác nhận đã nhận
# ---------------------------------------------------------------------------

class Journal:
    """Lưu {task_id: {kind, result, media, dir, created_at}} vào JSON.

    Media giữ nguyên file trên đĩa (results/<task_id>/...) để upload lại
    được sau khi relay restart. Ghi file kiểu atomic (tmp + rename).
    """

    def __init__(self, path: Path, results_dir: Path):
        self.path = path
        self.results_dir = results_dir
        self._lock = threading.Lock()
        self.entries: dict = {}
        # worker_id on dinh cho tien trinh worker nay, luu cung journal de
        # giu nguyen qua cac lan khoi dong lai (relay dung no de biet task
        # nao thuoc ve worker nao — gui qua header X-Worker-Id).
        self.worker_id: str = ""
        self._load()

    def _load(self) -> None:
        if self.path.is_file():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    self.entries = data.get("entries", {}) or {}
                    wid = data.get("worker_id") or ""
                    if isinstance(wid, str) and wid:
                        self.worker_id = wid
            except (OSError, ValueError):
                self.entries = {}
        if not self.worker_id:
            self.worker_id = "w-" + uuid.uuid4().hex[:12]
            self._save_locked()

    def _save_locked(self) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps({"version": 1, "worker_id": self.worker_id,
                        "entries": self.entries},
                       ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(tmp, self.path)

    def add(self, task_id: str, kind: str, result: dict, media: list) -> None:
        with self._lock:
            self.entries[task_id] = {
                "kind": kind,
                "result": result,
                "media": list(media),
                "dir": f"results/{task_id}",
                "created_at": time.time(),
            }
            self._save_locked()

    def remove(self, task_id: str, delete_files: bool = False) -> None:
        with self._lock:
            entry = self.entries.pop(task_id, None)
            self._save_locked()
        if delete_files and entry:
            self._delete_entry_files(entry)

    @staticmethod
    def _delete_entry_files(entry: dict) -> None:
        task_dir = SCRIPT_DIR / entry.get("dir", "")
        if task_dir.is_dir() and task_dir.parent == RESULTS_DIR:
            for child in sorted(task_dir.rglob("*")):
                if child.is_file():
                    try:
                        child.unlink()
                    except OSError:
                        pass
            for child in sorted(task_dir.rglob("*"), reverse=True):
                if child.is_dir():
                    try:
                        child.rmdir()
                    except OSError:
                        pass
            try:
                task_dir.rmdir()
            except OSError:
                pass

    def purge_old(self, ttl: int = JOURNAL_TTL_SECONDS) -> int:
        """Xóa entry quá hạn (relay đã có đủ thời gian lấy kết quả)."""
        now = time.time()
        removed = 0
        with self._lock:
            stale = [tid for tid, e in self.entries.items()
                     if now - float(e.get("created_at", 0)) > ttl]
            for tid in stale:
                entry = self.entries.pop(tid)
                self._delete_entry_files(entry)
                removed += 1
            if removed:
                self._save_locked()
        return removed

    def task_dir(self, task_id: str) -> Path:
        d = self.results_dir / task_id
        d.mkdir(parents=True, exist_ok=True)
        return d


# ---------------------------------------------------------------------------
# Client gọi relay
# ---------------------------------------------------------------------------

class RelayClient:
    def __init__(self, cfg: Config, worker_id: str = ""):
        self.cfg = cfg
        self.session = requests.Session()
        # Relay yeu cau ca Bearer key lan header X-Worker-Id (xem
        # relay/README.md muc 3.3) de biet task nao thuoc ve worker nao.
        headers = {"Authorization": f"Bearer {cfg.relay_worker_key}"}
        if worker_id:
            headers["X-Worker-Id"] = worker_id
        self.session.headers.update(headers)

    def _check(self, resp: requests.Response, task_id: str | None = None) -> None:
        if resp.status_code == 404 and task_id:
            raise TaskLost(f"relay trả 404 cho task {task_id}")
        if resp.status_code == 409 and task_id:
            raise TaskStale(f"relay trả 409 cho task {task_id}")
        if resp.status_code in (401, 403):
            raise RelayAuthError(
                f"relay trả {resp.status_code}: sai RELAY_WORKER_KEY "
                "hoặc sai vai trò (key này chỉ dùng cho /worker/*)"
            )
        resp.raise_for_status()

    def next_task(self, wait: int = LONG_POLL_WAIT):
        """Long-poll lấy task. Trả dict task, hoặc None khi 204."""
        resp = self.session.get(
            f"{self.cfg.relay_url}/worker/tasks/next",
            params={"wait": wait},
            timeout=wait + 15,
        )
        if resp.status_code == 204:
            return None
        self._check(resp)
        return resp.json()

    def get_input(self, task_id: str, name: str, dest: Path) -> Path:
        """Tải file input của task (ảnh reference cho image_edit), stream."""
        with self.session.get(
            f"{self.cfg.relay_url}/worker/tasks/{task_id}/inputs/{name}",
            stream=True,
            timeout=120,
        ) as resp:
            self._check(resp, task_id)
            with open(dest, "wb") as f:
                for chunk in resp.iter_content(chunk_size=CHUNK):
                    if chunk:
                        f.write(chunk)
        return dest

    def heartbeat(self, task_id: str, progress: int) -> None:
        resp = self.session.post(
            f"{self.cfg.relay_url}/worker/tasks/{task_id}/heartbeat",
            json={"progress": int(progress)},
            timeout=30,
        )
        self._check(resp, task_id)

    def post_status(self, task_id: str, status: str, progress: int,
                    error: str | None = None) -> None:
        body: dict = {"status": status, "progress": int(progress)}
        if error:
            body["error"] = error
        resp = self.session.post(
            f"{self.cfg.relay_url}/worker/tasks/{task_id}/status",
            json=body,
            timeout=30,
        )
        self._check(resp, task_id)

    def post_result(self, task_id: str, result: dict,
                    files: list) -> None:
        """Upload kết quả. Co file media: multipart (result JSON + files).
        Khong co file (chat/responses): gui JSON thang — relay chap nhan
        ca hai dang (multipart chi bat buoc khi co file)."""
        if files:
            multipart = []
            handles = []
            try:
                for path in files:
                    handles.append(open(path, "rb"))
                    multipart.append(
                        ("files", (path.name, handles[-1], _mime(path.name)))
                    )
                resp = self.session.post(
                    f"{self.cfg.relay_url}/worker/tasks/{task_id}/result",
                    data={"result": json.dumps(result, ensure_ascii=False)},
                    files=multipart,
                    timeout=300,
                )
                self._check(resp, task_id)
            finally:
                for h in handles:
                    h.close()
        else:
            resp = self.session.post(
                f"{self.cfg.relay_url}/worker/tasks/{task_id}/result",
                json={"result": result},
                timeout=300,
            )
            self._check(resp, task_id)

    def post_failed(self, task_id: str, error: str) -> None:
        resp = self.session.post(
            f"{self.cfg.relay_url}/worker/tasks/{task_id}/failed",
            json={"error": error[:MAX_ERROR_LEN]},
            timeout=30,
        )
        self._check(resp, task_id)

    def sync(self, payload: dict):
        """POST /worker/sync. Trả JSON relay trả về (dict, có thể rỗng)."""
        resp = self.session.post(
            f"{self.cfg.relay_url}/worker/sync",
            json=payload,
            timeout=30,
        )
        self._check(resp)
        try:
            return resp.json()
        except ValueError:
            return {}


def parse_sync_reply(reply) -> dict:
    """Chuẩn hóa reply của /worker/sync về dạng
    {task_id: {"needs_upload": bool, "acked": bool}}.

    Hình dạng chính (relay muse-relay, xem relay/app.py):
      {"requeued": [...], "needs_upload": [task_id, ...],
       "already_have": [task_id, ...]}
    mỗi mục là chuỗi task_id (hoặc dict có "task_id"). Ngoài ra chấp
    nhận vài hình dạng khác để tương thích:
      {"tasks": {task_id: {...}}}
      {"completed": [{"task_id": ..., "needs_upload": ..., "acked": ...}]}
      [{"task_id": ..., "needs_upload": ...}]
    Task không được nhắc tới coi như relay đã có (needs_upload=False).
    """
    out: dict = {}
    if isinstance(reply, dict):
        # Hình dạng chính của relay.
        for tid in reply.get("needs_upload") or []:
            if isinstance(tid, str):
                out[tid] = {"needs_upload": True, "acked": False}
            elif isinstance(tid, dict) and tid.get("task_id"):
                out[tid["task_id"]] = {
                    "needs_upload": True,
                    "acked": bool(tid.get("acked", False)),
                }
        for tid in reply.get("already_have") or []:
            if isinstance(tid, str):
                out[tid] = {"needs_upload": False, "acked": False}
            elif isinstance(tid, dict) and tid.get("task_id"):
                out[tid["task_id"]] = {
                    "needs_upload": False,
                    "acked": bool(tid.get("acked", False)),
                }
        blocks = []
        for key in ("tasks", "completed", "results"):
            value = reply.get(key)
            if isinstance(value, dict):
                blocks.append(value.items())
            elif isinstance(value, list):
                blocks.append(
                    (item.get("task_id"), item)
                    for item in value if isinstance(item, dict)
                )
        if isinstance(reply.get("task_id"), str):
            blocks.append([(reply["task_id"], reply)])
        for items in blocks:
            for task_id, directive in items:
                if not task_id:
                    continue
                out[task_id] = {
                    "needs_upload": bool(directive.get("needs_upload", False)),
                    "acked": bool(directive.get("acked", False)),
                }
    elif isinstance(reply, list):
        for item in reply:
            if isinstance(item, dict) and item.get("task_id"):
                out[item["task_id"]] = {
                    "needs_upload": bool(item.get("needs_upload", False)),
                    "acked": bool(item.get("acked", False)),
                }
    return out


# ---------------------------------------------------------------------------
# Client gọi muse2api nội bộ
# ---------------------------------------------------------------------------

def _mime(filename: str) -> str:
    name = filename.lower()
    if name.endswith(".webp"):
        return "image/webp"
    if name.endswith(".png"):
        return "image/png"
    if name.endswith(".jpg") or name.endswith(".jpeg"):
        return "image/jpeg"
    if name.endswith(".mp4"):
        return "video/mp4"
    if name.endswith(".mov"):
        return "video/quicktime"
    return "application/octet-stream"


def _media_filename(url: str) -> str:
    """'/v1/media/<hex>.webp' -> '<hex>.webp'."""
    return url.rsplit("/v1/media/", 1)[-1].split("?")[0].split("#")[0]


def rewrite_media_urls(obj, base: str):
    """Đổi mọi URL media local trong response thành chỉ tên file.

    '/v1/media/<name>' hoặc '<base>/v1/media/<name>' -> '<name>'.
    Relay sẽ phục vụ file đó ở /v1/media/<name>.
    """
    if isinstance(obj, dict):
        return {k: rewrite_media_urls(v, base) for k, v in obj.items()}
    if isinstance(obj, list):
        return [rewrite_media_urls(v, base) for v in obj]
    if isinstance(obj, str) and "/v1/media/" in obj:
        return _media_filename(obj)
    return obj


class LocalClient:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.session = requests.Session()
        self.session.headers.update(
            {"Authorization": f"Bearer {cfg.muse2api_key}"}
        )

    def _post_json(self, path: str, body: dict, timeout: int) -> dict:
        resp = self.session.post(
            f"{self.cfg.muse2api_base}{path}",
            json=body,
            timeout=timeout,
        )
        if resp.status_code >= 400:
            raise LocalError(
                f"muse2api {path} trả {resp.status_code}: "
                f"{resp.text[:MAX_ERROR_LEN]}"
            )
        return resp.json()

    def chat(self, body: dict, timeout: int) -> dict:
        body = dict(body)
        body["stream"] = False  # relay không stream; trả nguyên response
        return self._post_json("/v1/chat/completions", body, timeout)

    def responses(self, body: dict, timeout: int) -> dict:
        body = dict(body)
        body["stream"] = False
        return self._post_json("/v1/responses", body, timeout)

    def image(self, body: dict, timeout: int) -> dict:
        return self._post_json("/v1/images/generations", body, timeout)

    def image_edit(self, files: list, fields: dict, timeout: int) -> dict:
        multipart = []
        handles = []
        try:
            for path in files:
                handles.append(open(path, "rb"))
                multipart.append(("image", (path.name, handles[-1], _mime(path.name))))
            data = {k: str(v) for k, v in fields.items() if v is not None}
            resp = self.session.post(
                f"{self.cfg.muse2api_base}/v1/images/edits",
                data=data,
                files=multipart,
                timeout=timeout,
            )
            if resp.status_code >= 400:
                raise LocalError(
                    f"muse2api /v1/images/edits trả {resp.status_code}: "
                    f"{resp.text[:MAX_ERROR_LEN]}"
                )
            return resp.json()
        finally:
            for h in handles:
                h.close()

    def video_create(self, body: dict, timeout: int) -> dict:
        return self._post_json("/v1/videos", body, timeout)

    def video_status(self, local_task_id: str) -> dict:
        resp = self.session.get(
            f"{self.cfg.muse2api_base}/v1/videos/{local_task_id}",
            timeout=60,
        )
        if resp.status_code == 404:
            raise LocalError(f"task video local {local_task_id} không tồn tại")
        if resp.status_code >= 400:
            raise LocalError(
                f"muse2api GET /v1/videos trả {resp.status_code}: "
                f"{resp.text[:MAX_ERROR_LEN]}"
            )
        return resp.json()

    def download_media(self, url: str, dest: Path, timeout: int = 300) -> Path:
        """Tải file media từ muse2api local, stream theo chunk."""
        if url.startswith("/"):
            full = f"{self.cfg.muse2api_base}{url}"
        elif url.startswith("http"):
            full = url
        else:
            full = f"{self.cfg.muse2api_base}/v1/media/{url}"
        with self.session.get(full, stream=True, timeout=timeout) as resp:
            if resp.status_code >= 400:
                raise LocalError(
                    f"tải media local trả {resp.status_code}: {url}"
                )
            with open(dest, "wb") as f:
                for chunk in resp.iter_content(chunk_size=CHUNK):
                    if chunk:
                        f.write(chunk)
        return dest

    @staticmethod
    def decode_b64_to_file(b64str: str, dest: Path) -> Path:
        """Giải mã base64 ra file theo từng đoạn (không giữ hết RAM)."""
        with open(dest, "wb") as f:
            step = 4 * 1024 * 1024  # bội số của 4
            for i in range(0, len(b64str), step):
                chunk = b64str[i:i + step]
                if len(chunk) % 4:
                    chunk += "=" * (4 - len(chunk) % 4)
                f.write(base64.b64decode(chunk))
        return dest


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

class Worker:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        # Tao Journal truoc de lay worker_id on dinh, truyen cho RelayClient
        # (header X-Worker-Id) truoc khi goi bat ky endpoint /worker/* nao.
        self.journal = Journal(JOURNAL_PATH, RESULTS_DIR)
        self.relay = RelayClient(cfg, worker_id=self.journal.worker_id)
        self.local = LocalClient(cfg)
        self.shutdown = threading.Event()
        self._current_task: str | None = None
        self._progress = {"value": 0}
        self._progress_lock = threading.Lock()
        self._lost = threading.Event()
        self._lost_reason = ""

    # -- trạng thái ------------------------------------------------------

    def _set_progress(self, value: int) -> None:
        with self._progress_lock:
            self._progress["value"] = max(0, min(100, int(value)))

    def _get_progress(self) -> int:
        with self._progress_lock:
            return self._progress["value"]

    def _check_lost(self) -> None:
        if self._lost.is_set():
            raise TaskStale(f"task mất chủ: {self._lost_reason or 'relay từ chối'}")

    def _report_status(self, task_id: str, status: str, progress: int) -> None:
        """Báo trạng thái về relay. Lỗi mạng thì chỉ log rồi chạy tiếp
        (kết quả vẫn được journal + upload lại qua sync); chỉ 404/409
        mới là tín hiệu dừng task."""
        try:
            self.relay.post_status(task_id, status, progress)
        except (TaskLost, TaskStale):
            raise
        except requests.RequestException as exc:
            log(f"task {task_id}: báo trạng thái lỗi mạng "
                f"({exc.__class__.__name__}), tiếp tục chạy local")

    # -- heartbeat nền ---------------------------------------------------

    def _heartbeat_loop(self, task_id: str) -> None:
        while not self._lost.is_set() and not self.shutdown.is_set():
            if self._lost.wait(timeout=HEARTBEAT_INTERVAL):
                break
            try:
                self.relay.heartbeat(task_id, self._get_progress())
            except (TaskLost, TaskStale) as exc:
                self._lost_reason = str(exc)
                self._lost.set()
                log(f"task {task_id}: heartbeat báo {exc} — dừng task")
            except requests.RequestException as exc:
                log(f"task {task_id}: heartbeat lỗi mạng ({exc.__class__.__name__}), thử lại sau")

    # -- đồng bộ / phục hồi ----------------------------------------------

    def do_sync(self) -> None:
        """Gửi in_flight + completed_unacked; xử lý reply của relay."""
        completed = [
            {"task_id": tid, "result": e["result"], "media": e["media"]}
            for tid, e in self.journal.entries.items()
        ]
        payload = {
            "in_flight": [self._current_task] if self._current_task else [],
            "completed_unacked": completed,
        }
        try:
            reply = self.relay.sync(payload)
        except requests.RequestException as exc:
            log(f"sync lỗi mạng ({exc.__class__.__name__}), sẽ thử lại sau")
            return
        except RelayAuthError as exc:
            log(f"sync thất bại: {exc}")
            return
        directives = parse_sync_reply(reply)
        for tid, directive in directives.items():
            if directive.get("acked"):
                log(f"task {tid}: relay báo client đã ack — dọn journal")
                self.journal.remove(tid, delete_files=True)
            elif directive.get("needs_upload"):
                log(f"task {tid}: relay mất kết quả — upload lại")
                self._reupload(tid)

    def _reupload(self, task_id: str) -> None:
        entry = self.journal.entries.get(task_id)
        if not entry:
            return
        task_dir = SCRIPT_DIR / entry["dir"]
        files = [task_dir / name for name in entry["media"]]
        missing = [str(p) for p in files if not p.is_file()]
        if missing:
            log(f"task {task_id}: thiếu file media local, không upload lại được: {missing}")
            return
        try:
            self.relay.post_result(task_id, entry["result"], files)
            log(f"task {task_id}: đã upload lại kết quả ({len(files)} file)")
        except (TaskLost, TaskStale) as exc:
            log(f"task {task_id}: upload lại bị từ chối ({exc}) — bỏ journal entry")
            self.journal.remove(task_id, delete_files=True)
        except requests.RequestException as exc:
            log(f"task {task_id}: upload lại lỗi mạng ({exc.__class__.__name__}), giữ journal để thử sau")

    # -- lấy task --------------------------------------------------------

    def _input_file_names(self, task: dict) -> list:
        """Tên file input cho image_edit: thử vài vị trí trong task JSON."""
        names = []
        # Trường chính của relay: "input_files" (xem relay/app.py).
        for key in ("input_files", "inputs"):
            raw = task.get(key)
            if isinstance(raw, list):
                for item in raw:
                    if isinstance(item, str):
                        names.append(item)
                    elif isinstance(item, dict) and item.get("name"):
                        names.append(str(item["name"]))
        task_input = task.get("input") or {}
        if isinstance(task_input, dict):
            for key in ("images", "input_images", "files"):
                value = task_input.get(key)
                if isinstance(value, list):
                    for item in value:
                        if isinstance(item, str):
                            names.append(item)
                        elif isinstance(item, dict) and item.get("name"):
                            names.append(str(item["name"]))
        # Bỏ trùng, giữ thứ tự.
        seen = set()
        out = []
        for name in names:
            if name and name not in seen:
                seen.add(name)
                out.append(name)
        return out

    # -- chạy từng loại task --------------------------------------------

    def _save_image_result(self, resp: dict, task_dir: Path) -> tuple:
        """Từ response ảnh local: tải/giải mã media về đĩa, đổi URL
        thành tên file. Trả (result đã sửa, [file media])."""
        data = resp.get("data") or []
        files: list = []
        for item in data:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if url:
                name = _media_filename(url)
                dest = task_dir / name
                self.local.download_media(url, dest)
                files.append(dest)
                item["url"] = name
            elif item.get("b64_json"):
                fmt = "webp"
                raw_fmt = str(item.get("output_format") or "").lower()
                if raw_fmt in ("png", "jpg", "jpeg"):
                    fmt = "jpeg" if raw_fmt == "jpg" else raw_fmt
                name = secrets.token_hex(16) + f".{fmt}"
                dest = task_dir / name
                self.local.decode_b64_to_file(item["b64_json"], dest)
                files.append(dest)
                item.pop("b64_json", None)
                item["url"] = name
        result = rewrite_media_urls(resp, self.cfg.muse2api_base)
        return result, files

    def _execute_image(self, task: dict, task_dir: Path, timeout: int) -> tuple:
        self._set_progress(20)
        self._report_status(task["task_id"], "processing", 20)
        resp = self.local.image(task.get("input") or {}, timeout)
        self._set_progress(80)
        self._report_status(task["task_id"], "processing", 80)
        return self._save_image_result(resp, task_dir)

    def _execute_image_edit(self, task: dict, task_dir: Path, timeout: int) -> tuple:
        names = self._input_file_names(task)
        if not names:
            raise LocalError("task image_edit không có file input nào")
        inputs_dir = task_dir / "inputs"
        inputs_dir.mkdir(parents=True, exist_ok=True)
        local_files = []
        for i, name in enumerate(names):
            dest = inputs_dir / f"input_{i}_{Path(name).name}"
            log(f"task {task['task_id']}: tải input {name}")
            self.relay.get_input(task["task_id"], name, dest)
            local_files.append(dest)
        task_input = task.get("input") or {}
        fields: dict = {
            "prompt": task_input.get("prompt", ""),
            "model": task.get("model") or task_input.get("model") or "muse-image",
        }
        for key in ("size", "response_format", "n", "aspect_ratio"):
            if task_input.get(key) is not None:
                fields[key] = task_input[key]
        fields.setdefault("response_format", "url")
        self._set_progress(20)
        self._report_status(task["task_id"], "processing", 20)
        resp = self.local.image_edit(local_files, fields, timeout)
        self._set_progress(80)
        self._report_status(task["task_id"], "processing", 80)
        return self._save_image_result(resp, task_dir)

    def _execute_video(self, task: dict, task_dir: Path, timeout: int) -> tuple:
        self._set_progress(20)
        self._report_status(task["task_id"], "processing", 20)
        created = self.local.video_create(task.get("input") or {}, timeout)
        local_id = created.get("task_id") or created.get("id")
        if not local_id:
            raise LocalError(f"muse2api tạo video không trả task id: {str(created)[:200]}")
        log(f"task {task['task_id']}: video local {local_id} đã tạo, chờ xong")
        deadline = time.time() + timeout
        last_progress = 15
        while True:
            self._check_lost()
            if self.shutdown.is_set():
                raise LocalError("worker đang tắt, bỏ task video")
            if time.time() > deadline:
                raise LocalError(f"video local quá hạn {timeout}s")
            status = self.local.video_status(local_id)
            state = status.get("status")
            local_progress = int(status.get("progress") or 0)
            # Map tiến độ local 0-100 -> relay 20-80.
            relay_progress = 20 + int(local_progress * 0.6)
            if relay_progress != last_progress:
                last_progress = relay_progress
                self._set_progress(relay_progress)
            if state == "completed":
                url = status.get("url") or (status.get("result") or {}).get("url")
                if not url:
                    raise LocalError("video local xong nhưng không có URL")
                name = _media_filename(url)
                dest = task_dir / name
                self.local.download_media(url, dest)
                result = {
                    "id": local_id,
                    "task_id": local_id,
                    "object": "video.task",
                    "status": "completed",
                    "progress": 100,
                    "url": name,
                    "video": {"url": name},
                    "result": {"url": name},
                }
                self._set_progress(80)
                return rewrite_media_urls(result, self.cfg.muse2api_base), [dest]
            if state in ("failed", "error"):
                err = status.get("error") or "video local thất bại"
                raise LocalError(f"video local failed: {err}")
            time.sleep(10)

    def _execute(self, task: dict) -> tuple:
        """Chạy task local. Trả (result dict, [file media])."""
        kind = task.get("kind")
        task_dir = self.journal.task_dir(task["task_id"])
        timeout = int(task.get("timeout_seconds") or DEFAULT_TIMEOUTS.get(kind, 300))
        task_input = task.get("input") or {}
        if kind == "chat":
            self._set_progress(20)
            self._report_status(task["task_id"], "processing", 20)
            result = self.local.chat(task_input, timeout)
            self._set_progress(80)
            return result, []
        if kind == "responses":
            self._set_progress(20)
            self._report_status(task["task_id"], "processing", 20)
            result = self.local.responses(task_input, timeout)
            self._set_progress(80)
            return result, []
        if kind == "image":
            return self._execute_image(task, task_dir, timeout)
        if kind == "image_edit":
            return self._execute_image_edit(task, task_dir, timeout)
        if kind == "video":
            return self._execute_video(task, task_dir, timeout)
        raise LocalError(f"kind không hỗ trợ: {kind}")

    # -- xử lý một task ---------------------------------------------------

    def _upload_with_retries(self, task_id: str, result: dict, files: list,
                             attempts: int = 3) -> bool:
        """Upload kết quả; lỗi mạng thì thử lại. Trả True nếu relay nhận."""
        for attempt in range(1, attempts + 1):
            self._check_lost()
            try:
                self.relay.post_result(task_id, result, files)
                return True
            except (TaskLost, TaskStale):
                raise
            except requests.RequestException as exc:
                log(f"task {task_id}: upload kết quả lỗi mạng lần {attempt}/{attempts} "
                    f"({exc.__class__.__name__})")
                if attempt < attempts:
                    time.sleep(5 * attempt)
        return False

    def execute_task(self, task: dict) -> None:
        task_id = task.get("task_id")
        kind = task.get("kind")
        if not task_id or not kind:
            log(f"bỏ task lạ (thiếu task_id/kind): {str(task)[:200]}")
            return
        # Task đã xong từ trước (relay gửi lại sau restart): không chạy lại,
        # chỉ upload lại kết quả đã có.
        if task_id in self.journal.entries:
            log(f"task {task_id}: đã có kết quả trong journal — upload lại, không chạy lại")
            self._reupload(task_id)
            return

        self._current_task = task_id
        self._lost.clear()
        self._lost_reason = ""
        self._set_progress(5)
        heartbeat = threading.Thread(
            target=self._heartbeat_loop, args=(task_id,), daemon=True
        )
        heartbeat.start()
        try:
            self._report_status(task_id, "processing", 5)
            log(f"task {task_id} ({kind}): đã nhận, bắt đầu chạy local")
            result, files = self._execute(task)
            self._check_lost()
            # Ghi journal TRƯỚC khi upload: crash giữa chừng vẫn còn bản sao.
            media_names = [p.name for p in files]
            self.journal.add(task_id, kind, result, media_names)
            self._set_progress(90)
            self._report_status(task_id, "processing", 90)
            ok = self._upload_with_retries(task_id, result, files)
            if ok:
                self._set_progress(100)
                log(f"task {task_id} ({kind}): đã upload kết quả ({len(files)} file)")
            else:
                log(f"task {task_id} ({kind}): upload thất bại sau nhiều lần thử — "
                    "giữ journal, sẽ upload lại khi sync")
        except (TaskLost, TaskStale) as exc:
            log(f"task {task_id}: {exc} — bỏ task, không báo kết quả")
            self.journal.remove(task_id)
        except LocalError as exc:
            msg = self.cfg.redact(str(exc))[:MAX_ERROR_LEN]
            log(f"task {task_id}: lỗi local — {msg}")
            try:
                self.relay.post_failed(task_id, msg)
            except (TaskLost, TaskStale):
                log(f"task {task_id}: relay đã mất task, không báo failed được")
            except requests.RequestException:
                log(f"task {task_id}: không báo failed được (mất mạng), relay sẽ requeue")
            self.journal.remove(task_id)
        except requests.RequestException as exc:
            msg = f"lỗi mạng khi chạy task: {exc.__class__.__name__}"
            log(f"task {task_id}: {msg}")
            try:
                self.relay.post_failed(task_id, msg)
            except requests.RequestException:
                pass
            self.journal.remove(task_id)
        except Exception as exc:  # không để một task hỏng làm chết worker
            msg = self.cfg.redact(f"{exc.__class__.__name__}: {exc}")[:MAX_ERROR_LEN]
            log(f"task {task_id}: lỗi không ngờ — {msg}")
            try:
                self.relay.post_failed(task_id, msg)
            except requests.RequestException:
                pass
            self.journal.remove(task_id)
        finally:
            self._lost.set()  # dừng heartbeat thread
            heartbeat.join(timeout=5)
            self._current_task = None
            self._set_progress(0)

    # -- vòng lặp chính ----------------------------------------------------

    def run(self, once: bool = False) -> int:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        removed = self.journal.purge_old()
        if removed:
            log(f"đã dọn {removed} journal entry quá hạn")
        log(f"worker khởi động — relay {self.cfg.relay_url}, "
            f"muse2api {self.cfg.muse2api_base}")
        try:
            self.do_sync()
        except Exception as exc:  # sync lỗi không chặn vòng lặp chính
            log(f"sync khởi động thất bại ({exc.__class__.__name__}), vẫn tiếp tục poll")

        backoff = POLL_BACKOFF_MIN
        while not self.shutdown.is_set():
            try:
                task = self.relay.next_task(LONG_POLL_WAIT)
                backoff = POLL_BACKOFF_MIN
            except RelayAuthError as exc:
                log(f"LỖI XÁC THỰC: {exc} — kiểm tra RELAY_WORKER_KEY, thử lại sau 30s")
                if self.shutdown.wait(timeout=30):
                    break
                continue
            except requests.RequestException as exc:
                log(f"mất kết nối relay ({exc.__class__.__name__}), "
                    f"thử lại sau {backoff}s")
                if self.shutdown.wait(timeout=backoff):
                    break
                backoff = min(backoff * 2, POLL_BACKOFF_MAX)
                try:
                    self.do_sync()
                except Exception:
                    pass
                if once:
                    return 1
                continue
            if task is None:  # 204 — không có task
                if once:
                    log("không có task — thoát (--once)")
                    return 0
                continue
            try:
                self.execute_task(task)
            except Exception as exc:  # không để một task làm chết vòng lặp
                log(f"lỗi không ngờ ở vòng lặp: {self.cfg.redact(str(exc))[:MAX_ERROR_LEN]}")
            if once:
                return 0
        log("worker dừng.")
        return 0


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Muse Relay worker — kéo task từ relay, chạy bằng muse2api local."
    )
    parser.add_argument(
        "--env",
        default=str(SCRIPT_DIR / ".env"),
        help="đường dẫn file .env của worker (mặc định relay/worker/.env)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="xử lý một task rồi thoát (dùng để test)",
    )
    args = parser.parse_args(argv)

    cfg = Config(Path(args.env))
    try:
        cfg.validate()
    except SystemExit as exc:
        print(f"[worker] {exc}", file=sys.stderr)
        return 2

    worker = Worker(cfg)

    def _on_signal(signum, _frame):
        log(f"nhận signal {signum} — dừng nhận task mới, thoát sau task hiện tại")
        worker.shutdown.set()

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    return worker.run(once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())
