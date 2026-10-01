# ADR-043: Kho lưu trữ asset cho ảnh builder — object store S3-compatible, URL vĩnh viễn do app sở hữu

Status: Accepted

Mở khoá S6 (MC-UI-005 Asset and logo library). Không thay thế ADR nào. Kế thừa ràng buộc
ảnh của ADR-037 §1 và BR-TPL-009; kế thừa quy ước port của ADR-039 §"UI nói chuyện qua port".

**Liên quan:** `docs/superpowers/plans/2026-08-31-mailcraft-builder-vertical-slice.md` §S6 ·
`docs/superpowers/specs/2026-08-31-mailcraft-builder-screen-design.md` §2.12, §3.2, §5.2 ·
`../mailcraft-ui-handoff-v1/design-reference/screen-catalog.yaml` MC-UI-005

---

## Context

`screen-catalog.yaml` MC-UI-005 đòi bốn action `upload` · `replace` · `bind` ·
`mark_decorative` và năm state, trong đó có `missing_assets`. Plan §"Hai thứ chặn thật"
nói rõ đây **không phải mục được phép bỏ**, mà là một phụ thuộc chưa tồn tại và phải
được làm.

### Đo trước khi quyết — EOW hôm nay có gì (khảo sát 2026-09-03)

| Câu hỏi | Kết quả đo |
|---|---|
| Có thư viện xử lý upload? | **Không.** `multer`, `busboy`, `@aws-sdk/*`, `minio`, `sharp` đều không có trong `package.json` gốc lẫn `apps/api/package.json` |
| Có route nhận `multipart/form-data`? | **Không.** Không một chỗ nào trong `apps/api/src` |
| Có object store trong hạ tầng? | **Không.** `compose.yaml` có postgres · redis · mailpit · api · worker · scheduler · web · prometheus · grafana |
| Có route công khai (không cần đăng nhập)? | **Có.** `@Public()` (`apps/api/src/common/decorators/public.decorator.js`) opt-out khỏi `AuthGuard` toàn cục (`auth.guard.ts:21-35`); `auth.controller.ts` đã dùng ba lần |
| Nginx định tuyến thế nào? | `/api/` → api upstream; `/socket.io/` → api; còn lại → web (`deploy/nginx/default.conf`) |

⇒ Đây **không phải việc nối dây** như S1 (cột DB đã có, chỉ thiếu đường ra contract).
Đây là một tầng hạ tầng chưa từng tồn tại.

### Bốn ràng buộc kế thừa, không thương lượng được

1. **Sanitizer chỉ nhận `src` là `https:` hoặc `cid:`, không base64** (§2.12, BR-TPL-009).
   ⇒ ảnh phải có URL thật. Quyết định "lưu ở đâu" **không tách rời** quyết định "phục vụ
   bằng URL nào".
2. **Version bất biến** (§2.10, `PATCH /template-versions/:id` → `405`). HTML đã xuất bản
   **không sửa được**. ⇒ URL nhúng trong đó phải sống ít nhất bằng tuổi thọ của email đã gửi.
3. **`id` và `data-*` bị sanitizer xoá** (ADR-037 §3). ⇒ ánh xạ node↔asset nằm trong
   `projectData`, không phải trong HTML.
4. **Sáu mã lint là cố định** (§2.8), `IMAGE_ALT_MISSING` là một trong sáu. ⇒
   `mark_decorative` không được đẻ ra mã thứ bảy.

### Ràng buộc số 2 loại thẳng một phương án

Presigned URL có hạn — mặc định của mọi hướng dẫn "upload lên S3" — **không dùng được ở
đây**. Email đã gửi nằm trong hộp thư người nhận lâu hơn mọi TTL; presigned link hết hạn
nghĩa là **ảnh hỏng trong email đã duyệt**, mà version bất biến không cho sửa lại. Đây là
điểm asset-cho-email khác asset-cho-web, và là lý do ADR này tồn tại thay vì "cứ làm như
mọi nơi vẫn làm".

---

## Decision

### 1. Backend: object store S3-compatible; MinIO là container dev

Thêm một container MinIO vào `compose.yaml` và phụ thuộc `@aws-sdk/client-s3` vào
`apps/api`. Production trỏ sang S3/R2/Spaces bằng biến môi trường, không đổi code.

