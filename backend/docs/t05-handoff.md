# T05 — Phòng học IVS Real-Time

T05 nối media vào các trang `/sessions/:id` và `/meet/:code` hiện có. T04 tiếp tục
quản lý xin vào/duyệt/enter/leave và heartbeat Socket.IO. Camera/micro truyền trực
tiếp qua IVS; API không proxy dữ liệu audio/video.

## Cấu hình

Điền trực tiếp vào `backend/.env` trên server; không cần AWS CLI hoặc `AWS_PROFILE`:

```dotenv
IVS_ENABLED=true
AWS_REGION=ap-northeast-1
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key
# Chỉ thêm khi dùng credentials tạm:
# AWS_SESSION_TOKEN=your-session-token
IVS_TOKEN_TTL_SECONDS=60
IVS_EVENTS_QUEUE_URL=https://sqs.ap-northeast-1.amazonaws.com/123456789012/streamora-ivs-events
IVS_WORKER_ENABLED=false
```

API IVS và worker SQS ưu tiên cặp key này, kể cả khi máy còn đặt `AWS_PROFILE`.
Phải điền cả hai key; cấu hình thiếu một key sẽ báo tên biến cần bổ sung mà
không in giá trị. Key dài hạn không cần `AWS_SESSION_TOKEN`; credentials tạm
cần thêm biến này. Khi để trống cả hai key, EC2 có thể dùng instance IAM role.
Không đưa các giá trị này vào frontend hoặc commit Git. IVS region
độc lập với `FILES_S3_REGION`; ví dụ trên dùng Tokyo, không dùng Singapore cho
IVS Real-Time. Không cần token hoặc Stage ARN cố định trong env.

`IVS_ENABLED=false` là mặc định để phần còn lại của ứng dụng chạy khi chưa có
AWS. API join khi chưa cấu hình trả `503 MEDIA_UNAVAILABLE`. Mọi tên biến được
đọc và kiểm tra trong `src/config/environment.ts`; TTL hiện cố định tối đa 60s.

```powershell
npm ci
npm run db:migrate
npm run dev:api
# Terminal khác:
npm run dev
# Terminal worker riêng:
npm run dev:ivs-events
```

API và worker dùng cùng DB/env. Giữ `IVS_WORKER_ENABLED=false` trong API khi đã
chạy worker riêng; đặt true chỉ khi muốn consumer SQS chạy trong API. Worker SQS
không khởi động HTTP hoặc gateway. Worker thu hồi/reconcile media chạy cùng API
khi IVS được bật. Tắt cả API sẽ tạm dừng thu hồi/reconcile; khi chạy lại nó đọc
các kết nối còn lưu trong DB.

Frontend chỉ dùng `NEXT_PUBLIC_API_URL` và `NEXT_PUBLIC_REALTIME_URL` đã có.
Mặc định realtime dùng cùng API cổng 4000; nếu chọn service cổng 4001 thì phải
chạy thêm `npm run dev:realtime`.
Giữ cùng hostname `localhost` hoặc `127.0.0.1` với `WEB_ORIGIN`. Dùng HTTPS trên
staging để browser cho phép mic/camera.

## Hạ tầng AWS

- IAM API: `ivs:CreateStage`, `ivs:ListStages`, `ivs:GetStage`,
  `ivs:CreateParticipantToken`, `ivs:DisconnectParticipant`,
  `ivs:ListParticipants`, `ivs:ListCompositions`, `ivs:DeleteStage`,
  và quyền tag Stage. Giới hạn account/region/resource và môi trường phù hợp.
- IAM worker: `sqs:ReceiveMessage`, `sqs:DeleteMessage` trên queue sự kiện.
- EventBridge rule `source=aws.ivs`, các detail-type: `IVS Stage Update`,
  `IVS Composition State Change`, `IVS Participant Recording State Change`,
  `IVS Publisher Recording State Change`; target là SQS Standard cùng region.
- Queue policy cho `events.amazonaws.com` quyền SendMessage, ràng buộc
  SourceArn của rule. Redrive tới DLQ, gợi ý maxReceiveCount=3. Nếu dùng KMS,
  bổ sung quyền key tương ứng. Không có webhook public.

## API và dữ liệu

Swagger: `/api/v1/docs-media`, JSON `/api/v1/docs-media-json`.

