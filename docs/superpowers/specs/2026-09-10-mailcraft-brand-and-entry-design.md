# Mailcraft: nhận diện thương hiệu con, lối vào, và ba lỗi đo được

Ngày: 2026-09-10 · Trạng thái: **chờ duyệt**

**Quyết định nền:** Mailcraft là **thương hiệu con** của MailSpace, tích hợp trực tiếp
trong app — không phải một sản phẩm rời, cũng không phải một tính năng vô danh. Mọi lựa
chọn dưới đây suy ra từ câu đó.

**Liên quan:** ADR-037 (`id` bị loại khỏi `emailAttributes`; template import chỉ có HTML,
không có cây thành phần) · ADR-039 · ADR-041 (focus mode là biến thể của shell) ·
ADR-044 (prototype Mailcraft là gốc thị giác) · `ARCH-HANDOFF`
(`handoff-fidelity.test.ts`) · `ARCH-MAILCRAFT-DOM` (`mailcraft-dom.test.ts`)

---

## 0. Hai cổng ràng buộc mọi thứ dưới đây

`ARCH-HANDOFF` canh theo kiểu **trừ**: mọi dòng của `studio.css` và
`ui-handoff-v2/globals.css` phải còn nguyên, không sửa, đúng thứ tự gốc. **Thêm thì tự
do; sửa và xoá thì không.** Vì vậy mọi thay đổi thị giác dưới đây là *append override*,
không bao giờ là sửa dòng cũ.

`ARCH-MAILCRAFT-DOM` đòi mọi class mà JSX prototype dùng phải hoặc đang được dùng trong
`apps/web/src`, hoặc nằm trong sổ đăng ký kèm **địa chỉ**: một slice có lịch, hoặc ADR đã
bác nó. Sổ này tồn tại vì đã có tiền lệ: khối `contact` — 1 trong 16 `Kind` của prototype
— biến mất mà mọi cổng vẫn xanh, và không ai quyết bỏ nó cả.

Hai việc trong spec này là **lệch có chủ ý** khỏi prototype (§3 và §5). Cả hai đều phải
vào sổ, kèm lý do, trước khi code chạm vào.

---

## 1. Lỗi 409 khi tạo template — đo được, không phải giả thuyết

`startMailcraft()` luôn POST tên cố định `'Email chưa đặt tên'`. Tên template là duy nhất
theo tenant (unique index; service bắt `23505` và ném `TEMPLATE_NAME_CONFLICT`).

Đo trực tiếp trên API đang chạy, tenant Acme Demo:

| Gọi | Kết quả |
|---|---|
| POST tên `'Email chưa đặt tên'` | **409 `TEMPLATE_NAME_CONFLICT`** |
| POST lại tên đó | 409 |
| POST một tên chưa tồn tại | **201** |

Nghĩa là nút "Soạn bằng Mailcraft" **hỏng vĩnh viễn** kể từ lần dùng thứ hai trong mỗi
tenant — không phải thỉnh thoảng.

**Hướng đã cân nhắc và bác:** cho POST `/templates` gắn bản mới vào template trùng tên.
Bác vì ba lẽ. Version đã là khái niệm hạng nhất và đã có cửa riêng (`PATCH /templates/:id`
sửa nháp; `GET|POST /templates/:id/versions…`). Cho "tạo mới" đôi khi không tạo mới nghĩa
là một người bấm nút có thể ghi vào template của người khác chỉ vì trùng tên — đó là vấn
đề toàn vẹn dữ liệu. Và nó đổi hợp đồng API đã công bố, thứ `contracts:compat-check` đang
canh.

**Quyết định:** tên nháp mặc định phải **duy nhất từ lúc sinh ra**. Sửa ở client, một
chỗ, không đụng API, không đụng hợp đồng. 409 giữ nguyên cho trường hợp người dùng *tự*
đặt trùng tên — lúc đó báo lỗi là đúng; chỉ cần thông điệp nói rõ tên nào trùng.

---

## 2. Nút back trong header Mailcraft — trả về đúng bản gốc

Prototype đặt back **bên trong `.v3-doc`**, là con đầu tiên, ngay trước tiêu đề, dạng
chevron `‹` không viền (`.v3-doc>button{border:0;background:transparent;font-size:25px}`
— rule này *đã nằm sẵn* trong `globals.css` và hiện không style cho gì ở vị trí đó).

App đặt nó thành anh em, chen giữa logo và tiêu đề, dưới class tự chế
`focus-header-back`, hộp viền 34×34.

