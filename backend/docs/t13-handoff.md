# T13 — Handoff và test local

## Phạm vi và cách chạy

T13 phục vụ preview nhiều chất lượng cho video thư viện/bản ghi. Căn cứ `Job.xlsx`,
tab `Phan_cong` (T13) và `API_backend` (T13-01…04): MediaConvert tạo HLS nhiều mức
và thumbnail cho MP4; IVS STANDARD cung cấp LIVE ABR và rendition recording sẵn có;
SQS có retry/DLQ và chống job trùng; output chỉ được quảng bá khi DB đã publish READY.

| | Local | AWS |
| --- | --- | --- |
| Encode/đọc metadata | FFmpeg/ffprobe đi kèm development | MediaConvert encode + Probe API |
| Hàng đợi | Job DB, vòng lặp tuần tự | SQS dispatch/completion + DLQ |
| Lưu/phát | Thư mục local, API media có cookie | S3 private, CloudFront OAC + signed cookie |
| Khởi động | Cùng API khi VIDEO_WORKER_ENABLED=true | Lambda nhận SQS và lịch EventBridge; EC2 đặt false |

AWS dùng **một Lambda ZIP** để dispatch/submit/verify/reconcile/cleanup, MediaConvert
mã hóa. EC2 giữ API/quyền xem và không chạy worker AWS. Local vẫn FFmpeg cùng API
như trước. Triển khai từ local bằng [AWS CDK](t13-cdk-local.md), hoặc tạo thủ công
theo [setup AWS Console](t13-aws-setup.md). Lambda dùng DB secret riêng và kết nối PostgreSQL hiện có, không
bắt buộc RDS. Lambda không đọc được .env EC2.

## Logic chính và tính năng giữ lại

1. Upload/bản ghi hoàn tất: transaction lưu file, source descriptor và VideoJob.
   Source lấy từ DB/storage đã đăng ký, không nhận URL/objectKey tùy ý từ client.
2. Worker claim lease có fencing theo owner/attempt, Probe nguồn, chốt policy.
   Nguồn đủ chất lượng có ladder 360/720/1080/2160 theo cap; 480/1440 là tùy chọn.
   Không upscale. Video dọc lấy cạnh ngắn để đặt nhãn; nguồn nhỏ giữ chất lượng thật.
3. AWS: lịch mỗi phút đọc job QUEUED trong DB → SQS → Lambda → MediaConvert; snapshot policy chứa output location; mỗi
   job/attempt có prefix riêng. Metadata và token theo jobId/attempt chống submit trùng.
   Chưa rõ kết quả CreateJob thì giữ SUBMITTING và reconcile, không submit lại mù.
4. Completion xác minh account/region/project/job/attempt. GetJob đối chiếu nguồn,
   destination và ladder. Lịch reconcile phục hồi nếu event chậm/mất hoặc Lambda cold start.
5. Finalizer kiểm tra master/variant, mọi segment/init/audio, ENDLIST/timeline,
   metadata mẫu của từng rendition và thumbnail nếu có. AWS dùng Probe, local dùng
   ffprobe. Chỉ commit READY sau khi output hợp lệ. Completion event chỉ được xác nhận sau trạng thái terminal bền vững.
6. Catalog trả chất lượng đã publish; vẫn phát output cũ khi job mới xử lý/lỗi.
   Progress là `null` nếu chưa đo được, tối đa 99 khi xử lý, 100 khi READY.
7. Grant kiểm tra quyền thành viên, cookie HttpOnly giới hạn file/version 60 giây;
   player tự gia hạn. AWS bảo vệ cả master/variant/segment/thumbnail bằng CloudFront.
8. FAILED chỉ retry qua API có quyền host/owner/admin và Idempotency-Key. Cleanup
   sau 7 ngày cho output attempt/job terminal không còn được publish; giữ output
   đang dùng và prefix được HLS khác tham chiếu. Không xóa nguồn IVS như output encode.

