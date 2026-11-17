# Kiến trúc đa cloud: AWS + Azure + Google Cloud

Tài liệu mô tả kiến trúc đích khi Streamora chạy trên ba nhà cung cấp, khớp với bản chia
việc `Job_kien_truc_moi.xlsx` (tab Phan_cong, task T01–T24). Mỗi cloud giữ một phần riêng:

- **AWS:** lõi hệ thống: web/API, database, video (IVS), lưu trữ, hàng đợi, giám sát.
- **Azure:** kết nối realtime (Web PubSub for Socket.IO), kiểm duyệt nội dung, phụ đề.
- **Google Cloud:** nguồn phát dự phòng (GCS + Cloud CDN), tóm tắt bằng Gemini, đăng nhập Google.

Không cloud nào chạy trùng vai trò của cloud khác.

Hiện trạng: T01–T04 và chat realtime (T08) đã xong trên NestJS + PostgreSQL + Socket.IO.
Code chưa dùng SDK của cloud nào; media vẫn là `livekit-server-sdk`
(`src/modules/memberships/membership-media.service.ts`). Dự án không dùng Docker.

## Sơ đồ tổng quan

```text
Người dùng (trình duyệt)
   │  HTTPS                 │ WebRTC                 │ Socket.IO
   ▼                        ▼                        ▼
┌────────────────── AWS — lõi hệ thống ──────────────────┐   ┌──── Azure ────────────────────┐
│ ALB + EC2 Auto Scaling: Next.js, NestJS API, worker    │◄─►│ Web PubSub for Socket.IO      │
│ RDS PostgreSQL         Secrets Manager, CloudWatch     │   │ AI Content Safety (chat, ảnh) │
│ IVS Real-Time (stage) ─► composition ─► IVS Channel    │   │ AI Speech (phụ đề vi-VN)      │
│ S3 (bản ghi, HLS, tài liệu) ─► CloudFront (CDN chính)  │   └───────────────────────────────┘
│ EventBridge ─► SQS ─► worker ─► MediaConvert           │
│ AWS WAF trên ALB/CloudFront                            │   ┌──── Google Cloud ─────────────┐
└───────────────┬────────────────────────────────────────┘   │ GCS Standard ─► Cloud CDN     │
                │ Storage Transfer Service (S3 → GCS)        │ (nguồn phát phụ, failover)    │
                └──────────────────────────────────────────► │ Gemini / Vertex AI (tóm tắt)  │
                                                             │ Google Sign-In                │
                                                             └───────────────────────────────┘
```

## Vai trò từng dịch vụ

### AWS

| Dịch vụ                | Vai trò trong Streamora                                                | Task          |
| ---------------------- | ---------------------------------------------------------------------- | ------------- |
| EC2 Auto Scaling + ALB | Next.js, NestJS API, worker; scale theo request/CPU và độ sâu SQS      | T19           |
| RDS PostgreSQL         | Thay PostgreSQL tự cài; backup tự động, cùng VPC với EC2               | T19           |
| IVS Real-Time (stage)  | Phòng học và `/meet`: camera, micro, chia sẻ màn hình (thay LiveKit)   | T05, T06, T07 |
| IVS composition        | Ghi hình phòng (thay LiveKit Egress); đích S3 và IVS Channel           | T11           |
| IVS Channel (STANDARD) | Livestream đông người; IVS transcode nhiều chất lượng (ABR) khi LIVE   | T12, T13      |
| S3 + CloudFront        | Bản ghi, HLS, tài liệu, upload multipart; CDN chính có signed cookie   | T12–T17       |
| EventBridge + SQS      | Sự kiện IVS và hàng đợi job (thay webhook LiveKit và RabbitMQ); có DLQ | T05, T11, T13 |
| MediaConvert           | HLS nhiều mức + thumbnail cho file LOCAL_RECORDING/MP4                 | T13           |
| Secrets Manager, IAM   | Khoá Azure, Google, JWT, mật khẩu RDS; EC2 dùng IAM role               | T19           |
| CloudWatch             | Log, metric, dashboard, cảnh báo                                       | T19           |
| AWS WAF                | Bảo vệ HTTP(S) trên ALB/CloudFront                                     | T20           |

IVS Chat không dùng: chat đã chạy trên Socket.IO với kiểm tra quyền theo nhóm (T08).

### Azure

| Dịch vụ                  | Vai trò                                                                               | Task |
| ------------------------ | ------------------------------------------------------------------------------------- | ---- |
| Web PubSub for Socket.IO | Giữ kết nối Socket.IO và fan-out sự kiện giữa nhiều instance API (thay Redis adapter) | T21  |
| AI Content Safety        | Kiểm duyệt tin chat trước khi lưu; kiểm duyệt ảnh tải lên                             | T22  |
| AI Speech                | Batch transcription tiếng Việt cho bản ghi: phụ đề WebVTT và transcript               | T23  |

