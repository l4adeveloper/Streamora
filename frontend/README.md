# Frontend Streamora — tài khoản, phiên và khung chung T01, mục 6–8

Hướng dẫn chạy mới, demo và điểm tích hợp cho nhóm:
[bàn giao T01](../backend/docs/t01-handoff.md).

Các trang tài khoản dùng API thật:

- `/register`: họ tên, email, mật khẩu; validation theo trường, email đã có tài khoản,
  giới hạn tần suất, trạng thái đang gửi và thông báo đăng ký thành công. Đăng ký
  không tự đăng nhập; nút Đăng nhập ngay dẫn sang `/login`.
- `/login`: xử lý sai thông tin, tài khoản khóa, rate limit và mất kết nối; thành công
  chuyển tới `/workspace` hoặc liên kết mời T04 đã lưu. Có nút hiện/ẩn mật khẩu và autocomplete phù hợp.
- `/account`: GET hồ sơ, sửa họ tên qua PATCH, email chỉ đọc, hiển thị vai trò và logout.
  Người chưa đăng nhập được đưa về `/login`; không hiển thị hồ sơ trong lúc kiểm tra phiên.

Landing có liên kết đăng nhập/tạo tài khoản; icon tài khoản trong workspace dẫn
tới `/account`. Trang Meet, lịch nhóm và phòng T04 đã dùng API/realtime thật;
xem [hướng dẫn T04 mục 6](docs/class-sessions.md). Các trang cộng đồng, tệp,
`/rooms/:id` và trình phát workspace vẫn có phần demo hiện tại.
Nghiệm thu đầy đủ và demo nhiều tài khoản: [bàn giao T04](../backend/docs/t04-handoff.md).

## Chạy local

Tại gốc repository, PostgreSQL và migration từ mục 2 phải sẵn sàng:

```powershell
# Terminal backend (giữ mở)
npm run dev:api
```

```powershell
# Terminal frontend (giữ mở)
npm run dev
```

Mở `http://127.0.0.1:3000/register`. Tài khoản đã tạo qua PowerShell trước đây
có thể dùng ở trang đăng nhập. Không cần migration mới cho mục 6.

`frontend/.env.local` cần `NEXT_PUBLIC_API_URL=http://127.0.0.1:4000/api/v1`;
`backend/.env` cần `WEB_ORIGIN=http://127.0.0.1:3000`. Dùng nhất quán 127.0.0.1.
Sau khi sửa env, khởi động lại dev server; production cần inject public URL trước build.
Không đặt khóa JWT hoặc DATABASE_URL vào cấu hình frontend.

## Tổ chức và trạng thái phiên

`src/app/layout.tsx` đặt AuthProvider và ToastProvider chung cho toàn bộ ứng dụng. `src/app/(auth)`
cung cấp các trang tài khoản; page server khai báo metadata và render client component
trong `src/components/auth`. RequireSession bảo vệ `/account` ở phía giao diện;
API vẫn phải gắn guard backend. Landing/workspace nhận user thật từ provider.
`src/lib/auth` chứa transport API, phiên và kiểm tra đầu vào. Dùng kiểu từ
`@streamora/contracts`; validation frontend đếm Unicode code point, giữ nguyên mật khẩu,
trim họ tên và trim/lowercase email. Backend vẫn là nơi kiểm tra quyết định.

Access token chỉ giữ trong bộ nhớ tab. Cookie refresh do browser quản lý với
credentials=include; không đọc hoặc lưu cookie/token vào localStorage/sessionStorage.
Khi tải ứng dụng, provider khôi phục bằng refresh và GET /users/me. Timer làm mới
trước hạn khi tab đang hiển thị; focus/pageshow/online kiểm tra lại phiên.
Lớp authenticatedRequest tự refresh và thử lại tối đa một lần khi API trả 401.
Promise chung gom refresh trong tab; Web Locks tuần tự hóa thao tác cookie giữa các tab.
BroadcastChannel và storage event đồng bộ login/logout; profile thay đổi được thông báo
qua channel và được đọc lại khi focus. Storage chỉ có marker công khai
`streamora.auth.revision` gồm UUID sự kiện, action và reason; không chứa user/token.

