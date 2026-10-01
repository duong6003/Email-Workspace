# Thiết kế: Dữ liệu động cho template — list, bảng, dữ liệu theo phiên gửi

- Trạng thái: **Đề xuất, chờ duyệt.** Quyết định kiến trúc nằm ở ADR-053.
- Ngày: 2026-10-01
- Liên quan: ADR-013 (snapshot), ADR-015 (render), ADR-031/032/033 (configured variables),
  ADR-036 (định dạng), ADR-048 (List block), BR-TPL-003/004/012, BR-CMP-004/005/006/007,
  BR-IMP-*, BR-SEND-012.
- Audit liên quan: `docs/audit/2026-10-01-campaign-send-performance-audit.md`
  (freeze lỗi khi audience trên ~5k người là điều kiện tiên quyết của thiết kế này).

## 0. Tóm tắt quyết định

1. **Template khai báo "cần dữ liệu gì"; campaign quyết định "lấy dữ liệu từ đâu".**
   - Template công bố một *hợp đồng dữ liệu*: tập biến, kiểu của từng biến, và biến đó
     là giá trị chung hay riêng từng người.
   - Mỗi lần gửi *gắn nguồn* cho từng biến: mặc định, nhập tay, file import theo phiên,
     hoặc copy từ lần gửi trước.
   - Nhờ vậy cùng một template có thể được "bơm" dữ liệu khác nhau giữa các lần gửi mà
     không phải sửa hay publish lại.
2. **Thêm hai kiểu biến:**
   - `list`: danh sách giá trị đơn.
   - `table`: danh sách dòng, mỗi cột có kiểu và định dạng riêng.
   Kiểu `number` được bổ sung định dạng số và tiền tệ, theo đúng mô hình ADR-036
   (định dạng khai báo trên định nghĩa biến, không viết trong token).
3. **Cú pháp là một tập con chặt của Handlebars, khớp ADR-015:**
   - `{{#each}}…{{else}}…{{/each}}` và `{{#if}}…{{else}}…{{/if}}`;
   - biến đặc biệt `@number`, `@index`, `@first`, `@last`, `@odd`;
   - hai helper trong allowlist: `join` và `count`.
   Không có biểu thức tùy ý, không có triple-stash, và luôn escape HTML.
4. **"Dữ liệu phiên gửi" (session dataset) là dữ liệu thuộc về campaign, không ghi vào
   hồ sơ người nhận.** Import CSV/XLSX hoặc dán từ Excel, theo ba hình dạng:
   - mỗi người một dòng;
   - mỗi người nhiều dòng (tự gom thành bảng);
   - bảng dùng chung cho mọi người nhận.
   Dataset được validate trước khi gửi và **đóng băng vào snapshot** khi xác nhận
   (ADR-013), nên worker không phải thay đổi gì.
5. **Builder:** block Bảng và Danh sách được gắn với biến dữ liệu; có thêm "Hiển thị khi"
   cho section/row và section lặp. Người dùng phổ thông không cần gõ cú pháp.
6. **Một bộ parser/renderer dùng chung** (`packages/template-grammar`) thay cho 6 chỗ đang
   tự parse `{{…}}` bằng regex. Một rule kiến trúc mới cấm viết lại regex token.

## 1. Bài toán và use case

| # | Use case | Dữ liệu chung (cả lần gửi) | Dữ liệu riêng (mỗi người) | Hình dạng |
|---|---|---|---|---|
| U1 | Phiếu lương tháng | Kỳ lương, ngày chi trả | Các khoản thu nhập/khấu trừ (nhiều dòng), tổng nhận | Nhiều dòng/người + scalar |
| U2 | Xác nhận đơn hàng / công nợ | — | Mã đơn, danh sách sản phẩm (tên, SL, đơn giá, thành tiền), tổng | Nhiều dòng/người |
| U3 | Thư mời sự kiện | Lịch trình (bảng), địa điểm | Mã vé, ghế | Bảng chung + 1 dòng/người |
| U4 | Newsletter sản phẩm | Danh sách sản phẩm nổi bật (bảng có ảnh, link) | — | Bảng chung |
| U5 | Thông báo khóa học | Danh sách tài liệu | Danh sách lớp đã đăng ký (`list`) | Bảng chung + list/người |
| U6 | Gửi lại tháng sau | Như lần trước, cập nhật số liệu | File mới | Copy cấu hình gắn nguồn, thay file |

