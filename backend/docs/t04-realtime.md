# T04 — Realtime và heartbeat (mục 5)

Mục 5 bổ sung Socket.IO cho [lịch/vòng đời](t04-api.md) và
[xin vào, duyệt, vào/ra](t04-admission.md). Các thao tác nghiệp vụ vẫn qua HTTP;
socket thông báo thay đổi và duy trì lượt tham gia đã được server cho phép.
Không cần thêm dependency, Redis hoặc LiveKit để chạy phần này.

## Chạy local

Tại gốc repository, sau khi PostgreSQL hoạt động:

```sh
npm run db:migrate
npm run dev:api
```

Terminal khác, nếu muốn dùng service realtime riêng:

```sh
npm run dev:realtime
```

Namespace mới là `/sessions`: `http://127.0.0.1:4001/sessions` khi dùng realtime
riêng, hoặc `http://127.0.0.1:4000/sessions` trên API. Cả hai sử dụng cùng database
và khóa ký access token. Đây là namespace Socket.IO, không phải đường dẫn HTTP
`/api/v1/sessions`. Namespace `/classroom` của T03 giữ nguyên.

Sau khi pull migration cần khởi động lại API/realtime để dùng schema và build mới.
[Giao diện T04 mục 6](../../frontend/docs/class-sessions.md) đã nối watch/attach và
heartbeat ở các trang buổi học/Meet mới. Thử HTTP enter riêng thì lượt đó cũng
hết hạn sau 30 giây nếu chưa attach.

## Xác thực và watch

Handshake dùng `auth: { accessToken }`. Server xác minh JWT, phiên đăng nhập và
tài khoản; Origin nếu có phải trùng WEB_ORIGIN. Kết nối không có Origin vẫn dùng
được cho client Node đã xác thực, giống chính sách T03. Client cập nhật token qua
`auth:refresh {accessToken}`; token phải cùng user và cùng phiên đăng nhập. Đổi tài
khoản hoặc đổi phiên đăng nhập cần kết nối mới.

Mỗi thông điệp có acknowledgement:

```json
{ "ok": true, "data": {} }
```

Hoặc `{ok:false,error:{code,message}}`. Sai body/UUID/field thừa trả
VALIDATION_ERROR; mất auth đóng namespace. Lỗi database trả SERVICE_UNAVAILABLE,
không trả chi tiết truy vấn/token. Server kiểm tra lại auth khi nhận thao tác và
trong mỗi vòng gửi, cả khi socket không gửi gì.

- `session:watch {sessionId}`: theo dõi tối đa 8 buổi trên một socket. Trả
  `{sessionId,admission,version,heartbeatIntervalMs,reconnectGraceMs}`. `admission`
  chỉ chứa yêu cầu/lượt tham gia/quyền của chính người gọi, cùng dạng API admission.
  GROUP yêu cầu membership hiện tại; MEET cho người đã đăng nhập theo dõi trạng
  thái của mình mà không cấp quyền xem hàng chờ hoặc danh sách người tham gia.
- `session:unwatch {sessionId}`: bỏ theo dõi; kết nối đã attach được chuyển sang
  thời gian chờ khôi phục. Đây không phải thao tác rời phòng chủ động.
- Watch, reconnect và refresh token không tạo yêu cầu hoặc lượt vào.

Client đăng ký listener trước khi watch. Sau watch/reconnect, lấy lại admission,
chi tiết, hàng chờ và participants qua HTTP theo quyền; không dựa vào việc đã
nhận đủ các thông báo trước lúc mất mạng. Dùng quyền server trả về để điều khiển UI.

## Các thông báo server

Các invalidation từ journal có cùng dạng:

```json
{
  "eventId": "uuid",
  "sessionId": "uuid",
  "version": "123"
}
```

- `session.changed`: lịch, nội dung hoặc trạng thái thay đổi; gửi watcher còn
  đủ điều kiện. Client đọc lại nội dung được phép qua HTTP.
- `session.ended`: buổi đã kết thúc; gửi watcher còn quyền. Không đóng buổi khi
  host chỉ rời hoặc mất mạng.
