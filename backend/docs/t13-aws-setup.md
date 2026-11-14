# T13 — Setup Lambda và CloudFront bằng AWS Management Console

## 1. Cấu hình và kiến trúc

Account **586481704097**, region **Tokyo — ap-northeast-1**. IAM và CloudFront là
global; các service còn lại tạo ở Tokyo. Bucket nguồn giữ nguyên
**streamora-file-storage**; kiểm tra S3 → Properties để xác nhận region.
Web/API dự kiến **https://18-138-205-52.sslip.io**, API qua `/api/v1/`.
Cần HTTPS/certificate hợp lệ trên EC2; sslip.io chỉ cung cấp DNS.

```text
API EC2 → transaction lưu file + VideoJob vào PostgreSQL
                                  ↓
EventBridge mỗi phút → Lambda đọc job QUEUED → SQS dispatch
                                                  ↓
                                            cùng Lambda
                                                  ↓
                                  MediaConvert Probe + encode
                                                  ↓
                                          S3 output private
                                                  ↓
EventBridge kết quả → SQS completion → Lambda verify → DB READY

Browser → API kiểm tra quyền → signed cookie → CloudFront → S3 output
```

EC2 phục vụ API, trạng thái, retry và cấp quyền phát; **không chạy xử lý nền T13**
trên AWS. Một Lambda xử lý từng bước ngắn; MediaConvert encode video. Không cần
Docker/ECR, FFmpeg trong Lambda, API Gateway, Function URL, Step Functions hay
CloudFormation. Job mới thường bắt đầu trong khoảng một phút khi hệ thống rảnh.

| Tài nguyên | Tên chọn sẵn |
| --- | --- |
| S3 output | `streamora-video-586481704097-ap-northeast-1` |
| SQS dispatch / DLQ | `streamora-video-dispatch` / `streamora-video-dispatch-dlq` |
| SQS completion / DLQ | `streamora-video-completion` / `streamora-video-completion-dlq` |
| Role MediaConvert / Lambda | `streamora-mediaconvert` / `streamora-video-lambda` |
| Lambda function | `streamora-video-pipeline` |
| MediaConvert queue | `streamora-video` |
| EventBridge completion rule | `streamora-video-completion` |
| EventBridge scheduled rule | `streamora-video-maintenance` |
| DB secret / signing secret | `streamora/video-database` / `streamora/video-signing` |
| CloudFront description / OAC | `streamora-video-tokyo` / `streamora-video-oac` |
| CloudFront public key / key group | `streamora-video` / `streamora-video` |
| CloudFront CORS policy | `streamora-video-cors` |

Đây là tên đề xuất, chưa xác nhận tài nguyên tồn tại. Bucket S3 có tên duy nhất
toàn cầu: nếu phải đổi tên output, sửa đồng bộ policy/env. Tạo IAM role không có
path để ARN khớp ví dụ. Các thao tác có thể phát sinh phí AWS.

## 2. PostgreSQL và secret kết nối Lambda

Dùng PostgreSQL đang có, **không bắt buộc RDS**. Lambda không tự đọc được `.env`
trên EC2; cần kết nối cùng DB bằng secret và có đường mạng tới endpoint DB.

| DB hiện tại | Cấu hình Lambda |
| --- | --- |
| Endpoint public được phép truy cập từ Lambda, có TLS | Có thể giữ Lambda ngoài VPC của bạn. Không mở DB toàn Internet chỉ để thử. |
| DB private trong VPC Tokyo | Gắn Lambda vào VPC đó, private subnets và SG riêng. DB cho inbound TCP 5432 từ SG Lambda. |
| DB private ở region/account khác | Cần peering/VPN và route/SG tương ứng; một VPC bất kỳ không tự kết nối được DB. |

Lambda trong VPC cần **AWSLambdaVPCAccessExecutionRole**. Private subnet phải có
đường ra AWS APIs/HTTPS, thông thường qua NAT đã có. Public subnet không tự cấp
public IP/Internet cho Lambda. Nếu phải dựng mạng mới, tính cả chi phí NAT; không
tạo RDS/NAT chỉ vì tên dịch vụ xuất hiện trong hướng dẫn.

Secrets Manager → **Store a new secret → Other type → Plaintext**:

```json
{"url":"postgresql://DB_USER:URL_ENCODED_PASSWORD@DB_HOST:5432/DB_NAME?sslmode=require"}
```