**Quyết định:** đưa nút vào trong `.v3-doc` như bản gốc. Đây là *khôi phục* độ trung
thành, không phải lệch thêm — cổng chỉ xanh hơn. `focus-header-back` giữ lại như hook CSS
nếu còn cần, nhưng thôi vẽ hộp viền.

---

## 3. Bỏ "Nhập HTML" khỏi rail của Mailcraft — **lệch có chủ ý, phải ghi sổ**

Nút này không mở trình import nào. Nó đặt `leaveStateRef.current = { overlay: 'import' }`
rồi **thoát khỏi builder** về `/templates`, và overlay import của EOW mở lên.

Nó được thiết kế vậy vì một lý do đúng: **template import về chỉ có HTML, không có cây
thành phần**, nên builder không dựng lại được để sửa. Import vì thế là hành động ở tầng
EOW, không phải tính năng của builder.

Nhưng một mục rail *rời khỏi màn hình đang đứng* là lời hứa sai với người dùng: rail là
nơi mở panel, không phải nơi thoát.

**Quyết định:** bỏ mục `import` khỏi rail Mailcraft. Import vẫn còn nguyên ở màn Templates.

**Đây là lệch khỏi prototype** (rail còn 9/10 mục) nên phải có dòng đăng ký trong
`ARCH-MAILCRAFT-DOM` với địa chỉ là spec này, chứ không xoá lặng lẽ.

Phạm vi chạm, đã tra: `workspace-shell.ts:54` (định nghĩa đích) và dòng 28 (union type);
ba khẳng định trong `workspace-shell.test.ts` (dòng 11, 37, 44); hai e2e spec
(`mailcraft-contrast-both-themes`, `mailcraft-dark-mode-completion`) đang đặc cách nó là
"mục rail duy nhất rời builder"; `leaveStateRef` và nhánh navigate trong `BuilderScreen`;
và `TemplatesScreen` đang nhận `location.state.overlay` để tự mở overlay.

`leaveStateRef` và đường `location.state` **giữ lại** — chúng vẫn phục vụ luồng Back có
xác nhận lưu nháp.

---

## 4. "Soạn bằng Mailcraft" phải đọc ra như mở một app con

Hiện là `.secondary-button` trung tính, đứng cạnh "Import HTML" đang là `.primary-button`
màu coral. Người dùng đọc ra: import là việc chính, Mailcraft là việc phụ. Ngược hoàn toàn
với thực tế.

**Quyết định:** nút này mang **nhận diện Mailcraft** — nền `--mc-primary` (`#173f33`),
kèm mark Mailcraft (§5) và tên sản phẩm — để nó đọc ra là *mở một ứng dụng*, không phải
*thực hiện một thao tác*. "Import HTML" hạ xuống nút phụ.

Ràng buộc phải kiểm khi làm: tương phản chữ trên `#173f33` ở cả hai theme, và nút không
được trông như nút chính thứ hai — chỉ một hành động chính trên màn đó.

---

## 5. Thiết kế lại logo Mailcraft — **lệch có chủ ý, phải ghi sổ**

Hiện là chữ **M** Georgia trong hộp bo `--mc-primary`. Đó là nhận diện của prototype.

**Vấn đề:** Mailcraft là thương hiệu con của MailSpace, nhưng mark hiện tại **không có
quan hệ hình thức nào** với mark MailSpace. Một chữ cái trong hộp cạnh một cây bút vẽ
vector — hai thứ rời rạc, không đọc ra quan hệ cha–con.

Ngoài ra có một lỗi đo được, độc lập với chuyện thẩm mỹ: chip nhận diện trong panel trái
render **chữ "A" cứng**. "A" được chép đúng từ prototype, nơi nó là chữ cái của một công
ty mẫu; sang app thì chip này hiển thị logo của *tenant hiện tại*, nên "A" không còn nghĩa
gì.

**Quyết định về phương pháp:** làm lại theo **đúng cách đã làm cho logo MailSpace** —
không gõ tay toạ độ bezier, mà dựng từ hình học đã có, rồi **hội tụ bằng đo đạc**: tỉ lệ
gần kề Gestalt, độ thuôn của khối mực, lệch khối lượng, lề, và đếm thành phần liên thông
ở đúng các cỡ pixel mà app vẽ.

**Quyết định về hình:** mark Mailcraft **suy ra từ mark MailSpace**, không vẽ mới. Cùng
họ hình (ngòi bút đã trích từ concept), khác màu (`--mc-primary` thay dải cam–đỏ đô) và
khác chi tiết đủ để phân biệt. Đó là cách thể hiện quan hệ thương hiệu con bằng hình,
thay vì bằng lời.