- `queue.changed`: yêu cầu được tạo/đổi trạng thái; chỉ người quản lý hiện tại.
- `admission.changed`: chỉ người có yêu cầu/lượt tham gia bị thay đổi.
- `participants.changed`: chỉ người quản lý hoặc người đang được phép tham gia.
- `access.changed`: thay đổi membership/nhóm; chủ thể nhận thông báo về quyền
  của mình. Thay đổi toàn nhóm gửi các watcher vẫn còn quyền.

Payload không có tên, email, nội dung hàng chờ hoặc quyết định của người khác.
Quyền được đọc lại ngay trước mỗi đợt gửi; hạ HOST thu hồi thông báo hàng chờ nhưng
giữ lượt tham gia đang hợp lệ như VIEWER. Xóa membership không còn nhận dữ liệu
phòng. API cũng kiểm tra quyền độc lập với socket.

Hai thông báo điều khiển riêng:

- `session.access-revoked {sessionId}`: không còn quyền theo dõi, server tự bỏ watch.
- `participation.closed {sessionId,participationId,reason}`: lượt đã attach bị đóng
  do LEFT, DISCONNECTED, SESSION_ENDED hoặc ACCESS_REVOKED. Có thể chỉ ra lượt cũ
  dù một tab khác đã tạo lượt mới; UI phải đối chiếu participationId.

Các invalidation là tín hiệu tải lại, có thể nhận lặp khi retry. Dedupe bằng eventId;
version là chuỗi bigint, dùng BigInt khi cần so sánh. Không lấy số lượng event làm
số người tham gia, không áp dụng lại quyết định từ event cũ. Nếu gom nhiều loại
event theo version, phải tải lại toàn bộ dữ liệu liên quan; nếu xử lý từng loại,
giữ mốc phiên bản riêng theo loại để không bỏ qua một thông báo cần thiết.

## Attach, heartbeat và thời hạn

1. Dùng HTTP xin vào/duyệt, sau đó HTTP enter với Idempotency-Key theo mục 4.
2. Sau khi có participationId, watch buổi và gửi
   `participation:attach {sessionId,participationId}` trên từng socket/tab.
3. Gửi `participation:heartbeat {sessionId,participationId}` mỗi 10 giây.
   Attach/heartbeat trả `{participationId,serverTime,expiresAt}` theo giờ database.
4. Muốn rời ngay thì gọi HTTP leave với participationId; đóng socket/unwatch chỉ
   bắt đầu thời gian chờ.

Server gắn mỗi lease với lượt tham gia, phiên đăng nhập, socket và instance.
Socket khác không được heartbeat lease thay mình. Attach kiểm tra quyền và lượt
đang hiệu lực; socket không tự enter hoặc dùng lượt của người khác.

- TTL lease và thời gian khôi phục là 30 giây. Sau HTTP enter cũng có 30 giây
  để attach. Heartbeat cập nhật mốc hoạt động bằng giờ server.
- Disconnect/unwatch khi lease còn hạn cho 30 giây để reconnect. Lặp callback
  hoặc disconnect một lease đã hết hạn không gia hạn thời gian này.
- Chỉ cần một kết nối/lease còn hiệu lực, người dùng vẫn là một người trong phòng.
  Trong thời gian chờ reconnect, participants vẫn tính lượt đó; danh sách này
  không phải số socket đang mở ngay tại thời điểm truy vấn.
- Khi toàn bộ lease và thời gian khôi phục hết hạn, đóng lượt DISCONNECTED và
  chuyển admission đã dùng sang EXPIRED. Heartbeat muộn không hồi sinh lượt cũ;
  người thường phải chủ động xin duyệt lại. Người quản lý có thể enter lượt mới.
- Khi một tab leave, đóng lượt dùng chung trên mọi tab ngay trong transaction.
  Retry leave cũ không đóng lượt mới. Kết thúc buổi đóng mọi lượt cùng hàng chờ.
- Đăng xuất làm vô hiệu lease của phiên đăng nhập đó. Nếu một phiên đăng nhập
  khác còn lease hợp lệ thì vẫn giữ lượt; không còn lease hợp lệ thì đóng
  ACCESS_REVOKED. Tài khoản bị khóa hoặc mất membership cũng đóng lượt.