Điền cùng DB mà API dùng. Tên **streamora/video-database**, key mặc định
**aws/secretsmanager**. Dùng user ứng dụng có quyền đọc/ghi các bảng T13, files,
file_usages, storage_locations; Lambda không chạy migration.

Copy ARN đầy đủ dạng
`arn:aws:secretsmanager:ap-northeast-1:586481704097:secret:streamora/video-database-XXXXXX`.
Thay `DATABASE_SECRET_ARN` bên dưới bằng ARN thật, giữ cả hậu tố AWS cấp. Lambda
đọc lại secret sau khoảng 5 phút. Không nhập access key AWS vào DB secret.

## 3. S3 output và MediaConvert

### 3.1. S3

S3 → **Create bucket**:

| Trường | Giá trị |
| --- | --- |
| Bucket name | `streamora-video-586481704097-ap-northeast-1` |
| Region | Tokyo |
| Object Ownership | Bucket owner enforced, ACL disabled |
| Block Public Access | Bật cả bốn ô |
| Encryption | SSE-S3 |

Không dùng website endpoint. Giữ source private và CORS upload T16 đang có.
Không tạo S3 notification để gửi job lần nữa: transaction DB là nguồn job.
Không đặt lifecycle xóa toàn bộ video sau 7 ngày vì có thể xóa output đang phát.

### 3.2. Role MediaConvert

IAM → **Roles → Create role → Custom trust policy**, tên **streamora-mediaconvert**:

```json
{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Principal":{"Service":"mediaconvert.amazonaws.com"},"Action":"sts:AssumeRole"}]
}
```

Trong role → **Add permissions → Create inline policy → JSON**, tên
**streamora-video-objects**:

```json
{
  "Version":"2012-10-17",
  "Statement":[
    {"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::streamora-file-storage/*"},
    {"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::streamora-video-586481704097-ap-northeast-1/*"},
    {"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],"Resource":["arn:aws:s3:::streamora-file-storage","arn:aws:s3:::streamora-video-586481704097-ap-northeast-1"]}
  ]
}
```

Role ARN: `arn:aws:iam::586481704097:role/streamora-mediaconvert`.

### 3.3. MediaConvert queue

MediaConvert → **Queues → Create queue**: tên **streamora-video**, loại
**On-demand**, trạng thái **Active**. ARN dự kiến:
`arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/streamora-video`.
Đây là queue MediaConvert, không phải queue SQS.

Không cần job template/preset: code Probe nguồn, tạo ladder không upscale,
H.264/AAC tối đa 30 FPS, HLS 4 giây và JPEG. Bắt đầu cap 1080, thử 4K sau.

## 4. Bốn queue SQS

SQS → **Create queue → Standard**, encryption **SSE-SQS**; tạo DLQ trước:

| Queue | Visibility | Retention | Receive wait | DLQ |
| --- | --- | --- | --- | --- |
| `streamora-video-dispatch-dlq` | 1800 giây | 14 ngày | 20 giây | Không |
| `streamora-video-completion-dlq` | 1800 giây | 14 ngày | 20 giây | Không |
| `streamora-video-dispatch` | **1800 giây** | 4 ngày | 20 giây | dispatch-dlq, maxReceiveCount **5** |
| `streamora-video-completion` | **1800 giây** | 4 ngày | 20 giây | completion-dlq, maxReceiveCount **5** |

1800 = 6 × timeout Lambda 300 giây. Không giữ visibility 60 giây của bản worker cũ.
Nếu đổi timeout Lambda, cập nhật visibility tương ứng. Có thể đặt Redrive allow
policy của DLQ chỉ cho queue chính tương ứng. Chưa thêm trigger cho đến khi code/env/DB sẵn sàng.

```text
https://sqs.ap-northeast-1.amazonaws.com/586481704097/streamora-video-dispatch
https://sqs.ap-northeast-1.amazonaws.com/586481704097/streamora-video-completion
```

## 5. IAM role Lambda

IAM → **Roles → Create role → AWS service → Lambda**, tên **streamora-video-lambda**.
Gắn **AWSLambdaBasicExecutionRole** cho CloudWatch Logs; thêm
**AWSLambdaVPCAccessExecutionRole** nếu dùng VPC bước 2.

**Create inline policy**, tên **streamora-video-processing**, thay DB secret ARN thật:

