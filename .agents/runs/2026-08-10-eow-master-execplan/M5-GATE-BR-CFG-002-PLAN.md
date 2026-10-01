# M5-GATE remediation: BR-CFG-002 sender usability (+ the TC-SEND-017 test gap)

> **For agentic workers:** execute task-by-task under AGENTS.md §2 (evidence
> precedes status, commit at every task, compare test *and skip* counts against
> the baseline). Use `superpowers:test-driven-development` — RED before GREEN in
> every task. Steps use checkbox (`- [ ]`) syntax. This plan is the spec; do not
> re-derive it from `state.json`.

Node: `M5-GATE` (remediation slice inside the gate, not a new sub-node)
Baseline: `be31c4d`, **122 test files / 772 tests / 0 skipped / 0 failed**
Closes: **BR-CFG-002** (P0, `not_started`) and the `TC-SEND-017` half of
**BR-SEND-006** / **BR-SEND-007** (both `partially_closed`)
Reserved: defects **D-112…D-114**, decisions **DEC-115…DEC-119**. No migration.

**Goal:** make "sender must be verified and active before use" a rule the system
actually enforces at every point a campaign can start sending — and prove it.

**Architecture:** one pure decision function (`checkSenderUsable`) owned by the
API campaigns module, called by both the schedule validation report and a new
send-now precheck, plus the equivalent status check in the worker's own
time-of-use validation. No new table, no new migration, no new endpoint.

**Tech Stack:** NestJS + TypeORM (apps/api), raw `pg` (apps/worker), React
(apps/web), Vitest everywhere, real PostgreSQL/Redis in integration tests.

---

## 0. Findings this plan is built on (verified against the working tree, not assumed)

**(a) The schedule path already enforces the rule; nothing tests it.**
`campaigns.service.ts:645-646` inside `buildScheduleValidationReport` returns
`SENDER_NOT_FOUND` / `SENDER_NOT_VERIFIED` for any sender whose status is not
`verified` — so `pending`, `failed` and `disabled` are all blocked, and
`report.blocking` refuses the schedule. No test in
`campaign-schedule-http.test.ts` exercises the sender branch (its only 422 case,
A7, is the *template* branch), and `traceability.csv`'s BR-CFG-002 row has empty
`code_paths` and empty `test_files`. **The CSV row is stale in one direction and
correct in two others** — see (b) and (c).

**(b) The send-now path enforces nothing. D-112.** `sendCampaign`
(`campaigns.service.ts:556-584`) freezes the snapshot and moves the campaign to
`queued` without consulting `buildScheduleValidationReport` or any sender check.
`POST /campaigns/{id}/send` on a campaign whose `senderConfigId` points at a
`pending`, `failed` or `disabled` sender is accepted with 202 today. Fixed in
Task 3.

**(c) The worker blocks only `disabled`, and `pending` is reachable *after* a
successful schedule. D-113.** `apps/worker/src/campaign-send/validate.ts:78`
checks `sender.status === 'disabled'` and nothing else, so a `pending` or
`failed` sender passes validation and the batch proceeds to submit. This is not
hypothetical: `sender-config.service.ts:25` sets `status = 'pending'` and clears
`verifiedAt` whenever the secret or `fromEmail` is updated. A campaign scheduled
against a then-verified sender, whose secret is rotated before the dispatcher
fires, sends with an unverified sender identity — exactly what BR-CFG-002
exists to prevent. Fixed in Task 4.

**(d) No migration is needed.** `campaign_execution.failure_code` is plain
`text` with no CHECK constraint (`026_campaign_execution.sql:60`), so a new
`SENDER_NOT_VERIFIED` value is a code-only change. Published-migration
immutability (AGENTS.md §5) is not touched.

**(e) No OpenAPI schema change is needed.**
`CampaignScheduleValidationReport.sender.reason` is `{type: string}` with no
enum (`contracts/openapi.yaml:1536`), and `sendCampaign` already declares
`'422': {$ref: Problem}` (`contracts/openapi.yaml:755`). Only the two
`description` strings change, in Task 7.

