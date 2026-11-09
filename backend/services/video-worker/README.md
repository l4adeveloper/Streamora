# Video worker — điểm tích hợp

Pipeline dự kiến của T13: SQS → MediaConvert cho file LOCAL_RECORDING/MP4 →
HLS + thumbnail trên S3 → cập nhật trạng thái API. Bản ghi cloud dùng HLS do IVS
đã tạo; replication GCS do T18 quản lý.

Hợp đồng job `video.finalize.v1` cần được thống nhất với T11 trong contracts.
Chưa có consumer hoặc MediaConvert chạy thực tế.
Khi triển khai: ack sau khi lưu kết quả, idempotency theo recordingId, retry có backoff và dead-letter queue.
DVR trực tiếp cần POC T12 xác nhận IVS Channel ghi playlist/segment lên S3 kịp
trong lúc LIVE; file MP4 sau cuộc gọi không đủ để triển khai tua lại trực tiếp.
