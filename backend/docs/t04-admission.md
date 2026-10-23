# T04 — Xin vào, accept/reject, vào và rời phòng (mục 4)

Đã bổ sung 9 API vào ClassSessionsModule, dùng chung xác thực T01 và phân quyền
T03. Kết hợp với [API lịch học/vòng đời](t04-api.md), Swagger T04 hiện có 19 thao tác.
Phần này quản lý dữ liệu tham gia; không cấp token hoặc kết nối LiveKit.

## Chạy và kiểm tra

Tại thư mục gốc, PostgreSQL đang chạy:

```sh
npm run db:migrate
npm run dev:api
```

Nếu API đang chạy bản cũ, dừng rồi chạy lại. Không cần chạy seed.
Swagger: http://127.0.0.1:4000/api/v1/docs-sessions, nhóm T04 Admission.
Đăng nhập và lấy accessToken theo [hướng dẫn auth](auth-api.md), dùng Bearer cho
mọi endpoint. [Mục 5](t04-realtime.md) đã có realtime/heartbeat;
[mục 6](../../apps/web/docs/class-sessions.md) đã nối giao diện thật.

## Các endpoint mới

Tiền tố `/api/v1`:

```text
GET   /sessions/:sessionId/admission
POST  /sessions/:sessionId/join-requests
GET   /sessions/:sessionId/join-requests
GET   /sessions/:sessionId/join-requests/:requestId
POST  /sessions/:sessionId/join-requests/:requestId/cancel
PATCH /sessions/:sessionId/join-requests/:requestId
POST  /sessions/:sessionId/enter
GET   /sessions/:sessionId/participants
POST  /sessions/:sessionId/participations/:participationId/leave
```

Các API thành công trả 200; lỗi giữ cấu trúc T01 và requestId. Toàn bộ có
Cache-Control: no-store. Các POST chỉ nhận `{}` hoặc không có body. PATCH duyệt
chỉ nhận `{"decision":"ACCEPT"}` hoặc `{"decision":"REJECT"}`.
Không nhận userId, role, trạng thái, thời gian hoặc người duyệt trong body.

## Luồng người tham gia

1. Lấy sessionId từ lịch nhóm hoặc thông tin tối thiểu theo mã meet.
2. GET admission để đọc quyền và trạng thái của chính mình.
3. Khi buổi LIVE và chưa có quyền vào, POST join-requests với Idempotency-Key mới.
4. Host GET join-requests, rồi PATCH yêu cầu với ACCEPT hoặc REJECT.
5. Người xin đọc lại admission hoặc GET yêu cầu của mình để nhận kết quả.
6. Được ACCEPTED thì POST enter với một Idempotency-Key cho lần vào này.
7. Sau enter mới được tính trong danh sách participants và đọc dữ liệu trong phòng.
8. Rời bằng POST participations/:participationId/leave, dùng đúng ID từ enter.

Người quản lý được enter trực tiếp khi LIVE. Không cần tự xin/duyệt; xin khi
đã có quyền vào trực tiếp hoặc đang trong phòng trả 409 JOIN_REQUEST_NOT_REQUIRED.
Việc bắt đầu lớp, chấp nhận yêu cầu hoặc xem thông tin không tự ghi nhận đã vào.

## Quyền và dữ liệu được xem

- Lớp thuộc nhóm: kiểm tra membership hiện tại khi xin, duyệt, vào và đọc dữ liệu.
  Host/owner/global ADMIN quản lý; người ngoài nhóm không xin vào được dù biết link.
- Meet độc lập: người đã đăng nhập được xin vào; chỉ chủ meet/global ADMIN duyệt.
  Vai trò HOST ở nhóm khác không cấp quyền với meet.
- Hàng chờ/lịch sử theo trạng thái chỉ dành cho người quản lý. GET một yêu cầu
  dành cho chính người gửi hoặc người quản lý. Cancel chỉ dành cho chính người gửi.
- Participants chỉ dành cho người quản lý hoặc người đã vào và chưa rời; được
  accept nhưng chưa enter chưa được đọc danh sách. Phản hồi chỉ thêm user.id và
  fullName, không có email, mật khẩu, token hoặc cấu hình media.
- Request và participation phải thuộc đúng sessionId. Không dùng request/visit
  của người khác, hoặc thay sessionId để vượt kiểm tra quyền.
