# T13 — bàn giao video: EC2 + MediaConvert

API trên EC2 điều phối; MediaConvert encode HLS nhiều chất lượng; S3 lưu nguồn/output; DynamoDB lưu job; CloudFront phát công khai. Không dùng Lambda, Scheduler, SQS hoặc Docker cho pipeline video.

```text
Trình duyệt ──upload trực tiếp──> S3 nguồn
       └──> streamora-api trên EC2 ──> DynamoDB (job)
                        ├──> MediaConvert ──> S3 output ──> CloudFront public
                        └──> PostgreSQL (metadata, quyền, pin nguồn)
```

EC2 thuộc tài khoản AWS khác. Các dịch vụ thuộc tài khoản của **streamora-developer — 586481704097**, region **ap-northeast-1**. Backend dùng credentials tài khoản dịch vụ trong `backend/.env`; không đổi instance role EC2. PostgreSQL hiện có vẫn phục vụ ứng dụng, không tạo database SQL mới cho video.

## 1. Cấu hình và deploy

Làm một lần theo [hướng dẫn AWS Console](t13-aws-console.md), cập nhật [env EC2](../infra/t13/ec2.env.example). Đặc biệt đổi `VIDEO_WORKER_ENABLED=false` cũ thành `true`. Worker tự chạy trong **streamora-api**; không thêm process PM2, cron hoặc cổng inbound. MediaConvert Probe đọc metadata nên EC2 không cần cài FFmpeg/FFprobe cho T13 AWS.

Mỗi lần deploy, tại thư mục gốc repository:

```bash
npm ci
npm run build
pm2 restart streamora --update-env
pm2 restart streamora-api --update-env
pm2 save
```

Không có migration mới trong thay đổi này. Giữ database và bảng DynamoDB hiện có. Khi chuyển từ Lambda, tắt lịch/trigger cũ trước khi bật worker EC2 theo hướng dẫn Console.

## 2. Cách hoạt động

1. Upload hoàn tất: lưu metadata, job và pin nguồn trong cùng transaction SQL.
2. API bàn giao sang DynamoDB rồi đánh thức worker. Bàn giao lỗi được thử lại mỗi 15 giây và sau restart; nguồn vẫn được pin.
3. Worker nhận lease, dùng MediaConvert Probe kiểm tra nguồn, chọn ladder không upscale và gọi CreateJob.
4. Lưu providerJobId rồi trả lượt xử lý. Khoảng 10 giây sau, gọi GetJob; không giữ yêu cầu HTTP chờ encode. Khi rảnh worker dò job khoảng 1,5 giây/lần.
5. Encode xong: kiểm tra playlist/segment/metadata/thumbnail, publish READY trong DynamoDB. API đồng bộ về SQL và giải phóng pin nguồn.
6. Submission chưa rõ kết quả được đối soát với MediaConvert, không tự gửi lại mù. Lease/fencing cho phép phục hồi sau restart và ngăn lượt cũ ghi đè kết quả.
7. Khoảng 5 phút khi rảnh, worker kiểm tra output cũ: chỉ dọn cây job terminal đã qua 7 ngày, không còn publish/tham chiếu; giữ nguồn và video đang phát.

**Khi EC2/API dừng:** MediaConvert tiếp tục job đã nhận; việc gửi job mới, kiểm tra kết quả và chuyển READY chờ API chạy lại. Worker phục vụ tải nhỏ, không có autoscaling hoặc cam kết thời gian hoàn tất.

H.264/AAC SDR 8-bit, tối đa một video track/một audio track, 12 giờ và 30 FPS. Segment khoảng 4 giây; ladder mặc định gồm mức cao nhất của nguồn trong cap 2160p và các mức thấp hơn 2160/1440/1080/720/480/360p, không upscale. `VIDEO_OPTIONAL_QUALITIES` mặc định `480,1440`. Local vẫn có chế độ FFmpeg để phát triển.

Player lấy danh sách độ phân giải từ metadata đã publish, không chờ tải master playlist mới hiện menu. Giữ Bản gốc/Tự động và các mức cụ thể; đổi mức giữ vị trí và trạng thái phát. Lỗi tải/CORS được phân biệt với lỗi codec. Output cũ giữ nguyên danh sách đã encode, muốn bổ sung mức cần encode lại nguồn/upload lại.

Lượt sửa player 16/11/2026 đã kiểm tra: 23 ca FFmpeg/preview/worker, 16 ca adapter AWS/DynamoDB Local và một kịch bản browser HLS thật đều đạt; build toàn repository thành công. Browser test bao gồm menu trước khi master tải xong, đổi Bản gốc sang 480p, giữ vị trí/cài đặt, và phục hồi sau lỗi CDN thiếu CORS. Cấu hình CloudFront production cần áp dụng policy `streamora-video-public-cors` theo mục 5 của hướng dẫn Console; lượt này chỉ đọc AWS để chẩn đoán, không sửa tài nguyên.

