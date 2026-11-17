# ĐỀ ÁN NÂNG CẤP AI-BRIDGE THÀNH HỆ THỐNG API ĐA PHƯƠNG TIỆN

**Phiên bản:** 1.0  
**Ngày:** 17/11/2026  
**Trạng thái:** Nghiên cứu và lập kế hoạch — chưa chỉnh sửa mã nguồn  
**Dự án chính:** https://github.com/RenZekta/AI-Bridge  
**Nguồn nghiên cứu:** https://github.com/vip0014/muse2api

---

## I. MỤC TIÊU TỔNG THỂ

Phát triển AI-Bridge từ hệ thống chuyển tiếp chat văn bản thành một nền tảng API thống nhất, hỗ trợ:

1. Chat văn bản (Text).
2. Tạo và chỉnh sửa hình ảnh (Image).
3. Tạo video từ văn bản hoặc ảnh (Video).
4. Quản lý đồng thời nhiều Chrome Profile.
5. Kết nối và tự nhận diện các tab AI đã đăng nhập.
6. Phân công AI nào xử lý Text, Image hoặc Video.
7. Tạo API cục bộ cho các ứng dụng khác sử dụng.
8. Quản lý tác vụ, tiến trình, hàng chờ và kết quả.
9. Tải và xác minh file ảnh/video thật.

### Nguyên tắc bắt buộc

- Sử dụng Chrome Profile đã mở và do người dùng chỉ định.
- Không tự khởi chạy Chrome.
- Không tự tạo tab, chuyển tab hoặc kích hoạt cửa sổ Chrome.
- Không sao chép cookie, mật khẩu hay token phiên của website.
- Không sửa proxy hoặc cấu hình mạng của Chrome.
- Không dùng Chrome Remote Debugging.
- Mỗi Profile và tab phải có định danh riêng.
- Không can thiệp vào các cuộc trò chuyện không thuộc tác vụ.
- Chỉ dùng chức năng mà tài khoản và website thực tế cho phép.
- Không tự vượt CAPTCHA, giới hạn tài khoản hoặc hạn chế dịch vụ.

## II. ĐÁNH GIÁ MÃ NGUỒN HIỆN TẠI

### 1. Những chức năng đã có

AI-Bridge hiện sử dụng:

- Node.js HTTP Server cục bộ.
- Chrome Extension Manifest V3.
- WebSocket để trao đổi dữ liệu.
- Content Script để điều khiển giao diện website.
- API tương thích OpenAI Chat Completions.
- Truyền văn bản theo từng phần thông qua SSE.
- Cơ chế token để ghép nối Extension.
- Nhận diện chín nhà cung cấp AI Web.

Các nhà cung cấp được khai báo gồm ChatGPT, Gemini, Claude, DeepSeek, Grok, Perplexity, Qwen, Kimi và Z.ai.

### 2. Những chức năng còn thiếu

| Mã     | Vấn đề                                               | Mức ưu tiên |
| ------ | ---------------------------------------------------- | ----------- |
| GAP-01 | Chưa có API tạo ảnh hoàn chỉnh                       | P0          |
| GAP-02 | Chưa có API tạo video hoàn chỉnh                     | P0          |
| GAP-03 | Chưa nhận diện file ảnh/video gốc                    | P0          |
| GAP-04 | Chưa xác minh kết quả thuộc đúng Task ID             | P0          |
| GAP-05 | Chưa có lựa chọn Chrome Profile cụ thể               | P0          |
| GAP-06 | Chưa có cơ chế chỉ định tab cố định                  | P0          |
| GAP-07 | Khi gửi tác vụ có hành vi kích hoạt tab và cửa sổ    | P0          |
| GAP-08 | Popup có thể mở tab mới                              | P0          |
| GAP-09 | Hàng chờ toàn cục hạn chế các Profile chạy đồng thời | P1          |
| GAP-10 | Chưa có bảng điều khiển phân công Text/Image/Video   | P1          |
| GAP-11 | Chưa có media storage và API tải file                | P0          |
| GAP-12 | Khả năng phục hồi tác vụ chưa đủ cho media dài       | P0          |