Nút gửi bị khóa và handler có chốt chống gửi lặp. Lỗi API được xử lý bằng error.code,
details.fields và Retry-After. Mất kết nối có thông báo và cho thử lại; không in
request/response/token vào console. Logout chỉ xóa state sau khi server xác nhận,
để người dùng thử lại nếu kết nối lỗi.

Mục 7 đã triển khai tự refresh/retry, đồng bộ tab, chặn kết quả/thao tác từ danh tính cũ
và xử lý hết phiên. Xem [hướng dẫn tích hợp phiên](docs/session.md) để dùng API client/guard.
Mục 8 đã thống nhất PageShell/SiteHeader, AccountLink/SessionIdentity, FormField,
SubmitButton, thông báo inline/toast và trạng thái loading/error/empty; các màn hình
auth/account, landing và workspace đã dùng các thành phần phù hợp. Có fallback
loading, lỗi render và 404 ở App Router.
Xem [quy ước frontend cho nhóm](docs/frontend-conventions.md) để thêm module mới.

## Kiểm thử

Swagger có thể mở tại `http://127.0.0.1:3000/api/v1/docs` khi API và frontend cùng
chạy. Next.js rewrite `/api/v1/*` tới NEXT_PUBLIC_API_URL tuyệt đối; trình duyệt giữ
Origin frontend và tự quản lý cookie nên Auth có Try it out đầy đủ. Cấu hình URL
tương đối `/api/v1` (khi reverse proxy đã route API) không tạo rewrite vòng lặp.
Thay NEXT_PUBLIC_API_URL cần restart dev hoặc build lại production.
Xem [cách thử sáu API](../backend/docs/openapi.md).

Nghiệm thu toàn bộ T01 (mục 9): `npm run test:t01` tại gốc repository.
Xem [tiêu chí và cách chạy](../backend/docs/t01-acceptance.md).
Hai ca bổ sung kiểm tra tài khoản bị khóa khi đang dùng và hạn refresh tuyệt đối
bằng API/DB thật, cùng đồng bộ tab, xóa cookie và chặn thay đổi hồ sơ.

```powershell
npm run test:frontend
npm run typecheck
```

Test frontend dùng Playwright/Edge (hoặc STREAMORA_TEST_BROWSER_CHANNEL như test mục 5),
PostgreSQL local có quyền CREATEDB và production build Next.js thật. Không cần chạy
API/Next.js thủ công. Test copy source công khai vào `.preview/auth-frontend-run-<uuid>`,
build với API URL riêng, dùng port ngẫu nhiên và database tạm. Không sao chép env local
hoặc truyền secret backend vào builder/server frontend. Dọn bản sao, process và database
tạm sau test; không ghi đè `.next` của ứng dụng đang dùng.

Happy path dùng API/database thật. Case 429 và lỗi kết nối có mock HTTP để kiểm tra
UI độc lập với bộ đếm/thời gian mạng; backend rate limit đã được kiểm tra riêng.
Test xác nhận gửi một lần, validation, duplicate email, sai mật khẩu, user khóa,
sửa họ tên, reload, logout, bearer bị thu hồi, không lưu token vào browser storage,
email chỉ đọc, password visibility và bố cục mobile không tràn ngang.
Session tests kiểm tra 401/refresh/retry, payload/method ban đầu, request đồng thời,
401 cũ đến muộn, lỗi 403/500/503, thu hồi phiên, nhiều tab, logout khi đang refresh,
đổi user khi còn request, tab lỡ thông báo, đồng bộ workspace và các fallback thông báo.
Các trang session-probe, shell-probe và shell-crash chỉ được chép vào bản build tạm
của test, không có trong frontend. Test khung chung kiểm tra toast, lỗi trường của
module, pending, 403/5xx, 404, render error/retry và mobile.
