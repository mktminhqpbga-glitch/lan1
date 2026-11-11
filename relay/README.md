# Muse Relay — kiến trúc và hợp đồng API

Hệ thống mới, độc lập. Không dùng `mooz-relay` hay service muse2api cũ
trên Render (cả hai đã bị xóa cùng Blueprint của chúng ngày 11/11/2026).

## 1. Kiến trúc

```
Canvas trên Mac ──HTTPS──▶ Relay trên Render Free ──HTTPS (worker kéo)──▶ Worker trên máy ảo
   (MUSE_API_BASE      (hàng đợi task + kết quả,                 (gọi muse2api
    → bridge local)     KHÔNG chạy Chromium,                     127.0.0.1:1314,
                        KHÔNG chạy muse2api)                    Chromium + cookie
                                                                  + tài khoản ở đây)
```

- Mọi kết nối đều do **worker khởi xướng đi ra** (long-poll HTTPS tới
  relay). Không có kết nối nào đi vào máy ảo. Không SSH tunnel, reverse
  tunnel, port forwarding hay vượt giới hạn mạng.
- **Bridge trên Mac** là lớp tương thích: nó phơi đúng API OpenAI của
  muse2api (`/v1/models`, `/v1/chat/completions`, `/v1/images/generations`,
  `/v1/images/edits`, `/v1/videos`, `/v1/videos/{id}`, `/v1/responses`)
  cho Canvas gọi như cũ — Canvas **không sửa một dòng nào**. Bridge tự
  chuyển mỗi request thành task relay, poll relay tới khi xong, rồi trả
  response đúng định dạng OpenAI cho Canvas.
- **Relay** chỉ là hàng đợi + kho kết quả tạm. Nó không biết khóa API nội
  bộ của muse2api, không biết cookie Muse. Nó chỉ biết hai khóa riêng
  của nó (xem mục 4).
- **Worker** giữ khóa muse2api của máy ảo (đọc từ `lan1/.env` local) và
  chỉ gọi `http://127.0.0.1:1314`.

## 2. Cổng Canvas (đã xác nhận trên Mac, 11/11/2026)

- Canvas trên Mac chạy tại **`http://127.0.0.1:5521`** — Infinite Canvas
  (React/Vite), phục vụ bởi Python `canvas_server.py`, thư mục
  `/Users/phamminh/Desktop/ToonFlow-App-feat-toonflow-functional-completion/ToonFlow-App`;
  `/` và `/healthz` đều trả HTTP 200. **Giữ nguyên cổng 5521, không
  sửa giao diện, mã nguồn hay cổng của Canvas.**
- Cổng `521` chỉ là mặc định trong repo (`CANVAS_PORT`, mặc định 521);
  bản trên Mac dùng `CANVAS_PORT=5521`.
- **Bridge trên Mac dùng cổng riêng `5522`** (`BRIDGE_PORT=5522`),
  Canvas trỏ `MUSE_API_BASE=http://127.0.0.1:5522` sang bridge. Nếu
  5522 bận, đổi `BRIDGE_PORT` sang cổng trống khác và sửa
  `MUSE_API_BASE` theo.

## 3. Hợp đồng API relay

Base URL: `https://<relay>.onrender.com`. Mọi response JSON trừ media.

### 3.1 Xác thực

Hai Bearer token riêng, đặt bằng biến môi trường trên Render (do Render
sinh, không có trong repo):

- `RELAY_CANVAS_KEY` — bridge (phía Mac) dùng, cho các endpoint `/v1/*`.
- `RELAY_WORKER_KEY` — worker (phía máy ảo) dùng, cho các endpoint
  `/worker/*`.

Không key → 401. Sai vai trò (canvas key gọi `/worker/*` và ngược lại)
→ 403.

### 3.2 Client (bridge) API — auth: Canvas key

`POST /v1/tasks` — tạo task. Body JSON:

```json
{
  "kind": "chat | image | image_edit | video | responses",
  "model": "muse-spark | muse-image | muse-video",
  "input": { "...body OpenAI gốc, giữ nguyên..." },
  "idempotency_key": "uuid-do-client-tạo"
}
```

- `image_edit`: gửi `multipart/form-data` thay vì JSON: trường `request`
  là JSON trên, các file ảnh đính kèm trường `images` (1..n file).
