# T15 — Bàn giao thư viện nhóm và triển khai S3

Ngày cập nhật: 13/11/2026. Tài liệu mô tả code hiện có trong repository và các bước
triển khai tiếp theo. S3 chưa được tạo hay kiểm thử trên tài khoản AWS trong lần
bàn giao này; môi trường phát triển hiện dùng local. Không có mật khẩu hoặc khóa AWS
thật trong tài liệu.

Lượt cập nhật local ngày 13/11/2026 bổ sung thư mục, tải ZIP và tìm kiếm file trong
thư mục con. Kết quả chạy lại được ghi tại [báo cáo kiểm thử T15–T17](t15-t17-verification.md).
Không suy ra trạng thái triển khai EC2/S3 từ kết quả local.

## 1. Phạm vi bàn giao

| Hạng mục                                            | Trạng thái                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| Danh sách, tìm tên, lọc tài liệu/video, phân trang  | Đã dùng PostgreSQL/API thật                                              |
| Xem chi tiết, đổi tên, xóa theo quyền nhóm          | Đã triển khai                                                            |
| Tải file qua liên kết ngắn hạn                      | Đã triển khai cho local và có adapter S3                                 |
| Thư mục lồng nhau, tải ZIP, đổi tên/xóa toàn bộ cây | Đã triển khai; thư mục thuộc bộ lọc Tài liệu                             |
| Tìm kiếm file trong thư mục và thư mục con          | Trả file cụ thể, không trả dòng thư mục                                  |
| Xem trước PDF, JPEG/PNG/WebP, video tương thích     | Đã triển khai; PDF dùng viewer trình duyệt, ảnh/video có giao diện riêng |
| Nhập file hoặc toàn bộ thư mục để thử local         | Đã có lệnh nội bộ                                                        |
| Xóa mềm và dọn nội dung nền, retry khi lỗi          | Đã triển khai                                                            |
| Giao diện thư viện tinh gọn                         | Đã bỏ banner giới thiệu và ô tìm kiếm không gian ở thanh bên             |
| Upload S3 trực tiếp, multipart                      | Đã bổ sung tại [T16](t16-handoff.md); resume sau reload thuộc T17        |
| Chuyển dữ liệu local lên S3 tự động                 | Chưa có công cụ tự động                                                  |
| Pipeline ghi hình T11 và xử lý video                | Chỉ có điểm tích hợp nội bộ; chưa phải pipeline hoàn chỉnh               |

T15 không phụ thuộc T19. Hướng dẫn dưới đây chỉ cần S3 cho phần lưu nội dung;
không yêu cầu tạo thêm CDN, hàng đợi hoặc dịch vụ xử lý video.

## 2. Cách tổ chức dữ liệu và quyền

PostgreSQL lưu metadata; nội dung file nằm tại ổ đĩa backend hoặc S3.

| Thành phần              | Vai trò                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `files`                 | Tên hiển thị, folder_path, kích thước, MIME, nhóm, người tạo, trạng thái, object key |
| `recording_assets`      | Registry tối thiểu để xác minh recording thuộc buổi học                              |
| `file_usages`           | Giữ tham chiếu để chặn xóa file đang được sử dụng                                    |
| `file_object_deletions` | Hàng đợi bền vững để xóa nội dung sau khi xóa mềm                                    |

Trạng thái file: `PENDING` → `AVAILABLE` → `DELETED`. Chỉ `AVAILABLE` được cấp link
tải/xem trước. Danh sách không trả file `DELETED`.

- Thành viên nhóm được xem danh sách, chi tiết và xin link tải.
- Người tạo được đổi tên/xóa file của mình khi còn quyền truy cập nhóm.
- HOST/OWNER của nhóm và global ADMIN có quyền quản lý theo guard T03.
- ADMIN có thể truy cập theo quyền quản trị toàn hệ thống; người ngoài nhóm thông
  thường bị từ chối.
- Không xóa file `PENDING`, file còn `recordingId` hoặc còn `file_usages`.
- Đổi tên chỉ sửa tên hiển thị, không đổi `objectKey`.