Yêu cầu chung cho mọi use case:
- Không phải sửa hay publish lại template giữa các lần gửi.
- Không làm bẩn hồ sơ người nhận bằng dữ liệu chỉ dùng một lần.
- Biết chắc ai thiếu dữ liệu **trước khi** bấm gửi.
- Tái lập được chính xác nội dung đã gửi.

## 2. Hiện trạng và khoảng trống

| Hạng mục | Hiện tại | Khoảng trống |
|---|---|---|
| Cú pháp | Chỉ `{{key}}` phẳng, key `^[a-z][a-z0-9_]{0,63}$` (`template-variables.ts`); mọi thứ khác bị `UNSAFE_TEMPLATE_EXPRESSION` | Không có vòng lặp, điều kiện hay truy cập trường |
| Kiểu | text, number, date, boolean, enum | Không có list/table; số chưa có định dạng |
| Nguồn | Hệ thống; custom field (hồ sơ, bền vững); configured global/template; campaign override (scalar, chung) | Không có dữ liệu riêng từng người cho riêng một lần gửi |
| Import | Chỉ import vào **hồ sơ recipient** (BR-IMP-*) | Import chỉ cho một lần gửi buộc phải ghi đè hồ sơ |
| Builder | Block Bảng/Danh sách tĩnh (gõ từng ô) | Không lặp theo dữ liệu |
| Lỗi tiềm ẩn | Giá trị mảng/object được render bằng `JSON.stringify` (`variable-value-format.ts`) | Khách có thể nhận được chuỗi `["a","b"]` |
| Parser | 6 chỗ tự parse `{{…}}` (api: template-variables, template-content-lint; web: emitter, BuilderScreen, publish-readiness, template-editor/inline) | Mở rộng cú pháp sẽ làm các chỗ này lệch nhau |

## 3. Mô hình khái niệm

### 3.1 Hợp đồng dữ liệu (template) và gắn nguồn (campaign)

```
Template version (bất biến)              Campaign draft (sửa được)          Snapshot (bất biến)
┌─────────────────────────────┐        ┌──────────────────────────────┐   ┌────────────────────────┐
│ variable schema:            │        │ bindings:                    │   │ merge_data_json        │
│  ky_luong  text   campaign  │◄───────┤  ky_luong  ← nhập tay        │──►│  mỗi người: scalar +   │
│  chi_tiet  table  recipient │◄───────┤  chi_tiet  ← dataset#1 (N/ng)│   │  mảng các dòng         │
│  tong_nhan number recipient │◄───────┤  tong_nhan ← dataset#1 cột F │   │ email_snapshot (HTML   │
│  lich      table  campaign  │◄───────┤  lich      ← dataset#2 (chung)│  │  đã render)            │
└─────────────────────────────┘        └──────────────────────────────┘   └────────────────────────┘
```

Mỗi biến do template sở hữu (ADR-032) có thêm thuộc tính **`valueScope`**:

- `campaign`: **một giá trị cho cả lần gửi.** Nguồn hợp lệ: mặc định của template, nhập
  tay ở compose (override hiện có), hoặc một dataset dạng "bảng dùng chung" (với `table`/`list`).
- `recipient`: **giá trị riêng từng người.** Nguồn hợp lệ: dataset phiên dạng
  "mỗi người một dòng" hoặc "mỗi người nhiều dòng"; được dùng mặc định của template làm
  fallback nếu template cho phép.

Biến hệ thống và custom field (hồ sơ) giữ nguyên ngữ nghĩa: luôn là `recipient`, nguồn
luôn là hồ sơ. **Dataset phiên không được ghi đè chúng** (giữ nguyên ADR-031: dữ liệu
hồ sơ có thẩm quyền với key của chính nó). Nếu muốn cập nhật hồ sơ thì dùng import
recipient; đây là hai luồng tách biệt có chủ đích.

### 3.2 Phân loại nguồn dữ liệu theo vòng đời

| Nguồn | Phạm vi | Vòng đời | Ai sở hữu | Có trước đây? |
|---|---|---|---|---|
| Hệ thống (`email`, `first_name`, `last_name`, `unsubscribe_url`) | Riêng từng người | Tính khi freeze | Hệ thống | Có |
| Custom field (hồ sơ) | Riêng từng người | Bền vững | Recipient data | Có |
| Biến global của tenant | Chung | Bền vững | Cài đặt tenant | Có |
| Mặc định template | Chung (hoặc fallback cho riêng) | Theo version | Template | Có |
| Nhập tay ở compose (override) | Chung | Theo lần gửi | Campaign | Có, chỉ scalar → **mở rộng cho list/table** |
| **Dataset phiên: mỗi người 1 dòng** | Riêng từng người | Theo lần gửi | Campaign | **Mới** |
| **Dataset phiên: mỗi người N dòng** | Riêng từng người (bảng) | Theo lần gửi | Campaign | **Mới** |
| **Dataset phiên: bảng dùng chung** | Chung (bảng) | Theo lần gửi | Campaign | **Mới** |
| **Thư viện dữ liệu** (giai đoạn 4) | Chung hoặc riêng | Bền vững, có version | Tenant | **Mới** |
| **Kết nối ngoài** (Google Sheet/URL JSON, giai đoạn 4) | Chung hoặc riêng | Kéo về và chụp lại khi xác nhận | Tenant | **Mới**, STOP gate về credential |