Không dùng Azure OpenAI: gói Azure for Students không cấp. Không dùng Azure
Communication Services hay dịch vụ media của Azure vì trùng với IVS. Cần kiểm tra
gói Azure for Students tạo được tier Free của Web PubSub, Content Safety và Speech
trước khi làm T21–T23.

### Google Cloud

| Dịch vụ                        | Vai trò                                                           | Task |
| ------------------------------ | ----------------------------------------------------------------- | ---- |
| Cloud Storage (class Standard) | Bản sao file/HLS từ S3 để phát dự phòng                           | T18  |
| Cloud CDN                      | CDN thứ hai, signed cookie; player chuyển sang khi CloudFront lỗi | T18  |
| Storage Transfer Service       | Sao chép S3 → GCS theo sự kiện (qua SQS) cho object mới           | T18  |
| Gemini (Vertex AI)             | Tóm tắt bài giảng, tạo câu hỏi ôn tập từ transcript               | T23  |
| Google Sign-In                 | Đăng nhập bằng Gmail, bổ sung cho module `auth`                   | T24  |

Bucket GCS phải dùng class Standard (không phải Nearline/Coldline) vì nó phục vụ phát
trực tiếp khi failover, không chỉ để backup.

## Luồng chính

### Vào phòng học (T05)

1. Trình duyệt gọi `POST /sessions/{id}/join` với access token T01.
2. API kiểm tra lượt tham gia bằng `RequireClassParticipation` (T04) và trạng thái ban,
   đọc ánh xạ session → stage do server lưu, rồi gọi `CreateParticipantToken`.
   Capability PUBLISH/SUBSCRIBE và TTL ngắn lấy theo role hiện tại trong DB.
3. Trình duyệt dùng IVS Web Broadcast SDK kết nối WebRTC thẳng tới stage.
4. Sự kiện stage/participant đi qua EventBridge → SQS; consumer của T05 dedup theo
   event id rồi lưu. Không có webhook public.

### Thu hồi quyền, mute và ban (T03, T06, T07)

IVS không đổi quyền khi người dùng đang trong stage và không có remote mute:

- **Mất quyền / bị xóa / bị ban:** `DisconnectParticipant`, ngắt socket, chặn cấp token mới.
  `MembershipMediaService` chuyển từ LiveKit sang cách này trong T05.
- **Mute:** gửi `moderation.mute` qua socket để client tự tắt mic.
- **Khóa mic:** ngắt rồi cấp token chỉ có SUBSCRIBE.
- **Chia sẻ màn hình:** IVS không phân quyền theo loại track, nên policy viewer share
  thực thi ở client; host ngắt người vi phạm.

### Ghi hình, livestream và tua lại (T11–T13)

1. Host bắt đầu ghi → `StartComposition` từ stage, đích S3 và IVS Channel nếu livestream.
2. Channel loại STANDARD transcode nhiều chất lượng khi LIVE; recording configuration
   ghi đủ rendition vào S3.
3. Sự kiện composition/recording qua EventBridge → SQS → worker cập nhật trạng thái,
   đăng ký bản ghi vào thư viện (T15).
4. **DVR (T12):** player đọc HLS bản ghi trên S3 qua CloudFront để xem đoạn đã qua khi
   lớp vẫn LIVE. Cần POC sớm để xác minh IVS ghi segment vào S3 kịp trong lúc live.
5. File LOCAL_RECORDING/MP4 (T10) → job SQS → MediaConvert tạo HLS + thumbnail.
   Xóa message sau khi lưu kết quả; lỗi retry có giới hạn rồi vào DLQ.

### Realtime (T21)

Các gateway NestJS hiện có (membership, class-sessions, chat) gắn adapter của Azure Web
PubSub for Socket.IO. Frontend vẫn dùng `socket.io-client`, chỉ đổi endpoint theo môi
trường. Xác thực `auth.accessToken` và kiểm tra quyền vẫn chạy trong NestJS; lịch sử
bền vẫn ở PostgreSQL. Kiểm tra các tính năng Socket.IO mà dịch vụ không hỗ trợ trước
khi chuyển.

### Kiểm duyệt nội dung (T22)

`chat.send` gọi Azure AI Content Safety trước khi lưu/broadcast; tin vi phạm không tới
client khác. Ảnh tải lên được kiểm duyệt bất đồng bộ qua SQS. Nhóm chốt chính sách khi
dịch vụ lỗi (fail-open có log hay fail-closed).