Giới hạn chủ ý: SDR 8-bit, một video track, tối đa một audio track, tối đa 12 giờ;
HDR/10-bit/nhiều audio trả lỗi rõ. Encode tối đa 30 FPS, H.264/AAC, segment khoảng
4 giây. Local chạy một encode, giới hạn scratch 8 GiB, dọn scratch mồ côi sau 24 giờ.
AWS giới hạn toàn hệ thống bốn job MediaConvert active bằng advisory lock DB,
độc lập số Lambda instance. Lambda không giữ vòng lặp chờ encode. Cleanup là tác vụ
theo lô có budget, không phải cam kết xóa chính xác sau 7 ngày; cần theo dõi backlog
khi dữ liệu lớn. Job local FFmpeg không được dispatcher AWS gửi sang Lambda.

## File và API cần biết

| Vị trí | Trách nhiệm |
| --- | --- |
| `src/modules/video-processing/video-config.ts` | Hai mode và kiểm tra env |
| `video-processing.service.ts` | API quyền truy cập, enqueue/retry/status |
| `video-jobs.service.ts` | State machine DB: claim/lease/publish/fail, dùng chung API và Lambda |
| `video-worker.ts` | Vòng lặp local; các bước Lambda hữu hạn: dispatch, message, maintenance |
| `video-lambda-handler.ts`, `src/video.lambda.ts` | Route event SQS/lịch, partial failures, DB secret và pool nhỏ |
| `mediaconvert-encoder.ts` | Probe managed, job settings, submit/GetJob/reconcile |
| `ffmpeg-encoder.ts`, `video-probe.ts`, `video-scratch.ts` | Encoder và tài nguyên local |
| `video-finalizer.ts`, `database-video-catalog.ts` | Kiểm tra HLS và catalog thật |
| `video-delivery.ts`, `video-storage.ts` | Grant local/private và đọc metadata/storage |
| `video-cdn.ts`, `cloudfront-video-cdn.ts` | Contract CDN + adapter signed cookie CloudFront |
| `src/video.worker.ts` | Entry point tùy chọn khi debug worker tách riêng |
| `frontend/src/components/files/video-preview.tsx` | Player và chọn Auto/manual |

Các file ngắn trong bảng thuộc `backend/src/modules/video-processing/`.

| API (prefix `/api/v1`) | Quyền/kết quả |
| --- | --- |
| GET `/files/:fileId/processing` | Thành viên có quyền xem; status/progress/renditions/thumbnailReady/errorCode |
| POST `/files/:fileId/processing/retry` | Host/owner/admin; body `{}`, header Idempotency-Key, trả 202 |
| GET `/recordings/:recordingId/processing` | T13-01; cùng logic file tương ứng |
| POST `/recordings/:recordingId/processing/retry` | T13-02; cùng logic retry |
| POST `/files/:fileId/media-grant` | Kiểm tra quyền, cấp cookie phát ngắn hạn |

Dispatch recording `video.finalize.v1`:

```json
{"jobId":"uuid","recordingId":"uuid","sourceObjectKey":"DB-bound-key","outputVersion":"same-job-uuid","requestedAt":"ISO8601"}
```

Upload dùng `video.file.finalize.v1` với `{type,jobId,fileId,requestedAt}`, không giả
recordingId. Nguồn vẫn đối chiếu DB; client không tự đẩy URL video vào pipeline.

**Thay đổi ACK khi chuyển Lambda:** dispatch được xác nhận sau submit/mapping đã
lưu bền vững, kể cả SUBMITTING chưa rõ kết quả; completion/reconcile tiếp tục từ DB.
Không giữ receipt/tiến trình Lambda suốt thời gian encode. Completion terminal chỉ
được ACK sau READY/FAILED; retry riêng từng message bằng ReportBatchItemFailures.
Lỗi encode nằm ở FAILED; lỗi hạ tầng/malformed event retry rồi DLQ. Khác hợp đồng
worker giữ dispatch đến READY trước đây, thay đổi này tránh Lambda timeout hoặc
đẩy nhầm video encode lâu vào DLQ. Scheduled maintenance là thành phần bắt buộc.