Từ bản [T16](t16-handoff.md), `FILES_STORAGE_DRIVER` chọn vị trí cho upload mới;
file, phiên upload và job xóa giữ `storage_location_id` riêng. Registry lưu driver
và bucket/region hoặc thư mục local, nên đổi cấu hình không tự chuyển nơi đọc file
cũ. Khi nâng cấp phải khởi động một lần với cấu hình cũ để gắn dữ liệu legacy;
chi tiết ở mục 6 tài liệu T16. Local adapter chưa được nghiệm thu cho nhiều API
instance dùng ổ đĩa riêng; các vị trí cũ vẫn phải truy cập được.

Worker chạy mỗi 30 giây, xử lý tối đa 20 job mỗi lượt; có khóa nhận job và retry.
Xóa khỏi giao diện xảy ra trước khi nội dung được dọn. Khi bật S3 Versioning,
`DeleteObject` thông thường tạo delete marker; phiên bản cũ cần chính sách lưu giữ
riêng, không được xem là đã xóa vĩnh viễn mọi phiên bản.
[Hành vi xóa khi có Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html).

## 3. Chạy local và nhập dữ liệu thử

Yêu cầu Node.js/npm theo `package.json`, PostgreSQL và cấu hình auth/database của
dự án. Máy mới chạy từ gốc repository:

```powershell
npm ci
npm run setup:env
```

Điền `DATABASE_URL` thật trong `backend/.env`, giữ các khóa auth đã cấu hình.
Đặt cấu hình lưu trữ:

```dotenv
FILES_STORAGE_DRIVER=local
FILES_LOCAL_DIRECTORY=.local-storage/files
FILES_PUBLIC_BASE_URL=http://127.0.0.1:4000
FILES_DOWNLOAD_TTL_SECONDS=60
FILES_CLEANUP_ENABLED=true
```

`FILES_LOCAL_DIRECTORY` tương đối với thư mục `backend`. Với cấu hình trên,
nội dung nằm trong `backend/.local-storage/files/<objectKey>`; file nhập thường có
key `local/<UUID>`, không dùng tên hiển thị làm tên lưu trữ. Vùng này được Git bỏ qua.
File gốc ở thư mục người dùng không bị sửa. `FILES_PUBLIC_BASE_URL` là origin API,
không thêm `/api/v1` hoặc dấu `/` cuối.

```powershell
npm run db:migrate
npm run db:status
npm run dev:api
```

Mở terminal khác ở gốc dự án:

```powershell
npm run dev
```

API mặc định `http://127.0.0.1:4000`, web `http://127.0.0.1:3000`.
Frontend dùng `NEXT_PUBLIC_API_URL=http://127.0.0.1:4000/api/v1` trong
`frontend/.env.local`. Nếu truy cập từ máy khác, thay loopback bằng địa chỉ thực tế
và chỉnh `WEB_ORIGIN` cho khớp origin frontend.

Ví dụ nhóm dùng trong quá trình phát triển; thay ID/email nếu bàn giao sang DB khác:

```powershell
npm run files:import -- --group d1942c68-6365-454a-8120-54715241c1b9 --email "admin@streamora.io" --path "D:\TaiLieu\bai-giang.pdf"
```

Nhập cả thư mục, bao gồm thư mục con:

```powershell
npm run files:import -- --group d1942c68-6365-454a-8120-54715241c1b9 --email "admin@streamora.io" --folder "D:\TaiLieu"
```

Mở `/files?groupId=d1942c68-6365-454a-8120-54715241c1b9`, bấm **Làm mới**.
Tài khoản chỉ định phải tồn tại và có quyền upload trong nhóm. Nhập lại tạo mục mới;
chưa tự chống trùng. Lệnh nhập chỉ chạy khi driver là `local`.
Các tùy chọn `--name`, `--no-recursive`, nhập bản ghi local và giới hạn của công cụ
được ghi trong [hướng dẫn local](t15-local.md).

Migration T15: `prisma/migrations/20261108000100_file_library/migration.sql`.
Database cần hỗ trợ extension `pg_trgm`. Giữ nguyên migration đã áp dụng; không dùng
reset database để triển khai T15.

## 4. API và cách frontend sử dụng

Base URL local: `http://127.0.0.1:4000/api/v1`.
Tất cả API thư viện trong bảng yêu cầu:

