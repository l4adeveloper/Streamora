# T13 — cấu hình thủ công AWS Console: EC2 + MediaConvert

**EC2 API điều phối → MediaConvert encode → S3 output → CloudFront public.** DynamoDB lưu job; PostgreSQL hiện có giữ metadata/quyền. Không cần Lambda, Scheduler, Docker hay process PM2 mới.

Đối chiếu mã nguồn và tài liệu AWS ngày **16/11/2026**. Thông tin CloudFront được cập nhật theo ảnh Console bạn cung cấp; chưa kiểm tra trực tiếp tài khoản AWS hoặc nghiệm thu phát video. Nhãn Console có thể khác đôi chút.

## 0. Chọn đúng tài khoản

Đăng nhập tài khoản dịch vụ chứa **streamora-developer**, kiểm tra **Account ID = 586481704097**. Chọn **Tokyo / ap-northeast-1**; IAM và CloudFront là global. EC2 ở tài khoản khác chỉ chạy ứng dụng bằng credentials tài khoản dịch vụ.

Làm lần lượt các mục dưới đây; tên và giá trị cần điền được ghi ngay tại từng bước. Tài nguyên có sẵn thì kiểm tra/sửa, không tạo trùng hoặc xóa dữ liệu. Nếu tên/account/region thực tế khác, sửa đồng bộ JSON policy và env.

## 1. S3 — nguồn và output

### 1.1. Tạo bucket nguồn `streamora-file-storage`