### Phụ đề và tóm tắt (T23)

1. Khi bản ghi READY: worker tách audio, tạo presigned URL S3 TTL ngắn, gửi batch
   transcription tới Azure AI Speech (`vi-VN`); lưu WebVTT vào S3.
2. Gửi transcript cho Gemini (Vertex AI) để tóm tắt và tạo câu hỏi; lưu vào RDS.
3. Chỉ gửi audio sang Azure và văn bản sang Google, không gửi video. Khi có dữ liệu
   thật, dùng gói trả phí/Vertex AI để dữ liệu không bị dùng cho việc huấn luyện.

### Phát dự phòng (T18)

Storage Transfer Service sao chép object mới từ S3 sang GCS Standard theo sự kiện; mỗi
asset/rendition có trạng thái replica và chỉ READY khi đủ playlist và segment. Playback
resolver xác thực user, chọn CloudFront hoặc Cloud CDN theo region và health, cấp signed
cookie cho CDN đã chọn. Ngắt nguồn chính thì player chuyển sang nguồn phụ và xem tiếp.

### Đăng nhập Google (T24)

Frontend lấy ID token qua Google Identity Services; `POST /auth/google` kiểm tra chữ ký,
`aud`, `iss`, `email_verified`, liên kết theo `googleSub` hoặc email đã xác minh, rồi
phát access/refresh token như đăng nhập T01.

## Yêu cầu chung

- **Secret:** chỉ nằm trong Secrets Manager hoặc biến môi trường của deployment. Repo
  public: `.env.example` chỉ chứa giá trị mẫu, không ghi IP, user hay khoá thật.
- **Xác thực giữa các cloud:** EC2 dùng IAM role cho dịch vụ AWS. Key Azure và service
  account Google nằm trong Secrets Manager, chỉ có quyền trên đúng tài nguyên cần dùng.
  Storage Transfer Service đọc S3 bằng IAM role/user chỉ có quyền đọc bucket nguồn.
- **Phí chuyển dữ liệu ra khỏi AWS:** tính theo GB. Chỉ gửi audio cho Azure Speech, văn
  bản cho Gemini; GCS chỉ nhận asset cần phát; đặt lifecycle xóa bản cũ.
- **Region:** kiểm tra IVS Real-Time có ở region gần người dùng trước khi chọn region cho
  EC2/RDS. Web PubSub, Speech và GCS chọn region gần region AWS đã chọn.
- **Giám sát:** log và metric gom về CloudWatch kèm `requestId`/`eventId`; Web PubSub
  xem thêm ở Azure Monitor. Không log presigned URL, token hay transcript đầy đủ.

## Thay đổi cần có trong code

| Phần                                                  | Thay đổi                                                                        | Task    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- | ------- |
| `src/modules/memberships/membership-media.service.ts` | LiveKit → IVS: `DisconnectParticipant` khi mất quyền                            | T05     |
| Module media mới                                      | API cấp token IVS, bảng ánh xạ session → stage, consumer sự kiện IVS            | T05     |
| Module recordings                                     | `StartComposition`/`StopComposition`, trạng thái bản ghi                        | T11     |
| `services/recording`, `services/video-worker`         | Worker SQS, MediaConvert, cấu hình channel/recording IVS                        | T13     |
| Gateway Socket.IO (memberships, class-sessions, chat) | Gắn adapter Azure Web PubSub; bỏ nhu cầu Redis adapter                          | T21     |
| `ChatService`, module files                           | Gọi Azure AI Content Safety                                                     | T22     |
| Module AI mới                                         | Azure AI Speech + Gemini, lưu phụ đề và tóm tắt                                 | T23     |
| `src/modules/auth`                                    | `POST /auth/google`, bảng liên kết provider                                     | T24     |
| `frontend`                                            | IVS Web Broadcast SDK cho phòng, IVS Player/hls.js cho livestream, DVR, xem lại | T05–T14 |

## Giai đoạn triển khai

1. **GĐ1:** T01–T04 đã xong. Còn T15 (thư viện S3) và T19 (EC2, RDS, S3, CI/CD); ưu tiên
   chuyển database sang RDS.
2. **GĐ2:** IVS thay LiveKit (T05–T07), ghi cloud (T11), poll (T09), upload (T16),
   realtime trên Azure Web PubSub (T21), đăng nhập Google (T24).
3. **GĐ3:** ghi cục bộ (T10), DVR (T12), ABR và pipeline video (T13), player (T14),
   resume upload (T17), kiểm duyệt nội dung (T22).
4. **GĐ4:** GCS + Cloud CDN failover (T18), phụ đề và tóm tắt (T23), tải, autoscaling,
   WAF và nghiệm thu (T19, T20).
