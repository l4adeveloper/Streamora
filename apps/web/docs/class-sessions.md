# T04 — Giao diện lịch học, Meet và tham gia phòng (mục 6)

Giao diện dùng API T04 và Socket.IO `/sessions` thật, cùng AuthProvider/API client
của T01 và phân quyền nhóm T03. Không thêm dependency hoặc migration ở mục 6.

## Mở các màn hình

- `/groups`: mở nhóm → **Xem lịch học**, hoặc chọn nhóm trong workspace rồi mở
  **Lịch học của nhóm**. Đường dẫn lịch: `/groups/:groupId/sessions`.
- `/sessions/:sessionId`: buổi học thuộc nhóm, có liên kết chia sẻ ngay trên trang.
- `/meet`: tạo và bắt đầu cuộc họp độc lập, nhập mã/liên kết và xem các cuộc họp
  do chính mình tạo. Danh sách có phân trang, không liệt kê meet của người khác.
- `/meet/:code`: mở cuộc họp độc lập bằng mã 12 ký tự. Người chưa đăng nhập được
  đưa đến login rồi quay lại đúng liên kết mời; không tự gửi yêu cầu tham gia.

Các trang T04 yêu cầu đăng nhập. Trạng thái SCHEDULED/LIVE/ENDED/CANCELLED, quyền
và yêu cầu của người gọi được đọc từ server. Các phòng mẫu `/rooms/:id`, trình
phát mẫu ở workspace và các luồng media cũ chưa được thay bằng cuộc gọi T04.
Mic/camera/chia sẻ màn hình, chat trong buổi và ghi hình không thuộc mục này.

## Chạy local

Từ gốc repository, dùng cấu hình và migration đã có:

```powershell
npm run db:migrate
npm run dev:api
```

Terminal khác:

```powershell
npm run dev
```

Mặc định socket đi cùng API tại cổng 4000. Nếu muốn dùng realtime riêng, chạy
`npm run dev:realtime` ở terminal thứ ba và đặt
`NEXT_PUBLIC_REALTIME_URL=http://127.0.0.1:4001` trong `apps/web/.env.local`, rồi
khởi động lại frontend. API/realtime phải cùng database và khóa ký token.
Các URL frontend là biến public khi build; không đưa secret backend vào chúng.
Luồng T04 không cần LiveKit hoặc seed lại tài khoản.

## Buổi học thuộc nhóm

1. HOST/OWNER/ADMIN mở lịch, bấm **Lên lịch buổi học**, nhập tên, mô tả tùy chọn
   và giờ dự kiến. VIEWER chỉ xem lịch. Có lọc trạng thái và xem thêm qua cursor.
2. Ngày giờ nhập/hiển thị theo múi giờ thiết bị, chuyển ISO UTC trước khi gửi.
   Giờ không hợp lệ bị chặn; lịch chưa tự bắt đầu khi đến giờ.
3. Khi chưa bắt đầu, người quản lý có thể sửa hoặc hủy lịch. Hủy cần xác nhận
   trên trang vì không mở lại được buổi đó.
4. **Bắt đầu buổi học** chuyển LIVE. Thao tác này chưa ghi người quản lý vào phòng;
   muốn tham gia thì bấm **Vào phòng**.
5. VIEWER bấm **Xin vào phòng** rồi thấy trạng thái chờ; có thể hủy yêu cầu.
   Hàng chờ chỉ có ở trang người quản lý. Accept/reject cập nhật người xin qua socket.
6. Bị từ chối có thể bấm **Xin vào lại**. Được chấp nhận thì bấm **Vào phòng**;
   trước bước đó chưa được xem người tham gia hoặc tính là đang vào.
7. Người trong phòng/người quản lý xem danh sách tên và giờ vào, có phân trang.
   **Rời phòng** đóng lượt hiện tại trên mọi tab. VIEWER quay lại phải xin duyệt lại.
8. **Kết thúc buổi học** cần xác nhận, chuyển ENDED và đóng hàng chờ/lượt đang mở.
   Giao diện người tham gia cập nhật kết thúc; không có nút mở lại.

Quyền và mutation được kiểm tra lại ở backend. UI dùng permissions từ admission/T03,
không suy ra quyền host từ tên hoặc người tạo lớp. Hạ HOST về VIEWER giữ lượt đã
vào nhưng bỏ điều khiển/hàng chờ. Xóa membership ẩn dữ liệu phòng và báo lỗi quyền;
thêm lại không hồi sinh grant cũ.

## Meet độc lập

**Tạo và bắt đầu** dùng create rồi start. Lưu ID khi create đã thành công; nếu
start lỗi, chỉ tiếp tục start cuộc họp đã tạo. Mất phản hồi create thì retry cùng
body/key, tránh tạo trùng. Cuộc họp SCHEDULED cũng có thể mở từ danh sách của mình
để bắt đầu thủ công.

Nhập mã không phân biệt hoa/thường hoặc liên kết cùng origin `/meet/:code`.
Liên kết khác website hoặc sai định dạng được báo ngay tại trường. Trước khi vào
chỉ hiện preview tối thiểu và trạng thái của chính người gọi. Chủ meet/global
ADMIN mới có quản lý/hàng chờ; HOST ở nhóm khác không cấp quyền quản lý meet.
Thành viên của bất kỳ nhóm nào cũng có thể xin vào meet.