```http
Authorization: Bearer <accessToken>
```

| Method | Path sau `/api/v1`                        | Đầu vào/kết quả                                                                      |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/groups/:groupId/files`                  | Query `folderPath`, `q`, `type`, `limit`, `cursor`; trả `{items,folders,nextCursor}` |
| GET    | `/files/:fileId`                          | Trả `{file}`                                                                         |
| PATCH  | `/files/:fileId`                          | JSON `{"name":"Tên mới.pdf"}`; trả `{file}`                                          |
| DELETE | `/files/:fileId`                          | Xóa mềm và tạo job dọn nội dung; trả 204, không có body                              |
| POST   | `/files/:fileId/download-url`             | Không cần body; trả `{url,expiresAt}`                                                |
| POST   | `/files/:fileId/preview-url`              | PDF/ảnh/video tương thích; trả `{url,expiresAt}`                                     |
| POST   | `/files/:fileId/playback`                 | Nguồn phát video có thật và trạng thái xử lý                                         |
| PATCH  | `/groups/:groupId/files/folders`          | `{folderPath,name}`; đổi tên cây thư mục, trả 204                                    |
| DELETE | `/groups/:groupId/files/folders`          | `{folderPath}`; xóa cây thư mục, trả 204                                             |
| POST   | `/groups/:groupId/files/folders/download` | `{folderPath}`; trả binary `application/zip`, cần Bearer token                       |

`q` tìm tên không phân biệt hoa/thường, vẫn phân biệt dấu; `type` là `document`
hoặc `video`. Hiện `document` bao gồm MIME không bắt đầu bằng `video/`.
`limit` mặc định 20, từ 1 đến 100. Thứ tự là `createdAt DESC, id DESC`.
Khi dùng `nextCursor`, giữ nguyên nhóm, `folderPath`, `q` và `type`; đổi bộ lọc phải bỏ cursor cũ.
Alias `GET /files?groupId=...` được giữ để tương thích, không phải đường dẫn khuyến nghị.

Thử bằng PowerShell với token lấy từ phiên đăng nhập:

```powershell
$apiBase = "http://127.0.0.1:4000/api/v1"
$accessToken = "<accessToken>"
$headers = @{ Authorization = "Bearer $accessToken" }
$groupId = "d1942c68-6365-454a-8120-54715241c1b9"
$page = Invoke-RestMethod -Uri "$apiBase/groups/$groupId/files?limit=20" -Headers $headers
$page.items | Select-Object id, name, mimeType, status

