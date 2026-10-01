# ADR-049: Đường hủy đăng ký của người nhận — link được ký, có chỗ để bấm, và publish chặn thật

Status: Accepted

Đóng mục §4 "pháp lý" của sổ nợ rà soát, và sửa ba khẳng định sai mà repo đang mang. Dùng lại
nguyên khuôn ADR-043 §2 / migration 077 cho route công khai. Không đụng ADR-037, ADR-046,
ADR-047, ADR-048.

## Context

### Sổ nợ ghi một việc; đo ra ba

Sổ nợ §4 viết: *"`MISSING_UNSUBSCRIBE_URL` hiện chỉ ở mức warning, không chặn xuất bản."* Đó là
một phần ba sự thật. Đo ngày 2026-09-11:

| Khẳng định trong repo | Sự thật đo được |
|---|---|
| `publish-readiness.ts` nói với tác giả: *"email hàng loạt thiếu liên kết hủy đăng ký **sẽ bị chặn khi gửi** (BR-TPL-008)"* | **Không có cổng nào như vậy.** Không một tệp nào trong `apps/api` hay `apps/worker` từ chối gửi vì thiếu token |
| Chú thích của cùng tệp: *"the failure it prevents happens at SEND, not at publish, so blocking publish over it would stop the wrong step"* | Bước SEND đó **không tồn tại**, nên hoãn sang nó nghĩa là **không ai kiểm cả** |
| `ARCH-MAILCRAFT-BUSINESS-RULES` khẳng định ngay trong thông điệp assert: *"BR-TPL-008 fails at send time, not authoring time — this must warn, never block"* | Cùng một lý do đã hết hạn, lần này **được một test xanh giữ lại** |
| `{{unsubscribe_url}}` dựng `{origin}/unsubscribe/{recipientId}` | **Link không có đích.** Router web có 19 route, không có `/unsubscribe/:token`; API có 19 controller, không có cái nào cho việc này. Catch-all `*` nuốt nó thành trang không tìm thấy |

Tệp mint ra URL đó tự ghi điều cuối: *"Nothing redeems this URL yet (no public unsubscribe
endpoint exists in this catalogue's scope)."*

Gộp lại: sản phẩm **bắt tác giả** đặt link hủy đăng ký, **hứa** sẽ chặn nếu thiếu, và **không
có cách nào** thực hiện lời hứa đó — cũng không có cách nào để người nhận hủy thật.

Đây là lần thứ **năm** trong cùng phiên làm việc mà một lý do hết hạn nằm lại trong mã xanh.
Khác ba lần trước ở một điểm: lần này nó nằm trong **câu chữ hiển thị cho người dùng**.

### Vì sao không thể chỉ đổi warning thành blocking

Chặn publish khi thiếu token, mà không dựng đường redeem, sẽ buộc **mọi template xuất bản đều
mang một link 404**. Đó là *vẻ ngoài* của tuân thủ mà không có tuân thủ — tệ hơn cảnh báo trung
thực đang có.

### Và vì sao dựng đường redeem lại đảo ngược một quyết định bảo mật

`recipientVariableContext` ký link bằng… không gì cả. Lý do được ghi rõ và **đúng ở thời điểm
viết**: *"signing it would secure a capability that does not exist"*. Nhưng id người nhận là
UUID đi lại trong phản hồi API, bản export, log, và trong email được **chuyển tiếp**. Khoảnh
khắc có route redeem, "không ký" nghĩa là: ai cầm được một id thì hủy đăng ký được người đó.

Nên ADR này không thể chỉ *thêm* một route. Nó phải đổi chữ ký của link cùng lúc.

### Đo: RLS chặn route công khai, đúng như 077 đã ghi

Route này `@Public()` — cú bấm đến từ mail client, không mang cookie nào. Đó chính là vị trí mà
`077_asset_serve_bypass.sql` đã mô tả rất kỹ. Kiểm lại trực tiếp cho bảng `recipient`
(2026-09-11, trong container thật):

