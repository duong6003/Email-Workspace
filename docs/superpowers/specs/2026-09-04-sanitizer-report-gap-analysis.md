# S7 Task 43 — Báo cáo sanitizer: cái gì đã có, cái gì còn thiếu

**Ngày:** 2026-09-04
**Trạng thái:** phân tích + quyết định. Sản phẩm của Task 43; Task 44–46 thực thi theo §4.
**Đầu vào:** `2026-09-01-sanitizer-reports-what-it-removed-design.md` (thiết kế), `2026-08-31-mailcraft-builder-vertical-slice.md` §S7 (Task 43–46)
**Liên quan:** `2026-09-01-builder-block-sanitizer-audit.md`, ADR-038, ADR-040, ADR-042, ADR-043

> Mọi con số dưới đây **đo từ mã đã build** (`apps/api/dist/templates/template-html-sanitizer.js`), không đọc suy ra. Cách đo ghi ở §5.

---

## 1. Kết luận một dòng

Kế hoạch S7 đoán *"nhiều khả năng phần backend đã có sẵn"* (dòng 778). **Sai.** Toàn bộ §3 của thiết kế báo cáo — phép đo, ba loại mất mát, câu tiếng Việt, chống nhiễu — **chưa có gì**. Thứ đã có là **đường ống mang dữ liệu**, không phải dữ liệu.

⇒ S7 không phải "chỉ còn phần màn hình". Nó là **backend đo + màn hình**, và có ba chỗ trong đặc tả phải quyết trước khi viết (§4).

---

## 2. Cái gì đã có

| Thứ | Ở đâu | Ghi chú |
|---|---|---|
| Trường `changes: string[]` trong kết quả sanitize | `template-html-sanitizer.ts:6-10` | Hình dạng đúng như thiết kế §3.4 muốn giữ |
| `changes` được persist | `templates.service.ts:176` (create), `:222` (update/autosave) → `draft_validation_json` | Thiết kế §3.5 ("so với lần lưu trước") **khả thi, không cần migration** |
| `changes` đi hết đường tới web | `templates.service.ts:525-526` → `TemplateValidation` (`apps/web/src/api/templates.ts:7`) | Kiểu đã đúng ở cả hai đầu |
| `POST /templates/analyze` trả `validation` | `templates.service.ts:183-209` | Màn import đã gọi (`TemplatesScreen.tsx:75`) |
| Hai nguồn sinh `warnings` | `stripUnsafeStyleBlocks` (`:129-136`), nhánh `img` trong `transformTags` (`:152-163`) | Đây là **hai** trong bốn điểm mất mát của pipeline |
| 4/10 touch point MC-UI-006 | `upload_html` `analyze` `create_draft` `file_selected` `import_analyzing` `error` | Xem `mailcraft-fidelity.test.ts:233-236, 413-418` |
| Khái niệm `missing_assets` đã định nghĩa một lần | `apps/web/src/screens/templates/builder/assets.ts:36-60` | ADR-043: **liệt kê, không tự sửa**. Task 45 dùng lại đúng khái niệm này |

## 3. Cái gì còn thiếu

**Backend (chưa có gì):**

1. Không có phép đo nào. `changes` vẫn là đúng một câu cố định `"Sanitized imported HTML before storage."` (`template-html-sanitizer.ts:184`) — trường chết, y như thiết kế §2 mô tả cách đây ba ngày.
2. Không có ba loại mất mát của §3.3 (thuộc tính CSS / thuộc tính HTML / thẻ).
3. Không có câu tiếng Việt, không có gợi ý thay thế (§3.4).
4. Không có gộp/giới hạn 10 dòng, không có so-với-lần-trước (§3.5).

**Frontend (chưa có gì):**

5. Không nơi nào đọc `validation.changes`. Đã tìm toàn bộ `apps/web/src` — không có một tham chiếu nào ngoài chính khai báo kiểu.
6. Không có `review_report`, và bốn state `import_partial` `import_fallback` `missing_assets` đang là `deferred('S7', …)` trong cổng fidelity (`mailcraft-fidelity.test.ts:235, 416-418`).

