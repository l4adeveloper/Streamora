# Recording — điểm tích hợp

T11 sẽ dùng IVS server-side composition sau khi kiểm tra quyền của thành viên.
Composition trộn âm thanh và nội dung màn hình/camera từ Stage T05, lưu kết quả
đến S3. Sự kiện composition/recording đi qua EventBridge → SQS của T05.

Chưa triển khai StartComposition/StopComposition hoặc handler ghi hình.
Web Audio API cho ghi cục bộ thuộc T10. Thông tin xác thực AWS chỉ ở backend.

T04 đã có [điểm tích hợp cho T05/T11](../../docs/t04-integration.md):
ClassParticipantService/RequireClassParticipation kiểm tra đúng lượt LIVE;
ClassSessionEventsService đọc `session.ended.v1` với checkpoint bền vững theo
consumer. T11 sẽ ghi job riêng cùng transaction/dedupe eventId rồi để worker làm
I/O; hiện chưa có handler ghi hình hoặc consumer chạy tự động. Không dùng sự kiện
Socket.IO `session.ended` làm lệnh dừng composition.
