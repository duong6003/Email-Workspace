# Màn Import HTML: đối chiếu với prototype — bước lẽ ra phải làm trước Task 44

**Ngày:** 2026-09-04
**Vì sao có tài liệu này:** `design-reference/ui-source-contract.yaml` đòi `inventory_routes_screens_components_modals_states_..._first`. Tôi đã dựng màn `review_report` (S7 Task 44–45) **trước khi** làm việc kiểm kê này, và chỉ làm nó sau khi người dùng hỏi vì sao UI không lấy từ bộ handoff. Tài liệu này trả nợ đúng bước đó, và nêu ra hai điểm cần người dùng quyết.
**Nguồn có thẩm quyền:** `design-reference/ui-handoff-v2/source/app/action-overlays.tsx`, nhánh `type === 'importHtml'` (dòng 126–129). Trạng thái đăng ký: `python scripts/ui_handoff.py status` → `"status": "ready"`, sha256 `e15ce4c2…`.

---

## 1. Hai bộ handoff, chi phối hai thứ khác nhau

Dễ lẫn, nên nói rõ một lần:

| Bộ | Ở đâu | Quyết định điều gì | Được canh bằng |
|---|---|---|---|
| **Mailcraft** | `../mailcraft-ui-handoff-v1/` (ngoài repo, chỉ đọc) | **Cái gì phải có**: danh mục màn hình, state, action | `design-reference/mailcraft-screen-catalog.yaml` (bản sao trong repo) — `ARCH-MAILCRAFT-FIDELITY` **đọc thẳng tệp này** |
| **EOW** | `design-reference/ui-handoff-v2/source` (trong repo) | **Trông thế nào và tương tác ra sao** | `ui-source-contract.yaml` → `precedence.presentation_and_interaction` |

Sáu state và bốn action của MC-UI-006 đến từ bộ thứ nhất, và cổng fidelity sẽ đỏ nếu thiếu bất kỳ cái nào. Đó là phần đã đúng.

Bộ thứ hai là phần tôi bỏ qua.

## 2. Prototype nói gì về đúng modal này

```tsx
} else if (type === "importHtml") {
  title = "Import HTML template";
  subtitle = "Hệ thống sẽ kiểm tra cấu trúc, ảnh và biến dữ liệu.";
  content = <>
    <label className="upload-zone">
      <input type="file" accept=".html,text/html"/>
      <span>&lt;/&gt;</span>
      <b>Kéo thả file .html vào đây</b>
      <small>Dung lượng tối đa 5 MB</small>
    </label>
    <div className="validation-list">
      <p><span>✓</span> CSS inline được hỗ trợ</p>
      <p><span>✓</span> Tự động phát hiện biến {"{{variable}}"}</p>
      <p><i>!</i> Script và iframe sẽ bị loại bỏ</p>
    </div>
  </>;
  footer = <><Secondary>Hủy</Secondary><Primary>Import template</Primary></>;
}
```

**Điều đáng chú ý nhất:** khối `validation-list` với ba dòng ✓/! **chính là ý tưởng báo cáo sanitizer**, chỉ ở dạng lời hứa tĩnh — *"Script và iframe sẽ bị loại bỏ"*. Thứ S7 làm là biến đúng khối đó thành sự thật đo được cho từng lần import. Về bản chất đây là **thực hiện ý đồ của prototype**, không phải đi chệch nó.

## 3. Bảng khác biệt — tách rõ cái có từ trước và cái tôi mới thêm

| Điểm | Prototype | Màn hình hôm nay | Ai gây ra |
|---|---|---|---|
| Tiêu đề | "Import HTML template" | "Import HTML" | **Có từ trước** (M3) |
| Phụ đề | "…kiểm tra cấu trúc, ảnh và biến dữ liệu." | "…Script, iframe và nguồn ảnh không an toàn sẽ bị loại bỏ trước khi lưu." | **Có từ trước** |
| Ô tên / tiêu đề email | không có | có, tên là bắt buộc | **Có từ trước** — API đòi `name` |
| Vùng chọn tệp | `label.upload-zone`, kéo-thả được | `button.drop-zone`, chưa kéo-thả | **Có từ trước**. `drop-zone` cũng là lớp của prototype (`page.tsx`), nên vẫn trong từ vựng thiết kế — nhưng **mất khả năng kéo-thả** |
| Dán mã HTML | không có | có `textarea` | **Có từ trước** |
| Nhãn nút chính | "Import template" | "Lưu template" | **Có từ trước** |
| Khối `validation-list` | 1 khối, 3 dòng tĩnh | tối đa 4 khối, nội dung đo thật | **Tôi thêm** — đúng thành phần, nội dung thật |
| Số nút ở footer | 2 | 3 (thêm "Phân tích HTML") | **Tôi thêm** ⚠️ |
| Số bước | 1 bấm | 2 bấm | **Tôi đổi** ⚠️ |
| Ô `input[type=file]` | nằm trong `label`, không hiện | trước: hiện ra thành hộp "Choose File" thô | **Có từ trước** — đã sửa (`.visually-hidden` chưa từng được định nghĩa), sửa xong thì **gần prototype hơn** |

