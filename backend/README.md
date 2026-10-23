# Nền tảng backend và quy ước T01

Mục 1 đã tạo cấu trúc module, cấu hình môi trường, `/api/v1`, CORS và quy ước triển khai.
Mục 2 bổ sung PostgreSQL + Prisma, schema/migration và kết nối database trong NestJS.
Mục 3 triển khai 6 API auth/hồ sơ, Argon2id, JWT, refresh cookie và transaction xoay token.
Mục 4 cung cấp contracts FE/BE, guard/DTO dùng lại, lỗi chi tiết theo trường,
request ID và log HTTP chỉ chứa metadata.
Mục 5 chốt cookie/CORS/Origin, thêm template staging và test browser HTTP/HTTPS.
Mục 6 bổ sung giao diện gọi sáu API: xem [frontend/README](../frontend/README.md).
Mục 7 hoàn thiện tự refresh/retry, bảo vệ trang và đồng bộ phiên giữa các tab;
xem [hướng dẫn phiên frontend](../frontend/docs/session.md).
Swagger, phân quyền group và tích hợp giao diện tiếp tục ở các mục sau.
Hướng dẫn gọi API từng bước: [docs/auth-api.md](docs/auth-api.md).
Hướng dẫn tích hợp cho đồng đội: [docs/backend-conventions.md](docs/backend-conventions.md).
Cookie, staging và kiểm thử browser: [docs/session-security.md](docs/session-security.md).

## Chạy local

Yêu cầu Node.js >=22.16 và npm >=10; máy hiện tại được kiểm tra với Node.js 24.14.1.
Chạy tại thư mục gốc repository:

```sh
npm ci
npm run setup:env
docker compose --env-file .env -f infra/docker/compose.yml up -d --wait postgres
npm run db:migrate
npm run db:check
npm run dev:api
```

API mẫu: `http://127.0.0.1:4000/api/v1/health`.
`npm run dev:api` biên dịch rồi chạy; sau khi sửa TypeScript, dừng và chạy lại lệnh.
Frontend chạy ở terminal riêng bằng `npm run dev`.
Realtime chạy bằng `npm run dev:realtime`; service trong `backend/realtime/` dùng lại
gateway xác thực của API. Thành viên, guard, hook, outbox và LiveKit xem
[hướng dẫn T03](docs/t03-handoff.md).

`setup:env` tạo `.env` gốc cho Compose, `backend/.env` cho server và
`frontend/.env.local` cho Next.js. Mật khẩu local và khóa ký được tạo ngẫu nhiên,
không in ra terminal, không ghi đè file đã tồn tại. DATABASE_URL/RABBITMQ_URL của
file backend mới được ghép từ mật khẩu trong `.env` gốc.
Nếu đã có file cấu hình, tự đối chiếu URL/mật khẩu và `/api/v1`; chạy lại setup
không cập nhật hay đồng bộ các file đã có.

Server tự đọc `backend/.env` theo vị trí mã nguồn/compiled output, không theo thư mục
terminal. Biến môi trường do shell/deployment cung cấp được ưu tiên hơn file local.
Thiếu file local vẫn chạy được nếu môi trường đã cung cấp đủ biến.
Cấu hình sai bị từ chối khi khởi động; lỗi không chứa giá trị secret.

Docker Desktop cần chạy engine trước khi gọi Compose. `--wait` đợi healthcheck thành công;
lần đầu cần tải image. Xem trạng thái bằng
`docker compose --env-file .env -f infra/docker/compose.yml ps`.
Chỉ service `postgres` cần cho T01 ở bước này.

`npm run db:migrate` áp dụng các migration đã commit bằng `prisma migrate deploy`,
không xóa/reset dữ liệu. `npm run db:check` kiểm tra kết nối từ host bằng DATABASE_URL
và xác nhận có đủ bảng auth. NestJS cũng thử kết nối thật khi khởi động;
không kết nối được thì ứng dụng không bắt đầu nhận request.