```
psql -U eow_app -d eow -c "SELECT count(*) FROM recipient WHERE id='41829826-…';"
  count
  -----
      0          ← RLS: tenant_id = current_tenant_id(), mà hàm đó trả NULL khi chưa set

psql -U eow_app -d eow -c "SELECT * FROM find_unsubscribe_target('41829826-…');"
  email                          | already_unsubscribed
  schedule-http-…@example.test   | f          ← qua SECURITY DEFINER thì thấy
```

Không phải suy luận từ 077 — đo lại trên chính bảng này.

## Decision

### 1. Link được ký, và chữ ký LÀ năng lực

`unsubscribeUrlFor` xuất `{origin}/unsubscribe/{recipientId}.{signature}`.

Chữ ký là HMAC-SHA256 của `recipientId`, bằng một khoá **dẫn xuất theo mục đích** từ
`SESSION_SECRET`: `HMAC(SESSION_SECRET, "eow.unsubscribe.v1")`. Hai lý do, cả hai đều thực tế:

- **Không thêm biến môi trường bắt buộc.** Thêm một cái tốn bốn chỗ sửa trong tệp triển khai,
  và một biến mới bị quên là một môi trường hỏng.
- **Không dùng lại khoá thô cho hai việc.** Khoá phiên và khoá unsubscribe là hai khoá khác
  nhau, chung một nguồn.

**Không lưu trạng thái, không hết hạn.** Không có bảng token, không có TTL. Một link trong email
người ta giữ một năm vẫn phải chạy — một nút hủy đăng ký hết hạn là lỗi tuân thủ, không phải
thắng lợi bảo mật. Và token **tất định**, nên render lại một template cho ra HTML y hệt và hash
ảnh chụp (BR-SEND-012) không xê dịch.

**Không có tương thích ngược nào phải giữ.** Link cũ chưa ký đã không bao giờ redeem được — vì
không có route. Không có link đang chạy nào bị hỏng.

`LinkContext { webOrigin, unsubscribeSecret }` thay cho tham số `webOrigin: string` ở mọi nơi
dựng ngữ cảnh người nhận, để **không call site nào quên được chữ ký** — `tsc` tìm ra hết.

### 2. GET mô tả, POST mới hành động

Hai route, không phải một:

| | |
|---|---|
| `GET /api/v1/unsubscribe/:token` | trả `{ email, alreadyUnsubscribed }`. **Không đổi gì.** |
| `POST /api/v1/unsubscribe/:token` | thực hiện |

Đây không phải khẩu vị REST. **Bộ quét bảo mật email và trình xem trước link đều GET mọi URL
trong thư.** Một GET có tác dụng phụ sẽ hủy đăng ký những người chưa hề bấm — máy chủ thư của
họ bấm hộ. Cùng lý do RFC 8058 one-click dùng POST.

**Không gắn `CsrfGuard`, có chủ ý.** CSRF bảo vệ một *phiên* khỏi trang thứ ba hành động thay
người đã đăng nhập; ở đây không có phiên nào để cưỡi. Bên duy nhất kích hoạt được việc này cho
ai đó là bên đã cầm link của chính người đó.

Client gọi với `credentials: 'omit'` — người nhận tình cờ cũng là nhân viên đang đăng nhập phải
nhận đúng kết quả như người không đăng nhập.

### 3. Hai hàm SECURITY DEFINER hẹp, và hàm ghi chỉ biết hủy

`079_unsubscribe_redeem.sql`. Cùng hình dạng 077 (và 013 trước đó): `eow_app` vẫn bị RLS quản ở
mọi nơi khác, và được cấp đúng hai hàm cho đúng route này.

Hàm ghi `redeem_unsubscribe` được viết sao cho **vượt RLS không cho thêm quyền gì ngoài đúng
hành vi dự định**:

- Trạng thái đích là **hằng trong thân hàm**. Không có tham số cho nó, nên hàm này **chỉ có thể
  hủy đăng ký** — không bao giờ kích hoạt lại ai (BR-REC-004 dành việc đó cho Admin xác nhận
  tái đồng ý), không đặt `bounced` hay `paused`.
- Chạm đúng **hai cột**. Không email, không `custom_data`, không `tenant_id`.
- Nhận **một id**, không nhận đường dẫn, tenant hay vị từ nào.
- Người nhận đã xoá mềm (BR-GEN-006) vô hình với nó.

Năng lực **gọi** được hàm là chữ ký trong link, kiểm ở tầng API trước khi xuống đây. Hàm này cố
ý **không** là nơi thứ hai quyết định *ai* được hủy — nó chỉ quyết định *hủy nghĩa là gì*.

**Idempotent**: bấm lần hai báo thành công, không báo lỗi. Ý định của người nhận đã được thoả
mãn, và một trang lỗi sẽ đọc thành "việc hủy của bạn không ăn".

**Ghi audit trong cùng hàm** (BR-SEC-002), `actor_id` NULL vì người nhận không phải người dùng
của hệ thống — cùng hình dạng permission guard dùng khi không có ai để quy trách nhiệm.

### 4. Trang xác nhận nằm ngoài vỏ ứng dụng

Route `/unsubscribe/:token` đặt **ngoài `RequireAuth` và ngoài `AppShell`**. Người bấm link là
**người nhận**, không có tài khoản; vẽ cho họ thanh điều hướng của một workspace họ không vào
được là vô nghĩa.

Trang **không làm gì lúc tải**. Nó mô tả, rồi người nhận xác nhận — nửa còn lại của quyết định 2.

Token sai và người nhận đã bị xoá cho ra **cùng một câu trả lời**, vì API trả lời như nhau: một
trang phân biệt được hai thứ đó là một oracle cho biết id nào có thật.

Trang hiện **đầy đủ địa chỉ email**, không che. Che không được gì: một email chuyển tiếp làm lộ
token và địa chỉ cùng lúc, còn người nhận thì cần thấy đúng địa chỉ nào sắp bị hủy.

### 5. `MISSING_UNSUBSCRIBE_URL` chặn publish, và lời cảnh báo thôi nói sai

Chuyển từ `warnings` sang `blocking`. Câu chữ cũ hứa *"sẽ bị chặn khi gửi"* — lời hứa không có
thật — được thay bằng điều đúng: người nhận sẽ không có cách nào tự hủy, hãy chèn biến này
trước khi xuất bản.

Chặn được **bây giờ** vì ADR này dựng thứ làm cho yêu cầu đó có nghĩa. Trước đó, chặn sẽ chỉ ép
mọi email mang một link hỏng.

### Cái gì **không** đổi

- **Không có header `List-Unsubscribe`.** Vẫn chưa có tệp nào trong `apps/` đặt nó. Xem
  §Consequences — ghi là việc còn nợ, không giả vờ đã xong.
- **Không có trang "đăng ký lại".** BR-REC-004 giữ việc kích hoạt lại cho Admin xác nhận tái
  đồng ý; hàm ghi ở quyết định 3 **không thể** làm việc đó.
- **Không đụng logic gửi.** Người đã hủy vốn đã bị `audience-resolution.ts` loại
  (`status_unsubscribed`, BR-CMP-003/BR-REC-003) — phần đó đã đúng từ trước.

## Consequences

- **Người nhận hủy đăng ký được.** Đó là lý do tồn tại của ADR này, và cho tới hôm nay họ không
  thể.
- **Ba khẳng định sai trong repo được sửa**, gồm một câu hiển thị cho người dùng và một
  thông điệp assert trong `ARCH-MAILCRAFT-BUSINESS-RULES`.
