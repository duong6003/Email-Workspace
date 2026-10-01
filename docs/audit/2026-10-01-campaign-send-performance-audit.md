# Audit hiệu năng gửi campaign — 2026-10-01

Phạm vi: đường gửi từ lúc xác nhận gửi (freeze snapshot ở API) tới lúc SMTP nhận thư
(scheduler → worker `campaign-send-scan` → `validate` → `partition` → `sendClaimedBatch`
→ `aggregate`).
Hai câu hỏi cần trả lời:

1. Cơ chế gửi có chạy đúng như những gì người dùng cấu hình không?
2. Gửi chậm là do cấu hình hay do code?

Kết luận ngắn: **chậm do cả hai, xếp thành nhiều tầng.** Ở cấu hình mặc định, tầng
chặn trước tiên là một giới hạn **không cấu hình được và không hiển thị**: 60 email/phút
cho mỗi sender. Vì vậy hệ thống **không chạy theo cấu hình người dùng nhìn thấy**.
Gỡ giới hạn đó ra thì lộ tiếp tầng kiến trúc (chỉ gửi một batch mỗi tick 60 giây), rồi
đến tầng code (SMTP tuần tự, mở kết nối mới cho từng thư, Nagle làm trễ khoảng 40ms mỗi
thư). Ngoài ra, bước freeze **hỏng hoàn toàn với audience trên ~5.040 người**.

## 1. Phương pháp và môi trường đo

- Dùng PostgreSQL 16 và Redis thật, áp dụng đủ 49 migration bằng `database/migrate.sh`.
- Code đo là code worker thật: `sendClaimedBatch` và `scanQueuedCampaigns`.
  Script đo: `apps/worker/bench/send-throughput.ts`, có thể chạy lại.
- SMTP sink là một server viết trong tiến trình, nhận rồi bỏ thư.
  Không dùng Mailpit để đo vì nó ghi SQLite mất ~50ms mỗi thư: khi đó cái bị đo là sink,
  không phải worker.
- Độ trễ mạng được mô phỏng bằng proxy TCP, cộng 15ms mỗi chiều (RTT ≈ 30ms, tương
  đương gọi một provider trong khu vực). TLS không được mô phỏng, nên số đo **lạc quan**
  hơn thực tế.
- Mỗi thư có HTML khoảng 20KB, N = 300 cho đo tầng code và N = 1.000 cho đo tầng cấu hình.
- Baseline test của worker: 161/162 pass. Test duy nhất fail là
  `worker-restart.integration.test.ts`; test này SIGKILL tiến trình worker theo
  topology của compose, không liên quan đường gửi.

## 2. Cơ chế có chạy đúng cấu hình không? — **Không**

| # | Người dùng kỳ vọng | Thực tế đo được | Bằng chứng |
|---|---|---|---|
| E1 | Đặt "Tốc độ tenant" = 6.000 email/phút trong Cài đặt → gửi tối đa 6.000/phút | **Vẫn chỉ 60 email/phút.** `sender_config.rate_limit_per_minute` mặc định 60 (migration 026) và **không có trong API, OpenAPI hay UI**. Đây là vi phạm BR-CFG-006 ("rate limit cấu hình được"). | Bench `config: user raised tenant to 6000/min & batch 1000` → `sentThisTick: 60, deferred: 940` |
| E2 | "Email mỗi lượt" là kích thước lô xử lý | Thực chất là **trần số email mỗi phút của mỗi campaign**, vì mỗi tick 60 giây chỉ partition và gửi đúng một lô. UI không nói điều này. | `apps/worker/src/campaign-send/run.ts` (một lần `partitionBatch` + một lần `sendClaimedBatch` mỗi tick) |
| E3 | `daily_send_limit` của sender là quota cấu hình được (BR-CFG-006) | Có trong DB và worker có tôn trọng, nhưng **không cấu hình được** ở API hay UI. | grep `dailySendLimit` trong `apps/api`, `apps/web`: không có kết quả |
| E4 | `EOW_CAMPAIGN_AUDIENCE_LIMIT=100000` → gửi được tới 100k người | **Freeze lỗi từ ~5.040 người** với `bind message has 12464 parameter formats but 0 parameters`. Lý do: một câu `INSERT` chứa ~13 tham số × số người nhận, vượt trần 65.535 tham số của giao thức PostgreSQL. `findByIds` dùng `IN (:...ids)` cũng vỡ khi vượt 65.535 id. | Probe trên `freezeCampaignSnapshot` thật: 4.000 người → OK nhưng mất **10,6s**; 6.000 người → lỗi trên |
| E5 | Bấm "Gửi" là thư đi ngay | Thư đầu tiên chờ tới tick kế tiếp, tối đa 60s (`EOW_SCHEDULER_TICK_MS`). Với campaign hẹn giờ, `campaign-misfire-scan` và `campaign-send-scan` được enqueue cùng lúc nên có thể mất 2 tick. (Điểm hẹn giờ là suy luận từ code, chưa đo.) | `apps/scheduler/src/main.ts` |
| E6 | Metric `send_retry` phản ánh lỗi tạm thời | Những dòng bị dời sang phút sau vì hết rate limit cũng bị đếm là `retrying`, nên metric retry bị thổi phồng. | Log bench: `submitted: 60, retrying: 140` trong khi không có lỗi SMTP nào |

