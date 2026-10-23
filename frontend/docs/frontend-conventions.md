# Quy ước frontend dùng chung — T01, mục 8

Các module mới dùng nền tảng này để giữ cùng cách điều hướng, hiển thị tài khoản,
gửi form và xử lý lỗi. Backend tiếp tục nằm trong `backend/` ở gốc repository.
Mục 8 không thêm API, bảng hoặc migration.

## Khung và nơi đặt code

- `src/app/layout.tsx`: root Server Component, metadata, CSS chung; đặt AuthProvider
  rồi ToastProvider một lần. Không tạo lại provider trong từng page hoặc layout con.
- `src/components/shell/page-shell.tsx`: SiteHeader và PageShell cho trang nội dung.
  PageShell có header, main, tiêu đề, mô tả, eyebrow và breadcrumb tùy chọn.
- `src/components/shell/account-link.tsx`: AccountLink có dạng text/button/avatar;
  SessionIdentity hiển thị tên, avatar và trạng thái từ useAuth. Không hardcode user.
- `src/components/common`: FormField, SubmitButton, InlineNotice, LoadingState,
  ErrorState, RequestError, EmptyState và toast. CSS được root layout nạp một lần.
- `src/components/<module>`: UI và state nghiệp vụ; `src/lib/<module>`: API/types/helpers
  của module. Kiểu request/response chia sẻ với backend đặt ở `@streamora/contracts`.
- `src/lib/api.ts`: đầu mối client cho apiRequest, ApiError, asApiError, ApiRequestOptions.
  Nó dùng lớp phiên của mục 7; không tạo thêm client có refresh/token riêng.

`/account` và trang lỗi/404 đã dùng PageShell. AuthFrame dùng SiteHeader.
Landing dùng AccountLink; sidebar workspace dùng SessionIdentity và AccountLink.
Workspace giữ bố cục riêng cho phòng học/chat, dùng toast chung từ root.

Page và layout mặc định là Server Component; metadata đặt trong page/layout server.
Form, hook, browser API và các module API client cần `"use client"`. Các module transport
đã có `client-only`; không import chúng vào Server Component để lấy token hoặc user.

Ví dụ thêm trang cần đăng nhập:

```tsx
// src/app/my-feature/page.tsx — Server Component
import { RequireSession } from "@/components/auth/require-session";
import { PageShell } from "@/components/shell/page-shell";
import { FeatureContent } from "@/components/my-feature/feature-content";

export const metadata = { title: "Tính năng của tôi | Streamora" };

export default function Page() {
  return (
    <PageShell title="Tính năng của tôi" breadcrumb="Tính năng">
      <RequireSession>
        <FeatureContent />
      </RequireSession>
    </PageShell>
  );
}
```

RequireSession không render phần riêng tư trong lúc checking; anonymous chuyển đến
`/login`; lỗi khôi phục tạm thời có nút thử lại. Khi đổi user, guard thay subtree để
xóa state/form của danh tính cũ. Backend vẫn phải dùng RequireAuth và kiểm tra quyền
nghiệp vụ. Demo cộng đồng/phòng mẫu/tệp hiện tại vẫn mở cho khách; Meet T04 yêu cầu
đăng nhập, xem [giao diện T04](class-sessions.md).

## Form và thông báo

FormField nhận các props input thông thường cùng id, label, hint, error và icon tùy chọn.
Nó liên kết label, hint, lỗi qua aria-describedby/aria-invalid; password có nút hiện/ẩn.
id phải duy nhất trong trang. Không cần icon để dùng FormField.

SubmitButton nhận pending, pendingLabel và disabled, tự khóa nút và hiển thị tiến trình.
Form vẫn cần `fieldset disabled={pending}` cùng chốt useRef trong handler để chặn
hai lần submit trước khi React render. Dùng `noValidate` khi có validation theo trường;
focus trường lỗi đầu tiên và giữ nội dung người dùng đã nhập. Frontend hỗ trợ phản hồi
sớm; backend kiểm tra lại mọi request.

```tsx
import { FormField } from "@/components/common/form-field";
import { SubmitButton, InlineNotice } from "@/components/common/feedback";

// Bên trong Client Component, các biến là state/handler của form:
<form className="ui-form" onSubmit={submit} noValidate aria-busy={pending}>
  {message && <InlineNotice tone="error">{message}</InlineNotice>}
  <fieldset disabled={pending}>
    <FormField
      id="feature-title"
      name="title"
      label="Tiêu đề"
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      error={errors.title}
      hint="Đặt tên dễ nhận biết."
      required
    />
    <SubmitButton pending={pending} pendingLabel="Đang lưu…">
      Lưu
    </SubmitButton>
  </fieldset>
</form>;
```

InlineNotice có tone info/success/error, nhận ref để focus khi báo lỗi toàn form.
Lỗi validation để cạnh trường; lỗi form cần người dùng sửa để inline, giữ tới khi
người dùng chỉnh hoặc gửi lại. Không chỉ dùng toast ngắn cho lỗi cần sửa.

