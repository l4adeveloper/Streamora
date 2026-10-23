# Báo cáo bàn giao T01 — 20/10/2026

## Đối chiếu file phân công

Đã đọc ba sheet Phan_cong, API_backend, Quy_uoc trong `docs/Job.xlsx`.
Phan_cong!O6 (PR/ghi chú của T01), M6 và N6 trống. Không có URL staging hoặc nhánh
đích được chốt. Các URL trong workbook là tài liệu tham khảo. Quy_uoc!C8 xác nhận
ngày/PR đang để trống; C9 yêu cầu review, test, tích hợp staging và minh chứng
demo/PR trước khi chọn Hoàn thành. T19 phụ trách môi trường/CI/CD chung.

Theo quyền tự tạo người dùng đã cấp, chọn nhánh `codex/t01-auth-handoff`, đích
`main` theo default branch của GitHub repository l4adeveloper/Streamora. Không tự
đổi trạng thái hoặc ghi đè file Job.xlsx. Workbook đang là file người dùng cung
cấp trong workspace, không đưa vào commit T01.

## Kết quả mục 10

- Backend ở `backend/`; AuthModule/UsersModule, migration, guard/contracts, frontend
  auth/tài khoản và nền tảng UI từ các mục trước được bàn giao cùng nhau.
- Swagger development: http://127.0.0.1:3000/api/v1/docs sau khi chạy lại API/frontend.
  Sáu operation T01-01…06; JSON ở /api/v1/docs-json và bản export
  `backend/docs/openapi.json`. Docs mặc định tắt ở production. Cả sáu API có Try it
  out qua proxy frontend; POST auth giữ kiểm tra Origin và cookie HttpOnly thực.
- Có lệnh docs:api, docs:api:check và demo:auth; tài liệu setup, tích hợp, demo,
  staging và nội dung PR đã được viết. Không lưu credentials vào spec hoặc Git.
- HTTPS staging **local**: https://localhost:8443; Compose project riêng
  streamora-t01-stage. Database/volume riêng, cookie Secure, frontend build
  production, nginx cùng origin và Swagger tắt. Certificate tự ký 30 ngày.
  Không có URL public: repository/workbook không cung cấp tài khoản hosting,
  domain hoặc hạ tầng cloud. Chưa deploy Internet, chưa tạo chi phí cloud.

## Bằng chứng kiểm tra

- `npm run test:t01`: exit 0; **84/84** pass, fail/cancelled/skipped/todo đều 0,
  thời gian khoảng 170 giây. Gồm 18 unit/config, 30 API/database, 7 browser và
  29 frontend/session. Typecheck mọi workspace đạt; Next production build và
  PostgreSQL thật dùng môi trường tạm được dọn sau test.
- `node backend/scripts/export-openapi.cjs --check`: OpenAPI khớp source.
- `npm ci --dry-run --ignore-scripts --no-audit --no-fund`: lockfile hợp lệ.
- Kiểm tra file staged không có env thật, TLS key hoặc giá trị secrets local.
  diff --check còn một cảnh báo dòng trống cuối migration ban đầu; giữ nguyên
  migration đã áp dụng để bảo toàn checksum, không ảnh hưởng SQL/thực thi.
- npm install cuối của mục Swagger báo 0 vulnerabilities; js-yaml dùng bản vá
  5.4.2 qua override, ghi lý do trong openapi.md. Đây là kết quả tại thời điểm chạy.
- `npm run staging:up`: exit 0; build API/Next production trong Docker thành công,
  migration trên DB staging trống thành công; postgres/api/web healthy, proxy chạy.
- `npm run staging:smoke`: exit 0; **11/11 bước đạt** trên Edge qua nginx HTTPS,
  gồm đăng ký/login/sửa hồ sơ Unicode/reload/rotation/logout hai tab, guard/Origin,
  cookie Secure HttpOnly và Swagger production 404.
- Đã commit/push lên nhánh codex/t01-auth-handoff và mở
  [PR #1](https://github.com/l4adeveloper/Streamora/pull/1) vào main.
  GitHub hiện xác nhận PR này đã merge, merge commit c052b90.
  Minh chứng Docker/HTTPS local ở trên ứng với phần triển khai `910f918`.
  Bổ sung Try it out Auth qua proxy frontend có kiểm thử Next production riêng và
  nằm trong [draft PR #2](https://github.com/l4adeveloper/Streamora/pull/2), chờ review,
  chưa merge. Image HTTPS local trước đó chưa rebuild; staging vẫn tắt Swagger.

Log/ảnh local trong `.preview/`, không đưa vào Git. Các file .env thật, TLS key,
generated Prisma, node_modules, dist/.next và database đều không được commit.
Database development `streamora` và tài khoản demo có sẵn không bị reset hoặc sửa
trong nghiệm thu; smoke staging chỉ tạo user ngẫu nhiên trong database riêng.

## Phần còn lại của nhóm

Review draft PR #2 sửa Swagger, tích hợp các API nghiệp vụ với guard, triển khai commit lên
staging chung có domain/TLS thật và bổ sung minh chứng vào quy trình T19/T20.
Chỉ cập nhật T01 thành Hoàn thành sau khi đủ điều kiện workbook. PR #2 giữ draft,
không merge tự động. Hướng dẫn chạy: [t01-handoff.md](t01-handoff.md) và
[t01-staging.md](t01-staging.md).
