# ADR-044: Prototype Mailcraft là gốc thị giác, không còn là tài liệu tham khảo

Status: Accepted

**Sửa quyết định cũ.** Thay thế mệnh đề *"not copied"* trong ADR-039 §Consequences (gạch
"Porting is a real cost") và câu *"không để chép code sang"* trong
`docs/superpowers/specs/2026-08-31-mailcraft-builder-screen-design.md` §0. Phần còn lại
của ADR-039 (không dùng GrapesJS, builder sở hữu model và emitter) **giữ nguyên** — quyết
định này chỉ đụng tới tầng thị giác, không đụng tới model hay emitter.

**Liên quan:** `design-reference/mailcraft-ui-handoff-v1/` (bản vendor mới) ·
`design-reference/ui-source-contract.yaml` · DEC-009 (`EXECPLAN.md:1501`) ·
`packages/architecture-tests/src/handoff-fidelity.test.ts` ·
`docs/superpowers/specs/2026-09-04-import-modal-vs-handoff-inventory.md`

---

## Context

Repo có **hai** bộ UI đã duyệt, và cho tới hôm nay chúng bị chi phối bởi hai luật ngược nhau:

| Bộ | Luật | Có cổng canh? |
|---|---|---|
| EOW (`ui-handoff-v2`) | DEC-009: *"port the DOM and class names **verbatim** and copy `globals.css` unchanged"* | Có — `ARCH-HANDOFF`, nhưng chỉ 2 tệp |
| Mailcraft (`studio.tsx`) | ADR-039: *"must be migrated… **not copied**"* | **Không có gì** |

Hệ quả đo được ngày 2026-09-04, bằng sáu cuộc rà song song trên toàn bộ MC-UI-001…011:

- **`grep -rn "v3-" apps/web/src` trả về 0 kết quả.** Không một lớp nào trong ~120 lớp của
  prototype tồn tại trong app. Hai bộ từ vựng CSS rời hẳn nhau.
- Phần lớn điều đó **có lý do chính đáng**: khung editor bám sát `ui/UI-HANDOFF.md` §2 tới
  từng con số (rail 56px với đúng 4 mục *Insert · Structure · Reusable blocks · Assets*,
  workspace 320→480px, inspector 336→480px), và bản đặc tả viết ấy **đơn giản hơn** chính
  mã prototype (rail 10 mục). Repo bám bản đặc tả — đúng luật đang có hiệu lực lúc đó.
- Nhưng **bốn chỗ mất mà không tài liệu nào nhắc tới**:

| # | Mất gì | Kiểm chứng |
|---|---|---|
| 1 | Khối **`contact`** — 1 trong 16 `Kind` của prototype (`studio.tsx:7`) | Chữ "contact" không xuất hiện **lần nào** trong toàn bộ `docs/` |
| 2 | Thư viện asset: `v3-brand-kit`, thanh lọc ảnh/logo, ô xem trước trên hàng khối tái dùng, hướng dẫn 3 bước ở trạng thái rỗng | ADR-043 chỉ nói về lưu trữ backend |
| 3 | Bảng chèn: 5 nhóm có đếm số + ô tìm kiếm + 6 mẫu tỷ lệ cột. Cây cấu trúc: nút ẩn/hiện và khoá từng dòng, "+ Section" | Không tài liệu nào nêu |
| 4 | Báo cáo import (S7): bố cục hai cột, huy hiệu phán quyết, hàng ô số, trạng thái rỗng, câu tóm tắt ở thanh đáy | Bản kiểm kê `2026-09-04-import-modal-vs-handoff-inventory.md` |

Điểm chung của cả bốn: **không ai quyết bỏ chúng cả.** Chúng rơi ra vì không có gì canh, và
`ARCH-MAILCRAFT-FIDELITY` — cổng duy nhất chạm tới Mailcraft — chỉ canh **action và state**
trong `mailcraft-screen-catalog.yaml`, không canh hình thức. Một khối biến mất khỏi bộ khối
mà mọi cổng vẫn xanh.

Repo đã từng dính đúng dạng lỗi này: ghi chú đầu `blocks.ts` kể lại một lần bộ khối bị cắt
từ 14 xuống 9 rồi phải hoàn tác, với lý do *"quyết định đó không thuộc thẩm quyền của ai cả"*.
`contact` mất theo cùng một cách, chỉ là lần này không ai bắt được.

## Decision

**Prototype Mailcraft là gốc thị giác của mọi màn hình MC-UI, ngang hàng với bộ EOW.**
DEC-009 áp cho cả hai bộ, không riêng bộ EOW.

Cụ thể, bốn điều:

1. **Vendor vào repo.** `design-reference/mailcraft-ui-handoff-v1/` chứa `source/app/*` và
   `ui/*.md`, sao nguyên văn (đã kiểm `cmp` từng byte cho `studio.tsx`, `studio.css`,
   `mailcraft.css`). Không vendor `node_modules`, giống cách bộ EOW đang làm. Lý do bắt
   buộc: **một cổng không thể so với đường dẫn nằm ngoài repo** — đó là vì sao suốt bốn
   slice không có cổng nào canh được bộ này.

