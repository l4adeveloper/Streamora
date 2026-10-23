# T04 — API lịch học và vòng đời (mục 3)

Đã triển khai ClassSessionsModule theo [luồng nghiệp vụ](t04-scope.md) và
[database/contracts](t04-database.md). Mục này có lịch học, meet độc lập và các
thao tác bắt đầu/kết thúc/hủy. [Mục 4](t04-admission.md) đã bổ sung API xin vào,
accept/reject và vào/ra. [Mục 5](t04-realtime.md) đã có realtime/heartbeat;
[giao diện mục 6](../../frontend/docs/class-sessions.md) đã nối các luồng này.
API mới không gọi LiveKit.

## Chạy local và tài liệu API

Tại thư mục gốc, PostgreSQL đang hoạt động:

```sh
npm run db:migrate
npm run dev:api
```

Nếu API đang chạy bản cũ, dừng và chạy lại `dev:api` để build và nạp module mới.
Không cần chạy lại seed. Swagger khi API_DOCS_ENABLED=true:

- Giao diện: http://127.0.0.1:4000/api/v1/docs-sessions
- JSON: http://127.0.0.1:4000/api/v1/docs-sessions-json
- Bản lưu để review: [class-sessions-openapi.json](class-sessions-openapi.json).

Đăng nhập theo [hướng dẫn auth](auth-api.md), dùng accessToken qua Bearer hoặc
nút Authorize trong Swagger. Swagger không tự refresh access token. Các API
nghiệp vụ dưới đây không dùng refresh cookie để xác thực.

## Các endpoint

Tất cả có tiền tố `/api/v1`, yêu cầu đăng nhập:

```text
POST  /groups/:groupId/sessions  T04-01: tạo lịch học trong nhóm
GET   /groups/:groupId/sessions  T04-02: lịch học của nhóm
GET   /sessions/:sessionId       T04-03: chi tiết
PATCH /sessions/:sessionId       T04-04: sửa khi chưa bắt đầu
POST  /sessions/:sessionId/start T04-05: bắt đầu
POST  /sessions/:sessionId/end   T04-06: kết thúc
POST  /sessions/:sessionId/cancel        hủy trước khi bắt đầu
POST  /meets                            tạo meet độc lập
GET   /meets                            meet do chính tôi tạo
GET   /meets/:code                      thông tin tối thiểu trước khi vào meet
```

Tạo trả 201 `{session:ClassSession}`. Chi tiết/sửa/chuyển trạng thái trả 200
`{session:ClassSession}`. Danh sách trả `{items,nextCursor}`. Mọi response mới
dùng `Cache-Control: no-store`; lỗi theo hợp đồng T01 và có requestId.

## Tạo và sửa lịch học

Body tạo trong nhóm:

```json
{
  "title": "Ôn tập Điện toán đám mây",
  "description": "Chương 1 và 2",
  "scheduledAt": "2026-10-25T19:00:00+07:00"
}
```

Tạo meet dùng cùng title/description nhưng scheduledAt là tùy chọn. Cả hai
được tạo ở SCHEDULED; giao diện tạo meet ngay có thể gọi start tiếp với ID trả về.
Backend không tự bắt đầu theo giờ dự kiến và không tự ghi chủ phòng đã vào.

- Tên được trim, dài 1–100 ký tự; mô tả trim, tối đa 2000, chuỗi rỗng lưu null.
- Ngày giờ phải là ISO8601 đầy đủ, có Z hoặc offset, tối đa mili giây; từ chối
  ngày không tồn tại, ngày không có giờ hoặc giờ thiếu múi giờ. API trả UTC.
- Không nhận kind, groupId, createdById, joinCode hoặc status trong body.
  Nhóm lấy từ route; người tạo lấy từ identity đã xác thực.
- PATCH chỉ nhận các trường được cung cấp; `{}` không đổi updatedAt. title null
  bị từ chối; description null xóa mô tả. scheduledAt null chỉ dùng cho meet.
- Sửa khi LIVE/ENDED/CANCELLED trả 409 SESSION_NOT_EDITABLE.

## Phân quyền và bảo vệ dữ liệu

- Nhóm: HOST/OWNER/global ADMIN được tạo/sửa/bắt đầu/kết thúc/hủy. Thành viên
  thường chỉ xem danh sách/chi tiết. Dùng GroupAccessService T03 đọc quyền từ DB.
- Với sessionId, groupId luôn lấy từ bản ghi buổi học; thêm groupId vào query
  không thay đổi nhóm dùng để authorize.
- Meet: chủ phòng hoặc global ADMIN được quản lý và đọc đầy đủ. Vai trò HOST
  của một nhóm khác không cấp quyền quản lý meet.
- GET /meets chỉ liệt kê meet do người gọi tạo, kể cả khi người gọi là ADMIN.
- GET /meets/:code trả đúng `{meet:{id,title,host:{id,fullName},status}}`, không
  trả mô tả, email, hàng chờ hoặc danh sách người trong phòng. Mã dài 12 ký tự
  A–Z/0–9. Dùng mã của lớp thuộc nhóm ở endpoint này trả SESSION_NOT_FOUND.
- Người thường chưa vào meet không đọc được chi tiết đầy đủ bằng sessionId.
  Người tham gia dùng API enter của mục 4 để xác nhận đã vào trước khi đọc đầy đủ.
- Tài khoản bị khóa hoặc phiên đã logout bị chặn; thay đổi role/membership có
  hiệu lực với cả token đã cấp, không cần đăng nhập lại để server đọc quyền mới.
- Nhóm đã xóa mềm không còn truy cập được. Xóa nhóm có lớp LIVE trả 409 ACTIVE_SESSION.

