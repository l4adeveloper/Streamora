# T04 — Database và contracts (mục 2)

Đã bổ sung schema, migration và kiểu dữ liệu theo [phạm vi T04](t04-scope.md).
Mục này chuẩn bị dữ liệu. [Mục 3](t04-api.md) đã có API lịch/vòng đời và kiểm tra
quyền quản lý; [mục 4](t04-admission.md) có xin vào/duyệt và vào/ra;
[mục 5](t04-realtime.md) bổ sung lease/journal và heartbeat;
[mục 6](../../frontend/docs/class-sessions.md) đã nối giao diện.
[Mục 7](t04-integration.md) thêm bảng `class_session_end_consumers` để ghi checkpoint
consumer nghiệp vụ; không ảnh hưởng journal invalidation của realtime.

## Các bảng mới

- `class_sessions`: phân biệt GROUP/MEET, nhóm nếu có, người tạo, tên/mô tả,
  mã tham gia, lịch dự kiến, trạng thái và các mốc bắt đầu/kết thúc/hủy.
  `created_by_id` là người tạo, không phải vai trò HOST cố định của nhóm.
- `class_join_requests`: lưu từng lần xin vào, người xin, quyết định và người
  duyệt. Trạng thái PENDING/ACCEPTED còn hiệu lực; REJECTED/CANCELLED/EXPIRED/REVOKED
  đã đóng. Thêm lại thành viên không tự khôi phục yêu cầu REVOKED.
- `class_participations`: lưu từng lượt thực sự vào/ra, yêu cầu đã cấp quyền nếu
  có, thời điểm hoạt động cuối và lý do rời. Người quản lý vào trực tiếp có
  `join_request_id = null`. `last_seen_at` do server cập nhật, không nhận từ client.

Các bảng này tách biệt hoàn toàn với `auth_sessions`, `group_rooms` và LiveKit.
Không sao chép membership nhóm. Mã tham gia dài 12 ký tự A–Z/0–9, duy nhất trong
database; backend sẽ sinh ngẫu nhiên ở mục API. Biết mã không cấp quyền vào phòng.

## Các ràng buộc tại database

- GROUP bắt buộc có nhóm và lịch; MEET không được có nhóm, lịch có thể trống.
- Trạng thái hiện tại phải khớp mốc thời gian: LIVE có startedAt; ENDED có
  startedAt/endedAt đúng thứ tự; CANCELLED chỉ có cancelledAt.
- Tên không rỗng sau khi bỏ khoảng trắng; tối đa 100 ký tự, mô tả tối đa 2000.
- Một người chỉ có một yêu cầu PENDING hoặc ACCEPTED còn hiệu lực trong một buổi.
  Partial unique index này bảo vệ cả khi gửi đồng thời qua nhiều instance.
- Quyết định phải có cả người duyệt và thời điểm duyệt; yêu cầu đã đóng có closedAt.
  EXPIRED/REVOKED giữ lại người/thời điểm duyệt cũ nếu từng được accept.
- Một người chỉ có một lượt chưa rời trong một buổi. Lượt đã rời phải có lý do
  và thời điểm không trước lúc vào; các lượt cũ được giữ lại.
- Một yêu cầu chỉ gắn với tối đa một lượt vào. Khóa ngoại tổng hợp bảo đảm yêu
  cầu đó thuộc đúng buổi và đúng người, không dùng yêu cầu của người khác.
- Khóa ngoại RESTRICT giữ dữ liệu tham chiếu khi có thao tác xóa cứng. Xóa mềm
  nhóm theo T02 vẫn giữ lịch sử; chặn xóa mềm nhóm LIVE sẽ làm ở mục API.
- Lưu timestamp bằng TIMESTAMPTZ(3). Index hỗ trợ lịch theo nhóm, lọc trạng thái,
  meet do mình tạo, hàng chờ, lịch sử yêu cầu và người đang tham gia.

CHECK và partial unique index nằm trong SQL migration, Prisma chưa biểu diễn
đầy đủ trong schema. Khi tạo migration tiếp theo phải giữ các ràng buộc này.

