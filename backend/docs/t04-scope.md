# T04 — Luồng sử dụng và phân quyền

Ngày chốt phạm vi: 23/10/2026.

Tài liệu này hoàn thành mục 1 của kế hoạch T04: thống nhất hành vi nghiệp vụ
để làm database, API, realtime và giao diện ở các mục tiếp theo. Các hành vi
dưới đây là chuẩn nghiệp vụ; tiến độ triển khai xem [database](t04-database.md)
và [API lịch học/vòng đời](t04-api.md), [API tham gia](t04-admission.md),
[realtime/heartbeat](t04-realtime.md), [giao diện](../../frontend/docs/class-sessions.md)
và [điểm tích hợp T05/T11](t04-integration.md).
Nghiệm thu toàn bộ và hướng dẫn demo: [bàn giao T04](t04-handoff.md).

## 1. Căn cứ và phạm vi

- Kế hoạch `docs/Job.xlsx` của nhóm quy định lịch học và vòng đời buổi học.
- Leader điều chỉnh T04 sang quản lý vào/ra, accept/reject, kiểm tra thành viên
  với phòng thuộc nhóm; meet độc lập chỉ áp dụng duyệt tham gia.
- Người thực hiện giữ thêm lịch học và trạng thái bắt đầu/kết thúc, bỏ tích hợp
  LiveKit khỏi T04.
- Kế hoạch đã thống nhất yêu cầu đăng nhập cho cả hai loại phòng. Thành viên
  thường phải được duyệt; người có quyền quản lý được vào trực tiếp.

Phạm vi T04 gồm lịch học, phòng meet độc lập, trạng thái buổi học, hàng chờ,
duyệt tham gia, danh sách người trong phòng, rời phòng và cập nhật realtime.
T04 dùng tài khoản/phiên T01, nhóm T02 và phân quyền T03.

T04 chưa truyền mic/camera/màn hình, cấp token media, tạo/đóng phòng LiveKit,
ghi hình hoặc xử lý Egress. Code và cấu hình LiveKit đã có ở T03 được giữ nguyên;
luồng T04 mới phải hoạt động khi LiveKit không chạy. Chat, mute, ban và chuyển
quyền host không thuộc phạm vi này. Reject một yêu cầu không phải ban tài khoản.

## 2. Hai loại phòng

### Buổi học thuộc nhóm

- Luôn thuộc một nhóm đang hoạt động; nhóm được xác định từ dữ liệu server.
- Có tên, mô tả tùy chọn, lịch dự kiến và trạng thái.
- Người trong nhóm được xem lịch và chi tiết; global ADMIN được truy cập theo
  chính sách T03. Người ngoài nhóm không được xem nội dung buổi học hoặc xin vào.
- Biết mã/liên kết không thay thế điều kiện thành viên.
- HOST/OWNER/ADMIN được quản lý, kể cả khi không phải người tạo buổi học.

### Meet độc lập

- Không gắn với nhóm; không kiểm tra membership nhóm.
- Người đã đăng nhập và còn quyền sử dụng tài khoản được tạo meet.
- Người tạo là chủ phòng. Quyền quản lý thuộc chủ phòng hoặc global ADMIN;
  vai trò HOST/OWNER ở một nhóm khác không cấp quyền với meet này.
- Người có mã/liên kết và đã đăng nhập được xem thông tin tối thiểu để xin vào:
  tên phòng, tên chủ phòng, trạng thái và trạng thái yêu cầu của chính mình.
- Chưa được vào thì không xem danh sách người tham gia hoặc hàng chờ của host.
- Không cung cấp danh sách công khai mọi meet. Mã/liên kết là phương tiện tìm
  phòng, không phải bằng chứng đã được chấp nhận.
- Luồng giao diện chính là tạo và bắt đầu ngay. Bản ghi được tạo trước rồi
  chuyển sang LIVE bằng thao tác bắt đầu; mỗi thao tác phải chống gửi lặp.

## 3. Quyền theo thao tác

### Người quản lý buổi học thuộc nhóm

Quyền lấy từ `GroupAccessService` và `canHost` của T03 tại thời điểm thao tác:
HOST của nhóm, OWNER theo `groups.ownerId`, hoặc global ADMIN.

