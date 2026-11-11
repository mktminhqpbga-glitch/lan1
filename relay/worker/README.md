# Worker Muse Relay — chạy trên máy ảo Muse AI

Worker kéo task từ relay trên Render (long-poll HTTPS **đi ra**), chạy bằng
muse2api nội bộ `http://127.0.0.1:1314`, rồi đẩy kết quả về relay. Chromium,
cookie và tài khoản Muse đều ở trên máy ảo; không có gì trong số đó rời
khỏi máy ảo. Worker **không động vào tiến trình muse2api đang chạy** — nó
chỉ gọi API của muse2api như một client bình thường.

## Cấu hình

```sh
cp relay/worker/.env.example relay/worker/.env
# Mở relay/worker/.env, điền:
#   RELAY_URL=https://<relay>.onrender.com
#   RELAY_WORKER_KEY=<khóa đọc từ Render Dashboard → service relay → Environment>
# MUSE2API_KEY để trống cũng được: worker tự đọc từ ~/workspace/lan1/.env.
```

File `.env` đã được gitignore — không bao giờ commit nó. Không ghi secret
nào vào Git.

## Khởi động

```sh
~/workspace/lan1/.venv/bin/python relay/worker/worker.py
```

Worker chạy ở foreground, log ra stdout (task đã nhận, tiến độ, kết quả
đã upload, lỗi). Muốn chạy nền thì dùng `nohup ... &` hoặc `systemd` —
chưa có sẵn service file trong repo.

## Kiểm tra worker còn sống không

- Nhìn log: mỗi lần long-poll trả 204 thì worker im lặng; khi có task sẽ
  thấy dòng `task <id> (<kind>): đã nhận, bắt đầu chạy local` rồi
  `đã upload kết quả`.
- Kiểm tra relay còn sống: `curl https://<relay>.onrender.com/healthz`
  phải trả `{"status": "ok"}`.
- Kiểm tra muse2api local còn sống: `curl http://127.0.0.1:1314/healthz`.

## Dừng

Bấm `Ctrl+C` hoặc gửi `SIGTERM` (`kill <pid>`). Worker dừng nhận task
mới, cố gắng upload nốt kết quả của task đang chạy (nếu đã xong), rồi
thoát với mã 0. Task đang chạy dở mà chưa kịp xong sẽ được relay đưa về
hàng đợi sau 90 giây không có heartbeat, để worker nhận lại khi chạy
lại — không mất task.

## Phục hồi khi relay restart (không có ổ đĩa bền)

- Worker giữ một **journal** (`relay/worker/worker-journal.json`) và toàn
  bộ file kết quả (`relay/worker/results/<task_id>/`) trên máy ảo, cho tới
  khi relay báo client đã nhận (ack) hoặc quá 24 giờ.
- Mỗi lần khởi động và mỗi lần nối lại sau lỗi mạng, worker gọi
  `POST /worker/sync`, báo task đang chạy dở (`in_flight`) và task đã
  xong nhưng relay chưa xác nhận (`completed_unacked`, kèm result + tên
  file media). Relay trả về từng task có cần upload lại không
  (`needs_upload`); worker upload lại kết quả + file media từ đĩa máy
  ảo, không tạo lại nội dung.
- Nếu relay trả `404` (task đã mất) khi heartbeat/báo trạng thái/upload
  kết quả: worker đánh dấu task đó là mất, gọi lại `/worker/sync`, rồi
  tiếp tục kéo task mới.
- Nếu relay trả `409` (task không còn thuộc worker này): worker dừng
  làm task đó ngay, bỏ kết quả, tiếp tục kéo task mới.
- Một task lỗi (lỗi local, timeout, lỗi mạng) không bao giờ làm chết
  worker: worker báo `failed` cho relay rồi kéo task tiếp theo.

## Test nhanh (không chạy worker thật)

```sh
# Kiểm tra cú pháp + argparse:
~/workspace/lan1/.venv/bin/python -m py_compile relay/worker/worker.py
~/workspace/lan1/.venv/bin/python relay/worker/worker.py --help

# Xử lý đúng một task rồi thoát (cần relay đã deploy + .env đã điền):
~/workspace/lan1/.venv/bin/python relay/worker/worker.py --once
```

## File trong thư mục này

| File | Mô tả |
|---|---|
| `worker.py` | Worker (stdlib + `requests` trong venv lan1). |
| `.env.example` | Mẫu cấu hình (không chứa secret thật). |
| `.env` | Cấu hình thật — tự tạo, không commit. |
| `worker-journal.json` | Journal task đã xong chưa được relay xác nhận — tự tạo, không commit. |
| `results/` | File kết quả giữ trên máy ảo để upload lại — tự tạo, không commit. |
