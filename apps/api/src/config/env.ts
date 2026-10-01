import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters (64 hex chars)'),
  SENDER_CREDENTIAL_KEY: z.string().regex(/^[a-f0-9]{64}$/i, 'SENDER_CREDENTIAL_KEY must contain exactly 64 hexadecimal characters'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  SMTP_HOST: z.string().default('mailpit'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_FROM: z.string().default('no-reply@example.test'),
  SMTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  SMTP_GREETING_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  SMTP_SOCKET_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** BR-SEND-013: internal-only Prometheus exposition listener. */
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  TZ: z.string().default('Etc/UTC'),
  /**
   * ADR-043 asset storage. `ASSET_PUBLIC_ORIGIN` is the one that bites: Task 32
   * measured that a root-relative image src is stripped by the sanitizer, so
   * the API must emit an absolute https URL and therefore must be told its own
   * public origin. A wrong value here does not fail loudly -- it breaks every
   * image in already-published email, which cannot be re-edited.
   */
  ASSET_PUBLIC_ORIGIN: z.string().url().default('http://localhost:8080'),
  ASSET_STORAGE_ENDPOINT: z.string().url().default('http://minio:9000'),
  ASSET_STORAGE_REGION: z.string().default('us-east-1'),
  ASSET_STORAGE_BUCKET: z.string().min(1).default('eow-assets'),
  ASSET_STORAGE_ACCESS_KEY: z.string().min(1).default('eow'),
  // No .min(1): nothing consumes this until Task 36 wires the upload route, and
  // a schema that refuses to boot over an unused credential would block every
  // other change in between. Task 36 enforces non-empty where it is actually used.
  ASSET_STORAGE_SECRET_KEY: z.string().default(''),
  /** MinIO addresses buckets by path; real S3 uses a virtual host. */
  ASSET_STORAGE_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  /**
   * BR-CMP-009's configured tenant ceiling. No quota ledger exists until
   * M7-S1 (BR-CFG-006); this is a static limit, not a consumable reservation.
   * Default is BR-SEC-006's own MVP performance target (100,000
   * recipients/campaign), not an arbitrary number.
   */
  CAMPAIGN_AUDIENCE_LIMIT: z.coerce.number().int().min(1).default(100_000),
  /** BR-SCH-001: how far ahead a schedule must be, and how far out it may reach. */
  SCHEDULE_MIN_LEAD_SECONDS: z.coerce.number().int().min(0).default(120),
  SCHEDULE_MAX_HORIZON_DAYS: z.coerce.number().int().min(1).default(365),
  /** BR-SCH-005: mutations are refused once the due instant is this close. */
  SCHEDULE_LOCK_WINDOW_SECONDS: z.coerce.number().int().min(0).default(120),
  /**
   * BR-HIS-003: "Export chay background neu lon". At or below this row
   * count the API renders and completes the export synchronously; above it,
   * the row stays 'queued' for the worker (CP8). One threshold, one client
   * flow either way -- the client always polls/downloads the same routes.
   */
  EXPORT_INLINE_MAX_ROWS: z.coerce.number().int().min(1).default(500),
  /** BR-HIS-007: "file co expiry". Stamped onto export_job.expires_at at completion. */
  EXPORT_ARTIFACT_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(72),
  /**
   * BR-HIS-006: "message event chi tiet theo chinh sach tenant, mac dinh 12
   * thang". The deployment-wide default used for any tenant with no
   * retention_policy row (migration 032). The 30-day floor mirrors
   * purge_message_events()'s own hard floor.
   */
  HISTORY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
  /**
   * BR-SEND-008's webhook HMAC secret (M5-S4-WEBHOOK-PLAN.md SS3.2). Optional
   * so every existing app -- including every test app that never sets it --
   * still boots; unset means the webhook route fails closed with 503 at
   * request time (A15), never that it accepts an unverified event.
   *
   * D-111 (found deploying CP7): compose.yaml's `${EOW_PROVIDER_WEBHOOK_SECRET:-}`
   * expands to an empty string, not an absent key, when the .env value is
   * unset -- and an empty string is not `undefined`, so plain `.optional()`
   * does not cover it and `.min(32)` rejected it, crash-looping the API
   * container in exactly the "no provider callbacks configured" deployment
   * this variable's own default is meant to support. Preprocessing an empty
   * string to `undefined` before validation makes "unset" and "blank" the
   * same fact for this one variable, matching the deployment contract's own
   * `${VAR:-}` shape instead of fighting it.
   */
  PROVIDER_WEBHOOK_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32).optional(),
  ),
});

export type ValidatedEnv = z.infer<typeof envSchema>;

/**
 * Fails fast at boot on a missing or malformed required variable, naming it
 * in the thrown error, instead of letting the process start half-configured.
 */
export function validateEnv(raw: Record<string, string | undefined>): ValidatedEnv {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}
