# Streamora

Khung monorepo cho nền tảng học trực tuyến, cộng đồng và phát trực tiếp có tua lại. Toàn bộ giao diện tiếng Việt, tông tối với tím và cyan.

## Chạy giao diện

Yêu cầu Node.js 22.16+ và npm 10+. Tại thư mục gốc:

```sh
npm ci
npm run setup:env
npm run dev
```

Mở http://127.0.0.1:3000. Các trang trải nghiệm chạy độc lập với dữ liệu mẫu.
Đăng ký, đăng nhập và tài khoản dùng API/PostgreSQL thật; xem [hướng dẫn frontend](frontend/README.md).
Đồng đội bắt đầu từ [hướng dẫn bàn giao T01](backend/docs/t01-handoff.md).
Swagger local có Try it out Auth/Users: `http://127.0.0.1:3000/api/v1/docs`
(cần chạy cả frontend và API).
Phần quản lý nhóm xem [hướng dẫn bàn giao T02](backend/docs/t02-handoff.md).
Thành viên và phân quyền nhóm xem [hướng dẫn bàn giao T03](backend/docs/t03-handoff.md).
Lịch học, meet độc lập và vòng đời buổi học xem [API T04](backend/docs/t04-api.md).
Xin vào, accept/reject và vào/ra xem [API tham gia T04](backend/docs/t04-admission.md).
Thông báo realtime, heartbeat và reconnect xem [realtime T04](backend/docs/t04-realtime.md).
Giao diện T04 thật: mở nhóm → **Xem lịch học**, hoặc vào `/meet` để tạo/tham gia
cuộc họp độc lập. Xem [hướng dẫn giao diện T04](frontend/docs/class-sessions.md).
Điểm tích hợp T05/T11: [kiểm tra lượt tham gia và sự kiện kết thúc](backend/docs/t04-integration.md).
Nghiệm thu toàn bộ bằng `npm run test:t04`; xem [bàn giao và kịch bản demo T04](backend/docs/t04-handoff.md).
Swagger T04 local: `http://127.0.0.1:4000/api/v1/docs-sessions`.
Swagger API local: `http://127.0.0.1:4000/api/v1/docs`.

| Đường dẫn    | Nội dung                                                      |
| ------------ | ------------------------------------------------------------- |
| `/`          | Landing giới thiệu và bản xem trước không gian                |
| `/workspace` | Lớp trực tiếp, trình phát DVR minh họa, chat và thành viên    |
| `/meet`      | Tạo phòng hoặc tham gia bằng mã/liên kết                      |
| `/rooms/:id` | Phòng họp, camera/micro/chia sẻ màn hình trên thiết bị cục bộ |
| `/community` | Kênh chat, lưu lịch sử trên trình duyệt                       |
| `/files`     | Thư viện tìm kiếm, lọc và mô phỏng tải lên/tạm dừng/tiếp tục  |
| `/register`  | Đăng ký tài khoản thật                                        |
| `/login`     | Đăng nhập                                                     |
| `/account`   | Hồ sơ cá nhân, cập nhật họ tên và đăng xuất                   |

## Cấu trúc

```text
frontend/                # Next.js (@streamora/web)
  src/
    app/                 # Các route Next.js App Router và giao diện chung
    components/          # landing, workspace, live-player, presentation, ui, demo-data
backend/                 # NestJS API (@streamora/api)
  src/config/            # Cấu hình môi trường và chính sách auth T01
  src/database/          # DatabaseModule/PrismaService kết nối PostgreSQL
  src/common/            # Guard, DTO, validation, lỗi và log HTTP dùng chung
  src/modules/
    auth/                # Đăng ký, đăng nhập, JWT và refresh rotation
    users/               # GET/PATCH hồ sơ với guard xác thực
    communities/         # Danh sách cộng đồng mẫu
    memberships/         # Thành viên, quyền nhóm và thu hồi Socket.IO/LiveKit
    rooms/               # Phòng theo nhóm và ánh xạ LiveKit trong DB
    files/               # Tìm kiếm metadata tài liệu mẫu
  realtime/src/          # NestJS Socket.IO: tham gia kênh và phát tin nhắn
  test/                  # Test cấu hình, setup và HTTP nền tảng
  prisma/                # Schema và migration users/auth_sessions/refresh tokens
  services/
    recording/           # Hướng tích hợp LiveKit Egress
    video-worker/        # Hướng tích hợp RabbitMQ + FFmpeg + HLS
  contracts/src/         # Kiểu dữ liệu dùng chung FE/BE (@streamora/contracts)
  scripts/               # setup-env, setup-staging, demo, seed, smoke test
  infra/
    docker/              # PostgreSQL, Redis, RabbitMQ, LiveKit dev và staging
    kubernetes/          # Ghi chú tổ chức deployment
    observability/       # Danh mục metrics cần triển khai
```

## Các dịch vụ local

```sh
npm run dev:api       # http://127.0.0.1:4000/api/v1/health
npm run dev:realtime  # http://127.0.0.1:4001/health
npm run typecheck
npm run test:backend
npm run test:database # PostgreSQL local đang chạy
npm run build
```

