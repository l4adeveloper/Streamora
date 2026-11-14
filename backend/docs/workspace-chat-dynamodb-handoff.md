# Bàn giao chat workspace, DynamoDB và hỏi đáp theo chủ đề

Ngày: 13/11/2026. Phạm vi: chat nhóm/kênh trong workspace. Chat bên trong cuộc họp vẫn dùng RAM và vòng đời cuộc họp như trước.

## Kết quả

- Tin nhắn workspace chuyển sang DynamoDB, gồm gửi, sửa, xóa mềm, trả lời và chống trùng khi gửi lại.
- Mở kênh ở cuối lịch sử ngay trước khi trình duyệt vẽ, không chạy hiệu ứng cuộn từ đầu xuống.
- Lần đầu tải 20 tin mới nhất; tự tải thêm nếu chưa lấp đầy khung nhìn. Cuộn lên đầu tải trang cũ; chèn tin vào đầu giữ vị trí đọc. Có điều khiển tải thêm gọn cho bàn phím. Khi đang đọc tin cũ, tin mới không kéo người dùng xuống cuối.
- Tìm kiếm trong toàn bộ tin nhắn của group, bao gồm các kênh và thread, không chỉ các tin đã tải vào UI. Không phân biệt hoa/thường, chuẩn hóa Unicode NFC, giữ dấu tiếng Việt.
- Kênh hỏi-đáp mở danh sách chủ đề bên trái và nội dung thread bên phải. Người dùng tạo chủ đề có tiêu đề, mở từng thread, gửi/trả lời/sửa/xóa tin như chat thường. Màn hình nhỏ chuyển giữa danh sách và nội dung bằng nút quay lại.
- Gửi trong thread hiển thị tin tạm và xóa ô nhập ngay, giữ focus để viết tiếp; không khóa composer trong lúc chờ ACK. Đối chiếu clientId/ID để gộp tin đã xác nhận, tách tin chờ theo thread. Khi lỗi, giữ nguyên nội dung trong thông báo có nút “Thử gửi lại”, dùng lại clientId và không ghi đè bản nháp đang viết. Danh sách tin được memo hóa để gõ chữ không kích hoạt lại phần cuộn lịch sử.
- Panel thành viên tự đóng khi vào hỏi-đáp để dành chỗ cho cuộc thảo luận.

## Đối chiếu Job.xlsx

Đã đọc workbook `D:/2026.1/CLOUD/Streamora_files/Job.xlsx`, các phần T08, T03, T21, API_backend và quy ước dùng chung:

- Giữ UUID, thời gian JSON ISO8601 UTC, hiển thị theo múi giờ người dùng.
- REST dùng prefix `/api/v1`, danh sách `{items,nextCursor}`, cursor opaque và thứ tự ổn định createdAt + id, mặc định 20, tối đa 100.
- Giữ namespace `/classroom`, xác thực `auth.accessToken` và ACK `{ok:true,...}` / `{ok:false,error:{code,message}}`.
- Kiểm tra quyền khi đọc, join, gửi, sửa, xóa, tạo/đọc thread và tìm kiếm. Broadcast kiểm tra lại phiên và membership hiện tại trước khi chọn người nhận.
- Lưu bền trước broadcast; chống trùng theo group + channel/thread + sender + clientId. Retry cùng mã với nội dung khác trả CONFLICT.
- Khác biệt có chủ đích theo yêu cầu mới: workbook mô tả lịch sử PostgreSQL và API theo session; tính năng này chuyển lịch sử **workspace** sang DynamoDB, không thay API/vòng đời chat cuộc họp.
- Giữ tên sự kiện workspace đang có (`channel:join`, `chat:send`, `chat:edit`, `chat:delete`), không đổi tên gateway đang được các phần khác sử dụng. Giữ giới hạn nội dung workspace 4.000 ký tự; workbook nêu 2.000 là mức đề xuất.
- Có giới hạn 20 lần gửi / 10 giây / user / API instance. Đây chưa phải quota toàn cluster.

## Chạy local

Từ thư mục gốc project:

