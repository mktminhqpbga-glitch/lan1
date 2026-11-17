# Nghiệm thu trên Chrome thật — CHƯA CHẠY

Đây là checklist để người dùng nghiệm thu trên máy có Chrome đã mở. Không dùng các test fixture để đánh dấu các dòng dưới đây PASS. Không cần cung cấp cookie, mật khẩu hoặc token website cho Bridge hay qua chat.

## Chuẩn bị

1. Cài dependency với npm ci và FFmpeg/FFprobe, chạy npm start trên cùng máy với Chrome. Mở Control Center bằng thao tác của bạn.
2. Cài/load Extension v0.5 trong hai Profile đã mở. Nhập token ghép nối riêng của Bridge và đặt hai tên hiển thị khác nhau.
3. Giữ các tab AI bạn chỉ định; với Muse, tự đăng nhập và chọn chế độ Text/Image/Video thực tế được tài khoản cho phép. Không để draft chưa gửi hoặc tác vụ website khác đang chạy.
4. Trong Control Center, xác nhận URL/Profile/tab/session, cấp quyền cho capability được phát hiện. Checkbox chỉ là quyền cho phép, không phải chứng nhận thành công.
5. Ghi lại số tab, cửa sổ đang active và URL trước khi kiểm tra. Không thay proxy hoặc cấu hình mạng của Chrome. Dừng kiểm tra nếu xuất hiện CAPTCHA/hạn mức, không tự vượt qua.

## Ma trận kết quả

| Mã      | Thao tác                                             | Bằng chứng cần lưu                                                 | Trạng thái     |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------ | -------------- |
| TEST-01 | Gửi hai prompt Text khác nhau vào hai Profile        | Profile/task IDs, phản hồi khác nhau và đúng tab                   | CHƯA CHẠY LIVE |
| TEST-02 | Hai tab cùng provider, chỉ định tab thứ hai          | Chỉ tab thứ hai có user turn mới                                   | CHƯA CHẠY LIVE |
| TEST-03 | Chat Text                                            | Lượt user mới khớp prompt và assistant turn theo sau               | CHƯA CHẠY LIVE |
| TEST-04 | Muse Image                                           | Task COMPLETED, file gốc giải mã được, kích thước, SHA256          | CHƯA CHẠY LIVE |
| TEST-05 | Muse Video                                           | Task bất đồng bộ COMPLETED, video phát được, codec/duration/SHA256 | CHƯA CHẠY LIVE |
| TEST-06 | Giữ ảnh/video lịch sử trước khi gửi prompt mới       | File mới thuộc đúng turn; không tải thumbnail/lịch sử              | CHƯA CHẠY LIVE |
| TEST-07 | Ngắt Extension sau khi task đã dispatch              | UNKNOWN, không có lần gửi thứ hai khi kết nối lại                  | CHƯA CHẠY LIVE |
| TEST-08 | Đóng một Profile bằng thao tác của bạn               | Profile Offline, task đang chạy UNKNOWN                            | CHƯA CHẠY LIVE |
| TEST-09 | Reload/đổi URL bằng thao tác của bạn                 | Consent bị thu hồi; session cũ bị từ chối                          | CHƯA CHẠY LIVE |
| TEST-10 | Website trả file hỏng/không tải được                 | FAILED/UNKNOWN, không có media thành công                          | CHƯA CHẠY LIVE |
| TEST-11 | Gửi đồng thời hai tab độc lập                        | Hai task RUNNING, không trộn nội dung                              | CHƯA CHẠY LIVE |
| TEST-12 | Request không có API key hoặc Origin ngoài allowlist | 401/403, không dispatch vào Chrome                                 | CHƯA CHẠY LIVE |
| TEST-13 | Stop/start server sau dispatch                       | Task ID còn lại, UNKNOWN, không tự gửi lại                         | CHƯA CHẠY LIVE |
| TEST-14 | So sánh Chrome trước/sau mọi task                    | Không mở/đóng/chuyển/focus tab/cửa sổ ngoài thao tác của bạn       | CHƯA CHẠY LIVE |

Có thể kiểm tra SHA256 của file tải bằng công cụ hệ điều hành và đối chiếu metadata `/api/bridge/media`. Kiểm tra tệp ảnh/video bằng trình xem/phát thông thường; đừng chỉ nhìn thumbnail hoặc văn bản “đã tạo xong”.

## Khi task UNKNOWN

1. Không tạo task mới với key khác để “retry” ngay.
2. Kiểm tra tab website bằng thao tác của bạn xem lượt yêu cầu đã được gửi hay hoàn thành chưa.
3. Giữ task cũ UNKNOWN nếu chưa có bằng chứng. API không giả vờ cancel hay hoàn thành nó.
4. Chỉ giải phóng tab sau khi kiểm tra xong. Giải phóng không tự gửi lại task cũ.
5. Nếu muốn gửi một yêu cầu mới có chủ đích, tạo task/key mới sau khi bảo đảm website đã rảnh.

## Khi Muse không nhận diện mode hoặc không lấy được file

Không bật capability bằng cách sửa fixture/hardcode PASS. Ghi lại tên mode và cấu trúc DOM đã lược bỏ nội dung riêng tư để cập nhật adapter. Nếu download bị website/CORS chặn, chưa thể nghiệm thu Media. Không chuyển sang xuất cookie, CDP, mở tab mới hoặc giao thức riêng nhằm vượt giới hạn thiết kế.