Mở [S3 Console](https://console.aws.amazon.com/s3/), chọn region **Tokyo / ap-northeast-1** → **General purpose buckets**. Tìm `streamora-file-storage`; nếu chưa có, chọn **Create bucket**:

| Trường | Chọn |
| --- | --- |
| Region | Tokyo / ap-northeast-1 |
| Bucket name | `streamora-file-storage` |
| Bucket type | General purpose |
| Namespace nếu được hỏi | Shared global namespace |
| Object Ownership | ACLs disabled / Bucket owner enforced |
| Block Public Access | Giữ bật toàn bộ |
| Default encryption | SSE-S3 / Amazon S3 managed keys |
| Versioning | Disable cho bucket mới của cấu hình đơn giản này |

Chọn **Create bucket**.

### 1.2. Tạo bucket output `streamora-file-storage-output`

Trong [S3 Console](https://console.aws.amazon.com/s3/) → **General purpose buckets**, tìm `streamora-file-storage-output`; nếu chưa có, chọn **Create bucket**:

| Trường | Chọn |
| --- | --- |
| Region | Tokyo / ap-northeast-1 |
| Bucket name | `streamora-file-storage-output` |
| Bucket type | General purpose |
| Namespace nếu được hỏi | Shared global namespace |
| Object Ownership | ACLs disabled / Bucket owner enforced |
| Block Public Access | Giữ bật toàn bộ |
| Default encryption | SSE-S3 / Amazon S3 managed keys |
| Versioning | Disable cho bucket mới của cấu hình đơn giản này |

Chọn **Create bucket**.

Tên bucket duy nhất toàn AWS; nếu đã thuộc người khác, chọn tên khác và sửa policy/env. Bucket cũ đang dùng KMS cần quyền KMS bổ sung cho backend/role encode; không đổi encryption hoặc dữ liệu cũ tùy tiện.

### 1.3. CORS cho bucket nguồn `streamora-file-storage`

Trong **General purpose buckets**, bấm **streamora-file-storage → Permissions → Cross-origin resource sharing (CORS) → Edit**. Dán [source-cors.json](../infra/t13/source-cors.json); `AllowedOrigins` trong mẫu là `https://18-138-205-52.sslip.io`, thay nếu frontend thực tế khác, không có `/` cuối → **Save changes**. Giữ `ExposeHeaders: ETag` để upload multipart đọc được ETag. Nếu đã có rule khác, gộp vào cùng mảng. Bucket `streamora-file-storage-output` dùng CORS của CloudFront ở mục 5.

[Tham khảo tạo bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html).

## 2. DynamoDB — một bảng, một index

### 2.1. Tạo bảng `streamora-video-jobs`

Mở [DynamoDB Tokyo](https://ap-northeast-1.console.aws.amazon.com/dynamodbv2/home?region=ap-northeast-1) → **Tables**, tìm `streamora-video-jobs`. Nếu chưa có, chọn **Create table**:

| Trường | Giá trị |
| --- | --- |
| Table name | `streamora-video-jobs` |
| Partition key | `pk` — String |
| Sort key | **Bắt buộc bật**: `sk` — String |
| Table class | Standard |
| Capacity | On-demand; vào Customize settings nếu cần |

Chọn **Create table**, chờ bảng `streamora-video-jobs` có **Status = Active**.

### 2.2. Tạo index `work-due` trong bảng `streamora-video-jobs`

Trong **Tables**, bấm **streamora-video-jobs → Indexes**. Nếu chưa có index `work-due`, chọn **Create index**:

| Trường | Giá trị |
| --- | --- |
| Index name | `work-due` |
| Partition key | `work` — String |
| Sort key | `dueAt` — **Number** |
| Attribute projections | All |

Chọn **Create index**, chờ index `work-due` có **Status = Active**. Không thêm item thủ công; giữ Streams và TTL tắt cho bảng mới. PITR/deletion protection tùy nhu cầu. Bảng cũ đúng schema thì giữ nguyên. Index này được worker EC2 dùng để lấy job đến hạn.

[Tham khảo GSI](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.OnlineOps.html).

## 3. IAM — role encode và quyền backend

Mở [IAM Console](https://console.aws.amazon.com/iam/) trong tài khoản **586481704097**, chứa user **streamora-developer**. Các link JSON bên dưới là file trong repo: copy **nội dung file** vào editor JSON.

### 3.1. Role MediaConvert

1. **Roles → Create role → Custom trust policy**, dán:

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

2. **Next**, trang permissions để trống → **Next**; role name `streamora-video-mediaconvert` → **Create role**.
3. Mở **Roles → streamora-video-mediaconvert → Permissions → Add permissions → Create inline policy → JSON**. Dán [mediaconvert-policy.json](../infra/t13/mediaconvert-policy.json).
4. **Next**, policy name `streamora-video-storage` → **Create policy**.

Role có sẵn: kiểm tra **Trust relationships** và policy thay vì tạo lại. ARN: `arn:aws:iam::586481704097:role/streamora-video-mediaconvert`. Role chỉ để MediaConvert đọc S3 nguồn và ghi output, không gắn lên EC2.

[Quyền MediaConvert](https://docs.aws.amazon.com/mediaconvert/latest/ug/iam-role.html).

### 3.2. Identity sở hữu access key backend

1. **Users → streamora-developer → Permissions → Add permissions → Create inline policy → JSON**. Nếu key thuộc identity khác, mở đúng identity đó.
2. Dán [api-policy.json](../infra/t13/api-policy.json).
3. **Next**, policy name `streamora-video-api` → **Create policy**. Policy cùng tên đã có thì mở để sửa.

Policy mới gồm S3 upload/đọc/dọn output, DynamoDB bảng/index, MediaConvert Probe/CreateJob/GetJob/ListJobs và `iam:PassRole` cho đúng role encode. Đây là quyền API trước đây nhường cho Lambda. Giữ quyền IVS/chat/Azure hiện có; không thay toàn bộ quyền user bằng policy T13. Không sửa IAM của tài khoản sở hữu EC2.

[Actions và PassRole](https://docs.aws.amazon.com/service-authorization/latest/reference/list_mediaconvert.html).

Nếu chưa có access key: **Users → streamora-developer → Security credentials → Access keys → Create access key**; chọn use case phù hợp/Other, hoàn tất và lưu key/secret vào backend/.env ở mục 6. Secret chỉ hiện lúc tạo; không đưa lên frontend hoặc commit vào repository.

## 4. MediaConvert — dùng Default

### 4.1. Kiểm tra queue `Default`

Mở [MediaConvert Tokyo](https://ap-northeast-1.console.aws.amazon.com/mediaconvert/home?region=ap-northeast-1) → **Queues → Default**; kiểm tra queue Active, không Paused. Không tạo job, preset hay template bằng tay; backend tự dựng ladder theo nguồn.

ARN: `arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/Default`. Nếu còn job ở queue cũ, giữ override trong giai đoạn chuyển đổi theo mục 7.

[Tham khảo queue](https://docs.aws.amazon.com/mediaconvert/latest/ug/working-with-queues.html).

### 4.2. Bucket nguồn/output được gán khi backend tạo từng job

Không có bước gắn cố định hai bucket vào queue `Default`. Mỗi lần xử lý một video, worker trong `streamora-api` gọi **CreateJob**, gửi đủ nguồn, đích, role, queue và cấu hình HLS. MediaConvert đọc/ghi S3 trực tiếp theo yêu cầu đó.

Hai phần cấu hình phải khớp:

| Phần | Giá trị trong dự án |
| --- | --- |
| Nơi upload nguồn — `backend/.env` | `FILES_S3_BUCKET=streamora-file-storage` |
| Nơi ghi output — `backend/.env` | `VIDEO_OUTPUT_BUCKET=streamora-file-storage-output` |
| Role gửi trong CreateJob | `arn:aws:iam::586481704097:role/streamora-video-mediaconvert` |
| Queue gửi trong CreateJob | `arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/Default` |
| Quyền S3 của role encode | Đọc `streamora-file-storage/*`, ghi `streamora-file-storage-output/*` qua policy `streamora-video-storage` ở mục 3.1 |

Env chọn bucket; IAM cho phép truy cập bucket. Chỉ cấp quyền IAM chưa có nghĩa là MediaConvert tự nhận file hoặc tự bắt đầu encode.

Luồng khi upload qua ứng dụng:

1. Trình duyệt upload video vào bucket `streamora-file-storage` bằng URL do API ký.
2. Upload hoàn tất: API ghi metadata, tạo job và bàn giao sang DynamoDB `streamora-video-jobs`.
3. Worker trên EC2 nhận job, kiểm tra nguồn/chọn chất lượng rồi gọi CreateJob với các đường dẫn sau. `<...>` là giá trị do backend tự sinh, không điền thủ công:

   ```text
   Input FileInput:
   s3://streamora-file-storage/<object-key-cua-video-da-upload>

   HLS Destination:
   s3://streamora-file-storage-output/groups/<groupId>/videos/<fileId>/<jobId>/<attemptNo>/hls/master
   ```

4. MediaConvert dùng role `streamora-video-mediaconvert` để đọc nguồn, encode HLS nhiều chất lượng và ghi playlist/segment/thumbnail vào `streamora-file-storage-output`.
5. Worker gọi GetJob khoảng 10 giây/lượt khi theo dõi job. Khi Complete, worker kiểm tra output rồi chuyển READY. Player phát qua domain `d1t5ktmqzfd56b.cloudfront.net`.

Đường dẫn input/output được dựng trong `src/modules/video-processing/video-worker.ts`; `mediaconvert-encoder.ts` đưa chúng vào `Settings.Inputs[].FileInput` và `Settings.OutputGroups[].OutputGroupSettings.HlsGroupSettings.Destination` của CreateJob. Không cần template hoặc trigger S3 cho luồng này. Nếu chỉ tải file trực tiếp bằng S3 Console, ứng dụng chưa có metadata/job nên video đó không tự được encode.

**Kiểm tra sau khi upload một clip qua ứng dụng:** mở [MediaConvert Tokyo](https://ap-northeast-1.console.aws.amazon.com/mediaconvert/home?region=ap-northeast-1) → **Jobs → mở job mới nhất**. Trong chi tiết input/output hoặc phần JSON của job, kiểm tra Input bắt đầu bằng `s3://streamora-file-storage/`, HLS Destination bắt đầu bằng `s3://streamora-file-storage-output/`, role là `streamora-video-mediaconvert` và queue là `Default`. Không thấy job mới thì kiểm tra worker/env/quyền backend, chưa phải cấu hình đường dẫn trong MediaConvert Console.

[Tham khảo cấu hình input/output của từng job](https://docs.aws.amazon.com/mediaconvert/latest/ug/setting-up-a-job.html), [CreateJob API](https://docs.aws.amazon.com/mediaconvert/latest/apireference/jobs.html).

## 5. CloudFront — public, S3 private

Distribution đã có theo ảnh của bạn, dùng trực tiếp cấu hình này:

| Trường | Giá trị |
| --- | --- |
| Name | `streamora-video` |
| Distribution ID | `E1G60I1P5XO4F9` |
| Distribution domain name | `d1t5ktmqzfd56b.cloudfront.net` |
| ARN | `arn:aws:cloudfront::586481704097:distribution/E1G60I1P5XO4F9` |
| Billing | Pay-as-you-go |

Mở [CloudFront Console](https://console.aws.amazon.com/cloudfront/v4/home) → **Distributions** → chọn **E1G60I1P5XO4F9**, tên **streamora-video**, domain **d1t5ktmqzfd56b.cloudfront.net**. Không tạo distribution mới.

Ảnh hiển thị thông báo **The default cache behavior was updated** và trạng thái **Deploying**. Chờ **Last modified** hết chữ **Deploying** trước khi nghiệm thu video.

### Origin và quyền S3

Mở **Distributions → E1G60I1P5XO4F9 (streamora-video, d1t5ktmqzfd56b.cloudfront.net) → Origins → chọn origin trỏ bucket streamora-file-storage-output → Edit**:

- S3 REST origin của bucket `streamora-file-storage-output`, không dùng website endpoint; **Origin path để trống**.
- **Origin access control settings (recommended)**; nếu chưa có OAC, chọn **Create new control**, đặt tên `streamora-video-output`, chọn **Sign requests / Always**, tạo rồi chọn OAC này và **Save changes**. Nếu đã có OAC phù hợp, giữ nguyên.
- Nếu được yêu cầu, **Copy policy**; mở [S3 Console](https://console.aws.amazon.com/s3/) → **General purpose buckets → streamora-file-storage-output → Permissions → Bucket policy → Edit**, thêm statement vào policy hiện có → **Save changes**. Trong statement CloudFront, `AWS:SourceArn` phải là `arn:aws:cloudfront::586481704097:distribution/E1G60I1P5XO4F9`. Wizard đã cấp đúng quyền thì không dán lại.

Giữ S3 Block Public Access bật. OAC cho CloudFront đọc S3; người xem truy cập CloudFront công khai.

Ảnh đang ở tab Behaviors nên chưa xác nhận được OAC và bucket policy; kiểm tra trực tiếp các mục trên.

[Tham khảo OAC/bucket policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).

### Tạo policy CORS public `streamora-video-public-cors`

Đã tái hiện lỗi Chrome nhận playlist HTTP 200 nhưng thiếu `Access-Control-Allow-Origin`, khiến HLS không phát dù MediaConvert đã Complete. Tạo policy CORS với **Origin override bật** theo các bước dưới đây, thay cho `Managed-SimpleCORS` đang có. AWS yêu cầu các header CORS được cấu hình trong phần **Configure CORS**, không cho thêm chúng vào **Custom headers**.

1. Mở [CloudFront Console](https://console.aws.amazon.com/cloudfront/v4/home) → **Policies → Response headers → Create response headers policy**.
2. **Name**: `streamora-video-public-cors`.
3. Ở **Custom headers**, để trống. Nếu đã nhập dòng `Access-Control-Allow-Origin` theo bản hướng dẫn trước, bấm **Remove** cạnh dòng đó.
4. Bật **Configure CORS**, điền/chọn:

   | Trường | Giá trị |
   | --- | --- |
   | Access-Control-Allow-Origin | All origins / `*` |
   | Access-Control-Allow-Headers | All headers / `*` |
   | Access-Control-Allow-Methods | `GET`, `HEAD` |
   | Access-Control-Expose-Headers | None / để trống |
   | Access-Control-Max-Age, nếu có | `600` giây |
   | Access-Control-Allow-Credentials | Tắt / không chọn |
   | Origin override trong phần CORS | **Bật** |

5. Giữ các phần Security headers, Remove headers, Server-Timing mặc định → **Create**. Nếu policy `streamora-video-public-cors` đã có, mở kiểm tra/sửa thay vì tạo trùng.

Header này dành cho video public, không gửi cookie. Không thêm `Access-Control-Allow-Credentials: true`. S3 vẫn private qua OAC; không thay đổi quyền bucket.

[Cấu hình CORS và Origin override trong Console](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/creating-response-headers-policies.html), [các trường CORS của policy](https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_ResponseHeadersPolicyCorsConfig.html).

### Behavior — gắn policy `streamora-video-public-cors`

Mở **Distributions → E1G60I1P5XO4F9 (streamora-video, d1t5ktmqzfd56b.cloudfront.net) → Behaviors**, chọn dòng **Default (*) → Edit**:

| Trường | Giá trị |
| --- | --- |
| Origin | Chọn origin trỏ bucket `streamora-file-storage-output` |
| Viewer protocol policy | Redirect HTTP to HTTPS |
| Allowed HTTP methods | GET, HEAD |
| Restrict viewer access / signed URLs or cookies | **No** |
| Cache policy | `Managed-CachingOptimized` — trong danh sách chọn có thể hiện `CachingOptimized` |
| Origin request policy | Để trống — danh sách Behaviors hiển thị `-` |
| Response headers policy | `streamora-video-public-cors` |

Ảnh trước đó đã xác nhận một behavior **Default (*)**, Redirect HTTP to HTTPS, Managed-CachingOptimized, không có origin request policy và Managed-SimpleCORS. Trong lần sửa lỗi phát Chrome này, đổi **Response headers policy** sang `streamora-video-public-cors`. Hai trường **Allowed HTTP methods** và **Restrict viewer access** cần mở Edit để kiểm tra vì không hiển thị trong ảnh.

Nếu sửa giá trị, chọn **Save changes** rồi chờ hết **Deploying**. Env backend dùng trực tiếp `VIDEO_MEDIA_DOMAIN=d1t5ktmqzfd56b.cloudfront.net`. Player không gửi cookie CloudFront; không cần key group, khóa ký hoặc Secrets Manager cho video. **Ai có URL đều xem được video.**

Mở Chrome → **F12 → Network → Disable cache**, tải lại trang và mở video. Request `.m3u8` và `.ts` phải có **Response Headers → Access-Control-Allow-Origin: \***. Chỉ HTTP 200 hoặc mở URL ở tab mới chưa đủ để xác nhận CORS.

## 6. EC2 — env một lần, deploy như cũ

Trong `backend/.env` trên EC2, cập nhật mỗi tên biến một dòng; giữ DATABASE_URL, auth và cấu hình module khác. Key thuộc **tài khoản dịch vụ**, không phải tài khoản sở hữu EC2:

```dotenv
AWS_ACCESS_KEY_ID=<access key của streamora-developer>
AWS_SECRET_ACCESS_KEY=<secret tương ứng>
AWS_REGION=ap-northeast-1
FILES_STORAGE_DRIVER=s3
FILES_S3_BUCKET=streamora-file-storage
FILES_S3_REGION=ap-northeast-1
VIDEO_MODE=aws
VIDEO_WORKER_ENABLED=true
VIDEO_AWS_ACCOUNT_ID=586481704097
VIDEO_MEDIA_DOMAIN=d1t5ktmqzfd56b.cloudfront.net
VIDEO_DYNAMODB_TABLE=streamora-video-jobs
VIDEO_OUTPUT_BUCKET=streamora-file-storage-output
VIDEO_MEDIACONVERT_ROLE_ARN=arn:aws:iam::586481704097:role/streamora-video-mediaconvert
VIDEO_MEDIACONVERT_QUEUE_ARN=arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/Default
VIDEO_MAX_QUALITY=2160
VIDEO_OPTIONAL_QUALITIES=480,1440
```

Copy khối trên, thay access key/secret của `streamora-developer`. Domain CloudFront mới đã điền sẵn: `VIDEO_MEDIA_DOMAIN=d1t5ktmqzfd56b.cloudfront.net`, **chỉ hostname**, không thêm `https://` hoặc path. Nếu backend/PM2 còn domain cũ `d2etcjbg4sxx6m.cloudfront.net`, thay bằng `d1t5ktmqzfd56b.cloudfront.net` trước khi restart. Tên bảng, bucket, role và queue đã được điền đầy đủ trong cùng khối.

Video encode mới có mức cao nhất theo nguồn/cap, rồi các mức thấp hơn 2160/1440/1080/720/480/360p phù hợp, không upscale. Player giữ **Bản gốc**, **Tự động** và các mức đã encode. Output cũ không tự có thêm 480p/1440p sau khi deploy; dùng “Cập nhật chất lượng” trong cài đặt video player để xử lý lại nguồn. Không thêm nhãn cho chất lượng chưa tồn tại.

Chỉ dùng `AWS_SESSION_TOKEN` khi có credentials tạm thời còn hiệu lực. Biến process ưu tiên hơn `.env`; PM2/ecosystem giữ giá trị cũ thì sửa cho khớp, đặc biệt worker=true và key. Giữ `streamora-api` một instance fork như hiện tại; không thêm process worker. EC2 cần HTTPS ra AWS và kết nối PostgreSQL; không mở cổng inbound mới cho video.

Tại thư mục gốc repository trên EC2:

```bash
npm ci
npm run build
pm2 restart streamora --update-env
pm2 restart streamora-api --update-env
pm2 save
```

Worker tự chạy cùng API. Không cài Docker, AWS CLI, Java hoặc FFmpeg trên EC2 cho T13 AWS; không upload ZIP hoặc tạo lịch.

Không có bước CDK local hoặc CloudFormation để triển khai code. `npm run build` tự dọn output backend cũ trước khi biên dịch; các lệnh deploy ở trên giữ nguyên.

## 7. Chuyển từ Lambda cũ

1. Cập nhật quyền backend mục 3.2 trước khi bật worker EC2.
2. **Scheduler → Schedules → streamora-video-maintenance → Disable**. Tắt trigger DynamoDB/rule completion riêng T13 nếu còn; chờ invocation Lambda đang chạy kết thúc. Giữ trigger module khác.
3. Giữ DynamoDB/S3/CloudFront/role MediaConvert. Job encode đang chạy được worker mới theo dõi qua providerJobId đã lưu.
4. Nếu còn job ở queue cũ, giữ `VIDEO_MEDIACONVERT_QUEUE_ARN` trỏ queue đó. Chỉ đổi về Default sau khi hết job cũ; queue env phải khớp job đang theo dõi.
5. Đổi `VIDEO_WORKER_ENABLED=true`, deploy mục 6. Lease cũ có thể cần khoảng 30 giây hết hạn trước khi EC2 tiếp tục; backlog/lỗi AWS có thể làm chờ lâu hơn.
6. Nghiệm thu xong: xóa riêng Lambda `streamora-video-pipeline`, lịch T13 đã tắt, role Lambda/Scheduler riêng không còn được dùng và policy Lambda T13 cũ. Có thể giữ CloudWatch Logs tra cứu; không xóa bảng/bucket/job encode.

Các lệnh `package:video-lambda`, `test:t13:lambda` đã bỏ. Restart PM2 cập nhật cả API/worker, không còn deploy Lambda riêng.

## 8. Nghiệm thu và xử lý lỗi

1. `pm2 logs streamora-api`: không có lỗi cấu hình/quyền lặp lại.
2. Upload clip 10–30 giây: nguồn có ở S3; QUEUED chuyển PROCESSING; **MediaConvert → Jobs** có job mới.
3. Job Complete: S3 có HLS/thumbnail; API chuyển READY sau lượt poll/verify.
4. Chrome F12 → Network → Disable cache, mở player, chọn Tự động và đổi chất lượng: playlist/segment qua CloudFront, response có `Access-Control-Allow-Origin: *`. Với nguồn 1080p encode mới, menu có Bản gốc, Tự động, 1080p, 720p, 480p, 360p.
5. Copy URL master thật vào cửa sổ ẩn danh: trả playlist/tải `.m3u8`, không cần cookie. Domain CloudFront trống có thể 403 vì không có index.
6. Restart API khi job đang encode: MediaConvert tiếp tục, API theo dõi lại sau restart, không tạo thêm job encode trùng cùng lần xử lý.

| Triệu chứng | Kiểm tra |
| --- | --- |
| API không khởi động | env; account/role/queue/domain; VIDEO_MODE=aws |
| QUEUED kéo dài, không có job MediaConvert | worker=true trong PM2; api-policy mới; bảng/index Active |
| Không thấy tài nguyên | Tài khoản 586481704097, Tokyo |
| AccessDenied/PassRole | Key tài khoản dịch vụ; policy backend; trust/policy role encode |
| MediaConvert ERROR | Jobs → mở job → error message; nguồn/role/KMS nếu dùng |
| Complete nhưng chưa READY | PM2 Logs; quyền đọc output/Probe; queue env khớp; chờ poll/verify |
| WORKER_RETRY / VIDEO_HANDOFF_RETRY lặp | Kết nối AWS/PostgreSQL; work-due; credentials/quyền |
| HLS 403 | Object key; OAC/bucket policy; Restrict viewer access = No |
| HLS CORS / HTTP 200 nhưng Chrome chặn | Behavior Default (*) có `streamora-video-public-cors`; chờ Deployed, Disable cache và kiểm tra header trên cả .m3u8/.ts |

Không cần vào Lambda/Scheduler để debug sau khi chuyển đổi. Khi EC2/API dừng, MediaConvert tiếp tục encode nhưng gửi job mới và chuyển READY chờ API chạy lại.

## Ghi hình cuộc họp

Xem [cấu hình record trên AWS Management Console](recording-aws-console.md).
Giữ toàn bộ cấu hình T13 ở trên: chỉ luồng thu bản ghi dùng IVS → S3 và polling;
sau khi hoàn tất, chất lượng video vẫn được xử lý bởi pipeline hiện có.
API production tự chạy migration trước khi nhận request; năm lệnh deploy không đổi.