Những phần **chạy đúng**: rate limit được thực thi; dòng vượt hạn mức được dời sang phút
kế tiếp mà không bị mất; pause, retry và idempotency đều được test integration bao phủ và
pass.

## 3. Chậm vì cấu hình hay vì code? — Phân tầng có số đo

### Tầng 1 — Cấu hình mặc định (đang chặn đầu tiên)

| Kịch bản (N = 1.000, một tick) | Gửi được/tick | Thời gian làm việc | Dự phóng/giờ |
|---|---|---|---|
| Mặc định (sender 60/phút, batch 100, tenant 600) | 60 | 3,7s (worker **rảnh ~94%** của mỗi phút) | 3.600 |
| Người dùng nâng tenant lên 6.000 và batch lên 1.000 trên UI | **60** | 5,2s | 3.600 |
| Nâng sender limit lên 6.000 (hiện chỉ làm được bằng sửa DB) và batch 1.000 | 1.000 | **58,5s**, tức chạm trần của code | 60.000 (chỉ khi RTT = 0) |

→ Với cấu hình mặc định, **100.000 người nhận mất khoảng 27,8 giờ**, và người dùng không
có cách nào sửa trên giao diện.

### Tầng 2 — Kiến trúc: một batch mỗi tick

Ngay cả khi các giới hạn đã mở, mỗi campaign chỉ gửi được tối đa `batch_size` thư trong
60s. Batch xong sớm thì worker ngồi chờ tick sau; batch quá dài thì các tick chồng lên
nhau (xem rủi ro R1 bên dưới).

### Tầng 3 — Code gửi (đo bằng `sendClaimedBatch`, không giới hạn rate)

| Kịch bản (N = 300) | RTT 0ms: ms/thư | thư/giây | RTT 30ms: ms/thư | thư/giây |
|---|---|---|---|---|
| **Hiện tại**: kết nối SMTP mới cho mỗi thư, gửi tuần tự | 58,7 | 17 | 233,8 | **4,3** |
| + `TCP_NODELAY` | 15,4 | 65 | 188,7 | 5,3 |
| + pool một kết nối SMTP (vẫn tuần tự) | 12,6 | 79 | 139,8 | 7,2 |
| Provider no-op (chỉ còn chi phí DB và Redis) | **4,2** | 239 | 3,8 | 264 |

Microbenchmark riêng bằng nodemailer trên loopback: 44ms/thư khi dùng mặc định; **1,4ms/thư**
khi pool và bật NODELAY; **1,0ms/thư** khi pool 8 kết nối song song.

Diễn giải:
- **DB và Redis không phải nút cổ chai.** Chúng chỉ tốn khoảng 4–7ms/thư; 6 round-trip
  PostgreSQL mỗi thư vẫn nên gom lại, nhưng đó là ưu tiên thấp.
- **Nagle + delayed-ACK ≈ 40ms/thư.** nodemailer không gọi `setNoDelay()`, nên gói nhỏ
  `\r\n.\r\n` kết thúc lệnh DATA phải chờ ACK trì hoãn từ server. Lỗi này xảy ra với
  mọi server, không chỉ trên loopback.
- **Mỗi thư mở kết nối mới** (TCP + EHLO, cộng TLS và AUTH khi chạy thật): thêm vài RTT
  cho mỗi thư.
- **Gửi tuần tự**: ở RTT 30ms, một kết nối gửi được tối đa khoảng 7 thư/giây. Muốn
  nhanh hơn thì bắt buộc phải gửi song song có giới hạn.
- Ở RTT 30ms, code hiện tại đạt trần **~258 email/phút mỗi worker**, kể cả khi mọi cấu
  hình đã được mở hết.

### Tầng 4 — Freeze snapshot ở API (trước khi worker bắt đầu)

- Lỗi tham số ở E4 khiến **không gửi được** bất kỳ campaign nào có trên ~5.040 người.
- Freeze chạy **đồng bộ trong request HTTP** và giữ khóa trên dòng campaign. Nó resolve
  audience hai lần (một lần trong validation, một lần trong freeze) và render HTML đầy đủ
  cho từng người. 4.000 người đã mất 10,6s; nếu tăng tuyến tính, 100k người mất vài phút,
  vượt mọi timeout HTTP.
