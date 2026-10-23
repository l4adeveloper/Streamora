# T04 — Nghiệm thu và bàn giao

Ngày kiểm tra: 23/10/2026. Tài liệu mục 8 tổng hợp phạm vi, cách chạy, kịch bản
demo và kiểm thử; chi tiết triển khai nằm trong các tài liệu được liên kết bên dưới.

## Kết quả sử dụng

T04 cung cấp lịch học thuộc nhóm, Meet độc lập, bắt đầu/hủy/kết thúc buổi,
xin vào, accept/reject, xác nhận vào, rời phòng, danh sách người tham gia và
cập nhật realtime. Tài khoản/phiên dùng T01, nhóm dùng T02, quyền nhóm dùng T03.

- Buổi thuộc nhóm: HOST/OWNER/global ADMIN quản lý; VIEWER xin duyệt;
  người ngoài nhóm không được dùng liên kết để vượt membership.
- Meet độc lập: tài khoản đã đăng nhập được xin vào bằng mã/liên kết;
  chủ Meet/global ADMIN quản lý, không yêu cầu cùng nhóm.
- Lịch là giờ dự kiến, hiển thị theo múi giờ thiết bị và lưu UTC. Đến giờ không
  tự bắt đầu. Vòng đời: `SCHEDULED → LIVE → ENDED` hoặc `SCHEDULED → CANCELLED`.
  Buổi đã kết thúc/hủy không mở lại.
- Accept chỉ cấp quyền vào. Cả người quản lý cũng phải bấm **Vào phòng** mới
  có lượt tham gia. Nhiều tab dùng chung lượt; **Rời phòng** đóng lượt ở mọi tab.
- Heartbeat mặc định 10 giây, thời hạn khôi phục 30 giây. Quá hạn thì lượt đóng;
  người tham gia thường phải xin duyệt lại. Chủ phòng mất mạng không tự kết thúc buổi.

T04 hoạt động khi LiveKit không chạy. Mic/camera/chia sẻ màn hình, token media,
ghi hình, chat, mute/ban và DVR chưa được triển khai trong luồng này. Các màn
demo cũ trong workspace không phải phòng T04 có media. T03 vẫn giữ worker
đồng bộ quyền LiveKit đã có trước đó.

## Chuẩn bị sau khi lấy code

Chạy từ gốc repository bằng Node/npm đúng `engines` trong package.json. Nếu chưa
cài dependencies hoặc lockfile thay đổi, chạy `npm ci` trước. Dùng cấu hình local
hiện có; máy mới chạy `npm run setup:env` và bật PostgreSQL trước các lệnh sau:

```powershell
npm run db:migrate
npm run db:status
npm run build --workspace=@streamora/api
```

Migration chỉ cập nhật cấu trúc. Đã có 9 migration, trong đó 5 migration T04.
Build API tạo Prisma client và build contracts dùng chung. Không cần seed/reset
để chạy T04; các tài khoản và mật khẩu hiện có vẫn được sử dụng.

Mở các terminal riêng:

```powershell
# Terminal 1
npm run dev:api
```

```powershell
# Terminal 2
npm run dev
```

API mặc định cổng 4000; frontend cổng 3000. Socket.IO `/sessions` đã có ngay
trên API. Nếu `apps/web/.env.local` đặt `NEXT_PUBLIC_REALTIME_URL` sang cổng
4001 thì mở thêm terminal chạy `npm run dev:realtime`. API và realtime phải
dùng chung database/khóa ký; khởi động lại frontend sau khi đổi biến public.
Các cổng đang chạy có thể giữ nguyên trong lúc chạy test vì fixture dùng cổng ngẫu nhiên.

Màn hình thật:

- Nhóm → **Xem lịch học**: `/groups/:groupId/sessions`.
- Chi tiết buổi thuộc nhóm: `/sessions/:sessionId`.
- Tạo/tham gia Meet: `/meet`; liên kết mời: `/meet/:code`.
- Khi `API_DOCS_ENABLED=true`: Swagger `/api/v1/docs-sessions`, JSON
  `/api/v1/docs-sessions-json`; snapshot [OpenAPI](class-sessions-openapi.json).

## Demo với ba tài khoản

Dùng ba profile trình duyệt hoặc cửa sổ riêng: A là OWNER của một nhóm,
B là VIEWER trong nhóm, C là tài khoản ngoài nhóm. Có thể tạo nhóm/thêm thành
viên bằng giao diện T02/T03; không cần biết mật khẩu mẫu hoặc chạy seed.

