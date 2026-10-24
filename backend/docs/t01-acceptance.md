# Nghiệm thu T01 trên môi trường local

Đối chiếu yêu cầu `docs/Job.xlsx`: `Phan_cong!H6:L6`,
`API_backend!A6:L11` và quy ước auth/error tại `Quy_uoc!C14:D20`.
Đây là kiểm thử tự động local, gồm Swagger/bàn giao ở mục 10. Review và tích hợp
staging chung vẫn cần hoàn tất trước khi cập nhật trạng thái toàn bộ T01 trong file phân công.

## Kết quả local ngày 20/10/2026

Đã chạy `npm run test:t01`, exit code 0. Typecheck mọi workspace đạt.
84 kiểm thử đạt: 18 unit/config, 30 API/database, 7 browser và
29 frontend/session. Không có ca fail, cancelled, skipped hoặc todo.
Frontend tests đã build production các bản sao tạm của mã nguồn hiện tại.

## Chạy toàn bộ

Tại gốc repository, dependencies và env local cần sẵn sàng theo README.
Bật Docker Desktop rồi chạy:

```powershell
docker compose --env-file .env -f backend/infra/docker/compose.yml up -d --wait postgres
npm run test:t01
```

Lệnh nghiệm thu chạy tuần tự:

1. Typecheck mọi workspace, build contracts và generate Prisma Client.
2. Build backend một lần để kiểm tra đúng mã TypeScript hiện tại.
3. Unit/config, integration API/database, cookie browser và frontend/session.

Chỉ đạt khi lệnh thoát với exit code 0 và không có test fail/cancel/skip.
Không cần chạy API/frontend bằng tay, không dùng tài khoản demo có sẵn.
Không có migration mới trong mục 9.

Windows mặc định dùng Edge. Cookie HTTPS test dùng OpenSSL từ Git for Windows
hoặc `STREAMORA_TEST_OPENSSL`. Chi tiết chọn browser và công cụ nằm trong
[kiểm thử cookie/phiên](session-security.md).

Nếu cần khoanh vùng lỗi, các lệnh riêng vẫn dùng được:

```powershell
npm run test:backend
npm run test:database
npm run test:browser
npm run test:frontend
```

Không chạy thêm các bộ trên khi `test:t01` đã đạt và mã nguồn chưa thay đổi.
Sau khi sửa lỗi, chạy lại bộ bị ảnh hưởng; chạy toàn bộ khi cần nghiệm thu bản mới.

## Tiêu chí và bằng chứng kiểm thử

1. **Đăng ký/đăng nhập thành công, chặn email trùng.**
   `test/integration/auth.test.cjs` kiểm tra chuẩn hóa email, unique dưới request
   đồng thời, password hash Argon2id với salt riêng và response chỉ chứa public user.
   `test/frontend/auth-ui.test.cjs` chạy đăng ký/đăng nhập thật, validation,
   email trùng, mật khẩu sai, Unicode và trạng thái đang gửi.

2. **Sáu API đúng hợp đồng.**
   Integration kiểm tra status/body của register, login, refresh, logout,
   GET/PATCH users/me. Patch chỉ nhận fullName, chặn email/password/globalRole.
   Guard từ module khác được kiểm tra qua FeatureModule chỉ có trong test.
   Cookie endpoints yêu cầu đúng Origin, body refresh/logout được kiểm tra runtime.

3. **Refresh rotation và phát hiện reuse.**
   Integration kiểm tra hash token trong DB, chỉ một token hiện tại, xoay vòng
   không kéo dài hạn tuyệt đối và reuse thu hồi cả family. Hai refresh đồng thời
   không tạo hai nhánh hợp lệ. Cookie/browser kiểm tra cùng hành vi qua fetch thật.

4. **Logout vô hiệu phiên.**
   Integration kiểm tra bearer/cookie cũ bị từ chối, logout lặp an toàn và không
   thu hồi session độc lập khác. Logout cạnh tranh với refresh không làm sống lại
   phiên. UI đồng bộ logout giữa các tab, xóa private state và thông báo cũ.

5. **Không đăng nhập thì không truy cập API riêng tư.**
   Integration thử thiếu bearer, JWT hết hạn/giả/sai claims, session hết hạn/thu hồi
   và decorator bị thiếu guard. UI bảo vệ account trong lúc checking và anonymous.
   Trang workspace demo vẫn có thể xem với vai trò Khách.

6. **Tài khoản khóa bị chặn cả khi đang dùng.**
   API kiểm tra login, bearer, refresh và mọi session đã có. Frontend session test
   khóa user trong DB tạm, thử sửa hồ sơ, xác nhận không ghi dữ liệu, tất cả tab
   bảo vệ về login, cookie bị xóa và bật lại user không hồi sinh session cũ.

7. **Hết phiên được xử lý hoàn chỉnh.**
   Session test hết hạn family trong DB tạm, gọi refresh từ UI, xác nhận không xoay
   token mới, không lặp refresh, cookie bị xóa, tab bảo vệ về login và trang công khai
   trở lại guest. Reload không khôi phục phiên đã hết hạn.