```tsx
import { useToast } from "@/components/common/toast-provider";

const { notify } = useToast();
// Chỉ báo thành công sau khi API xác nhận:
notify("Đã lưu thay đổi.", { tone: "success" });
// Tone mặc định: info. Error có nút đóng và không tự ẩn:
notify("Chưa thể hoàn tất thao tác.", { tone: "error" });
```

Toast chung hiển thị tối đa 3 thông báo gần nhất, có nút đóng, tồn tại qua điều hướng
trong cùng tab. Info/success tự ẩn sau 5 giây; hover hoặc focus dừng bộ đếm, rời ra
bắt đầu lại 5 giây. Error giữ tới khi đóng hoặc bị thay bởi thông báo mới khi đầy.
Đổi user/logout xóa thông báo cũ. Không lưu toast vào storage hay đồng bộ sang tab khác.
Không đưa password/token, raw request/response hoặc thông tin nhạy cảm vào thông báo.

## Loading, dữ liệu rỗng và lỗi

- LoadingState cho lần tải đầu hoặc vùng đang tải, có message và role=status.
  Với mutation giữ form và dùng pending trên SubmitButton để tránh mất bản nháp.
- EmptyState khi request thành công nhưng danh sách rỗng; thêm nút tạo mới nếu có quyền.
- ErrorState cho lỗi đã có thông báo phù hợp và action tùy chọn.
- RequestError nhận error từ API client, hiển thị thông báo chung. 403 giữ phiên,
  không tự hiện nút retry; 401 có liên kết đăng nhập. Các lỗi khác nhận onRetry khi
  caller chủ động cho phép. Chỉ truyền retry cho thao tác an toàn, thường là đọc dữ liệu.
- `src/app/loading.tsx` là fallback điều hướng Next.js. Lần fetch sau hydration vẫn
  cần LoadingState tại module; fallback route không tự theo dõi fetch trong useEffect.
- `src/app/error.tsx` bắt lỗi render chưa xử lý, có nút retry theo API Next.js đang cài.
  Nó không hiển thị error.message/stack. Lỗi từ event handler/async request phải catch
  tại module. `not-found.tsx` dùng khung và trạng thái chung cho trang 404.

## Gọi API và xử lý 401/403

```tsx
"use client";
import { apiRequest, asApiError } from "@/lib/api";
import type { UserResponse } from "@streamora/contracts";

async function saveProfile(fullName: string) {
  try {
    return await apiRequest<UserResponse>("/users/me", {
      method: "PATCH",
      body: { fullName },
    });
  } catch (error) {
    const failure = asApiError(error);
    // failure.fields: lỗi theo tên trường; failure.message: thông báo an toàn.
    // Cập nhật state form hoặc đưa error vào <RequestError error={error} />.
    throw failure;
  }
}
```

apiRequest mặc định GET, path từ `/api/v1`, JSON body, credentials=include và
cache=no-store. Client thêm bearer từ bộ nhớ, gom refresh và chỉ thử lại một lần khi
401; refresh lỗi xác thực hoặc USER_DISABLED kết thúc phiên. Không dùng fetch riêng
với token, không tự redirect mọi 403 sang login và không tạo vòng lặp retry trong module.
Login/updateProfile/logout dùng useAuth; đăng ký hiện dùng transport auth riêng.

asApiError trả status/code/message/fields/requestId. Lỗi trường theo contract
`error.details.fields=[{field,message}]`; parser hỗ trợ tên trường module, giới hạn
30 lỗi, tên 64 ký tự và message 300 ký tự, loại bỏ key nguy hiểm. Lỗi code mới cần
thông báo chuyên biệt thì bổ sung mapping ở transport; không render error.message
thô từ server hoặc alert(JSON.stringify(response)). requestId chỉ dùng khi cần đối chiếu
với backend; không log nguyên request, header Authorization hoặc cookie.

403 không refresh, không logout. Mạng/5xx/429 không tự replay request mutation.
Nếu mất kết nối sau thao tác ghi, không biết chắc server đã lưu hay chưa; module cần
đối chiếu dữ liệu hoặc idempotency theo nghiệp vụ trước khi cho gửi lại.
SESSION_CHANGED nghĩa là danh tính đã đổi khi request đang chờ; bỏ kết quả cũ,
không áp dụng dữ liệu sang user mới. Chi tiết ở [quản lý phiên](session.md).

## Kiểm tra trước khi tích hợp

```powershell
npm run typecheck
npm run test:frontend
```

Frontend tests dùng Next.js production, Edge và API/PostgreSQL trong môi trường tạm.
Ngoài auth/session, mục 8 kiểm tra toast qua điều hướng/đóng/hẹn giờ/đổi user, lỗi trường
của module, pending chống gửi lặp, lỗi 403/5xx, 404, khôi phục lỗi render và mobile.
Các trang shell-probe/shell-crash chỉ được chép vào bản build tạm của test.

Thử thêm với module mới: tải chậm, danh sách rỗng, 400 theo trường, 403, 5xx, mất mạng,
hết phiên, logout ở tab khác, chuyển user khi request còn chờ và màn hình hẹp.
Backend endpoints cần guard/phân quyền riêng theo hướng dẫn backend của T01.