Mọi nguồn "theo lần gửi" và "kết nối ngoài" đều được **chụp lại vào snapshot** khi xác
nhận gửi hoặc lên lịch (ADR-013). Worker không bao giờ đọc nguồn sống (BR-SEND-012).

### 3.3 Hệ kiểu

| Kiểu | Giá trị lưu | Định dạng (trên định nghĩa, ADR-036) | Ghi chú |
|---|---|---|---|
| text, boolean, enum | Như hiện tại | — | |
| number | number | **Mới:** `format` dạng `#,##0.##`, `currency` (`VND`, `USD`), `locale` (mặc định `vi-VN`) | Dùng `Intl.NumberFormat`, không thêm dependency |
| date | ISO instant | Như ADR-036 | |
| **list** | `Array<scalar>` | `itemType`, `itemFormat`, `joinWith` mặc định `", "` | ≤ 200 phần tử |
| **table** | `Array<Record<colKey, scalar>>` | `columns[]`: `{ key, label, dataType, format, align }` | ≤ 500 dòng/người, ≤ 30 cột |

Quy tắc `table`:
- Key của cột theo cùng regex với key biến.
- Cột trong một bảng là một **không gian tên con**: bên trong `{{#each chi_tiet}}`, token
  `{{so_tien}}` được tìm ở cột của dòng trước, rồi mới tới biến bên ngoài.
- Nếu tên cột trùng tên biến bên ngoài, lint cảnh báo; tên cột thắng (giống Handlebars).

Custom field (hồ sơ) **giữ nguyên chỉ scalar** trong phạm vi thiết kế này. Một custom field
dạng list (ví dụ "sở thích") là giai đoạn sau và cần ADR riêng, vì nó ảnh hưởng tới
segment/filter (BR-REC-007/008).

## 4. Cú pháp template — tập con Handlebars (ADR-015)

```handlebars
Chào {{first_name}}, phiếu lương {{ky_luong}}:
<table>
  <tr><th>Khoản</th><th>Số tiền</th></tr>
  {{#each chi_tiet}}
  <tr class="{{#if @odd}}zebra{{/if}}"><td>{{@number}}. {{khoan}}</td><td>{{so_tien}}</td></tr>
  {{else}}
  <tr><td colspan="2">Không có phát sinh trong kỳ.</td></tr>
  {{/each}}
</table>
{{#if ghi_chu}}<p>Ghi chú: {{ghi_chu}}</p>{{/if}}
Lớp đã đăng ký: {{join lop_hoc ", "}} ({{count lop_hoc}} lớp)
```

| Cấu trúc | Ngữ nghĩa |
|---|---|
| `{{key}}` | Như hiện tại: escape HTML trong `html`, không escape trong subject/text. Nếu `key` là `list` và đứng ngoài `each` → tương đương `{{join key}}` với `joinWith` của định nghĩa. Nếu `key` là `table` và đứng ngoài `each` → **lỗi publish** (không còn `JSON.stringify` lọt ra ngoài). |
| `{{#each k}}…{{else}}…{{/each}}` | `k` phải là `list` hoặc `table`. Với `list`, phần tử hiện tại là `{{this}}`. Nhánh `else` render khi rỗng hoặc thiếu. |
| `{{#if k}}…{{else}}…{{/if}}` | Falsy: thiếu, `null`, `""`, `false`, list/table rỗng. **Số `0` là truthy** (khác Handlebars, có chủ đích: "0 đ" là dữ liệu hợp lệ). |
| `@index`, `@number`, `@first`, `@last`, `@odd` | Chỉ dùng được trong `each`; `@number = @index + 1`. |
| `{{join k "sep"}}`, `{{count k}}` | Hai helper duy nhất trong allowlist; tham số chỉ được là chuỗi literal. |

