# Triển khai Muse2API lên Render

Nhánh: `deploy/render-muse2api` (tách riêng khỏi `main`, không động vào
Canvas hay công việc Việt hóa). Chỉ triển khai **muse2api** — không kèm
canvas, không kèm Agent. Bản trên máy ảo Muse (`127.0.0.1:1314`) không thay
đổi và vẫn chạy song song.

## 1. File trong nhánh này

| File | Thay đổi |
|---|---|
| `render.yaml` | Mới. Blueprint: Web Service Docker, gói Free, region Singapore, health check `/healthz`. |
| `muse2api/Dockerfile` | CMD dùng `$PORT` do Render cấp (mặc định 18610 khi chạy local) + `--proxy-headers`. |
| `muse2api/.dockerignore` | Mới. Loại `data/` (tài khoản/cookie/media) khỏi image. |
| `DEPLOY_RENDER.md` | File này. |

Không sửa `app.py`, `config.py`, `engine.py` hay bất cứ file Canvas nào.

## 2. Cách tạo service trên Render

1. Render Dashboard → **New → Blueprint** → chọn repo `mktminhqpbga-glitch/lan1`,
   nhánh `deploy/render-muse2api` → **Apply**.
2. Render tạo service `muse2api` theo `render.yaml`, sinh `MUSE2API_KEY`
   ngẫu nhiên (giữ nguyên qua các lần deploy sau). Đọc khóa tại
   Dashboard → service `muse2api` → **Environment** (bấm reveal).
3. URL: `https://muse2api.onrender.com` (nếu tên bị trùng, Render thêm hậu tố
   — lấy URL thực tế trên dashboard).

Không cần nhập thêm biến nào. `MUSE2API_KEY` là biến duy nhất bắt buộc.

## 3. Giới hạn của gói Free (quan trọng)

- **Không có persistent disk.** Tài khoản Muse, cookie, phiên Chromium, tác
  vụ và media đều lưu trong `/app/data` — **mất hết mỗi lần redeploy hoặc
  restart**. Sau mỗi lần deploy phải nhập lại tài khoản (xem mục 5).
- **Ngủ sau 15 phút không có request.** Request đầu tiên sau khi ngủ mất
  30–60 giây để đánh thức (kể cả Chromium khởi động lại).
- **512 MB RAM, 0.1 CPU.** Đã giới hạn `MUSE2API_CONCURRENCY=1`. Tạo ảnh
  có thể chạy được nhưng chậm; tạo video nhiều khả năng quá tải/timeout.
- **750 giờ/tháng.** Một service chạy liên tục ≈ 720 giờ/tháng nên vừa đủ
  cho 1 service Free.

### Nâng cấp khi cần (cần chủ repo chấp thuận chi phí trước khi làm)

- Web Service **Starter: 7 USD/tháng** (512 MB RAM, 0.5 CPU, không ngủ).
- Persistent Disk: **0.25 USD/GB/tháng** (tối thiểu 1 GB), gắn tại
  `/app/data` — giữ được tài khoản/cookie/media qua redeploy.
- Giá theo bảng giá Render tại thời điểm tạo, kiểm tra lại lúc thanh toán.
- Thêm `disk:` vào `render.yaml` chỉ khi đã chuyển sang gói trả phí
  (disk không dùng được với gói Free).

## 4. Rà soát bảo mật (đã kiểm tra mã nguồn)

Các endpoint không cần xác thực là **thiết kế có chủ ý của upstream**,
được ghi trong chính trang quản trị (`admin.html`):

- `GET /healthz` — public, Render cần để health check.
- `GET /readyz` — public, chỉ tiết lộ số tài khoản + Chromium có chạy không.
- `GET /v1/media/{name}` — public **theo thiết kế**: Canvas phát video
  bằng thẻ `<video>` nên không gửi được header `Authorization`.
  Tên file là 32 ký tự hex ngẫu nhiên (128 bit, không đoán được); URL chỉ
  xuất hiện trong response của API đã xác thực. Không chia sẻ URL media.
- `GET /`, `GET /admin` — chỉ trả trang quản trị tĩnh; mọi API đằng sau
  đều cần key.
- `GET /admin/extension`, `/admin/extension/files`, `/admin/cookie-helper`
  — chỉ trả code/script hỗ trợ công khai, không chứa secret.

