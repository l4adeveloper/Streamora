# Ghi hình cuộc họp: IVS → S3

Xem [hướng dẫn cấu hình trên AWS Management Console](recording-aws-console.md)
cho tài khoản dịch vụ có user streamora-developer và EC2 ở tài khoản khác.

Trình duyệt chỉ gửi lệnh bắt đầu/dừng. IVS ghép hình/tiếng rồi ghi HLS trực tiếp
vào S3. Backend kiểm tra định kỳ bằng API và marker S3; đóng tab không xóa phần
đã ghi. Trạng thái/lease nằm trong database để tiếp tục sau khi API khởi động lại.
Khi IVS đã hoàn tất và playlist đã đóng, backend ghép MP4 không mã hóa lại, lưu
vào S3 và mới tạo job chất lượng/phụ đề trong cùng transaction.

Chỉ phần thu bản ghi không phụ thuộc SQS/EventBridge. Các consumer SQS, rule và
quyền cũ giữ nguyên. Giữ cấu hình VIDEO_* hiện có; production tiếp tục dùng
MediaConvert/DynamoDB/CDN đang chạy. Không chuyển VIDEO_MODE sang local vì record.

FFmpeg ghép bản ghi được npm ci cài qua dependency ffmpeg-static, không cần cài
thủ công trên EC2. API production tự áp dụng migration trước khi nhận request.
Năm lệnh deploy vẫn là:

~~~bash
npm ci
npm run build
pm2 restart streamora --update-env
pm2 restart streamora-api --update-env
pm2 save
~~~

“Cập nhật chất lượng” trong player cho phép HOST/OWNER/ADMIN yêu cầu xử lý video
chưa có job, video lỗi hoặc xử lý lại video đã xong. Các request lặp dùng lại
job đang chạy; các chất lượng đã công bố vẫn phát được khi xử lý lại lỗi.

Giới hạn MVP: xuất một bản ghi một lúc trên mỗi API, tối đa 4 GiB dữ liệu HLS
cho một lần xuất MP4. Cần đủ đĩa tạm cho HLS + MP4; HLS gốc vẫn giữ trên S3 nếu
xuất hoặc xử lý lỗi. Chi phí IVS Composition và dịch vụ xử lý cũ vẫn áp dụng.

Script setup-recording.cjs vẫn có thể dùng như công cụ tùy chọn một lần;
không phải bước deploy và không cần chạy nếu đã tạo hai ARN trên Console.