# Chọn đúng ID từ kết quả phía trên.
$fileId = "<fileId>"
$download = Invoke-RestMethod -Method Post -Uri "$apiBase/files/$fileId/download-url" -Headers $headers
Start-Process -FilePath $download.url
```

Phản hồi cấp link có dạng dưới đây; đây là giá trị minh họa:

```json
{
  "url": "https://<signed-file-url>",
  "expiresAt": "2026-11-08T10:02:00.000Z"
}
```

Frontend gọi backend để kiểm tra quyền rồi mở `url`. Với S3, trình duyệt tải trực
tiếp từ S3; không gửi Bearer token Streamora tới S3. Với PDF, frontend gắn link
preview vào iframe. Không cần sửa frontend khi đổi driver.

PDF phải có metadata `mimeType=application/pdf`. Local còn kiểm tra đầu nội dung
`%PDF-`; adapter S3 hiện không đọc nội dung để kiểm tra chữ ký PDF trước khi ký URL.
Giao diện hỗ trợ preview PDF, JPEG/PNG/WebP và video tương thích; video dùng route
playback. Không suy ra định dạng chỉ từ tên file.

| HTTP/code                                                   | Ý nghĩa                                        |
| ----------------------------------------------------------- | ---------------------------------------------- |
| 400 `VALIDATION_ERROR` / `INVALID_CURSOR`                   | Đầu vào hoặc cursor không hợp lệ               |
| 401 `UNAUTHENTICATED`                                       | Chưa đăng nhập/token không hợp lệ              |
| 403 `FORBIDDEN`                                             | Không đủ quyền                                 |
| 404 `GROUP_NOT_FOUND` / `FILE_NOT_FOUND`                    | Nhóm/file không tồn tại hoặc đã bị xóa         |
| 409 `FILE_NOT_READY`                                        | File chưa AVAILABLE                            |
| 409 `FILE_IN_USE`                                           | Chưa thể xóa do upload/tham chiếu/recording    |
| 415 `PDF_PREVIEW_UNSUPPORTED` / `VIDEO_PREVIEW_UNSUPPORTED` | Định dạng preview không được hỗ trợ            |
| 503 `STORAGE_UNAVAILABLE`                                   | Thiếu cấu hình bucket hoặc không cấp được link |

Swagger: `/api/v1/docs-files`; OpenAPI JSON: `/api/v1/docs-files-json`.
Đặt `API_DOCS_ENABLED=true` để mở tài liệu; production mặc định tắt.

### Thư mục và tìm kiếm (13/11/2026)

- Migration `20261113000100_file_folders` thêm `folder_path` vào `files` và
  `upload_sessions`; mặc định chuỗi rỗng cho file ở gốc. Chạy migration trước API mới.
- Thư mục được suy ra từ đường dẫn các file còn tồn tại. Chưa lưu thư mục rỗng,
  chưa có thao tác tạo thư mục rỗng hoặc di chuyển file trên giao diện.
- Không nhập `q`: liệt kê file trực tiếp trong `folderPath` cùng thư mục con trực tiếp.
  Thư mục chỉ xuất hiện ở **Tất cả/Tài liệu**, không thuộc **Video và bản ghi**.
- Có `q`: tìm theo tên file trong thư mục hiện tại và toàn bộ cây con. Ở gốc,
  tìm toàn nhóm; kết quả chỉ có file và kèm đường dẫn, `folders=[]`. Bộ lọc MIME vẫn áp dụng.
- Nút **Chọn tải lên** mở **Chọn file/Chọn thư mục**; kéo thả làm nổi bật vùng nhận.
  Bảng không có dòng dữ liệu chỉ hiển thị thông báo trống, không hiện tiêu đề lệch cột.
- Đổi tên sửa `folder_path` của mọi file con, giữ objectKey. Chặn trùng tên/đường dẫn
  quá dài; không trộn hai cây thư mục.
- Đổi tên/xóa yêu cầu quyền quản lý toàn bộ file bên trong: chủ file hoặc canHost.
  Xóa có xác nhận, chặn file PENDING/recording/tham chiếu và phiên upload đang hoạt động.
  Toàn bộ thay đổi metadata và job xóa được commit cùng transaction; bytes dọn ngoài transaction.
- Tải thư mục trả ZIP qua API có xác thực (thư viện `archiver`), giữ đường dẫn con,
  xử lý tên trùng. Backend stream từng file từ vị trí lưu; frontend nhận Blob rồi lưu
  `<tên thư mục>.zip`. ZIP rất lớn vẫn chịu giới hạn bộ nhớ/đĩa và thời gian chờ trình duyệt
  (request hiện tối đa 10 phút); chưa nghiệm thu ZIP lớn qua EC2/S3.
- Lỗi bổ sung: 404 `FOLDER_NOT_FOUND`, 409 `FOLDER_EXISTS`/`FOLDER_BUSY`;
  file chưa sẵn sàng/đang dùng và lỗi quyền dùng mã lỗi file/nhóm hiện có.

Khi chạy local, xác nhận `DATABASE_URL` thực sự trỏ database phát triển. Chạy web/API
trên máy không đồng nghĩa database local. Không reset database đang dùng khi gặp lỗi thiếu
cột; kiểm tra migration và đúng môi trường trước. Không tự áp migration vào EC2 từ lượt kiểm thử.

## 5. Tạo bucket S3 bằng AWS Management Console

Các bước này là hướng dẫn triển khai khi nhóm quyết định dùng S3, không phải thay
đổi đã được thực hiện. Dùng bucket general purpose, cùng tài khoản với quyền backend.

1. Đăng nhập [AWS S3 Console](https://console.aws.amazon.com/s3/), chọn **Create bucket**.
2. Chọn **General purpose**, region **Asia Pacific (Singapore) — ap-southeast-1**
   nếu nhóm muốn dùng Singapore.
3. Nhập **streamora-storage**. Với namespace dùng chung, tên phải chưa có người
   khác sử dụng; nếu bị trùng thì cần tên khác và cập nhật cấu hình tương ứng.
4. **Object Ownership**: chọn **ACLs disabled / Bucket owner enforced**.
5. Giữ **Block all public access** bật.
6. **Default encryption**: chọn **SSE-S3** để phù hợp policy đơn giản bên dưới.
7. Với môi trường thử mới, có thể để **Bucket Versioning: Disable**. Bucket đã có
   versioning cần thống nhất retention phiên bản cũ; worker hiện không xóa version cụ thể.
8. Chọn **Create bucket**. Tên và region không thể đổi sau khi tạo.

Tham khảo [tạo bucket và các thiết lập](https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html)
và [chặn truy cập public](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html).

Không cần bật static website hosting hay cho phép đọc public. Link presigned cho
phép truy cập tạm thời theo quyền của bên ký.
[Cơ chế presigned URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
cũng có nghĩa người giữ link còn hạn có thể sử dụng nó; thu hồi membership chặn
cấp link mới, không lập tức thu hồi mọi link đã cấp. Credentials tạm hết hạn có
thể làm link hết hạn sớm hơn TTL cấu hình.

## 6. Cấp quyền AWS cho backend

Trong **IAM → Policies → Create policy → JSON**, tạo policy, ví dụ
`StreamoraT15Storage`, với nội dung:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "T15ReadAndDeleteObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::streamora-storage/*"
    }
  ]
}
```

