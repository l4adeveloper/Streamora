# Folder buổi học và tóm tắt Azure OpenAI

## Luồng sử dụng

Trong **Tạo cuộc họp** hoặc **Lên lịch buổi học** của Group, tích **Tạo folder cho buổi học**. Chọn các tài liệu sẵn có theo thư mục và tên; tài liệu được di chuyển vào folder mới. Có thể để trống và tải lên hoặc thêm tài liệu sau.

Folder hiển thị nhãn **Buổi học** và gắn cố định với ID cuộc họp, không dựa vào tên hoặc đường dẫn. Khi bản ghi được tải lên/hoàn tất, backend tự đặt vào folder đó, bao gồm trường hợp cuộc họp đã kết thúc và folder đã đổi tên. Cuộc họp không chọn tùy chọn này tiếp tục hoạt động như trước.

Mở folder rồi chọn **Tài liệu & Tóm tắt AI**, hoặc bấm **Tóm tắt AI** ngay trên thẻ folder. Host/owner/admin có thể thêm tài liệu sẵn có, xem prompt cơ sở và nhập tối đa 4.000 ký tự yêu cầu bổ sung. Sau khi cuộc họp kết thúc, bản ghi đã lưu xong và transcript sẵn sàng, bấm tạo tóm tắt. Nguồn gồm bản ghi và các tài liệu trong folder, kể cả thư mục con; không dùng các bản tóm tắt AI trước làm đầu vào.

Kết quả được lưu thành file `.md` trong chính folder đó và hiển thị ở cửa sổ tóm tắt. Cùng nguồn/prompt/model sẽ tái sử dụng kết quả; thay tài liệu hoặc yêu cầu sẽ tạo phiên bản khác. Các file kết quả cũ vẫn ở folder. Nếu nguồn có tài liệu chưa công bố, kết quả cũng ở trạng thái chờ công bố. Thành viên xem kết quả đã công bố theo quyền nhóm; chỉ host/owner/admin được gửi yêu cầu AI.

Phạm vi folder này là Meeting trong Group/Workspace. Meeting độc lập chưa có thư viện nhóm nên không hiển thị tùy chọn tạo folder.

## Cấu hình

Backend dùng Azure OpenAI của resource `streamora-openai`, không gửi dữ liệu sang Gemini. Điền ở `backend/.env` hoặc secret của deployment:

```dotenv
AZURE_OPENAI_ENDPOINT=https://<resource-name>.openai.azure.com/
AZURE_OPENAI_API_KEY=<key-cua-resource>
AZURE_OPENAI_DEPLOYMENT=<ten-deployment-thuc-te>
```

Endpoint phải lấy từ Keys and Endpoint/Foundry; không phải URL trang Azure Portal. Tên deployment lấy từ trang Deployments. Chọn deployment hỗ trợ **Responses API v1**, structured outputs và đọc PDF/ảnh nếu dùng các tài liệu đó (ví dụ deployment GPT-4.1 có các khả năng tương ứng). Tên resource không thay thế được tên deployment. Không đưa API key vào frontend hoặc commit `.env`.

Backend gọi `POST /openai/v1/responses`, với tên deployment ở trường `model`, `store: false`, JSON Schema và prompt cơ sở phía server. Provider adapter không trả lỗi thô hoặc key ra client. Nguồn: [Azure Responses API](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/responses), [Azure structured outputs](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/structured-outputs).

