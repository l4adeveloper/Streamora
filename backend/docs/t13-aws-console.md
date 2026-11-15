# T13 — cấu hình AWS Console cho MVP

Đối chiếu tài liệu AWS chính thức ngày **16/11/2026**. Hướng dẫn dùng tên mục tiếng Anh; một số tài khoản có thể nhận giao diện mới sớm hoặc muộn hơn. Các bước dưới đây được kiểm tra bằng tài liệu AWS và mã nguồn dự án, chưa thao tác trong Console của bạn.

Code hiện tại lấy job bằng **Scheduler mỗi phút**. Phương án API gọi Lambda ngay mới được trao đổi, chưa được triển khai; tài liệu này cấu hình theo code đang có.

```text
EC2 API → DynamoDB ← Lambda ← Scheduler mỗi phút
                       ↓
                  MediaConvert → S3 output → CloudFront → Player HLS
```

## 0. Mở đúng tài khoản và region

1. Đăng nhập Console bằng identity **streamora-developer** trong tài khoản chứa các service.
2. Mở menu tài khoản ở góc phải, kiểm tra **Account ID = 586481704097**. Đây là ID đang dùng trong các policy mẫu.
3. Với S3, DynamoDB, Lambda, MediaConvert và Scheduler, chọn **Asia Pacific (Tokyo) / ap-northeast-1** ở thanh trên. IAM và CloudFront là dịch vụ global.
4. Nếu không thấy menu trái, bấm biểu tượng mở thanh điều hướng. Có thể dùng ô tìm kiếm dịch vụ ở thanh trên hoặc các liên kết Console trong từng mục.

**Tài nguyên đã có thì mở để kiểm tra/sửa, không tạo trùng.** Mọi thao tác IAM trong tài liệu diễn ra ở tài khoản chứa streamora-developer; không cần vào tài khoản sở hữu EC2 hoặc sửa instance role của EC2.

| Tài nguyên | Tên dùng trong dự án |
| --- | --- |
| Bucket nguồn | `streamora-file-storage` |
| Bucket output | `streamora-file-storage-output` |
| Bảng DynamoDB | `streamora-video-jobs` |
| Index | `work-due` |
| Role encode | `streamora-video-mediaconvert` |
| Role Lambda | `streamora-video-lambda` |
| Lambda | `streamora-video-pipeline` |
| Lịch | `streamora-video-maintenance` |

Làm lần lượt **S3 → DynamoDB → IAM → Lambda → Scheduler → CloudFront → env API**. Không có bước sinh cấu hình trung gian.

## 1. S3 — tạo hai bucket