Gắn policy vào IAM role/user thực sự chạy backend bằng **Permissions → Add
permissions → Attach policies**. Đây là quyền chạy T15, không phải quyền tạo
bucket hoặc upload dữ liệu bàn giao. Tài khoản thực hiện tạo/copy trên Console
cần quyền quản trị/upload tương ứng riêng.
[Quyền và resource S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-policy-language-overview.html).

Policy giả định cùng tài khoản, SSE-S3 và không có explicit deny từ bucket,
organization hoặc các lớp quyền khác. Nếu dùng SSE-KMS cần cấu hình thêm quyền
KMS phù hợp; policy này chưa bao phủ trường hợp đó.

Chọn cách xác thực phù hợp:

- **Backend trên AWS:** gắn IAM role vào EC2 instance hoặc ECS task chạy backend.
  Code tự lấy credentials; không cần chép access key vào `.env`.
- **Máy phát triển:** dùng AWS profile đã cấu hình (ví dụ `AWS_PROFILE=streamora-dev`)
  và đăng nhập profile nếu cần; hoặc credentials môi trường ở ví dụ dưới.
- **Nếu dùng IAM user để thử local:** trong IAM chọn user dành cho ứng dụng,
  gắn policy trên; **Security credentials → Access keys → Create access key**,
  chọn trường hợp sử dụng phù hợp và lưu credentials ở backend.
  [Tạo access key bằng Console](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-key-self-managed.html).

Ví dụ biến môi trường; các giá trị trong ngoặc là placeholder, không phải khóa thật:

```dotenv
AWS_ACCESS_KEY_ID=<access-key-id>
AWS_SECRET_ACCESS_KEY=<secret-access-key>
# Chỉ thêm dòng dưới nếu bộ credentials là credentials tạm thời:
# AWS_SESSION_TOKEN=<session-token>
```

Email/mật khẩu AWS Console không thay thế credentials API. Không đặt khóa vào
frontend, biến `NEXT_PUBLIC_*` hoặc commit Git. SDK hiện dùng default credential
provider chain; credentials từ môi trường có thể ưu tiên hơn profile/role. Khi
đổi phương thức, bỏ credentials cũ khỏi môi trường chạy.
[Cách AWS SDK Node.js tìm credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).

## 7. CORS và chuẩn bị cho T16/T17

Luồng T15 hiện mở link tải/iframe PDF trực tiếp, không dùng JavaScript fetch đọc
nội dung S3. Nếu cần trình duyệt đọc response hoặc chuẩn bị upload trực tiếp sau
này, vào bucket → **Permissions → Cross-origin resource sharing (CORS) → Edit**:

