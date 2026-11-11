// Bản địa hoá tiếng Việt. Các khoá chưa dịch kế thừa tiếng Anh để giao diện không hiển thị tiếng Trung.
// Không thay đổi định danh API, biến môi trường hay tham số yêu cầu.
import enUS from "./en-US";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeLocale<T>(base: T, changes: Record<string, unknown>): T {
    const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(changes)) {
        merged[key] = isRecord(value) && isRecord(merged[key])
            ? mergeLocale(merged[key], value)
            : value;
    }
    return merged as T;
}

const viVN = mergeLocale(enUS, {
    "meta": {
        "title": "Canvas vô hạn",
        "description": "Không gian sáng tạo với Canvas vô hạn"
    },
    "theme": {
        "toggle": "Đổi giao diện"
    },
    "common": {
        "cancel": "Huỷ",
        "save": "Lưu",
        "edit": "Chỉnh sửa",
        "done": "Hoàn tất",
        "delete": "Xoá",
        "copy": "Sao chép",
        "copied": "Đã sao chép",
        "details": "Chi tiết",
        "addToAssets": "Thêm vào tài nguyên của tôi",
        "addedToAssets": "Đã thêm vào tài nguyên",
        "copyPrompt": "Sao chép prompt",
        "promptCopied": "Đã sao chép prompt",
        "created": "Đã tạo: {{date}}",
        "updated": "Cập nhật: {{date}}",
        "all": "Tất cả",
        "view": "Xem",
        "download": "Tải xuống",
        "upload": "Tải lên",
        "requestCanceled": "Đã huỷ yêu cầu",
        "durationMinutes": "{{minutes}} phút {{seconds}} giây",
        "durationSeconds": "{{seconds}} giây",
        "imageReadFailed": "Không đọc được ảnh"
    },
    "settingsPanels": {
        "common": {
            "auto": "Tự động",
            "low": "Thấp",
            "medium": "Trung bình",
            "high": "Cao",
            "xhigh": "Rất cao",
            "max": "Tối đa"
        },
        "image": {
            "title": "Cài đặt ảnh",
            "quality": "Chất lượng",
            "size": "Kích thước",
            "align16": "Căn theo bội số 16",
            "resolution": "Độ phân giải",
            "aspectRatio": "Tỷ lệ khung hình",
            "transparent": "Nền trong suốt",
            "count": "Số ảnh",
            "images": "{{count}} ảnh"
        },
        "video": {
            "title": "Cài đặt video",
            "quality": "Chất lượng",
            "size": "Kích thước",
            "seconds": "Số giây",
            "mode": "Chế độ",
            "modes": {
                "frames": "Khung hình đầu và cuối",
                "reference": "Ảnh/video tham chiếu"
            },
            "resolution": "Độ phân giải",
            "ratio": "Tỷ lệ khung hình",
            "duration": "Thời lượng",
            "smart": "Thông minh",
            "output": "Đầu ra",
            "generateAudio": "Tạo âm thanh",
            "watermark": "Thêm hình mờ",
            "adaptive": "Tự thích ứng",
            "sizes": {
                "landscape": "Ngang",
                "portrait": "Dọc",
                "square": "Vuông",
                "widescreen": "Màn hình rộng",
                "tall": "Ảnh dọc",
                "auto": "Tự động"
            }
        },
        "audio": {
            "title": "Cài đặt âm thanh",
            "voice": "Giọng đọc",
            "format": "Định dạng",
            "speed": "Tốc độ",
            "instructions": "Hướng dẫn giọng đọc"
        },
        "text": {
            "title": "Cài đặt văn bản",
            "reasoning": "Mức suy luận",
            "count": "Số lần tạo"
        },
        "model": {
            "select": "Chọn model",
            "assign": "Chọn model cho {{capability}} trong cài đặt nhà cung cấp",
            "noMatch": "Không có model phù hợp cho {{capability}}",
            "addFirst": "Hãy thêm nhà cung cấp và model trong Cài đặt",
            "capabilities": {
                "image": "tạo ảnh",
                "video": "video",
                "text": "văn bản",
                "audio": "âm thanh"
            }
        }
    },
    "apiErrors": {
        "requestFailed": "Yêu cầu thất bại",
        "requestCanceled": "Đã huỷ yêu cầu",
        "baseUrlRequired": "Hãy cấu hình BASE URL",
        "apiKeyRequired": "Hãy nhập API Key",
        "authenticationFailed": "Xác thực thất bại. Kiểm tra API Key và quyền sử dụng model.",
        "rateLimited": "Yêu cầu bị giới hạn hoặc đã hết hạn mức. Hãy thử lại sau.",
        "notFound": "Không tìm thấy endpoint (404). Kiểm tra BASE URL và model.",
        "badGateway": "Lỗi gateway (502). Dịch vụ API có thể đang gián đoạn.",
        "serviceBusy": "Dịch vụ đang bận (503). Hãy thử lại.",
        "httpFailed": "Yêu cầu thất bại (HTTP {{status}}). Kiểm tra BASE URL và API Key.",
        "imageTimeout": "Tạo ảnh quá thời gian chờ. Hãy thử lại hoặc đổi nhà cung cấp.",
        "noImageReturned": "API không trả về ảnh.",
        "videoTimeout": "Tạo video của {{provider}} quá thời gian chờ. Hãy thử lại.",
        "videoGenerationFailed": "Tạo video thất bại",
        "videoModelRequired": "Hãy cấu hình model tạo video trước",
        "videoPromptRequired": "Nhập mô tả video hoặc kết nối tài nguyên tham chiếu",
        "videoDownloadFailed": "Không tải được video"
    },
    "assets": {
        "title": "Tài nguyên của tôi",
        "description": "Lưu văn bản, ảnh và video để tái sử dụng.",
        "search": "Tìm theo tên, nội dung, thẻ hoặc nguồn",
        "type": "Loại",
        "export": "Xuất tài nguyên",
        "import": "Nhập tài nguyên",
        "add": "Thêm tài nguyên",
        "edit": "Sửa tài nguyên",
        "empty": "Không tìm thấy tài nguyên",
        "selectImage": "Chọn ảnh",
        "updated": "Đã cập nhật tài nguyên",
        "saved": "Đã lưu tài nguyên",
        "textCopied": "Đã sao chép văn bản",
        "deleted": "Đã xoá tài nguyên",
        "kinds": {
            "text": "Văn bản",
            "image": "Ảnh",
            "video": "Video"
        }
    },
    "notFound": {
        "title": "Không tìm thấy trang",
        "description": "Trang này không tồn tại hoặc đã được chuyển đến vị trí khác.",
        "home": "Về trang chủ"
    },
    "workbench": {
        "logs": "Lịch sử tạo nội dung",
        "settings": "Cài đặt",
        "prompt": "Prompt",
        "viewPrompts": "Xem thư viện prompt",
        "viewAssets": "Xem tài nguyên",
        "clipboard": "Bộ nhớ tạm",
        "upload": "Tải lên",
        "adjust": "Điều chỉnh",
        "generate": "Tạo nội dung",
        "results": "Kết quả",
        "waiting": "Đang chờ {{time}}",
        "model": "Model",
        "generating": "Đang tạo",
        "success": "Thành công",
        "failed": "Tạo thất bại",
        "retry": "Thử lại",
        "new": "Mới",
        "selectAll": "Chọn tất cả",
        "noLogs": "Chưa có lịch sử tạo nội dung",
        "deleteLogs": "Xoá lịch sử tạo nội dung",
        "deleteLogsConfirm": "Xoá {{count}} mục lịch sử đã chọn?",
        "successCount": "{{count}} thành công",
        "failCount": "{{count}} thất bại",
        "itemCount": "{{count}} ảnh",
        "untitled": "Chưa đặt tên",
        "configFirst": "Hãy hoàn tất cấu hình trước",
        "generationFailed": "Tạo nội dung thất bại",
        "retrySuccess": "Thử lại thành công"
    },
    "imageWorkbench": {
        "title": "Trình tạo ảnh"
    },
    "videoWorkbench": {
        "title": "Trình tạo video"
    },
    "canvas": {
        "title": "Canvas vô hạn",
        "defaultTitle": "Canvas {{count}}",
        "library": "Thư viện Canvas",
        "imported": "Đã nhập {{count}} Canvas",
        "importFailed": "Nhập thất bại, vui lòng chọn tệp Canvas hợp lệ",
        "opening": "Đang mở Canvas…",
        "loading": "Đang tải Canvas…",
        "exportSelected": "Xuất mục đã chọn",
        "deleteSelected": "Xoá mục đã chọn",
        "deleteAll": "Xoá tất cả",
        "import": "Nhập Canvas",
        "create": "Tạo Canvas mới",
        "empty": "Chưa có Canvas",
        "emptyDescription": "Tạo Canvas để lưu các thành phần, kết nối và bố cục riêng.",
        "collapsePanel": "Thu gọn bảng",
        "expandPanel": "Mở rộng bảng",
        "home": "Trang chủ",
        "docs": "Tài liệu",
        "projects": "Canvas của tôi"
    },
    "navigation": {
        "canvas": "Canvas của tôi",
        "image": "Tạo ảnh",
        "video": "Tạo video",
        "prompts": "Thư viện prompt",
        "assets": "Tài nguyên",
        "config": "Cài đặt"
    },
    "topNav": {
        "openMenu": "Mở menu điều hướng",
        "menu": "Menu điều hướng",
        "navigation": "Điều hướng",
        "openAgent": "Mở Agent",
        "closeAgent": "Đóng Agent",
        "plugins": "Plugin nút",
        "docs": "Tài liệu",
        "switchLanguage": "Chuyển sang {{language}}",
        "shortcuts": "Phím tắt",
        "lightTheme": "Chế độ sáng",
        "darkTheme": "Chế độ tối"
    },
    "home": {
        "promptError": "Không tải được prompt",
        "description": "Tạo, kết nối và chỉnh sửa <content>ảnh, văn bản, đồ hoạ</content> trên <canvas>Canvas vô hạn</canvas>.",
        "start": "Bắt đầu",
        "openCanvas": "Mở Canvas",
        "showcaseTitle": "Lưu giữ mọi kết quả tốt nhất",
        "showcaseDescription": "Lưu prompt, ảnh tham chiếu và ảnh đã tạo để dùng trong lần sáng tạo tiếp theo.",
        "viewPrompts": "Xem thư viện prompt"
    },
    "version": {
        "viewUpdates": "Xem cập nhật",
        "title": "Thông tin phiên bản",
        "currentVersion": "Phiên bản hiện tại",
        "latestVersion": "Phiên bản mới nhất",
        "checking": "Đang kiểm tra…",
        "checkUpdates": "Kiểm tra cập nhật",
        "unreleased": "Chưa phát hành",
        "latest": "Mới nhất",
        "current": "Hiện tại",
        "readFailed": "Không đọc được phiên bản",
        "changelogFailed": "Không đọc được thay đổi",
        "updated": "Đã tải phiên bản mới nhất",
        "updateFailed": "Không tải được thông tin phiên bản"
    },
    "config": {
        "title": "Cài đặt và tuỳ chọn",
        "invalidFile": "Định dạng tệp cấu hình không hợp lệ",
        "description": "Nhà cung cấp, model, đồng bộ và lưu trữ",
        "modalDescription": "Nhà cung cấp, model mặc định, đồng bộ và lưu trữ",
        "tabs": {
            "channels": "Nhà cung cấp",
            "localProxy": "Proxy cục bộ",
            "preferences": "Tuỳ chọn",
            "promptSources": "Nguồn prompt",
            "localStorage": "Bộ nhớ cục bộ"
        },
        "proxy": {
            "title": "Proxy cục bộ",
            "address": "Địa chỉ proxy",
            "test": "Kiểm tra kết nối"
        },
        "localStorage": {
            "title": "Dung lượng IndexedDB",
            "quota": "Dung lượng khả dụng",
            "refresh": "Làm mới dung lượng"
        }
    },
    "agent": {
        "status": {
            "failed": "Kết nối thất bại",
            "connected": "Đã kết nối",
            "connecting": "Đang kết nối",
            "disconnected": "Đã ngắt kết nối"
        },
        "state": {
            "ready": "Sẵn sàng",
            "offline": "Ngoại tuyến"
        },
        "history": {
            "empty": "Chưa có lịch sử",
            "refresh": "Làm mới",
            "newThread": "Cuộc trò chuyện mới"
        },
        "skills": {
            "search": "Tìm kỹ năng",
            "loading": "Đang tải kỹ năng…",
            "select": "Chọn kỹ năng"
        },
        "composer": {
            "removeImage": "Gỡ ảnh",
            "uploadImage": "Tải ảnh lên",
            "stop": "Dừng",
            "send": "Gửi"
        },
        "panel": {
            "chat": "Trò chuyện",
            "history": "Lịch sử",
            "skills": "Kỹ năng",
            "logs": "Nhật ký"
        },
        "chat": {
            "input": "Đầu vào",
            "output": "Đầu ra"
        },
        "logs": {
            "copied": "Đã sao chép nhật ký",
            "title": "Nhật ký chạy",
            "diagnostics": "Chẩn đoán"
        },
        "events": {
            "analyzing": "Đang phân tích yêu cầu…",
            "reasoning": "Tóm tắt suy luận",
            "plan": "Kế hoạch thực hiện",
            "commandFailed": "Lệnh thất bại",
            "commandCompleted": "Lệnh hoàn tất",
            "executeCommand": "Chạy lệnh"
        }
    },
    "locale": {
        "zhCN": "简体中文",
        "enUS": "English",
        "viVN": "Tiếng Việt"
    }
});
export default viVN;