Lý do chọn cái này thay vì đĩa cục bộ: đĩa cục bộ buộc `api` dính vào một volume cụ thể,
chặn scale ngang, và việc chuyển sang object store sau này là **một cuộc migration dữ liệu
thật** chứ không phải đổi cấu hình. Cái giá phải trả được ghi nhận thẳng: máy dev hiện
thiếu RAM (`pnpm infra:up` tồn tại chính vì lý do đó), nên MinIO **phải nằm trong
`infra:up`**, không phải một container thứ chín chỉ chạy khi dựng đủ stack.

### 2. Đường phục vụ: một route công khai của app, không phải URL của object store

Ảnh nhúng vào email là `https://<host>/api/v1/assets/<asset_id>/<slug>.<ext>` — route
`@Public()`, stream từ object store, `Cache-Control` dài.

**Sửa 2026-09-03:** bản gốc ghi `/api/assets/...`, thiếu `/v1/`. Đây không phải đổi quyết
định, mà là chữa một lỗi thật: `assetPublicUrl` (Task 36) đã in ra đúng cái sai này, và mọi
test liên quan — cả `assets-http.test.ts` lẫn `builder-block-sanitizer.test.ts` — tự dựng
lại đường dẫn đúng bằng tay thay vì fetch thẳng giá trị `url` trả về, nên không ai bắt được.
Lộ ra khi lần đầu tiên có một domain thật fetch đúng URL đó. Xem
`apps/api/src/assets/asset-storage.ts` cho lý do đầy đủ.

**Không** nhúng URL trực tiếp của object store, dù bucket có để public. Lý do là ràng buộc
số 2: URL của store đổi theo môi trường (MinIO ở dev, S3/R2 ở prod) và đổi khi hạ tầng
chuyển nhà; một URL như thế đã bị **đóng băng vĩnh viễn** vào version bất biến sẽ chết lúc
chuyển. URL do app sở hữu là cái duy nhất sống sót được ràng buộc bất biến — và nó cũng là
chỗ đặt CDN sau này mà không đụng tới HTML đã xuất bản.

`asset_id` là UUID, không đoán được. **Nói thẳng hệ quả:** URL công khai là một
*bearer capability* — ai có link đều tải được, không cần đăng nhập. Điều này là **bắt buộc**
với ảnh email (mail client fetch không kèm cookie của ta), không phải sơ suất. Vì thế kho
asset **không phải chỗ để tệp nhạy cảm**, và UI phải nói điều đó ở chỗ upload.

**Sửa 2026-09-04, lỗi nghiêm trọng hơn dòng URL ở §2:** route `@Public()` không
đọc được **hàng nào cả**, luôn luôn, cho tới migration `077_asset_serve_bypass.sql`.
`asset` bật RLS với policy `tenant_id = current_tenant_id()` (§3 dưới đây), và
`current_tenant_id()` trả `NULL` khi `app.tenant_id` chưa set — mà route công khai
thì **cố tình** không set, vì nó chưa biết tenant trước khi tra ra hàng (đúng
nguyên tắc "id là capability" ở trên). `tenant_id = NULL` không bao giờ đúng, nên
`eow_app` luôn thấy 0 hàng. Đo trực tiếp: `psql -U eow_app` không set tenant, tra
một id có thật → `(0 rows)`, mọi lần. **Mọi asset upload từ Task 36 tới giờ đều
404 khi mail client thật fetch.** Không ai bắt được vì bài test duy nhất động vào
route này (`assets-http.test.ts`) khởi động app-dưới-test bằng **role owner**
(`testDatabaseUrl()`), vốn bypass RLS hoàn toàn — bài test không sai, nó chỉ chưa
từng thật sự chạm RLS. `asset-rls.test.ts` (Task 34) nối đúng bằng `eow_app`
nhưng chỉ kiểm luật chung ("fails closed khi chưa set tenant") — đúng, nhưng
không ai viết thêm ngoại lệ riêng cho route này. Sửa theo đúng khuôn
`013_outbox_relay_api.sql` đã dùng cho vấn đề y hệt: một hàm `SECURITY DEFINER`
hẹp, trả đúng 4 cột `AssetsService.serve()` cần, không trả nguyên hàng.