## Test tự động ở local

Yêu cầu Node.js 22.16+, npm 10+, chạy tại root repository:

```bash
npm ci
npm run test:t13
npm run test:t13:lambda
npm run test:t13:browser
```

`test:t13` build backend, chạy unit/managed AWS adapter bằng mock, sau đó chạy
integration với PostgreSQL tương thích nhúng tạm, migrations và FFmpeg thật.
Không đọc `.env` ứng dụng, không sửa DB/S3 thật, không gọi AWS. `test:t13:lambda`
đóng gói ZIP, giải nén ngoài repository và kiểm tra handler/Prisma WASM truy cập DB
nhúng mà không có node_modules. Integration kiểm tra
upload/recording → HLS → quyền xem/retry, source nhỏ/dọc, recover lease và output hỏng.
`test:t13:browser` dùng player HLS thật trong Edge/Chromium, kiểm tra Auto/manual và
giữ vị trí xem. Máy cần có Edge/Chromium tương thích với Playwright.

Hồi quy liên quan:

```bash
npm run test:video-preview
npm run typecheck
```

Một số test preview cũ có thể dùng PostgreSQL ngoài: đặt
`TEST_DATABASE_MODE=embedded` nếu muốn dùng DB nhúng. Local mock AWS không thay thế
smoke test IAM/EventBridge/MediaConvert/CloudFront thật trong tài liệu setup.

## Chạy ứng dụng và thử bằng tay

1. Chạy `npm run setup:env` nếu chưa có env. Chuẩn bị PostgreSQL development và
   `DATABASE_URL`, auth secret, cấu hình frontend theo README gốc. Nếu dùng chat,
   cần DynamoDB Local như hướng dẫn chat; test tự động T13 không cần service đó.
2. Điền các dòng sau trong **backend/.env**:

```dotenv
FILES_STORAGE_DRIVER=local
FILES_LOCAL_DIRECTORY=.local-storage/files
VIDEO_MODE=local
VIDEO_WORKER_ENABLED=true
VIDEO_MAX_QUALITY=1080
VIDEO_SCRATCH_DIRECTORY=.local-storage/video-scratch
```

Development tự dùng binary FFmpeg/ffprobe từ npm. Chỉ thêm
`VIDEO_FFMPEG_PATH`/`VIDEO_FFPROBE_PATH` khi cần binary riêng. Nếu chạy local với
`NODE_ENV=production`, phải cung cấp executable vì installer là dev dependency.

3. Sao lưu DB development nếu cần, chạy `npm run db:migrate`. Lệnh áp mọi migration
   pending; T13 mới không thêm schema so với bản T13 trước. Chạy hai terminal:

```bash
npm run dev:api
```

```bash
npm run dev
```

Backend đã có worker; không mở thêm `dev:video-worker`. Khi muốn debug riêng, đặt
`VIDEO_WORKER_ENABLED=false` cho API rồi chạy `npm run dev:video-worker` dùng cùng
DB/storage. Không chạy hai chế độ đồng thời.

4. Đăng nhập, vào group có quyền upload, upload clip MP4 1080p SDR ngắn và mở
   preview. Theo dõi QUEUED → PROCESSING → READY. Clip 16:9 1080p có 1080/720/360;
   thử 720p, video dọc, nguồn nhỏ, không audio. Để thử 4K, đặt cap 2160 và dùng UHD thật.
5. Thử Auto và chuyển chất lượng thủ công khi đang phát: giữ thời gian xem, tua,
   pause/resume, thumbnail. Xem quá 60 giây để kiểm tra gia hạn cookie. Dùng cùng
   hostname xuyên suốt (không đổi `localhost` và `127.0.0.1`); ưu tiên proxy `/api/v1`
   cùng origin. Nếu cấu hình `FILES_PUBLIC_BASE_URL`, phải là URL API mà browser đọc được.
