# T13 video worker

Entry point: `backend/src/video.worker.ts`. API chỉ ghi metadata/job trong transaction;
worker riêng chạy FFmpeg local hoặc điều phối MediaConvert trên AWS.

## Local

1. Chạy `npm ci` ở root. Development có FFmpeg/ffprobe từ các gói installer;
   production dùng executable của hệ điều hành/deployment.
2. Áp migration bằng `npm run db:migrate` khi database đã được chuẩn bị.
3. Cấu hình `backend/.env`:

```dotenv
FILES_STORAGE_DRIVER=local
FILES_LOCAL_DIRECTORY=.local-storage/files
VIDEO_MODE=local
VIDEO_MAX_QUALITY=1080
VIDEO_SCRATCH_DIRECTORY=.local-storage/video-scratch
# Tùy chọn executable riêng (bỏ qua để dùng bản development đi kèm):
# VIDEO_FFMPEG_PATH=C:/tools/ffmpeg/bin/ffmpeg.exe
# VIDEO_FFPROBE_PATH=C:/tools/ffmpeg/bin/ffprobe.exe
# VIDEO_OPTIONAL_QUALITIES=480,1440
```

4. Chạy `npm run dev:api` và `npm run dev:video-worker` ở hai tiến trình.
   Upload video, theo dõi `GET /api/v1/files/:id/processing`, mở preview.
   Clip 4K cần `VIDEO_MAX_QUALITY=2160` và nguồn UHD thật.

Worker local: concurrency 1, heartbeat 1,5 giây, lease 30 giây, tối đa 3 attempt
phục hồi do worker chết, timeout encode 4 giờ, 2 thread/encoder. Scratch dự kiến
vượt 8 GiB bị từ chối. Output H.264/AAC tối đa 30 FPS, segment 4 giây; nguồn SDR
không audio vẫn hợp lệ. HDR/10-bit và nhiều audio track trả lỗi rõ.
Scratch bỏ lại do worker chết được dọn sau 24 giờ; quota tính cả scratch còn tồn.

API và worker dùng chung DB/storage. Grant HttpOnly chỉ cho một file/version,
tối đa 60 giây. Ưu tiên proxy cùng origin `/api/v1`; FILES_PUBLIC_BASE_URL phải
trỏ tới API/proxy browser truy cập được. Không đổi localhost ↔ 127.0.0.1 trong phiên.

`npm run test:t13` dùng PostgreSQL nhúng tạm, migration và FFmpeg thật, không đọc
DB ứng dụng. `npm run test:t13:browser` chạy player HLS thật trong Edge/Chromium.
Hồi quy cũ: `npm run test:video-preview`; đặt `TEST_DATABASE_MODE=embedded` để
không cần quyền CREATEDB trên server.

## AWS

Xem [triển khai AWS](../../infra/aws/video/README.md). Worker cần ffprobe;
encode chỉ chạy MediaConvert. Cùng chương trình có dispatcher, dispatch consumer,
completion consumer và reconcile; giới hạn 4 job MediaConvert in-flight.

Payload recording `video.finalize.v1`:

```json
{"jobId":"uuid","recordingId":"uuid","sourceObjectKey":"server-bound-key","outputVersion":"same-job-uuid","requestedAt":"ISO8601"}
```

Upload dùng `video.file.finalize.v1` với fileId, không giả recordingId. Nguồn
resolve từ DB, payload chỉ đối chiếu. Dispatch chỉ xóa receipt sau READY commit;
FAILED được redrive DLQ. Completion xác minh account/region, attempt, provider,
nguồn và destination trước finalize.

CreateJob không rõ kết quả giữ SUBMITTING và reconcile metadata/provider, không
tự submit lại ngoài cửa sổ idempotency. Lỗi đọc trạng thái không được coi là
provider đã dừng encode. Theo dõi cảnh báo SUBMISSION_UNCERTAIN và
PROVIDER_STATUS_UNCERTAIN; không xóa job để ép chạy lại.

Output cũ vẫn phát khi job mới xử lý/lỗi. Retention 7 ngày cho job transcode
terminal không còn publish (hoặc file đã xóa), bỏ qua prefix được nguồn HLS khác
tham chiếu. Import IVS không bị cleanup như output tự encode.

## Ranh giới T11

T11 gọi nội bộ `FilesService.registerRecording` khi recording hoàn tất, truyền
videoSource FILE/HLS và storageLocationId tin cậy. HLS có channelType STANDARD,
renditionSelection ALL, expectedHeights từ metadata IVS đã xác minh, prefix và
masterKey thật; MIME `application/vnd.apple.mpegurl`, không MP4 giả. Worker
import trực tiếp. Không có public endpoint nhận objectKey/URL tùy ý.

T11 cloud/composition hiện chưa có mapping channel → phiên ghi đầy đủ trong repo.
Boundary này không tự suy mapping từ event hoặc coi fixture local là IVS LIVE.
DVR thuộc T12; replication/failover thuộc T18.