```json
{
  "Version":"2012-10-17",
  "Statement":[
    {"Effect":"Allow","Action":["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes"],"Resource":["arn:aws:sqs:ap-northeast-1:586481704097:streamora-video-dispatch","arn:aws:sqs:ap-northeast-1:586481704097:streamora-video-completion"]},
    {"Effect":"Allow","Action":"sqs:SendMessage","Resource":"arn:aws:sqs:ap-northeast-1:586481704097:streamora-video-dispatch"},
    {"Effect":"Allow","Action":["mediaconvert:Probe","mediaconvert:CreateJob","mediaconvert:GetJob","mediaconvert:ListJobs"],"Resource":"*"},
    {"Effect":"Allow","Action":"iam:PassRole","Resource":"arn:aws:iam::586481704097:role/streamora-mediaconvert","Condition":{"StringEquals":{"iam:PassedToService":"mediaconvert.amazonaws.com"}}},
    {"Effect":"Allow","Action":"s3:GetObject","Resource":["arn:aws:s3:::streamora-file-storage/*","arn:aws:s3:::streamora-video-586481704097-ap-northeast-1/*"]},
    {"Effect":"Allow","Action":"s3:ListBucket","Resource":["arn:aws:s3:::streamora-file-storage","arn:aws:s3:::streamora-video-586481704097-ap-northeast-1"]},
    {"Effect":"Allow","Action":"s3:DeleteObject","Resource":"arn:aws:s3:::streamora-video-586481704097-ap-northeast-1/groups/*/videos/*"},
    {"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"DATABASE_SECRET_ARN"}
  ]
}
```

Lambda không cần private key CloudFront hoặc auth secret của API. Policy trên dùng
SSE-S3/key mặc định; nếu dùng KMS key riêng thì cấp thêm quyền đúng key cho vai trò đọc/ghi.

## 6. Build ZIP và tạo Lambda

Tại root repo local:

```bash
npm ci
npm run package:video-lambda
```

Kết quả **backend/dist/video-lambda.zip** chứa một `index.cjs`: code, SDK,
PostgreSQL JS driver và Prisma WASM. Không kèm `.env`, FFmpeg, frontend hay toàn
`node_modules`. Build được từ Windows, không cần Docker/native Prisma engine.
Kiểm tra đúng ZIP đó bằng `npm run test:t13:lambda` (DB tạm local, không gọi AWS).

Lambda → **Create function → Author from scratch**:

| Trường | Giá trị |
| --- | --- |
| Function name | `streamora-video-pipeline` |
| Runtime / architecture | **Node.js 22.x / x86_64** |
| Permissions | Use an existing role → `streamora-video-lambda` |
| Function URL | Không tạo |

Sau khi tạo:

1. **Code → Upload from → .zip file**, chọn ZIP, Save.
2. **Runtime settings → Edit → Handler: `index.handler`**.
3. **Configuration → General configuration:** Memory **512 MB**, Timeout
   **5 phút (300 giây)**, ephemeral storage **512 MB**.
4. **Concurrency → Reserved concurrency: 5**. Mỗi runtime dùng pool tối đa hai
   connection; DB lock giới hạn toàn hệ thống bốn job MediaConvert active.
5. **Environment variables → Edit**, nhập từng key/value:

```dotenv
NODE_ENV=production
FILES_S3_REGION=ap-northeast-1
FILES_S3_BUCKET=streamora-file-storage
VIDEO_MODE=aws
VIDEO_WORKER_ENABLED=false
VIDEO_AWS_ACCOUNT_ID=586481704097
VIDEO_MAX_QUALITY=1080
VIDEO_OUTPUT_BUCKET=streamora-video-586481704097-ap-northeast-1
VIDEO_MEDIACONVERT_ROLE_ARN=arn:aws:iam::586481704097:role/streamora-mediaconvert
VIDEO_MEDIACONVERT_QUEUE_ARN=arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/streamora-video
VIDEO_DISPATCH_QUEUE_URL=https://sqs.ap-northeast-1.amazonaws.com/586481704097/streamora-video-dispatch
VIDEO_COMPLETION_QUEUE_URL=https://sqs.ap-northeast-1.amazonaws.com/586481704097/streamora-video-completion
VIDEO_DATABASE_SECRET_ARN=DATABASE_SECRET_ARN
```