**Nhận xét:** AI-Bridge đã có nền tảng giao tiếp Chrome và API tương đối rõ ràng. Nên nâng cấp có chọn lọc thay vì thay toàn bộ kiến trúc.

## III. KẾT QUẢ NGHIÊN CỨU MUSE2API

### 1. Cơ chế đáng học hỏi

Trong mã nguồn muse2api, những phần quan trọng gồm:

**MediaRef:** Biểu diễn tham chiếu kết quả media, gồm loại, đường dẫn hoặc URL, MIME và thông tin liên quan.

**ChatWithItems:** Gửi yêu cầu với các nội dung đính kèm và theo dõi phản hồi từ phía Muse.

**pickMedia:** Lựa chọn kết quả thực sự phù hợp với loại yêu cầu là ảnh hoặc video.

**DownloadToFile:** Tải media theo luồng, có giới hạn dung lượng, tránh phải giữ toàn bộ video lớn trong RAM.

**Task Manager:** Quản lý trạng thái tác vụ, hàng chờ, hủy, lỗi, khôi phục và kết quả chưa xác định.

**Media Validation:** Kiểm tra file trước khi lưu và trả kết quả.

### 2. Những gì không nên sao chép

muse2api có cơ chế giao tiếp với dịch vụ Muse thông qua thông tin phiên đăng nhập và giao thức riêng.

AI-Bridge có yêu cầu khác: tiếp tục làm việc trực tiếp trên Chrome đã đăng nhập mà không xuất cookie.

Vì vậy, chỉ nên học hỏi:

- Kiến trúc quản lý tác vụ.
- Mô hình biểu diễn media.
- Kiểm tra tính toàn vẹn của file.
- Xử lý tiến trình và lỗi.
- Quy tắc phân biệt phản hồi văn bản với kết quả media.

Không được mặc định mang nguyên cơ chế giao tiếp Muse sang các AI khác, vì mỗi website có kiến trúc riêng.

## IV. KIẾN TRÚC AI-BRIDGE ĐỀ XUẤT

Hệ thống chia thành bảy thành phần chính.

### A. Profile Manager

Quản lý các Chrome Profile được kết nối.

Mỗi Profile có:

- `profileInstanceId`: ID riêng của Extension trong Profile đó.
- `displayName`: Tên người dùng đặt, chẳng hạn Profile 22.
- `connectionStatus`: Online, Offline hoặc Connecting.
- `availableProviders`: Những AI được nhận diện.
- `selectedTabs`: Các tab được người dùng cấp quyền.
- `lastSeen`: Thời gian kết nối gần nhất.

Không dựa vào số tab để phân biệt Profile.

Extension không tự biết chính xác tên Profile trong giao diện Chrome, nên người dùng cần xác nhận hoặc đặt tên Profile khi ghép nối.

### B. Tab Manager

Tìm kiếm và theo dõi các tab AI hiện có.

Mỗi tab lưu thông tin:

- Profile ID.
- Tab ID.
- Provider ID.
- URL được phép.
- Document Session ID.
- Trạng thái sẵn sàng.
- Loại tác vụ được hỗ trợ.
- Trạng thái bận/rảnh.

Nếu tab bị đóng, điều hướng hoặc tải lại thì yêu cầu xác minh lại trước khi gửi tác vụ.

### C. Capability Manager

Phân biệt ba trạng thái cấu hình:

**Được phát hiện:** Extension xác định tab thuộc một nhà cung cấp AI.

**Được bật:** Người dùng cho phép tab xử lý một loại tác vụ.

**Đã xác minh:** Adapter đã chứng minh loại tác vụ đó chạy thành công trên phiên website thực tế.

Ví dụ một tab Gemini có thể được nhận diện nhưng chức năng tạo ảnh vẫn chưa được xác minh. Không vì bật checkbox Image mà tự động coi tính năng đã hoạt động.

### D. Provider Adapter

Mỗi website có adapter riêng.

Các chức năng chuẩn:

- `detect()`: Xác định website.
- `probe()`: Kiểm tra trạng thái.
- `sendText()`: Gửi yêu cầu văn bản.
- `sendImage()`: Gửi yêu cầu tạo ảnh.
- `sendVideo()`: Gửi yêu cầu tạo video.
- `observeTask()`: Theo dõi tác vụ.
- `collectMedia()`: Thu thập kết quả.
- `cancel()`: Hủy trong phạm vi website cho phép.