```powershell
npm install
docker compose -f infra/docker/chat.compose.yml up -d
npm run chat:setup --workspace=@streamora/api
npm run dev:api
```

Ở terminal khác:

```powershell
npm run dev
```

Database PostgreSQL hiện có vẫn cần thiết cho đăng nhập, nhóm, quyền, metadata kênh và cuộc họp. DynamoDB thay phần nội dung chat workspace, không thay toàn bộ PostgreSQL.

Cấu hình trong `backend/.env` (có sẵn mẫu ở `.env.example`):

```dotenv
CHAT_DYNAMODB_ENDPOINT=http://127.0.0.1:8000
CHAT_DYNAMODB_REGION=ap-southeast-1
CHAT_DYNAMODB_TABLE=streamora-chat
```

Mặc định development/test trỏ `127.0.0.1:8000`; production bỏ endpoint mặc định và dùng AWS. Local không có AWS credentials sẽ dùng credentials giả `local/local`. Không cần đặt khóa AWS thật để thử local.

Compose bind cổng vào loopback, lưu dữ liệu bằng named volume `chat-data`; `docker compose down` không xóa volume. Tránh thêm `-v` nếu muốn giữ lịch sử.

Nếu Docker chưa chạy, có thể dùng DynamoDB Local chính thức bằng Java. Tải và giải nén theo [hướng dẫn AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html), rồi chạy tại thư mục chứa JAR:

```powershell
java '-Djava.library.path=./DynamoDBLocal_lib' -jar DynamoDBLocal.jar -sharedDb -port 8000 -dbPath .
```

Trong lượt triển khai này đã chạy DynamoDB Local 3.3.1 bằng Java có trên máy, dữ liệu ở `backend/.local-storage/dynamodb-runtime` (bị gitignore). Có thể chạy lại trên máy này bằng:

```powershell
Set-Location backend/.local-storage/dynamodb-runtime
& 'C:/Program Files/JetBrains/PyCharm 2026.2.0.1/jbr/bin/java.exe' '-Djava.library.path=./DynamoDBLocal_lib' -jar DynamoDBLocal.jar -sharedDb -port 8000 -dbPath .
```

Chỉ chạy một DynamoDB Local trên cổng 8000. Không chạy đồng thời bản Java và Compose trên cùng cổng.

## API bổ sung

### Cập nhật giao diện tìm kiếm và hỏi đáp

Kết quả tìm kiếm hiển thị thành thẻ có avatar, người gửi, kênh và thời gian; toàn bộ thẻ là liên kết mở kênh/chủ đề. Cụm từ khớp được in đậm và tô nền, không phân biệt hoa/thường sau chuẩn hóa NFC. Tin dài được trích quanh vị trí khớp. Ô nhập luôn ở phía trên khi cuộn kết quả; các kết quả đã tải được sắp từ mới đến cũ. Client tự đi tiếp tối đa 5 trang khi gặp trang tìm kiếm rỗng, sau đó vẫn có nút tìm thêm để giới hạn chi phí đọc.

Hỏi đáp có cột chủ đề 304px, ô lọc ở đầu và nút dấu cộng tròn cố định ở góc dưới bên phải. Hover hoặc focus bằng bàn phím mở rộng nhãn “Tạo chủ đề” sang trái, giữ nguyên mép phải; chế độ giảm chuyển động bỏ hiệu ứng. Đã bỏ phần tiêu đề/lời giới thiệu và nút làm mới; danh sách vẫn đồng bộ qua sự kiện realtime. Bộ lọc áp dụng cho danh sách chủ đề đã tải, không thay thế API tìm kiếm toàn lịch sử. Thẻ được chọn có vạch nhấn, ngày giờ ngắn gọn. Khung thảo luận hiển thị nhãn, tiêu đề và ngày tạo; ẩn các dòng thông tin lặp, dùng lời nhắc “Viết câu trả lời hoặc chia sẻ ý kiến…”. Nút quay lại danh sách chỉ hiện trên màn hình nhỏ.

Đã kiểm tra trên trình duyệt ở desktop 1440×1000 và mobile 390×844: làm nổi bật từ khóa tiếng Việt khác hoa/thường, lọc tiêu đề, tạo/gửi tin vào thread, mở chat ở cuối và cuộn tải tin cũ. Typecheck frontend và production build trong bản sao thử riêng đạt.

