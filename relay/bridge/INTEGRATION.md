# Tích hợp Bridge vào ứng dụng macOS (.app/.dmg) — tài liệu cho Codex

Bridge (`relay/bridge/bridge.py`) được thiết kế từ đầu để đóng gói cùng
ứng dụng Canvas: chỉ dùng Python stdlib (không cần pip, không cần Python
cài sẵn nếu đóng gói kèm interpreter), không dùng đường dẫn tuyệt đối
cứng, không nhúng secret vào frontend. Tài liệu này là hợp đồng tích
hợp — Codex cấu hình app theo đúng các mục dưới đây, không cần sửa
Bridge hay Canvas.

## 1. Bridge là gì (tóm tắt)

- Bridge là tiến trình con chạy trên máy người dùng, phơi API tương
  thích OpenAI (`/v1/models`, `/v1/chat/completions`, `/v1/responses`,
  `/v1/images/generations`, `/v1/images/edits`, `/v1/videos`,
  `/v1/videos/{id}`, `/v1/videos/{id}/content`) cho Canvas gọi.
- Bridge chuyển mỗi request thành task trên Render Relay, poll tới khi
  xong, trả kết quả đúng định dạng Canvas cần. Canvas không sửa gì.
- Bridge chỉ biết `RELAY_CANVAS_KEY` (khóa riêng của relay). Nó không
  biết khóa muse2api nội bộ của máy ảo và không biết cookie Muse.

## 2. Khởi động Bridge từ app

App spawn Bridge như một tiến trình con (không mở Terminal):

```text
<app>/Contents/Resources/bridge/bridge
  --env <app>/Contents/Resources/bridge/.env
  --port 0
  --data-dir <Application Support>/MuseRelay
  --parent-pid <pid-cua-app>
  --ready-file <Application Support>/MuseRelay/bridge-ready.json
```

- `--port 0`: để hệ điều hành chọn cổng trống (tránh đụng cổng trên máy
  người dùng). **Không** cố định 5522 trong bản đóng gói.
- `--parent-pid`: Bridge tự tắt khi app thoát (xem mục 5).
- `--ready-file`: Bridge ghi file JSON khi đã lắng nghe xong (mục 3).
- `--data-dir`: journal task + dữ liệu local của Bridge (mục 6).
- `--env`: file cấu hình. Trong bản đóng gói, app **tự sinh file này**
  khi chạy lần đầu (ghi `RELAY_URL` + `RELAY_CANVAS_KEY` lấy từ Keychain,
  xem mục 4) — không ship file `.env` có secret thật trong `.app`/`.dmg`.

Chạy thủ công (dev, không đóng gói) vẫn được, xem `relay/bridge/README.md`:
`python3 relay/bridge/bridge.py` (mặc định cổng 5522).

## 3. Giao thức ready — app biết Bridge đã sẵn sàng ở cổng nào

Khi đã lắng nghe xong, Bridge:

1. In một dòng JSON ra stdout:
   `{"event": "bridge_ready", "host": "127.0.0.1", "port": 51234, "url": "http://127.0.0.1:51234"}`
2. Ghi cùng nội dung vào `--ready-file` (ghi atomic: file tạm + đổi tên).

App đọc cổng thực tế từ stdout hoặc ready-file, rồi mới khởi động
Canvas với `MUSE_API_BASE=<url-cua-bridge>`. Thứ tự khởi động:

```
app → spawn bridge (--port 0) → đợi ready (stdout/ready-file)
    → spawn canvas_server.py với MUSE_API_BASE=http://127.0.0.1:<port>
    → Canvas chạy ở cổng 5521 như cũ, không đổi gì
```

## 4. Khóa — Keychain, không nhúng vào frontend

- `RELAY_CANVAS_KEY` là khóa duy nhất Bridge cần. App lưu nó trong
  **macOS Keychain** (`SecItemAdd` / `SecItemCopyMatching`, service
  `MuseRelay`, account `canvas`).
- Khi spawn Bridge, app đọc khóa từ Keychain và truyền qua **biến môi
  trường** (`RELAY_CANVAS_KEY=...`) hoặc ghi vào file `.env` trong
  Application Support (quyền 600, không nằm trong bundle app).
- Biến môi trường thắng file `.env` (thứ tự ưu tiên: CLI > env > `.env`).
- **Không bao giờ** đặt khóa vào mã frontend, vào bundle `.app`, vào
  file cấu hình ship kèm, hay vào log. Bridge không in khóa ra log.
- `MUSE_API_KEY` (khóa Canvas cũ) giữ nguyên trong cấu hình Canvas —
  Bridge chỉ kiểm tra nó có khác rỗng, không chuyển nó đi đâu.

## 5. Kiểm tra kết nối, tự kết nối lại, dừng khi app thoát

- **Health check:** `GET http://127.0.0.1:<port>/healthz` → `{"status":"ok"}`.
  App gọi endpoint này để hiển thị trạng thái Bridge.
- **Tự kết nối lại relay:** Bridge retry mọi cuộc gọi lên relay tới 120
  giây khi gặp lỗi tạm thời (relay Free ngủ thì mất 30–60 giây để đánh
  thức). Tạo task có `idempotency_key` nên retry POST không tạo task
  trùng. App không cần tự retry hộ Bridge.