Thay dòng cuối bằng ARN thật. Không thêm access key hoặc private PEM.
`AWS_REGION` do Lambda cung cấp; T13 lấy region từ `FILES_S3_REGION`.
`VIDEO_WORKER_ENABLED=false` ngăn vòng lặp local, không tắt handler Lambda.
Muốn bật 4K/480/1440, sửa `VIDEO_MAX_QUALITY`/`VIDEO_OPTIONAL_QUALITIES` **trên Lambda**;
chỉ áp dụng job mới. EC2 không quyết định ladder AWS nữa.

Cấu hình VPC nếu cần theo bước 2. CloudWatch → log group
`/aws/lambda/streamora-video-pipeline`, đặt retention ví dụ **7 ngày**.
Mỗi lần sửa code: build/upload ZIP mới; sửa code trên EC2 không tự cập nhật Lambda.

## 7. Nối SQS và EventBridge

### 7.1. Hai SQS trigger

Lambda → **Add trigger → SQS**, thêm **hai lần**, mỗi lần một queue chính:

| Trường | Giá trị |
| --- | --- |
| Queue | dispatch, sau đó completion |
| Batch size / window | **1 / 0 giây** |
| Report batch item failures | **Bật** |
| Maximum concurrency | **2** cho mỗi trigger |
| Enable trigger | Bật sau khi DB/env/code sẵn sàng |

Trong Event source mappings kiểm tra **ReportBatchItemFailures**. Không thêm body
filter. Handler trả riêng ID message lỗi; Lambda tự xóa message thành công.

Dispatch được xác nhận sau khi submit/mapping đã có trạng thái bền vững trong DB.
Completion được xác nhận sau khi DB có kết quả READY/FAILED; READY chỉ được commit
khi HLS hợp lệ. Lỗi DB/IAM/malformed event retry rồi DLQ. Encode lỗi lưu FAILED để
người có quyền retry. Không giữ Lambda/dispatch receipt mở suốt thời gian encode
như worker cũ; DB và lịch reconcile chịu trách nhiệm phục hồi bước tiếp theo.

### 7.2. EventBridge completion → SQS

EventBridge → **Rules → Create rule**, tên **streamora-video-completion**, bus
**default**, loại **Rule with an event pattern → Custom pattern**:

```json
{
  "source":["aws.mediaconvert"],
  "account":["586481704097"],
  "region":["ap-northeast-1"],
  "detail-type":["MediaConvert Job State Change"],
  "detail":{"status":["COMPLETE","ERROR","CANCELED","STATUS_UPDATE"],"userMetadata":{"project":["streamora"]}}
}
```

Target **SQS → streamora-video-completion**, input **Matched event** nguyên bản;
không dùng transformer, không tạo Lambda completion thứ hai.

SQS completion → **Permissions → Access policy**: thêm statement sau vào mảng
`Statement` hiện có. Nếu Console đã tạo quyền tương đương, giữ một bản:

```json
{
  "Sid":"MediaConvertEvents",
  "Effect":"Allow",
  "Principal":{"Service":"events.amazonaws.com"},
  "Action":"sqs:SendMessage",
  "Resource":"arn:aws:sqs:ap-northeast-1:586481704097:streamora-video-completion",
  "Condition":{
    "ArnEquals":{"aws:SourceArn":"arn:aws:events:ap-northeast-1:586481704097:rule/streamora-video-completion"},
    "StringEquals":{"aws:SourceAccount":"586481704097"}
  }
}
```

Không ghi đè cả policy hoặc cho Principal `*` gửi message.

### 7.3. Lịch bắt buộc mỗi phút

EventBridge → **Rules → Create rule**, tên **streamora-video-maintenance**, bus
**default**, loại **Schedule** (scheduled rule/legacy nếu Console phân biệt với Scheduler):

- Rate expression **1 minute**, tương đương `rate(1 minute)`.
- Target **Lambda → streamora-video-pipeline**.
- Target input **Constant (JSON text)**:

```json
{"action":"maintenance"}
```

- Cho Console thêm quyền invoke. Lambda → Permissions → resource-based policy phải
  cho `events.amazonaws.com` gọi function với SourceArn
  `arn:aws:events:ap-northeast-1:586481704097:rule/streamora-video-maintenance`.
- Target retry có thể đặt maximum event age **1 giờ**, retry **2 lần**. Bật rule.