Tất cả đều yêu cầu Bearer token và quyền truy cập group hiện tại. Runtime validation từ chối field lạ, UUID sai và giới hạn không hợp lệ.

| Method | Path sau `/api/v1` | Đầu vào | Kết quả |
|---|---|---|---|
| GET | `/groups/{groupId}/chat/messages` | `channel?`, `cursor?`, `limit?` | `{items:GroupChatMessage[],nextCursor}`; mỗi trang tăng dần theo thời gian, trang tiếp theo là các tin cũ hơn |
| GET | `/groups/{groupId}/chat/search` | `q` dài 1–100, `cursor?`, `limit?` | `{items:GroupChatMessage[],nextCursor}` |
| GET | `/groups/{groupId}/chat/threads` | `cursor?`, `limit?` | `{items:GroupChatThread[],nextCursor}` |
| GET | `/groups/{groupId}/chat/threads/{threadId}` | UUID | `{thread}` |
| POST | `/groups/{groupId}/chat/threads` | `{title:string}` dài 1–120 sau trim | 201 `{thread}` |

`GroupChatThread={id,groupId,title,createdById,createdAt}`. Nội dung của thread dùng channel nội bộ `thread:{threadId}`; server xác nhận thread thuộc group trước khi join/gửi/đọc. Không thể dùng ID thread của nhóm khác.

`channel:join` trả thêm `nextCursor` và tối đa 20 tin mới nhất. UI dùng REST `/chat/messages` để tải trang cũ. `chat:thread.created` thông báo làm mới danh sách chủ đề. Contracts nằm trong `backend/contracts/src/memberships.ts`.

Tìm kiếm có debounce 300ms và chặn phản hồi cũ khi đổi từ khóa/nhóm. Kết quả thread mở đúng chủ đề qua `threadId` trên URL; kết quả kênh mở kênh tương ứng. `messageId` xác định tin cần đến; cuộn ngắn tới tin, tô nổi bật trong 5 giây sau khi đến nơi. Không cuộn lại khi người dùng đang đọc hoặc gõ bản nháp mới.

### Bổ sung nhảy tới tin nhắn và rà soát hồi quy (14/11/2026)

`GET /groups/{groupId}/chat/messages?channel=...&around={messageId}&limit=20` đọc trực tiếp tối đa 20 tin trước, tin đích và 20 tin sau; trả `{items,nextCursor,newerCursor}`. Không duyệt tuần tự từ tin mới nhất về tin cần tìm. `nextCursor` tiếp tục về trước bằng API cũ; `newerCursor` tiếp tục về sau bằng `direction=after&cursor=...`. Giữ kiểm tra quyền nhóm/chủ đề; tin đã xóa hoặc thuộc kênh/nhóm khác trả 404. Bỏ `around` và `direction` giữ nguyên hành vi API lịch sử cũ.

`use-group-chat.ts` dùng chung một hàm tải trang cho hai hướng. `use-chat-scroll.ts` giữ vị trí đọc, theo cuối khung khi đang ở tin mới nhất và quản lý hiệu ứng tìm kiếm; không phụ thuộc component hiển thị tin. Kết nối lại xóa cursor của cửa sổ tìm kiếm cũ. ACK gửi tin được trả ngay, không phải chờ tải lại lịch sử.

Hỏi đáp giữ tin nhắn dưới tiêu đề, rộng cùng cột với ô trả lời trên desktop/mobile. Nút về tin mới nhất nằm nổi trong khung lịch sử, không thay đổi chiều cao ô nhập. CSS cuộn chung nằm ở `workspace-layout.css`, phần căn lề riêng cho hỏi đáp ở `workspace-threads.css`.