**Đo được, cụ thể — đây là hiện trạng người dùng thật gặp:**

| HTML vào | Sanitizer trả về hôm nay |
|---|---|
| `@media (max-width:600px){…}` trong `<style>` | `warnings: []`, `changes: ["Sanitized imported HTML before storage."]` — **im lặng hoàn toàn** |
| `<script>alert(1)</script>` | `warnings: []` — **im lặng hoàn toàn** |
| `<img src="http://…">` | `warnings: ["Removed an image resource that is not HTTPS or cid."]` — có báo, **không kèm URL nào** |
| `style="background:#f00"` (nút CTA, ô bảng) | im lặng |
| `style="border-top:2px solid …"` (đường ngăn) | im lặng |
| `aria-label="Facebook"` | im lặng |
| HTML sạch | `changes: []` ✅ — nghiệm thu §6 gạch 2 **đã đúng sẵn** |

**Chính mẫu nghiệm thu của Task 46** (`<script>` + `@media` + ảnh `http:`) hôm nay báo **1 trên 3**, và cái duy nhất được báo cũng không nói ảnh nào.

**Một lỗi đếm kèm theo:** `warnings` bị khử trùng lặp bằng `[...new Set(warnings)]` (`:185`). Đo: ba ảnh `http:`/`ftp:` khác nhau ⇒ `warnings.length === 1`. Toast import hiện `đã loại bỏ ${warnings.length} nội dung không an toàn` (`TemplatesScreen.tsx:79`) ⇒ **hiện "1" khi thật ra là 3**. Không phải lỗi của S7, nhưng S7 chạm đúng vào nó.

---

## 4. Ba chỗ đặc tả mâu thuẫn — và quyết định

Cả ba đều là mâu thuẫn **giữa** thiết kế báo cáo và kế hoạch S7, phát hiện khi đọc đối chiếu. Quyết định ghi ngay dưới mỗi mục; lý do dẫn từ nguyên tắc đã có trong repo, không từ sở thích.

### 4.1 §3.2 đo quanh `sanitize()` **không thấy được `@media`** — mà Task 44 và 46 lại đòi báo nó

Thiết kế §3.2 chốt: đo **ngay trước và ngay sau mỗi lần `sanitize()`**, *"bỏ `juice` ra ngoài phép so sánh hoàn toàn"*. Lý do đưa ra là đúng và vẫn đúng: `juice` di chuyển CSS hợp pháp, so đầu-cuối sẽ báo nhầm.

Nhưng đo thật cho thấy `@media` **không bị `sanitize()` xoá** — nó bị `juice` xoá:

```
sau sanitize pass 1 : <style>.col{color:#111}@media (max-width:600px){.col{width:100%!important}}</style>  ← còn nguyên
sau juice           : <p class="col" style="color: #111;">Hi</p>                                            ← @media biến mất
```

`preserveMediaQueries: false` (`:182`) là thứ xoá nó. ⇒ Với đúng §3.2 như viết, chênh lệch quanh cả hai `sanitize()` cho `@media` bằng **0**, và báo cáo sẽ không bao giờ nêu nó.

Trong khi đó kế hoạch đòi ngược lại, ở hai chỗ:
- Task 44: nhóm báo cáo gồm *"`@media` bị xoá / stylesheet bị xoá cả khối"*.
- Task 46: *"e2e import một tệp có `<script>` + `@media` + ảnh `http:`, khẳng định báo cáo nêu **đủ ba**"*.

**✅ QUYẾT ĐỊNH: đo ở cả bốn điểm. Thiết kế sai ở chỗ này, kế hoạch đúng.**

Lý do §3.2 loại `juice` là **cụ thể**: `juice` *di chuyển* CSS từ `<style>` sang `style=""` một cách hợp pháp, nên so sánh quanh nó sẽ đếm một khai báo thành nhiều lần và báo `<style>` là "bị mất". Lý do đó **không áp dụng cho `@media`**: `juice` không thể inline một media query đi đâu cả — nó chỉ có thể xoá. Không tồn tại biến đổi hợp pháp nào để nhầm với mất mát. Câu chữ của §3.2 ("bỏ `juice` ra ngoài **hoàn toàn**") rộng hơn chính lý do nó đưa ra.

