# Swagger và OpenAPI T01

Sau khi pull dependency mới, chạy `npm ci` ở gốc repo. Dừng API bản cũ bằng Ctrl+C
và chạy lại `npm run dev:api` để nạp code mới. Backend hiện không tự reload TypeScript.

- Swagger UI local: `http://127.0.0.1:4000/api/v1/docs`
- OpenAPI JSON: `http://127.0.0.1:4000/api/v1/docs-json`
- Bản xuất để review/import: [openapi.json](openapi.json)

Tài liệu có đúng sáu API Auth/Users của T01 với request DTO, constraint, public user,
response, error, Origin, Bearer, refresh cookie và header liên quan. Các API nghiệp vụ
demo chưa thuộc bản đặc tả này. Paths đã chứa `/api/v1`; server `/` là gốc host API,
không thêm `/api/v1` lần nữa. Khi import file vào công cụ khác, đặt server thành host
API tương ứng, ví dụ `http://127.0.0.1:4000`.

## Thử trên giao diện

GET/PATCH `/users/me` có Try it out. Mở Authorize, chỉ nhập **access token** của tài
khoản thử vào mục accessToken, bấm Authorize rồi Close. Không thêm chữ `Bearer`.
Token chỉ nằm trong bộ nhớ trang Swagger; reload sẽ xóa trạng thái Authorize.
Swagger không tự refresh, không đồng bộ phiên với frontend và không cần refresh cookie
để đọc/sửa hồ sơ. Không nhập refresh token vào hộp Authorize.

Các POST auth có đầy đủ mô tả nhưng không có Try it out trên Swagger. Trang Swagger
ở origin API `http://127.0.0.1:4000`; frontend ở `http://127.0.0.1:3000`. Browser
tự gửi Origin của trang hiện tại, trong khi POST auth yêu cầu đúng WEB_ORIGIN.
Giữ nguyên guard này; không thêm origin API hoặc wildcard vào allowlist để thử Swagger.
Dùng [frontend](../../apps/web/README.md), [PowerShell](auth-api.md) hoặc
`npm run demo:auth` để chạy POST auth đúng hợp đồng. POST login trực tiếp từ origin
Swagger vẫn bị 403 ORIGIN_NOT_ALLOWED.

Ví dụ nếu đã chạy login theo hướng dẫn PowerShell, access token là biến
`$login.accessToken`; không in cả response/login ra log hoặc đưa token vào ảnh demo.
Sau khi thử xong, chạy logout với chính WebSession đã login và reload Swagger.
Đăng nhập bằng PowerShell và frontend tạo các session riêng; logout một session
không thay thế logout trên thiết bị/session khác.

## Bật/tắt theo môi trường

`API_DOCS_ENABLED` chỉ nhận `true` hoặc `false`:

- Development: mặc định true, kể cả file env cũ chưa có biến này.
- Test và production: mặc định false. Template staging để false rõ ràng.
- Có thể bật rõ ràng ở staging nếu nhóm muốn cung cấp tài liệu tại host API đó.

Tắt docs sẽ không đăng ký UI, JSON hoặc static assets của Swagger. Raw YAML không
được phục vụ. UI/assets dùng package local, không CDN; validator bên ngoài và cấu
hình qua query được tắt. Spec URL cố định cùng host. Auth/profile/docs trả no-store.

## Xuất và kiểm tra đặc tả

Tại gốc repository:

```powershell
npm run docs:api
npm run docs:api:check
```

Lệnh đầu build backend rồi xuất `backend/docs/openapi.json` từ controller/DTO.
Lệnh check build backend rồi so sánh nội dung đặc tả với source, trả exit code khác 0
nếu file thiếu/cũ. Xuất/check không đọc env local, không init Prisma và không mở cổng
HTTP, nên không cần PostgreSQL hoặc credentials thật. Cấu hình nội bộ chỉ là giá trị
giả cho việc dựng metadata; không được dùng để chạy API.

Đổi endpoint, DTO, status, security hoặc error cần cập nhật decorator, chạy export
và đưa spec đã sinh vào cùng PR. `npm run test:t01` tự kiểm tra spec không bị cũ,
response thật khớp schema, chế độ production tắt docs và Swagger UI qua Edge.

Các schema response có class riêng trong `src/documentation/api-models.ts`,
implements contracts TypeScript để giữ đồng bộ kiểu. Validation nghiệp vụ vẫn do
class-validator/guard/service thực hiện; decorator Swagger không cấp quyền.

## Dependency

Giữ Swagger 11.4.7 tương thích NestJS 11. Root có cùng devDependency Swagger và
override `js-yaml=5.4.2`: cần dependency gốc để npm áp dụng override qua workspace
link trên phiên bản npm hiện tại. Backend vẫn khai báo Swagger là runtime dependency.
Không gỡ riêng khai báo gốc/override khi nâng dependency. Xem
[npm workspace override issue](https://github.com/npm/cli/issues/9659) và
[bản vá YAML](https://github.com/advisories/GHSA-r3ph-w7gj-g6xm).

Sau khi cập nhật dependency, kiểm tra `npm ls @nestjs/swagger js-yaml --all`,
`npm audit` và nghiệm thu T01. Không dùng audit fix --force để tự nâng major NestJS.
Hướng dẫn API dựa trên [Nest OpenAPI](https://docs.nestjs.com/openapi/introduction),
[security](https://docs.nestjs.com/openapi/security) và
[schemas](https://docs.nestjs.com/openapi/types-and-parameters).
