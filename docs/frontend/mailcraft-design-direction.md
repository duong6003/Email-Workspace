# Mailcraft — Định hướng, ý tưởng và lưu ý khi sáng tạo

**Đối tượng:** đội xây prototype Mailcraft.

> Đây **không phải** bản đặc tả kỹ thuật, và cũng không phải danh sách rào chắn.
> Mục tiêu duy nhất: cho bạn đủ bối cảnh để sáng tạo đúng hướng.
> Phần lớn ràng buộc kỹ thuật nhắc tới ở đây nằm trong mã nguồn của **chúng tôi** và **sửa được**. Nếu thiết kế của bạn cần chúng tôi mở gì ra, hãy nói — đừng tự cắt ý tưởng.

---

## 1. Mailcraft đứng ở đâu

**Email Operations Workspace (EOW)** là hệ thống vận hành: người nhận, biến dữ liệu, chiến dịch, gửi, lịch sử gửi, phân quyền.

**Mailcraft** là nơi nội dung được tạo ra. Hệ thống riêng, engine riêng, giao diện riêng — nhưng cùng một hệ sinh thái.

Người dùng sẽ có hai con đường tạo template:

- **Import HTML có sẵn** — EOW lo, bằng một code editor tử tế. Dành cho người đã có file từ designer.
- **Tạo qua Mailcraft** — dành cho tất cả những người còn lại.

Mailcraft không phải phương án dự phòng. Nó phải là con đường mà người ta **muốn** chọn.

---

## 2. Ai sẽ dùng, và hôm nay họ đang khổ vì gì

Nhìn vào chính nội dung trong sản phẩm hiện tại — "Chào mừng nhân viên tháng 8", danh sách nhân viên, email onboarding — người dùng thật là **nhân sự và marketing nội bộ, làm việc bằng tiếng Việt, không biết HTML**.

Quy trình của họ hôm nay: đi xin file HTML từ một người biết code, chờ, upload lên, phát hiện sai, quay lại xin sửa.

Mailcraft xóa bỏ vòng lặp đó.

> **Thước đo thành công:** một người phụ trách nhân sự tự dựng xong email onboarding trong mười phút mà không phải hỏi ai.

Đồng thời không được đánh mất nhóm còn lại: người có kỹ thuật vẫn phải xuống được tới HTML khi cần.

---

## 3. Tinh thần thị giác

Brief 34 điểm đã mô tả rõ hướng premium / clean / minimal. Phần này chỉ bổ sung bối cảnh riêng của hệ sinh thái.

**EOW hiện tại** có ngôn ngữ thị giác riêng: nền ấm `#f7f5f6`, accent coral `#e85b37`, đường viền rất nhạt `#e9e5e7`, bo góc 8–14px, đổ bóng mềm và thưa (`0 12px 34px rgba(58,36,31,.07)`), chữ nhỏ và đặc. Cảm giác tổng thể: gọn, ấm, không lạnh lẽo kiểu dashboard doanh nghiệp.

**Mailcraft không cần sao chép.** Nhưng nên **cùng họ hàng**: khi người dùng bấm "Tạo qua Mailcraft" từ trong EOW, họ không được cảm thấy vừa nhảy sang sản phẩm của một công ty khác.

Cách nghĩ tôi đề xuất:

> EOW là **bản compact** — nhiều dữ liệu, mật độ cao, làm việc nhanh.
> Mailcraft là **bản studio** — rộng rãi hơn, typography cao cấp hơn, ít chrome hơn, canvas là trung tâm.

Cùng một gia đình accent ấm, cùng độ mềm của bo góc và bóng đổ. Khác ở nhịp thở.

Token EOW hiện có, để bạn map khi cần:

```
--ink #262229    --muted #77717a    --line #e9e5e7
--surface #fff   --canvas #f7f5f6
--coral #e85b37  --coral-dark #c94527  --coral-soft #fff0e8
--green #158163  --amber #b46b12
--radius-sm 8px  --radius-md 12px   --radius-lg 14px
--shadow 0 12px 34px rgba(58,36,31,.07)
```

Đề nghị duy nhất về mặt kỹ thuật ở giai đoạn này: **khai báo token tập trung một chỗ**, đừng rải màu cứng khắp component. Chỉ vậy là đủ để map sau.

---

## 4. Năm thứ khiến Mailcraft khác một page builder đổi tên

Đây là phần tôi mong bên bạn khai thác nhất — vì đó là lợi thế sẵn có mà Unlayer, Beefree hay Stripo **không** có.