Chuyển giữa các kênh chat, tài liệu và bản ghi trong cùng nhóm dùng chung trạng thái điều hướng, giữ Workspace/sidebar đang mount, cập nhật URL bằng History API và hỗ trợ Back/Forward. `type=recordings` chọn bộ lọc bản ghi; bỏ tham số này quay về tất cả tài liệu. Không để trạng thái chọn chat cũ che màn hình thư viện. Danh sách kênh được giữ theo nhóm trong khi chờ ACK kênh mới; đổi nhóm không hiển thị kênh của nhóm cũ và bỏ qua phản hồi tạo kênh cũ đến muộn. Link mở tab mới vẫn giữ `groupId`. Khi đang trong cuộc họp, chuyển sang thư viện vẫn phải rời phòng thành công trước.

### Panel, chưa đọc và thứ tự chủ đề

Lựa chọn mở/đóng panel bên phải được lưu trong localStorage theo tài khoản (`streamora-workspace-panel:{userId}`). Thao tác tự ẩn panel khi vào hỏi đáp hoặc màn hình nhỏ không ghi đè lựa chọn này; thao tác tự mở khi khôi phục cuộc họp tôn trọng lựa chọn đóng trước đó.

`GET /groups/{groupId}/chat/read-state` trả `{unread:Record<channel,number>,threadActivity:Record<threadChannel,ISO8601>}`. `POST /groups/{groupId}/chat/read` nhận `{channel,messageId}` và lưu mốc đọc theo tài khoản đã xác thực; không nhận userId từ client. Mốc chỉ tiến lên, không lùi khi tab/phản hồi cũ đến trễ. Không tính tin do chính người đọc gửi hoặc đã xóa. Trò chuyện chung hiện số của kênh; hỏi đáp cộng các chủ đề và có badge riêng từng chủ đề. Chỉ xác nhận đã đọc khi cuộc trò chuyện hiển thị, tab đang hoạt động và người dùng xem tới cuối cửa sổ lịch sử mới nhất; mở thư viện, đọc tin cũ hoặc mở chủ đề khác không xóa số đếm.

`READ#{userId}#{channel}` lưu mốc trong cùng bảng DynamoDB, không cần migration PostgreSQL hay tạo bảng mới. API đọc metadata tin nhắn (không tải nội dung) theo partition nhóm để tính chính xác số chưa đọc và thời gian hoạt động. Chi phí đọc tăng theo lịch sử nhóm; khi quy mô lớn cần chỉ mục/tổng hợp riêng. Client gộp thông báo realtime trước khi cập nhật badge và làm mới khi quay lại tab/kết nối lại.

`GET /chat/threads` sắp xếp theo tin gửi mới nhất, dùng ngày tạo cho chủ đề chưa có tin, rồi ID để phân trang ổn định. Chủ đề cũ có tin mới được đưa lên đầu cả ở server và giao diện, kể cả khi trước đó nằm ngoài trang đầu; phản hồi danh sách cũ không ghi đè danh sách vừa làm mới. Chỉnh sửa tin không làm đổi ngày gửi.

## Cấu trúc lưu trữ

Một table có partition key `pk` (String), sort key `sk` (String), PAY_PER_REQUEST. Mọi dữ liệu được phân vùng bằng `pk=GROUP#{groupId}`:

| Prefix sort key | Mục đích |
|---|---|
| `M#{channel}#{createdAt}#{id}` | Nội dung tin nhắn, revision cho cập nhật có điều kiện |
| `ID#{id}` | Tra cứu ID sang khóa tin nhắn |
| `CLIENT#{channel}#{senderId}#{clientId}` | Chống tạo trùng khi gửi lại, kể cả gửi đồng thời |
| `T#{createdAt}#{id}` | Danh sách chủ đề |
| `THREAD#{id}` | Tra cứu và xác nhận quyền sở hữu group của thread |
| `E#{createdAt}#{eventId}` | Outbox sự kiện, TTL `expiresAt` sau 24 giờ |

Tin nhắn và outbox được ghi trong cùng DynamoDB transaction. Sửa/xóa kiểm tra revision tránh ghi đè khi cạnh tranh. Xóa mềm giữ nội dung trong database, loại khỏi lịch sử và tìm kiếm; chưa có tác vụ purge nội dung. Khi xóa group trong PostgreSQL, quyền bị chặn ngay nhưng dữ liệu DynamoDB chưa tự purge.

