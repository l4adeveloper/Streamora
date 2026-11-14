# Cài T13 bằng AWS Management Console

Bản dành cho tài khoản dịch vụ **586481704097**, region **Tokyo (ap-northeast-1)**, user **streamora-developer**, bucket nguồn **streamora-file-storage**, web/API **18-138-205-52.sslip.io**. EC2 và database đang dùng tiếp tục chạy như hiện tại.

## Bước 1 — Mở đúng tài khoản và region

Đăng nhập AWS Console của tài khoản **586481704097** và chọn **Asia Pacific (Tokyo)**.

Người tạo stack cần quyền triển khai CloudFormation, S3, SQS, MediaConvert, EventBridge, CloudFront, Secrets Manager, Lambda và IAM. Các policy runtime trong ảnh bạn gửi chưa thể hiện đủ quyền tạo hạ tầng này; người có quyền triển khai trong tài khoản có thể thực hiện một lần. Ứng dụng sau đó vẫn dùng user streamora-developer hiện có.

Tạo tài nguyên/lưu lượng AWS có thể phát sinh phí. Kiểm tra danh sách resources trước khi Submit.

## Bước 2 — Upload một file

Trong thanh tìm kiếm dịch vụ, tìm **CloudFormation** rồi chọn:

**Create stack → With new resources (standard) → Choose an existing template → Upload a template file → Choose file**.

Chọn file **backend/infra/aws/video/cloudformation-console.yaml** trong project. Đây là file mới dành cho cách cài qua Console, khác hai template cần nhập secret/public key bằng tay.

Bấm **Next**.

## Bước 3 — Giữ nguyên bốn ô

Đặt **Stack name** là **streamora-t13-console**.

| Ô | Giá trị đã điền sẵn |
| --- | --- |
| SourceBucket | streamora-file-storage |
| WebOrigin | https://18-138-205-52.sslip.io |
| ApiDomain | 18-138-205-52.sslip.io |
| RuntimeUserName | streamora-developer |

Không cần nhập access key, public key hay private key vào màn hình này.

Bấm **Next**. Giữ mặc định phần options. Ở mục Capabilities, đánh dấu **I acknowledge that AWS CloudFormation might create IAM resources**. Bấm **Next**, đọc phần Review, rồi **Submit**. Vị trí checkbox có thể khác một chút theo giao diện Console.

AWS hướng dẫn thao tác tại [Create a stack from the CloudFormation console](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stack.html).

## Bước 4 — Đợi CREATE_COMPLETE

Theo dõi tab **Events** đến khi trạng thái stack là **CREATE_COMPLETE**. Nếu báo CREATE_FAILED/ROLLBACK, xem resource lỗi đầu tiên trong Events để biết quyền hoặc thuộc tính đang thiếu.

Template tự tạo SQS/MediaConvert/EventBridge, bucket output, CloudFront private và policy T13 gắn vào streamora-developer. Một Lambda chỉ phục vụ các thao tác cài đặt của stack sẽ tạo cặp khóa RSA bên trong AWS, lưu private key trong Secrets Manager và tự điền public key ID đúng. Encode video vẫn do MediaConvert thực hiện.

Không cần mở CloudShell, tự tạo khóa, dán secret hoặc cấu hình từng dịch vụ bằng tay. Template không tạo lại EC2, RDS, S3 nguồn, IVS hoặc DynamoDB hiện có.

## Bước 5 — Lấy cấu hình đã điền sẵn

Vào **stack → Outputs**, tìm dòng **VideoEnvironment**, copy toàn bộ giá trị. Khối này đã có queue URL, role ARN, domain CloudFront, secret ARN, account và region đúng với stack.

Trên EC2, cập nhật các biến tương ứng trong **backend/.env** hoặc nơi process manager đang cấp cấu hình cho backend. Mỗi biến chỉ để một lần. Giữ nguyên database URL, access token secret, bộ AWS credentials của streamora-developer và cấu hình IVS/DynamoDB đang hoạt động.

Đây là bước nối ứng dụng với tài nguyên mới: tạo stack trong Console không tự sửa file trên EC2. Không đưa khối cấu hình backend vào frontend.

## Bước 6 — Chạy API và video worker

EC2 cần bản code T13 hiện tại, migrations đã áp và ffprobe có trong PATH. Khởi động lại API và chạy thêm video worker theo process manager đang dùng. Nếu cần chạy tay để kiểm tra, entry point của worker sau build là **backend/dist/video.worker.js**.

Giữ worker chạy cùng ứng dụng; chỉ API thì queue sẽ chưa được xử lý. API và worker dùng cùng database và bộ credentials của streamora-developer, dù EC2 thuộc tài khoản khác.

## Bước 7 — Thử video

Mở web HTTPS và upload một MP4 1080p ngắn qua thư viện. Trong MediaConvert tại Tokyo, phải thấy job mới rồi COMPLETE. Ứng dụng cần chuyển sang READY và player hiển thị các chất lượng thật. Xem quá 60 giây để kiểm tra gia hạn quyền xem.

Nếu cần 4K, sau khi thử ổn đổi VIDEO_MAX_QUALITY từ 1080 sang 2160 và upload nguồn UHD thật.

## Hai điểm cần kiểm tra khi xem video

- Web/API phải truy cập được qua **https://18-138-205-52.sslip.io**, certificate hợp lệ và route `/api/v1/` tới backend. sslip.io cung cấp DNS, không tự cung cấp HTTPS. Template không cấp certificate cho EC2.
- Web sslip.io và domain CloudFront mặc định khác site. Nếu trình duyệt chặn cookie bên thứ ba, media có thể lỗi 403. Khi thử nghiệm có thể cần ngoại lệ cookie riêng cho trang; bản này không loại bỏ giới hạn đó. Muốn hỗ trợ ổn định mọi trình duyệt cần domain cùng site hoặc thêm delivery proxy vào code/Nginx. Xem [giải thích cookie](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies).

Template này triển khai video upload VOD. Phần tự gắn bản ghi IVS vào phiên học/thư viện vẫn phụ thuộc mapping T11; IVS đang chạy không tự chứng minh phần nối đó đã hoàn tất.

Đã kiểm tra local cấu trúc template, quan hệ phụ thuộc, tạo/bind khóa, thử lại/update và rollback/delete; không đưa private key vào Outputs hoặc phản hồi CloudFormation. Chưa triển khai/nghiệm thu template trên AWS thực. Secret và bucket output được Retain khi xóa stack để không mất khóa/video.
