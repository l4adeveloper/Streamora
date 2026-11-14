# Cài T13 trên AWS Tokyo, từ trạng thái mới có S3

**Nếu bạn đã có EC2 ở tài khoản khác và dùng user streamora-developer của tài
khoản 586481704097, dùng [hướng dẫn IAM user](t13-aws-iam-user-setup.md) thay cho
phần dựng EC2/RDS trong tài liệu này.**

Ngày đối chiếu code và tài liệu AWS: 14/11/2026. Region của bucket hiện có: **ap-northeast-1 (Tokyo)**.

Hướng dẫn này dành cho video upload → MediaConvert → HLS nhiều chất lượng → preview có quyền xem. Chưa có thao tác tạo tài nguyên AWS nào được thực hiện khi viết tài liệu này. EC2, RDS, MediaConvert, S3, Secrets Manager và lưu lượng CloudFront có thể phát sinh phí; xem phần ước tính trong Console trước khi tạo.

Luồng sau khi cài:

```text
Trình duyệt upload → S3 nguồn hiện có
                         ↓
API ghi VideoJob → SQS dispatch → video worker → MediaConvert
                                                    ↓
                                 S3 output: HLS + thumbnail
                                                    ↓
EventBridge → SQS completion → worker kiểm tra → PostgreSQL: READY
                                                    ↓
                           CloudFront private → video player
```

## 1. Xác định các giá trị sẽ dùng

Các tên sau là ví dụ, không phải tài nguyên có sẵn:

| Giá trị | Ví dụ / cách điền |
| --- | --- |
| Region | `ap-northeast-1` |
| AWS account ID | 12 chữ số, lấy từ menu tài khoản AWS |
| SourceBucket | Tên bucket S3 bạn đã tạo, không có `s3://` |
| WebOrigin | `https://app.example.com` |
| ApiDomain | `api.example.com`, không có `https://` hoặc đường dẫn |
| Media domain | `media.example.com` |
| Stack name | `streamora-t13-tokyo` |

Thay `example.com` bằng tên miền bạn quản lý. Nếu chưa có tên miền, cần chuẩn bị trước bước HTTPS và kiểm thử trên trình duyệt. Template hiện tại yêu cầu WebOrigin là HTTPS.

Nên dùng ba tên miền con cùng một tên miền gốc để tránh vướng việc trình duyệt chặn cookie của bên thứ ba. `ApiDomain` là origin backend, không được trỏ ngược về distribution media.

