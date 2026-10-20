# Tích hợp quản lý phiên frontend — mục 7

AuthProvider ở root layout cung cấp useAuth cho toàn bộ ứng dụng. Backend vẫn là
nơi quyết định xác thực/phân quyền; guard giao diện chỉ điều khiển nội dung và điều hướng.
Mục này không thêm API hoặc migration mới.
Mục 8 cung cấp đầu mối `apiRequest` từ `@/lib/api` (cùng cơ chế với
authenticatedRequest) và [quy ước giao diện dùng chung](frontend-conventions.md).

## Gọi API cần đăng nhập

Dùng từ Client Component/hook hoặc module thuộc client. Các module phiên và transport
đánh dấu client-only để chặn việc import nhầm vào Server Component.

```tsx
"use client";
import { authenticatedRequest } from "@/lib/auth/session";
import type { UserResponse } from "@streamora/contracts";

async function loadProfile() {
  const { user } = await authenticatedRequest<UserResponse>("/users/me");
  return user;
}

async function updateProfile(fullName: string) {
  return authenticatedRequest<UserResponse>("/users/me", {
    method: "PATCH",
    body: { fullName },
  });
}
```

Path tính từ NEXT_PUBLIC_API_URL có `/api/v1`. GET là mặc định; hỗ trợ POST, PATCH,
PUT, DELETE và JSON body. Token được lấy tự động từ bộ nhớ tab; credentials=include
và cache=no-store. Không tự chép token vào header ngoài lớp này, query hoặc storage.
Auth login/refresh/logout đi qua authSession/useAuth để giữ đúng lock và thông báo tab.

Client chụp lại method/body trước khi chờ mạng. Nếu đã hết hạn theo expiresIn, nó
refresh trước request. Nếu server trả 401, nó gom refresh rồi thử lại cùng request
tối đa một lần. 401 cũ đến muộn dùng token mới đã có, không xoay thêm cookie.
Không tự replay lỗi kết nối, 400/403/409/429/5xx. Các API mutation vẫn cần quy ước
idempotency riêng khi nghiệp vụ yêu cầu; không tự retry write sau network error vì
không biết server đã commit hay chưa.

## Trạng thái và trang bảo vệ

```tsx
import { RequireSession } from "@/components/auth/require-session";
import { PrivateContent } from "./private-content";

export default function Page() {
  return (
    <RequireSession>
      <PrivateContent />
    </RequireSession>
  );
}
```

useAuth trả user, phase, notice và login/updateProfile/logout/retry.
phase gồm checking, authenticated, anonymous, error. Khi checking, không render dữ
liệu riêng; anonymous chuyển về `/login`; lỗi kiểm tra phiên tạm thời có nút thử lại.
RequireSession thay subtree khi user đổi, giúp xóa form/state riêng của user trước.
Backend module vẫn phải gắn RequireAuth và kiểm tra quyền nghiệp vụ/group.
Các trang demo workspace/meet/community/files vẫn công khai, có thể xem với vai trò Khách.

Profile update qua useAuth cập nhật store và báo các tab khác đọc lại profile.
Focus revalidation không ghi đè bản nháp khi giá trị user phía server chưa đổi.
Landing và sidebar workspace hiển thị trạng thái user từ provider chung.

## Vòng đời token và lỗi

- Access token chỉ ở bộ nhớ module trong từng tab; server không được gửi snapshot
  chứa token qua SSR. Snapshot ban đầu chỉ có trạng thái checking, user=null.
- Refresh cookie HttpOnly do browser quản lý. Bootstrap dùng refresh rồi GET /users/me.
- Timer dựa trên expiresIn, làm mới sớm tối đa 30 giây khi tab hiển thị. Khi tab trở lại,
  pageshow/focus/visibilitychange và online kiểm tra lại phiên; server vẫn kiểm tra exp.
- Refresh trong cùng tab dùng một Promise chung, gồm cả StrictMode bootstrap và các 401.
  Giữa các tab, login/refresh/logout dùng cùng Web Lock, giữ lock đến khi nhận cookie mới
  và xác nhận danh tính. Mỗi tab có access token riêng; các tab có thể refresh nối tiếp,
  không chia sẻ token qua channel hoặc storage.
- Refresh 401/reuse/hết hạn, 401 sau một lần retry hoặc USER_DISABLED kết thúc state,
  thông báo các tab và đưa trang bảo vệ về đăng nhập. Server xóa cookie ở refresh lỗi;
  các lỗi xác thực từ resource có bước logout tốt nhất có thể để xóa cookie auth-path.
- Lỗi mạng/503 giữ phiên để thử lại. Refresh nền có backoff 30 giây để tránh vòng lặp;
  người dùng có thể thử lại chủ động. Logout do người dùng yêu cầu chỉ xóa state sau
  khi server xác nhận thành công.

## Đồng bộ và tránh ghi nhầm tài khoản

Mỗi login/logout/thu hồi ghi một marker mới vào localStorage:
`streamora.auth.revision={id,action,reason?}`. UUID là ID sự kiện, không phải user ID.
Không có email, họ tên, password, JWT hoặc refresh token trong marker.
BroadcastChannel báo nhanh; storage event là fallback khi channel không dùng được.
Nếu storage bị chặn, channel vẫn gửi sự kiện trong bộ nhớ. Khi focus hoặc trước khi
gọi API, tab đối chiếu marker để phát hiện thay đổi đã bỏ lỡ.

Epoch và user ID gắn với mỗi thao tác đang chờ. Đổi account/logout sẽ làm request cũ
không được cập nhật UI hoặc retry dưới danh tính mới. Client kiểm tra cả trước khi
gửi, sau response và trước retry; trả SESSION_CHANGED để người dùng thực hiện lại.
Không thể hủy tác dụng phụ mà server đã hoàn tất trước khi logout; guard backend và
quy tắc transaction/idempotency của module vẫn áp dụng.

Cookie rotation yêu cầu Web Locks trên browser hiện đại và secure context
(HTTPS; local dùng 127.0.0.1). Nếu thiếu API này, giao diện báo cần cập nhật browser
và không chạy refresh thiếu phối hợp. Không thay bằng localStorage check-then-set
vì cơ chế đó không bảo đảm độc quyền. Xem [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API),
[BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API),
[storage event](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event)
và [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore).

## Kiểm thử

```powershell
npm run test:frontend
npm run typecheck
```

Test Next.js production build + Edge + API/PostgreSQL thật trong môi trường tạm.
Backend test helper ký JWT đã hết hạn nhưng giữ claims/chữ ký đúng để kiểm tra 401
thực tế; khóa ký không được truyền sang frontend. Các case đồng thời có request
đến muộn, nhiều tab restore, logout chen refresh, đổi user khi write còn chờ và tab
lỡ thông báo. Lỗi HTTP/mạng và thiếu API browser có test điều khiển riêng.
Timer được kiểm tra bằng clock của Playwright; không đổi thời gian của hệ thống.
Không có endpoint/trang debug phiên trong bản frontend thật.
