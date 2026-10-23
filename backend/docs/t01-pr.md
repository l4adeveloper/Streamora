# Sửa Swagger Auth chưa có Try it out

Swagger chỉ bật Execute cho GET/PATCH, khiến bốn API Auth không có Try it out.
Bật POST và cookie credentials; bổ sung proxy Next.js để Swagger mở tại origin
frontend và thực thi đủ sáu API mà vẫn giữ nguyên AuthOriginGuard.

## Thay đổi

- Swagger hỗ trợ GET/POST/PATCH, cookie HttpOnly do browser tự gửi/nhận và xoay.
- Next rewrite `/api/v1/*` tới NEXT_PUBLIC_API_URL tuyệt đối. Swagger dùng server
  `/`, nên Origin là frontend, đúng WEB_ORIGIN. URL tương đối `/api/v1` trong
  Compose không tạo rewrite; nginx đã xử lý proxy.
- Không tự refresh/Authorize, không giữ Bearer sau reload. GET/PATCH dùng token
  người thử nhập vào Authorize. Origin sai vẫn bị chặn ở cả API và proxy.
- Cập nhật đặc tả export, URL/hướng dẫn demo, nghiệm thu và báo cáo bàn giao.
  Không có migration hoặc thay đổi dữ liệu ứng dụng.

## Validation

`npm run test:t01`: **84/84 pass** ngày 20/10/2026, exit 0; không có
fail/cancelled/skipped/todo. Typecheck mọi workspace đạt.

Test mới build Next production, mở Swagger trên Edge và Execute đủ register,
login, GET/PATCH profile, refresh và logout với API/PostgreSQL thật trong DB tạm.
Kiểm tra Origin gốc, cookie HttpOnly xoay/xóa, bearer sau logout 401, Origin API
bị từ chối cả khi qua proxy, storage không chứa credentials và reload xóa Authorize.
Test Swagger trên host API chờ DOM render trước khi kiểm tra nút POST.
OpenAPI export/check khớp source. Chi tiết: backend/docs/t01-acceptance.md.

## Chạy thử

Restart hai terminal `npm run dev:api` và `npm run dev`, mở
http://127.0.0.1:3000/api/v1/docs. Register/login rồi chép accessToken vào Authorize
để thử GET/PATCH; refresh/logout dùng cookie tự động, không có body.

Trang trực tiếp ở port 4000 vẫn xem tài liệu được nhưng POST auth trả 403 do Origin
khác WEB_ORIGIN. Docs vẫn mặc định tắt ở production. Image HTTPS local trước đó
không tự rebuild theo thay đổi này; cấu hình staging vẫn tắt Swagger.

## PR

[Draft PR #2](https://github.com/l4adeveloper/Streamora/pull/2):
codex/t01-auth-handoff → main. GitHub xác nhận PR #1 bàn giao T01 trước đó đã merge;
PR #2 chỉ chứa phần sửa Swagger và minh chứng liên quan, giữ draft chờ review.