Adapter không được tự ý khởi tạo cuộc trò chuyện, chuyển URL hoặc mở tab mới.

### E. Task Manager

Quản lý vòng đời của từng yêu cầu.

Các trạng thái chuẩn:

`QUEUED → DISPATCHED → RUNNING → COMPLETED`

Trạng thái ngoại lệ:

- `FAILED`: Đã xác định có lỗi.
- `CANCELLED`: Đã xác nhận hủy.
- `UNKNOWN`: Không xác định được tác vụ có hoàn thành hay không.

Một tab chỉ xử lý một yêu cầu tại một thời điểm.

Các tab độc lập có thể chạy song song nếu adapter hỗ trợ.

Tác vụ đã được gửi nhưng mất xác nhận không được tự động gửi lại, tránh tạo trùng hoặc phát sinh chi phí.

### F. Media Engine

Gồm ba module quan trọng.

**Media Detector:** Nhận biết ảnh hoặc video vừa được tạo.

**Media Collector:** Lấy dữ liệu thông qua cơ chế tải hợp lệ trong phiên trình duyệt.

**Media Validator:** Kiểm tra định dạng, kích thước, nội dung và tính toàn vẹn trước khi chấp nhận.

Hệ thống phải xác minh kết quả theo tab, phiên trang và lượt phản hồi mới, không chỉ tìm ảnh hoặc video xuất hiện cuối cùng trên giao diện.

### G. Local API Gateway

Cung cấp API thống nhất cho ứng dụng bên ngoài.

Server chỉ lắng nghe trên loopback, có xác thực riêng, kiểm soát Origin và không cho trang web bất kỳ sử dụng API một cách tùy ý.

## V. GIẢI PHÁP NHẬN DIỆN ẢNH VÀ VIDEO

### 1. Quy trình tạo ảnh

1. Nhận yêu cầu API loại Image.
2. Chọn Profile, Provider và tab được phép.
3. Kiểm tra chức năng tạo ảnh thực tế.
4. Ghi nhận các ảnh đã tồn tại trước khi gửi.
5. Gửi prompt đúng một lần.
6. Xác định lượt phản hồi mới của tác vụ.
7. Theo dõi quá trình sinh ảnh.
8. Phát hiện kết quả mới thuộc lượt phản hồi đó.
9. Tải file gốc nếu website cho phép.
10. Xác minh MIME, chữ ký file, kích thước và khả năng giải mã.
11. Lưu file kèm Task ID.
12. Trả file hoặc URL cục bộ cho API.

Không chấp nhận ảnh lịch sử, thumbnail hoặc ảnh chỉ xuất hiện trên màn hình mà chưa có tệp hợp lệ.

### 2. Quy trình tạo video

1. Nhận yêu cầu loại Video.
2. Tạo Task ID bền vững.
3. Đưa yêu cầu vào hàng chờ.
4. Chọn Profile và tab được phép.
5. Kiểm tra chế độ tạo video.
6. Gửi prompt đúng một lần.
7. Theo dõi trạng thái đang xử lý.
8. Phân biệt thông báo văn bản với kết quả video.
9. Xác định video mới thuộc tác vụ.
10. Tải tệp video được website cung cấp.
11. Xác minh container, codec, thời lượng và dữ liệu media thật.
12. Lưu file và trả kết quả.

API video phải hỗ trợ tác vụ bất đồng bộ. Không để kết nối HTTP chờ vô hạn.

### 3. Nhiều lớp nhận diện kết quả

Đề xuất ba lớp kiểm tra độc lập:

**Lớp 1 — Task Matching:** Xác định đúng tác vụ và lượt phản hồi bằng Task ID, Profile, Tab, phiên trang và các dấu hiệu lượt gửi.

**Lớp 2 — Media Detection:** Xác định phần tử media mới trên website, đối chiếu với nội dung trước khi gửi.

**Lớp 3 — File Validation:** Xác minh file đã tải bằng dữ liệu nhị phân, metadata và checksum.

Chỉ công nhận `COMPLETED` khi có đủ bằng chứng.