6. Upload file hỏng có MIME video: FAILED có errorCode. Retry bằng tài khoản được
   phép, lặp cùng Idempotency-Key không tạo hai job. User ngoài group bị 403.
7. Dừng/restart API giữa encode và kiểm tra lease phục hồi, không publish output dở
   hoặc attempt cũ. Output publish trước đó vẫn phát được nếu lần xử lý mới thất bại.

Player hỗ trợ play/pause, seek, volume, fullscreen, playbackRate và phím tắt:
Space/K, ←/→, J/L, M, F. Bản gốc vẫn dùng `POST /files/:fileId/playback` có Bearer;
API local phục vụ stream GET/HEAD với Range/206/416 và grant ngắn hạn. Khi chưa
có HLS READY, giao diện chỉ quảng bá bản gốc; có HLS thì Auto/manual lấy các level
thật từ manifest. Presigned URL master đơn lẻ không thay thế quyền cho segment.

## Ranh giới IVS và trạng thái bàn giao

T11 gọi nội bộ `FilesService.registerRecording` khi nguồn đã hoàn tất và mapping
channel → phiên ghi đã xác minh. FILE chứa storageLocationId/key đã đăng ký;
HLS phải có prefix/masterKey thật, `channelType=STANDARD`, `renditionSelection=ALL`
và expectedHeights từ metadata tin cậy. T13 kiểm tra mọi rendition rồi import trực
tiếp, không encode lại. HLS S3 phải nằm trong output bucket đã gắn CloudFront.

Repo chưa có đầy đủ mapping cloud recording-ended T11 cho IVS STANDARD. T13 không
tự biến IVS Real-Time Stage thành Low-Latency Channel, và fixture local không chứng
minh LIVE ABR. DVR thuộc T12; GCS/CDN failover thuộc T18. Cần nghiệm thu LIVE/VOD ABR,
IAM/CDN private và native HLS trên thiết bị thật sau khi cấu hình AWS.

Đã bỏ ba template CloudFormation, Lambda custom resource chỉ dùng lúc setup, test
của các template và các tài liệu setup trùng nhau. FFmpeg local, schema/migration,
contracts, player, API và kiểm tra output được giữ vì vẫn phục vụ tính năng/test.

## Điểm mở rộng CDN và cách cập nhật Lambda

CloudFront giữ cấu hình tối thiểu: output S3 private qua OAC, một trusted key group,
một behavior API cấp cookie. Public key/key group cần để xác minh người xem; OAC
không thay thế quyền xem. Không thêm Lambda@Edge hay làm video public cho nhẹ setup.

VideoDelivery chọn provider hỗ trợ storage đã đăng ký. CloudFrontVideoCdn là adapter
mặc định; danh sách có thể cung cấp qua token VIDEO_CDN_PROVIDERS trong module.
Provider cấp assetUrl(key) để catalog không tự ghép domain/query/cơ chế ký của CDN.
Khi có CDN thứ hai: thêm adapter, binding storage/replica READY và chiến lược chọn
nguồn thật. Storage GCS và failover chưa được cài; chưa quảng bá replica chưa đủ file.

Đổi code Lambda: chạy `npm run package:video-lambda`, kiểm tra
`backend/dist/video-lambda.zip`, upload lại Console, handler `index.handler`.
Đổi cap quality trên Lambda env; API EC2 chỉ cần output bucket/media domain/signing
secret và `VIDEO_WORKER_ENABLED=false`. Local giữ true. Không thêm migration T13
mới cho lần chuyển đổi Lambda này.

Kiểm tra local ngày 15/11/2026: `test:t13` qua 29 test; `test:t13:lambda` qua 9 test
(gồm giải nén ZIP và truy cập DB tạm); HLS browser qua 1 test, preview hồi quy qua
4 test, environment/setup-env qua 9 test; typecheck toàn workspace thành công.
Chưa tạo/nghiệm thu tài nguyên AWS thật từ phiên làm việc này.
