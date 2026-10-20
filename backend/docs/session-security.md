# Cookie và phiên an toàn — mục 5

Mục 3 đã triển khai hash refresh token, cookie, kiểm tra Origin và transaction xoay
token. Mục 5 chốt cấu hình local/staging, chỉ cấp CORS cho đúng origin, và kiểm tra
các hành vi đó bằng trình duyệt thật. Không có migration mới.

## Cookie và vòng đời phiên

- Refresh token ngẫu nhiên 32 byte, cookie tên `refreshToken`, HttpOnly, host-only
  (không có Domain), Path `/api/v1/auth`. Không trả refresh token trong JSON.
- Database chỉ lưu SHA-256 của token. Mật khẩu dùng Argon2id riêng; không dùng
  SHA-256 để hash mật khẩu. API public không trả passwordHash hoặc dữ liệu phiên.
- Local HTTP: Secure=false, SameSite=Lax. Staging HTTPS: Secure=true, SameSite=Lax
  khi FE/API cùng site. Max-Age/Expires bám theo hạn tuyệt đối của phiên, mặc định
  7 ngày. Refresh không gia hạn phiên.
- Mỗi refresh đánh dấu token cũ đã dùng rồi tạo hash token mới trong cùng transaction.
  Khóa user và unique index bảo đảm một token không sinh hai nhánh hợp lệ. Reuse
  thu hồi cả family rồi trả 401 REFRESH_REUSED, kể cả hai request đồng thời hợp lệ.
- Logout thu hồi phiên hiện tại; access token đã cấp của phiên cũng bị guard từ chối.
  Cookie được xóa với cùng name, host/path và các thuộc tính như khi đặt.
- Refresh lỗi 401/403 xóa cookie. Origin sai bị chặn trước xử lý và không xóa cookie
  hoặc thay đổi phiên. Lỗi tạm thời 500/503 không chủ động xóa cookie còn hạn.
- Auth/profile trả Cache-Control=no-store và Pragma=no-cache; không dùng GET cho
  refresh/logout. Không ghi token/cookie/body hoặc nguyên exception vào log.