1. A mở lịch nhóm, tạo buổi có tên/giờ dự kiến. B xem được lịch, C mở liên kết
   bị từ chối. Khi còn SCHEDULED, B chưa xin vào được. A thử sửa lịch.
2. A bắt đầu; trạng thái LIVE nhưng danh sách chưa tự tính A. A bấm **Vào phòng**.
3. B xin vào; A thấy hàng chờ. A reject, B thấy kết quả và chủ động xin lại.
   A accept; B vẫn chưa được tính tham gia cho tới khi bấm **Vào phòng**.
4. B mở cùng buổi ở tab thứ hai: danh sách vẫn chỉ có một B. B bấm **Rời phòng**
   ở một tab; cả hai cập nhật lượt đã đóng. B muốn vào lại phải xin duyệt mới.
5. B vào lại, tắt kết nối của mọi tab B quá 30 giây rồi bật lại. B phải xin lại;
   không tự enter từ kết quả cũ. Mất một tab trong khi tab khác heartbeat không
   làm mất lượt. Tạm ngắt rồi nối lại trong thời hạn dùng tiếp lượt còn hiệu lực.
6. A xóa B khỏi nhóm khi đang chờ hoặc trong phòng. B mất truy cập; thêm lại B
   không phục hồi quyền vào cũ. Có thể thử HOST → VIEWER: mất nút quản lý,
   giữ lượt đang vào nếu vẫn còn membership.
7. A kết thúc: buổi ENDED, hàng chờ/quyền vào/lượt đang mở đều đóng, các tab
   cập nhật và không vào lại bằng liên kết cũ. Tạo buổi khác rồi hủy khi SCHEDULED.
8. A vào `/meet`, **Tạo và bắt đầu**, gửi liên kết cho C. C đăng nhập, quay lại
   lời mời, xin vào và được A duyệt dù không cùng nhóm. C không thấy hàng chờ
   của A hoặc tự kết thúc Meet. A kết thúc và kiểm tra C nhận trạng thái mới.

Thử xóa nhóm có buổi LIVE sẽ nhận `ACTIVE_SESSION`; kết thúc buổi rồi mới xóa.
Các tranh chấp đồng thời, retry mất phản hồi và thu hồi phiên được test tự động
để không phải canh thời điểm bằng tay.

## Chạy nghiệm thu tự động

```powershell
npm run test:t04
```

Lệnh này lần lượt typecheck toàn monorepo, Prisma validate, build API/realtime,
đối chiếu OpenAPI T04, rồi chạy toàn bộ unit, integration, browser và frontend
T01–T04 với concurrency 1. Frontend production được build trong thư mục fixture
riêng, không ghi đè `.next` hoặc env của người phát triển.

Yêu cầu: PostgreSQL truy cập được với tài khoản có quyền tạo database kiểm thử;
Edge trên Windows (mặc định), hoặc Chromium đã cài cho Playwright. Có thể đặt
`STREAMORA_TEST_BROWSER_CHANNEL=chromium` khi dùng Chromium. Kiểm thử cookie HTTPS
cần OpenSSL; fixture tự nhận OpenSSL của Git for Windows, hoặc dùng biến
`STREAMORA_TEST_OPENSSL` chỉ đường dẫn executable. Test tạo database tên
`streamora_test_<uuid>` và tự dọn, không reset/seed database ứng dụng.

Lệnh kiểm tra riêng khi sửa một phần:

```powershell
npm run test:t04:database
npm run test:t04:api
npm run test:t04:admission
npm run test:t04:realtime
npm run test:t04:frontend
npm run test:t04:integration
npm run docs:t04:check
```

`npm run docs:t04` cập nhật snapshot có chủ đích; `docs:t04:check` chỉ đối chiếu.
Không chạy build/Prisma generate song song với bộ kiểm thử đang dùng dist/client.

### Đối chiếu 15 tiêu chí phạm vi

Các tên file dưới đây nằm trong `backend/test`; test gọi API thật hoặc chạy
trình duyệt, dùng PostgreSQL tạm và hai API instance cho các tình huống cạnh tranh.

1. Quyền tạo/xem lịch: `integration/class-sessions-api.test.cjs` — current
   HOST/OWNER/ADMIN rights; `frontend/class-sessions-ui.test.cjs` — lịch/UTC.
2. Chưa LIVE không xin vào: `integration/class-admissions-api.test.cjs` —
   cannot request or enter before LIVE or after ENDED/CANCELLED.
3. Accept tách enter, quản lý vào trực tiếp: cùng file admission — separates
   pending, acceptance and actual entry; UI thử từng bước trên hai tài khoản.