**(f) The web overlay renders a sender-blocked 422 as a generic time/timezone
message. D-114.** `schedule-error-copy.ts:55-56` falls through to
`DEFAULT_MESSAGE` (*"Không thể lên lịch gửi. Vui lòng kiểm tra lại thời gian và
múi giờ."*) for any body without a recognised `code` — and the blocking-report
422 has no `code` at all, it has `{blocking, sender, template, …}`. A user whose
sender is disabled is told to check the time. Fixed in Task 5.

**(g) TC-SEND-017 is a test gap, not a code gap.** `send.ts:241`'s reserve query
already carries `AND (next_retry_at IS NULL OR next_retry_at <= now())`, and
A12 already proves the `Retry-After` header wins over the backoff floor. What no
test asserts is TC-SEND-017's own expected result end-to-end: *no attempt before
the window, exactly one success after it*. Task 6 adds that one test and writes
no production code. TC-SEND-018 needs nothing — see §4.

---

## Task 1: one sender-usability rule, stated once

**Files:**
- Create: `apps/api/src/campaigns/sender-usability.ts`
- Create: `apps/api/src/campaigns/sender-usability.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/campaigns/sender-usability.test.ts
import { describe, expect, it } from 'vitest';
import { checkSenderUsable } from './sender-usability.js';

/** BR-CFG-002: sender phải verified và active trước khi dùng. */
describe('checkSenderUsable (BR-CFG-002)', () => {
  it('blocks every non-verified status by name, not just disabled', () => {
    for (const status of ['pending', 'failed', 'disabled']) {
      expect(checkSenderUsable({ senderConfigId: 'sender-1' }, { status })).toEqual({
        valid: false,
        reason: 'SENDER_NOT_VERIFIED',
      });
    }
  });

  it('accepts a verified sender config', () => {
    expect(checkSenderUsable({ senderConfigId: 'sender-1' }, { status: 'verified' })).toEqual({ valid: true });
  });

  it('reports a referenced-but-absent sender config as not found, not as unverified', () => {
    expect(checkSenderUsable({ senderConfigId: 'sender-1' }, null)).toEqual({
      valid: false,
      reason: 'SENDER_NOT_FOUND',
    });
  });

  it('falls back to the raw fromEmail when no sender config is referenced', () => {
    expect(checkSenderUsable({ fromEmail: 'ops@example.test' }, null)).toEqual({ valid: true });
    expect(checkSenderUsable({ fromEmail: '   ' }, null)).toEqual({ valid: false, reason: 'SENDER_MISSING' });
    expect(checkSenderUsable({}, null)).toEqual({ valid: false, reason: 'SENDER_MISSING' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/sender-usability.test.ts
```

Expected: FAIL — `Failed to resolve import "./sender-usability.js"`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// apps/api/src/campaigns/sender-usability.ts
/**
 * BR-CFG-002 (M5-GATE, DEC-115): one sender-usability rule with three callers
 * -- the schedule validation report, the send-now precheck and (restated in
 * raw SQL, not imported across the app boundary) the worker's own time-of-use
 * validation. A sender is usable only when it exists, is not soft-deleted and
 * is `verified`; `pending`, `failed` and `disabled` all block. Pure over the
 * row so the decision is testable without a database.
 */
export type SenderUsabilityReason = 'SENDER_MISSING' | 'SENDER_NOT_FOUND' | 'SENDER_NOT_VERIFIED';
export type SenderUsability = { valid: true } | { valid: false; reason: SenderUsabilityReason };

export function checkSenderUsable(
  sender: { senderConfigId?: string | null; fromEmail?: string | null },
  senderConfig: { status: string } | null,
): SenderUsability {
  if (sender.senderConfigId) {
    if (!senderConfig) return { valid: false, reason: 'SENDER_NOT_FOUND' };
    if (senderConfig.status !== 'verified') return { valid: false, reason: 'SENDER_NOT_VERIFIED' };
    return { valid: true };
  }
  if (!sender.fromEmail?.trim()) return { valid: false, reason: 'SENDER_MISSING' };
  return { valid: true };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @eow/api exec vitest run src/campaigns/sender-usability.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/sender-usability.ts apps/api/src/campaigns/sender-usability.test.ts && git commit -m "M5-GATE BR-CFG-002 (1/7): extract checkSenderUsable as one testable rule"
```

---

## Task 2: the schedule report reads the shared rule, and a test finally proves it

**Files:**
- Modify: `apps/api/src/campaigns/campaigns.service.ts:641-649`
- Modify: `apps/api/test/integration/campaign-schedule-http.test.ts` (new tests + `sender_config` cleanup)

- [ ] **Step 1: Write the failing integration test**

Add this helper next to `draftCampaignWithAudience` (it is that helper plus a
real `sender_config` row — the existing one deliberately uses a bare
`fromEmail`, and both shapes must keep working):

```ts
  async function draftCampaignWithSenderConfig(
    session: { cookie: string; csrfToken: string },
    status: 'pending' | 'failed' | 'disabled' | 'verified',
  ) {
    const [sender] = await dataSource.query(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, $2, $3, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_SCHEDULE_HTTP_UNUSED', $4) RETURNING id`,
      [tenant.id, `sender-${randomUUID()}`, `sender-${randomUUID()}@example.test`, status],
    );
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1,
      subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const list = await dataSource.getRepository(RecipientListEntity).save({ tenantId: tenant.id, name: `list-${randomUUID()}` });
    const recipient = await dataSource.getRepository(RecipientEntity).save({ tenantId: tenant.id, email: `schedule-sender-${randomUUID()}@example.test` });
    await dataSource.query(
      'INSERT INTO recipient_list_member (tenant_id, list_id, recipient_id, joined_at, source) VALUES ($1, $2, $3, now(), $4)',
      [tenant.id, list.id, recipient.id, 'manual'],
    );
    const created = await request(app.getHttpServer()).post('/api/v1/campaigns')
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .send({
        name: `Schedule sender ${randomUUID()}`, templateId: template.id, templateVersionId: version.id,
        sender: { senderConfigId: sender.id, fromEmail: 'ops@example.test' }, audience: { listIds: [list.id] },
      });
    return { campaignId: created.body.id as string, senderConfigId: sender.id as string };
  }
```

And the tests themselves:

```ts
  it('BR-CFG-002: a pending, failed or disabled sender blocks the schedule 422 with SENDER_NOT_VERIFIED and creates no schedule', async () => {
    const session = await login();
    for (const status of ['pending', 'failed', 'disabled'] as const) {
      const { campaignId } = await draftCampaignWithSenderConfig(session, status);

      const response = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ blocking: true, sender: { valid: false, reason: 'SENDER_NOT_VERIFIED' } });
      const [row] = await dataSource.query('SELECT status, scheduled_at_utc FROM campaign WHERE id = $1', [campaignId]);
      expect(row).toMatchObject({ status: 'draft', scheduled_at_utc: null });
    }
  });

  it('BR-CFG-002: the same campaign schedules once its sender reaches verified', async () => {
    const session = await login();
    const { campaignId, senderConfigId } = await draftCampaignWithSenderConfig(session, 'pending');
    const blocked = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());
    expect(blocked.status).toBe(422);

    await dataSource.query("UPDATE sender_config SET status = 'verified', verified_at = now() WHERE id = $1", [senderConfigId]);
    const allowed = await scheduleRequest(session, campaignId, { localDateTime: nearFutureLocalDateTime(), timeZone: 'UTC' }, randomUUID());

    expect(allowed.status).toBe(202);
    const [row] = await dataSource.query('SELECT status FROM campaign WHERE id = $1', [campaignId]);
    expect(row.status).toBe('scheduled');
  });