Tokyo hỗ trợ IVS Low-Latency và Real-Time: [AWS IVS endpoints](https://docs.aws.amazon.com/general/latest/gr/ivs.html).

## 2. Tạo nơi chạy ứng dụng và worker

Bạn mới có S3 nên còn thiếu máy chạy API/worker và PostgreSQL. Template T13 không tạo những phần này.

Trong **EC2 → Launch instance**, chọn Tokyo và Ubuntu Server 24.04 LTS, kiến trúc x86_64. Với bản demo chạy frontend, API và worker chung máy, có thể bắt đầu với 2 vCPU và ít nhất 4 GiB RAM để build; cần đo lại nếu tăng người dùng. Không cần GPU vì MediaConvert thực hiện encode.

Tạo security group cho máy:

- Cổng 22: chỉ IP quản trị của bạn, nếu dùng SSH.
- Cổng 80/443: cho truy cập web.
- Không mở công khai 3000, 4000 hoặc 5432.

Gắn địa chỉ IP ổn định nếu dùng DNS trỏ trực tiếp tới EC2. Cho máy kết nối ra Internet để gọi S3, SQS, MediaConvert và Secrets Manager; nếu đặt máy trong subnet private thì phải có đường ra hoặc endpoint phù hợp.

Trong máy, chuẩn bị Git, Node.js 22 từ 22.16 trở lên, npm từ 10 trở lên, Nginx và ffprobe. Đây là yêu cầu của project; ffprobe vẫn cần trên AWS để đọc metadata và kiểm tra output. Không dùng FFmpeg để encode trong chế độ AWS.

Ví dụ cài các tiện ích trên Ubuntu, sau khi đã cài Node/npm:

```bash
sudo apt update
sudo apt install -y git nginx ffmpeg openssl python3 curl certbot python3-certbot-nginx
node --version
npm --version
ffprobe -version
```

Đưa bản code hiện tại lên EC2, gồm các sửa player mới nhất. Các bước dưới giả sử repo ở `/home/ubuntu/Streamora`.

## 3. Chuẩn bị PostgreSQL

Trong **RDS → Create database**, tạo PostgreSQL ở Tokyo, cùng VPC với EC2. Có thể dùng PostgreSQL 16 cho lần cài này. Điền initial database name là `streamora`.

Chọn **Public access: No**. Security group của RDS cho phép cổng 5432 từ security group EC2, không từ toàn Internet. Ghi lại endpoint, database, username và password.

Nếu chuyển dữ liệu từ database local, cần kế hoạch backup/restore metadata riêng. Tạo database mới không tự nhập các file đang có trên S3 vào thư viện; danh sách file, user và quyền nằm trong PostgreSQL.

URL dùng trong backend có dạng:

```dotenv
DATABASE_URL="postgresql://USER:PASSWORD_URL_ENCODED@RDS_ENDPOINT:5432/streamora?sslmode=require"
```

Tải CA bundle Tokyo trên EC2 để tiến trình Node tin cậy certificate của RDS:

```bash
curl -fL https://truststore.pki.rds.amazonaws.com/ap-northeast-1/ap-northeast-1-bundle.pem \
  -o /home/ubuntu/rds-tokyo-bundle.pem
export NODE_EXTRA_CA_CERTS=/home/ubuntu/rds-tokyo-bundle.pem
```

Đặt biến này trước khi khởi động Node; chỉ thêm vào backend/.env sau khi Node đã chạy không đủ để Node nạp CA. Với terminal SSH mới, export lại; service ở bước 13 đặt Environment tương ứng. Không khắc phục lỗi chứng chỉ bằng cách tắt kiểm tra TLS. Tham khảo [RDS PostgreSQL SSL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html) và [CA bundles theo region](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).

## 4. Tạo IAM role cho EC2

Vào **IAM → Roles → Create role → AWS service → EC2**, đặt tên ví dụ `StreamoraAppRole`.

Role này cần quyền đọc/ghi bucket upload nguồn. Tạo policy riêng, thay `SOURCE_BUCKET` bằng tên bucket thật:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
      "Resource": "arn:aws:s3:::SOURCE_BUCKET"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": "arn:aws:s3:::SOURCE_BUCKET/groups/*"
    }
  ]
}
```

Sau đó vào **EC2 → Instances → chọn máy → Actions → Security → Modify IAM role**, gắn role này. Sau bước CloudFormation sẽ gắn thêm WorkerPolicy do stack tạo. Không cần đặt access key dài hạn trong `.env` trên EC2. Nếu `.env` cũ có các dòng `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, bỏ các giá trị cũ để SDK dùng instance role.

Nếu bucket dùng SSE-KMS, cần bổ sung quyền đúng KMS key cho cả role ứng dụng và role MediaConvert; policy S3 đơn thuần chưa đủ.

Tham khảo [gắn IAM role cho EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attach-iam-role.html).

## 5. Cấu hình CORS cho bucket nguồn

Vào **S3 → bucket hiện có → Permissions → Cross-origin resource sharing → Edit**. Thêm origin web thật vào cấu hình hiện có; không xóa các origin ứng dụng khác đang dùng.

Ví dụ cho một web origin:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 300
  }
]
```

Giữ bucket private; CORS không cấp quyền public. `ETag` cần được trình duyệt đọc khi upload multipart. [Cấu hình CORS S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html).

## 6. Tạo khóa ký CloudFront và secret

Mở **AWS CloudShell** ở Tokyo. Đây là terminal của AWS, không phải PowerShell trên máy Windows. Tạo khóa trong thư mục riêng, không trong repo:

```bash
umask 077
mkdir -p ~/streamora-t13-keys
cd ~/streamora-t13-keys
openssl genrsa -out private_key.pem 2048
openssl rsa -pubout -in private_key.pem -out public_key.pem
python3 - <<'PY'
import json
from pathlib import Path
Path('signing-secret.json').write_text(json.dumps({
    'keyPairId': 'PENDING_STACK_OUTPUT',
    'privateKey': Path('private_key.pem').read_text()
}))
PY
aws secretsmanager create-secret \
  --region ap-northeast-1 \
  --name streamora/t13/cloudfront-signing \
  --secret-string file://signing-secret.json
```

Ghi lại **ARN** trả về. Chưa dùng secret để phát video cho tới khi cập nhật keyPairId ở bước 8. Nếu đã tạo secret trước đó, dùng lại ARN thay vì tạo trùng.

Public key có thể đưa vào CloudFormation; private key chỉ đưa vào Secrets Manager và nơi lưu giữ khóa được bảo vệ. Hướng dẫn chính thức: [CloudFront trusted key groups](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html).

## 7. Tạo hạ tầng T13 bằng CloudFormation

File có sẵn trong repo: `backend/infra/aws/video/cloudformation.yaml`.

Trong **CloudFormation** tại Tokyo, chọn **Create stack → With new resources (standard) → Upload a template file**, tải file trên lên.

Điền stack name và các tham số:

| Tham số | Điền |
| --- | --- |
| SourceBucket | Tên bucket nguồn hiện có |
| WebOrigin | `https://app.example.com`, không dấu `/` cuối |
| ApiDomain | `api.example.com`, không protocol/path |
| SigningSecretArn | ARN tạo ở bước 6 |
| PublicKeyPem | Toàn bộ nội dung `public_key.pem`, gồm BEGIN/END |

Public key phải giữ nguyên PEM và xuống dòng. Ở bước cuối, đọc phần resources/change set, xác nhận khả năng tạo IAM resources, rồi Submit. Chờ trạng thái **CREATE_COMPLETE**. Nếu thất bại, xem Events của resource lỗi đầu tiên.

Stack tạo: S3 output private, hai SQS queue và hai DLQ, MediaConvert queue/role, EventBridge rule, CloudFront OAC/public key/key group/distribution, WorkerPolicy và IVS STANDARD recording ALL. Không cần tạo MediaConvert Job Template thủ công: worker sinh settings theo nguồn thật.

Bucket output là bucket mới do stack tạo; không thay SourceBucket bằng bucket output. Stack chưa được nghiệm thu trên tài khoản AWS thực trong các phiên lập trình local.

## 8. Lấy Outputs và hoàn thiện secret/quyền

Vào tab **Outputs**, lưu các giá trị:

```text
DispatchQueueUrl
CompletionQueueUrl
OutputBucketName
MediaConvertRoleArn
MediaConvertQueueArn
MediaDomain
KeyPairId
WorkerPolicyArn
LiveChannelArn
RecordingConfigurationArn
```

`KeyPairId` ở đây là ID public key CloudFront, không phải key group ID hay EC2 key pair.

Trong CloudShell, sửa secret bằng public key ID thật:

```bash
cd ~/streamora-t13-keys
read -r -p 'CloudFront KeyPairId từ Outputs: ' T13_KEY_PAIR_ID
python3 - "$T13_KEY_PAIR_ID" <<'PY'
import json, sys
from pathlib import Path
Path('signing-secret.json').write_text(json.dumps({
    'keyPairId': sys.argv[1],
    'privateKey': Path('private_key.pem').read_text()
}))
PY
aws secretsmanager put-secret-value \
  --region ap-northeast-1 \
  --secret-id streamora/t13/cloudfront-signing \
  --secret-string file://signing-secret.json
```

Vào **IAM → StreamoraAppRole → Add permissions → Attach policies**, tìm đúng managed policy ứng với `WorkerPolicyArn` và gắn vào role. Policy này cho SQS, MediaConvert, PassRole, đọc nguồn/output và đọc secret. Nó không thay policy upload S3 ở bước 4.

Nếu đã chạy API trước khi sửa secret, restart API để bỏ bản secret đã cache trong bộ nhớ.

## 9. Cấu hình tên miền media

Template hiện tạo domain dạng `d....cloudfront.net`, chưa có custom alias/certificate.

Trong **ACM**, chuyển sang **US East (N. Virginia), us-east-1**, yêu cầu public certificate cho `media.example.com`, dùng DNS validation và đợi Issued. Certificate cho CloudFront phải ở us-east-1 dù S3, worker và MediaConvert ở Tokyo. [Yêu cầu ACM của CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-procedures.html).

Vào distribution vừa tạo trong **CloudFront → General → Add a domain / Edit**, thêm `media.example.com` và chọn certificate trên. Tạo DNS CNAME `media` trỏ về `MediaDomain` trong Outputs, hoặc Alias tương ứng nếu dùng Route 53. Chờ distribution triển khai xong.

Nếu sửa qua Console, cần đưa alias/certificate đó vào template trước lần cập nhật stack sau để giữ cấu hình nhất quán. Khi dùng tên miền riêng, `VIDEO_MEDIA_DOMAIN` sẽ là `media.example.com`, không còn là domain mặc định trong Outputs.

Kiểm tra hai behavior do template tạo:

- Default → S3 output, OAC, Trusted key group bật.
- `/api/v1/files/*/media-grant` → origin API, không yêu cầu signed cookie, không cache, chuyển Authorization và Origin tới API.

Không mở public bucket output để chữa lỗi 403. CloudFront dùng OAC để đọc S3; browser dùng signed cookie để được CloudFront cho xem.

## 10. Điền backend và frontend env

Trên EC2, từ thư mục repo, chạy `npm ci` rồi `npm run setup:env` nếu chưa có env. Lệnh setup giữ nguyên file env đã tồn tại. Chỉnh `backend/.env` bằng các giá trị thật, không để trùng nhiều dòng cùng một biến:

```dotenv
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=4000
API_DOCS_ENABLED=false
WEB_ORIGIN=https://app.example.com
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAME_SITE=lax
ACCESS_TOKEN_SECRET=<GIU_SECRET_DA_TAO_HOAC_SECRET_NGAU_NHIEN_IT_NHAT_32_BYTE>
DATABASE_URL="postgresql://USER:PASSWORD_URL_ENCODED@RDS_ENDPOINT:5432/streamora?sslmode=require"

FILES_STORAGE_DRIVER=s3
FILES_S3_BUCKET=<SOURCE_BUCKET_HIEN_CO>
FILES_S3_REGION=ap-northeast-1
FILES_PUBLIC_BASE_URL=https://api.example.com

VIDEO_MODE=aws
VIDEO_AWS_ACCOUNT_ID=<AWS_ACCOUNT_12_CHU_SO>
VIDEO_MAX_QUALITY=1080
VIDEO_FFPROBE_PATH=/usr/bin/ffprobe
VIDEO_DISPATCH_QUEUE_URL=<DispatchQueueUrl>
VIDEO_COMPLETION_QUEUE_URL=<CompletionQueueUrl>
VIDEO_OUTPUT_BUCKET=<OutputBucketName>
VIDEO_MEDIACONVERT_ROLE_ARN=<MediaConvertRoleArn>
VIDEO_MEDIACONVERT_QUEUE_ARN=<MediaConvertQueueArn>
VIDEO_MEDIA_DOMAIN=media.example.com
VIDEO_SIGNING_SECRET_ARN=<SigningSecretArn>

IVS_ENABLED=false
IVS_WORKER_ENABLED=false
AWS_REGION=ap-northeast-1
```

Lần kiểm tra đầu dùng 1080; sau khi ổn đổi `VIDEO_MAX_QUALITY=2160` để nhận 4K nếu nguồn đủ. Muốn bật thêm mức 480/1440 thì thêm `VIDEO_OPTIONAL_QUALITIES=480,1440`.

**Region của T13 được code lấy từ FILES_S3_REGION.** Chỉ đổi AWS_REGION không đủ để đổi region của MediaConvert/SQS trong T13.

Nếu chưa dùng Azure Speech, xóa hoặc để trống cả `AZURE_SPEECH_REGION` và `AZURE_SPEECH_KEY` từ mẫu. T13 không tự tạo dịch vụ phụ đề; phụ đề tự động của project là phần Azure Speech riêng. Giữ các cấu hình tính năng khác đang dùng.

Trong `frontend/.env.local` trên máy triển khai, cấu hình trước khi build:

```dotenv
NEXT_PUBLIC_API_URL=/api/v1
```

Nginx ở bước 12 sẽ chuyển `/api/v1` tới backend. Không đưa database URL, signing key hoặc AWS secret vào biến NEXT_PUBLIC.

## 11. Build, migration và khởi động thử

Từ thư mục repo trên EC2:

```bash
npm run build --workspace=@streamora/api
npm run db:status
npm run db:migrate
npm run build --workspace=@streamora/web
```

Nếu dùng database có dữ liệu, backup trước khi áp migrations và kiểm tra danh sách migrations pending. Lệnh db:migrate áp toàn bộ migrations còn thiếu của repo, không chỉ hai bảng T13.

Chạy thử ba tiến trình bằng ba terminal:

```bash
# Terminal 1, cwd = thư mục repo:
export NODE_EXTRA_CA_CERTS=/home/ubuntu/rds-tokyo-bundle.pem
node backend/dist/main.js

# Terminal 2, cwd = thư mục repo:
export NODE_EXTRA_CA_CERTS=/home/ubuntu/rds-tokyo-bundle.pem
node backend/dist/video.worker.js

# Terminal 3, cwd = thư mục repo:
npm run start --workspace=@streamora/web -- --hostname 127.0.0.1 --port 3000
```

Worker phải được chạy riêng; chỉ chạy API sẽ không xử lý queue. Dùng entry point production đã build thay vì dev:video-worker để tránh build lại mỗi lần khởi động.

Kiểm tra trên EC2:

```bash
curl http://127.0.0.1:4000/api/v1/health
```

Kỳ vọng `status: ok`. Worker cần kết nối cùng database, source bucket và bộ env T13 với API. Khi lỗi khởi động, kiểm tra env, DB, instance role và đường dẫn ffprobe.

## 12. Đưa web/API lên HTTPS

Tạo DNS A record cho `app.example.com` và `api.example.com` trỏ tới IP EC2 ổn định.

Ví dụ cấu hình Nginx HTTP ban đầu, lưu trong site config riêng và enable theo cách cài Nginx của bạn:

```nginx
server {
    listen 80;
    server_name app.example.com;

    location /api/v1/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Kiểm tra cấu hình trước khi reload, rồi cấp certificate HTTPS:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d app.example.com -d api.example.com
```

Chọn chuyển HTTP sang HTTPS. API origin phải có certificate hợp lệ khớp `api.example.com`, vì CloudFront nối tới API bằng HTTPS. Không dùng certificate media ở đây thay cho certificate origin API.

Điểm kiểm tra: `https://api.example.com/api/v1/health` trả `status: ok`, và `https://app.example.com/login` mở được.

Đây là cấu hình web/REST cần cho T13; triển khai đầy đủ các tính năng realtime/chat của app còn cần cấu hình riêng. Chat workspace hiện dùng DynamoDB: xem `workspace-chat-dynamodb-handoff.md`, không để endpoint DynamoDB Local trong env production.

## 13. Giữ API, worker và web chạy sau khi đóng SSH

Sau khi chạy thử thành công, dừng ba tiến trình chạy tay và đưa chúng vào process manager. Ví dụ systemd cho worker, lưu thành `/etc/systemd/system/streamora-video-worker.service`:

```ini
[Unit]
Description=Streamora T13 video worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/Streamora
Environment=NODE_ENV=production
Environment=NODE_EXTRA_CA_CERTS=/home/ubuntu/rds-tokyo-bundle.pem
ExecStart=/FULL/PATH/TO/node backend/dist/video.worker.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

Thay `/FULL/PATH/TO/node` bằng kết quả `command -v node`; không giả định systemd nạp môi trường nvm của terminal. Worker tự đọc `backend/.env`. Giới hạn quyền đọc env, ví dụ `chmod 600 backend/.env`, owner là user chạy dịch vụ.

Tạo service API tương tự, đổi Description và ExecStart thành `node backend/dist/main.js`. Tạo service web với WorkingDirectory là `/home/ubuntu/Streamora/frontend`, ExecStart dùng đường dẫn tuyệt đối tới node và Next CLI của repo, ví dụ `/FULL/PATH/TO/node /home/ubuntu/Streamora/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000`.

Sau khi tạo đủ ba service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now streamora-api streamora-video-worker streamora-web
sudo systemctl status streamora-api streamora-video-worker streamora-web
sudo journalctl -u streamora-video-worker -f
```

## 14. Kiểm tra từ upload đến xem video

1. Đăng nhập web và vào thư viện của nhóm bạn có quyền upload.
2. Upload MP4 H.264 SDR khoảng 30–60 giây, 1080p. Upload qua ứng dụng, không chỉ thả file vào S3 Console; ứng dụng cần tạo metadata và VideoJob.
3. API processing phải đi qua QUEUED/PROCESSING, rồi READY hoặc báo lỗi rõ. Endpoint: `GET /api/v1/files/:fileId/processing`, dùng token người có quyền xem.
4. Trong **MediaConvert → Jobs**, tìm job trong queue của stack; metadata có `project=streamora`, `jobId`, `attemptNo`. Đợi COMPLETE.
5. Trong S3 output phải có playlist `.m3u8`, segment và thumbnail; không cần đoán tên variant từ FFmpeg local, MediaConvert có tên file riêng.
6. Mở preview: phải thấy Auto và các mức thật như 1080p, 720p, 360p tùy nguồn. Đổi chất lượng, tua qua lại và mở bản chép lời trong fullscreen.
7. Xem liên tục quá 60 giây để kiểm tra gia hạn cookie, không chỉ thử vài giây đầu.
8. Mở URL master/segment ở cửa sổ riêng chưa đăng nhập: phải bị từ chối. URL S3 trực tiếp cũng không được public.
9. Xóa quyền thành viên của tài khoản thử: lần cấp grant mới phải bị từ chối. Buffer đã tải không thể thu hồi ngược.

Sau đó mới thử nguồn UHD 4K với `VIDEO_MAX_QUALITY=2160` và kiểm tra 2160p thật; không upscale nguồn 1080p.

## 15. Tra lỗi nhanh

| Hiện tượng | Kiểm tra đầu tiên |
| --- | --- |
| QUEUED không đổi | Worker có chạy không; dispatch queue URL và role SQS đúng chưa |
| SUBMITTING lâu, SUBMISSION_UNCERTAIN | Quyền CreateJob/PassRole và job đang có ở MediaConvert; không xóa DB row để ép submit lại |
| MediaConvert báo đọc nguồn lỗi | SourceBucket/object, role MediaConvert, KMS nếu dùng |
| MediaConvert COMPLETE nhưng processing chưa READY | EventBridge/completion queue, account/region, worker log, ffprobe và quyền đọc/list output |
| PROVIDER_MISMATCH | Queue ARN, role ARN, account ID, region có trùng stack và env không |
| VIDEO_DELIVERY_UNAVAILABLE | VIDEO_MEDIA_DOMAIN, signing secret và mapping output bucket |
| master/segment 403 | Secret KeyPairId đúng public key, key group gắn đúng behavior, cookie đúng media host/path, OAC/bucket policy |
| `/media-grant` lỗi 401 | Behavior phải forward Authorization tới API |
| CloudFront `/media-grant` lỗi 502 | ApiDomain/DNS/certificate origin HTTPS, API có đang chạy không |
| Upload CORS hoặc thiếu ETag | CORS source bucket phải đúng WebOrigin, có PUT và ExposeHeaders ETag |
| Video lỗi sau khoảng 60 giây | Grant renewal, cookie bị chặn, CORS credentials, domain web/media và secret |

## 16. Phần IVS / bản ghi livestream còn thiếu

Stack có tạo IVS STANDARD và recording configuration ALL, ghi vào bucket output. Nhưng code T11 hiện **chưa có mapping cloud channel → phiên học/bản ghi hoàn chỉnh**. Tạo stack không tự làm mọi bản ghi IVS xuất hiện trong thư viện.

Để hoàn tất phần này còn cần nối recording-ended, đọc metadata đáng tin cậy, xác định đúng phiên, gọi `FilesService.registerRecording` với source HLS, storageLocationId/prefix/masterKey và danh sách rendition thật. Sau đó worker IMPORT_HLS, không gọi MediaConvert để encode lại HLS phù hợp.

Channel, recording configuration và bucket ghi phải cùng region; ở đây dùng Tokyo. LIVE ABR cần nghiệm thu riêng, và DVR là T12. [IVS recording setup](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/record-to-s3.html).

Vì vậy thứ tự phù hợp là nghiệm thu **upload → MediaConvert → CloudFront** trước, rồi hoàn thiện/nối T11 và thử IVS thật. Phụ đề Azure Speech cũng là cấu hình riêng, không tự có sau deploy T13.

## Nguồn code để đối chiếu

- `backend/infra/aws/video/cloudformation.yaml`
- `backend/infra/aws/video/README.md`
- `backend/services/video-worker/README.md`
- `backend/src/modules/video-processing/video-config.ts`
- `backend/src/modules/video-processing/mediaconvert-encoder.ts`
- `backend/docs/t13-video-pipeline.md`

Tài liệu này hướng dẫn triển khai dựa trên code hiện tại; chưa phải bằng chứng stack/AWS smoke đã chạy thành công trên tài khoản của bạn.
