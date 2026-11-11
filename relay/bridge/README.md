# Bridge trên Mac — lớp tương thích API cho Canvas

Bridge là cầu nối giữa **Canvas trên Mac** và **relay trên Render**.
Nó phơi đúng API OpenAI của muse2api cho Canvas gọi như cũ — Canvas
**không sửa một dòng nào**. Bridge tự chuyển mỗi request thành task
relay, poll relay tới khi xong, rồi trả response đúng định dạng OpenAI.

```
Canvas trên Mac (cổng 5521) ──▶ Bridge (cổng 5522) ──HTTPS──▶ Relay Render
   MUSE_API_BASE=http://127.0.0.1:5522              (task + kết quả)
```

## Bàn giao cho Mac

**Bridge URL:** `http://127.0.0.1:5522`

**Biến môi trường** (file `relay/bridge/.env` trong bản checkout `lan1`
trên Mac — copy từ `.env.example`, điền giá trị thật, không commit):

```env
RELAY_URL=https://<relay>.onrender.com
RELAY_CANVAS_KEY=<paste from Render Dashboard>
BRIDGE_PORT=5522
BRIDGE_HOST=127.0.0.1
```

**Lệnh chạy** (đứng trong thư mục checkout `lan1` trên Mac, một
terminal riêng, giữ chạy trong lúc dùng Canvas):

```sh
python3 relay/bridge/bridge.py
```

Không cần `pip install` gì — bridge chỉ dùng thư viện chuẩn của
Python 3 có sẵn trên Mac. Muốn đổi cổng thì thêm `--port <cổng>` (hoặc
sửa `BRIDGE_PORT` trong `.env`).

**Cấu hình Canvas cho Codex** (file `.env` mà `canvas_server.py` đọc,
trong thư mục Canvas trên Mac):

```env
MUSE_API_BASE=http://127.0.0.1:5522
```

Giữ nguyên `MUSE_API_KEY` cũ của Canvas. **Canvas vẫn ở cổng 5521,
không đổi gì** — chỉ đổi `MUSE_API_BASE` từ muse2api trực tiếp sang
bridge.

**Lưu ý cổng 5522 phải còn trống trên Mac.** Nếu đã có app khác dùng
5522, đặt `BRIDGE_PORT` sang một cổng trống khác và sửa
`MUSE_API_BASE` theo đúng cổng đó.

## Kiểm tra bridge đang chạy

```sh
curl http://127.0.0.1:5522/healthz
# {"status": "ok"}

curl -H "Authorization: Bearer <bat-ky-token-nao>" \
  http://127.0.0.1:5522/v1/models
# {"object": "list", "data": [{"id": "muse-spark", ...}, ...]}
```

## Bridge làm gì

| Canvas gọi | Bridge làm |
|---|---|
| `GET /v1/models` | Trả danh sách model tĩnh, không gọi relay. |
| `POST /v1/chat/completions` | Tạo task relay `kind=chat`, đợi xong, trả JSON gốc. |
| `POST /v1/responses` | Tạo task relay `kind=responses`, đợi xong, trả lại dưới dạng SSE tối thiểu (1 delta + completed) vì client `/v1/responses` của Canvas chỉ hiểu SSE. Không stream token theo thời gian thực. |
| `POST /v1/images/generations` | Tạo task relay `kind=image`, đợi xong, tải file media từ relay, mã hóa base64 theo chunk, trả `data[].b64_json` như Canvas mong đợi. |
| `POST /v1/images/edits` | Nhận multipart từ Canvas, chuyển tiếp sang relay dạng multipart (`request` JSON + file trường `images`), stream file từ đĩa tạm, không load cả file vào RAM. |
| `POST /v1/videos` | Tạo task relay `kind=video`, trả ngay dạng task của muse2api (`queued`, `progress: 10`) — Canvas tự poll. |
| `GET /v1/videos/{id}` | Hỏi trạng thái relay, dịch sang dạng task video của muse2api; khi xong trả URL media tuyệt đối của relay (`.../v1/media/<name>.mp4`) để Canvas tải trực tiếp. |
| `GET /v1/videos/{id}/content` | Dự phòng: bridge tải video từ relay rồi stream về cho Canvas (khi Canvas thấy `completed` mà không có URL). |
| `POST /v1/audio/speech` | Trả `501` — TTS không được relay hỗ trợ (muse2api cũng không có endpoint này). |

Các đường khác → `404` JSON. Thiếu Bearer token từ Canvas → `401`
JSON (bridge chấp nhận bất kỳ Bearer token nào khác rỗng — khóa này
chỉ để bridge tự kiểm tra, **không chuyển lên relay**; bridge gọi
relay bằng `RELAY_CANVAS_KEY` riêng).

## Giới hạn đã biết

- **Chat/ảnh đợi đồng bộ tới hết timeout của task** (chat 300 giây,
  ảnh 240 giây). Request đầu tiên sau khi relay ngủ mất thêm 30–60
  giây để Render đánh thức relay; bridge chịu được vì nó poll chứ
  không timeout nhanh.
- **Video poll như trước**: Canvas hỏi mỗi 2,5 giây, tối đa 240 lần
  (10 phút), khớp timeout video 600 giây của relay.
- **TTS không hỗ trợ**: `POST /v1/audio/speech` luôn trả `501`.
- **Không stream text theo thời gian thực**: chat và `/v1/responses`
  trả nguyên response khi xong; riêng `/v1/responses` được đóng khung
  SSE để client của Canvas đọc được.
- **Video có ảnh tham chiếu**: bridge chuyển các file ảnh (`first_frame`,
  `last_frame`, `images`) sang relay; file video/audio tham chiếu
  (`video[]`, `audio[]`) hiện chưa có trong hợp đồng relay nên bị bỏ
  qua (ghi log).
- **Task mất khi relay restart**: bridge tự tạo lại task với cùng
  `idempotency_key` (tối đa 3 lần) cho các endpoint đợi đồng bộ
  (chat/responses/ảnh). Với video, task đã mất thì lần poll tiếp theo
  trả `failed` — cần tạo task video mới từ Canvas.
- **Dừng bridge**: `Ctrl+C` hoặc `kill` (SIGINT/SIGTERM) — tắt sạch.
  Log mỗi request ra stdout (thời gian, method, path, task id,
  trạng thái) — không bao giờ in khóa.