### 4.1 Biến dữ liệu là công dân hạng nhất

EOW đã có sẵn mô hình biến bốn tầng, đang chạy thật:

- **Hệ thống** — mặc định có sẵn
- **Dùng chung** — khai báo một lần, dùng toàn workspace
- **Dữ liệu người nhận** — lấy từ hồ sơ từng người
- **Riêng template này** — chỉ tồn tại trong template đó

Mỗi biến có thể **bắt buộc**, có thể có **giá trị mặc định**, và một số biến cho phép **từng chiến dịch ghi đè** giá trị cho lượt gửi đó.

Đây là tài sản thật. Nếu Mailcraft biến việc chèn, tra cứu và kiểm biến thành trải nghiệm mượt nhất mà người dùng từng gặp, đó là điểm khác biệt không sao chép được.

### 4.2 Xem trước bằng người thật, không phải dữ liệu giả

EOW biết chính xác ai sẽ nhận email này. Preview không cần bịa "John Doe" — nó có thể duyệt qua những người nhận thật, và chỉ ra ai đang **thiếu dữ liệu** khiến email của họ sẽ có chỗ trống.

Đó là một trải nghiệm preview khác hẳn về chất so với việc thu nhỏ canvas lại.

### 4.3 Trợ lý soát lỗi, không phải bảng mã lỗi

EOW đã tự kiểm: ảnh thiếu mô tả alt, liên kết hỏng, liên kết còn để địa chỉ mẫu, thiếu bản text thuần, HTML quá nặng.

Ý tưởng: đừng trình bày chúng như một bảng lỗi kỹ thuật. Hãy nghĩ về một **người soát lỗi thân thiện** ngồi cạnh canvas, nói bằng tiếng Việt đời thường: *"Ba tấm ảnh chưa có mô tả — người dùng chặn ảnh sẽ không hiểu email nói gì."*

### 4.4 Lịch sử an toàn tuyệt đối

Bản đã xuất bản trong EOW là **bất biến** — không ai sửa được, kể cả quản trị viên. Email đã gửi đi luôn truy ngược được về đúng nội dung tại thời điểm đó.

Đây là điểm bán hàng, không phải hạn chế kỹ thuật. Nên thể hiện ra, đừng giấu.

### 4.5 "Email-first" cụ thể là gì

Builder nào cũng nói email-first. Ở đây nó có nghĩa rất cụ thể:

- **Bản text thuần** là công dân thật, không phải phụ lục — nhiều hộp thư và trình đọc màn hình chỉ đọc nó.
- **Ảnh bị chặn mặc định** ở rất nhiều hộp thư doanh nghiệp → alt text không phải tính năng accessibility, nó là nội dung.
- **Mỗi hộp thư render một kiểu** → thứ bạn thấy trên canvas không phải thứ người nhận thấy, và UI nên trung thực về điều đó.

---

## 5. Lưu ý khi sáng tạo

Chia làm hai nhóm rất khác nhau. Đọc kỹ chỗ phân nhóm này, vì nó quyết định bạn được thoải mái tới đâu.

### 5.1 Ba điều thực sự cứng

Đây là bản chất hệ thống, không phải lựa chọn triển khai. Đừng thiết kế ngược lại.

**a. HTML là bản ghi cuối cùng.**
Dữ liệu dự án của editor chỉ phục vụ việc chỉnh sửa lại; thứ được gửi đi luôn là HTML. Hệ quả: **không có tính năng nào chỉ tồn tại trên canvas mà không biểu diễn được ra HTML**. Nếu người dùng thấy nó mà email không có, đó là lỗi thiết kế.

**b. Biến chỉ có dạng `{{ten_bien}}`.**
Không điều kiện, không vòng lặp, không hàm. Lý do: nội dung được render phía máy chủ cho hàng loạt người nhận, và mọi biểu thức tùy ý đều là rủi ro an toàn.
Nếu Mailcraft thấy cần nội dung theo điều kiện — cứ đề xuất. Nhưng hãy biết rằng đó là thay đổi ở tầng gửi email, không phải một tính năng UI.

**c. Bản đã xuất bản không sửa được.**
"Khôi phục phiên bản cũ" nghĩa là **tạo một bản nháp mới** từ nội dung đó — không phải ghi đè lịch sử. Đừng thiết kế nút "Sửa phiên bản này".