- Mỗi người nhận lưu một bản HTML đã render trong `email_snapshot`; 100k × 20–80KB tương
  đương 2–8GB TOAST. Phần này chấp nhận được vì ADR-013, nhưng cần đưa vào kế hoạch dung lượng.

## 4. Rủi ro phát sinh nếu "chỉ tăng cấu hình" mà không sửa code

- **R1 — Gửi trùng.** `STALE_CLAIM_MINUTES = 5` (`send.ts`). Ở RTT 30ms code gửi
  ~4,3 thư/giây, nên một batch 5.000 mất khoảng 19 phút. Sau 5 phút, scan của tick khác sẽ
  **claim lại các dòng đang gửi dở** và gửi lần hai. Message-ID tất định giúp provider
  dedupe được một phần, nhưng không đảm bảo. **Không được nâng `batch_size` lên cao khi
  chưa thay cơ chế claim bằng heartbeat.**
- **R2 — Chặn đầu hàng.** Các campaign trong một scan chạy tuần tự, nên một campaign lớn
  chặn mọi campaign phía sau. Đã quan sát được: lượt đo đầu tiên mất 51s vì scan đi qua
  26 campaign còn sót lại.
- **R3 — Progress quét toàn bảng.** `publishProgressSnapshot` chạy 3 câu `count(*)` quét
  toàn bộ người nhận của campaign, khoảng mỗi giây một lần, ngay trong vòng gửi.

## 5. Kế hoạch sửa (đề xuất ở ADR-054, cần duyệt)

| Ưu tiên | Hạng mục | Loại | Kỳ vọng |
|---|---|---|---|
| P0 | Chia nhỏ freeze (≤ 1.000 dòng mỗi INSERT, dùng `= ANY($1::uuid[])`), thêm test 20k người | Sửa lỗi | Hết lỗi E4 |
| P0 | Cho cấu hình `rate_limit_per_minute` và `daily_send_limit` của sender (API, OpenAPI, UI); màn Review hiển thị tốc độ hiệu lực = min(sender, tenant) và ETA | Cấu hình/UX | Hết lỗi E1, E3; tuân thủ BR-CFG-006 |
| P0 | SMTP transport dạng pool cho mỗi sender, bật `TCP_NODELAY`, gửi song song có giới hạn (`maxConnections` cấu hình theo sender) | Code | Nhanh hơn ~10–30 lần ở tầng 3 |
| P1 | Worker gửi liên tục: mỗi campaign tự rút hàng đợi trong một khung thời gian, dừng khi hết hạn mức rate (không chờ tick); campaign được enqueue ngay khi xác nhận | Kiến trúc | Hết trần batch/tick; thư đầu đi trong vài giây |
| P1 | Claim bằng heartbeat/lease thay vì cố định 5 phút | An toàn | Hết R1 |
| P1 | Freeze bất đồng bộ (trạng thái `preparing`), render theo lô | Kiến trúc | Hết timeout HTTP |
| P2 | Gom ghi DB theo lô; xin token rate limit theo lô (Lua `INCRBY`); dùng chung pool PG/Redis trong process; tách progress ra khỏi vòng gửi | Hiệu năng | Giảm tải DB/Redis |
| P2 | Không đếm dòng bị dời do rate limit là `retrying` | Quan sát | Sửa E6 |

Ước tính sau P0–P1 (cần đo lại; vẫn dùng sink, RTT 30ms, 8 kết nối): khoảng 3.000 email/phút
mỗi worker. Lúc đó tốc độ thực tế sẽ do **hạn mức của provider** quyết định, đúng như yêu
cầu "tuân rate limit tenant/sender/provider" của BR-SEND-007.

## 6. Phát hiện phụ

- `database/migrate.sh` dòng 220: `printf '-- Published migration …'` lỗi
  (`printf: --: invalid option`) khi chạy bằng bash hoặc dash trên host. Container
  (busybox) không bị ảnh hưởng. Sửa bằng `printf -- '…'`.
- ADR-015 ghi "Handlebars strict/whitelisted merge", nhưng code chỉ hiện thực phép thay thế
  phẳng `{{key}}`. Xem thiết kế dữ liệu template (ADR-053).

## 7. Cách chạy lại phép đo

```bash
# Cần .env, PostgreSQL/Redis đã migrate (giống integration test của worker)
cd apps/worker
BENCH_N=300 BENCH_ONLY=code   pnpm exec tsx bench/send-throughput.ts | grep scenario
BENCH_N=300 BENCH_ONLY=code BENCH_LATENCY_MS=15 pnpm exec tsx bench/send-throughput.ts | grep scenario
BENCH_N=1000 BENCH_ONLY=config pnpm exec tsx bench/send-throughput.ts | grep scenario
```
