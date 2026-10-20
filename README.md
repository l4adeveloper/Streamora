# Streamora

Khung monorepo cho nền tảng học trực tuyến, cộng đồng và phát trực tiếp có tua lại. Toàn bộ giao diện tiếng Việt, tông tối với tím và cyan.

## Chạy giao diện

Yêu cầu Node.js 20.9+ và npm. Tại thư mục gốc:

```sh
npm install
npm run dev
```

Mở http://127.0.0.1:3000. Giao diện chạy độc lập, không yêu cầu database hoặc khóa dịch vụ.

| Đường dẫn    | Nội dung                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `/`          | Landing giới thiệu và bản xem trước không gian                                                                 |
| `/workspace` | Lớp trực tiếp, trình phát DVR minh họa, chat và thành viên                                                     |
| `/meet`      | Trang cuộc họp độc lập kiểu Google Meet: tạo ngay, lấy liên kết dùng sau, nhập mã/liên kết và cuộc họp gần đây |
| `/meet/:id`  | Phòng chờ kiểm tra thiết bị và phòng họp độc lập, không dùng sidebar cộng đồng                                 |
| `/rooms/:id` | Phòng họp, camera/micro/chia sẻ màn hình trên thiết bị cục bộ                                                  |
| `/community` | Kênh chat, lưu lịch sử trên trình duyệt                                                                        |
| `/files`     | Thư viện tìm kiếm, lọc và mô phỏng tải lên/tạm dừng/tiếp tục                                                   |

## Cấu trúc

```text
apps/
  web/src/
    app/                 # Các route Next.js App Router và giao diện chung
    components/          # landing, workspace, live-player, presentation, ui, demo-data
  api/src/modules/
    auth/                # Điểm tích hợp xác thực và phân quyền
    communities/         # Danh sách cộng đồng mẫu
    rooms/               # API tạo/đọc phòng trong bộ nhớ
    files/               # Tìm kiếm metadata tài liệu mẫu
  realtime/src/          # NestJS Socket.IO: tham gia kênh và phát tin nhắn
packages/contracts/src/  # Kiểu dữ liệu dùng chung
services/
  recording/             # Hướng tích hợp LiveKit Egress
  video-worker/          # Hướng tích hợp RabbitMQ + FFmpeg + HLS
infra/
  docker/                # PostgreSQL, Redis, RabbitMQ, LiveKit dev
  kubernetes/            # Ghi chú tổ chức deployment
  observability/         # Danh mục metrics cần triển khai
```

## Các dịch vụ local

```sh
npm run dev:api       # http://127.0.0.1:4000/api/health
npm run dev:realtime  # http://127.0.0.1:4001/health
npm run typecheck
npm run build
```

API mẫu: `GET /api/communities`, `POST /api/rooms` với body `{"name":"Nhóm học tập"}`, `GET /api/rooms/:id`, `GET /api/files?q=slide`.
Phòng API lưu trong bộ nhớ và mất khi restart. DTO giới hạn tên 1–100 ký tự.
Realtime nhận `channel:join` (`{channelId}`), `chat:send` (`{channelId,text}`) và phát `chat:message` đến các socket cùng kênh.
Frontend hiện độc lập với API/realtime để bản mẫu chạy ngay; các biến `NEXT_PUBLIC_*` là điểm cấu hình dự kiến, chưa được sử dụng.

Với Docker: đặt mật khẩu trong `.env` tại gốc (tham khảo `.env.example`), rồi chạy:

```sh
docker compose --env-file .env -f infra/docker/compose.yml up -d
# Thêm LiveKit ở chế độ phát triển:
docker compose --env-file .env -f infra/docker/compose.yml --profile media up -d
```

## Phạm vi đã triển khai

- Điều hướng giữa các trang, mời bằng liên kết, tạo/tham gia phòng mẫu, tìm metadata tài liệu và tin nhắn.
- Luồng cuộc họp độc lập: `/meet` → `/meet/:id`. Tạo ngay vào phòng họp; liên kết dùng sau và mã tham gia mở phòng chờ. Cuộc họp gần đây lưu tối đa 5 mục trên trình duyệt. Camera, micro, chia sẻ màn hình, giơ tay và bảng tin nhắn cục bộ có trong giao diện họp độc lập. `/rooms/:id` tiếp tục là phòng trong cộng đồng.
- Chat được lưu riêng theo kênh; kênh mới và metadata thư viện lưu trong `localStorage` trên thiết bị. Thao tác cộng đồng/quản lý thành viên/bình chọn là trạng thái mẫu.
- Thanh tua kéo được, play/pause, đuổi theo mốc trực tiếp, chọn tốc độ/chất lượng và toàn màn hình là mô phỏng giao diện, chưa phát video HLS thực.
- Camera/micro/chia sẻ màn hình dùng `getUserMedia`/`getDisplayMedia` thật sau khi cho phép, có dừng track khi rời trang. Chưa truyền media giữa người dùng.
- Có thiết lập FPS cho lần chia sẻ tiếp theo; trình duyệt quyết định mức hỗ trợ.
- Thông báo ghi hình, mục bản ghi và tải lên chỉ minh họa. Không tạo tệp ghi âm/video, không giữ nội dung tệp đã chọn và không upload lên cloud.
- Giao diện dùng ảnh chân dung minh họa từ Unsplash và font Be Vietnam Pro từ Google Fonts; có fallback khi không tải được font.

## Phần cần tích hợp tiếp

Đăng nhập/RBAC; PostgreSQL và migration; LiveKit SDK và token từ API đã xác thực;
Egress + Web Audio API; HLS/hls.js với rolling DVR playlist; presigned multipart upload S3 có resume thật;
worker FFmpeg, retry/DLQ; Redis adapter; replication GCS và định tuyến CDN; Kubernetes/HPA/WAF và metrics.

API/realtime hiện chỉ bind loopback và chưa xác thực. Cần hoàn thiện các lớp quyền trước khi triển khai nhiều người dùng.
Chưa cấu hình publish/deploy; mã nguồn nằm trong repository hiện tại.