## Kết nối, retry và phiên

- API module dùng `apiRequest`; không có transport/refresh token riêng. Lỗi T04
  được ánh xạ sang thông báo tiếng Việt, không render raw lỗi.
- Create/request/enter và lifecycle giữ key trong bộ nhớ cho cùng ý định khi mất
  phản hồi. Khi server đã đổi trạng thái và người dùng chủ động xin/vào lại, dùng
  key mới. Không tự request/enter khi reload, nhận accept hoặc reconnect; chỉ
  attach lượt còn hiệu lực đã được HTTP ghi nhận.
- Form/nút thao tác có chốt pending. Khi host khác đã xử lý hàng chờ, hiển thị
  lỗi xung đột và đọc lại server. Mất phản hồi không tự replay mutation.
- `useClassRealtime` watch, attach và heartbeat theo thời gian server trả về
  (mặc định 10 giây). Token chỉ lấy từ authSession trong bộ nhớ; không lưu thêm
  vào storage hay URL. Mỗi loại event có mốc version riêng.
- Event chỉ kích hoạt đọc HTTP mới; không áp dụng quyết định hoặc đếm người từ
  event. Reconnect re-watch và đọc lại state/queue/participants. Hết hạn 30 giây
  thì server đóng lượt, UI không auto-enter. Nhiều tab dùng cùng participationId.
- `participation.closed` chỉ tác động đúng lượt liên quan, không đóng lượt mới.
  Đóng/điều hướng khỏi trang không tự gọi leave; dùng **Rời phòng** để đóng ngay.
- Đọc lại sau mutation, focus/online và mỗi 15 giây để khôi phục khi socket gián
  đoạn. Lỗi đọc ẩn dữ liệu bảo vệ; 403 không logout hoặc giữ hàng chờ cũ.
- Sequence bỏ phản hồi cũ khi route/quyền thay đổi. RequireSession thay subtree
  khi đổi user/logout, gỡ socket và dữ liệu riêng.
- Các trang T04 bật `preserveDestination`. Login/register chỉ giữ đường dẫn nội
  bộ trong allowlist `safeReturnTo`; không chuyển sang URL ngoài hoặc scheme lạ.
  Đăng nhập thông thường vẫn mở `/workspace`.

Tab bị trình duyệt đình chỉ quá lâu có thể hết heartbeat và cần xin vào lại.
Participants tính lượt còn hiệu lực, gồm thời gian chờ khôi phục; không phải số
socket đang mở ngay tại thời điểm xem.

## Code và kiểm thử

- Route server: `src/app/groups/[id]/sessions`, `src/app/sessions/[id]`,
  `src/app/meet` và `src/app/meet/[code]`. Params dùng Promise theo Next đang cài.
- Component/state/form/CSS: `src/components/class-sessions`; API, thời gian,
  phân trang và realtime: `src/lib/class-sessions`.
- Dùng PageShell, FormField, LoadingState, EmptyState, RequestError, toast chung
  và màu theo theme; bố cục một cột trên mobile. Không có trang debug sản phẩm.

```powershell
npm run test:t04:frontend
npm run test:frontend
npm run typecheck
```

Test dùng Next production, Edge headless, API/socket thật và database tạm tự dọn.
Mất phản hồi/503/offline được chủ động tạo ở lớp mạng trình duyệt. TTL riêng của
fixture là 5 giây để thử timeout nhanh; production giữ 30 giây. Không cần chạy
server thủ công, không ghi đè `.next` hoặc sửa database ứng dụng.

Tham chiếu: [phạm vi T04](../../../backend/docs/t04-scope.md),
[API admission](../../../backend/docs/t04-admission.md),
[hợp đồng realtime](../../../backend/docs/t04-realtime.md).
Nghiệm thu toàn bộ T01–T04 bằng `npm run test:t04`; xem
[bàn giao và demo T04](../../../backend/docs/t04-handoff.md).

## Kết quả ngày 23/10/2026

- Typecheck toàn monorepo đạt; frontend production build đạt trong fixture riêng.
- 12/12 kiểm thử trình duyệt T04 đạt: lịch/UTC, sửa/bắt đầu/hủy/kết thúc, privacy,
  reject/xin lại/accept/enter, nhiều tab/leave, heartbeat/offline, Meet và liên kết
  mời qua login, retry create/start, quyền thay đổi, phân trang và mobile.
- 41/41 kiểm thử hồi quy frontend T01–T03 đạt: auth/shell 12, phiên 17, nhóm 4,
  membership/workspace 8. Helper phiên cũ được sửa để mở trang account sau khi
  kiểm tra login đã chuyển đến workspace; không đổi quy tắc refresh/logout.
- T04 chuẩn bị account API trong database tạm với hash thật và JWT do backend
  test ký; browser vẫn đăng nhập thật. Không nới quota hoặc thêm đường dẫn test
  vào ứng dụng. Seed tài khoản local và dữ liệu ứng dụng không bị thay đổi.
- Đã xem ảnh desktop và mobile sáng/tối; nút kết thúc rõ màu, nhãn filter được
  liên kết với select, trang hẹp 390px không tràn ngang. Ảnh kiểm tra ở `.preview/`.
