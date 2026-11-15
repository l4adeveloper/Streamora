# T13 — Setup CDK từ local

Chạy ở root repository. Cần Node.js/npm, AWS CLI và AWS profile có quyền quản lý
hạ tầng T13. Nếu mới tải repo, chạy `npm ci` một lần để cài thư viện ứng dụng.

Trước lần triển khai đầu, dùng tài khoản có quyền quản lý IAM để tạo **managed
policy** `StreamoraT13Deployment` từ [deployment-policy.json](../infra/t13-cdk/deployment-policy.json),
rồi gắn vào user `streamora-developer`. File này dành cho account `586481704097`,
Tokyo, tên mặc định T13 và bootstrap qualifier `hnb659fds`; đổi tên/account/region
trong config thì cần cập nhật ARN trong policy tương ứng.

Policy bao gồm CloudFormation, bootstrap CDK, quyền assume role triển khai, dọn
service tạo tay và nạp secret. Đây là **quyền triển khai mạnh**: bootstrap tạo role
CloudFormation với `AdministratorAccess` mặc định; một số API CloudFront cũ cần
`Resource: "*"`. Chỉ gắn cho danh tính triển khai được tin cậy. Quyền `apiRuntimeUserName`
chỉ đọc signing secret cho API, không thay thế policy triển khai này.

Nếu user báo AccessDenied với `cloudformation:ListStackResources`, cần người có
quyền IAM gắn policy trên; không bỏ qua lỗi để đoán tài nguyên là tạo tay.
Hướng dẫn [gắn policy IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_manage-attach-detach.html)
và [bootstrap CDK](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html).

## 1. Tạo cấu hình

```powershell
$env:AWS_PROFILE = "streamora-developer"
npm run setup:t13
```

Lần đầu lệnh tạo hai file rồi dừng để bạn điền:

- `backend/infra/t13-cdk/t13.config.json`: kiểm tra account, region, hostname HTTPS
  của API và origin frontend. Mặc định account `586481704097`, Tokyo.
- `backend/infra/t13-cdk/.local/database-secret.json`: DB PostgreSQL mà API đang dùng:

```json
{"url":"postgresql://USER:URL_ENCODED_PASSWORD@HOST:5432/DB_NAME?sslmode=require"}
```

Nếu muốn tự gắn quyền đọc signing secret vào role EC2, thêm
`"apiRuntimeRoleName": "TEN_ROLE_API"` vào config. Hoặc dùng `apiRuntimeUserName`
nếu API dùng IAM user cùng account. Không chọn cả hai.

## 2. Chạy setup

```powershell
npm run setup:t13
```

Lệnh tự thực hiện theo thứ tự:

1. Kiểm tra config, AWS account và region bucket nguồn; tạo khóa RSA nếu chưa có.
2. Build ZIP Lambda tại local.
3. Dọn các service T13 tạo tay theo đúng tên bên dưới.
4. Bootstrap CDK nếu chưa có; deploy hạ tầng với pipeline tắt.
5. Nạp DB secret và signing secret, rồi deploy bật pipeline.
6. In block env cần ghép vào API trên EC2.

Lambda dùng concurrency chung của account, không giữ riêng 5 lượt chạy nên phù
hợp cả account có quota thấp. Mỗi SQS trigger vẫn giới hạn concurrency 2.
Nếu lần tạo stack trước thất bại và đã `ROLLBACK_COMPLETE`, setup tự xóa phần stack
thất bại trước khi tạo lại; bucket output và secret có Retain được dùng lại. Queue
và log còn lại sau rollback được dọn theo tên T13. Stack đang hoạt động được giữ.

Đọc và xác nhận thay đổi IAM khi CDK hỏi tại terminal. Không chạy GitHub Actions.
S3, Lambda, MediaConvert, CloudFront và các dịch vụ liên quan có thể phát sinh phí.

## Dọn tài nguyên cũ trước mỗi lần setup

Chỉ dọn tài nguyên **tạo tay**, đúng tên T13 đã thống nhất:

| Dịch vụ | Tên mặc định |
| --- | --- |
| Lambda và log group của nó | `streamora-video-pipeline` |
| SQS → Lambda trigger cũ | Chỉ dispatch/completion nối đúng `streamora-video-pipeline`; đợi xóa xong trước khi tạo lại |
| EventBridge rules | `streamora-video-maintenance`, `streamora-video-completion` |
| SQS và DLQ | `streamora-video-dispatch`, `streamora-video-completion`, cùng hậu tố `-dlq` |
| MediaConvert queue | `streamora-video` |
| IAM roles | `streamora-video-lambda`, `streamora-mediaconvert`, `streamora-video-mediaconvert` |
| CloudFront distribution | Comment `streamora-video-tokyo` hoặc `streamora-video private HLS` |
| CloudFront key group/public key | `streamora-video` |
| CloudFront OAC / CORS policy | `streamora-video-oac` / `streamora-video-cors` |

Tài nguyên thuộc CloudFormation được giữ và cập nhật bằng CDK. Chạy lại setup
không xóa stack đã triển khai. Nếu đổi `namePrefix`, các tên dọn cũng đổi theo;
các tên legacy `streamora-*` chỉ áp dụng với prefix mặc định.

Nếu gặp lỗi `event source mapping ... already exists`, cập nhật managed policy
`StreamoraT13Deployment` bằng file `deployment-policy.json` mới (thêm quyền List/
DeleteEventSourceMapping), đợi stack rollback hoàn tất rồi chạy `npm run setup:t13`.
Setup tự dọn trigger tạo tay/còn sót; không xóa trigger thuộc stack đang hoạt động.
Bước chờ dùng lại `ListEventSourceMappings`, không cần quyền `GetEventSourceMapping`.

**Dọn queue sẽ mất message cũ; dọn CDN/Lambda làm gián đoạn service cũ.** Chờ
MediaConvert hết job và dừng worker AWS cũ trên EC2 trước khi chạy. CloudFront cần
tắt/đợi triển khai trước khi xóa; SQS cần đợi ít nhất 60 giây trước khi tạo lại tên.
Lệnh tự chờ theo [quy định CloudFront](https://docs.aws.amazon.com/cli/latest/reference/cloudfront/delete-distribution.html)
và [SQS](https://docs.aws.amazon.com/cli/latest/reference/sqs/delete-queue.html).

`streamora-file-storage` **đã có sẵn**: chỉ tham chiếu, không tạo/xóa hay sửa policy.
Bucket output nếu đã có sẽ được dùng lại và giữ video; CDK cập nhật policy riêng
cho CloudFront T13. DB và Secrets Manager không bị xóa; secret có sẵn được dùng lại
và nạp giá trị từ file local/cặp khóa khi setup. File config tự lưu ARN secret và
trạng thái dùng lại bucket để các lệnh CDK sau thống nhất.

## Sau khi setup

Ghép block env được in vào `backend/.env` **trên EC2**, giữ các biến auth/upload/
IVS/chat và DATABASE_URL hiện có. Gắn `ApiRuntimePolicyArn` trong outputs vào đúng
role/user API nếu chưa khai báo trong config. Áp migration còn thiếu và restart API
theo [hướng dẫn EC2](t13-aws-setup.md#9-env-ec2-và-chuyển-khỏi-worker-cũ).

Upload MP4 ngắn để kiểm tra QUEUED → READY; thử phát video và đổi chất lượng.
Pipeline bật sau setup nên có thể xử lý cả job QUEUED đang có trong DB.

DB private: thêm cấu hình `vpc` (VPC ID, AZ, private subnet IDs và SG IDs hiện có);
Lambda cần đường đến DB và AWS APIs. Chi tiết mạng và cookie khác site xem
[hướng dẫn AWS T13](t13-aws-setup.md). Setup không tạo DB/VPC/NAT/EC2.
Web sslip.io và CloudFront khác site nên browser cần cho phép cookie bên thứ ba.

Các lệnh riêng vẫn có khi cần: `cdk:t13:test`, `cdk:t13:synth`, `cdk:t13:diff`,
`cdk:t13:api-env`. `cdk:t13:deploy` cũng gọi **setup:t13**, gồm bước dọn service
tạo tay; test/synth/diff không xóa AWS. Không commit `.local`, private key hoặc DB URL.