Nếu website không cung cấp file gốc hoặc không thể chứng minh media thuộc đúng tác vụ, trả lỗi rõ ràng hoặc trạng thái `UNKNOWN`.

## VI. BẢNG ĐIỀU KHIỂN ĐỀ XUẤT

Tên: **AI-Bridge Control Center**

### 1. Quản lý Profile

Hiển thị toàn bộ Profile đã ghép nối, trạng thái kết nối và những tab AI được chọn.

Cho phép đổi tên, đặt Profile mặc định, bật/tắt sử dụng và ngắt kết nối.

### 2. Phân công AI theo chức năng

Bảng cấu hình gồm:

| AI       | Chrome Profile | Text           | Image            | Video            |
| -------- | -------------- | -------------- | ---------------- | ---------------- |
| ChatGPT  | Profile 22     | Bật            | Tùy capability   | Tùy capability   |
| Gemini   | Profile 22     | Bật            | Tùy capability   | Tùy capability   |
| Muse     | Profile 22     | Tùy capability | Bật khi xác minh | Bật khi xác minh |
| Claude   | Profile 5      | Bật            | Tùy capability   | Tùy capability   |
| DeepSeek | Profile 5      | Bật            | Tùy capability   | Tùy capability   |

Đây là cấu hình mục tiêu, không phải cam kết tất cả các loại tác vụ đã được hỗ trợ.

Có thể gán nhiều Profile cho một nhà cung cấp nhưng mỗi tài khoản vẫn phải được định danh độc lập.

### 3. Model và ưu tiên

Hỗ trợ chọn AI mặc định cho Text, Image và Video.

Cho phép chọn Profile cụ thể trước khi gửi.

Không tự động chuyển sang tài khoản khác khi một tác vụ đã được gửi nhưng chưa rõ kết quả.

### 4. Theo dõi tác vụ

Hiển thị:

- Task ID.
- Loại tác vụ.
- Nhà cung cấp.
- Profile và tab.
- Thời gian bắt đầu.
- Trạng thái thực tế.
- Kết quả, file và thông báo lỗi.

Tiến trình phần trăm chỉ hiển thị khi có nguồn dữ liệu đáng tin cậy, không tự tạo phần trăm giả.

### 5. Quản lý Media

Có danh sách file đã hoàn thành, thông tin MIME, kích thước, thời lượng và liên kết tác vụ.

Hỗ trợ xem trước, tải file và kiểm tra dữ liệu đã lưu.

## VII. ĐẶC TẢ API THỐNG NHẤT

### Text

`POST /v1/chat/completions`

Giữ tương thích với các ứng dụng sử dụng OpenAI Chat Completions.

### Image

`POST /v1/images/generations`

Chuyển yêu cầu tới adapter ảnh và trả file hoặc URL cục bộ khi đã xác minh kết quả.

### Video

`POST /v1/video/tasks`

Trả về Task ID và trạng thái ban đầu.

`GET /v1/video/tasks/{taskId}`

Kiểm tra tiến trình và kết quả.

### Media

`GET /v1/media/{fileId}`

Trả file media đã lưu.

### Quản lý Bridge

- `GET /api/bridge/profiles`
- `GET /api/bridge/tabs`
- `GET /api/bridge/capabilities`
- `GET /api/bridge/tasks`
- `GET /api/bridge/health`

Những endpoint trên là thiết kế mục tiêu, không phải các endpoint hiện có của bản gốc. Các API quản lý phải có xác thực và phân quyền.

## VIII. KẾ HOẠCH TRIỂN KHAI

### Giai đoạn 0 — Kiểm tra hiện trạng

- Xác định HEAD, phiên bản và nhánh nguồn.
- Kiểm tra AGPL-3.0 của AI-Bridge và MIT của phiên bản muse2api đang tham khảo.
- Chạy bộ test hiện có.
- Xác minh khả năng gửi/nhận chat thật.
- Kiểm tra trên Chrome có nhiều Profile.
- Ghi nhận toàn bộ hành vi tự mở/chuyển tab.

**Kết quả yêu cầu:** Có báo cáo BASELINE và bộ kiểm thử tái hiện được.

### Giai đoạn 1 — Củng cố Chrome Bridge