Thêm một lập luận từ §1 của chính thiết kế — *"Hệ thống biết nó vừa xoá gì và không nói"*: mất `@media` là mất bố cục trên điện thoại, hậu quả nặng nhất trong các mất mát ở đây. Một báo cáo im lặng đúng chỗ đó thì thất bại ở mục đích của chính nó.

Pipeline có **bốn** điểm mất mát, không phải hai. Đo ở cả bốn, mỗi điểm một phép đo riêng đúng với bản chất của nó:

| # | Điểm | Mất gì | Đo thế nào |
|---|---|---|---|
| 1 | `stripUnsafeStyleBlocks` | cả khối `<style>` | đã có `warnings`, chỉ cần chuyển thành câu `changes` có số đếm |
| 2 | `sanitize()` pass 1 | thẻ, thuộc tính HTML, khai báo CSS inline | so trước/sau — đúng §3.2 |
| 3 | `juice` | **chỉ `@media`** | đếm số khối `@media` trước, so với sau (luôn 0 khi `preserveMediaQueries:false`) — **không** so gì khác quanh `juice`, để giữ nguyên lý do §3.2 |
| 4 | `sanitize()` pass 2 | như #2, sau khi đã inline | so trước/sau — đúng §3.2 |

Điểm #3 hẹp đúng một thứ, nên nó **không** phá lập luận của §3.2: chỗ `juice` biến đổi hợp pháp (`<style>` → `style=""`) vẫn nằm ngoài phép so sánh.

### 4.2 Nghiệm thu §6 gạch 1 ("nêu tên **cả 16**") đã lỗi thời

Thiết kế viết ngày 2026-09-01, tính trên 16 khai báo mà cuộc kiểm kê khối tìm thủ công. Từ đó tới nay:

- **ADR-040** cho `display`, `max-height`, `overflow` (preheader) — 3 mục thôi mất.
- **ADR-042** cho `box-shadow`, `letter-spacing`, `text-transform`, `background-image` (gradient) — 4 mục nữa thôi mất.
- **S2 Task 5/6** sửa emitter: `background`→`background-color`, bỏ `border-top`, bỏ `aria-label`, bỏ `opacity`, tách `font` shorthand.

⇒ Chạy sanitizer trên **output builder hôm nay** sẽ không còn 16 mục nào để tìm — `builder-block-sanitizer.test.ts` (30 test) đang canh đúng điều đó. Con số 16 chỉ còn nghĩa với **HTML import**, tức mẫu cố định.

**✅ QUYẾT ĐỊNH: thay bằng một tệp mẫu HTML đóng băng.**

Đặt trong `.agents/runs/.../evidence/s7-task43/`, chứa đủ các mất mát của cuộc kiểm kê, không sửa về sau. Nghiệm thu là "báo cáo nêu đúng tập đó".

Lý do dẫn từ chính repo này: ghi chú đầu `mailcraft-fidelity.test.ts` ghi lại một cổng từng xanh mà không chặn được gì. Một thước đo **đo vào code đang thay đổi** thì không phải thước đo — allowlist đổi một lần là con số đổi theo, và không ai biết cổng còn canh gì. Mẫu đóng băng cũng nhất quán với §3.1: báo cáo phải *không* phụ thuộc allowlist, nên phép nghiệm thu của nó cũng không được phụ thuộc.

Ranh giới: mẫu phải là **HTML import**, không phải output builder. Output builder đã có `builder-block-sanitizer.test.ts` canh riêng, và nó canh điều ngược lại — rằng builder **không** mất gì.

### 4.3 Task 44 viện một tiền lệ **không tồn tại**

Task 44 viết: *"mỗi mục bấm được để nhảy tới vị trí, **giống 6 mã lint đã làm**"*.