## Các quy tắc sẽ triển khai ở service

Database kiểm tra hình dạng dữ liệu, không tự quyết định quyền nghiệp vụ:

- Auth, membership, quyền host, khả năng xem danh sách và quyền đọc theo mã.
- Các chuyển trạng thái chỉ SCHEDULED → LIVE → ENDED hoặc SCHEDULED → CANCELLED.
  CHECK không ngăn cập nhật một bản ghi ENDED thành một trạng thái hợp lệ khác;
  service phải kiểm tra trạng thái cũ trong transaction có khóa.
- Chỉ xin/duyệt/vào khi LIVE; phải ACCEPTED trước khi vào, trừ người có quyền quản lý.
  Khóa ngoại không thay thế kiểm tra trạng thái yêu cầu hoặc quyền vào trực tiếp.
- Kết thúc/rời/thu hồi quyền phải đóng lượt và làm hết hiệu lực yêu cầu ACCEPTED
  trong cùng transaction. Gửi lại yêu cầu cũ không được ghi đè quyết định.
- Idempotency cho create/start/end/request và outbox kết thúc sẽ bổ sung cùng
  các API tương ứng. Mục 2 chưa phát sự kiện hoặc tạo tác vụ ghi hình.
- Kết nối nhiều tab, heartbeat và thời hạn reconnect thuộc mục realtime.

## Contracts

`backend/contracts/src/class-sessions.ts` được export từ `@streamora/contracts`:

- ClassSession là union GROUP/MEET; GROUP có groupId/scheduledAt bắt buộc, MEET
  có groupId null. Có request/response cho tạo, sửa, danh sách và chi tiết.
- ClassJoinRequest và ClassParticipation tách quyết định duyệt với lượt tham gia.
  Danh sách dành cho host/người trong phòng có tên hiển thị, không đưa password,
  token hoặc email vào các kiểu dữ liệu mới.
- MeetPreview là thông tin tối thiểu trước khi được vào meet độc lập.
- ClassAdmissionResponse chỉ có trạng thái của chính người gọi và quyền hiện tại.
- ClassSessionEndedEvent giữ eventId, sessionId, endedAt và version kiểu chuỗi
  thập phân để không mất độ chính xác bigint khi truyền JSON.
- Thời gian public là chuỗi ISO8601 UTC. Prisma/Date không được import vào contracts.

## Cài đặt và kiểm tra

Sau khi pull code, tại thư mục gốc:

```sh
npm run db:migrate
npm run db:status
npm run test:t04:database
npm run typecheck
```

`db:migrate` chỉ thêm enum/bảng/index mới, không reset hoặc seed dữ liệu hiện có.
Nếu API/realtime đang chạy, khởi động lại sau khi build để dùng Prisma Client mới.

`test:t04:database` build API, tạo database kiểm thử riêng, áp dụng toàn bộ migration,
kiểm tra ràng buộc/đồng thời/khóa ngoại rồi tự dọn database tạm. Cần PostgreSQL
local hoạt động và tài khoản có CREATEDB. Kiểm thử không dùng LiveKit.

Migration mới: `20261023000100_class_sessions`. Phần kiểm thử database nền cũng
được cập nhật để kiểm tra đủ ba bảng và migration mới.

## Kết quả kiểm tra khi hoàn tất mục 2 ngày 23/10/2026

- `npm run db:validate`: đạt.
- `npm run typecheck`: đạt toàn monorepo; API build và Prisma Client generate đạt.
- Kiểm thử PostgreSQL trên database tạm: 8/8 kiểm thử T04 và 5/5 kiểm thử database
  nền đạt, gồm gửi đồng thời, khóa ngoại, thời gian và lưu lịch sử.
- Đã áp dụng migration vào database local `streamora`; `npm run db:status` xác
  nhận đủ 5 migration và không còn migration chờ. Không chạy seed/reset.
- Đối chiếu Prisma với database không có chênh lệch ở ba bảng T04. Có chênh lệch
  default UUID đã tồn tại ở `groups`/`group_rooms`; mục này không sửa các bảng đó.
