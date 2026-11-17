# AI-Bridge 0.5.0 — Control Center

API cục bộ kết nối các tab AI đang mở qua Chrome Extension MV3. Chọn rõ Profile, tab và phiên tài liệu; các tab độc lập có thể chạy đồng thời. Server không khởi chạy Chrome và Extension không mở, đóng, chuyển hay kích hoạt tab/cửa sổ.

**Trạng thái:** đã triển khai nền tảng đa Profile, task bền vững, API Text/Image/Video, media storage/validation và Control Center. Muse Image/Video là adapter DOM thử nghiệm, **chưa nghiệm thu trên tài khoản Muse thật**. Không công bố khả năng tạo media thật cho mọi provider. Xem [tiến độ và giới hạn](docs/IMPLEMENTATION.md), [baseline](docs/BASELINE.md) và [nghiệm thu thực tế](docs/LIVE-ACCEPTANCE.md).

## Cài đặt

- Node.js 22+; kiểm thử tự động hiện chạy trên Node 24/Linux.
- FFmpeg và FFprobe có trong PATH. Cả ảnh và video được giải mã bằng các công cụ này. Cần các codec tương ứng; khả năng AVIF phụ thuộc bản FFmpeg.
- Chrome 116+ do bạn mở sẵn, với tài khoản website đăng nhập bình thường.

```sh
npm ci
npm test
npm start
```

Windows có thể dùng `Run.bat` sau khi `npm ci` và cài FFmpeg. Chưa có nghiệm thu Windows/macOS hay bộ cài tự chạy cùng hệ điều hành.

Server chỉ bind `127.0.0.1:4317`. Tự mở địa chỉ này trong trình duyệt của bạn để dùng Control Center. Không cần build frontend. Để Chrome ở nguyên trạng trong các task tự động: sử dụng checkout hiện có, không tạo worktree trừ khi được yêu cầu, không mở Chrome hay tab bằng script.

Hai credential khác nhau được sinh tự động, không in giá trị vào log:

- `.ai-bridge-token`: dùng **chỉ để ghép nối Extension**.
- `.ai-bridge-data/api-key`: dùng cho API và Control Center.

Chỉ đọc/copy các giá trị này ở máy của bạn; không gửi lên chat hoặc commit. Có thể dùng `BRIDGE_TOKEN` và `BRIDGE_API_KEY` để cấp từ môi trường. Thư mục dữ liệu, credential và node_modules được gitignore. Không chạy hai server chung một thư mục dữ liệu; có lock để ngăn việc này.

## Ghép nối nhiều Profile

1. Trong từng Chrome Profile đang mở, tự cài Extension từ thư mục `extension` bằng **Load unpacked**.
2. Mở popup, nhập URL loopback và token ghép nối. Đặt tên hiển thị, ví dụ “Profile 22”. Extension không tự đọc được tên Profile thực của Chrome.
3. Mở trang Control Center bằng thao tác của bạn, nhập **khóa API**. Nó chỉ giữ trong bộ nhớ trang.
4. Danh sách chỉ hiển thị các tab provider hiện có và content script phản hồi được. Tab đã mở trước khi cài Extension có thể cần bạn tự reload.
5. Cho phép Text/Image/Video riêng cho từng tab. Không tự cấp quyền khi phát hiện website. Reload/đổi URL thu hồi quyền; phải chọn lại phiên mới.
6. Chọn đích mặc định theo loại tác vụ hoặc chỉ định `target` trong mỗi API request.

Các website được nhận diện: ChatGPT, Gemini, Claude, DeepSeek, Grok, Perplexity, Qwen, Kimi, Z.ai và Muse. “Nhận diện” không có nghĩa đăng nhập/capability đã được nghiệm thu. Text dùng selector của bản gốc cùng kiểm tra lượt mới; adapter có thể từ chối nếu không chứng minh được user/assistant turn.

