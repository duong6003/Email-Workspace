# ADR-052: Tỉ lệ cột tự do, danh sách nền tảng mở, và icon mạng xã hội thật

Status: Accepted

Đóng item #8 của thứ tự đề nghị: §3 "Linh hoạt bố cục". Bốn chỗ bị khoá cứng, một đã sửa
2026-09-11 (`stackMobile`). Ba chỗ còn lại — tỉ lệ cột, danh sách nền tảng, icon mạng xã hội —
đóng cùng một ADR vì hai cái cuối sổ nợ tự nói rõ phải làm cùng nhau: "mở danh sách mà vẫn để
icon là chữ thì chỉ đổi một hạn chế này lấy một hạn chế khác."

## Context

### Tỉ lệ cột: toán đã đúng, chỉ thiếu chỗ gõ số

`columnPixelWidth` (`emitter.ts`) tính `Math.round(theme.width * (n.width ?? 100) / 100)` cho
**từng cột độc lập** — không có gì cộng tổng các cột anh em lại và kiểm có bằng 100 không (đo
được: `emitRow` chỉ `map` qua `children`, không có phép toán chéo cột nào). Chỗ duy nhất từng
ghi `Node.width` là `RowLayoutPicker` (`BuilderScreen.tsx`), và nó chỉ chọn nguyên một trong
sáu preset (`ROW_LAYOUT_PRESETS`: 100 / 50-50 / 35-65 / 65-35 / 33-34-33 / 25-25-25-25) — không
có ô nhập số tự do, không có cách gõ 30/70 hay xây hàng 3 cột 20/60/20.

`inspector-fields.ts`'s `containerFields()` (dùng chung cho `section` và `column`) không có
trường `width` nào — không phải vì bị chặn, mà vì chưa ai thêm.

### Mạng xã hội: 5 nền tảng cứng, và editor không có chỗ thêm/bớt dòng

`SOCIAL_PLATFORMS` (`blocks.ts`) là mảng đúng 5 giá trị. `SocialLinksEditor`
(`BuilderScreen.tsx`) có comment tự giải thích lý do không có `<select>` chọn nền tảng lẫn nút
xoá dòng: "`BLOCK_CATALOG` tạo khối social với sẵn cả năm nền tảng... một dòng chỉ bật/tắt,
không bao giờ thêm hay đổi." Đúng khi còn 5 giá trị cố định; sai ngay khi danh sách mở ra —
seed toàn bộ 9+ nền tảng mỗi lần chèn khối là một hồi quy UX.

### Icon: chữ chưa qua tạo kiểu, không phải chữ thật

`emitSocial` xuất `escapeHtml(link.platform)` làm nội dung nhìn thấy của `<a>` — email nhận
được đúng chữ tiếng Anh "facebook", không phải icon. Canvas cũng vậy (`BuilderScreen.tsx`'s
preview branch cho `kind === 'social'`): `{link.label || link.platform}` — cả hai nơi cùng một
lỗi, không phải một nơi đúng một nơi sai.

### Prototype gốc đã có câu trả lời, chỉ chưa được dựng

`studio.tsx` (line 20-26, 118-119, 840, 861, ~886):
- `Node.socialStyle?: "circle" | "square" | "text"`, `socialSize?: number` — chưa từng port.
- Glyph: `{facebook:"f", linkedin:"in", instagram:"ig", youtube:"yt", website:"↗"}` — chữ đã
  tạo kiểu, không phải ảnh, không phải SVG.
- Inspector: một `Segment(["circle","square","text"])` + slider 24-48px.

CSS ba biến thể (`.v3-p-social.circle/.square/.text`, cộng `.missing`) **đã được vendor**
byte-for-byte vào `globals.css` từ ARCH-HANDOFF — không ai gắn class chọn giữa chúng cho tới
ADR này. Grep xác nhận: `.v3-social-edit>div{grid-template-columns:29px 75px 1fr 25px}` và
`.v3-social-edit select`/`.v3-social-edit button` đều có luật CSS sẵn — bằng chứng editor gốc
của prototype vốn có `<select>` nền tảng + nút xoá, đúng thứ ADR này phục hồi, không phải bịa
mới.

### Sanitizer: chữ tạo kiểu không cần mở gì cả; SVG/ảnh thì cần

Grep `apps/api/src/templates/template-html-sanitizer.ts`: `<svg>` **không** nằm trong
`emailTags` — mở nó là một quyết định riêng (thẻ mới + thuộc tính con + đo sống sót, đúng độ
nghiêm ADR-042 đã áp cho CSS). `<img src>` được phép nhưng **chỉ** `https:`/`cid:` — và repo
**không có hạ tầng icon nào**: `Asset.kind` chỉ có `logo`/`image`, mọi asset đều do tenant tự
tải lên (ADR-043), không có thư viện icon dùng chung. `UiIcon` (`app/ui-icons.tsx`) là SVG nội
tuyến chỉ dùng cho giao diện ứng dụng — không đi qua `emitter.ts`, và dù có thì `<svg>` cũng bị
sanitizer tước.