- API kiểm tra TTL khi đọc quyền và trước khi ghi; không cần chờ sweeper để chặn
  vào lại bằng grant đã hết hạn. Một phản hồi admission trong khoảng trước khi
  sweeper lưu closure có thể còn bản ghi leftAt null, nhưng quyền đã bị chặn.

## Lưu dữ liệu và nhiều instance

Migration `20261023000400_class_realtime` bổ sung:

- `class_presence_leases`: trạng thái kết nối có hạn; FK tới participation và
  auth_session. Khi đóng lượt, trigger xóa mọi lease của lượt đó.
- `presence_checked_at` và index trên participation để sweeper quét luân phiên.
- `class_session_changes`: journal thay đổi tối thiểu; không lưu access token,
  nội dung hàng chờ hoặc bản sao quyền. Trigger ghi cùng transaction nghiệp vụ.

Mỗi instance đọc journal độc lập mỗi 500ms, tối đa 100 event/lần, rồi gửi tới
các socket cục bộ theo quyền hiện tại. Advisory lock 73005 cấp version và giữ
đến commit, tránh bỏ sót một transaction commit muộn có version nhỏ. Khi gặp lỗi,
cursor không tiến lên; retry giữ eventId. Heartbeat không tạo invalidation mới.

Sweeper chạy mỗi giây, tối đa 100 lượt/lần và đọc lại sau khi giữ khóa user →
group → session. Hai instance quét đồng thời không đóng nhầm lượt mới. Database
mất kết nối hoặc tải lớn có thể làm chậm thông báo/lưu closure; quyền HTTP vẫn
kiểm tra TTL hiện tại khi database hoạt động. Sau khi process chết, lease tự hết
hạn; process khác hoặc process vừa khởi động tiếp tục quét từ database.

Khi khởi động, dispatcher bắt đầu ở cuối journal; client kết nối lại phải dùng
snapshot/HTTP để khôi phục trạng thái. Chưa có API replay toàn bộ journal hoặc
tác vụ dọn journal; dữ liệu lịch sử được giữ. Socket.IO đang dùng WebSocket cho
kiểm thử; cấu hình load balancer, Redis adapter hoặc sticky session khi mở rộng
hạ tầng nằm ngoài mục này.

`session.ended` của socket là invalidation riêng với sự kiện nghiệp vụ bền vững
`session.ended.v1` ở `class_session_end_events` (mục 3). Sự kiện nghiệp vụ vẫn có
đúng một bản ghi/buổi. [Mục 7](t04-integration.md) đã bổ sung consumer/checkpoint
để T11 nối handler. Chưa dispatch sang worker ghi hình hoặc LiveKit; không dùng
lẫn version/eventId của hai journal.

## Kiểm thử

```sh
npm run test:t04:realtime
npm run test:database
npm run typecheck
```

Test dùng socket thật, hai Nest server và database tạm riêng, tự dọn sau khi chạy.
Bao phủ auth/Origin, privacy, phát giữa instance, attach giả mạo, heartbeat, nhiều
tab, reconnect/timeout, leave/end, thu hồi quyền/khóa tài khoản/logout, refresh
token, lease từ process chết và thứ tự commit journal. Không ghi dữ liệu demo
vào database ứng dụng và không gọi LiveKit.

## Kết quả ngày 23/10/2026

- Typecheck toàn monorepo, build API/realtime, Prisma validate và OpenAPI check: đạt.
- 133/133 kiểm thử backend đạt: 37 unit và 96 integration, gồm 16 kiểm thử realtime
  mới. Bộ hồi quy có auth, nhóm, membership, lịch học, admission và schema.
- Migration đã áp dụng vào database local `streamora`; đủ 8 migration, không còn
  migration chờ. Không chạy seed/reset hoặc thay đổi mật khẩu tài khoản.
- Đối chiếu Prisma/database không có chênh lệch T04. Chênh lệch default UUID cũ
  ở groups/group_rooms vẫn giữ nguyên như các mục trước.
- Kết quả mục 5 dùng socket Node thật. Giao diện và kiểm thử trình duyệt đã bổ sung
  ở [mục 6](../../frontend/docs/class-sessions.md).