Đo mã: 6 mã lint **không có vị trí**. Hợp đồng của chúng là `{ code, severity, count, field }` (`apps/web/src/api/templates.ts:50`) — không có `start`/`end`. Thứ duy nhất có offset và được tô trong CodeMirror là **biến chưa khai báo** (`TemplateEditorScreen.tsx:335-337` → `codeRanges` → `TemplateCodeView`), và ngay cả nó cũng chỉ là **decoration**, không bấm được để nhảy.

⇒ "Bấm để nhảy" ở S7 sẽ là **cái đầu tiên** trong repo, không phải bản sao. Hai lựa chọn:

- **A.** Báo cáo cũng chỉ có `count` theo loại, không vị trí — rẻ, nhất quán với lint, và đúng tinh thần §3.4 (*"nói cho người nghe hiểu, không phải cho máy hành động"*).
- **B.** Sinh thêm offset cho từng mất mát và dựng cơ chế nhảy — đắt hơn nhiều, và phép đo §3.1 (so sánh kết quả, không nhân bản luật) **không sinh ra offset**: nó đếm, không định vị.

**✅ QUYẾT ĐỊNH: A — chỉ đếm theo loại, không có vị trí, không bấm-để-nhảy.**

Ba lý do, xếp theo sức nặng:

1. **Phép đo đã chọn không sinh ra vị trí.** §3.1 chốt "so sánh kết quả": nó **đếm**, không **định vị**. Đây là bản chất của phương pháp, không phải thiếu sót cài đặt.
2. **Muốn có vị trí thì phải nhân bản allowlist.** Đó đúng là hướng A mà §3.1 đã bác, với lý do vẫn còn nguyên giá trị: ADR-038 rồi ADR-040 rồi ADR-042 đã sửa allowlist ba lần trong hai tuần — bản sao thứ hai sẽ lỗi thời ngay ngày hôm đó.
3. **Tiền lệ mà Task 44 viện dẫn không tồn tại.** Một yêu cầu dựng trên tiền đề sai thì phải suy lại từ đầu, không kế thừa.

Task 46 phải sửa theo: `review_report` trở thành touch point thật khi **báo cáo tồn tại và nêu đúng nội dung**, không phải khi bấm được.

---

### 4.4 "Nhóm theo loại" — làm bằng thứ tự và bằng chính câu chữ, không bằng năm tiêu đề

Phát hiện muộn hơn ba mục trên, khi bắt tay viết Task 44. Kế hoạch ghi *"nhóm theo loại (tag bị xoá / attribute bị xoá / CSS bị xoá / `@media` bị xoá / stylesheet bị xoá cả khối)"* — năm nhóm. Nhưng `changes` là `string[]` (thiết kế §3.4 cố tình giữ vậy), nên màn hình không biết dòng nào thuộc nhóm nào trừ khi đi phân tích lại câu chữ, hoặc trừ khi thêm một trường có cấu trúc vào hợp đồng.

**✅ QUYẾT ĐỊNH: sắp xếp theo loại, và mỗi câu tự nói loại của nó.** Không thêm trường mới, không dựng năm tiêu đề.

- Thứ tự: mất mát lớn trước — `stylesheet` → `@media` → thẻ → ảnh → thuộc tính → khai báo CSS. Trong cùng một loại thì nhiều trước ít, để lúc cắt còn 10 dòng thì cái bị bỏ là cái ít hệ quả nhất.
- Mỗi câu chứa từ chỉ loại: "…1 thẻ `<script>`", "…thuộc tính aria-label trên 2 phần tử", "…3 khai báo background".

Lý do không thêm trường có cấu trúc: §3.4 đã lập luận rằng bề mặt này dành cho **người đọc**, còn phần "máy hành động" đã có lint lo với mã và số đếm. Năm tiêu đề trên một danh sách tối đa 10 dòng, mà phần lớn nhóm chỉ có một dòng, là nghi thức chứ không phải thông tin.

Đo thật, trên một email marketing có nút CTA, đường ngăn và bảng:

```
• Đã loại bỏ thuộc tính aria-label trên 1 phần tử — dùng title.
• Đã loại bỏ 3 khai báo background — dùng background-color.
• Đã loại bỏ 1 khai báo border-top — dùng một hàng bảng có height và background-color.
```