- Trả `202 {"task_id", "status": "queued", "created_at"}`.
- Gửi lại cùng `idempotency_key` → trả task cũ, không tạo task mới
  (chống task trùng khi client retry).

`GET /v1/tasks/{task_id}` — trạng thái:

```json
{
  "task_id": "...", "kind": "image", "status": "queued | processing | completed | failed | timeout",
  "progress": 0-100, "error": null | "lý do",
  "result": null | { "...response OpenAI gốc..." },
  "result_media": null | ["<name>.webp", ...]
}
```

- `image`/`image_edit`/`chat`/`responses` khi xong: `result` là response
  OpenAI đầy đủ (bridge trả nguyên vẹn cho Canvas).
- `video` khi xong: `result` là `{"url": "/v1/media/<name>.mp4", ...}` —
  bridge dịch sang định dạng task video của muse2api cho Canvas poll.

`GET /v1/media/{name}` — tải file kết quả (ảnh/video). Không cần auth
(theo thiết kế của muse2api): tên file 32 ký tự hex ngẫu nhiên, không
đoán được; chỉ ai có URL (tức là người tạo task) mới tải được. Stream
từ đĩa, không load toàn bộ file vào RAM.

`POST /v1/tasks/{task_id}/ack` — client xác nhận đã nhận kết quả. Relay
được phép xóa task + media để giải phóng chỗ.

`GET /healthz` — public, `{"status": "ok"}` (Render health check).

### 3.3 Worker API — auth: Worker key

`GET /worker/tasks/next?wait=25` — long-poll lấy task. Có task đang
`queued` → trả ngay task JSON `{task_id, kind, model, input,
idempotency_key, timeout_seconds}`. Hết `wait` giây không có task → `204`.
Worker gọi lại ngay sau mỗi lần trả (kể cả 204) — nhịp này giữ relay
thức khi đang làm việc, và là heartbeat gián tiếp. **Mọi request
`/worker/*` phải kèm header `X-Worker-Id` (một ID ổn định của worker,
worker tự sinh một lần và giữ qua các lần khởi động) — relay dùng nó
để biết task thuộc về worker nào; thiếu header → 400.**

`GET /worker/tasks/{task_id}/inputs/{name}` — tải file input của task
(ảnh reference cho `image_edit`). Stream.

`POST /worker/tasks/{task_id}/heartbeat` — `{progress}`. Worker gửi mỗi
30 giây trong khi chạy. Relay coi task là "mất worker" nếu quá 90 giây
không có heartbeat → đưa task về `queued` để worker khác (hoặc chính
worker đó khi nối lại) nhận lại. Worker trước khi báo kết quả phải kiểm
tra mình còn là chủ task không; kết quả của chủ cũ bị từ chối `409`.

`POST /worker/tasks/{task_id}/status` — `{status: "processing",
progress, error?}`.

`POST /worker/tasks/{task_id}/result` — `multipart/form-data`: trường
`result` là JSON (response OpenAI hoặc thông tin video), các file đính
kèm trường `files`. Relay lưu file xuống đĩa (stream theo chunk), đánh
dấu task `completed`. Trả `200` khi đã ghi xong.

`POST /worker/tasks/{task_id}/failed` — `{error}`. Đánh dấu task `failed`.

`POST /worker/sync` — worker (re)kết nối gửi danh sách task nó đang giữ:

```json
{"in_flight": ["task_id", ...], "completed_unacked": [{"task_id": "...", "result": {...}, "media": ["..."]}]}
```

Relay đối chiếu sau khi nó restart (xem mục 5).

### 3.4 Timeout

Theo từng loại (khớp timeout của muse2api): chat 300s, image 240s,
video 600s. Quá hạn mà worker chưa báo xong → relay đánh `timeout`,
worker hủy cuộc gọi local nếu còn chạy (best effort) và không báo kết
quả cho task đó nữa.

## 4. Biến môi trường

Relay trên Render (do Render sinh bằng `generateValue`, đọc lại từ
Dashboard → Environment sau khi deploy):

- `RELAY_CANVAS_KEY` — bridge dùng.
- `RELAY_WORKER_KEY` — worker dùng.

Không có biến nào khác bắt buộc. Tùy chọn:

- `RELAY_DATA_DIR` (mặc định `/app/data`) — nơi relay lưu task + media
  trên đĩa tạm của container.
