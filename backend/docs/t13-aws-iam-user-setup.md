# T13: EC2 ở tài khoản khác, dịch vụ dùng streamora-developer

Đối chiếu ngày 14/11/2026. Đây là hướng dẫn theo cấu hình bạn đã xác nhận, thay cho phần tạo EC2/RDS mới trong hướng dẫn trước.

| Thành phần | Cấu hình dùng |
| --- | --- |
| Web/API hiện có | `18-138-205-52.sslip.io` |
| EC2 | Giữ máy và tài khoản EC2 hiện tại |
| Tài khoản tạo dịch vụ T13 | `586481704097` |
| Region T13 | `ap-northeast-1` (Tokyo), theo bucket đã xác nhận |
| IAM user ứng dụng | `streamora-developer` |
| S3 nguồn | `streamora-file-storage` |
| IVS, DynamoDB | Dùng các dịch vụ đang có; template dưới không tạo lại |

EC2 gọi AWS bằng access key của IAM user tài khoản 586481704097. Vì vậy không cần chuyển EC2 sang tài khoản đó hoặc thêm cross-account bucket policy chỉ vì máy EC2 thuộc tài khoản khác. Cả API và worker phải dùng đúng credentials của user này.

Tài liệu chỉ chuẩn bị cấu hình; chưa tạo hoặc nghiệm thu tài nguyên AWS trong tài khoản của bạn. MediaConvert, các tài nguyên mới và lưu lượng có thể phát sinh phí.

## 1. Chọn đúng tài khoản để tạo hạ tầng

Đăng nhập AWS Console của **586481704097**, chọn **Tokyo**.

Trong ảnh hiện có S3FullAccess, SQSFullAccess, IVSFullAccess và policy DynamoDB. Các policy đó chưa thể hiện quyền tạo CloudFormation, CloudFront, Secrets Manager, MediaConvert role hoặc gắn policy IAM. Dùng người/role có quyền triển khai các tài nguyên này để tạo stack một lần. Nếu streamora-developer chưa có quyền tạo, quản trị viên cần thực hiện bước tạo stack; không cần cấp AdministratorAccess lâu dài cho user chạy ứng dụng.

Template sẽ tự gắn một policy runtime bổ sung vào streamora-developer: tạo/đọc job MediaConvert, PassRole chỉ cho role encode vừa tạo, đọc secret ký, thao tác queue và output cần thiết. User không cần quyền quản trị CloudFront hay EventBridge để phát video sau khi cài.

MediaConvert vẫn cần service role riêng do AWS dịch vụ sử dụng. Đây không phải IAM user mới. Role và MediaConvert được tạo trong cùng tài khoản 586481704097. [AWS PassRole](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_passrole.html).

## 2. Kiểm tra HTTPS của ứng dụng hiện có

Chạy từ máy có thể truy cập web:

```bash
curl https://18-138-205-52.sslip.io/api/v1/health
```

Kỳ vọng HTTP 200, JSON có `status: ok`, không lỗi certificate. `sslip.io` cung cấp DNS, không tự cấp certificate HTTPS.

Nếu API đang chỉ mở qua cổng 4000, cần route `/api/v1/` qua Nginx HTTPS trên hostname trên. Template dùng origin API cổng 443. Không điền `https://`, `:4000` hay `/api/v1` vào tham số ApiDomain.

Tôi chưa xác minh được endpoint từ công cụ truy cập web; bạn cần kiểm tra bằng lệnh trên. [Yêu cầu TLS của CloudFront origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/http-502-bad-gateway.html).

## 3. Tạo khóa ký và Secrets Manager secret

Mở **CloudShell của tài khoản 586481704097**. Nếu trước đó đã tạo secret và cặp khóa theo hướng dẫn cũ, dùng lại đúng secret/cặp khóa đó, không tạo trùng.

Nếu chưa có, chạy khối sau trong CloudShell, không phải PowerShell Windows:

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
cat public_key.pem
```

Lưu **ARN secret** trả về và public key gồm các dòng BEGIN/END. Private key nằm trong secret và thư mục khóa được bảo vệ, không đưa vào frontend/repo/chat. Chưa phát video trước khi cập nhật KeyPairId ở bước 5.

## 4. Upload template đã chuẩn bị và tạo stack

File dùng cho cấu hình của bạn: **backend/infra/aws/video/cloudformation-iam-user.yaml**. Không dùng nhầm cloudformation.yaml cũ vì file cũ còn tạo IVS channel mới.

Vào **CloudFormation → Create stack → With new resources (standard) → Upload a template file**. Upload file trên, đặt stack name `streamora-t13-user`.

| Tham số | Điền |
| --- | --- |
| SourceBucket | `streamora-file-storage` |
| WebOrigin | `https://18-138-205-52.sslip.io` |
| ApiDomain | `18-138-205-52.sslip.io` |
| RuntimeUserName | `streamora-developer` |
| SigningSecretArn | ARN secret từ bước 3, thuộc tài khoản 586481704097/Tokyo |
| PublicKeyPem | Toàn bộ public key từ bước 3 |