```json
[
  {
    "AllowedOrigins": ["http://127.0.0.1:3000", "http://localhost:3000"],
    "AllowedMethods": ["GET", "HEAD", "PUT", "POST"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Disposition"],
    "MaxAgeSeconds": 3600
  }
]
```

Thay/thêm origin HTTPS thật khi deploy. Không thêm `OPTIONS` vào AllowedMethods;
S3 xử lý preflight. CORS không cấp quyền IAM hoặc làm bucket thành public.
[Cấu hình CORS của S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html).

Để chuẩn bị multipart, có thể vào **Management → Create lifecycle rule**, đặt tên
`abort-incomplete-uploads`, áp dụng toàn bucket, chọn dọn incomplete multipart
uploads sau **7 ngày**. Không chọn hết hạn toàn bộ object đang sử dụng.
Rule chỉ dọn phần upload dở, không xóa object upload hoàn chỉnh.
[Hướng dẫn lifecycle multipart](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html).

CORS/lifecycle cần đi cùng API upload. [T16](t16-handoff.md) đã bổ sung khởi tạo,
ký part, complete/abort và xác minh trước khi tạo file AVAILABLE. Resume thuộc T17.
Policy T15 ở mục 6 chỉ dành cho thư viện; quyền upload/multipart bổ sung nằm trong
`backend/infra/aws/uploads-iam.json`.

## 8. Chuyển dữ liệu local lên S3 và đổi cấu hình

**Lưu ý khi đã nhận T16:** các bước bên dưới mô tả việc chép nội dung của T15.
T16 định tuyến file theo `storage_location_id`; giữ nguyên objectKey rồi đổi .env
không tự chuyển liên kết file cũ sang S3. Cần quy trình xác minh dữ liệu và cập nhật
liên kết vị trí có kiểm soát; chưa có công cụ tự động. Nếu chỉ muốn upload mới vào
S3 và tiếp tục đọc local cũ, làm theo mục 6 và 8 của [bàn giao T16](t16-handoff.md).

### 8.1. Chuẩn bị và chốt dữ liệu

1. Sao lưu PostgreSQL và thư mục local. Ghi lại driver/bucket/region đang dùng.
2. Tạm dừng thao tác thay đổi dữ liệu từ web, lệnh import và các worker ghi file.
   Giữ API local chạy để worker dọn hết job xóa còn tồn tại.
3. Chạy các truy vấn chỉ đọc dưới đây bằng công cụ PostgreSQL. Chờ
   `pending_deletions=0`; nếu có lỗi retry thì xử lý ở local trước. Không đổi driver
   khi còn file PENDING cần hoàn tất hoặc còn job xóa chưa xử lý.
4. Dừng các instance API/worker trước khi chép dữ liệu cuối cùng và đổi cấu hình.

```sql
SELECT id, name, object_key, size, mime_type, status
FROM files
WHERE status <> 'DELETED'
ORDER BY object_key;

SELECT count(*) AS pending_files FROM files WHERE status = 'PENDING';

SELECT count(*) AS pending_deletions
FROM file_object_deletions
WHERE completed_at IS NULL;
```

Lưu danh sách trên làm manifest đối chiếu. Đường dẫn nội dung local là
`FILES_LOCAL_DIRECTORY/object_key`. API công khai không trả object key.

### 8.2. Chép bằng Console và giữ nguyên key

Ví dụ DB lưu `object_key=local/abc-123`, tên hiển thị `Bài giảng.pdf`:

| Nơi        | Định danh phải có                            |
| ---------- | -------------------------------------------- |
| Local      | `backend/.local-storage/files/local/abc-123` |
| S3         | `s3://streamora-storage/local/abc-123`       |
| PostgreSQL | Giữ nguyên `object_key=local/abc-123`        |

Với số lượng nhỏ, vào bucket → tạo folder `local` → mở folder → **Upload → Add
files**, chọn các file UUID tương ứng trong thư mục local. File tải lên phải giữ
tên UUID, không đổi thành tên hiển thị có đuôi `.pdf`. Với cấu trúc khác, tạo đúng
prefix theo manifest. Có thể dùng **Add folder** để giữ cả cây thư mục, nhưng phải
kiểm tra key kết quả trước khi chuyển; không thêm prefix `.local-storage/files/`.

