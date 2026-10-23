# @streamora/contracts

Hợp đồng request/response dùng chung cho `backend` và `frontend`. Package này
không phụ thuộc NestJS, Prisma, React hoặc biến môi trường server.

```ts
import type {
  RegisterRequest,
  LoginResponse,
  UserResponse,
  ApiErrorResponse,
  CursorPage,
} from "@streamora/contracts";
import { AUTH_CONSTRAINTS, PAGINATION_DEFAULTS } from "@streamora/contracts";
```

`auth.ts` định nghĩa User public, role và sáu request/response auth/hồ sơ.
`api.ts` định nghĩa lỗi/chi tiết validation và phân trang cursor.
`index.ts` giữ các kiểu demo cũ để các task khác cập nhật dần.
`GroupRole` dùng OWNER/HOST/VIEWER; `CommunityRole` cũ chỉ phục vụ demo.

TypeScript types không kiểm tra dữ liệu từ mạng khi chạy. Backend vẫn phải dùng DTO
và ValidationPipe; frontend xử lý HTTP status và `error.code`, không phân nhánh theo
nội dung tiếng Việt trong `message`. Không đưa passwordHash, refresh token, khóa ký
hoặc kiểu Prisma vào User/response public.

Build từ gốc bằng `npm run build:contracts`, sinh JavaScript CommonJS và `.d.ts`
vào `dist` đã gitignore. `npm ci` chạy prepare của workspace; các lệnh dev/build/
typecheck tại gốc và build/typecheck backend cũng biên dịch contracts trước.
Sau khi sửa contracts, chạy lại lệnh dev hoặc `npm run build:contracts`.