```

Add the fixture cleanup to `afterAll`, immediately before the
`deleteTemplateVersionFixtures(...)` line (sender rows are referenced by
`campaign_execution.sender_config_id`, so they must be deleted after the
execution delete that the transaction above already performs):

```ts
    await dataSource.query('DELETE FROM sender_config WHERE tenant_id = ANY($1)', [[tenant.id, otherTenant.id]]);
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter @eow/api exec vitest run test/integration/campaign-schedule-http.test.ts -t "BR-CFG-002"
```

Expected: **PASS, and that is the point** — the schedule path already enforces
this (§0(a)); this test converts an untested code path into BR-CFG-002 evidence.
If it *fails*, stop and use `superpowers:systematic-debugging`: the finding in
§0(a) is then wrong and the rest of this plan needs rereading.

- [ ] **Step 3: Rewire the report to the shared rule (no behaviour change)**

Replace `campaigns.service.ts:641-649` — from `const sender = campaign.senderJson;`
through the `} else if (!sender.fromEmail?.trim()) { … }` block — with:

```ts
    const sender = campaign.senderJson;
    const senderConfig = sender.senderConfigId
      ? await new SenderConfigRepository(manager, tenantId).findActiveById(sender.senderConfigId)
      : null;
    const usability = checkSenderUsable(sender, senderConfig);
    const senderCheck: CampaignScheduleValidationReport['sender'] = usability.valid
      ? { valid: true }
      : { valid: false, reason: usability.reason };
```

Add the import next to the other campaigns-module imports:

```ts
import { checkSenderUsable } from './sender-usability.js';
```

- [ ] **Step 4: Re-run the whole file to prove the refactor changed nothing else**

```bash
pnpm --filter @eow/api exec vitest run test/integration/campaign-schedule-http.test.ts
```

Expected: PASS, 16 tests (14 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/campaigns.service.ts apps/api/test/integration/campaign-schedule-http.test.ts && git commit -m "M5-GATE BR-CFG-002 (2/7): schedule report reads checkSenderUsable, with its first sender test"
```