- Loại bỏ hành vi tự mở tab khi không được yêu cầu.
- Không kích hoạt cửa sổ/tab khi gửi yêu cầu.
- Bổ sung quản lý Profile ID.
- Bổ sung lựa chọn Tab ID cụ thể.
- Thêm kiểm tra phiên trang trước khi gửi.
- Củng cố ghép nối và xác thực Local API.
- Bổ sung trạng thái mất kết nối.

**Nghiệm thu:** Gửi chat qua hai Profile riêng biệt, đúng tab, không làm gián đoạn cửa sổ Chrome.

### Giai đoạn 2 — Xây Media Engine

- Tạo cấu trúc MediaRef thống nhất.
- Tạo Media Detector.
- Tạo Media Collector.
- Tạo Media Validator.
- Bổ sung lưu file và endpoint truy xuất.
- Chuẩn hóa Task ID và cơ chế chống gửi trùng.
- Bổ sung giới hạn file, timeout và checksum.

**Nghiệm thu:** Nhận diện được file ảnh/video mẫu, phát hiện file sai, file cũ hoặc không thuộc tác vụ.

### Giai đoạn 3 — Hoàn thiện Muse Adapter

**Muse là nhà cung cấp thử nghiệm đầu tiên.**

Kiểm tra:

- Phát hiện tab Muse đang đăng nhập.
- Gửi prompt tạo ảnh.
- Xác định lượt ảnh mới.
- Tải và xác minh ảnh thật.
- Gửi prompt tạo video.
- Theo dõi đến khi tác vụ kết thúc.
- Tải và xác minh video thật.
- Trả kết quả thông qua API cục bộ.

**Nghiệm thu:** Tạo và nhận một ảnh cùng một video thật qua đúng Chrome Profile được chọn, không xuất cookie và không mở Chrome mới.

Nếu không thể lấy file media qua cơ chế website cho phép, phải ghi rõ giới hạn thay vì công bố tính năng đã hoàn thành.

### Giai đoạn 4 — Mở rộng Provider

Thực hiện lần lượt:

1. Gemini.
2. ChatGPT.
3. Claude.
4. DeepSeek.
5. Grok, Qwen, Kimi, Perplexity và Z.ai.

Với mỗi nhà cung cấp, chỉ triển khai các loại tác vụ website thực sự hỗ trợ và chỉ đánh dấu PASS sau khi có nghiệm thu.

### Giai đoạn 5 — Hoàn thiện Dashboard

Tạo giao diện quản lý:

- Chrome Profiles.
- Danh sách tab AI.
- Capability theo từng tài khoản.
- Text / Image / Video.
- Chọn AI mặc định.
- Hàng chờ.
- Lịch sử tác vụ.
- Thư viện kết quả.
- Thiết lập API.
- Chẩn đoán lỗi.

Không tạo những công tắc không có chức năng thực.

### Giai đoạn 6 — Kiểm thử hệ thống

Bộ kiểm thử tối thiểu:

| Mã kiểm thử | Nội dung                     | Tiêu chí                                      |
| ----------- | ---------------------------- | --------------------------------------------- |
| TEST-01     | Hai Chrome Profile cùng chạy | Không nhầm Profile                            |
| TEST-02     | Nhiều tab cùng Provider      | Gửi đúng tab chỉ định                         |
| TEST-03     | Chat văn bản                 | Đúng phản hồi mới                             |
| TEST-04     | Tạo ảnh                      | File ảnh hợp lệ                               |
| TEST-05     | Tạo video                    | File video hợp lệ                             |
| TEST-06     | Tab có media cũ              | Không lấy nhầm                                |
| TEST-07     | Mất kết nối                  | Không tự gửi trùng                            |
| TEST-08     | Đóng Profile                 | Báo Offline                                   |
| TEST-09     | Đổi URL hoặc reload          | Từ chối phiên không khớp                      |
| TEST-10     | File không hợp lệ            | Không báo thành công                          |
| TEST-11     | Gửi đồng thời trên hai tab   | Hàng chờ không xung đột                       |
| TEST-12     | Kiểm tra bảo mật API         | Không truy cập trái phép                      |
| TEST-13     | Đóng/mở Bridge Server        | Không làm mất hoặc gửi lại tác vụ đã xác nhận |
| TEST-14     | Chrome vẫn giữ nguyên        | Không mở/đóng/chuyển tab ngoài ý muốn         |

