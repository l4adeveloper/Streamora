# T15–T17 — Kết quả kiểm thử ngày 13/11/2026

## Môi trường và phạm vi

- Windows, Node.js 26.8.1, npm 11.19.0, PostgreSQL 18.6, Edge headless qua Playwright.
- PostgreSQL kiểm thử riêng tại 127.0.0.1:55442. DATABASE_URL chỉ được ghi đè trong
  tiến trình kiểm thử; không sửa backend/.env, không chạy migration trên database EC2.
- Fixture tạo database streamora_test_<uuid>, áp toàn bộ migration từ đầu (gồm
  20261113000100_file_folders), rồi xóa đúng database tạm sau lượt chạy.
- Bytes upload/download và ZIP dùng ổ local tạm; S3 chỉ được kiểm thử ký URL offline.
  Các con số cũ trong tài liệu bàn giao không được tính vào tổng lượt này.

## Kết quả

| Nhóm                                                        | Kết quả   |
| ----------------------------------------------------------- | --------- |
| Typecheck toàn monorepo                                     | Đạt       |
| Build API và các bản frontend production riêng của fixture  | Đạt       |
| Prisma validate                                             | Đạt       |
| Unit/controller/adapter T15–T17, gồm thư mục và video local | 30/30 đạt |
| API/database files + uploads, gồm ca thư mục multipart mới  | 17/17 đạt |
| UI thư viện T15 và UI thư mục                               | 2/2 đạt   |
| UI multipart T16                                            | 1/1 đạt   |
| UI pause/reload/resume, hàng đợi 5 file, quota 6 file T17   | 3/3 đạt   |

Tổng **53/53 ca đạt**, không có ca thất bại/bỏ qua ở các lượt xác minh cuối.

Các kiểm thử giữ giới hạn 4 file/5 PUT; không tăng timeout/concurrency nghiệp vụ để
làm test đạt. Kiểm thử UI T15 ban đầu vướng locator dialog cũ (nay có hai hộp thoại);
đã chọn rõ hộp thoại tài liệu và chạy lại đạt. Các input được tách theo thuộc tính
webkitdirectory, nút chọn file được truy cập qua menu Chọn tải lên mới.

## Những thay đổi được kiểm chứng

- Duyệt thư mục lồng nhau; thư mục không xuất hiện trong bộ lọc video/bản ghi.
- Tìm kiếm trả file bên trong cây thư mục, không trả dòng folder; empty state không
  để lại tiêu đề bảng bị bó hẹp. UI 375 px không tràn ngang.
- Picker thư mục giữ đường dẫn Materials/Sub; drag hover bật/tắt đúng khi vào/rời vùng nhận.
- Tải ZIP qua HTTP có xác thực, giữ tên/đường dẫn và bytes; nút UI lưu tên Materials.zip.
- Đổi tên/xóa cập nhật mọi file con; chặn người không có quyền, thư mục bận, trùng tên,
  file đang dùng; metadata xóa và job dọn storage được kiểm tra.
- Multipart upload → complete giữ folder_path trong UploadSession và LibraryFile;
  download kiểm tra SHA-256 cho file hơn 40 MiB, 6 part với concurrency 5.
- Resume sau reload giữ đúng `Resume/Sub` trong phiên server và file đã complete,
  không tạo phiên mới hoặc đưa file về gốc.
- Pause/reload/resume, native handle/Blob, sparse parts, fingerprint, quota, expiry,
  revocation và retry vẫn dùng luồng T16/T17 hiện có.

## Chạy lại

Từ gốc repository, chuẩn bị PostgreSQL KIỂM THỬ riêng có CREATEDB và pg_trgm.
Không dùng database ứng dụng để thay thế fixture hoặc reset dữ liệu đang sử dụng.

```powershell
$previousTestDatabaseUrl = $env:DATABASE_URL
try {
    $env:DATABASE_URL = 'postgresql://<test_user>:<password>@127.0.0.1:<port>/postgres'
    npm run typecheck
    npm run db:validate
    npm run test:t15
    npm run test:t15:frontend
    npm run test:t16
    npm run test:t16:frontend
    npm run test:t17
    npm run test:t17:frontend
} finally {
    if ($null -eq $previousTestDatabaseUrl) {
        Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    } else {
        $env:DATABASE_URL = $previousTestDatabaseUrl
    }
}
```

Lượt này build API một lần rồi chạy các file bằng node --test --test-concurrency=1
để tránh chạy trùng các ca giữa script T15/T16/T17. Nhóm 30 ca gồm:

```text
backend/test/files.test.cjs
backend/test/file-folders.test.cjs
backend/test/local-file-storage.test.cjs
backend/test/local-file-import.test.cjs
backend/test/multipart-storage.test.cjs
backend/test/uploads-resume.test.cjs
backend/test/uploads-scheduling.test.cjs
backend/test/uploads-resume-browser.test.cjs
backend/test/video-preview.test.cjs
```

Nhóm 17 ca gồm backend/test/integration/files.test.cjs và uploads.test.cjs.
Nhóm UI gồm backend/test/frontend/files-ui.test.cjs, uploads-ui.test.cjs và
uploads-resume-ui.test.cjs. Các ca được chạy lại sau sửa được tính một lần.

## Giới hạn bằng chứng

Chưa nghiệm thu EC2/S3 thật, IAM/CORS trên AWS, ZIP lớn qua internet hoặc benchmark
upload 1 GiB ở lượt này. Kiểm thử controller có hash 1 GiB để đo cache fingerprint,
không phải benchmark truyền 1 GiB. Không thay các ghi nhận lịch sử bằng kết quả local.
Thư mục rỗng và tạo/di chuyển thư mục thủ công vẫn chưa có trong sản phẩm.

## Bổ sung: buộc đổi tên/xóa thư mục đang tải lên

Lượt kiểm thử bổ sung sau khi thêm force: **49/49 ca đạt**, gồm 24 ca
unit/controller/adapter, 20 ca API/database và 5 ca UI (2 T15, 3 T17).
Typecheck toàn monorepo và build API đạt. Database vẫn là cluster local riêng
127.0.0.1:55442, không dùng database ứng dụng/EC2.

Bổ sung bằng chứng: từ chối force sai kiểu/không đủ quyền; chỉ hủy đúng cây và
không ảnh hưởng thư mục có prefix tương tự; active sessions chuyển về hủy và dọn;
INITIALIZING không thành ACTIVE sau force; COMPLETING không xuất bản file muộn và
object đã ghép được xóa. UI xác nhận rõ trước khi force, dừng 4 lượt đang truyền
cùng 2 draft chờ, và tab thứ hai tự chuyển 6 job sang đã hủy qua BroadcastChannel.
Các ca pause/resume, reload hàng đợi và quota hiện có tiếp tục đạt.

Trong lượt đầu, kiểm thử phát hiện bảng tiến độ 6 file che nút quản lý thư mục.
Đã thêm thu gọn/mở rộng bảng tiến độ, kiểm thử thao tác thật qua nút thu gọn rồi
force đã đạt, không dùng click cưỡng ép để bỏ qua vấn đề bố cục.
