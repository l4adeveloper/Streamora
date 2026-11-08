# T15 — thư viện tài liệu

Tài liệu tổng hợp phạm vi, API và triển khai/chuyển dữ liệu sang S3:
[bàn giao T15](t15-handoff.md).

Thư viện vẫn dùng API và PostgreSQL thật; nội dung file nằm trên ổ đĩa của máy
chạy backend. Không cần tài khoản AWS, bucket, Docker hoặc dịch vụ cloud mới.
Đây là T15; chưa có uploader multipart/resume T16/T17.

## Chạy

Trong `backend/.env`, thêm hoặc sửa:

```dotenv
FILES_STORAGE_DRIVER=local
FILES_LOCAL_DIRECTORY=.local-storage/files
FILES_PUBLIC_BASE_URL=http://127.0.0.1:4000
FILES_DOWNLOAD_TTL_SECONDS=120
FILES_CLEANUP_ENABLED=true
```

FILES_LOCAL_DIRECTORY tương đối với thư mục backend, không phải thư mục terminal.
Thư mục mặc định được Git bỏ qua. Không đặt nó vào frontend/public.
FILES_PUBLIC_BASE_URL là origin backend truy cập được từ trình duyệt, không có
`/api/v1` hay dấu `/` cuối; sửa nếu đổi port/host. Khi truy cập bằng máy khác,
localhost không đại diện cho máy chạy backend; dùng địa chỉ backend phù hợp.

```sh
npm run db:migrate
npm run dev:api
```

Mở terminal khác tại thư mục gốc:

```sh
npm run dev
```

Đăng nhập/đăng ký tài khoản, tạo group hoặc chọn group đã tham gia.
Lấy UUID group từ URL trang chi tiết group, ví dụ `/groups/<groupId>`.

## Nhập file thử vào thư viện

Trong terminal tại thư mục gốc (thay group/email/path bằng dữ liệu của bạn):

```powershell
npm run files:import -- --group UUID_CUA_GROUP --email "email-dang-nhap@example.com" --path "D:\TaiLieu\bai-giang.pdf"
```

Có thể thêm `--name "Tên trong thư viện.pdf"`. Lệnh chỉ sao chép file vào vùng
lưu trữ local, không sửa file gốc. Người tạo file là tài khoản email chỉ định,
phải còn membership/canUpload trong đúng group. Đây là công cụ nội bộ để nhập
dữ liệu thử; không có API công khai nhận objectKey hoặc createdBy từ trình duyệt.
Lệnh không tạo tài khoản, không đổi mật khẩu và không thay vai trò.

Nhập toàn bộ thư mục, mặc định gồm cả thư mục con:

```powershell
npm run files:import -- --group UUID_CUA_GROUP --email "email-dang-nhap@example.com" --folder "D:\TaiLieu"
```

Chỉ nhập các file nằm trực tiếp trong thư mục, bỏ qua thư mục con:

```powershell
npm run files:import -- --group UUID_CUA_GROUP --email "email-dang-nhap@example.com" --folder "D:\TaiLieu" --no-recursive
```

Mỗi file được thêm thành một mục thư viện. File trong thư mục con dùng tên tương đối
như `Chuong1/bai-giang.pdf` để phân biệt các file trùng tên; không tạo cây thư mục
trong giao diện. Bỏ qua symlink và vùng lưu trữ nội bộ của Streamora. Không dùng
`--folder` cùng `--path`/`--name`. Nếu một file lỗi, lệnh dừng và báo số file đã nhập;
các file thành công trước đó được giữ lại. Chạy lại sẽ tạo mục mới, không tự chống trùng.

Bản ghi cục bộ có thể nhập thêm `--source LOCAL_RECORDING --session UUID_BUOI_HOC`;
session phải thuộc cùng group. File cloud recording đi qua service registerRecording
của T11, không tạo bản ghi cloud giả bằng lệnh này.

Mở `/files?groupId=<UUID_CUA_GROUP>` rồi bấm **Làm mới**. File đã nhập xuất hiện
với trạng thái Sẵn sàng, có thể xem chi tiết/đổi tên/tải/xóa theo quyền.

## Các tình huống thử