2. **CSS chép nguyên văn, không viết lại — `studio.css`, và chỉ nó.** Tệp này được append vào
   `apps/web/src/app/globals.css` y nguyên. An toàn vì mọi lớp của nó mang tiền tố `v3-`, không
   va với lớp nào của EOW; và `ARCH-HANDOFF` vốn cho phép thêm (*"Additions are free"*).

   **`mailcraft.css` bị loại, và đây là lý do có địa chỉ theo điều 4.** Bản nháp đầu của ADR
   này gộp cả hai tệp. Đo lại trước khi chép thì thấy sai: `mailcraft.css` **không tạo kiểu cho
   thứ gì trong `studio.tsx`**. Chín lớp đặc trưng của nó — `email-hero`, `btn primary`,
   `block-grid`, `inspect-tabs`, `review-btn`, `draft-pill`, `select-name`, `seg`, `product one`
   — đều xuất hiện **0 lần** trong `studio.tsx`, vốn chỉ dùng `v3-*`. Nó là tàn dư của một bản
   prototype đời trước, `layout.tsx` vẫn nạp nhưng đã chết. Selector của nó lại **trần** (`.app`,
   `.canvas`, `.tabs`, `.btn.primary`, `.component`), nên chép vào sẽ gieo 296 dòng CSS chết có
   khả năng va với bất kỳ lớp EOW nào trùng tên trong tương lai. `:root` của nó trùng giá trị
   với `:root` của EOW ở mọi biến dùng chung, nên cũng không mang thêm gì.

   Nếu về sau `studio.tsx` bắt đầu dùng lớp của `mailcraft.css`, điều loại trừ này hết hiệu lực
   và tệp phải được đưa vào cổng.

3. **DOM và tên lớp port nguyên văn.** Các màn MC-UI dùng tên lớp `v3-*` của prototype thay
   cho `builder-*` tự đặt. Các dấu `data-mc-action` / `data-mc-state` **không đổi** — chúng
   độc lập với tên lớp, nên cổng fidelity và bộ e2e hiện có vẫn giữ nguyên hiệu lực.

4. **Sai lệch phải được ghi, không được im lặng.** Mọi chỗ cố ý khác prototype phải có một
   dòng `excludedReason` mang địa chỉ (số ADR hoặc số slice) trong `ARCH-MAILCRAFT-FIDELITY`,
   đúng khuôn Task 24 đang dùng cho action bị kiến trúc bác.

### Cái gì **không** đổi

- ADR-039 phần model/emitter: builder vẫn sở hữu `Doc`/`Node` và emitter của chính nó,
  vẫn không dùng GrapesJS. Quyết định này thuần thị giác.
- ADR-037 §3 vẫn cấm dựng ngược cây component từ HTML. Nên `nativeBlocks`, `customBlocks`,
  `preservedBlocks`, `coverage` trong `ImportReport` của prototype **vẫn nằm ngoài phạm vi** —
  đây là sai lệch có địa chỉ theo điều 4, không phải việc phải khôi phục.
- Ba thứ repo làm **tốt hơn** prototype vẫn giữ và không bị coi là sai lệch cần sửa:
  `role="tree"` + điều hướng bàn phím cho cây cấu trúc (prototype không có gì), preview chạy
  trong `<iframe sandbox="">` (prototype dùng `dangerouslySetInnerHTML`), và khái niệm
  `missing_assets` của ADR-043.

## Consequences

- **Bốn chỗ mất ở §Context phải được khôi phục**, trừ phần ADR-037 §3 đã bác. Đây là một
  slice riêng, không nhét vào S7.
- **Cổng mới `ARCH-MAILCRAFT-SOURCE`** mở rộng `handoff-fidelity.test.ts` sang
  `studio.css`/`mailcraft.css` bằng đúng phép kiểm trừ dần (mọi dòng bản gốc phải còn, đúng
  thứ tự; thêm thì tự do). Không có cổng thì quyết định này chỉ là lời văn — và repo đã có
  tiền lệ một cổng xanh chẳng chặn được gì.
- **Chi phí là thật và phải nói ra.** Port DOM sang `v3-*` đụng vào mã của S3–S6 vốn đã
  chạy, đã có test và đã qua cổng. Đây là làm lại phần thị giác của bốn slice đã đóng, không
  phải một lần sửa nhỏ. Đổi lại: từ nay một khối biến mất khỏi thiết kế sẽ làm đỏ, thay vì
  im lặng suốt bốn slice như `contact`.
- **Bản đặc tả viết và mã prototype vênh nhau** (rail 4 mục so với 10 mục). Điều 3 nói mã
  prototype thắng khi có mâu thuẫn; những mục rail dôi ra (Kho mẫu, Chủ đề, Nhập HTML, Biến,
  Soát lỗi, Lịch sử) đều đã tồn tại trong EOW ở nơi khác, nên việc đưa chúng lên rail là câu
  hỏi bố cục, phải quyết bằng một mục trong slice khôi phục chứ không suy ra được từ đây.
