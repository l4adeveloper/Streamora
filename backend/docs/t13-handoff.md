# T13 — serverless video pipeline

AWS MVP dùng DynamoDB, một Lambda, MediaConvert Default queue và EventBridge Scheduler mỗi phút.
Output ở S3 private, được CloudFront phân phối công khai qua OAC.
Lambda không có Prisma/PostgreSQL, DB secret, VPC hoặc NAT. Gói Lambda được kiểm tra
để không chứa runtime Prisma/pg; chỉ có một handler bundle độc lập.

Tạo/cấu hình dịch vụ trong AWS Management Console theo [hướng dẫn triển khai](t13-aws-console.md).
Đóng gói ZIP bằng `npm run package:video-lambda`, upload vào Lambda rồi cấu hình env EC2.
Local vẫn dùng PostgreSQL/FFmpeg để phát triển. API trên EC2 tài khoản khác sử dụng credentials của streamora-developer trong backend/.env; Lambda sử dụng execution role riêng. Deploy API/frontend giữ npm ci → npm run build → restart hai process PM2 → pm2 save.

## Trách nhiệm và trạng thái

1. API hoàn tất upload/đăng ký bản ghi trong transaction metadata, tạo yêu cầu bàn giao
   và pin nguồn. Source được gắn vào storage đã đăng ký, không nhận URL tùy ý từ client.
2. Ngay sau commit, API gửi snapshot nguồn/job sang DynamoDB bằng transaction chống
   trùng. Khi AWS tạm lỗi, metadata và pin còn nguyên; relay bàn giao thử lại sau 15 giây
   hoặc restart. SQL chỉ giữ metadata/bàn giao và bản tương thích cho dữ liệu cũ.
3. Scheduler gọi Lambda mỗi phút. Lambda lấy job due từ GSI work-due, claim lease nguyên tử có owner/attempt fencing. Không dùng DynamoDB Streams hay rule completion.
4. Lambda Probe, chốt ladder, lưu SUBMITTING trước CreateJob rồi lưu providerJobId. MediaConvert dùng queue Default; Lambda không chờ encode.
5. Ở tick sau, Lambda dùng GetJob kiểm tra provider role/queue/nguồn/destination/ladder trước khi hoàn tất. Job lỗi không chặn các job tiếp theo.
6. Job SUBMITTING chưa rõ kết quả được reconcile, không submit lại mù: request token chỉ chống trùng trong một phút. Với tải nhỏ, bắt đầu xử lý và publish thường chờ thêm khoảng một tick; backlog/throttling/lỗi có thể kéo dài hơn.
7. Finalizer kiểm tra master/variant/segment/init/audio/ENDLIST/timeline, metadata thật
   và thumbnail. Publish READY cùng publishedJobId trong transaction DynamoDB có fence.
8. API đọc trạng thái/output từ DynamoDB, giữ quyền xem theo metadata/thành viên SQL.
   Đồng bộ terminal về SQL chỉ để tương thích/release pin; Lambda không gọi về API/DB.
9. Retry FAILED có quyền host/owner/admin và Idempotency-Key. Nguồn cũ vẫn được pin
   trước khi bàn giao retry; output đã publish trước đó được giữ khi lần mới lỗi.
10. Cleanup theo lô sau bảy ngày chỉ dọn job terminal chưa được publish hoặc đã xóa.
    Giữ output còn được HLS khác tham chiếu; marker cleanup ngăn import mới trong lúc
    dọn. Giữ toàn bộ cây của job đang publish. Không xóa nguồn IVS như output encode.

DynamoDB on-demand; PITR/deletion protection tùy nhu cầu triển khai. Không dùng TTL cho job đang publish. Scheduler phục hồi job còn due, không có SQS/DLQ. Theo dõi lỗi qua CloudWatch.
Sau khi job vào DynamoDB, EC2 ngừng hoạt động không ngăn MediaConvert/Lambda hoàn tất.
Khi API hoạt động lại, nó đọc kết quả DynamoDB và giải phóng pin metadata.

## Định dạng video và quyền phát

H.264/AAC SDR 8-bit, tối đa một video track/một audio track, 12 giờ và 30 FPS.
Segment khoảng bốn giây. Ladder 360/720/1080/2160 theo cap và nguồn, không upscale;
480/1440 tùy chọn. Video dọc đặt nhãn theo cạnh ngắn. Local scratch tối đa 8 GiB.
Progress null nếu chưa đo được, tối đa 99 khi đang xử lý, 100 khi READY.

