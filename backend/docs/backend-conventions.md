# Quy ước dùng chung sau mục 4

Mã backend đặt trong `backend/src`, theo module tại `modules/`.
Frontend ở `frontend`; hợp đồng public ở `packages/contracts`.
Mục này không thay đổi schema/migration hoặc dữ liệu local.

## Dùng xác thực trong module khác

Module nghiệp vụ import `SessionSecurityModule` từ
`modules/auth/session-security.module.ts` để Nest inject guard và dịch vụ phiên.
Ứng dụng gốc đã đăng ký ConfigurationModule và DatabaseModule.

```ts
import { Controller, Get, Module } from "@nestjs/common";
import { SessionSecurityModule } from "../auth/session-security.module";
import { CurrentAuth, RequireAuth } from "../../common";
import type { AuthenticatedIdentity } from "../../common";

@Controller("example")
@RequireAuth()
class ExampleController {
  @Get("me")
  me(@CurrentAuth() identity: AuthenticatedIdentity) {
    return { user: identity.user };
  }
}

@Module({
  imports: [SessionSecurityModule],
  controllers: [ExampleController],
})
export class ExampleModule {}
```

`RequireAuth()` dùng được ở controller hoặc method. Guard kiểm tra Bearer JWT,
claims, phiên còn hiệu lực và user chưa bị khóa. Thiếu/sai/hết hạn token hoặc phiên
đã logout trả 401; tài khoản bị khóa trả 403 USER_DISABLED.
`CurrentAuth()` cung cấp `{user,sessionId}`, không cung cấp raw token.
Nếu quên guard, decorator vẫn từ chối request vì chưa có identity.

API cộng đồng vẫn là dữ liệu mẫu công khai. T03 đã bảo vệ API phòng/tệp và realtime;
global ADMIN có quyền quản lý mọi group còn hoạt động. Module khác dùng
`GroupAccessService`/`RequireGroupAccess`, resolve groupId từ tài nguyên phía server.
Xem [hướng dẫn T03](t03-handoff.md) cho ma trận OWNER/HOST/VIEWER và thu hồi truy cập.

## Contracts và đầu vào

Import kiểu public từ `@streamora/contracts`: User, RegisterRequest, LoginRequest,
UpdateProfileRequest, RegisterResponse, LoginResponse, RefreshResponse, UserResponse,
LogoutResponse, ApiErrorResponse, CursorPage. `expiresIn` tính bằng giây; `LogoutResponse`
là void. Các kiểu này không mang dependency backend vào bundle frontend.

DTO backend implement request interface để phát hiện lệch kiểu khi build, đồng thời
dùng decorator class-validator để kiểm tra runtime. `EmailField()` và `FullNameField()`
dùng giới hạn AUTH_CONSTRAINTS và chuẩn hóa trim/lowercase theo chính sách T01.
Mật khẩu giữ nguyên ký tự/khoảng trắng. Không bật implicit conversion cho body.

Global ValidationPipe bật transform, whitelist và forbidNonWhitelisted. Các field
ngoài DTO bị từ chối, không được âm thầm dùng để cập nhật role hoặc dữ liệu riêng.
Không dùng interface TypeScript làm kiểu `@Body()` thay DTO vì không có metadata runtime.

`PaginationQueryDto` nhận `cursor?: string`, `limit` mặc định 20 và tối đa 100.
Chỉ chuyển chuỗi số nguyên thập phân dương thành number; từ chối mảng, số thập phân,
số mũ và field query ngoài DTO. Cursor tối đa 2048 ký tự, giữ nguyên để service giải mã
và kiểm tra theo từng API. Danh sách trả `{items,nextCursor}`, hết trang dùng null.
`UUIDParamPipe` kiểm tra định dạng UUID cho tham số trước khi truy vấn database.

```ts
@Get(":id")
find(@Param("id", new UUIDParamPipe()) id: string) { /* service */ }

@Get()
list(@Query() query: PaginationQueryDto) { /* service: {items,nextCursor} */ }
```