### 4.5 Ba kiểu kể trùng, phát hiện khi nhìn đầu ra thật

Bản cài đặt đầu tiên chạy đúng test nhưng đầu ra thật kể **cùng một mất mát hai lần**: ảnh `http:` vừa được kể là "ảnh" vừa được kể là "thuộc tính src"; ô bảng mất `background` bị kể thêm "mất thuộc tính style" (vì `style=""` rỗng thì bị bỏ theo); và thẻ `<script>` bị xoá còn kéo theo dòng "mất thuộc tính type".

Đã sửa, có test riêng cho cả ba. Nguyên tắc áp dụng: **không bao giờ giấu một mất mát, chỉ giấu câu thứ hai nói về mất mát đã được gọi tên.** Và chỉ bỏ thuộc tính của những thẻ bị xoá **hoàn toàn** — thẻ còn sống ở chỗ khác thì mất mát trên nó là thật.

## 5. Cách đo, để ai cũng lặp lại được

```bash
pnpm --filter @eow/api build
node -e "import('file:///<repo>/apps/api/dist/templates/template-html-sanitizer.js').then(m => console.log(JSON.stringify(m.sanitizeTemplateHtml('<html><body><script>x</script></body></html>'), null, 1)))"
```

Chỗ `@media` bị xoá được chứng minh bằng cách gọi `sanitizeHtml` rồi `juice` tách rời, chạy trong `apps/api` (nơi có `juice` trong `node_modules`).

---

## 6. Hai lỗi nền tìm thấy khi kiểm chứng S6 — đã sửa trước khi bắt đầu S7

Không thuộc S7, nhưng chặn S7: khi `pnpm check` đỏ vì lý do không liên quan, mọi khẳng định "xanh" về sau đều không kiểm chứng được.

**a) Healthcheck của Postgres báo khoẻ trước khi nhận kết nối mạng** (`f42ce44`).

`pg_isready` không có `-h` thì hỏi socket cục bộ, mà server tạm giai đoạn initdb (`listen_addresses=''`) trả lời socket trong khi vẫn từ chối mọi client TCP. Đo trên `postgres:17-alpine`, lấy mẫu 100ms/lần: **ba tick liên tiếp `socket=OK` `tcp=no`**. `migrate`, `api`, `worker`, `scheduler` đều nối qua mạng ⇒ cả bốn có thể được thả vào cửa sổ đó. Không chỉ là lỗi test.

Đáng chú ý: `migration-runner-behavior.test.ts:573` đã ghi đúng luật này cho harness riêng của nó từ trước — đường Compose không kế thừa.

**b) `ARCH-NGINX-ROUTING` đỏ vì ngân sách, không vì định tuyến** (`78a0180`).

Cấu hình nginx đúng — đã đo trực tiếp bằng `curl` qua container nginx thật: GET/POST đường trần và đường phục vụ tệp đều 200, không có header `Location`. Ba khiếm khuyết nằm ở chính cái cổng: ngân sách 30s (mặc định cho test **không** đụng Docker) trong khi nó tạo 3 đối tượng Docker và cần 11,5s lúc rảnh; đăng ký dọn dẹp **sau** khi tạo xong nên giai đoạn tạo không được bảo vệ (đã làm rò một container thật); và `fetch` chờ sẵn sàng không có hạn giờ, trong khi cổng Docker chấp nhận kết nối TCP trước khi bên trong container kịp lắng nghe.

## 7. Ranh giới S7 — nhắc lại để không trôi

- Import **vẫn** tạo `origin: 'imported'` và vào code editor. Không dựng ngược cây component (kế hoạch dòng 780, ADR-037 §3).
- **Không** đụng allowlist (thiết kế §5). Câu hỏi "có nên cho phép X" là ADR riêng.
- **Không** đổi hình dạng `warnings`/`errors`, chỉ `changes` (thiết kế §5).
- `missing_assets` = **liệt kê, không tự sửa** (ADR-043, kế hoạch dòng 784).