Transcription tiếp tục dùng Azure Speech hiện có (`AZURE_SPEECH_REGION`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_LOCALES`). Nếu transcript chưa sẵn sàng, API thông báo chờ; không tạo nội dung thay cho phần âm thanh chưa được chép lời.

Migration: `20261116000100_lesson_folders`. Từ gốc repository:

```sh
npm run db:migrate --workspace=@streamora/api
npm run build --workspace=@streamora/api
```

Khởi động lại backend sau khi cập nhật env/migration. Worker tóm tắt chỉ chạy khi cấu hình Azure OpenAI đầy đủ. Đường ghi S3 cần cho phép `s3:PutObject` dưới `groups/*/summaries/*` trong bucket tài liệu hiện tại; đường local dùng cùng storage adapter.

## Hợp đồng backend

- `POST /groups/:groupId/sessions`: thêm `createLessonFolder?: boolean`, `materialFileIds?: UUID[]` (tối đa 50). Tạo cuộc họp, folder và di chuyển tài liệu trong cùng transaction/idempotency key. Chặn tài liệu không sẵn sàng/khác nhóm.
- Session trả `lessonFolderId` khi tạo và khi đọc chi tiết. Folder trả `kind: LESSON | REGULAR`, `sessionId`.
- `POST /folders/:folderId/materials`: `{fileIds}` thêm tài liệu về sau, xác thực quyền host và Group.
- `GET /folders/:folderId/summary?summaryId=...`: trạng thái, prompt cơ sở, khả dụng AI và kết quả đọc theo quyền nhóm.
- `POST /folders/:folderId/summary`: `{customPrompt?: string}`, trả 202; job xử lý nền, không giữ kết nối HTTP trong lúc chờ model.

Job có claim/lease, tối đa 3 lần thử với lỗi tạm thời/429 và chống trùng yêu cầu đồng thời. Fingerprint JSON được chuẩn hóa key trước khi hash để tương thích PostgreSQL JSONB. Worker kiểm tra quyền trước khi đọc/gửi và trước khi lưu; kiểm tra lại nguồn và ownership lease trước khi công bố kết quả. Thay đổi nguồn trong khi xử lý làm job thất bại rõ ràng để host tạo lại.

## Nguồn và giới hạn

- Transcript các video (bao gồm mốc thời gian), PDF, PNG/JPEG/WebP, văn bản UTF-8/Markdown/CSV/JSON.
- Tối đa 50 file, 100 thư mục con, tổng 18 MB tài liệu và 240.000 ký tự transcript; file văn bản tối đa 240.000 byte/file. Không âm thầm bỏ các file không hỗ trợ. Word/PowerPoint/Excel cần chuyển sang PDF trước.
- PDF và ảnh được gửi inline cho model; không cấp URL truy cập công khai cho AI.
- Prompt cơ sở tách lời giảng khỏi tài liệu tham khảo, không suy đoán tên người nói, người được giao việc, hạn chót hoặc quyết định chưa được xác nhận. Yêu cầu thêm không thay thế prompt cơ sở.
- Không tự gửi email, thông báo bên ngoài hoặc thực hiện tác vụ từ nội dung tài liệu/prompt.
- Folder buổi học chưa kết thúc, còn bản ghi đang lưu hoặc đang tóm tắt sẽ không bị xóa. Sau đó có thể xóa theo cơ chế thư mục hiện có.

## Kiểm chứng

```sh
node --test --test-concurrency=1 backend/test/lesson-folders.test.cjs backend/test/azure-lesson-summary.test.cjs
node --test backend/test/frontend/lesson-folders-ui.test.cjs
npm run typecheck --workspace=@streamora/web
```

Các test dùng database cô lập và provider AI giả lập, không lấy dữ liệu lớp thật hoặc gọi Azure thật. Kiểm tra tạo tức thời/lên lịch ở API, tài liệu trước/sau, idempotency, ghi hình sau khi kết thúc và đổi tên folder, summary trong đúng folder, quyền chéo nhóm/viewer/draft, nguồn bị đổi, output sai nguồn, yêu cầu đồng thời và host bị thu hồi quyền. Test trình duyệt build frontend riêng, thực hiện luồng tạo folder/chọn và thêm tài liệu/nhập prompt/lưu tóm tắt, kiểm tra desktop và mobile.

Lượt kiểm tra hồi quy `meeting-access.test.cjs` gặp lỗi channel:join do ChatStore mới trên main yêu cầu DynamoDB local cổng 8000. Đây là dịch vụ riêng; luồng folder không dùng DynamoDB. Cần bật DynamoDB theo tài liệu chat để chạy kiểm tra chat đầy đủ.