Tắt PostgreSQL bằng `docker compose --env-file .env -f infra/docker/compose.yml stop postgres`.
Khởi động lại bằng lệnh `up` ở trên. Dữ liệu nằm trong volume `streamora_postgres-data`;
không dùng `down -v` khi muốn giữ dữ liệu. Mật khẩu khởi tạo chỉ áp dụng với volume mới,
sửa `.env` không tự đổi mật khẩu của PostgreSQL đã khởi tạo.

## Cấu trúc và trách nhiệm

```text
backend/
  src/
    main.ts                  # Đọc env và khởi động
    app.ts                   # Prefix, CORS, validation toàn ứng dụng
    config/                  # Kiểm tra env và hằng số chính sách auth
    common/                  # Guard, DTO, validation, lỗi và request context dùng chung
    modules/
      app.module.ts
      auth/                  # AuthModule: đăng ký, đăng nhập, phiên
      users/                 # UsersModule: thông tin và hồ sơ user
      communities/           # API mẫu cũ
      memberships/           # T03: thành viên, quyền và thu hồi truy cập
      rooms/                 # Phòng theo nhóm, mapping lưu DB
      files/                 # API mẫu cũ
  test/                      # Kiểm thử cấu hình và HTTP
  realtime/                  # Service Socket.IO dùng chung quyền T03
  services/                  # Điểm tích hợp recording, video-worker (chưa triển khai)
  prisma/                    # Schema và migration đã commit
  prisma.config.ts           # Cấu hình Prisma CLI, đọc backend/.env
```

API nghiệp vụ viết thành module trong ứng dụng NestJS này. Không đặt code backend
trong `frontend/`. Kiểu request/response dùng chung FE/BE nằm ở `packages/contracts`,
import qua `@streamora/contracts`. Prisma và migration nằm trong `backend/prisma`.

## Database và migration T01

Prisma CLI/client/adapter cùng khóa ở bản 7.10.1. Client được sinh vào
`src/generated/prisma` và biên dịch cùng backend; không commit generated code.
`build` và `typecheck` tự generate client. Runtime dùng PostgreSQL driver adapter,
pool tối đa 10 kết nối, thời hạn mở kết nối 5 giây. PrismaService đóng pool khi NestJS dừng.

- `users`: UUID, email unique đã chuẩn hóa, `password_hash`, `full_name`,
  `global_role` mặc định USER, `disabled_at` và thời gian tạo/cập nhật.
- `auth_sessions`: một lần đăng nhập là một session/family ổn định, liên kết user,
  hạn tuyệt đối, lần sử dụng cuối, thời điểm và lý do thu hồi.
- `auth_refresh_tokens`: bảng phụ lưu hash SHA-256, số thế hệ, hạn token và thời điểm
  đã dùng. Nhiều token lịch sử cùng liên kết một session; không lưu token bản rõ.

Index unique email xử lý cả hai đăng ký đồng thời. CHECK trong migration buộc email
đã lowercase/trim, tên có nội dung, hạn phiên/token lớn hơn lúc tạo, generation không âm,
hash đúng dạng hex SHA-256 và trạng thái thu hồi nhất quán. Cột password hash chỉ nhận
giá trị có prefix Argon2id; xác minh/hash mật khẩu thực tế thuộc mục 3.
Partial unique index chỉ cho một refresh token chưa dùng trong mỗi session;
xoay token phải đánh dấu token cũ đã dùng trước khi thêm token mới trong cùng transaction.
Các CHECK/partial index là SQL bổ sung, cần giữ khi review migration tiếp theo.
FK cascade dọn token khi xóa session và dọn session khi xóa user.

AuthService dùng transaction và khóa user trước khi thay đổi session/token, thống nhất
thứ tự khóa cho login/refresh/logout. Hạn token mới bằng hạn tuyệt đối của session.
Lỗi reuse được trả ra SAU khi commit thu hồi family, tránh rollback làm token vẫn còn dùng được.
Chưa có job tự dọn token cũ; không xóa lịch sử hash trước khi family hết hạn.