| Method | Path sau `/api/v1`                                   | Dữ liệu                                                                                                                                          |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/sessions/:sessionId/join`                          | `{participationId,clientId,requestId,deviceLabel?}` → `{requestId,connectionId,participantToken,participantId,expiresIn,expiresAt,capabilities}` |
| POST   | `/sessions/:sessionId/media/:connectionId/heartbeat` | `{requestId,participationId,clientId,connected,micEnabled,cameraEnabled}` → `{ok:true}`                                                          |
| POST   | `/sessions/:sessionId/media/:connectionId/leave`     | `{requestId}` → `{ok:true}`                                                                                                                      |
| GET    | `/sessions/:sessionId/participants`                  | Endpoint T04 giữ phân trang; thêm `media {connected,micEnabled,cameraEnabled,checkedAt}` vào item                                                |

`clientId` là UUID theo vòng đời component/tab. Giữ `requestId` khi retry một
yêu cầu join chưa rõ kết quả. Retry cùng request còn hạn trả cùng participant,
không tạo thêm người. Token được mã hóa AES-GCM trong DB, gắn với connection ID;
không lưu plaintext hoặc log token. Token phía frontend chỉ ở bộ nhớ.

Join kiểm tra actor từ Bearer, chính xác participation hiện tại, phiên auth,
membership/owner Meet, LIVE và ban. Sau I/O AWS, kiểm tra lại trong transaction
T04 trước khi lưu/trả token. Không giữ khóa DB trong lúc gọi AWS. Pending issuance
có lease; trường hợp AWS trả kết quả không chắc chắn được phục hồi qua Stage tag.
Stage tạo khi có lần join media được xác thực đầu tiên; không chặn start T04
khi AWS chưa sẵn sàng. Mỗi class session ánh xạ một Stage trong DB.

Khóa chuẩn bị Stage có hạn 120 giây. AWS từ chối rõ ràng (credentials, IAM,
validation hoặc quota) thì nhả đúng khóa của lần gọi đó để có thể thử lại ngay;
timeout/kết quả chưa chắc chắn giữ khóa để phục hồi Stage theo tag. Lỗi được
log bằng mã và loại lỗi, không ghi credentials, token hoặc thông điệp SDK thô.
Khi nhận `409 MEDIA_STARTING`/`MEDIA_REVOKING`, frontend tự chờ và thử lại với
cùng `clientId`/`requestId`, giãn từ 0,5 đến 4 giây, tối đa 130 giây. Rời phòng
hoặc đổi phòng hủy chờ ngay; các lỗi quyền truy cập không được tự retry.

Danh sách IVS dùng `activeSessionId` của Stage, không dùng UUID buổi học làm
IVS session ID. `connected` từ reconciliation AWS; mic/camera là trạng thái thiết
bị do client báo để hiển thị, không phải bằng chứng cấp quyền. Sau 30s không
heartbeat media, kết nối được thu hồi. Token hết hạn chỉ giới hạn join, không
tự ngắt người đang kết nối.

## Thu hồi và điểm giao

- Worker kiểm tra lại quyền/lượt/auth/ban hiện tại, nên leave/end/removal/logout
  không phụ thuộc việc EventBridge có gửi sự kiện hay không. `DisconnectParticipant`
  dùng IVS participant ID đã lưu, không dùng userId làm participant ID.
- Bảng `session_bans` dành cho API moderation T07 ghi trong tương lai. T05 đã
  kiểm tra ban nhưng chưa cung cấp giao diện/endpoint quản trị ban.
- Meet dùng token chỉ có quyền `PUBLISH` cho luồng chia sẻ màn hình, tách khỏi
  kết nối mic/camera. T10 có thể dùng remote streams trong `useClassMedia` để trộn audio.
- T11 đăng ký handler bằng `IvsEventsService.register(detailType, handler)` trong
  module worker của mình. Handler nhận `(event, tx)` và chỉ ghi job/outbox qua tx.
  Event composition/recording chưa có handler giữ nguyên `handledAt=null` trong
  inbox, không bị ACK nghiệp vụ giả. SQS được ACK sau khi inbox đã lưu bền.
- Event đến trễ/sai thứ tự không trực tiếp đổi quyền/presence. Worker reconcile
  bằng ListParticipants. Event trùng dedup theo ID; handler và handledAt commit
  cùng transaction. Raw event chỉ ở server và không được trả qua endpoint public.
- End T04 chặn token mới ngay. Worker đợi các kết nối bị thu hồi và không còn
  composition STARTING/ACTIVE/STOPPING trước khi DeleteStage; T11 phải xử lý
  `session.ended.v1` để StopComposition. Không tự dừng bản ghi đang hoạt động.

## Kiểm thử và giới hạn nghiệm thu

```powershell
npm run test:t05
npm run test:t05:integration
npm run test:t05:frontend
node --test backend/test/meeting-media-recovery.test.cjs
npm run typecheck
```

Unit/adapter tests không dùng AWS thật: DTO giả mạo, ban, kiểm tra lại sau I/O,
retry token, mã hóa, ownership heartbeat, event dedup/ACK, bảo toàn composition và
migration constraints trên PostgreSQL WASM cô lập. Integration dùng PostgreSQL
tạm thật, cần CREATEDB như các test T04; SDK AWS được thay bằng adapter giả lập.

Nghiệm thu media thật cần AWS credentials/IAM và hai browser/máy: mở preview,
join sau enter, nghe/nhìn hai chiều, bật/tắt và đổi thiết bị, vào chỉ nghe rồi
bật mic, mất mạng ngắn/reconnect, rời phòng dừng tracks, ban/removal chặn token
mới và ngắt kết nối cũ. IVS giới hạn 12 publisher mỗi Stage; chưa có màn hình
điều phối lượt phát khi vượt quota. Không coi test adapter là bằng chứng WebRTC
hoặc EventBridge/SQS trên AWS đã chạy thành công.

Tham khảo: [IVS SDK](https://docs.aws.amazon.com/ivs/latest/RealTimeUserGuide/web-publish-subscribe.html),
[participant tokens](https://docs.aws.amazon.com/ivs/latest/RealTimeAPIReference/API_CreateParticipantToken.html),
[EventBridge](https://docs.aws.amazon.com/ivs/latest/RealTimeUserGuide/eventbridge.html).

Request history trong `class_media_requests` ngăn join retry cũ hoặc leave của generation cũ thay thế/đóng kết nối mới.

`npm run test:t05:frontend` build Next.js rồi kiểm tra preview/stop tracks, lỗi IVS chưa cấu hình và bố cục desktop/mobile với thiết bị/API giả lập. Không gọi AWS hay dùng tài khoản thật.

Để nghiệm thu với cấu hình AWS thật trong `backend/.env`, chạy:

```sh
npm run test:ivs:live
```

Lệnh này kiểm tra quyền truy cập IVS/SQS, đọc thử PostgreSQL và các cột Meeting
trong database được cấu hình; sau đó tạo một database tạm, một Stage AWS tạm và
hai tài khoản kiểm thử. Hai trình duyệt dùng mic/camera giả lập nhưng kết nối
AWS IVS thật. Hai người tự kết nối sau khi vào phòng. Kiểm thử xác nhận RTP
audio/video hai chiều, duy trì qua heartbeat,
AWS xác nhận presence, bật/tắt thiết bị, rời phòng, thu hồi media và đóng Stage.
Không ghi vào database ứng dụng, không nhận/xóa thông báo từ SQS đang dùng.
Stage của bài kiểm thử được dọn sau khi chạy; dữ liệu báo cáo không chứa
credentials/token nằm tại `.preview/ivs-live-review/report.json`, kèm ảnh phòng.
Lệnh cần Edge trên Windows (hoặc Chromium của Playwright trên hệ điều hành khác)
và sử dụng AWS trong thời gian ngắn; không chạy trong bộ test mặc định.

Kiểm tra riêng lỗi micro nhiều người trong Workspace:

```sh
npm run test:ivs:workspace-audio
```

Bài này dùng ba tài khoản trong ba browser context riêng. Hai học viên bật
micro bằng nút cạnh tài khoản Workspace. Kiểm tra hai nút micro của Workspace
và cuộc họp cùng trạng thái, mỗi người nhận hai nguồn RTP audio có tín hiệu và
hai phần tử audio thực sự phát khi cả ba camera đều tắt. Sau đó kiểm tra video
và xác nhận âm thanh tiếp tục phát khi tắt camera.
Không tắt chính sách autoplay của trình duyệt. Các bước heartbeat, rời phòng,
thu hồi kết nối và dọn Stage dùng chung với bài kiểm tra hai người.

Nút micro cạnh tài khoản Workspace điều khiển cùng `useClassMedia` với thanh
thiết bị trong phòng. Bật thiết bị khi đã có lượt tham gia sẽ kết nối IVS nếu
chưa kết nối; chưa được duyệt thì chỉ xem trước thiết bị. Biểu tượng micro/camera
phản ánh track thật, không hiển thị bật khi chưa mở thiết bị.

Migration T05 là `20261108000400_class_media`. Trước khi deploy lên DB dùng chung, đối chiếu `npm run db:status`: checkout và DB cần có cùng lịch sử migration. Không reset DB để xử lý nhánh có lịch sử khác.

## Trạng thái kiểm chứng tại workspace

- Build backend/Next.js, typecheck toàn workspace, các test T05 và bài kiểm tra
  giao diện desktop/mobile đã đạt. Các test backend đã theo dõi trong Git
  cùng test T05 mới đã đạt.
- Ngày 10/11/2026, cấu hình IVS mới tại Tokyo đã vượt qua `test:ivs:live`:
  tạo Stage/token thật, hai browser truyền audio/video hai chiều, duy trì qua
  heartbeat với presence do AWS xác nhận, bật/tắt thiết bị, rời phòng, thu hồi
  kết nối và tự xóa Stage khi kết thúc. Mic/camera dùng nguồn giả lập;
  đường truyền và dịch vụ AWS là thật.
- PostgreSQL được cấu hình đã kết nối thành công và có các cột cần thiết cho
  Meeting/media. Bài live check không ghi dữ liệu vào database ứng dụng hoặc
  thay đổi migration; database kiểm thử chạy toàn bộ migration trên PGlite.
- SQS đã trả HTTP 200 cho truy vấn thuộc tính queue. Chưa nghiệm thu toàn bộ
  đường EventBridge → SQS → consumer hoặc thiết bị vật lý/mạng của từng người.
- Ngày 11/11/2026, bài kiểm tra ba người trong Workspace đã đạt với IVS thật:
  bật micro sau khi vào chỉ nghe, cả ba cùng gửi/nhận audio, playback bình thường,
  duy trì heartbeat và thu hồi khi rời phòng. Nguồn mic/camera vẫn là giả lập.