## Phản hồi và lỗi

Prefix `/api/v1`. Thành công giữ shape riêng của API, không bọc thêm `{data}`.
204 không có body. ID public dùng UUID; thời gian dùng ISO8601 UTC khi xuất JSON.
API demo cũ có thể còn `{data,demo}` đến khi owner thay hợp đồng.

Lỗi thống nhất:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Dữ liệu không hợp lệ hoặc có trường không được phép.",
    "details": {
      "fields": [
        {
          "field": "email",
          "code": "INVALID_EMAIL",
          "message": "Email không hợp lệ."
        }
      ]
    }
  },
  "requestId": "UUID do server tạo"
}
```

`details` không bắt buộc. Field lạ dùng `_form/UNEXPECTED_FIELD`, không phản chiếu
tên field người dùng gửi. Validation chỉ trả mã/thông báo tĩnh, không trả value,
DTO target hoặc message từ custom validator có thể chứa input. Tối đa 30 lỗi.

Nghiệp vụ ném `new ApiError(status, code, publicMessage, safeDetails?)` từ `common`.
Chỉ đưa dữ liệu an toàn vào publicMessage/details; không truyền nguyên request,
exception hoặc lỗi Prisma. Các HttpException thông thường giữ status nhưng nhận
mã/thông báo chung; exception không xác định trả 500 INTERNAL_ERROR.

- 400 VALIDATION_ERROR: body/query/param sai.
- 401 UNAUTHENTICATED: chưa xác thực hoặc phiên không còn hợp lệ.
- 403 FORBIDDEN/USER_DISABLED/ORIGIN_NOT_ALLOWED: thiếu quyền, khóa user hoặc sai Origin.
- 404 NOT_FOUND; 409 CONFLICT hoặc EMAIL_EXISTS; 410 GONE.
- 413 PAYLOAD_TOO_LARGE; 415 UNSUPPORTED_MEDIA_TYPE.
- 429 RATE_LIMITED kèm Retry-After khi bộ đếm auth vượt giới hạn.
- 503 SERVICE_UNAVAILABLE: lỗi phụ thuộc được nhận diện; 500 INTERNAL_ERROR cho lỗi khác.

Prisma known error unique/FK/transaction conflict được ánh xạ 409, record missing
thành 404 và các mã timeout/kết nối được nhận diện thành 503. Không trả tên bảng,
cột, query, metadata hoặc thông báo database.

## Request ID và log

Middleware tạo UUID mới cho mỗi request, bỏ qua X-Request-ID đầu vào.
Header response X-Request-ID, body lỗi requestId và log cùng một giá trị.
Frontend được CORS expose X-Request-ID và Retry-After.

Log HTTP là một dòng JSON gồm đúng event=http_request, requestId, method, route,
statusCode, durationMs. Route là mẫu tĩnh như `/api/v1/users/:id`, không phải URL
có ID/query thực; đường dẫn không khớp dùng `[unmatched]`.
Không ghi body, email, mật khẩu, token, Authorization, Cookie, Set-Cookie,
DATABASE_URL, stack trace hoặc raw exception. Prisma query logging đã tắt.
Không thêm `console.log(dto/request/error)` trong các module mới.

Đăng ký giới hạn 20 request/15 phút; đăng nhập 30 request/phút theo IP/tiến trình,
tính cả dữ liệu sai. Chưa dùng bộ đếm phân tán; deployment nhiều instance cần
owner hạ tầng thay bằng Redis/gateway và cấu hình trusted proxy.

## Kiểm tra khi sửa nền tảng

```sh
npm run test:backend
npm run test:database
npm run typecheck
```

Integration test tự tạo database tạm, áp migration rồi xóa đúng database đó.
Test một module riêng dùng SessionSecurityModule, guard và DTO qua HTTP để phát hiện
lỗi dependency injection/validation; đồng thời kiểm tra request ID, lỗi và log.
Swagger và giao diện auth thực hiện ở các mục tiếp theo.