HttpOnly chặn JavaScript đọc cookie; browser vẫn gửi cookie với fetch phù hợp.
Cookie không phân biệt port; Path chỉ giới hạn việc gửi theo URL, không thay thế
kiểm tra quyền. Xem [Set-Cookie của MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

## CORS, credentials và CSRF

FE dùng `credentials: "include"` cho login/refresh/logout và khi cần nhận cookie.
Access token giữ trong bộ nhớ, gửi Bearer cho API được bảo vệ. Không dùng localStorage
để giữ refresh token hoặc lưu toàn bộ response đăng nhập.

CORS chỉ cho đúng WEB_ORIGIN; không wildcard, không tự phản chiếu Origin người gọi.
Cho credentials và expose X-Request-ID, Retry-After. Set-Cookie là header browser
không cho JS đọc dù cookie đã được lưu. Xem [CORS của MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

Mọi POST auth (kể cả login/register) phải có Origin khớp chính xác WEB_ORIGIN;
Origin thiếu, `null`, origin lạ hoặc có dấu `/` cuối đều trả 403 ORIGIN_NOT_ALLOWED.
Không fallback sang Referer. CORS chặn đọc response và preflight từ origin lạ,
còn Origin guard chặn tác dụng phụ của simple request/form dùng cookie.
Policy này áp dụng cả khi SameSite=None; các endpoint dùng cookie mới phải gắn
cùng Origin guard. API dùng Bearer không tự lấy danh tính từ refresh cookie.

Frontend mục 7 đã gom refresh trong tab và dùng Web Locks giữa các tab cùng origin;
xem [hướng dẫn tích hợp phiên](../../apps/web/docs/session.md).
Nếu tự gửi hai refresh với cùng cookie, policy hiện tại chủ động thu hồi family.

## Local

Các file hiện tại do `npm run setup:env` tạo đã có cấu hình phù hợp:

```dotenv
# backend/.env
WEB_ORIGIN=http://127.0.0.1:3000
AUTH_COOKIE_SECURE=false
AUTH_COOKIE_SAME_SITE=lax

# apps/web/.env.local (public only)
NEXT_PUBLIC_API_URL=http://127.0.0.1:4000/api/v1
```

Dùng nhất quán 127.0.0.1 cho cả hai phía. Chạy PostgreSQL, migration, API và frontend
theo backend/README.md. Dừng API đang chạy rồi `npm run dev:api` để nạp cấu hình/code mới.
Không cần sửa mật khẩu, tạo lại database hay xóa volume cho mục này.

## Staging

Hai template được commit:

- `backend/.env.staging.example`: NODE_ENV=production, API_HOST=0.0.0.0,
  WEB_ORIGIN HTTPS chính xác, Secure=true, SameSite=Lax.
- `apps/web/.env.staging.example`: API URL HTTPS có `/api/v1`, chỉ có biến public.

Địa chỉ `.example` là placeholder; thay bằng host thật khi nhóm dựng staging.
Inject khóa JWT ngẫu nhiên riêng và DATABASE_URL bằng environment/secret của deployment.
Không dùng khóa/mật khẩu local, không đưa backend/.env vào image. Template khóa chưa
thay bị bộ kiểm tra env từ chối. Chạy cùng migration đã commit trên database staging.

Ví dụ `https://app.staging.streamora.example` và `https://api.staging.streamora.example`
khác origin nhưng cùng site nên dùng Lax. Nếu hai domain thực sự khác site, dùng
SameSite=None và Secure=true; Origin guard vẫn bắt buộc. Trình duyệt/chính sách có thể
chặn third-party cookie; cần kiểm tra trên domain thật hoặc chọn cùng site/proxy.

Reverse proxy cung cấp HTTPS/cert hợp lệ, giữ nguyên Origin, Cookie và Set-Cookie,
giữ đường dẫn `/api/v1/auth`; không rewrite cookie thành Domain/Path rộng hơn,
không cache auth/profile, không mở cổng HTTP nội bộ của API ra Internet.
Server mặc định chưa tin X-Forwarded-For; owner hạ tầng cần cấu hình trusted proxy
và rate limit phân tán theo topology thật trước khi triển khai nhiều instance.

Next.js dùng NODE_ENV=production cho staging. `.env.staging.example` không được
Next.js hoặc backend tự nạp. Inject NEXT_PUBLIC_API_URL trước khi build frontend;
biến NEXT_PUBLIC được đóng vào bundle. Các file `.env.staging` thực đã gitignore.
Backend đọc environment do deployment cấp trước các giá trị file local.

## Kiểm thử trình duyệt

Không cần chạy Next.js hoặc dừng server của người dùng. Test tự tạo API, các origin
trắng phục vụ test và database `streamora_test_<uuid>`, dùng port ngẫu nhiên; xóa
database tạm, browser context và khóa TLS tạm khi kết thúc.

```powershell
# PostgreSQL local phải đang chạy; npm ci cần chạy sau khi pull dependency mới.
npm run test:browser
```

Windows mặc định dùng Microsoft Edge đã cài. TLS test cần OpenSSL; runner tự tìm
`C:/Program Files/Git/usr/bin/openssl.exe` hoặc `openssl` trong PATH. Nếu cần:

```powershell
$env:STREAMORA_TEST_OPENSSL = 'D:/duong-dan/openssl.exe'
```

Máy không có Edge có thể dùng Chromium của Playwright:

```powershell
npx playwright install chromium
$env:STREAMORA_TEST_BROWSER_CHANNEL = 'chromium'
npm run test:browser
```

Profile local dùng HTTP/127.0.0.1. Profile HTTPS mô phỏng staging dùng app.streamora.test
và api.streamora.test, ánh xạ loopback chỉ trong browser test; không sửa hosts của máy.
Cert tự ký sinh mới trong thư mục tạm, chỉ context test bỏ kiểm tra chứng chỉ; không
tắt CORS, SameSite hoặc web security. Không tạo trace/storageState chứa token.

Test xác nhận:

1. HttpOnly ngay trên host/path cookie; host-only, Path, expiry và không lộ Set-Cookie.
2. credentials=include nhận/gửi cookie; omit không nhận/gửi/xóa cookie đang lưu.
3. Refresh thay cookie, giữ hạn tuyệt đối và lưu đúng hash phía server; reload vẫn refresh được.
4. Origin khác port cùng site cũng bị chặn; form/simple request không logout/refresh được,
   JSON preflight bị chặn trước POST và response không được CORS chia sẻ.
5. Hai refresh đồng thời chỉ một lần thành công rồi family bị thu hồi.
6. HTTPS khác host cùng site dùng Secure/Lax; cookie không dùng cho HTTP hoặc host FE.
7. Logout, hết phiên và khóa user xóa đúng cookie; bearer cũ bị từ chối.

Đây là kiểm thử browser với topology staging mô phỏng trên máy local. Chưa xác nhận
DNS/cert/proxy hoặc chính sách cookie trên staging thật. Khi có domain, chạy lại
luồng đăng ký → login → reload/refresh → logout trong DevTools Network/Application:
kiểm tra cookie attributes, Origin, CORS và 401 sau logout; không sao chép token vào log.