Chỉ chép các object đang sử dụng theo manifest, đối chiếu số lượng, kích thước và
nội dung khi cần. Upload một PDF bằng tên `Bài giảng.pdf` trực tiếp vào bucket sẽ
không khớp key hiện tại. Chỉ upload lên S3 cũng không tự tạo một mục thư viện mới.

### 8.3. Đổi driver

Trong `backend/.env` hoặc môi trường deployment:

```dotenv
FILES_STORAGE_DRIVER=s3
FILES_S3_BUCKET=streamora-storage
FILES_S3_REGION=ap-southeast-1
FILES_DOWNLOAD_TTL_SECONDS=60
FILES_CLEANUP_ENABLED=true
```

Giữ cấu hình database/auth/web đang dùng; thêm credentials/profile/role theo mục 6.
`FILES_LOCAL_DIRECTORY` và `FILES_PUBLIC_BASE_URL` không được dùng để phục vụ nội
dung S3. Region phải trùng bucket. Biến môi trường của tiến trình ưu tiên hơn `.env`.

Từ gốc repository, với môi trường phát triển:

```powershell
npm run dev:api
```

Với deployment đã chuẩn bị môi trường production:

```powershell
npm run build --workspace=@streamora/api
npm run start --workspace=@streamora/api
```

Chuyển driver không thay thế cấu hình triển khai web/API: vẫn cần địa chỉ API,
HTTPS, `WEB_ORIGIN`, cookie và kết nối PostgreSQL phù hợp môi trường.
Không cần migration mới chỉ để đổi local sang S3. API và frontend giữ nguyên.

### 8.4. Kiểm tra sau chuyển và quay lại local

Trong thời gian nghiệm thu ban đầu vẫn chặn thao tác ghi. Giữ bản sao local.
Kiểm tra tải/xem trước ở mục 9 trước khi mở lại cho người dùng.

Nếu lỗi trong giai đoạn này, dừng API, đặt lại `FILES_STORAGE_DRIVER=local`, kiểm
tra lại thư mục/base URL local rồi khởi động lại. Không cần sửa metadata nếu key
và dữ liệu chưa thay đổi. Sau khi đã có file mới hoặc xóa trên S3, phải đối chiếu
và đồng bộ dữ liệu ngược trước khi quay lại; không chỉ đổi driver rồi giả định local
vẫn đầy đủ. Chưa có công cụ rollback tự động.

## 9. Nghiệm thu và vận hành

| Kiểm tra          | Kết quả cần đạt                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| Danh sách nhóm    | File đúng nhóm; tìm/lọc/phân trang hoạt động                                      |
| Tải file          | API trả link và GET link thực sự tải được nội dung đúng                           |
| PDF               | Preview hiển thị được trang PDF, tải xuống vẫn hoạt động                          |
| Preview ảnh/video | JPEG/PNG/WebP và MP4/WebM/MOV phù hợp; định dạng không hỗ trợ trả 415             |
| Quyền             | Người ngoài nhóm thông thường bị 403; thành viên khác không quản lý file của nhau |
| Trạng thái        | PENDING không được cấp link; DELETED không còn trong danh sách                    |
| Hết hạn           | Gửi GET mới bằng link cũ sau TTL bị từ chối; xin link mới hoạt động               |
| Xóa               | Dùng một file thử riêng; API 204, biến mất ngay, worker dọn object sau đó         |
| Bucket private    | Truy cập object không có chữ ký bị từ chối                                        |

Kiểm tra xóa bằng dữ liệu thử riêng sau khi đã xác nhận chuyển đổi; không dùng tài
liệu cần giữ làm mẫu. Khi kiểm tra hết hạn, dùng request mới, tránh kết quả từ cache
hoặc trang PDF đã nạp sẵn. TTL không xóa byte đã được tải về máy người dùng.

Quan trọng: adapter S3 ký URL mà chưa gọi `HeadObject`. API cấp link thành công
chưa chứng minh object tồn tại, credentials có đủ quyền đọc hay region đúng.
Phải thực sự mở link. Lỗi S3 403/404 có thể xuất hiện ở bước tải, không phải ở API
Streamora. IAM/CORS/S3 thật cần nghiệm thu trên AWS, không được suy ra từ test local.

