# T16 — Bàn giao upload multipart song song

Phần resume trong tài liệu này mô tả mốc T16. Triển khai tiếp theo xem [bàn giao T17](t17-handoff.md).

Ngày cập nhật: **13/11/2026**. Các kết quả ngày 08/11 bên dưới là bằng chứng lịch sử.

Tài liệu mô tả code trong working tree tại thời điểm bàn giao. T16 đã tích hợp
vào frontend **3000**, API NestJS **4000** và storage local **4002**. AWS có adapter
và cấu hình mẫu; **chưa tạo hạ tầng hay kiểm thử upload trên S3 thật**. Các thay đổi
chưa được chốt thành commit/PR trong đợt viết tài liệu này.

Yêu cầu gốc được đối chiếu với [Job.xlsx](../../docs/Job.xlsx), mục T16 và
T16-01 đến T16-05. T16 dùng thư viện/quyền nhóm của [T15](t15-handoff.md).

Cập nhật hiện tại: một nút **Chọn tải lên** cho file/thư mục, kéo thả cây thư mục,
vùng nhận có hover, lưu đường dẫn qua multipart. Resume hiện đã có tại T17; các đoạn
mô tả giới hạn của mốc T16 được đánh dấu bên dưới. Xem [kết quả chạy lại](t15-t17-verification.md).

## 1. Phạm vi và trạng thái bàn giao

| Hạng mục                                                                  | Trạng thái                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| Chọn nhiều file hoặc thư mục lồng nhau, kéo thả, hàng đợi riêng từng file | Đã triển khai                                     |
| Tối đa 4 file xử lý đồng thời trong một uploader                          | Đã triển khai                                     |
| Tổng tối đa 5 PUT part cùng lúc trong hàng đợi đó                         | Đã triển khai                                     |
| Chia file, ký URL theo batch, thu ETag, kiểm tra rồi complete             | Đã triển khai local; có adapter S3                |
| Hủy phiên, dọn parts/final object còn sót, retry complete                 | Đã triển khai                                     |
| Popup tiến độ; trạng thái thành công tự ẩn sau 5 giây                     | Đã triển khai                                     |
| Quota server theo người dùng/nhóm, số phiên và dung lượng                 | Đã triển khai                                     |
| Lưu vị trí riêng cho file/phiên upload/job xóa                            | Đã triển khai                                     |
| Preview PDF và ảnh JPEG/PNG/WebP                                          | Đã triển khai                                     |
| Preview video thật, tốc độ phát, menu chất lượng, Range/HEAD              | Đã triển khai; mặc định chỉ có bản gốc            |
| UI live preview kiểu YouTube trong workspace                              | Đã chỉnh UI; nội dung/DVR/chất lượng vẫn minh họa |
| Resume sau mất mạng/reload, IndexedDB, API trạng thái                     | Đã có tại [T17](t17-handoff.md)                   |
| Encode nhiều chất lượng bằng AWS, callback/job xử lý                      | Chưa triển khai; điểm nối T13                     |
| CDN/CloudFront, `CDN_BASE_URL`, phân phối HLS riêng tư                    | Chưa tích hợp; điểm nối T14                       |
| Replication GCS, failover hoặc kiểm thử tải đa cloud                      | Chưa triển khai                                   |

T16-05 là thao tác PUT vào URL storage đã ký, **không phải endpoint nhận bytes
trong NestJS**. API điều khiển có kiểm tra phiên đăng nhập và quyền nhóm; URL PUT
là quyền truy cập tạm thời dành cho người giữ URL hợp lệ.

## 2. Kiến trúc và luồng upload

```mermaid
sequenceDiagram
    participant UI as Trình duyệt · 3000
    participant API as UploadsModule · 4000
    participant DB as PostgreSQL
    participant Store as Local 4002 hoặc S3
    UI->>API: POST /uploads · metadata
    API->>DB: Kiểm tra quyền, quota, giữ chỗ INITIALIZING
    API->>Store: Tạo phiên multipart · ngoài transaction
    API->>DB: Kiểm tra lại quyền, chuyển ACTIVE
    API-->>UI: uploadId, partSize, totalParts, expiresAt
    loop Các batch tối đa 5 part trên client
        UI->>API: POST /uploads/:id/parts/sign
        API-->>UI: URL có hạn tối đa 60 giây
        par Các PUT được giới hạn bởi hàng đợi chung
            UI->>Store: PUT bytes part thứ nhất
            Store-->>UI: HTTP 200, ETag
        and Part khác khi còn lượt trong limiter
            UI->>Store: PUT bytes part tiếp theo
            Store-->>UI: HTTP 200, ETag
        end
    end
    UI->>API: POST /uploads/:id/complete · parts + ETag
    API->>DB: Nhận quyền xử lý COMPLETING
    API->>Store: ListParts / ghép file / HeadObject
    API->>DB: Kiểm tra lại quyền, tạo file AVAILABLE, COMPLETED
    API-->>UI: Cùng fileId cho những lần complete lại
```

PostgreSQL chỉ giữ metadata và trạng thái điều phối. Bytes đi từ trình duyệt tới
storage. Local stream từng phần xuống đĩa, ghép bằng stream và xuất bản file hoàn
chỉnh trước khi công bố metadata; không nạp toàn bộ file lớn vào RAM.

### 2.1. Phân biệt kích thước part với concurrency

