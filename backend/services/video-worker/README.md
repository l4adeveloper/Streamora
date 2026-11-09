# Video worker — điểm tích hợp

Pipeline dự kiến của T13: SQS → MediaConvert cho file LOCAL_RECORDING/MP4 →
HLS + thumbnail trên S3 → cập nhật trạng thái API. Bản ghi cloud dùng HLS do IVS
đã tạo; replication GCS do T18 quản lý.

Payload `TranscodeJob` trong `backend/contracts` là scaffold cũ; adapter AWS/T13 sẽ cần hợp đồng jobId/outputVersion và xử lý sự kiện hoàn tất bền vững. Chưa có encoder, AWS job hoặc consumer chạy thực tế.
Player/Range local và điểm nối `VideoRenditionCatalog` đã có: xem [video preview local](../../docs/video-preview-local.md).
Khi triển khai: lưu output và trạng thái thành công trước khi ack sự kiện/queue, idempotency theo jobId/recordingId/outputVersion, retry có backoff và dead-letter queue.
DVR trực tiếp cần POC T12 xác nhận IVS Channel ghi playlist/segment lên S3 kịp
trong lúc LIVE; file MP4 sau cuộc gọi không đủ để triển khai tua lại trực tiếp.
