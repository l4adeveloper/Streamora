# Thử API tài khoản và phiên T01

Chạy PostgreSQL và `npm run dev:api` trước. Nếu server đang chạy bản code cũ,
Ctrl+C rồi chạy lại; lệnh dev hiện không tự reload TypeScript.
Tất cả đường dẫn dưới đây có tiền tố `http://127.0.0.1:4000/api/v1`.
Từ mục 6 có thể thử qua `/register`, `/login`, `/account` tại frontend;
xem [hướng dẫn giao diện](../../apps/web/README.md).

Từ mục 4, mọi request nhận header `X-Request-ID`. Body lỗi có cùng `requestId`;
lỗi DTO bổ sung `error.details.fields` với `field`, `code`, `message` để frontend
hiển thị theo trường. Không đổi body thành công của sáu API.
Kiểu dữ liệu import từ `@streamora/contracts`; xem [quy ước dùng chung](backend-conventions.md).

## Sáu API

1. `POST /auth/register`: body `{email,password,fullName}`, trả 201 `{user}`.
   Email trim/lowercase; họ tên trim; mật khẩu 12–128 ký tự và giữ nguyên khoảng trắng.
   Trùng email trả 409 EMAIL_EXISTS; đăng ký không tự đăng nhập.
2. `POST /auth/login`: body `{email,password}`, trả 200 `{accessToken,expiresIn,user}`,
   đồng thời Set-Cookie refreshToken. Sai thông tin trả 401 INVALID_CREDENTIALS;
   tài khoản bị khóa trả 403 USER_DISABLED sau khi kiểm tra đúng mật khẩu.
3. `POST /auth/refresh`: không body; gửi refresh cookie. Trả 200 `{accessToken,expiresIn}`
   và thay cookie. Token cũ bị dùng lại trả 401 REFRESH_REUSED và thu hồi cả family;
   token sai/hết hạn hoặc phiên đã thu hồi trả 401 REFRESH_EXPIRED.
4. `POST /auth/logout`: không body; gửi refresh cookie. Trả 204, thu hồi phiên hiện tại,
   xóa cookie. Gọi lại hoặc không có cookie vẫn 204; phiên ở thiết bị khác còn hoạt động.
5. `GET /users/me`: Bearer access token; trả 200 `{user}`.
6. `PATCH /users/me`: Bearer access token, body `{fullName}`; trả 200 `{user}` mới.
   Không nhận email, password, globalRole hoặc trường bổ sung.

User public chỉ gồm `{id,email,fullName,globalRole}`. Không trả passwordHash,
refresh token, sessionId hoặc lịch sử token trong JSON.
JWT có `sid` để backend đối chiếu session; logout/reuse làm access token cũ bị từ chối.
Auth/profile trả Cache-Control no-store. Lỗi theo `{error:{code,message},requestId}`.

Mọi POST `/auth/*` phải có header `Origin` khớp WEB_ORIGIN (local mặc định
`http://127.0.0.1:3000`), kể cả khi thử bằng Postman/PowerShell. Thiếu/sai Origin trả
403 ORIGIN_NOT_ALLOWED, không thay đổi phiên/cookie. GET/PATCH hồ sơ dùng Bearer;
cookie đơn thuần không đủ xác thực hồ sơ.

Giới hạn hiện tại theo IP và tiến trình: register 20 request/15 phút, login 30 request/phút,
tính cả request lỗi; vượt ngưỡng trả 429 RATE_LIMITED và Retry-After. Bộ đếm chung cho
nhiều instance sẽ cần Redis/gateway khi triển khai hạ tầng.

## PowerShell: thử toàn bộ luồng

Chạy các đoạn dưới trong một terminal mới. Dùng email thử nghiệm riêng trên database local.
Thay mật khẩu mẫu nếu cần; không in biến `$login`/`$fresh` vì chúng chứa access token.
Các request JSON bên dưới chỉ định UTF-8 và gửi byte UTF-8 để giữ nguyên tiếng Việt
trên cả Windows PowerShell và PowerShell mới. Không chỉ đổi encoding hiển thị terminal:
nếu tên đã gửi sai thì cần PATCH lại bằng dữ liệu đúng.

```powershell
$api = 'http://127.0.0.1:4000/api/v1'
$originHeaders = @{ Origin = 'http://127.0.0.1:3000' }
$webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$email = 'demo@example.test'
$password = 'Change-this-test-password-123!'

$registerBody = @{ email = $email; password = $password; fullName = 'Người dùng thử' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/auth/register" -Headers $originHeaders -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($registerBody))

$loginBody = @{ email = $email; password = $password } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -Headers $originHeaders -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($loginBody)) -WebSession $webSession

$bearer = @{ Authorization = "Bearer $($login.accessToken)" }
Invoke-RestMethod -Uri "$api/users/me" -Headers $bearer

$profileBody = @{ fullName = 'Họ tên đã cập nhật' } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri "$api/users/me" -Headers $bearer -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($profileBody))

$fresh = Invoke-RestMethod -Method Post -Uri "$api/auth/refresh" -Headers $originHeaders -WebSession $webSession
$bearer = @{ Authorization = "Bearer $($fresh.accessToken)" }
Invoke-RestMethod -Uri "$api/users/me" -Headers $bearer

Invoke-RestMethod -Method Post -Uri "$api/auth/logout" -Headers $originHeaders -WebSession $webSession
```

Sau logout, gọi lại GET `/users/me` bằng `$bearer` cũ sẽ trả 401 UNAUTHENTICATED.
Để xem đủ trường thay vì bảng bị rút gọn, dùng `Invoke-RestMethod -Uri "$api/users/me" -Headers $bearer | ConvertTo-Json -Depth 3` khi phiên còn hiệu lực.
Chạy lại register với cùng email trả 409; bỏ qua bước đăng ký nếu tài khoản đã có.
Các request refresh đồng thời phải được frontend gom thành một; hiện policy thu hồi
cả family nếu một token bị dùng hai lần, kể cả do hai tab/request cùng gửi.

## Kiểm thử tự động

```sh
npm run test:backend
npm run test:database
```

Integration tests dùng database tạm riêng và dọn sau khi chạy. Không thêm user demo
vào database ứng dụng, không reset/truncate dữ liệu local.
Swagger đã có ở `/api/v1/docs`, JSON ở `/api/v1/docs-json`; xem
[cách dùng và xuất OpenAPI](openapi.md). Có thể chạy `npm run demo:auth` khi API đang
hoạt động; script dùng email/mật khẩu ngẫu nhiên và chỉ in tên bước/status.

Thư viện: [node-argon2](https://github.com/ranisalt/node-argon2),
[jsonwebtoken](https://github.com/auth0/node-jsonwebtoken).
Encoding request theo [tài liệu Invoke-RestMethod của Microsoft](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-restmethod#-contenttype).