Mỗi API instance poll sự kiện của các group có socket local, kiểm tra lại quyền rồi phát tới các socket được phép. Poll dùng cửa sổ chồng lấn 60 giây và dedup eventId; sự cố đọc sẽ không tiến con trỏ. Cần đồng bộ giờ máy bằng NTP và tránh transaction bị treo lâu hơn cửa sổ. Các sự kiện ngoài cửa sổ khi không còn kết nối được phục hồi qua lịch sử khi rejoin/scroll. Đây là cơ chế poll local/cloud ban đầu, chưa benchmark throughput hay khẳng định khả năng tải lớn. Khi scale lớn nên thay phần đọc outbox bằng DynamoDB Streams + consumer/delivery phù hợp.

Metadata kênh (`group_chat_channels`) và thay đổi kênh vẫn ở PostgreSQL. Thông báo tự động tạo cuộc họp vẫn phát sinh từ transaction cuộc họp trong PostgreSQL; gateway chiếu sang DynamoDB theo ID để lịch sử workspace đọc được. Bảng `group_chat_messages` cũ được giữ nguyên để tương thích quan hệ `ClassSession.announcement` và chuyển dữ liệu; tin nhắn người dùng mới không ghi vào bảng này.

## Giới hạn tìm kiếm

DynamoDB không tự cung cấp full-text search cho văn bản chat. Bản này thực hiện **Query theo partition của group**, duyệt tối đa 100 bản ghi tin nhắn mỗi request rồi lọc chuỗi; không Scan toàn table và không đưa dữ liệu nhóm khác vào kết quả. Thứ tự tìm theo sort key (kênh rồi thời gian), chưa xếp hạng relevance hay theo thời gian trên toàn group.

Một trang có thể rỗng nhưng vẫn có `nextCursor`; nút “Tiếp tục tìm trong lịch sử” đi tiếp cho đến khi hết. `limit` giới hạn số kết quả trả về, không cam kết quét hết lịch sử trong một request. Chi phí và độ trễ tăng theo lịch sử group. Khi dữ liệu lớn cần bổ sung search index chuyên dụng, ví dụ OpenSearch qua DynamoDB Streams, cùng cơ chế xóa/cập nhật chỉ mục. Không cần đổi API UI để thực hiện nâng cấp đó.

## Chuyển lịch sử PostgreSQL cũ

Không tự động sao chép/xóa dữ liệu cloud khi khởi chạy app. Nếu chưa chuyển, lịch sử tin nhắn cũ trong PostgreSQL không xuất hiện trong DynamoDB.

```powershell
# Chỉ đếm các tin chưa xóa; không ghi
npm run chat:migrate --workspace=@streamora/api
# Sau khi xác nhận DATABASE_URL và endpoint/table đích
npm run chat:migrate --workspace=@streamora/api -- --write
```

Lệnh chạy theo lô 100, giữ ID, thời gian, replyToId và trạng thái chỉnh sửa; bỏ qua tin đã có theo ID. Không sửa/xóa PostgreSQL, không copy tin đã xóa mềm. Script tạo outbox khi copy; nên chạy lúc tạm dừng ghi và trước khi cho client vào để tránh phát lại tin cũ. Chạy lại chỉ an toàn với nguồn bất biến; script không đồng bộ thay đổi mới vào ID đã copy.

Đã **không chạy migration trên database EC2** trong lượt này.

## Chuyển lên AWS