Bị cấm, lỗi publish `UNSAFE_TEMPLATE_EXPRESSION`: triple-stash `{{{…}}}`, partial,
helper ngoài allowlist, truy cập đường dẫn sâu (`a.b.c`), `../` lên scope cha (dùng biến
ngoài trực tiếp), comment `{{! }}`, và whitespace control `~`.

Giới hạn (lỗi publish nếu vượt):
- độ lồng ≤ 3;
- tổng số token ≤ 1.000 (giữ mức hiện có);
- mỗi block phải đóng đúng và cân bằng.

Giới hạn lúc render, được kiểm khi validate campaign:
- kích thước HTML sau render ≤ 1MB (lỗi);
- cảnh báo khi vượt 102KB, ngưỡng Gmail cắt thư.

**Vị trí block trong HTML.** Ở `html`, mỗi block `{{#each}}`/`{{#if}}` phải mở và đóng
**trong cùng một phần tử cha** và bao trọn phần tử, không cắt ngang một thẻ. Lint lúc
publish kiểm tra điều này bằng htmlparser2 (dependency sẵn có của sanitize-html).

Lý do: text giữa các `<tr>` sẽ bị trình duyệt "foster-parent" ra khỏi bảng. Render ở
server không gặp chuyện này vì htmlparser2 không foster-parent, nhưng code view và
preview trên trình duyệt thì có. Builder luôn sinh token ở vị trí hợp lệ.

**Text body.** Dùng cùng cú pháp. Builder tự sinh text cho bảng theo dạng
`{{@number}}. {{khoan}}: {{so_tien}}` mỗi dòng (BR-TPL-007).

**Parser dùng chung.** Thêm `packages/template-grammar`: tokenizer → AST → validator →
renderer, thuần TypeScript, không dependency, cùng chạy được ở API và web.
- `apps/api` dùng cho analyze, lint, preview và freeze.
- `apps/web` dùng cho highlight, lint inline, publish-readiness và emitter.
- Worker không render (giữ nguyên ADR-013).

Thêm rule `ARCH-TEMPLATE-GRAMMAR` trong `packages/architecture-tests`: cấm regex
`\{\{` ngoài package này (kèm allowlist có lý do). Đây chính là loại lệch đã từng xảy ra.

Phân tích schema (`analyzeTemplateVariables`):
- Biến trong `each` được tính là cột của bảng.
- Kiểm tra mọi cột được dùng đều có trong định nghĩa `columns`.
- `required` cho `table`/`list` có nghĩa là **phải có mặt**. Còn có được rỗng hay không
  thì do `minItems` quyết định (mặc định 0 = cho phép rỗng và render nhánh `else`).

## 5. Builder (Mailcraft)

| Block | Thay đổi |
|---|---|
| **Bảng dữ liệu** | Inspector có "Nguồn": `Tĩnh` (như hiện tại) hoặc `Biến bảng`. Khi chọn `Biến bảng`: chọn biến `table`; bật/tắt, sắp xếp, đổi nhãn và căn lề từng cột; chọn dòng tổng (lấy từ biến scalar); nhập nội dung khi rỗng. Zebra và màu giữ nguyên, sinh qua `@odd`. Emitter sinh `<tr>` mẫu bọc trong `{{#each}}`. |
| **Danh sách** (ADR-048) | Nguồn `Tĩnh` hoặc `Biến danh sách` (hoặc một cột của bảng) → một `<li>` mỗi phần tử. |
| **Section/Row** | "Hiển thị khi…": chọn biến, điều kiện "có dữ liệu" hoặc "không có dữ liệu" → `{{#if}}`/`{{else}}`. |
| **Section lặp** (mới) | "Lặp theo bảng": mỗi dòng dữ liệu sinh một bản sao của section, dùng cho thẻ sản phẩm (U4). Ô bên trong chèn được cột như chèn biến. |
| Canvas | Hiện 3 dòng mẫu, lấy từ dữ liệu mẫu của biến hoặc dataset đang chọn; có nhãn "Dữ liệu mẫu". |
| Panel biến | Nhóm theo phạm vi: "Chung cho lần gửi", "Riêng từng người", "Hồ sơ người nhận", "Hệ thống". Biến `table` mở ra danh sách cột để kéo vào ô. |
| Định nghĩa biến | Form tạo biến của template (ADR-032) thêm kiểu `list`/`table`, `valueScope`, editor cột và **dữ liệu mẫu** (một bảng nhỏ nhập trực tiếp hoặc dán từ Excel) phục vụ preview. |

## 6. Dữ liệu phiên gửi — import theo phiên

### 6.1 Luồng ở màn Soạn campaign