Còn lại tất cả `/v1/*` và `/admin/*` đều yêu cầu
`Authorization: Bearer <MUSE2API_KEY>` (đã kiểm tra: gọi không key trả 401).

- **CORS `allow_origins=["*"]` là có chủ ý**: Canvas và các client trình
  duyệt gọi API từ origin bất kỳ; khóa API là lớp bảo vệ. Không thu hẹp
  vì sẽ chặn Canvas trên Mac. Lưu ý: biến `MUSE2API_CORS_ORIGINS` trong
  code hiện không được middleware dùng tới (chỉ dùng cho flow nhập cookie
  từ trang muse.ai) — nối nó vào sẽ chặn Canvas nên **không sửa**.
- **Không có secret nào trong repo**: `.env` đã gitignored; khóa Render
  do Render sinh (`generateValue: true`); `.dockerignore` chặn `data/`
  khỏi image. Không commit cookie/tài khoản.

### Khóa API và Canvas công khai

`/config.js` của Canvas nhúng `MUSE_API_KEY` theo thiết kế của upstream —
ai mở được Canvas là thấy khóa. Vì vậy:

- Chỉ dùng Canvas Render-key này trên máy cá nhân / mạng tin cậy, **không
  chia sẻ URL Canvas công khai**.
- Nếu Canvas cần dùng công khai: đặt Canvas sau một lớp proxy riêng có
  xác thực (ví dụ Basic Auth / OAuth) và chỉ proxy mới giữ khóa thật —
  Canvas không gọi thẳng Render nữa. Chưa triển khai trong nhánh này.

## 5. Nhập tài khoản Muse vào service Render

Sau khi deploy xong và service chạy:

1. Lấy cookie tài khoản Muse từ máy đang đăng nhập Muse (extension
   `muse2api/extension/` hoặc trang quản trị của bản máy ảo
   → Admin → Accounts → Export).
2. Vào trang quản trị của service Render
   (`https://muse2api.onrender.com/admin`), nhập `MUSE2API_KEY`
   → **Accounts → Import / Add account** → dán cookie → **Test**.
   Kiểm tra trả về "会话有效，可正常生成" (phiên hợp lệ, tạo được).
3. Lưu ý: tài khoản nhập vào service Render là **bản sao độc lập** — dùng
   chung tài khoản với bản máy ảo; quota Free plan của Muse vẫn chung
   theo tài khoản.

Không nhập cookie bằng cách commit file hay gửi qua log.

## 6. Kiểm thử sau deploy (phân biệt rõ từng mức)

| # | Kiểm tra | Cách | Đạt khi |
|---|---|---|---|
| 1 | API chạy | `GET /healthz` | `{"status":"ok"}` |
| 2 | Xác thực | `GET /v1/models` + Bearer key | Trả `muse-spark`, `muse-image`, `muse-video` |
| 3 | Tài khoản Muse | Admin → Test account | "会话有效，可正常生成" |
| 4 | Chat | `POST /v1/chat/completions` (muse-spark) | Trả text |
| 5 | Tạo ảnh | `POST /v1/images/generations` (muse-image) | Trả URL/b64 ảnh thật |
| 6 | Tạo video | `POST /v1/videos` rồi `GET /v1/videos/{id}` | Trả video thật, hoặc lỗi rõ ràng |
| 7 | Media/Admin | `GET /v1/media/{name}`, mở `/admin` với key | Ảnh tải được, trang quản trị mở được |

Không kết luận "hoàn tất" nếu mới chỉ có `/healthz`. Nếu Muse giới hạn
video theo khu vực/tài khoản thì báo đúng lỗi và dừng — không tìm cách
vượt giới hạn.

## 7. Cấu hình Canvas trên Mac

Trong `.env` của `lan1` trên Mac:

```env
MUSE_API_BASE=https://muse2api.onrender.com
MUSE_API_KEY=<khóa đọc từ Render Dashboard → Environment>
```

Không thêm `/v1` ở cuối Base URL — frontend Canvas tự ghép endpoint.
Khóa này khác khóa của bản máy ảo. Nếu service Render ngủ (gói Free),
request đầu tiên sẽ chậm 30–60 giây rồi mới chạy.
