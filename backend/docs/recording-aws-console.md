# Cấu hình ghi hình: làm lần lượt 7 bước

**Cấu hình AWS một lần ở bước 1–5. Khi cập nhật code sau này, dùng bước 6.**

## Bước 1 — Đăng nhập đúng tài khoản

Mở AWS Management Console bằng tài khoản có quyền quản trị dịch vụ, rồi kiểm tra:

| Mục | Giá trị |
| --- | --- |
| Account ID | `586481704097` — tài khoản dịch vụ có user `streamora-developer` |
| Region | **Tokyo — ap-northeast-1** |
| Bucket đang dùng | `streamora-file-storage` |

EC2 vẫn ở tài khoản khác như hiện tại. Giữ access key của `streamora-developer`
trên EC2; không thay bằng key của tài khoản EC2.

## Bước 2 — Kiểm tra S3

Mở **S3 → General purpose buckets → streamora-file-storage**.

1. Trong **Properties**, kiểm tra Region là **ap-northeast-1**.
2. Trong **Permissions**, giữ **Block all public access** bật; **Object Ownership**
   là **Bucket owner enforced** hoặc **Bucket owner preferred**.
3. Trong **Properties → Default encryption**, kiểm tra đang dùng **SSE-S3**.
   Nếu đang dùng KMS, cần quản trị viên kiểm tra quyền KMS trước khi tiếp tục;
   không tự đổi cấu hình mã hóa của bucket đang dùng.

Giữ nguyên CORS, bucket policy và các dịch vụ cũ. IVS sẽ bổ sung quyền ghi vào
bucket khi tạo cấu hình ở bước 3.

## Bước 3 — Tạo cấu hình IVS và lấy hai ARN

Trên thanh công cụ Console, bấm **CloudShell** và chọn **Bash**.
Không cần cài AWS CLI trên EC2.

**Copy toàn bộ khối dưới đây, dán vào CloudShell rồi Enter.** Khối lệnh tự dùng lại
cấu hình có sẵn; nếu chưa có thì tạo mới.

```bash
set -eo pipefail

recording_account=$(aws sts get-caller-identity --query Account --output text)
if [ "$recording_account" != "586481704097" ]; then
  echo "Sai tài khoản. Hãy đăng nhập tài khoản dịch vụ 586481704097 rồi chạy lại."
else
  recording_storage=$(aws ivs-realtime list-storage-configurations \
    --region ap-northeast-1 \
    --query "storageConfigurations[?s3.bucketName=='streamora-file-storage'].arn | [0]" \
    --output json | tr -d '"')
  if [ "$recording_storage" = "null" ]; then
    recording_storage=$(aws ivs-realtime create-storage-configuration \
      --region ap-northeast-1 --name streamora-recordings \
      --s3 bucketName=streamora-file-storage \
      --query storageConfiguration.arn --output text)
  fi

  recording_encoder=$(aws ivs-realtime list-encoder-configurations \
    --region ap-northeast-1 \
    --query "encoderConfigurations[?name=='streamora-recording-1080p-v1'].arn | [0]" \
    --output json | tr -d '"')
  if [ "$recording_encoder" = "null" ]; then
    recording_encoder=$(aws ivs-realtime create-encoder-configuration \
      --region ap-northeast-1 --name streamora-recording-1080p-v1 \
      --video width=1920,height=1080,framerate=30,bitrate=4000000 \
      --query encoderConfiguration.arn --output text)
  fi

  printf '\nIVS_RECORDING_STORAGE_ARN=%s\nIVS_RECORDING_ENCODER_ARN=%s\n' \
    "$recording_storage" "$recording_encoder"
fi
```

**Kết quả cần có:** hai dòng bắt đầu bằng `IVS_RECORDING_STORAGE_ARN=` và
`IVS_RECORDING_ENCODER_ARN=`. Copy hai dòng này vào ghi chú để dùng ở bước 5.
Nếu có lỗi hoặc không có đủ hai dòng, xử lý lỗi trước khi tiếp tục.

## Bước 4 — Thêm quyền cho streamora-developer

1. Mở **IAM → Users → streamora-developer → Permissions**.
2. Chọn **Add permissions → Create inline policy → JSON**.
3. Mở [file policy recording](../infra/recording/api-policy.json), copy **toàn bộ
   nội dung JSON** và dán vào ô JSON trên Console.
4. Chọn **Next**, điền tên `StreamoraMeetingRecording`, rồi **Create policy**.