**Về nút thứ ba:** footer ba nút không xa lạ với prototype — 26 overlay của nó có từ hai `Secondary` trở lên, và chính overlay `templatePicker` có `Secondary | spacer | Secondary | Primary`. Nên đây **không** phải phá vỡ ngôn ngữ thị giác. Cái tôi đổi là **tương tác**, và hợp đồng ghi rõ `preserve_approved_layout_color_typography_copy_assets_and_interactions` — nên vẫn là vi phạm, chỉ hẹp hơn tôi tưởng lúc đầu.

Một chi tiết nhỏ: prototype đặt `Secondary` phụ ở **bên trái** kèm `footer-spacer`; tôi đặt cạnh nút chính bên phải. Với `templatePicker` thì nút trái là hành động **rẽ sang chỗ khác**, còn "Phân tích HTML" là **bước bắt buộc trong cùng luồng** — nên đặt cạnh nút chính có lý do. Vẫn là lựa chọn, không phải suy ra từ hợp đồng.

## 4. Vì sao lại thành hai bước — và vì sao lý do không thay thế được việc xin phép

Luồng cũ (một bấm) làm thế này:

```ts
const checked = await analyzeTemplate({ subject, html });
setAnalysis(checked);                    // ← đặt vào state
const created = await createTemplate({ ... });
onClose();                               // ← modal đóng, state biến mất
```

Kết quả phân tích được lấy về, cất vào state, rồi **vứt đi ngay** khi modal đóng. Khối hiển thị nó (`{analysis && …}`) trên thực tế **không bao giờ kịp hiện**. Nghĩa là dù có báo cáo hay không, người dùng cũng không thấy.

Đó là lý do thật, và nó đủ mạnh. Nhưng hợp đồng nói `do_not_redesign_without_explicit_approval`, không nói "trừ khi có lý do chính đáng". Có ít nhất một phương án khác giữ được một bước — ví dụ tạo nháp xong thì **chuyển thẳng sang trình soạn thảo và hiện báo cáo ở đó**, đúng như bảng §4 của thiết kế sanitizer-report vốn đã dự trù một bề mặt "Editor (autosave)". Tôi chưa cân nhắc phương án đó trước khi đổi.

⇒ **Cần người dùng chọn.** Ghi ở `state.json` → `blocker.items[4]`.

## 5. Một việc handoff Mailcraft yêu cầu mà tôi bỏ sót

`../mailcraft-ui-handoff-v1/ui/INTERACTION-STATES.md` §Import state:

> *"Analysis failure never discards the uploaded source. The user can download the report or retry with another strategy."*

- **"never discards the uploaded source"** — đã làm: `import_fallback` giữ nguyên HTML và vẫn lưu được.
- **"download the report"** — **chưa làm, và cũng chưa ghi nợ**. Đây là thiếu sót thật, không phải nằm ngoài phạm vi.

Cùng mục đó liệt kê bốn nhóm kết quả: *converted to native / partially converted / preserved as custom fallback / blocked or missing*. Ba nhóm đầu chỉ có nghĩa khi import **vào builder** — thứ ADR-037 §3 cấm và kế hoạch dòng 780 nói rõ S7 không được lặng lẽ mở rộng sang. Nhóm thứ tư là thứ S7 làm. Điều này đúng, nhưng lẽ ra phải được nói ra ở Task 43 chứ không phải bây giờ.

⇒ **Cần người dùng chọn**: làm nút tải báo cáo ở S7, hay ghi thành deferred có địa chỉ slice. Ghi ở `blocker.items[5]`.

## 6. Còn nợ: đối chiếu thị giác trên ba viewport

`ui-source-contract.yaml` đòi `verify_visual_equivalence_before_screen_completion` trên `1440×900`, `768×1024`, `390×844`. Tôi mới chụp **một** ảnh desktop `1440×1000`, và chụp **sau khi** làm xong thay vì đối chiếu trước. Đang chụp bù đủ ba viewport; kết quả sẽ nằm ở `.agents/runs/2026-08-31-mailcraft-builder/evidence/s7-task46/`.