Giữ PEM nguyên xuống dòng. Đọc phần resources, xác nhận tạo IAM resources và Submit. Đợi **CREATE_COMPLETE**.

Stack tạo S3 bucket output mới, SQS dispatch/completion kèm hai DLQ, MediaConvert queue/role, EventBridge, CloudFront private và policy gắn vào user hiện có. Bucket nguồn, EC2, PostgreSQL, IVS và DynamoDB hiện có không được stack quản lý lại.

Nếu CREATE_FAILED, mở tab Events, xem resource lỗi đầu tiên. Bị AccessDenied khi tạo stack là quyền triển khai, khác với quyền runtime mà stack tạo ở cuối.

## 5. Cập nhật secret bằng KeyPairId

Vào **stack → Outputs**, lấy `KeyPairId`. Đây là public key ID CloudFront, không phải key group ID hoặc EC2 key pair.

Trong CloudShell, điền giá trị đó khi lệnh hỏi:

```bash
cd ~/streamora-t13-keys
read -r -p 'Dán KeyPairId từ Outputs: ' T13_KEY_PAIR_ID
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

Trong **IAM → Users → streamora-developer → Permissions**, kiểm tra có policy mới trùng ARN trong output `WorkerPolicyArn`. Không cần tự thêm các policy FullAccess khác cho runtime.

## 6. Điền env trên EC2 hiện có

Giữ DATABASE_URL, ACCESS_TOKEN_SECRET, cấu hình IVS/DynamoDB và các giá trị đang chạy. Không chạy lại quy trình dựng EC2/database của hướng dẫn trước.

Giữ bộ access key đang hoạt động của **streamora-developer** trong môi trường backend/API/worker. Nếu dùng backend/.env thì giữ các dòng AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY hiện có. Không thay bằng credentials của tài khoản sở hữu EC2. AWS SDK có thể lấy credentials từ biến môi trường dù máy nằm ở tài khoản khác. [AWS SDK credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).

Chỉ thêm/cập nhật các cấu hình dưới đây, mỗi biến một lần. Dấu `<...>` phải được thay bằng Outputs thật:

```dotenv
WEB_ORIGIN=https://18-138-205-52.sslip.io
AUTH_COOKIE_SECURE=true
FILES_STORAGE_DRIVER=s3
FILES_S3_BUCKET=streamora-file-storage
FILES_S3_REGION=ap-northeast-1