Mở [S3 Console](https://console.aws.amazon.com/s3/). Trong menu trái chọn **General purpose buckets**, tìm tên bucket trước khi tạo.

### 1.1. Tạo bucket nguồn và output

Chọn **Create bucket**, thực hiện hai lần với hai tên ở bảng trên:

| Trường trên form | Điền/chọn |
| --- | --- |
| AWS Region | Asia Pacific (Tokyo) — ap-northeast-1 |
| Bucket type | General purpose |
| Bucket namespace, nếu xuất hiện | Shared global namespace, để giữ đúng tên bucket trong policy |
| Bucket name | `streamora-file-storage`, lần sau là `streamora-file-storage-output` |
| Object Ownership | ACLs disabled / Bucket owner enforced |
| Block Public Access settings | Giữ Block all public access bật |
| Bucket Versioning | Disable cho bucket mới của MVP |
| Default encryption | SSE-S3 / Amazon S3 managed keys |

Cuộn cuối form, chọn **Create bucket**. Với bucket đã có, giữ encryption và dữ liệu hiện tại; nếu đang dùng SSE-KMS, các role cần quyền KMS bổ sung.

**Kiểm tra:** hai bucket có trong danh sách, region Tokyo. Nếu báo tên đã tồn tại nhưng không thấy trong tài khoản, tên global đang thuộc tài khoản khác; không thể sử dụng chỉ bằng cách nhập tên. Nếu bucket output cũ có tên khác, tạo bucket mới theo tên dự án, giữ dữ liệu cũ khi còn tham chiếu.

Nguồn: [các tùy chọn tạo bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html).

### 1.2. CORS cho upload từ trình duyệt

1. Bấm **tên** `streamora-file-storage` trong danh sách.
2. Mở tab **Permissions**.
3. Cuộn đến **Cross-origin resource sharing (CORS)** → **Edit**.
4. Mở [source-cors.json](../infra/t13/source-cors.json), copy toàn bộ nội dung JSON, dán vào editor rồi chọn **Save changes**.
5. Kiểm tra `AllowedOrigins` khớp frontend: hiện là `https://18-138-205-52.sslip.io`, không thêm dấu `/` cuối.

Nếu đã có rule khác, thêm rule Streamora vào cùng mảng JSON thay vì ghi đè. Đây là editor CORS, không phải editor Bucket policy. Bucket output dùng response headers của CloudFront ở mục 6.

Nguồn: [vị trí CORS trong S3 Console](https://docs.aws.amazon.com/AmazonS3/latest/userguide/enabling-cors-examples.html).

## 2. DynamoDB — bảng và index

### 2.1. Tạo bảng

Mở [DynamoDB tại Tokyo](https://ap-northeast-1.console.aws.amazon.com/dynamodbv2/home?region=ap-northeast-1), chọn **Tables → Create table**.

| Trường | Giá trị |
| --- | --- |
| Table name | `streamora-video-jobs` |
| Partition key | `pk`, type String |
| Sort key | Bật thêm sort key nếu form yêu cầu; tên `sk`, type String |
| Table settings | Customize settings nếu cần để xem/chỉnh capacity |
| Table class | DynamoDB Standard |
| Read/write capacity mode | On-demand |

Chọn **Create table**; chờ **Status = Active**. Không cần thêm item bằng tay. Nếu bảng có sẵn, chỉ kiểm tra cấu hình và index; không xóa bảng để tạo lại.

Nguồn: [tạo bảng bằng Console](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/getting-started-step-1.html).

### 2.2. Tạo index phục vụ lịch Lambda

1. Trong **Tables**, bấm tên bảng → tab **Indexes**.
2. Tìm phần **Global secondary indexes** → **Create index**. Nếu index `work-due` đã có, mở để kiểm tra.
3. Điền:

| Trường | Giá trị |
| --- | --- |
| Partition key | `work`, type String |
| Sort key / Add sort key | `dueAt`, type Number |
| Index name | `work-due` — sửa tên tự điền nếu khác |
| Attribute projections / Projected attributes | All |
| Capacity | Theo chế độ On-demand của bảng |

Chọn **Create index**, chờ index **Active**. Tên và kiểu phân biệt chính xác: `dueAt` là Number, không phải String. GSI kế thừa capacity mode của bảng. [Cấu hình GSI](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.OnlineOps.html), [projection All](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Projection.html).

**Kiểm tra:** bảng có `pk/sk`; index có `work/dueAt`, projection All. Giữ Streams tắt, không bật TTL tự xóa job. PITR/deletion protection có thể bật thêm theo nhu cầu bảo vệ dữ liệu.

## 3. IAM — quyền cho encoder và Lambda

Mở [IAM Console](https://console.aws.amazon.com/iam/). Các JSON được liên kết bên dưới là file có sẵn trong repo: mở file và copy **nội dung**, không dán đường dẫn file vào AWS.

### 3.1. Role MediaConvert

Để không phụ thuộc danh sách use case của wizard, dùng custom trust:

1. **Roles → Create role → Custom trust policy**.
2. Thay nội dung editor bằng:

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

3. Chọn **Next**; trang permissions để trống, chọn **Next**.
4. **Role name**: `streamora-video-mediaconvert` → **Create role**.
5. Mở role vừa tạo → **Permissions → Add permissions → Create inline policy**.
6. Trong **Policy editor**, chọn **JSON**, dán [mediaconvert-policy.json](../infra/t13/mediaconvert-policy.json).
7. **Next** → policy name `streamora-video-storage` → **Create policy**.

Role đã có: dùng tab **Trust relationships → Edit trust policy** để kiểm tra trust; mở inline policy đang có để sửa nếu cần. Trust policy xác định dịch vụ được nhận role, còn permissions policy xác định quyền S3 — không dán hai loại vào cùng editor.

Nguồn: [service role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-service.html), [editor JSON](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_create-console.html).

### 3.2. Role Lambda

1. **Roles → Create role → AWS service**.
2. Trong **Service or use case**, chọn **Lambda**, rồi **Next**.
3. Tìm và chọn **AWSLambdaBasicExecutionRole** nếu wizard cho chọn policy.
4. **Next**, đặt role name `streamora-video-lambda` → **Create role**.
5. Mở role → **Permissions**. Nếu thiếu AWSLambdaBasicExecutionRole, dùng **Add permissions → Attach policies**, tìm đúng tên, chọn và thêm.
6. Tiếp tục **Add permissions → Create inline policy → JSON**, dán [lambda-policy.json](../infra/t13/lambda-policy.json).
7. **Next**, policy name `streamora-video-runtime` → **Create policy**.

**Kiểm tra:** role Lambda có quyền ghi Logs và inline policy runtime; role MediaConvert có policy storage. ARN của role encode phải là:

```text
arn:aws:iam::586481704097:role/streamora-video-mediaconvert
```

Nguồn: [thêm policy vào identity](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_manage-attach-detach.html).

### 3.3. MediaConvert — dùng Default

Mở [MediaConvert tại Tokyo](https://ap-northeast-1.console.aws.amazon.com/mediaconvert/home?region=ap-northeast-1), menu trái **Queues** → mở **Default**, kiểm tra queue không bị Paused. Không cần Create job, template, preset hoặc queue riêng. Lambda tạo cấu hình encode theo từng nguồn.

ARN mặc định mà code sử dụng:

```text
arn:aws:mediaconvert:ap-northeast-1:586481704097:queues/Default
```

Nguồn: [queue mặc định MediaConvert](https://docs.aws.amazon.com/mediaconvert/latest/ug/working-with-queues.html).

## 4. Lambda — Event Function và upload ZIP

### 4.1. Đóng gói trên máy phát triển

Tại thư mục root của repo, sau khi đã cài dependencies bằng `npm ci`, chạy:

```bash
npm run package:video-lambda
```

File kết quả: **backend/dist/video-lambda.zip**; bên trong có `index.cjs` ở gốc. Không nén thêm folder bọc ngoài hoặc upload toàn bộ repo.

### 4.2. Tạo function trên giao diện mới

Mở [Lambda tại Tokyo](https://ap-northeast-1.console.aws.amazon.com/lambda/home?region=ap-northeast-1).

1. Menu trái chọn **Event Functions** → **Create Event Function**. Nếu tài khoản còn nhãn cũ thì mục tương đương là **Functions → Create function**. Không chọn Web Functions.
2. Chọn **Author from scratch**.
3. **Function name**: `streamora-video-pipeline`.
4. **Runtime**: chọn **Node.js 22.x**, kể cả khi wizard mặc định Node.js 24.
5. **Architecture**: x86_64.
6. Mở **Permissions → Change default execution role** → **Use an existing role** → `streamora-video-lambda`.
7. Giữ các tùy chọn nâng cao mặc định, không gắn VPC; chọn **Create Event Function**.

Function đã có: bấm vào tên function và tiếp tục cập nhật dưới đây, không tạo thêm function.

### 4.3. Nạp code và chỉnh handler

1. Tab **Code**, trong **Code source**, chọn **Upload from → .zip file**.
2. **Upload** → chọn `backend/dist/video-lambda.zip` → **Open → Save**.
3. Vẫn ở tab **Code**, cuộn **xuống dưới editor** đến **Runtime settings** → **Edit**.
4. Đặt **Handler = index.handler**, giữ runtime Node.js 22.x và x86_64 → **Save**.

Nguồn cho mục 4.2–4.3: [Event Functions, upload ZIP và Runtime settings](https://docs.aws.amazon.com/lambda/latest/dg/configuration-function-zip.html).

### 4.4. Memory, timeout và biến môi trường

Trong tab **Configuration**:

| Menu bên trái | Thao tác |
| --- | --- |
| General configuration → Edit | Memory `512 MB`; Timeout `5 min 0 sec`; Save |
| Environment variables → Edit | Add environment variable: key `VIDEO_AWS_ACCOUNT_ID`, value `586481704097`; Save |
| Permissions | Kiểm tra Execution role là `streamora-video-lambda` |

Không đặt `AWS_REGION` hoặc access key vào env Lambda: region và credentials do runtime/execution role cấp. Mã hiện tại tự dùng Tokyo, hai bucket, bảng, role encode và queue Default ở trên; cap mặc định **2160p/4K**, không upscale nguồn. Các override nằm trong [video-config.ts](../src/modules/video-processing/video-config.ts).

Nếu cấu hình cũ còn `VIDEO_MAX_QUALITY=1080`, nó vẫn giới hạn 1080p; bỏ override hoặc đổi thành `2160` nếu muốn cap 4K. Với `VIDEO_MEDIACONVERT_QUEUE_ARN` cũ, đọc mục chuyển cấu hình trước khi bỏ.

Nguồn: [Memory](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html), [Timeout](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html), [Environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html).

### 4.5. Test bằng input đúng

1. Tab **Test** → trong **Test event**, chọn **Create new event**.
2. Name: `maintenance-check`; **Event sharing settings = Private**.
3. Thay toàn bộ JSON mẫu bằng:

```json
{"action":"maintenance"}
```

4. **Save** hoặc **Save changes**, rồi **Test**.
5. Mở **Execution result → Details**. Mong đợi response `{"ok":true}`; xem thêm **Monitor → View CloudWatch logs** nếu cần.

Code không nhận input `{}` hoặc mẫu Hello World. Kết quả `ok` xác nhận lượt chạy hoàn tất, chưa chứng minh video đã encode thành công; từng job vẫn cần kiểm tra status/Logs. Khi bảng có dữ liệu, test này thực sự xử lý job đến hạn và cleanup.

Nguồn: [Test tab và private event](https://docs.aws.amazon.com/lambda/latest/dg/testing-functions.html).

## 5. Scheduler — gọi Lambda mỗi phút

Mở thẳng [EventBridge Scheduler tại Tokyo](https://ap-northeast-1.console.aws.amazon.com/scheduler/home?region=ap-northeast-1). Nếu đi từ EventBridge, chọn **Scheduler → Schedules**, không vào Rules của event bus.

### 5.1. Specify schedule detail

**Schedules → Create schedule**, điền:

| Trường | Giá trị |
| --- | --- |
| Schedule name | `streamora-video-maintenance` |
| Schedule group | default |
| Occurrence | Recurring schedule |
| Schedule type/pattern | Rate-based schedule |
| Rate / Value + Unit | `1` + minute/minutes, tương đương `rate(1 minute)` |
| Flexible time window | Off |
| Timeframe | Không cần start/end date; giữ timezone mặc định cho rate này |

Chọn **Next**. Nếu lịch cùng tên đã có, chọn lịch → **Edit** và sửa cấu hình tương ứng.

### 5.2. Select target

1. Chọn **Templated targets**.
2. Tìm và chọn **AWS Lambda Invoke**.
3. Trong **Lambda function**, chọn `streamora-video-pipeline`. Nếu danh sách trống, kiểm tra region và function đã tạo.
4. Trong ô **Payload/Input**, nhập `{"action":"maintenance"}`. Không bọc thành chuỗi JSON có thêm dấu nháy bên ngoài.
5. **Next**.

### 5.3. Settings và review

Ở màn **Settings - optional** (Step 3), chọn đúng như sau:

| Phần trên màn hình | Lựa chọn cho MVP |
| --- | --- |
| Schedule state → Enable schedule | Bật, công tắc màu xanh |
| Action after schedule completion | NONE |
| Retry policy → Retry | Tắt |
| Dead-letter queue (DLQ) | None |
| Encryption → Customize encryption settings (advanced) | Không tích; dùng AWS-owned key mặc định |
| Permissions → Execution role | Create new role for this schedule |
| Role name | Giữ tên AWS tự sinh dạng Amazon_EventBridge_Scheduler_LAMBDA_…; không bắt buộc đổi |

Retry tắt nghĩa là Scheduler không gửi lại riêng lần gọi bị lỗi; lịch vẫn tiếp tục mỗi phút. Job đã lưu trong DynamoDB được lượt chạy sau lấy lại khi đến hạn/lease hết hạn. Với MVP này có thể giữ như vậy; nếu gặp lỗi cấp quyền kéo dài thì cần sửa quyền, không chỉ chờ tick sau.

Role tự sinh là role **của Scheduler trong tài khoản dịch vụ**, để gọi Lambda; không phải instance role của EC2. Nếu muốn tên dễ nhận biết, có thể đổi thành streamora-video-scheduler trước khi tạo. Role tên đó đã có và đúng quyền thì chọn **Use existing role**.

Bấm **Next** ở góc phải dưới → **Review and create schedule** (Step 4). Trước khi bấm **Create schedule**, kiểm tra:

- Rate expression: rate(1 minute), Flexible time window: Off.
- Target: Lambda streamora-video-pipeline ở ap-northeast-1.
- Input: `{"action":"maintenance"}`.
- State: Enabled; Action after completion: NONE; DLQ: None.

Ảnh Step 3 chỉ xác nhận được các tùy chọn Settings; tên target và input phải kiểm tra ở Review hoặc Step 2.

Nguồn cho các màn hình Scheduler: [tạo schedule trong Console](https://docs.aws.amazon.com/scheduler/latest/UserGuide/getting-started.html).

**Giao diện mới còn có đường dẫn ngắn:** trong Lambda, **Function overview → Add trigger → Scheduler**, có thể tìm bằng từ `schedule`. Form này có tên lịch, nhóm, recurring schedule, payload và lựa chọn tự tạo role. Chỉ dùng một trong hai cách để tránh hai lịch chạy trùng. [Luồng Add trigger mới](https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html).

**Kiểm tra:** trong Schedules, lịch Enabled, target đúng ARN Lambda, input đúng. Sau vài phút, tab Monitor của Lambda có invocations theo lịch và Logs mới. Flexible window Off vẫn không có nghĩa lịch chạy chính xác ở giây 00.

## 6. CloudFront — wizard mới và S3 origin

Mở [CloudFront Console](https://console.aws.amazon.com/cloudfront/v4/home). Nếu giữ distribution `d2etcjbg4sxx6m.cloudfront.net`, tìm theo domain rồi mở distribution; đi thẳng mục 6.2–6.3.

### 6.1. Tạo distribution mới

1. **Distributions → Create distribution**.
2. **Distribution name**: `streamora-video`; chọn **Single website or app** → **Next**.
3. Nếu có màn **Choose a plan/Pricing plan**, dùng **Pay-as-you-go** cho cấu hình trong hướng dẫn này; không tự nâng gói của distribution đang chạy. Vị trí bước plan có thể thay đổi. [Các mô hình giá hiện tại](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html).
4. **Domain setup**: bỏ qua custom domain, tiếp tục bằng domain CloudFront cấp.
5. **Specify origin**: loại **Amazon S3**; **Browse S3**, chọn `streamora-file-storage-output`. Để **Origin path** trống.
6. **Settings → Use recommended origin settings**, rồi **Next**.
7. **Enable security protections**: chưa cần bật WAF bổ sung cho MVP → **Next**.
8. Review → **Create distribution**.

Nguồn: [wizard standard distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-creating-console.html).

Với đường tạo S3 origin được AWS khuyến nghị, CloudFront thiết lập OAC và cập nhật bucket policy tự động khi quyền cho phép. Sau khi tạo, mở tab **General**, ghi lại **Distribution domain name**. Chờ **Last modified** hết chữ Deploying và distribution Enabled. [Hướng dẫn tạo S3 origin có OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GettingStarted.SimpleDistribution.html).

### 6.2. Distribution đã có hoặc OAC chưa được tự cấu hình

1. Mở distribution → tab **Origins** → chọn origin output → **Edit**.
2. Origin phải trỏ tới bucket `streamora-file-storage-output` dạng S3 REST origin, không phải S3 website endpoint.
3. Trong **Origin access**, chọn **Origin access control settings (recommended)**.
4. Chọn OAC đã có hoặc **Create new control**; tên `streamora-video-output`, chọn **Sign requests / Always** → tạo → **Save changes**.
5. Nếu Console yêu cầu cấp quyền bucket, chọn **Copy policy** tại phần S3 bucket access/thông báo tương ứng. Mở S3 bucket output → **Permissions → Bucket policy → Edit**; thêm statement CloudFront vào policy hiện có → **Save changes**.

Không ghi đè statement của dịch vụ khác. Nếu wizard đã thêm quyền đúng distribution ARN thì không cần dán lần nữa. Giữ S3 **Block Public Access bật**. [Cách cấp quyền S3 origin/OAC](https://repost.aws/knowledge-center/cloudfront-access-to-amazon-s3).

### 6.3. Sửa behavior để HLS công khai và có CORS

Tab **Behaviors** → chọn **Default (*)** → **Edit**:

| Trường | Giá trị |
| --- | --- |
| Origin / Origin and origin groups | Origin của bucket output |
| Viewer protocol policy | Redirect HTTP to HTTPS |
| Allowed HTTP methods | GET, HEAD |
| Restrict viewer access / signed URLs or cookies | No |
| Cache key and origin requests | Cache policy and origin request policy, nếu cần chọn kiểu |
| Cache policy | Managed-CachingOptimized / CachingOptimized |
| Origin request policy | Không cần thêm policy cho GET public này |
| Response headers policy — optional | Managed-SimpleCORS / SimpleCORS |

**Save changes**, chờ triển khai xong. Nếu không thấy Response headers policy trong wizard tạo mới, đây chính là chỗ chỉnh sau khi tạo. Nếu có behavior riêng `groups/*` khớp HLS trước Default, cấu hình tương tự cho behavior đó.

SimpleCORS thêm `Access-Control-Allow-Origin: *`; player hiện dùng request không gửi cookie với HLS public. Không cần tự tạo response headers policy. [Managed SimpleCORS](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-response-headers-policies.html).

Không cần API origin, media-grant behavior, key group, khóa ký hoặc Secrets Manager cho T13. Người có URL có thể xem playlist/segment mà không đăng nhập ứng dụng.

## 7. Quyền API và env — chỉ sửa trong tài khoản dịch vụ

### 7.1. Policy cho identity mà backend đang dùng

1. Trong IAM của tài khoản **586481704097**, mở **Users → streamora-developer** nếu đây là user sở hữu access key đặt trong backend/.env. Nếu backend dùng key của user khác trong cùng tài khoản, chọn đúng user sở hữu key.
2. **Permissions → Add permissions → Create inline policy → JSON**.
3. Dán [api-policy.json](../infra/t13/api-policy.json) → **Next**, tên `streamora-video-api` → **Create policy**.
4. Policy đã có thì mở để kiểm tra/sửa. Giữ quyền IVS/chat/các module khác.

Các bước IAM này không tác động tới tài khoản EC2. Code hiện tại dùng Scheduler nên policy API trong repo chỉ cần các quyền S3/DynamoDB đã liệt kê; không cần bổ sung quyền gọi Lambda trong lần cấu hình này. [Inline policy cho user/role](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_manage-attach-detach.html).

### 7.2. backend/.env trên máy đang chạy API

Giữ credentials hiện có nếu đúng streamora-developer. Điền hoặc cập nhật các biến sau, mỗi tên một dòng, không nối thêm bản trùng:

```dotenv
AWS_ACCESS_KEY_ID=<access key trong tài khoản dịch vụ>
AWS_SECRET_ACCESS_KEY=<secret tương ứng>
AWS_REGION=ap-northeast-1
FILES_STORAGE_DRIVER=s3
FILES_S3_BUCKET=streamora-file-storage
FILES_S3_REGION=ap-northeast-1
VIDEO_MODE=aws
VIDEO_WORKER_ENABLED=false
VIDEO_AWS_ACCOUNT_ID=586481704097
VIDEO_MEDIA_DOMAIN=d2etcjbg4sxx6m.cloudfront.net
```

Thay `VIDEO_MEDIA_DOMAIN` bằng domain ghi ở CloudFront, chỉ hostname, không có `https://` hoặc path. Hai bucket, bảng và queue Default đã có mặc định trong mã; nếu đang có override khác thì kiểm tra chúng trước khi bật pipeline. Mẫu tham khảo: [EC2 env](../infra/t13/ec2.env.example), [Lambda env](../infra/t13/lambda.env.example).

Giữ DATABASE_URL/auth và biến của các module khác. Chỉ đặt AWS_SESSION_TOKEN khi có credentials tạm thời hợp lệ. API đọc backend/.env khi khởi động; nếu PM2 giữ biến AWS cũ, cập nhật chúng cho khớp vì biến môi trường process ưu tiên hơn .env. Lambda dùng execution role riêng, không copy access key API lên Lambda.

Deploy frontend/API giữ nguyên:

```bash
npm ci
npm run build
pm2 restart streamora --update-env
pm2 restart streamora-api --update-env
pm2 save
```

Khi thay code Lambda, đóng gói và upload ZIP theo mục 4; restart PM2 không cập nhật code trên Lambda.

## 8. Chuyển từ cấu hình T13 cũ

1. Kiểm tra job đang encode trước khi đổi queue: chờ queue cũ xử lý xong hoặc giữ `VIDEO_MEDIACONVERT_QUEUE_ARN` trỏ queue cũ trong giai đoạn chuyển tiếp. Sau khi hết job cũ mới bỏ override để dùng Default. Không xóa job/queue đang dùng.
2. Upload ZIP Lambda theo luồng Scheduler mới, giữ bảng và dữ liệu.
3. Trong Lambda → **Configuration → Triggers**, tắt trigger DynamoDB cũ; EventBridge → event bus Rules, tắt `streamora-video-completion`. Chỉ tắt stream ở bảng khi không còn ứng dụng nào khác dùng.
4. Giữ **một** lịch maintenance mỗi phút. Lịch cũ có input `{"action":"maintenance"}` vẫn dùng được.
5. CloudFront bỏ yêu cầu signed URL/cookie trên behavior HLS, dùng SimpleCORS. Chỉ dọn origin/behavior API riêng của T13 nếu xác nhận không dùng cho chức năng khác.

## 9. Nghiệm thu — làm lần lượt

| Bước thử | Kết quả cần thấy |
| --- | --- |
| Test Lambda với input maintenance | Response ok; không có lỗi cấu hình/quyền trong Logs |
| Đợi Scheduler | Lịch Enabled, Lambda có invocation mới |
| Upload clip 10–30 giây qua ứng dụng | File nguồn có ở S3, trạng thái QUEUED |
| Đợi lịch Lambda | MediaConvert → Jobs có job mới, trạng thái chuyển PROCESSING |
| Encode hoàn tất và tick tiếp theo | Output HLS có ở bucket output, API báo READY |
| Player chọn Tự động | Playlist/segment tải qua CloudFront, phát được và đổi chất lượng |
| Copy URL master thật, mở cửa sổ ẩn danh | URL trả nội dung playlist hoặc tải file .m3u8; không cần cookie |

Không thử bằng cách mở mỗi domain CloudFront trống: MVP không có trang index. Việc trình duyệt tải file .m3u8 thay vì phát trực tiếp không chứng minh video lỗi. Để kiểm tra CORS, dùng player ứng dụng và tab Network, xem response request .m3u8 có Access-Control-Allow-Origin.

| Triệu chứng | Mở đúng chỗ để kiểm tra |
| --- | --- |
| Không thấy tài nguyên trong danh sách | Account ID, region Tokyo, bộ lọc tìm kiếm |
| Không thấy Runtime settings | Lambda → Code → cuộn xuống dưới Code source |
| HandlerNotFound / Cannot find module index | ZIP có index.cjs ở gốc; Handler index.handler |
| Lambda timeout sau vài giây | Configuration → General configuration, timeout 5 phút |
| VIDEO_EVENT_INVALID | Test event và Scheduler input phải là action maintenance |
| Lỗi index / QUEUED kéo dài | DynamoDB → Indexes: work-due Active, work String/dueAt Number |
| Lambda AccessDenied | Configuration → Permissions → mở execution role; kiểm tra runtime policy và PassRole |
| Scheduler không gọi được Lambda | Schedules → target/input/role; kiểm tra role được tạo cho schedule |
| MediaConvert ERROR | Jobs → mở job → error message; role encode, nguồn S3, encryption |
| Encode xong chưa READY | Tick kế tiếp, Lambda Logs; ok của một lượt chạy không đảm bảo tất cả job thành công |
| HLS 403 | Origins/OAC, bucket policy, đúng object key, Restrict viewer access = No |
| HLS lỗi CORS | Behavior thực sự khớp URL có SimpleCORS; frontend/API đã cập nhật bản public HLS |
