# Triển khai 0.5.0 và phạm vi đã xác minh

17/11/2026. Mã được triển khai trực tiếp trên AI-Bridge, không khôi phục lan1. Không thay cơ chế đăng nhập website thành xuất cookie. Đây là bản phát triển để nghiệm thu tiếp, chưa phải tuyên bố hoàn thành các tiêu chí live của đề án.

## Kiến trúc

- `local-server.mjs`: khởi động CLI, credential tách biệt, kiểm tra FFmpeg/FFprobe, chỉ loopback. Không in giá trị bí mật.
- `lib/server.mjs`: HTTP/API, Origin/Host, ghép nối WebSocket v2, SSE/tool calls và Control Center.
- `lib/state.mjs`: Profile/tab/document registry, consent, queue theo tab, journal snapshot atomic, lock một instance, idempotency và phục hồi UNKNOWN.
- `lib/media.mjs`: upload có ACK, tệp tạm, giới hạn dung lượng, giải mã FFmpeg/FFprobe, SHA256, tối đa hai validation đồng thời.
- `extension/background.js`: Profile UUID bền vững, inventory tab hiện hữu, xác minh target/session trước dispatch, lưu Task ID đã chuyển tiếp để không gửi trùng khi worker khởi động lại.
- `extension/content.js`: probe adapter, từ chối draft/busy tab, so sánh lượt mới và stream media trong phiên trang. Không CDP/debugger/cookie/proxy APIs.
- `control/`: giao diện không cần build, dùng DOM textContent cho dữ liệu không tin cậy, không lưu API key trên đĩa trình duyệt.

## Đối chiếu giai đoạn

| Giai đoạn đề án   | Kết quả trong bản này                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline      | Hoàn tất kiểm tra HEAD/license và 20 tests upstream. Phần chat thật/multi-Profile thật chưa chạy.                                                                                                                           |
| 1 — Chrome Bridge | Đã triển khai và kiểm thử tự động chọn Profile/tab/session, không focus/mở tab, xác thực và disconnect. Chưa nghiệm thu trên hai Profile Chrome thật.                                                                       |
| 2 — Media Engine  | Đã triển khai storage/upload/validator/task lifecycle và kiểm thử file ảnh/video nhị phân thực được tạo cục bộ. Các file này là fixture, không phải AI generation.                                                          |
| 3 — Muse Adapter  | Đã có adapter DOM bảo thủ và capability theo mode đang chọn. Chưa được xác minh trên website Muse thật. Selector, tải gốc và CORS có thể cần điều chỉnh theo phiên thực.                                                    |
| 4 — Provider khác | Giữ đường Text của chín provider dưới quy tắc lượt mới. Chưa nghiệm thu website; không bật Image/Video cho chúng. Chưa mở rộng media trước khi Muse có bằng chứng.                                                          |
| 5 — Dashboard     | Có Profile rename/enable/disconnect, quyền tab theo loại, defaults, gửi task, queue/history, xem text, download và kiểm tra checksum media. UI đã kiểm thử DOM nối server HTTP thật. Chưa kiểm tra render trên Chrome thật. |
| 6 — Tests         | Có bộ test HTTP/WebSocket/DOM, ảnh/video fixture, lifecycle và bảo mật. Ma trận live nằm ở LIVE-ACCEPTANCE.md, không được coi là đã PASS.                                                                                   |
| 7 — Standalone    | Có source cài bằng npm ci, CLI/Run.bat, tài liệu và lockfile. Chưa có installer/autostart, kiểm thử Windows/macOS hoặc nghiệm thu tải video lớn trên tài khoản thật.                                                        |

## Những quyết định ảnh hưởng tương thích

1. API key luôn bắt buộc cho dữ liệu. Token Extension không thể dùng để gọi API. Không giữ chế độ “bất kỳ placeholder key nào cũng được”.
2. Extension v0.4 không được dùng để dispatch: thiếu định danh Profile/tab/document. Cần reload Extension v0.5 và ghép nối.
3. Không còn chọn tab active và không mở trang provider từ popup. Người dùng cấp quyền một tab hiện hữu trong Control Center.
4. Một Profile có thể có nhiều tab độc lập. Mỗi tab tối đa một task được dispatch; các tab có thể chạy song song. Profile trùng UUID bị từ chối.
5. Nếu mất kết nối hoặc không chứng minh được kết quả sau dispatch, dùng UNKNOWN và giữ tab cần kiểm tra. Không fallback qua tài khoản khác, không retry tác vụ đó.
6. `CANCELLED` chỉ áp dụng task đang QUEUED. Website chưa cung cấp bằng chứng cancel thì API trả 409, giữ trạng thái thực tế.
7. Image nhận `n=1`, URL xác thực và timeout HTTP hữu hạn. Image editing, ảnh tham chiếu và image-to-video trả lỗi chưa hỗ trợ; không âm thầm bỏ qua input.
8. Không điều khiển mode/quality/size/duration của website bằng tùy chọn API chưa được kiểm chứng. Người dùng chọn trên trang, probe chỉ phát hiện.
9. Kết quả capability được đánh dấu theo task/session trả về từ adapter. Fixture không tạo bằng chứng cho tài khoản live; không dùng checkbox như một chứng nhận hỗ trợ.
10. Khởi động lại thu hồi mọi quyền tab. Task đã dispatch trở thành UNKNOWN; chưa gửi thì không được remap sang Profile khác.
11. Giữ pre/post prompt và title interception. SSE có thể trả một đợt nội dung sau khi lượt phản hồi ổn định để tránh đưa văn bản lịch sử/trạng thái vào kết quả.

## Kiểm thử và chuỗi phụ thuộc

`npm test` kết hợp test server thật với Extension giả lập WebSocket, DOM fixture cho content/background/popup và Control Center. FFmpeg tạo file PNG/MP4 mẫu; validator giải mã rồi byte-compare file tải qua HTTP. Có kiểm tra file giả chỉ mang chữ ký, file hỏng, size limit, sai chunk offset, session cũ, sai socket/nonce, trùng idempotency, deadline, disconnect, crash snapshot, API Origin/Host và credential logging.

Trong quá trình triển khai, `npm audit --omit=dev` phát hiện sharp/libvips có advisory mức high chưa có bản vá trong phiên bản có sẵn. Dependency đó đã được gỡ; cả ảnh lẫn video sử dụng FFmpeg/FFprobe có sẵn trong máy. Không tắt TLS, không bỏ qua checksum, không dùng cookie từ repo tham khảo.

## Còn cần để nghiệm thu

Thực hiện checklist live với Chrome do người dùng mở sẵn, Extension v0.5 được ghép nối, hai Profile và các tab tài khoản do người dùng chỉ định. Chưa có các kết nối này trong phiên làm việc hiện tại. Không tự mở trình duyệt, tạo tab, sao chép phiên đăng nhập hay chạy bot đăng nhập để thay thế.

Sau Muse live mới quyết định selector/mode/download thực tế nào cần sửa. Nếu website không cho tải file gốc bằng phiên DOM được phép, giữ capability chưa xác minh và ghi rõ giới hạn. Không có cam kết mọi website đều có thể tạo ảnh/video.