Thêm bước **"Dữ liệu"** giữa *Người nhận* và *Xem lại*. Bước này chỉ hiện khi template có
biến cần gắn nguồn.

1. **Danh sách biến cần dữ liệu.** Mỗi biến hiển thị phạm vi, kiểu, nguồn hiện tại và trạng thái
   (✓ đủ, ⚠ thiếu N người, ✗ chưa gắn).
2. **Thêm nguồn:**
   - "Tải file" (CSV/XLSX; parse ở client bằng `csv-import.ts`/`spreadsheet-import.ts`
     và exceljs sẵn có);
   - "Dán từ Excel";
   - "Nhập tay" (cho biến chung, như override hiện tại, nay hỗ trợ cả bảng nhỏ);
   - "Dùng lại từ lần gửi trước".
3. **Chọn hình dạng dữ liệu**, hệ thống tự gợi ý theo việc cột khóa có bị lặp hay không:
   - **Mỗi người một dòng:** chọn cột khóa → mỗi cột map sang một biến `recipient` (scalar hoặc list,
     ví dụ "A; B; C" tách bằng dấu phân cách cấu hình được).
   - **Mỗi người nhiều dòng:** chọn cột khóa → các dòng cùng khóa gom thành một biến
     `table`; mỗi cột map sang một cột của bảng. Cột có **giá trị giống nhau trên mọi dòng
     của một người** có thể map sang biến scalar `recipient` (ví dụ `tong_nhan`). Nếu không
     nhất quán thì báo lỗi theo từng người.
   - **Bảng dùng chung:** không có khóa; toàn bộ file thành một biến `table` (hoặc `list`)
     phạm vi `campaign`.
4. **Khóa đối sánh** (chỉ cho dữ liệu riêng):
   - **email** (chuẩn hóa như BR-REC-001, mặc định);
   - hoặc **một custom field làm mã ngoài** (ví dụ `ma_nhan_vien`), nếu custom field đó
     là duy nhất trong tenant.
5. **Quan hệ với audience**, chọn một trong hai:
   - **"Audience giữ nguyên, file chỉ bổ sung dữ liệu"** (mặc định): người trong audience
     mà không có dữ liệu sẽ áp chính sách thiếu dữ liệu (§6.3); dòng trong file mà không
     có trong audience được báo là "không khớp" và bị bỏ qua.
   - **"Gửi cho đúng những người có trong file":** audience bằng giao của file với các
     recipient đang tồn tại và đủ điều kiện (BR-CMP-003). Người trong file chưa có hồ sơ
     được liệt kê kèm nút *"Tạo hồ sơ"*. Nút này đi qua **luồng import recipient hiện có**
     (BR-IMP-004/005, consent), không tự tạo ngầm.
6. **Map cột và kiểu:**
   - Tự ghép theo key hoặc nhãn (bỏ dấu, không phân biệt hoa thường).
   - Ép kiểu theo định nghĩa biến/cột. Ngày dạng `dd/MM/yyyy` được parse theo múi giờ
     tenant. Số được parse theo locale (`1.234.567,5`).
   - Ô XLSX chứa công thức: chỉ lấy **giá trị đã tính sẵn**, không bao giờ tính lại công thức.
7. **Báo cáo kiểm tra** (bắt buộc pass trước khi được sang bước Xem lại):
   - số dòng, số người khớp, số dòng không khớp (tải được file lỗi);
   - người trong audience thiếu dữ liệu, theo từng biến;
   - lỗi kiểu dữ liệu (dòng, cột, giá trị, lý do);
   - khóa trùng (với chế độ một dòng/người);
   - số người vượt `maxRows` (≤ 500);
   - email lớn nhất sau render (cảnh báo > 102KB);
   - preview cho 1 người bất kỳ, hoặc đúng người đang có lỗi.

### 6.2 Dùng lại giữa các lần gửi

- **Copy từ campaign trước** (kể cả resend, theo lineage ADR-027): copy *cấu hình gắn
  nguồn và mapping*, có tùy chọn copy cả *dữ liệu*. Trường hợp thường gặp: giữ mapping,
  chỉ thay file.
