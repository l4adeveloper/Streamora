# Bàn giao T01: tài khoản, đăng nhập và phiên

Code backend nằm trong `backend/` ở gốc, frontend trong `frontend/`, kiểu chung trong
`backend/contracts/`. API auth/profile dùng PostgreSQL thật. Các màn hình nghiệp vụ
cộng đồng/phòng/tệp hiện còn là demo và owner của từng task sẽ tích hợp tiếp.

## Thành viên khác pull về và chạy lần đầu

Cần Node.js 22.16+ và npm 10+, không cần Docker. Tại gốc repository:

```powershell
npm ci
npm run setup:env   # rồi điền DATABASE_URL trong backend/.env
npm run db:migrate
npm run db:check
```

Mở hai terminal tại gốc repo:

```powershell
# Terminal API, giữ mở
npm run dev:api
```

```powershell
# Terminal frontend, giữ mở
npm run dev
```

Mở `http://127.0.0.1:3000/register`; health API ở
`http://127.0.0.1:4000/api/v1/health`; Swagger ở
`http://127.0.0.1:3000/api/v1/docs` (qua proxy frontend để thử cả Auth).

setup:env tạo `backend/.env` cho API và `frontend/.env.local` chỉ chứa biến public.
Khóa JWT được sinh riêng trên từng máy; `DATABASE_URL` của PostgreSQL dùng chung lấy từ nhóm. File đã có được giữ nguyên. Khi env cũ chưa có
API_DOCS_ENABLED, development vẫn bật docs mặc định. Dùng nhất quán 127.0.0.1
cho WEB_ORIGIN và frontend/API URL.

Migration ban đầu là `20261019000100_init_auth`, tạo users, auth_sessions và
auth_refresh_tokens cùng constraints/index/FK. Mục Swagger/bàn giao không thêm
migration mới. Dùng `migrate deploy` qua `npm run db:migrate` sau pull; không chạy
reset/down -v để sửa lỗi kết nối. Nếu volume đã có, đổi mật khẩu trong file env
không tự đổi mật khẩu của role PostgreSQL bên trong volume.

Git chỉ chia sẻ schema/migration/code; database local và dữ liệu đăng ký trên máy
một người không đồng bộ sang máy đồng đội. Không có tài khoản/mật khẩu mặc định
được seed; mỗi người tạo user thử qua frontend hoặc script demo.

## Demo UI cho nhóm

1. Đăng ký bằng email thử mới, họ tên tiếng Việt và mật khẩu ít nhất 12 ký tự.
   Thành công dẫn tới đăng nhập, không tự tạo phiên.
2. Thử email đã có, email sai và mật khẩu ngắn. Lỗi nằm cạnh trường; không tạo
   thêm user. Thử đăng nhập sai mật khẩu rồi đúng mật khẩu.
3. Ở account, sửa họ tên và lưu. Tên/avatar nhận user thật. Reload để thấy phiên
   được khôi phục; không cần đăng nhập lại.
4. Mở account trong tab thứ hai, logout ở tab thứ nhất. Hai tab về login, thông
   tin riêng biến mất. Workspace công khai trở lại Khách.
5. Mở Swagger qua frontend, Try it out register/login rồi dùng accessToken trong
   Authorize để thử GET/PATCH. Refresh/logout dùng cookie browser tự quản lý.
   Xem [hướng dẫn Swagger](openapi.md) để thực hiện đúng thứ tự.
6. Chạy `npm run test:t01` để minh chứng reuse, refresh đồng thời, JWT hết hạn,
   tài khoản khóa, logout chen refresh, đổi user khi request chờ và cookie HTTPS.

Không quay/chụp tab Network, header Authorization, cookie, password hoặc response
login đầy đủ vào minh chứng. Ảnh Swagger tự động được chụp trước khi nhập Bearer.

## Demo HTTP tự động

API cần đang chạy, PostgreSQL/migration sẵn sàng:

```powershell
npm run demo:auth
```

Script tạo **một tài khoản thử mới** với email/mật khẩu ngẫu nhiên, chạy đăng ký,
trùng email, sai mật khẩu, login, đọc/sửa hồ sơ Unicode, refresh, logout và các yêu cầu
sau logout/Origin sai. Chỉ in tên bước và status, kết thúc bằng DEMO_T01_OK.
Không in credentials/token/cookie, không reset/xóa user khác. User thử và lịch sử
session đã logout vẫn còn trong database; script không seed tài khoản dùng chung.
Mật khẩu thử không được xuất, vì vậy dùng tài khoản riêng tạo qua UI để demo giao diện.

Để chọn API/Origin khác, đặt hai biến public rồi chạy lại:

```powershell
$env:STREAMORA_DEMO_API_URL = 'https://api.staging.streamora.example/api/v1'
$env:STREAMORA_DEMO_ORIGIN = 'https://app.staging.streamora.example'
npm run demo:auth
```