### 3. Cách ly tenant: một bucket, prefix theo `tenant_id`, hàng DB là nguồn sự thật

Key: `tenant/<tenant_id>/<asset_id>`. Bảng `asset` (migration `076_asset_storage.sql` — 075 đã bị `reusable_block` của S5 lấy) mang
`tenant_id`, `content_type`, `byte_size`, `width`, `height`, `original_filename`,
`created_by`, `archived_at`.

Bucket riêng mỗi tenant **không** làm bây giờ: §3.3 nói rõ chưa tiêu chí ADR-008 nào đang
đúng, và tiêu chí compliance là một trong năm cái đó. Prefix giữ nguyên đường nâng cấp —
đổi sang bucket riêng là đổi hàm sinh key, không phải đổi mô hình dữ liệu.

Route liệt kê/xoá đi qua `AuthGuard` + RBAC bình thường: đọc cần `content:read`, ghi cần
`content:manage` (tiền lệ migration 073). Chỉ route **phục vụ tệp** là `@Public()`.

### 4. Giới hạn: 5 MB, và **không SVG**

- Kích thước: **5 MB/tệp**, cùng con số với trần HTML template (§2.12) — một số để nhớ, không phải hai.
- MIME cho phép: `image/png` · `image/jpeg` · `image/gif` · `image/webp`.
- **`image/svg+xml` bị từ chối.** SVG chạy được script. Sanitizer đã xoá tag `svg` khỏi HTML
  (§2.12); phục vụ tệp SVG từ chính origin của ta qua một route công khai sẽ mở lại đúng bề
  mặt tấn công đó bằng cửa sau, và tệ hơn — ở origin của app, nơi cookie phiên đang sống.
- MIME xác định bằng **magic bytes**, không tin `Content-Type` client gửi lên. **Làm rõ
  2026-09-03 (lỗ hổng do Task 35 chỉ ra):** "không tin" nghĩa là **không đọc đến nó**, chứ
  không phải "từ chối khi hai bên lệch nhau". Bản nháp đầu của validator từ chối khi lệch;
  nó không mua được chút an toàn nào — kiểu đã sniff mới là thứ được lưu và phục vụ, kiểu
  client khai không bao giờ chạm tới storage — mà lại mở một đường **từ chối nhầm ảnh hợp
  lệ**: client thật gửi `image/jpg`, `application/octet-stream`, hoặc rỗng khi kéo-thả một
  tệp không có đuôi. `validateAssetUpload` vì thế chỉ nhận **bytes**.
- **Nhận diện SVG là heuristic, và nó hỏng về phía an toàn.** Quét 256 byte đầu (bỏ qua BOM
  và khoảng trắng) tìm `<?xml` hoặc `<svg`. Một tệp SVG dựng đặc biệt để đẩy thẻ mở ra ngoài
  cửa sổ đó sẽ **không** được nhận là SVG — nhưng nó cũng không khớp chữ ký nhị phân nào, nên
  rơi vào `UNSUPPORTED_TYPE` và **vẫn bị từ chối**. Mất đi chỉ là thông điệp cụ thể, không
  phải hàng rào.
- Hạn mức tenant: chưa đặt số. Ghi nhận là quyết định để mở, không phải quên.

### 5. Vòng đời: xoá mềm, không bao giờ xoá cứng

`archived_at`, không `DELETE`. Lý do là ràng buộc số 2 lần nữa: xoá cứng một asset mà một
version **đã xuất bản** còn trỏ tới là làm hỏng một email đã duyệt, mà version thì không sửa
được. Cùng khuôn với BR-TPL-001 (`draft`/`published`/`archived`, không xoá cứng).

Asset đã archive **vẫn được phục vụ** ở route công khai — archive là ẩn khỏi thư viện, không
phải gỡ khỏi email đã gửi. UI phải nói rõ điều này, nếu không người dùng sẽ tưởng đã thu hồi.

### 6. `cid:` không thuộc S6

Chỉ `https:`. `cid:` kéo quyết định sang tầng gửi (`apps/worker` phải đính tệp vào MIME),
làm S6 rộng gấp đôi mà không phục vụ cổng thoát của vertical slice.