- GET admission chỉ có request của mình, lượt tham gia gần nhất và bốn quyền:
  canManage, canRequestJoin, canEnter, canViewParticipants. participation có thể
  là lượt đã rời, phải kiểm tra leftAt/quyền hiện tại; không suy ra quyền từ ID cũ.

## Retry, quyết định và vào lại

POST join-requests và POST enter **bắt buộc** có Idempotency-Key, từ 1–128 ký tự
ASCII không có khoảng trắng. Dùng khóa mới cho ý định mới; giữ khóa khi retry.

- Xin vào đồng thời bằng một hoặc nhiều key chỉ tạo một PENDING/ACCEPTED còn hiệu lực.
- Replay key xin vào đọc lại đúng yêu cầu cũ với trạng thái hiện tại, không tạo
  yêu cầu mới khi yêu cầu cũ đã REJECTED, CANCELLED, EXPIRED hoặc REVOKED.
- Muốn xin lại sau reject/cancel/rời phải chủ động gửi key mới. Reject không phải ban.
- Hai host accept/reject cùng một yêu cầu chỉ có một quyết định có hiệu lực.
  Lặp cùng ACCEPTED/REJECTED trả kết quả cũ, giữ nguyên người và thời điểm duyệt.
  Quyết định ngược hoặc cố mở lại yêu cầu đã đóng trả JOIN_REQUEST_ALREADY_RESOLVED.
- Hai tab enter cùng lúc chỉ có một lượt đang mở. Reconnect/refresh có thể đọc
  admission và dùng lại lượt còn hiệu lực, không tự tạo người tham gia trùng.
- Khi rời, đóng lượt và EXPIRED quyền ACCEPTED gắn với lượt đó trong cùng transaction.
  Thành viên thường cần xin và được duyệt lại. Người còn quyền quản lý vào trực tiếp.
- Retry key enter của lượt đã kết thúc trả ADMISSION_REVOKED; không tự tạo lượt mới,
  kể cả khi người gọi là host hoặc đã có lượt khác đang mở.
- Leave dùng participationId để request rời cũ không đóng nhầm một lượt mới.
  Rời lặp trả dữ liệu đã đóng, giữ nguyên leftAt và lý do kết thúc đầu tiên.
- Key được lưu theo user/thao tác/key; dùng lại cho session khác trả IDEMPOTENCY_CONFLICT.
- Xin, duyệt và enter chỉ hợp lệ khi LIVE; trước hoặc sau đó trả SESSION_NOT_LIVE.
  Kết thúc lớp vẫn đóng yêu cầu/lượt tham gia nguyên tử theo mục 3.

## Danh sách và phân trang

GET join-requests mặc định status=PENDING; có thể chọn ACCEPTED, REJECTED,
CANCELLED, EXPIRED hoặc REVOKED để xem lịch sử. Sắp requestedAt ASC/id ASC.
GET participants chỉ trả lượt chưa rời còn đủ điều kiện, sắp joinedAt ASC/id ASC.
limit mặc định 20, tối đa 100; dùng nextCursor để lấy trang tiếp.

Cursor gắn với endpoint, session, người gọi và status nếu có. Đổi các điều kiện
này phải quay về trang đầu; cursor sai trả INVALID_CURSOR. Query lạ bị từ chối.

## Thu hồi quyền và phối hợp với T01–T03

- Xóa membership qua T03 khóa group, REVOKED các PENDING/ACCEPTED của người đó
  trong nhóm và đóng lượt đang mở với ACCESS_REVOKED, cùng transaction xóa.
  Thêm lại thành viên không khôi phục yêu cầu hoặc key enter cũ.
- Mỗi quyết định kiểm tra lại người xin; nếu không còn đủ điều kiện thì lưu
  thu hồi quyền trước khi trả ADMISSION_REVOKED. Không rollback nhầm việc thu hồi.
- Khi T01 phát hiện tài khoản bị khóa trong login/refresh/xác thực, thu hồi các
  phiên và đóng yêu cầu/lượt tham gia của người đó trên các phòng liên quan.
  Việc khóa trực tiếp trong DB chỉ được xử lý khi hệ thống phát hiện; danh sách
  participants đã lọc người bị khóa. [Mục 5](t04-realtime.md) cũng phát hiện từ
  socket đang mở mà không cần thêm yêu cầu HTTP.
- Hạ HOST xuống VIEWER thu hồi quyền điều khiển/hàng chờ. Lượt đang tham gia vẫn
  được giữ nếu còn membership; sau khi rời phải xin duyệt lại như VIEWER.
