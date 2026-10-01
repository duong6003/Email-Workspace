import { createHash } from 'node:crypto';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = /^(authorization|cookie|set-cookie|x-csrf-token|password|passphrase|secret|smtpsecret|smtp_secret|token|sessiontoken|session_token|rawbody|raw_body)$/i;
const CONTENT_KEYS = /^(html|text|textbody|text_body|subject|body|emailbody|email_body)$/i;
const CUSTOM_DATA_KEYS = /^(customdata|custom_data|mergedata|merge_data)$/i;
const SECRET_REFERENCE_KEYS = /^(secretref|secret_ref)$/i;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

/**
 * Value-shaped secrets that may appear anywhere inside free text, including a
 * driver's error message. Each is replaced in place rather than discarding the
 * surrounding text.
 */
const VALUE_SHAPED_SECRETS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  /\bEOW_SENDER_SECRET_[A-Z0-9]+\b/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
  new RegExp(EMAIL_ADDRESS.source, 'gi'),
];

/**
 * Scrubs secret-shaped SUBSTRINGS while preserving the surrounding text.
 *
 * This replaces an earlier behaviour that discarded an Error's whole message.
 * That was safe but too blunt: apps/api/src/config/env.ts documents that a boot
 * failure "names it in the thrown error", test/integration/boot.test.ts asserts
 * exactly that for DATABASE_URL and SESSION_SECRET, and DEPLOY-001's operator
 * contract is that a bad .env names the offending variable. A blanket
 * [REDACTED] satisfied BR-SEC-003 by making the system undebuggable, which is
 * not the trade BR-SEC-003 asks for: it forbids secret VALUES in logs, not
 * variable names. See EXECPLAN D-170.
 */
/**
 * Boot-time configuration failures are the one Error class whose message must
 * survive, and they are safe to keep by construction.
 *
 * apps/api/src/config/env.ts composes this message from `issue.path` (the
 * variable NAME) and zod's own text ("Required", "SESSION_SECRET must be at
 * least 32 characters") -- never from the variable's VALUE -- and it is thrown
 * before the process can hold any tenant data at all. Three things depend on it
 * reaching the operator: env.ts's documented contract that it "names it in the
 * thrown error", test/integration/boot.test.ts's two assertions, and DEPLOY-001,
 * whose whole acceptance is that a bad .env names the offending variable.
 *
 * Everything else stays fully redacted, which is what BR-SEC-003 asks for and
 * what this module's own "never emits raw Error messages" test asserts. The
 * allowlist is one exact prefix, not a heuristic, and the message is still
 * scrubbed for value-shaped secrets afterwards. See EXECPLAN D-170.
 */
const SAFE_ERROR_MESSAGE_PREFIXES = [/^Invalid environment configuration: /];

function safeErrorMessage(message: string): string {
  return SAFE_ERROR_MESSAGE_PREFIXES.some((pattern) => pattern.test(message)) ? scrubText(message) : REDACTED;
}

function scrubText(value: string): string {
  let out = value;
  for (const pattern of VALUE_SHAPED_SECRETS) out = out.replace(pattern, REDACTED);
  return out;
}

function contentSummary(key: string, value: string): Record<string, unknown> {
  const normalized = key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`).replace(/^_/, '');
  return {
    [`${normalized}_bytes`]: Buffer.byteLength(value, 'utf8'),
    [`${normalized}_sha256`]: createHash('sha256').update(value).digest('hex'),
  };
}

function maskSecretReference(value: string): string {
  if (value.length <= 4) return REDACTED;
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return EMAIL_ADDRESS.test(value) ? REDACTED : scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: safeErrorMessage(value.message),
      ...(value.stack ? { stack_sha256: createHash('sha256').update(value.stack).digest('hex') } : {}),
    };
  }
  if (Buffer.isBuffer(value)) return { bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') };
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    if (SECRET_REFERENCE_KEYS.test(key) && typeof nested === 'string') {
      output[key] = maskSecretReference(nested);
      continue;
    }
    if (CONTENT_KEYS.test(key) && typeof nested === 'string') {
      Object.assign(output, contentSummary(key, nested));
      continue;
    }
    if (CUSTOM_DATA_KEYS.test(key) && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      output[key] = Object.fromEntries(Object.keys(nested as Record<string, unknown>).map((field) => [field, REDACTED]));
      continue;
    }
    output[key] = sanitize(nested, seen);
  }
  return output;
}

export function sanitizeLogValue(value: unknown): unknown {
  return sanitize(value, new WeakSet());
}
