# Streamora

Nền tảng học trực tuyến, cộng đồng và phát trực tiếp có tua lại. Dự án dùng **Next.js + NestJS + PostgreSQL + DynamoDB**, tổ chức theo monorepo, với giao diện tiếng Việt.

Chat workspace dùng DynamoDB; chat cuộc họp giữ trong RAM. Xem [bàn giao chat, tìm kiếm và thread hỏi đáp](backend/docs/workspace-chat-dynamodb-handoff.md) để chạy DynamoDB Local, chuyển lịch sử cũ và cấu hình AWS.

## 1. Chạy local

### Chuẩn bị

- **Node.js 22.16+**, **npm 10+**.
- PostgreSQL truy cập được qua `DATABASE_URL`; dự án kết nối trực tiếp, không cần Docker.
- DynamoDB Local trên cổng 8000 cho chat workspace (Java theo tài liệu bàn giao, không cần Docker); chạy `npm run chat:setup --workspace=@streamora/api` trước khi thử chat.
- Thực hiện các lệnh dưới đây tại **thư mục gốc repository**.

### Bước 1 — Cài đặt và tạo cấu hình

```sh
npm ci
npm run setup:env
```

`setup:env` tạo khóa ký ngẫu nhiên và các file cấu hình nếu chưa có; giữ nguyên file đã tồn tại.

| File                  | Cần cấu hình                                                                      |
| --------------------- | --------------------------------------------------------------------------------- |
| `backend/.env`        | Điền `DATABASE_URL` của PostgreSQL; kiểm tra `WEB_ORIGIN=http://127.0.0.1:3000`   |
| `frontend/.env.local` | `NEXT_PUBLIC_API_URL=http://127.0.0.1:4000/api/v1`; realtime mặc định dùng API cổng 4000 |

Dùng thống nhất hostname `127.0.0.1`. Cấu hình frontend chỉ chứa biến public; khóa ký, thông tin database và credentials storage thuộc backend. Khởi động lại dịch vụ sau khi sửa env.

### Bước 2 — Chuẩn bị database

Sau khi điền `DATABASE_URL`:

```sh
npm run db:migrate
npm run db:check
```

Migration áp dụng khi có thay đổi mới. Nếu nhóm dùng chung database, migration đã được một người áp dụng sẽ có hiệu lực cho cả nhóm; không cần chạy lại để đồng bộ dữ liệu.

### Bước 3 — Mở các dịch vụ ở terminal riêng

