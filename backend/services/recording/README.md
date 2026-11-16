# Ghi hình IVS → S3

Đã triển khai tại `src/modules/class-recordings`: backend gọi IVS Composition,
kiểm tra hoàn tất bằng polling và metadata S3, sau đó mới tạo job chất lượng/phụ đề.
Không cần SQS/EventBridge cho luồng ghi hình.

Xem [cấu hình MVP](../../docs/recording-mvp.md).
