# T04 — Điểm tích hợp T05/T11 (mục 7)

Mục này xuất bộ kiểm tra lượt tham gia để T05 dùng trước chức năng trong buổi học,
và consumer có checkpoint cho sự kiện kết thúc để T11 tích hợp. Không thêm HTTP
endpoint, gọi LiveKit, phát token media hoặc chạy ghi hình. API T04 vẫn có 19 thao tác.

## Kiểm tra lượt tham gia cho T05

Import `ClassSessionsModule` vào module Nest của tính năng mới. Các thành phần
public có ở `src/modules/class-sessions/index.ts`:

- `ClassParticipantService`: đọc lại quyền/lượt tham gia hoặc chạy callback cùng
  transaction để serialize thao tác DB với leave/end/thay đổi quyền.
- `RequireClassParticipation`: ghép AccessTokenGuard T01 và ClassParticipantGuard.
- `CurrentClassParticipant`: lấy context đã được guard xác minh từ request.

Ví dụ chữ ký của một controller tích hợp:

```ts
@Get("sessions/:sessionId/participations/:participationId/context")
@RequireClassParticipation()
context(@CurrentClassParticipant() context: ClassSessionParticipantContext) {
  return context;
}
```

Đây chỉ là ví dụ dùng guard, không phải endpoint mới của T04. Dùng
`@RequireClassParticipation({manage:true})` để thêm điều kiện quản lý. Có thể đổi
tên params qua `{sessionParam:"lessonId", participationParam:"visitId"}` nếu
route khác. Đây là cấu hình trong code, không lấy từ body/query client.

Điều kiện được kiểm tra ở server:

1. Actor từ CurrentAuth T01, gồm user ID và auth-session ID. JWT/phiên/tài khoản
   còn hợp lệ; service cũng kiểm tra lại auth-session trong DB.
2. Resolve sessionId từ DB và kiểm tra LIVE. GROUP lấy groupId từ bản ghi, kiểm
   tra nhóm/membership hiện tại; MEET xác định chủ bằng createdById.
3. Có lượt đang mở, grant còn hiệu lực và chưa hết TTL. Được accept nhưng chưa
   enter không đủ. HOST/OWNER/ADMIN cũng phải enter.
4. ParticipationId đúng lượt hiện tại, đúng actor và session. Lượt cũ đã rời,
   lượt của người khác hoặc lượt trước khi xin vào lại đều bị chặn.
5. Nếu yêu cầu manage thì quyền quản lý vẫn còn. Hạ HOST về VIEWER giữ lượt đang
   hợp lệ nhưng không vượt điều kiện manage.

Context chứa `session {id,kind,groupId,status:LIVE}`, `userId`, `authSessionId`,
`participationId`, `canManage`, `checkedAt` UTC. Không có email, JWT, joinCode,
quyết định người khác hoặc token media. Auth-session ID là tham chiếu nội bộ,
không thay bearer. Context là kết quả tại một thời điểm, không cache làm chứng
nhận vào phòng. Module sau chỉ trả dữ liệu cần cho chức năng của mình ra frontend.

`ClassParticipantService.require(actor, sessionId, participationId, manage?)`
phục vụ kiểm tra đọc. Guard không giữ transaction qua controller. Để ghi DB hoặc
ký cục bộ ngay sau khi kiểm tra, dùng:

```ts
return this.participants.withParticipant(
  { userId: identity.user.id, authSessionId: identity.sessionId },
  context.session.id,
  context.participationId,
  async (current, tx) => {
    // Ghi dữ liệu của module qua tx hoặc ký cục bộ theo current.
    // Không lấy role/groupId từ body. Chính sách media do T05 quy định.
    return current;
  },
  true, // Tùy chọn: đòi quyền quản lý.
);
```

Service khóa user → auth_session → group → class_session, rồi đọc quyền hiện tại.
Leave/end/removal không commit chen giữa callback và DB commit. Callback dùng tx
được truyền vào, không mở transaction lồng hoặc gọi network lâu trong khóa.
Giới hạn transaction 10 giây. checkedAt/TTL vẫn là kiểm tra tại thời điểm cấp quyền,
không kéo dài phiên/lượt tham gia hoặc ngăn thời gian trôi trong callback.

Thiếu decorator/metadata thì chặn. Identity luôn từ AccessTokenGuard, không dùng
userId/query/body client. Service không xác minh chữ ký JWT thay cho guard.
Lỗi chính: 401 UNAUTHENTICATED; 403 FORBIDDEN/ADMISSION_REQUIRED/ADMISSION_REVOKED;
409 SESSION_NOT_LIVE; 400 VALIDATION_ERROR. Guard LIVE này không thay chính sách
xem lịch sử/tệp/bản ghi sau buổi học của T03/T14/T15.

T05 tự lưu ánh xạ sessionId → phòng media trong module của mình. Không coi
class_sessions.id là group_rooms.id hoặc dùng joinCode làm quyền kết nối media.
Token/URL đã phát hành và việc thu hồi ở hệ thống media cần chính sách TTL/cleanup
của T05/T03; context T04 không tự thu hồi một token của dịch vụ ngoài.

## Sự kiện kết thúc cho T11

`class_session_end_events` là outbox nghiệp vụ ghi cùng transaction ENDED và
đóng admission/participation. Một session có đúng một event kết thúc; retry end
không tạo event mới. Hợp đồng `ClassSessionEndedMessage` trong contracts:

```json
{
  "type": "session.ended.v1",
  "payload": {
    "eventId": "uuid",
    "sessionId": "uuid",
    "endedAt": "2026-10-23T06:00:00.000Z",
    "version": "123"
  }
}
```

