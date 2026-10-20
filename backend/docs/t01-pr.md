# Triển khai tài khoản và phiên T01 với backend riêng

Ứng dụng cần tài khoản lưu bền và xác thực phiên cho các module nghiệp vụ. Bổ sung
sáu API auth/profile trong `backend/`, giao diện đăng ký/đăng nhập/tài khoản và nền
tảng dùng chung để các thành viên tích hợp xác thực, lỗi và trạng thái UI.

## Thay đổi

- Chuyển API/realtime về `backend/`, cập nhật workspaces và cấu hình local. Frontend
  giữ trong `apps/web/`; contracts dùng chung cho frontend/backend.
- PostgreSQL/Prisma với migration users, auth_sessions và lịch sử auth_refresh_tokens.
  Email chuẩn hóa/unique, mật khẩu Argon2id, refresh chỉ lưu SHA-256 trong server.
- Access JWT ngắn hạn, cookie HttpOnly xoay vòng, hạn refresh tuyệt đối, reuse thu hồi
  family và logout vô hiệu bearer ngay. Chặn tài khoản khóa và Origin không hợp lệ.
- Guard/DTO/error/log/requestId chung, rate limit login/register theo IP/tiến trình.
- Frontend khôi phục phiên, refresh/retry tối đa một lần, phối hợp nhiều tab và bỏ
  kết quả/request từ danh tính cũ. Token ở bộ nhớ; marker công khai đồng bộ tab.
- Khung trang/form/toast/loading/error dùng chung. Swagger/OpenAPI cho sáu API,
  export/check đặc tả không cần database, cùng script demo HTTP.

## Validation

```powershell
npm run test:t01
npm run docs:api:check
```

Nghiệm thu dùng database/port/browser context riêng, Next.js production build và
cookie HTTP/HTTPS thật. Có case email trùng đồng thời, rotation/reuse, logout chen
refresh, JWT giả/hết hạn, tài khoản khóa, mất mạng, nhiều tab, đổi user và log an toàn.
83/83 kiểm thử đạt ngày 20/10/2026, không fail/cancel/skip/todo.
Swagger được kiểm tra với Bearer thật, schema khớp response và docs tắt ở production.
Script demo HTTP được kiểm thử trên API/database tạm.

## Migration và cấu hình

Chạy setup:env và db:migrate theo `backend/docs/t01-handoff.md`; mỗi máy có database
local riêng. Migration chỉ tạo schema auth mới, không seed user dùng chung. Chỉ
commit env template; không chứa credentials thật. Swagger mặc định bật ở development,
tắt ở production; API_DOCS_ENABLED là lựa chọn triển khai.

API nghiệp vụ demo và realtime chưa được tự động bảo vệ bởi PR này; owner cần tích
hợp RequireAuth và quyền theo tài nguyên/group. Rate limit phân tán, trusted proxy
và môi trường staging chung thuộc bước tích hợp hạ tầng. Có Compose HTTPS local
riêng để demo production tại https://localhost:8443, database/secrets/volume riêng.

## Minh chứng khi gửi review

- Kết quả local: xem `backend/docs/t01-acceptance.md`.
- Nhánh: codex/t01-auth-handoff → main (default branch; workbook chưa chốt nhánh).
- Reviewer và staging chung: chờ nhóm; PR giữ draft, chưa tự merge.
- Draft PR: https://github.com/l4adeveloper/Streamora/pull/1.
- Docker production build/migration/health đạt; smoke HTTPS local 11/11 bước đạt
  trên Edge. Chi tiết: backend/docs/t01-delivery-report.md.
- Kịch bản demo và điểm tích hợp: `backend/docs/t01-handoff.md`.