Đo trước khi quyết: dựng markup huy hiệu tròn (`width/height/line-height/border-radius/border`)
và markup chữ-gạch-chân (`text-decoration:underline`), chạy qua `sanitizeTemplateHtml` thật —
**cả hai sống sót nguyên vẹn, 0 thay đổi**. Bảy thuộc tính CSS cần dùng đều đã mở sẵn.

⇒ Ba lựa chọn cho icon — SVG (cần ADR allowlist riêng), ảnh `<img>` (cần hạ tầng icon chưa có),
chữ tạo kiểu (đã có công thức từ chính prototype, không cần gì mới) — chọn chữ tạo kiểu, không
phải vì rẻ nhất mà vì đó là thiết kế gốc thật sự, chỉ chưa từng được dựng.

## Decision

### 1. Trường `width` tự do cho cột

`inspector-fields.ts`: `column: () => [{ key: 'width', label: 'Tỉ lệ cột (%)', type: 'number',
tab: 'design' }, ...containerFields()]` — tách khỏi `containerFields` dùng chung với `section`
(section không có `width`, thêm control ở đó sẽ là control không đổi gì — đúng bẫy ADR-042).
`RowLayoutPicker` (6 preset) vẫn là đường nhanh cho tỉ lệ phổ biến; trường mới là ghi đè tự do
trên **một** cột tại một thời điểm — gõ 30/70 nghĩa là chọn cột, gõ 70, chọn cột kia, gõ 30.

Không ép tổng bằng 100 — đo được (Context) không có gì ràng buộc điều đó hôm nay và không có gì
bắt buộc phải thêm. Thay vào đó, `RowLayoutPicker` hiện thêm một gợi ý sống: tổng tỉ lệ hiện tại
nếu khác 100% được in ra thành cảnh báo nhẹ, không chặn gì — đúng dạng "nói ra thay vì im lặng"
mà ADR-048 §Consequences đặt tên cho quy ước "mỗi dòng một mục".

### 2. `SOCIAL_PLATFORMS` mở từ 5 lên 9, cộng lối thoát `other`

```ts
// document.ts
export const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'linkedin', 'youtube', 'tiktok', 'zalo', 'threads', 'website', 'other'] as const;
```

Ba cái sổ nợ gọi tên (Zalo, TikTok, Threads) cộng `other` — nền tảng thứ mười không bao giờ cần
sửa code để dùng được, chỉ cần `label` (dùng làm chữ cái đầu cho glyph, xem mục 3) và một huy
hiệu chữ chung chung cho tới khi một ADR thật đặt tên nó. Đóng, không phải chuỗi tự do — giữ an
toàn kiểu và dễ kiểm, đúng tiền lệ `list-style-type` (ADR-048) chọn từ vựng đóng thay vì regex
mở.

`blocks.ts`'s `DEFAULT_SOCIAL_PLATFORMS = ['facebook', 'instagram', 'website']` — chỉ ba, không
phải chín: seed toàn bộ danh sách mỗi lần chèn khối là hồi quy UX một khi danh sách vượt quá
năm. `SocialLinksEditor` (`BuilderScreen.tsx`) được dựng lại với `<select>` nền tảng + nút xoá
dòng + nút "＋ Thêm mạng xã hội" — phục hồi đúng lưới 4 cột CSS đã chờ sẵn (mục Context).

### 3. Icon: glyph chữ đã tạo kiểu, không phải chữ trần

`emitter.ts`:
```ts
const SOCIAL_GLYPH: Record<SocialPlatformKind, string> = {
  facebook: 'f', linkedin: 'in', instagram: 'ig', youtube: 'yt',
  tiktok: 'tt', zalo: 'za', threads: 'th', website: '↗', other: '•',
};
export function socialGlyph(link: SocialLink): string {
  if (link.platform === 'other') { const c = link.label?.trim().charAt(0); return c ? c.toUpperCase() : SOCIAL_GLYPH.other; }
  return SOCIAL_GLYPH[link.platform];
}
```
`emitSocial` dựng huy hiệu bằng `<a style="...">` — `width`/`height`/`line-height`/
`border-radius`/`border` cho `circle`/`square`, bỏ hết bốn thứ đó và gạch chân cho `text` — một
hàm, không phải `<div class="v3-p-social">` kiểu flex của prototype: `display:flex` tuy sống
sót sanitizer (khớp mẫu từ khoá chung của `safeStyleValues`) nhưng flexbox trong email vỡ trên
Outlook desktop — `<p>` bọc các `<a inline-block>` đạt đúng hình ảnh mà không cần flex.

