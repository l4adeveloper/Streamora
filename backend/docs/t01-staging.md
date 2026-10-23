# HTTPS staging local cho T01

Môi trường chạy tại **https://localhost:8443**, chỉ truy cập trên máy đang chạy
Docker. Đây là bản chạy production trên máy cá nhân để demo và kiểm tra cấu hình;
chưa phải staging công khai hoặc staging chung của nhóm. Certificate tự ký có hạn
30 ngày; trình duyệt thông thường sẽ báo chưa tin cậy. Không cài certificate vào
Windows hoặc tắt kiểm tra TLS toàn hệ thống.

## Chạy

Cần Docker Desktop, Node.js và OpenSSL. Trên Windows dùng OpenSSL đi kèm Git for
Windows; có thể chỉ định STREAMORA_TEST_OPENSSL nếu cài ở vị trí khác.

```powershell
npm run staging:setup
npm run staging:up
```

Lệnh setup tạo `infra/docker/staging/.env` với mật khẩu/khóa ngẫu nhiên riêng và
certificate/key tại `infra/docker/staging/tls/`; giữ file đã có. Cả hai đều được
gitignore và loại khỏi build context. Không thay `.env`, `backend/.env` hay
`frontend/.env.local` đang dùng cho development. Không đổi mật khẩu sau khi đã có
volume trừ khi đồng thời đổi role PostgreSQL đúng quy trình.

Compose project `streamora-t01-stage` gồm PostgreSQL, migration một lần, API, Next.js
production và nginx HTTPS. PostgreSQL dùng database `streamora_staging` và volume
`streamora-t01-stage_stage-postgres`, không dùng volume/database development.
Chỉ nginx được publish tại `127.0.0.1:8443`; API/web/database không mở port host.

API chạy NODE_ENV=production, cookie Secure/HttpOnly/SameSite=Lax, WEB_ORIGIN chính
xác `https://localhost:8443`. Frontend build với NEXT_PUBLIC_API_URL=/api/v1, truy
cập API qua cùng origin. Proxy giữ Origin/Cookie/Set-Cookie; không cache auth.
Swagger tắt. Đường dẫn kiểm tra: `/login`, `/register`, `/account`, `/api/v1/health`.

Image demo giữ build tools/dependencies để chạy Prisma migration trong cùng image;
chưa tối ưu kích thước/runtime dependencies cho hạ tầng production chung. Không
push image này lên registry hoặc deploy public trong quy trình local này.

## Smoke test

Sau khi cài dependencies bằng npm ci trên host:

```powershell
npm run staging:smoke
```

Runner dùng Edge trên Windows (Chromium trên Linux nếu đã cài browser Playwright).
Ngoại lệ certificate tự ký chỉ áp dụng cho browser context tạm, cố định đích
localhost:8443. Không tắt TLS của Node hoặc hệ điều hành.

11 bước kiểm tra health HTTPS, docs production 404, guard/Origin, đăng ký qua UI,
login/Bearer/cookie Secure HttpOnly, sửa tên Unicode, reload và xoay cookie, storage
không chứa credentials, hai tab khôi phục/logout và bearer bị vô hiệu. Script tạo
một user thử ngẫu nhiên trong database staging, logout ở cuối; không in mật khẩu,
token hoặc cookie. Ảnh tài khoản demo ở `.preview/t01-staging-account.png`.

Kiểm tra trạng thái hoặc dừng, giữ dữ liệu:

```powershell
docker compose --env-file infra/docker/staging/.env -f infra/docker/staging/compose.yml ps
npm run staging:down
```

Chạy lại bằng staging:up; không dùng down -v khi cần giữ dữ liệu. Certificate hết
hạn thì lưu bản cũ ngoài Git, tạo lại cặp key/cert bằng staging:setup và recreate
proxy. Không tái sử dụng certificate/key local này cho domain public.

## Chuyển sang staging chung

Job.xlsx chưa ghi domain, nền tảng hosting, tài khoản cloud hoặc nhánh release.
T19 là owner môi trường chung. Cần deploy commit của PR lên hạ tầng nhóm, cấp
database/secrets, domain và TLS hợp lệ, cấu hình origin thực rồi chạy lại smoke
test. HTTPS local và PR chưa thay thế bước review/tích hợp staging của workbook.
Xem [báo cáo bàn giao](t01-delivery-report.md) để biết kết quả đã chạy.