- **Mẫu mapping** lưu theo template: lần sau tải file cùng tiêu đề cột thì map tự động.
- **Thư viện dữ liệu** (giai đoạn 4): dataset đặt tên, có version (ví dụ "Bảng giá
  T10/2026"), dùng làm nguồn cho biến `campaign`. Campaign tham chiếu đúng version, và
  snapshot copy nội dung tại thời điểm xác nhận.
- **Kết nối ngoài** (giai đoạn 4): Google Sheets hoặc URL JSON, được kéo về **khi bấm
  Kiểm tra và khi xác nhận gửi**. Kết quả được chụp lại như một file import. Cần
  credential nên là STOP gate theo `approval-policy` và phải có ADR riêng.

### 6.3 Chính sách thiếu hoặc rỗng (BR-CMP-005/006)

| Tình huống | Hành vi |
|---|---|
| Biến `recipient` *required* bị thiếu với người X | Giống thiếu biến hiện nay: **chặn gửi**. Người dùng được chọn bổ sung dữ liệu hoặc *loại người thiếu* bằng waiver hiện có (`audienceWaiver`). Người bị loại được snapshot ghi là `skipped: missing_required_variable`. |
| Biến `recipient` *optional* bị thiếu | Dùng mặc định của template, nếu không có thì để rỗng (BR-CMP-006). |
| `table` có mặt nhưng 0 dòng | Hợp lệ nếu `minItems = 0`: render nhánh `{{else}}`. Nếu `minItems ≥ 1` thì xử lý như thiếu required. |
| Biến `campaign` *required* chưa có giá trị | Chặn ở bước Dữ liệu, giống override hiện tại. |
| Dòng trong file không khớp audience | Không chặn; báo cáo và cho tải file lỗi. |

### 6.4 Lưu trữ và vòng đời (migration forward-only)

```sql
-- 080: kiểu biến mới (forward migration, không sửa migration đã publish)
ALTER TABLE configured_variable DROP CONSTRAINT configured_variable_data_type_values;
ALTER TABLE configured_variable
  ADD CONSTRAINT configured_variable_data_type_values
    CHECK (data_type IN ('text','number','date','boolean','enum','list','table')),
  ADD COLUMN value_scope text NOT NULL DEFAULT 'campaign' CHECK (value_scope IN ('campaign','recipient')),
  ADD COLUMN item_schema jsonb,      -- list: {itemType,itemFormat,joinWith}; table: {columns:[...]}
  ADD COLUMN min_items integer NOT NULL DEFAULT 0,
  ADD COLUMN max_items integer,
  ADD COLUMN sample_value jsonb;     -- dữ liệu mẫu cho preview/builder, không bao giờ được gửi

-- 081: dataset theo campaign
CREATE TABLE campaign_dataset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  campaign_id uuid NOT NULL,
  name text NOT NULL,
  shape text NOT NULL CHECK (shape IN ('one_per_recipient','many_per_recipient','shared')),
  key_kind text CHECK (key_kind IN ('email','custom_field')),
  key_field text,                      -- custom field key khi key_kind = 'custom_field'
  source_kind text NOT NULL CHECK (source_kind IN ('upload','paste','manual','copy')),
  source_name text,                    -- tên file gốc (không lưu file)
  columns_json jsonb NOT NULL,         -- tiêu đề cột gốc + kiểu đã nhận diện
  mapping_json jsonb NOT NULL DEFAULT '{}',  -- cột → biến/cột bảng
  row_count integer NOT NULL DEFAULT 0,
  validation_json jsonb,               -- báo cáo §6.1 bước 7, có version
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','frozen')),
  content_hash text,                   -- khi frozen
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campaign_dataset_row (
  dataset_id uuid NOT NULL REFERENCES campaign_dataset(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  row_no integer NOT NULL,
  match_key text,                      -- email chuẩn hóa hoặc giá trị mã ngoài; NULL nếu shared
  data jsonb NOT NULL,                 -- giá trị đã ép kiểu
  PRIMARY KEY (dataset_id, row_no)
);
CREATE INDEX ON campaign_dataset_row (tenant_id, dataset_id, match_key);
-- RLS tenant_isolation như mọi bảng; trigger bất biến khi dataset.status = 'frozen'.
```

- Campaign draft giữ `settingsJson.bindings`: `{ [variableKey]: { kind: 'default' | 'manual' | 'dataset', datasetId?, column? } }`.
- **Freeze:**
  - đọc dataset theo lô;
  - gom các dòng theo `match_key`;
  - trộn vào `merge_data_json` của từng người (table thành mảng các object);
  - render bằng `template-grammar`;
  - ghi `email_snapshot`, đặt `dataset.status = frozen` và ghi `content_hash`;
  - ghi `snapshot.policy_result_json.datasets = [{id, contentHash, rowCount, matched, unmatched}]` để audit.
- **Worker không đổi.** Worker vẫn gửi từ `email_snapshot` (BR-SEND-012).
- **Giữ lại dữ liệu (PII):** `campaign_dataset_row` của campaign đã ở trạng thái kết thúc
  được xóa theo `HISTORY_EVENT_RETENTION_DAYS`, qua scan có sẵn
  `history-purge-scan`. Dữ liệu đã gửi vẫn còn trong snapshot theo chính sách hiện hành.
  Dataset nháp bị bỏ quá 30 ngày cũng được dọn.

### 6.5 Giới hạn và bảo mật

| Hạng mục | Giá trị | Có env? |
|---|---|---|
| Kích thước file | 20MB | `EOW_CAMPAIGN_DATASET_MAX_BYTES` |
| Số dòng mỗi dataset | 200.000 | `EOW_CAMPAIGN_DATASET_MAX_ROWS` |
| Số cột | 50 | — |
| Số dòng mỗi người (`table`) | 500 | Theo định nghĩa biến, có trần cứng |
| Số dataset mỗi campaign | 5 | — |

- Upload theo lô ≤ 1.000 dòng mỗi request, có `Idempotency-Key` và `chunkIndex`, nên
  retry không nhân đôi dòng. Lý do: tránh body lớn và tránh lặp lại lỗi tham số ở E4.
- Validation chạy **ở server**. Validation ở client chỉ là hiển thị sớm.
- Validate dưới 5.000 dòng thì chạy đồng bộ; từ 5.000 trở lên thì chạy job nền, theo mẫu
  import job, có progress realtime và notification bền vững (ADR-011).
- Quyền: dùng `PERMISSIONS.CONTENT_MANAGE`, cùng quyền đang bảo vệ `PATCH /campaigns/:id`;
  RBAC deny-by-default (`packages/architecture-tests`) thêm route mới vào ma trận và
  `rbac-matrix.test.ts`.
- Audit: ghi tạo, xóa dataset và mapping (không ghi giá trị). Lỗi validation chỉ trả về vị trí
  dòng/cột và tóm tắt giá trị đã che, đồng bộ với BR-CF-009.
- File lỗi CSV xuất ra: chặn CSV injection bằng cách thêm tiền tố `'` cho ô bắt đầu
  bằng `= + - @`.

## 7. API và contract (phác thảo, chốt ở OpenAPI khi triển khai)

| Method | Path | Ghi chú |
|---|---|---|
| POST | `/campaigns/{id}/datasets` | Tạo dataset với `shape`, `keyKind`, `keyField`, `name`, `columns` |
| POST | `/campaigns/{id}/datasets/{dsId}/rows:batch` | ≤ 1.000 dòng/lần, idempotent theo `chunkIndex` |
| PUT | `/campaigns/{id}/datasets/{dsId}/mapping` | Cột → biến/cột bảng, có ép kiểu |
| POST | `/campaigns/{id}/datasets/{dsId}/validate` | Trả báo cáo hoặc `202 + jobId` khi lớn |
| GET | `/campaigns/{id}/datasets/{dsId}/errors.csv` | File lỗi |
| DELETE | `/campaigns/{id}/datasets/{dsId}` | Chỉ khi chưa frozen |
| POST | `/campaigns/{id}/datasets:copy` | `{ sourceCampaignId, includeRows }` |
| PUT | `/campaigns/{id}` | `settings.bindings` (mở rộng DTO hiện có) |
| POST | `/template-versions/{id}/preview` | `context` nhận list/table; thêm `datasetId` + `recipientId` để preview bằng dữ liệu thật |

AsyncAPI: thêm `campaign.dataset_validation_changed`, chỉ là gợi ý refetch theo nguyên
tắc ADR-010. REST/PostgreSQL vẫn là nguồn sự thật.

## 8. Quy tắc nghiệp vụ và traceability

Sửa:
- **BR-TPL-003:** cú pháp mở rộng thành tập con Handlebars ở §4.
- **BR-TPL-004:** `required`/`optional` áp dụng cho list/table cùng với `minItems`.
- **BR-CMP-004:** kiểm biến trên toàn audience, tính cả dữ liệu phiên.

Thêm (đề xuất ID):
- **BR-TPL-013:** biến `list`/`table`, giới hạn và định dạng.
- **BR-TPL-014:** giới hạn render (1MB lỗi, 102KB cảnh báo; độ lồng ≤ 3).
- **BR-CMP-011:** dữ liệu phiên thuộc campaign và không ghi vào hồ sơ.
- **BR-CMP-012:** ba hình dạng dataset, khóa đối sánh, quan hệ với audience.
- **BR-CMP-013:** dùng lại dữ liệu và mapping giữa các lần gửi.
- **BR-IMP-008:** giới hạn, ép kiểu và an toàn của import phiên (không tính công thức, chặn CSV injection).

Ca kiểm thử tối thiểu, sẽ đăng ký vào `catalog/test-cases.json` khi triển khai:
- render each/if/else và join/count;
- escape trong cột bảng;
- `0` là truthy;
- lỗi publish khi token table đứng ngoài each;
- block cắt ngang thẻ bị lint chặn;
- dataset ở cả 3 hình dạng;
- trùng khóa;
- scalar không nhất quán khi map từ dữ liệu nhiều dòng;
- người thiếu dữ liệu → chặn, hoặc waiver → `skipped`;
- freeze 20k người × 10 dòng (hiệu năng, liên quan E4);
- snapshot không đổi khi sửa dataset sau khi xác nhận;
- purge PII theo retention;
- RBAC và tenant isolation cho route mới;
- visual check của builder ở các viewport trong `visual-acceptance.md`.

## 9. Lộ trình (mỗi giai đoạn là một vertical slice)

| Giai đoạn | Nội dung | Phụ thuộc |
|---|---|---|
| **G0** | Sửa freeze lỗi trên 5k người; freeze bất đồng bộ (ADR-054) | — (bắt buộc trước, vì dataset làm `merge_data_json` lớn hơn) |
| **G1** | `packages/template-grammar` (each/if/join/count, `@vars`), kiểu `list`/`table` + định dạng số, lint vị trí block, preview với dữ liệu mẫu, code view; thay 6 parser cũ; ARCH-TEMPLATE-GRAMMAR | G0 |
| **G2** | Dataset phiên: 3 hình dạng, map cột, validate, báo cáo, freeze tích hợp, retention; bước "Dữ liệu" ở compose; nhập tay bảng nhỏ cho biến `campaign` | G1 |
| **G3** | Builder: Bảng/Danh sách gắn biến, "Hiển thị khi", Section lặp, panel biến theo phạm vi | G1 (song song với G2) |
| **G4** | Dùng lại: copy từ campaign trước, mẫu mapping, thư viện dữ liệu có version; kết nối Google Sheets/URL (ADR riêng, STOP gate credential) | G2 |

## 10. Quyết định cần chốt (kèm khuyến nghị)

1. **Cú pháp:** tập con Handlebars (khuyến nghị; khớp ADR-015 và quen thuộc với dev),
   hay chỉ cho phép gắn dữ liệu qua builder?
   → Khuyến nghị **cả hai**: builder sinh cú pháp, code view cho phép viết tay, cùng một parser.
2. **Dataset phiên có được cập nhật hồ sơ không?**
   → Khuyến nghị **không**. Muốn cập nhật hồ sơ thì dùng import recipient.
3. **Người thiếu dữ liệu riêng:**
   → Khuyến nghị **chặn gửi, có waiver để loại người thiếu**, giống BR-CMP-005 hiện hành.
4. **`0` là truthy trong `{{#if}}`:**
   → Khuyến nghị **có**. Có thể đổi, nhưng phải ghi rõ vào BR-TPL-013.
5. **Audience theo file:** có bật chế độ "Gửi cho đúng những người có trong file" ngay ở G2 không?
   → Khuyến nghị **có**, nhưng chỉ khớp với recipient đã tồn tại.
6. **Giới hạn mặc định** (20MB, 200k dòng, 500 dòng/người): có phù hợp quy mô thực tế không?

## 11. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| `merge_data_json` và `email_snapshot` phình to vì bảng | Có giới hạn dòng; cảnh báo 102KB; G0 freeze theo lô; theo dõi dung lượng TOAST |
| Parser web và API lệch nhau | Một package dùng chung cộng rule ARCH-TEMPLATE-GRAMMAR |
| Lỗ hổng injection qua dữ liệu import | Luôn escape; không có triple-stash; dữ liệu chỉ được chèn dưới dạng text đã escape; **yêu cầu mới**: giá trị chèn vào `href`/`src` phải qua link validation (BR-TPL-006, chỉ `https:`/`mailto:`) ngay lúc render, giá trị không hợp lệ được báo là lỗi dữ liệu ở bước Kiểm tra |
| Người dùng nhầm dataset phiên với hồ sơ | Đặt tên rõ ở UI ("Dữ liệu cho lần gửi này — không lưu vào hồ sơ"); màn Review liệt kê nguồn của từng biến |
| PII tồn đọng | Retention purge (§6.4); xóa file gốc ngay sau khi parse vì server không lưu file |