| Terminal | Lệnh                   | Mục đích                                              |
| -------- | ---------------------- | ----------------------------------------------------- |
| Frontend | `npm run dev`          | Giao diện tại [127.0.0.1:3000](http://127.0.0.1:3000) |
| API      | `npm run dev:api`      | Auth, nhóm, lịch học, thư viện và điều khiển upload   |
| Realtime | `npm run dev:realtime` | Chat/thông báo realtime khi frontend dùng cổng 4001   |

`dev:api` biên dịch rồi chạy một lần. Sau khi sửa code backend, dừng và chạy lại lệnh. Listener PUT local được API tự mở khi cần, không có lệnh chạy storage riêng.

**Bắt đầu sử dụng:** mở [Đăng ký](http://127.0.0.1:3000/register) hoặc [Đăng nhập](http://127.0.0.1:3000/login), chọn nhóm rồi mở thư viện/lịch học. Luồng demo nhiều tài khoản nằm trong [bàn giao T04](backend/docs/t04-handoff.md).

## 2. Dịch vụ và đường dẫn

### Cổng mặc định

| Dịch vụ              | Cổng | Địa chỉ / ghi chú                                                |
| -------------------- | ---- | ---------------------------------------------------------------- |
| Frontend             | 3000 | [Trang chủ](http://127.0.0.1:3000)                               |
| API NestJS           | 4000 | [Health](http://127.0.0.1:4000/api/v1/health), tiền tố `/api/v1` |
| Realtime             | 4001 | [Health](http://127.0.0.1:4001/health), Socket.IO `/classroom`   |
| Storage upload local | 4002 | Nhận PUT part qua URL đã ký; được quản lý bởi API                |

API/realtime mặc định bind loopback. Staging công khai cần cấu hình hạ tầng/domain riêng.

Phòng mic/camera IVS T05: xem [cấu hình AWS và luồng tham gia](backend/docs/t05-handoff.md). Khi dùng worker SQS riêng, mở thêm terminal chạy `npm run dev:ivs-events`.

### Các trang chính

| Đường dẫn                         | Nội dung                                                               |
| --------------------------------- | ---------------------------------------------------------------------- |
| `/`                               | Giới thiệu và xem trước không gian học                                 |
| `/register`, `/login`, `/account` | Đăng ký, đăng nhập, hồ sơ và đăng xuất                                 |
| `/workspace`                      | Không gian nhóm, chat, thành viên và trình phát trực tiếp minh họa     |
| `/meet`                           | Tạo/tham gia cuộc họp độc lập bằng mã hoặc liên kết                    |
| `/rooms/:id`                      | Giao diện phòng demo và kiểm tra thiết bị          |
| `/groups/:groupId/sessions`       | Lịch học của nhóm; cũng có thể mở nhóm → **Xem lịch học**              |
| `/sessions/:sessionId`, `/meet/:code` | Vào buổi học, preview và kết nối mic/camera IVS — T04/T05 |
| `/community`                      | Không gian cộng đồng; có phần trạng thái/dữ liệu minh họa              |
| `/files`                          | Thư viện theo nhóm: upload, tìm kiếm, quản lý và preview PDF/ảnh/video |

### Swagger và API

| Phạm vi                                | Tài liệu tương tác                                             |
| -------------------------------------- | -------------------------------------------------------------- |
| Auth và hồ sơ                          | [Swagger API](http://127.0.0.1:4000/api/v1/docs)               |
| Lịch học, Meet và tham gia phòng — T04 | [Swagger sessions](http://127.0.0.1:4000/api/v1/docs-sessions) |
| Mic/camera IVS — T05 | [Swagger media](http://127.0.0.1:4000/api/v1/docs-media) |
| Thư viện và upload — T15/T16/T17       | [Swagger files](http://127.0.0.1:4000/api/v1/docs-files)       |

Khi cả frontend và API đang chạy, có thể mở Swagger qua proxy frontend tại [3000/api/v1/docs](http://127.0.0.1:3000/api/v1/docs) để thử luồng auth/cookie. Xem [hướng dẫn thử API](backend/docs/auth-api.md) và [OpenAPI](backend/docs/openapi.md).

## 3. Trạng thái tính năng

### Đã tích hợp API/storage thật

| Phạm vi                | Đã có                                                                        | Tài liệu chính                     |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| Tài khoản — T01        | Đăng ký/đăng nhập, hồ sơ, refresh/retry và đồng bộ phiên giữa các tab        | [T01](backend/docs/t01-handoff.md) |
| Nhóm — T02             | Quản lý nhóm và không gian làm việc theo nhóm                                | [T02](backend/docs/t02-handoff.md) |
| Thành viên — T03       | Tìm/thêm/xóa thành viên, HOST/VIEWER, bảo vệ OWNER và thu hồi quyền          | [T03](backend/docs/t03-handoff.md) |
| Lịch học và Meet — T04 | Lịch, vòng đời buổi học, xin vào/duyệt/vào/ra và realtime                    | [T04](backend/docs/t04-handoff.md) |
| Mic/camera — T05 | Preview, token backend, join/leave/reconnect IVS; cần nghiệm thu AWS thật | [T05](backend/docs/t05-handoff.md) |
| Chia sẻ màn hình | Phát màn hình qua IVS trong Meet độc lập và trong Workspace | [Meet](backend/docs/meetings.md) |
| Thư viện — T15         | Metadata PostgreSQL, tìm kiếm, quản lý file và preview                       | [T15](backend/docs/t15-handoff.md) |
| Upload multipart — T16 | Nhiều file, chia part, ký URL, complete/abort; local và adapter S3           | [T16](backend/docs/t16-handoff.md) |
| Tiếp tục upload — T17  | Pause/resume, khôi phục nguồn/hàng đợi sau reload, retry và chia lượt truyền | [T17](backend/docs/t17-handoff.md) |

Chat trong nhóm dùng API/realtime thật; phần demo không gắn nhóm vẫn có trạng thái lưu trên trình duyệt. Thư viện `/files` theo nhóm đọc metadata thật từ PostgreSQL.

### Còn minh họa hoặc cần tích hợp tiếp

- Trình phát trực tiếp trong workspace có thanh tua, tốc độ/chất lượng và toàn màn hình minh họa; chưa có luồng HLS/DVR thật.
- Mic/camera và chia sẻ màn hình cần cấu hình AWS IVS để chạy với người tham gia thật.
- Ghi hình và bản ghi trong workspace còn minh họa; T10/T11, IVS server-side composition và Web Audio API là phần tích hợp tiếp.
- Pipeline video EC2/MediaConvert đã có code và hướng dẫn Console; cần nghiệm thu AWS thật. Redis adapter, replication GCS và hạ tầng Kubernetes/HPA/WAF/metrics còn là phần tích hợp tiếp.
- S3 có adapter, IAM/CORS/lifecycle mẫu; chưa triển khai và kiểm thử upload S3 thật. Preview video và test local xem [handoff T13](backend/docs/t13-handoff.md).
- Giao diện dùng ảnh chân dung minh họa từ Unsplash và font Be Vietnam Pro từ Google Fonts; có font fallback.

## 4. Các lệnh thường dùng

### Phát triển và kiểm tra chung

| Lệnh                     | Công dụng                                                                      |
| ------------------------ | ------------------------------------------------------------------------------ |
| `npm run typecheck`      | Kiểm tra kiểu dữ liệu toàn monorepo                                            |
| `npm run build`          | Build các workspace                                                            |
| `npm run db:status`      | Xem trạng thái migration                                                       |
| `npm run db:migrate`     | Áp dụng migration đã có                                                        |
| `npm run db:check`       | Kiểm tra kết nối và các bảng auth                                              |
| `npm run docs:api`       | Xuất OpenAPI                                                                   |
| `npm run docs:api:check` | Kiểm tra OpenAPI khớp code                                                     |
| `npm run demo:auth`      | Chạy kịch bản demo auth                                                        |
| `npm run files:import`   | Nhập file local; xem [hướng dẫn T15](backend/docs/t15-local.md) trước khi dùng |

### Triển khai T13 bằng AWS Management Console

Cấu hình một lần theo [hướng dẫn AWS Console](backend/docs/t13-aws-console.md).
Worker chạy cùng API trên EC2, điều phối MediaConvert; DynamoDB lưu job, S3 lưu nguồn/output, CloudFront phát public. Không cần Lambda, Scheduler, Docker hay process PM2 mới. EC2 thuộc tài khoản khác vẫn dùng credentials của streamora-developer trong backend/.env.

Sau khi cấu hình env (đặc biệt VIDEO_WORKER_ENABLED=true), deploy như hiện tại:

```bash
npm ci
npm run build
pm2 restart streamora --update-env
pm2 restart streamora-api --update-env
pm2 save
```

Xem [bàn giao và kiểm thử](backend/docs/t13-handoff.md). Khi chuyển từ Lambda cũ, tắt lịch/trigger T13 trước khi bật worker EC2; giữ nguyên dữ liệu.

### Kiểm thử

| Phạm vi                                         | Lệnh                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| Backend                                         | `npm run test:backend`                                                     |
| Database / browser auth / toàn bộ UI            | `npm run test:database` / `npm run test:browser` / `npm run test:frontend` |
| T01 — tài khoản, cookie và phiên                | `npm run test:t01`                                                         |
| T02 — nhóm                                      | `npm run test:t02`                                                         |
| T03 — thành viên và quyền                       | `npm run test:t03`                                                         |
| T04 — lịch học, tham gia và realtime            | `npm run test:t04`                                                         |
| T05 — mic/camera IVS | `npm run test:t05` / `npm run test:t05:integration` / `npm run test:t05:frontend` |
| T13 — video nhiều chất lượng | `npm run test:t13` / `npm run test:t13:browser` |
| T13 — FFmpeg local, không cần AWS/DynamoDB Local | `npm run test:t13:local` |
| T13 — triển khai AWS | [AWS Management Console](backend/docs/t13-aws-console.md) |
| T15 — thư viện và UI                            | `npm run test:t15` / `npm run test:t15:frontend`                           |
| T16 — multipart và UI                           | `npm run test:t16` / `npm run test:t16:frontend`                           |
| T17 — resume và điều phối, không cần PostgreSQL | `npm run test:t17`                                                         |
| T17 — API/database và UI                        | `npm run test:t17:integration` / `npm run test:t17:frontend`               |
| Preview video                                   | `npm run test:video-preview`                                               |

**Database kiểm thử:** integration/UI tạo rồi xóa database `streamora_test_*` qua fixture. Dùng PostgreSQL/tài khoản kiểm thử riêng và ghi đè `DATABASE_URL` cho tiến trình test. Tài khoản này cần `CREATEDB`; tài khoản chạy ứng dụng bình thường không cần quyền đó. Xem [cách cấu hình an toàn trong T17](backend/docs/t17-handoff.md#database-kiểm-thử-và-quyền-createdb).

## 5. Tài liệu và bàn giao

### Theo module

| Module                       | Điểm bắt đầu                                           | Tài liệu bổ sung                                                                                      |
| ---------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| T01 — tài khoản và nền tảng  | [Bàn giao](backend/docs/t01-handoff.md)                | [Nghiệm thu](backend/docs/t01-acceptance.md), [báo cáo bàn giao](backend/docs/t01-delivery-report.md) |
| T02 — nhóm                   | [Bàn giao](backend/docs/t02-handoff.md)                | —                                                                                                     |
| T03 — thành viên, quyền nhóm | [Bàn giao](backend/docs/t03-handoff.md)                | Guard, thu hồi truy cập Socket.IO trong tài liệu bàn giao                                     |
| T04 — lịch học và Meet       | [Bàn giao / demo](backend/docs/t04-handoff.md)         | [API lịch học](backend/docs/t04-api.md), [API tham gia](backend/docs/t04-admission.md)                |
| T04 — giao diện và realtime  | [Hướng dẫn giao diện](frontend/docs/class-sessions.md) | [Realtime / heartbeat](backend/docs/t04-realtime.md)                                                  |
| T04 — điểm nối T05/T11       | [Hướng dẫn tích hợp](backend/docs/t04-integration.md)  | Guard tham gia và consumer sự kiện kết thúc                                                           |
| T05 — mic/camera IVS | [Bàn giao](backend/docs/t05-handoff.md) | Env access key, API media, thu hồi và EventBridge/SQS |
| T15 — thư viện               | [Bàn giao](backend/docs/t15-handoff.md)                | [Nhập file và chạy local](backend/docs/t15-local.md)                                                  |
| T16 — upload multipart       | [Bàn giao local/AWS](backend/docs/t16-handoff.md)      | API, quota, storage và nghiệm thu multipart                                                           |
| T17 — tiếp tục upload        | [Bàn giao mới nhất](backend/docs/t17-handoff.md)       | Pause/resume, reload hàng đợi, tối ưu truyền và các giới hạn                                          |
| T13 — Pipeline video | [Setup AWS Console](backend/docs/t13-aws-console.md), [Handoff và test local](backend/docs/t13-handoff.md) | EC2 điều phối MediaConvert, job DynamoDB và HLS public qua CloudFront |

### Quy ước dùng chung

| Chủ đề              | Tài liệu                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Frontend và backend | [Frontend README](frontend/README.md), [Backend README](backend/README.md)                                          |
| Tích hợp module     | [Quy ước frontend](frontend/docs/frontend-conventions.md), [quy ước backend](backend/docs/backend-conventions.md)   |
| Phiên và cookie     | [Phiên frontend](frontend/docs/session.md), [cookie / staging / kiểm thử browser](backend/docs/session-security.md) |
| Thử API và OpenAPI  | [Auth API](backend/docs/auth-api.md), [OpenAPI](backend/docs/openapi.md)                                            |

Module mới dùng contracts trong `@streamora/contracts`, guard/quyền nhóm và API client hiện có. Cơ chế token, cookie, outbox và thu hồi quyền được mô tả trong các tài liệu nền tảng ở trên.

## 6. Cấu trúc repository

```text
frontend/                      # Next.js — @streamora/web
  src/app/                     # Route và layout
  src/components/              # Giao diện auth, nhóm, lịch học, thư viện, workspace
  src/lib/                     # API client, phiên, upload và logic phía trình duyệt
  docs/                        # Quy ước và hướng dẫn tích hợp frontend
backend/                       # NestJS API — @streamora/api
  src/config/                  # Đọc/kiểm tra cấu hình môi trường
  src/common/                  # Guard, validation, lỗi và log dùng chung
  src/database/                # PrismaService và kết nối PostgreSQL
  src/modules/
    auth/, users/              # Tài khoản và hồ sơ
    groups/, memberships/      # Nhóm, thành viên và quyền
    class-sessions/, rooms/    # Lịch học, tham gia và phòng
    class-media/               # Token, mic/camera IVS, thu hồi và sự kiện SQS
    files/, uploads/           # Thư viện, multipart và resume
    communities/               # API cộng đồng mẫu
  prisma/                      # Schema và migration
  realtime/                    # Service Socket.IO — @streamora/realtime
  contracts/                   # Kiểu dữ liệu FE/BE — @streamora/contracts
  services/                    # Điểm nối recording
  infra/                       # Mẫu AWS, Kubernetes và observability
  scripts/                     # Setup, demo, seed và xuất OpenAPI
  test/                        # Unit, integration, browser và UI
  docs/                        # Bàn giao theo task và hợp đồng API
```

### Ghi chú tích hợp API/realtime

- `GET /api/v1/communities` vẫn trả dữ liệu mẫu.
- `POST /api/v1/rooms` nhận `{name, groupId}`, cần HOST/OWNER/ADMIN; `GET /api/v1/rooms/:id` xác minh quyền qua nhóm trong database.
- `GET /api/v1/groups/:groupId/files?q=slide` yêu cầu thành viên nhóm và đọc thư viện thật.
- Socket.IO `/classroom` dùng `auth.accessToken`; `channel:join` nhận `{groupId}`, `chat:send` nhận `{groupId, text}`. API cũng cung cấp gateway; service cổng 4001 dùng cùng bộ quyền.