4. Ngoài nhóm không vượt quyền: API details resolve stored group; admission
   validates ownership và target eligibility, guard tích hợp chặn giả mạo ID.
5. Meet không cần membership: admission — independent meet permits requests
   without membership; UI kiểm tra liên kết mời qua login.
6. Reject rồi chủ động xin lại: admission — request keys prevent delayed retries;
   UI kiểm tra reject/xin lại/accept.
7. Cancel pending chặn accept: admission — cancel/accept races.
8. Hai host quyết định đồng thời: admission — accept/reject races.
9. Chống retry trùng: lifecycle API — concurrent creates/start/end; admission —
   cross-instance requests/entries; UI tạo Meet khi mất response và start trả 503.
10. Nhiều tab, reconnect, leave: `integration/class-sessions-realtime.test.cjs`
    — multiple tabs, grace, explicit leave; UI thử nhiều tab/offline.
11. Thu hồi/hạ quyền: admission — removing/readding membership, downgrade;
    realtime — current membership gates delivery; UI kiểm tra trang đang mở.
12. End cạnh tranh approve/enter: admission — expired when end races approval
    or entry; guard transaction cạnh tranh end ở `class-session-integration.test.cjs`.
13. End đóng mọi lượt, terminal: lifecycle API + realtime broadcast; UI end/cancel.
14. Start/delete nhóm: lifecycle API — group deletion blocks LIVE and serializes
    with starting a class.
15. Không cần LiveKit: kiểm thử T04 không khởi động LiveKit hoặc tạo ánh xạ phòng
    media; guard không xuất token media và event module chạy riêng không có gateway media.

Ngoài 15 tiêu chí, mục 7 kiểm tra guard ràng buộc đúng lượt, quyền hiện hành,
rollback handler, retry cùng eventId, nhiều worker/consumer, restart và bigint.
Bộ hồi quy giữ kiểm tra auth/cookie, nhóm và membership T01–T03, bao gồm mock
RoomService của T03; mock này không phải media/WebRTC thực.

## Kết quả và giới hạn bàn giao

Đã chạy `npm run test:t04` thành công trên máy local ngày 23/10/2026:

- Typecheck toàn monorepo, Prisma validate, build API/realtime và đối chiếu
  snapshot OpenAPI T04: đạt. Frontend production build đạt trong các fixture UI.
- **206/206 kiểm thử đạt**, 0 lỗi, 0 bỏ qua: 37 unit, 109 integration,
  7 browser cookie/Swagger và 53 frontend (12 T04, 41 hồi quy T01–T03).
  Phần chạy test mất khoảng 374 giây, chưa tính các bước build/typecheck.
- `npm run db:status`: đủ 9 migration, database local up to date.
  Không chạy seed/reset hoặc sửa mật khẩu tài khoản ứng dụng.
- Đã xem ảnh desktop, mobile sáng/tối tạo lại từ bộ UI; không tràn ngang ở
  viewport 390 px. Ảnh nằm trong `.preview/t04-*.png`.
- Log local: `.preview/t04-stage8-acceptance.log` (thư mục bị Git ignore;
  chạy lại lệnh để tái tạo bằng chứng trên máy khác).

Mục 8 thêm lệnh nghiệm thu/đối chiếu tài liệu và hướng dẫn bàn giao; không thêm
dependency, migration hoặc thay đổi hành vi sản phẩm. Các tình huống đã có
kiểm thử từ mục 2–7 được chạy lại cùng hồi quy trong một lượt đầy đủ.

Chưa kiểm thử trên staging công khai hoặc media/WebRTC thật. `Job.xlsx` giữ
nguyên để nhóm tự nghiệm thu. Không tạo consumer T11 chạy nền, job ghi hình,
publisher RabbitMQ hoặc endpoint token media. T05/T11 dùng public surface đã có:

- [Guard/service và consumer T05/T11](t04-integration.md): đã accept vẫn phải
  enter; dùng đúng `sessionId/participationId`, lấy identity từ auth server.
- `session.ended.v1` có eventId/version bền vững. Consumer và hiệu ứng DB dùng
  cùng transaction; I/O ngoài DB cần dedupe/outbox của module nhận.

Tài liệu tham chiếu: [phạm vi](t04-scope.md), [database](t04-database.md),
[API lịch/vòng đời](t04-api.md), [admission](t04-admission.md),
[realtime](t04-realtime.md), [giao diện](../../apps/web/docs/class-sessions.md).