Profile ID được lưu riêng trong `chrome.storage.local` của từng Extension. Không dùng Tab ID làm định danh Profile. Nếu bạn sao chép dữ liệu Extension làm trùng ID, server từ chối kết nối trùng, không tự gộp tài khoản.

## API

Mọi API dữ liệu/điều khiển yêu cầu `Authorization: Bearer <API_KEY>`. Origin lạ và Host lạ bị từ chối; không có CORS `*`. `GET /health` chỉ công khai trạng thái tối thiểu. Không truyền credential trong URL tải media.

```json
{
  "profileInstanceId": "<Profile ID từ /api/bridge/profiles>",
  "tabId": 123,
  "documentSessionId": "<phiên từ /api/bridge/tabs>"
}
```

Dùng đối tượng trên làm `target`. Thiếu target và chưa đặt default thì API trả lỗi; không tự chọn tab active hoặc đổi sang Profile khác.

| Endpoint                                                                   | Hành vi                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `POST /v1/chat/completions`                                                | Text, JSON hoặc SSE; giữ chuyển đổi tool-call văn bản của bản gốc           |
| `GET /v1/models`                                                           | Danh sách bridge provider; không phải tuyên bố mọi capability đều hoạt động |
| `POST /v1/images/generations`                                              | Một ảnh, `n=1`, `response_format=url`; chờ có giới hạn hoặc trả 202/task    |
| `POST /v1/video/tasks`                                                     | Bất đồng bộ, trả 202 và Task ID                                             |
| `GET /v1/video/tasks/{id}`                                                 | Trạng thái, lỗi và danh sách Media ID                                       |
| `GET /v1/media/{fileId}`                                                   | File đã xác minh, có xác thực, hỗ trợ byte range và kiểm tra checksum       |
| `GET /api/bridge/{profiles,tabs,capabilities,tasks,media,health,defaults}` | Thông tin quản lý có xác thực                                               |
| `PATCH /api/bridge/profiles/{id}`                                          | Đổi tên, bật/tắt Profile hoặc ngắt Extension                                |
| `PATCH /api/bridge/tabs/{profileId}/{tabId}`                               | Cấp quyền capability theo đúng document session                             |
| `PATCH /api/bridge/defaults`                                               | Đích mặc định riêng cho text/image/video                                    |
| `POST /api/bridge/tasks`                                                   | Tạo task bất đồng bộ `{kind,prompt,target}`                                 |
| `POST /api/bridge/tasks/{id}/cancel`                                       | Chỉ xác nhận hủy task còn QUEUED                                            |
| `POST /api/bridge/media/{id}/verify`                                       | Đối chiếu SHA256 của file trên đĩa                                          |

Ví dụ chat:

```json
{
  "model": "bridge-muse",
  "messages": [{ "role": "user", "content": "Xin chào" }],
  "stream": false,
  "target": {
    "profileInstanceId": "...",
    "tabId": 123,
    "documentSessionId": "..."
  }
}
```

Ví dụ image/video/task:

```json
{
  "prompt": "Một ngọn hải đăng bên bờ biển",
  "target": {
    "profileInstanceId": "...",
    "tabId": 123,
    "documentSessionId": "..."
  }
}
```

Gửi `Prefer: respond-async` để Image/Text trả Task ID ngay. Nếu Image/Text chưa xong trong thời gian chờ HTTP (mặc định 60 giây), server trả 202, tiếp tục tra `/api/bridge/tasks/{id}`. File hoàn thành có trong `/api/bridge/media` và task.media. Với yêu cầu có thể được client retry, dùng **cùng** `Idempotency-Key`; đổi payload với cùng key trả 409. Muốn tạo tác vụ mới có chủ đích thì dùng key mới.

`QUEUED → DISPATCHED → RUNNING → COMPLETED`; các trạng thái ngoại lệ là FAILED, CANCELLED, UNKNOWN. Chỉ COMPLETED với phản hồi mới hoặc file đã giải mã và đối chiếu task. Mất kết nối/restart sau dispatch chuyển UNKNOWN, giữ tab ở trạng thái cần kiểm tra, không tự gửi lại. Sau khi tự kiểm tra website, bạn có thể giải phóng tab từ Control Center; thao tác này không biến task cũ thành thành công và không tự gửi lại nó. Hủy task đã gửi trả 409 vì website chưa xác nhận hủy.