---

## Task 3: send-now stops accepting an unusable sender (D-112)

**Files:**
- Modify: `apps/api/src/campaigns/campaigns.service.ts:556-584` (`sendCampaign`)
- Modify: `apps/api/test/integration/campaign-send-http.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add this fixture beside `sendingCampaignFixture` (that one builds an
already-`sending` campaign from raw SQL; this one needs a real draft the HTTP
route can act on):

```ts
  async function draftCampaignWithSender(status: 'pending' | 'failed' | 'disabled' | 'verified') {
    const [sender] = await dataSource.query(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, $2, $3, 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_SEND_HTTP_UNUSED', $4) RETURNING id`,
      [tenant.id, `sender-${randomUUID()}`, `sender-${randomUUID()}@example.test`, status],
    );
    const template = await dataSource.getRepository(EmailTemplateEntity).save({ tenantId: tenant.id, name: `t-${randomUUID()}`, status: 'published' });
    const version = await dataSource.getRepository(EmailTemplateVersionEntity).save({
      tenantId: tenant.id, templateId: template.id, version: 1, subject: 'Hi', html: '<p>Hi</p>', textBody: '',
      requiredVariables: [], variableSchemaJson: { required: [], optional: [] },
      contentHash: createHash('sha256').update(randomUUID()).digest('hex'), publishedAt: new Date(),
    });
    const campaign = await dataSource.getRepository(CampaignEntity).save({
      tenantId: tenant.id, name: `Send sender ${randomUUID()}`, templateVersionId: version.id,
      senderJson: { senderConfigId: sender.id, fromEmail: 'ops@example.test' }, audienceJson: {}, settingsJson: {},
      status: 'draft', version: 0,
    });
    return { campaignId: campaign.id as string, senderConfigId: sender.id as string };
  }