- Tạo buổi học trong nhóm, xem lịch và chi tiết.
- Sửa lịch/nội dung hoặc hủy khi SCHEDULED.
- Bắt đầu, kết thúc, xem hàng chờ và accept/reject.
- Vào trực tiếp khi LIVE, xem người tham gia và rời phòng.
- HOST không được quản lý membership nhóm chỉ vì có quyền quản lý buổi học.

### VIEWER của nhóm

- Xem danh sách, chi tiết và trạng thái buổi học.
- Xin vào khi LIVE; xem hoặc hủy yêu cầu của chính mình.
- Vào sau khi được chấp nhận, xem danh sách người trong phòng và rời phòng.
- Không tạo/sửa/hủy, bắt đầu/kết thúc, đọc hàng chờ người khác hoặc duyệt.

### Chủ meet độc lập và global ADMIN

- Có các quyền quản lý tương ứng: sửa/hủy trước khi bắt đầu, bắt đầu/kết thúc,
  xem hàng chờ, accept/reject và vào trực tiếp khi LIVE.
- Chỉ chủ meet được liệt kê meet đó trong danh sách meet do mình tạo.

### Người tham gia meet độc lập

- Xem thông tin tối thiểu bằng mã/liên kết, xin vào và xem/hủy yêu cầu của mình.
- Vào sau khi được duyệt, xem người trong phòng rồi rời phòng.
- Không có quyền điều khiển phòng hoặc đọc/duyệt yêu cầu của người khác.

### Tài khoản chưa đăng nhập, bị khóa hoặc phiên không còn hợp lệ

- Phải đăng nhập hoặc khôi phục phiên hợp lệ trước khi sử dụng chức năng T04.
- Không được gửi yêu cầu, duyệt, vào phòng hoặc tiếp tục nhận dữ liệu được bảo vệ.
- Đăng xuất hoặc tài khoản bị khóa làm mất quyền kết nối hiện tại. Một phiên
  đăng nhập hợp lệ khác của cùng người dùng vẫn phải kiểm tra quyền riêng.

## 4. Lịch và vòng đời

Trạng thái buổi học khác với trạng thái đăng nhập và yêu cầu tham gia:

```text
SCHEDULED -> LIVE -> ENDED
SCHEDULED -> CANCELLED
```

- Buổi học thuộc nhóm mới tạo ở SCHEDULED và bắt buộc có thời gian dự kiến.
  Meet độc lập không bắt buộc có lịch dự kiến.
- Giờ lưu và trả qua API theo UTC; giao diện đổi sang múi giờ người dùng.
- Đến giờ dự kiến không tự chuyển LIVE. Chỉ thao tác bắt đầu của người quản lý
  mới mở buổi học; trong phạm vi này người quản lý được bắt đầu sớm hoặc muộn.
- SCHEDULED: được sửa nội dung/lịch, bắt đầu hoặc hủy; chưa nhận yêu cầu vào.
- LIVE: nhận yêu cầu, duyệt và cho vào; không sửa lịch/nội dung hoặc hủy.
- ENDED/CANCELLED: chỉ đọc theo quyền, không nhận yêu cầu hoặc người vào mới,
  không sửa và không mở lại. Muốn tổ chức lại phải tạo buổi khác.
- Gọi bắt đầu khi đã LIVE trả trạng thái hiện tại; không tạo buổi/lượt vào trùng.
- Gọi kết thúc khi đã ENDED trả trạng thái hiện tại; không phát thêm sự kiện
  kết thúc nghiệp vụ. Hủy lại một buổi CANCELLED có kết quả tương tự.
- Những chuyển trạng thái khác bị từ chối, ví dụ kết thúc khi còn SCHEDULED
  hoặc bắt đầu một buổi CANCELLED/ENDED.
- Chủ phòng rời hoặc mất mạng không tự kết thúc buổi. Người có quyền quản lý
  có thể quay lại; người đã được duyệt vẫn được vào khi buổi còn LIVE.
- Kết thúc làm hết hiệu lực hàng chờ và quyền vào trước đó, đóng các lượt tham
  gia đang mở và thông báo cho người trong phòng. Không giữ ai ở trạng thái
  đang tham gia sau thời điểm kết thúc.

## 5. Xin vào, accept/reject và thực sự vào phòng

### Luồng người tham gia

