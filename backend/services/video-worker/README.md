# Video worker — điểm tích hợp

Theo lựa chọn hiện tại, encode nhiều chất lượng sẽ chạy bằng dịch vụ AWS do nhóm thiết lập sau (ví dụ AWS Elemental MediaConvert).

Pipeline dự kiến: S3 nguồn → AWS encoder → HLS/renditions + thumbnail trên S3 → sự kiện hoàn tất → backend cập nhật trạng thái/output catalog. Replication GCS là bước độc lập của pipeline multi-cloud.

Payload `TranscodeJob` trong `backend/contracts` là scaffold cũ; adapter AWS/T13 sẽ cần hợp đồng jobId/outputVersion và xử lý sự kiện hoàn tất bền vững. Chưa có encoder, AWS job hoặc consumer chạy thực tế.
Player/Range local và điểm nối `VideoRenditionCatalog` đã có: xem [video preview local](../../docs/video-preview-local.md).
Khi triển khai: lưu output và trạng thái thành công trước khi ack sự kiện/queue, idempotency theo jobId/recordingId/outputVersion, retry có backoff và dead-letter queue.
DVR trực tiếp cần Egress/packager phát HLS rolling playlist trong lúc buổi học diễn ra; file MP4 sau cuộc gọi không đủ để triển khai tua lại trực tiếp.