Đây là policy bổ sung. Giữ nguyên các policy và queue SQS/EventBridge đang có.
Nếu đã có policy cùng tên, mở policy đó và cập nhật nội dung thay vì tạo trùng.

## Bước 5 — Thêm hai biến vào backend/.env trên EC2

Mở `backend/.env` trên EC2 và **dán hai dòng ARN nhận được ở bước 3**.
Nếu hai biến đã có, thay giá trị cũ; mỗi biến chỉ giữ một dòng.

Kiểm tra `NODE_ENV=production` và `IVS_ENABLED=true`.
Giữ nguyên các phần sau:

- `AWS_ACCESS_KEY_ID` và `AWS_SECRET_ACCESS_KEY` của `streamora-developer`.
- `AWS_REGION=ap-northeast-1`, bucket `streamora-file-storage` và region S3 tương ứng.
- Toàn bộ `VIDEO_*`, gồm `VIDEO_MODE=aws` và worker xử lý video đang dùng.
- `IVS_EVENTS_QUEUE_URL`, `IVS_WORKER_ENABLED`, Azure Speech, database và auth.

Nếu hai ARN đã được khai báo trong shell hoặc cấu hình PM2, cập nhật cả tại đó:
biến môi trường process được ưu tiên hơn `.env`.

## Bước 6 — Deploy bằng đúng các lệnh đang dùng

Trên EC2, tại thư mục gốc dự án, chạy lần lượt:

```bash
npm ci
npm run build
pm2 restart streamora --update-env
pm2 restart streamora-api --update-env
pm2 save
```

Không cần thêm process PM2 hoặc cài FFmpeg thủ công. API production tự áp dụng
migration khi khởi động; user database cần có quyền chạy migration.

## Bước 7 — Kiểm tra ghi hình

1. Chạy `pm2 logs streamora-api`. Kiểm tra có dòng
   **“Đã kiểm tra và áp dụng database migrations.”** và API khởi động thành công.
2. Vào một buổi học thuộc nhóm bằng tài khoản quản lý. Bật mic/camera hoặc chia sẻ
   màn hình, rồi bấm **Ghi hình**.
3. Mở **S3 → streamora-file-storage → Objects**. Kiểm tra có dữ liệu video mới.
4. Đóng tab người bấm ghi. Nếu còn người phát, video tiếp tục được ghi. Nếu tất cả
   ngừng phát, IVS tự hoàn tất sau khoảng 60 giây.
5. Mở lại cuộc họp và bấm **Dừng ghi hình** nếu bản ghi còn chạy. Chờ bản ghi xuất
   hiện trong thư viện; sau đó mới bắt đầu xử lý chất lượng và phụ đề.
6. Mở một video cũ → **Cài đặt → Cập nhật chất lượng** để kiểm tra xử lý thủ công.

**Hoàn tất khi:** bản ghi vẫn còn sau khi đóng tab, xuất hiện trong thư viện và
có các chất lượng/phụ đề sau xử lý. Phụ đề cần cấu hình Azure Speech hiện có.

### Nếu gặp lỗi

| Lỗi | Việc cần kiểm tra |
| --- | --- |
| `AccessDenied` trong CloudShell | Dùng identity có quyền tạo cấu hình IVS và sửa bucket policy trong tài khoản dịch vụ |
| `AccessDenied` khi bấm ghi | Làm lại bước 4; kiểm tra EC2 dùng đúng key của `streamora-developer` |
| Không thấy nút ghi | Kiểm tra tài khoản có quyền quản lý phòng |
| Bấm ghi nhưng chưa bắt đầu | Hai ARN ở bước 5, kết nối IVS và buổi học thuộc nhóm |
| Bản ghi chưa vào thư viện | Log API, quyền đọc/ghi S3 và dung lượng đĩa tạm trên EC2 |
| API không lên sau deploy | Log migration, kết nối và quyền database |

Bản MVP xuất MP4 tối đa **4 GiB HLS/bản ghi**; HLS gốc vẫn giữ trên S3 nếu xuất
lỗi. Có phí IVS Composition, S3 và xử lý video hiện tại.

Tham khảo: [IVS ghi vào S3](https://docs.aws.amazon.com/ivs/latest/RealTimeUserGuide/rt-composite-recording.html),
[CloudShell trên Console](https://docs.aws.amazon.com/cloudshell/latest/userguide/getting-started.html).