**Hệ quả phải nói với người dùng, không được giấu:** Outlook desktop và nhiều client chặn
ảnh ngoài theo mặc định ⇒ **logo sẽ hiện thành ô trống** cho tới khi người nhận bấm "hiển
thị ảnh". Đây là cùng loại đánh đổi ADR-040 đã ghi cho preheader (`mso-hide:all` bị xoá), và
xử lý giống nhau: nói thẳng trong copy, không giả vờ nó không tồn tại. `cid:` để mở cho một
slice sau.

### 7. Port `AssetProvider` — cổng thứ sáu, đóng lại bộ sáu của spec §1.4

Thêm vào `apps/web/src/screens/templates/editor-ports.ts`, không dựng bộ contract mới:

```ts
export type Asset = {
  id: string; url: string; filename: string;
  contentType: string; byteSize: number;
  width: number | null; height: number | null;
};

export type AssetProvider = {
  list: () => Promise<Asset[]>;
  upload: (file: File) => Promise<Asset>;
  replace: (assetId: string, file: File) => Promise<Asset>;
  archive: (assetId: string) => Promise<void>;
};
```

`bind` và `mark_decorative` **không** nằm ở port — chúng là thao tác trên cây tài liệu
(gán `src` cho node `image`/`logo`/`banner`, và đặt cờ trang trí), nên thuộc `tree-ops.ts`.
Đưa chúng vào port sẽ để UI sửa tài liệu qua hai đường, phá §2.13.

`replace` **tạo asset mới rồi trỏ lại**, không ghi đè byte của asset cũ — ghi đè sẽ đổi
nội dung ảnh trong mọi email đã xuất bản đang trỏ tới nó, lại là ràng buộc số 2.

### 8. `mark_decorative` giải bằng `projectData`, không bằng mã lint thứ bảy

Node mang cờ `decorative: true`. Emitter dịch ra `alt=""` **và** `role="presentation"`.
`IMAGE_ALT_MISSING` phải **không** kêu khi `alt=""` đi kèm `role="presentation"` — đó là
`alt` rỗng có chủ đích, khác hẳn `alt` thiếu.

Đây là thay đổi hành vi của một trong sáu mã, nên phải có test riêng: ảnh trang trí ⇒ 0
cảnh báo; ảnh thiếu `alt` mà không có `role="presentation"` ⇒ vẫn 1 cảnh báo. §2.8 cấm định
nghĩa bộ mã khác, **không** cấm làm một mã có sẵn chính xác hơn.

**Bổ sung 2026-09-03 — điều mục này chưa lường trước:** đo qua sanitizer thật (Task 39)
lộ ra `role` đang bị **xoá khỏi `<img>`**, vì allowlist attribute của `img` chỉ có
`alt`/`height`/`src`/`title`/`width` (`template-html-sanitizer.ts`, từ M3-S1). Vậy cặp
`alt=""` + `role="presentation"` mục này yêu cầu **không sống sót nổi tới lúc lưu**, và
`IMAGE_ALT_MISSING` không bao giờ đọc được nó vì lint chạy trên HTML đã sanitize. Quyết
định ở đây chốt đúng đầu ra nhưng không lường tới tầng sanitizer.

Đã sửa: thêm `role` vào allowlist của `img`, thu hẹp trong `transformTags` chỉ còn
`presentation`/`none` — hai giá trị đúng nghĩa "bỏ qua phần tử này". Giá trị khác bị xoá
hẳn, không để lại thuộc tính `role` trống. Đây là lần đầu allowlist bảo mật của sanitizer
được nới kể từ khi cơ chế ADR-037 §1/ADR-038 kiểm soát nó ra đời — ghi nhận rõ ràng thay
vì âm thầm, vì mọi lần nới trước giờ đều đi qua ADR riêng. `table` đã mang `role` từ
M3-S1 vì lý do bảng layout, nên bản thân thuộc tính không mới với sanitizer, chỉ mới với
`img`. Test đo thường trực trong `builder-block-sanitizer.test.ts` (S6 Task 39) và
`template-html-sanitizer.test.ts`.

---

## Consequences