`GET /api/v1/communities` vẫn là dữ liệu mẫu. API phòng yêu cầu Bearer:
`POST /api/v1/rooms` với `{name,groupId}` dành cho HOST/OWNER/ADMIN và
`GET /api/v1/rooms/:id` xác minh membership từ room trong DB.
`GET /api/v1/files?groupId=<uuid>&q=slide` yêu cầu thành viên nhóm; nội dung vẫn minh họa.
Realtime `/classroom` dùng `auth.accessToken`; `channel:join` nhận `{groupId}`,
`chat:send` nhận `{groupId,text}`. API cũng cung cấp gateway; service cổng 4001 dùng cùng bộ quyền.
Khu vực tài khoản/nhóm/thành viên/lịch học/Meet dùng `NEXT_PUBLIC_API_URL` gọi backend thật;
trình phát trong workspace và thư viện còn dùng dữ liệu minh họa.

`npm run setup:env` tạo cấu hình local cùng mật khẩu và khóa ký ngẫu nhiên; giữ nguyên
file đã có. `.env` gốc dành cho Docker, `backend/.env` dành cho server,
`frontend/.env.local` chỉ có biến public. Quy ước tài khoản, token, cookie, cấu trúc module
và phạm vi từng mục được ghi trong [backend/README.md](backend/README.md).
Backend đã nạp/kiểm tra env, bật CORS credentials và tích hợp PostgreSQL/Prisma.
Đã có 6 API auth/hồ sơ; xem [hướng dẫn thử API](backend/docs/auth-api.md).
Mục 4 đã cung cấp package `@streamora/contracts` cho FE/BE và
[quy ước tích hợp backend](backend/docs/backend-conventions.md) cho các module khác.
Mục 5 có [cấu hình cookie/staging và test trình duyệt](backend/docs/session-security.md),
chạy bằng `npm run test:browser` khi PostgreSQL local đang hoạt động.
Mục 6 đã tích hợp giao diện đăng ký/đăng nhập/tài khoản. Mục 7 bổ sung tự refresh/retry
và đồng bộ phiên giữa các tab; xem [hướng dẫn phiên frontend](frontend/docs/session.md).
Mục 8 có khung trang/điều hướng, user, toast, form và trạng thái dùng chung;
xem [quy ước frontend cho nhóm](frontend/docs/frontend-conventions.md).
Mục 9 có `npm run test:t01` để nghiệm thu typecheck, API/database, cookie và UI/phiên;
xem [hướng dẫn nghiệm thu T01](backend/docs/t01-acceptance.md).
Mục 10 cung cấp Swagger, bản OpenAPI để review, `npm run docs:api`,
`npm run docs:api:check`, `npm run demo:auth` và tài liệu bàn giao/demo/PR/staging.
Chạy kiểm thử bằng `npm run test:frontend`. Trước khi chạy API, chuẩn bị database:

```sh
docker compose --env-file .env -f backend/infra/docker/compose.yml up -d --wait postgres
npm run db:migrate
npm run db:check
```

Đồng đội chạy migration để có cùng cấu trúc bảng trên database local riêng;
dữ liệu đã insert trên máy khác không được đồng bộ qua Git.

Với Docker, sau khi tạo cấu hình local, chạy:

```sh
docker compose --env-file .env -f backend/infra/docker/compose.yml up -d
# Thêm LiveKit ở chế độ phát triển:
docker compose --env-file .env -f backend/infra/docker/compose.yml --profile media up -d
```

## Phạm vi đã triển khai

- Điều hướng giữa các trang, mời bằng liên kết, tạo/tham gia phòng mẫu, tìm metadata tài liệu và tin nhắn.
- Chat được lưu riêng theo kênh; kênh mới và metadata thư viện lưu trong `localStorage` trên thiết bị. Thao tác cộng đồng/bình chọn là trạng thái mẫu. Mục Thành viên dùng API thật: tên/email, tìm kiếm, thêm/xóa, gán HOST/VIEWER và bảo vệ OWNER.
- Thanh tua kéo được, play/pause, đuổi theo mốc trực tiếp, chọn tốc độ/chất lượng và toàn màn hình là mô phỏng giao diện, chưa phát video HLS thực.
- Camera/micro/chia sẻ màn hình dùng `getUserMedia`/`getDisplayMedia` thật sau khi cho phép, có dừng track khi rời trang. Chưa truyền media giữa người dùng.
- Có thiết lập FPS cho lần chia sẻ tiếp theo; trình duyệt quyết định mức hỗ trợ.
- Thông báo ghi hình, mục bản ghi và tải lên chỉ minh họa. Không tạo tệp ghi âm/video, không giữ nội dung tệp đã chọn và không upload lên cloud.
- Giao diện dùng ảnh chân dung minh họa từ Unsplash và font Be Vietnam Pro từ Google Fonts; có fallback khi không tải được font.

## Phần cần tích hợp tiếp

Tích hợp guard T03 vào các module lớp học/tài liệu/bản ghi khi triển khai; LiveKit và token từ API đã xác thực;
Egress + Web Audio API; HLS/hls.js với rolling DVR playlist; presigned multipart upload S3 có resume thật;
worker FFmpeg, retry/DLQ; Redis adapter; replication GCS và định tuyến CDN; Kubernetes/HPA/WAF và metrics.

API/realtime chỉ bind loopback. API phòng/tài liệu và Socket.IO hiện đã xác thực,
kiểm tra quyền theo group và thu hồi truy cập khi xóa thành viên. Xem giới hạn media,
TTL, outbox và hướng dẫn dùng chung guard/hook trong tài liệu T03.
Có [HTTPS staging local cho T01](backend/docs/t01-staging.md) tại
https://localhost:8443, khởi tạo bằng `npm run staging:setup` rồi `npm run staging:up`.
Kết quả test, PR và giới hạn bàn giao xem [báo cáo T01](backend/docs/t01-delivery-report.md).
Staging công khai của nhóm cần hạ tầng/domain deployment riêng.
