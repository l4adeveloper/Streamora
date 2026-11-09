# Video preview local — điểm nối T13

Tài liệu tổng hợp upload, cấu hình, migration và nghiệm thu:
[bàn giao T16](t16-handoff.md). Player ở `/files` phát file thật; live preview ở
`/workspace` là giao diện minh họa riêng, chất lượng 720p/1080p ở đó không phải
output encoder đã được tạo. Chi tiết ở mục 7 tài liệu T16.

## Dùng ngay

Mở `http://127.0.0.1:3000/files`, upload MP4, WebM hoặc MOV rồi bấm biểu tượng
con mắt **Xem trước video**. Player có giao diện điều khiển trong khung video:
phát/dừng, thanh tua đỏ, âm lượng, thời gian và toàn màn hình. Bánh răng **Cài đặt**
chứa **Chất lượng** và **Tốc độ phát** (0.25× đến 2×). Thanh điều khiển tự ẩn
khi phát, xuất hiện lại khi di chuột/chạm hoặc dùng bàn phím.
MP4 H.264/AAC và WebM VP8/VP9 là lựa chọn phổ biến; container
MP4/MOV không đảm bảo mọi codec bên trong đều được trình duyệt hỗ trợ. Nếu không
phát được, UI hiện lỗi và vẫn giữ nút tải xuống.

Hiện menu chất lượng chỉ hiển thị **Bản gốc** vì dịch vụ encode AWS chưa được
thiết lập. Các bản encode do AWS tạo sau này; frontend chỉ phát nguồn được API
cấp quyền và không encode video. Menu **Cập nhật chất lượng** đọc lại nguồn từ
API. Đổi chất lượng giữ vị trí và tốc độ phát; đổi tốc độ thực hiện ngay trong
trình duyệt qua playbackRate, không cần một bản encode khác.

Phím tắt khi focus khung player: K/Space phát/dừng, ←/→ tua 5 giây, J/L tua 10
giây, M tắt/bật âm, F toàn màn hình, ↑/↓ âm lượng. Escape đóng menu trước khi
đóng cửa sổ xem trước. Menu có hỗ trợ phím mũi tên, Home và End.

Không có migration mới cho phần preview. Frontend vẫn ở 3000, API ở 4000;
file local phục vụ từ endpoint có token ký, còn S3 dùng presigned GetObject.
T16 vẫn giữ 4 file upload đồng thời và tổng tối đa 5 phần PUT.

## API playback

`POST /api/v1/files/:fileId/playback`, Bearer bắt buộc. Kiểm tra file AVAILABLE,
quyền nhóm hiện tại và khóa cùng group/file như download T15. Trả về:

```json
{
  "fileId": "<uuid>",
  "processing": { "status": "NOT_REQUESTED", "progressPercent": null },
  "sources": [
    {
      "id": "original",
      "label": "Bản gốc",
      "kind": "file",
      "mimeType": "video/webm",
      "height": null,
      "bitrate": null,
      "url": "<signed-url>",
      "expiresAt": "<ISO-8601>"
    }
  ]
}
```

Không trả objectKey, không nhận key hoặc chất lượng tự khai báo từ client.
Grant tối đa 60 giây, áp dụng cho cả bản gốc, rendition và HLS từ catalog. Nếu video báo lỗi sau khi URL hết hạn,
player xin grant mới, kiểm tra lại quyền rồi khôi phục vị trí/tốc độ/trạng thái
phát. Nút thử lại dùng cùng luồng. URL đã cấp là bearer URL tới hết TTL như T15.

Storage local hỗ trợ GET/HEAD, `Accept-Ranges: bytes`, single Range (bounded,
open-ended, suffix), HTTP 206 với Content-Range và 416 khi không thỏa mãn.
Đọc đĩa bằng stream giới hạn start/end; không đưa cả video vào RAM. Token,
expiry và chữ ký container vẫn được kiểm tra trước cả các request Range/HEAD.
Khi đóng player/đổi nguồn hoặc client ngắt request, controller hủy stream và
đóng FileHandle tường minh, không chờ garbage collection (bao gồm Node.js 26).
S3 đã có Range; URL GET giữ đúng MIME và Content-Disposition inline.

## AWS encoder / T13 nối vào đâu?

