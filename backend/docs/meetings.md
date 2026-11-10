# Meeting trong Workspace và Meeting độc lập

Meeting tiếp tục sử dụng `ClassSession`, admission, heartbeat và media IVS hiện có.
Không tạo phòng video hay hệ thống tài khoản thứ hai.

## Điều hướng và quyền

- Link chia sẻ chuẩn cho cả hai loại phòng: `/meet/:joinCode`.
- `GET /api/v1/meets/:code` và `GET /api/v1/sessions/:sessionId/access` xác minh
  tài khoản, trạng thái nhóm, membership và ban, trả `mode` do backend quyết định.
- Thành viên nhóm vào `/workspace/meetings/:id?groupId=...`. Group trong shell lấy
  từ kết quả server; sửa query không thể chọn nhóm khác cho phòng đó.
- Khách của nhóm chỉ được khám phá phòng khi `allowGuests=true`. Khách vẫn phải
  đăng nhập, xin vào và được chủ phòng duyệt. Không có quyền quản lý nhóm, lịch,
  file hoặc hàng chờ chỉ nhờ biết link hoặc được duyệt vào Meeting.
- Thành viên nhóm được vào trực tiếp khi Meeting mới LIVE. Các lịch học cũ
  giữ quy trình duyệt hiện có (`memberAdmission=APPROVAL`), và màn hình lịch cũ
  vẫn có thể tạo lớp học dùng hàng chờ. Meet không thuộc nhóm tiếp tục
  dùng quy trình chủ phòng duyệt; luôn hiển thị độc lập.
- ADMIN giữ quyền quản trị hiện có. Người bị ban, tài khoản bị khóa và nhóm đã
  xóa không thể dùng link để vượt kiểm tra quyền. Quyền được kiểm tra lại tại
  admission, media và realtime, không chỉ lúc chọn giao diện.

## Tạo và quản lý

`/workspace/meetings` có tab cho từng nhóm người dùng truy cập được, danh sách
theo nhóm và bộ lọc Sắp diễn ra / Đang diễn ra / Đã kết thúc / Đã hủy.
Tạo cuộc họp tự gắn groupId của tab hiện tại. OWNER/HOST/ADMIN được tạo.

`POST /groups/:groupId/sessions` bổ sung `allowGuests` (mặc định false).
`title` và `scheduledAt` có thể bỏ trống. Không đặt lịch thì UI tạo rồi bắt đầu;
có lịch thì giữ SCHEDULED. Bộ đếm của nhóm được tăng dưới khóa hàng, sinh tên
`Cuộc họp N` và không tăng lại khi retry cùng Idempotency-Key. Tên tự đặt cũng
chiếm một số thứ tự. Có thể đổi tên khi SCHEDULED hoặc LIVE; chỉ SCHEDULED được
sửa thời gian/mô tả. Quyền khách được chọn lúc tạo, không nhận từ URL.

Tạo cuộc họp thành công lưu thông báo vào kênh `thông-báo` và invalidation bền trong
cùng transaction. Một `meeting_id` chỉ có một thông báo. Mỗi gateway đọc cursor
riêng và kiểm tra quyền người nhận trước broadcast; reconnect đọc lịch sử DB.
Thông báo hệ thống không được chỉnh sửa/xóa qua API chat thường.

Tạo bên ngoài nhóm tại `/meet` vẫn dùng `POST /meets`, không gắn nhóm.
`/sessions/:id` được đưa qua cùng luồng điều hướng. Lịch nhóm cũ vẫn có thể
lên lịch, còn liên kết vào phòng từ đó đi qua bộ phân giải quyền chung.

## Cập nhật và kiểm tra

Chạy tại gốc repository khi đưa phiên bản mới vào môi trường ứng dụng:

```sh
npm ci
npm run db:migrate
npm run dev:api
npm run dev
```

Migration `20261110000100_meeting_access` bổ sung quyền khách, bộ đếm tên và
liên kết thông báo. Phòng nhóm cũ giữ chế độ chỉ thành viên. Không tự sửa
database ứng dụng khi chạy các test dưới đây:

```sh
npm run build --workspace=@streamora/api
node --test backend/test/meeting-access.test.cjs
node --test backend/test/frontend/meeting-ui.test.cjs
```

Hai test dùng PGlite/PostgreSQL protocol trên loopback với toàn bộ migration và
NestJS thật. Test UI build frontend riêng trong `.preview`, dùng Edge headless
trên Windows, kiểm tra tạo phòng, tab lớp, link riêng/công khai/độc lập và
desktop/mobile. Không gọi AWS. Kiểm thử media thật vẫn cần môi trường AWS IVS
và thiết bị của từng người dùng; các luồng chia sẻ/ghi hình demo không được
chuyển thành tính năng cloud trong thay đổi này.