PDF có nút **Xem trước** (biểu tượng mắt) trong danh sách và phần chi tiết.
Khung xem dùng trình đọc PDF có sẵn của trình duyệt, có thể tải lại link hoặc tải
file xuống. Backend chỉ cấp `POST /files/:fileId/preview-url` cho PDF AVAILABLE,
có kiểm tra quyền group; link inline có cùng TTL với link tải. Chế độ local kiểm
tra cả chữ ký `%PDF-` của nội dung, không chỉ tên file. File khác vẫn dùng tải xuống.
Không cần bật public access để xem trước trên S3; adapter ký GET với Content-Type
application/pdf và Content-Disposition inline. Trình duyệt cần có hỗ trợ hiển thị PDF.

- Tìm tên, lọc tài liệu/video và phân trang dữ liệu thật.
- Uploader sửa/xóa file của mình; viewer khác không sửa/xóa được.
- HOST/OWNER quản lý tài liệu group; người ngoài group không xem hoặc cấp link tải.
- Link tải local có chữ ký và hết hạn; sửa token hoặc đợi quá TTL sẽ bị từ chối.
- PENDING không tải được; file đang được tham chiếu không xóa được.
- Xóa mềm làm file biến mất ngay. Worker dọn nội dung local mỗi 30 giây, có retry.
- Chạy `npm run test:t15` cho các kiểm thử API/local storage; cần PostgreSQL
  cho phép tạo database kiểm thử tạm. `npm run test:t15:frontend` kiểm tra giao diện.

Link local là bearer URL ngắn hạn giống mô hình presigned URL: ai có link còn
hạn có thể tải; không cấp link mới sau thu hồi quyền. Không phục vụ thư mục local
bằng static hosting. URL không chứa đường dẫn tuyệt đối của ổ đĩa.

## API và tích hợp

REST có tiền tố `/api/v1`, dùng Bearer token và kiểm tra quyền group:

| Method | Path | Chức năng |
| --- | --- | --- |
| GET | `/groups/:groupId/files` | Tìm `q`, lọc `type=document\|video`, phân trang `cursor`/`limit` |
| GET | `/files/:fileId` | Chi tiết |
| PATCH | `/files/:fileId` | Đổi tên `{name}`, giữ objectKey |
| DELETE | `/files/:fileId` | Xóa mềm, trả 204 |
| POST | `/files/:fileId/download-url` | Link tải `{url,expiresAt}` |
| POST | `/files/:fileId/preview-url` | Link xem PDF inline |

Swagger: `/api/v1/docs-files`; JSON: `/api/v1/docs-files-json`.
Alias `GET /files?groupId=...` giữ tương thích T03. Tìm tên giữ dấu, không phân biệt
hoa/thường. Phân trang `createdAt DESC,id DESC`, limit 1–100. Migration cần `pg_trgm`.

File PENDING chưa tải/xem trước được. Uploader hoặc HOST/OWNER/ADMIN được sửa/xóa;
uploader phải còn quyền group. File PENDING, còn recordingId hoặc file_usages trả
409 FILE_IN_USE. Xóa mềm tạo outbox để dọn nội dung và retry khi storage lỗi.

T11 gọi service nội bộ `FilesService.registerRecording`: tạo registry
`recording_assets {id,sessionId}` trước, rồi đăng ký metadata; service kiểm tra
group và chống trùng theo recordingId. T16 tạo file PENDING, chuyển AVAILABLE
sau complete; T11/T13 dùng file_usages để giữ file đang được xử lý.

## Chuyển sang S3 sau

```dotenv
FILES_STORAGE_DRIVER=s3
FILES_S3_BUCKET=streamora-storage
FILES_S3_REGION=ap-southeast-1
```

Cấu hình credentials phía backend rồi khởi động lại. Giao diện/API metadata
giữ nguyên. **Các file đã nhập local không tự chuyển lên S3**; cần chuyển dữ liệu
và giữ objectKey tương ứng trước khi đổi driver cho thư viện đang có dữ liệu.
Chế độ local dùng một ổ đĩa, không thay thế khả năng chia sẻ lưu trữ giữa nhiều
backend hoặc kiểm thử IAM/CORS/chữ ký S3 thật.