Thành viên khác pull code chạy đúng chuỗi lệnh local ở trên để tạo cùng cấu trúc bảng
trên database riêng; dữ liệu local không đi theo Git. Hiện chưa thêm seed tài khoản.
Để tạo migration mới khi thay schema, chạy tại gốc:

```sh
npm run db:migrate:dev --workspace=@streamora/api -- --name ten_thay_doi
```

Review và commit cả schema lẫn thư mục migration. Không dùng `db push` hoặc
`migrate reset` thay cho migration dùng chung của nhóm.

## Quy tắc tài khoản

- Email: trim khoảng trắng ngoài, lowercase toàn bộ theo quy ước sản phẩm,
  kiểm tra đúng định dạng email, tối đa 254 ký tự; unique trên email đã chuẩn hóa
  tại database. Không tự bỏ dấu chấm hoặc phần `+tag`.
- Mật khẩu: 12–128 Unicode code point, không trim, không lowercase, không ép bộ ký tự
  hoa/thường/số/ký hiệu. Không dùng email hoặc họ tên để biến đổi mật khẩu.
- Lưu mật khẩu bằng argon2 0.45.1, Argon2id với memoryCost=65536 KiB,
  timeCost=3, parallelism=1, hashLength=32, salt ngẫu nhiên 16 byte cho từng mật khẩu.
  Login user không tồn tại vẫn verify một dummy hash để giảm khác biệt thời gian.
- Họ tên: trim khoảng trắng ngoài, từ 1 đến 100 Unicode code point.
- `User` public: `{id,email,fullName,globalRole}`. ID là UUID; thời gian API là ISO8601 UTC.
- `globalRole`: `USER` hoặc `ADMIN`; đăng ký công khai luôn tạo `USER`.
  `OWNER/HOST/VIEWER` thuộc membership của từng group và do T03 triển khai.
- `PATCH /users/me` chỉ nhận `fullName`; không cho đổi email, mật khẩu hoặc role.

## Access token và phiên refresh

- Access token: JWT ký HS256, mặc định 900 giây (15 phút), cấu hình qua
  `ACCESS_TOKEN_TTL_SECONDS`. Khóa ký `ACCESS_TOKEN_SECRET` do server giữ,
  tối thiểu 32 byte ngẫu nhiên; công cụ setup tạo 48 byte ngẫu nhiên.
- Claims: `sub` (userId), `sid` (auth sessionId), `jti`, `iat`, `exp`,
  `iss=streamora-api`, `aud=streamora-web`. FE gửi `Authorization: Bearer <token>`.
- Access token giữ trong bộ nhớ frontend. Reload trang khôi phục bằng refresh cookie;
  không lưu refresh token vào localStorage, IndexedDB hoặc response JSON.
- Refresh token: opaque token từ 32 byte ngẫu nhiên trở lên, chỉ lưu hash SHA-256
  của token trong DB. Đây là hash của token ngẫu nhiên, khác password hash Argon2id.
- Phiên có hạn tuyệt đối 604800 giây (7 ngày) từ lúc đăng nhập. Refresh không kéo dài
  hạn của family; `REFRESH_TOKEN_TTL_SECONDS` phải lớn hơn hạn access token.
- Mỗi lần refresh thay token và vô hiệu token cũ trong transaction. Hai request đồng
  thời không được cùng sử dụng thành công một token. FE gom các lần refresh đồng thời.
- Giữ dấu vết token đã dùng trong family đến hết hạn để phát hiện reuse. Reuse thu hồi
  toàn family; trả `401 REFRESH_REUSED`. Hết hạn trả `401 REFRESH_EXPIRED`.