Các lệnh kiểm tra code sẵn có, chạy từ gốc repository:

```powershell
npm run typecheck
npm run test:t15
npm run test:t15:frontend
```

Test integration/UI tạo database `streamora_test_*` tạm và xóa sau khi chạy;
cần PostgreSQL test có quyền CREATEDB và pg_trgm. Không reset database ứng dụng
để chạy test. Unit test adapter S3 dùng mô phỏng, không thay thế nghiệm thu AWS.
Lượt chạy lại ngày 13/11/2026 xem [báo cáo kiểm thử](t15-t17-verification.md).
Chưa chạy nghiệm thu S3 thật.

| Triệu chứng                    | Kiểm tra                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Import xong không thấy file    | Đúng database, API đang chạy bản mới, groupId và tài khoản; bấm Làm mới        |
| 503 STORAGE_UNAVAILABLE        | Bucket/credentials/profile; API đã khởi động lại sau sửa cấu hình chưa         |
| Link S3 trả AccessDenied       | IAM/bucket policy, credentials hết hạn, explicit deny, key và cấu hình mã hóa  |
| Link báo sai region/chữ ký     | Region bucket, thời gian máy, credentials; không sửa chuỗi URL đã ký           |
| Object không tồn tại           | Đối chiếu `object_key` với key S3, đặc biệt prefix `local/`                    |
| PDF không hiện                 | MIME metadata, nội dung thật, trình đọc PDF, GET link và thời hạn link         |
| File đã xóa vẫn còn object     | Worker có bật không, chờ lượt xử lý, quyền DeleteObject, retry hoặc Versioning |
| Lỗi CORS khi dùng fetch/upload | Origin đầy đủ có scheme/port; CORS S3 khác CORS API backend                    |

Log liên quan: `file_download_issued`, `file_preview_issued`,
`file_cleanup_retry`, `file_cleanup_unavailable`. Theo dõi job chưa hoàn tất trong
`file_object_deletions`; không xóa job chỉ để che lỗi quyền storage.

## 10. Điểm tiếp nhận cho người phát triển tiếp

| Đường dẫn trong repository                          | Nội dung                                            |
| --------------------------------------------------- | --------------------------------------------------- |
| `backend/src/modules/files/files.controller.ts`     | Các route HTTP                                      |
| `backend/src/modules/files/files.service.ts`        | Metadata, phân quyền, trạng thái, đăng ký recording |
| `backend/src/modules/files/file-storage.service.ts` | Chọn local/S3, ký URL, xóa object                   |
| `backend/src/modules/files/local-file-storage.ts`   | Nội dung local và chữ ký URL                        |
| `backend/src/modules/files/file-cleanup.service.ts` | Worker dọn nội dung                                 |
| `backend/src/config/environment.ts`                 | Nạp và kiểm tra cấu hình                            |
| `backend/contracts/src/files.ts`                    | Kiểu API dùng chung FE/BE                           |
| `backend/prisma/schema.prisma`                      | Schema metadata và hàng đợi                         |
| `backend/scripts/import-local-file.cjs`             | Công cụ nhập file/folder local                      |
| `frontend/src/components/files/`                    | Giao diện thư viện và preview PDF                   |
| `frontend/src/lib/files/api.ts`                     | Client gọi API T15                                  |

T11 gọi `FilesService.registerRecording` ở ranh giới nội bộ tin cậy, sau khi có
`recording_assets` thuộc đúng session/group. Đây không phải API HTTP công khai.
T16 lưu phiên upload ACTIVE riêng và chỉ tạo file AVAILABLE sau khi xác minh complete.
T11/T13 cần giữ/nhả `file_usages` và tuân thủ khóa hàng file khi thay đổi tham chiếu.
Không nhận `createdBy`, `objectKey` hoặc trạng thái tùy ý từ trình duyệt để bỏ qua
kiểm tra quyền. T16 đã có bàn giao riêng; các điểm này chưa chứng minh T11/T13/T17
đã được triển khai đầy đủ.