## Muse media thử nghiệm

Adapter chỉ công bố Image/Video khi phát hiện một điều khiển mode tương ứng **đang được chọn** trên website. Bạn tự chọn chế độ, chất lượng và thời lượng trong tab. Hệ thống không giả vờ hỗ trợ tùy chọn API mà adapter không điều khiển được.

Nó phải thấy một user turn mới khớp prompt, rồi một assistant turn mới nằm sau đó. Ảnh chỉ được lấy từ liên kết download hoặc nguồn được đánh dấu original; không lấy thumbnail/ảnh lịch sử. Video lấy từ media gắn với đúng response mới. Fetch và đọc stream diễn ra trong content script, không xuất cookie/token phiên hay chuyển URL media có chữ ký về server. Nếu CORS hoặc website không cung cấp tệp đọc được, tác vụ báo UNKNOWN/lỗi, không trả văn bản như file.

Upload theo chunk có ACK/backpressure, giới hạn 256 MiB/file, 40 megapixels/frame, tối đa hai bộ giải mã cùng lúc. FFprobe kiểm tra codec/dimensions/duration; FFmpeg thực sự giải mã. Sau đó lưu metadata, SHA256 và Task ID. Video quá một giờ hoặc giải mã quá 120 giây bị từ chối. Không có phần trăm tiến trình giả.

**Chưa hỗ trợ:** upload ảnh tham chiếu, chỉnh sửa ảnh (`/v1/images/edits` trả 501), image-to-video, batch `n>1`, `b64_json`, tự chọn model/mode trên website, tự vượt CAPTCHA/hạn mức, tự cancel phía website, hoặc tự chạy cùng hệ điều hành. Media adapter cho 9 provider còn lại chưa được triển khai. Chưa có bằng chứng Text/Image/Video thật trên Chrome của người dùng.

## Cấu hình và phát triển

- `BRIDGE_PORT`, `BRIDGE_DATA_DIR`, `BRIDGE_TOKEN_FILE`, `BRIDGE_SETTINGS_FILE`, `BRIDGE_PROMPT_INSTRUCTIONS_DIR`.
- `BRIDGE_ALLOWED_ORIGINS`: danh sách Origin cụ thể, phân cách bằng dấu phẩy; mặc định chỉ giao diện cùng server và client cục bộ không có Origin. WebSocket còn chấp nhận Origin Chrome Extension với token đúng.
- `ai-bridge.settings.json` và `prompt-instructions/` giữ cơ chế pre/post prompt và title interception của upstream. Không cần tải website cho yêu cầu đặt tên hội thoại được nhận diện; tắt bằng `interceptTitleRequests:false` hoặc `BRIDGE_INTERCEPT_TITLES=0`.
- `.ai-bridge-data/state.json`: snapshot atomic, fsync trên Unix, chứa lịch sử/prompt cục bộ với quyền 0600. Một server sở hữu thư mục này. Sao lưu khi server đã dừng.

```sh
npm test
npm run format:check
npm audit --omit=dev
```

Không có bước build/transpile. Các kiểm thử DOM/WebSocket là fixture, không thay thế nghiệm thu website thật. Xem checklist trong [LIVE-ACCEPTANCE.md](docs/LIVE-ACCEPTANCE.md).

## Giấy phép

Giữ GNU AGPL v3 của AI-Bridge; xem [LICENSE](LICENSE). Nghiên cứu thiết kế task/media của `vip0014/muse2api` (MIT), không sao chép cơ chế phiên đăng nhập hay mã giao thức riêng. Nguồn và HEAD nghiên cứu được ghi trong [BASELINE](docs/BASELINE.md).