CloudFront dùng OAC để đọc bucket private, nhưng HLS được công khai: bất kỳ ai có URL đều phát được playlist, segment và thumbnail, kể cả sau khi mất quyền ứng dụng. API vẫn kiểm tra quyền khi cung cấp metadata. Không cần khóa ký hoặc Secrets Manager. Thời hạn trong phản hồi giữ để tương thích; player không gia hạn hay gửi cookie khi phát HLS public. CloudFront dùng SimpleCORS có sẵn.

Bản ghi trình duyệt đi qua multipart hoàn tất. T11 cloud recording phải gọi
`FilesService.registerRecording` với mapping phiên ghi/nhóm/storage đã xác minh khi
nguồn AVAILABLE. HLS IVS STANDARD/ALL được kiểm tra/import, không encode lại.
Repo chưa có đầy đủ adapter cloud recording-ended T11 cho IVS STANDARD; Stage IVS
Real-Time không được tự biến thành Low-Latency Channel. DVR thuộc T12.

## File chính

Các file xử lý nằm ở `backend/src/modules/video-processing/`:

| File | Trách nhiệm |
| --- | --- |
| video-job-store.ts | Contract job store dùng chung; type Prisma chỉ dùng khi biên dịch |
| dynamodb-video-jobs.ts | Transaction/lease/publish/retry/recovery index/reference/cleanup của AWS |
| video-cloud-bridge.ts | Bàn giao metadata bền vững, đồng bộ terminal và pin nguồn |
| video-processing.service.ts | Enqueue, quyền API, retry, status và chọn nguồn trạng thái |
| video-jobs.service.ts | Adapter SQL cho local; API AWS không claim job bằng SQL |
| video-worker.ts | Các bước xử lý hữu hạn dùng chung; vòng lặp chỉ được bật ở local |
| managed-video-encoder.ts, mediaconvert-encoder.ts | Contract encoder và adapter AWS |
| video-storage.ts, video-finalizer.ts | Storage và kiểm tra HLS |
| video-delivery.ts, video-cdn.ts, cloudfront-video-cdn.ts | Cấp quyền và adapter CDN |
| backend/src/video.lambda.ts | Xử lý một tick Scheduler, không khởi động API/Nest app |

Storage identity thuần nằm ở `modules/files/storage-target.ts`, không kéo SQL vào
Lambda. Thay job store/encoder/storage/CDN qua adapter; GCS/CDN failover chưa cài.

## API

Prefix `/api/v1`:

| Endpoint | Quyền/hành vi |
| --- | --- |
| GET /files/:fileId/processing | Thành viên có quyền xem: status/progress/renditions/thumbnail/errorCode |
| POST /files/:fileId/processing/retry | Host/owner/admin, body {}, Idempotency-Key, trả 202 |
| GET /recordings/:recordingId/processing | Status theo file đã gắn bản ghi |
| POST /recordings/:recordingId/processing/retry | Cùng quyền/idempotency với file |

## Kiểm thử

```bash
npm run test:t13
npm run test:t13:lambda
npm run typecheck
```

`test:t13`: PostgreSQL nhúng tạm/FFmpeg thật, bảng DynamoDB Local riêng, mock managed
encode/S3, kiểm tra upload/bản ghi/retry/quyền xem, giao dịch DDB, lease, recovery,
retention và bàn giao khi AWS tạm lỗi. DynamoDB tests chỉ chấp nhận endpoint loopback;
không dùng account/table thật. `test:t13:lambda` giải nén ZIP bên ngoài repo, không
có node_modules hoặc DB credentials, xác minh handler hoạt động độc lập.
Cấu hình Console và IAM được kiểm tra theo checklist trong hướng dẫn triển khai.
Browser tùy chọn: `npm run test:t13:browser` (cần Edge/Chromium).
Các kiểm thử local không thay thế smoke test IAM/MediaConvert/CDN trên AWS thật.

Tham chiếu AWS: [Scheduler → Lambda](https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html), [queue mặc định](https://docs.aws.amazon.com/mediaconvert/latest/ug/working-with-queues.html), [request token](https://docs.aws.amazon.com/mediaconvert/latest/apireference/idempotency.html).