- **8 MiB** là kích thước mặc định của một part.
- **5** là số PUT tối đa cùng lúc trong một hàng đợi UI, không phải tổng số part.
- **4** là số file tối đa uploader đang xử lý; các file dùng chung giới hạn 5 PUT.

Ví dụ file **1 GiB** có **128 part × 8 MiB** và gửi theo các lượt. File không bị
giới hạn ở 40 MiB. Giới hạn ứng dụng mặc định là **2 GiB/file**; phần cuối có thể
nhỏ hơn partSize. API ký tối đa 8 part/request, còn client hiện ký batch tối đa 5.

Client ký lại URL khi part đang chờ lượt có URL sắp hết hạn (còn tối đa 3 giây).
Tại mốc T16 ban đầu chưa có retry/backoff hay resume bền vững. Bản hiện tại
đã bổ sung tại T17; đọc T17 để tích hợp luồng đang dùng.

### 2.2. Trạng thái và phục hồi

```mermaid
stateDiagram-v2
    [*] --> INITIALIZING
    INITIALIZING --> ACTIVE: Tạo storage thành công
    INITIALIZING --> ABORTED: Tạo thất bại, dọn thành công
    ACTIVE --> COMPLETING: Nhận lease
    COMPLETING --> COMPLETED: Xác minh và commit file
    COMPLETING --> ACTIVE: Lỗi, cho phép thử hoàn tất lại
    ACTIVE --> ABORTING: Hủy hoặc hết hạn
    INITIALIZING --> ABORTING: Khởi tạo dang dở, lease đã hết
    COMPLETING --> ABORTING: Phiên và lease đã hết hạn
    ABORTING --> ABORTED: Dọn storage thành công
```

Các bước INITIALIZING/COMPLETING/ABORTING giữ lease **5 phút**, gia hạn mỗi phút
khi còn xử lý, và có `operation_token` để kiểm tra trước khi commit. Thao tác
storage chạy ngoài transaction; khóa user → group → upload chỉ giữ trong bước
database ngắn. Download/playback dùng các lần kiểm tra quyền ngắn trước và sau
khi cấp grant; không giữ khóa trong lúc gọi storage.

- Complete kiểm tra parts thực tế, thứ tự, ETag và kích thước. Không chỉ tin
  danh sách do client gửi.
- Nếu object đã ghép nhưng metadata chưa commit, lần complete lại dùng
  HeadObject/local size để phục hồi và tạo một file.
- Complete đồng thời chờ ngoài transaction tối đa 8 giây; nếu thao tác trước
  còn chạy thì trả `409 UPLOAD_BUSY`. Khi đã COMPLETED, retry trả cùng fileId.
- Abort khi đang có lease xử lý còn hiệu lực cũng có thể trả UPLOAD_BUSY.
  Abort đã thành công thì gọi lại trả 204; file COMPLETED phải xóa qua thư viện.
- UI giữ payload complete trong bộ nhớ để nút **Thử hoàn tất lại** không cần gửi
  lại bytes. Reload trang sẽ mất payload này.

Worker mỗi 30 giây xử lý tối đa 20 phiên hết hạn/khởi tạo dang dở/hủy lỗi khi lease
cho phép. Chỉ giải phóng quota sau complete hoặc dọn thành công. Worker xóa file
của T15 cũng claim job bằng một UPDATE với SKIP LOCKED rồi xóa ngoài transaction.

## 3. Chạy và demo local

Yêu cầu Node.js **>=22.16.0**, npm **>=10**, PostgreSQL và cấu hình auth/database
hợp lệ. Node.js 26 đã được kiểm tra đường stream video; môi trường triển khai
vẫn cần chọn phiên bản Node được nhóm hỗ trợ.

Từ gốc repository, với máy mới:

```powershell
npm ci
npm run setup:env
```

Lệnh setup tạo file còn thiếu, giữ nguyên cấu hình đã có. Điền DATABASE_URL và
các giá trị còn thiếu trong `backend/.env`. ACCESS_TOKEN_SECRET phải hợp lệ theo
quy tắc của dự án; không thay khóa của môi trường đang sử dụng tùy tiện.

Cấu hình T16 trong `backend/.env`:

```dotenv
API_HOST=127.0.0.1
API_PORT=4000
WEB_ORIGIN=http://127.0.0.1:3000

FILES_STORAGE_DRIVER=local
FILES_LOCAL_DIRECTORY=.local-storage/files
FILES_PUBLIC_BASE_URL=http://127.0.0.1:4000
FILES_DOWNLOAD_TTL_SECONDS=60
FILES_CLEANUP_ENABLED=true

UPLOAD_LOCAL_PORT=4002
UPLOAD_MAX_SIZE_BYTES=2147483648
UPLOAD_PART_SIZE_BYTES=8388608
UPLOAD_TTL_SECONDS=86400
UPLOAD_MAX_ACTIVE_PER_USER=4
UPLOAD_MAX_ACTIVE_PER_GROUP=32
UPLOAD_MAX_ACTIVE_BYTES_PER_USER=8589934592
UPLOAD_MAX_ACTIVE_BYTES_PER_GROUP=68719476736
```

`frontend/.env.local` dùng API hiện tại:

```dotenv
NEXT_PUBLIC_API_URL=http://127.0.0.1:4000/api/v1
```