Canvas (`BuilderScreen.tsx`'s nhánh xem trước `social`) gọi **cùng** `socialGlyph` — nhập từ
`emitter.js` — nên canvas và email không bao giờ hiện hai thứ khác nhau cho cùng một liên kết.
`socialStyle`/`socialSize` thêm vào `Node` (mặc định `circle`/32px khi bỏ trống, khớp giá trị
mặc định của chính prototype).

### Cái gì không đổi

- Sanitizer: không đổi allowlist nào (đo ở Context — bảy thuộc tính đã mở sẵn).
- Không route mới, không migration, không asset mới.
- `<svg>` vẫn bị tước — mở nó, nếu cần sau này, là một ADR riêng.
- `ARCH-MAILCRAFT-SOURCE`'s `ADDED_KINDS` không đụng: `social` đã là kind đã duyệt từ trước, ADR
  này chỉ mở rộng GIÁ TRỊ của `SocialLink.platform`, không thêm/đổi/bỏ kind nào — gate đó chỉ
  soi cấp *kind*, không soi cấp giá trị enum bên trong một field (đo được, không có gate nào
  hiện ghim 5 giá trị cũ).

## Consequences

**Bảng cổng (mutation-tested):**

| Gì phải giữ | Test |
|---|---|
| Không quay lại lỗi cũ: chữ "facebook" thô không được xuất hiện làm nội dung nhìn thấy | `emitter.test.ts`, `builder-block-sanitizer.test.ts` — assert trực tiếp "không quay lại lỗi" |
| Mỗi nền tảng đóng có glyph riêng; `other` lấy chữ cái đầu của `label`, viết hoa; `other` không nhãn thì chấm tròn, không im lặng | `emitter.test.ts` — 8 nền tảng + 2 ca `other` |
| Huy hiệu tròn/vuông/chữ đúng CSS qua sanitizer thật (không phải chỉ qua emitter) | `builder-block-sanitizer.test.ts` describe riêng, sống sót thật |
| Mặc định không đặt gì = tròn, 32px, khớp prototype | `emitter.test.ts` |
| Nhãn dùng làm glyph vẫn bị escape (an toàn XSS không đổi khi thêm đường dữ liệu mới) | cả hai file trên |
| Tỉ lệ 20/60/20 và 30/70 tính đúng pixel dù không có preset nào cho chúng | `emitter.test.ts` — đúng ví dụ sổ nợ nêu |
| Column có đúng field Section cộng thêm `width`, không hơn không kém | `inspector-fields.test.ts` |
| Khối social mới chỉ seed 3 nền tảng, không trùng lặp | `blocks.test.ts` |
| Mẫu `ARCH-BUILDER-SANITIZER` cho `social` khai cả `socialStyle`/`socialSize` lẫn một link `other` | `builder-block-sanitizer.test.ts` `sampleNodes.social` |

**Còn nợ lại, cố ý không làm ở đây:**
- Không ép tổng tỉ lệ cột bằng 100 — chỉ gợi ý, không chặn (Context giải thích vì sao).
- `<svg>`/ảnh icon thật theo brand: chưa làm, cần ADR allowlist hoặc hạ tầng icon riêng nếu sau
  này cần độ trung thực thương hiệu cao hơn glyph chữ.
- Không thêm gate `ARCH-*` ghim giá trị `SOCIAL_PLATFORMS` — không có tiền lệ nào đòi việc đó ở
  cấp giá trị-trong-field (khác cấp *kind*), và một gate không ai yêu cầu là một trừu tượng thừa.

## Phương án đã cân nhắc và loại

- **Chuỗi tự do cho `platform`** thay vì union đóng 9 giá trị + `other`. Loại: mất an toàn kiểu
  cho việc tra glyph, và một danh sách mở vô hạn không khác gì không có danh sách — `other` +
  label đã cho tác giả lối thoát mà không cần từ bỏ kiểm tra kiểu.
- **Ảnh `<img>` icon thương hiệu thật.** Loại (hoãn): không có hạ tầng icon nào trong repo hôm
  nay (mọi asset đều do tenant tải, không có thư viện dùng chung) — xây nó là một quyết định hạ
  tầng riêng, không phải một chỉnh sửa nhỏ.
- **`<svg>` inline.** Loại (hoãn): không nằm trong allowlist thẻ của sanitizer; mở nó đòi đúng
  độ nghiêm ADR-042 áp cho CSS — đo, rồi mới mở, không đoán.
- **Ép buộc tổng tỉ lệ cột bằng 100 (chặn xuất bản hoặc tự động chuẩn hoá).** Loại: không có gì
  đòi hỏi điều đó về mặt kiến trúc hôm nay, và tự động chuẩn hoá sẽ âm thầm đổi con số tác giả
  vừa gõ — một cảnh báo sống là đủ để tác giả tự sửa mà không mất quyền kiểm soát.
- **Seed toàn bộ 9 nền tảng cho khối social mới**, giữ nguyên hành vi cũ. Loại: đúng thứ chính
  sổ nợ than phiền ("mở danh sách... nên làm cùng nhau" với icon) — mở danh sách mà vẫn ép mọi
  khối mới mang 9 dòng là đổi một hạn chế lấy một hạn chế khác theo đúng cách khác.