Theo lựa chọn hiện tại, việc encode nhiều chất lượng sẽ do dịch vụ AWS đảm
nhiệm (ví dụ AWS Elemental MediaConvert), được thiết lập sau. Luồng dự kiến:

`S3 nguồn → MediaConvert → HLS/renditions trên S3 → EventBridge COMPLETE → backend cập nhật catalog → player`

Đây là điểm nối thiết kế, chưa tạo AWS job, IAM role, queue hay EventBridge rule.
Backend chỉ nhận output hợp lệ của job đã hoàn tất và cung cấp metadata/URL;
player chọn chất lượng hoặc ABR từ các output thực tế. Tốc độ phát là chức năng
của player, độc lập với AWS encoder. AWS có thể tạo file MP4 hoặc gói HLS và
cung cấp thông tin output khi job COMPLETE:
[AWS MediaConvert outputs](https://docs.aws.amazon.com/mediaconvert/latest/ug/output-settings.html),
[EventBridge COMPLETE](https://docs.aws.amazon.com/mediaconvert/latest/ug/ev_status_complete.html).

`VideoRenditionCatalog` là điểm tích hợp nội bộ. Provider mặc định
`SourceOnlyVideoCatalog` trả NOT_REQUESTED, progress null và không có rendition.
T13 thay binding trong `FilesModule` bằng provider đọc trạng thái/output bền vững
từ database, qua client được truyền vào `read(file, db)`. Client này không còn nằm
trong transaction giữ khóa trong lúc ký URL; quyền truy cập được đọc lại trong
một transaction ngắn trước khi trả manifest.

Snapshot có:

- `status`: NOT_REQUESTED / QUEUED / PROCESSING / READY / FAILED.
- `progressPercent`: số thực tế hoặc null; không tự tăng tiến độ giả.
- `renditions`: chỉ output đã xuất bản hoàn chỉnh, gồm id, height, bitrate,
  mimeType và objectKey. Key progressive phải nằm dưới
  `groups/<groupId>/videos/<fileId>/<outputVersion>/...`.
- `hls` tùy chọn: URL master playlist đã được lớp phân phối cấp quyền toàn cây
  playlist/segment, kèm expiresAt. Đây là dữ liệu server tin cậy, không từ client.

`VideoPlaybackService` ký URL từng rendition MP4/WebM/MOV; UI tự thêm mức chất
lượng theo height thực tế. Khi đổi nguồn, giữ thời gian, tốc độ và trạng thái
phát/dừng. Khóa việc xóa/pin output và idempotency/outputVersion là trách nhiệm
adapter AWS/T13 khi ghi catalog; chỉ publish khi mọi output đã sẵn sàng.

Player đã có nhánh HLS qua lazy-load `hls.js`, chọn Tự động hoặc level lấy từ
master thực tế; dùng native HLS khi môi trường không hỗ trợ hls.js nhưng có
native playback. Để tránh nhãn trùng, khi đã có HLS levels thì selector dùng các
level đó cùng lựa chọn Bản gốc/Tự động. HLS engine được hủy khi đóng/đổi video.

**Chưa triển khai:** AWS encoder/job orchestration, xử lý EventBridge, retry/DLQ,
thumbnail, database trạng thái encode, API retry processing T13-02, pipeline
LIVE DVR/ABR hoặc CDN T14. Không dựng encoder cục bộ cho phần preview này.
Chưa kiểm thử HLS end-to-end qua S3/CDN. Một presigned URL cho master.m3u8
không tự cấp quyền cho các playlist con và segment: T13/T14 phải giải quyết phần
phân phối và CORS này trước khi bật source HLS trong catalog.

## Kiểm thử

```sh
npm run test:video-preview
npm run typecheck
```

Các test dùng database riêng như test T15/T16 (cần CREATEDB), không dùng database
nhóm để tạo dữ liệu fixture. Bộ test gồm Range/HEAD/416, expiry, container sai,
metadata source-only/rendition, chặn key chéo nhóm, phát WebM thật trong browser,
đổi giữa 640×360 và 320×180 có giữ playhead, và thu hồi quyền trước khi cấp grant mới.
Test rendition thay catalog trong fixture bằng hai video WebM có kích thước thật
khác nhau; không thay provider mặc định của ứng dụng.

Tham chiếu: [hls.js API](https://github.com/video-dev/hls.js/blob/master/docs/API.md),
[HTTP Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests).