1. Mở lịch hoặc mã/liên kết và đăng nhập nếu cần.
2. Backend xác minh tài khoản, quyền xem, trạng thái LIVE và membership nếu có.
3. Người dùng bấm xin vào; server tạo yêu cầu đang chờ.
4. Host thấy yêu cầu; người xin thấy màn hình chờ và có thể hủy.
5. Host accept hoặc reject. Server kiểm tra lại quyền host, điều kiện của người
   xin vào và trạng thái buổi học ngay tại lúc quyết định.
6. Khi accept, người xin được phép vào; khi reject, giao diện hiển thị bị từ chối.
7. Người đã được accept xác nhận vào phòng. Server kiểm tra lại điều kiện và
   ghi nhận thời điểm vào rồi mới cho đọc dữ liệu dành cho người trong phòng.

Người quản lý bỏ qua hàng chờ, nhưng vẫn phải qua bước xác nhận vào để được
ghi nhận là đang tham gia. Bắt đầu buổi học không tự ghi người quản lý vào phòng.

### Quy tắc yêu cầu

- Mỗi người chỉ có một yêu cầu đang chờ trong một buổi; gửi lặp trả yêu cầu cũ.
- Quyết định accept/reject là nguyên tử. Hai người quản lý xử lý đồng thời
  không được ghi hai kết quả trái ngược; yêu cầu đã có quyết định không bị ghi đè.
- Hủy yêu cầu chỉ áp dụng với yêu cầu đang chờ của chính người gửi.
- Người bị reject hoặc đã hủy được chủ động xin lại bằng yêu cầu mới khi LIVE;
  refresh hoặc retry mạng không tự tạo yêu cầu mới. Lịch sử quyết định được giữ.
- Được accept chưa đồng nghĩa với đã vào phòng hoặc được tính đang tham gia.
- Quyền vào sau accept có hiệu lực khi buổi còn LIVE và các điều kiện truy cập
  còn hợp lệ. Nó hết hiệu lực khi chủ động rời, bị thu hồi quyền hoặc buổi kết thúc.
- Chấp nhận không cấp quyền HOST, không thêm membership nhóm và không cho phép
  duyệt người khác. Người xin không được tự gửi role, người duyệt hay kết quả.
- Yêu cầu của người khác chỉ hiển thị cho người quản lý; người xin chỉ xem
  trạng thái của chính mình. Mọi API/socket đều kiểm tra quyền phía server.

## 6. Rời phòng, nhiều tab và mất kết nối

- Chủ động rời ghi nhận thời điểm rời và kết thúc lượt tham gia. Rời lặp không
  tạo thêm lượt hoặc sửa sai thời điểm rời đã ghi nhận.
- Người tham gia thường muốn vào lại sau khi chủ động rời phải xin duyệt lại.
  Người còn quyền quản lý được vào trực tiếp.
- Một người chỉ được tính một lần trong danh sách đang tham gia của một buổi,
  dù mở nhiều tab hoặc reconnect. Các lần vào lại sau khi rời vẫn có lịch sử riêng.
- Chủ động rời từ một tab kết thúc lượt tham gia hiện tại trên các tab cùng
  tài khoản trong buổi đó; các tab còn lại phải cập nhật theo server.
- Mất kết nối tạm thời không phải reject hay chủ động rời. Reconnect/refresh
  đọc lại trạng thái server và dùng lượt tham gia còn hiệu lực.
- Cần phân biệt người đang kết nối với người được duyệt. Khi mọi kết nối của
  một người mất quá thời hạn khôi phục, kết thúc lượt hiện tại và cập nhật danh
  sách. Thời hạn kỹ thuật và heartbeat sẽ được định nghĩa ở mục realtime.
- Sau khi hết thời hạn khôi phục, người tham gia thường phải xin vào lại;
  không được dùng kết quả accept của lượt đã kết thúc để vào thẳng.

## 7. Thay đổi quyền trong khi buổi đang mở

- Xóa membership/khóa tài khoản phải chặn yêu cầu và quyền vào còn hiệu lực,
  kết thúc lượt tham gia liên quan, thu hồi quyền đọc dữ liệu phòng/realtime.
  Thêm lại membership không khôi phục kết quả accept đã bị thu hồi.
- Hạ HOST xuống VIEWER thu hồi quyền điều khiển và duyệt; người đã trong phòng
  vẫn được tham gia như VIEWER nếu còn membership. Chưa vào thì phải xin duyệt
  theo quyền hiện tại, không dùng đặc quyền vào trực tiếp trước đó.