Payload giữ nguyên `ClassSessionEndedEvent` đã có. Version là chuỗi bigint, so
sánh bằng BigInt. Không yêu cầu version liên tiếp: rollback có thể để khoảng trống.
Khóa advisory 73004 của producer giữ thứ tự version đến commit, tránh bỏ qua
event commit muộn hơn.

Đây là luồng riêng với Socket.IO `session.ended`/`class_session_changes`. Không
lấy thông báo UI làm lệnh dừng ghi hình hoặc trộn eventId/version hai journal.
Leave/timeout của host và CANCELLED không phát event kết thúc buổi.

## Consumer có checkpoint

`ClassSessionEventsService` cung cấp:

- `consumeNext(name, handler)`: xử lý một event tiếp theo; trả message đã xử lý
  hoặc null nếu bắt kịp. Handler nhận `(message, tx)`.
- `consumeBatch(name, handler, limit=25)`: xử lý tối đa limit event, trả số đã xử
  lý bởi lần gọi đó. Limit nguyên 1–100. Từng event commit riêng; lỗi sau không
  rollback những event trước đã hoàn tất.

Tên ổn định theo chức năng, ví dụ `recording-session-end-v1`, theo regex
`^[a-z][a-z0-9_.-]{0,99}$`. Không đổi tên mỗi restart/request/user. Mỗi tên có
checkpoint riêng trong `class_session_end_consumers`. Tên mới đọc từ đầu lịch sử
còn lưu; restart giữ nguyên tên để tiếp tục, không tự nhảy đến cuối.

Transaction khóa hàng checkpoint, chọn event có version lớn hơn mốc hiện tại,
gọi handler rồi cập nhật checkpoint. Handler thành công mới ack; ghi DB của
handler và checkpoint dùng cùng tx. Handler throw/process chết trước commit
rollback cả hai; lần gọi sau nhận cùng eventId. Hai worker cùng tên tuần tự hóa
qua khóa DB, không commit trùng hiệu ứng DB. Tên khác nhận lịch sử độc lập.

```ts
await this.sessionEvents.consumeBatch(
  "recording-session-end-v1",
  async ({ payload }, tx) => {
    // T11 upsert job bền vững qua tx, dedupe bằng payload.eventId.
    // Resolve recording/room từ DB theo payload.sessionId, không từ client.
    // Worker riêng thực hiện I/O; không gọi LiveKit trong transaction này.
  },
  25,
);
```

Mục 7 chưa chạy consumer mặc định vì chưa có handler T11 thật. T11 tự đặt lịch
gọi batch, retry/backoff và theo dõi lỗi; không swallow lỗi rồi coi là đã ack.
Worker độc lập chỉ cần `ClassSessionEventsModule` cùng DatabaseModule cấu hình
PostgreSQL, không cần ClassSessionsModule đầy đủ. Event module không khởi động
gateway, auth, LiveKit hoặc broker. Consumer hiện tại yêu cầu cùng DB chứa outbox;
chưa có HTTP feed hoặc RabbitMQ publisher mới.

Nguyên tử chỉ áp dụng cho hiệu ứng DB trong cùng tx. Gọi dịch vụ ngoài trực tiếp
trong handler vẫn có thể gửi lặp nếu crash sau khi đích đã nhận. T11 dedupe ở đích
bằng eventId hoặc ghi outbox/job của mình qua tx để worker riêng thực hiện I/O.
T04 không tuyên bố exactly-once qua network. Lỗi DB/lock/handler trả cho caller;
checkpoint không tiến qua event lỗi. Không có API xóa/nhảy checkpoint hoặc dọn
lịch sử ở mục này.

## Migration và kiểm thử

`20261023000500_class_integration` chỉ thêm bảng checkpoint, không sửa buổi học,
tài khoản/mật khẩu hoặc chạy seed. Sau khi pull:

```powershell
npm run db:migrate
npm run db:status
npm run test:t04:integration
npm run typecheck
```

Test dùng controller T05 giả lập chỉ trong file kiểm thử, hai API instance và
PostgreSQL tạm thật. Bao phủ vào thực sự, giả mạo/stale ID, quyền/phiên bị thu hồi,
TTL, transaction cạnh tranh end; thứ tự event, rollback/retry, nhiều consumer,
hai worker, restart, bigint và event module không có gateway. Không cần LiveKit.

Tham chiếu: [phạm vi](t04-scope.md), [API vòng đời](t04-api.md),
[admission](t04-admission.md), [realtime](t04-realtime.md),
[giao diện](../../frontend/docs/class-sessions.md).

## Kết quả ngày 23/10/2026

- Build API/realtime, typecheck toàn monorepo, Prisma validate và OpenAPI check: đạt.
- 146/146 kiểm thử backend đạt: 37 unit và 109 integration, gồm 13 kiểm thử mới
  cho guard/service, transaction và consumer T05/T11. Bộ hồi quy gồm T01–T04.
- Database local `streamora` đã nhận đủ 9 migration, không còn migration chờ.
  Không chạy seed/reset hoặc thay đổi mật khẩu. Bảng checkpoint sẵn sàng, chưa
  có consumer T11 tự chạy hoặc handler media mới.
- Đối chiếu schema không có chênh lệch T04; default UUID cũ ở groups/group_rooms
  được giữ nguyên. Không thêm dependencies, broker, LiveKit hoặc endpoint public.
- Frontend không đổi ở mục này; các kết quả UI của mục 6 vẫn ghi riêng trong
  [hướng dẫn giao diện](../../frontend/docs/class-sessions.md).