- **Container thứ mười, và nó phải vào `infra:up`.** MinIO tham gia bộ tối thiểu
  (postgres/redis/mailpit) chứ không phải bộ đầy đủ, nếu không mọi test có ảnh sẽ buộc phải
  dựng cả stack trên một máy đã thiếu RAM.
- **`075_asset_storage.sql` là migration đầu tiên kể từ 074.** `ARCH-MIGRATION` so từng
  SHA-256 với `database/migrations.lock.json` và fail ở mọi khác biệt ⇒ hash phải tính và
  dán tay **trong cùng commit**. Spec §7 từng ghi "không có migration mới trong S1–S5"; câu
  đó đúng cho S1–S5 và hết hiệu lực ở đây.
- **Route công khai đầu tiên phục vụ dữ liệu người dùng.** `@Public()` tới nay chỉ dùng cho
  auth. Route này cần rate limit và không được nhận đường dẫn do client dựng (chỉ `asset_id`
  tra bảng), nếu không nó thành proxy đọc tuỳ ý object store.
- **`AssetProvider` đóng lại bộ sáu port** spec §1.4 liệt kê. Sau ADR này không còn port nào
  ở trạng thái "cố tình hoãn".
- **`missing_assets` trở thành state dựng được ở cả MC-UI-005 lẫn MC-UI-006** (S7): cùng một
  khái niệm "ảnh trỏ tới URL không phục vụ được", một cách trình bày.
- **Ảnh vẫn bị chặn mặc định trong Outlook desktop.** Đây là hệ quả chọn `https:`; nó chỉ
  mất khi `cid:` được làm ở một slice sau.
- **Kho asset không phải nơi để tệp nhạy cảm** — URL công khai là bearer capability. UI phải
  nói điều đó tại chỗ upload, không chôn trong tài liệu.
- **Hạn mức mỗi tenant chưa có số.** Để mở có ghi nhận, không phải bỏ quên; cần trước khi
  mở cho tenant ngoài.
- **Đã đo một nửa (Task 32, 2026-09-03); nửa còn lại phải đợi.** Khác ADR-042 (đo từng giá
  trị CSS qua sanitizer thật trước khi quyết), ADR này quyết trên khảo sát năng lực hiện có.
  Phần đo được **ngay bây giờ** — trước khi có một dòng code lưu trữ nào — là hình dạng URL mà
  quyết định §2 sinh ra: nó có sống sót qua emitter và sanitizer thật không. Đã chạy, thành
  test thường trực trong `packages/architecture-tests/src/builder-block-sanitizer.test.ts`
  (không phải script vứt đi — đúng bài học phương pháp của ADR-042):

  | Trường hợp | Kết quả |
  |---|---|
  | `https://<host>/api/v1/assets/<uuid>/<slug>.png` | **giữ nguyên từng byte** |
  | Tên tệp tiếng Việt đã percent-encode | **giữ nguyên** |
  | `png` · `jpg` · `jpeg` · `gif` · `webp`, path dài 120 ký tự | **giữ nguyên** |
  | Cùng URL đó trên `banner` và `logo`, không riêng `image` | **giữ nguyên** |
  | `http:` · `data:` · protocol-relative `//host/...` | **bị xoá** (đúng như mong đợi) |
  | **`/api/v1/assets/<uuid>/logo.png` (đường dẫn tương đối)** | **BỊ XOÁ** |

  ⇒ **Ràng buộc phát sinh từ phép đo, phải tuân ở Task 36:** `isPermittedImageSource` khớp
  `^https:`, nên đường dẫn tương đối **không** được coi là "cùng origin" mà bị vứt thẳng. URL
  asset **bắt buộc là https tuyệt đối**, tức là API phải **biết origin công khai của chính
  nó** lúc phát HTML — không dựa được vào origin của trang như markup web thông thường. Thêm
  một biến môi trường cho origin đó là việc của Task 36, và nếu nó sai thì mọi ảnh trong email
  đã xuất bản sẽ hỏng mà không có cảnh báo nào.

  **Nửa chưa đo được:** vòng upload → lưu → phục vụ. Nó chưa tồn tại (Task 33–36) và chỉ
  nghiệm thu được đầu-cuối ở Task 42. **Không code UI trước khi nửa đó xanh.**