- `RELAY_TASK_TTL_HOURS` (mặc định 24) — task completed quá hạn thì dọn.
- `RELAY_MAX_MEDIA_MB` (mặc định 2048) — tổng dung lượng media tối đa,
  vượt thì xóa task completed cũ nhất (LRU).

Worker trên máy ảo (file config local `relay/worker/.env`, KHÔNG commit):

- `RELAY_URL=https://<relay>.onrender.com`
- `RELAY_WORKER_KEY=<khóa đọc từ Render Dashboard>`
- `MUSE2API_BASE=http://127.0.0.1:1314`
- `MUSE2API_KEY=<khóa trong lan1/.env của máy ảo>`

Bridge trên Mac (file config local, KHÔNG commit):

- `RELAY_URL=https://<relay>.onrender.com`
- `RELAY_CANVAS_KEY=<khóa đọc từ Render Dashboard>`
- `BRIDGE_PORT` (mặc định 5522) — cổng bridge phơi API cho Canvas.
- Canvas trên Mac đặt `MUSE_API_BASE=http://127.0.0.1:5522` (trỏ sang
  bridge thay vì muse2api trực tiếp). Canvas vẫn chạy ở cổng 5521,
  không đổi gì. Khóa API Canvas giữ nguyên khóa cũ của muse2api (bridge
  tự kiểm tra, không chuyển nó đi đâu).

## 5. Phục hồi khi relay restart (không có ổ đĩa bền)

Relay lưu task + media trên đĩa tạm của container. Restart/redeploy sẽ
xóa hết. Cơ chế phục hồi:

1. **Relay khởi động** quét lại thư mục dữ liệu (thường là trống sau
   restart) và dựng lại index. Mọi task `processing` còn sót lại (nếu
   đĩa chưa mất) được đưa về `queued`.
2. **Worker reconnect** gọi `POST /worker/sync` ngay khi nối lại, báo
   task nó đang chạy dở (`in_flight`) và task đã xong nhưng client chưa
   ack (`completed_unacked`, kèm result + tên file media nó vẫn giữ
   trên máy ảo). Relay:
   - Task trong `completed_unacked` mà relay đã mất → tạo lại bản ghi
     `completed`, worker upload lại media (nó vẫn còn trên máy ảo).
     Không tạo lại nội dung.
   - Task trong `in_flight` mà relay đã mất → tạo lại bản ghi
     `processing` gán cho chính worker đó (worker đang chạy dở, sẽ báo
     kết quả khi xong — không đưa về `queued` để tránh worker khác
     nhận trùng).
3. **Client (bridge)** khi hỏi task mà relay trả `404 unknown` → coi như
   task đã mất theo relay, gửi lại task với cùng `idempotency_key`.
   Nếu worker đã làm xong task đó rồi, nó sẽ báo lại qua `/worker/sync`
   mà không tạo mới (xem bước 2).
4. **Máy ảo là kho bền cuối cùng**: worker giữ mọi kết quả trên máy ảo
   cho tới khi client ack. Relay chỉ là bản sao tạm. Mất relay không
   bao giờ làm mất kết quả đã tạo.

## 6. Giới hạn Render Free (đã kiểm tra)

- 1 service, **512 MB RAM, 0.1 CPU**, ngủ sau **15 phút** không có
  request, **750 giờ/tháng** (ngân sách chung cho mọi service Free).
- Relay nhẹ (FastAPI, không Chromium) nên 512 MB là đủ. Media lưu trên
  đĩa tạm, stream theo chunk, không giữ file trong RAM.
- Worker long-poll giữ relay thức khi đang làm việc. Relay thức liên
  tục ≈ 720 giờ/tháng, gần cạn ngân sách 750 giờ nếu cộng thêm
  toonflow-app. **Cách vận hành khuyến nghị: chỉ chạy worker khi đang
  dùng Canvas** (bật worker lên làm việc, xong tắt đi) — relay sẽ ngủ
  khi không ai dùng. Request đầu tiên sau khi ngủ mất 30–60 giây để
  đánh thức relay; bridge chịu được (nó poll, không timeout nhanh).
- Không dùng gói trả phí. Muốn relay luôn thức + có ổ đĩa bền thì cần
  Starter 7 USD/tháng + disk 0.25 USD/GB/tháng — chưa làm, cần phê
  duyệt chi phí trước.