### 5.2 Những thứ trông như ràng buộc, nhưng sửa được

Bộ lọc HTML của EOW là **mã nguồn của chúng tôi**. Hiện tại nó khá chặt, nhưng chặt là lựa chọn hôm nay, không phải định mệnh.

| Hiện tại | Thái độ |
|---|---|
| CSS chỉ giữ ~20 thuộc tính; `border-radius`, `background-image`, `box-shadow` bị xóa | **Mở được.** Nếu hệ block của bạn cần, chúng tôi mở |
| `@media` bị xóa → responsive phải làm kiểu fluid/hybrid | **Mở được**, nhưng cần kiểm chứng thực tế trên Outlook/Gmail trước |
| `id` và `data-*` bị xóa khỏi HTML lưu trữ | **Mở được.** Trong lúc chờ, đừng dựa vào chúng để ánh xạ dữ liệu |
| Ảnh chỉ nhận URL `https`, không nhúng base64 | Nên giữ — nhưng nghĩa là **cần một kho ảnh**, mà EOW chưa có |
| `<button>` không tồn tại trong email; nút bấm dựng bằng `<a>` + `<table>` | Bản chất của email, nên giữ |

Riêng dòng thứ tư đáng chú ý: **EOW hiện chưa có module lưu trữ ảnh nào.** Nếu Mailcraft thiết kế một asset manager tốt, khả năng rất cao chúng tôi sẽ xây kho ảnh **theo đúng hình dung của bạn** — nên cứ thiết kế nó cho đàng hoàng, đừng né.

> Nguyên tắc chung: **đừng tự cắt ý tưởng vì sợ bộ lọc HTML.** Ghi lại thứ bạn cần, chúng tôi mở. Chỉ có ba điều ở §5.1 là không thương lượng.

### 5.3 Vài lưu ý nhỏ, dễ vướng

- **`href="#"` sẽ bị đánh dấu là "liên kết mẫu chưa thay".** Block mặc định nên ở trạng thái *"chưa đặt liên kết"* tường minh thay vì `#` — vừa sạch cảnh báo, vừa là UX tốt hơn.
- **Canvas email luôn nền sáng**, kể cả khi giao diện đang ở dark mode. Người dùng không được thiết kế email trên nền tối rồi nhận về email nền sáng.
- **Tiếng Việt dài hơn tiếng Anh 20–40%.** Đừng thiết kế nhãn chật.
- **Có phân quyền.** Sẽ có người chỉ được xem, không được sửa. Chế độ chỉ đọc nên được thiết kế cho đẹp, không phải để rơi vào màn hình lỗi.
- **Ba khổ màn hình cần tính:** 1440×900, 768×1024, 390×844. Riêng 390 chỉ cần là chế độ xem tử tế — không ai dựng email trên điện thoại.

---

## 6. Prototype giai đoạn này nên trả lời được gì

Hiểu rằng lúc này bạn đang làm phần tinh thần UI, theme và định hướng — chưa phải engine. Vậy prototype nên đủ để trả lời được:

- Nhìn ba giây có thấy đây là **công cụ sáng tạo**, không phải trang quản trị không?
- **Canvas có phải trung tâm** không, hay các panel đang tranh chỗ với nó?
- Người **không biết HTML** mở lên có biết bắt đầu từ đâu không?
- **Chèn biến** có mượt không, hay vẫn phải nhớ cú pháp?
- **Bảng thuộc tính** có làm người ta ngợp không?
- Chuyển **desktop / mobile** có tự nhiên không?
- **Trạng thái rỗng, đang lưu, có lỗi** đã được thiết kế chưa, hay để sau?

Chưa cần ở giai đoạn này: engine thật, lưu trữ thật, phân quyền, và toàn bộ phần tích hợp API.

---

## 7. Khi nào bàn tới tích hợp

Khi prototype đã chốt được identity và cấu trúc thông tin, lúc đó mới bàn tới lớp adapter giữa hai hệ thống — để UI của Mailcraft không dính chặt vào engine bên dưới, và để cùng một Mailcraft chạy được với cả dữ liệu mẫu lẫn dữ liệu thật của EOW.

Bên EOW đã có sẵn tài liệu kỹ thuật chi tiết cho bước đó: danh mục biến, endpoint xem trước, bộ kiểm nội dung, và cơ chế lưu chống ghi đè. Không cần đọc bây giờ.

Việc bây giờ là làm cho Mailcraft **đẹp và đúng tinh thần** đã.
