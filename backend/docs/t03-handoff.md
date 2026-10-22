# T03 — Thành viên và phân quyền nhóm

## Sử dụng

Trong workspace, mở **Thành viên** từ sidebar. Chọn nhóm hiện tại ở đầu sidebar.
Từ trang chi tiết nhóm cũng có liên kết **Quản lý thành viên** mở đúng nhóm.
Danh sách lấy dữ liệu thật, hiển thị tên, email đăng ký và vai trò. Tìm tên/email
có debounce 300 ms và phân trang 20 người, bỏ qua kết quả tìm kiếm đã cũ.

OWNER hoặc global ADMIN thêm thành viên bằng email chính xác đã đăng ký, chọn
HOST/VIEWER, đổi vai trò và xác nhận xóa thành viên. Tài khoản không tồn tại hoặc
bị khóa không được thêm. OWNER luôn được đánh dấu và bảo vệ khỏi đổi vai trò/xóa.
HOST/VIEWER chỉ xem và tìm trong danh sách của nhóm, không được tra cứu tài khoản
ngoài nhóm hoặc quản lý người khác. Theo yêu cầu giao diện bổ sung, email hiển thị
cho các thành viên trong nhóm, thay cho quy tắc chỉ quản lý nhìn thấy trong file kế hoạch.

## Chạy và kiểm tra

```sh
npm run db:migrate
npm run dev:api
npm run dev
# Tùy chọn khi frontend trỏ NEXT_PUBLIC_REALTIME_URL sang cổng 4001:
npm run dev:realtime
npm run test:t03
npm run docs:t03
```

Gateway `/classroom` được gắn vào API trên cổng 4000. Service realtime cổng 4001
dùng lại cùng module, DB và bộ xác thực. Đã loại bỏ gateway chat/kênh ẩn danh cũ.
Nếu không đặt `NEXT_PUBLIC_REALTIME_URL`, frontend dùng host của API. Khi đã đặt
biến này, cần chạy service tương ứng. Sau khi nhận sự kiện/reconnect/focus,
frontend đọc lại quyền server; kiểm tra bổ sung mỗi 15 giây khi socket bị chặn.
Không đưa secret LiveKit vào biến `NEXT_PUBLIC_*`.

Schema kế thừa `group_members` của T02. Migration T03 thêm index phân trang,
outbox `membership_changes`, quota lookup dùng chung instance và ánh xạ `group_rooms`.
Không tạo bảng membership trùng hoặc thay đổi dữ liệu tài khoản hiện có.

## Hợp đồng T03

Tất cả HTTP dùng Bearer và tiền tố `/api/v1`, response lỗi dùng mẫu chung T01.
Swagger T03: `/api/v1/docs-memberships`, JSON `/api/v1/docs-memberships-json` khi
`API_DOCS_ENABLED=true`. Bản lưu: `backend/docs/memberships-openapi.json`.
Swagger T01 giữ nguyên để đồng đội có thể tiếp tục kiểm tra hợp đồng tài khoản.

| Mã     | Giao tiếp                                         | Quyền / kết quả                                                                                                    |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| T03-01 | `GET /users/lookup?groupId&email`                 | OWNER/ADMIN, email trim/lowercase chính xác; `{user:null}` nếu không thấy; 30 lần/phút/user, quota atomic trong DB |
| T03-02 | `GET /groups/:groupId/members?q&cursor&limit`     | MEMBER/ADMIN; `{items,nextCursor}`, email/tên; cursor gắn với nhóm và bộ lọc                                       |
| T03-03 | `POST /groups/:groupId/members`                   | OWNER/ADMIN; `{userId,role:HOST\|VIEWER}`; 201, `USER_NOT_FOUND`, `ALREADY_MEMBER`                                 |
| T03-04 | `PATCH /groups/:groupId/members/:userId`          | OWNER/ADMIN; `{role:HOST\|VIEWER}`; 200, `OWNER_PROTECTED`                                                         |
| T03-05 | `DELETE /groups/:groupId/members/:userId`         | OWNER/ADMIN; 204, `OWNER_PROTECTED`; quyền bị thu hồi khi commit                                                   |
| T03-06 | `GET /groups/:groupId/permissions/me`             | MEMBER/ADMIN; role, canManageMembers, canHost, canUpload, canViewRecordings                                        |
| T03-07 | `membership.changed` server → client `/classroom` | Chỉ socket của user bị tác động; `{groupId,userId,role,removed,version}`                                           |