1. Tạo table đúng schema và bật TTL `expiresAt` bằng IaC hoặc `npm run chat:setup --workspace=@streamora/api -- --cloud`. Lệnh setup cloud chỉ chạy khi bỏ endpoint và có `--cloud`; API không tự tạo table.
2. Đặt `NODE_ENV=production`, `CHAT_DYNAMODB_TABLE` và `CHAT_DYNAMODB_REGION`. Xóa biến `CHAT_DYNAMODB_ENDPOINT` của local khỏi deployment.
3. Cấp IAM role cho EC2/ECS: `dynamodb:GetItem`, `Query`, `PutItem` trên table (các thao tác Put trong transaction cần quyền PutItem). Role setup riêng cần CreateTable, DescribeTable, UpdateTimeToLive. Không lưu access key trong repository.
4. Bật backup/PITR, mã hóa và giám sát theo chính sách vận hành. Đồng bộ thời gian API instances. Không gán TTL cho tin nhắn hoặc thread.
5. Tạm dừng ghi, chạy dry-run/copy lịch sử nếu cần, đối chiếu số lượng, rồi chuyển traffic. Không bật backend cũ tiếp tục ghi chat vào PostgreSQL cùng lúc backend mới ghi DynamoDB.
6. Giữ cấu hình frontend realtime/Web PubSub hiện có; việc thay database không yêu cầu đổi socket.io-client. Chưa kiểm thử trên tài nguyên AWS/Azure thật trong lượt này.

## Kiểm thử và nghiệm thu

```powershell
npm run typecheck
npm run build --workspace=@streamora/web
npm run test:chat --workspace=@streamora/api
node --test backend/test/frontend/chat-search-navigation.test.cjs
node --test backend/test/frontend/chat-scroll-browser.test.cjs
```

`test:chat` yêu cầu DynamoDB Local đang chạy, tạo table `streamora_chat_test_{UUID}` và xóa chính table đó sau khi chạy; từ chối endpoint ngoài loopback. Phần kiểm tra HTTP dùng PostgreSQL PGlite trong RAM, không đọc `.env` hay tạo database EC2. Không chạy các bài integration cũ với DATABASE_URL ứng dụng: fixture cũ cần PostgreSQL test riêng có CREATEDB.

Hai bộ frontend mới không cần dữ liệu ứng dụng: bộ logic kiểm tra yêu cầu tải trực tiếp, đổi đích, reconnect và ACK; bộ trình duyệt dùng component thật với mạng giả lập để kiểm tra cuộn, khung tô 5 giây, bố cục desktop/mobile, tự lấp khung và gửi/thử lại khi lưu chậm hoặc lỗi. Đặt `STREAMORA_CHAT_SCREENSHOTS=1` nếu cần lưu ảnh bố cục vào `.preview/chat-layout-review`. Khi chạy production build lúc đang mở dev server, dùng bản sao nguồn riêng để không ghi đè `.next` đang chạy.

Đã đạt 7 bài: retry đồng thời và conflict, phân trang timestamp trùng/cursor chéo scope, search nhiều kênh và sửa/xóa, trang search rỗng có cursor, thread độc lập, kiểm tra gateway/quyền/broadcast giữa hai gateway dùng chung DynamoDB, xác thực/validation/phân quyền REST qua Nest thật. Typecheck toàn workspace và production build frontend đạt.

Ngoài 7 bài trên, kiểm thử hồi quy `node --test backend/test/meeting-access.test.cjs` cũng đạt: tạo cuộc họp, quyền truy cập và thông báo cuộc họp vẫn hoạt động.

Đã chạy browser smoke bằng Edge headless với DynamoDB Local + PostgreSQL RAM: mở chat ở cuối, cuộn lên tải lịch sử, tạo chủ đề và gửi tin vào thread. Đã xem ảnh bố cục desktop 1440×1000 và mobile 390×844, sửa panel thành viên che nội dung ở màn hình nhỏ. Đây là kiểm tra local, không thay cho nghiệm thu đa instance AWS/Azure hoặc bài đo tải.

Đã mô phỏng lưu tin chậm 1,8 giây và lỗi lưu tin trong browser smoke: tin tạm xuất hiện trước ACK, input vẫn có focus và nhận nội dung tiếp, gửi hai tin liên tiếp, ACK không xóa bản nháp mới, lỗi giữ nội dung để retry, xác nhận/retry không tạo bản hiển thị trùng.

Checklist thử tay: mở hai tài khoản cùng nhóm; gửi/sửa/xóa; refresh; tạo/chọn hai chủ đề; xác nhận tin không lẫn; tìm một từ trong tin cũ chưa tải; tiếp tục qua trang tìm rỗng; thử nhóm không có quyền; ngắt/rejoin; cuộn lên trong khi client khác gửi tin; đổi nhóm/kênh khi đang tải lịch sử.