```

```ts
  it('BR-CFG-002/D-112: POST /send refuses 422 SENDER_NOT_VERIFIED for a pending, failed or disabled sender and freezes no snapshot', async () => {
    const session = await login();
    for (const status of ['pending', 'failed', 'disabled'] as const) {
      const { campaignId } = await draftCampaignWithSender(status);

      const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send`)
        .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
        .set('Idempotency-Key', randomUUID()).send({});

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'SENDER_NOT_VERIFIED' });
      const [row] = await dataSource.query('SELECT status FROM campaign WHERE id = $1', [campaignId]);
      expect(row.status).toBe('draft');
      const snapshots = await dataSource.query('SELECT 1 FROM campaign_snapshot WHERE campaign_id = $1', [campaignId]);
      expect(snapshots).toHaveLength(0);
    }
  });

  it('BR-CFG-002: POST /send accepts the same campaign once its sender is verified', async () => {
    const session = await login();
    const { campaignId, senderConfigId } = await draftCampaignWithSender('pending');
    await dataSource.query("UPDATE sender_config SET status = 'verified', verified_at = now() WHERE id = $1", [senderConfigId]);

    const response = await request(app.getHttpServer()).post(`/api/v1/campaigns/${campaignId}/send`)
      .set('Cookie', session.cookie).set('x-csrf-token', session.csrfToken)
      .set('Idempotency-Key', randomUUID()).send({});

    expect(response.status).toBe(202);
    const [row] = await dataSource.query('SELECT status FROM campaign WHERE id = $1', [campaignId]);
    expect(row.status).toBe('queued');
  });
```

Add to `afterAll`, immediately before `deleteTemplateVersionFixtures(...)`:

```ts
    await dataSource.query('DELETE FROM sender_config WHERE tenant_id = $1', [tenant.id]);
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @eow/api exec vitest run test/integration/campaign-send-http.test.ts -t "BR-CFG-002"
```

Expected: FAIL — the first test receives **202**, not 422. That is D-112
reproduced.

- [ ] **Step 3: Add the precheck**

In `sendCampaign`, immediately after `if (!campaign) throw new NotFoundException('Campaign was not found.');`
and *before* `const webOrigin = …`:

```ts
      // BR-CFG-002/D-112 (DEC-116): send-now had no sender check at all -- only
      // the schedule route did -- so an unusable sender reached the worker as a
      // queued campaign. Deliberately scoped to the sender dimension: the rest
      // of buildScheduleValidationReport (audience/variable waivers) governs
      // its own rules on its own route, and widening send-now to the whole
      // report here would change M4-S4's accepted behaviour rather than close
      // this rule.
      const senderConfig = campaign.senderJson.senderConfigId
        ? await new SenderConfigRepository(manager, tenantId).findActiveById(campaign.senderJson.senderConfigId)
        : null;
      const usability = checkSenderUsable(campaign.senderJson, senderConfig);
      if (!usability.valid) throw new UnprocessableEntityException({ code: usability.reason });
```

`UnprocessableEntityException`, `SenderConfigRepository` and `checkSenderUsable`
are all already imported in this file after Task 2 — verify, and add whichever
is missing.

- [ ] **Step 4: Run it and watch it pass, then the whole file**

```bash
pnpm --filter @eow/api exec vitest run test/integration/campaign-send-http.test.ts
```

Expected: PASS, 9 tests (7 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/campaigns/campaigns.service.ts apps/api/test/integration/campaign-send-http.test.ts && git commit -m "M5-GATE BR-CFG-002 (3/7): fix D-112 -- send-now refuses an unusable sender 422"
```

---

## Task 4: the worker enforces it at time of use (D-113)

**Files:**
- Modify: `apps/worker/src/campaign-send/validate.ts:4` and `:78`
- Modify: `apps/worker/src/campaign-send/validate.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**

```ts
  it('BR-CFG-002/D-113: a sender that regressed to pending after scheduling fails validating with SENDER_NOT_VERIFIED', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Validate pending sender', 'pending@example.test', 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_VALIDATE_PENDING', 'pending') RETURNING id`,
      [tenantId],
    )).rows[0];
    const campaignId = await insertQueuedCampaign({ senderConfigId: sender.id });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome).toEqual({ result: 'failed', failureCode: 'SENDER_NOT_VERIFIED' });
    const execution = (await pool.query<{ status: string; failure_code: string }>(
      'SELECT status, failure_code FROM campaign_execution WHERE campaign_id = $1', [campaignId],
    )).rows[0];
    expect(execution).toMatchObject({ status: 'failed', failure_code: 'SENDER_NOT_VERIFIED' });
  });

  it('BR-CFG-002/D-113: a failed sender is refused the same way, and stays distinct from SENDER_DISABLED', async () => {
    const sender = (await pool.query<{ id: string }>(
      `INSERT INTO sender_config (tenant_id, name, from_email, host, port, username, secret_ref, status)
       VALUES ($1, 'Validate failed sender', 'failed@example.test', 'smtp.example.test', 587, '', 'EOW_SENDER_SECRET_VALIDATE_FAILED', 'failed') RETURNING id`,
      [tenantId],
    )).rows[0];
    const campaignId = await insertQueuedCampaign({ senderConfigId: sender.id });

    const outcome = await runValidation(testAppDatabaseUrl(), tenantId, campaignId);

    expect(outcome).toEqual({ result: 'failed', failureCode: 'SENDER_NOT_VERIFIED' });
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @eow/worker exec vitest run src/campaign-send/validate.integration.test.ts -t "D-113"
```

Expected: FAIL — both return `{ result: 'validated', … }`. That is D-113
reproduced: a `pending` sender sends today.

- [ ] **Step 3: Add the check**

`validate.ts:4` — extend the union:

```ts
export type ValidationFailureCode = 'NO_LIVE_SNAPSHOT' | 'SENDER_MISSING' | 'SENDER_NOT_FOUND' | 'SENDER_DISABLED' | 'SENDER_NOT_VERIFIED' | 'SENDER_SECRET_UNRESOLVED';
```

`validate.ts:78` — one line directly after the existing `disabled` check:

```ts
    if (sender.status === 'disabled') return failValidation(client, tenantId, campaignId, execution.id, 'SENDER_DISABLED');
    // BR-CFG-002/D-113 (DEC-117): `disabled` keeps its own more precise code
    // (A4 already asserts it); every other non-verified status -- `pending`,
    // `failed` -- was silently sendable. sender_config.status regresses to
    // `pending` on any secret or from-address change
    // (sender-config.service.ts:25), so this is reachable *after* a schedule
    // that legitimately passed the API's own check.
    if (sender.status !== 'verified') return failValidation(client, tenantId, campaignId, execution.id, 'SENDER_NOT_VERIFIED');
```

- [ ] **Step 4: Run the whole file**

```bash
pnpm --filter @eow/worker exec vitest run src/campaign-send/validate.integration.test.ts
```

Expected: PASS, 9 tests (7 existing + 2 new). The pre-existing
`A4: sender disabled` case must still report `SENDER_DISABLED`, not the new
code — that assertion is the guard against the new line swallowing the old one.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/campaign-send/validate.ts apps/worker/src/campaign-send/validate.integration.test.ts && git commit -m "M5-GATE BR-CFG-002 (4/7): fix D-113 -- worker refuses a non-verified sender at time of use"
```

---

## Task 5: the overlay says what is actually wrong (D-114)

**Files:**
- Modify: `apps/web/src/overlays/schedule-error-copy.ts:11-18, 33`
- Modify: `apps/web/src/overlays/schedule-error-copy.test.ts`

- [ ] **Step 1: Write the failing unit tests**

```ts
  it('D-114: renders a blocking sender report as a sender problem, not as a time/timezone problem', () => {
    const result = scheduleErrorCopy({ blocking: true, sender: { valid: false, reason: 'SENDER_NOT_VERIFIED' } });
    expect(result.message).toBe('Cấu hình gửi chưa được xác minh hoặc đã bị tắt. Hãy kiểm tra và xác minh cấu hình gửi trước khi lên lịch.');
  });

  it('D-114: renders a missing sender config distinctly from an unverified one', () => {
    const result = scheduleErrorCopy({ blocking: true, sender: { valid: false, reason: 'SENDER_NOT_FOUND' } });
    expect(result.message).toBe('Không tìm thấy cấu hình gửi của chiến dịch. Hãy chọn lại cấu hình gửi.');
  });

  it('D-114: leaves a blocking report whose sender is valid on the generic message', () => {
    const result = scheduleErrorCopy({ blocking: true, sender: { valid: true } });
    expect(result.message).toBe('Không thể lên lịch gửi. Vui lòng kiểm tra lại thời gian và múi giờ.');
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @eow/web exec vitest run src/overlays/schedule-error-copy.test.ts -t "D-114"
```

Expected: FAIL on the first two (they receive the generic default message —
that is the defect). The third passes already; it is the regression guard.

- [ ] **Step 3: Implement**

Extend the extras type (`schedule-error-copy.ts:11-18`) with the report shape
the 422 actually carries:

```ts
export type ScheduleProblemExtras = {
  code?: string;
  minAt?: string;
  maxAt?: string;
  suggestedAtUtc?: string;
  candidateOffsetMinutes?: [number, number];
  timeZone?: string;
  /**
   * D-114: `POST /schedule`'s *other* 422 body -- BR-SCH-004's blocking
   * validation report -- carries no `code` at all, so it fell through to the
   * generic time/timezone copy. Modeled here for the sender dimension only;
   * the template/audience/variable dimensions are already blocked before this
   * overlay can submit (`p0Blocked`, ScheduleSendOverlay.tsx:94).
   */
  blocking?: boolean;
  sender?: { valid: boolean; reason?: string };
};
```

Add the branch at the top of `scheduleErrorCopy`, before the `switch`:

```ts
export function scheduleErrorCopy(problem: ScheduleProblemExtras | null): ScheduleErrorCopy {
  if (problem?.blocking && problem.sender?.valid === false) {
    return {
      message: problem.sender.reason === 'SENDER_NOT_FOUND'
        ? 'Không tìm thấy cấu hình gửi của chiến dịch. Hãy chọn lại cấu hình gửi.'
        : 'Cấu hình gửi chưa được xác minh hoặc đã bị tắt. Hãy kiểm tra và xác minh cấu hình gửi trước khi lên lịch.',
    };
  }
  switch (problem?.code) {
```

- [ ] **Step 4: Run the whole file**

```bash
pnpm --filter @eow/web exec vitest run src/overlays/schedule-error-copy.test.ts
```

Expected: PASS, every existing test plus the 3 new ones. The
`'falls back to the generic message for an unrecognized code'` case must stay
green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/overlays/schedule-error-copy.ts apps/web/src/overlays/schedule-error-copy.test.ts && git commit -m "M5-GATE BR-CFG-002 (5/7): fix D-114 -- sender-blocked schedule 422 gets its own copy"
```

---

## Task 6: TC-SEND-017's own expected result, end to end (no production code)

**Files:**
- Modify: `apps/worker/src/campaign-send/send.integration.test.ts` (after the A12 test at :282)

- [ ] **Step 1: Write the test**

```ts
  it('TC-SEND-017: after a 429/Retry-After the row is not claimed before the window, then submits exactly once when it is due', async () => {
    const failingSend: SmtpSendFn = async () => {
      throw { responseCode: 421, response: '421 4.7.0 Try again later', retryAfterSeconds: 30 };
    };
    const toEmail = `send-tc017-${randomUUID()}@example.test`;
    const { campaignId, executionId, campaignRecipientId } = await fixture({ toEmail });

    const throttled = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100, failingSend);
    expect(throttled).toEqual({ submitted: 0, retrying: 1, failed: 0 });

    // Inside the Retry-After window: nothing is claimed, nothing is attempted.
    const tooSoon = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);
    expect(tooSoon).toEqual({ submitted: 0, retrying: 0, failed: 0 });
    const duringWindow = await pool.query('SELECT id FROM message_attempt WHERE campaign_recipient_id = $1', [campaignRecipientId]);
    expect(duringWindow.rowCount).toBe(1);

    // The window elapses (moved, not slept): one success, one further attempt row.
    await pool.query(`UPDATE campaign_recipient SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [campaignRecipientId]);
    const afterWindow = await sendClaimedBatch(testAppDatabaseUrl(), testRedisUrl(), tenantId, campaignId, executionId, 100);

    expect(afterWindow).toEqual({ submitted: 1, retrying: 0, failed: 0 });
    const row = (await pool.query<{ status: string; next_retry_at: Date | null }>(
      'SELECT status, next_retry_at FROM campaign_recipient WHERE id = $1', [campaignRecipientId],
    )).rows[0];
    expect(row).toMatchObject({ status: 'submitted', next_retry_at: null });
    const outcomes = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM message_attempt WHERE campaign_recipient_id = $1 ORDER BY attempt_no', [campaignRecipientId],
    );
    expect(outcomes.rows.map((r) => r.outcome)).toEqual(['retrying', 'submitted']);
  });
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter @eow/worker exec vitest run src/campaign-send/send.integration.test.ts -t "TC-SEND-017"
```

Expected: PASS. `send.ts:241`'s reserve guard and `recordFailure`'s
`next_retry_at` write already implement this (§0(g)); the test converts an
untested guarantee into TC-SEND-017 evidence. **If the `outcome` values differ
from `['retrying', 'submitted']`, read `send.ts:319-345` and match the real
column values — this task must not alter production behaviour.**

- [ ] **Step 3: Run the whole file**

```bash
pnpm --filter @eow/worker exec vitest run src/campaign-send/send.integration.test.ts
```

Expected: PASS, 16 tests (15 existing + 1 new).

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/campaign-send/send.integration.test.ts && git commit -m "M5-GATE (6/7): TC-SEND-017 end-to-end -- no attempt inside the Retry-After window, one success after"
```

---

## Task 7: contracts, traceability, decisions, and the workspace check

**Files:**
- Modify: `contracts/openapi.yaml:732-756` (sendCampaign description + 422 description)
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/traceability.csv` (BR-CFG-002, BR-SEND-006, BR-SEND-007)
- Modify: `.agents/runs/2026-08-10-eow-master-execplan/EXECPLAN.md` §19/§20 (D-112…D-114, DEC-115…DEC-119)

- [ ] **Step 1: Update the contract description (no schema change — §0(e))**

Append to `sendCampaign`'s `description`:

```
        M5-GATE (BR-CFG-002, D-112): refuses 422 `SENDER_NOT_VERIFIED` /
        `SENDER_NOT_FOUND` when the campaign's sender config is not verified
        and active -- previously only the schedule route enforced this, so an
        unusable sender reached the worker as a queued campaign.
```

and replace the bare `'422': {$ref: '#/components/responses/Problem'}` on that
operation with:

```yaml
        '422':
          description: 'BR-CFG-002: the campaign sender is missing, absent or not verified (SENDER_MISSING, SENDER_NOT_FOUND, SENDER_NOT_VERIFIED).'
          content: {application/json: {schema: {$ref: '#/components/schemas/Problem'}}}
```

Confirm `components.schemas.Problem` exists first:

```bash
grep -n "^    Problem:" contracts/openapi.yaml
```

If it is only defined under `components.responses`, keep
`{$ref: '#/components/responses/Problem'}` and carry the sentence in the
operation `description` instead.

- [ ] **Step 2: Update traceability (UTF-8, ARCH-CSV-SHAPE quoting)**

`BR-CFG-002` — status `not_started` → `closed`, filling every empty column:
- `slice`: `M5-GATE`
- `openapi_operation_ids`: `scheduleCampaign;sendCampaign`
- `code_paths`: `apps/api/src/campaigns/sender-usability.ts;apps/api/src/campaigns/campaigns.service.ts;apps/worker/src/campaign-send/validate.ts;apps/web/src/overlays/schedule-error-copy.ts`
- `test_files`: `apps/api/src/campaigns/sender-usability.test.ts;apps/api/test/integration/campaign-schedule-http.test.ts;apps/api/test/integration/campaign-send-http.test.ts;apps/worker/src/campaign-send/validate.integration.test.ts;apps/web/src/overlays/schedule-error-copy.test.ts`
- `log_or_metric_or_audit`: `campaign_send.validation_failed audit log carrying failure_code SENDER_NOT_VERIFIED; campaign_execution.failure_code; D-112 (send-now unenforced), D-113 (worker allowed pending/failed) and D-114 (overlay copy) fixed here`

`BR-SEND-006` and `BR-SEND-007` — `partially_closed` → `closed`; add
`TC-SEND-017` to `test_case_ids`, and replace the trailing
`TC-SEND-017/018 … remain not_started` clause of `log_or_metric_or_audit` with
what is actually true:

```
TC-SEND-017 closed at M5-GATE; TC-SEND-018's M5 half (crash between claim and record produces no duplicate) is closed by send.integration.test.ts A15 plus the deterministic Message-ID (DEC-104); its queue-redelivery/DLQ-replay half belongs to BR-SEC-005/BR-SEC-007 (M7), see DEC-118
```

- [ ] **Step 3: Record the defects and decisions in EXECPLAN.md**

- **D-112** — send-now accepted an unusable sender (§0(b)); fixed in Task 3.
- **D-113** — worker allowed `pending`/`failed` senders (§0(c)); fixed in Task 4.
- **D-114** — sender-blocked 422 rendered as a time/timezone error (§0(f)); fixed in Task 5.
- **DEC-115** — one `checkSenderUsable` in the API; the worker restates the rule in its own SQL rather than importing across the app boundary (no shared runtime package exists between `apps/api` and `apps/worker`, and creating one for a three-line predicate is not warranted).
- **DEC-116** — send-now enforces the *sender* dimension only, not the whole schedule report (rationale inline in Task 3's comment).
- **DEC-117** — `SENDER_DISABLED` keeps its own code; `SENDER_NOT_VERIFIED` covers `pending`/`failed`.
- **DEC-118** — TC-SEND-018 needs no new M5 work; its M5 half is A15, its remainder is M7's BR-SEC-005/007 (§4).
- **DEC-119** — no migration: `campaign_execution.failure_code` is unconstrained `text` (§0(d)).

- [ ] **Step 4: Run the workspace check**

```bash
pnpm run check
```

Expected: green at **123 test files / 786 tests / 0 skipped / 0 failed** — the
`be31c4d` baseline of 122/772 plus one new file and 14 new tests (4+2+2+2+3+1).
Record the *actual* counts from the run output as the evidence; the arithmetic
here is only the expectation. Per the handoff, budget for retries: unrelated
Docker workloads on this host make `run.integration.test.ts`,
`campaign-snapshot-post-freeze.test.ts` and `auth-http.test.ts` flake. Isolate
any failure with a standalone re-run before calling it a flake; never assume.

```bash
python .agents/runs/2026-08-10-eow-master-execplan/validate_plan.py
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add contracts/openapi.yaml .agents/runs/2026-08-10-eow-master-execplan/ && git commit -m "M5-GATE BR-CFG-002 (7/7): close BR-CFG-002/BR-SEND-006/BR-SEND-007, record D-112..114/DEC-115..119"
```

---

## 4. What this plan deliberately does not do

- **TC-SEND-018 gets no new test.** Its M5-owned half — *"killing the worker
  between the claim and the attempt row produces no duplicate submission"* — is
  already proven by `send.integration.test.ts`'s A15 (a reserved-but-unrecorded
  row is reclaimed only once stale, and exactly one `message_attempt` results),
  by the `idempotent claim` case beside it, and by the deterministic Message-ID
  (`message.ts:20`, DEC-104) that gives the provider its own dedup key. Its
  remaining half — queue redelivery, DLQ inspect/replay, provider-state
  reconcile — is owned by `BR-SEC-005` and `BR-SEC-007`, which
  `traceability.csv` places in **M7** and against which it lists `TC-SEND-018`.
  A second crash test here would duplicate A15 under a new label without
  closing anything M5 owns. Recorded as DEC-118, not skipped silently.
- **`BR-SCH-004`'s quota dimension and `BR-SCH-007`'s history rendering are not
  touched.** Both remainders are structurally outside M5 (M7-S1's quota ledger,
  M6-S3's history screen) and both rules' own *acceptance* text is already
  satisfied. They are a gate-scope decision, not an implementation task, and
  belong in the gate's own evidence rather than here.
- **No migration, no new endpoint, no new environment variable**, so the
  one-command deployment contract (AGENTS.md §2) is unchanged.