## 7. Những gì relay KHÔNG làm

- Không chạy Chromium, không chạy muse2api, không giữ cookie Muse,
  không giữ khóa API nội bộ của muse2api.
- Không hỗ trợ TTS (`/audio/speech`): muse2api không có endpoint này
  nên Canvas gọi TTS qua bridge sẽ nhận lỗi rõ ràng (501), giống như
  gọi thẳng muse2api hiện tại. Ngoài phạm vi.
- Không stream text theo thời gian thực: chat qua relay trả về nguyên
  response khi xong. Riêng `/v1/responses`, bridge đóng khung kết quả
  đã xong thành SSE tối thiểu (một `response.output_text.delta` mang
  toàn bộ text, một `response.completed`, rồi `[DONE]`) vì client
  responses của Canvas chỉ hiểu SSE — không phải stream token thật.
- Video reference dạng file video/audio bị bridge bỏ qua (relay không
  có trường cho chúng); chỉ ảnh reference (`first_frame`, `last_frame`,
  `images`) được chuyển tiếp. Text-to-video và video có ảnh reference
  vẫn hoạt động.

## 8. Đóng gói Bridge thành app macOS (sẵn sàng, chưa build app)

Bridge được thiết kế từ đầu để đóng gói cùng ứng dụng Canvas
(`.app`/`.dmg`) — xem `relay/bridge/INTEGRATION.md` (tài liệu cho Codex):

- Chạy dưới dạng tiến trình con của app, không cần Terminal.
- Cổng động: `--port 0` (hệ điều hành chọn cổng trống) + báo cổng thực
  tế qua dòng JSON `bridge_ready` trên stdout và file `--ready-file`.
- Tự tắt khi app thoát: SIGTERM/SIGINT + watchdog (cha chết → tắt).
- Tự kết nối lại relay: retry tới 120 giây khi relay Free đang ngủ.
- Khóa qua Keychain: app đọc `RELAY_CANVAS_KEY` từ Keychain, truyền
  qua biến môi trường cho Bridge; không nhúng khóa vào frontend hay
  bundle. Thứ tự ưu tiên cấu hình: CLI > env > `.env`.
- Khôi phục task khi mở lại app: journal local `bridge-tasks.json`
  trong `--data-dir` + endpoint nội bộ `GET /bridge/tasks`,
  `GET /bridge/tasks/{id}`; kết quả trên relay giữ 24 giờ.
- Không phụ thuộc đường dẫn tuyệt đối hay Python cài sẵn: Bridge chỉ
  dùng stdlib, đóng gói bằng PyInstaller onefile hoặc Python.framework
  nhúng trong app.

## 9. Cấu trúc file

```
relay/
  README.md            # file này
  app.py               # FastAPI relay
  requirements.txt     # fastapi, uvicorn, python-multipart
  Dockerfile           # python:3.11-slim, chạy uvicorn với $PORT
  .dockerignore
  worker/
    worker.py          # worker máy ảo (requests, long-poll)
    README.md          # cách chạy trên máy ảo
    .env.example       # mẫu config (không chứa secret thật)
  bridge/
    bridge.py          # bridge Mac (chỉ dùng stdlib, không cần pip)
    README.md          # cách chạy trên Mac + cấu hình Canvas
    INTEGRATION.md     # tich hop bridge vao app macOS (.app/.dmg) — cho Codex
    .env.example
render.yaml            # Blueprint: 1 web service Docker, Free, Singapore
```

## 9. Kế hoạch kiểm thử (tối thiểu hạn mức Muse)

1. Mac (mô phỏng bằng bridge chạy trên máy ảo) gửi task lên Render.
2. Worker máy ảo kéo được task.
3. Worker gọi muse2api nội bộ `:1314`.
4. Relay nhận trạng thái + kết quả.
5. Bridge trả đúng định dạng OpenAI; Canvas (kiểm chứng bằng bridge)
   nhận được ảnh/video.
6. Mất mạng (dừng worker giữa task), restart relay, task trùng
   (cùng idempotency_key), timeout.

Chỉ chạy tối thiểu: 1 chat, 1 ảnh, 1 video ngắn. Không tạo thêm nội
dung ngoài kiểm thử.