Biến môi trường của tiến trình ưu tiên hơn file .env. Cấu hình mẫu nằm trong
[backend/.env.example](../.env.example) và
[frontend/.env.example](../../frontend/.env.example).

Chuẩn bị database rồi chạy API và frontend ở hai terminal:

```powershell
npm run db:migrate
npm run db:check
npm run dev:api
```

```powershell
npm run dev
```

| Cổng | Vai trò                                                   |
| ---- | --------------------------------------------------------- |
| 3000 | Giao diện: `/files?groupId=<uuid>`, `/workspace`          |
| 4000 | Auth, metadata, điều khiển upload, download/preview local |
| 4002 | Listener nhận PUT part local; tự mở khi ký part đầu tiên  |

Không cần chạy thêm ứng dụng 3006, AWS, Docker hoặc storage daemon. Listener
local chỉ bind 127.0.0.1 và dành cho phát triển. `FILES_PUBLIC_BASE_URL` là địa chỉ
API cấp bytes local, không phải địa chỉ frontend hoặc CDN.

Mặc định parts/manifest ở `backend/.local-storage/uploads/<storageId>`; nội dung
hoàn tất ở `backend/.local-storage/files/groups/<groupId>/uploads/<uploadId>`.
Tên hiển thị và objectKey độc lập. Chỉ đo tốc độ local; kết quả này không đại diện
cho tốc độ upload internet/S3.

## 4. Policy, quota và quyền

| Biến                              | Mặc định    | Ý nghĩa / giới hạn                                  |
| --------------------------------- | ----------- | --------------------------------------------------- |
| UPLOAD_MAX_SIZE_BYTES             | 2147483648  | 2 GiB cho một file                                  |
| UPLOAD_PART_SIZE_BYTES            | 8388608     | 8 MiB; ứng dụng cho phép 5–64 MiB                   |
| UPLOAD_TTL_SECONDS                | 86400       | Phiên 24 giờ; cấu hình tối đa 7 ngày                |
| UPLOAD_LOCAL_PORT                 | 4002        | Cổng PUT local, phải trống                          |
| UPLOAD_MAX_ACTIVE_PER_USER        | 4           | Tổng phiên giữ chỗ của người dùng trên mọi nhóm/tab |
| UPLOAD_MAX_ACTIVE_PER_GROUP       | 32          | Tổng phiên giữ chỗ của nhóm                         |
| UPLOAD_MAX_ACTIVE_BYTES_PER_USER  | 8589934592  | 8 GiB giữ chỗ/người                                 |
| UPLOAD_MAX_ACTIVE_BYTES_PER_GROUP | 68719476736 | 64 GiB giữ chỗ/nhóm                                 |
| FILES_DOWNLOAD_TTL_SECONDS        | 60          | URL download/preview tối đa 60 giây khi chạy        |
| FILES_CLEANUP_ENABLED             | true        | Bật worker xóa object sau xóa mềm ở thư viện        |

Quota được kiểm tra tại server dưới khóa user/group nên không thể vượt bằng
cách mở thêm tab hoặc dùng nhiều API instance. Đếm INITIALIZING, ACTIVE,
COMPLETING, ABORTING, kể cả phiên hết hạn chưa dọn xong. Đây là **quota upload đang
diễn ra** theo size đã khai báo, chưa phải hard quota trên bucket/ổ đĩa hoặc quota
tổng dung lượng thư viện. Kích thước thực tế vẫn được xác minh khi complete.
Giới hạn PUT 5 là phía hàng
đợi client, không phải bộ đếm PUT toàn hệ thống hoặc toàn tài khoản AWS.

maxActivePerUser không được lớn hơn maxActivePerGroup; giới hạn bytes cũng tương
tự. Kích thước file tối đa còn phải phù hợp giới hạn 10.000 part của ứng dụng.
Giá trị download TTL cũ 120 giây được chặn về 60 giây, không làm startup lỗi chỉ
vì giá trị cũ này. Worker dọn phiên upload có lịch riêng, không phụ thuộc cờ
FILES_CLEANUP_ENABLED của worker xóa file.

MIME cho phép: PDF, TXT, CSV, ZIP, DOC/DOCX, XLS/XLSX, PPT/PPTX, JPEG/PNG/WebP,
MP3/Ogg/WebM audio và MP4/WebM/QuickTime video theo allowlist trong UploadsService.
File rỗng bị từ chối. Client thiếu MIME gửi application/octet-stream và bị từ chối
theo policy hiện tại. MIME khai báo không thay thế quét virus/xác minh toàn bộ
nội dung. Preview local kiểm tra dấu hiệu định dạng đầu file; không phục vụ
HTML/SVG inline.

- Tạo phiên cần thành viên có canUpload hoặc global ADMIN.
- Ký/complete cần chủ phiên hoặc ADMIN và còn quyền upload ở nhóm.
- Chủ phiên đã bị thu hồi membership vẫn được hủy để dọn dữ liệu; tài khoản
  vẫn phải hợp lệ, không bị vô hiệu hóa.