`version` là chuỗi số thập phân biểu diễn bigint để tránh mất độ chính xác.
Sự kiện không thay cho việc authorize server. Client reconnect phải đọc quyền mới.

## Dùng chung phân quyền

`MembershipsModule` export `GroupAccessService`, `GroupAccessGuard` và
`SessionSecurityModule`. Không dùng group role từ JWT, request hoặc cache để cấp quyền.
Service đọc user còn hoạt động, global role hiện tại, nhóm chưa xóa và membership từ DB.
Global ADMIN có quyền trên mọi nhóm còn hoạt động, không cần membership của nhóm.
OWNER là người có `groups.owner_id`; một membership OWNER sai ownerId không cấp quyền.

| Vai trò hiệu lực    | Quản lý thành viên | Điều khiển lớp / ghi cloud | Upload / ghi cục bộ | Xem bản ghi |
| ------------------- | ------------------ | -------------------------- | ------------------- | ----------- |
| ADMIN / OWNER       | Có                 | Có                         | Có                  | Có          |
| HOST                | Không              | Có                         | Có                  | Có          |
| VIEWER              | Không              | Không                      | Có                  | Có          |
| Ngoài nhóm / bị xóa | Không              | Không                      | Không               | Không       |

Frontend dùng `useGroupPermissions(groupId)` cho workspace lớp học, thư viện và bản ghi.
Hook không giữ quyền nhóm cũ khi đổi nhóm/tài khoản, vô hiệu quyền tạm thời khi có
membership.changed, xác minh lại trên server và ngừng track thiết bị khi bị thu hồi.

Backend: `access.require(userId, groupId, permission?)`. Với tài nguyên đã tồn tại,
**lấy groupId từ bản ghi phía server**, không từ query/body tùy ý của client.
Ví dụ phòng: `@RequireGroupAccess(undefined, "room", "id")` resolve `group_rooms.id`;
thay `undefined` bằng `"canHost"` để bảo vệ thao tác host. Test đã kiểm tra giả mạo
query groupId không vượt quyền đọc phòng.

`POST /rooms` hiện yêu cầu Bearer, `{name,groupId}` và canHost, lưu ánh xạ phòng vào DB.
`GET /rooms/:id` xác thực membership theo ánh xạ đó. `GET /files` yêu cầu Bearer,
query `groupId` và quyền hiện hành; danh sách nội dung vẫn là dữ liệu minh họa của T15.
Không có endpoint cấp token LiveKit hoặc URL phát/tải trong scaffold hiện tại.
T05/T14/T15/T16 phải gọi cùng service ngay trước khi phát hành token/URL và áp dụng
cùng guard với groupId resolve từ session/recording/file của mình.

## Thu hồi online và LiveKit

Mỗi thay đổi membership và event outbox được commit trong cùng transaction.
Khóa hàng group ngăn các thao tác đồng thời vượt quyền hoặc làm mất owner.
Version được cấp tuần tự qua khóa advisory đến khi commit, tránh mất sự kiện giữa
hai transaction của các group khác nhau. Mỗi API/realtime instance đọc outbox để
thông báo socket của mình, không cần dựa vào cache quyền.

Socket handshake dùng `auth.accessToken`. `channel:join` nhận `{groupId}` và có ACK;
`chat:send` nhận `{groupId,text}`; mỗi lệnh và mỗi người nhận đều kiểm tra lại quyền,
phiên và tài khoản. Xóa thành viên chặn gửi/nhận mới ngay cả trước lần polling
outbox kế tiếp. Socket rời room `group:<uuid>` và nhận membership.changed qua room
`user:<uuid>`. `auth:refresh` thay access token cùng user, từ chối đổi danh tính socket.
Chat vẫn là scaffold cục bộ từng instance, chưa có lịch sử/dedup/Redis fanout của T08.