CloudFront **public**, không signed URL/cookie hoặc khóa ký. Ai có URL đều phát được video và thumbnail, kể cả sau khi mất quyền ứng dụng. API vẫn kiểm tra thành viên khi cấp metadata. S3 giữ private, CloudFront đọc qua OAC.

## 3. Code và phần đã dọn

Các file trong `src/modules/video-processing/`:

| File | Vai trò |
| --- | --- |
| `video-processing-core.module.ts` | Chọn store/encoder và khởi tạo worker trong API |
| `video-worker.ts` | Nhận job, submit/poll, verify, publish, cleanup |
| `mediaconvert-encoder.ts` | Probe/CreateJob/GetJob và đối soát submission |
| `dynamodb-video-jobs.ts` | Job AWS, lease, fencing, publish, retention |
| `video-cloud-bridge.ts` | Bàn giao bền vững, đồng bộ SQL, pin nguồn |
| `video-processing.service.ts` | Enqueue, quyền, retry, trạng thái API |
| `video-jobs.service.ts`, `ffmpeg-encoder.ts` | Chế độ local |
| `video-storage.ts`, `video-finalizer.ts` | Storage và kiểm tra HLS |
| `video-delivery.ts`, `cloudfront-video-cdn.ts` | Phát local/CloudFront public |

Đã bỏ entrypoint Lambda, script ZIP, lệnh npm, env/policy/test riêng của Lambda và dependency đóng gói trực tiếp. Test adapter MediaConvert được giữ lại. Không đổi API/frontend hoặc schema để giữ các video/job hiện có.

Đã dọn thư mục CDK local, output CloudFormation, cấu hình triển khai và khóa ký CloudFront cũ. Không còn bước cài CDK/bootstrap/synth/deploy trên máy. Backend build tự xóa `dist` trước khi biên dịch để không giữ file Lambda hoặc module đã bị bỏ.

## 4. API và bản ghi

Prefix `/api/v1`:

| Endpoint | Hành vi |
| --- | --- |
| `GET /files/:fileId/processing` | Status, progress, renditions, thumbnail, errorCode |
| `POST /files/:fileId/processing/retry` | Host/owner/admin; body `{}`, Idempotency-Key; trả 202 |
| `GET /recordings/:recordingId/processing` | Trạng thái theo file bản ghi |
| `POST /recordings/:recordingId/processing/retry` | Quyền/idempotency như file |

Retry chỉ dành cho FAILED; giữ output đã publish khi lần mới lỗi. Bản ghi trình duyệt đi qua multipart. T11 phải gọi `FilesService.registerRecording` với nguồn AVAILABLE và mapping phiên/nhóm/storage đã xác minh. HLS IVS STANDARD/ALL được kiểm tra/import, không encode lại. Adapter cloud recording-ended T11 cho IVS STANDARD chưa đầy đủ; DVR thuộc T12.

## 5. Kiểm tra

```bash
npm run test:t13:local
npm run test:t13
npm run typecheck
npm run build
```

`test:t13:local` chạy FFmpeg/FFprobe thật và PostgreSQL nhúng tạm: encode HLS, nguồn dọc/4K, preview, retry và phục hồi worker. Không cần AWS, DynamoDB Local, PostgreSQL riêng hoặc Docker. Binary FFmpeg/FFprobe phục vụ test được cài qua `npm ci` thông thường, không bỏ devDependencies khi chạy test.

`test:t13` dùng PostgreSQL nhúng tạm, FFmpeg thật cho local, DynamoDB Local và mock MediaConvert/S3. DynamoDB tests chỉ chấp nhận endpoint loopback, không dùng bảng thật. Chạy DynamoDB Local bằng Java theo [hướng dẫn hiện có](workspace-chat-dynamodb-handoff.md), không cần Docker; mặc định cổng 8000, đổi bằng `VIDEO_TEST_DYNAMODB_ENDPOINT`. Browser tùy chọn: `npm run test:t13:browser`.

Test local không xác nhận IAM/encode/CDN trên AWS thật. Nghiệm thu theo checklist cuối [hướng dẫn Console](t13-aws-console.md).

Đã kiểm tra trong lượt thay đổi 16/11/2026: `test:t13` đạt 37/37; cấu hình/setup-env/preview đạt 12/12; `npm run typecheck` và `npm run build` toàn repository thành công. DynamoDB Local chạy bằng Java với dữ liệu tạm trong RAM, không dùng Docker hay tài nguyên AWS thật.

Sau khi dọn CDK/output cũ, `npm run test:t13:local` đạt 23/23 ca trên bản backend build sạch. DynamoDB video được giữ nguyên theo thiết kế EC2 hiện tại.
