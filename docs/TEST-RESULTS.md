# Kết quả kiểm tra — 17/11/2026

Môi trường: Linux, Node.js 24.22.1, FFmpeg/FFprobe 7.1.5.

| Kiểm tra                                | Kết quả                                                             |
| --------------------------------------- | ------------------------------------------------------------------- |
| Baseline upstream 0.4.0                 | 20/20 tests PASS, trước khi thay đổi                                |
| npm test, bản 0.5.0                     | 40/40 tests PASS; 0 fail/cancelled/skipped/todo                     |
| npm run format:check                    | PASS                                                                |
| git diff --check                        | PASS                                                                |
| npm audit --omit=dev --audit-level=high | 0 vulnerabilities trong dependency production được registry báo cáo |
| npm start                               | Server CLI khởi động thành công, bind loopback                      |
| HTTP /, /control.js, /control.css       | 200, trả đúng tài nguyên                                            |
| /health và API có Authorization hợp lệ  | 200                                                                 |
| /v1/models không có API key             | 401                                                                 |
| Profile đang ghép nối ở runtime         | 0; chưa có phiên website live                                       |

40 tests bao gồm:

- 17 bài integration server/CLI: xác thực, Origin/Host, token scope, WebSocket, đa Profile/tab, session reload, socket/nonce sai, idempotency, disconnect/restart, queue/cancel, media PNG/MP4 giải mã thật, file hỏng, upload offset/size, SSE/tool calls, checksum tampering, deadline, lượt phản hồi cũ và khóa data-directory.
- 6 bài Extension DOM/background: capability theo mode, stale session, không phá draft, không gửi khi website đang sinh, lượt user/assistant mới, không nhận lịch sử/thumbnail, streaming/backpressure và không gọi API mở/focus/đóng Chrome. Có kiểm tra upload chờ ACK bị ngắt kết nối.
- 1 bài Control Center DOM nối HTTP server thật: login, chống chèn HTML qua tên Profile, cấp quyền tab, default target và tạo task.
- 16 bài unit kế thừa cho prompt instructions và tool-call conversion (thêm Muse vào bảng tên provider).

Ảnh/video trong integration tests được FFmpeg tạo **cục bộ**. Không phải ảnh/video do Muse sinh. Không chạy Chrome mới hay dùng Chrome Remote Debugging để kiểm thử.

Tạo ảnh/video AI thật, hai Profile Chrome thật, tương thích giao diện live của các provider, render trên Chrome thật, Windows/macOS và tải video lớn qua website: **CHƯA CHẠY**. Xem [LIVE-ACCEPTANCE.md](LIVE-ACCEPTANCE.md).
