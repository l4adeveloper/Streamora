# T21 — Azure Web PubSub for Socket.IO

T21 dùng hub `classroom` và namespace `/classroom` cho membership, chat và sự kiện buổi học. NestJS xác thực `auth.accessToken`, kiểm tra phiên đăng nhập và quyền từ PostgreSQL. Khi mất kết nối, client lấy token mới nếu cần, tham gia lại và đồng bộ dữ liệu qua `channel:join`, `session:watch` và API quyền hiện có.

## Cấu hình staging

1. Tạo resource **Web PubSub for Socket.IO** ở chế độ mặc định bằng Azure CLI hoặc Portal. Điền tên resource duy nhất, resource group và region của nhóm.

   ```sh
   az webpubsub create --name <resource-name> --resource-group <resource-group> --location <region> --kind SocketIO --sku Free_F1 --unit-count 1
   ```

   Kiểm tra SKU và quota của subscription Azure for Students thực tế trước khi tạo. Dùng hub `classroom` khi lấy Client Endpoint và Client Path trong Portal. Endpoint là origin HTTPS, path là `/clients/socketio/hubs/classroom`. [Azure CLI](https://learn.microsoft.com/cli/azure/webpubsub#az-webpubsub-create) · [Socket.IO quickstart](https://learn.microsoft.com/azure/azure-web-pubsub/socketio-quickstart)
2. Lưu **connection string nguyên dạng** dưới dạng `SecretString` trong AWS Secrets Manager. Cấp `secretsmanager:GetSecretValue` cho EC2 IAM role trên ARN của secret này. Nếu secret dùng khóa KMS riêng, cấp quyền giải mã trên khóa đó.
3. Đặt `REALTIME_PROVIDER=azure`, `AZURE_WEB_PUBSUB_SECRET_ID` và `AWS_REGION` trên mọi API instance. Các instance cần dùng cùng PostgreSQL, khóa ký access token, `WEB_ORIGIN` và hub. Mở kết nối HTTPS/WebSocket đi ra Azure và HTTPS đến Secrets Manager.
4. Chạy `npm run db:migrate` trước khi chạy API mới. Đặt `NEXT_PUBLIC_AZURE_WEB_PUBSUB_URL` thành Client Endpoint trước khi build frontend. Triển khai frontend và API cùng đợt vì client buổi học chuyển sang namespace `/classroom`.

Local mặc định dùng Socket.IO trên API. Có thể đặt `NEXT_PUBLIC_REALTIME_URL` để trỏ sang service local cổng 4001.

## Tương thích và kiểm thử

Azure chỉ liệt kê socket cục bộ qua `fetchSockets` và không hỗ trợ `serverSideEmit`. Mỗi API instance đọc các sự kiện đã commit trong PostgreSQL, kiểm tra quyền của socket nó quản lý rồi giao qua Azure. Chat lưu sự kiện cùng transaction với tin nhắn và xóa nhật ký sự kiện sau 24 giờ. Membership removal và session ban chặn tham gia lại, đồng thời đóng socket đã tham gia nhóm hoặc đang theo dõi buổi học bị thu hồi quyền. [Các API Socket.IO Azure hỗ trợ](https://learn.microsoft.com/azure/azure-web-pubsub/socketio-supported-server-apis)

```sh
npm run build --workspace=@streamora/api
node --test --test-concurrency=1 backend/test/integration/memberships.test.cjs backend/test/integration/class-sessions-realtime.test.cjs
```

Để kiểm thử cloud, đặt `T21_AZURE_URL` và `T21_AZURE_SECRET_ID` trỏ tới resource dành riêng cho test. Cần AWS credentials có quyền đọc secret và `DATABASE_URL` có quyền `CREATEDB` trên PostgreSQL test. Bài test xác nhận Azure phân hai client vào hai API instance khác nhau, sau đó kiểm tra chat, buổi học, thay đổi quyền và thu hồi quyền.

```sh
node --test backend/test/integration/t21-azure.test.cjs
```