Kiểm thử tự động phải kết hợp với kiểm thử website AI thực tế. Test DOM mô phỏng không đủ để xác nhận khả năng tạo media.

### Giai đoạn 7 — Hoàn thiện bản sử dụng độc lập

- Hoàn thiện tài liệu cài đặt.
- Cơ chế tự chạy Local API Server.
- Kiểm tra tương thích Windows/macOS.
- Quản lý nhật ký không chứa bí mật.
- Kiểm tra tải file lớn và bộ nhớ.
- Kiểm tra nghĩa vụ giấy phép trước khi phân phối.
- Chuẩn hóa phiên bản và khả năng cập nhật.

## IX. THỨ TỰ ƯU TIÊN

**P0 — Phải hoàn thành trước:**

Giữ Chrome nguyên trạng, chọn đúng Profile/tab, bảo mật API, nhận diện ảnh/video mới, tải file, xác minh kết quả và chống gửi trùng.

**P1 — Hoàn thiện sau P0:**

Định tuyến đa Profile, hàng chờ song song, hỗ trợ thêm nhà cung cấp, dashboard và quản lý media.

**P2 — Nâng cao:**

Tối ưu hiệu năng, chẩn đoán chi tiết, lịch sử thống kê, tiện ích quản lý file và quy trình phân phối.

Không ưu tiên mở rộng hàng loạt nhà cung cấp trước khi có một adapter ảnh/video hoạt động thật.

## X. RỦI RO VÀ PHƯƠNG ÁN XỬ LÝ

| Rủi ro                        | Giải pháp                                                          |
| ----------------------------- | ------------------------------------------------------------------ |
| Website thay đổi giao diện    | Adapter riêng, bộ test selector và kiểm tra capability             |
| Không lấy được media gốc      | Sử dụng cơ chế tải được website cho phép; báo không hỗ trợ khi cần |
| Nhầm media cũ                 | Đối chiếu lượt phản hồi và Task ID, không chỉ dựa trên URL         |
| Kết quả video đến chậm        | Task bất đồng bộ, polling và timeout phù hợp                       |
| Mất kết nối Chrome            | Chuyển UNKNOWN, không tự gửi lại                                   |
| Trùng tài khoản giữa Profile  | Stable Profile ID và Tab ID                                        |
| Chrome Extension bị tạm ngưng | Thiết kế kết nối lại và xác nhận phiên                             |
| API bị ứng dụng khác truy cập | Xác thực mặc định, Origin allowlist, giới hạn loopback             |
| Điều khoản nhà cung cấp       | Kiểm tra quyền sử dụng cho từng website                            |
| Phát hành phần mềm AGPL       | Đánh giá và tuân thủ nghĩa vụ cấp phép                             |

## XI. TIÊU CHÍ HOÀN THÀNH TOÀN DỰ ÁN

AI-Bridge chỉ được công nhận hoàn thiện chức năng cốt lõi khi:

1. Kết nối được nhiều Chrome Profile đang mở.
2. Chọn được đúng Profile và đúng tab.
3. Không tự tạo Chrome hoặc tab mới.
4. Không xuất cookie hay thông tin đăng nhập.
5. Gửi và nhận Text đúng tác vụ.
6. Tạo, nhận diện và tải được ảnh thật.
7. Tạo, nhận diện và tải được video thật.
8. Có API cục bộ cho cả ba loại nội dung.
9. Không gửi trùng tác vụ khi mất kết nối.
10. Các chức năng trên có bằng chứng kiểm thử thực tế.

**Kết luận kỹ thuật:** Phát triển dựa trên mã nguồn AI-Bridge hiện tại, lấy ý tưởng quản lý MediaRef, Task Manager và xác minh media từ muse2api. Hoàn thiện Muse trước, sau đó mở rộng các nhà cung cấp khác. Không cần thay đổi cơ chế đăng nhập Chrome thành cơ chế xuất cookie.

**Trạng thái báo cáo:** Hoàn thành nghiên cứu mã nguồn và thiết kế mục tiêu. Chưa triển khai, chưa chạy thử AI thật, chưa sửa repository.
