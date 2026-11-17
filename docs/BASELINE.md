# BASELINE — 17/11/2026

Được ghi nhận trước khi triển khai nâng cấp. Đây là bằng chứng mã nguồn và kiểm thử offline, không phải nghiệm thu tài khoản AI thật.

| Nguồn              | Ref / phiên bản        | HEAD đã kiểm tra                           |
| ------------------ | ---------------------- | ------------------------------------------ |
| RenZekta/AI-Bridge | main, 0.4.0            | `5c47d9dd682f41cb69234c319adf00f2296dfca9` |
| vip0014/muse2api   | master, Go 1.24 module | `0a2cfffb1fa6dc706398781fb3a75621f8494750` |

AI-Bridge không có AGENTS.md tại HEAD trên. Môi trường kiểm tra: Linux, Node 24.22.1. `npm test` của bản gốc chạy **20 tests, 20 pass, 0 fail, 0 skipped**. Các bài relay dùng WebSocket mô phỏng Extension; không gửi chat lên website thật.

## Những kết luận đã đối chiếu

- AI-Bridge là Node HTTP/WebSocket + Chrome MV3, khai báo 9 provider. Chưa có Muse trong manifest, content script hoặc bảng provider.
- `extension/background.js:185–186` của HEAD gốc gọi `chrome.tabs.update(...active:true)` và `chrome.windows.update(...focused:true)` sau khi gửi prompt.
- `background.js:192–198` chọn tab bằng active/highlighted; không có lựa chọn Profile ID, Tab ID hoặc Document Session ID trong API.
- `background.js:214–223` mở/kích hoạt tab khi **người dùng bấm nút provider trong popup**. Đây là hành vi có thao tác người dùng, không phải tự mở tab mỗi lần nhận tác vụ. Thiết kế mới vẫn loại bỏ nó để tuân thủ yêu cầu tuyệt đối không mở/chuyển tab.
- `local-server.mjs:43–46,255–273` dùng một `activeJob` và queue chung; nhiều kết nối Extension đã có nhưng chưa phải định tuyến đa Profile an toàn.
- `local-server.mjs:288–290` đã đối chiếu Job ID và socket được giao. Vì vậy GAP-04 nên hiểu là **chưa có bằng chứng kết quả media theo Profile/tab/document/turn**, không phải hoàn toàn không kiểm tra Task ID.
- `local-server.mjs:34,576–588` cho phép tắt xác thực API theo mặc định và đặt CORS `*`. Loopback không thay thế kiểm soát Origin và khóa API.
- Job chỉ ở RAM, timeout 4 phút, mất socket trả lỗi 502. Chưa có journal phục hồi, trạng thái UNKNOWN bền vững hoặc Idempotency-Key.
- `content.js:125–160` so sánh văn bản phản hồi cuối với văn bản cũ. Đây không phải bộ thu thập media, cũng không chứng minh lượt phản hồi mới nếu người dùng đồng thời thao tác.
- Endpoint Image, Video, Media và các endpoint quản lý trong đề án chưa tồn tại ở HEAD gốc.

Các đường dẫn/dòng trên thuộc HEAD gốc, không phải số dòng sau khi triển khai.

## Đối chiếu muse2api

Nguồn `vip0014/muse2api` là **bản Go**, khác với bản Python trong repo lan1 đã xóa trước đó. Không khôi phục hay sử dụng lan1.

- `internal/muse/protocol/hatch/chat.go:50`: `MediaRef`.
- `chat.go:267`: `ChatWithItems` dùng thông tin phiên/tuyến giao thức Muse.
- `chat.go:439`: `DownloadToFile` ghi có giới hạn vào tệp tạm, thay vì gom toàn video vào RAM.
- `driver.go:291`: `pickMedia` lọc loại đầu ra rồi tải và lưu.
- `driver.go:410–491`: kiểm tra dung lượng/chữ ký file; metadata MP4 được thử đọc với file không quá 128 MiB. Không nên coi phần này là bằng chứng giải mã đầy đủ hay xác minh mọi codec.
- `internal/task/manager.go:169–187`: phân biệt task chưa được gửi với kết quả chưa rõ sau shutdown, tránh tự retry tác vụ có thể đã chạy.

Không sao chép cơ chế cookie, RPC riêng, Noise hoặc gateway upstream. Bản nâng cấp dùng DOM và tệp mà website cung cấp trong phiên trình duyệt hiện tại.

## Giấy phép và giới hạn baseline

LICENSE của AI-Bridge là GNU AGPL v3; LICENSE của bản muse2api tham khảo là MIT. Giữ nguyên LICENSE AI-Bridge. Không nhập mã nguồn muse2api vào ứng dụng.

Không chạy live Muse, không kiểm thử hai Chrome Profile thật, không kiểm tra Windows/macOS. Không khởi chạy Chrome, dùng CDP, trích xuất cookie hoặc tạo tab để lập baseline.