- **Dừng khi app thoát:** Bridge tự tắt khi (a) nhận SIGTERM/SIGINT,
  (b) tiến trình cha chết — watchdog kiểm tra PID `--parent-pid` mỗi
  2 giây, PID không còn thì tắt Bridge. App phải luôn truyền
  `--parent-pid` khi spawn Bridge. App thoát bình thường thì gửi
  SIGTERM cho Bridge rồi đợi nó tắt; nếu app crash, watchdog sẽ tắt
  Bridge trong vòng ~2 giây. (Không dùng kiểm tra `ppid == 1` để
  tránh tắt nhầm khi Bridge chạy standalone bằng `nohup`.)
- Bridge không tự chạy lại sau khi tắt — app chịu trách nhiệm spawn lại
  khi cần (ví dụ khi người dùng mở lại Canvas).

## 6. Khôi phục task khi mở lại app

- Relay giữ task đã xong trong **24 giờ** (hoặc tới khi client ack).
  Bridge chỉ ack sau khi đã trả kết quả cho Canvas.
- Bridge ghi journal local `bridge-tasks.json` trong `--data-dir`
  (tối đa 200 task gần nhất; chỉ lưu task_id/kind/model/trạng thái —
  không lưu prompt, không lưu secret).
- App truy vấn journal qua endpoint nội bộ của Bridge (chỉ nghe trên
  localhost, không cần Bearer key của Canvas):
  - `GET /bridge/tasks` → `{"tasks": [{task_id, kind, model, status, created_at, updated_at}]}` (mới nhất trước).
  - `GET /bridge/tasks/{task_id}` → trạng thái task trên relay (hoặc
    bản ghi journal nếu relay đã mất task).
- Luồng khôi phục khi mở lại app: đọc `/bridge/tasks` → với mỗi task
  chưa xong (`submitted`/`processing`), hỏi lại `/bridge/tasks/{id}` →
  nếu `completed` thì lấy kết quả từ relay như bình thường (trong cửa
  sổ 24 giờ của relay); nếu relay trả 404 thì task đã quá hạn, app báo
  cho người dùng tạo lại.

## 7. Đóng gói — không phụ thuộc Python cài sẵn hay đường dẫn tuyệt đối

- Bridge chỉ dùng stdlib (`http.server`, `urllib`, `json`, `base64`,
  `threading`, `uuid`, `tempfile`, `mimetypes`). Hai cách đóng gói:
  1. **PyInstaller onefile** (khuyến nghị): `pyinstaller --onefile
     --name bridge bridge.py` → một file thực thi duy nhất, không cần
     Python trên máy người dùng. Đặt file này vào
     `<app>/Contents/Resources/bridge/bridge`.
  2. Nhúng `Python.framework` vào app và chạy `bridge.py` bằng
     interpreter đó.
- Bridge tự xác định đường dẫn theo vị trí file thực thi/script
  (`__file__`), không dùng CWD, không dùng đường dẫn tuyệt đối cứng.
  Mọi đường dẫn app cần (`.env`, `--data-dir`, `--ready-file`) đều
  truyền qua tham số/biến môi trường.
- macOS Gatekeeper: file thực thi của Bridge phải được ký (codesign)
  cùng bundle app và notarize cùng `.dmg`. Bridge cần quyền mạng:
  kết nối HTTPS ra ngoài tới relay + lắng nghe localhost (entitlement
  `com.apple.security.network.client` và `...server` nếu app dùng
  sandbox).

## 8. Cấu hình Canvas (không sửa mã Canvas)

- Canvas giữ nguyên ở cổng **5521** (`CANVAS_PORT=5521`).
- Chỉ thay đổi cấu hình API của Canvas khi app khởi động Canvas:
  `MUSE_API_BASE=http://127.0.0.1:<port-cua-bridge>` (port đọc từ
  ready-file, mục 3). `MUSE_API_KEY` giữ nguyên.
- Kiểm chứng nhanh sau khi tích hợp: mở Canvas, tạo một ảnh — ảnh phải
  về qua Bridge → Relay → Worker máy ảo (xem `relay/README.md` mục 9
  để biết các bước kiểm thử đầy đủ).

## 9. Checklist cho Codex

- [ ] Spawn Bridge với `--port 0 --parent-pid <pid> --ready-file ... --data-dir ...`
- [ ] Đợi ready (stdout JSON hoặc ready-file) trước khi spawn Canvas
- [ ] Truyền `MUSE_API_BASE=http://127.0.0.1:<port>` cho Canvas
- [ ] Lưu `RELAY_CANVAS_KEY` trong Keychain, truyền qua env khi spawn
- [ ] Gửi SIGTERM cho Bridge khi app thoát; watchdog lo trường hợp crash
- [ ] Hiển thị trạng thái Bridge qua `GET /healthz`; khôi phục task qua
      `GET /bridge/tasks` khi mở lại app
- [ ] Không ship `.env` có secret thật trong bundle; không log khóa