Lịch đọc outbox QUEUED, GetJob cập nhật tiến độ/phục hồi event bị mất, cleanup theo
lô. **Không có lịch thì API ghi DB xong nhưng job có thể QUEUED mãi.** Trong Lambda
có thể Test JSON trên, tên event `video-maintenance`, mong đợi `{"ok":true}`. Nếu
DB đã có job queued, test này có thể gửi job thật và phát sinh phí MediaConvert.

## 8. CloudFront tối thiểu và khóa ký

### 8.1. Khóa ký/key group có cần không?

**Có với signed cookie CloudFront đang dùng.** OAC chỉ bảo vệ CloudFront → S3;
key group cho CloudFront kiểm tra quyền người xem. Bỏ restrict/key group mà vẫn
dùng OAC thì người có URL CloudFront có thể đọc video. Với video nhóm/lớp, giữ
signed cookie là cách native gọn; không thêm Lambda@Edge hay token engine khác.
Private PEM này khác access key IAM và certificate HTTPS.

### 8.2. Tạo khóa, key group và secret ký

Trên máy tin cậy có OpenSSL, chạy một lần **ngoài repository**:

```bash
openssl genrsa -out streamora-video-private.pem 2048
openssl rsa -pubout -in streamora-video-private.pem -out streamora-video-public.pem
```

CloudFront → **Public keys → Create public key**, tên **streamora-video**, dán public
PEM. Copy **Public key ID**. **Key groups → Create**, tên **streamora-video**, chọn
public key vừa tạo. Secret dùng public key ID; behavior chọn key group.

Secrets Manager → **Other type → Plaintext**:

```json
{"keyPairId":"PUBLIC_KEY_ID","privateKey":"-----BEGIN PRIVATE KEY-----\nNOI_DUNG_PRIVATE_PEM\n-----END PRIVATE KEY-----\n"}
```

Dùng toàn bộ private PEM thật, giữ header/footer OpenSSL sinh ra (`RSA PRIVATE KEY`
cũng hợp lệ), xuống dòng trong JSON là `\n`. Tên **streamora/video-signing**, key
`aws/secretsmanager`. Copy ARN thật thay `SIGNING_SECRET_ARN` bên dưới. Chỉ API cần
đọc secret này; không đưa private key vào Lambda, `.env`, Git hoặc frontend.

### 8.3. Distribution, hai origin và hai behavior

CloudFront → **Create distribution**, description **streamora-video-tokyo**:

| Trường | Giá trị |
| --- | --- |
| S3 origin | Output bucket, REST regional endpoint; không dùng website endpoint |
| Origin ID / Origin path | `streamora-video-s3` / trống |
| Origin access | OAC mới `streamora-video-oac`, **Sign requests** |
| Default protocol / methods | HTTPS only / GET, HEAD, OPTIONS |
| Default cache policy | **CachingOptimized**; VOD có prefix/version riêng |
| Restrict viewer access | **Yes → Trusted key groups → streamora-video** |
| Domain/certificate ban đầu | CloudFront default |

Sau khi tạo, copy bucket policy do Console/OAC đề xuất vào S3 output → Permissions.
Policy phải cho `cloudfront.amazonaws.com` đọc output với `AWS:SourceArn` bằng
đúng ARN distribution này. Giữ Block Public Access. Cookie vẫn được kiểm tra trên
từng request kể cả cache hit; cache object không thay thế quyền xem ngắn hạn.

**Origins → Create origin** thứ hai: domain **18-138-205-52.sslip.io**, ID
**streamora-video-api**, HTTPS only, port 443, TLS 1.2, Origin path trống.
Web server chuyển route `/api/v1/` tới NestJS hiện có.

**Behaviors → Create behavior** ngoài default:

| Trường | Giá trị |
| --- | --- |
| Path pattern / origin | `/api/v1/files/*/media-grant` / `streamora-video-api` |
| Protocol / methods | HTTPS only / cả 7 method để chuyển POST/OPTIONS |
| Cache policy | **CachingDisabled** |
| Origin request policy | **AllViewerExceptHostHeader**, có Authorization/Origin |
| Restrict viewer access | **No**; API tự kiểm tra Bearer/quyền nhóm |

Không cache Set-Cookie hoặc đổi lỗi 403 thành 200. API origin chỉ cấp cookie;
video đi CloudFront → S3, không stream qua EC2/Lambda.

### 8.4. CORS và sslip.io