## Danh sách và cursor

Query hỗ trợ status, cursor và limit (mặc định 20, tối đa 100). Query lạ, limit
sai hoặc status sai trả 400. Lịch nhóm sắp theo scheduledAt ASC/id ASC; meet của
tôi theo createdAt DESC/id DESC. Phân trang vẫn ổn định khi các thời điểm bằng nhau.

Cursor gắn với người gọi, nhóm hoặc danh sách meet của tôi, và bộ lọc status.
Đổi các điều kiện này phải bắt đầu lại từ trang đầu, không dùng cursor cũ.
Cursor sai trả 400 INVALID_CURSOR; không được dùng cursor để mở rộng quyền đọc.

## Vòng đời và retry

Các POST start/end/cancel chỉ nhận body `{}` hoặc không có body:

```text
SCHEDULED --start--> LIVE --end--> ENDED
SCHEDULED --cancel--> CANCELLED
```

- START khi LIVE, END khi ENDED, CANCEL khi CANCELLED trả hiện trạng và giữ mốc
  thời gian cũ. Những chuyển trạng thái khác trả 409 INVALID_SESSION_STATE.
- END làm PENDING/ACCEPTED hết hiệu lực bằng EXPIRED/closedAt, giữ lịch sử quyết
  định; đóng lượt tham gia còn mở với lý do SESSION_ENDED trong cùng transaction.
- ID không hợp lệ trả 400, không tồn tại trả 404. Người không có quyền bị 403
  trước khi nhận kết quả điều khiển hoặc response replay.

Header Idempotency-Key là tùy chọn, khuyến nghị gửi cho tạo và chuyển trạng thái.
Khóa có 1–128 ký tự ASCII không có khoảng trắng, được lưu theo user/thao tác/key:

- Tạo cùng key và nội dung đã chuẩn hóa trả response ban đầu; không tạo thêm
  buổi. Không gửi key thì mỗi POST tạo là một lần tạo mới.
- Đổi nội dung hoặc tài nguyên trong cùng phạm vi key trả 409 IDEMPOTENCY_CONFLICT.
- Key của chuyển trạng thái không vượt quyền hay vòng đời. Retry start cũ sau
  khi buổi đã ENDED vẫn trả INVALID_SESSION_STATE, không trả response LIVE cũ.
- Với chuyển trạng thái hợp lệ/lặp, trả trạng thái hiện tại; key mới cũng không
  thay đổi mốc bắt đầu/kết thúc đã ghi nhận.
- Replay tạo vẫn kiểm tra quyền hiện tại. Người mất quyền không đọc được
  response cũ thông qua key. Khóa hiện chưa tự hết hạn.

## Transaction, thứ tự khóa và sự kiện kết thúc

Mutation khóa user trước, sau đó khóa advisory của key nếu có, khóa group nếu
là lớp theo nhóm, rồi khóa session. Quyền và trạng thái được đọc lại trong
transaction. Xóa nhóm cũng khóa group cùng cách, nên start/delete không thể
đồng thời để lại lớp LIVE thuộc nhóm đã xóa. Các thao tác membership T03 cũng
được phối hợp bằng khóa group này.

Migration `20261023000200_class_session_lifecycle` bổ sung:

- class_session_commands: lưu hash nội dung, tài nguyên và response thành công
  để chống tạo trùng/replay qua nhiều API instance.
- class_session_end_events: lưu duy nhất một sự kiện kết thúc cho mỗi buổi,
  gồm eventId, sessionId, endedAt, version. Đây là outbox cho session.ended.v1.

Trạng thái ENDED, đóng admission/participation và sự kiện được commit cùng nhau.
Khóa advisory 73004 giữ thứ tự cấp version tới lúc commit giữa các buổi khác nhau.
Retry gửi sự kiện về sau phải giữ eventId; version public dùng chuỗi bigint.
Mục 5 đã có journal invalidation riêng để phát `session.ended` tới Socket.IO;
xem [realtime](t04-realtime.md). Outbox nghiệp vụ `session.ended.v1` có
[consumer/checkpoint ở mục 7](t04-integration.md) để T11 nối handler sau;
chưa gọi ghi hình hoặc đóng phòng media.

## Kiểm thử

```sh
npm run test:t04:api
npm run test:t04:database
npm run typecheck
npm run docs:t04
```

Kiểm thử API dùng database tạm và hai API instance với cổng ngẫu nhiên; tự dọn
database sau khi chạy. Không tạo tài khoản/buổi học thử trong database local đang dùng.
Bao phủ phân quyền, validation, UTC, cursor, dữ liệu preview, retry, chuyển trạng
thái, đóng admission, outbox duy nhất, tranh chấp start/end/edit/cancel/delete,
token cũ sau khi mất quyền, và Swagger. T04 không tạo group_rooms hoặc cấp token media.

## Kết quả khi hoàn tất mục 3 ngày 23/10/2026

- API build, Prisma validate và typecheck toàn monorepo: đạt.
- Unit: 35/35 đạt, gồm validation/OpenAPI T04 và hồi quy T01–T03.
- Tích hợp PostgreSQL: 40/40 đạt, gồm 13 API T04, 8 ràng buộc schema T04,
  database nền và hồi quy nhóm/thành viên T02–T03. Test tự dọn database tạm.
- Migration vòng đời đã áp dụng vào database local `streamora`; đủ 6 migration,
  không còn migration chờ, không chạy seed/reset hoặc tạo buổi học demo ở local.
- Đối chiếu schema không có chênh lệch T04. Default UUID cũ ở groups/group_rooms
  vẫn là chênh lệch đã ghi nhận từ mục 2, không được sửa trong mục này.
