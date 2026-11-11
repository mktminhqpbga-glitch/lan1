# Muse–Canvas — Hướng dẫn tiếng Việt

> Repo này kết hợp **muse2api**, **Canvas vô hạn** và **Canvas Agent (Codex + DeepSeek)**. Giao diện tiếng Việt được bổ sung theo cách không thay đổi endpoint, thông số API, cơ chế xác thực, tên model hay dữ liệu tài khoản.

**Tài liệu khác:** [中文 / English](README.md)

## 1. Thành phần

| Thành phần | Công dụng | Cổng mặc định |
| --- | --- | --- |
| `muse2api` | Chuyển khả năng tạo ảnh, tạo video và trò chuyện trên Muse thành API tương thích OpenAI | `1314` |
| `Muse–Canvas` | Giao diện Canvas vô hạn để tạo và quản lý ảnh, video, nội dung | `521` |
| `Canvas Agent` | Kết nối DeepSeek qua Codex App Server, điều khiển Canvas bằng MCP | `17371` |

**Lưu ý:** API và Canvas là hai dịch vụ khác nhau. Chỉ cần API thì không bắt buộc chạy Canvas và Agent.

## 2. Cấu hình máy chủ

Yêu cầu: Debian 12+ hoặc Ubuntu 22.04+, Python 3.10+, Node.js 18+, Chromium hoặc Chrome, ít nhất 2 vCPU/4 GB RAM.

```bash
git clone https://github.com/mktminhqpbga-glitch/lan1.git /Muse
cd /Muse
cp .env.example .env
nano .env
```

Ít nhất hãy cấu hình:

```dotenv
MUSE_API_BASE=http://127.0.0.1:1314
MUSE_API_KEY=thay-bang-khoa-dai-ngau-nhien
DEEPSEEK_API_KEY=sk-khoa-deepseek-cua-ban
```

- `MUSE_API_BASE`: địa chỉ **trình duyệt có thể truy cập** đến muse2api, không thêm `/v1` ở cuối. Nếu truy cập Canvas bằng HTTPS thì API cũng phải dùng HTTPS.
- `MUSE_API_KEY`: khoá riêng để ứng dụng truy cập muse2api, **không phải mật khẩu tài khoản Muse**.
- `DEEPSEEK_API_KEY`: chỉ dùng cho Agent ở phía máy chủ. Không đưa khoá này vào giao diện web.
- Khi triển khai qua tên miền, hãy thay `127.0.0.1` bằng địa chỉ API mà trình duyệt của bạn truy cập được.

Chạy trình cài đặt (sau khi kiểm tra nội dung script và cấu hình):

```bash
sudo -E bash install.sh
```

Trong 1Panel → Công cụ → Supervisor, tạo ba tiến trình:

| Tên | Thư mục chạy | Lệnh |
| --- | --- | --- |
| muse2api | `/Muse` | `/bin/bash /Muse/start-api.sh` |
| muse-canvas | `/Muse` | `/bin/bash /Muse/start-canvas.sh` |
| muse-agent | `/Muse/agent` | `/bin/bash /Muse/agent/start-agent.sh` |

Chỉ mở những dịch vụ bạn thực sự cần. Đối với Internet, nên đặt HTTPS và kiểm soát truy cập thông qua reverse proxy.

## 3. Dùng bảng quản trị muse2api bằng tiếng Việt

Mở `http://DIA_CHI_MAY_CHU:1314/admin?key=API_KEY_CUA_BAN` (hoặc tên miền HTTPS của API).

Ở góc trên, chọn **Tiếng Việt**. Nếu đã sử dụng giao diện trước đó, trình duyệt có thể đang lưu lựa chọn English / 中文; hãy chuyển ngôn ngữ một lần.

Các khu vực chính:

1. **Kho tài khoản** — thêm Muse Cookie, kiểm tra trạng thái, hạn mức và duy trì phiên.
2. **Lấy Cookie** — hướng dẫn cài tiện ích Chrome hoặc sao chép thủ công.
3. **Lịch sử tác vụ** — theo dõi tạo ảnh / video.
4. **Thư viện ảnh/video** — xem và tải kết quả.
5. **Thử API** — gửi yêu cầu thử nghiệm.
6. **Hướng dẫn tích hợp** — thông tin BASE URL, API Key và model.

### Nhập tài khoản Muse bằng tiện ích Chrome

1. Đăng nhập `https://muse.ai/` bằng trình duyệt Chrome.
2. Tại trang quản trị, mở **Lấy Cookie**, tải gói tiện ích rồi giải nén.
3. Vào `chrome://extensions`, bật *Chế độ dành cho nhà phát triển*, chọn *Tải tiện ích đã giải nén* và trỏ tới thư mục `muse2api/extension` hoặc thư mục gói vừa giải nén.
4. Bấm biểu tượng tiện ích, chọn **Tiếng Việt**, nhập địa chỉ API và API Key.
5. Bấm **Đọc Cookie và nhập tài khoản** rồi kiểm tra trạng thái trong **Kho tài khoản**.

Cookie là thông tin đăng nhập nhạy cảm. Chỉ chuyển Cookie đến máy chủ mà bạn kiểm soát, không chia sẻ với người lạ.

## 4. Dùng API trong ứng dụng

muse2api cung cấp API tương thích OpenAI. Ví dụ:

```bash
curl http://127.0.0.1:1314/v1/models \
  -H "Authorization: Bearer $MUSE_API_KEY"
```

Các tên model có sẵn theo repo là `muse-spark` (chat), `muse-image` (ảnh) và `muse-video` (video). Không đổi các tên model hoặc đường dẫn API khi Việt hoá.

## 5. Việt hoá giao diện Canvas: cần build lại

Thư mục `canvas/dist` là bản frontend được build sẵn từ trước. Sau khi cập nhật mã nguồn, để các bản dịch trong `source/infinite-canvas/web/src/i18n` xuất hiện trên website cần build lại:

```bash
cd /Muse/source/infinite-canvas/web
npm install --legacy-peer-deps --ignore-scripts
npm run build
cd /Muse
rm -rf canvas/dist
cp -a source/infinite-canvas/web/dist canvas/dist
```

Sau đó khởi động lại tiến trình `muse-canvas` hoặc làm mới trang. **Nên sao lưu `canvas/dist` trước khi thay nếu đang chạy production.** Nếu `npm run build` báo lỗi, giữ nguyên bản dist cũ và kiểm tra lỗi trước khi sao chép.

Các bản dịch Canvas đã có cho những mục chính. **Những nội dung chưa dịch sang tiếng Việt sẽ hiển thị tiếng Anh** để tránh hiện tiếng Trung; đây là cơ chế fallback tạm thời, chưa phải bản dịch đầy đủ 100%.

## 6. Những phần phải giữ nguyên

- Tên biến môi trường như `MUSE_API_BASE`, `MUSE_API_KEY`, `DEEPSEEK_API_KEY`.
- Đường dẫn endpoint như `/v1/models`, `/v1/images/generations`, `/v1/videos`.
- Cookie `hatch_sess`, `hatch_vml`, định dạng `Authorization: Bearer`.
- Tên model, khoá JSON, ID HTML, hành vi kết nối, cơ chế Agent và dữ liệu cũ.

## 7. Lưu ý bảo mật

- Không đưa `.env`, Cookie Muse hoặc token Agent lên GitHub.
- Không để Agent có khả năng chạy lệnh được truy cập công khai nếu chưa có xác thực và kiểm soát quyền.
- `canvas-agent.json` có thể được chuyển đến người truy cập Canvas thông qua `/config.js`; vì vậy phải bảo vệ chính trang Canvas.

Tham khảo thêm cấu hình Supervisor, Nginx và các ví dụ nâng cao tại [README gốc](README.md).