CloudFront → **Policies → Response headers → Create**, tên **streamora-video-cors**:

| Trường | Giá trị |
| --- | --- |
| Allow origin | `https://18-138-205-52.sslip.io`, không có `/` cuối |
| Allow credentials | true |
| Allow methods | GET, HEAD, OPTIONS, POST |
| Allow headers | Authorization, Content-Type, Range |
| Expose headers | Content-Length, Content-Range, Accept-Ranges |
| Origin override | true |

Gắn vào **cả hai behavior**. Không dùng wildcard origin với credentials. Giữ CORS
upload của source bucket; browser không cần đọc output bằng URL S3 public.

Đợi distribution **Deployed**, copy domain `dxxx.cloudfront.net` vào EC2 env.
Đây là domain AWS cấp; không tự đặt `media.18-138-205-52.sslip.io` làm alias vì bạn
không quản lý DNS sslip.io để trỏ CNAME tới CloudFront.

Web sslip.io và CloudFront khác site: khi demo browser phải cho phép cookie bên
thứ ba cho luồng này. Nếu chặn cookie, grant có thể 200 nhưng segment 403.
`SameSite=None; Secure` và CORS đúng không tự vượt qua chặn cookie. Để ổn định trên
nhiều browser, dùng domain bạn kiểm soát cho web/media, ví dụ `app.example.com` và
`media.example.com`; lúc đó mới thêm DNS alias và ACM certificate **us-east-1** cho
CloudFront. Ghi nhận giới hạn demo hiện tại khi nghiệm thu.

### 8.5. Quyền EC2 và mở rộng CDN

Gắn policy **streamora-video-runtime** vào role EC2 hoặc IAM user đang dùng trong
account tài nguyên. Thay ARN signing secret thật:

```json
{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"SIGNING_SECRET_ARN"}]
}
```

Giữ quyền upload/IVS/chat hiện có. API không cần quyền MediaConvert/SQS T13 nữa.
Nếu EC2 ở account khác, giữ credentials của account tài nguyên đang hoạt động;
không thay bằng role account EC2 không có quyền truy cập tài nguyên này.

Code tách `VideoCdnProvider`/`CloudFrontVideoCdn`: provider quyết định storage nào
phát được và URL từng asset. Sau này thêm adapter CDN, binding storage và trạng thái
replica thật. Chưa dựng GCS/Cloud CDN hoặc failover giả khi replica chưa sẵn sàng.

## 9. `.env` EC2 và chuyển khỏi worker cũ

Giữ DATABASE_URL, auth secret, AWS credentials và cấu hình upload/IVS/chat. Cập nhật
**backend/.env trên EC2**:

```dotenv
NODE_ENV=production
WEB_ORIGIN=https://18-138-205-52.sslip.io
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAME_SITE=lax
FILES_STORAGE_DRIVER=s3
FILES_S3_BUCKET=streamora-file-storage
FILES_S3_REGION=ap-northeast-1
VIDEO_MODE=aws
VIDEO_WORKER_ENABLED=false
VIDEO_AWS_ACCOUNT_ID=586481704097
VIDEO_OUTPUT_BUCKET=streamora-video-586481704097-ap-northeast-1
VIDEO_MEDIA_DOMAIN=dxxx.cloudfront.net
VIDEO_SIGNING_SECRET_ARN=SIGNING_SECRET_ARN
```

Hai dòng cuối lấy từ Console. Media domain không có scheme/path; WEB_ORIGIN có
HTTPS. Queue/MediaConvert/cap/database-secret thuộc Lambda, có thể bỏ các biến T13
cũ tương ứng khỏi env EC2. **Không xóa DATABASE_URL của API.**

Sao lưu DB rồi tại root repo EC2 chạy từng lệnh khi lệnh trước thành công:

```bash
npm ci
npm run build
npm run db:migrate
```

Nếu có PM2 `streamora-video-worker`, xóa process cũ **trước khi bật Lambda trigger/lịch**.
Không chạy `dev:video-worker` trên AWS. Với tên process thực tế:

```bash
pm2 delete streamora-video-worker
pm2 restart streamora-api --update-env
pm2 save
pm2 logs streamora-api --lines 50
```

Chỉ chạy delete nếu process tồn tại. Không để PM2 env cũ đè `.env`. T13 Lambda
không thêm schema mới; migrate áp mọi migration pending. Job encode đang chạy giữ
providerJobId/attempt trong DB để Lambda tiếp tục, không submit lại bằng tay.