- Guard của `GET/PATCH /users/me` kiểm tra chữ ký/claims, user còn hoạt động và session `sid`
  còn hiệu lực tại server cho mỗi request cần xác thực. Logout/khóa tài khoản vì thế
  vô hiệu cả access token đã cấp. Mặc định chưa cache trạng thái phiên.
- Logout chỉ kết thúc phiên hiện tại, xóa cookie; trả 204 kể cả đã logout hoặc cookie
  không còn hợp lệ, không tạo tác dụng phụ khi gọi lại. Không thêm logout-all trong T01.
- User bị khóa không được login/refresh hoặc dùng API được bảo vệ. Khi auth phát hiện
  `disabledAt`, các phiên còn hoạt động bị thu hồi và không được phục hồi khi mở khóa.
  Module quản trị tương lai phải thu hồi phiên trong thao tác khóa tài khoản;
  màn hình/endpoint quản trị khóa tài khoản không thuộc T01.

## Cookie, CORS và CSRF

- Cookie tên `refreshToken`, `HttpOnly`, `Path=/api/v1/auth`, không đặt `Domain`.
  Max-Age dựa trên thời gian còn lại đến hạn tuyệt đối của family.
- Local HTTP: `AUTH_COOKIE_SECURE=false`, `AUTH_COOKIE_SAME_SITE=lax`.
  Dùng nhất quán `127.0.0.1` cho cả FE và BE để tránh khác site với `localhost`.
- Production/staging: `NODE_ENV=production`, origin frontend HTTPS chính xác,
  cookie Secure bắt buộc. Reverse proxy kết thúc TLS và chuyển traffic tới API.
- Nếu FE/BE thực sự khác site, dùng `SameSite=none` cùng `Secure=true` và HTTPS.
  Không dùng wildcard origin khi gửi credentials. `WEB_ORIGIN` là một origin duy nhất,
  không kèm đường dẫn, dấu `/` cuối, query hoặc credentials.
- CORS credentials đã bật; frontend auth ở mục 7 sẽ dùng `credentials: include`.
  CORS không thay thế CSRF: các endpoint POST auth kiểm tra Origin
  khớp WEB_ORIGIN trước xử lý. Origin thiếu/sai bị từ chối với 403; công cụ test phải
  gửi Origin. Preflight OPTIONS do CORS xử lý, không yêu cầu token.
- Khi xóa cookie dùng cùng name/path/domain và thuộc tính tương ứng lúc đặt.
  Refresh lỗi 401/403 xóa cookie. Origin sai bị từ chối trước khi thay đổi cookie/phiên.
- Auth và `/users/me` trả Cache-Control no-store, Pragma no-cache.

## Hợp đồng API và lỗi

Swagger local ở `http://127.0.0.1:4000/api/v1/docs`, JSON ở `/api/v1/docs-json`.
API_DOCS_ENABLED mặc định true ở development, false ở test/production.
Xem [Swagger/OpenAPI](docs/openapi.md), [bàn giao T01](docs/t01-handoff.md)
và [nội dung PR](docs/t01-pr.md). `npm run docs:api` xuất spec không cần database;
`npm run demo:auth` chạy luồng HTTP trên API đang hoạt động.

Prefix cố định `/api/v1`; biến public `NEXT_PUBLIC_API_URL` bao gồm prefix này.
Sáu API T01 là `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`,
`POST /auth/logout`, `GET /users/me`, `PATCH /users/me`.
Health mẫu hiện là `/api/v1/health`; probe `/health/*` riêng thuộc T19.