Worker LiveKit đọc outbox riêng với worker phát sự kiện, tránh để lỗi media làm
chậm thông báo quyền. Mỗi group room lấy `room_name` đã lưu từ server.
Khi xóa: `RoomServiceClient.removeParticipant(roomName,userId)`.
Khi đổi vai trò: `updateParticipant` cập nhật metadata/và quyền publish tương ứng;
VIEWER được mic/camera, screen share cần HOST/OWNER/ADMIN cho tới khi T06 có policy.
Identity LiveKit phải là userId đã xác thực trong T05.

Cấu hình backend: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
Nếu thiếu cấu hình hoặc LiveKit lỗi, event vẫn ở DB, retry backoff tới 30 giây,
log cảnh báo tối đa mỗi phút. Đồng bộ media khóa cùng hàng group với mutation,
đọc quyền hiện tại để event cũ không khôi phục quyền đã thu hồi. Không tìm thấy
participant/room được coi là đã đồng bộ. Đã kiểm tra chữ ký và request SDK với
máy chủ RoomService giả lập, cùng failure/retry; chưa kiểm thử media/WebRTC thật.

Mục tiêu local: API thu hồi khi transaction commit; Socket.IO poll mỗi 500 ms;
LiveKit worker mỗi 1 giây khi dịch vụ sẵn sàng. Đây là chu kỳ cấu hình, không phải
cam kết SLA qua sự cố mạng. T05/T14/T15 phải giới hạn token/URL TTL tối đa 60 giây
khi tích hợp. URL đã cấp và token LiveKit tự triển khai có thể còn dùng được tới
khi hết TTL; cần kiểm thử reconnect và cơ chế edge nếu muốn thu hồi sớm hơn.
T03 không tự cấp URL/token để tránh thêm đường truy cập bỏ qua các module đó.

## Bằng chứng kiểm thử

Kết quả local ngày 22/10/2026: `npm run test:t03` qua typecheck toàn monorepo,
build API và 13/13 kiểm thử. OpenAPI T03 khớp bản lưu. Bộ hồi quy đầy đủ chạy
117/118 đạt; một kiểm thử schema vẫn kỳ vọng các bảng/migration trước T03.
Sau khi cập nhật kỳ vọng này, chạy lại cả file database được 5/5 đạt trên mã cuối.
Migration T03 đã được áp dụng thành công vào database local.

- Unit: DTO chống giả mạo role/trường thừa; ma trận quyền dùng chung, ADMIN/OWNER
  và user đã bị khóa; OpenAPI khớp bản lưu.
- PostgreSQL + hai API instances: owner/admin quản lý; HOST/VIEWER bị từ chối;
  bảo vệ owner; thêm trùng đồng thời; quota lookup; phân trang và tìm kiếm;
  xóa ngăn token cũ đọc lớp, tài liệu và quyền xem bản ghi.
- Socket.IO thật: handshake, refresh không đổi danh tính; sự kiện chỉ gửi user
  đích; xóa online ngừng nhận/gửi chat và rejoin thất bại, rời group room.
- LiveKit RoomService giả lập HTTP: xác minh JWT room-admin, room mapping,
  cập nhật sources khi hạ vai trò, RemoveParticipant và retry outbox khi 503.
- Trình duyệt: sidebar, thêm bằng email, không thấy tài khoản, Host/Viewer,
  owner được bảo vệ, xác nhận xóa/hủy, tìm kiếm không nhận response cũ,
  phân trang, chuyển nhóm, thu hồi màn hình đang mở và bố cục 390 px.

Ảnh kiểm tra được tạo lại bởi test giao diện trong `.preview/t03-members-*.png`.
File Job.xlsx giữ nguyên. T03 chưa tự đánh dấu hoàn thành trong bảng kế hoạch vì
review, staging và kiểm thử LiveKit/WebRTC thật là bước nghiệm thu của nhóm.