Local vẫn dùng `VIDEO_MODE=local`, `VIDEO_WORKER_ENABLED=true` với FFmpeg; xem
[handoff và test local](t13-handoff.md). Không copy block AWS vào `.env` local.

## 10. Smoke test và tìm lỗi

1. Test Lambda `{"action":"maintenance"}` trả `{ok:true}`; DB/env/role đúng, hai SQS
   mapping và lịch Enabled. Log group không có lỗi kết nối DB hoặc đọc secret.
2. Upload video **mới** MP4 SDR 1080p ngắn. QUEUED → MediaConvert job sau khoảng một
   phút khi rảnh; metadata `project=streamora`, đúng jobId/attempt/nguồn S3.
3. COMPLETE → HLS/JPEG trên S3 → DB READY; player có 1080/720/360 nếu nguồn đủ.
4. Xem >60 giây, Auto/manual, tua, thumbnail. Không cookie: master/variant/segment/
   thumbnail bị từ chối; S3 trực tiếp private; user ngoài nhóm không cấp được grant.
5. File hỏng → FAILED/errorCode; retry có quyền + Idempotency-Key tạo job mới.
   SQS lỗi hạ tầng → retry/DLQ; encode FAILED dùng API retry, không redrive để ép job mới.
6. Event trùng/cold start: không publish attempt cũ/submit trùng; thiếu completion
   thì lịch GetJob phục hồi. Thử 4K sau 1080p. LIVE ABR cần test riêng với IVS STANDARD.

| Hiện tượng | Kiểm tra |
| --- | --- |
| QUEUED mãi | Lịch maintenance, DB connection, SendMessage, dispatch mapping |
| Timeout / mất mạng | VPC route/NAT/SG/DB endpoint; public subnet không đủ |
| VIDEO_DATABASE_SECRET_UNAVAILABLE | ARN/hậu tố, JSON key `url`, GetSecretValue, region |
| VIDEO_MAINTENANCE_FAILED | DB/network hoặc SendMessage; lỗi được che chi tiết để tránh lộ credentials |
| SQS không trigger | Receive/Delete/GetQueueAttributes, visibility, Enabled, concurrency |
| VIDEO_QUEUE_MISMATCH | URL/ARN/account/region Lambda không khớp event source |
| SUBMISSION_UNCERTAIN | Tra MediaConvert theo jobId/attempt; không xóa DB/submit mù |
| PROVIDER_ACCESS_DENIED | CreateJob/PassRole; role MediaConvert đọc nguồn/ghi output |
| COMPLETE chưa READY | GetObject/ListBucket/Probe output, event rule/policy, manifest thiếu hoặc sai |
| Grant lỗi | API HTTPS, Authorization forwarding, no-cache, CORS |
| Segment 403 | Key group/public key ID/secret, OAC, cookie khác site, đồng hồ |

Theo dõi CloudWatch Errors/Throttles/Duration và hai DLQ. Cleanup output cũ chạy
theo lô có giới hạn thời gian, giữ output publish/nguồn IVS; ở quy mô lớn cần theo
dõi backlog cleanup và bổ sung dọn dựa trên metadata, không xóa mù bucket.

## 11. IVS và nguồn tham chiếu

IVS Low-Latency Channel nếu dùng: **STANDARD**, recording configuration **ALL**,
ghi vào output bucket gắn CloudFront. T11 xác minh channel/phiên rồi gọi nội bộ
`FilesService.registerRecording`; Lambda kiểm tra và dùng lại HLS, không encode.
IVS Real-Time Stage là đường khác; mapping cloud T11 chưa tự hoàn tất qua setup này.

[Lambda ZIP](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-package.html),
[SQS mapping](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html),
[partial failures](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html),
[Lambda VPC](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc-internet.html),
[MediaConvert events](https://docs.aws.amazon.com/mediaconvert/latest/ug/mediaconvert_event_list.html),
[Probe](https://docs.aws.amazon.com/mediaconvert/latest/apireference/probe.html),
[signed cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-cookies.html),
[CloudFront domain](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html),
[cookie khác site](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies).

Repository cung cấp code/ZIP; bạn tự tạo tài nguyên trong Console. Kiểm thử local
không chứng minh IAM/VPC/MediaConvert/CDN đã nghiệm thu trên AWS thật.