Thay các host `.example` bằng staging thật. Script không tắt kiểm tra TLS và không
theo redirect; dùng trực tiếp URL HTTPS đúng. Với local mặc định, không cần đặt biến.
Sau khi thử host khác, bỏ hai biến hoặc mở terminal mới trước khi demo local.

## Chủ module tích hợp

- Backend import SessionSecurityModule, gắn RequireAuth và lấy CurrentAuth. Kiểm tra
  membership/role/tài nguyên của module tại server. Auth decorator/Swagger metadata
  không thay thế guard. Xem [quy ước backend](backend-conventions.md).
- Frontend dùng apiRequest từ `@/lib/api`, useAuth và RequireSession. Dùng PageShell,
  FormField, SubmitButton, trạng thái chung và useToast. Xem
  [quy ước frontend](../../frontend/docs/frontend-conventions.md) và
  [quản lý phiên](../../frontend/docs/session.md).
- Dùng kiểu request/response từ `@streamora/contracts`. Thành công theo resource,
  lỗi có code/message/details/requestId; không bọc lại thành shape khác ở từng module.
- T01 cung cấp auth session và globalRole. OWNER/HOST/VIEWER theo group, thu hồi
  quyền LiveKit/Socket.IO, upload/media và rate limit phân tán thuộc task khác.

## Staging cho owner hạ tầng

Template: `backend/.env.staging.example`, `frontend/.env.staging.example`.
Inject DATABASE_URL, ACCESS_TOKEN_SECRET ngẫu nhiên riêng, WEB_ORIGIN HTTPS,
AUTH_COOKIE_SECURE=true, SameSite và API_DOCS_ENABLED theo quyết định nhóm.
Không đưa khóa backend vào biến NEXT_PUBLIC hoặc image frontend.

Inject NEXT_PUBLIC_API_URL HTTPS **trước build** frontend. NODE_ENV=production;
file `.env.staging` không tự được Next.js hoặc backend nạp. Tại checkout deployment:

```powershell
# Environment/secrets đã được deployment cấp trước các lệnh này.
npm ci
npm run db:migrate
npm run build:contracts
npm run build --workspace=@streamora/api
npm run build --workspace=@streamora/web
```

Chạy backend `npm run start --workspace=@streamora/api` và frontend
`npm run start --workspace=@streamora/web` dưới process/container manager.
Runtime giữ các workspace/runtime dependencies, contracts/dist và backend/dist;
không chỉ copy riêng main.js. Build cần cả dev dependencies/generator; nếu làm image
nhiều stage thì prune runtime sau build. Backend nghe API_HOST=0.0.0.0 phía mạng nội bộ,
reverse proxy cấp HTTPS, giữ Origin/Cookie/Set-Cookie/Path và không cache auth/profile.

Lưu ý topology proxy, giới hạn theo tiến trình và kiểm tra domain/cookie thật trong
[hướng dẫn session security](session-security.md). Việc cấp database/domain/TLS,
deploy staging, thiết lập trusted proxy và bộ đếm phân tán cần owner hạ tầng.

Sau deploy, thử health, login/reload, profile update, logout hai tab, cookie Secure,
Origin không hợp lệ và các API cần guard. Xác nhận docs 404 nếu để tắt. Đính kèm
URL build/commit, kết quả smoke test và ảnh demo không chứa credentials vào PR.
Kết quả và phạm vi triển khai nằm trong [báo cáo bàn giao](t01-delivery-report.md).
Staging công khai của nhóm vẫn cần hạ tầng/domain/tài khoản deployment.

## Review và bàn giao PR

Nội dung PR tại [t01-pr.md](t01-pr.md). Chọn nhánh codex/t01-auth-handoff lên main
theo default branch của repository vì workbook chưa ghi nhánh đích. Trạng thái/URL
PR được cập nhật trong [báo cáo bàn giao](t01-delivery-report.md). Đính kèm kết quả
nghiệm thu và bổ sung minh chứng staging chung khi nhóm deploy.
PR #1 bàn giao T01 đã được merge trên GitHub; phần sửa Try it out Auth nằm trong
draft PR #2, nội dung review được cập nhật theo phạm vi bản sửa này.

Reviewer cần xác nhận: backend đúng thư mục; migration chạy trên DB trống; DTO
không nhận trường nâng quyền; Argon2id và refresh hash; transaction rotation/reuse;
guard kiểm tra session; cookie/Origin đúng; log không lộ secrets; FE không lưu token;
request cũ không ghi nhầm user; OpenAPI khớp source. Dùng
[tiêu chí nghiệm thu](t01-acceptance.md) để đối chiếu bằng kiểm thử.

Trước khi đưa thay đổi vào PR, kiểm tra git diff và chỉ thêm source, templates,
migration, lockfile, spec, test và tài liệu cần bàn giao. Các file env thực,
node_modules, generated Prisma, dist, .next, ảnh/test artifacts và database không
được đưa lên repo. Không tự cập nhật Job.xlsx thành Hoàn thành khi còn thiếu review,
staging và minh chứng demo/PR của nhóm.