Lý do không vẽ mới: buổi thiết kế logo MailSpace đã chứng minh gõ tay path cho ra hình
thô, và bốn vòng thử đầu đều bị bác. Cái cứu được nó là trích contour thật rồi đo. Không
có concept Mailcraft nào để trích, nên nguồn hình học duy nhất đáng tin là mark đã có.

**Cần chốt trước khi dựng:** chữ trong chip nhận diện lấy chữ cái đầu của tenant, hay lấy
mark Mailcraft thu nhỏ.

---

## 6. `.v3-brand` mất chức năng — lỗi, không phải lựa chọn

Prototype để `.v3-brand` là `<button>` bấm được để về kho mẫu. App biến thành
`<span aria-hidden="true">`. Mất điều hướng, và trình đọc màn hình không đọc được tên sản
phẩm ở header.

**Quyết định:** trả lại thành `<button>`, bỏ `aria-hidden`. Khôi phục độ trung thành.

---

### 6b. Brand ở header chỉ còn icon — **lệch có chủ ý, phải ghi sổ**

Prototype vẽ `.v3-brand` là mark **kèm chữ** "Mailcraft", nên khối này rộng 100px. Rail
công cụ ngay dưới rộng 56px. Hai mép dọc cách nhau 44px, đủ gần để mắt đọc ra là *lệch*
chứ không phải là hai cột khác nhau — và đường kẻ dọc trong header (viền trái của
`.v3-doc`) rơi ở x=68 trong khi mép rail ở x=56.

**Quyết định:** bỏ chữ khỏi phần nhìn thấy, giữ nó trong `.visually-hidden` để tên sản
phẩm không biến mất khỏi trình đọc màn hình (§6 vừa mới trả lại chính thứ đó). Cột brand
ép về đúng 56px, và huỷ gap cho riêng `.v3-doc` để viền trái của nó nằm lên mép rail;
12px bị huỷ trả lại bằng padding nên chữ tiêu đề không xê dịch một pixel nào.

Đây là **lệch khỏi prototype**, không phải sửa lỗi port. Lý do chấp nhận: prototype vẽ
header rời, không có rail 56px bên dưới để phải khớp. Cái đúng của prototype là *có tên
sản phẩm ở header*, và điều đó vẫn đúng — chỉ khác kênh truyền đạt.

**Bằng chứng bắt buộc:** đo `getBoundingClientRect()` của `.v3-brand`, `.v3-doc` và
`.mc-tool-rail`; brand phải là 0..56, mép phải rail 56, viền trái `.v3-doc` tại 56, tâm
mark trùng tâm icon rail. Và `accessibleName` của nút vẫn phải là "Mailcraft".

---

## 7. Thứ tự làm

| # | Việc | Cổng | Rủi ro |
|---|---|---|---|
| 1 | §1 tên nháp duy nhất | không đụng | thấp — đang hỏng thật |
| 2 | §2 nút back vào `.v3-doc` | trả về bản gốc | thấp |
| 3 | §6 `.v3-brand` thành button | trả về bản gốc | thấp |
| 4 | §5 mark Mailcraft mới | **ghi sổ** | trung bình |
| 5 | §4 nút mở app con | không đụng | thấp, phụ thuộc 4 |
| 6 | §3 bỏ Nhập HTML khỏi rail | **ghi sổ** | trung bình — 7 chỗ chạm |
| 7 | §6b brand chỉ còn icon | **ghi sổ** | thấp — chỉ CSS và một `<span>` |

1–3 độc lập nhau, làm trước để có kết quả sớm. 4 phải xong trước 5 vì nút dùng mark. 6 để
cuối vì nó chạm nhiều tệp test nhất.

## 8. Kiểm chứng

Mỗi việc phải có bằng chứng đo được, không phải "nhìn thấy ổn":

- §1: gọi POST hai lần liên tiếp trong cùng tenant, cả hai phải 201.
- §2, §6: chụp header ở cả hai theme; `ARCH-HANDOFF` và `ARCH-MAILCRAFT-DOM` xanh.
- §6b: bốn số đo hình học ở trên, và `accessibleName` của `.v3-brand` vẫn là "Mailcraft".
- §6b: đo lại ở 760px — breakpoint mobile đẩy `.workspace` sang 72px cho một sidebar
  mà focus mode không có, nên phải triệt tiêu rãnh đó trước khi nói là khớp.
- §5: bảng chỉ số như đã dùng cho mark MailSpace, và đếm khối rời ở 44/42/32/30/26px.
- §4: đo tương phản chữ/nền ở cả hai theme.
- §3: `pnpm --filter @eow/web test` xanh sau khi sửa ba khẳng định và hai e2e spec.
- Toàn cục: `pnpm check`.
