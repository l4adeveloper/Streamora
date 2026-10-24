# Video worker — điểm tích hợp

Pipeline dự kiến: RabbitMQ → tải bản ghi từ S3 → FFmpeg → HLS 720p/1080p + thumbnail → upload S3 → replicate GCS → cập nhật trạng thái API.

Payload dùng `TranscodeJob` trong `backend/contracts`. Chưa có consumer hoặc FFmpeg chạy thực tế.
Khi triển khai: ack sau khi lưu kết quả, idempotency theo recordingId, retry có backoff và dead-letter queue.
DVR trực tiếp cần Egress/packager phát HLS rolling playlist trong lúc buổi học diễn ra; file MP4 sau cuộc gọi không đủ để triển khai tua lại trực tiếp.
