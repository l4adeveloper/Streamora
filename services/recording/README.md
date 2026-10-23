# Recording — điểm tích hợp

LiveKit Egress nhận lệnh từ API sau khi kiểm tra quyền của thành viên. Room composite egress trộn âm thanh người nói và nội dung màn hình/camera; lưu kết quả đến S3. Webhook có xác thực tạo job hậu xử lý.

Chưa triển khai lệnh Egress, webhook, quyền ghi hình hay trộn Web Audio API. Không tạo secret/token trên frontend.

T04 đã có [điểm tích hợp cho T05/T11](../../backend/docs/t04-integration.md):
ClassParticipantService/RequireClassParticipation kiểm tra đúng lượt LIVE;
ClassSessionEventsService đọc `session.ended.v1` với checkpoint bền vững theo
consumer. T11 sẽ ghi job riêng cùng transaction/dedupe eventId rồi để worker làm
I/O; hiện chưa có handler ghi hình hoặc consumer chạy tự động. Không dùng sự kiện
Socket.IO `session.ended` làm lệnh Egress.