- **Link chưa ký ngừng hoạt động** — nhưng chúng chưa bao giờ hoạt động, nên không mất gì. Đã
  kiểm: `GET /unsubscribe/{id trần}` trả 404.
- **`SESSION_SECRET` xoay vòng sẽ làm mọi link đã gửi ngừng redeem.** Đây là cái giá thật của
  việc không thêm biến riêng, và phải được ghi ở quy trình xoay khoá. Hiện chưa có quy trình
  đó — ghi vào sổ nợ.
- **Header `List-Unsubscribe` (RFC 8058) vẫn chưa có.** Link trong thân thư đã dựng và redeem
  được; nút "hủy đăng ký" gốc của Gmail/Apple Mail thì chưa, vì nó cần header do
  `smtp-provider.adapter.ts` đặt. Việc riêng, đã ghi.
- **Địa chỉ bưu chính / khối chân thư vẫn chưa có** (nửa còn lại của sổ nợ §4). ADR này làm nửa
  opt-out; nửa kia là quyết định riêng.
- **Đây là ADR đầu tiên mở một route công khai ghi dữ liệu.** Trước nó, route `@Public()` duy
  nhất có tác dụng ghi là không có — asset serving chỉ đọc. Bất kỳ route công khai nào sau này
  phải đọc lại quyết định 3 trước, vì nó là khuôn.
- **Cần cổng, mutation-test được:**

  | Cổng | Khẳng định |
  |---|---|
  | `unsubscribe-token.test.ts` | id trần bị từ chối; chữ ký của secret khác bị từ chối; đổi id giữ chữ ký bị từ chối; token hỏng không ném lỗi |
  | RLS (kiểu `asset-rls.test.ts`) | `eow_app` không tenant **không** đọc được `recipient` bằng query thường, **có** đọc được qua hàm; và `redeem_unsubscribe` không thể đặt trạng thái nào khác `unsubscribed` |
  | `ARCH-MAILCRAFT-BUSINESS-RULES` | BR-TPL-008 **chặn**, và link có chữ ký |

## Phương án đã cân nhắc và loại

1. **Chỉ đổi warning thành blocking.** Loại vì nó ép mọi template mang một link 404 — vẻ ngoài
   tuân thủ mà không tuân thủ, tệ hơn cảnh báo trung thực.
2. **Giữ link không ký, chỉ thêm route.** Loại vì đo được id người nhận không phải bí mật: nó
   nằm trong phản hồi API, bản export, log, và trong mọi email được chuyển tiếp. Ai cầm một id
   sẽ hủy đăng ký được người đó.
3. **Token có hạn / token một lần.** Loại vì một nút hủy đăng ký hết hạn là lỗi tuân thủ. Người
   ta hủy đăng ký từ email sáu tháng tuổi, và đó là lúc họ cần nó nhất.
4. **Bảng token phát theo từng lần gửi.** Loại vì phải ghi một hàng cho mỗi người nhận của mỗi
   chiến dịch, và làm hash ảnh chụp (BR-SEND-012) đổi theo mỗi lần render.
5. **GET là hủy luôn cho đỡ một bước.** Loại vì bộ quét bảo mật email GET mọi link trong thư —
   sẽ hủy đăng ký hàng loạt người chưa bấm gì.
6. **Cho `eow_app` quyền đọc/ghi `recipient` không cần tenant.** Loại vì nó gỡ RLS cho toàn bộ
   ứng dụng để phục vụ một route. Hai hàm hẹp làm đúng việc cần, và hàm ghi chỉ biết một hành
   vi duy nhất.
7. **Thêm `UNSUBSCRIBE_SECRET` riêng.** Loại vì một biến môi trường bắt buộc mới tốn bốn chỗ
   sửa và một môi trường quên nó là một môi trường hỏng; dẫn xuất theo mục đích cho cùng mức
   tách biệt khoá mà không thêm bề mặt vận hành.
