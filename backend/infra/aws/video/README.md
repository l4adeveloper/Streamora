# Triển khai AWS cho T13

`cloudformation.yaml` chuẩn bị hai queue dispatch/completion và hai DLQ,
MediaConvert queue/role, IVS STANDARD với recording ALL, S3 private, CloudFront
OAC/key group và IAM policy gắn vào role EC2/API/worker hiện có. Stack chưa deploy.

Tham số: SourceBucket hiện có; WebOrigin HTTPS chính xác; ApiDomain của backend;
RSA PublicKeyPem; SigningSecretArn đã tạo trong Secrets Manager. Secret JSON có
`{"keyPairId":"CloudFront public key ID","privateKey":"PEM"}`. Sau deploy, cập nhật
keyPairId từ output KeyPairId. Private key chỉ ở Secrets Manager, không ở frontend.

Điền env từ stack outputs, cùng region/account triển khai:

```dotenv
FILES_STORAGE_DRIVER=s3
FILES_S3_BUCKET=<SourceBucket>
FILES_S3_REGION=<region>
VIDEO_MODE=aws
VIDEO_AWS_ACCOUNT_ID=<12-digit-account>
VIDEO_MAX_QUALITY=2160
VIDEO_FFPROBE_PATH=ffprobe
VIDEO_DISPATCH_QUEUE_URL=<DispatchQueueUrl>
VIDEO_COMPLETION_QUEUE_URL=<CompletionQueueUrl>
VIDEO_OUTPUT_BUCKET=<OutputBucketName>
VIDEO_MEDIACONVERT_ROLE_ARN=<MediaConvertRoleArn>
VIDEO_MEDIACONVERT_QUEUE_ARN=<MediaConvertQueueArn>
VIDEO_MEDIA_DOMAIN=<MediaDomain-hostname>
VIDEO_SIGNING_SECRET_ARN=<SigningSecretArn>
```

Gắn WorkerPolicyArn vào role API/worker. MediaConvert role chỉ đọc source bucket,
ghi output bucket. Dùng IAM role. Nếu source SSE-KMS hoặc secret dùng CMK riêng,
bổ sung quyền đúng KMS key trước smoke test.

CloudFront route `/api/v1/files/*/media-grant` về API, chuyển Authorization/Origin,
không cache, không yêu cầu signed cookie. Frontend gọi endpoint này trên media
domain để cấp cookie HttpOnly đúng host/path. Playlist/segment/init/audio/thumbnail
dùng behavior S3 có TrustedKeyGroups/OAC; S3 trực tiếp private. CORS chỉ WebOrigin
có credentials. Browser chặn third-party cookie cần media custom domain cùng site
với web app và alias/ACM tương ứng; domain CloudFront mặc định chưa bảo đảm Safari.

Finalize list S3 có phân trang, đọc playlist và probe segment mẫu. Output giữ
storageLocationId trong policy/output snapshot. Đổi driver không di chuyển file cũ.
Preset CDN hiện ánh xạ OutputBucket; IVS phải ghi vào bucket đó. HLS ở bucket khác
cần cấu hình origin tương ứng trước khi import; worker từ chối mapping chưa có.

## Nghiệm thu sau deploy

- Upload 1080p/4K: MediaConvert COMPLETE có HLS/JPEG, processing READY, ít nhất hai
  mức khi nguồn đủ, không segment thiếu.
- T11 gắn đúng channel/phiên ghi; verify STANDARD/ALL bằng AWS; ingest đúng
  recording-ended/metadata, import mọi rendition thực và không encode lại.
- LIVE ABR và VOD ABR là hai ca riêng, thay đổi băng thông thực. Fixture local
  không chứng minh LIVE/DVR chạy.
- Không cookie: master/variant/segment/thumbnail 403; S3 trực tiếp 403. TTL 60 giây,
  thu hồi membership ngăn grant mới.
- Kill/restart worker giữa submit/commit/completion; event lặp/sớm; mất receipt:
  không submit trùng hoặc publish attempt cũ; dispatch chỉ ack sau READY commit.
- ERROR/CANCELED lưu FAILED, retry có quyền và redrive đúng DLQ. Native HLS cần
  thiết bị đích thực, kiểm tra Auto/manual/cookie renewal.

AWS smoke, IVS LIVE, CDN private thực và native HLS thiết bị đích chưa được
nghiệm thu trong phiên lập trình local.

Đối chiếu: [MediaConvert idempotency](https://docs.aws.amazon.com/mediaconvert/latest/apireference/idempotency.html),
[IVS auto-record](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/record-to-s3.html),
[IVS recording ALL](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ivs-recordingconfiguration-renditionconfiguration.html).