Response thành công theo từng API, ví dụ `{user}` hoặc `{accessToken,expiresIn,user}`;
không tự bọc tất cả vào `{data}`. Logout 204 không body. API mẫu cũ còn `{data,demo}`,
sẽ được owner tương ứng thay khi tích hợp hợp đồng mới.
Lỗi dùng `{error:{code,message,details?},requestId}`; 400 dữ liệu sai, 401 chưa xác thực,
403 thiếu quyền/tài khoản khóa, 409 email trùng, 429 quá tần suất. ApiErrorFilter đã
áp dụng mẫu lỗi và requestId; lỗi bất ngờ trả thông báo chung, không trả nguyên exception.
Lỗi validation có `details.fields: [{field,code,message}]`, không trả giá trị nhập vào.
Mỗi request có `X-Request-ID` do server tạo, trùng với `requestId` trong body lỗi và log.
Log HTTP dạng JSON chỉ gồm event, requestId, method, route mẫu, statusCode và durationMs;
không ghi URL thực, query, body, header hoặc nguyên exception. CORS cho phép FE đọc
`X-Request-ID` và `Retry-After`. API danh sách mới dùng `{items,nextCursor}`;
`PaginationQueryDto` mặc định 20, tối đa 100, cursor là chuỗi opaque.

Backend đang bật ValidationPipe với whitelist + forbidNonWhitelisted + transform;
DTO auth/hồ sơ đã kiểm tra input. Không ghi password, Authorization, Cookie,
Set-Cookie, token, khóa ký hoặc DATABASE_URL vào log; không trả stack trace cho client.
Rate limit hiện theo IP/tiến trình: đăng ký 20 yêu cầu/15 phút; đăng nhập 30 yêu cầu/phút,
tính cả request sai dữ liệu, trả 429 + Retry-After khi quá giới hạn. Không tin X-Forwarded-For
khi chưa cấu hình trusted proxy. Khi triển khai nhiều instance phải thay bằng bộ đếm chung
(Redis/gateway) cùng cấu hình proxy tại bước hạ tầng; hiện bộ đếm reset khi restart.

## Kiểm tra mục 1 đến mục 5

Nghiệm thu toàn bộ T01 tại gốc repository: `npm run test:t01`.
Lệnh này bao gồm typecheck và tất cả bộ kiểm thử dưới đây cùng frontend/session;
xem [tiêu chí và hướng dẫn nghiệm thu mục 9](docs/t01-acceptance.md).

```sh
npm run test:backend
npm run test:database
npm run test:browser
npm run db:validate
npm run typecheck
npm run build --workspace=@streamora/realtime
```

`test:backend` kiểm tra cấu hình, công cụ setup, validation, mẫu lỗi và log an toàn,
không cần database.
`test:database` yêu cầu PostgreSQL đang chạy và tài khoản local có quyền CREATEDB.
Test tự tạo database tạm tên `streamora_test_<uuid>`, áp migration từ đầu và xóa
đúng database tạm đó sau khi chạy; không truncate/reset database ứng dụng.
Các test kiểm tra HTTP/prefix/CORS sau khi tích hợp Prisma, schema, email trùng khi
ghi đồng thời, CHECK/FK và dữ liệu lịch sử token.
Auth tests gọi đủ 6 API qua HTTP: chuẩn hóa input, hash/salt, không lộ dữ liệu nội bộ,
cookie, profile, expiry, JWT sai, rotation/reuse đồng thời, logout, user bị khóa, Origin và 429.
Common tests kiểm tra dùng guard trong module khác, request ID, chi tiết validation,
UUID/phân trang, lỗi 403/503/500 và log qua HTTP thật.
Browser tests dùng Playwright/Edge kiểm tra cookie thật trên HTTP local và HTTPS
khác host cùng site mô phỏng staging; xem yêu cầu OpenSSL và cách chạy trong tài liệu cookie.
`npm run test:frontend` kiểm tra form/luồng tài khoản trên Next.js production build
với API và database tạm thật; có case lỗi, mất kết nối và mobile.

Tham khảo API nạp env của [Node.js](https://nodejs.org/docs/latest-v24.x/api/process.html#processloadenvfilepath)
và cấu hình [CORS NestJS](https://docs.nestjs.com/security/cors).
Prisma sử dụng [PostgreSQL adapter](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)
và [generator CommonJS](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators).