- Client không được tự truyền userId, objectKey, storageId hoặc storageLocationId.
- LOCAL_RECORDING bắt buộc sessionId và session.groupId phải khớp groupId.
- Thu hồi quyền chặn grant mới. URL đã cấp là bearer URL tới hết hạn; không có
  cơ chế thu hồi tức thì mọi URL S3 đã phát hành.
  [Cơ chế presigned URL của S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

## 5. API bàn giao

Base path: `/api/v1`. API điều khiển yêu cầu `Authorization: Bearer <accessToken>`.
Swagger T15/T16: `/api/v1/docs-files`, JSON: `/api/v1/docs-files-json`, khi bật
API_DOCS_ENABLED theo môi trường.

| Mã     | Method và path                     | Request / kết quả                                                                                |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| T16-01 | POST /uploads                      | Metadata → 201 `{uploadId,partSize,totalParts,expiresAt}`                                        |
| T16-02 | POST /uploads/:uploadId/parts/sign | `{partNumbers:[1,2]}` → 200 `{parts:[{partNumber,url,expiresAt}]}`                               |
| T16-03 | POST /uploads/:uploadId/complete   | Header Idempotency-Key; `{parts:[{partNumber,etag}]}` → 200 `{uploadId,status:"COMPLETED",file}` |
| T16-04 | DELETE /uploads/:uploadId          | 204 sau hủy; lặp lại sau ABORTED vẫn 204                                                         |
| T16-05 | PUT URL đã ký                      | Binary bytes trực tiếp tới storage → 200 và header ETag                                          |

Ví dụ tạo phiên cho file 10 MiB, ứng dụng mặc định trả 2 part:

```json
{
  "groupId": "<uuid-cua-nhom>",
  "filename": "bai-giang.pdf",
  "folderPath": "Tài liệu/Bài 1",
  "size": 10485760,
  "mimeType": "application/pdf",
  "fingerprint": "10485760:1760000000000:bai-giang.pdf",
  "source": "DOCUMENT"
}
```

Ví dụ fingerprint trên thuộc mốc T16 ban đầu. Client hiện dùng `sha256-tree-v1:<hex>`
đọc toàn bộ nội dung theo T17; không dùng fingerprint metadata cũ để resume.

Giữ ETag đúng như header storage trả về, kể cả dấu nháy. Client gửi đủ parts khi
complete; server đối chiếu storage. Idempotency-Key cần 1–128 ký tự
A–Z/a–z/0–9/_/-. Phạm vi chống tạo file trùng là uploadId bền vững; đổi header key
không tạo thêm file cho một upload đã complete.

**Khác biệt với trường tùy chọn trong Job.xlsx:** CompleteUploadDto hiện chỉ nhận
parts; chưa nhận `checksum`. Toàn vẹn end-to-end được kiểm tra bằng SHA-256 file
gốc và file tải lại trong test. Không coi ETag multipart là checksum toàn file.

API bổ trợ dùng lại thư viện: POST `/files/:id/download-url`,
POST `/files/:id/preview-url`, POST `/files/:id/playback`,
DELETE `/files/:id`; danh sách GET `/groups/:groupId/files`.
Response công khai không lộ objectKey, credentials hoặc storageLocationId.

| HTTP / mã                                     | Khi xảy ra / hướng xử lý                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 400 VALIDATION_ERROR / INVALID_PART_NUMBER    | Metadata, UUID, part không hợp lệ hoặc trường thừa                                         |
| 400 INVALID_IDEMPOTENCY_KEY                   | Thiếu/sai header khi complete                                                              |
| 400 SESSION_REQUIRED / SESSION_GROUP_MISMATCH | LOCAL_RECORDING thiếu buổi học hoặc buổi học khác nhóm                                     |
| 401 UNAUTHENTICATED                           | Đăng nhập/khôi phục phiên trước khi gọi API                                                |
| 403 FORBIDDEN                                 | Sai chủ phiên, mất quyền nhóm hoặc tài khoản không hợp lệ                                  |
| 404 UPLOAD_NOT_FOUND                          | Kiểm tra uploadId/môi trường database                                                      |
| 409 MISSING_PARTS / SIZE_MISMATCH             | Đối chiếu ETag và kích thước parts thật; không công bố file                                |
| 409 UPLOAD_BUSY / UPLOAD_NOT_ACTIVE           | Thao tác khác còn xử lý hoặc phiên đã kết thúc; đọc trạng thái nghiệp vụ trước khi thử lại |
| 409 ALREADY_COMPLETED                         | Muốn xóa file đã lưu thì dùng API thư viện                                                 |
| 410 UPLOAD_EXPIRED                            | Hủy/dọn phiên cũ rồi tạo phiên mới                                                         |
| 413 FILE_TOO_LARGE / 415 UNSUPPORTED_TYPE     | Kiểm tra kích thước/MIME và policy                                                         |
| 429 UPLOAD_QUOTA_EXCEEDED                     | Chờ hoàn tất hoặc hủy phiên giữ chỗ; phiên lỗi còn giữ quota                               |
| 503 STORAGE_UNAVAILABLE / SERVICE_UNAVAILABLE | Kiểm tra cấu hình storage, credentials hoặc kết nối PostgreSQL                             |

Lỗi PUT trực tiếp thuộc storage và không dùng chung JSON error envelope của API.

### Upload thư mục (13/11/2026)

`POST /uploads` nhận thêm `folderPath?` (tối đa 2048 ký tự), mặc định gốc `""`.
Đường dẫn tương đối, dùng `/` giữa các thư mục; `filename` chỉ là tên file.
Picker thư mục đọc `webkitRelativePath`; kéo thả dùng entry API và duyệt các batch
`readEntries` đến hết, giữ thư mục lồng nhau. Mỗi file vẫn tạo phiên riêng và dùng
chung giới hạn 4 file/5 PUT. Thư mục rỗng chưa lưu, giới hạn MIME/kích thước áp dụng từng file.
Đường dẫn được ghép với thư mục đang mở khi thêm vào hàng đợi, lưu vào phiên và copy
sang `LibraryFile` khi complete. Thao tác quản lý/tải ZIP xem T15.

## 6. Dữ liệu và migration

| Thành phần                        | Nội dung                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| upload_sessions                   | Owner/group, metadata file, objectKey, storageId, partSize/totalParts, expiry, status, fileId |
| storage_locations                 | Registry driver + thư mục local hoặc bucket/region; không lưu credentials                     |
| files                             | File chỉ xuất hiện AVAILABLE sau xác minh/commit complete                                     |
| file_object_deletions             | Outbox xóa object, kèm đúng vị trí lưu                                                        |
| operation_token / operation_until | Quyền xử lý tạm thời và mốc hết lease                                                         |

Migration bổ sung:

1. `20261108000200_multipart_uploads`: bảng upload_sessions.
2. `20261108000300_upload_capacity_and_locations`: storage_locations, liên kết
   vị trí cho file/upload/job xóa, cột lease và chỉ mục quota.
3. `20261113000100_file_folders`: `folder_path` trên files/upload_sessions; cần cho bản mới.

Trong phiên triển khai local ngày 08/11/2026, cả hai migration đã được áp dụng
vào database cấu hình của máy phát triển. Đây không phải xác nhận migration
đã chạy trên môi trường của người nhận; dùng `npm run db:status` để kiểm tra.
Không xóa/sửa migration đã áp dụng để hoàn tác tính năng.

### 6.1. Đổi cấu hình và giữ file cũ

`FILES_STORAGE_DRIVER` chọn nơi lưu cho **upload mới**. File cũ được định tuyến
theo storage_location_id riêng; đổi bucket/region/driver không tự đổi nơi đọc file
đã có. Máy chạy API phải còn truy cập được thư mục/bucket cũ và giữ cấu hình ký
local phù hợp. Không có job tự copy dữ liệu hoặc replication giữa các vị trí.

Khi nâng cấp từ bản chưa có registry:

1. Giữ cấu hình storage cũ, chạy migration.
2. Khởi động một lần với cấu hình cũ để đăng ký vị trí và gắn các bản ghi legacy.
3. Xác nhận không còn file/upload thiếu vị trí; chỉ sau đó đổi nơi lưu mới.
4. Khởi động lại và kiểm tra upload mới lẫn download/preview/xóa file cũ.

Nếu legacy upload còn driver khác cấu hình đang khởi động, service chặn bước gắn
vị trí để tránh gán nhầm. Cần quay lại cấu hình cũ và hoàn tất nâng cấp trước.

Nếu muốn **di chuyển cả file cũ** sang S3: cần quy trình riêng để copy đúng key,
kiểm tra size/checksum, rồi cập nhật liên kết vị trí có kiểm soát. Chỉ copy bytes
hoặc đổi .env sẽ không chuyển các liên kết đã lưu. Chưa có lệnh tự động cho việc
này. Local adapter không được nghiệm thu cho mô hình nhiều API instance dùng các
ổ đĩa riêng; registry không thay thế shared storage hay định tuyến media.

## 7. Preview và các điểm nối video

### 7.1. Thư viện /files: nội dung thật

- PDF dùng viewer của trình duyệt; ảnh JPEG/PNG/WebP hiển thị trong dialog.
- MP4/WebM/MOV dùng player có thanh tua đỏ, phát/dừng, âm lượng, toàn màn hình,
  menu tốc độ 0.25×–2× và chọn nguồn chất lượng.
- Mặc định API chỉ cấp **Bản gốc**. Chỉ thêm mức chất lượng khi catalog có output
  thật; frontend không encode file hoặc tự tạo nguồn 360p/720p/1080p.
- Đổi nguồn giữ playhead/tốc độ/trạng thái phát. Khi URL hết hạn và media báo lỗi,
  player xin grant mới, kiểm tra lại quyền rồi khôi phục vị trí.
- Local GET/HEAD hỗ trợ single Range, 206/416; stream giới hạn vùng đọc và đóng
  file handle khi kết thúc hoặc client ngắt.
- Nguồn HLS có sẵn nhánh hls.js/native playback; chưa nghiệm thu S3/CDN end-to-end.

Chi tiết giao thức, phím tắt, catalog và ranh giới T13:
[video-preview-local.md](video-preview-local.md).

### 7.2. /workspace: live preview minh họa

LivePlayer dùng UI kiểu YouTube: khung 16:9, điều khiển nổi trên nền gradient,
thanh tua đỏ, về trực tiếp, menu cài đặt, fullscreen và tự ẩn sau khoảng 2,6 giây.
Menu tốc độ mẫu 0.5×–2×; chất lượng Tự động/1080p/720p là lựa chọn minh họa,
không yêu cầu backend encode và không chứng minh LIVE DVR/ABR đã hoạt động.

Chia sẻ màn hình dùng preview MediaStream cục bộ; tua/tốc độ/chất lượng không áp
dụng cho luồng này. Tạm dừng preview không dừng track capture. Bố cục và menu được
kiểm tra ở desktop, 390 px và 768 px. Phần này độc lập với playback file thật ở
thư viện; không dùng lựa chọn minh họa làm dữ liệu nguồn cho T13.

## 8. Cấu hình S3 khi hạ tầng sẵn sàng

Cấu hình trong **backend/.env** hoặc môi trường deployment:

```dotenv
FILES_STORAGE_DRIVER=s3
FILES_S3_BUCKET=your-private-bucket
FILES_S3_REGION=ap-southeast-1
FILES_DOWNLOAD_TTL_SECONDS=60

# Chỉ điền khi dùng credentials qua biến môi trường:
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
# Credentials tạm thời còn cần AWS_SESSION_TOKEN.
```

Code đọc bucket/region bằng **FILES_S3_BUCKET / FILES_S3_REGION**.
`AWS_BUCKET_NAME` không được đọc; `AWS_REGION` không thay thế region đã được
truyền rõ từ FILES_S3_REGION vào S3Client. Không đưa các biến bí mật sang
frontend/.env.local hoặc NEXT_PUBLIC_*.

Backend dùng default credential chain của AWS SDK: env, profile hoặc role,
bao gồm IAM role của EC2. Khi dùng role hợp lệ không cần lưu access key tĩnh
trong .env. [AWS SDK credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).

Các file hạ tầng bàn giao, chưa áp dụng lên tài khoản AWS:

| File                                                          | Cần cấu hình                                            |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| [uploads-iam.json](../infra/aws/uploads-iam.json)             | Thay REPLACE_BUCKET; quyền runtime trên groups/*        |
| [uploads-cors.json](../infra/aws/uploads-cors.json)           | AllowedOrigins đúng frontend; PUT/GET/HEAD; expose ETag |
| [uploads-lifecycle.json](../infra/aws/uploads-lifecycle.json) | Abort multipart chưa hoàn tất sau 2 ngày dưới groups/   |

Policy mẫu có PutObject, GetObject, DeleteObject, AbortMultipartUpload,
ListMultipartUploadParts; giữ thêm policy T15 cho key ngoài groups/ nếu đang dùng.
Cấu hình bucket riêng tư, chặn public access và mã hóa phù hợp policy; SSE-KMS cần
quyền KMS tương ứng. CORS không thay thế quyền IAM. Các lệnh `put-bucket-cors` và
`put-bucket-lifecycle-configuration` ghi lại cấu hình tương ứng; gộp với rule hiện
có trước khi áp dụng trên bucket đang sử dụng.

SDK thực hiện CreateMultipartUpload → UploadPart presign → ListParts có phân
trang → CompleteMultipartUpload → HeadObject hoặc AbortMultipartUpload. Các URL
part có hạn tối đa 60 giây theo policy ứng dụng.
[Giới hạn multipart S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html).

Cần kiểm thử trên AWS trước khi nghiệm thu: file nhỏ/lớn, checksum tải lại,
CORS/ETag, quota, quyền chéo nhóm, thiếu part, complete retry, abort, expiry và
job dọn. Local adapter không kiểm chứng IAM, bucket policy, độ trễ mạng hoặc chi phí S3.

### 8.1. CDN_BASE_URL

`CDN_BASE_URL` **chưa được code đọc**, không cần cho upload S3 hiện tại.
Upload vẫn đi trực tiếp S3; download/preview hiện dùng presigned GetObject.

Khi nối CloudFront, địa chỉ CDN dùng cho luồng xem/tải. Nội dung riêng tư cần
cơ chế cấp quyền ở CDN và truy cập origin phù hợp; không chỉ đổi domain trong
S3 URL đã ký. HLS cần cấp quyền cả master, playlist con và segments.
[CloudFront private content](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PrivateContent.html).

Chưa bật Transfer Acceleration, tạo CloudFront distribution, encoder AWS hoặc
dịch vụ cloud bổ sung trong đợt T16 local này.

## 9. File chính để người nhận tiếp tục làm việc

| File / thư mục                                                   | Vai trò                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| frontend/src/components/files/file-uploader.tsx                  | Hàng đợi 4 file, popup, hủy, thử complete lại                 |
| frontend/src/lib/files/upload.ts                                 | Cắt file, batch ký URL, limiter chung 5 PUT, progress/ETag    |
| frontend/src/components/files/files-panel.tsx                    | Thư viện, mở preview, làm mới sau upload                      |
| frontend/src/components/files/video-preview.tsx                  | Lấy playback, nguồn gốc/renditions/HLS và refresh grant       |
| frontend/src/components/files/video-player-controls.tsx          | Điều khiển video thật, tốc độ và chọn chất lượng              |
| frontend/src/components/live-player.tsx / live-player.module.css | Live preview workspace, CSS giới hạn trong component          |
| backend/src/modules/uploads/                                     | DTO, controller, điều phối lease/quota, local và S3 multipart |
| backend/src/modules/files/storage-locations.service.ts           | Registry vị trí và gắn dữ liệu legacy                         |
| backend/src/modules/files/file-storage.service.ts                | Cấp link/đọc/xóa đúng vị trí local hoặc S3                    |
| backend/src/modules/files/video-rendition-catalog.ts             | Interface catalog cho T13; mặc định source-only               |
| backend/src/modules/files/video-playback.service.ts              | Playback response và ký nguồn được công bố                    |
| backend/src/modules/files/file-cleanup.service.ts                | Outbox xóa nội dung của thư viện                              |
| backend/src/config/environment.ts                                | Tên biến và validation cấu hình                               |
| backend/src/database/prisma.service.ts                           | Pool và timeout database dùng chung                           |
| backend/prisma/schema.prisma và migrations/                      | Schema cùng hai migration T16                                 |
| backend/infra/aws/                                               | IAM, CORS, lifecycle mẫu                                      |
| backend/test/integration/uploads.test.cjs                        | Kiểm thử policy, checksum, quota, khóa, phục hồi và vị trí    |

Đường dẫn trong bảng tính từ gốc repository. Shared contracts phần thư viện/video
ở backend/contracts/src/files.ts. Public response dùng presenter rõ trường, không
lan truyền các cột storage nội bộ sang frontend.

## 10. Kiểm thử và bằng chứng nghiệm thu

### 10.1. Chạy lại

Integration/UI tạo database `streamora_test_*` tạm rồi xóa đúng database đó.
Tài khoản kết nối cần CREATEDB. Nếu database nhóm không có quyền này, dùng một
PostgreSQL kiểm thử riêng; không đổi .env chung chỉ để chạy fixture.

Ví dụ trong terminal PowerShell riêng, thay địa chỉ bằng PostgreSQL kiểm thử:

```powershell
$env:DATABASE_URL='postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/TEST_DB'
npm run test:t16
npm run test:t16:frontend
npm run test:video-preview
npm run test:t15
npm run typecheck
```

Mỗi script test tương ứng build API trước. Browser test dùng Playwright, mặc định
Edge trên Windows; cần có browser phù hợp. Với bài file lớn, bảo đảm đủ đĩa cho
parts, file ghép, bản xuất bản và file đọc đối chiếu:

```powershell
npm run test:t16:large
```

Các kiểm thử sâu về schema/timeout và lỗi dùng chung có thể chạy sau khi build:

```powershell
node --test --test-concurrency=1 backend/test/integration/database.test.cjs backend/test/integration/common.test.cjs
```

Lượt chạy hiện tại ngày 13/11/2026: [báo cáo kiểm thử T15–T17](t15-t17-verification.md).
Các số liệu ở mục kế tiếp là kết quả lịch sử, không phải lượt chạy mới.

### 10.2. Kết quả đã ghi nhận ngày 08/11/2026

| Nhóm kiểm tra                                           | Kết quả / giới hạn bằng chứng                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit backend ở đợt tối ưu                               | 54/54 qua                                                                                                                                             |
| Integration files + uploads sau tối ưu                  | 14/14 qua, gồm bảy create đồng thời chỉ bốn thành công, quota nhóm/bytes, khóa ngắn, thu hồi quyền và vị trí cũ                                       |
| Integration schema/database sau cập nhật danh sách bảng | 6/6 qua; query quá lâu bị ngắt, query tiếp theo chạy được                                                                                             |
| Browser upload và video file                            | 2/2 qua: checksum, hủy, nhiều file, popup tự ẩn, PDF/ảnh, video thật, quality/speed và expiry                                                         |
| Typecheck frontend sau đổi UI workspace                 | Qua                                                                                                                                                   |
| Workspace live preview                                  | Kiểm tra thao tác bằng Playwright: settings, phím tắt, fullscreen, tự ẩn, 390/768 px, capture giả lập vẫn sống khi pause preview; không có page error |
| Hệ thống local chính 3000/4000                          | Đã chạy upload → preview → SHA-256 → xóa → worker dọn nội dung; dữ liệu thử được dọn                                                                  |
| File 40 MiB + 19 byte với limiter 5 PUT                 | Tải lại đúng SHA-256; 6 part                                                                                                                          |
| File 1 GiB, 128 part                                    | Test lịch sử dùng 3 worker, SHA-256 đúng; cả ca roundtrip khoảng 38 giây                                                                              |
| S3/CloudFront/encode AWS                                | Chưa kiểm thử end-to-end                                                                                                                              |

Không dùng kết quả 1 GiB/3 worker để tuyên bố benchmark của cấu hình hiện tại
4 file/5 PUT hoặc throughput trên AWS. Script large hiện dùng concurrency 5 và
cần chạy lại trên môi trường đích. Kiểm tra workspace là đợt thao tác riêng;
chưa thêm bài workspace UI vào bộ test repository.

Đợt regression rộng auth/nhóm/quyền/file có **53/54 qua**: ca T02 so tên nhóm tiếng
Việt không phân biệt hoa/thường thất bại trên database kiểm thử locale C
(`lower('TOÁN') <> lower('Toán')`). Code tên nhóm/chỉ mục của T02 không sửa trong
đợt này. Không ghi nhận toàn bộ regression xanh; cần kiểm tra T02 trên locale
Unicode phù hợp. Log .preview chỉ là bằng chứng ở máy phát triển, không phải
thành phần cần thiết để chạy repository.

### 10.3. Kịch bản demo ngắn cho người nhận

1. Đăng nhập, chọn nhóm có quyền upload; mở /files.
2. Chọn ít nhất 5 file để thấy tối đa 4 file xử lý và file còn lại chờ.
3. Theo dõi progress, hủy một file; file khác vẫn hoàn tất.
4. Kiểm tra chỉ sau complete mới báo 100%/thành công; popup tự ẩn sau 5 giây.
5. Mở PDF, ảnh và video; video file chỉ có bản gốc khi chưa nối encoder.
6. Tải file hoàn tất và đối chiếu SHA-256 bằng Get-FileHash.
7. Xóa file thử và đợi worker dọn; không xóa trực tiếp thư mục storage khi API chạy.
8. Mở /workspace để xem UI live preview; xác nhận đây là minh họa khác với
   video thật vừa upload.

## 11. Vận hành và xử lý lỗi

| Triệu chứng                        | Kiểm tra                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| UI báo dịch vụ chưa sẵn sàng       | API 4000, DATABASE_URL, migration; đọc requestId/mã lỗi                              |
| File không bắt đầu hoặc 429        | Phiên cũ đang giữ quota; hủy/chờ worker dọn, không chỉ đóng popup                    |
| PUT local lỗi kết nối              | 4002 có bị chiếm không; listener bind loopback; kiểm tra bước ký part và thư mục/đĩa |
| S3 PUT xong nhưng UI không có ETag | CORS expose ETag và origin frontend đúng                                             |
| URL PUT lỗi chữ ký/hết hạn         | Ký URL mới qua API; kiểm tra đồng hồ, region, credentials và headers; không sửa URL  |
| Complete thiếu part/sai size       | ListParts thực tế, số part, thứ tự/ETag và phần cuối                                 |
| Complete phản hồi bị mất           | Dùng Thử hoàn tất lại khi payload còn trong bộ nhớ; không tạo phiên mới ngay         |
| Video không phát                   | Codec/container thực tế, grant còn hạn, Range/CORS; vẫn cho tải file xuống           |
| Đổi cấu hình rồi file cũ lỗi       | storage_location_id, quyền truy cập vị trí cũ, volume local và khóa ký               |
| file_cleanup_retry                 | Quyền xóa, đường dẫn/bucket, kết nối storage; job chưa hoàn tất vẫn được giữ         |
| CONNECTION_TIMEOUT                 | Kết nối mạng/PostgreSQL; không kết luận là lỗi MIME hoặc uploader                    |

Log chẩn đoán giới hạn ở event/requestId/fileId/uploadId và mã lỗi; không ghi
connection string, signed URL, khóa AWS hoặc exception nguyên bản.

Pool database dùng chung tối đa 10 kết nối, chờ kết nối 5 giây; statement_timeout
12 giây, query read timeout 15 giây, idle transaction timeout 30 giây. Kết nối có
TCP keepalive và max lifetime 5 phút, được tái tạo khi có thể trả về pool. Các
transaction T16 có timeout 10 giây, maxWait 5 giây; storage I/O ở ngoài transaction.
Đây là thay đổi dùng chung qua PrismaService, không chỉ áp dụng cho upload.

Đã quan sát pg và Prisma trực tiếp cùng timeout rồi phục hồi; khi kết nối được,
quyền SELECT/UPDATE cleanup hợp lệ và không thấy idle transaction/chờ khóa.
Log API ghi CONNECTION_TIMEOUT. **Chưa xác định nguyên nhân mạng/server cụ thể
và chưa chứng minh hết timeout**; các giới hạn chờ giúp tránh chờ vô hạn, không
thay thế việc vận hành PostgreSQL.

Các trường hợp còn cần dọn bổ sung: crash sau CreateMultipartUpload trước khi
lưu được UploadId; crash sau commit file trước khi dọn parts COMPLETED; file
tạm phát sinh khi tiến trình dừng đột ngột. S3 lifecycle và phần quét orphan T17
là lớp bổ sung. Với S3 Versioning, DeleteObject không đồng nghĩa xóa mọi phiên
bản; cần chính sách retention riêng.

## 12. Điểm nối và việc còn lại

| Phần nhận tiếp      | Việc cần làm                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| T10 ghi cục bộ      | Dùng uploadFile với source=LOCAL_RECORDING, sessionId; giữ file tải cục bộ khi upload lỗi; không tạo API media khác                            |
| T11 ghi cloud       | Dùng registerRecording/recording_assets và vị trí storage đúng; giữ file_usages khi có tham chiếu                                              |
| T13 encode AWS      | Thay SourceOnlyVideoCatalog bằng provider đọc output/trạng thái bền vững; publish khi output thật sẵn sàng; xử lý event, retry/DLQ/idempotency |
| T14 CDN/multi cloud | Cấp quyền phân phối, CDN_BASE_URL/signed URL/cookie, HLS toàn cây, replication và routing; registry hiện chỉ hỗ trợ local/S3                   |
| T17 resume          | IndexedDB, API status đối chiếu ListParts, xác minh file, retry/backoff, ký lại parts thiếu và quét orphan                                     |
| T20 nghiệm thu tải  | Chốt ngưỡng, benchmark 4 file/5 PUT trên môi trường đích, đo API riêng với băng thông storage                                                  |

Trước khi chuyển giao nhánh: kiểm tra git status và đưa đủ các file mới
(untracked), module, migrations, frontend player/uploader, tests, cấu hình mẫu và
tài liệu vào commit theo quy trình nhóm. Không commit .env thật, storage local
hoặc .preview. Không cần reset database để nhận T16; dùng migrate deploy.

Nếu quay về binary cũ, phải xét schema/trạng thái upload mới trước khi chạy;
bản cũ không hiểu INITIALIZING/COMPLETING/ABORTING. Việc đổi driver cũng không
thay thế migration dữ liệu hoặc kế hoạch rollback.