- Nâng lên HOST cho phép quản lý/vào trực tiếp sau khi server xác minh quyền mới.
- Không dùng quyền đã lưu ở client hoặc chỉ chờ sự kiện socket để authorize.
- Phòng thuộc nhóm đã bị xóa không được truy cập. T02 phải chặn xóa nhóm khi có
  buổi LIVE với lỗi ACTIVE_SESSION; xóa nhóm và bắt đầu buổi phải chống xung đột.

## 8. Tình huống nghiệm thu nghiệp vụ

1. OWNER tạo lịch nhóm; VIEWER xem được lịch nhưng không sửa/bắt đầu được.
2. Trước LIVE, thành viên chưa xin vào được. HOST bắt đầu thì được xin vào.
3. Thành viên xin vào, host accept, thành viên xác nhận vào; số người chỉ tăng
   ở bước vào. Người quản lý được vào trực tiếp.
4. Người ngoài nhóm có liên kết vẫn bị từ chối; accept không vượt kiểm tra nhóm.
5. Người tạo meet độc lập mở phòng; tài khoản ở bất kỳ nhóm nào được xin vào,
   nhưng chỉ chủ meet/global ADMIN được duyệt.
6. Host reject; người xin thấy kết quả, không vào được; có thể chủ động xin lại.
7. Người chờ hủy; host không còn accept được yêu cầu đã hủy đó.
8. Hai host accept/reject đồng thời chỉ có một quyết định có hiệu lực.
9. Gửi lặp xin vào/start/end hoặc refresh không tạo yêu cầu, buổi, lượt tham gia
   hay sự kiện kết thúc trùng.
10. Mở nhiều tab/reconnect không nhân đôi người tham gia. Chủ động rời cập nhật
    mọi tab; vào lại cần duyệt mới nếu không có quyền quản lý.
11. Xóa thành viên lúc đang chờ, đã được accept hoặc đang trong phòng đều thu hồi
    truy cập; thêm lại không phục hồi quyết định cũ. Hạ HOST thu hồi quyền duyệt.
12. Accept hoặc vào đồng thời với kết thúc không để ai được vào sau khi ENDED;
    quyết định/lượt vào đã commit trước đó cũng hết hiệu lực khi kết thúc.
13. Kết thúc đóng hàng chờ/lượt tham gia, giữ lịch sử và thông báo người dùng;
    không thể vào lại bằng liên kết hoặc kết quả accept cũ.
14. Nhóm có buổi LIVE không xóa được, kể cả khi start/delete chạy đồng thời.
15. Toàn bộ luồng T04 chạy khi LiveKit không được khởi động.

## 9. Điểm tích hợp cho các mục tiếp theo

- Database/contracts: phân biệt loại phòng, lifecycle, quyết định duyệt và
  lượt tham gia; không gộp tất cả vào một cột trạng thái.
- Backend: dùng lại auth T01 và GroupAccessService T03; lấy userId từ identity,
  groupId và chủ phòng từ bản ghi server. Meet cần kiểm tra chủ phòng riêng,
  không giả lập một membership nhóm để cấp quyền.
- Realtime: dữ liệu server là nguồn chính; thông báo hàng chờ chỉ tới người
  quản lý, quyết định tới người xin và danh sách tham gia tới người có quyền đọc.
  Không đổi nghĩa gateway/kênh nhóm T03 thành bằng chứng đã vào một buổi cụ thể.
- T04 giữ sự kiện nội bộ session.ended.v1 với eventId, sessionId, endedAt,
  version và cơ chế chống phát kết thúc nghiệp vụ trùng. Truyền lại cùng eventId
  khi retry là hợp lệ; chưa tạo tác vụ ghi hình hoặc gọi LiveKit.
- T05/T11 khi tích hợp phải kiểm tra lại quyền/trạng thái tại backend và nối
  quyền vào với media; kết quả accept T04 hiện chưa phải token kết nối media.
- Tài liệu OpenAPI, schema và test ở các mục sau phải bám các quy tắc trên.

Tham chiếu code hiện tại: [quy ước backend](backend-conventions.md),
[bàn giao nhóm T02](t02-handoff.md), [phân quyền T03](t03-handoff.md).
