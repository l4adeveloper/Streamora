# T13 — cấu hình AWS từng bước

Theo tài liệu AWS ngày **15/11/2026**, dùng tên mục tiếng Anh hiện tại.
Làm lần lượt từ trên xuống; tên dịch vụ và ARN cố định đã điền ngay tại từng bước.

Code triển khai CDK đã được bỏ. Local chỉ đóng gói ZIP và chuẩn bị khóa ký; mọi
tài nguyên AWS dưới đây được tạo/cấu hình trong Console.

Chọn region **Asia Pacific (Tokyo) — ap-northeast-1**, account **586481704097**.
IAM và CloudFront dùng giao diện global.

**Tài nguyên cùng tên đã có thì mở để cấu hình tiếp.** Giữ dữ liệu và khóa ký đang
chạy. Không xóa stack `StreamoraT13`/`CDKToolkit` cũ vì có thể còn sở hữu dịch vụ.

## 1. S3 — nguồn upload và output private

Mở [S3 Console](https://console.aws.amazon.com/s3/) → **General purpose buckets**.
Chọn **Create bucket**, tạo lần lượt hai bucket:

| Bucket | Điền vào Bucket name |
| --- | --- |
| File upload/bản ghi gốc | `streamora-file-storage` |
| Video đã convert | `streamora-video-586481704097-ap-northeast-1` |

Cả hai bucket dùng cấu hình sau:

| Trường | Bucket nguồn và bucket output |
| --- | --- |
| AWS Region | Asia Pacific (Tokyo) — `ap-northeast-1` |
| Bucket type | General purpose |
| Object Ownership | ACLs disabled / Bucket owner enforced |
| Block Public Access | Bật toàn bộ bốn lựa chọn |
| Bucket Versioning | Có thể giữ Disabled cho triển khai tối thiểu |
| Default encryption | Server-side encryption with Amazon S3 managed keys — SSE-S3 |

Chọn **Create bucket**. Bucket có sẵn đang dùng SSE-KMS cần quyền KMS bổ sung;
các policy mẫu ở đây dùng SSE-S3, không tự thay encryption dữ liệu hiện có.

Mở **streamora-file-storage → Permissions → Cross-origin resource sharing (CORS) → Edit**.
Dán JSON sau rồi **Save changes**:

```json
[
  {
    "ID": "streamora-upload",
    "AllowedOrigins": ["https://18-138-205-52.sslip.io"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": [
      "ETag",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

Nếu đã có rule cho ứng dụng khác, giữ rule đó trong cùng mảng và đặt rule Streamora
trước các rule rộng có thể khớp cùng origin. Thay `AllowedOrigins` nếu đổi frontend.

## 2. DynamoDB — trạng thái xử lý, không cần PostgreSQL cho Lambda

Mở [DynamoDB Console](https://console.aws.amazon.com/dynamodb/) → **Tables → Create table**.

| Trường | Giá trị |
| --- | --- |
| Table name | `streamora-video-jobs` |
| Partition key | `pk`, kiểu **String** |
| Sort key | `sk`, kiểu **String** |
| Table settings | Customize settings nếu cần chỉnh capacity/protection |
| Table class | DynamoDB Standard |
| Capacity mode | **On-demand** |
| Encryption | Khóa do DynamoDB/AWS sở hữu mặc định |
| Deletion protection | Bật |

Tạo bảng, đợi **Active**. Không tự tạo item, không bật TTL tự xóa job.

Mở **streamora-video-jobs → Indexes → Create index**:

| Trường | Giá trị |
| --- | --- |
| Partition key | `work`, **String** |
| Sort key | `dueAt`, **Number** |
| Index name | **`work-due`** |
| Attribute projections | **All** |
| Capacity | On-demand theo bảng |

Đợi index **Active**. Sai tên hoặc kiểu `dueAt` sẽ làm phục hồi/cleanup không chạy.

Mở **streamora-video-jobs → Exports and streams → DynamoDB stream details → Turn on**;
chọn **New image** rồi bật stream.
Ở **streamora-video-jobs → Backups → Point-in-time recovery → Edit**, bật PITR và lưu.
Nếu chưa bật deletion protection lúc tạo, vào cấu hình bảng và bật trước khi dùng.

## 3. SQS — giữ sự kiện đã retry vẫn lỗi

Mở [SQS Console](https://console.aws.amazon.com/sqs/) → **Queues → Create queue**:

| Trường | Giá trị |
| --- | --- |
| Type | **Standard**, không dùng FIFO |
| Name | `streamora-video-failures` |
| Message retention period | **14 days** |
| Visibility timeout / Delivery delay | Giữ mặc định |
| Encryption | Enabled, **SSE-SQS** / Amazon SQS managed keys |
| Dead-letter queue của chính queue này | Không cần cấu hình thêm |

Không thêm queue này làm Lambda trigger. Tạo xong, mở **streamora-video-failures → Access policy → Edit** và dùng
[failure-queue-policy.json](../infra/t13/failure-queue-policy.json).
Nếu queue đã có policy, gộp các statement, không bỏ quyền hợp lệ của workload khác.

## 4. IAM role cho MediaConvert

Mở **IAM → Roles → Create role → Custom trust policy**, dán:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "mediaconvert.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
```

Đi tiếp, không cần gắn policy toàn quyền. Đặt tên **`streamora-video-mediaconvert`**,
chọn **Create role**. Mở role → **Permissions → Add permissions → Create inline policy**
→ **JSON**, dán [mediaconvert-policy.json](../infra/t13/mediaconvert-policy.json).
Đi tiếp, đặt policy name `streamora-video-storage`, tạo policy.

Role ARN đã điền sẵn:

```text
arn:aws:iam::586481704097:role/streamora-video-mediaconvert
```
Role có sẵn thì kiểm tra trust/permissions tương ứng thay vì tạo lại.

## 5. MediaConvert — queue encode on-demand

Mở **AWS Elemental MediaConvert → Queues → Create queue** tại Tokyo:

| Trường | Giá trị |
| --- | --- |
| Name | `streamora-video` |
| Queue type/pricing nếu được hỏi | **On-demand** |
| Concurrent jobs | **4** trong giới hạn quota account |
| Status | Active |

Chọn **Create queue**. Queue ARN đã điền sẵn:

```text
arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/streamora-video
```

Không cần tạo job/template/preset bằng tay; Lambda đã tạo cấu hình encode theo video.

## 6. IAM role cho Lambda

**IAM → Roles → Create role → AWS service → Lambda**, đi tiếp và gắn
**AWSLambdaBasicExecutionRole** để ghi CloudWatch Logs.
Đặt role name **`streamora-video-lambda`**, tạo role.

Mở **streamora-video-lambda → Add permissions → Create inline policy → JSON**, dán
[lambda-policy.json](../infra/t13/lambda-policy.json); đặt tên `streamora-video-runtime`.

## 7. Lambda — upload code và cấu hình xử lý

### 7.1. Đóng gói trên máy local

Tại root repository, dùng Node.js 22.16+ và npm 10+:

```bash
npm ci
npm run package:video-lambda
```

Kết quả **`backend/dist/video-lambda.zip`**, bên trong có `index.cjs` ở gốc.
Không upload cả repository, `node_modules`, `.env` hoặc folder bọc ngoài ZIP.

### 7.2. Tạo function và nạp ZIP

Mở [Lambda Console](https://console.aws.amazon.com/lambda/) → **Event Functions →
Create Event Function → Author from scratch**. Nếu tài khoản chưa nhận tên giao
diện mới, mục tương đương là Functions/Create function.

| Trường | Giá trị |
| --- | --- |
| Function name | `streamora-video-pipeline` |
| Runtime | **Node.js 22.x**; chọn rõ, không để mặc định Node.js 24 |
| Architecture | x86_64 |
| Change default execution role | Use an existing role → `streamora-video-lambda` |
| Durable execution / tenant isolation | Không bật cho handler này |
| VPC | Không gắn VPC |

Tạo function → **Code → Code source → Upload from → .zip file** → chọn ZIP → **Save**.
Trong **Runtime settings → Edit**, đặt **Handler = `index.handler`**, lưu.
Nếu khu vực Runtime settings đang thu gọn, mở nó ở tab Code.

Trong **Configuration → General configuration → Edit**:
**Memory = 512 MB**, **Timeout = 5 min 0 sec**, lưu.
Trong **Configuration → Concurrency → Edit** đặt **Reserved concurrency = 2**.
Nếu account mới có quota quá thấp để reserve, giữ unreserved, không đặt 0; có thể
yêu cầu tăng quota rồi reserve sau. Giới hạn bốn job encode vẫn nằm ở MediaConvert.

Mở **streamora-video-pipeline → Configuration → Environment variables → Edit**.
Thêm từng key/value sau; các ARN đã được điền sẵn:

```dotenv
NODE_ENV=production
FILES_S3_REGION=ap-northeast-1
FILES_S3_BUCKET=streamora-file-storage
VIDEO_MODE=aws
VIDEO_WORKER_ENABLED=false
VIDEO_DYNAMODB_TABLE=streamora-video-jobs
VIDEO_AWS_ACCOUNT_ID=586481704097
VIDEO_OUTPUT_BUCKET=streamora-video-586481704097-ap-northeast-1
VIDEO_MAX_QUALITY=1080
VIDEO_OPTIONAL_QUALITIES=
VIDEO_MEDIACONVERT_ROLE_ARN=arn:aws:iam::586481704097:role/streamora-video-mediaconvert
VIDEO_MEDIACONVERT_QUEUE_ARN=arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/streamora-video
```

Đây là env Lambda. Block dành cho EC2 nằm cuối tài liệu.
`VIDEO_OPTIONAL_QUALITIES` có thể bỏ hẳn nếu giao diện không cho lưu chuỗi rỗng.
Không đặt `AWS_REGION` vào Lambda env vì AWS tự cấp; code dùng `FILES_S3_REGION`.

### 7.3. Retry và nơi giữ lỗi bất đồng bộ

**Configuration → Asynchronous invocation → Edit**: maximum event age **1 hour**,
retry attempts **2**, lưu. Ở function overview chọn **Add destination**:
**Source = Asynchronous invocation**, **Condition = On failure**, **Destination type =
SQS queue**, chọn `streamora-video-failures`. Lưu.
Nếu function cũ đã có legacy DLQ, chuyển sang on-failure destination này và bỏ DLQ
cũ sau khi xác nhận destination đúng; không cần hai cơ chế cùng lúc.

### 7.4. CloudWatch Logs

**Monitor → View CloudWatch logs** mở log group
`/aws/lambda/streamora-video-pipeline` sau lần gọi đầu tiên.
Trong **CloudWatch → Logs → Log groups**, mở group và đặt **Retention = 1 week**.
Chưa có group thì chạy test ở mục 11 rồi quay lại chỉnh retention.

## 8. DynamoDB trigger — bắt đầu xử lý ngay khi có job

Mở **Lambda → streamora-video-pipeline → Add trigger → DynamoDB**:

| Trường | Giá trị |
| --- | --- |
| DynamoDB table | `streamora-video-jobs`, stream vừa bật |
| Batch size | **1** |
| Batch window | **0 seconds** |
| Starting position | **Trim horizon** |
| Retry attempts | **3**, không để infinite |
| Maximum age of record | **86400 seconds / 24 hours** |
| Concurrent batches per shard | **1** |
| Split batch on error | Off; batch chỉ có một record |
| Report batch item failures | **Bật** — `ReportBatchItemFailures` |
| On-failure destination | `arn:aws:sqs:ap-northeast-1:586481704097:streamora-video-failures` |
| Enable trigger | Bật |

Mở **Additional settings** nếu các trường trên đang ẩn. Trong **Filter criteria →
Add filter**, dán JSON sau:

```json
{
  "eventName": ["INSERT"],
  "dynamodb": {
    "NewImage": {
      "kind": {
        "S": ["JOB"]
      },
      "state": {
        "S": ["QUEUED", "SUBMITTING", "PROCESSING", "VERIFYING"]
      }
    }
  }
}
```
Nếu form tạo chưa có đủ trường, tạo rồi mở **Configuration → Triggers → chọn trigger →
Edit** để hoàn tất. Xác nhận trigger **Enabled**, không có Last processing result lỗi.

## 9. EventBridge — nhận kết quả MediaConvert

Mở [EventBridge Console](https://console.aws.amazon.com/events/) → **Event buses →
default → Rules → Create rule → Advanced Builder**. Đây là trình tạo JSON hiện tại;
không cần dùng canvas Enhanced Builder.

1. Name: **`streamora-video-completion`**; event bus **default**;
   rule type **Rule with an event pattern**; bật rule.
2. **Creation method → Custom pattern (JSON editor)**, dán:

   ```json
   {
     "source": ["aws.mediaconvert"],
     "account": ["586481704097"],
     "region": ["ap-northeast-1"],
     "detail-type": ["MediaConvert Job State Change"],
     "detail": {
       "status": ["COMPLETE", "ERROR", "CANCELED", "STATUS_UPDATE"],
       "userMetadata": {
         "project": ["streamora"]
       }
     }
   }
   ```
3. Target: **AWS service → Lambda function → `streamora-video-pipeline`**.
4. Target input: **Matched events / toàn bộ sự kiện**. Không đổi thành constant:
   handler cần account, region, detail và userMetadata gốc.
5. Additional settings: maximum event age **1 hour**, retry attempts **2**;
   Dead-letter queue chọn queue SQS `streamora-video-failures` cùng account.
6. Giữ lựa chọn Console cấp quyền invoke cho target; review rồi tạo rule.

Mở Lambda → **Configuration → Permissions → Resource-based policy statements**,
kiểm tra có quyền `lambda:InvokeFunction` cho `events.amazonaws.com`, giới hạn
Source ARN của rule vừa tạo. Nếu Console chưa thêm, chọn **Add permissions → AWS
service → EventBridge**, điền và lưu:

| Trường | Giá trị |
| --- | --- |
| Statement ID | `streamora-video-completion` |
| Principal | `events.amazonaws.com` |
| Source ARN | `arn:aws:events:ap-northeast-1:586481704097:rule/streamora-video-completion` |
| Action | `lambda:InvokeFunction` |
Nếu giao diện hiện thêm execution role cho target, giữ role Console tạo với quyền
invoke đúng function; không gán role runtime của Lambda làm role EventBridge.

## 10. EventBridge Scheduler — phục hồi và dọn output mỗi phút

Tạo lịch bằng **Scheduler**, không dùng mục **Scheduled rule (legacy)**.

Trước tiên tạo IAM role: **IAM → Roles → Create role → Custom trust policy**, dán
[scheduler-trust.json](../infra/t13/scheduler-trust.json), đặt tên
**`streamora-video-scheduler`**. Mở role → **Add permissions → Create inline policy →
JSON**, dán [scheduler-policy.json](../infra/t13/scheduler-policy.json), đặt tên
**`streamora-video-maintenance`**, tạo policy.
Trust này giới hạn schedule group **default**, đúng account và region.

Mở **EventBridge → Scheduler → Schedules → Create schedule**:

| Trường | Giá trị |
| --- | --- |
| Schedule name | `streamora-video-maintenance` |
| Schedule group | **default** |
| Occurrence | Recurring schedule |
| Schedule type | Rate-based schedule |
| Rate | **1 minute**, tương đương `rate(1 minute)` |
| Flexible time window | **Off** |
| Start/end date | Không cần giới hạn |
| Target | Templated targets → **AWS Lambda Invoke** |
| Lambda function | `streamora-video-pipeline` |
| Payload/Input | **`{"action":"maintenance"}`** |
| Retry | Maximum event age 1 hour; maximum retry attempts 2 |
| Dead-letter queue | `streamora-video-failures` |
| Queue ARN nếu cần nhập | `arn:aws:sqs:ap-northeast-1:586481704097:streamora-video-failures` |
| Permissions / Execution role | Use existing role → `streamora-video-scheduler` |
| Role ARN nếu cần nhập | `arn:aws:iam::586481704097:role/streamora-video-scheduler` |
| Schedule state | Enabled |

Review rồi **Create schedule**. Không tạo thêm lịch một phút khác nếu lịch cũ vẫn
chạy: khi chuyển từ rule maintenance cũ, disable rule cũ sau khi schedule mới đã bật.

Scheduler chỉ phục hồi/cleanup. Video mới bắt đầu qua DynamoDB Streams ngay sau bàn giao.

## 11. Thử Lambda

Mở **Lambda → streamora-video-pipeline → Test → Create new event**,
Event name = **maintenance-check**, dán JSON:

```json
{"action":"maintenance"}
```

Save rồi Test, kỳ vọng `{"ok":true}`. Test này chạy phục hồi/cleanup thật nếu bảng
đã có dữ liệu. Lỗi AccessDenied thì xem role **streamora-video-lambda**; lỗi Query
thì kiểm tra index **work-due**, `work: String`, `dueAt: Number` và projection All.

## 12. CloudFront — public key và key group

Nếu distribution/secret cũ đang chạy, tái sử dụng public key ID, key group và private
key tương ứng. Trong **Secrets Manager → streamora/video-signing → Retrieve secret value**, đối chiếu
`keyPairId` với **CloudFront → Public keys**. Không tự tạo khóa mới để thay khóa cũ.

**Với triển khai mới**, tại root chạy:

```bash
npm run video:signing-key
```

Script chỉ tạo cặp RSA 2048 local nếu chưa có, kiểm tra cặp khóa đã có, không gọi AWS.
Mở `backend/infra/t13/.local/cloudfront-public.pem`, copy toàn bộ PEM.

Mở [CloudFront Console](https://console.aws.amazon.com/cloudfront/v4/home) →
**Public keys → Create public key**. Name `streamora-video`, Key value là public PEM,
tạo key và ghi lại **Public key ID**.
Mở **Key groups → Create/Add key group**, name `streamora-video`, thêm public key vừa
tạo vào group, lưu. Dùng key group này ở behavior video bên dưới.

## 13. Secrets Manager — lưu private key ký video

Với triển khai mới, chạy lại, thay `PUBLIC_KEY_ID` bằng **ID public key**, không phải
ID distribution hay key group:

```bash
npm run video:signing-key -- PUBLIC_KEY_ID
```

Mở `backend/infra/t13/.local/signing-secret.json`. File là JSON hợp lệ gồm
`keyPairId` và `privateKey`, đã xử lý xuống dòng PEM; không tự bỏ các dấu `\n` trong JSON.

Mở **Secrets Manager → Store a new secret → Other type of secret → Plaintext**,
dán toàn bộ JSON. Encryption key **aws/secretsmanager**, Next. Secret name:
**`streamora/video-signing`**. Không bật automatic rotation cho secret ký này.
Review và **Store**, ghi lại **Secret ARN đầy đủ**, gồm hậu tố ngẫu nhiên.
Không chọn loại database secret và không nhập `DATABASE_URL` vào đây.

Secret có sẵn thì giữ nguyên nếu đúng cặp khóa và public key ID; không ghi đè bằng
payload local chưa đối chiếu. Backend EC2 đọc secret này; Lambda encode không đọc nó.

## 14. CloudFront — distribution, OAC và hai behavior bắt buộc

### 14.1. Tạo/cập nhật distribution và S3 origin

Mở **CloudFront → Distributions → Create distribution**, điền:

| Trường | Giá trị |
| --- | --- |
| Name | `streamora-video` |
| Distribution type | Single website or app |
| Pricing plan nếu được hỏi | Pay-as-you-go |
| Domain setup | Bỏ qua custom domain |
| Origin type | Amazon S3 |
| S3 bucket | `streamora-video-586481704097-ap-northeast-1` |
| Origin name nếu được hỏi | `streamora-video-output` |
| Origin path | Để trống |
| Settings | Customize origin settings |
| Origin access | Origin access control — OAC |
| OAC name | `streamora-video-output` |
| Signing | Sign requests (recommended) / Always |
| WAF | Không cần bật thêm cho triển khai tối thiểu |

Review và tạo. Nếu đang dùng distribution **d2etcjbg4sxx6m.cloudfront.net**, mở nó
để chỉnh tiếp. Origin ID cũ có thể khác ví dụ; chọn theo bucket
**streamora-video-586481704097-ap-northeast-1**.

Ghi lại **Distribution ID** và **Distribution domain name**.
Mở **S3 → streamora-video-586481704097-ap-northeast-1 → Permissions → Bucket policy → Edit**.
Dán policy dưới đây, chỉ thay **REPLACE_WITH_DISTRIBUTION_ID** bằng ID AWS cấp.
Nếu đã có policy, gộp statement Allow này và giữ các statement cũ.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::streamora-video-586481704097-ap-northeast-1/*",
    "Condition": {"StringEquals": {
      "AWS:SourceArn": "arn:aws:cloudfront::586481704097:distribution/REPLACE_WITH_DISTRIBUTION_ID"
    }}
  }]
}
```

Lưu, giữ **Block Public Access bật**. Trong **CloudFront → distribution streamora-video →
Origins**, kiểm tra S3 origin dùng OAC **streamora-video-output**.

### 14.2. Tạo response headers policy cho CORS

**CloudFront → Policies → Response headers → Create response headers policy**,
name `streamora-video-cors`. Bật **Configure CORS**:

| Trường | Giá trị |
| --- | --- |
| Access-Control-Allow-Origin | `https://18-138-205-52.sslip.io`, thay bằng frontend thật nếu khác |
| Access-Control-Allow-Credentials | true |
| Access-Control-Allow-Methods | GET, HEAD, OPTIONS, POST |
| Access-Control-Allow-Headers | Authorization, Content-Type, Range |
| Access-Control-Expose-Headers | Content-Length, Content-Range, Accept-Ranges |
| Origin override | Bật |

Tạo policy. Không dùng Allow-Origin `*` với credentials.

### 14.3. Default behavior bảo vệ HLS

Mở **CloudFront → distribution streamora-video → Behaviors → Default (*) → Edit**:

| Trường | Giá trị |
| --- | --- |
| Origin | `streamora-video-output` — bucket `streamora-video-586481704097-ap-northeast-1`, có OAC |
| Viewer protocol policy | HTTPS only |
| Allowed HTTP methods | GET, HEAD, OPTIONS |
| Restrict viewer access / Use signed URLs or signed cookies | **Yes** |
| Trusted authorization type | **Trusted key groups** |
| Key group | `streamora-video` |
| Cache policy | Managed **CachingOptimized** |
| Origin request policy | Không forward cookie/header auth đến S3 nếu không cần |
| Response headers policy | `streamora-video-cors` |

Lưu. Không tạo behavior rộng `groups/*` công khai có precedence cao hơn default.

### 14.4. API origin và media-grant behavior

Mở **CloudFront → distribution streamora-video → Origins → Create origin**:
origin type **Other / custom origin**, domain **`18-138-205-52.sslip.io`**,
name `streamora-api`, origin path trống, protocol **HTTPS only**, port **443**,
minimum origin SSL protocol **TLSv1.2**. Origin này không dùng OAC.
EC2 cần HTTPS certificate hợp lệ cho domain đó và reverse proxy chuyển `/api/v1/*`
đến backend. Không dùng IP trần hoặc nối trực tiếp HTTP port 4000 cho origin này.

**CloudFront → distribution streamora-video → Behaviors → Create behavior**:

| Trường | Giá trị |
| --- | --- |
| Path pattern | **`/api/v1/files/*/media-grant`** |
| Origin | `streamora-api` |
| Viewer protocol policy | HTTPS only |
| Allowed HTTP methods | **GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE** để có POST |
| Restrict viewer access / signed cookies | **No** — API tự kiểm tra đăng nhập/quyền |
| Cache policy | Managed **CachingDisabled** |
| Origin request policy | Managed **AllViewerExceptHostHeader** |
| Response headers policy | `streamora-video-cors` |

Đặt behavior này có precedence trước default và mọi pattern rộng có thể khớp nó.
Không cache grant hoặc `Set-Cookie`; không gắn trusted key group vào grant endpoint,
vì người xem cần gọi endpoint này để nhận cookie đầu tiên.
Sau khi lưu, đợi distribution triển khai xong, Status Enabled và không còn Deploying.

## 15. Cấp quyền cho EC2 API

EC2 đã có IAM role thì thêm policy vào role đó để giữ quyền các module khác.
Nếu chưa có: **IAM → Roles → Create role → AWS service → EC2**,
đặt **Role name = streamora-api**, tạo role.

Mở role của EC2 → **Add permissions → Create inline policy → JSON**, dán
[ec2-api-policy.json](../infra/t13/ec2-api-policy.json), đặt
**Policy name = streamora-video-api**, lưu.

Nếu vừa tạo role: **EC2 → Instances → chọn máy API → Actions → Security →
Modify IAM role → streamora-api → Update IAM role**.

Dùng instance role thì không cần access key tĩnh. Chỉ bỏ key cũ khỏi env sau khi
role có đủ quyền cho IVS và các module khác; key tĩnh còn lại có thể được ưu tiên hơn role.

## 16. Cập nhật backend và nghiệm thu

1. Backup `backend/.env` trên EC2. Chép block ở mục 17, thay các giá trị chưa biết,
   **thay dòng cũ cùng tên**, không nối thêm các dòng trùng. Giữ cấu hình auth/database
   và các module khác. `NODE_ENV` là tên đúng; xóa dòng `ODE_ENV` gõ thiếu chữ N.
2. Đưa source mới lên EC2, chạy tại root repository:

   ```bash
   npm ci
   npm run db:migrate
   npm run build --workspace=@streamora/api
   pm2 restart streamora-api --update-env
   ```

   Thay `streamora-api` bằng process name thật. PostgreSQL hiện có vẫn phục vụ
   auth/quyền/metadata/bàn giao bền vững của ứng dụng; chỉ phần xử lý job T13 ở AWS
   dùng DynamoDB. Không xóa `DATABASE_URL` của API.
3. Upload clip 10–30 giây **qua ứng dụng**, hoặc hoàn tất bản ghi trình duyệt.
   Kỳ vọng `QUEUED → PROCESSING → READY`. Trong MediaConvert Jobs phải có job mới,
   output xuất hiện dưới `groups/.../videos/...` ở bucket output.
4. Phát HLS, đổi chất lượng. Browser Network phải thấy POST media-grant qua domain
   CloudFront rồi các request `.m3u8`/segment thành công. Cửa sổ ẩn danh không có
   grant phải nhận 403 khi mở trực tiếp cùng HLS URL.
5. Kiểm tra CloudWatch Lambda Errors/Throttles, EventBridge FailedInvocations,
   Scheduler TargetErrorCount và SQS messages. Queue rỗng trong luồng thành công.
6. Khi đổi code Lambda, chỉ chạy `npm run package:video-lambda` rồi upload ZIP mới
   và kiểm tra handler/env; không phải tạo lại các dịch vụ.

| Triệu chứng | Kiểm tra trước |
| --- | --- |
| QUEUED lâu, không có MediaConvert job | API role/DynamoDB handoff, stream Enabled, filter, Lambda Logs |
| Lambda AccessDenied MediaConvert | `mediaconvert:Probe`, CreateJob/GetJob/ListJobs và PassRole đúng role |
| Job ERROR đọc/ghi S3 | Role MediaConvert, bucket/key/region, SSE-KMS nếu có |
| Encode xong nhưng chưa READY | EventBridge pattern/target permission, GetJob và finalizer; Scheduler chỉ là phục hồi |
| HLS 403 | OAC/bucket policy, trusted key group, public key ID trong secret, cookie hết hạn |
| media-grant 403 ở CloudFront | Behavior grant phải không yêu cầu signed cookie, precedence đúng |
| media-grant 401 | Authorization phải được chuyển đến API qua AllViewerExceptHostHeader |
| media-grant 502 | HTTPS origin, certificate domain, port 443 và reverse proxy EC2 |
| CORS/cookie bị chặn | Origin đúng tuyệt đối, Allow-Credentials, browser cookie policy |

`sslip.io` và `cloudfront.net` khác site. Một số trình duyệt chặn cookie bên thứ ba;
CORS đúng cũng không vượt qua được chặn này. Production ổn định nên dùng frontend/
API/media dưới cùng domain sở hữu, ví dụ `app.example.com`, `api.example.com`,
`media.example.com`; CloudFront alternate domain cần certificate ACM tại us-east-1.
Khi đổi domain, cập nhật WEB_ORIGIN, S3 CORS, response headers policy và media domain.

<details>
<summary>Tài liệu AWS tham chiếu</summary>

Nguồn AWS: [tạo bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/GetStartedWithS3.html),
[CORS JSON trong giao diện hiện tại](https://docs.aws.amazon.com/AmazonS3/latest/userguide/enabling-cors-examples.html).

Nguồn AWS: [tạo bảng/PITR](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/getting-started-step-1.html),
[GSI](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.OnlineOps.html),
[bật Streams](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html).

Nguồn AWS: [Standard queue trong Console](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/creating-sqs-standard-queues.html),
[on-failure của DynamoDB mapping](https://docs.aws.amazon.com/lambda/latest/dg/services-dynamodb-eventsourcemapping.html).

Nguồn AWS: [tạo queue theo Console hiện tại](https://docs.aws.amazon.com/mediaconvert/latest/ug/creating-queues.html),
[concurrency và quota](https://docs.aws.amazon.com/mediaconvert/latest/ug/working-with-on-demand-queues.html).

Nguồn AWS: [Event Functions và upload ZIP](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-package.html),
[cấu hình function](https://docs.aws.amazon.com/lambda/latest/dg/file-processing-app.html),
[reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html),
[async retry](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-configuring.html),
[on-failure destination](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html).

Nguồn AWS: [tạo mapping và các trường](https://docs.aws.amazon.com/lambda/latest/dg/services-dynamodb-eventsourcemapping.html),
[thêm filter trong Console](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html),
[partial batch response](https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-batchfailurereporting.html).

Nguồn AWS: [Advanced Builder hiện tại](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-wizard.html),
[quyền target](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html).

Nguồn AWS: [Scheduler Console](https://docs.aws.amazon.com/scheduler/latest/UserGuide/getting-started.html),
[execution role](https://docs.aws.amazon.com/scheduler/latest/UserGuide/setting-up.html),
[scheduled rule đã là legacy](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rules.html).

Nguồn AWS: [public key và trusted key group](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html).

Nguồn AWS: [Other type of secret / Plaintext](https://docs.aws.amazon.com/secretsmanager/latest/userguide/create_secret.html).

Nguồn AWS: [wizard Single website or app hiện tại](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-creating-console.html),
[pricing plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html),
[OAC và bucket policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).

Nguồn AWS: [response headers policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/creating-response-headers-policies.html).

Nguồn AWS: [gắn signer theo behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html).

Nguồn AWS: [AllViewerExceptHostHeader](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html).

Nguồn AWS: [gắn role trong Console](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attach-iam-role.html).

</details>

## 17. Danh sách cuối cùng — dán vào `.env` của backend EC2

Mẫu có thể mở riêng: [ec2.env.example](../infra/t13/ec2.env.example).
Block dưới đã điền domain và signing secret **bạn cung cấp**, dùng khi giữ tài nguyên cũ.
Nếu tạo mới, chỉ thay `VIDEO_MEDIA_DOMAIN` và `VIDEO_SIGNING_SECRET_ARN` bằng giá trị
AWS vừa cấp. Tên/ARN của các dịch vụ còn lại đã điền đúng trong từng bước.

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
VIDEO_DYNAMODB_TABLE=streamora-video-jobs
VIDEO_AWS_ACCOUNT_ID=586481704097
VIDEO_OUTPUT_BUCKET=streamora-video-586481704097-ap-northeast-1
VIDEO_MAX_QUALITY=1080
VIDEO_OPTIONAL_QUALITIES=
VIDEO_MEDIA_DOMAIN=d2etcjbg4sxx6m.cloudfront.net
VIDEO_SIGNING_SECRET_ARN=arn:aws:secretsmanager:ap-northeast-1:586481704097:secret:streamora/video-signing-F3xMpv
```

| Biến cần thay | Lấy ở đâu / lưu ý |
| --- | --- |
| `WEB_ORIGIN` | Đã điền `https://18-138-205-52.sslip.io`; chỉ sửa nếu đổi frontend |
| `VIDEO_MEDIA_DOMAIN` | CloudFront distribution → General → Distribution domain name; **không** có `https://` hoặc path. Có thể giữ `d2etcjbg4sxx6m.cloudfront.net` nếu tái sử dụng đúng distribution cũ |
| `VIDEO_SIGNING_SECRET_ARN` | Secrets Manager → `streamora/video-signing` → Secret ARN, đầy đủ hậu tố |

Giữ nguyên `DATABASE_URL`, `ACCESS_TOKEN_SECRET`, PORT và env nghiệp vụ hiện có.
EC2 không cần `VIDEO_MEDIACONVERT_ROLE_ARN`, `VIDEO_MEDIACONVERT_QUEUE_ARN`,
`VIDEO_DATABASE_SECRET_ARN` hay `VIDEO_DISPATCH_QUEUE_URL`; hai ARN MediaConvert chỉ
đặt ở Lambda. Bỏ các biến T13 cũ đó khỏi env API nếu còn. Dùng instance role thì
không thêm AWS access key vào block này. Không xóa env SQS/IVS của module khác.