VIDEO_MODE=aws
VIDEO_AWS_ACCOUNT_ID=586481704097
VIDEO_MAX_QUALITY=1080
VIDEO_FFPROBE_PATH=/usr/bin/ffprobe
VIDEO_DISPATCH_QUEUE_URL=<DispatchQueueUrl>
VIDEO_COMPLETION_QUEUE_URL=<CompletionQueueUrl>
VIDEO_OUTPUT_BUCKET=<OutputBucketName>
VIDEO_MEDIACONVERT_ROLE_ARN=<MediaConvertRoleArn>
VIDEO_MEDIACONVERT_QUEUE_ARN=<MediaConvertQueueArn>
VIDEO_MEDIA_DOMAIN=<MediaDomain>
VIDEO_SIGNING_SECRET_ARN=<ARN_SECRET_BUOC_3>
```

**VIDEO_AWS_ACCOUNT_ID là 586481704097, không phải account của EC2.** Region của T13 lấy từ FILES_S3_REGION. ARN role/queue/secret cũng phải cùng tài khoản và Tokyo.

MediaDomain dùng nguyên domain CloudFront trong Outputs, ví dụ `dxxxx.cloudfront.net`, không có https://. Không điền sslip.io vào VIDEO_MEDIA_DOMAIN: trong bản cấu hình này media được phục vụ bởi CloudFront, còn sslip.io là web/API.

Nếu process manager/systemd đã đặt các biến AWS ở ngoài .env, các biến đó có thể được ưu tiên; kiểm tra API và worker thực sự dùng cùng bộ key. Không tạo access key mới chỉ để thêm T13 nếu key cũ vẫn hợp lệ.

## 7. Chạy worker cùng ứng dụng

Trên EC2, kiểm tra `ffprobe -version`. Nếu dùng Ubuntu và chưa có ffprobe, cài `sudo apt install ffmpeg`, rồi kiểm tra đường dẫn bằng `command -v ffprobe` và điền đúng vào env. OS khác dùng bản ffprobe tương ứng.

Từ thư mục repo đã cập nhật code:

```bash
npm run build --workspace=@streamora/api
npm run db:status
```

Nếu còn migrations pending, backup database đang dùng trước rồi chạy `npm run db:migrate`. Lệnh áp mọi migration pending, không chỉ T13.

Restart API bằng PM2/systemd/cách quản lý ứng dụng hiện có. Chạy thử worker trong terminal khác:

```bash
node backend/dist/video.worker.js
```

Sau khi worker chạy được, thêm nó vào process manager đang dùng để tiếp tục chạy khi đóng SSH. Chỉ chạy API sẽ không xử lý video. API và worker cùng dùng database và credentials của streamora-developer.

Worker trên EC2 chỉ điều phối/probe; MediaConvert ở tài khoản 586481704097 encode video. Khi thay secret/env, restart API và worker để áp cấu hình mới.

## 8. Kiểm tra bằng một video mới

1. Mở web HTTPS, đăng nhập và upload MP4 1080p khoảng 30–60 giây qua thư viện.
2. Trong MediaConvert tại Tokyo/tài khoản 586481704097, phải thấy job mới và cuối cùng COMPLETE.
3. Trạng thái xử lý trong ứng dụng phải READY. Bucket output mới có HLS `.m3u8`, segment và thumbnail.
4. Mở preview, thử Auto/1080p/720p/360p theo nguồn, tua qua lại; xem quá 60 giây để kiểm tra gia hạn quyền.
5. Khi ổn, có thể đổi VIDEO_MAX_QUALITY=2160 để thử nguồn UHD thật.

Nếu upload báo CORS, vào **S3 → streamora-file-storage → Permissions → CORS**, thêm `https://18-138-205-52.sslip.io` vào AllowedOrigins của rule upload đang có; giữ PUT/GET/HEAD và ExposeHeaders ETag. Không xóa origin khác đang dùng.

## 9. Điểm cần biết khi dùng sslip.io với CloudFront mặc định

Không cần mua tên miền mới để thử bản cấu hình này: template dùng domain CloudFront mặc định. Nhưng web sslip.io và media cloudfront.net khác site; player hiện dùng signed cookie, nên trình duyệt chặn third-party cookies có thể làm media-grant/segment lỗi 403.

Để thử nghiệm, có thể cho phép third-party cookies riêng cho trang thử nghiệm trong trình duyệt có hỗ trợ ngoại lệ. Đây không phải cấu hình bảo đảm chạy trên mọi trình duyệt. Muốn phát ổn định mà không phụ thuộc ngoại lệ cookie, cần domain web/media cùng site do bạn kiểm soát hoặc bổ sung delivery proxy cùng origin vào code/Nginx. Bản code hiện chưa có cấu hình proxy đó bằng một biến env duy nhất. [MDN: third-party cookies](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies).

Không gắn sslip.io vào CloudFront hay đưa domain đó vào VIDEO_MEDIA_DOMAIN để chữa lỗi cookie: DNS hostname này hiện trỏ EC2 và chữ ký/cookie phải khớp hostname media.

## Tra lỗi nhanh

| Lỗi | Kiểm tra |
| --- | --- |
| Worker AccessDenied CreateJob | Policy WorkerPolicyArn có gắn user streamora-developer chưa |
| AccessDenied iam:PassRole | Role encode dùng ARN trong Outputs, cùng account 586481704097 |
| AccessDenied GetSecretValue | Đúng secret ARN, policy runtime; nếu CMK riêng cần quyền KMS phù hợp |
| Không có job MediaConvert | Worker có chạy không, đúng queue URL, đúng bộ credentials và region không |
| CloudFront media-grant 502 | HTTPS/certificate/Nginx route tới API qua hostname sslip.io |
| media-grant 401 | Authorization phải được forward tới API; template đã có behavior riêng |
| media-grant/segment 403 | Kiểm tra cookie bị browser chặn, KeyPairId/private key, key group, expiry |
| COMPLETE nhưng app chưa READY | Worker log, completion queue/EventBridge, ffprobe, quyền đọc output |

T13 upload VOD là phạm vi của template này. IVS hiện có vẫn cần mapping bản ghi → phiên học/file của T11 để bản ghi cloud xuất hiện tự động trong thư viện; không suy ra bước này đã xong chỉ vì IVS/S3 đã được tạo. Template không nối lại hoặc thay cấu hình ghi IVS hiện có.

Template đã được parse và kiểm tra cấu trúc/tham chiếu bằng test local; chưa được deploy/validate bằng CloudFormation trên tài khoản AWS thực.