- Nâng lên HOST cho phép vào trực tiếp; yêu cầu đang chờ/được duyệt trước đó được
  EXPIRED khi dùng quyền quản lý để enter, không giữ thêm một grant thừa.
- Logout làm token/phiên hiện tại không dùng được. [Mục 5](t04-realtime.md) bổ sung
  heartbeat và timeout; participants tính một người/lượt còn hiệu lực, bao gồm
  thời gian chờ reconnect 30 giây, không phải số socket đang mở. Sau HTTP enter
  cần attach/heartbeat để duy trì lượt; không có kết nối thì lượt tự hết hạn.

Mutation khóa các user liên quan theo UUID, sau đó khóa key nếu có, group rồi
session. Read admission/queue/participants dùng khóa chia sẻ để không đọc dữ
liệu giữa chừng khi duyệt, xóa thành viên hoặc kết thúc. Không dùng trạng thái
phía client làm căn cứ cấp quyền.

## Thử nhanh bằng PowerShell

Chuẩn bị một session LIVE, Bearer token của người quản lý và một thành viên
VIEWER (hoặc người bất kỳ với meet độc lập). Thay các giá trị `<...>`:

```powershell
$apiBase = "http://127.0.0.1:4000/api/v1"
$sessionId = "<session-id>"
$viewerHeaders = @{ Authorization = "Bearer <viewer-access-token>" }
$hostHeaders = @{ Authorization = "Bearer <host-access-token>" }

# Chỉ tạo key một lần cho ý định xin vào này; retry giữ nguyên key.
$requestHeaders = $viewerHeaders.Clone()
$requestHeaders["Idempotency-Key"] = [guid]::NewGuid().ToString()
$request = Invoke-RestMethod -Method Post -Uri "$apiBase/sessions/$sessionId/join-requests" -Headers $requestHeaders -ContentType "application/json" -Body '{}'
$requestId = $request.request.id

Invoke-RestMethod -Method Patch -Uri "$apiBase/sessions/$sessionId/join-requests/$requestId" -Headers $hostHeaders -ContentType "application/json" -Body '{"decision":"ACCEPT"}'

$entryHeaders = $viewerHeaders.Clone()
$entryHeaders["Idempotency-Key"] = [guid]::NewGuid().ToString()
$entry = Invoke-RestMethod -Method Post -Uri "$apiBase/sessions/$sessionId/enter" -Headers $entryHeaders -ContentType "application/json" -Body '{}'
$participationId = $entry.participation.id

Invoke-RestMethod -Uri "$apiBase/sessions/$sessionId/participants" -Headers $viewerHeaders
Invoke-RestMethod -Method Post -Uri "$apiBase/sessions/$sessionId/participations/$participationId/leave" -Headers $viewerHeaders -ContentType "application/json" -Body '{}'
Invoke-RestMethod -Uri "$apiBase/sessions/$sessionId/admission" -Headers $viewerHeaders
```

## Kiểm thử và migration

```sh
npm run test:t04:admission
npm run test:t04:api
npm run typecheck
npm run docs:t04
```

Kiểm thử admission dùng hai API instance và database tạm, tự dọn sau khi chạy.
Bao phủ luồng nhóm/meet, tính riêng tư, nhập sai/giả mạo, key/retry, nhiều tab,
cursor, accept/reject/cancel/end đồng thời, xóa/thêm lại membership, khóa tài
khoản và nâng/hạ role. Không ghi tài khoản hoặc phòng demo vào database local.

Migration `20261023000300_class_admission_commands` chỉ mở rộng CHECK cho phép
REQUEST_JOIN và ENTER_SESSION trong bảng lưu key. Không đổi dữ liệu, tạo bảng
media, seed hoặc reset database.

## Kết quả ngày 23/10/2026

- Build API và typecheck toàn monorepo: đạt.
- Unit: 37/37 đạt, gồm 2 kiểm thử mới về DTO và hợp đồng admission.
- Tích hợp PostgreSQL: 80/80 đạt, gồm 15 kiểm thử admission mới qua hai instance
  và hồi quy toàn bộ integration auth, common, nhóm, membership, lịch học và OpenAPI.
- Đã áp dụng migration vào database local `streamora`; đủ 7 migration, không
  reset/seed. Không triển khai UI hoặc heartbeat trong mục này.