8. **Tự refresh/retry đúng và tránh ghi nhầm danh tính.**
   `test/frontend/session-ui.test.cjs` dùng JWT hết hạn có chữ ký đúng của fixture
   để nhận 401 thật; client refresh một lần rồi replay đúng method/body ban đầu.
   Request song song/401 đến muộn gom refresh. 403/5xx không tự replay. Các test
   đổi user, tab bỏ lỡ thông báo, logout chen refresh và giữ bản nháp khi focus
   kiểm tra giới hạn của các thao tác đang chờ.

9. **Cookie và storage.**
   `test/browser/session.test.cjs` kiểm tra HttpOnly, host-only, Path, credentials,
   Secure qua HTTPS giữa hai host same-site và xóa cookie đúng thuộc tính.
   Origin không được phép và preflight bị chặn. Frontend không lưu token/PII vào
   localStorage/sessionStorage; chỉ marker phiên công khai được lưu.

10. **Không lộ mật khẩu/token/hash trong log hoặc error.**
    `test/common.test.cjs` và `test/integration/common.test.cjs` kiểm tra allowlist
    metadata HTTP, không log body/query/header/URL thô, không echo private input,
    exception hoặc Prisma metadata. Kiểm tra token/cookie thực tế không xuất hiện
    trong log. RequestId liên kết response và log mà không tin header đầu vào.

11. **Migration và dữ liệu.**
    `test/integration/database.test.cjs` chạy migration vào DB trống, kiểm tra
    schema/index/constraints, unique email, history token và khóa ngoại. Không chỉ
    dựa vào Prisma Client generate để kết luận database dùng được.

12. **Khung chung, lỗi và khả năng phục hồi.**
    Frontend kiểm tra form/pending, toast qua điều hướng/logout, field errors của
    module, 403 giữ phiên, lỗi mạng/5xx có phản hồi, 404/render error/retry và mobile.
    Cookie và frontend tests có request lỗi được điều khiển khi cần mô phỏng mạng;
    luồng auth, profile, revoke/disabled/expiry dùng API và PostgreSQL thật.

## Cách ly và dọn dữ liệu kiểm thử

Swagger có kiểm thử đặc tả sinh offline, schema khớp sáu API thật, Origin/cookie/
Bearer, tài liệu tắt ở production và script demo 12 bước. Edge kiểm tra giao diện
Swagger, gọi GET /users/me với Bearer thật, không giữ thông tin authorize sau reload
và không gửi request ra dịch vụ ngoài. JSON đã lưu được đối chiếu với source.

`test/frontend/swagger-ui.test.cjs` build Next production và mở Swagger qua proxy
frontend, Execute đủ register/login/GET/PATCH/refresh/logout bằng UI thực. Kiểm tra
Origin gốc được giữ, cookie HttpOnly xoay/xóa, bearer sau logout bị chặn, Origin API
bị từ chối ngay cả qua proxy, storage không chứa credentials và reload xóa Authorize.

Fixture kết nối PostgreSQL local để tạo `streamora_test_<uuid>`, cần quyền CREATEDB.
Chỉ chạy migration và thay đổi user/session trong DB vừa tạo. Cleanup kiểm tra tên
DB chính xác trước DROP. Không reset hoặc xóa dữ liệu database ứng dụng `streamora`.

API và Next.js test dùng port ngẫu nhiên. Frontend được copy nguồn công khai và build
production tại `.preview/auth-frontend-run-<uuid>`, không copy env local hay đưa
secret backend vào builder/server frontend. Không ghi đè `.next` đang chạy của bạn.
Trang probe chỉ được chép vào bản build tạm, không có trong frontend bàn giao.
Browser context, server, bản sao frontend, database và TLS key tạm được dọn ở after/finally.
Ảnh kiểm tra giao diện nằm trong `.preview/`, đã gitignore.

HTTPS trong test là proxy/certificate tạm trên loopback với browser context riêng.
Nó kiểm tra thuộc tính cookie và luồng cross-origin của profile staging, không thay
cho lần triển khai/kiểm tra trên domain staging thực của nhóm.

## Kiểm tra bổ sung khi bàn giao

- Người review đối chiếu form, thông báo và navigation với giao diện hiện tại.
- Trên staging thực, đăng ký/login, reload, hai tab logout, profile update và hết
  phiên với cấu hình HTTPS, CORS, SameSite/Secure đã chốt.
- Owner API nghiệp vụ tích hợp RequireAuth trước khi nghiệm thu endpoint của họ.
  Quyền theo group và thu hồi Socket.IO/LiveKit thuộc các task tương ứng.
- Gắn minh chứng chạy test, demo/staging và PR vào quy trình của nhóm khi bàn giao.
  Không đưa file env, token, cookie hoặc dump dữ liệu thật vào minh chứng.
