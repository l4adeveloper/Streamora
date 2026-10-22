# Bàn giao T02: quản lý nhóm

T02 dùng phiên đăng nhập của T01. API nằm ở `/api/v1/groups`;
giao diện ở `/groups` và `/groups/:id`.

## Cài đặt và kiểm tra

```sh
npm run db:migrate
npm run test:t02
```

Test cần PostgreSQL local và Edge (hoặc browser được cấu hình cho Playwright).
Test tạo database và bản build frontend tạm riêng, tự dọn sau khi chạy.
Migration mới thêm khóa ngoại đến users, index phân trang và bảng lưu request tạo nhóm.
Nếu dữ liệu cũ có owner/member không tồn tại, cần sửa dữ liệu trước khi áp migration;
migration không tự xóa dữ liệu.

## Quy tắc

- Owner được xác định bằng `groups.ownerId` ở cả API và giao diện.
  Membership OWNER vẫn được tạo cùng group trong transaction. Khi T03 chuyển owner,
  phải cập nhật ownerId và membership trong cùng transaction.
- Thành viên được xem; owner hoặc global ADMIN được sửa/xóa.
  Không thay owner qua PATCH group.
- Tên nhóm đang hoạt động là duy nhất theo owner, không phân biệt hoa/thường
  và khoảng trắng thừa. Tạo/đổi tên trùng trả 409 GROUP_NAME_EXISTS.
  Kiểm tra trong transaction có khóa owner để chặn hai yêu cầu đồng thời.
  Nhóm đã xóa không giữ tên; các nhóm trùng cũ không bị tự đổi tên hoặc xóa.
- PATCH bỏ trường thì giữ nguyên. `description: null` hoặc `""` xóa mô tả;
  `name: null` bị từ chối.
- Danh sách lọc tên, dùng cursor theo `createdAt DESC, id DESC`; cursor sai trả 400.
- POST nhận `Idempotency-Key` tùy chọn, 1–128 ký tự ASCII không có khoảng trắng.
  Frontend luôn gửi key và giữ lại khi thử lại cùng nội dung trong form.
  Key được lưu theo user và thao tác tạo group trong PostgreSQL cùng transaction.
  Cùng key/body trả response ban đầu; khác body trả 409 IDEMPOTENCY_CONFLICT.
  Key không tự hết hạn; dùng key mới cho một lần tạo mới.
- DELETE chỉ cập nhật deletedAt; không xóa cứng group hoặc membership.

## Điểm tích hợp tiếp

Chặn xóa group có lớp LIVE để T04 tích hợp. Các mục lớp học, thành viên, tài liệu
trên trang chi tiết đang hiển thị “Sắp có”, chưa mở sang trang demo chung.
T03/T04/T15 cần bổ sung route và API theo group trước khi bật các mục này.

Test T02 bao phủ tạo đồng thời qua hai API instance, retry/conflict, phân quyền,
xóa mềm, phân trang, validation, khóa ngoại và các luồng giao diện tìm kiếm/tạo/sửa/xóa.
