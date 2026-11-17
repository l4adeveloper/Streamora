# T14 — xem lại và cấp quyền phát

## Trạng thái

Code đang ở workspace, chưa deploy. CloudFront production vẫn public cho tới khi
kiểm tra backend cấp và phát URL ký thành công rồi mới bật trusted key group.
T18 (GCS, Cloud CDN, replication và resolver failover) chưa triển khai.

User đã chọn signed URLs thay signed cookies vì ứng dụng chạy qua sslip.io còn
CDN dùng domain cloudfront.net. API không thể đặt cookie cho domain CDN này.

## Luồng phát

- `/groups/:id/recordings`: danh sách bản ghi, phân trang, lọc status.
- `/recordings/:id`: chi tiết và đường gọi playback theo file.
- `/recordings/:id/progress`: GET/PUT vị trí theo user trong token, chặn cập nhật cũ.
- `/groups/:id/recordings` và `/recordings/:id` ở frontend dùng player hiện có.
- Backend đọc private key từ Secrets Manager (raw PEM), không gửi xuống frontend.
- Playlist đi qua API với cookie video_grant ngắn hạn. Mọi URI playlist con được
  viết lại về API; segment, init và thumbnail được ký riêng bằng RSA-SHA256.
- URL segment có thời hạn 15 phút; grant API 60 giây và player gia hạn qua API
  kiểm tra quyền. Quyền đã cấp không bị thu hồi ngay lập tức khi membership đổi.
- Frontend gửi cookie cho playlist API, bỏ credentials khi tải signed URL CDN.

## AWS đã chuẩn bị qua Console/CloudShell

- Distribution: E1G60I1P5X04F9, domain d1t5ktmqzfd56b.cloudfront.net.
- S3 output private, Block Public Access bật, OAC gắn với distribution.
- Secret mới: streamora/t14-cloudfront-signing, region ap-northeast-1.
- Public key mới: streamora-t14-video, ID K309R6IXKZS780.
- Key group mới: streamora-t14-video, chưa gắn distribution.
- IAM user streamora-developer có inline policy streamora-t14-signing-secret
  cho GetSecretValue trên secret mới.
- Secret cũ streamora/video-signing đã lộ một phần private key trong ảnh chat;
  không sử dụng. Việc rà consumer và thu hồi khóa cũ vẫn còn cần thực hiện.

## Deploy từng bước

1. Chuyển toàn bộ source và migration mới lên EC2 theo quy trình Git của nhóm.
2. Chạy npm ci, npm run build và npm run db:migrate ở gốc repo.
3. Thêm vào backend/.env, không đổi VIDEO_* hiện có:

```dotenv
VIDEO_CLOUDFRONT_KEY_PAIR_ID=K309R6IXKZS780
VIDEO_CLOUDFRONT_SIGNING_SECRET_ID=streamora/t14-cloudfront-signing
```

4. Restart streamora-api và streamora với --update-env rồi pm2 save.
5. Mở bản ghi thực tế: xác nhận playlist API, segment có Policy/Signature/
   Key-Pair-Id/Hash-Algorithm, thumbnail ký và gia hạn sau 60 giây.
6. Chỉ khi đường phát trên đạt mới bật Restrict viewer access và trusted key group
   streamora-t14-video trên Default (*), đợi CloudFront deploy xong.
7. Kiểm tra URL CDN không chữ ký trả 403; URL ký vẫn phát được, tua và đổi chất
   lượng giữ vị trí. Refresh khôi phục tiến độ; người ngoài group nhận 403.

User yêu cầu mỗi bước AWS phải đợi screenshot xác nhận trước khi sang bước mới.

## Kiểm thử

```bash
npx tsc --noEmit -p backend/tsconfig.json
npm run typecheck --workspace=@streamora/web
npx tsc -p backend/tsconfig.json
node --test --test-concurrency=1 backend/test/cloudfront-signed-hls.test.cjs backend/test/video-cdn.test.cjs backend/test/integration/recording-playback.test.cjs
node --test backend/test/frontend/video-pipeline-ui.test.cjs
```

Integration dùng database PGlite tạm, không đọc database thật. Browser test hiện
có kiểm tra HLS local; không thay thế nghiệm thu CloudFront trên môi trường đích.
Native HLS/Safari và đường phát private AWS cần nghiệm thu riêng trước khi coi
T14 hoàn tất.
